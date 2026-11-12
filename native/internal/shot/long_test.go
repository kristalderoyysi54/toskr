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
