package main

import (
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 粘贴规则：三个子页签；默认规则锁回车 / 敏感处理；共享方案里的应用按「仅此应用」改会拆出独立方案，其他应用不变；恢复默认解除绑定。
func TestPasteRulesInspector(t *testing.T) {
	a, _ := testApp(t)
	a.openSettingsAt(setPagePaste, 0)
	set := ui.NewTester(a.settingsView, 1040, 2000)
	set.Frame()
	for _, s := range []string{"粘贴规则", "隐私保护", "提示词模板", "默认规则", "未绑定应用使用这套默认规则", "默认规则始终只粘贴，不自动回车。", "选择应用…"} {
		if !set.HasText(s) {
			t.Fatalf("缺 %q：%v", s, set.Texts())
		}
	}
	if set.HasText("最近发送") {
		t.Fatal("最近发送在主面板抽屉里，不在设置")
	}
	term := "com.apple.Terminal"
	a.paste.sel = term
	set.Frame()
	if !set.HasText("仅此应用") || !set.HasText("修改时为当前应用建立独立规则，其他应用保持原设置。") {
		t.Fatalf("终端方案被 7 个应用共享，应可选修改范围 %v", set.Texts())
	}
	a.applyRule(term, func(p *store.TargetProfile) { p.KeepPanel = true })
	_, ps, _ := a.store.Settings().ProfileConfig()
	own := ownersOf(ps, term)
	if len(own) != 1 || len(own[0].BundleIDs) != 1 || !own[0].KeepPanel || own[0].DefaultFormat != "code" {
		t.Fatalf("仅此应用应拆出独立方案并保留原设置 %+v", own)
	}
	shared := ownersOf(ps, "com.googlecode.iterm2")
	if len(shared) != 1 || shared[0].KeepPanel || slices.Contains(shared[0].BundleIDs, term) {
		t.Fatalf("其他应用不受影响 %+v", shared)
	}
	a.restoreDefaultRule(term)
	_, ps, _ = a.store.Settings().ProfileConfig()
	if len(ownersOf(ps, term)) != 0 {
		t.Fatal("恢复默认应解除绑定")
	}
	pickAppBundle = func(*app) string { return "com.apple.Notes" }
	set.Frame()
	if err := set.Click("选择应用…"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if a.paste.sel != "com.apple.Notes" || !set.HasText("尚未单独设置，当前使用默认规则") {
		t.Fatalf("选择应用后应选中它 %q %v", a.paste.sel, set.Texts())
	}
}

// 隐私保护：两张卡片（隐私检查 / 可逆化名），「发现后如何处理」跳回粘贴规则；化名词典「+ 添加」才出表单。
func TestPrivacyProtectionPage(t *testing.T) {
	a, _ := testApp(t)
	a.openSettingsAt(setPagePaste, 1)
	set := ui.NewTester(a.settingsView, 1040, 2000)
	set.Frame()
	for _, s := range []string{"发送前在本机检查敏感内容，原始卡片不会被改写。", "发送前隐私检查", "按粘贴规则", "本机规则可能漏检，发送前仍可在预检中核对最终内容。", "可逆化名", "0 条", "+ 添加", "捕获回复时自动还原", "试一试替换效果"} {
		if !set.HasText(s) {
			t.Fatalf("缺 %q：%v", s, set.Texts())
		}
	}
	if set.HasText("原文（精确匹配，区分大小写）") {
		t.Fatal("添加表单默认收起")
	}
	if err := set.Click("+ 添加"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if !a.aliasUI.open {
		t.Fatal("点「+ 添加」应展开表单")
	}
	if err := set.Click("按粘贴规则"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if a.setSub != 0 {
		t.Fatalf("应跳到粘贴规则 sub=%d", a.setSub)
	}
	a.patchSettings(func(x *store.Settings) { x.AliasOff = true })
	a.setSub = 1
	set.Frame()
	if set.HasText("捕获回复时自动还原") || set.HasText("词典加密保存在本机；导出的完整备份中为明文。删除条目后，它的占位符编号不再复用。") {
		t.Fatal("化名关闭时只留总开关")
	}
}

// 粘贴规则卡片的「模板排序」「输出预览」与「当前目标与规则检查」（同 Tauri ApplicationRuleFields / CurrentTargetPreview）。
func TestPasteRuleExtras(t *testing.T) {
	a, _ := testApp(t)
	a.openSettingsAt(setPagePaste, 0)
	set := ui.NewTester(a.settingsView, 1040, 2400)
	set.Frame()
	for _, s := range []string{"模板排序", "输出预览", "测试内容（可编辑，最多 4000 字符）", "格式预览 · 原文", "当前目标与规则检查"} {
		if !set.HasText(s) {
			t.Fatalf("缺 %q：%v", s, set.Texts())
		}
	}
	// 输出预览：与发送链路同一转换；切到代码块的方案后预览带围栏
	term := "com.apple.Terminal"
	a.paste.sel = term
	set.Frame()
	if !set.HasText("格式预览 · 代码块") || store.FormatForDelivery(a.paste.preview, "code") == a.paste.preview {
		t.Fatalf("终端方案应预览代码块 %v", set.Texts())
	}
	a.paste.preview = strings.Repeat("字", previewMaxRunes+50)
	set.Frame()
	if n := len([]rune(a.paste.preview)); n != previewMaxRunes {
		t.Fatalf("测试内容最多 4000 字符，得 %d", n)
	}
	a.paste.preview = defaultPreviewText()
	// 模板排序：改提示词组写进该应用的规则（仅此应用 → 拆出独立方案）
	groups, _, _ := a.store.Settings().ProfileConfig()
	if len(groups) == 0 {
		t.Fatal("应有提示词组")
	}
	a.paste.tmplOpen = true
	set.Frame()
	if !set.HasText("只影响「其他模板」的顺序，不会自动套用模板。") {
		t.Fatalf("模板排序展开 %v", set.Texts())
	}
	want := groups[len(groups)-1].ID
	a.applyRule(term, func(p *store.TargetProfile) { p.PromptGroupID = want })
	_, ps, _ := a.store.Settings().ProfileConfig()
	if own := ownersOf(ps, term); len(own) != 1 || own[0].PromptGroupID != want {
		t.Fatalf("提示词组应写进终端规则 %+v", own)
	}
	// 当前目标与规则检查：检查只重算说明；「调整粘贴规则」选中当前目标
	a.target.PID, a.target.BundleID, a.target.Name = 4242, "com.example.Editor", "Editor"
	a.paste.targetOpen = true
	set.Frame()
	for _, s := range []string{"当前粘贴目标", "检查规则", "重新识别目标", "调整粘贴规则"} {
		if !set.HasText(s) {
			t.Fatalf("目标检查缺 %q：%v", s, set.Texts())
		}
	}
	if err := set.Click("检查规则"); err != nil {
		t.Fatal(err)
	}
	set.Frame()
	if !strings.Contains(a.paste.checkMsg, "未执行粘贴或回车") {
		t.Fatalf("检查结果 %q", a.paste.checkMsg)
	}
	a.editTargetRule()
	if a.paste.sel != "com.example.Editor" {
		t.Fatalf("应选中当前目标 %q", a.paste.sel)
	}
}
