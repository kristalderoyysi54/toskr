package core

import (
	"strings"
	"testing"
)

func kinds(fs []Finding) []string {
	out := make([]string, len(fs))
	for i, f := range fs {
		out[i] = f.Category + ":" + f.Kind
	}
	return out
}

// 同 Tauri privacy.rs 的正反例：手机号只认带上下文的号码，日期 / IP / 订单号不算。
func TestScanPhoneCases(t *testing.T) {
	pos := []string{
		"手机：" + joined("138", "0013", "8000"),
		"电话: " + joined("021-", "6234", "5678"),
		`"phone": "` + joined("+1 (415) ", "555-2671") + `"`,
		"tel: " + joined("+1 415 ", "555 2671"),
		"联系电话：" + joined("0755-", "8888", "1234"),
		"phone number: " + joined("415", "5552671"),
	}
	for _, s := range pos {
		if fs := Scan(s, Rules{}); len(fs) != 1 || fs[0].Category != "phone" {
			t.Errorf("%q 应命中手机号：%v", s, kinds(fs))
		}
	}
	neg := []string{"订单号 " + joined("138", "00138000"), "phone: 12345", "日期 2026-08-11", "phone: 2026-08-11", "telephone support is unavailable", "phone: 1111111"}
	for _, s := range neg {
		for _, f := range Scan(s, Rules{}) {
			if f.Category == "phone" {
				t.Errorf("%q 不应命中手机号", s)
			}
		}
	}
}

func TestScanIPv4AndEmail(t *testing.T) {
	for _, s := range []string{"10.0.0.1", "172.16.8.9", "server=169.254.2.3", "连到 8.8.8.8 了"} {
		if fs := Scan(s, Rules{}); len(fs) != 1 || fs[0].Category != "ipAddress" {
			t.Errorf("%q 应命中 IP：%v", s, kinds(fs))
		}
	}
	for _, s := range []string{"256.1.1.1", "1.2.3", "1.2.3.4.5", "version1.2.3.4beta", "version 1.2.3 released"} {
		if fs := Scan(s, Rules{}); len(fs) != 0 {
			t.Errorf("%q 不应命中：%v", s, kinds(fs))
		}
	}
	mail := joined("alice", "@example.com")
	if fs := Scan("发给 "+mail+" 吧", Rules{}); len(fs) != 1 || fs[0].Category != "email" {
		t.Fatalf("邮箱未命中：%v", kinds(Scan(mail, Rules{})))
	}
	for _, s := range []string{"git clone git@github.com:toskr/app.git", "ssh deploy@example.com", "ssh://git@example.com/repo"} {
		for _, f := range Scan(s, Rules{}) {
			if f.Category == "email" {
				t.Errorf("%q 是远程目标，不应算邮箱", s)
			}
		}
	}
}

func TestScanRulesSwitches(t *testing.T) {
	mail := joined("bob", "@corp.io")
	key := joined("-----BEGIN RSA ", "PRIVATE KEY-----")
	text := "邮件 " + mail + "\n" + key
	if fs := Scan(text, Rules{Off: true}); fs != nil {
		t.Fatalf("关闭后不应检测：%v", kinds(fs))
	}
	fs := Scan(text, Rules{DisabledWarn: []string{"email"}})
	if len(fs) != 1 || fs[0].Kind != "私钥" {
		t.Fatalf("关掉邮箱类别后只剩高风险：%v", kinds(fs))
	}
	if fs := Preflight(text); len(fs) != 2 {
		t.Fatalf("默认全开：%v", kinds(fs))
	}
}

func TestScanCustomFields(t *testing.T) {
	r := Rules{CustomFields: []string{"内部口令", "partner_secret"}}
	text := "内部口令：" + joined("hunter", "-42") + "\npartner_secret（生产） = 'abc def'\nmy_partner_secret: nope\n内部口令说明很长"
	fs := Scan(text, r)
	if len(fs) != 2 {
		t.Fatalf("应命中两处自定义字段：%v", kinds(fs))
	}
	if got := text[fs[0].Start:fs[0].End]; got != "hunter-42" || fs[0].Kind != "自定义敏感字段：内部口令" {
		t.Fatalf("第一处：%q %s", got, fs[0].Kind)
	}
	if got := text[fs[1].Start:fs[1].End]; got != "'abc def'" || fs[1].Category != "custom" {
		t.Fatalf("第二处：%q", got)
	}
	// 自定义字段按高风险处理：关掉所有提示级类别仍然检测
	if fs := Scan(text, Rules{CustomFields: r.CustomFields, DisabledWarn: WarnCategories}); len(fs) != 2 {
		t.Fatalf("关掉提示类别后自定义字段仍应检测：%v", kinds(fs))
	}
}

func TestCustomFieldIssue(t *testing.T) {
	many := make([]string, 32)
	for i := range many {
		many[i] = "f" + strings.Repeat("x", i+1)
	}
	cases := []struct {
		v        string
		existing []string
		want     string
	}{
		{"  ", nil, "请填写字段名，不需要填写密钥值"},
		{strings.Repeat("长", 65), nil, "字段名最多 64 个字符"},
		{"有 空格", nil, "仅支持汉字、英文字母、数字、下划线、点和短横线，不含空格"},
		{"Token", []string{"token"}, "这个字段已经添加（英文不区分大小写）"},
		{"new_one", many, "最多添加 32 个敏感字段"},
		{"内部口令.v2-x_y", nil, ""},
	}
	for _, c := range cases {
		if got := CustomFieldIssue(c.v, c.existing); got != c.want {
			t.Errorf("%q → %q，期望 %q", c.v, got, c.want)
		}
	}
}
