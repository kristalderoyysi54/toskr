package core

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"unicode/utf16"
)

// TestPrivacyParityWithTauri 是与 Tauri privacy.rs 的差分测试：TOSKR_PRIVACY_DIFF 指向 Rust 版对一批文本的扫描结果
// （[{text, findings:[{category,start,end,rule}]}]，区间为 UTF-16），逐条比对类别与区间。语料来自 Tauri 自己的单测输入，
// 含大量令牌形态的正例，不入库（避免触发 secret scanning）；生成方式见 tasks/lessons.md 2026-11-06 条。
func TestPrivacyParityWithTauri(t *testing.T) {
	path := os.Getenv("TOSKR_PRIVACY_DIFF")
	if path == "" {
		t.Skip("未设置 TOSKR_PRIVACY_DIFF")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Text     string `json:"text"`
		Findings []struct {
			Category   string `json:"category"`
			Start, End int
			Rule       string `json:"rule"`
		} `json:"findings"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	bad := 0
	for _, c := range cases {
		var want, got []string
		for _, f := range c.Findings {
			want = append(want, fmt.Sprintf("%s@%d-%d", f.Category, f.Start, f.End))
		}
		for _, f := range Scan(c.Text, Rules{}) {
			got = append(got, fmt.Sprintf("%s@%d-%d", f.Category, u16At(c.Text, f.Start), u16At(c.Text, f.End)))
		}
		if strings.Join(want, ",") != strings.Join(got, ",") {
			bad++
			if bad <= 40 {
				t.Errorf("%q\n  tauri %v\n  go    %v", trunc(c.Text), want, got)
			}
		}
	}
	t.Logf("%d 条语料，%d 条不一致", len(cases), bad)
}

func u16At(s string, b int) int { return len(utf16.Encode([]rune(s[:b]))) }

func trunc(s string) string {
	if r := []rune(s); len(r) > 120 {
		return string(r[:120]) + "…"
	}
	return s
}
