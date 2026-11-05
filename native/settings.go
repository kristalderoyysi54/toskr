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
	"github.com/toskr/native/internal/store"
)

var (
	modifierNames  = []string{"shift", "control", "option"}
	modifierLabels = []string{"⇧ Shift", "⌃ Control", "⌥ Option"}
	glassNames     = []string{"glass", "clear", "none"}
	glassLabels    = []string{"液态玻璃", "清透玻璃", "关闭"}
	langNames      = []string{"system", "zh", "en"}
	langLabels     = []string{"跟随系统", "中文", "English"}
)

// importPreview 是待确认的备份导入（设置窗主线程读写）。
var importPreview *store.Preview

func (a *app) openSettings() {
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
	if a.settingsWin == nil {
		a.settingsWin = mygo.NewWindow(mygo.WindowOptions{
			Title: "Toskr 设置", Width: 580, Height: 680, Hidden: true,
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
	t := c.Theme()
	if c.Vibrancy() {
		c.Root().Background(ui.Transparent)
	} else {
		c.Root().Background(t.Background)
	}
	st := a.store.Settings()
	section := func(title string, body func()) {
		ui.Column(c).Padding(14, 16).Gap(10).Radius(12).Background(t.Surface.Alpha(0.7)).Children(func() {
			ui.Text(c, title).Bold()
			body()
		})
	}
	row := func(label string, control func()) {
		ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
			ui.Text(c, label).Grow(1).Wrap()
			control()
		})
	}
	hint := func(s string) { ui.Text(c, s).FontSize(12).TextColor(t.TextMuted).Wrap() }
	toggle := func(label string, v bool, set func(*store.Settings, bool)) {
		row(label, func() {
			on := v
			if ui.Switch(c, &on).Changed() {
				s := a.store.Settings()
				set(&s, on)
				_ = a.store.SetSettings(s)
			}
		})
	}
	changed := false
	ui.Scroll(c).Fill().Children(func() {
		ui.Column(c).Padding(24, 20).Gap(14).Children(func() {
			section("触发", func() {
				row("双击修饰键", func() { changed = ui.Segmented(c, &a.setModifier, modifierLabels...).Changed() || changed })
				row("两击最大间隔（毫秒）", func() { changed = ui.NumberInput(c, &a.setGap, 150, 1000, 50).Width(110).Changed() || changed })
				hint("面板快捷键：" + keyLabel(a.shortcut) + "　截图：" + keyLabel(st.ScreenshotKey))
			})
			section("发送", func() {
				toggle("粘贴后回车（终端类目标始终不回车）", st.PasteThenEnter, func(s *store.Settings, v bool) { s.PasteThenEnter = v })
				hint("发送前自动预检密钥、令牌、银行卡号、身份证号，命中时在面板里确认或遮罩后发送。")
				if len(a.history) > 0 {
					ui.Text(c, "最近发送").FontSize(12).Bold()
					for _, d := range a.history[:min(len(a.history), 8)] {
						s := fmt.Sprintf("%s  %d 条 → %s", d.At.Format("15:04:05"), d.Count, d.Target)
						if d.Err != "" {
							s += "  ✗ " + d.Err
						}
						ui.Text(c, s).FontSize(11).TextColor(t.TextMuted).SingleLine()
					}
				}
			})
			section("剪贴板", func() {
				row("记录剪贴板历史", func() { changed = ui.Switch(c, &a.setClip).Changed() || changed })
				row("保留天数（0 = 不按时间清理，保留项除外）", func() { changed = ui.NumberInput(c, &a.setRetain, 0, 365, 1).Width(90).Changed() || changed })
				hint("排除这些应用（每行一个 bundle id，不捕获、不记录）")
				changed = ui.TextArea(c, &a.setExcluded).Lines(3, 8).Changed() || changed
			})
			section("外观与语言", func() {
				row("面板材质", func() { changed = ui.Segmented(c, &a.setGlass, glassLabels...).Changed() || changed })
				hint("macOS 26 起为系统液态玻璃；更早系统回退为模糊材质，卡片使用 mygo 绘制的窗内玻璃")
				row("界面语言", func() { changed = ui.Segmented(c, &a.setLang, langLabels...).Changed() || changed })
				toggle("隐身模式（只保留发送失败等警告气泡）", st.Stealth, func(s *store.Settings, v bool) { s.Stealth = v })
				hint("伴随停靠：以下应用在前台时，面板贴在其窗口右侧（每行一个 bundle id）")
				changed = ui.TextArea(c, &a.setCompan).Lines(2, 6).Changed() || changed
			})
			section("提醒", func() {
				toggle("任务到期与账单提醒（系统通知）", st.DueReminders, func(s *store.Settings, v bool) { s.DueReminders = v })
				row("货币符号", func() {
					cur := st.Currency
					if ui.TextInput(c, &cur).Width(60).Changed() {
						s := a.store.Settings()
						s.Currency = cur
						_ = a.store.SetSettings(s)
					}
				})
			})
			section("AI（OpenAI 兼容接口）", func() {
				row("接口地址", func() { changed = ui.TextInput(c, &a.setAIEnd).Width(260).Changed() || changed })
				row("模型", func() { changed = ui.TextInput(c, &a.setAIModel).Width(260).Changed() || changed })
				status := "未配置"
				if aiKey() != "" {
					status = "已存入钥匙串"
				}
				row("密钥（"+status+"）", func() {
					ui.TextInput(c, &a.setAIKey).Password().Width(180).Placeholder("sk-…")
					if ui.Button(c, "保存").Clicked() && strings.TrimSpace(a.setAIKey) != "" {
						if err := mygo.Secrets.Set(aiKeyName, []byte(strings.TrimSpace(a.setAIKey))); err != nil {
							c.Toast("保存失败：" + err.Error())
						} else {
							a.setAIKey = ""
							c.Toast("已存入钥匙串")
						}
					}
				})
				hint("右键笔记 → AI：润色 / 精简 / 翻译 / 写成提示词。结果作为新笔记插在原文上方。")
			})
			section("权限", func() {
				status := "未授权"
				if a.axTrusted {
					status = "已授权"
				}
				row("辅助功能（读取选区、合成粘贴、伴随停靠）："+status, func() {
					if ui.Button(c, "打开授权").Clicked() {
						a.axTrusted = macos.AXTrusted(true)
					}
				})
				if a.tapErr != "" {
					ui.Text(c, "键盘监听："+a.tapErr).FontSize(12).TextColor(t.Danger).Wrap()
				} else {
					hint("键盘监听：正常")
				}
			})
			a.dataSection(c, section, row, hint)
			section("关于", func() {
				row("Toskr Native "+mygo.App.Version()+" · mygo", func() {
					if ui.Button(c, "检查更新").Clicked() {
						a.checkUpdate()
					}
				})
				if a.updateMsg != "" {
					hint(a.updateMsg)
				}
			})
		})
	})
	if changed {
		a.saveSettings()
	}
}

func (a *app) dataSection(c *ui.Context, section func(string, func()), row func(string, func()), hint func(string)) {
	t := c.Theme()
	section("数据", func() {
		hint("目录：" + dataDir())
		hint("加密：AES-256-GCM（TSK1 信封），密钥存于钥匙串；图片按内容哈希加密存放")
		row("导出备份（.toskr-backup，加密）", func() {
			if ui.Button(c, "导出…").Clicked() {
				a.exportBackup(c)
			}
		})
		row("从备份合并导入（本机同 ID 记录优先）", func() {
			if ui.Button(c, "选择文件…").Clicked() {
				a.inspectBackup(c)
			}
		})
		if p := importPreview; p != nil {
			ui.Column(c).Padding(10).Gap(6).Radius(8).Background(t.Accent.Alpha(0.12)).Children(func() {
				ui.Text(c, fmt.Sprintf("备份时间 %s · 笔记 %d（新增 %d / 已有 %d）· 任务 %d · 账单 %d · 秘文 %d",
					p.Manifest.CreatedAt.Format("2006-01-02 15:04"), p.Manifest.Counts["notes"], p.New, p.Overlap,
					p.Manifest.Counts["tasks"], p.Manifest.Counts["bills"], p.Manifest.Counts["secrets"])).FontSize(12).Wrap()
				if p.MissingMedia > 0 {
					ui.Text(c, fmt.Sprintf("%d 张图片校验失败，将跳过", p.MissingMedia)).FontSize(12).TextColor(t.Warning)
				}
				ui.Row(c).Gap(6).Children(func() {
					if ui.Button(c, "合并导入").Clicked() {
						n, err := a.store.ImportBackup(p)
						importPreview = nil
						if err != nil {
							c.Toast("导入失败：" + err.Error())
						} else {
							c.Toast(fmt.Sprintf("已导入 %d 条笔记（导入前已写恢复点）", n))
							a.recovery = a.store.RecoveryPoints()
						}
					}
					if ui.Button(c, "取消").Clicked() {
						importPreview = nil
					}
				})
			})
		}
		ui.Text(c, fmt.Sprintf("恢复点（启动 / 导入 / 恢复前自动生成，保留 %d 份）", store.RecoveryKeep)).FontSize(12).Bold()
		if len(a.recovery) == 0 {
			hint("暂无")
		}
		for i := len(a.recovery) - 1; i >= 0; i-- {
			p := a.recovery[i]
			row(recoveryLabel(p), func() {
				if ui.Button(c, "恢复到此").Clicked() {
					if err := a.store.RestoreRecoveryPoint(p); err != nil {
						c.Toast("恢复失败：" + err.Error())
					} else {
						c.Toast("已恢复（恢复前的数据也存了一个恢复点）")
						a.recovery = a.store.RecoveryPoints()
					}
				}
			})
		}
		row("数据健康检查（只报告，不改数据）", func() {
			if ui.Button(c, "检查").Clicked() {
				h := a.store.CheckHealth()
				a.health = fmt.Sprintf("笔记 %d · 缺失图片 %d · 孤立图片 %d · 分组失联 %d", h.Notes, h.MissingMedia, h.OrphanMedia, h.OrphanSectionRefs)
			}
		})
		if a.health != "" {
			hint(a.health)
		}
		row("清空剪贴板分组（保留项除外）", func() {
			if ui.Button(c, "清空").Clicked() {
				n := a.store.ClearSection(store.SectionClipboard)
				c.Toast("已清空 " + itoa(n) + " 条")
			}
		})
	})
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
