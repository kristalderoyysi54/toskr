package main

import "testing"

// 同 Tauri TextPreviewView 无界剧场：打开时显示；光标进窗显示、离窗收起；编辑 / 选词期间常显。
func TestDetailChromeAutoHide(t *testing.T) {
	a, _ := testApp(t, "一段正文")
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	if !dt.HasText("复制") {
		t.Fatalf("打开时操作坞应显示 %v", dt.Texts())
	}
	a.detail.chromeHidden = true // 键盘打开 2.5s 后光标不在窗内
	dt.Frame()
	if dt.HasText("复制") {
		t.Fatal("收起后坞不应显示")
	}
	dt.Move(200, 200)
	dt.Frame()
	if !dt.HasText("复制") {
		t.Fatal("光标进窗应唤出")
	}
	dt.Move(-20, -20)
	dt.Frame()
	if dt.HasText("复制") {
		t.Fatal("光标离窗应立即收起")
	}
	a.detail.pick = true
	dt.Frame()
	if !dt.HasText("复制") {
		t.Fatal("选词期间应常显")
	}
}
