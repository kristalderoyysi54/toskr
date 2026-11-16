package main

import (
	"strings"

	"github.com/egoist/mygo/ui"
)

// 搜索命中高亮（同 Tauri NoteCard splitHighlight：琥珀底 mark，大小写不敏感）。

type hlSeg struct {
	text string
	hit  bool
}

func splitHighlight(s, q string) []hlSeg {
	q = strings.TrimSpace(q)
	if q == "" {
		return []hlSeg{{s, false}}
	}
	ls, lq := strings.ToLower(s), strings.ToLower(q)
	if len(ls) != len(s) { // 大小写转换改变了字节长度（极少数字符）：不高亮，避免切错 UTF-8
		return []hlSeg{{s, false}}
	}
	var out []hlSeg
	for i := 0; i < len(s); {
		j := strings.Index(ls[i:], lq)
		if j < 0 {
			out = append(out, hlSeg{s[i:], false})
			break
		}
		if j > 0 {
			out = append(out, hlSeg{s[i : i+j], false})
		}
		out = append(out, hlSeg{s[i+j : i+j+len(lq)], true})
		i += j + len(lq)
	}
	return out
}

// highlightText：卡面正文；有搜索词时命中处加琥珀底。
// cardPreviewRunes：列表卡片预览最多交给排版的字数。mygo 排版会测量整段文字（MaxLines 只截显示），
// 2MB 的文字卡单帧要几分钟、面板卡死；预览最多四十来行，4000 字足够填满。
const cardPreviewRunes = 4000

// previewCap：截到前 cardPreviewRunes 个字（按字符边界）。
func previewCap(s string) string {
	if len(s) <= cardPreviewRunes {
		return s
	}
	n := 0
	for i := range s {
		if n == cardPreviewRunes {
			return s[:i]
		}
		n++
	}
	return s
}

func highlightText(c *ui.Context, k tokens, s, q string, size, lh float32, col ui.Color) ui.Element {
	s = previewCap(s)
	segs := splitHighlight(s, q)
	if len(segs) == 1 && !segs[0].hit {
		return text(c, s, size, lh, 400, col)
	}
	mark := k.amberBar.Alpha(0.6) // token-exception: 同 Tauri bg-amber-300/60 搜索 mark
	if k.dark {
		mark = k.amberBar.Alpha(0.4)
	}
	spans := make([]ui.Span, len(segs))
	for i, sg := range segs {
		spans[i] = ui.Span{Text: sg.text, Color: col}
		if sg.hit {
			spans[i].Background, spans[i].Radius = mark, 2
		}
	}
	return ui.RichText(c, spans...).Font(fontSans).FontSize(size).FixedLineHeight(lh)
}

// searchMatchCount 同 Tauri matchCount：剪贴页 = 剪贴命中；秘文 / 消息子页 = 各自命中；笔记 = 各分组（含已完成）命中合计。
func (a *app) searchMatchCount() int {
	switch {
	case a.page == pageClip:
		return len(a.clipList)
	case a.page == pageNotes && a.noteSub == subMessages:
		return len(a.visibleMessages())
	case a.page == pageNotes && a.noteSub != 0:
		return len(a.secrets)
	}
	n := 0
	for _, g := range a.noteGroups {
		n += len(g.open) + len(g.done)
	}
	return n
}
