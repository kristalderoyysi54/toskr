package core

import (
	"strings"
	"testing"

	"github.com/toskr/native/internal/macos"
)

// 正例在运行时拼接，仓库文本里不留连续的可扫描令牌模式（见 lessons：secret scanning 告警）。
func joined(parts ...string) string { return strings.Join(parts, "") }

func TestPreflightFindsSecretsCardsAndIDs(t *testing.T) {
	gh := joined("gh", "p_", strings.Repeat("a1B2", 9))
	card := joined("4111 1111", " 1111 1111")  // Luhn 合法的测试卡号
	id := joined("1101051949", "1002002", "9") // 校验位正确
	text := "令牌 " + gh + " 卡号 " + card + " 证件 " + id + " 普通数字 1234 5678 9012 3456"
	got := Preflight(text)
	kinds := []string{}
	for _, f := range got {
		kinds = append(kinds, f.Kind)
	}
	if strings.Join(kinds, ",") != "密钥/凭据,银行卡号,身份证号" {
		t.Fatalf("命中 %v", kinds)
	}
	red := Redact(text, got)
	if strings.Contains(red, gh) || strings.Contains(red, id) || !strings.Contains(red, "普通数字 1234") {
		t.Fatalf("遮罩结果 %q", red)
	}
	if len(Preflight("今天下午三点开会，带上 2026 年预算表")) != 0 {
		t.Fatal("普通文本不应命中")
	}
}

func TestDeliverWithEnterAndImage(t *testing.T) {
	f := &fake{items: original(), activateOK: true, front: macos.FrontApp{PID: 1}}
	var keys []uint16
	sys := &keyRecorder{fake: f, keys: &keys}
	if _, err := DeliverWith(sys, macos.FrontApp{PID: 42}, Payload{Text: "图注", PNG: []byte("png")}, Options{Enter: true}); err != nil {
		t.Fatal(err)
	}
	WaitIdle()
	if len(keys) != 2 || keys[0] != macos.KeyV || keys[1] != KeyReturn {
		t.Fatalf("应 ⌘V 后回车，实为 %v", keys)
	}
	if text, _ := f.ReadString(); text != "用户原剪贴板" {
		t.Fatal("应还原原剪贴板")
	}
	if _, err := DeliverWith(f, macos.FrontApp{PID: 42}, Payload{PNG: []byte("png")}, Options{}); err != nil {
		t.Fatal("纯图片也应可发")
	}
	WaitIdle()
}

type keyRecorder struct {
	*fake
	keys *[]uint16
}

func (k *keyRecorder) PostKey(code uint16, flags uint64) {
	*k.keys = append(*k.keys, code)
	k.fake.PostKey(code, flags)
}

// verifySys 模拟有 AXValue 的输入框与进程身份。
type verifySys struct {
	*fake
	value   string
	started int64
	paste   bool // ⌘V 是否真的改了输入框
}

func (v *verifySys) ProcessStartMs(int32) int64   { return v.started }
func (v *verifySys) FocusedValue() (string, bool) { return v.value, true }
func (v *verifySys) PostKey(code uint16, flags uint64) {
	if code == macos.KeyV && v.paste {
		v.value += "粘贴"
	}
	v.fake.PostKey(code, flags)
}

func TestDeliverVerifiesPasteAndLocksIdentity(t *testing.T) {
	v := &verifySys{fake: &fake{items: original(), activateOK: true, front: macos.FrontApp{PID: 1}}, started: 100, paste: true}
	if c, err := DeliverWith(v, macos.FrontApp{PID: 42}, Payload{Text: "x"}, Options{StartedMs: 100}); err != nil || c != CheckVerified {
		t.Fatalf("%v %v", c, err)
	}
	WaitIdle()
	v.paste = false
	if c, _ := DeliverWith(v, macos.FrontApp{PID: 42}, Payload{Text: "x"}, Options{}); c != CheckUnchanged {
		t.Fatalf("输入框没变应报 unchanged，实为 %v", c)
	}
	WaitIdle()
	n := len(v.fake.pasted)
	if _, err := DeliverWith(v, macos.FrontApp{PID: 42}, Payload{Text: "x"}, Options{StartedMs: 99}); err != ErrTargetChanged {
		t.Fatalf("进程身份变化必须中止：%v", err)
	}
	if len(v.fake.pasted) != n {
		t.Fatal("身份不符不得粘贴")
	}
	old := v.started
	v.started = 0 // 进程已退出：取不到启动时刻
	if _, err := DeliverWith(v, macos.FrontApp{PID: 42}, Payload{Text: "x"}, Options{StartedMs: 99}); err != ErrTargetExited || len(v.fake.pasted) != n {
		t.Fatalf("目标已退出必须中止且报 ErrTargetExited：%v", err)
	}
	v.started = old
}
