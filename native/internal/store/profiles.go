package store

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// 发送方案（同 Tauri src/lib/targetProfiles.ts）：按目标应用 bundle 决定输出格式、粘贴后动作、隐私策略与发送后是否保持面板。

type PromptGroup struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Order int    `json:"order"`
}

type TargetProfile struct {
	ID                  string   `json:"id"`
	Name                string   `json:"name"`
	BundleIDs           []string `json:"bundleIds"`
	PromptGroupID       string   `json:"promptGroupId"`
	DefaultFormat       string   `json:"defaultFormat"`       // plain | code
	DefaultMarkdownMode string   `json:"defaultMarkdownMode"` // preserve | strip
	EnterPolicy         string   `json:"enterPolicy"`         // never | confirm | allow
	PrivacyPolicy       string   `json:"privacyPolicy"`       // requireRedaction | confirmRaw | allowRaw
	KeepPanel           bool     `json:"keepPanel"`
}

const (
	GeneralPromptGroup = "general"
	SafetyProfileID    = "default-safe"
	TerminalProfileID  = "terminal-safe"
)

// TerminalBundleIDs：明确的终端 bundle（同 Tauri TERMINAL_BUNDLE_IDS）。
var TerminalBundleIDs = []string{"com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable",
	"com.github.wez.wezterm", "net.kovidgoyal.kitty", "io.alacritty", "com.mitchellh.ghostty"}

var safetyProfile = TargetProfile{ID: SafetyProfileID, Name: "稳妥发送", PromptGroupID: GeneralPromptGroup,
	DefaultFormat: "plain", DefaultMarkdownMode: "preserve", EnterPolicy: "never", PrivacyPolicy: "requireRedaction"}

func DefaultPromptGroups() []PromptGroup {
	return []PromptGroup{{ID: GeneralPromptGroup, Name: "通用"}}
}

// DefaultTargetProfiles：稳妥发送 + 终端（安全）；旧版开过「粘贴后回车」的，默认方案改为每次确认。
func DefaultTargetProfiles(legacyAutoEnter bool) []TargetProfile {
	safe := safetyProfile
	if legacyAutoEnter {
		safe.EnterPolicy = "confirm"
	}
	return []TargetProfile{safe, {ID: TerminalProfileID, Name: "终端（安全）", BundleIDs: slices.Clone(TerminalBundleIDs),
		PromptGroupID: GeneralPromptGroup, DefaultFormat: "code", DefaultMarkdownMode: "preserve", EnterPolicy: "never", PrivacyPolicy: "requireRedaction"}}
}

// ProfileConfig：设置里的方案（未配置时给默认值，深拷贝，可直接修改后写回）。
func (st Settings) ProfileConfig() (groups []PromptGroup, profiles []TargetProfile, defaultID string) {
	groups = slices.Clone(st.PromptGroups)
	if len(groups) == 0 {
		groups = DefaultPromptGroups()
	}
	for _, p := range st.TargetProfiles {
		p.BundleIDs = slices.Clone(p.BundleIDs)
		profiles = append(profiles, p)
	}
	if len(profiles) == 0 {
		profiles = DefaultTargetProfiles(st.PasteThenEnter)
	}
	defaultID = st.DefaultProfileID
	if !slices.ContainsFunc(profiles, func(p TargetProfile) bool { return p.ID == defaultID }) {
		defaultID = profiles[0].ID
	}
	return
}

// OutputMode：plain | strip-markdown | code。
func (p TargetProfile) OutputMode() string {
	if p.DefaultFormat == "plain" && p.DefaultMarkdownMode == "strip" {
		return "strip-markdown"
	}
	if p.DefaultFormat == "code" {
		return "code"
	}
	return "plain"
}

func (p *TargetProfile) SetOutputMode(mode string) {
	switch mode {
	case "strip-markdown":
		p.DefaultFormat, p.DefaultMarkdownMode = "plain", "strip"
	case "code":
		p.DefaultFormat, p.DefaultMarkdownMode = "code", "preserve"
	default:
		p.DefaultFormat, p.DefaultMarkdownMode = "plain", "preserve"
	}
}

// RuleOverrides：本次（当前目标）单条规则覆盖；空串 / nil = 不覆盖。隐私策略不在覆盖范围。
type RuleOverrides struct {
	PromptGroupID string
	OutputMode    string
	EnterPolicy   string
	KeepPanel     *bool
}

type ProfileResolution struct {
	Profile    TargetProfile
	Group      PromptGroup
	Source     string // temporary | exact | fallback | conflict
	Reason     string // temporary_override | temporary_target_changed | exact_bundle_match | duplicate_bundle_conflict | fallback_default | target_missing
	Clamped    bool   // 未命中 bundle：默认方案的回车 / 隐私被钳到最稳妥
	Duplicates []string
	Overridden []string // promptGroupId | defaultOutputMode | enterPolicy | keepPanel
}

// ResolveProfile 同 Tauri resolveTargetProfile：临时指定 > bundle 精确匹配（多条取第一条并标冲突）> 默认方案（钳制回车与隐私）> 内置稳妥发送；
// 规则覆盖在钳制之后叠加（用户本次显式选择）。tempID 只在目标身份未变时传入；tempStale 表示原临时方案因换目标失效。
func ResolveProfile(bundle string, groups []PromptGroup, profiles []TargetProfile, defaultID, tempID string, tempStale bool, ov *RuleOverrides) ProfileResolution {
	r := ProfileResolution{Source: "fallback", Reason: "target_missing", Profile: safetyProfile}
	if bundle != "" {
		r.Reason = "fallback_default"
	}
	var matches []TargetProfile
	if bundle != "" {
		for _, p := range profiles {
			if slices.Contains(p.BundleIDs, bundle) {
				matches = append(matches, p)
				r.Duplicates = append(r.Duplicates, p.ID)
			}
		}
	}
	find := func(id string) (TargetProfile, bool) {
		i := slices.IndexFunc(profiles, func(p TargetProfile) bool { return p.ID == id })
		if i < 0 {
			return TargetProfile{}, false
		}
		return profiles[i], true
	}
	if t, ok := find(tempID); ok && tempID != "" {
		r.Source, r.Reason, r.Profile = "temporary", "temporary_override", t
	} else if len(matches) > 0 {
		r.Source, r.Reason, r.Profile = "exact", "exact_bundle_match", matches[0]
		if len(matches) > 1 {
			r.Source, r.Reason = "conflict", "duplicate_bundle_conflict"
		}
	} else if d, ok := find(defaultID); ok {
		r.Profile = d
	}
	if tempStale {
		r.Reason = "temporary_target_changed"
	}
	if r.Source == "fallback" {
		r.Clamped = r.Profile.EnterPolicy != "never" || r.Profile.PrivacyPolicy != "requireRedaction"
		r.Profile.EnterPolicy, r.Profile.PrivacyPolicy = "never", "requireRedaction"
	}
	r.Profile.BundleIDs = slices.Clone(r.Profile.BundleIDs)
	if ov != nil {
		if ov.PromptGroupID != "" && ov.PromptGroupID != r.Profile.PromptGroupID && slices.ContainsFunc(groups, func(g PromptGroup) bool { return g.ID == ov.PromptGroupID }) {
			r.Profile.PromptGroupID = ov.PromptGroupID
			r.Overridden = append(r.Overridden, "promptGroupId")
		}
		if ov.OutputMode != "" && ov.OutputMode != r.Profile.OutputMode() {
			r.Profile.SetOutputMode(ov.OutputMode)
			r.Overridden = append(r.Overridden, "defaultOutputMode")
		}
		if ov.EnterPolicy != "" && ov.EnterPolicy != r.Profile.EnterPolicy {
			r.Profile.EnterPolicy = ov.EnterPolicy
			r.Overridden = append(r.Overridden, "enterPolicy")
		}
		if ov.KeepPanel != nil && *ov.KeepPanel != r.Profile.KeepPanel {
			r.Profile.KeepPanel = *ov.KeepPanel
			r.Overridden = append(r.Overridden, "keepPanel")
		}
	}
	r.Group = DefaultPromptGroups()[0]
	for _, id := range []string{r.Profile.PromptGroupID, GeneralPromptGroup} {
		if i := slices.IndexFunc(groups, func(g PromptGroup) bool { return g.ID == id }); i >= 0 {
			r.Group = groups[i]
			break
		}
	}
	return r
}

// FormatForDelivery 按输出格式加工发送文本（同 Tauri：代码块 = wrapAsCodeBlock，无 Markdown = markdownToPlainText）。
func FormatForDelivery(text, mode string) string {
	switch mode {
	case "code":
		return "```\n" + text + "\n```"
	case "strip-markdown":
		return MarkdownToPlain(text)
	}
	return text
}

var (
	mdImage   = regexp.MustCompile(`!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)`)
	mdLink    = regexp.MustCompile(`\[([^\]]+)\]\(([^)\s]*)(?:\s+"[^"]*")?\)`)
	mdCode    = regexp.MustCompile("`([^`]+)`")
	mdStrong  = regexp.MustCompile(`\*\*([^*]+)\*\*|__([^_]+)__`)
	mdEm      = regexp.MustCompile(`\*([^*\s][^*]*)\*`)
	mdStrike  = regexp.MustCompile(`~~([^~]+)~~`)
	mdBr      = regexp.MustCompile(`(?i)<br\s*/?>`)
	mdTag     = regexp.MustCompile(`<[^>]*>`)
	mdHeading = regexp.MustCompile(`^#{1,6}\s+`)
	mdHr      = regexp.MustCompile(`^\s*([-*_])(\s*[-*_]){2,}\s*$`)
	mdBullet  = regexp.MustCompile(`^(\s*)[-*+]\s+(\[([ xX])\]\s+)?`)
	mdOrdered = regexp.MustCompile(`^(\s*)(\d+)[.)]\s+(\[([ xX])\]\s+)?`)
	mdTableHr = regexp.MustCompile(`^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$`)
	mdBlanks  = regexp.MustCompile(`\n{3,}`)
)

func mdInline(s string) string {
	s = mdBr.ReplaceAllString(s, "\n")
	s = mdTag.ReplaceAllString(s, "")
	s = mdImage.ReplaceAllStringFunc(s, func(m string) string {
		g := mdImage.FindStringSubmatch(m)
		label := strings.TrimSpace(g[1])
		if label == "" {
			label = "图片"
		}
		if g[2] == "" {
			return "图片：" + label
		}
		return "图片：" + label + "（" + g[2] + "）"
	})
	s = mdLink.ReplaceAllStringFunc(s, func(m string) string {
		g := mdLink.FindStringSubmatch(m)
		if g[2] == "" || g[1] == g[2] || g[2] == "mailto:"+g[1] {
			return g[1]
		}
		return g[1] + "（" + g[2] + "）"
	})
	s = mdCode.ReplaceAllString(s, "$1")
	s = mdStrong.ReplaceAllString(s, "$1$2")
	s = mdEm.ReplaceAllString(s, "$1")
	return mdStrike.ReplaceAllString(s, "$1")
}

// MarkdownToPlain：Markdown → 可直接粘贴的纯文本（只删表示层语法，保留列表、任务状态、链接地址与表格结构）。
func MarkdownToPlain(text string) string {
	var out []string
	inFence := false
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "```") || strings.HasPrefix(trim, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			out = append(out, line)
			continue
		}
		for strings.HasPrefix(strings.TrimLeft(line, " "), ">") {
			line = strings.TrimPrefix(strings.TrimLeft(line, " "), ">")
			line = strings.TrimPrefix(line, " ")
		}
		switch {
		case mdHr.MatchString(line) || mdTableHr.MatchString(line) && strings.Contains(line, "-") && strings.Contains(line, "|"):
			continue
		case mdHeading.MatchString(line):
			line = mdHeading.ReplaceAllString(line, "")
		case mdBullet.MatchString(line):
			g := mdBullet.FindStringSubmatch(line)
			line = strings.Repeat("  ", len(g[1])/2) + "• " + checkbox(g[3]) + line[len(g[0]):]
		case mdOrdered.MatchString(line):
			g := mdOrdered.FindStringSubmatch(line)
			n, _ := strconv.Atoi(g[2])
			line = strings.Repeat("  ", len(g[1])/2) + strconv.Itoa(n) + ". " + checkbox(g[4]) + line[len(g[0]):]
		case strings.HasPrefix(trim, "|") && strings.HasSuffix(trim, "|"):
			cells := strings.Split(strings.Trim(trim, "|"), "|")
			for i := range cells {
				cells[i] = strings.TrimSpace(cells[i])
			}
			line = strings.Join(cells, "\t")
		}
		out = append(out, strings.TrimRight(mdInline(line), " \t"))
	}
	return strings.TrimSpace(mdBlanks.ReplaceAllString(strings.Join(out, "\n"), "\n\n"))
}

func checkbox(mark string) string {
	switch mark {
	case "":
		return ""
	case " ":
		return "☐ "
	}
	return "☒ "
}
