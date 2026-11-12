package main

import (
	"slices"

	"github.com/egoist/mygo/ui"
)

// sortDrag 是一列竖排条目的拖动排序状态（同 Tauri dnd-kit verticalListSortingStrategy）：
// 拿起的条目由 mygo 的拖动副本跟着指针走；原条目移到落点、淡化成占位；
// 两者之间的条目平移让出空位；松手即落进空位。
// 指针落在哪一项按各项「未平移的布局框」判断（同 dnd-kit 用初始矩形），让位动画不反过来改判定，不抖动。
type sortDrag struct {
	active, over string
	h            map[string]float32 // 各项上一帧的布局高度
}

// begin：拖动源这一帧报告正在拖 id。
func (s *sortDrag) begin(id string) {
	if s.active != id {
		s.active, s.over = id, id
	}
}

// track 记录 id 的布局高度；py 是指针相对该项布局框的纵坐标（PointerPosition），落在框内即为当前落点。
func (s *sortDrag) track(id string, h, py float32, pointerOK bool) {
	if s.h == nil {
		s.h = map[string]float32{}
	}
	s.h[id] = h
	if s.active != "" && pointerOK && py >= 0 && py < h {
		s.over = id
	}
}

// offset：ids 为当前显示顺序、gap 为项间距，返回 id 应平移的纵向距离。
func (s *sortDrag) offset(ids []string, id string, gap float32) float32 {
	if s.active == "" || s.over == s.active {
		return 0
	}
	i, j, k := slices.Index(ids, s.active), slices.Index(ids, s.over), slices.Index(ids, id)
	if i < 0 || j < 0 || k < 0 {
		return 0
	}
	span := func(from, to int) (sum float32) { // [from, to] 各项高度 + 间距
		for x := from; x <= to; x++ {
			sum += s.h[ids[x]] + gap
		}
		return
	}
	switch {
	case k == i && j > i:
		return span(i+1, j)
	case k == i:
		return -span(j, i-1)
	case i < k && k <= j:
		return -(s.h[s.active] + gap)
	case j <= k && k < i:
		return s.h[s.active] + gap
	}
	return 0
}

// end 结束拖动，返回 (拿起的项, 落点项)；没移动时 over 为空。
func (s *sortDrag) end() (active, over string) {
	active, over = s.active, s.over
	s.active, s.over = "", ""
	if over == active {
		over = ""
	}
	return
}

// sortTrack：在未平移的槽位元素上调用，记录高度与指针落点（只在拖动中读指针，免得平时每次移动鼠标都重建）。
func sortTrack(st *sortDrag, slot ui.Element, id string) {
	py, ok := float32(0), false
	if st.active != "" {
		_, py, ok = slot.PointerPosition()
	}
	st.track(id, slot.Bounds().H, py, ok)
}

// sortShift：把条目平移到让位后的位置（dnd-kit 默认 transform 250ms ease）；落下那一帧直接归零（顺序已换，不再从旧位置滑回）。
func sortShift(st *sortDrag, inner ui.Element, ids []string, id string, gap float32, jump bool) {
	var v float32
	if jump {
		v = inner.Jump("sort", 0)
	} else {
		v = inner.AnimateTo("sort", st.offset(ids, id, gap), tw(250, easeCSS))
	}
	if v != 0 {
		inner.Translate(0, v)
	}
	if st.active == id { // 落点占位：淡化（拿起的那份由拖动副本跟着指针）
		inner.Opacity(0.4)
	}
}

// sortListBegin：在列表容器上、建子项之前调用。容器接收 T 的放下（子项不接收 T，放下总落到容器上），
// 松手即按 st 记下的落点提交；jump 让本帧各项平移直接归零。
func sortListBegin[T any](st *sortDrag, list ui.Element, jump, seen *bool, commit func(from, to string)) {
	*jump, *seen = false, false
	if _, ok := ui.Drop[T](list); ok {
		if from, to := st.end(); to != "" {
			commit(from, to)
			*jump = true
		}
	}
}

// sortListEnd：建完子项后调用；拖动源这一帧没在拖（Esc 取消 / 拖出容器松手）就结束，各项滑回原位。
func sortListEnd(st *sortDrag, seen bool) {
	if st.active != "" && !seen {
		st.end()
	}
}

// sortAutoScroll：拖动排序时指针靠近滚动区上下缘（48pt 内）自动滚动，越靠边越快（最快每帧 16pt），长列表一次拖到底。
func sortAutoScroll(c *ui.Context, sc ui.Element, state *ui.ScrollState) {
	const edge, maxStep = 48, 16
	_, py, _ := sc.PointerPosition()
	h := sc.Bounds().H
	if h <= 0 {
		return
	}
	var step float32
	switch {
	case py < edge:
		step = -maxStep * min(1, (edge-py)/edge)
	case py > h-edge:
		step = maxStep * min(1, (py-(h-edge))/edge)
	}
	if step == 0 {
		return
	}
	next := min(max(state.Y+step, 0), state.MaxY)
	if next != state.Y {
		state.Y = next
		c.Invalidate() // 指针不动也要继续滚
	}
}

// slotMark：落点虚线框（拿起项的淡化占位上，标出松手后落在哪）。
func slotMark(c *ui.Context) {
	p := stok(c).primary
	ui.Box(c).Absolute().Top(-2).Left(-2).Right(-2).Bottom(0).Radius(rr(10)).Border(1, p).BorderStyle(ui.BorderDashed).
		Background(p.Alpha(0.08)).PassThrough().Key("slotmark")
}

// liftHead：拿起时的区头样式（拖动副本照着画：卡片底 + elevation-2 浮起阴影）。
func liftHead(c *ui.Context, e ui.Element) {
	e.Background(tok(c).card).Shadow(0, 6, 16, -4, gray(0, 0.18))
}
