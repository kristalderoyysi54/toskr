package core

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/webp"
	"golang.org/x/net/html"

	"github.com/toskr/native/internal/store"
)

// 富文本捕获（同 Tauri richClipboard.ts + rich_clipboard.rs）：把复制时的 HTML 扫成有序的文字 / 图片块，
// 图片本地化后存进媒体目录。只做 token 扫描，不建 DOM、不执行脚本；图片下载与本地读取有大小、数量、时长与来源闸门。

const (
	maxLocalizeSources = 32
	maxSourceChars     = 24 * 1024 * 1024
	maxImageBytes      = 16 * 1024 * 1024
	maxBatchBytes      = 48 * 1024 * 1024
	maxBatchDuration   = 30 * time.Second
	maxImageEdge       = 16384
	maxImagePixels     = 24_000_000
)

var ignoredSubtrees = map[string]bool{"head": true, "noscript": true, "script": true, "style": true, "svg": true, "template": true}

var blockTags = map[string]bool{}

func init() {
	for _, t := range strings.Fields("address article aside blockquote dd div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section ul") {
		blockTags[t] = true
	}
}

// RichBlock 是解析结果：文字，或引用 Sources[Index] 的图片。
type RichBlock struct {
	Text  string
	Image bool
	Index int
	Alt   string
}

type RichParse struct {
	Blocks         []RichBlock
	Sources        []string
	Omitted        int
	OmittedSchemes []string
}

var (
	wsRun     = regexp.MustCompile(`[^\S\n\t]+`)
	tabTrim   = regexp.MustCompile(` *\t *`)
	nlTrim    = regexp.MustCompile(` *\n *`)
	manyNL    = regexp.MustCompile(`\n{3,}`)
	anyWS     = regexp.MustCompile(`[\s\x{00a0}]+`)
	dataImage = regexp.MustCompile(`(?is)^data:image/(png|jpe?g|gif|webp|bmp);base64,(.*)$`)
	b64       = regexp.MustCompile(`^[A-Za-z0-9+/]*={0,2}$`)
)

func normalizeRich(s string) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
	s = strings.ReplaceAll(s, " ", " ")
	s = wsRun.ReplaceAllString(s, " ")
	s = tabTrim.ReplaceAllString(s, "\t")
	s = nlTrim.ReplaceAllString(s, "\n")
	s = manyNL.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

func appendSep(s, sep string) string {
	s = strings.TrimRight(s, " ")
	if sep == "\n" && strings.HasSuffix(s, "\n") {
		return s
	}
	return s + sep
}

// ParseRichHTML 同 Tauri parseRichClipboard：表格单元以 Tab、行以换行连接；没有图片时整段用纯文本（或 HTML 文字）。
func ParseRichHTML(plain, htmlSrc, sourceURL string) RichParse {
	var r RichParse
	base := validHTTP(sourceURL)
	idx := map[string]int{}
	pending := ""
	var ignored []string
	tableDepth, cellDepth, cellCount := 0, 0, 0
	tableRow := false
	flush := func() {
		t := normalizeRich(pending)
		pending = ""
		if t == "" {
			return
		}
		if n := len(r.Blocks); n > 0 && !r.Blocks[n-1].Image {
			r.Blocks[n-1].Text = normalizeRich(r.Blocks[n-1].Text + "\n" + t)
			return
		}
		r.Blocks = append(r.Blocks, RichBlock{Text: t})
	}
	z := html.NewTokenizer(strings.NewReader(htmlSrc))
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			break
		}
		tok := z.Token()
		name := tok.Data
		closing, self := tt == html.EndTagToken, tt == html.SelfClosingTagToken
		if tt == html.TextToken {
			if len(ignored) == 0 && !(tableDepth > 0 && cellDepth == 0) {
				if t := anyWS.ReplaceAllString(tok.Data, " "); t != "" {
					pending += t
				}
			}
			continue
		}
		if tt != html.StartTagToken && !closing && !self {
			continue
		}
		if n := len(ignored); n > 0 {
			switch {
			case closing && name == ignored[n-1]:
				ignored = ignored[:n-1]
			case !closing && !self && name == ignored[n-1]:
				ignored = append(ignored, name)
			}
			continue
		}
		if !closing && ignoredSubtrees[name] {
			if !self {
				ignored = append(ignored, name)
			}
			continue
		}
		if name == "table" {
			if closing {
				tableDepth = max(0, tableDepth-1)
				if tableDepth == 0 {
					cellDepth = 0
					pending = appendSep(pending, "\n")
				}
			} else {
				if tableDepth == 0 {
					pending = appendSep(pending, "\n")
					tableRow, cellCount, cellDepth = false, 0, 0
				}
				tableDepth++
			}
			continue
		}
		if tableDepth > 0 {
			switch {
			case name == "tr":
				if !closing {
					if tableRow {
						pending = appendSep(pending, "\n")
					}
					tableRow, cellCount, cellDepth = true, 0, 0
				}
				continue
			case name == "td" || name == "th":
				if closing {
					cellDepth = max(0, cellDepth-1)
				} else {
					if cellCount > 0 {
						pending = appendSep(pending, "\t")
					}
					cellCount++
					cellDepth++
				}
				continue
			case name == "br" || blockTags[name]:
				if cellDepth > 0 {
					pending += " "
				}
				continue
			}
		}
		if !closing && name == "img" {
			var src, alt string
			for _, at := range tok.Attr {
				switch at.Key {
				case "src":
					src = at.Val
				case "alt":
					alt = strings.TrimSpace(anyWS.ReplaceAllString(at.Val, " "))
				}
			}
			s, scheme := normalizeImageSource(src, base)
			if s == "" {
				r.Omitted++
				r.OmittedSchemes = append(r.OmittedSchemes, scheme)
				continue
			}
			i, ok := idx[s]
			if !ok {
				i = len(r.Sources)
				r.Sources = append(r.Sources, s)
				idx[s] = i
			}
			flush()
			r.Blocks = append(r.Blocks, RichBlock{Image: true, Index: i, Alt: alt})
			continue
		}
		if name == "br" || blockTags[name] {
			pending = appendSep(pending, "\n")
		}
	}
	flush()
	htmlText := richText(r.Blocks)
	fallback := normalizeRich(plain)
	if fallback == "" {
		fallback = htmlText
	}
	if len(r.Sources) == 0 {
		r.Blocks = nil
		if fallback != "" {
			r.Blocks = []RichBlock{{Text: fallback}}
		}
		return r
	}
	if htmlText == "" && fallback != "" {
		r.Blocks = append([]RichBlock{{Text: fallback}}, r.Blocks...)
	}
	return r
}

func richText(bs []RichBlock) string {
	var parts []string
	for _, b := range bs {
		if !b.Image {
			parts = append(parts, b.Text)
		}
	}
	return normalizeRich(strings.Join(parts, "\n"))
}

func validHTTP(s string) *url.URL {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil
	}
	return u
}

func isSVGPath(p string) bool {
	p = strings.ToLower(p)
	return strings.HasSuffix(p, ".svg") || strings.HasSuffix(p, ".svgz")
}

// normalizeImageSource 同 Tauri：放行 data:image（png/jpeg/gif/webp/bmp）、http(s)、本机 file://（读取时再把关）；
// 其余返回空串与丢弃原因（诊断用）。
func normalizeImageSource(v string, base *url.URL) (string, string) {
	s := strings.TrimSpace(v)
	if s == "" {
		return "", "empty"
	}
	if m := dataImage.FindStringSubmatch(s); m != nil {
		payload := strings.Join(strings.Fields(m[2]), "")
		if payload == "" || !b64.MatchString(payload) {
			return "", "data"
		}
		return "data:image/" + strings.ToLower(m[1]) + ";base64," + payload, ""
	}
	if strings.HasPrefix(strings.ToLower(s), "data:") {
		mime := strings.ToLower(strings.SplitN(strings.SplitN(s[5:], ";", 2)[0], ",", 2)[0])
		if mime == "" {
			return "", "data"
		}
		return "", "data:" + mime
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme == "" {
		if base == nil || err != nil {
			return "", "relative"
		}
		u = base.ResolveReference(u)
	}
	switch strings.ToLower(u.Scheme) {
	case "file":
		if u.Host != "" && u.Host != "localhost" {
			return "", "file-host"
		}
		if isSVGPath(u.Path) {
			return "", "svg"
		}
		return u.String(), ""
	case "http", "https":
		if isSVGPath(u.Path) {
			return "", "svg"
		}
		return u.String(), ""
	}
	return "", strings.ToLower(u.Scheme)
}

// LocalizeRich 把解析结果的图片读成 PNG 存进媒体目录，产出笔记内容块；失败的图片省略并计数。
// sourceURL 是复制来源网页（org.chromium.source-url）：有它时拒绝 file://，并作为 Referer 下载。
func LocalizeRich(r RichParse, sourceURL string, save func([]byte) (string, error)) (blocks []store.ContentBlock, failed int) {
	files := make([]store.ContentBlock, len(r.Sources))
	ok := make([]bool, len(r.Sources))
	origin := ""
	if u := validHTTP(sourceURL); u != nil {
		origin = u.Scheme + "://" + u.Host + "/"
	}
	deadline := time.Now().Add(maxBatchDuration)
	budget := maxBatchBytes
	for i, src := range r.Sources {
		if i >= maxLocalizeSources || budget <= 0 || time.Now().After(deadline) {
			break
		}
		raw, err := loadImageSource(src, min(budget, maxImageBytes), origin, deadline)
		if err != nil {
			continue
		}
		budget -= len(raw)
		pngBytes, w, h, err := toPNG(raw)
		if err != nil {
			continue
		}
		name, err := save(pngBytes)
		if err != nil {
			continue
		}
		files[i], ok[i] = store.ContentBlock{Type: "image", File: name, Width: w, Height: h}, true
	}
	for _, b := range r.Blocks {
		switch {
		case !b.Image:
			blocks = append(blocks, store.ContentBlock{Type: "text", Text: b.Text})
		case ok[b.Index]:
			im := files[b.Index]
			im.Alt = b.Alt
			blocks = append(blocks, im)
		default:
			failed++
		}
	}
	return blocks, failed
}

var errImage = errors.New("图片不可用")

func loadImageSource(src string, limit int, origin string, deadline time.Time) ([]byte, error) {
	if len(src) > maxSourceChars {
		return nil, errImage
	}
	switch {
	case strings.HasPrefix(src, "data:"):
		_, payload, _ := strings.Cut(src, ",")
		if base64.StdEncoding.DecodedLen(len(payload)) > limit+3 {
			return nil, errImage
		}
		b, err := base64.StdEncoding.DecodeString(payload)
		if err != nil || len(b) > limit {
			return nil, errImage
		}
		return b, nil
	case strings.HasPrefix(src, "file:"):
		if origin != "" { // 真实网页渲染不了 file:// 图：这种组合只可能是伪造的剪贴板 HTML
			return nil, errImage
		}
		u, err := url.Parse(src)
		if err != nil {
			return nil, errImage
		}
		p, err := filepath.EvalSymlinks(u.Path)
		if err != nil || !localImageAllowed(p) {
			return nil, errImage
		}
		fi, err := os.Lstat(p)
		if err != nil || !fi.Mode().IsRegular() || fi.Size() > int64(limit) {
			return nil, errImage
		}
		return os.ReadFile(p)
	}
	return fetchImage(src, limit, origin, deadline)
}

// localImageAllowed：只读各应用数据 / 缓存（~/Library）与系统临时目录；用户文稿树永不可达。
func localImageAllowed(p string) bool {
	roots := []string{"/private/var/folders/", "/private/tmp/", "/var/folders/", "/tmp/"}
	if home, err := os.UserHomeDir(); err == nil && filepath.IsAbs(home) {
		roots = append(roots, filepath.Join(home, "Library")+"/")
	}
	for _, r := range roots {
		if strings.HasPrefix(p, r) {
			return true
		}
	}
	return false
}

// publicIP：拒绝回环、内网、链路本地、组播与未指定地址（防 SSRF）。
func publicIP(ip net.IP) bool {
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() || ip.IsInterfaceLocalMulticast())
}

var dialPublic = func(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	for _, ip := range ips {
		if !publicIP(ip) {
			return nil, errImage
		}
	}
	var d net.Dialer
	return d.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
}

func fetchImage(src string, limit int, origin string, deadline time.Time) ([]byte, error) {
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	client := &http.Client{
		Transport: &http.Transport{DialContext: dialPublic, Proxy: nil},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 4 || (req.URL.Scheme != "http" && req.URL.Scheme != "https") {
				return errImage
			}
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "image/png,image/jpeg,image/gif,image/webp,image/bmp;q=0.9,*/*;q=0.1")
	if origin != "" {
		req.Header.Set("Referer", origin)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.ContentLength > int64(limit) {
		return nil, errImage
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, int64(limit)+1))
	if err != nil || len(b) > limit {
		return nil, errImage
	}
	return b, nil
}

// toPNG 先读尺寸把关（边长 / 像素数），再解码重编码为 PNG。
func toPNG(raw []byte) ([]byte, int, int, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxImageEdge || cfg.Height > maxImageEdge || cfg.Width*cfg.Height > maxImagePixels {
		return nil, 0, 0, errImage
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, 0, 0, errImage
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, 0, 0, err
	}
	return buf.Bytes(), cfg.Width, cfg.Height, nil
}
