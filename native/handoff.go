package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/toskr/native/internal/store"
)

// 迭代期 → 正式版的数据交接（只有装过 Toskr Native 的机器需要，普通用户走 legacy_adopt.go 的静默接续）。
// 两种身份的数据密钥不同（原生版自己的 / 旧版那一把），所以不是复制目录，而是用旧版的密钥整库重写到
// 正式版的数据目录。之后正式版首次启动看到那里已有数据，就直接用它，不再去接旧版的数据。
// 用法（先退出 Toskr Native）：TOSKR_HANDOFF_TO_RELEASE=1 "…/Toskr Native.app/Contents/MacOS/Toskr Native"
// 读旧版密钥时系统会弹一次钥匙串授权框。原生版自己的数据原样保留。

const handoffEnv = "TOSKR_HANDOFF_TO_RELEASE"

// releaseDataDir：正式版的默认数据目录（不随当前身份变）。
func releaseDataDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, releaseBundle, "v1")
}

var ( // 测试替换
	handoffTarget = func() (string, error) { // 与正式版启动时的解析一致（含沿用旧版的自定义数据目录）
		dir, missing := resolveDataDir(releaseDataDir(), true)
		if missing != "" {
			return "", fmt.Errorf("正式版要用的数据目录不可用：%s", missing)
		}
		return dir, nil
	}
	handoffSource = func() (*store.Store, error) {
		dir, missing := activeDataDir()
		if missing != "" {
			return nil, fmt.Errorf("自定义数据目录不可用：%s", missing)
		}
		if _, err := os.Stat(filepath.Join(dir, store.DataFile)); err != nil {
			return nil, errors.New("这台机器上没有 Toskr Native 的数据")
		}
		key, err := dataKey(false)
		if err != nil {
			return nil, err
		}
		return store.OpenDir(dir, key)
	}
)

// runHandoff 返回给用户看的结果说明。
func runHandoff() (string, error) {
	if released() {
		return "", errors.New("正式版不需要交接：它直接使用自己的数据")
	}
	dst, err := handoffTarget()
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(filepath.Join(dst, store.DataFile)); err == nil {
		return "", fmt.Errorf("正式版的数据目录里已经有数据，没有覆盖：%s", dst)
	}
	st, err := handoffSource()
	if err != nil {
		return "", err
	}
	key, err := tauriKey() // 旧版的数据密钥 = 正式版的数据密钥
	if err != nil {
		return "", fmt.Errorf("读不到正式版要用的数据密钥：%w", err)
	}
	defer clear(key)
	info, err := st.RekeyTo(dst, key)
	if err != nil {
		return "", err
	}
	// 标记「已接续」：正式版启动后以这份为准，不再把旧版的数据并进来
	t, err := store.OpenDir(dst, key)
	if err != nil {
		return "", err
	}
	cur := t.Settings()
	cur.TauriMigration = "done"
	if err := t.SetSettings(cur); err != nil {
		return "", err
	}
	if err := t.Flush(); err != nil {
		return "", err
	}
	return fmt.Sprintf("已把 Toskr Native 的数据交接给正式版：笔记 %d、任务 %d、图片 %d。\n位置：%s\n原数据原样保留。", info.Notes, info.Tasks, info.Media, dst), nil
}
