package store

import (
	"slices"
	"testing"
)

func TestResolveProfile(t *testing.T) {
	groups := DefaultPromptGroups()
	profiles := DefaultTargetProfiles(false)
	ai := TargetProfile{ID: "ai", Name: "AI 对话", BundleIDs: []string{"com.openai.chat"}, PromptGroupID: GeneralPromptGroup,
		DefaultFormat: "plain", DefaultMarkdownMode: "preserve", EnterPolicy: "confirm", PrivacyPolicy: "confirmRaw", KeepPanel: true}
	profiles = append(profiles, ai)

	r := ResolveProfile("com.apple.Terminal", groups, profiles, SafetyProfileID, "", false, nil)
	if r.Source != "exact" || r.Profile.ID != TerminalProfileID || r.Profile.OutputMode() != "code" {
		t.Fatalf("终端应精确命中终端方案 %+v", r)
	}
	if r := ResolveProfile("", groups, profiles, SafetyProfileID, "", false, nil); r.Reason != "target_missing" || r.Profile.ID != SafetyProfileID {
		t.Fatalf("无目标 %+v", r)
	}
	// 默认方案放宽了回车 / 隐私：未命中 bundle 时钳回最稳妥
	r = ResolveProfile("com.apple.Safari", groups, profiles, "ai", "", false, nil)
	if r.Source != "fallback" || r.Profile.ID != "ai" || !r.Clamped || r.Profile.EnterPolicy != "never" || r.Profile.PrivacyPolicy != "requireRedaction" || !r.Profile.KeepPanel {
		t.Fatalf("回落默认应钳制 %+v", r)
	}
	// 临时指定优先；换目标后失效并给出原因
	if r := ResolveProfile("com.apple.Terminal", groups, profiles, SafetyProfileID, "ai", false, nil); r.Source != "temporary" || r.Profile.EnterPolicy != "confirm" {
		t.Fatalf("临时指定 %+v", r)
	}
	if r := ResolveProfile("com.apple.Terminal", groups, profiles, SafetyProfileID, "", true, nil); r.Reason != "temporary_target_changed" || r.Profile.ID != TerminalProfileID {
		t.Fatalf("临时方案失效 %+v", r)
	}
	// 重复绑定：取第一条并标冲突
	dup := append(slices.Clone(profiles), TargetProfile{ID: "dup", BundleIDs: []string{"com.openai.chat"}})
	if r := ResolveProfile("com.openai.chat", groups, dup, SafetyProfileID, "", false, nil); r.Source != "conflict" || r.Profile.ID != "ai" || len(r.Duplicates) != 2 {
		t.Fatalf("冲突 %+v", r)
	}
	// 规则覆盖叠加在钳制之后，只记与基线不同的键
	keep := false
	r = ResolveProfile("com.apple.Safari", groups, profiles, SafetyProfileID, "", false, &RuleOverrides{OutputMode: "strip-markdown", EnterPolicy: "allow", KeepPanel: &keep, PromptGroupID: "missing"})
	if r.Profile.OutputMode() != "strip-markdown" || r.Profile.EnterPolicy != "allow" || !slices.Equal(r.Overridden, []string{"defaultOutputMode", "enterPolicy"}) {
		t.Fatalf("规则覆盖 %+v", r)
	}
	// 旧版「粘贴后回车」迁移为每次确认
	if p := DefaultTargetProfiles(true)[0]; p.EnterPolicy != "confirm" {
		t.Fatal("legacyAutoEnter")
	}
	st := Settings{}
	if _, ps, def := st.ProfileConfig(); len(ps) != 2 || def != SafetyProfileID {
		t.Fatalf("未配置时用默认方案 %v %q", ps, def)
	}
}

func TestFormatForDelivery(t *testing.T) {
	md := "# 标题\n\n**粗体** 和 *斜体* 与 `code`，见 [文档](https://x.dev) 与 [https://a.b](https://a.b)\n\n- [ ] 待办\n- [x] 完成\n  - 子项\n1. 第一\n\n> 引用\n\n---\n\n| 名 | 值 |\n| --- | --- |\n| a | 1 |\n\n```go\nfmt.Println(1)\n```\n![图](p.png)"
	want := "标题\n\n粗体 和 斜体 与 code，见 文档（https://x.dev） 与 https://a.b\n\n• ☐ 待办\n• ☒ 完成\n  • 子项\n1. 第一\n\n引用\n\n名\t值\na\t1\n\nfmt.Println(1)\n图片：图（p.png）"
	if got := FormatForDelivery(md, "strip-markdown"); got != want {
		t.Fatalf("去 Markdown：\n%s\n---want---\n%s", got, want)
	}
	if got := FormatForDelivery("ls -la", "code"); got != "```\nls -la\n```" {
		t.Fatalf("代码块 %q", got)
	}
	if FormatForDelivery("a *b*", "plain") != "a *b*" {
		t.Fatal("原文不动")
	}
}

func TestPromptSnippets(t *testing.T) {
	if got := ApplyPromptTemplate("翻译成英文：{内容}\n只输出译文", "你好"); got != "翻译成英文：你好\n只输出译文" {
		t.Fatalf("占位 %q", got)
	}
	if got := ApplyPromptTemplate("请总结", "正文 $& 不展开"); got != "请总结\n\n正文 $& 不展开" {
		t.Fatalf("前缀 %q", got)
	}
	if got := ApplyPromptTemplate("{CONTENT} / {占位}", "x"); got != "x / x" {
		t.Fatalf("多处、大小写 %q", got)
	}
	snips := []PromptSnippet{{ID: "a", GroupID: "g2"}, {ID: "b", GroupID: GeneralPromptGroup, IsCommon: true}, {ID: "c", GroupID: GeneralPromptGroup}}
	common, rest := SnippetsForGroup(snips, GeneralPromptGroup)
	if len(common) != 1 || common[0].ID != "b" || len(rest) != 2 || rest[0].ID != "c" || rest[1].ID != "a" {
		t.Fatalf("分组排序 %v %v", common, rest)
	}
	var st Settings
	for _, id := range []string{"1", "2", "3", "4", "5", "6", "3"} {
		st.UseSnippet(id)
	}
	if !slices.Equal(st.RecentSnippets, []string{"3", "6", "5", "4", "2"}) {
		t.Fatalf("最近使用 %v", st.RecentSnippets)
	}
}

func TestAppearanceDefaultsAndClamp(t *testing.T) {
	var st Settings
	if st.WindowAlpha() != 1 || st.PanelAlpha() != 0.62 || st.CardAlpha() != 1 || st.HUDDuration().Seconds() != 3 || st.Gap() != 8 {
		t.Fatal("未设置时用 Tauri 默认值")
	}
	zero, big := 0, 99
	st = Settings{WindowOpacity: 0.1, PanelOpacity: 2, HUDDurationMs: 60000, CompanionGap: &zero}
	if st.WindowAlpha() != 0.3 || st.PanelAlpha() != 1 || st.HUDDuration().Seconds() != 10 || st.Gap() != 0 {
		t.Fatal("越界值夹到范围内；间隙 0 是有效值")
	}
	st.CompanionGap = &big
	if st.Gap() != 40 {
		t.Fatal("间隙上限 40")
	}
}
