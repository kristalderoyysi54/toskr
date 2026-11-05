package main

import (
	"errors"
	"testing"

	"github.com/toskr/native/internal/ai"
)

func stubLocal(t *testing.T, f func([]string) ([]string, error)) {
	t.Helper()
	old := translateLocal
	translateLocal = f
	t.Cleanup(func() { translateLocal = old; langPackHinted.Store(false) })
}

// 本机可用直接用；缺语言包且 AI 未配置 → 遮罩短提示 + 关遮罩后引导；其它原因且 AI 未配置 → AI 的错误。
func TestTranslateTextsLocalFirstThenFallback(t *testing.T) {
	stubLocal(t, func(l []string) ([]string, error) { return []string{"你好"}, nil })
	out, msg, hint := translateTexts(ai.Config{}, []string{"Hello"})
	if len(out) != 1 || out[0] != "你好" || msg != "" || hint != "" {
		t.Fatalf("本机 %v %q %q", out, msg, hint)
	}
	stubLocal(t, func([]string) ([]string, error) { return nil, errors.New("language pack not installed") })
	out, msg, hint = translateTexts(ai.Config{}, []string{"Hello"})
	if out != nil || msg != tr("未安装离线翻译语言包，关闭截图后按提示下载") || hint == "" {
		t.Fatalf("缺包 %v %q %q", out, msg, hint)
	}
	stubLocal(t, func([]string) ([]string, error) { return nil, errTranslateHelperMissing })
	_, msg, hint = translateTexts(ai.Config{}, []string{"Hello"})
	if msg != ai.ErrNoKey.Error() || hint != "" {
		t.Fatalf("辅助程序缺失 %q %q", msg, hint)
	}
	if translateReason(errors.New("macOS 15 required")) != localUnsupported || translateReason(errors.New("helper timeout")) != localUnknown {
		t.Fatal("原因归类")
	}
}

// 真辅助程序（系统翻译框架）：语言包未装 / 系统不支持时跳过。
func TestTranslateHelperReal(t *testing.T) {
	out, err := runTranslateHelper("resources/darwin/"+translateHelperName, []string{"Hello world", "12345"})
	if err != nil {
		if r := translateReason(err); r != localUnknown {
			t.Skipf("本机翻译不可用：%v", err)
		}
		t.Fatalf("辅助程序：%v", err)
	}
	if len(out) != 2 || out[0] == "Hello world" || out[1] != "12345" {
		t.Fatalf("译文 %q", out)
	}
}

// 遮罩期间排队的引导在遮罩关掉后弹出。
func TestShotHintAfterEnd(t *testing.T) {
	a, _, _ := shotTest(t)
	a.shot.hint = "引导"
	a.endShot(false)
	if a.hudText != "引导" {
		t.Fatalf("HUD %q", a.hudText)
	}
}
