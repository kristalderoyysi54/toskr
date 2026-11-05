package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
)

const keyName = "data-key-v1"

// dataKey 从钥匙串取 32 字节数据密钥；首次运行生成。钥匙串不可用时显式失败，
// 绝不退回明文或临时密钥（否则下次启动解不开、表现为数据丢失）。
//
// 打包后的应用经内置辅助程序访问（见 keychain_helper.go，授权一次后重编译不再弹窗）；辅助程序存在但校验失败时
// 直接报错，不回退到主进程直读。只有开发态（go run / mygo dev，包里没有辅助程序）才由主进程直接读写。
func dataKey(fresh bool) ([]byte, error) {
	gen := func() ([]byte, error) {
		k := make([]byte, 32)
		_, err := rand.Read(k)
		return k, err
	}
	if !mygo.IsDev() && !devBinary() { // mygo dev 的包不带 hardened runtime，辅助程序会拒绝；开发态用独立数据目录直读
		path, err := helperPath()
		if err != nil {
			return nil, fmt.Errorf("内置密钥辅助程序缺失：请重新安装完整的 Toskr Native（%v）", err)
		}
		return helperDataKey(path, fresh, gen)
	}
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
	if key, err = gen(); err != nil {
		return nil, err
	}
	return key, mygo.Secrets.Set(keyName, key)
}

// devBinary：不在 .app 包里运行（go run / go build 出的裸二进制），只有开发者自己会这样跑。
func devBinary() bool {
	exe, err := os.Executable()
	return err == nil && filepath.Base(filepath.Dir(exe)) != "MacOS"
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
