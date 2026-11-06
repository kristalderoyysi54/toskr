// Package linkmeta 识别链接、抓取网页标题与图标（同 Tauri src/lib/link.ts + linkmeta.rs / preview_network.rs / favicon.rs）。
//
// 自动抓取只访问公网：每次建连都校验实际连接的 IP（防 DNS 重绑定），重定向最多 4 跳，整次 8 秒，正文 ≤3MB；
// 手动抓取可放行单个内网 origin（调用方先征得用户同意）。图标统一缩成 ≤64px 的 PNG data URL。
package linkmeta

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // favicon 可能是 GIF
	_ "image/jpeg" // 或 JPEG
	"image/png"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // 或 WebP
)

// UA：部分站点对默认 UA 返回 403 / 跳登录，伪装成 Safari（同 Tauri linkmeta::UA）。
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"

const (
	maxPage  = 3 << 20
	maxIcon  = 1 << 20
	iconSize = 64
)

// bareTLDs：无 scheme 的裸域名只在这些顶级域命中时才算链接（避免 README.md、com.apple.Terminal 误判）。
var bareTLDs = map[string]bool{}

func init() {
	for _, t := range strings.Fields(`com org net edu gov mil int io dev app ai me co cc tv sh im so gg gs to ly fm am run link site tech
		xyz top info biz pro moe one red icu art online store fun live news vip work club blog page zone plus space world today cloud
		email network group team life design video wiki cn hk tw jp kr sg us uk de fr ru in`) {
		bareTLDs[t] = true
	}
}

var (
	schemeURL = regexp.MustCompile(`(?i)^https?://\S+$`)
	bareURL   = regexp.MustCompile(`(?i)^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24}))(?::\d{1,5})?(?:[/?#]\S*)?$`)
)

// Detect：整段文本就是一个链接时返回可打开的完整 URL（裸域名补 https://），否则 ""。
func Detect(text string) string {
	t := strings.TrimSpace(text)
	if schemeURL.MatchString(t) {
		if u, err := url.Parse(t); err == nil && u.Host != "" {
			return t
		}
		return ""
	}
	m := bareURL.FindStringSubmatch(t)
	if m == nil || !bareTLDs[strings.ToLower(m[2])] {
		return ""
	}
	if _, err := url.Parse("https://" + t); err != nil {
		return ""
	}
	return "https://" + t
}

// Meta 是抓取结果；Icon 为 data:image/png;base64,…（与 Tauri linkIcon 同格式）。
type Meta struct{ Title, Icon string }

// ErrPrivate：自动抓取遇到内网或特殊地址——可让用户确认后手动抓取。
var ErrPrivate = errors.New("自动预览已跳过内网或特殊地址；可手动确认获取此链接预览")

// Fetch 抓取标题与图标。allowOrigin 非空时放行该 origin（scheme://host[:port]）的内网地址。
func Fetch(ctx context.Context, raw, allowOrigin string) (Meta, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	body, final, err := get(ctx, raw, maxPage, allowOrigin)
	if err != nil {
		return Meta{}, err
	}
	title, icon := Extract(string(body), final)
	m := Meta{Title: title}
	if icon != "" {
		m.Icon, _ = iconDataURL(ctx, icon, allowOrigin) // 图标失败不影响标题
	}
	return m, nil
}

// Origin：scheme://host[:port]。
func Origin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func checkURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return nil, errors.New("预览仅支持无凭据的 HTTP(S) 地址")
	}
	u.Fragment = ""
	return u, nil
}

// Public：只放行全球单播地址（同 Tauri preview_network::public_ip）。
func Public(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	if ip.Is4() {
		b := ip.As4()
		return b[0] != 0 && b[0] < 240 && !(b[0] == 100 && b[1] >= 64 && b[1] <= 127) &&
			!(b[0] == 198 && (b[1] == 18 || b[1] == 19)) && !(b[0] == 192 && b[1] == 0) &&
			!(b[0] == 198 && b[1] == 51 && b[2] == 100) && !(b[0] == 203 && b[1] == 0 && b[2] == 113)
	}
	s := ip.As16()
	s0, s1 := uint16(s[0])<<8|uint16(s[1]), uint16(s[2])<<8|uint16(s[3])
	return s0&0xe000 == 0x2000 && s0 != 0x2002 && !(s0 == 0x2001 && s1 < 0x200) &&
		!(s0 == 0x2001 && s1 == 0xdb8) && !(s0 == 0x3fff && s1 < 0x1000) && !(s0 == 0x64 && s1 == 0xff9b)
}

// FakeIP：198.18.0.0/15——Surge / Clash 等代理的增强（TUN）模式把所有域名解析到这里，真实地址由代理解析。
func FakeIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.Is4() {
		return false
	}
	b := ip.As4()
	return b[0] == 198 && (b[1] == 18 || b[1] == 19)
}

// SystemProxy 返回系统 HTTPS 代理地址（host:port），仅认本机回环上的代理；没有则 ""（测试替换）。
var SystemProxy = func() string {
	out, err := exec.Command("/usr/sbin/scutil", "--proxy").Output()
	if err != nil {
		return ""
	}
	kv := map[string]string{}
	for _, l := range strings.Split(string(out), "\n") {
		if k, v, ok := strings.Cut(l, " : "); ok {
			kv[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	if kv["HTTPSEnable"] != "1" || kv["HTTPSProxy"] == "" || kv["HTTPSPort"] == "" {
		return ""
	}
	if ip, err := netip.ParseAddr(kv["HTTPSProxy"]); err != nil || !ip.IsLoopback() {
		return ""
	}
	return net.JoinHostPort(kv["HTTPSProxy"], kv["HTTPSPort"])
}

var lookup = net.DefaultResolver.LookupNetIP // 测试替换

var localSuffixes = []string{".local", ".lan", ".internal", ".home.arpa", ".localhost", ".intranet", ".corp"}

// route 判定一跳怎么走：公网地址直连；域名只解析到 fake-ip 且有本机系统代理时经代理（代理负责解析真实地址）；
// 其余（内网、IP 字面量的特殊地址、本地后缀）拒绝，除非是用户手动放行的 origin。
func route(ctx context.Context, u *url.URL, allowOrigin, proxy string) (viaProxy bool, err error) {
	if allowOrigin != "" && u.Scheme+"://"+u.Host == allowOrigin {
		return false, nil
	}
	host := strings.ToLower(u.Hostname())
	if ip, err := netip.ParseAddr(host); err == nil {
		if Public(ip) {
			return false, nil
		}
		return false, ErrPrivate
	}
	for _, suf := range localSuffixes {
		if strings.HasSuffix(host, suf) || host == strings.TrimPrefix(suf, ".") {
			return false, ErrPrivate
		}
	}
	addrs, err := lookup(ctx, "ip", host)
	if err != nil || len(addrs) == 0 {
		return false, errors.New("预览域名解析失败")
	}
	fake := 0
	for _, a := range addrs {
		switch {
		case FakeIP(a):
			fake++
		case !Public(a):
			return false, ErrPrivate
		}
	}
	if fake == 0 {
		return false, nil
	}
	if fake == len(addrs) && proxy != "" {
		return true, nil
	}
	return false, ErrPrivate
}

func get(ctx context.Context, raw string, limit int64, allowOrigin string) ([]byte, string, error) {
	u, err := checkURL(raw)
	if err != nil {
		return nil, "", err
	}
	proxy := SystemProxy()
	var viaProxy sync.Map // host → 经代理
	hop := func(u *url.URL) error {
		p, err := route(ctx, u, allowOrigin, proxy)
		if err == nil {
			viaProxy.Store(u.Host, p)
		}
		return err
	}
	var cur atomic.Pointer[url.URL] // 当前这一跳；拨号时据此判断是否是被放行的 origin
	// 拨号守卫按实际连接的 IP 判（防 DNS 重绑定）：公网、被放行 origin 的直连、或者正是系统代理本身
	dialer := &net.Dialer{Timeout: 6 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
		ap, err := netip.ParseAddrPort(address)
		if err != nil {
			return ErrPrivate
		}
		c := cur.Load()
		if Public(ap.Addr()) || allowOrigin != "" && c.Scheme+"://"+c.Host == allowOrigin {
			return nil
		}
		if p, _ := viaProxy.Load(c.Host); p == true && address == proxy {
			return nil
		}
		return ErrPrivate
	}}
	client := &http.Client{
		Transport: &http.Transport{
			Proxy: func(r *http.Request) (*url.URL, error) {
				if p, _ := viaProxy.Load(r.URL.Host); p == true {
					return &url.URL{Scheme: "http", Host: proxy}, nil
				}
				return nil, nil
			},
			DialContext: dialer.DialContext, TLSHandshakeTimeout: 6 * time.Second, ResponseHeaderTimeout: 6 * time.Second,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 4 {
				return errors.New("预览重定向次数超限")
			}
			if _, err := checkURL(req.URL.String()); err != nil {
				return err
			}
			if err := hop(req.URL); err != nil {
				return err
			}
			cur.Store(req.URL)
			return nil
		},
	}
	if err := hop(u); err != nil {
		return nil, "", err
	}
	defer client.CloseIdleConnections()
	cur.Store(u)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", UA)
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, ErrPrivate) {
			return nil, "", ErrPrivate
		}
		return nil, "", fmt.Errorf("预览请求失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, "", fmt.Errorf("预览服务器返回 %d", resp.StatusCode)
	}
	if resp.ContentLength > limit {
		return nil, "", errors.New("预览响应过大")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, "", fmt.Errorf("预览响应读取失败：%w", err)
	}
	if int64(len(body)) > limit {
		return nil, "", errors.New("预览响应过大")
	}
	return body, resp.Request.URL.String(), nil
}

// Extract 从 HTML 取标题（og:title 优先，其次 <title>）与图标地址（rel 含 icon，apple-touch-icon 兜底，再兜底 /favicon.ico）。
func Extract(html, base string) (title, icon string) {
	lower := asciiLower(html) // 只转 ASCII，字节布局不变：lower 上定位、原串上取值
	title = metaContent(html, lower, "og:title")
	if title == "" {
		title = tagText(html, lower, "title")
	}
	title = decodeEntities(strings.TrimSpace(title))
	if h := linkIconHref(html, lower); h != "" {
		icon = absolutize(h, base)
	}
	if icon == "" {
		if o := Origin(base); o != "" && strings.Contains(o, "://") {
			icon = o + "/favicon.ico"
		}
	}
	return title, icon
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func metaContent(html, lower, needle string) string {
	from := 0
	for {
		rel := strings.Index(lower[from:], needle)
		if rel < 0 {
			return ""
		}
		at := from + rel
		e := strings.IndexByte(lower[at:], '>')
		if e < 0 {
			return ""
		}
		end := at + e + 1
		if start := strings.LastIndexByte(lower[:at], '<'); start >= 0 && strings.HasPrefix(lower[start:], "<meta") {
			if v, ok := attrValue(html, lower, start, end, "content"); ok {
				return v
			}
		}
		from = end
	}
}

func tagText(html, lower, tag string) string {
	start := strings.Index(lower, "<"+tag)
	if start < 0 {
		return ""
	}
	gt := strings.IndexByte(lower[start:], '>')
	if gt < 0 {
		return ""
	}
	ts := start + gt + 1
	te := strings.Index(lower[ts:], "</"+tag)
	if te < 0 {
		return ""
	}
	return html[ts : ts+te]
}

func linkIconHref(html, lower string) string {
	from, fallback := 0, ""
	for {
		rel := strings.Index(lower[from:], "<link")
		if rel < 0 {
			return fallback
		}
		start := from + rel
		e := strings.IndexByte(lower[start:], '>')
		if e < 0 {
			return fallback
		}
		end := start + e + 1
		if r, ok := attrValue(html, lower, start, end, "rel"); ok {
			rl := strings.ToLower(r)
			isIcon := false
			for _, w := range strings.Fields(rl) {
				isIcon = isIcon || w == "icon"
			}
			if isIcon || strings.Contains(rl, "apple-touch-icon") {
				if href, ok := attrValue(html, lower, start, end, "href"); ok && strings.TrimSpace(href) != "" {
					if isIcon {
						return href
					}
					if fallback == "" {
						fallback = href
					}
				}
			}
		}
		from = end
	}
}

// attrValue：标签片段内 name="v" / name='v'，属性名前必须是空白（防 data-content 误中）。
func attrValue(html, lower string, start, end int, name string) (string, bool) {
	seg := lower[start:end]
	for _, q := range []byte{'"', '\''} {
		pat := name + "=" + string(q)
		from := 0
		for {
			rel := strings.Index(seg[from:], pat)
			if rel < 0 {
				break
			}
			at := from + rel
			if at > 0 && (seg[at-1] == ' ' || seg[at-1] == '\t' || seg[at-1] == '\n' || seg[at-1] == '\r') {
				vs := start + at + len(pat)
				ve := strings.IndexByte(lower[vs:end], q)
				if ve < 0 {
					return "", false
				}
				return html[vs : vs+ve], true
			}
			from = at + len(pat)
		}
	}
	return "", false
}

var entities = strings.NewReplacer("&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'", "&#x27;", "'", "&nbsp;", " ")

func decodeEntities(s string) string { return strings.ReplaceAll(entities.Replace(s), "&amp;", "&") }

func absolutize(href, base string) string {
	href = strings.TrimSpace(href)
	b, err := url.Parse(base)
	if err != nil {
		return ""
	}
	r, err := url.Parse(href)
	if err != nil {
		return ""
	}
	return b.ResolveReference(r).String()
}

// iconDataURL 下载图标、解码（PNG/JPEG/GIF/WebP/ICO；SVG 不支持）、缩到 ≤64px，转成 PNG data URL。
func iconDataURL(ctx context.Context, raw, allowOrigin string) (string, error) {
	if strings.HasPrefix(raw, "data:") {
		return "", errors.New("内联图标不抓取")
	}
	body, _, err := get(ctx, raw, maxIcon, allowOrigin)
	if err != nil {
		return "", err
	}
	img, err := DecodeIcon(body)
	if err != nil {
		return "", err
	}
	return PNGDataURL(img)
}

// PNGDataURL 把图缩到 ≤64px 后编码成 data:image/png;base64,…。
func PNGDataURL(img image.Image) (string, error) {
	b := img.Bounds()
	if b.Dx() > iconSize || b.Dy() > iconSize {
		w, h := iconSize, iconSize
		if b.Dx() > b.Dy() {
			h = max(1, b.Dy()*iconSize/b.Dx())
		} else {
			w = max(1, b.Dx()*iconSize/b.Dy())
		}
		dst := image.NewRGBA(image.Rect(0, 0, w, h))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
		img = dst
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// DecodeIcon 解码图标字节；ICO 取最大的一帧（PNG 帧直接解，BMP 帧补文件头后解）。
func DecodeIcon(b []byte) (image.Image, error) {
	trim := bytes.TrimLeft(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")), " \t\r\n")
	if bytes.HasPrefix(trim, []byte("<svg")) || bytes.HasPrefix(trim, []byte("<?xml")) {
		return nil, errors.New("SVG 图标暂不支持")
	}
	if len(b) >= 6 && binary.LittleEndian.Uint16(b[0:]) == 0 && binary.LittleEndian.Uint16(b[2:]) == 1 {
		return decodeICO(b)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return nil, errors.New("图标格式无效")
	}
	if cfg.Width > 1024 || cfg.Height > 1024 {
		return nil, errors.New("图标尺寸超限")
	}
	img, _, err := image.Decode(bytes.NewReader(b))
	return img, err
}

func decodeICO(b []byte) (image.Image, error) {
	n := int(binary.LittleEndian.Uint16(b[4:]))
	best, bestArea := -1, -1
	for i := 0; i < n && 6+16*(i+1) <= len(b); i++ {
		e := b[6+16*i:]
		w, h := int(e[0]), int(e[1])
		if w == 0 {
			w = 256
		}
		if h == 0 {
			h = 256
		}
		if w*h > bestArea {
			best, bestArea = i, w*h
		}
	}
	if best < 0 {
		return nil, errors.New("ICO 无图像")
	}
	e := b[6+16*best:]
	size, off := int(binary.LittleEndian.Uint32(e[8:])), int(binary.LittleEndian.Uint32(e[12:]))
	if off < 0 || size <= 0 || off+size > len(b) {
		return nil, errors.New("ICO 数据越界")
	}
	data := b[off : off+size]
	if bytes.HasPrefix(data, []byte("\x89PNG")) {
		return png.Decode(bytes.NewReader(data))
	}
	if len(data) < 40 {
		return nil, errors.New("ICO 帧无效")
	}
	// BMP 帧：DIB 头里的高度是 XOR+AND 两层之和，减半；补 14 字节文件头交给 bmp 解码
	dib := append([]byte(nil), data...)
	h := int32(binary.LittleEndian.Uint32(dib[8:]))
	binary.LittleEndian.PutUint32(dib[8:], uint32(h/2))
	hdr := binary.LittleEndian.Uint32(dib[0:])
	bpp := binary.LittleEndian.Uint16(dib[14:])
	colors := binary.LittleEndian.Uint32(dib[32:])
	if colors == 0 && bpp <= 8 {
		colors = 1 << bpp
	}
	file := make([]byte, 14, 14+len(dib))
	file[0], file[1] = 'B', 'M'
	binary.LittleEndian.PutUint32(file[2:], uint32(14+len(dib)))
	binary.LittleEndian.PutUint32(file[10:], 14+hdr+4*colors)
	return bmp.Decode(bytes.NewReader(append(file, dib...)))
}
