package main

import (
	"testing"

	"github.com/toskr/native/internal/store"
)

// 常用区右键「取消常用」（气泡可撤销）：菜单回调在画方块的循环里改了 a.quick，后面的格子不能越界（实发：闪退）。
func TestQuickUnpinFromContextMenu(t *testing.T) {
	a, tt, sec := quickTestApp(t, 2)
	f, _ := a.store.SaveImage(whitePNG(t, 60, 30))
	bs := []store.ContentBlock{{Type: "text", Text: "图片卡"}, {Type: "image", File: f}}
	x := addNote(t, a, store.Note{Section: sec, Text: store.TextFromBlocks(bs), Blocks: bs})
	_ = a.store.SetKept(x.ID, true)
	a.setQuickOrder([]string{x.ID})
	tt.Frame()
	tt.Frame()
	if a.quick[0].ID != x.ID || len(a.quick) != 3 {
		t.Fatalf("前置：图片卡应排第一 %v", quickTexts(a))
	}
	if err := tt.RightClick("发送：图片卡"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("取消常用"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	tt.Frame()
	if len(a.quick) != 2 {
		t.Fatalf("应剩 2 张常用 %v", quickTexts(a))
	}
	if a.hudText != "已取消常用" || a.hudUndo == nil {
		t.Fatalf("应出可撤销气泡 %q", a.hudText)
	}
	a.hudUndo() // 撤销：回到常用区原来的位置
	if len(a.quick) != 3 || a.quick[0].ID != x.ID {
		t.Fatalf("撤销后图片卡应回到第一 %v", quickTexts(a))
	}
}
