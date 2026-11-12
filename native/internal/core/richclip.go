package core

import (
	"bytes"
	"encoding/base64"
	"errors"
	"html"
	"strings"

	"github.com/toskr/native/internal/store"
)

// 富剪贴板（同 Tauri rich_clipboard::build_document）：有序图文写成同一项的纯文本 + HTML，
// 图片以 data:image/png 内嵌；纯文本里图片用 alt（缺省「图片」）占位，块间补一个换行。
const (
	richMaxBlocks = 128
	richMaxPlain  = 2 << 20
	richMaxImages = 48 << 20
	richMaxHTML   = 72 << 20
	richMaxAlt    = 4 << 10
)

var (
	ErrRichEmpty      = errors.New("没有可复制的内容")
	ErrRichTooMany    = errors.New("内容块过多")
	ErrRichTooLarge   = errors.New("内容过大，无法写入剪贴板")
	ErrRichUnreadable = errors.New("图片读取失败")
	ErrRichNotPNG     = errors.New("图片不是 PNG")
)

var pngMagic = []byte("\x89PNG\r\n\x1a\n")

func BuildRichClipboard(blocks []store.ContentBlock, read func(string) ([]byte, error)) (plain, doc string, images int, err error) {
	if len(blocks) == 0 {
		return "", "", 0, ErrRichEmpty
	}
	if len(blocks) > richMaxBlocks {
		return "", "", 0, ErrRichTooMany
	}
	var p, body strings.Builder
	imgBytes := 0
	for _, b := range blocks {
		next := b.Text
		if b.Type == "image" {
			next = cmpOr(b.Alt, "图片")
		} else if next == "" {
			continue
		}
		s := p.String()
		if s != "" && !strings.HasSuffix(s, "\n") && !strings.HasPrefix(next, "\n") {
			p.WriteString("\n")
			body.WriteString("<br>")
		}
		if b.Type != "image" {
			p.WriteString(b.Text)
			body.WriteString(`<span style="white-space: pre-wrap">` + html.EscapeString(b.Text) + "</span>")
			continue
		}
		if len(next) > richMaxAlt {
			return "", "", 0, ErrRichTooLarge
		}
		p.WriteString(next)
		raw, e := read(b.File)
		if e != nil {
			return "", "", 0, ErrRichUnreadable
		}
		if !bytes.HasPrefix(raw, pngMagic) {
			return "", "", 0, ErrRichNotPNG
		}
		if imgBytes += len(raw); imgBytes > richMaxImages {
			return "", "", 0, ErrRichTooLarge
		}
		body.WriteString(`<img src="data:image/png;base64,` + base64.StdEncoding.EncodeToString(raw) + `" alt="` + html.EscapeString(next) + `">`)
		images++
	}
	if p.Len() == 0 && images == 0 {
		return "", "", 0, ErrRichEmpty
	}
	doc = `<html><head><meta charset="utf-8"></head><body><div data-toskr-rich-clipboard="1">` + body.String() + "</div></body></html>"
	if p.Len() > richMaxPlain || len(doc) > richMaxHTML {
		return "", "", 0, ErrRichTooLarge
	}
	return p.String(), doc, images, nil
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
