package main

import "testing"

// 多详情窗挑窗（同 Tauri pickDetailWindowLabel）：同卡复用 > 未固定窗 > 新窗；换窗时各窗状态互不串台。
func TestDetailPanePicking(t *testing.T) {
	a, _ := testApp(t)
	p1, same := a.pickPane("n1")
	if same || len(a.panes) != 1 {
		t.Fatal("首次开卡建新窗")
	}
	a.usePane(p1)
	a.detail.id, a.detailText = "n1", "第一张"
	if p, same := a.pickPane("n1"); p != p1 || !same {
		t.Fatal("同卡复用")
	}
	if p, _ := a.pickPane("n2"); p != p1 {
		t.Fatal("未固定的窗被新卡复用")
	}
	a.detail.pinned = true // 📌 固定 p1
	p2, same := a.pickPane("n2")
	if p2 == p1 || same || len(a.panes) != 2 {
		t.Fatal("全部固定时另开新窗")
	}
	a.usePane(p2)
	a.detail.id, a.detailText = "n2", "第二张"
	a.usePane(p1)
	if a.detail.id != "n1" || a.detailText != "第一张" || !a.detail.pinned {
		t.Fatalf("换回 p1 应恢复它自己的状态：%q %q", a.detail.id, a.detailText)
	}
	a.usePane(p2)
	if a.detail.id != "n2" || a.detailText != "第二张" || a.detail.pinned {
		t.Fatal("p2 状态独立")
	}
}
