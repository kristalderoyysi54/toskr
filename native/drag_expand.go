package main

import (
	"time"

	"github.com/egoist/mygo/ui"
)

// 拖到折叠分组头上悬停 500ms 自动展开（同 Tauri App.tsx / TaskPage onDragOver 的 dragExpand）。

const dragExpandDelay = 500 * time.Millisecond

var dragNow = time.Now // 测试替换

type dragExpand struct {
	sec  string
	from time.Time
}

// dragHover 在折叠分组头的拖拽悬停帧里调用：悬停够久返回 true（调用方展开），离开或已展开就清掉计时。
func (a *app) dragHover(c *ui.Context, sec string, over, collapsed bool) bool {
	if !over || !collapsed {
		if a.dragExp.sec == sec {
			a.dragExp = dragExpand{}
		}
		return false
	}
	if a.dragExp.sec != sec {
		a.dragExp = dragExpand{sec: sec, from: dragNow()}
	}
	if dragNow().Sub(a.dragExp.from) >= dragExpandDelay {
		a.dragExp = dragExpand{}
		return true
	}
	c.Invalidate() // 指针不动也要继续出帧，计时才能走到
	return false
}
