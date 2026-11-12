package main

import (
	"testing"
	"time"

	"github.com/toskr/native/internal/store"
)

func inboxColor(a *app) string {
	for _, s := range a.store.Sections() {
		if s.ID == store.SectionInbox {
			return s.Color
		}
	}
	return ""
}

// 分组头右键「分组颜色…」弹出色板：点色点即设色并收起，卡片通栏随之着色；「无颜色」清除。
func TestSectionColorPopover(t *testing.T) {
	a, tt := testApp(t, "收件箱卡片")
	if err := tt.RightClick("收件箱"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("分组颜色…"); err != nil {
		t.Fatalf("%v %v", err, tt.Menu())
	}
	tt.Frame()
	tt.Advance(200 * time.Millisecond)
	if !tt.HasText("分组颜色") {
		t.Fatalf("应弹出色板 %v", tt.Texts())
	}
	r, _ := tt.Find("收件箱卡片")
	before := tt.Image().RGBAAt(int(r.X)+4, int(r.Y)-14)
	if err := tt.Click("红"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	tt.Advance(300 * time.Millisecond)
	if inboxColor(a) != "#ef4444" || a.secColorPick != "" {
		t.Fatalf("应设为红色并收起 color=%q pick=%q", inboxColor(a), a.secColorPick)
	}
	if after := tt.Image().RGBAAt(int(r.X)+4, int(r.Y)-14); after == before || after.R < after.G+60 {
		t.Fatalf("卡片通栏应变红 %v → %v", before, after)
	}
	_ = tt.RightClick("收件箱")
	_ = tt.ChooseMenuItem("分组颜色…")
	tt.Frame()
	tt.Advance(200 * time.Millisecond)
	if err := tt.Click("无颜色"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if inboxColor(a) != "" {
		t.Fatal("无颜色应清除")
	}
}
