package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 带按钮的系统警告框一律改走 confirmAsk：系统框认不出中文「取消」，Esc 会落到第 0 个按钮（删除 / 发送原文）。
func TestNoRawMessageDialogs(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	call := regexp.MustCompile(`Dialog\.Message\(`)
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, _ := os.ReadFile(f)
		for _, loc := range call.FindAllIndex(src, -1) {
			end := min(len(src), loc[1]+600)
			if call := src[loc[0]:end]; strings.Contains(string(call[:closeParen(call)]), "Buttons:") {
				t.Errorf("%s 直接弹带按钮的系统警告框，请改用 confirmAsk", f)
			}
		}
	}
}

// closeParen：从 "Dialog.Message(" 起找到与之配对的右括号位置。
func closeParen(b []byte) int {
	depth := 0
	for i, ch := range b {
		switch ch {
		case '(':
			depth++
		case ')':
			if depth--; depth == 0 {
				return i
			}
		}
	}
	return len(b)
}

func confirmTester(spec confirmSpec) (*confirmWin, *[]bool, *ui.Tester) {
	got := &[]bool{}
	cw := &confirmWin{spec: spec, answer: func(ok bool) { *got = append(*got, ok) }}
	tt := ui.NewTester(func(c *ui.Context) {
		bd := gray(0.96, 1) // 代替窗口后面的毛玻璃，截图才看得出真实对比度
		if tok(c).dark {
			bd = gray(0.16, 1)
		}
		confirmView(c, cw)
		c.Root().Background(bd)
	}, confirmW, 320)
	tt.Frame()
	return cw, got, tt
}

var dangerSpec = confirmSpec{icon: "trash-2", danger: true, title: "删除剪贴板历史记录？", body: "已固定（★）的记录不会被删除。", note: "删除后可在主面板的提示气泡中撤销一次。", ok: "清除"}

// Esc / 点取消 = 取消；危险操作单按 ⏎ 不确认、⌘⏎ 才确认；普通确认 ⏎ 即确认；只回答一次。
func TestConfirmKeys(t *testing.T) {
	_, got, tt := confirmTester(dangerSpec)
	tt.Key(0, ui.KeyEscape)
	tt.Frame()
	if len(*got) != 1 || (*got)[0] {
		t.Fatalf("Esc 应取消 %v", *got)
	}

	_, got, tt = confirmTester(dangerSpec)
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if len(*got) != 0 {
		t.Fatalf("危险操作单按 ⏎ 不应确认 %v", *got)
	}
	tt.Key(ui.Cmd, ui.KeyEnter)
	tt.Frame()
	tt.Key(ui.Cmd, ui.KeyEnter)
	tt.Frame()
	if len(*got) != 1 || !(*got)[0] {
		t.Fatalf("⌘⏎ 确认且只回答一次 %v", *got)
	}

	safe := confirmSpec{icon: "link-2", title: "获取链接预览？", facts: []confirmFact{{label: "地址", value: "http://192.168.1.2:8080"}}, ok: "仅本次允许"}
	_, got, tt = confirmTester(safe)
	tt.Key(0, ui.KeyEnter)
	tt.Frame()
	if len(*got) != 1 || !(*got)[0] {
		t.Fatalf("普通确认 ⏎ 即确认 %v", *got)
	}

	_, got, tt = confirmTester(dangerSpec)
	if err := tt.Click("取消"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	_, got2, tt2 := confirmTester(dangerSpec)
	if err := tt2.Click("清除"); err != nil {
		t.Fatal(err)
	}
	tt2.Frame()
	if len(*got) != 1 || (*got)[0] || len(*got2) != 1 || !(*got2)[0] {
		t.Fatalf("点按钮 取消=%v 清除=%v", *got, *got2)
	}
}

// TestConfirmShots：确认窗浅 / 深色与 Platinum 截图供目检（TOSKR_SHOT_DIR 未设时跳过）。
func TestConfirmShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	ai := confirmSpec{icon: "shield-alert", danger: true, title: "发给 AI 的原文含敏感内容",
		facts: []confirmFact{{label: "用途", value: "润色"}, {label: "AI 服务", value: "api.deepseek.com"}, {label: "原文包含", tags: []string{"密钥/凭据 1 处", "邮箱 2 处", "手机号 1 处"}}},
		note:  "此前对其他应用「保留原文」的决定不适用于 AI 请求。", ok: "仅本次发送原文"}
	link := confirmSpec{icon: "link-2", title: "获取链接预览？", body: "访问该地址获取标题和图标，本次允许它访问内网。",
		facts: []confirmFact{{label: "地址", value: "http://intranet.example.internal:8080/very/long/path/to/a/page"}}, note: "不会发送应用中的其他内容；授权不覆盖其他内网地址的重定向。", ok: "仅本次允许"}
	for _, scheme := range []string{"", "platinum"} {
		a, _ := testApp(t)
		a.patchSettings(func(x *store.Settings) { x.ColorScheme = scheme })
		prev := curScheme
		if scheme != "" {
			curScheme = scheme
		}
		for _, dark := range []bool{false, true} {
			if scheme == "platinum" && dark {
				continue // Platinum 固定浅色
			}
			for name, spec := range map[string]confirmSpec{"ai": ai, "clip": dangerSpec, "link": link} {
				cw, _, tt := confirmTester(spec)
				tt.SetDark(dark)
				for range 3 {
					tt.Frame()
				}
				mode := map[bool]string{false: "light", true: "dark"}[dark]
				tag := map[string]string{"": "default", "platinum": "platinum"}[scheme]
				img := tt.Image()
				save(t, filepath.Join(dir, "confirm-"+name+"-"+tag+"-"+mode+".png"), img)
				if cw.h <= 0 || cw.h > 320 {
					t.Errorf("%s 内容高度 %d 应在窗内", name, cw.h)
				}
			}
		}
		a.patchSettings(func(x *store.Settings) { x.ColorScheme = "" })
		curScheme = prev
	}
}
