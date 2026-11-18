package main

import (
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 笔记分组的筛选与管理菜单。竖版左侧分组侧栏已移除（用户 2026-11-17）：筛选走分组头菜单「只看此组」，
// 新建分组走分组头菜单「新建分组」，拖卡换组走拖动时的分组坞（note_dock.go）。

var sectionColors = []string{"#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#94a3b8"}

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

// sectionMenu：分组管理菜单（分组区头 / 横栏胶囊共用，同 Tauri GroupPill 右键）。
func (a *app) sectionMenu(m *ui.Menu, s store.Section, i, n int) {
	members := a.store.Section(s.ID)
	if m.Item(tr("全选此组")).Disabled(len(members) == 0).Chosen() { // 同 Tauri：含已完成，空组置灰
		for _, x := range members {
			a.chosen.Add(x.ID)
		}
	}
	if m.Item(tr("重命名")).Chosen() {
		a.headRename, a.headRenameText, a.headRenameFocused = s.ID, sectionName(s), false // 就地改（同 Tauri）
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
	m.Submenu(tr("排序"), func(sm *ui.Menu) { // 只影响本组的未完成卡；普通卡发送后会标完成移出，配合「发送后保留」最有用
		for _, o := range sectionSorts {
			if sm.Item(tr(o.label)).Checked(s.Sort == o.id).Chosen() {
				s.Sort = o.id
				_ = a.store.UpdateSection(s)
			}
		}
	})
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
