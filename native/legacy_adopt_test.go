package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/toskr/native/internal/store"
)

// 两种身份：迭代期「Toskr Native」各用各的；正式版「Toskr」沿用旧版的标识、列表名与密钥辅助程序，数据放 com.toskr.app/v1。
func TestIdentityFlavors(t *testing.T) {
	if released() || appName() != "Toskr Native" || !strings.HasPrefix(filepath.Base(dataDir()), "com.toskr.native") || activeHelper() != nativeHelper ||
		remindersListTitle() != "Toskr Native" || tr("退出 Toskr Native") != "退出 Toskr Native" || selfBundle() != "com.toskr.native" {
		t.Fatalf("默认应为迭代期身份：%s %s", appName(), dataDir())
	}
	t.Cleanup(setReleased(true))
	d := dataDir()
	if !released() || appName() != "Toskr" || filepath.Base(d) != "v1" || filepath.Base(filepath.Dir(d)) != "com.toskr.app" {
		t.Fatalf("正式版 %s %s", appName(), d)
	}
	if activeHelper().identifier != "com.toskr.keychain-helper" || activeHelper().cdhash != "5008368f7af34fde0f4ca7d5277eecb4a5218ef0" ||
		activeHelper().file != "com.toskr.keychain-helper.bin" {
		t.Fatalf("正式版应锁定旧版辅助程序 %+v", activeHelper())
	}
	if remindersListTitle() != "Toskr" || selfBundle() != "com.toskr.app" || tr("退出 Toskr Native") != "退出 Toskr" ||
		brand("请重新安装完整的 Toskr Native") != "请重新安装完整的 Toskr" || filepath.Base(defaultAutoBackupDir()) != "Toskr 自动备份" {
		t.Fatal("正式版文案不应再出现 Native")
	}
	setLanguage("en", nil)
	defer setLanguage("zh", nil)
	if got := tr("在 iPhone 的「Toskr Native」列表里查看和勾选"); strings.Contains(got, "Native") || !strings.Contains(got, "“Toskr”") {
		t.Fatalf("英文文案 %q", got)
	}
}

func legacyFixture(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "toskr-data.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	old := legacyDataDir
	legacyDataDir = func() string { return dir }
	t.Cleanup(func() { legacyDataDir = old })
	return dir
}

func legacyDoc(t *testing.T) string {
	t.Helper()
	inner, _ := json.Marshal(map[string]any{"version": 27, "state": map[string]any{
		"welcomeTourSeen": false,
		"notes": []any{
			map[string]any{"id": "n1", "text": "旧版的一条笔记", "sectionId": "inbox", "createdAt": 1790000000000},
			map[string]any{"id": "n2", "text": "旧版的剪贴", "sectionId": "clipboard", "createdAt": 1790000001000},
		},
		"tasks": []any{map[string]any{"id": "t1", "text": "旧版的任务", "status": "todo", "createdAt": 1790000002000}},
	}})
	raw, _ := json.Marshal(map[string]string{"toskr": string(inner)})
	return string(raw)
}

// 旧版点更新后的第一次启动：空库 + 旧版数据 → 静默接续、标记完成、不再弹导览与迁移向导；旧文件一个字节不动；只做一次。
func TestAdoptLegacyData(t *testing.T) {
	t.Cleanup(setReleased(true))
	doc := legacyDoc(t)
	dir := legacyFixture(t, doc)
	st, err := store.OpenDir(t.TempDir(), bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	rep := adoptLegacyData(st)
	if rep == nil || rep.Notes != 2 || rep.Tasks != 1 {
		t.Fatalf("应接续旧数据 %+v", rep)
	}
	if n, ok := st.Note("n1"); !ok || n.Text != "旧版的一条笔记" {
		t.Fatal("笔记应带过来")
	}
	if ts := st.Tasks(); len(ts) != 1 || ts[0].ID != "t1" {
		t.Fatalf("任务 id 应保留（提醒事项靠它关联）%+v", ts)
	}
	cur := st.Settings()
	if cur.TauriMigration != "done" || cur.TauriMigratedAt == 0 || !cur.WelcomeTourSeen {
		t.Fatalf("应标记完成并跳过导览 %+v", cur.TauriMigration)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "toskr-data.json")); string(got) != doc {
		t.Fatal("旧版数据文件不应被改动")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("旧版目录里不应多出文件 %v", entries)
	}
	if adoptLegacyData(st) != nil {
		t.Fatal("只接续一次")
	}
	a := newApp(nopSys{}, st)
	if a.maybeOpenMigrate(); a.migrate != nil {
		t.Fatal("正式版不弹迁移向导")
	}
}

// 旧数据读不出来：不标记完成（设置里还能手动再试），库保持可用；没有旧数据什么都不做。
func TestAdoptLegacyDataFailsSoft(t *testing.T) {
	t.Cleanup(setReleased(true))
	st, _ := store.OpenDir(t.TempDir(), bytes.Repeat([]byte{7}, 32))
	if adoptLegacyData(st) != nil {
		t.Fatal("没有旧数据")
	}
	legacyFixture(t, `{"unknown":"{}"}`)
	if adoptLegacyData(st) != nil || st.Settings().TauriMigration != "" {
		t.Fatal("导入失败不应标记完成")
	}
	if _, _, err := st.Add(store.Note{Section: store.SectionInbox, Text: "还能用"}); err != nil {
		t.Fatal(err)
	}
}

// AI 密钥沿用旧版钥匙串记录：JSON 记录 / 早期纯字符串 / 已删除（key 为 null）；读一次后缓存；保存与删除写回同格式。
func TestLegacyAIKeyRecord(t *testing.T) {
	for in, want := range map[string]string{`{"key":" sk-abc ","updatedAtMs":5}`: "sk-abc", `{"key":null,"updatedAtMs":9}`: "", "sk-plain\n": "sk-plain"} {
		if got, err := decodeLegacyAI([]byte(in)); err != nil || got != want {
			t.Fatalf("%q → %q %v", in, got, err)
		}
	}
	if _, err := decodeLegacyAI([]byte(`{坏的`)); err == nil {
		t.Fatal("损坏的 JSON 不能当成密钥")
	}
	var stored []byte
	calls, fail := 0, false
	old := legacyAICall
	t.Cleanup(func() { legacyAICall = old; legacyAI.key, legacyAI.loaded, legacyAI.retryAt = "", false, time.Time{} })
	legacyAICall = func(op string, value []byte) (int32, []byte, error) {
		calls++
		switch {
		case fail:
			return 0, nil, errors.New("辅助程序不可用")
		case op == "store":
			stored = value
			return 0, nil, nil
		case stored == nil:
			return errSecItemNotFound, nil, nil
		}
		return 0, stored, nil
	}
	legacyAI.key, legacyAI.loaded, legacyAI.retryAt = "", false, time.Time{}
	if legacyAIKey() != "" || legacyAIKey() != "" || calls != 1 {
		t.Fatalf("没有记录也只读一次 calls=%d", calls)
	}
	if err := storeLegacyAIKey(" sk-new "); err != nil || legacyAIKey() != "sk-new" || calls != 2 {
		t.Fatalf("保存后直接用缓存 %v calls=%d", err, calls)
	}
	var rec legacyAIRecord
	if json.Unmarshal(stored, &rec) != nil || rec.Key == nil || *rec.Key != "sk-new" || rec.UpdatedAtMs == nil {
		t.Fatalf("记录格式同旧版 %s", stored)
	}
	if err := storeLegacyAIKey(""); err != nil || legacyAIKey() != "" {
		t.Fatal("删除")
	}
	if !strings.Contains(string(stored), `"key":null`) {
		t.Fatalf("删除写带时刻的空记录 %s", stored)
	}
	// 读取失败：一分钟内不重复起辅助进程
	legacyAI.loaded, fail = false, true
	before := calls
	if legacyAIKey() != "" || legacyAIKey() != "" || calls != before+1 {
		t.Fatalf("失败后应限流 calls=%d", calls-before)
	}
}

// 开机启动：旧版开着 → 打开本版登录项并移走旧启动项；登录项没生效就保留旧的；迭代期身份不碰。
func TestAdoptLegacyAutostart(t *testing.T) {
	oldSet, oldGet := setOpenAtLogin, openAtLogin
	t.Cleanup(func() { setOpenAtLogin, openAtLogin = oldSet, oldGet })
	on := false
	setOpenAtLogin = func(v bool) error { on = v; return nil }
	openAtLogin = func() bool { return on }
	_, agent := fakeLegacy(t)
	a, _ := testApp(t)
	a.adoptLegacyAutostart()
	if _, err := os.Stat(agent); err != nil || on {
		t.Fatal("迭代期身份不接管旧版的启动项")
	}
	t.Cleanup(setReleased(true))
	openAtLogin = func() bool { return false } // 登录项没生效
	a.adoptLegacyAutostart()
	if _, err := os.Stat(agent); err != nil {
		t.Fatal("登录项没生效时旧启动项必须保留")
	}
	openAtLogin = func() bool { return on }
	a.adoptLegacyAutostart()
	if _, err := os.Stat(agent); !errors.Is(err, os.ErrNotExist) || !on {
		t.Fatal("应打开登录项并移走旧启动项")
	}
	if _, err := os.Stat(filepath.Join(a.store.Dir(), "legacy-autostart-Toskr.plist")); err != nil {
		t.Fatal("旧启动项应留在数据目录里（可手动移回）")
	}
}

// 迭代期 → 正式版交接：用旧版的密钥整库重写到正式版目录；目标已有数据不覆盖；取不到密钥不动任何东西；正式版身份下拒绝。
func TestRunHandoff(t *testing.T) {
	k1, k2 := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	src, err := store.OpenDir(t.TempDir(), k1)
	if err != nil {
		t.Fatal(err)
	}
	_, _, _ = src.Add(store.Note{Section: store.SectionInbox, Text: "原生版里的笔记"})
	src.AddTask(store.Task{Text: "原生版里的任务"})
	dst := filepath.Join(t.TempDir(), "com.toskr.app", "v1")
	oldT, oldS, oldK := handoffTarget, handoffSource, tauriKey
	t.Cleanup(func() { handoffTarget, handoffSource, tauriKey = oldT, oldS, oldK })
	handoffTarget = func() (string, error) { return dst, nil }
	handoffSource = func() (*store.Store, error) { return src, nil }
	tauriKey = func() ([]byte, error) { return nil, errors.New("没有取得钥匙串授权") }
	if _, err := runHandoff(); err == nil {
		t.Fatal("取不到密钥应失败")
	}
	if _, err := os.Stat(dst); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("失败时不应留下目标目录")
	}
	tauriKey = func() ([]byte, error) { return bytes.Clone(k2), nil }
	msg, err := runHandoff()
	if err != nil || !strings.Contains(msg, "笔记 1、任务 1") {
		t.Fatalf("%q %v", msg, err)
	}
	got, err := store.OpenDir(dst, k2)
	if err != nil || len(got.Notes()) != 1 || got.Notes()[0].Text != "原生版里的笔记" || len(got.Tasks()) != 1 || got.Settings().TauriMigration != "done" {
		t.Fatalf("正式版应能用旧版密钥打开交接过来的数据 %v", err)
	}
	legacyFixture(t, legacyDoc(t)) // 这台机器上还有旧版数据：正式版启动时不应把它并进交接过来的库
	func() {
		defer setReleased(true)()
		if adoptLegacyData(got) != nil || len(got.Notes()) != 1 {
			t.Fatal("交接过来的库以原生版数据为准，不再接旧版数据")
		}
	}()
	if _, err := runHandoff(); err == nil || !strings.Contains(err.Error(), "没有覆盖") {
		t.Fatalf("目标已有数据不覆盖 %v", err)
	}
	t.Cleanup(setReleased(true))
	if _, err := runHandoff(); err == nil {
		t.Fatal("正式版身份下不做交接")
	}
}

// 旧版自定义过数据目录：正式版沿用它（放在其下的 v1 子目录）；自己的指针优先；默认目录里已有数据就不再沿用；
// 旧目录不可用按「自定义目录不可用」退回默认目录；迭代期身份不看旧版指针。
func TestInheritLegacyDataDir(t *testing.T) {
	def, custom := filepath.Join(t.TempDir(), "com.toskr.app", "v1"), t.TempDir()
	_ = os.MkdirAll(def, 0o700)
	ptr := filepath.Join(filepath.Dir(def), dataDirPointer)
	old := legacyPointerPath
	legacyPointerPath = func() string { return ptr }
	t.Cleanup(func() { legacyPointerPath = old })
	if d, m := resolveDataDir(def, true); d != def || m != "" {
		t.Fatalf("没有旧指针用默认目录 %s %s", d, m)
	}
	_ = os.WriteFile(ptr, []byte(custom+"\n"), 0o600)
	want := filepath.Join(custom, "v1")
	if d, m := resolveDataDir(def, true); d != want || m != "" {
		t.Fatalf("应沿用旧版自定义目录的 v1 子目录：%s %s", d, m)
	}
	if fi, err := os.Stat(want); err != nil || !fi.IsDir() {
		t.Fatal("子目录应已建好")
	}
	if d, _ := resolveDataDir(def, false); d != def {
		t.Fatal("迭代期身份不看旧版指针")
	}
	own := t.TempDir()
	_ = os.WriteFile(filepath.Join(def, dataDirPointer), []byte(own), 0o600)
	if d, _ := resolveDataDir(def, true); d != own {
		t.Fatal("自己的指针优先")
	}
	_ = os.Remove(filepath.Join(def, dataDirPointer))
	_ = os.WriteFile(ptr, []byte("/Volumes/没挂载的盘/Toskr"), 0o600)
	if d, m := resolveDataDir(def, true); d != def || m != "/Volumes/没挂载的盘/Toskr/v1" {
		t.Fatalf("旧目录不可用应退回默认并报告 %s %s", d, m)
	}
	_ = os.WriteFile(ptr, []byte(custom), 0o600)
	_ = os.WriteFile(filepath.Join(def, store.DataFile), []byte("x"), 0o600)
	if d, _ := resolveDataDir(def, true); d != def {
		t.Fatal("默认目录里已有数据（如在设置里换回默认）就不再沿用")
	}
}
