package main

import (
	"strings"

	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// 拖进详情编辑器：面板卡片正文是原生拖出源（doneText 的 DragData），同时带 cardTextDrag——本进程内拖到详情窗能拿到
// 整张卡（含图片）；外部应用拖来的纯文字也收。落点按指针算到字：悬停时在落点画插入光标，松手插在那里；
// 落在当前选区内则替换选区。阅读态（不在编辑）拖进来按「添加到打开的卡片」处理。

type cardTextDrag struct{ ids []string }

var detailDropOpts = transfer.DropOptions{Formats: []transfer.Format{transfer.Text}}

// dropHover：一次拖入编辑器的悬停状态。orig 是拖进来时编辑器原有选区（落在它里面 = 替换它）；idx 为当前落点。
type dropHover struct {
	on    bool
	key   string // 哪个编辑器（纯文字卡 "-1" / 图文卡文字块下标）
	orig  [2]int
	idx   int
	moved bool // 真实光标已被挪到落点（离开时要还原 orig）
}

// detailDropIndex：编辑器内的点（相对编辑器盒）→ 文本 rune 偏移与该处光标矩形。与编辑器同字体同宽排版
// （已逐点核对与 TextArea 自身点击定位一致）。
func (a *app) detailDropIndex(src string, w, x, y float32) (int, ui.Rect) {
	lay := ui.ShapeText(src, ui.Font{Family: fontSans, Size: 13, Weight: 400, LineHeight: 21.125 / 13}, w)
	pos := lay.PositionAt(ui.Point{X: max(x, 0), Y: max(y, 0)})
	idx := min(max(pos.Index, 0), len([]rune(src)))
	return idx, lay.CaretAt(pos)
}

func inRange(r [2]int, i int) bool {
	lo, hi := min(r[0], r[1]), max(r[0], r[1])
	return lo >= 0 && lo < hi && i >= lo && i <= hi
}

// detailDropZone：给编辑器 ta（正文 src、block 为图文卡文字块下标，-1 = 纯文字卡）挂拖放。
// 悬停：编辑器的真实光标跟着指针走（同系统文本框拖放），落在原选区里则保留选区高亮（= 将替换它）；
// 另画一条 2pt 主色插入线——拖动时详情窗不是前台窗，系统光标不画，插入线保证看得见。松手插在光标显示处。
func (a *app) detailDropZone(ta ui.Element, n store.Note, src string, block int) (ui.Rect, bool) {
	key := itoa(block)
	local, gotLocal := ui.Drop[cardTextDrag](ta)
	data, gotData := ui.DropData(ta, detailDropOpts)
	_, over := ui.DataDragOver(ta, detailDropOpts)
	h := &a.dropHov
	box := ta.Bounds()
	if gotLocal || gotData {
		x, y, _ := ta.PointerPosition() // 松手那一刻的指针（数据拖放最后一次悬停即落点）
		idx, _ := a.detailDropIndex(src, box.W, x, y)
		if h.on && h.key == key {
			idx = h.idx // 与最后显示的光标同一处
		}
		orig := selPair(ta)
		if h.on && h.key == key {
			orig = h.orig
		}
		*h = dropHover{}
		var notes []store.Note
		if gotLocal {
			for _, id := range local.ids {
				if x, ok := a.store.Note(id); ok {
					notes = append(notes, x)
				}
			}
		} else if b, err := data.Data.Read(transfer.Text); err == nil && strings.TrimSpace(string(b)) != "" {
			notes = []store.Note{{ID: "drop", Text: string(b)}}
		}
		diag.Push("拖入详情: 落点=%d 原选区=%v 卡片=%d 本进程=%v", idx, orig, len(notes), gotLocal)
		a.dropIntoDraft(n, notes, idx, orig, block)
		return ui.Rect{}, false
	}
	if !over {
		if h.on && h.key == key { // 拖出编辑器没放下：真实选区还原
			if h.moved {
				ta.SetTextSelection(h.orig[0], h.orig[1])
			}
			*h = dropHover{}
		}
		return ui.Rect{}, false
	}
	x, y, _ := ta.PointerPosition()
	idx, caret := a.detailDropIndex(src, box.W, x, y)
	if !h.on || h.key != key {
		lo, hi := selPair(ta)[0], selPair(ta)[1]
		*h = dropHover{on: true, key: key, orig: [2]int{lo, hi}, idx: -1}
	}
	if inRange(h.orig, idx) { // 落在原选区里：保留选区（松手替换它），插入线不画
		if h.moved {
			ta.SetTextSelection(h.orig[0], h.orig[1])
			h.moved = false
		}
		h.idx = idx
		return ui.Rect{}, false
	}
	if idx != h.idx || !h.moved {
		ta.Focus().SetTextSelection(idx, idx)
		h.moved = true
	}
	h.idx = idx
	return caret, true
}

// dropIntoDraft：拖放落在编辑器 idx 处——落点在拖入前的选区 orig 里就替换它，否则插在落点（光标随后落在插入内容之后）。
func (a *app) dropIntoDraft(n store.Note, notes []store.Note, idx int, orig [2]int, block int) {
	incoming, imgs, sources := cardIncoming(notes, n.ID)
	if sources == 0 {
		a.showHUD("warn", tr("不能把卡片内容添加到自身"))
		return
	}
	if incoming == "" && len(imgs) == 0 {
		return
	}
	rng := [2]int{idx, idx}
	if inRange(orig, idx) {
		rng = orig
	}
	d := &a.detail
	if block >= 0 {
		d.blkActive, d.blkRange, d.blkSet = block+1, rng, [3]int{}
	} else {
		d.editSel, d.editRange = [2]int{-1, -1}, rng
	}
	a.insertWithUndo(n.ID, incoming, imgs, rng[0] != rng[1])
}

// dropCaret：悬停落点的插入光标（2pt 主色竖线），画在编辑器同一坐标系的覆盖层里。
func dropCaret(c *ui.Context, r ui.Rect) {
	ui.Box(c).Absolute().Left(r.X-1).Top(r.Y).Size(2, max(r.H, 16)).Radius(1).Background(stok(c).primary).PassThrough().Key("drop-caret")
}

func selPair(ta ui.Element) [2]int {
	lo, hi := ta.TextSelection()
	return [2]int{lo, hi}
}
