package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

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

// adoptLegacyData：还没接续过（TauriMigration 为空）且有旧版数据时导入一次。返回导入报告（nil = 不需要、或这次没成功）。
// 从迭代期交接过来的库已标记完成（handoff.go），不会再被旧版数据覆盖。
func adoptLegacyData(st *store.Store) *store.TauriReport {
	if st.Settings().TauriMigration != "" || !legacyDataExists() {
		return nil
	}
	dir := legacyDataDir()
	rep, err := st.ImportTauri(dir, st.Key())
	if err != nil { // 不标记完成：设置 → 数据「从旧版迁移」可再试；旧数据没有被改动
		diag.Push("接续旧版数据失败 %s: %v", dir, err)
		return nil
	}
	cur := st.Settings()
	cur.TauriMigration, cur.TauriMigratedAt = "done", time.Now().UnixMilli()
	cur.WelcomeTourSeen = true // 老用户升级：不再弹首启导览
	_ = st.SetSettings(cur)
	diag.Push("已接续旧版数据 %s：笔记 %d 分组 %d 任务 %d 账单 %d 秘文 %d 消息 %d 图片 %d（缺 %d）· %s",
		dir, rep.Notes, rep.Sections, rep.Tasks, rep.Bills, rep.Secrets, rep.Messages, rep.Media, rep.MediaMissing, rep.Check.Summary())
	return &rep
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
