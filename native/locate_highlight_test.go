package main

import (
	"testing"
	"time"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 定位原会话：来源未运行 / 列表里没有 / 认不出列表 各给提示；命中时以群名查找并显示高亮。
func TestLocateMessage(t *testing.T) {
	a, _ := msgApp(t)
	oldL, oldR, oldA := locateConversation, locateRunning, locateActivate
	t.Cleanup(func() { locateConversation, locateRunning, locateActivate = oldL, oldR, oldA })
	running := []int32{}
	locateRunning = func(string) []int32 { return running }
	activated := int32(0)
	locateActivate = func(pid int32) bool { activated = pid; return true }
	m := store.Message{ConversationID: "g1", ConversationName: "项目群", SourceApp: "某 IM", SourceBundle: "com.example.im"}
	a.locateMessage(m)
	if a.hudText != "某 IM 当前未运行" {
		t.Fatal(a.hudText)
	}
	running = []int32{42}
	var gotPid int32
	var gotName string
	res := macos.LocateNotInList
	locateConversation = func(pid int32, needle string) (macos.Rect, macos.LocateOutcome) {
		gotPid, gotName = pid, needle
		return macos.Rect{X: 10, Y: 20, W: 200, H: 60}, res
	}
	wait := func() {
		a.hudText = ""
		a.locateMessage(m)
		for i := 0; i < 100 && a.hudText == "" && a.locateGen == 0; i++ {
			time.Sleep(10 * time.Millisecond)
			a.drainUpdates()
		}
	}
	wait()
	if activated != 42 || gotPid != 42 || gotName != "项目群" || a.hudText != "某 IM会话列表里没找到该群（列表可能处于搜索或过滤状态）" {
		t.Fatalf("%d %d %q %q", activated, gotPid, gotName, a.hudText)
	}
	res = macos.LocateNoList
	wait()
	if a.hudText != "未能识别某 IM的会话列表（请确认主窗口已打开）" {
		t.Fatal(a.hudText)
	}
	res = macos.LocateRow
	wait()
	if a.locateGen != 1 || a.hudText != "" {
		t.Fatalf("命中应显示高亮而不是提示 %d %q", a.locateGen, a.hudText)
	}
}
