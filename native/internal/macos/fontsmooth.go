//go:build darwin

package macos

// WebFontSmoothing 让本进程画字与 Tauri（WKWebView + -webkit-font-smoothing: antialiased）一致：
// 在本应用 NSUserDefaults 的注册域放 AppleFontSmoothing = 0，mygo 的 Core Text 栅格化读到后不再做
// 字体平滑（stem darkening，同字重笔画会粗一圈）。只作用于本进程、不写盘；用户若在本应用域显式设置过则以其为准。
// 必须在第一次排版文字之前调用（mygo 文字引擎创建时只读一次）。
func WebFontSmoothing() {
	load()
	withPool(func() {
		num := class("NSNumber").Send(sel("numberWithInt:"), 0)
		dict := class("NSDictionary").Send(sel("dictionaryWithObject:forKey:"), num, nsString("AppleFontSmoothing"))
		class("NSUserDefaults").Send(sel("standardUserDefaults")).Send(sel("registerDefaults:"), dict)
	})
}
