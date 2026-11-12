package main

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 共用界面代码不许直接认识某个主题：主题专用的名字（pt* 助手与颜色、"platinum" 字面量、已删的 .pt 标志）
// 只能出现在 platinum*.go 里，其余文件一律经 styleTheme 接口。新增主题的专用文件加进 owned。
func TestSharedCodeIsThemeAgnostic(t *testing.T) {
	owned := regexp.MustCompile(`^platinum`)
	bad := regexp.MustCompile(`\bpt[A-Z]\w*|"platinum"|\b[kst]\.pt\b`)
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if owned.MatchString(f) || strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(src), "\n") {
			if code, _, _ := strings.Cut(line, "//"); bad.MatchString(code) {
				t.Errorf("%s:%d 直接引用了主题专用名字，应改走 styleTheme：%s", f, i+1, strings.TrimSpace(line))
			}
		}
	}
}

// stubTheme：只改元信息和一个修饰点的最小主题，验证「嵌入 baseTheme + registerTheme」就能接进来。
type stubTheme struct {
	baseTheme
	wells int
}

func (*stubTheme) ID() string        { return "stub" }
func (*stubTheme) Label() string     { return "Stub" }
func (*stubTheme) FixedLight() bool  { return true }
func (s *stubTheme) Well(ui.Element) { s.wells++ }

func TestThemeRegistryPlugsIn(t *testing.T) {
	st := &stubTheme{}
	registerTheme(st)
	defer func() { // 测试注册的主题不留给其它用例
		delete(styleThemes, "stub")
		styleThemeOrder = styleThemeOrder[:len(styleThemeOrder)-1]
		curScheme = "default"
	}()
	if themeFor("stub") != styleTheme(st) || !isTheme("stub") || isTheme("matcha") || themeFor("matcha") != modernTheme {
		t.Fatal("注册后按 ID 取得到；颜色名不是主题")
	}
	if !fixedLight("stub") || fixedLight("fog") || !fixedLight("platinum") {
		t.Fatal("固定浅色由主题元信息决定")
	}

	a, _ := testApp(t, "一条笔记")
	a.patchSettings(func(x *store.Settings) { x.ColorScheme = "sakura" })
	a.setStyleTheme("stub")
	if v := a.store.Settings(); v.ColorScheme != "stub" || v.LastColorScheme != "sakura" {
		t.Fatalf("进主题应记下颜色 %q %q", v.ColorScheme, v.LastColorScheme)
	}
	a.setStyleTheme("platinum") // 主题之间直接切：记下的颜色不被覆盖
	if v := a.store.Settings(); v.ColorScheme != "platinum" || v.LastColorScheme != "sakura" {
		t.Fatalf("主题间切换 %q %q", v.ColorScheme, v.LastColorScheme)
	}
	a.setStyleTheme("nope") // 未注册的 ID 不生效
	a.setStyleTheme("")
	if v := a.store.Settings(); v.ColorScheme != "sakura" || v.LastColorScheme != "" {
		t.Fatalf("切回现代应恢复颜色 %q", v.ColorScheme)
	}

	// 设置里「主题」行列出现代 + 全部已注册主题；选中 stub 后共用控件经它修饰（任务速记框是输入井）
	a.setStyleTheme("stub")
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 720)
	set.Frame()
	for _, s := range []string{"主题", "Stub"} {
		if !set.HasText(s) {
			t.Fatalf("设置缺 %q %v", s, set.Texts())
		}
	}
	if slices.Contains(set.Texts(), "颜色") {
		t.Fatal("主题生效时不显示「颜色」行")
	}
	a.switchPage(pageTasks)
	pt := ui.NewTester(a.panelView, 380, 760)
	pt.Frame()
	if st.wells == 0 {
		t.Fatal("共用控件应调用当前主题的修饰点")
	}
}
