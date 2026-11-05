package main

import (
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
)

const keyName = "data-key-v1"

// dataKey 从钥匙串取 32 字节数据密钥；首次运行生成。钥匙串不可用时显式失败，
// 绝不退回明文或临时密钥（否则下次启动解不开、表现为数据丢失）。
func dataKey(fresh bool) ([]byte, error) {
	key, err := mygo.Secrets.Get(keyName)
	if err == nil && len(key) == 32 {
		return key, nil
	}
	if err != nil && !errors.Is(err, mygo.ErrSecretNotFound) {
		return nil, err
	}
	if !fresh {
		return nil, errors.New("钥匙串里没有数据密钥，但数据文件已存在：拒绝新建密钥覆盖")
	}
	key = make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	return key, mygo.Secrets.Set(keyName, key)
}

// dataDir 是原生版独立的数据目录（不碰 Tauri 版 com.toskr.app）。
func dataDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	id := "com.toskr.native"
	if mygo.IsDev() {
		id += ".dev"
	}
	return filepath.Join(base, id)
}
