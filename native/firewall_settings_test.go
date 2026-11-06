package main

import (
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/store"
)

func TestFirewallSettings(t *testing.T) {
	a, _ := testApp(t)
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 2000)
	a.setJump = "粘贴与隐私"
	set.Frame()
	set.Frame()
	for _, s := range []string{"发送前隐私检查", "检测类别", "全部开启", "自定义敏感字段", "未添加"} {
		if !set.HasText(s) {
			t.Fatalf("缺 %q：%v", s, set.Texts())
		}
	}
	// 关掉邮箱提示
	_ = set.Click("全部开启")
	set.Frame()
	if !set.HasText("邮箱") || !set.HasText("私钥、授权凭据、密钥、数据库连接、Cookie 等高风险内容始终检测，不能关闭。") {
		t.Fatal(set.Texts())
	}
	a.patchSettings(func(x *store.Settings) { x.FirewallDisabledWarn = []string{"email"} })
	set.Frame()
	if !set.HasText("已开启 4/5") {
		t.Fatal(set.Texts())
	}
	mail := "发给 carol" + "@corp.io"
	if fs := core.Scan(mail, a.scanRules()); len(fs) != 0 {
		t.Fatalf("邮箱类别已关，不应命中：%v", fs)
	}

	// 添加自定义字段：先重复再合法
	_ = set.Click("未添加")
	set.Frame()
	if err := set.Click("敏感字段名"); err != nil {
		t.Fatal(err)
	}
	set.Type("有 空格")
	_ = set.Click("添加")
	set.Frame()
	if !set.HasText("仅支持汉字、英文字母、数字、下划线、点和短横线，不含空格") {
		t.Fatalf("应显示校验错误：%v", set.Texts())
	}
	a.fw.input = "内部编号"
	_ = set.Click("添加")
	set.Frame()
	if got := a.store.Settings().FirewallCustomFields; !slices.Equal(got, []string{"内部编号"}) || !set.HasText("1 个") {
		t.Fatalf("自定义字段：%v %v", got, set.Texts())
	}
	if fs := core.Scan("内部编号：abc123", a.scanRules()); len(fs) != 1 || fs[0].Category != "custom" {
		t.Fatalf("%v", fs)
	}
	_ = set.Click("删除敏感字段 内部编号")
	set.Frame()
	if len(a.store.Settings().FirewallCustomFields) != 0 {
		t.Fatal("删除失败")
	}

	// 总开关关闭：类别显示未生效，扫描不报
	a.patchSettings(func(x *store.Settings) { x.FirewallOff = true })
	set.Frame()
	if !set.HasText("未生效") || !set.HasText("已关闭：发送前不检查；可逆化名不受影响") {
		t.Fatal(set.Texts())
	}
	if fs := core.Scan("-----BEGIN RSA "+"PRIVATE KEY-----", a.scanRules()); fs != nil {
		t.Fatal(fs)
	}
}
