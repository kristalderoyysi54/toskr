package linkmeta

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func TestDetect(t *testing.T) {
	for in, want := range map[string]string{
		"https://a.com/x":       "https://a.com/x",
		"  http://a.com  ":      "http://a.com",
		"github.com/egoist/x":   "https://github.com/egoist/x",
		"www.example.cn:8080/a": "https://www.example.cn:8080/a",
		"README.md":             "",
		"com.apple.Terminal":    "",
		"package.json":          "",
		"看 https://a.com":       "",
		"https://a.com b":       "",
	} {
		if got := Detect(in); got != want {
			t.Errorf("Detect(%q)=%q want %q", in, got, want)
		}
	}
}

// 同 Tauri linkmeta.rs 的六条用例。
func TestExtract(t *testing.T) {
	title, _ := Extract(`<html><head><title>后备标题</title>
		<meta property="og:title" content="JS 接入指南_抖音开放平台"/></head></html>`, "https://developer.open-douyin.com/docs/x")
	if title != "JS 接入指南_抖音开放平台" {
		t.Fatal(title)
	}
	if title, _ = Extract("<HTML><HEAD><TITLE>A &amp; B &lt;C&gt;</TITLE></HEAD>", "https://example.com"); title != "A & B <C>" {
		t.Fatal(title)
	}
	if _, icon := Extract(`<link rel="shortcut icon" href="/static/fav.png">`, "https://a.com/docs/page"); icon != "https://a.com/static/fav.png" {
		t.Fatal(icon)
	}
	if title, icon := Extract("<html></html>", "https://a.com/docs/page"); icon != "https://a.com/favicon.ico" || title != "" {
		t.Fatal(icon, title)
	}
	if _, icon := Extract(`<link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="//cdn.a.com/fav.svg">`, "https://a.com"); icon != "https://cdn.a.com/fav.svg" {
		t.Fatal(icon)
	}
	if title, _ = Extract(`<meta property="og:title" data-content="假的" content="真的">`, "https://a.com"); title != "真的" {
		t.Fatal(title)
	}
}

func TestPublic(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2001:db8::1", "192.168.1.1", "198.18.0.1", "fd00::1"} {
		if Public(netip.MustParseAddr(s)) {
			t.Errorf("%s 不应算公网", s)
		}
	}
	for _, s := range []string{"8.8.8.8", "1.1.1.1", "2606:4700::1111"} {
		if !Public(netip.MustParseAddr(s)) {
			t.Errorf("%s 应算公网", s)
		}
	}
}

func pngBytes(w, h int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = 200
	}
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}

func ico(frames ...[]byte) []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.LittleEndian, [3]uint16{0, 1, uint16(len(frames))})
	off := 6 + 16*len(frames)
	for i, f := range frames {
		sz := byte(16 * (i + 1))
		b.Write([]byte{sz, sz, 0, 0, 1, 0, 32, 0})
		_ = binary.Write(&b, binary.LittleEndian, [2]uint32{uint32(len(f)), uint32(off)})
		off += len(f)
	}
	for _, f := range frames {
		b.Write(f)
	}
	return b.Bytes()
}

// 32 位 BMP 帧（无文件头、高度为两倍），自下而上 BGRA。
func bmpFrame(w, h int, c color.NRGBA) []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.LittleEndian, struct {
		Size          uint32
		W, H          int32
		Planes, Bpp   uint16
		Comp, ImgSize uint32
		XR, YR        int32
		Used, Imp     uint32
	}{40, int32(w), int32(2 * h), 1, 32, 0, 0, 0, 0, 0, 0})
	for i := 0; i < w*h; i++ {
		b.Write([]byte{c.B, c.G, c.R, c.A})
	}
	b.Write(make([]byte, h*((w+31)/32*4))) // AND 掩码
	return b.Bytes()
}

func TestDecodeIcon(t *testing.T) {
	img, err := DecodeIcon(ico(pngBytes(16, 16), pngBytes(32, 32)))
	if err != nil || img.Bounds().Dx() != 32 {
		t.Fatalf("ICO 取最大 PNG 帧 %v %v", err, img)
	}
	img, err = DecodeIcon(ico(bmpFrame(16, 16, color.NRGBA{R: 255, A: 255})))
	if err != nil || img.Bounds().Dx() != 16 || img.Bounds().Dy() != 16 {
		t.Fatalf("ICO BMP 帧 %v %v", err, img)
	}
	if r, _, _, _ := img.At(3, 3).RGBA(); r>>8 != 255 {
		t.Fatalf("BMP 颜色错 %v", img.At(3, 3))
	}
	if _, err = DecodeIcon([]byte("\xef\xbb\xbf <svg xmlns=…>")); err == nil {
		t.Fatal("SVG 应报不支持")
	}
	src, _ := png.Decode(bytes.NewReader(pngBytes(200, 100)))
	u, err := PNGDataURL(src)
	if err != nil || !strings.HasPrefix(u, "data:image/png;base64,") {
		t.Fatal(err)
	}
}

// 本机回环地址：自动抓取一律拒绝；手动放行本 origin 后可抓，重定向到别的内网 origin 仍拒绝。
func TestFetchPrivateGuard(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "<title>别处</title>") }))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/jump":
			http.Redirect(w, r, other.URL, http.StatusFound)
		case "/big":
			w.Write(bytes.Repeat([]byte("x"), maxPage+10))
		case "/fav.png":
			w.Write(pngBytes(128, 128))
		default:
			fmt.Fprint(w, `<title>本地页</title><link rel="icon" href="/fav.png">`)
		}
	}))
	defer srv.Close()
	ctx := context.Background()
	if _, err := Fetch(ctx, srv.URL, ""); !errors.Is(err, ErrPrivate) {
		t.Fatalf("自动抓取应拒绝内网 %v", err)
	}
	m, err := Fetch(ctx, srv.URL+"/page", Origin(srv.URL))
	if err != nil || m.Title != "本地页" || !strings.HasPrefix(m.Icon, "data:image/png;base64,") {
		t.Fatalf("放行本 origin 后应抓到 %v %+v", err, m)
	}
	if _, err := Fetch(ctx, srv.URL+"/jump", Origin(srv.URL)); !errors.Is(err, ErrPrivate) {
		t.Fatalf("重定向到别的内网 origin 应拒绝 %v", err)
	}
	if _, err := Fetch(ctx, srv.URL+"/big", Origin(srv.URL)); err == nil || !strings.Contains(err.Error(), "过大") {
		t.Fatalf("超限应报过大 %v", err)
	}
	if _, err := Fetch(ctx, "ftp://a.com", ""); err == nil {
		t.Fatal("非 http(s) 应拒绝")
	}
}

// 增强模式代理（fake-ip）：域名只解析到 198.18/15 且有本机系统代理时经代理抓取；没有代理、IP 字面量、本地后缀一律拒绝。
func TestFetchViaFakeIPProxy(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Host != "example.com" { // 经代理的请求行是绝对 URL
			http.Error(w, "bad", 400)
			return
		}
		fmt.Fprint(w, "<title>经代理</title>")
	}))
	defer proxy.Close()
	oldL, oldP := lookup, SystemProxy
	defer func() { lookup, SystemProxy = oldL, oldP }()
	lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("198.18.0.7")}, nil
	}
	SystemProxy = func() string { return strings.TrimPrefix(proxy.URL, "http://") }
	m, err := Fetch(context.Background(), "http://example.com/", "")
	if err != nil || m.Title != "经代理" {
		t.Fatalf("fake-ip 应经系统代理 %v %+v", err, m)
	}
	for _, u := range []string{"http://198.18.0.7/", "http://printer.local/"} {
		if _, err := Fetch(context.Background(), u, ""); !errors.Is(err, ErrPrivate) {
			t.Fatalf("%s 应拒绝 %v", u, err)
		}
	}
	SystemProxy = func() string { return "" }
	if _, err := Fetch(context.Background(), "http://example.com/", ""); !errors.Is(err, ErrPrivate) {
		t.Fatalf("没有系统代理时 fake-ip 应拒绝 %v", err)
	}
}
