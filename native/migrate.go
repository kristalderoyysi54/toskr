package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 旧版（Tauri）→ 新版（原生）迁移向导：唤出面板时检测到旧版数据且没迁移过，就先于首启导览盖上向导。
//  1. 导入：同「设置 → 数据 → 从 Tauri 版导入」（钥匙串授权一次、导入前写恢复点、回读核对）；
//  2. 交接：旧版仍在运行 / 开着开机启动时，提示退出、关闭——两版同时运行会都响应双击触发键、各收一份剪贴；
//  3. 完成后记 TauriMigration=done 不再弹；「不再提示」记 dismissed；「稍后」只收起到下次启动。
// 设置 → 数据 →「旧版迁移向导」可随时重开。

const legacyBundle = "com.toskr.app"

// 可替换（测试）：旧版数据目录、运行中进程、退出、开机启动项路径。
var (
	legacyDataDir   = store.TauriDataDir
	legacyPIDs      = func() []int32 { return macos.RunningPIDs(legacyBundle) }
	legacyTerminate = macos.Terminate
	legacyAgentPath = func() string {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "LaunchAgents", "Toskr.plist")
	}
)

type migrateState struct {
	step    int // 0 介绍 · 1 导入中 · 2 交接旧版（导入已成功）
	err     string
	result  string
	quitMsg string
	agentOK bool // 本次已关闭旧版开机启动
}

func legacyDataExists() bool {
	d := legacyDataDir()
	if d == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(d, "toskr-data.json"))
	return err == nil
}

// maybeOpenMigrate：每次唤出面板时检查（同首启导览的时机），本次进程选过「稍后」则不再打扰。
func (a *app) maybeOpenMigrate() {
	if released() { // 正式版就是旧版的接替者：启动时已静默接续，没有「两版并存」要交接
		return
	}
	if a.migrate == nil && !a.migrateLater && a.store.Settings().TauriMigration == "" && legacyDataExists() {
		a.migrate = &migrateState{}
	}
}

func (a *app) setMigrationMark(v string) {
	st := a.store.Settings()
	st.TauriMigration = v
	if v == "done" {
		st.TauriMigratedAt = a.now().UnixMilli()
	}
	_ = a.store.SetSettings(st)
}

// legacyAgentOn：旧版的开机启动项（tauri-plugin-autostart 写的 LaunchAgent，指向 Toskr.app 的 toskr）。
func legacyAgentOn() bool {
	b, err := os.ReadFile(legacyAgentPath())
	return err == nil && strings.Contains(string(b), "/Toskr.app/Contents/MacOS/toskr")
}

// disableLegacyAgent：把启动项移进本应用数据目录（可手动移回恢复），下次登录起旧版不再自启；不动正在运行的进程。
func (a *app) disableLegacyAgent() error {
	dst := filepath.Join(a.store.Dir(), "legacy-autostart-Toskr.plist")
	if err := os.Rename(legacyAgentPath(), dst); err != nil {
		return err
	}
	diag.Push("迁移：旧版开机启动项已移到 %s", dst)
	return nil
}

func (a *app) runMigrationImport() {
	m := a.migrate
	m.step, m.err = 1, ""
	a.importTauri(func(msg string, err error) {
		if a.migrate != m {
			return
		}
		if err != nil {
			m.step, m.err = 0, err.Error()
			return
		}
		m.step, m.result = 2, msg
		a.setMigrationMark("done") // 导入成功即记完成：交接步骤可选，中途关掉也不再弹
		diag.Push("迁移向导：导入完成")
	})
}

// migrateWizard 盖住面板内容（层级同首启导览，画在它之后）。
// 版式：顶部两步进度 → 主视觉（旧版图标 → 新版图标 / 完成徽章）→ 标题与说明 → 内容格（导入前是类别、导入后是条数）
// → 操作。主按钮全宽、次操作降为文字链接；危险 / 成功态用色只落在小面积（图标、细边、状态胶囊）。
func (a *app) migrateWizard(c *ui.Context, k tokens) {
	m := a.migrate
	if m == nil {
		return
	}
	w, h := c.Size()
	var act func()
	defer func() {
		if act != nil {
			act()
		}
	}()
	ui.Overlay(c, func() {
		ui.Column(c).Absolute().Left(0).Top(0).Size(w, h).Radius(rr(14)).Background(sheetBg(c)).Key("migrate-wizard").Role(ui.RoleDialog).Label(tr("旧版迁移")).Children(func() {
			ui.Scroll(c).Fill().Scrollbars(false).Children(func() {
				ui.Column(c).Padding(20, 20, 24, 20).Gap(20).MaxWidth(420).MinHeight(h).Children(func() {
					a.migrateSteps(c, k, map[bool]int{false: 0, true: 1}[m.step == 2])
					body := ui.Column(c).Grow(1).Gap(18).Justify(ui.Center).Key("migrate-step-" + itoa(min(m.step, 2)/2)).
						Transition(ui.ElementTransition{Duration: 220 * time.Millisecond, Ease: easeStandard, Colors: true, Enter: &ui.Motion{Y: 8, Opacity: 0}})
					body.Children(func() {
						if m.step < 2 {
							act = a.migrateImportStep(c, k, m, act)
						} else {
							act = a.migrateHandoffStep(c, k, m, act)
						}
					})
				})
			})
		})
	})
}

// migrateSteps：① 导入数据 —— ② 停用旧版；已完成的步骤圆点换对勾。
func (a *app) migrateSteps(c *ui.Context, k tokens, cur int) {
	ui.Row(c).Gap(8).AlignItems(ui.Center).Justify(ui.Center).Children(func() {
		for i, label := range []string{tr("导入数据"), tr("停用旧版")} {
			if i > 0 {
				line := k.fg.Alpha(0.12)
				if cur >= i {
					line = k.ok.Alpha(0.6)
				}
				ui.Box(c).Size(24, 1).Background(line)
			}
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				dot := ui.Box(c).Size(16, 16).Radius(8).Center()
				col := k.muted
				switch {
				case i < cur:
					dot.Background(k.ok.Alpha(0.15))
					dot.Children(func() { licon(c, "check", 10, k.ok) })
				case i == cur:
					dot.Background(k.fg)
					col = k.fg
					dot.Children(func() { text(c, itoa(i+1), 10, 14, 600, c.Theme().Background) })
				default:
					dot.Border(1, k.fg.Alpha(0.18))
					dot.Children(func() { text(c, itoa(i+1), 10, 14, 500, k.muted) })
				}
				text(c, label, 11, 16, map[bool]int{true: 600, false: 500}[i == cur], col).SingleLine()
			})
		}
	})
}

func (a *app) appTile(c *ui.Context, k tokens, bundle, caption string) {
	ui.Column(c).Gap(6).AlignItems(ui.Center).Children(func() {
		ui.Box(c).Size(64, 64).Radius(16).Background(k.track).Border(1, k.inputBorder).Center().Children(func() {
			if img := a.appIcon(bundle); img != nil {
				ui.Image(c, img).Size(48, 48)
			} else {
				licon(c, "inbox", 24, k.muted)
			}
		})
		text(c, caption, 11, 16, 500, k.muted)
	})
}

type migrateKind struct {
	icon, label string
	n           func(r *store.TauriReport) int
}

var migrateKinds = []migrateKind{
	{"notebook-pen", "笔记", func(r *store.TauriReport) int { return r.Notes }},
	{"layers", "分组", func(r *store.TauriReport) int { return r.Sections }},
	{"list-todo", "任务", func(r *store.TauriReport) int { return r.Tasks }},
	{"wallet", "账单", func(r *store.TauriReport) int { return r.Bills }},
	{"lock", "秘文", func(r *store.TauriReport) int { return r.Secrets }},
	{"send", "发送记录", func(r *store.TauriReport) int { return r.Deliveries }},
}

// kindGrid：3 × 2 内容格。rep 为 nil 时画类别（导入前），否则画条数。
func kindGrid(c *ui.Context, k tokens, rep *store.TauriReport) {
	ui.Column(c).Gap(6).Children(func() {
		for row := range 2 {
			ui.Row(c).Gap(6).Children(func() {
				for _, kd := range migrateKinds[row*3 : row*3+3] {
					ui.Column(c).Grow(1).Basis(0).Padding(10, 8).Gap(4).Radius(rr(10)).Background(k.track).AlignItems(ui.Center).Key("mk-" + kd.label).Children(func() {
						if rep == nil {
							licon(c, kd.icon, 16, k.muted)
						} else {
							text(c, itoa(kd.n(rep)), 15, 20, 600, k.fg).SingleLine()
						}
						text(c, tr(kd.label), 10, 14, 500, k.muted).SingleLine()
					})
				}
			})
		}
	})
}

func shortHome(p string) string {
	if home, _ := os.UserHomeDir(); home != "" && strings.HasPrefix(p, home) {
		return "~" + p[len(home):]
	}
	return p
}

func heading(c *ui.Context, k tokens, title, sub string) {
	ui.Column(c).Gap(6).AlignItems(ui.Center).Children(func() {
		text(c, title, 17, 24, 600, k.fg).Wrap().TextAlign(ui.Center)
		text(c, sub, 12, 18, 400, k.muted).Wrap().TextAlign(ui.Center)
	})
}

func (a *app) migrateImportStep(c *ui.Context, k tokens, m *migrateState, act func()) func() {
	ui.Row(c).Gap(14).Justify(ui.Center).AlignItems(ui.Center).Children(func() {
		a.appTile(c, k, legacyBundle, tr("旧版"))
		ui.Box(c).Margin(0, 0, 22, 0).Children(func() { licon(c, "arrow-right", 18, k.muted) })
		a.appTile(c, k, "com.toskr.native", tr("新版"))
	})
	heading(c, k, tr("把旧版的数据搬到新版"), tr("检测到旧版 Toskr 的数据，导入后可直接接着用。"))
	kindGrid(c, k, nil)
	ui.Column(c).Gap(6).Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			licon(c, "shield-check", 13, k.ok)
			text(c, tr("导入前自动写恢复点；旧版数据只读，不会被修改"), 11, 16, 400, k.muted).Wrap().Grow(1).Basis(0)
		})
		d := legacyDataDir()
		tipOf(c, ui.Row(c).Gap(6).AlignItems(ui.Center), d).Children(func() {
			licon(c, "folder", 13, k.muted)
			text(c, shortHome(d), 10, 14, 400, k.muted).Font(fontMono).SingleLine().Grow(1).Basis(0)
		})
	})
	if m.err != "" {
		ui.Row(c).Gap(8).Padding(8, 10).Radius(rr(10)).Background(k.danger.Alpha(0.08)).Border(1, k.danger.Alpha(0.25)).AlignItems(ui.Start).Key("migrate-err").Children(func() {
			licon(c, "x", 14, k.danger).Margin(1, 0, 0, 0)
			text(c, fmt.Sprintf(tr("导入失败：%s"), m.err), 11, 16, 500, k.danger).Wrap().Grow(1).Basis(0)
		})
	}
	ui.Column(c).Gap(10).Children(func() {
		label := tr("导入旧版数据")
		switch {
		case m.step == 1:
			label = tr("导入中…")
		case m.err != "":
			label = tr("重试导入")
		}
		if btnOf(c, label).FillWidth().Disabled(m.step == 1).Clicked() && m.step == 0 {
			act = a.runMigrationImport
		}
		if m.step == 1 {
			ui.Row(c).Gap(6).Justify(ui.Center).AlignItems(ui.Center).Children(func() {
				licon(c, "loader-circle", 12, k.muted).Rotate(float32(c.Now().UnixMilli()%1000) * 0.36)
				c.AnimationFrame()
				text(c, tr("系统会弹出钥匙串授权，请选「允许」"), 11, 16, 400, k.muted)
			})
			return
		}
		ui.Row(c).Justify(ui.Center).Gap(4).AlignItems(ui.Center).Children(func() {
			if linkButton(c, k, "migrate-later", tr("稍后")) {
				act = func() { a.migrate, a.migrateLater = nil, true }
			}
			text(c, "·", 11, 16, 400, k.muted.Alpha(0.6))
			if linkButton(c, k, "migrate-never", tr("不再提示")) {
				act = func() { a.migrate = nil; a.setMigrationMark("dismissed") }
			}
		})
	})
	return act
}

func (a *app) migrateHandoffStep(c *ui.Context, k tokens, m *migrateState, act func()) func() {
	ui.Row(c).Justify(ui.Center).Children(func() {
		ui.Box(c).Size(56, 56).Radius(28).Background(k.ok.Alpha(0.12)).Center().Children(func() { licon(c, "circle-check", 28, k.ok) })
	})
	sub := tr("旧版的内容已经在新版里了。")
	if r := a.lastTauriReport; r != nil && len(r.Check.Mismatch) > 0 {
		sub = fmt.Sprintf(tr("有 %d 条回读不一致，详见设置 → 诊断。"), len(r.Check.Mismatch))
	}
	heading(c, k, tr("数据已搬到新版"), sub)
	if r := a.lastTauriReport; r != nil {
		kindGrid(c, k, r)
	} else if m.result != "" {
		text(c, m.result, 11, 16, 400, k.muted).Wrap().TextAlign(ui.Center)
	}
	running, agent := len(legacyPIDs()) > 0, legacyAgentOn()
	if running {
		c.Invalidate() // 退出是异步的：刷新直到进程消失
	}
	ui.Column(c).Gap(8).Children(func() {
		ui.Column(c).Gap(2).Children(func() {
			text(c, tr("停用旧版"), 12, 17, 600, k.fg)
			text(c, tr("两版同时运行会都响应双击触发键、各收一份剪贴。"), 11, 16, 400, k.muted).Wrap()
		})
		ui.Column(c).Radius(12).Background(k.track).Clip().Children(func() {
			row := func(key, icon, title, desc, btn string, show, done bool, doneLabel string, do func(), last bool) {
				if !show {
					return
				}
				ui.Row(c).Gap(10).Padding(10, 12).AlignItems(ui.Center).Key(key).Children(func() {
					ui.Box(c).Size(28, 28).Radius(rr(8)).Background(k.window).Border(1, k.inputBorder).Center().Children(func() {
						if img := a.appIcon(icon); img != nil { // 旧版应用图标本身最好认
							ui.Image(c, img).Size(22, 22)
						} else {
							licon(c, map[bool]string{true: "inbox", false: icon}[icon == legacyBundle], 14, k.fg)
						}
					})
					ui.Column(c).Grow(1).Basis(0).Gap(1).Children(func() {
						text(c, title, 12, 17, 500, k.fg).SingleLine()
						text(c, desc, 10, 14, 400, k.muted).Wrap()
					})
					if done {
						ui.Row(c).Height(22).Padding(0, 8).Gap(4).Radius(11).Background(k.ok.Alpha(0.12)).AlignItems(ui.Center).Children(func() {
							licon(c, "check", 11, k.ok)
							text(c, doneLabel, 11, 16, 500, k.ok)
						})
					} else if btnOf(c, btn).Clicked() {
						act = do
					}
				})
				if !last {
					ui.Box(c).Height(1).Margin(0, 12).Background(k.fg.Alpha(0.06))
				}
			}
			showQuit, showAgent := running || m.quitMsg != "", agent || m.agentOK
			row("migrate-quit", legacyBundle, tr("旧版仍在运行"), tr("请求旧版正常退出"), tr("退出旧版"), showQuit, !running, tr("已退出"), func() {
				for _, pid := range legacyPIDs() {
					legacyTerminate(pid)
				}
				m.quitMsg = "sent"
				diag.Push("迁移：请求旧版退出")
			}, !showAgent)
			row("migrate-agent", "calendar-clock", tr("旧版开着开机启动"), tr("下次登录起不再自启，可恢复"), tr("关闭"), showAgent, m.agentOK, tr("已关闭"), func() {
				if err := a.disableLegacyAgent(); err != nil {
					a.showHUD("warn", fmt.Sprintf(tr("关闭旧版开机启动失败：%v"), err))
					return
				}
				m.agentOK = true
			}, true)
			if !showQuit && !showAgent {
				ui.Row(c).Gap(8).Padding(10, 12).AlignItems(ui.Center).Children(func() {
					licon(c, "check", 13, k.ok)
					text(c, tr("旧版没有在运行，也没有开机启动"), 11, 16, 400, k.muted)
				})
			}
		})
	})
	if btnOf(c, tr("开始使用新版")).FillWidth().Clicked() {
		act = func() { a.migrate = nil }
	}
	return act
}

// legacyMigrationRow：设置 → 数据「从旧版迁移」一行，合并原「从 Tauri 版导入」「旧版迁移向导」两行。
// 右侧：状态胶囊（未迁移 / 已迁移 日期 / 未检测到旧版）· 文字链接「仅导入数据」· 主按钮「打开向导」。
func (a *app) legacyMigrationRow(c *ui.Context, k tokens, s settingsTokens) setRow {
	st := a.store.Settings()
	has := legacyDataExists()
	d := legacyDataDir()
	return setRow{title: tr("从旧版迁移"), hint: tr("把旧版 Toskr 的数据搬到新版，并停用旧版"),
		tip: fmt.Sprintf(tr("读取 %s 的笔记、分组、任务、账单、秘文、消息与发送记录（同 ID 以旧版为准）；会请求一次钥匙串授权，导入前自动写恢复点"), d),
		control: func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				label, col := tr("未迁移"), k.muted
				bg := k.fg.Alpha(0.06)
				switch {
				case st.TauriMigration == "done":
					label, col, bg = tr("已迁移"), k.ok, k.ok.Alpha(0.12)
					if st.TauriMigratedAt > 0 {
						label += " " + time.UnixMilli(st.TauriMigratedAt).Format("1/2")
					}
				case !has:
					label = tr("未检测到旧版")
				}
				ui.Row(c).Height(20).Padding(0, 8).Radius(10).Background(bg).AlignItems(ui.Center).Key("legacy-status").
					Children(func() { text(c, label, 10, 14, 500, col).SingleLine() })
				if !has {
					return
				}
				only := tr("仅导入数据")
				if a.tauriImporting {
					only = tr("导入中…")
				}
				if linkButton(c, k, "legacy-import", only) && !a.tauriImporting {
					a.importTauri(func(_ string, err error) {
						if err == nil {
							a.setMigrationMark("done")
						}
					})
				}
				if !released() && button(c, s, "打开向导") {
					a.migrate, a.migrateLater = &migrateState{}, false
					a.onMain(a.showPanel)
				}
			})
		}}
}

func init() { // 旧版迁移向导、设置「从旧版迁移」与课程进度的英文
	for k, v := range map[string]string{
		"旧版迁移": "Migrate from the old version", "导入数据": "Import data", "停用旧版": "Retire old version",
		"旧版": "Old", "新版": "New", "笔记": "Notes", "分组": "Groups", "任务": "Tasks", "账单": "Bills", "秘文": "Secrets", "发送记录": "Send history",
		"把旧版的数据搬到新版":                 "Bring your data to the new version",
		"检测到旧版 Toskr 的数据，导入后可直接接着用。": "Found data from the old Toskr. Import it and pick up where you left off.",
		"导入前自动写恢复点；旧版数据只读，不会被修改":     "A restore point is written first; old data is read-only and left untouched",
		"导入失败：%s": "Import failed: %s",
		"导入旧版数据":  "Import old data",
		"导入中…":    "Importing…",
		"重试导入":    "Retry import",
		"系统会弹出钥匙串授权，请选「允许」": "macOS will ask for Keychain access — choose Allow",
		"稍后":   "Later",
		"不再提示": "Don't ask again",
		"旧版的内容已经在新版里了。":           "Everything from the old version is here now.",
		"有 %d 条回读不一致，详见设置 → 诊断。":  "%d items didn't match on readback; see Settings → Diagnostics.",
		"数据已搬到新版":                 "Your data is in the new version",
		"两版同时运行会都响应双击触发键、各收一份剪贴。": "Running both makes each respond to the trigger and save its own clipboard copy.",
		"旧版仍在运行":                  "Old version is running",
		"请求旧版正常退出":                "Ask it to quit normally",
		"退出旧版":                    "Quit old version",
		"已退出":                     "Quit",
		"旧版开着开机启动":                "Old version opens at login",
		"下次登录起不再自启，可恢复":           "Stops opening at next login; reversible",
		"关闭":            "Turn off",
		"已关闭":           "Off",
		"关闭旧版开机启动失败：%v": "Couldn't turn off the old login item: %v",
		"旧版没有在运行，也没有开机启动":         "The old version isn't running or opening at login",
		"开始使用新版":                  "Start using the new version",
		"从旧版迁移":                   "Migrate from old version",
		"把旧版 Toskr 的数据搬到新版，并停用旧版": "Bring old Toskr data over and retire the old app",
		"未迁移":                "Not migrated",
		"已迁移":                "Migrated",
		"未检测到旧版":             "No old version found",
		"仅导入数据":              "Import data only",
		"打开向导":               "Open wizard",
		"已完成":                "Done",
		"已完成 %d / %d":        "%d of %d done",
		"退出教程":               "Exit tutorial",
		"AES-256 加密，密钥存于钥匙串": "AES-256 encrypted, key in Keychain",
		"合并或整份恢复，导入前自动写恢复点": "Merge or full restore; a restore point is written first",
		"读取 %s 的笔记、分组、任务、账单、秘文、消息与发送记录（同 ID 以旧版为准）；会请求一次钥匙串授权，导入前自动写恢复点": "Reads notes, groups, tasks, bills, secrets, messages and send history from %s (old version wins on the same ID); asks for Keychain access once and writes a restore point first",
	} {
		if _, ok := en[k]; !ok {
			en[k] = v
		}
	}
}
