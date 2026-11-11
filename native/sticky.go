package main

import "github.com/egoist/mygo/ui"

// 笔记分组吸顶（同 Tauri SectionGroup / stickyHeader.ts）。mygo 没有 position: sticky，按滚动量平移区头：
// 分组在内容里的纵坐标 = 上一帧它的窗口坐标 − 视口窗口坐标 + 上一帧滚动量；本帧滚动量超过它就把区头往下推，
// 最多推到本组底部（下一组的区头接替）。

type stickCtx struct {
	view          ui.Rect            // 列表视口（上一帧）
	builtY, nextY float32            // 上一帧 / 本帧构建时的滚动量
	top           map[string]float32 // 本帧吸顶中的分组 → 组首的滚动位置（点标题回到组首）
}

const secHeadH = 20

// stickOffset：分组区头本帧应下移的距离（0 = 不吸顶）。b 是分组块上一帧的位置。
func (a *app) stickOffset(id string, b ui.Rect) float32 {
	s := &a.stick
	if s.view.H <= 0 || b.H <= 0 {
		return 0
	}
	contentTop := b.Y - s.view.Y + s.builtY
	off := min(s.nextY-contentTop, b.H-secHeadH-4) // 底部留 4：与块的下内边距一致
	if off <= 0 {
		return 0
	}
	if s.top != nil {
		s.top[id] = contentTop
	}
	return off
}
