//go:build darwin

package macos

import (
	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// PickApplication 弹系统「打开」面板，只允许选应用（.app），返回所选应用的路径；取消返回空串。主线程调用（模态）。
// 不用 mygo Dialog.Open 的扩展名过滤：它把 "app" 转成 UTType(filenameExtension:)，默认按 public.data 解析得到
// com.apple.application-file，而 .app 是 com.apple.application-bundle（包），结果面板里所有应用都是灰的、选不了。
func PickApplication(title, prompt string) string {
	load()
	_, _ = purego.Dlopen("/System/Library/Frameworks/UniformTypeIdentifiers.framework/UniformTypeIdentifiers", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	out := ""
	withPool(func() {
		panel := class("NSOpenPanel").Send(sel("openPanel"))
		panel.Send(sel("setCanChooseFiles:"), true)
		panel.Send(sel("setCanChooseDirectories:"), false)
		panel.Send(sel("setAllowsMultipleSelection:"), false)
		panel.Send(sel("setTreatsFilePackagesAsDirectories:"), false)
		if title != "" {
			panel.Send(sel("setTitle:"), nsString(title))
			panel.Send(sel("setMessage:"), nsString(title))
		}
		if prompt != "" {
			panel.Send(sel("setPrompt:"), nsString(prompt))
		}
		panel.Send(sel("setDirectoryURL:"), class("NSURL").Send(sel("fileURLWithPath:"), nsString("/Applications")))
		if ut := class("UTType"); ut != 0 {
			if t := ut.Send(sel("typeWithIdentifier:"), nsString("com.apple.application-bundle")); t != 0 {
				panel.Send(sel("setAllowedContentTypes:"), class("NSArray").Send(sel("arrayWithObject:"), t))
			}
		} else {
			panel.Send(sel("setAllowedFileTypes:"), class("NSArray").Send(sel("arrayWithObject:"), nsString("app")))
		}
		class("NSApplication").Send(sel("sharedApplication")).Send(sel("activateIgnoringOtherApps:"), true)
		if objc.Send[int](panel, sel("runModal")) != 1 { // NSModalResponseOK
			return
		}
		urls := panel.Send(sel("URLs"))
		if objc.Send[int](urls, sel("count")) == 0 {
			return
		}
		out = goString(uintptr(urls.Send(sel("objectAtIndex:"), 0).Send(sel("path"))))
	})
	return out
}
