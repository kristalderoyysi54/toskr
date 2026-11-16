package main

import (
	"strings"
	"testing"
	"time"

	"github.com/toskr/native/internal/store"
)

// 2MB 文字卡在列表里（笔记 / 剪贴页、标准 / 紧凑密度）：预览只排版前一截，单帧不能卡住面板（修复前每帧数秒到几分钟）。
func TestBigCardFrameStaysFast(t *testing.T) {
	const size = 2*1024*1024 + 1
	for _, sc := range []struct{ name, text, section, density string }{
		{"notes-lines", strings.Repeat("abc def 中文 12345\n", size/24), store.SectionInbox, ""},
		{"notes-oneword", strings.Repeat("x", size), store.SectionInbox, ""},
		{"notes-compact", strings.Repeat("abc def ", size/8), store.SectionInbox, "compact"},
		{"clip", strings.Repeat("abc def 中文\n", size/16), store.SectionClipboard, ""},
		{"clip-compact", strings.Repeat("y", size), store.SectionClipboard, "compact"},
	} {
		t.Run(sc.name, func(t *testing.T) {
			a, tt := testApp(t)
			st := a.store.Settings()
			st.CardDensity = sc.density
			_ = a.store.SetSettings(st)
			n, _, _ := a.store.Add(store.Note{Section: sc.section, Text: sc.text})
			if sc.section == store.SectionClipboard {
				a.switchPage(pageClip)
			}
			a.reload()
			s := time.Now() // 量首帧：布局没变时后续帧走缓存，代价都在唤出 / 内容变化后的这一帧
			tt.Frame()
			if d := time.Since(s); d > 1500*time.Millisecond {
				t.Fatalf("单帧 %v（卡 %d 字节）", d, len(n.Text))
			}
			head := firstLine(sc.text)[:3]
			shown := false
			for _, x := range tt.Texts() {
				if strings.HasPrefix(x, head) && len(x) <= 4*cardPreviewRunes {
					shown = true
				}
			}
			if !shown {
				t.Fatal("预览应显示卡片开头（截断后）")
			}
		})
	}
}

func TestPreviewCapAndFirstLine(t *testing.T) {
	s := strings.Repeat("字", cardPreviewRunes+10)
	if got := previewCap(s); len([]rune(got)) != cardPreviewRunes {
		t.Fatalf("截断到 %d 字，实为 %d", cardPreviewRunes, len([]rune(got)))
	}
	if previewCap("短") != "短" || firstLine("\n  \n 第二行 \n第三行") != "第二行" || firstLine("") != "" {
		t.Fatal("短文本原样、firstLine 取首个非空行")
	}
}
