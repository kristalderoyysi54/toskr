//go:build darwin

package macos

import "testing"

func TestTitleMatches(t *testing.T) {
	for _, c := range []struct {
		title, needle string
		want          bool
	}{
		{"【P0需求】查询PID-API", "【P0需求】查询PID-API", true},
		{"项目群（12）", "项目群", true},
		{"支付中心自动落账技术…", "支付中心自动落账技术对接", true}, // 截断的长名
		{"支付…", "支付中心自动落账技术对接", false},        // 截断后太短不认
		{"", "x", false},
	} {
		if got := TitleMatches(c.title, c.needle); got != c.want {
			t.Errorf("%q / %q = %v", c.title, c.needle, got)
		}
	}
}
