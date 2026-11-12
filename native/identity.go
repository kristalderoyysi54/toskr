package main

import (
	"strings"
	"sync"

	"github.com/toskr/native/internal/macos"
)

// 同一份源码按应用包标识分两种身份（打包时由 mygo.json 的 identifier 决定，运行时读自己的包标识）：
//   - com.toskr.native：迭代期的「Toskr Native」，与旧版（Tauri）并存，数据、钥匙串条目、提醒事项列表都各用各的；
//   - com.toskr.app：正式版「Toskr」，接替旧版——旧版点「更新」后装上的就是它。沿用旧版的包标识
//     （辅助功能 / 输入监控授权按「标识 + 证书」保留）、旧版的数据密钥（经旧版原样的密钥辅助程序读取，不弹授权框）、
//     旧版的提醒事项列表；首次启动把旧版数据静默接过来（legacy_adopt.go）。
// 其它标识（mygo dev 的 .dev 后缀、go test 里没有包）一律按迭代期处理。

const (
	nativeBundle  = "com.toskr.native"
	releaseBundle = legacyBundle // com.toskr.app
)

var bundleID = sync.OnceValue(func() string { // 测试里用 setReleased 替换
	if id := macos.MainBundleID(); id != "" {
		return id
	}
	return nativeBundle
})

// released：正式版身份。
func released() bool { return bundleID() == releaseBundle }

// setReleased：测试切换身份，返回还原函数。
func setReleased(on bool) func() {
	prev := bundleID
	id := nativeBundle
	if on {
		id = releaseBundle
	}
	bundleID = func() string { return id }
	return func() { bundleID = prev }
}

// appName：给用户看的应用名。
func appName() string {
	if released() {
		return "Toskr"
	}
	return "Toskr Native"
}

// brand：文案里的「Toskr Native」在正式版里写成「Toskr」（tr 已内置；没走 tr 的文案手动调）。
func brand(s string) string {
	if released() && strings.Contains(s, "Toskr Native") {
		return strings.ReplaceAll(s, "Toskr Native", "Toskr")
	}
	return s
}

// helperSpec：包内密钥辅助程序（Contents/Resources 下的固定产物）及其锁定身份。
type helperSpec struct {
	file       string // 资源文件名；mygo 重签时按「文件名去掉最后一段扩展名」定标识
	identifier string
	cdhash     string // arm64 切片
	cdhashX86  string // x86_64 切片（Intel 机器上系统跑的是这一片，指纹不同）
}

var (
	// 迭代期：原生版自己的辅助程序与钥匙串条目。
	nativeHelper = helperSpec{file: "com.toskr.native.keychain-helper", identifier: "com.toskr.native", cdhash: "fc4feefa9eb2f2264085822ed17e4a383fb61d04", cdhashX86: "0f75b278ee67af4d3c89c5ec7617f78586ef800a"}
	// 正式版：旧版的辅助程序原样产物（src-tauri/keychain-helper/artifacts，文件名加 .bin 让重签后的标识仍是
	// com.toskr.keychain-helper）。钥匙串授权绑在它的 CDHash 上：指纹一变，存量用户就会被要求重新授权，
	// 所以发布脚本逐包核对这个值（script/release-native.sh）。
	releaseHelper = helperSpec{file: "com.toskr.keychain-helper.bin", identifier: "com.toskr.keychain-helper", cdhash: "5008368f7af34fde0f4ca7d5277eecb4a5218ef0", cdhashX86: "3ef817d1670e8e9d27175545ccfc48e0794e1f88"}
)

func activeHelper() helperSpec {
	if released() {
		return releaseHelper
	}
	return nativeHelper
}
