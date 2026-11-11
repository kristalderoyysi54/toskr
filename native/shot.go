package main

import (
	"bytes"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/shot"
	"github.com/toskr/native/internal/store"
)

// 截图编辑器（移植 Tauri ScreenshotView + screenshot.rs）：每块屏一扇遮罩窗，盖住冻结帧；
// 选区、标注、出图都在本进程内完成。遮罩窗是 Panel：拿键盘但不激活本应用，结束后原应用仍在前台。

type shotSession struct {
	displays   []*shotDisplay
	wasVisible bool          // 截图前面板开着：取消 / 存入后再打开
	hiddenPins []*pinWin     // 「截图时隐藏 Toskr」时暂时藏起的钉图，结束后放回
	front      string        // 截图时前台应用名（入库来源）
	frontID    string        // 前台应用 bundle id
	done       chan struct{} // 结束时关闭：停掉光标轮询
	hint       string        // 遮罩关掉后才弹的气泡（遮罩层级高于气泡，期间弹了也看不见）
}

type shotDisplay struct {
	X, Y     float64 // 本屏左上角（全局 pt）
	W, H     float64 // 本屏大小（pt）
	pxW, pxH int     // 冻结帧像素
	sx, sy   float64 // 像素 / pt
	img      *image.RGBA
	bm       *ui.Bitmap
	windows  []shot.Rect // 屏上窗口（本屏 pt，自顶向下）：悬停吸附
	win      *mygo.Window
	ed       shotEditor
}

// screenshot：托盘「截图」与全局快捷键入口。
func (a *app) screenshot() {
	if a.shot != nil || a.store.Settings().ScreenshotOff {
		return
	}
	if !macos.ScreenCaptureAllowed() {
		macos.RequestScreenCapture()
		diag.Push("截图: 缺少屏幕录制权限")
		a.showHUD("warn", tr("需要「屏幕录制」权限：系统设置 → 隐私与安全性 → 屏幕录制，勾选后重试"))
		return
	}
	s := &shotSession{done: make(chan struct{})}
	if f, ok := a.sys.Frontmost(); ok && f.PID != a.sys.SelfPID() {
		s.front, s.frontID = f.Name, f.BundleID
	}
	// 默认截到的就是屏幕上看到的样子（同 Tauri screenshotHideSelf=false）；开了「截图时隐藏 Toskr」才先藏面板与钉图
	hideSelf := a.store.Settings().ShotHideSelf
	s.wasVisible = a.panel != nil && a.panel.IsVisible()
	if s.wasVisible && hideSelf {
		a.hidePanelNow()
	}
	if hideSelf {
		for _, p := range a.pins {
			if p.win != nil && p.win.IsVisible() {
				p.win.Hide()
				s.hiddenPins = append(s.hiddenPins, p)
			}
		}
	}
	if a.hud != nil {
		a.hud.Hide()
	}
	a.shot = s
	displays := mygo.Screen.Displays()
	go func() {
		if hideSelf && (s.wasVisible || len(s.hiddenPins) > 0) {
			time.Sleep(80 * time.Millisecond) // 等面板 / 钉图真正离屏，免得拍进冻结帧
		}
		start := time.Now()
		frames := make([]*image.RGBA, len(displays))
		var wg sync.WaitGroup
		for i, d := range displays {
			wg.Add(1)
			go func() {
				defer wg.Done()
				img, err := captureRect(d.Bounds)
				if err != nil {
					diag.Push("截图: 第 %d 屏取帧失败 %v", i, err)
				}
				frames[i] = img
			}()
		}
		wg.Wait()
		wins := macos.WindowRects(a.sys.SelfPID(), !hideSelf)
		diag.Push("截图: 取帧 %d 屏 %dms 窗口 %d", len(displays), time.Since(start).Milliseconds(), len(wins))
		a.panel.Update(func() { a.openShot(s, displays, frames, wins) })
	}()
}

// captureRect：screencapture -R 按全局 pt 截一块屏（免去显示器序号映射），得到原生像素。
func captureRect(r mygo.Rectangle) (*image.RGBA, error) {
	f, err := os.CreateTemp("", "toskr-shot-*.png")
	if err != nil {
		return nil, err
	}
	path := f.Name()
	f.Close()
	defer os.Remove(path)
	arg := fmt.Sprintf("-R%d,%d,%d,%d", r.X, r.Y, r.Width, r.Height)
	if out, err := exec.Command("/usr/sbin/screencapture", "-x", "-t", "png", arg, path).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("%v %s", err, out)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	src, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	if rgba, ok := src.(*image.RGBA); ok && rgba.Rect.Min == (image.Point{}) {
		return rgba, nil
	}
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Rect, src, b.Min, draw.Src)
	return dst, nil
}

// openShot 建遮罩窗：光标所在屏先显示并拿键盘。
func (a *app) openShot(s *shotSession, displays []mygo.Display, frames []*image.RGBA, wins []macos.WinRect) {
	if a.shot != s {
		return
	}
	cur := mygo.Screen.CursorScreenPoint()
	var first *shotDisplay
	for i, d := range displays {
		img := frames[i]
		if img == nil {
			continue
		}
		b := d.Bounds
		sd := &shotDisplay{X: float64(b.X), Y: float64(b.Y), W: float64(b.Width), H: float64(b.Height), img: img,
			pxW: img.Rect.Dx(), pxH: img.Rect.Dy()}
		sd.sx, sd.sy = float64(sd.pxW)/sd.W, float64(sd.pxH)/sd.H
		sd.bm = ui.NewBitmap(img).Pixelated()
		for _, w := range wins {
			r := shot.Rect{X: w.X - sd.X, Y: w.Y - sd.Y, W: w.W, H: w.H}
			if r.X < sd.W && r.Y < sd.H && r.X+r.W > 0 && r.Y+r.H > 0 {
				sd.windows = append(sd.windows, r)
			}
		}
		sd.ed.reset()
		if cur.X >= b.X && cur.X < b.X+b.Width && cur.Y >= b.Y && cur.Y < b.Y+b.Height {
			sd.ed.cursor = &shot.Point{X: float64(cur.X - b.X), Y: float64(cur.Y - b.Y)}
			first = sd
		}
		s.displays = append(s.displays, sd)
	}
	if len(s.displays) == 0 {
		a.shot = nil
		a.showHUD("warn", tr("截图失败，详情见诊断日志"))
		return
	}
	if first == nil {
		first = s.displays[0]
	}
	setShotCursor(true)
	for _, sd := range s.displays {
		sd.win = mygo.NewWindow(mygo.WindowOptions{
			Title: "Toskr 截图", Panel: true, Hidden: true, Frameless: true, DisableResize: true, DisableShadow: true,
			X: int(sd.X), Y: int(sd.Y), Width: int(sd.W), Height: int(sd.H), BackgroundColor: "#000000",
			Content: ui.View(func(c *ui.Context) { a.shotView(c, sd) }),
		})
		sd.win.SetBounds(mygo.Rectangle{X: int(sd.X), Y: int(sd.Y), Width: int(sd.W), Height: int(sd.H)})
		macos.MakeOverlay(sd.win.NativeHandle())
	}
	for _, sd := range s.displays {
		if sd != first {
			sd.win.ShowInactive()
		}
	}
	first.win.Show()
	first.win.Focus()
	for _, sd := range s.displays { // 显示之后再钉一次 frame：系统在显示时会把窗口推到菜单栏下方（冻结画面整体下移）
		before, after := macos.PinOverlayFrame(sd.win.NativeHandle(), sd.X, sd.Y, sd.W, sd.H)
		if before != after {
			diag.Push("截图: 遮罩 frame 被系统挪动 %.0f,%.0f %.0f×%.0f → 复位 %.0f,%.0f", before[0], before[1], before[2], before[3], after[0], after[1])
		}
	}
	time.AfterFunc(300*time.Millisecond, func() { // 系统的上屏约束发生在显示之后的下一轮：再核一次（实测旧版此时下移 38 / 25pt）
		a.panel.Update(func() {
			if a.shot != s {
				return
			}
			for _, sd := range s.displays {
				if before, after := macos.PinOverlayFrame(sd.win.NativeHandle(), sd.X, sd.Y, sd.W, sd.H); before != after {
					diag.Push("截图: 遮罩显示后被挪动 %.0f,%.0f → 复位 %.0f,%.0f", before[0], before[1], after[0], after[1])
				}
			}
		})
	})
	diag.Push("截图: 遮罩 %d 屏", len(s.displays))
	go a.pollShotCursor(s)
}

// pollShotCursor：遮罩未拿到真实指针事件前（及跨屏时）跟随系统光标，拖拽中以指针事件为准。
func (a *app) pollShotCursor(s *shotSession) {
	t := time.NewTicker(16 * time.Millisecond)
	defer t.Stop()
	for tick := 0; ; tick++ {
		select {
		case <-s.done:
			return
		case <-t.C:
		}
		p := mygo.Screen.CursorScreenPoint()
		a.panel.Update(func() {
			if a.shot != s {
				return
			}
			if tick%5 == 0 && s.typing() { // 约 80ms 一次（同 Tauri set_typing 轮询）
				a.raiseIMEWindows()
			}
			for _, d := range s.displays {
				in := float64(p.X) >= d.X && float64(p.X) < d.X+d.W && float64(p.Y) >= d.Y && float64(p.Y) < d.Y+d.H
				e := &d.ed
				if e.drag != nil || e.draft != nil || e.edrag != nil {
					continue
				}
				switch {
				case !in && e.cursor != nil:
					e.cursor = nil
					d.win.Invalidate()
				case in && !e.gotPointer:
					q := shot.Point{X: float64(p.X) - d.X, Y: float64(p.Y) - d.Y}
					if e.cursor == nil || *e.cursor != q {
						e.cursor = &q
						d.win.Invalidate()
					}
				case in && e.cursor == nil:
					q := shot.Point{X: float64(p.X) - d.X, Y: float64(p.Y) - d.Y}
					e.cursor = &q
					d.win.Invalidate()
				}
				// 键盘跟着光标走：还没有屏选出选区时，光标进哪块屏哪块接键（取色 C、Esc）
				if in && !d.win.IsFocused() && !a.shotHasSelection() {
					d.win.Focus()
				}
			}
		})
	}
}

// typing：遮罩里有文字 / 批注说明输入框（输入法候选窗要提到遮罩之上）。
func (s *shotSession) typing() bool {
	for _, d := range s.displays {
		if d.ed.editing != nil || d.ed.note != nil {
			return true
		}
	}
	return false
}

// raiseIMEWindows：把本进程里不属于 mygo 的可见窗口（输入法候选窗）提到遮罩之上。
func (a *app) raiseIMEWindows() {
	ours := map[uintptr]bool{}
	for _, w := range mygo.Windows() {
		ours[w.NativeHandle()] = true
	}
	for _, r := range macos.RaiseIMEWindows(ours) {
		diag.Push("截图输入 提升候选窗 %s", r)
	}
}

func (a *app) shotHasSelection() bool {
	if a.shot == nil {
		return false
	}
	for _, d := range a.shot.displays {
		if d.ed.sel != nil {
			return true
		}
	}
	return false
}

// endShot 关掉全部遮罩；reopen 为 true 时恢复截图前开着的面板。
func (a *app) endShot(reopen bool) {
	s := a.shot
	if s == nil {
		return
	}
	a.shot = nil
	setShotCursor(false)
	close(s.done)
	for _, d := range s.displays {
		if d.win != nil {
			d.win.Destroy()
		}
		d.bm, d.img = nil, nil
	}
	if reopen && s.wasVisible && a.panel != nil {
		a.panel.Show()
	}
	for _, p := range s.hiddenPins {
		if p.win != nil {
			p.win.ShowInactive()
		}
	}
	if s.hint != "" {
		a.showHUD("info", s.hint)
	}
}

// ---- 出图后的动作（对应 screenshot.rs commit / save / save_as / copy_color / save_text）----

type shotAction string

const (
	shotSave    shotAction = "save"    // 复制并存入「剪贴」
	shotSection shotAction = "section" // 复制并存入指定笔记分组
	shotSend    shotAction = "send"    // 存入「剪贴」后发送到当前目标
	shotEdit    shotAction = "edit"    // 存入「剪贴」后打开图片编辑器
	shotPin     shotAction = "pin"     // 钉在屏幕上（不入库）
	shotSaveAs  shotAction = "saveas"  // 另存为 PNG
)

// commitShot：出图（已含标注与圆角阴影）后结束会话并执行动作。place 为出图左上角的全局 pt（钉图用）。
func (a *app) commitShot(d *shotDisplay, act shotAction, out *image.RGBA, place shot.Point, section, caption string) {
	s := a.shot
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, out); err != nil {
		a.endShot(true)
		a.showHUD("warn", tr("截图保存失败：")+err.Error())
		return
	}
	raw := buf.Bytes()
	w, h := out.Rect.Dx(), out.Rect.Dy()
	front, frontID := s.front, s.frontID
	a.endShot(act == shotSave || act == shotSection)
	diag.Push("截图: 出图 %d×%d %s", w, h, act)
	switch act {
	case shotPin:
		a.pinShot(out, d.X+place.X, d.Y+place.Y, float64(w)/d.sx, float64(h)/d.sy)
		return
	case shotSaveAs:
		go a.saveShotAs(raw)
		return
	}
	a.storeShot(raw, w, h, act, section, caption, front, frontID)
}

// storeShot：图片入库（剪贴或指定分组）后按动作复制 / 发送 / 打开。
func (a *app) storeShot(raw []byte, w, h int, act shotAction, section, caption, front, frontID string) {
	name, err := a.store.SaveImage(raw)
	if err != nil {
		a.showHUD("warn", tr("截图保存失败：")+err.Error())
		return
	}
	if caption == "" {
		caption = fmt.Sprintf(tr("图片 %d×%d"), w, h)
	}
	sec := store.SectionClipboard
	if act == shotSection && section != "" {
		sec = section
	}
	n, _, err := a.store.Add(store.Note{Section: sec, Kind: "image", ImageFile: name, ImageW: w, ImageH: h, Text: caption,
		SourceApp: front, BundleID: frontID})
	if err != nil {
		a.showHUD("warn", err.Error())
		return
	}
	switch act {
	case shotSend:
		a.send([]store.Note{n})
	case shotEdit:
		a.openRedactor(n)
	case shotSection:
		a.sys.Write([]macos.Item{{macos.TypePNG: raw}}, false)
		a.showHUD("ok", fmt.Sprintf(tr("截图已复制，存入「%s」"), a.sectionName(sec)))
	default:
		a.sys.Write([]macos.Item{{macos.TypePNG: raw}}, false)
		a.showHUD("ok", tr("截图已复制，存入「剪贴」"))
	}
}

func (a *app) sectionName(id string) string {
	for _, s := range a.store.Sections() {
		if s.ID == id {
			return sectionName(s)
		}
	}
	return id
}

// saveShotAs：系统保存面板，默认桌面、「Toskr 截图 2026-10-31 14.05.03.png」。
func (a *app) saveShotAs(raw []byte) {
	home, _ := os.UserHomeDir()
	name := time.Now().Format(tr("Toskr 截图") + " 2006-01-02 15.04.05.png")
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{DefaultPath: filepath.Join(home, "Desktop", name),
		CreateDirectories: true, Filters: []mygo.FileFilter{{Name: "PNG", Extensions: []string{"png"}}}})
	if err != nil || path == "" {
		return
	}
	err = os.WriteFile(path, raw, 0o644)
	a.panel.Update(func() {
		if err != nil {
			diag.Push("截图另存为失败：%v", err)
			a.showHUD("warn", tr("保存失败，详情见诊断日志"))
			return
		}
		a.showHUD("ok", fmt.Sprintf(tr("已保存「%s」"), filepath.Base(path)))
	})
}

// copyShotColor：取色写剪贴板并存入「剪贴」，遮罩不关。
func (a *app) copyShotColor(v string) {
	a.sys.Write([]macos.Item{{macos.TypeString: []byte(v)}}, false)
	s := a.shot
	_, _, _ = a.store.Add(store.Note{Section: store.SectionClipboard, Text: v, SourceApp: s.front, BundleID: s.frontID})
	diag.Push("截图取色存入剪贴 %s", v)
}

// copyShotText：识别结果只复制（不入库），结束截图并用气泡回报字数。
func (a *app) copyShotText(text string) {
	a.endShot(true)
	a.sys.Write([]macos.Item{{macos.TypeString: []byte(text)}}, false)
	a.showHUD("ok", fmt.Sprintf(tr("已复制 %d 字"), utf8.RuneCountInString(text)))
}

// saveShotText：识别结果复制并存入「剪贴」，结束截图。
func (a *app) saveShotText(text string) {
	s := a.shot
	a.endShot(true)
	a.sys.Write([]macos.Item{{macos.TypeString: []byte(text)}}, false)
	_, _, _ = a.store.Add(store.Note{Section: store.SectionClipboard, Text: text, SourceApp: s.front, BundleID: s.frontID})
	a.showHUD("ok", tr("文字已复制，存入「剪贴」"))
}
