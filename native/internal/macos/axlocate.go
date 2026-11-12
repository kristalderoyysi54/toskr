//go:build darwin

package macos

import (
	"strings"
	"sync"
	"time"

	"github.com/ebitengine/purego"
)

// 在 IM 的会话列表里找到某个会话并滚到可见（同 Tauri ax.rs locate_conversation）：只读辅助功能树，
// 不打开会话、不改已读。列表按结构特征识别（窗口左半、宽 ≥120、高 ≥ 窗口 35%、子项 ≥5）。

// LocateOutcome 是定位结果。
type LocateOutcome int

const (
	LocateNoList    LocateOutcome = iota // 没认出会话列表（主窗口没开 / 最小化）
	LocateNotInList                      // 有列表但没这个会话（可能在搜索或过滤状态）
	LocateRow                            // 找到并已在可视范围
)

var (
	axLocOnce        sync.Once
	axSetAttr        func(el, attr, val uintptr) int32
	axPerformAction  func(el, action uintptr) int32
	axArrCount       func(arr uintptr) int
	axArrAt          func(arr uintptr, i int) uintptr
	cfArrayGetTypeID func() uint
)

func loadLocate() {
	load()
	axWinOnce.Do(func() {
		purego.RegisterLibFunc(&axUIElementCreateApplication, ax, "AXUIElementCreateApplication")
		purego.RegisterLibFunc(&axValueGetValue, ax, "AXValueGetValue")
	})
	axLocOnce.Do(func() {
		purego.RegisterLibFunc(&axSetAttr, ax, "AXUIElementSetAttributeValue")
		purego.RegisterLibFunc(&axPerformAction, ax, "AXUIElementPerformAction")
		purego.RegisterLibFunc(&axArrCount, cf, "CFArrayGetCount")
		purego.RegisterLibFunc(&axArrAt, cf, "CFArrayGetValueAtIndex")
		purego.RegisterLibFunc(&cfArrayGetTypeID, cf, "CFArrayGetTypeID")
	})
}

// TitleMatches 同 Tauri title_matches：行文本包含会话名；或行文本是被截断（…）的长名、会话名包含它。
func TitleMatches(title, needle string) bool {
	title = strings.TrimSpace(title)
	if title == "" {
		return false
	}
	core := strings.TrimSpace(strings.TrimRight(title, "…"))
	return strings.Contains(title, needle) || (len([]rune(core)) >= 6 && strings.Contains(needle, core))
}

func elFrame(el uintptr) (Rect, bool) {
	pos, size := copyAttr(el, "AXPosition"), copyAttr(el, "AXSize")
	defer func() {
		if pos != 0 {
			CFRelease(pos)
		}
		if size != 0 {
			CFRelease(size)
		}
	}()
	if pos == 0 || size == 0 {
		return Rect{}, false
	}
	var p, s [2]float64
	if !axValueGetValue(pos, 1, &p) || !axValueGetValue(size, 2, &s) {
		return Rect{}, false
	}
	return Rect{X: p[0], Y: p[1], W: s[0], H: s[1]}, true
}

func elString(el uintptr, attr string) string {
	v := copyAttr(el, attr)
	if v == 0 {
		return ""
	}
	defer CFRelease(v)
	if CFGetTypeID(v) != CFStringGetTypeID() {
		return ""
	}
	return goString(v)
}

func elBool(el uintptr, attr string) bool {
	v := copyAttr(el, attr)
	if v == 0 {
		return false
	}
	defer CFRelease(v)
	return v == kCFBooleanTrue
}

// children 返回 AXChildren 数组（已 retain 的数组，调用方 CFRelease）与元素列表（借用，数组释放前有效）。
func children(el uintptr) (uintptr, []uintptr) {
	arr := copyAttr(el, "AXChildren")
	if arr == 0 {
		return 0, nil
	}
	if CFGetTypeID(arr) != cfArrayGetTypeID() {
		CFRelease(arr)
		return 0, nil
	}
	n := axArrCount(arr)
	out := make([]uintptr, 0, n)
	for i := range n {
		if c := axArrAt(arr, i); c != 0 {
			out = append(out, c)
		}
	}
	return arr, out
}

// walk 先序遍历（预算内），visit 返回 true 时停止；借用的子元素在遍历期间由其父数组保活。
func walk(root uintptr, maxNodes, maxDepth int, visit func(el uintptr) bool) {
	type item struct {
		el    uintptr
		depth int
	}
	var arrays []uintptr
	defer func() {
		for _, a := range arrays {
			CFRelease(a)
		}
	}()
	stack := []item{{root, 0}}
	for n := 0; len(stack) > 0 && n < maxNodes; n++ {
		it := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if visit(it.el) {
			return
		}
		if it.depth >= maxDepth {
			continue
		}
		arr, kids := children(it.el)
		if arr == 0 {
			continue
		}
		arrays = append(arrays, arr)
		for i := len(kids) - 1; i >= 0; i-- {
			stack = append(stack, item{kids[i], it.depth + 1})
		}
	}
}

func rowVisible(row, list Rect) bool {
	return row.H >= 8 && row.Y >= list.Y-4 && row.Y+row.H <= list.Y+list.H+8
}

// LocateConversation 在 pid 的窗口里找会话列表与 needle 所在行，必要时让它滚到可见（AXScrollToVisible），返回行的屏幕矩形。
// Chromium 在首次打开辅助功能树后要一会才建好（实测第一次 150ms 内读必然「未识别列表」），没认出列表时重试两次。
func LocateConversation(pid int32, needle string) (Rect, LocateOutcome) {
	for i := 0; ; i++ {
		r, res := locateOnce(pid, needle)
		if res != LocateNoList || i == 2 {
			return r, res
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// rowMatches：exact 时要求行内某个文本节点与会话名完全相同（避免别的行的消息预览里提到这个群名而误命中）。
func rowMatches(row uintptr, needle string, exact bool) bool {
	hit := false
	walk(row, 40, 10, func(el uintptr) bool {
		for _, attr := range []string{"AXTitle", "AXValue", "AXDescription"} {
			v := strings.TrimSpace(elString(el, attr))
			if exact && v == needle || !exact && TitleMatches(v, needle) {
				hit = true
				return true
			}
		}
		return false
	})
	return hit
}

func locateOnce(pid int32, needle string) (Rect, LocateOutcome) {
	needle = strings.TrimSpace(needle)
	if needle == "" {
		return Rect{}, LocateNotInList
	}
	loadLocate()
	app := axUIElementCreateApplication(pid)
	if app == 0 {
		return Rect{}, LocateNoList
	}
	defer CFRelease(app)
	for _, attr := range []string{"AXManualAccessibility", "AXEnhancedUserInterface"} { // Electron / Chromium 默认不展开网页可访问树
		a := cfString(attr)
		axSetAttr(app, a, kCFBooleanTrue)
		CFRelease(a)
	}
	winArr, wins := func() (uintptr, []uintptr) {
		arr := copyAttr(app, "AXWindows")
		if arr == 0 || CFGetTypeID(arr) != cfArrayGetTypeID() {
			if arr != 0 {
				CFRelease(arr)
			}
			return 0, nil
		}
		var out []uintptr
		for i := range axArrCount(arr) {
			out = append(out, axArrAt(arr, i))
		}
		return arr, out
	}()
	if winArr == 0 {
		return Rect{}, LocateNoList
	}
	defer CFRelease(winArr)
	outcome := LocateNoList
	for _, win := range wins {
		if win == 0 || elBool(win, "AXMinimized") {
			continue
		}
		wf, ok := elFrame(win)
		if !ok {
			continue
		}
		var list uintptr
		var lf Rect
		walk(win, 3500, 30, func(el uintptr) bool {
			if elString(el, "AXRole") != "AXList" {
				return false
			}
			f, ok := elFrame(el)
			if !ok || f.X >= wf.X+wf.W*0.5 || f.H < wf.H*0.35 || f.W < 120 {
				return false
			}
			arr, kids := children(el)
			if arr != 0 {
				CFRelease(arr)
			}
			if len(kids) < 5 {
				return false
			}
			list, lf = CFRetain(el), f
			return true
		})
		if list == 0 {
			continue
		}
		outcome = LocateNotInList
		var row uintptr
		arr, rows := children(list)
		for _, exact := range []bool{true, false} {
			for _, r := range rows {
				if rowMatches(r, needle, exact) {
					row = CFRetain(r)
					break
				}
			}
			if row != 0 {
				break
			}
		}
		if arr != 0 {
			CFRelease(arr)
		}
		CFRelease(list)
		if row == 0 {
			continue
		}
		rf, ok := elFrame(row)
		if !ok || !rowVisible(rf, lf) { // 离屏（虚拟化行高≈0 或滚出视口）：让列表自己滚过去
			act := cfString("AXScrollToVisible")
			axPerformAction(row, act)
			CFRelease(act)
			for range 6 {
				time.Sleep(250 * time.Millisecond)
				if rf, ok = elFrame(row); ok && rowVisible(rf, lf) {
					break
				}
			}
		}
		CFRelease(row)
		if ok && rowVisible(rf, lf) {
			return rf, LocateRow
		}
		return Rect{}, LocateNotInList
	}
	return Rect{}, outcome
}
