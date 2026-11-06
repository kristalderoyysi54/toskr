package main

import (
	"bytes"
	"encoding/json"
	"net/url"
	"strings"

	"github.com/toskr/native/internal/store"
)

// textOps：同 Tauri src/lib/textops.ts TEXT_OPS（输入区「处理当前草稿」菜单）。失败（如 JSON 不合法）返回错误，草稿不动。
var textOps = []struct {
	id, label string
	apply     func(string) (string, error)
}{
	{"trim", "去首尾空白", func(t string) (string, error) { return strings.TrimSpace(t), nil }},
	{"strip-blank-lines", "去空行", func(t string) (string, error) {
		var out []string
		for _, l := range strings.Split(t, "\n") {
			if strings.TrimSpace(l) != "" {
				out = append(out, l)
			}
		}
		return strings.Join(out, "\n"), nil
	}},
	{"upper", "转大写", func(t string) (string, error) { return strings.ToUpper(t), nil }},
	{"lower", "转小写", func(t string) (string, error) { return strings.ToLower(t), nil }},
	{"json-pretty", "JSON 格式化", func(t string) (string, error) {
		var buf bytes.Buffer
		if err := json.Indent(&buf, []byte(strings.TrimSpace(t)), "", "  "); err != nil {
			return "", err
		}
		return buf.String(), nil
	}},
	{"url-decode", "URL 解码", url.PathUnescape},
	{"strip-md", "去 Markdown 标记", func(t string) (string, error) { return store.MarkdownToPlain(t), nil }},
}

// applyDraftOp 处理输入区草稿；失败给警告气泡。
func (a *app) applyDraftOp(i int) {
	out, err := textOps[i].apply(a.draft)
	if err != nil {
		a.showHUD("warn", tr("处理失败：")+err.Error())
		return
	}
	a.draft = out
}

// expandDraft：转大窗编辑（同 Tauri DraftInput expandToDetail）——草稿落成当前分组的一张卡并在详情窗编辑，空草稿落「新笔记」。
func (a *app) expandDraft() {
	text := strings.TrimSpace(a.draft)
	if text == "" {
		text = tr("新笔记")
	}
	n, _, err := a.store.Add(store.Note{Section: a.composerSection().ID, Text: text})
	if err != nil {
		return
	}
	a.draft = ""
	a.reload()
	openDetailFn(a, n)
	a.detail.edit = true
}
