//go:build darwin

package macos

import (
	"math"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// 不需要权限的部分：结构体传参（CGRect / CMTime）往返、帧接收对象拷贝真实 CMSampleBuffer、
// block 在 GCD 工作线程上回调 Go。
func TestSCKPlumbing(t *testing.T) {
	if err := loadSCK(); err != nil {
		t.Skipf("ScreenCaptureKit 不可用：%v", err)
	}
	withPool(func() {
		cfg := class("SCStreamConfiguration").Send(sel("alloc")).Send(sel("init"))
		defer cfg.Send(sel("release"))
		cfg.Send(sel("setSourceRect:"), cgRect{1.5, 2, 300, 200})
		if r := objc.Send[cgRect](cfg, sel("sourceRect")); r != (cgRect{1.5, 2, 300, 200}) {
			t.Errorf("sourceRect 往返 = %+v", r)
		}
		cfg.Send(sel("setMinimumFrameInterval:"), cmTime{Value: 1, Timescale: 60, Flags: 1})
		if m := objc.Send[cmTime](cfg, sel("minimumFrameInterval")); m.Value != 1 || m.Timescale != 60 {
			t.Errorf("minimumFrameInterval 往返 = %+v", m)
		}
	})

	// 2×1 BGRA 像素缓冲包成 CMSampleBuffer 交给帧接收对象
	var (
		cvCreate   func(alloc, w, h uintptr, format uint32, attrs uintptr, out *uintptr) int32
		cmFmt      func(alloc, pb uintptr, out *uintptr) int32
		cmSample   func(alloc, pb, fmtDesc uintptr, timing *[3]cmTime, out *uintptr) int32
		cm, _      = purego.Dlopen("/System/Library/Frameworks/CoreMedia.framework/CoreMedia", purego.RTLD_NOW)
		cv, _      = purego.Dlopen("/System/Library/Frameworks/CoreVideo.framework/CoreVideo", purego.RTLD_NOW)
		pb, fd, sb uintptr
	)
	purego.RegisterLibFunc(&cvCreate, cv, "CVPixelBufferCreate")
	purego.RegisterLibFunc(&cmFmt, cm, "CMVideoFormatDescriptionCreateForImageBuffer")
	purego.RegisterLibFunc(&cmSample, cm, "CMSampleBufferCreateReadyWithImageBuffer")
	if cvCreate(0, 2, 1, 0x42475241, 0, &pb) != 0 {
		t.Fatal("CVPixelBufferCreate 失败")
	}
	defer CFRelease(pb)
	cvPixelBufferLockBaseAddress(pb, 0)
	copy(unsafe.Slice((*byte)(cvPixelBufferGetBaseAddress(pb)), 8), []byte{1, 2, 3, 0, 4, 5, 6, 0})
	cvPixelBufferUnlockBase(pb, 0)
	if cmFmt(0, pb, &fd) != 0 {
		t.Fatal("CMVideoFormatDescriptionCreateForImageBuffer 失败")
	}
	defer CFRelease(fd)
	timing := [3]cmTime{{Value: 1, Timescale: 60, Flags: 1}, {Value: 0, Timescale: 60, Flags: 1}, {}}
	if cmSample(0, pb, fd, &timing, &sb) != 0 {
		t.Fatal("CMSampleBufferCreateReadyWithImageBuffer 失败")
	}
	defer CFRelease(sb)

	sink := objc.ID(sckSinkCl).Send(sel("alloc")).Send(sel("init"))
	defer sink.Send(sel("release"))
	s := &RegionStream{frames: &sckFrames{notify: make(chan struct{}, 1)}}
	sckSinks.Store(sink, s.frames)
	defer sckSinks.Delete(sink)
	out := sel("stream:didOutputSampleBuffer:ofType:")
	sink.Send(out, objc.ID(0), objc.ID(sb), 1) // 非画面类型：忽略
	if s.frames.seq != 0 {
		t.Fatal("音频类型样本不应产生帧")
	}
	sink.Send(out, objc.ID(0), objc.ID(sb), 0)
	pix, w, h, err := s.Next(time.Second)
	if err != nil || w != 2 || h != 1 || string(pix) != string([]byte{3, 2, 1, 255, 6, 5, 4, 255}) {
		t.Fatalf("帧 = %v %d×%d %v", pix, w, h, err)
	}

	// block 在 GCD 并发线程上回调 Go（SCK 的 completion handler 与帧回调都在系统线程上）
	var n atomic.Int32
	block := objc.NewBlock(func(_ objc.Block, _ objc.ID, _ uint, _ *bool) { n.Add(1) })
	defer block.Release()
	withPool(func() {
		arr := class("NSMutableArray").Send(sel("array"))
		for range 64 {
			arr.Send(sel("addObject:"), class("NSNull").Send(sel("null")))
		}
		arr.Send(sel("enumerateObjectsWithOptions:usingBlock:"), uint(1), block) // NSEnumerationConcurrent
	})
	if n.Load() != 64 {
		t.Fatalf("block 回调 %d 次，应为 64", n.Load())
	}
}

// 需屏幕录制授权（授权给跑测试的终端）；没有授权时跳过。
func TestRegionStreamCapturesRect(t *testing.T) {
	if !ScreenCaptureAllowed() {
		t.Skip("无屏幕录制权限，跳过 ScreenCaptureKit 取帧测试")
	}
	if err := loadSCK(); err != nil {
		t.Skipf("ScreenCaptureKit 不可用：%v", err)
	}
	const x, y, w, h = 100.0, 100.0, 300.0, 200.0
	t0 := time.Now()
	s, err := StartRegionStream(x, y, w, h)
	if err != nil {
		t.Fatalf("StartRegionStream: %v", err)
	}
	defer s.Close()
	t.Logf("启动 %v", time.Since(t0))

	var pw, ph int
	for i := range 5 {
		t1 := time.Now()
		pix, fw, fh, err := s.Next(100 * time.Millisecond)
		d := time.Since(t1)
		if err != nil {
			t.Fatalf("第 %d 帧：%v", i, err)
		}
		t.Logf("第 %d 帧 %d×%d %v", i, fw, fh, d)
		if len(pix) != fw*fh*4 {
			t.Fatalf("像素长度 %d ≠ %d×%d×4", len(pix), fw, fh)
		}
		if i == 0 {
			pw, ph = fw, fh
			scale := float64(fw) / w
			if scale < 1 || math.Abs(float64(fh)-h*scale) > 1 {
				t.Fatalf("尺寸 %d×%d 与选区 %.0f×%.0f 不成比例", fw, fh, w, h)
			}
		} else {
			if fw != pw || fh != ph {
				t.Fatalf("帧尺寸变化 %d×%d → %d×%d", pw, ph, fw, fh)
			}
			// 有新帧立即返回，静止时最多等 100ms 交回上一帧
			if d > 150*time.Millisecond {
				t.Fatalf("取帧 %v 超过 150ms", d)
			}
		}
		if pix[3] != 255 {
			t.Fatalf("alpha = %d，应为不透明", pix[3])
		}
	}
}
