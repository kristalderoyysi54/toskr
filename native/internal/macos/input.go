//go:build darwin

package macos

import (
	"errors"
	"runtime"
	"time"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

var (
	CGEventTapCreate            func(tap, place, options uint32, mask uint64, cb, info uintptr) uintptr
	CGEventTapEnable            func(port uintptr, enable bool)
	CGEventGetFlags             func(ev uintptr) uint64
	CGEventSetFlags             func(ev uintptr, flags uint64)
	CGEventGetIntegerValueField func(ev uintptr, field uint32) int64
	CGEventSetIntegerValueField func(ev uintptr, field uint32, v int64)
	CGEventCreateKeyboardEvent  func(src uintptr, key uint16, down bool) uintptr
	CGEventPost                 func(tap uint32, ev uintptr)
	CGEventSourceFlagsState     func(state int32) uint64
)

func loadCG() {
	for name, fn := range map[string]any{
		"CGEventTapCreate": &CGEventTapCreate, "CGEventTapEnable": &CGEventTapEnable,
		"CGEventGetFlags": &CGEventGetFlags, "CGEventSetFlags": &CGEventSetFlags,
		"CGEventGetIntegerValueField": &CGEventGetIntegerValueField, "CGEventSetIntegerValueField": &CGEventSetIntegerValueField,
		"CGEventCreateKeyboardEvent": &CGEventCreateKeyboardEvent, "CGEventPost": &CGEventPost,
		"CGEventSourceFlagsState": &CGEventSourceFlagsState,
	} {
		purego.RegisterLibFunc(fn, cg, name)
	}
}

// 事件类型与修饰键位（CGEventTypes.h）。
const (
	EventKeyDown           = 10
	EventFlagsChanged      = 12
	tapDisabledByTimeout   = 0xFFFFFFFE
	tapDisabledByUserInput = 0xFFFFFFFF

	FlagShift   uint64 = 0x00020000
	FlagControl uint64 = 0x00040000
	FlagOption  uint64 = 0x00080000
	FlagCommand uint64 = 0x00100000

	fieldKeycode    = 9
	fieldSourceUser = 42
	// SynthMarker 标记本应用合成的按键，监听回调据此忽略自身输入。
	SynthMarker int64 = 0x70B5_7051
)

// KeyEvent 是事件监听回调收到的键盘事件（只读，不改写事件流）。
type KeyEvent struct {
	Type      uint32
	Flags     uint64
	Keycode   int64
	Synthetic bool
}

var (
	tapPort    uintptr
	tapHandler func(KeyEvent)
	tapCB      uintptr
)

// StartKeyTap 在独立 OS 线程上建立只读（ListenOnly）会话级事件监听并运行 CFRunLoop。
// 需要「辅助功能」或「输入监控」权限；返回 error 表示 tap 创建失败。
// 调用前应用必须已是 Accessory 激活策略（Sequoia 上是创建成功的前提）。
func StartKeyTap(handler func(KeyEvent)) error {
	load()
	tapHandler = handler
	if tapCB == 0 {
		tapCB = purego.NewCallback(func(proxy uintptr, typ uint32, ev uintptr, info uintptr) uintptr {
			if typ == tapDisabledByTimeout || typ == tapDisabledByUserInput {
				CGEventTapEnable(tapPort, true)
				return ev
			}
			if h := tapHandler; h != nil {
				h(KeyEvent{
					Type:      typ,
					Flags:     CGEventGetFlags(ev),
					Keycode:   CGEventGetIntegerValueField(ev, fieldKeycode),
					Synthetic: CGEventGetIntegerValueField(ev, fieldSourceUser) == SynthMarker,
				})
			}
			return ev
		})
	}
	result := make(chan error, 1)
	go func() {
		runtime.LockOSThread() // CFRunLoop 绑定当前线程
		mask := uint64(1<<EventKeyDown | 1<<EventFlagsChanged)
		// kCGSessionEventTap=1, kCGHeadInsertEventTap=0, kCGEventTapOptionListenOnly=1
		port := CGEventTapCreate(1, 0, 1, mask, tapCB, 0)
		if port == 0 {
			result <- errors.New("CGEventTapCreate 失败：缺少辅助功能 / 输入监控权限")
			return
		}
		tapPort = port
		CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(0, port, 0), kCFRunLoopCommonModes)
		CGEventTapEnable(port, true)
		result <- nil
		CFRunLoopRun()
	}()
	return <-result
}

// PostKey 合成一次组合键（如 ⌘C keycode 8、⌘V keycode 9），带 SynthMarker。
func PostKey(keycode uint16, flags uint64) {
	load()
	for _, down := range []bool{true, false} {
		ev := CGEventCreateKeyboardEvent(0, keycode, down)
		CGEventSetFlags(ev, flags)
		CGEventSetIntegerValueField(ev, fieldSourceUser, SynthMarker)
		CGEventPost(0, ev) // kCGHIDEventTap
		CFRelease(ev)
		time.Sleep(12 * time.Millisecond)
	}
}

const (
	KeyC uint16 = 8
	KeyV uint16 = 9
)

// HeldModifiers 返回此刻键盘上真实按住的修饰键（kCGEventSourceStateCombinedSessionState）。
// 窗口失焦期间松开的修饰键不会送到窗口，界面里缓存的修饰键状态会卡住；按住类交互以它为准。
func HeldModifiers() uint64 {
	load()
	return CGEventSourceFlagsState(0)
}

// MouseButtonsDown：此刻是否按着任意鼠标键（[NSEvent pressedMouseButtons]，系统级，与指针在哪个窗口无关）。
func MouseButtonsDown() bool {
	load()
	return objc.Send[uint](class("NSEvent"), sel("pressedMouseButtons")) != 0
}
