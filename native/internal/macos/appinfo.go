//go:build darwin

package macos

import "strings"

// AppDisplayName：bundle 对应已安装应用的显示名（Finder 里看到的名字，去掉 .app）；找不到返回空串。
func AppDisplayName(bundle string) string {
	if bundle == "" {
		return ""
	}
	load()
	out := ""
	withPool(func() {
		ws := class("NSWorkspace").Send(sel("sharedWorkspace"))
		url := ws.Send(sel("URLForApplicationWithBundleIdentifier:"), nsString(bundle))
		if url == 0 {
			return
		}
		fm := class("NSFileManager").Send(sel("defaultManager"))
		out = strings.TrimSuffix(goString(uintptr(fm.Send(sel("displayNameAtPath:"), url.Send(sel("path"))))), ".app")
	})
	return out
}

// BundleIDOfApp：.app 路径的 bundle id（同 Tauri bundle_id_of_app）；不是应用包返回空串。
func BundleIDOfApp(path string) string {
	load()
	out := ""
	withPool(func() {
		b := class("NSBundle").Send(sel("bundleWithPath:"), nsString(path))
		if b != 0 {
			out = goString(uintptr(b.Send(sel("bundleIdentifier"))))
		}
	})
	return out
}
