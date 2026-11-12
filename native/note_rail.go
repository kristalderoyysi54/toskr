package main

import (
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 笔记分组侧栏（Tauri NoteGroupRail + GroupPills vertical）：左缘 12×20 开关展开 64 宽列表：
// 全部 / 各分组（色点 + 名）/ 新建；点选只显示该组，双击改名，右键管理（全选此组、重命名、颜色、发送后保留、上下移、删除）。

var sectionColors = []string{"#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#94a3b8"}

const railW = 64

// pickNoteGroup：切换分组过滤（清掉勾选，同 Tauri pickNoteGroup）。
func (a *app) pickNoteGroup(id string) {
	if id == a.noteFilter {
		return
	}
	a.noteFilter = id
	if id != "" && id != doneFilter {
		a.section = id // 输入区记到所选分组
	}
	a.chosen.Clear()
	a.reload()
}

func (a *app) noteRailToggle(c *ui.Context, k tokens) {
	name := tr("全部")
	for _, s := range a.store.Sections() {
		if s.ID == a.noteFilter {
			name = sectionName(s)
		}
	}
	tip := tr("选择笔记分组")
	if a.noteRailOpen {
		tip = tr("收起笔记分组")
	}
	b := tipOf(c, ui.Box(c).Absolute().Left(0).Top(4).Size(12, 20).Radius(0, rr(8), rr(8), 0).Center(), tip).
		Role(ui.RoleButton).Label(tip + tr("，当前：") + name).Key("rail-toggle")
	col := k.muted.Alpha(0.35)
	if b.Hovered() || a.noteRailOpen {
		col = k.fg
	}
	if b.Hovered() {
		b.Background(k.track)
	}
	b.Children(func() { licon(c, "panel-left", 12, col) })
	if b.Clicked() {
		a.noteRailOpen = !a.noteRailOpen
		a.renamingSec = ""
	}
}

func (a *app) noteRail(c *ui.Context, k tokens) {
	secs := a.noteSections()
	rail := ui.Box(c).Width(railW).FillHeight().BorderWidth(0, 1, 0, 0).BorderColor(k.inputBorder.Alpha(0.4)).Key("note-rail").Label(tr("笔记分组"))
	rail.Children(func() {
		ui.Scroll(c).Fill().Scrollbars(false).Children(func() {
			col := ui.Column(c).Padding(32, 0, 4, 8).Gap(4)
			sortListBegin[secDrag](&a.railSort, col, &a.railJump, &a.railSeen, func(from, to string) {
				_ = a.store.ReorderSection(from, to)
				a.reload()
				secs = a.noteSections()
			})
			ids := make([]string, 0, len(secs))
			for _, x := range secs {
				ids = append(ids, x.ID)
			}
			defer func() { sortListEnd(&a.railSort, a.railSeen) }()
			col.Children(func() {
				if a.railPill(c, k, "", tr("全部"), "", a.noteFilter == "") {
					a.pickNoteGroup("")
					a.noteRailOpen = false
				}
				for i, s := range secs {
					a.railSection(c, k, s, i, len(secs), ids)
				}
				nb := ui.Row(c).Height(22).Margin(4, 0, 0, 0).Padding(0, 4).Gap(4).Radius(rr(6)).AlignItems(ui.Center).Role(ui.RoleButton).Label(tr("新建分组")).Key("rail-new")
				fg := k.muted.Alpha(0.6)
				if nb.Hovered() {
					fg = k.fg
					nb.Background(k.hoverBg)
				}
				nb.Children(func() {
					licon(c, "plus", 12, fg)
					text(c, tr("新建"), 11, 16, 400, fg)
				})
				if nb.Clicked() {
					if id := a.store.AddSection(tr("新分组")); id != "" {
						a.renamingSec, a.renameText = id, tr("新分组")
					}
				}
			})
		})
	})
}

// noteSections：笔记页可见分组（不含剪贴板）。
func (a *app) noteSections() []store.Section {
	var out []store.Section
	for _, s := range a.store.Sections() {
		if s.ID != store.SectionClipboard {
			out = append(out, s)
		}
	}
	return out
}

// railPill：竖排胶囊（pillCls vertical）：选中浅主色底 + 描边、字重 500。
func (a *app) railPill(c *ui.Context, k tokens, id, label, color string, on bool) bool {
	s := stok(c)
	b := tipOf(c, ui.Row(c).Height(26).Padding(0, 2).Gap(4).Radius(rr(6)).AlignItems(ui.Center).Border(1, ui.Transparent).
		Role(ui.RoleButton).Label(label), label).Key("rail-" + id)
	fg, w := k.muted, 400
	switch {
	case on:
		b.Background(s.primary.Alpha(0.1)).Border(1, k.inputBorder)
		fg, w = k.fg, 500
	case b.Hovered():
		b.Background(k.hoverBg)
		fg = k.fg
	}
	if id == "" {
		b.Justify(ui.Center)
	}
	if id != "" { // 侧栏分组也是放置目标：拖卡片到这里 = 移入该组
		if _, ok := ui.DragOver[noteDrag](b); ok {
			b.Background(s.primary.Alpha(0.15))
		}
		if d, ok := ui.Drop[noteDrag](b); ok {
			_ = a.store.MoveToAt(d.id, id, 0)
		}
	}
	b.Children(func() {
		if id != "" {
			dot := ui.RGB(0x98, 0x98, 0x9d)
			if color != "" {
				dot = hexColor(color)
			}
			ui.Box(c).Size(6, 6).Radius(3).Background(dot)
		}
		text(c, label, 11, 16, w, fg).SingleLine().Grow(1).Basis(0)
	})
	return b.Clicked()
}

func (a *app) railSection(c *ui.Context, k tokens, s store.Section, i, n int, ids []string) {
	if a.renamingSec == s.ID {
		ui.TextInputBase(c, &a.renameText).Height(24).Padding(0, 4).Radius(rr(6)).Border(1, k.inputBorder).Font(fontSans).FontSize(11).
			TextColor(k.fg).Label(tr("分组名称")).Focus().OnTextKey(func(key ui.TextKey) bool {
			switch key.Key {
			case ui.KeyEnter:
				a.renameText = key.Text()
				a.commitRename()
				return true
			case ui.KeyEscape:
				a.renamingSec = ""
				return true
			}
			return false
		})
		return
	}
	// 侧栏胶囊也可拖动排序（同 Tauri GroupPill reorder）：槽位判断落点，胶囊平移让位
	slot := ui.Column(c).Key("railslot-" + s.ID)
	sortTrack(&a.railSort, slot, s.ID)
	slot.Children(func() {
		pill := ui.Box(c).Key("railsec-" + s.ID).Drag(secDrag{s.ID})
		sortShift(&a.railSort, pill, ids, s.ID, 4, a.railJump)
		if pill.Dragging() {
			a.railSort.begin(s.ID)
			a.railSeen = true
			liftHead(c, pill.Radius(rr(6)))
		}
		pill.ContextMenu(func(m *ui.Menu) { a.secMenuSrc = "rail"; a.sectionMenu(m, s, i, n) })
		a.sectionColorPopover(c, k, s, pill, "rail")
		pill.Children(func() {
			if a.railPill(c, k, s.ID, sectionName(s), s.Color, a.noteFilter == s.ID) {
				a.pickNoteGroup(s.ID)
				a.noteRailOpen = false
			}
		})
		if pill.DoubleClicked() {
			a.renamingSec, a.renameText = s.ID, s.Name
		}
	})
}

func (a *app) commitRename() {
	id := a.renamingSec
	a.renamingSec = ""
	for _, s := range a.store.Sections() {
		if s.ID == id && a.renameText != "" && a.renameText != s.Name {
			s.Name = a.renameText
			_ = a.store.UpdateSection(s)
		}
	}
}

// sectionMenu：分组管理菜单（侧栏与分组区头共用，同 Tauri GroupPill 右键）。
func (a *app) sectionMenu(m *ui.Menu, s store.Section, i, n int) {
	members := a.store.Section(s.ID)
	if m.Item(tr("全选此组")).Disabled(len(members) == 0).Chosen() { // 同 Tauri：含已完成，空组置灰
		for _, x := range members {
			a.chosen.Add(x.ID)
		}
	}
	if m.Item(tr("重命名")).Chosen() {
		if a.noteRailOpen { // 从侧栏右键：在侧栏里改
			a.renamingSec, a.renameText = s.ID, s.Name
		} else { // 从分组头「…」/ 右键：就地改（同 Tauri）
			a.headRename, a.headRenameText, a.headRenameFocused = s.ID, sectionName(s), false
		}
	}
	if m.Item(tr("分组颜色…")).Chosen() { // 原生菜单放不了色点：弹出色板（section_color.go）
		a.openSectionColor(s.ID)
	}
	keep := tr("发送后保留")
	if s.KeepAfterSend {
		keep = tr("取消发送后保留")
	}
	if m.Item(keep).Chosen() {
		s.KeepAfterSend = !s.KeepAfterSend
		_ = a.store.UpdateSection(s)
	}
	// 设为捕获目标（同 Tauri SectionGroup）：双击触发键捕获的内容存入此组；再点改回收件箱
	capID := a.store.Settings().CaptureSection
	isCap := capID == s.ID || (capID == "" && s.ID == store.SectionInbox)
	if s.ID != store.SectionClipboard && !(isCap && s.ID == store.SectionInbox) {
		label := tr("设为捕获目标")
		if isCap {
			label = tr("捕获改回存入收件箱")
		}
		if m.Item(label).Chosen() {
			cur := a.store.Settings()
			cur.CaptureSection = s.ID
			if isCap {
				cur.CaptureSection = ""
			}
			_ = a.store.SetSettings(cur)
		}
	}
	m.Separator()
	if m.Item(tr("上移")).Disabled(i == 0).Chosen() {
		_ = a.store.MoveSection(s.ID, -1)
	}
	if m.Item(tr("下移")).Disabled(i == n-1).Chosen() {
		_ = a.store.MoveSection(s.ID, 1)
	}
	if !store.IsSystemSection(s.ID) {
		m.Separator()
		if m.Item(tr("删除分组")).Chosen() {
			if a.noteFilter == s.ID {
				a.pickNoteGroup("")
			}
			a.store.DeleteSection(s.ID)
		}
	}
}
