package main

import (
	"regexp"
	"strings"
)

// 选区格式（同 Tauri src/lib/selectionFormat.ts）：链接、整行块格式（正文 / 标题 / 列表 / 核对清单 / 代码块）。
// 偏移一律是 rune 下标，与详情窗选区（detailSelection）一致。

type blockFormat struct{ id, label string }

// blockFormats 顺序即 ⌥⌘0–7（同 Tauri BLOCK_FORMATS）。
var blockFormats = []blockFormat{
	{"paragraph", "文本"}, {"heading1", "标题 1"}, {"heading2", "标题 2"}, {"heading3", "标题 3"},
	{"numbered-list", "编号列表"}, {"bullet-list", "项目符号列表"}, {"todo-list", "核对清单"}, {"code-block", "代码块"},
}

var (
	wholeLinkRe   = regexp.MustCompile(`^\[([^\]\n]+)\]\(([^)\n]+)\)$`)
	blockPrefixRe = regexp.MustCompile(`^(?:#{1,6}|[-+*][\t ]+\[[ xX]\]|[-+*]|\d+[.)])[\t ]+`)
	fenceRe       = regexp.MustCompile("^[\t ]{0,3}(`{3,}|~{3,})(.*)$")
	todoRe        = regexp.MustCompile(`^[-+*]\s+\[[ xX]\]\s`)
	numberedRe    = regexp.MustCompile(`^\d+[.)]\s`)
)

func runeIndex(r []rune, from int, c rune) int {
	for i := max(from, 0); i < len(r); i++ {
		if r[i] == c {
			return i
		}
	}
	return -1
}

func runeLastIndex(r []rune, before int, c rune) int {
	for i := min(before, len(r)-1); i >= 0; i-- {
		if r[i] == c {
			return i
		}
	}
	return -1
}

// selectedLines：选区涉及的整行区间（选到行尾换行时不含下一行）。
func selectedLines(r []rune, lo, hi int) (int, int) {
	start := runeLastIndex(r, lo-1, '\n') + 1
	if hi > lo && hi-1 < len(r) && r[hi-1] == '\n' {
		return start, hi - 1
	}
	if nb := runeIndex(r, hi, '\n'); nb >= 0 {
		return start, nb
	}
	return start, len(r)
}

// inCodeFence：选区所在行是否在一对围栏之间。
func inCodeFence(r []rune, lo, hi int) bool {
	ls, le := selectedLines(r, lo, hi)
	open, off := false, 0
	for _, line := range strings.Split(string(r), "\n") {
		n := len([]rune(line))
		if m := fenceRe.FindStringSubmatch(line); m != nil {
			if !open {
				open = true
			} else if strings.TrimSpace(m[2]) == "" {
				open = false
			}
		} else if open && off <= ls && le <= off+n {
			return true
		}
		off += n + 1
	}
	return false
}

// applyMarkdownLink 同 Tauri：选中整个 [文字](旧地址) 时只换地址；否则包成 [选中](地址)。返回新文本与新选区。
func applyMarkdownLink(text string, lo, hi int, href string) (string, int, int) {
	r := []rune(text)
	href = strings.TrimSpace(href)
	sel := string(r[lo:hi])
	if href == "" || strings.TrimSpace(sel) == "" || strings.Contains(sel, "\n") {
		return text, lo, hi
	}
	if m := wholeLinkRe.FindStringSubmatch(sel); m != nil {
		label := []rune(m[1])
		return string(r[:lo]) + "[" + m[1] + "](" + href + ")" + string(r[hi:]), lo + 1, lo + 1 + len(label)
	}
	if lo > 0 && r[lo-1] == '[' && strings.HasPrefix(string(r[hi:]), "](") {
		if end := runeIndex(r, hi+2, ')'); end >= 0 {
			return string(r[:hi+2]) + href + string(r[end:]), lo, hi
		}
	}
	return string(r[:lo]) + "[" + sel + "](" + href + ")" + string(r[hi:]), lo + 1, hi + 1
}

// markdownHrefAt：选区已是链接时取出地址（回填链接框、按下态）。
func markdownHrefAt(text string, lo, hi int) string {
	r := []rune(text)
	if m := wholeLinkRe.FindStringSubmatch(string(r[lo:hi])); m != nil {
		return m[2]
	}
	if lo > 0 && r[lo-1] == '[' && strings.HasPrefix(string(r[hi:]), "](") {
		if end := runeIndex(r, hi+2, ')'); end >= 0 {
			return string(r[hi+2 : end])
		}
	}
	return ""
}

// applyBlockFormat 同 Tauri：选区涉及的整行切换格式，空行原样；代码块用围栏包住（已在围栏里则不动）。
func applyBlockFormat(text string, lo, hi int, format string) (string, int, int) {
	r := []rune(text)
	start, end := selectedLines(r, lo, hi)
	content := string(r[start:end])
	if format == "code-block" {
		if inCodeFence(r, lo, hi) {
			return text, lo, hi
		}
		fence := "```"
		for strings.Contains(content, fence) {
			fence += "`"
		}
		cs := start + len([]rune(fence)) + 1
		return string(r[:start]) + fence + "\n" + content + "\n" + fence + string(r[end:]), cs, cs + len([]rune(content))
	}
	lines := strings.Split(content, "\n")
	num := 0
	for i, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		body := strings.TrimLeft(line, " \t")
		indent := line[:len(line)-len(body)]
		body = blockPrefixRe.ReplaceAllString(body, "")
		switch format {
		case "heading1":
			body = "# " + body
		case "heading2":
			body = "## " + body
		case "heading3":
			body = "### " + body
		case "bullet-list":
			body = "- " + body
		case "todo-list":
			body = "- [ ] " + body
		case "numbered-list":
			num++
			body = itoa(num) + ". " + body
		}
		lines[i] = indent + body
	}
	rep := strings.Join(lines, "\n")
	return string(r[:start]) + rep + string(r[end:]), start, start + len([]rune(rep))
}

// blockFormatAt：「文本」按钮显示选区首个非空行的格式。
func blockFormatAt(text string, lo, hi int) string {
	r := []rune(text)
	if inCodeFence(r, lo, hi) {
		return "code-block"
	}
	start, end := selectedLines(r, lo, hi)
	for _, line := range strings.Split(string(r[start:end]), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		b := strings.TrimLeft(line, " \t")
		switch {
		case strings.HasPrefix(b, "# "):
			return "heading1"
		case strings.HasPrefix(b, "## "):
			return "heading2"
		case strings.HasPrefix(b, "### "):
			return "heading3"
		case numberedRe.MatchString(b):
			return "numbered-list"
		case todoRe.MatchString(b):
			return "todo-list"
		case strings.HasPrefix(b, "- ") || strings.HasPrefix(b, "* ") || strings.HasPrefix(b, "+ "):
			return "bullet-list"
		}
		return "paragraph"
	}
	return "paragraph"
}

func blockLabel(id string) string {
	for _, f := range blockFormats {
		if f.id == id {
			return f.label
		}
	}
	return "文本"
}
