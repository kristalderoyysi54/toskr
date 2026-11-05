package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/secretcodec"
	"github.com/toskr/native/internal/store"
)

var (
	modifierNames  = []string{"shift", "control", "option"}
	modifierLabels = []string{"⇧ Shift", "⌃ Control", "⌥ Option"}
	glassNames     = []string{"glass", "clear", "none"}
	glassLabels    = []string{"液态玻璃", "清透玻璃", "关闭"}
	langNames      = []string{"system", "zh", "en"}
)

// importPreview 是待确认的备份导入（设置窗主线程读写）。
var importPreview *store.Preview

func (a *app) openSettings() {
	a.openSettingsState()
	if a.settingsWin == nil {
		a.settingsWin = mygo.NewWindow(mygo.WindowOptions{
			Title: "Toskr 设置", Width: 1040, Height: 720, MinWidth: 560, MinHeight: 420, Hidden: true,
			Vibrancy: mygo.VibrancySidebar, Transparent: true,
			Content: ui.View(a.settingsView),
		})
		a.settingsWin.OnClose(func(e *mygo.CloseEvent) {
			e.PreventDefault()
			a.settingsWin.Hide()
		})
	}
	a.settingsWin.Invalidate()
	a.settingsWin.Show()
	a.settingsWin.Focus()
}

// openSettingsState 把当前设置载入设置窗编辑态（对照测试也用它准备首屏）。
func (a *app) openSettingsState() {
	st := a.store.Settings()
	a.setModifier = max(0, slices.Index(modifierNames, st.TriggerModifier))
	a.setGap = float64(st.TriggerGapMs)
	a.setClip = st.ClipboardWatch
	a.setGlass = max(0, slices.Index(glassNames, st.Glass))
	a.setExcluded = strings.Join(st.ExcludedApps, "\n")
	a.setRetain = float64(st.ClipRetainDays)
	a.setLang = max(0, slices.Index(langNames, st.Language))
	a.setAIEnd, a.setAIModel, a.setAIKey = st.AIEndpoint, st.AIModel, ""
	a.setCompan = strings.Join(st.Companion, "\n")
	a.axTrusted = macos.AXTrusted(false)
	a.recovery = a.store.RecoveryPoints()
}

func lines(s string) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}

func (a *app) saveSettings() {
	st := a.store.Settings()
	st.TriggerModifier = modifierNames[a.setModifier]
	st.TriggerGapMs = int(a.setGap)
	st.ClipboardWatch = a.setClip
	oldGlass := st.Glass
	st.Glass = glassNames[a.setGlass]
	st.ExcludedApps = lines(a.setExcluded)
	st.ClipRetainDays = int(a.setRetain)
	st.Language = langNames[a.setLang]
	st.AIEndpoint, st.AIModel = strings.TrimSpace(a.setAIEnd), strings.TrimSpace(a.setAIModel)
	st.Companion = lines(a.setCompan)
	_ = a.store.SetSettings(st)
	setLanguage(st.Language, mygo.App.PreferredLanguages())
	if oldGlass != st.Glass {
		v := vibrancyFor(st.Glass)
		a.panel.SetVibrancy(v)
		a.hud.SetVibrancy(v)
	}
	a.panel.Invalidate()
}

func (a *app) settingsView(c *ui.Context) {
	registerFonts()
	k, s := tok(c), stok(c)
	st := a.store.Settings()
	changed := false
	setToggle := func(v bool, set func(*store.Settings, bool)) func() {
		return func() {
			on := v
			if toggle(c, s, &on) {
				cur := a.store.Settings()
				set(&cur, on)
				_ = a.store.SetSettings(cur)
			}
		}
	}
	hotkey := func(v string) func() {
		return func() {
			ui.Row(c).Height(28).Padding(0, 10).Radius(10).Background(k.track).AlignItems(ui.Center).Children(func() {
				text(c, keyLabel(v), 12, 17, 500, k.fg).Font(fontMono)
			})
		}
	}
	retain := tr("不按时间清理")
	if a.setRetain > 0 {
		retain = itoa(int(a.setRetain)) + tr(" 天")
	}

	var recent []setRow
	for _, d := range a.history[:min(len(a.history), 8)] {
		r := setRow{title: fmt.Sprintf("%s · %d 条 → %s", d.At.Format("15:04:05"), d.Count, d.Target)}
		if d.Err != "" {
			r.hint = "✗ " + d.Err
		}
		recent = append(recent, r)
	}
	if len(recent) == 0 {
		recent = []setRow{{title: tr("暂无发送记录")}}
	}

	aiStatus := tr("未配置")
	if aiKey() != "" {
		aiStatus = tr("已存入钥匙串")
	}
	axStatus, tapStatus := tr("未授权"), tr("正常")
	if a.axTrusted {
		axStatus = tr("已授权")
	}
	if a.tapErr != "" {
		tapStatus = a.tapErr
	}

	pages := []setPage{
		{label: "窗口与外观", icon: "settings-2", subs: []string{"通用", "伴随停靠"}, sections: [][]setSection{
			{
				{tr("常用外观"), []setRow{
					{title: tr("语言"), hint: tr("跟随系统时，中文系统显示中文，其余显示英文"), control: func() {
						changed = segmented(c, k, &a.setLang, "跟随系统", "简体中文", "English") || changed
					}},
					{title: tr("面板材质"), hint: tr("macOS 26 起为系统液态玻璃，更早系统回退为模糊材质"), control: func() {
						changed = segmented(c, k, &a.setGlass, glassLabels...) || changed
					}},
				}},
				{tr("窗口与提示"), []setRow{
					{title: tr("隐身模式"), hint: tr("不弹「已捕获」气泡，适合投屏；失败提醒仍会显示"), control: setToggle(st.Stealth, func(s *store.Settings, v bool) { s.Stealth = v })},
				}},
			},
			{
				{tr("伴随停靠"), []setRow{
					{title: tr("伴随应用"), hint: tr("以下应用在前台时，面板贴在其窗口右侧并跟随移动缩放（每行一个 bundle id）"), below: func() {
						changed = textBox(c, k, s, &a.setCompan, 3, 8) || changed
					}},
				}},
			},
		}},
		{label: "快捷键", icon: "keyboard", sections: [][]setSection{{
			{tr("划词捕获"), []setRow{
				{title: tr("双击修饰键"), hint: tr("选中文字后连按两次即捕获；无选中时开关面板"), control: func() {
					changed = segmented(c, k, &a.setModifier, modifierLabels...) || changed
				}},
				{title: tr("两击最大间隔"), hint: tr("两次按键间隔超过此值不算双击"), control: func() {
					changed = sliderValue(c, k, &a.setGap, 150, 1000, 50, itoa(int(a.setGap))+"ms") || changed
				}},
			}},
			{tr("全局快捷键"), []setRow{
				{title: tr("开关面板"), control: hotkey(a.shortcut)},
				{title: tr("截图"), control: hotkey(st.ScreenshotKey)},
			}},
		}}},
		{label: "剪贴板", icon: "clipboard-list", sections: [][]setSection{{
			{tr("剪贴板历史"), []setRow{
				{title: tr("记录剪贴板历史"), hint: tr("复制的文字、链接与图片自动进入「剪贴」页"), control: func() {
					changed = toggle(c, s, &a.setClip) || changed
				}},
				{title: tr("保留时长"), hint: tr("超期记录自动清理，置顶项除外"), control: func() {
					changed = sliderValue(c, k, &a.setRetain, 0, 90, 1, retain) || changed
				}},
				{title: tr("清空剪贴板分组"), hint: tr("置顶项保留"), control: func() {
					if button(c, s, "清空") {
						n := a.store.ClearSection(store.SectionClipboard)
						c.Toast(tr("已清空 ") + itoa(n) + tr(" 条"))
					}
				}},
			}},
			{tr("排除应用"), []setRow{
				{title: tr("不记录这些应用"), hint: tr("每行一个 bundle id，来自这些应用的复制与划词都不会被记录"), below: func() {
					changed = textBox(c, k, s, &a.setExcluded, 3, 8) || changed
				}},
			}},
		}}},
		{label: "粘贴与隐私", icon: "crosshair", sections: [][]setSection{{
			{tr("发送"), []setRow{
				{title: tr("粘贴后回车"), hint: tr("终端类目标始终不回车"), control: setToggle(st.PasteThenEnter, func(s *store.Settings, v bool) { s.PasteThenEnter = v })},
				{title: tr("发送前预检"), hint: tr("自动检查密钥、令牌、银行卡号、身份证号，命中时在面板里确认或遮罩后发送")},
			}},
			{tr("最近发送"), recent},
		}}},
		{label: "更多功能", icon: "blocks", sections: [][]setSection{{
			{tr("功能"), []setRow{
				{title: tr("秘文"), hint: tr("在本机把文字加密成中文、代码、日志等格式，对方自动识别解密"), control: setToggle(st.SecretEnabled, func(s *store.Settings, v bool) { s.SecretEnabled = v })},
				{title: tr("订阅"), hint: tr("管理账单与信用卡到期，在「提醒」页按时提醒"), control: setToggle(st.SubscriptionsEnabled, func(s *store.Settings, v bool) { s.SubscriptionsEnabled = v })},
			}},
			{tr("提醒"), []setRow{
				{title: tr("任务到期与账单提醒"), hint: tr("通过系统通知提醒"), control: setToggle(st.DueReminders, func(s *store.Settings, v bool) { s.DueReminders = v })},
				{title: tr("货币符号"), hint: tr("账单金额前缀"), control: func() {
					cur := st.Currency
					if textField(c, k, s, &cur, 64, "¥", false) {
						ns := a.store.Settings()
						ns.Currency = cur
						_ = a.store.SetSettings(ns)
					}
				}},
			}},
			{tr("AI（OpenAI 兼容接口）"), []setRow{
				{title: tr("接口地址"), control: func() { changed = textField(c, k, s, &a.setAIEnd, 280, "https://api.openai.com/v1", false) || changed }},
				{title: tr("模型"), control: func() { changed = textField(c, k, s, &a.setAIModel, 280, "gpt-4o-mini", false) || changed }},
				{title: tr("密钥"), hint: aiStatus, control: func() {
					ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
						textField(c, k, s, &a.setAIKey, 180, "sk-…", true)
						if button(c, s, "保存") && strings.TrimSpace(a.setAIKey) != "" {
							if err := mygo.Secrets.Set(aiKeyName, []byte(strings.TrimSpace(a.setAIKey))); err != nil {
								c.Toast(tr("保存失败：") + err.Error())
							} else {
								a.setAIKey = ""
								c.Toast(tr("已存入钥匙串"))
							}
						}
					})
				}},
				{title: tr("右键笔记 → AI"), hint: tr("润色 / 精简 / 翻译 / 写成提示词，结果作为新笔记插在原文上方")},
			}},
		}}},
		{label: "数据与备份", icon: "database", sections: [][]setSection{a.dataSections(c, k, s)}},
		{label: "权限", icon: "shield-check", sections: [][]setSection{{
			{tr("系统权限"), []setRow{
				{title: tr("辅助功能"), hint: tr("读取选区、合成粘贴、伴随停靠 · ") + axStatus, control: func() {
					if button(c, s, "打开授权") {
						a.axTrusted = macos.AXTrusted(true)
					}
				}},
				{title: tr("键盘监听"), hint: tapStatus},
			}},
		}}},
		{label: "帮助与更新", icon: "info", sections: [][]setSection{{
			{tr("关于"), []setRow{
				{title: "Toskr Native " + mygo.App.Version(), hint: cmpOr(a.updateMsg, "mygo · "+tr("原生界面")), control: func() {
					if button(c, s, "检查更新") {
						a.checkUpdate()
					}
				}},
			}},
		}}},
	}
	if st.SecretEnabled { // 与 Tauri 一致：秘文功能开启后侧栏才出现「秘文」分类
		pages = slices.Insert(pages, 5, setPage{label: "秘文", icon: "key-round", sections: [][]setSection{a.secretSections(c, k, s, st)}})
	}
	a.settingsShell(c, pages)
	if changed {
		a.saveSettings()
	}
}

func (a *app) dataSections(c *ui.Context, k tokens, s settingsTokens) []setSection {
	backup := []setRow{
		{title: tr("数据目录"), hint: dataDir()},
		{title: tr("加密"), hint: tr("AES-256-GCM（TSK1 信封），密钥存于钥匙串；图片按内容哈希加密存放")},
		{title: tr("导出备份"), hint: tr(".toskr-backup，加密"), control: func() {
			if button(c, s, "导出…") {
				a.exportBackup(c)
			}
		}},
		{title: tr("从备份合并导入"), hint: tr("本机同 ID 记录优先，导入前自动写恢复点"), control: func() {
			if button(c, s, "选择文件…") {
				a.inspectBackup(c)
			}
		}},
	}
	if p := importPreview; p != nil {
		hint := fmt.Sprintf(tr("备份时间 %s · 笔记 %d（新增 %d / 已有 %d）· 任务 %d · 账单 %d · 秘文 %d"),
			p.Manifest.CreatedAt.Format("2006-01-02 15:04"), p.Manifest.Counts["notes"], p.New, p.Overlap,
			p.Manifest.Counts["tasks"], p.Manifest.Counts["bills"], p.Manifest.Counts["secrets"])
		if p.MissingMedia > 0 {
			hint += fmt.Sprintf(tr(" · %d 张图片校验失败，将跳过"), p.MissingMedia)
		}
		backup = append(backup, setRow{title: tr("待导入的备份"), hint: hint, control: func() {
			ui.Row(c).Gap(6).Children(func() {
				if button(c, s, "合并导入") {
					n, err := a.store.ImportBackup(p)
					importPreview = nil
					if err != nil {
						c.Toast(tr("导入失败：") + err.Error())
					} else {
						c.Toast(fmt.Sprintf(tr("已导入 %d 条笔记（导入前已写恢复点）"), n))
						a.recovery = a.store.RecoveryPoints()
					}
				}
				if button(c, s, "取消") {
					importPreview = nil
				}
			})
		}})
	}
	var points []setRow
	for i := len(a.recovery) - 1; i >= 0; i-- {
		p := a.recovery[i]
		points = append(points, setRow{title: recoveryLabel(p), control: func() {
			if button(c, s, "恢复到此") {
				if err := a.store.RestoreRecoveryPoint(p); err != nil {
					c.Toast(tr("恢复失败：") + err.Error())
				} else {
					c.Toast(tr("已恢复（恢复前的数据也存了一个恢复点）"))
					a.recovery = a.store.RecoveryPoints()
				}
			}
		}})
	}
	if len(points) == 0 {
		points = []setRow{{title: tr("暂无恢复点")}}
	}
	health := cmpOr(a.health, tr("只报告，不改数据"))
	return []setSection{
		{tr("备份与导入"), backup},
		{fmt.Sprintf(tr("恢复点（启动 / 导入 / 恢复前自动生成，保留 %d 份）"), store.RecoveryKeep), points},
		{tr("维护"), []setRow{{title: tr("数据健康检查"), hint: health, control: func() {
			if button(c, s, "检查") {
				h := a.store.CheckHealth()
				a.health = fmt.Sprintf(tr("笔记 %d · 缺失图片 %d · 孤立图片 %d · 分组失联 %d"), h.Notes, h.MissingMedia, h.OrphanMedia, h.OrphanSectionRefs)
			}
		}}}},
	}
}

func recoveryLabel(path string) string {
	base := filepath.Base(path) // pre-launch-<13位毫秒>-<tag>.bak
	parts := strings.SplitN(strings.TrimSuffix(strings.TrimPrefix(base, "pre-launch-"), ".bak"), "-", 2)
	var ms int64
	_, _ = fmt.Sscan(parts[0], &ms)
	tag := map[string]string{"launch": "启动", "pre-import": "导入前", "pre-restore": "恢复前"}
	label := time.UnixMilli(ms).Format("01-02 15:04:05")
	if len(parts) == 2 {
		label += " · " + cmpOr(tag[parts[1]], parts[1])
	}
	return label
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func (a *app) exportBackup(c *ui.Context) {
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: a.settingsWin, Title: "导出备份",
		DefaultPath: "Toskr-" + time.Now().Format("20060102-1504") + ".toskr-backup",
		Filters:     []mygo.FileFilter{{Name: "Toskr 备份", Extensions: []string{"toskr-backup"}}}})
	if err != nil || path == "" {
		return
	}
	man, err := a.store.ExportBackup(path)
	if err != nil {
		c.Toast("导出失败：" + err.Error())
		return
	}
	c.Toast(fmt.Sprintf("已导出：笔记 %d · 图片 %d", man.Counts["notes"], len(man.Media)))
}

func (a *app) inspectBackup(c *ui.Context) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: a.settingsWin, Title: "选择备份",
		Filters: []mygo.FileFilter{{Name: "Toskr 备份", Extensions: []string{"toskr-backup"}}}})
	if err != nil || len(paths) == 0 {
		return
	}
	p, err := a.store.InspectBackup(paths[0])
	if err != nil {
		c.Toast("备份无法使用：" + err.Error())
		return
	}
	importPreview = p
}

func (a *app) checkUpdate() {
	a.updateMsg = "检查中…"
	go func() {
		up, err := mygo.Updater.Check(context.Background())
		msg := ""
		switch {
		case errors.Is(err, mygo.ErrUpdatesDisabled):
			msg = "此构建未启用自动更新（mygo.json 尚未配置 updates.publicKey 与发布仓库）"
		case err != nil:
			msg = "检查失败：" + err.Error()
		case up == nil:
			msg = "已是最新版本"
		default:
			msg = "发现新版本 " + up.Version + "，正在下载安装…"
			go func() {
				if err := up.Install(context.Background(), nil); err != nil {
					a.settingsWin.Update(func() { a.updateMsg = "安装失败：" + err.Error() })
					return
				}
				mygo.App.Relaunch()
			}()
		}
		a.settingsWin.Update(func() { a.updateMsg = msg })
	}()
}

func keyLabel(s string) string {
	return strings.NewReplacer("Cmd+", "⌘", "CmdOrCtrl+", "⌘", "Shift+", "⇧", "Alt+", "⌥", "Ctrl+", "⌃").Replace(s)
}

// secretSections 是设置「秘文」：共享密钥增删、默认密钥、密文格式、显现时长。
func (a *app) secretSections(c *ui.Context, k tokens, s settingsTokens, st store.Settings) []setSection {
	save := func(fn func(*store.Settings)) {
		cur := a.store.Settings()
		fn(&cur)
		_ = a.store.SetSettings(cur)
	}
	var keys []setRow
	for _, key := range st.SecretKeys {
		hint := tr("创建于 ") + key.CreatedAt.Format("2006-01-02")
		if key.Note != "" {
			hint = key.Note + " · " + hint
		}
		if key.ID == st.SecretDefaultKeyID {
			hint = tr("默认 · ") + hint
		}
		keys = append(keys, setRow{title: cmpOr(key.Label, tr("未命名密钥")), hint: hint, control: func() {
			ui.Row(c).Gap(6).Children(func() {
				if key.ID != st.SecretDefaultKeyID && button(c, s, "设为默认") {
					save(func(x *store.Settings) { x.SecretDefaultKeyID = key.ID })
				}
				if button(c, s, "删除") {
					save(func(x *store.Settings) {
						x.SecretKeys = slices.DeleteFunc(x.SecretKeys, func(y store.SecretKey) bool { return y.ID == key.ID })
						if x.SecretDefaultKeyID == key.ID {
							x.SecretDefaultKeyID = ""
						}
					})
				}
			})
		}})
	}
	keys = append(keys, setRow{title: tr("添加共享密钥"), hint: tr("与对方约定相同的暗号（中文、字符皆可），备注写清给谁、何时设置"), below: func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			textField(c, k, s, &a.newKeyLabel, 120, tr("给谁 / 场景"), false)
			textField(c, k, s, &a.newKeyPass, 200, tr("共享密钥"), true)
			textField(c, k, s, &a.newKeyNote, 160, tr("备注（可选）"), false)
			if button(c, s, "添加") {
				if strings.TrimSpace(a.newKeyPass) == "" {
					c.Toast(tr("密钥不能为空"))
					return
				}
				key := store.SecretKey{ID: fmt.Sprintf("k%d", time.Now().UnixNano()), Label: strings.TrimSpace(a.newKeyLabel),
					Passphrase: a.newKeyPass, Note: strings.TrimSpace(a.newKeyNote), CreatedAt: time.Now()}
				save(func(x *store.Settings) {
					x.SecretKeys = append(x.SecretKeys, key)
					if x.SecretDefaultKeyID == "" {
						x.SecretDefaultKeyID = key.ID
					}
				})
				a.newKeyLabel, a.newKeyPass, a.newKeyNote = "", "", ""
			}
		})
	}})
	style := 0
	for i, o := range secretcodec.StyleOptions {
		if string(o.Value) == st.SecretCipherStyle {
			style = i
		}
	}
	var styleLabels []string
	for _, o := range secretcodec.StyleOptions {
		styleLabels = append(styleLabels, o.ShortLabel)
	}
	reveal := float64(st.SecretRevealMs) / 1000
	revealLabel := tr("不自动")
	if reveal > 0 {
		revealLabel = fmt.Sprintf("%ds", int(reveal))
	}
	return []setSection{
		{tr("共享密钥"), keys},
		{tr("收发"), []setRow{
			{title: tr("默认密文格式"), hint: tr("中文文本 / 代码（随机语言）/ 日志记录 / 英文引用；接收端自动识别"), control: func() {
				if segmented(c, k, &style, styleLabels...) {
					save(func(x *store.Settings) { x.SecretCipherStyle = string(secretcodec.StyleOptions[style].Value) })
				}
			}},
			{title: tr("显现时长"), hint: tr("点击解密后自动回遮罩；面板隐藏或失焦时立即回遮罩"), control: func() {
				if sliderValue(c, k, &reveal, 0, 60, 1, revealLabel) {
					save(func(x *store.Settings) { x.SecretRevealMs = int(reveal) * 1000 })
				}
			}},
			{title: tr("安全边界"), hint: tr("防 IM / 网络 / 肩窥：密文用 AES-GCM，密钥经 PBKDF2 派生；不防本机取证（密钥随本地加密数据保存）")},
		}},
	}
}
