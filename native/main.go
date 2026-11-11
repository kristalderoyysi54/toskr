// Toskr Native：用 mygo 原生 UI 重写的 Toskr（菜单栏划词队列）。
package main

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

func main() {
	macos.WebFontSmoothing() // 同 Tauri -webkit-font-smoothing: antialiased：关掉字体平滑，字不发粗
	if !mygo.App.RequestSingleInstanceLock() {
		return
	}
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	mygo.App.OnWindowAllClosed(func() {})
	var a *app
	mygo.App.OnSecondInstance(func([]string, string) {
		if a != nil {
			a.showPanel()
		}
	})
	mygo.App.WhenReady(func() {
		if out := os.Getenv("TOSKR_ADOPT_CHECK"); out != "" { // 接续预检：只读，报告写到文件后退出（legacy_adopt.go）
			runAdoptCheck(out)
			mygo.App.Quit()
			return
		}
		if os.Getenv(handoffEnv) == "1" { // 把迭代期的数据交接给正式版后退出（handoff.go）
			msg, err := runHandoff()
			if err != nil {
				msg = "交接没有完成：" + err.Error()
			}
			log.Print(msg)
			_, _ = mygo.Dialog.Message(mygo.MessageOptions{Title: appName(), Message: msg})
			mygo.App.Quit()
			return
		}
		var err error
		if a, err = start(); err != nil {
			log.Print(err)
			_, _ = mygo.Dialog.Message(mygo.MessageOptions{Title: appName() + " 无法启动", Message: err.Error()})
			mygo.App.Quit()
		}
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

func start() (*app, error) {
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return nil, err
	}
	diag.Init(dataDir()) // 诊断日志与目录指针始终在默认目录
	diag.Push("启动 v%s pid=%d", mygo.App.Version(), os.Getpid())
	dir, missing := activeDataDir()
	if missing != "" {
		diag.Push("自定义数据目录不可用: %s，本次使用默认目录", missing)
	} else if dir != dataDir() {
		diag.Push("数据目录: %s", dir)
	}
	_, statErr := os.Stat(filepath.Join(dir, store.DataFile))
	fresh := errors.Is(statErr, os.ErrNotExist)
	store.ReleaseDefaults = released()
	key, err := dataKey(fresh)
	if err != nil {
		return nil, err
	}
	st, err := store.OpenDir(dir, key)
	if err != nil {
		return nil, err
	}
	seedIfRequested(st)
	var adopted *store.TauriReport
	var adoptErr error
	if released() { // 旧版点「更新」后的第一次启动：把旧版数据静默接过来（没成功的话下次启动再试，成功后不再做）
		adopted, adoptErr = adoptLegacyData(st)
	}
	setLanguage(st.Settings().Language, mygo.App.PreferredLanguages())
	appLive = true
	applyAppearance(st.Settings())
	a := newApp(core.Mac{}, st)
	a.dataDirMissing = missing
	total := len(st.Notes())
	diag.Push("数据水合完成 笔记=%d 剪贴板=%d（全部 %d 条 · 分组 %d · 任务 %d · 收件箱未完成 %d）",
		total-a.counts[store.SectionClipboard], a.counts[store.SectionClipboard], total, len(st.Sections()), len(st.Tasks()), a.counts[store.SectionInbox])

	withBundle, nameOnly := 0, 0
	for _, n := range st.Notes() {
		switch {
		case n.BundleID != "":
			withBundle++
		case n.SourceApp != "":
			nameOnly++
		}
	}
	diag.Push("来源: 有 bundle %d · 只有应用名 %d", withBundle, nameOnly)

	a.panel = mygo.NewWindow(mygo.WindowOptions{
		Title: "Toskr", Panel: true, Hidden: true, Frameless: true, Transparent: true,
		Vibrancy: vibrancyFor(st.Settings().Glass), CornerRadius: 18,
		Width: 380, Height: 720, MinWidth: panelMinW, MaxWidth: panelMaxW, MinHeight: panelMinH, // 拖边调宽高（同 Tauri），尺寸记进设置
		Content: ui.View(a.panelView),
	})
	a.panel.SetActiveAppearance(true)
	a.panel.SetAlwaysOnTop(!st.Settings().PanelNotOnTop)
	// 退出时 mygo 先逐个关窗，任何一个 PreventDefault 都会取消退出；只在非退出时把「关闭」改成隐藏
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { a.quitting = true })
	// 二次启动（再次 open / 从启动台点开）且没有可见窗口时唤出面板，同 Tauri single_instance → request_show_panel
	mygo.App.OnActivate(func(visible bool) {
		if !visible && !a.quitting {
			diag.Push("二次启动：唤出面板")
			a.showPanel()
		}
	})
	a.panel.OnClose(func(e *mygo.CloseEvent) {
		if !a.quitting {
			e.PreventDefault()
			a.hidePanel()
		}
	})
	a.panel.OnResize(a.rememberPanelFrame)
	a.panel.OnMove(func() {
		if a.edgeHidden || time.Now().Before(a.edgeMachineUntil) {
			return // 贴边滑动 / 吸平是机器移动：不记位置、不清锚点
		}
		a.rememberPanelFrame()
		a.panelMovedByUser()
	})
	a.startEdgeSupervisor()
	a.startCompanionTracker()
	a.panel.OnBlur(func() {
		diag.Push("面板失焦 pinned=%v", a.pinned)
		a.remaskAll()                        // 秘文失焦即回遮罩（钉住时也一样，与 Tauri 一致）
		if time.Now().Before(a.yieldUntil) || a.cmpWin != nil { // 发送时主动让出焦点 / 正在对比窗里核对预检：都不是用户点走
			return
		}
		if a.edgeHideNow(false) { // 已入坞：失焦改为贴边滑出（同 Tauri edge_hide_now）
			return
		}
		if !a.pinned && !a.store.Settings().KeepOnBlur && !a.holdOpen { // 快捷键唤出保持展开（同 Tauri shouldHidePanelOnBlur）
			a.hidePanel()
		}
	})
	a.createHUD()
	st.OnChange(func() {
		a.panel.Update(func() {
			a.reload()
			a.refreshTray()
			a.panel.SetOpacity(a.store.Settings().WindowAlpha()) // 窗口整体不透明度
		})
	})
	a.panel.SetOpacity(st.Settings().WindowAlpha())
	diag.OnPush(func() { // 设置 → 诊断页开着时随新事件重绘
		if w := diagWin.Load(); w != nil {
			w.Invalidate()
		}
	})
	st.OnChange(a.remindersChanged) // 任务变了 1.5s 后推提醒事项（关着时直接返回）
	if st.Settings().RemindersOn {
		a.scheduleReminderSync(3 * time.Second) // 启动先对账一轮（含导入列表里新建的提醒）
	}
	st.OnConflict, st.OnError = a.storeConflict, a.storeError
	mygo.App.OnQuit(func() {
		a.saveDraftState()
		a.shutdownIM()()
		if err := st.Flush(); err != nil {
			diag.Push("退出前落盘失败: %v", err)
		}
	})

	a.replayIMLedger()
	a.registerHotkeys()
	a.setUpTray()
	a.startBackground()
	useTestUpdateDir()
	a.startUpdateChecks()
	diag.Push("辅助功能授权=%v", macos.AXTrusted(false))
	a.watchPermission()
	a.startTap()
	a.watchClipboard()
	a.pinned = os.Getenv("TOSKR_PIN") == "1" // 测量用：面板常驻不随失焦收起
	a.adoptLegacyAutostart()
	if adopted != nil {
		kind, msg := adoptSummary(adopted)
		a.showHUDForce(kind, msg)
	}
	if adoptErr != nil { // 旧数据没接上：面板顶部常驻横幅（带重试），并立刻唤出面板让用户看到
		a.adoptErr = adoptReason(adoptErr)
		a.showPanel()
	}
	if !mygo.App.WasOpenedAtLogin() {
		a.showPanel()
	}
	return a, nil
}
