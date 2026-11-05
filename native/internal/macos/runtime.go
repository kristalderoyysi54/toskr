//go:build darwin

// Package macos 是 Toskr 原生版直接调用的系统接口（purego，无 cgo）：
// 事件监听、辅助功能读选区、剪贴板事务、合成按键、前台应用。
// 对应 Rust 版的 input/tap.rs、ax.rs、pasteboard.rs、input/synth.rs、focus.rs。
package macos

import (
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

var (
	loadOnce   sync.Once
	cf, cg, ax uintptr

	CFRelease                     func(p uintptr)
	CFRetain                      func(p uintptr) uintptr
	CFStringCreateWithBytes       func(alloc uintptr, b *byte, n int, enc uint32, ext bool) uintptr
	CFStringGetLength             func(s uintptr) int
	CFStringGetBytes              func(s uintptr, loc, length int, enc uint32, lossByte uint8, ext bool, buf *byte, max int, used *int) int
	CFGetTypeID                   func(p uintptr) uint
	CFStringGetTypeID             func() uint
	CFDictionaryCreate            func(alloc uintptr, keys, values *uintptr, n int, kcb, vcb uintptr) uintptr
	CFMachPortCreateRunLoopSource func(alloc, port uintptr, order int) uintptr
	CFRunLoopGetCurrent           func() uintptr
	CFRunLoopAddSource            func(rl, src, mode uintptr)
	CFRunLoopRun                  func()

	kCFBooleanTrue, kCFRunLoopCommonModes, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks uintptr
)

const kCFStringEncodingUTF8 = 0x08000100

func load() {
	loadOnce.Do(func() {
		var err error
		open := func(p string) uintptr {
			h, e := purego.Dlopen(p, purego.RTLD_NOW|purego.RTLD_GLOBAL)
			if e != nil {
				err = e
			}
			return h
		}
		cf = open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
		cg = open("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
		ax = open("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
		open("/System/Library/Frameworks/AppKit.framework/AppKit")
		if err != nil {
			panic(err)
		}
		for name, fn := range map[string]any{
			"CFRelease": &CFRelease, "CFRetain": &CFRetain, "CFStringCreateWithBytes": &CFStringCreateWithBytes,
			"CFStringGetLength": &CFStringGetLength, "CFStringGetBytes": &CFStringGetBytes,
			"CFGetTypeID": &CFGetTypeID, "CFStringGetTypeID": &CFStringGetTypeID, "CFDictionaryCreate": &CFDictionaryCreate,
			"CFMachPortCreateRunLoopSource": &CFMachPortCreateRunLoopSource, "CFRunLoopGetCurrent": &CFRunLoopGetCurrent,
			"CFRunLoopAddSource": &CFRunLoopAddSource, "CFRunLoopRun": &CFRunLoopRun,
		} {
			purego.RegisterLibFunc(fn, cf, name)
		}
		kCFBooleanTrue = deref(cf, "kCFBooleanTrue")
		kCFRunLoopCommonModes = deref(cf, "kCFRunLoopCommonModes")
		kCFTypeDictionaryKeyCallBacks, _ = purego.Dlsym(cf, "kCFTypeDictionaryKeyCallBacks")
		kCFTypeDictionaryValueCallBacks, _ = purego.Dlsym(cf, "kCFTypeDictionaryValueCallBacks")
		loadCG()
		loadAX()
	})
}

func deref(lib uintptr, name string) uintptr {
	p, err := purego.Dlsym(lib, name)
	if err != nil {
		panic(err)
	}
	return *(*uintptr)(unsafe.Pointer(p))
}

// cfString 创建 CFString（调用方 CFRelease）。
func cfString(s string) uintptr {
	load()
	b := []byte(s)
	if len(b) == 0 {
		b = []byte{0}
		r := CFStringCreateWithBytes(0, &b[0], 0, kCFStringEncodingUTF8, false)
		return r
	}
	r := CFStringCreateWithBytes(0, &b[0], len(b), kCFStringEncodingUTF8, false)
	runtime.KeepAlive(b)
	return r
}

// goString 读 CFString / NSString（toll-free bridged）。
func goString(s uintptr) string {
	if s == 0 {
		return ""
	}
	n := CFStringGetLength(s)
	if n == 0 {
		return ""
	}
	buf := make([]byte, n*4+1)
	var used int
	CFStringGetBytes(s, 0, n, kCFStringEncodingUTF8, '?', false, &buf[0], len(buf), &used)
	return string(buf[:used])
}

// ---- Objective-C 小工具 ----

func sel(name string) objc.SEL  { return objc.RegisterName(name) }
func class(name string) objc.ID { return objc.ID(objc.GetClass(name)) }
func nsString(s string) objc.ID {
	// CFString 与 NSString toll-free bridged；交给 autorelease 管理
	ref := cfString(s)
	return objc.ID(ref).Send(sel("autorelease"))
}

// withPool 在 autorelease pool 里执行（非主线程调用 AppKit 时必须）。
func withPool(fn func()) {
	pool := class("NSAutoreleasePool").Send(sel("alloc")).Send(sel("init"))
	defer pool.Send(sel("drain"))
	fn()
}
