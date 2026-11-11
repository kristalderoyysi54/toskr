package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
)

// 样本 18「灵动胶囊」：换目标时旧名淡出、新名浮入，播完只剩新名；面板不可见时不播；播放中再换直接接到最新目标。
func TestTargetSwitchDecode(t *testing.T) {
	a, tt := testApp(t)
	tswAlways = true
	defer func() { tswAlways = false }()
	a.target = macos.FrontApp{PID: 7, BundleID: "com.yetone.alma", Name: "Alma"}
	tt.Frame()
	if !a.tsw.at.IsZero() || !tt.HasText("Alma") {
		t.Fatalf("首次识别不播 %v", tt.Texts())
	}
	a.target = macos.FrontApp{PID: 42, BundleID: "com.google.Chrome", Name: "Google Chrome"}
	tt.Frame()
	if a.tsw.at.IsZero() || a.tsw.from.PID != 7 {
		t.Fatalf("换目标应开始播放 from=%+v", a.tsw.from)
	}
	if !tt.HasText("Alma") || tt.HasText("Google Chrome") {
		t.Fatalf("起步时显示旧名、新名尚未浮入 %v", tt.Texts())
	}
	tt.Advance(120 * time.Millisecond)
	a.target = macos.FrontApp{PID: 50, BundleID: "com.tencent.xinWeChat", Name: "微信"} // 播放中再换：直接接到最新
	tt.Frame()
	if a.tsw.shown.PID != 50 {
		t.Fatalf("应接到最新目标 %+v", a.tsw.shown)
	}
	tt.Advance(1100 * time.Millisecond)
	if !a.tsw.at.IsZero() || !tt.HasText("微信") || tt.HasText("Google Chrome") {
		t.Fatalf("播完应显示新名 %v", tt.Texts())
	}

	tswAlways = false // 面板不可见（测试里无窗口）：直接显示最终状态
	a.target = macos.FrontApp{PID: 7, BundleID: "com.yetone.alma", Name: "Alma"}
	tt.Frame()
	if !a.tsw.at.IsZero() || !tt.HasText("Alma") {
		t.Fatal("面板不可见时不播")
	}
}

// 胶囊底色自适应：深色模式提亮近黑主色、浅色模式压暗过亮主色，偏灰主色加浓；正常主色不改色。
func TestCapsuleTint(t *testing.T) {
	cursor := ui.RGB(45, 48, 56)
	if c, a := capsuleTint(cursor, true); relLum(c) <= relLum(cursor) || a <= 0.24 {
		t.Fatalf("深色模式近黑主色应提亮并加浓 lum=%v a=%v", relLum(c), a)
	}
	yellow := ui.RGB(251, 230, 5)
	if c, _ := capsuleTint(yellow, false); relLum(c) >= relLum(yellow) {
		t.Fatal("浅色模式过亮主色应压暗")
	}
	green := ui.RGB(7, 193, 96)
	if c, a := capsuleTint(green, false); c != green || a != 0.18 {
		t.Fatalf("正常主色在浅色模式不改 %v %v", c, a)
	}
}
