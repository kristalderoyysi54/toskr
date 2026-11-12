package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

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
	// 以下为原生版扩充（Tauri 无）：输入区与详情窗共用这张表
	{"base64-encode", "Base64 编码", func(t string) (string, error) { return base64.StdEncoding.EncodeToString([]byte(t)), nil }},
	{"base64-decode", "Base64 解码", base64Decode},
	{"timestamp", "时间戳 ↔ 日期", convertTimestamp},
	{"dedupe-lines", "行去重", func(t string) (string, error) {
		seen, out := map[string]bool{}, []string(nil)
		for _, l := range strings.Split(t, "\n") {
			if !seen[l] {
				seen[l] = true
				out = append(out, l)
			}
		}
		return strings.Join(out, "\n"), nil
	}},
	{"sort-lines", "行排序", func(t string) (string, error) {
		ls := strings.Split(t, "\n")
		slices.Sort(ls)
		return strings.Join(ls, "\n"), nil
	}},
	{"to-halfwidth", "全角转半角", func(t string) (string, error) {
		return strings.Map(func(r rune) rune {
			switch {
			case r == 0x3000:
				return ' '
			case r >= 0xFF01 && r <= 0xFF5E:
				return r - 0xFEE0
			}
			return r
		}, t), nil
	}},
	{"to-fullwidth", "半角转全角", func(t string) (string, error) {
		return strings.Map(func(r rune) rune {
			if r >= 0x21 && r <= 0x7E {
				return r + 0xFEE0
			}
			return r
		}, t), nil
	}},
	{"cjk-space", "中英文之间加空格", func(t string) (string, error) { return spaceCJK(t), nil }},
	{"extract-links", "提取全部链接", extractLinks},
}

func base64Decode(t string) (string, error) {
	raw := strings.Join(strings.Fields(t), "")
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(raw); err == nil {
			if !utf8.Valid(b) {
				return "", errors.New(tr("解码结果不是文本"))
			}
			return string(b), nil
		}
	}
	return "", errors.New(tr("不是有效的 Base64"))
}

var dateLayouts = []string{"2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02T15:04:05", "2006/01/02 15:04:05", "2006/01/02 15:04", "2006-01-02", "2006/01/02"}

// convertTimestamp：纯数字按 Unix 时间戳（10 位秒 / 13 位毫秒）转本地日期时间；日期时间转回秒级时间戳。
func convertTimestamp(t string) (string, error) {
	v := strings.TrimSpace(t)
	if n, err := strconv.ParseInt(v, 10, 64); err == nil && (len(v) == 10 || len(v) == 13) {
		if len(v) == 13 {
			return time.UnixMilli(n).Format("2006-01-02 15:04:05.000"), nil
		}
		return time.Unix(n, 0).Format("2006-01-02 15:04:05"), nil
	}
	if d, err := time.Parse(time.RFC3339, v); err == nil {
		return strconv.FormatInt(d.Unix(), 10), nil
	}
	for _, l := range dateLayouts {
		if d, err := time.ParseInLocation(l, v, time.Local); err == nil {
			return strconv.FormatInt(d.Unix(), 10), nil
		}
	}
	return "", errors.New(tr("不是时间戳或日期"))
}

// spaceCJK：汉字与相邻的拉丁字母 / 数字之间补一个空格（已有空白不重复加）。
func spaceCJK(t string) string {
	var b strings.Builder
	var prev rune
	for _, r := range t {
		if prev != 0 && (unicode.Is(unicode.Han, prev) && isLatinDigit(r) || isLatinDigit(prev) && unicode.Is(unicode.Han, r)) {
			b.WriteByte(' ')
		}
		b.WriteRune(r)
		prev = r
	}
	return b.String()
}

func isLatinDigit(r rune) bool {
	return r < 0x80 && (unicode.IsLetter(r) || unicode.IsDigit(r))
}

var linkRe = regexp.MustCompile(`https?://[^\s<>"'）)】」，。；、]+`)

func extractLinks(t string) (string, error) {
	var out []string
	for _, l := range linkRe.FindAllString(t, -1) {
		if l = strings.TrimRight(l, ".,;:!?"); !slices.Contains(out, l) {
			out = append(out, l)
		}
	}
	if len(out) == 0 {
		return "", errors.New(tr("没有找到链接"))
	}
	return strings.Join(out, "\n"), nil
}

// applyDraftOp 处理输入区草稿；失败给警告气泡。
func (a *app) applyDraftOp(i int) {
	out, err := textOps[i].apply(a.draft)
	if err != nil {
		a.showHUD("warn", tr("处理失败：")+err.Error())
		return
	}
	if out == a.draft { // 同 Tauri applyDraftTextOp
		a.showHUD("info", tr("内容无变化"))
		return
	}
	prev := a.draft
	a.draft = out
	a.showHUDUndo("ok", tr("已处理草稿 · ")+tr(textOps[i].label), func() { a.draft = prev })
}

// expandDraft：转大窗编辑（同 Tauri DraftInput expandToDetail）——草稿落成当前分组的一张卡并在详情窗编辑，空草稿落「新笔记」。
func (a *app) expandDraft() {
	text := strings.TrimSpace(a.draft)
	if text == "" && len(a.draftImgs) == 0 {
		text = tr("新笔记")
	}
	placeholder := text == tr("新笔记")
	n, dup, err := a.store.Add(draftNote(a.composerSection().ID, text, a.draftImgs))
	if err != nil {
		return
	}
	a.draft, a.draftImgs = "", nil
	a.reload()
	a.editInDetail(n)
	if placeholder { // 同 Tauri openNoteDetail(id, true, !text)：空草稿全选占位文字，关窗时一字未改就回收
		a.detail.editSel = [2]int{0, len([]rune(n.Text))}
		a.detail.blank = !dup
	}
}
