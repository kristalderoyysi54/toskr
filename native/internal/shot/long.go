package shot

import "time"

// 长截屏拼接（移植自 screenshot_long.rs）：定时截取选区，按相邻两帧重叠的像素行拼接，
// 可往回滚、不重复追加；固定页头只参与对位排除，固定页尾始终只留一份在最底部。

const (
	LongMaxPixels  = 50_000_000 // 长图像素上限（约 200MB RGBA），超出即停
	minMatchRatio  = 0.6        // 有效重叠：非空白行里至少这么多比例对得上
	minOverlapRows = 12
	minVotes       = 3 // 至少这么多「帧内唯一」的行对上，才算找到重叠
	LongIdleLimit  = 120 * time.Second
	LongPreviewW   = 400 // 预览图宽度（像素），最近邻缩小、只追加新行
	LongPanelW     = 220.0
	LongPanelMinH  = 320.0
	LongPanelGap   = 12.0
	LongFramePad   = 4.0 // 边框窗比选区每边大出的 pt（画在选区外，不会被截进去）
	LongMinCrop    = 16.0
	longFNVOffset  = 0xcbf29ce484222325
	longFNVPrime   = 0x100000001b3
)

// RowSig：每行的哈希与是否纯色（纯色行在任何偏移下都能对上，不参与判定）。
type RowSig struct {
	Hash  uint64
	Blank bool
}

func RowSignatures(rgba []byte, w, h int) []RowSig {
	out := make([]RowSig, h)
	for y := range h {
		row := rgba[y*w*4 : (y+1)*w*4]
		hash := uint64(longFNVOffset)
		blank := true
		for i, b := range row {
			hash ^= uint64(b)
			hash *= longFNVPrime
			if blank && b != row[i%4] {
				blank = false
			}
		}
		out[y] = RowSig{hash, blank}
	}
	return out
}

// uniqueRows：帧内独一无二的非空白行：哈希 → 行号（重复出现的记 -1）。
func uniqueRows(rows []RowSig) map[uint64]int {
	seen := make(map[uint64]int, len(rows))
	for i, r := range rows {
		if r.Blank {
			continue
		}
		if _, ok := seen[r.Hash]; ok {
			seen[r.Hash] = -1
		} else {
			seen[r.Hash] = i
		}
	}
	return seen
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// ScrollOffset：新帧相对上一帧的位移：上一帧第 r+dy 行 == 新帧第 r 行。正 = 往下滚，负 = 往回滚，
// 0 = 没滚（画面原地变化）。只让两帧内都独一无二的行投票，得票最多的偏移再按整段重叠复核；
// 没有可信重叠返回 false。
func ScrollOffset(prev, next []RowSig) (int, bool) {
	h := min(len(prev), len(next))
	prev, next = prev[:h], next[:h]
	at := uniqueRows(prev)
	votes := map[int]int{}
	for hash, r := range uniqueRows(next) {
		if p, ok := at[hash]; ok && r >= 0 && p >= 0 {
			votes[p-r]++
		}
	}
	best, n := 0, 0
	for dy, c := range votes {
		if c > n || (c == n && absInt(dy) < absInt(best)) {
			best, n = dy, c
		}
	}
	if n < minVotes {
		return 0, false
	}
	considered, matched := 0, 0
	for r := range h {
		p := r + best
		if p < 0 || p >= h {
			continue
		}
		if prev[p].Blank && next[r].Blank {
			continue
		}
		considered++
		if prev[p].Hash == next[r].Hash {
			matched++
		}
	}
	return best, float64(matched) >= minMatchRatio*float64(considered)
}

// fixedRows：相邻两帧在原位不变的顶部 / 底部行数（固定页头、固定页尾）。
func fixedRows(prev, next []RowSig) (top, bottom int) {
	h := min(len(prev), len(next))
	for top < h && prev[top].Hash == next[top].Hash {
		top++
	}
	for r := h - 1; r >= top && prev[r].Hash == next[r].Hash; r-- {
		bottom++
	}
	return
}

type Push int

const (
	Appended  Push = iota
	Same           // 与上一帧完全相同（到底了）
	NoOverlap      // 接不上（滚太快）
	Moved          // 往回滚，或往下滚但还没越过已拼部分：只更新位置
)

// Stitcher 逐帧拼接。
type Stitcher struct {
	W, H   int
	Out    []byte
	TotalH int
	prev   []RowSig
	tail   int // 长图末尾有多少行是上一帧底部的原样像素（摘页尾不能超过它）
	behind int // 当前帧内容底边比已拼长图底边高出的行数（往回滚产生）
	// 诊断：相邻两帧最大位移；接不上的帧之间能互相对齐的次数
	MaxStep                int
	lost                   []RowSig
	LostPairs, LostAligned int
}

func NewStitcher(first []byte, w, h int) *Stitcher {
	return &Stitcher{W: w, H: h, Out: first, TotalH: h, prev: RowSignatures(first, w, h), tail: h}
}

func sigEqual(a, b []RowSig) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (s *Stitcher) Push(frame []byte) Push {
	w, h := s.W, s.H
	sig := RowSignatures(frame, w, h)
	if sigEqual(sig, s.prev) {
		return Same
	}
	top, bottom := fixedRows(s.prev, sig)
	if top+bottom+2*minOverlapRows >= h {
		top, bottom = 0, 0
	}
	bottom = min(bottom, s.tail)
	dy, ok := ScrollOffset(s.prev[top:h-bottom], sig[top:h-bottom])
	if !ok {
		if s.lost != nil {
			s.LostPairs++
			if d, ok := ScrollOffset(s.lost, sig); ok && d != 0 {
				s.LostAligned++
			}
		}
		s.lost = sig
		return NoOverlap
	}
	s.lost = nil
	s.MaxStep = max(s.MaxStep, absInt(dy))
	if dy <= 0 {
		s.behind += -dy
		s.moved(sig, bottom)
		return Moved
	}
	if dy <= s.behind {
		s.behind -= dy
		s.moved(sig, bottom)
		return Moved
	}
	n := dy - s.behind
	s.behind = 0
	// 摘掉旧页尾 → 接上新帧页尾之上的 n 行新内容 + 新页尾
	s.Out = append(s.Out[:len(s.Out)-bottom*w*4], frame[(h-bottom-n)*w*4:]...)
	s.TotalH += n
	s.tail = n + bottom
	s.prev = sig
	return Appended
}

func (s *Stitcher) moved(sig []RowSig, bottom int) {
	s.tail = min(s.tail, bottom)
	s.prev = sig
}

// Stop 是长截屏的结束原因。
type Stop int

const (
	StopNone Stop = iota
	StopFinished
	StopCancelled
	StopIdle
	StopLimit
)

// LongStats：逐帧统计（诊断用：区分「滚太快」与「内容对不上」）。
type LongStats struct {
	Frames, Misses, LongestMissRun int
	CaptureMs                      int64
}

// Follow 定时截帧，画面变了就拼；对不上的帧丢弃（等用户往回滚到能接上）。
// stop 返回面板按钮的请求；stitched 每次追加后回调，stalled 在接不上 / 恢复时回调。
func Follow(st *Stitcher, capture func() ([]byte, int, int, error), stop func() Stop, stitched func(), stalled func(bool), now func() time.Time) (Stop, LongStats, error) {
	if now == nil {
		now = time.Now
	}
	lastChange := now()
	var stats LongStats
	isStalled, missRun := false, 0
	for {
		if r := stop(); r != StopNone {
			return r, stats, nil
		}
		if now().Sub(lastChange) > LongIdleLimit {
			return StopIdle, stats, nil
		}
		started := time.Now()
		frame, fw, fh, err := capture()
		stats.CaptureMs += time.Since(started).Milliseconds()
		if err != nil {
			return StopNone, stats, err
		}
		if fw != st.W || fh != st.H {
			return StopNone, stats, errFrameSize
		}
		res := st.Push(frame)
		stats.Frames++
		if res == NoOverlap {
			stats.Misses++
			missRun++
			stats.LongestMissRun = max(stats.LongestMissRun, missRun)
		} else {
			missRun = 0
		}
		if res != Same {
			lastChange = now()
		}
		if (res == NoOverlap) != isStalled {
			isStalled = !isStalled
			if stalled != nil {
				stalled(isStalled)
			}
		}
		if res == Appended {
			if stitched != nil {
				stitched()
			}
			if st.W*st.TotalH >= LongMaxPixels {
				return StopLimit, stats, nil
			}
		}
	}
}

type longErr string

func (e longErr) Error() string { return string(e) }

const errFrameSize = longErr("frame size changed")

// LongPanelRect：预览面板放选区右侧，放不下放左侧，都放不下贴屏幕右缘；纵向与选区顶对齐并收进屏内。
func LongPanelRect(display, region Rect) Rect {
	h := min(max(region.H, LongPanelMinH), display.H-2*LongPanelGap)
	right := region.X + region.W + LongPanelGap
	left := region.X - LongPanelGap - LongPanelW
	x := display.X + display.W - LongPanelW - LongPanelGap
	if right+LongPanelW <= display.X+display.W-LongPanelGap {
		x = right
	} else if left >= display.X+LongPanelGap {
		x = left
	}
	y := clamp(region.Y, display.Y+LongPanelGap, display.Y+display.H-h-LongPanelGap)
	return Rect{x, y, LongPanelW, h}
}

// LongPreview：按 LongPreviewW 最近邻缩小的预览，只追加尚未采样的行（预览第 k 行取源第 ⌊k·f⌋ 行）。
type LongPreview struct {
	RGBA []byte
	Rows int
}

func (p *LongPreview) Extend(src []byte, srcW, srcH int) {
	f := float64(srcW) / LongPreviewW
	for {
		sy := int(float64(p.Rows) * f)
		if sy >= srcH {
			return
		}
		row := src[sy*srcW*4 : (sy+1)*srcW*4]
		for k := range LongPreviewW {
			sx := min(int(float64(k)*f), srcW-1) * 4
			p.RGBA = append(p.RGBA, row[sx:sx+4]...)
		}
		p.Rows++
	}
}
