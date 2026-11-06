package core

import (
	"testing"
	"time"

	"bytes"
	"github.com/toskr/native/internal/macos"
	"golang.org/x/image/tiff"
	"image"
	"image/png"
)

// fake 模拟剪贴板、前台应用与按键效果。
type fake struct {
	count      int
	items      []macos.Item
	front      macos.FrontApp
	sel        string
	selKind    macos.Selection
	copyResult string // ⌘C 后剪贴板变成的内容；空表示 ⌘C 无效
	activateOK bool
	pasted     []string
	activated  []int32
	userCopies func() // 在还原等待期间模拟用户复制
}

func (f *fake) Frontmost() (macos.FrontApp, bool)       { return f.front, f.front.PID != 0 }
func (f *fake) SelectedText() (macos.Selection, string) { return f.selKind, f.sel }
func (f *fake) ChangeCount() int                        { return f.count }
func (f *fake) Types() []string {
	var out []string
	for _, it := range f.items {
		for t := range it {
			out = append(out, t)
		}
	}
	return out
}
func (f *fake) ReadString() (string, string) {
	if len(f.items) == 0 {
		return "", ""
	}
	return string(f.items[0][macos.TypeString]), string(f.items[0][macos.TypeHTML])
}
func (f *fake) Snapshot() []macos.Item { return f.items }
func (f *fake) Write(items []macos.Item, transient bool) int {
	f.items = items
	f.count++
	return f.count
}
func (f *fake) PostKey(k uint16, flags uint64) {
	switch k {
	case macos.KeyC:
		if f.copyResult != "" {
			f.Write([]macos.Item{{macos.TypeString: []byte(f.copyResult)}}, false)
		}
	case macos.KeyV:
		text, _ := f.ReadString()
		f.pasted = append(f.pasted, text)
	}
}
func (f *fake) Activate(pid int32) bool {
	f.activated = append(f.activated, pid)
	if f.activateOK {
		f.front = macos.FrontApp{PID: pid}
	}
	return f.activateOK
}
func (f *fake) Sleep(d time.Duration) {
	if d == restoreDelay && f.userCopies != nil {
		f.userCopies()
	}
}
func (f *fake) SelfPID() int32 { return 1 }

func original() []macos.Item { return []macos.Item{{macos.TypeString: []byte("用户原剪贴板")}} }

func TestCaptureViaCopyRestoresOriginalClipboard(t *testing.T) {
	f := &fake{items: original(), count: 10, copyResult: "选中的文字\n\n", selKind: macos.SelEmpty}
	got, ok := Capture(f, macos.FrontApp{PID: 42})
	if !ok || got.Text != "选中的文字" {
		t.Fatalf("%+v %v", got, ok)
	}
	if text, _ := f.ReadString(); text != "用户原剪贴板" {
		t.Fatalf("捕获后必须还原原剪贴板，实为 %q", text)
	}
	if !isOwn(f.count) {
		t.Fatal("还原写入应标记为自身写入，监听不得当成新复制")
	}
}

func TestCaptureFallsBackToAXWhenCopyDoesNothing(t *testing.T) {
	f := &fake{items: original(), selKind: macos.SelText, sel: "AX 文本"}
	got, ok := Capture(f, macos.FrontApp{PID: 42})
	if !ok || got.Text != "AX 文本" {
		t.Fatalf("%+v", got)
	}
	if text, _ := f.ReadString(); text != "用户原剪贴板" {
		t.Fatal("⌘C 无效时剪贴板不应被改动")
	}
}

func TestCaptureNothingSelected(t *testing.T) {
	if _, ok := Capture(&fake{items: original(), selKind: macos.SelEmpty}, macos.FrontApp{PID: 42}); ok {
		t.Fatal("无选中内容应返回 false（交给面板开关）")
	}
}

func TestDeliverPastesAndRestores(t *testing.T) {
	f := &fake{items: original(), activateOK: true, front: macos.FrontApp{PID: 1}}
	if err := Deliver(f, macos.FrontApp{PID: 42}, "发送内容"); err != nil {
		t.Fatal(err)
	}
	WaitIdle()
	if len(f.pasted) != 1 || f.pasted[0] != "发送内容" {
		t.Fatalf("%v", f.pasted)
	}
	if text, _ := f.ReadString(); text != "用户原剪贴板" {
		t.Fatalf("1.5s 后应还原，实为 %q", text)
	}
}

func TestDeliverAbortsWhenTargetNotFront(t *testing.T) {
	f := &fake{items: original(), activateOK: false, front: macos.FrontApp{PID: 1}}
	if err := Deliver(f, macos.FrontApp{PID: 42}, "发送内容"); err != ErrTargetFocus {
		t.Fatalf("应中止，得到 %v", err)
	}
	WaitIdle()
	if len(f.pasted) != 0 {
		t.Fatal("目标未就绪不得粘贴")
	}
	if text, _ := f.ReadString(); text != "用户原剪贴板" {
		t.Fatal("中止时立即还原剪贴板")
	}
}

func TestDeliverDoesNotClobberUserCopyDuringRestoreWindow(t *testing.T) {
	f := &fake{items: original(), activateOK: true, front: macos.FrontApp{PID: 1}}
	f.userCopies = func() { f.Write([]macos.Item{{macos.TypeString: []byte("用户新复制")}}, false) }
	if err := Deliver(f, macos.FrontApp{PID: 42}, "x"); err != nil {
		t.Fatal(err)
	}
	WaitIdle()
	if text, _ := f.ReadString(); text != "用户新复制" {
		t.Fatalf("用户期间复制的内容不得被还原覆盖，实为 %q", text)
	}
}

func TestDeliverRejectsSelfAndEmpty(t *testing.T) {
	f := &fake{}
	if Deliver(f, macos.FrontApp{PID: 1}, "x") != ErrNoTarget || Deliver(f, macos.FrontApp{PID: 9}, " \n") != ErrEmpty {
		t.Fatal()
	}
}

func TestClipWatcherSkipsOwnTransientExcluded(t *testing.T) {
	f := &fake{items: original(), count: 5, front: macos.FrontApp{PID: 9, BundleID: "com.app"}}
	w := &ClipWatcher{Sys: f, Excluded: func() []string { return []string{"com.secret"} }}
	if _, ok := w.Tick(); ok {
		t.Fatal("首次 tick 只建立基线")
	}
	f.Write([]macos.Item{{macos.TypeString: []byte("外部复制")}}, false)
	if ev, ok := w.Tick(); !ok || ev.Text != "外部复制" || ev.Source.BundleID != "com.app" {
		t.Fatalf("%+v", ev)
	}
	markOwn(f.Write([]macos.Item{{macos.TypeString: []byte("自身")}}, true))
	if _, ok := w.Tick(); ok {
		t.Fatal("自身写入跳过")
	}
	f.Write([]macos.Item{{macos.TypeString: []byte("pw"), "org.nspasteboard.ConcealedType": nil}}, false)
	if _, ok := w.Tick(); ok {
		t.Fatal("密码类型跳过")
	}
	f.front.BundleID = "com.secret"
	f.Write([]macos.Item{{macos.TypeString: []byte("机密")}}, false)
	if _, ok := w.Tick(); ok {
		t.Fatal("排除名单应用跳过")
	}
}

func TestClipWatcherLinksAndImages(t *testing.T) {
	f := &fake{items: original(), count: 5, front: macos.FrontApp{PID: 9, BundleID: "com.app"}}
	w := &ClipWatcher{Sys: f}
	w.Tick()
	f.Write([]macos.Item{{macos.TypeString: []byte("  https://github.com/egoist/mygo  ")}}, false)
	if ev, ok := w.Tick(); !ok || !ev.Link {
		t.Fatalf("单个链接应识别为 link %+v", ev)
	}
	f.Write([]macos.Item{{macos.TypeString: []byte("见 https://a.b 文档")}}, false)
	if ev, _ := w.Tick(); ev.Link {
		t.Fatal("夹在句子里的链接不算链接卡")
	}
	img := image.NewRGBA(image.Rect(0, 0, 3, 2))
	var tb, pb bytes.Buffer
	_ = tiff.Encode(&tb, img, nil)
	_ = png.Encode(&pb, img)
	f.Write([]macos.Item{{TypeTIFF: tb.Bytes()}}, false)
	ev, ok := w.Tick()
	if !ok || ev.W != 3 || ev.H != 2 || !bytes.HasPrefix(ev.PNG, []byte("\x89PNG")) {
		t.Fatalf("TIFF 应转 PNG %v %d×%d", ok, ev.W, ev.H)
	}
	f.Write([]macos.Item{{macos.TypePNG: pb.Bytes(), TypeTIFF: tb.Bytes()}}, false)
	if ev, ok := w.Tick(); !ok || !bytes.Equal(ev.PNG, pb.Bytes()) {
		t.Fatal("有 PNG 时原样使用")
	}
	f.Write([]macos.Item{{TypeTIFF: []byte("坏数据")}}, false)
	if _, ok := w.Tick(); ok {
		t.Fatal("解不开的图片跳过")
	}
}
