//go:build darwin

package macos

import "github.com/ebitengine/purego/objc"

// AppIconPNG 返回 bundle 对应应用的图标 PNG（同 Tauri focus.rs app_icon_png_base64）：
// 优先运行中进程的图标，查不到回退 NSWorkspace 按安装路径取；都没有返回 nil。
// NSImage 的 TIFF 表示取第一张位图（通常是最大尺寸），由调用方缩放。
func AppIconPNG(bundle string) []byte {
	if bundle == "" {
		return nil
	}
	load()
	var out []byte
	withPool(func() {
		var img objc.ID
		if apps := class("NSRunningApplication").Send(sel("runningApplicationsWithBundleIdentifier:"), nsString(bundle)); objc.Send[uint](apps, sel("count")) > 0 {
			img = apps.Send(sel("firstObject")).Send(sel("icon"))
		}
		if img == 0 {
			ws := class("NSWorkspace").Send(sel("sharedWorkspace"))
			url := ws.Send(sel("URLForApplicationWithBundleIdentifier:"), nsString(bundle))
			if url == 0 {
				return
			}
			img = ws.Send(sel("iconForFile:"), url.Send(sel("path")))
		}
		if img == 0 {
			return
		}
		tiff := img.Send(sel("TIFFRepresentation"))
		if tiff == 0 {
			return
		}
		rep := class("NSBitmapImageRep").Send(sel("imageRepWithData:"), tiff)
		if rep == 0 {
			return
		}
		const pngFileType = 4 // NSBitmapImageFileTypePNG
		png := rep.Send(sel("representationUsingType:properties:"), uint(pngFileType), class("NSDictionary").Send(sel("dictionary")))
		if png != 0 {
			out = nsDataBytes(png)
		}
	})
	return out
}
