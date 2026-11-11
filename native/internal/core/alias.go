package core

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/toskr/native/internal/store"
)

// 可逆化名（同 Tauri src/lib/delivery/aliasEntities.ts）：发送时把词典里的原文精确替换为固定占位符，
// 回复回来后在本机还原；不依赖发送会话，重启后仍可还原。

var AliasPresetCategories = []store.AliasCategory{{Code: "USER", Label: "用户"}, {Code: "MERCHANT", Label: "商户"}, {Code: "ORDER", Label: "订单"}, {Code: "PROJECT", Label: "项目"}, {Code: "CONTACT", Label: "联系方式"}}

var reservedAliasCodes = []string{"PRIVATE_KEY", "AUTHORIZATION", "API_KEY", "DATABASE_URL", "EMAIL", "PHONE", "NATIONAL_ID", "BANK_CARD", "IP_ADDRESS", "COOKIE", "SESSION"}

var aliasCodeRe = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,15}$`)

func ValidAliasCategoryCode(code string) bool {
	return aliasCodeRe.MatchString(code) && !slices.Contains(reservedAliasCodes, code)
}

// AliasCategoryLabel：类别显示名（预置 / 自定义，找不到用码本身）。
func AliasCategoryLabel(code string, custom []store.AliasCategory) string {
	for _, c := range slices.Concat(AliasPresetCategories, custom) {
		if c.Code == code {
			return c.Label
		}
	}
	return code
}

type aliasHit struct {
	start, end int
	e          store.AliasEntity
}

// scanAliases：精确子串匹配；正文里已是 [CODE_NN] 形态的片段不二次匹配；重叠时长者优先、再按位置。
func scanAliases(text string, dict []store.AliasEntity) []aliasHit {
	if text == "" || len(dict) == 0 {
		return nil
	}
	excl := placeholderRe.FindAllStringIndex(text, -1)
	overlaps := func(s, e int, spans [][2]int) bool {
		for _, x := range spans {
			if s < x[1] && e > x[0] {
				return true
			}
		}
		return false
	}
	var ex [][2]int
	for _, x := range excl {
		ex = append(ex, [2]int{x[0], x[1]})
	}
	var hits []aliasHit
	for _, e := range dict {
		if e.OriginalText == "" || e.Placeholder == "" {
			continue
		}
		for from := 0; from <= len(text)-len(e.OriginalText); {
			i := strings.Index(text[from:], e.OriginalText)
			if i < 0 {
				break
			}
			s := from + i
			end := s + len(e.OriginalText)
			from = end
			if !overlaps(s, end, ex) {
				hits = append(hits, aliasHit{s, end, e})
			}
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		li, lj := hits[i].end-hits[i].start, hits[j].end-hits[j].start
		if li != lj {
			return li > lj
		}
		return hits[i].start < hits[j].start
	})
	var kept []aliasHit
	var taken [][2]int
	for _, h := range hits {
		if !overlaps(h.start, h.end, taken) {
			kept = append(kept, h)
			taken = append(taken, [2]int{h.start, h.end})
		}
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].start < kept[j].start })
	return kept
}

// ApplyAliases 把词典命中全部替换为条目固定占位符，返回新文本与替换处数。
func ApplyAliases(text string, dict []store.AliasEntity) (string, int) {
	hits := scanAliases(text, dict)
	if len(hits) == 0 {
		return text, 0
	}
	var b strings.Builder
	last := 0
	for _, h := range hits {
		b.WriteString(text[last:h.start])
		b.WriteString(h.e.Placeholder)
		last = h.end
	}
	b.WriteString(text[last:])
	return b.String(), len(hits)
}

// AliasHit 是一处词典替换（字节区间 + 词条），供预检逐项列出与还原。
type AliasHit struct {
	Start, End int
	Entity     store.AliasEntity
}

// AliasHits 列出 ApplyAliases 会替换的每一处（同一套匹配规则）。
func AliasHits(text string, dict []store.AliasEntity) []AliasHit {
	var out []AliasHit
	for _, h := range scanAliases(text, dict) {
		out = append(out, AliasHit{h.start, h.end, h.e})
	}
	return out
}

// ApplyAliasesSkip 同 ApplyAliases，但 skip(start) 为真的那处保留原文（预检「还原为原文」，仅本次发送）。
func ApplyAliasesSkip(text string, dict []store.AliasEntity, skip func(start int) bool) string {
	var b strings.Builder
	last := 0
	for _, h := range scanAliases(text, dict) {
		if skip(h.start) {
			continue
		}
		b.WriteString(text[last:h.start])
		b.WriteString(h.e.Placeholder)
		last = h.end
	}
	b.WriteString(text[last:])
	return b.String()
}

// RestoreAliases：文本里词典已知的占位符 → 原文；未知占位符原样保留。
func RestoreAliases(text string, dict []store.AliasEntity) (string, int) {
	es := slices.Clone(dict)
	sort.SliceStable(es, func(i, j int) bool {
		if len(es[i].Placeholder) != len(es[j].Placeholder) {
			return len(es[i].Placeholder) > len(es[j].Placeholder)
		}
		return es[i].Placeholder < es[j].Placeholder
	})
	n := 0
	for _, e := range es {
		if e.Placeholder == "" || e.OriginalText == "" {
			continue
		}
		if c := strings.Count(text, e.Placeholder); c > 0 {
			n += c
			text = strings.ReplaceAll(text, e.Placeholder, e.OriginalText)
		}
	}
	return text, n
}

// AliasOccurrences：文本里还处于占位符状态、可还原的词典项数。
func AliasOccurrences(text string, dict []store.AliasEntity) int {
	if text == "" || len(dict) == 0 {
		return 0
	}
	known := map[string]bool{}
	for _, e := range dict {
		if e.Placeholder != "" && e.OriginalText != "" {
			known[e.Placeholder] = true
		}
	}
	n := 0
	for _, p := range placeholderRe.FindAllString(text, -1) {
		if known[p] {
			n++
		}
	}
	return n
}

// AllocateAliasPlaceholder 取号：计数器只增不减。
func AllocateAliasPlaceholder(code string, counters map[string]int) (string, map[string]int) {
	n := counters[code]
	if n < 1 {
		n = 1
	}
	next := map[string]int{}
	for k, v := range counters {
		next[k] = v
	}
	next[code] = n + 1
	return fmt.Sprintf("[%s_%02d]", code, n), next
}

// SuggestAliasCategory 同 Tauri suggestAliasCategory。
var (
	reContactNum = regexp.MustCompile(`^\+?[\d\s\-()]{7,}$`)
	reOrderNo    = regexp.MustCompile(`(?i)^[A-Z0-9][A-Z0-9\-_#/]{3,}$`)
	reDigit      = regexp.MustCompile(`\d`)
)

func SuggestAliasCategory(text string) string {
	t := strings.TrimSpace(text)
	switch {
	case strings.Contains(t, "@"), reContactNum.MatchString(t):
		return "CONTACT"
	case reOrderNo.MatchString(t) && reDigit.MatchString(t):
		return "ORDER"
	}
	return "USER"
}

// AliasOriginalIssue 同 Tauri aliasOriginalTextIssue；空串 = 可用。
func AliasOriginalIssue(orig string, dict []store.AliasEntity, editingID string) string {
	t := strings.TrimSpace(orig)
	switch {
	case t == "":
		return "原文不能为空"
	case t != orig:
		return "原文首尾不能是空白字符"
	case placeholderRe.MatchString(orig):
		return "原文不能包含占位符形态的文字"
	}
	for _, e := range dict {
		if e.ID != editingID && e.OriginalText == orig {
			return "该原文已存在于词典"
		}
	}
	return ""
}
