//go:build darwin

package macos

import "github.com/ebitengine/purego"

var (
	AXIsProcessTrustedWithOptions func(options uintptr) bool
	AXUIElementCreateSystemWide   func() uintptr
	AXUIElementCopyAttributeValue func(el, attr uintptr, out *uintptr) int32
	kAXTrustedCheckOptionPrompt   uintptr
)

func loadAX() {
	purego.RegisterLibFunc(&AXIsProcessTrustedWithOptions, ax, "AXIsProcessTrustedWithOptions")
	purego.RegisterLibFunc(&AXUIElementCreateSystemWide, ax, "AXUIElementCreateSystemWide")
	purego.RegisterLibFunc(&AXUIElementCopyAttributeValue, ax, "AXUIElementCopyAttributeValue")
	kAXTrustedCheckOptionPrompt = deref(ax, "kAXTrustedCheckOptionPrompt")
}

// AXTrusted 报告是否已获辅助功能授权；prompt 为 true 时系统弹出授权引导。
func AXTrusted(prompt bool) bool {
	load()
	if !prompt {
		return AXIsProcessTrustedWithOptions(0)
	}
	keys := []uintptr{kAXTrustedCheckOptionPrompt}
	vals := []uintptr{kCFBooleanTrue}
	dict := CFDictionaryCreate(0, &keys[0], &vals[0], 1, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks)
	defer CFRelease(dict)
	return AXIsProcessTrustedWithOptions(dict)
}

// Selection 是 AX 直读结果。
type Selection int

const (
	SelUnsupported Selection = iota // 拿不到焦点元素或不支持 AXSelectedText
	SelEmpty                        // 支持但为空（不可信：部分终端从不填充）
	SelText
)

// SelectedText 读系统焦点元素的 AXSelectedText。
func SelectedText() (Selection, string) {
	load()
	sys := AXUIElementCreateSystemWide()
	defer CFRelease(sys)
	focusedAttr := cfString("AXFocusedUIElement")
	defer CFRelease(focusedAttr)
	var focused uintptr
	if AXUIElementCopyAttributeValue(sys, focusedAttr, &focused) != 0 || focused == 0 {
		return SelUnsupported, ""
	}
	defer CFRelease(focused)
	selAttr := cfString("AXSelectedText")
	defer CFRelease(selAttr)
	var value uintptr
	if AXUIElementCopyAttributeValue(focused, selAttr, &value) != 0 || value == 0 {
		return SelUnsupported, ""
	}
	defer CFRelease(value)
	if CFGetTypeID(value) != CFStringGetTypeID() {
		return SelUnsupported, ""
	}
	if s := goString(value); s != "" {
		return SelText, s
	}
	return SelEmpty, ""
}

// FocusedValue 读系统焦点元素的 AXValue（字符串型输入框）；用于粘贴结果核验。
func FocusedValue() (string, bool) {
	load()
	sys := AXUIElementCreateSystemWide()
	defer CFRelease(sys)
	focused := copyAttr(sys, "AXFocusedUIElement")
	if focused == 0 {
		return "", false
	}
	defer CFRelease(focused)
	value := copyAttr(focused, "AXValue")
	if value == 0 {
		return "", false
	}
	defer CFRelease(value)
	if CFGetTypeID(value) != CFStringGetTypeID() {
		return "", false
	}
	return goString(value), true
}
