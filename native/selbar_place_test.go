package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestSelBarTop(t *testing.T) {
	// 视区 [60, 500)，工具条高 32，间距 8
	cases := []struct {
		name        string
		top, bot, h float32
		want        float32
	}{
		{"上方放得下", 200, 220, 32, 162},
		{"上方被标题栏挡，翻到下方", 80, 100, 32, 106},
		{"下方也越过操作坞，夹在坞上", 80, 480, 32, 468},
		{"选区滚出视区上方，夹在标题栏下", -300, -280, 32, 60},
		{"带链接输入行更高", 200, 220, 66, 128},
	}
	for _, c := range cases {
		if got := selBarTop(c.top, c.bot, c.h, 60, 500); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

// 编辑态划词工具条贴着选区：首行（上方被标题栏挡）翻到下方，往下选几行工具条随之下移约同样行数，都不在底部回落位。
func TestSelBarFollowsEditSelection(t *testing.T) {
	var lines []string
	for i := range 20 {
		lines = append(lines, fmt.Sprintf("第%02d行内容", i))
	}
	a, _ := testApp(t, strings.Join(lines, "\n"))
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	a.enterDetailEdit(n)
	dt.Frame() // 编辑器先布局一帧（实际使用中选区总在编辑器出现之后）
	barAt := func(line int) ui.Rect {
		t.Helper()
		lo := line * 7 // 每行 6 字 + 换行
		a.detail.editSel = [2]int{lo, lo + 6}
		for range 6 {
			dt.Frame()
		}
		r, ok := dt.Find("已选 6 字")
		if !ok {
			t.Fatalf("第 %d 行选中后无工具条 %v", line, dt.Texts())
		}
		return r
	}
	fallback := float32(540 - 56 - 32)
	r1, r5 := barAt(5), barAt(9)
	if r1.Y >= fallback-20 || r5.Y >= fallback-20 {
		t.Fatalf("工具条仍在底部：%v %v", r1, r5)
	}
	if d := r5.Y - r1.Y; d < 4*21.125-6 || d > 4*21.125+6 {
		t.Fatalf("选区下移 4 行，工具条应随之下移约 %.0f，实际 %.1f（%v → %v）", 4*21.125, d, r1, r5)
	}
}

func TestSelBarLeft(t *testing.T) {
	// 窗宽 [0, 560)，工具条宽 300
	for _, c := range []struct {
		name              string
		left, right, want float32
	}{
		{"居中对准选区", 200, 300, 100},
		{"贴左缘钳到 6", 0, 40, 6},
		{"贴右缘钳到 560-6-300", 500, 560, 254},
	} {
		if got := selBarLeft(c.left, c.right, 300, 0, 560); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

// 同 Tauri：选词态工具条贴着选中键帽（不在底部回落位），且只占自身宽度、不挡同行其他键帽。
func TestSelBarFollowsPickChips(t *testing.T) {
	a, _ := testApp(t, "复现测试 一段文字 demo.user@example.com我·w")
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	mustClick(t, dt, "选词")
	mustClick(t, dt, "文字")
	for range 6 {
		dt.Frame()
	}
	bar, ok := dt.Find("已选 2 字")
	chip, _ := dt.Find("文字")
	if !ok {
		t.Fatalf("无工具条 %v", dt.Texts())
	}
	if bar.Y > chip.Y+80 {
		t.Fatalf("工具条应贴着键帽：bar=%v chip=%v", bar, chip)
	}
	mustClick(t, dt, "demo.user")
	if got := a.pickedText(n.Text); got != "文字 demo.user" {
		t.Fatalf("工具条挡住了同行键帽：%q", got)
	}
}
