package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// 正式版（com.toskr.app）接替旧版时不需要用户做任何事：
//  1. 首次启动（本版数据文件还不存在）发现旧版数据 → 静默导入（同「从旧版迁移」的导入与回读核对，先写恢复点）。
//     数据密钥就是旧版那一把（经旧版原样的辅助程序读取），所以不用再问钥匙串授权。旧版文件一个不动。
//  2. AI 密钥继续用旧版的钥匙串记录（辅助程序的 ai 槽，记录格式同旧版 StoredAiKey）。
//  3. 旧版写的开机启动项（LaunchAgent）换成本版的登录项。

// usesLegacyKeychain：正式版且在 .app 里运行——钥匙串走旧版的辅助程序。
func usesLegacyKeychain() bool { return released() && !mygo.IsDev() && !devBinary() }

// adoptLegacyData：还没接续过（TauriMigration 为空）且有旧版数据时导入一次。
// 返回 (报告, nil) = 这次接上了；(nil, nil) = 不需要；(nil, err) = 有旧数据但没接上——调用方必须让用户看到
// （面板顶部横幅 + 重试），不能让老用户对着一个空面板以为数据丢了。旧数据在任何情况下都不被改动。
// 从迭代期交接过来的库已标记完成（handoff.go），不会再被旧版数据覆盖。
func adoptLegacyData(st *store.Store) (*store.TauriReport, error) {
	if st.Settings().TauriMigration != "" {
		return nil, nil
	}
	dir := legacyDataDir()
	if dir == "" {
		return nil, nil
	}
	if !legacyDataExists() {
		if _, err := os.Stat(dir); err != nil && legacyDirCustom(dir) { // 旧版把数据放在自定义目录，而它现在不可用（外置盘没挂载等）
			return nil, fmt.Errorf("旧版数据所在的文件夹现在打不开：%s", dir)
		}
		return nil, nil // 没装过旧版，或旧版从没存过数据
	}
	done := func() {
		cur := st.Settings()
		cur.TauriMigration, cur.TauriMigratedAt = "done", time.Now().UnixMilli()
		cur.WelcomeTourSeen = true // 老用户升级：不再弹首启导览
		_ = st.SetSettings(cur)
	}
	rep, err := st.ImportTauri(dir, st.Key())
	if errors.Is(err, store.ErrTauriEmpty) { // 旧版里本来就没有内容：没什么可接的，不必每次启动都再试
		done()
		diag.Push("旧版数据为空，无需接续 %s", dir)
		return nil, nil
	}
	if err != nil { // 不标记完成：下次启动、横幅「重试」、设置 → 数据「从旧版迁移」都会再试
		diag.Push("接续旧版数据失败 %s: %v", dir, err)
		return nil, err
	}
	done()
	diag.Push("已接续旧版数据 %s：笔记 %d 分组 %d 任务 %d 账单 %d 秘文 %d 消息 %d 图片 %d（缺 %d）· %s",
		dir, rep.Notes, rep.Sections, rep.Tasks, rep.Bills, rep.Secrets, rep.Messages, rep.Media, rep.MediaMissing, rep.Check.Summary())
	for _, m := range rep.Check.Mismatch[:min(len(rep.Check.Mismatch), 20)] {
		diag.Push("  不一致 %s", m)
	}
	return &rep, nil
}

// legacyDirCustom：dir 不是旧版的默认应用目录（即来自旧版的自定义数据目录指针）。
func legacyDirCustom(dir string) bool {
	return filepath.Clean(dir) != filepath.Clean(filepath.Dir(releaseDataDir()))
}

// adoptSummary：接续结果给用户看的一句话；有核对不上的内容时如实说。
func adoptSummary(rep *store.TauriReport) (kind, msg string) {
	bad := len(rep.Check.Mismatch) + len(rep.Check.Lost) + rep.MediaMissing
	if bad > 0 {
		return "warn", fmt.Sprintf(tr("已升级到新版；有 %d 项内容没能原样带过来，旧版数据仍完整保留（详见 设置 → 诊断）"), bad)
	}
	return "ok", fmt.Sprintf(tr("已升级到新版，数据都在（%d 条内容）"), rep.Notes)
}

// adoptReason：横幅里给用户看的原因。文件夹不可用要原样说（用户能自己解决）；其余技术细节只进诊断日志。
func adoptReason(err error) string {
	if strings.Contains(err.Error(), "打不开") {
		return err.Error()
	}
	return tr("旧版的数据文件读不出来（详情见 设置 → 诊断）")
}

// retryAdopt：横幅「重试」。
func (a *app) retryAdopt() {
	rep, err := adoptLegacyData(a.store)
	if err != nil {
		a.adoptErr = adoptReason(err)
		a.showHUD("warn", tr("还是没接上：")+a.adoptErr)
		return
	}
	a.adoptErr = ""
	a.reload()
	if rep != nil {
		kind, msg := adoptSummary(rep)
		a.showHUDForce(kind, msg)
	}
}

// adoptBanner：旧版数据没接上时常驻面板顶部，直到接上为止。
func (a *app) adoptBanner(c *ui.Context, k tokens) {
	if a.adoptErr == "" {
		return
	}
	s := stok(c)
	title := tr("旧版的数据还没显示出来")
	ui.Column(c).Margin(0, 12, 8, 12).Padding(12).Gap(6).Radius(12).Background(k.amberBar.Alpha(0.1)).Border(1, k.amberBar.Alpha(0.35)).
		Label(title).Key("adopt-banner").Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			licon(c, "triangle-alert", 14, k.amberText)
			text(c, title, 12, 17, 500, k.amberText)
		})
		text(c, tr("数据没有丢，仍完整保存在原处。原因：")+a.adoptErr, 11, 16, 400, k.muted).Wrap().MaxLines(3)
		ui.Row(c).Gap(6).Children(func() {
			if bannerButton(c, s, "重试") {
				a.retryAdopt()
			}
		})
	})
}

// runAdoptCheck：接续预检（只读）。把旧版数据导入到一个临时目录里的空库，报告能接上多少、核对结果如何；
// 不写正式版的数据目录，不改旧版文件。用法：TOSKR_ADOPT_CHECK=<报告文件> 运行正式身份的可执行文件。
func runAdoptCheck(out string) {
	report := func(s string) { _ = os.WriteFile(out, []byte(s+"\n"), 0o600) }
	if !released() {
		report("失败：只有正式身份（com.toskr.app）的包能做接续预检")
		return
	}
	key, err := dataKey(false)
	if err != nil {
		report("失败：读不到旧版的数据密钥：" + err.Error())
		return
	}
	defer clear(key)
	tmp, err := os.MkdirTemp("", "toskr-adopt-check-")
	if err != nil {
		report("失败：" + err.Error())
		return
	}
	defer os.RemoveAll(tmp)
	st, err := store.OpenDir(tmp, key)
	if err != nil {
		report("失败：" + err.Error())
		return
	}
	dir := legacyDataDir()
	rep, err := adoptLegacyData(st)
	switch {
	case err != nil:
		report("失败：" + err.Error() + "\n旧版数据目录：" + dir)
	case rep == nil:
		report("没有需要接续的旧版数据\n旧版数据目录：" + dir)
	default:
		notes, clips := 0, 0
		for _, n := range st.Notes() {
			if n.Section == store.SectionClipboard {
				clips++
			} else {
				notes++
			}
		}
		report(fmt.Sprintf("通过：旧版数据可以接续\n旧版数据目录：%s\n接续后库里：笔记 %d · 剪贴 %d · 分组 %d · 任务 %d · 账单 %d · 秘文 %d · 消息 %d\n图片 %d（缺 %d）\n%s\n不一致明细：%v\n分组失联：%v",
			dir, notes, clips, len(st.Sections()), len(st.Tasks()), len(st.Bills()), len(st.Secrets()), rep.Messages, rep.Media, rep.MediaMissing,
			rep.Check.Summary(), rep.Check.Mismatch, rep.Check.Lost))
	}
}

// adoptLegacyAutostart：旧版开着开机启动 → 打开本版的登录项，确认生效后把旧启动项移进数据目录（不删，可手动移回）。
func (a *app) adoptLegacyAutostart() {
	if !released() || !legacyAgentOn() {
		return
	}
	if err := setOpenAtLogin(true); err != nil || !openAtLogin() {
		diag.Push("接管开机启动失败（旧启动项保留）: %v", err)
		return
	}
	if err := a.disableLegacyAgent(); err != nil {
		diag.Push("旧版开机启动项未能移走: %v", err)
	}
}

var ( // 测试替换
	setOpenAtLogin = func(on bool) error { return mygo.App.SetOpenAtLogin(on) }
	openAtLogin    = func() bool { return mygo.App.OpenAtLogin() }
)

// ---- AI 密钥（旧版钥匙串记录） ----

// legacyAIRecord 同旧版 StoredAiKey：key 为 null = 用户删除过（保留删除时刻，旧数据里的副本不会被再迁回来）。
type legacyAIRecord struct {
	Key         *string `json:"key"`
	UpdatedAtMs *int64  `json:"updatedAtMs"`
}

// decodeLegacyAI：JSON 记录，或更早的纯字符串条目。
func decodeLegacyAI(raw []byte) (string, error) {
	var rec legacyAIRecord
	if err := json.Unmarshal(raw, &rec); err == nil {
		if rec.Key == nil {
			return "", nil
		}
		return strings.TrimSpace(*rec.Key), nil
	}
	if len(raw) > 0 && raw[0] == '{' {
		return "", errors.New("钥匙串中的 AI 密钥记录无效")
	}
	return strings.TrimSpace(string(raw)), nil
}

func encodeLegacyAI(key string, now time.Time) []byte {
	ms := now.UnixMilli()
	rec := legacyAIRecord{UpdatedAtMs: &ms}
	if key != "" {
		rec.Key = &key
	}
	out, _ := json.Marshal(rec)
	return out
}

var legacyAI struct {
	sync.Mutex
	key     string
	loaded  bool
	retryAt time.Time // 读取失败后过一阵再试（设置页每帧都会问一次，不能每帧起一个辅助进程）
}

var legacyAICall = func(op string, value []byte) (int32, []byte, error) { // 测试替换
	path, err := helperPath()
	if err != nil {
		return 0, nil, err
	}
	return helperCall(path, "ai", op, value)
}

// legacyAIKey：读一次后在进程内缓存；没有记录也算读到（空）。
func legacyAIKey() string {
	legacyAI.Lock()
	defer legacyAI.Unlock()
	if legacyAI.loaded || time.Now().Before(legacyAI.retryAt) {
		return legacyAI.key
	}
	st, raw, err := legacyAICall("load", nil)
	switch {
	case err == nil && st == 0:
		if k, derr := decodeLegacyAI(raw); derr == nil {
			legacyAI.key, legacyAI.loaded = k, true
			return k
		} else {
			err = derr
		}
	case err == nil && st == errSecItemNotFound:
		legacyAI.key, legacyAI.loaded = "", true
		return ""
	}
	diag.Push("AI 密钥读取失败 status=%d err=%v", st, err)
	legacyAI.retryAt = time.Now().Add(time.Minute)
	return ""
}

// storeLegacyAIKey：key 为空 = 删除（写入带删除时刻的空记录，同旧版）。
func storeLegacyAIKey(key string) error {
	st, _, err := legacyAICall("store", encodeLegacyAI(strings.TrimSpace(key), time.Now()))
	if err == nil && st != 0 {
		err = fmt.Errorf("无法写入钥匙串（%d）", st)
	}
	if err != nil {
		return err
	}
	legacyAI.Lock()
	legacyAI.key, legacyAI.loaded, legacyAI.retryAt = strings.TrimSpace(key), true, time.Time{}
	legacyAI.Unlock()
	return nil
}

// saveAIKey / removeAIKey：设置页的保存与删除，按身份走各自的钥匙串条目。
func saveAIKey(key string) error {
	if usesLegacyKeychain() {
		return storeLegacyAIKey(key)
	}
	return mygo.Secrets.Set(aiKeyName, []byte(key))
}

func removeAIKey() error {
	if usesLegacyKeychain() {
		return storeLegacyAIKey("")
	}
	return mygo.Secrets.Delete(aiKeyName)
}
