//go:build darwin

package macos

import (
	"errors"
	"fmt"
	"math"
	"os"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// 长截屏连续取帧走 ScreenCaptureKit（对应 Rust 版 screenshot_sck.rs 的 RegionStream）：
// SCStream 以最高 60 帧/秒把选区推到回调队列，取帧方只拿最新一帧；整体排除本应用窗口
// （选区边框与预览面板）。逐帧 CGWindowListCreateImage 在 macOS 15 上每帧可达 1s。
//
// 异步接口的 completion handler 用 purego objc.NewBlock：堆上 block（__NSMallocBlock__），
// 引用计数归零时 dispose 回调才把 Go 闭包从缓存删掉。调用方传入后立即 Release，
// 系统若要异步回调会自行 Block_copy 持有，超时后迟到的回调仍然安全（只往带缓冲的 channel 非阻塞写）。
// 回调都在系统的 dispatch 线程上执行，Go 侧只做加锁拷贝与 channel 通知。

const sckTimeout = 3 * time.Second

var (
	sckOnce   sync.Once
	sckErr    error
	sckSinkCl objc.Class
	sckSinks  sync.Map // 帧接收对象（objc.ID）→ *sckFrames

	kCGColorSpaceSRGB uintptr

	cmSampleBufferGetImageBuffer func(sb uintptr) uintptr
	cvPixelBufferLockBaseAddress func(pb uintptr, flags uint64) int32
	cvPixelBufferUnlockBase      func(pb uintptr, flags uint64) int32
	cvPixelBufferGetWidth        func(pb uintptr) uintptr
	cvPixelBufferGetHeight       func(pb uintptr) uintptr
	cvPixelBufferGetBytesPerRow  func(pb uintptr) uintptr
	cvPixelBufferGetBaseAddress  func(pb uintptr) unsafe.Pointer
	dispatchQueueCreate          func(label string, attr uintptr) uintptr
	dispatchRelease              func(obj uintptr)
)

// cmTime 即 CMTime（value/timescale/flags/epoch，24 字节）。
type cmTime struct {
	Value     int64
	Timescale int32
	Flags     uint32
	Epoch     int64
}

func loadSCK() error {
	sckOnce.Do(func() {
		load()
		loadScreen()
		libs := map[string]uintptr{}
		for _, p := range []string{
			"/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit",
			"/System/Library/Frameworks/CoreMedia.framework/CoreMedia",
			"/System/Library/Frameworks/CoreVideo.framework/CoreVideo",
			"/usr/lib/libSystem.B.dylib",
		} {
			h, err := purego.Dlopen(p, purego.RTLD_NOW|purego.RTLD_GLOBAL)
			if err != nil {
				sckErr = err
				return
			}
			libs[p] = h
		}
		// 与 Tauri 一致只在 macOS 14+ 启用：取像素比用的 SCContentFilter.pointPixelScale 是 14 才有的
		if objc.GetClass("SCScreenshotManager") == 0 || objc.GetClass("SCStream") == 0 {
			sckErr = errors.New("ScreenCaptureKit 需要 macOS 14+")
			return
		}
		cm := libs["/System/Library/Frameworks/CoreMedia.framework/CoreMedia"]
		cv := libs["/System/Library/Frameworks/CoreVideo.framework/CoreVideo"]
		sys := libs["/usr/lib/libSystem.B.dylib"]
		purego.RegisterLibFunc(&cmSampleBufferGetImageBuffer, cm, "CMSampleBufferGetImageBuffer")
		purego.RegisterLibFunc(&cvPixelBufferLockBaseAddress, cv, "CVPixelBufferLockBaseAddress")
		purego.RegisterLibFunc(&cvPixelBufferUnlockBase, cv, "CVPixelBufferUnlockBaseAddress")
		purego.RegisterLibFunc(&cvPixelBufferGetWidth, cv, "CVPixelBufferGetWidth")
		purego.RegisterLibFunc(&cvPixelBufferGetHeight, cv, "CVPixelBufferGetHeight")
		purego.RegisterLibFunc(&cvPixelBufferGetBytesPerRow, cv, "CVPixelBufferGetBytesPerRow")
		purego.RegisterLibFunc(&cvPixelBufferGetBaseAddress, cv, "CVPixelBufferGetBaseAddress")
		purego.RegisterLibFunc(&dispatchQueueCreate, sys, "dispatch_queue_create")
		purego.RegisterLibFunc(&dispatchRelease, sys, "dispatch_release")
		kCGColorSpaceSRGB = deref(cg, "kCGColorSpaceSRGB")

		var protos []*objc.Protocol
		if p := objc.GetProtocol("SCStreamOutput"); p != nil {
			protos = append(protos, p)
		}
		sckSinkCl, sckErr = objc.RegisterClass("ToskrLongShotFrameSink", objc.GetClass("NSObject"), protos, nil, []objc.MethodDef{
			{Cmd: sel("stream:didOutputSampleBuffer:ofType:"), Fn: sckDidOutput},
		})
	})
	return sckErr
}

// sckFrames：回调线程写入、取帧方取走的最新一帧（BGRA 紧排）。
type sckFrames struct {
	mu     sync.Mutex
	bgra   []byte
	w, h   int
	seq    uint64
	notify chan struct{} // 容量 1：有新帧
}

// sckDidOutput 是 SCStreamOutput 的 stream:didOutputSampleBuffer:ofType:，在帧队列线程上调用。
func sckDidOutput(self objc.ID, _ objc.SEL, _ objc.ID, sample objc.ID, kind int) {
	const screen = 0 // SCStreamOutputTypeScreen
	v, ok := sckSinks.Load(self)
	if !ok || kind != screen {
		return
	}
	// 画面没变时系统发的「空闲」样本不带像素
	pb := cmSampleBufferGetImageBuffer(uintptr(sample))
	if pb == 0 || cvPixelBufferLockBaseAddress(pb, 1) != 0 { // 1 = kCVPixelBufferLock_ReadOnly
		return
	}
	defer cvPixelBufferUnlockBase(pb, 1)
	w, h, stride := int(cvPixelBufferGetWidth(pb)), int(cvPixelBufferGetHeight(pb)), int(cvPixelBufferGetBytesPerRow(pb))
	base := cvPixelBufferGetBaseAddress(pb)
	if base == nil || w == 0 || h == 0 || stride < w*4 {
		return
	}
	src := unsafe.Slice((*byte)(base), stride*(h-1)+w*4)
	f := v.(*sckFrames)
	f.mu.Lock()
	if len(f.bgra) != w*h*4 {
		f.bgra = make([]byte, w*h*4)
	}
	for y := range h {
		copy(f.bgra[y*w*4:(y+1)*w*4], src[y*stride:y*stride+w*4])
	}
	f.w, f.h = w, h
	f.seq++
	f.mu.Unlock()
	select {
	case f.notify <- struct{}{}:
	default:
	}
}

// RegionStream 是长截屏用的 SCStream：只截全局 pt 矩形，排除本应用所有窗口。
type RegionStream struct {
	stream, sink, filter, config objc.ID
	queue                        uintptr
	frames                       *sckFrames
	seen                         uint64
	last                         []byte
	lw, lh                       int
}

// StartRegionStream 开始连续截取全局 pt 矩形（需屏幕录制权限与 macOS 14+）。失败时调用方回退逐帧截屏。
func StartRegionStream(x, y, w, h float64) (*RegionStream, error) {
	if err := loadSCK(); err != nil {
		return nil, err
	}
	// autorelease pool 绑定线程：整段设置期间不让 goroutine 换线程
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var s *RegionStream
	var err error
	withPool(func() { s, err = startRegionStream(x, y, w, h) })
	return s, err
}

func startRegionStream(x, y, w, h float64) (*RegionStream, error) {
	content, err := sckShareableContent()
	if err != nil {
		return nil, err
	}
	defer content.Send(sel("release"))

	// 选区中心所在的屏（SCDisplay.frame 为全局 pt，原点主屏左上）
	cx, cy := x+w/2, y+h/2
	var display objc.ID
	var df cgRect
	displays := content.Send(sel("displays"))
	for i, n := 0, objc.Send[int](displays, sel("count")); i < n; i++ {
		d := displays.Send(sel("objectAtIndex:"), i)
		f := objc.Send[cgRect](d, sel("frame"))
		if cx >= f.X && cx < f.X+f.W && cy >= f.Y && cy < f.Y+f.H {
			display, df = d, f
			break
		}
	}
	if display == 0 {
		return nil, fmt.Errorf("选区 (%.0f,%.0f) 不在可共享的屏上", cx, cy)
	}

	// 选区边框与预览面板是本应用窗口，整体排除（同 Tauri；效果同原先只截边框窗之下）
	own := class("NSMutableArray").Send(sel("alloc")).Send(sel("init"))
	defer own.Send(sel("release"))
	me := int32(os.Getpid())
	apps := content.Send(sel("applications"))
	for i, n := 0, objc.Send[int](apps, sel("count")); i < n; i++ {
		a := apps.Send(sel("objectAtIndex:"), i)
		if objc.Send[int32](a, sel("processID")) == me {
			own.Send(sel("addObject:"), a)
		}
	}
	filter := class("SCContentFilter").Send(sel("alloc")).Send(sel("initWithDisplay:excludingApplications:exceptingWindows:"),
		display, own, class("NSArray").Send(sel("array")))
	if filter == 0 {
		return nil, errors.New("SCContentFilter 创建失败")
	}
	s := &RegionStream{filter: filter, frames: &sckFrames{notify: make(chan struct{}, 1)}}
	ok := false
	defer func() {
		if !ok {
			s.release()
		}
	}()

	scale := float64(objc.Send[float32](filter, sel("pointPixelScale")))
	if scale <= 0 {
		scale = 1
	}
	pw, ph := int(math.Round(w*scale)), int(math.Round(h*scale))
	if pw <= 0 || ph <= 0 {
		return nil, fmt.Errorf("选区过小 %.1f×%.1f", w, h)
	}
	const bgra = 0x42475241 // kCVPixelFormatType_32BGRA（'BGRA'）
	s.config = class("SCStreamConfiguration").Send(sel("alloc")).Send(sel("init"))
	s.config.Send(sel("setWidth:"), uint(pw))
	s.config.Send(sel("setHeight:"), uint(ph))
	s.config.Send(sel("setShowsCursor:"), false)
	s.config.Send(sel("setPixelFormat:"), uint32(bgra))
	s.config.Send(sel("setColorSpaceName:"), kCGColorSpaceSRGB)            // 转到 sRGB，与 CGWindowListCreateImage 取到的一致
	s.config.Send(sel("setSourceRect:"), cgRect{x - df.X, y - df.Y, w, h}) // 屏内 pt
	s.config.Send(sel("setMinimumFrameInterval:"), cmTime{Value: 1, Timescale: 60, Flags: 1})

	s.stream = class("SCStream").Send(sel("alloc")).Send(sel("initWithFilter:configuration:delegate:"), filter, s.config, objc.ID(0))
	if s.stream == 0 {
		return nil, errors.New("SCStream 创建失败")
	}
	s.sink = objc.ID(sckSinkCl).Send(sel("alloc")).Send(sel("init"))
	sckSinks.Store(s.sink, s.frames)
	s.queue = dispatchQueueCreate("com.toskr.longshot", 0)
	var nsErr objc.ID
	if !objc.Send[bool](s.stream, sel("addStreamOutput:type:sampleHandlerQueue:error:"), s.sink, 0, s.queue, &nsErr) {
		return nil, fmt.Errorf("addStreamOutput 失败：%s", nsErrorText(nsErr))
	}
	if err := sckWaitErr(s.stream, "startCaptureWithCompletionHandler:"); err != nil {
		return nil, fmt.Errorf("SCStream 启动失败：%w", err)
	}
	ok = true
	return s, nil
}

// Next 等下一帧（最多 wait；首帧最多 3s），返回 RGBA（不透明）与像素尺寸；画面静止没有新帧时返回上一帧。
func (s *RegionStream) Next(wait time.Duration) ([]byte, int, int, error) {
	if s.last == nil {
		wait = sckTimeout
	}
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	f := s.frames
	for {
		f.mu.Lock()
		if f.seq != s.seen {
			pix := make([]byte, len(f.bgra))
			for i := 0; i < len(pix); i += 4 {
				pix[i], pix[i+1], pix[i+2], pix[i+3] = f.bgra[i+2], f.bgra[i+1], f.bgra[i], 255
			}
			s.seen, s.last, s.lw, s.lh = f.seq, pix, f.w, f.h
			f.mu.Unlock()
			return pix, s.lw, s.lh, nil
		}
		f.mu.Unlock()
		select {
		case <-f.notify:
		case <-deadline.C:
			if s.last == nil {
				return nil, 0, 0, errors.New("SCStream 无帧")
			}
			return s.last, s.lw, s.lh, nil
		}
	}
}

// Close 停止取帧并释放对象（等停止回调最多 3s）。
func (s *RegionStream) Close() {
	if s == nil || s.stream == 0 {
		return
	}
	_ = sckWaitErr(s.stream, "stopCaptureWithCompletionHandler:")
	s.release()
}

func (s *RegionStream) release() {
	if s.sink != 0 {
		sckSinks.Delete(s.sink) // 迟到的帧回调找不到接收方就直接返回
	}
	for _, o := range []objc.ID{s.stream, s.sink, s.config, s.filter} {
		if o != 0 {
			o.Send(sel("release"))
		}
	}
	if s.queue != 0 {
		dispatchRelease(s.queue)
	}
	*s = RegionStream{}
}

// sckShareableContent：屏上可共享内容（已 retain，调用方 release）。无屏幕录制权限时报错。
func sckShareableContent() (objc.ID, error) {
	type result struct{ content, err objc.ID }
	ch := make(chan result, 1)
	block := objc.NewBlock(func(_ objc.Block, content, nsErr objc.ID) {
		if content != 0 {
			content.Send(sel("retain"))
		}
		select {
		case ch <- result{content, nsErr}:
		default:
		}
	})
	defer block.Release()
	class("SCShareableContent").Send(sel("getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler:"), false, true, block)
	select {
	case r := <-ch:
		if r.content == 0 {
			return 0, fmt.Errorf("取可共享内容失败：%s", nsErrorText(r.err))
		}
		return r.content, nil
	case <-time.After(sckTimeout):
		return 0, errors.New("取可共享内容超时")
	}
}

// sckWaitErr 调用以 void (^)(NSError *) 为唯一参数的异步方法并等回调（最多 3s）。
func sckWaitErr(target objc.ID, selector string) error {
	ch := make(chan string, 1)
	block := objc.NewBlock(func(_ objc.Block, nsErr objc.ID) {
		msg := ""
		if nsErr != 0 {
			msg = nsErrorText(nsErr)
		}
		select {
		case ch <- msg:
		default:
		}
	})
	defer block.Release()
	target.Send(sel(selector), block)
	select {
	case msg := <-ch:
		if msg != "" {
			return errors.New(msg)
		}
		return nil
	case <-time.After(sckTimeout):
		return errors.New("超时")
	}
}

func nsErrorText(e objc.ID) string {
	if e == 0 {
		return "未知错误"
	}
	return fmt.Sprintf("%s (%d)", goString(uintptr(e.Send(sel("localizedDescription")))), objc.Send[int](e, sel("code")))
}
