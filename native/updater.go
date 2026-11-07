package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// 应用更新（同 Tauri updater.ts silentUpdateFlow + 设置「关于」）：启动 8 秒后检查一次，之后每 30 分钟；
// 自动安装开着就后台下载、下次启动生效；否则右上角气泡「发现新版本 · 点击查看」并在标题栏亮「更新」。
// 同一版本只处理一次。手动检查走设置页：发现新版先给「下载并安装」，完成后自动重启。

const (
	repoURL         = "https://github.com/kristalderoyysi54/toskr"
	setPageHelp     = 99 // 设置窗按页数夹紧：最后一页总是「帮助与更新」
	updateFirstWait = 8 * time.Second
	updateEvery     = 30 * time.Minute
)

type updateState struct {
	avail       *mygo.Update // 已发现、尚未安装的新版本
	handled     string       // 已处理过的版本（静默检查去重）
	checking    bool
	installing  bool
	progress    int // 0–100
	installed   bool
	pendingOpen bool // 点了新版本气泡：唤出设置帮助页
}

// 测试替换
var (
	updaterEnabled = mygo.Updater.Enabled
	updaterCheck   = func(ctx context.Context) (*mygo.Update, error) { return mygo.Updater.Check(ctx) }
	updateInstall  = func(ctx context.Context, up *mygo.Update, progress func(done, total int64)) error {
		return up.Install(ctx, progress)
	}
	relaunch = mygo.App.Relaunch
	openLink = func(u string) { _ = exec.Command("/usr/bin/open", u).Start() }
)

func (a *app) startUpdateChecks() {
	go func() {
		time.Sleep(updateFirstWait)
		for {
			a.silentUpdate()
			time.Sleep(updateEvery)
		}
	}()
}

// silentUpdate 在后台 goroutine 里调用。
func (a *app) silentUpdate() {
	st := a.store.Settings()
	if !st.AutoCheckOn() || !updaterEnabled() {
		return
	}
	up, err := updaterCheck(context.Background())
	if err != nil || up == nil {
		if err != nil {
			diag.Push("更新: 静默检查失败 %v", err)
		}
		return
	}
	done := make(chan bool, 1)
	a.onMain(func() {
		dup := up.Version == a.upd.handled
		a.upd.handled = up.Version
		done <- dup
	})
	if <-done {
		return
	}
	diag.Push("更新: 发现 v%s auto=%v", up.Version, st.AutoInstallUpdate)
	if st.AutoInstallUpdate {
		err := updateInstall(context.Background(), up, nil)
		a.onMain(func() {
			if err != nil {
				a.showHUD("warn", tr("自动更新失败：")+err.Error())
				return
			}
			a.upd.installed = true
			a.showHUD("ok", fmt.Sprintf(tr("已更新到 v%s · 重启应用后生效"), up.Version))
		})
		return
	}
	a.onMain(func() {
		a.upd.avail = up
		a.showHUD("info", fmt.Sprintf(tr("发现新版本 v%s · 点击查看"), up.Version))
		a.upd.pendingOpen = true // hudOpen 点气泡时打开设置帮助页
	})
}

// openUpdate：标题栏「更新」/ 新版本气泡 → 设置「帮助与更新」。
func (a *app) openUpdate() {
	a.upd.pendingOpen = false
	a.openSettingsAt(setPageHelp, 0)
}

// checkUpdate：设置里手动检查（不经静默去重）。
func (a *app) checkUpdate() {
	if a.upd.checking || a.upd.installing {
		return
	}
	a.upd.checking, a.updateMsg = true, tr("检查中…")
	go func() {
		up, err := updaterCheck(context.Background())
		a.onMain(func() {
			a.upd.checking = false
			switch {
			case errors.Is(err, mygo.ErrUpdatesDisabled):
				a.updateMsg = tr("此构建未启用自动更新（开发构建或安装位置不可写）")
			case err != nil && strings.Contains(err.Error(), "no release is published"): // mygo internal/update.ErrNotPublished
				a.upd.avail, a.updateMsg = nil, tr("还没有发布原生版更新，当前即最新")
			case err != nil:
				a.updateMsg = tr("检查失败：") + err.Error()
			case up == nil:
				a.upd.avail, a.updateMsg = nil, tr("已是最新版本")
			default:
				a.upd.avail, a.updateMsg = up, fmt.Sprintf(tr("发现新版本 v%s"), up.Version)
			}
			a.redrawSettings()
		})
	}()
}

// installUpdate：下载并安装，完成后自动重启（同 Tauri「n% · 完成后自动重启」）。
func (a *app) installUpdate() {
	up := a.upd.avail
	if up == nil || a.upd.installing {
		return
	}
	a.upd.installing, a.upd.progress = true, 0
	go func() {
		err := updateInstall(context.Background(), up, func(done, total int64) {
			if total > 0 {
				p := int(done * 100 / total)
				a.onMain(func() { a.upd.progress = p; a.redrawSettings() })
			}
		})
		a.onMain(func() {
			a.upd.installing = false
			if err != nil {
				a.updateMsg = tr("安装失败：") + err.Error()
				a.redrawSettings()
				return
			}
			relaunch()
		})
	}()
}

// updatePill：有新版本时标题栏亮「更新」（同 Tauri 头部 ArrowUpCircle 胶囊），无更新不占位。
func (a *app) updatePill(c *ui.Context, k tokens) {
	if a.upd.avail == nil {
		return
	}
	p := stok(c).primary
	b := ui.Row(c).Height(20).Padding(0, 8).Gap(4).Radius(10).Background(p.Alpha(0.1)).Border(1, p.Alpha(0.4)).AlignItems(ui.Center).
		Role(ui.RoleButton).Label(tr("更新")).Key("update-pill")
	if b.Hovered() {
		b.Background(p.Alpha(0.15))
	}
	b.Children(func() {
		licon(c, "circle-arrow-up", 12, p)
		text(c, tr("更新"), 10, 14, 500, p)
	})
	if b.Clicked() {
		a.openUpdate()
	}
}

// aboutRows：设置「关于」+「链接」（同 Tauri SettingsView About）。
func (a *app) aboutRows(c *ui.Context, s settingsTokens) []setSection {
	st := a.store.Settings()
	save := func(fn func(*store.Settings)) {
		cur := a.store.Settings()
		fn(&cur)
		_ = a.store.SetSettings(cur)
	}
	ver := setRow{title: "Toskr Native " + mygo.App.Version(), hint: cmpOr(a.updateMsg, "mygo · "+tr("原生界面")), control: func() {
		switch {
		case a.upd.installing:
			text(c, fmt.Sprintf(tr("%d%% · 完成后自动重启"), a.upd.progress), 11, 16, 400, tok(c).muted).FontFeatures("tnum")
		case a.upd.avail != nil:
			if button(c, s, "下载并安装") {
				a.installUpdate()
			}
		default:
			label := "检查更新"
			if a.upd.checking {
				label = "检查中…"
			}
			if button(c, s, label) {
				a.checkUpdate()
			}
		}
	}}
	rows := []setRow{ver}
	if a.upd.avail != nil && a.upd.avail.Notes != "" {
		rows = append(rows, setRow{title: tr("本次更新内容"), hint: a.upd.avail.Notes})
	}
	auto, inst := st.AutoCheckOn(), st.AutoInstallUpdate
	rows = append(rows,
		setRow{title: tr("自动检查更新"), hint: tr("启动后在后台检查；关闭后只在手动检查时查找"), control: func() {
			if toggle(c, s, &auto) {
				save(func(x *store.Settings) { x.AutoCheckUpdate = &auto })
			}
		}},
		setRow{title: tr("自动安装更新"), hint: tr("在后台下载新版，下次启动时生效"), control: func() {
			if toggle(c, s, &inst) {
				save(func(x *store.Settings) { x.AutoInstallUpdate = inst })
			}
		}},
		a.linkRow(c, s, "更新日志", "所有版本", repoURL+"/releases"),
	)
	return []setSection{
		{tr("关于"), rows},
		{tr("链接"), []setRow{a.linkRow(c, s, "项目主页", "GitHub", repoURL), a.linkRow(c, s, "报告 Bug", "提 Issue", repoURL+"/issues/new")}},
	}
}

func (a *app) linkRow(c *ui.Context, s settingsTokens, title, value, url string) setRow {
	return setRow{title: tr(title), control: func() {
		if button(c, s, value) {
			openLink(url)
		}
	}}
}
