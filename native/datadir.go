package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// 切换数据目录（同 Tauri 设置 → 数据 → 数据目录）与定期自动备份（同 Tauri lib/autoBackup.ts）。
// 默认目录（dataDir）里放指针文件 toskr-datadir.txt 指向自定义目录；诊断日志始终写默认目录。
// 切换流程：选文件夹 → 预检（空目录 = 迁移当前数据过去并核对；已有 Toskr 数据 = 直接加载）→ 写指针 → 重启。
// 原目录的数据不删。指针指向的目录启动时不可用（外置盘没挂载等）时退回默认目录并持续提示。

const dataDirPointer = "toskr-datadir.txt"

var defaultDir = dataDir // 测试替换成临时目录，免得写到真实的默认目录

// activeDataDir 读指针：没有指针用默认目录；指针指向的目录不可用时用默认目录并返回 missing。
func activeDataDir() (dir, missing string) {
	def := defaultDir()
	raw, err := os.ReadFile(filepath.Join(def, dataDirPointer))
	p := strings.TrimSpace(string(raw))
	if err != nil || p == "" {
		return def, ""
	}
	if fi, err := os.Stat(p); err != nil || !fi.IsDir() || !filepath.IsAbs(p) {
		return def, p
	}
	return p, ""
}

// setDataDirPointer：dir 为空或就是默认目录时删除指针。
func setDataDirPointer(dir string) error {
	def := defaultDir()
	path := filepath.Join(def, dataDirPointer)
	if dir == "" || filepath.Clean(dir) == filepath.Clean(def) {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(dir+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// dirPlan 是待确认的目录切换（设置窗主线程读写）。
type dirPlan struct {
	target string
	load   bool // true = 加载目标已有数据；false = 把当前数据迁移过去
	info   store.DirInfo
}

// planDataDir 预检目标目录，给出可执行的计划或拒绝原因。
func (a *app) planDataDir(target string) (*dirPlan, error) {
	target = filepath.Clean(target)
	if filepath.Clean(a.store.Dir()) == target {
		return nil, errors.New(tr("已经在使用这个目录"))
	}
	if store.SameOrNested(a.store.Dir(), target) {
		return nil, errors.New(tr("新目录不能在当前数据目录里面（或反过来）"))
	}
	info, err := store.InspectDir(target, a.store.Key())
	if err != nil {
		return nil, err
	}
	if info.Stray {
		return nil, errors.New(tr("该目录里有 media 文件夹但没有数据文件，请换一个空文件夹"))
	}
	return &dirPlan{target: target, load: info.HasData, info: info}, nil
}

// applyDataDir 执行计划：迁移（复制 + 核对）→ 写指针 → 重启。任一步失败都不写指针，继续用当前目录。
func (a *app) applyDataDir(p *dirPlan) error {
	if !p.load {
		info, err := a.store.CopyTo(p.target)
		if err != nil {
			return fmt.Errorf(tr("迁移失败，仍使用当前目录：%v"), err)
		}
		diag.Push("数据目录迁移完成 笔记=%d 任务=%d 媒体=%d → %s", info.Notes, info.Tasks, info.Media, p.target)
	} else if err := a.store.Flush(); err != nil {
		return err
	}
	if err := setDataDirPointer(p.target); err != nil {
		return err
	}
	diag.Push("数据目录切换到 %s（%s），重启生效", p.target, map[bool]string{true: "加载已有数据", false: "迁移"}[p.load])
	return nil
}

func dirInfoLine(i store.DirInfo) string {
	s := fmt.Sprintf(tr("笔记 %d · 任务 %d · 媒体 %d"), i.Notes, i.Tasks, i.Media)
	if !i.ModAt.IsZero() {
		s += fmt.Sprintf(tr(" · 最后写入 %s"), i.ModAt.Format("2006-01-02 15:04"))
	}
	return s
}

func (a *app) pickDataDir() {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: a.settingsWin, Title: tr("选择数据目录"), Directory: true,
		CreateDirectories: true, ButtonLabel: tr("选择"), Message: tr("选一个空文件夹迁移当前数据，或选已有 Toskr Native 数据的文件夹直接加载")})
	if err != nil || len(paths) == 0 {
		return
	}
	a.previewDataDir(paths[0])
}

func (a *app) previewDataDir(target string) {
	p, err := a.planDataDir(target)
	if err != nil {
		a.showHUD("warn", tr("不能切换到该目录：")+err.Error())
		return
	}
	a.dirPlan = p
}

// dataDirRows：数据目录行 + 预检结果行 + 启动时自定义目录不可用的提示。
func (a *app) dataDirRows(c *ui.Context, k tokens, s settingsTokens) []setRow {
	cur := a.store.Dir()
	custom := filepath.Clean(cur) != filepath.Clean(defaultDir())
	hint := cur
	if custom {
		hint += tr("（自定义）")
	}
	rows := []setRow{{title: tr("数据目录"), hint: hint, control: func() {
		ui.Row(c).Gap(6).Children(func() {
			if custom && button(c, s, "恢复默认") {
				a.previewDataDir(defaultDir())
			}
			if button(c, s, "更改…") {
				a.pickDataDir()
			}
		})
	}}}
	if a.dataDirMissing != "" {
		rows = append(rows, setRow{title: tr("自定义数据目录不可用"),
			hint: fmt.Sprintf(tr("%s 未找到（外置盘没接上？），本次用的是默认目录；接上后点「重试」"), a.dataDirMissing), control: func() {
				ui.Row(c).Gap(6).Children(func() {
					if button(c, s, "改用默认目录") {
						if err := setDataDirPointer(""); err != nil {
							a.showHUD("warn", err.Error())
						} else {
							a.dataDirMissing = ""
							a.showHUD("ok", tr("已改用默认目录"))
						}
					}
					if button(c, s, "重试") {
						a.restartApp()
					}
				})
			}})
	}
	if p := a.dirPlan; p != nil {
		title, hint, act := tr("迁移当前数据到新目录"), tr("空目录：复制当前数据过去并逐条核对，然后重启使用新目录；原目录数据保留"), "迁移并重启"
		if p.load {
			title, hint, act = tr("加载该目录已有的数据"), tr("目标已有 Toskr Native 数据：")+dirInfoLine(p.info)+tr("。当前目录数据保留，可随时切回"), "加载并重启"
		}
		rows = append(rows, setRow{title: title, hint: p.target + " · " + hint, control: func() {
			ui.Row(c).Gap(6).Children(func() {
				if button(c, s, "取消") {
					a.dirPlan = nil
				}
				if button(c, s, act) {
					a.dirPlan = nil
					if err := a.applyDataDir(p); err != nil {
						a.showHUD("warn", err.Error())
						return
					}
					a.restartApp()
				}
			})
		}})
	}
	return rows
}

// ---- 定期自动备份 ----

func defaultAutoBackupDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Documents", "Toskr Native 自动备份")
}

func (a *app) autoBackupDir() string {
	return cmpOr(a.store.Settings().AutoBackupDir, defaultAutoBackupDir())
}

var (
	autoBackupRunning atomic.Bool
	backupFailAt      atomic.Int64 // 上次失败（UnixNano，0 = 无）：6 小时内不再自动重试
)

// runAutoBackup：到期（或 manual）时写一份加密完整备份并清理旧份；在调用方 goroutine 上执行。
func (a *app) runAutoBackup(manual bool, now time.Time) {
	st := a.store.Settings()
	var lastFail time.Time
	if v := backupFailAt.Load(); v != 0 {
		lastFail = time.Unix(0, v)
	}
	if !manual && !store.AutoBackupDue(st, now, lastFail) {
		return
	}
	if !autoBackupRunning.CompareAndSwap(false, true) {
		return
	}
	defer autoBackupRunning.Store(false)
	dir := a.autoBackupDir()
	onUI := func(fn func()) {
		if a.panel != nil {
			a.panel.Update(fn)
		} else {
			fn()
		}
	}
	fail := func(err error) {
		backupFailAt.Store(now.UnixNano())
		diag.Push("自动备份失败: %v", err)
		onUI(func() { a.showHUDForce("warn", tr("自动备份失败：")+err.Error()) })
	}
	if !filepath.IsAbs(dir) {
		fail(errors.New(tr("备份目录必须是绝对路径")))
		return
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fail(err)
		return
	}
	man, err := a.store.ExportBackup(filepath.Join(dir, store.AutoBackupName(now)))
	if err != nil {
		fail(err)
		return
	}
	pruned, _ := store.PruneAutoBackups(dir, st.BackupKeep())
	backupFailAt.Store(0)
	cur := a.store.Settings()
	cur.AutoBackupAt = now
	_ = a.store.SetSettings(cur)
	diag.Push("自动备份完成 笔记=%d 媒体=%d 清理旧备份=%d 目录=%s", man.Counts["notes"], len(man.Media), pruned, dir)
	if manual {
		msg := fmt.Sprintf(tr("已备份 %d 条笔记、%d 个媒体"), man.Counts["notes"], len(man.Media))
		if pruned > 0 {
			msg += fmt.Sprintf(tr("，清理旧备份 %d 份"), pruned)
		}
		onUI(func() { a.showHUD("ok", msg) })
	}
}

func (a *app) autoBackupRows(c *ui.Context, k tokens, s settingsTokens) []setRow {
	st := a.store.Settings()
	on := !st.AutoBackupOff
	rows := []setRow{{title: tr("定期自动备份"), hint: tr("每天加密备份一次（含图片），只能在本机恢复；换电脑请用「导出备份」"), control: func() {
		if toggle(c, s, &on) {
			cur := a.store.Settings()
			cur.AutoBackupOff = !on
			_ = a.store.SetSettings(cur)
		}
	}}}
	if !on {
		return rows
	}
	last, lastHint := tr("尚未备份"), tr("启动 2 分钟后自动执行")
	if !st.AutoBackupAt.IsZero() {
		last, lastHint = st.AutoBackupAt.Format("2006-01-02 15:04"), ""
	}
	rows = append(rows,
		setRow{title: tr("上次备份") + "：" + last, hint: lastHint, control: func() {
			label := "立即备份"
			if autoBackupRunning.Load() {
				label = "备份中…"
			}
			if button(c, s, label) && !autoBackupRunning.Load() {
				go a.runAutoBackup(true, time.Now())
			}
		}},
		setRow{title: tr("备份位置"), hint: a.autoBackupDir(), control: func() {
			ui.Row(c).Gap(6).Children(func() {
				if st.AutoBackupDir != "" && button(c, s, "恢复默认") {
					cur := a.store.Settings()
					cur.AutoBackupDir = ""
					_ = a.store.SetSettings(cur)
				}
				if button(c, s, "选择…") {
					paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: a.settingsWin, Title: tr("选择备份位置"), Directory: true, CreateDirectories: true})
					if err == nil && len(paths) > 0 {
						cur := a.store.Settings()
						cur.AutoBackupDir = paths[0]
						_ = a.store.SetSettings(cur)
					}
				}
			})
		}},
		setRow{title: tr("保留份数"), hint: tr("更早的自动备份会被删除，其他文件不受影响"), control: func() {
			opts := make([][2]string, len(store.AutoBackupKeepOptions))
			for i, n := range store.AutoBackupKeepOptions {
				opts[i] = [2]string{itoa(n), fmt.Sprintf(tr("%d 份"), n)}
			}
			if v, ok := miniSegmented(c, k, itoa(st.BackupKeep()), opts); ok {
				cur := a.store.Settings()
				fmt.Sscan(v, &cur.AutoBackupKeep)
				_ = a.store.SetSettings(cur)
			}
		}},
	)
	return rows
}
