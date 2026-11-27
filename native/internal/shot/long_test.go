package shot

import (
	"bytes"
	"slices"
	"testing"
)

// 对应 screenshot_long.rs 的 12 个用例。

// page：宽 2 的"页面"：第 i 行像素值由 i 决定，纯色行模拟空白。
func page(rows []byte) []byte {
	var out []byte
	for _, v := range rows {
		out = append(out, v, v*7, 1, 255, v+3, v, 2, 255)
	}
	return out
}

func content(n int) []byte {
	c := make([]byte, n)
	for i := range c {
		c[i] = byte(i * 13 % 251)
	}
	return c
}

func window(c []byte, top, h int) []RowSig { return RowSignatures(page(c[top:top+h]), 2, h) }

func firstBytes(v []byte) []byte {
	var out []byte
	for i := 0; i < len(v); i += 8 {
		out = append(out, v[i])
	}
	return out
}

func TestFindsScrollDistance(t *testing.T) {
	c := content(200)
	if dy, ok := ScrollOffset(window(c, 0, 60), window(c, 25, 60)); !ok || dy != 25 {
		t.Fatal(dy, ok)
	}
}

func TestNoOverlapWhenJumpTooFar(t *testing.T) {
	c := content(200)
	if _, ok := ScrollOffset(window(c, 0, 40), window(c, 100, 40)); ok {
		t.Fatal("跳太远应无重叠")
	}
}

func TestBlankRowsDoNotFakeAMatch(t *testing.T) {
	blank := bytes.Repeat([]byte{9, 9, 9, 255}, 2)
	rows := RowSignatures(bytes.Repeat(blank, 50), 2, 50)
	if _, ok := ScrollOffset(rows, rows); ok {
		t.Fatal("纯色行不算重叠")
	}
}

func TestStickyHeaderAndFooterKeptOnce(t *testing.T) {
	c := make([]byte, 120)
	for i := range c {
		c[i] = byte(100 + i)
	}
	header := []byte{1, 2, 3, 4, 5, 6, 7, 8}
	footer := []byte{30, 31, 32, 33, 34, 35, 36, 37, 38, 39}
	bodyH := 60 - len(header) - len(footer)
	frame := func(top int) []byte {
		return page(slices.Concat(header, c[top:top+bodyH], footer))
	}
	st := NewStitcher(frame(0), 2, 60)
	for _, top := range []int{20, 40, 60} {
		if r := st.Push(frame(top)); r != Appended {
			t.Fatal(top, r)
		}
	}
	if st.Push(frame(60)) != Same {
		t.Fatal("同帧")
	}
	want := page(slices.Concat(header, c[:60+bodyH], footer))
	if st.TotalH != 120 || !bytes.Equal(firstBytes(st.Out), firstBytes(want)) {
		t.Fatal("页头页尾不重复、内容连续", st.TotalH)
	}
}

func TestManualModeSkipsUnalignedFramesUntilFinished(t *testing.T) {
	c := content(200)
	st := NewStitcher(page(c[:60]), 2, 60)
	tops := []int{0, 20, 120, 40}
	n := 0
	req := StopNone
	capture := func() ([]byte, int, int, error) {
		top := tops[min(n, len(tops)-1)]
		n++
		if n == len(tops) {
			req = StopFinished
		}
		return page(c[top : top+60]), 2, 60, nil
	}
	var stalls []bool
	stop, stats, err := Follow(st, capture, func() Stop { r := req; req = StopNone; return r }, nil, func(v bool) { stalls = append(stalls, v) }, nil)
	if err != nil || stop != StopFinished {
		t.Fatal(stop, err)
	}
	if stats.Frames != 4 || stats.Misses != 1 || stats.LongestMissRun != 1 {
		t.Fatalf("%+v", stats)
	}
	if st.MaxStep != 20 || !slices.Equal(stalls, []bool{true, false}) || !bytes.Equal(st.Out, page(c[:100])) {
		t.Fatal(st.MaxStep, stalls)
	}
}

func TestManualScrollBackDoesNotDuplicate(t *testing.T) {
	c := content(200)
	frame := func(top int) []byte { return page(c[top : top+60]) }
	st := NewStitcher(frame(0), 2, 60)
	for _, s := range []struct {
		top  int
		want Push
	}{{30, Appended}, {10, Moved}, {25, Moved}, {50, Appended}} {
		if r := st.Push(frame(s.top)); r != s.want {
			t.Fatal(s.top, r)
		}
	}
	if !bytes.Equal(st.Out, page(c[:110])) {
		t.Fatal("往回滚不重复")
	}
}

func TestFastScrollOnSparsePageNeitherDuplicatesNorSkips(t *testing.T) {
	const H = 60
	c := make([]byte, 600)
	for i := range c {
		if i%10 < 4 {
			c[i] = byte(1 + i*7%250)
		}
	}
	frame := func(top int) []byte {
		px := page(c[top : top+H])
		thumb := top * (H - 6) / (len(c) - H)
		for r := thumb; r < thumb+6; r++ {
			px[r*8+4] ^= 0x80
		}
		return px
	}
	for _, s := range [][2]int{{1, 10}, {5, 20}, {10, 30}, {20, 28}, {30, 18}} {
		minStep, span := s[0], s[1]
		seed := uint32(7)
		top := 0
		st := NewStitcher(frame(0), 2, H)
		for top+minStep+span+H <= len(c) {
			seed = seed*1103515245 + 12345
			top += minStep + int(seed>>16)%span
			st.Push(frame(top))
		}
		if rows := firstBytes(st.Out); !bytes.Equal(rows, c[:st.TotalH]) {
			t.Fatalf("步长 %d+%d 不连续", minStep, span)
		}
		if st.TotalH <= len(c)/2 {
			t.Fatalf("步长 %d+%d 只拼到 %d", minStep, span, st.TotalH)
		}
	}
}

func TestLostFramesThatStillAlignAreCounted(t *testing.T) {
	c := content(200)
	frame := func(top int) []byte { return page(c[top : top+60]) }
	st := NewStitcher(frame(0), 2, 60)
	for _, top := range []int{100, 110, 125} {
		if st.Push(frame(top)) != NoOverlap {
			t.Fatal(top)
		}
	}
	if st.LostPairs != 2 || st.LostAligned != 2 {
		t.Fatal(st.LostPairs, st.LostAligned)
	}
	if st.Push(frame(30)) != Appended || st.Push(frame(140)) != NoOverlap || st.LostPairs != 2 {
		t.Fatal("接上后清空，再丢失重新计")
	}
}

func TestCancelRequestStopsWithCancelled(t *testing.T) {
	c := content(200)
	st := NewStitcher(page(c[:60]), 2, 60)
	req := StopNone
	capture := func() ([]byte, int, int, error) { req = StopCancelled; return page(c[:60]), 2, 60, nil }
	if stop, _, _ := Follow(st, capture, func() Stop { return req }, nil, nil, nil); stop != StopCancelled {
		t.Fatal(stop)
	}
}

func TestPanelSitsBesideRegionInsideDisplay(t *testing.T) {
	d := Rect{0, 0, 1440, 900}
	if r := LongPanelRect(d, Rect{100, 100, 600, 500}); r.X != 712 || r.Y != 100 || r.H != 500 {
		t.Fatal(r)
	}
	if r := LongPanelRect(d, Rect{900, 100, 500, 200}); r.X != 900-12-220 || r.H != 320 {
		t.Fatal(r)
	}
	if r := LongPanelRect(d, Rect{0, 800, 1440, 100}); r.X != 1440-220-12 || r.Y+r.H > 900-12 {
		t.Fatal(r)
	}
}

func TestPlainPageStitchesContiguously(t *testing.T) {
	c := content(200)
	st := NewStitcher(page(c[:60]), 2, 60)
	if st.Push(page(c[30:90])) != Appended || st.Push(page(c[55:115])) != Appended || !bytes.Equal(st.Out, page(c[:115])) {
		t.Fatal("连续拼接")
	}
}

func TestPreviewDownsamplesAppendedRowsOnly(t *testing.T) {
	var p LongPreview
	sw := LongPreviewW * 2
	src := make([]byte, 0, sw*10*4)
	for i := range sw * 10 {
		src = append(src, byte(i/sw), 0, 0, 255)
	}
	p.Extend(src[:sw*4*4], sw, 4) // 前 4 行 → 预览 2 行
	if p.Rows != 2 || len(p.RGBA) != 2*LongPreviewW*4 {
		t.Fatal(p.Rows)
	}
	p.Extend(src, sw, 10)
	if p.Rows != 5 || p.RGBA[LongPreviewW*4*3] != 6 {
		t.Fatal("只追加新行、第 k 行取源 2k 行", p.Rows)
	}
}

// syntheticDoc 生成类似真实网页/列表的宽幅 RGBA 画布（白底 + 错落文字块 + 彩色标签），用于模拟真实滚动。
func syntheticDoc(w, h int) []byte {
	pix := make([]byte, w*h*4)
	for i := 0; i < len(pix); i += 4 {
		pix[i], pix[i+1], pix[i+2], pix[i+3] = 248, 248, 250, 255
	}
	seed := uint32(0x1234567)
	next := func() uint32 {
		seed = seed*1664525 + 1013904223
		return seed
	}
	for y := 12; y < h-12; y += 22 {
		// 模拟不同长度与缩进的文字行、偶尔插入卡片色块
		indent := 20 + int(next()%80)
		span := 120 + int(next()%uint32(max(40, w-indent-60)))
		cr := uint8(30 + next()%90)
		cg := uint8(30 + next()%90)
		cb := uint8(30 + next()%110)
		for dy := range 10 {
			yy := y + dy
			if yy >= h {
				break
			}
			for x := indent; x < min(w-30, indent+span); x++ {
				// 模拟字形笔画间隙
				if ((x+dy*3+y)^int(cr))%5 < 2 {
					continue
				}
				o := (yy*w + x) * 4
				pix[o], pix[o+1], pix[o+2] = cr, cg, cb
			}
		}
	}
	return pix
}

// sampleSubpixel 从 doc 在小数位置 yPos 采样一帧（线性插值模拟 1×/缩放屏亚像素滚动），
// 叠加右侧移动/淡变的 overlay 滚动条与 ±2 抖动噪声。
func sampleSubpixel(doc []byte, w, docH, h int, yPos float64, frameIdx int) []byte {
	out := make([]byte, w*h*4)
	y0 := int(yPos)
	frac := yPos - float64(y0)
	for r := range h {
		s0 := min(max(y0+r, 0), docH-1)
		s1 := min(s0+1, docH-1)
		for x := range w {
			o := (r*w + x) * 4
			i0 := (s0*w + x) * 4
			i1 := (s1*w + x) * 4
			noise := (x + r + frameIdx) % 3 // 0..2 轻微色彩抖动
			for c := range 3 {
				v := float64(doc[i0+c])*(1-frac) + float64(doc[i1+c])*frac
				iv := int(v) + noise - 1
				out[o+c] = uint8(min(255, max(0, iv)))
			}
			out[o+3] = 255
		}
		// 模拟 macOS 右侧 14px 宽的 overlay 滚动条（滑块随滚动移动且透明度每帧淡变）
		thumbTop := int(yPos * float64(h-60) / float64(max(1, docH-h)))
		inThumb := r >= thumbTop && r < thumbTop+60
		alpha := 0.25 + 0.05*float64(frameIdx%8)
		for x := max(0, w-16); x < w-2; x++ {
			o := (r*w + x) * 4
			if inThumb {
				for c := range 3 {
					out[o+c] = uint8(float64(out[o+c])*(1-alpha) + 60*alpha)
				}
			} else {
				// 轨道淡入淡出
				for c := range 3 {
					out[o+c] = uint8(max(0, int(out[o+c])-frameIdx%4))
				}
			}
		}
	}
	return out
}

// 回归真实诊断日志（480×481 / 776×561 接不上 0/121）：
// 亚像素平滑滚动 + 右侧滚动条 + 色彩抖动下必须稳定连续拼接，不能全帧 NoOverlap。
func TestSubpixelSmoothScrollWithScrollbarStitches(t *testing.T) {
	const W, H, DocH = 480, 481, 2000
	doc := syntheticDoc(W, DocH)
	first := sampleSubpixel(doc, W, DocH, H, 0, 0)
	st := NewStitcher(first, W, H)

	misses := 0
	y := 0.0
	for i := 1; i <= 80; i++ {
		y += 14.3 // 小数步长模拟触控板平滑滚动
		if y+H >= DocH {
			break
		}
		res := st.Push(sampleSubpixel(doc, W, DocH, H, y, i))
		if res == NoOverlap {
			misses++
		}
	}
	st.Flush()
	wantH := H + int(y)
	if misses > 0 {
		t.Fatalf("亚像素滚动 + 滚动条不应出现接不上，实有 %d 次（总高 %d，期望约 %d）", misses, st.TotalH, wantH)
	}
	if absInt(st.TotalH-wantH) > 8 {
		t.Fatalf("拼接总高误差过大：实得 %d，期望约 %d（误差限 8px）", st.TotalH, wantH)
	}
}

// 吸顶栏首行有动态微变（使 fixedRows 在第 0 行截断）时，静态栏不能靠 dy=0 抢票导致整帧 NoOverlap。
func TestNoisyStickyHeaderDoesNotStealZeroOffsetVote(t *testing.T) {
	const W, H, DocH = 640, 420, 1400
	const headerH = 72
	doc := syntheticDoc(W, DocH)
	render := func(top, tick int) []byte {
		f := make([]byte, W*H*4)
		// 吸顶栏：深灰底 + 居中标题横条；首行每帧微变 20 模拟顶部进度条 / 时钟
		for y := range headerH {
			for x := range W {
				o := (y*W + x) * 4
				r, g, b := uint8(36), uint8(38), uint8(44)
				if y == 0 && x < 120 {
					r = uint8(80 + (tick*17)%120)
				} else if y >= 24 && y < 44 && x >= 40 && x < 360 && (x+y)%3 != 0 {
					r, g, b = 220, 224, 232
				}
				f[o], f[o+1], f[o+2], f[o+3] = r, g, b, 255
			}
		}
		// 中间滚动内容
		bodyH := H - headerH
		copy(f[headerH*W*4:], doc[top*W*4:(top+bodyH)*W*4])
		return f
	}
	st := NewStitcher(render(0, 0), W, H)
	for i := 1; i <= 10; i++ {
		if r := st.Push(render(i*60, i)); r != Appended {
			t.Fatalf("第 %d 步应正常拼接，实为 %v", i, r)
		}
	}
	if st.TotalH != H+600 {
		t.Fatalf("总高 %d，期望 %d", st.TotalH, H+600)
	}
}

// 白底上两段完全不重叠的稀疏短文字行不能误对齐（防假阳性）。
func TestDisjointSparseTextDoesNotFalseMatch(t *testing.T) {
	const W, H = 600, 400
	makeFrame := func(seed uint32) []byte {
		pix := make([]byte, W*H*4)
		for i := 0; i < len(pix); i += 4 {
			pix[i], pix[i+1], pix[i+2], pix[i+3] = 255, 255, 255, 255
		}
		for y := 20; y < H-20; y += 28 {
			seed = seed*1664525 + 1013904223
			x0 := 24 + int(seed%260)
			for dy := range 8 {
				for x := x0; x < x0+70; x++ {
					if (x+dy)%2 == 0 {
						o := ((y+dy)*W + x) * 4
						pix[o], pix[o+1], pix[o+2] = 20, 20, 20
					}
				}
			}
		}
		return pix
	}
	a := RowSignatures(makeFrame(11), W, H)
	b := RowSignatures(makeFrame(99991), W, H)
	if dy, ok := ScrollOffset(a, b); ok {
		t.Fatalf("完全不重叠的稀疏页面不应误对齐：dy=%d", dy)
	}
}

// 画面未滚动但有局部光标闪烁 / 小卡片悬停变化：应视为 dy=0（Moved），不报错也不重复追加。
func TestInPlaceHoverOrCaretBlinkDoesNotStall(t *testing.T) {
	const W, H = 600, 400
	base := syntheticDoc(W, H)
	st := NewStitcher(base, W, H)
	changed := slices.Clone(base)
	// 中间 2px×16px 闪烁光标
	for y := 180; y < 196; y++ {
		for x := 200; x < 202; x++ {
			o := (y*W + x) * 4
			changed[o], changed[o+1], changed[o+2] = 0, 122, 255
		}
	}
	if r := st.Push(changed); r != Moved || st.TotalH != H {
		t.Fatalf("原地闪烁光标应为 Moved 且不增高，实为 %v totalH=%d", r, st.TotalH)
	}
}

// 60fps 微小步长（每帧 5px）平滑滚动后停住或点击完成：小步长暂存不丢且暂停后立即落盘。
func TestMicroStepsAccumulateAndFlushOnPause(t *testing.T) {
	const W, H, DocH = 400, 300, 900
	doc := syntheticDoc(W, DocH)
	sliceFrame := func(top int) []byte { return doc[top*W*4 : (top+H)*W*4] }
	st := NewStitcher(sliceFrame(0), W, H)
	for top := 5; top <= 20; top += 5 {
		if r := st.Push(sliceFrame(top)); r != Moved {
			t.Fatalf("小步长 %d 应先暂存（Moved），实为 %v", top, r)
		}
	}
	// 画面停顿（收到同帧）：应立刻落盘暂存的 20px
	if r := st.Push(sliceFrame(20)); r != Appended || st.TotalH != H+20 {
		t.Fatalf("停滚时暂存应落盘：res=%v totalH=%d 期望 %d", r, st.TotalH, H+20)
	}
}
