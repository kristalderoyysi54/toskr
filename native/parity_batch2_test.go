package main

import (
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/secretcodec"
	"github.com/toskr/native/internal/store"
)

// 同 Tauri TargetLensBar：目标未识别时头部给「重新识别发送目标」，点了采信前台应用。
func TestRefreshTargetButton(t *testing.T) {
	a, tt := testApp(t, "早上好")
	a.target = macos.FrontApp{}
	tt.Frame()
	mustClick(t, tt, "重新识别发送目标")
	if a.target.PID != 42 || a.target.Name != "Cursor" {
		t.Fatalf("应采信前台应用 %+v", a.target)
	}
	tt.Frame()
	if tt.HasText("重新识别发送目标") {
		t.Fatal("目标就绪后头部不再显示刷新钮（收进展开区）")
	}
}

// 同 Tauri removeKey：删除密钥先确认并说明会锁住几条秘文；取消不删；删默认密钥后改用剩下的第一把。
func TestRemoveSecretKeyConfirms(t *testing.T) {
	a, _ := testApp(t)
	st := a.store.Settings()
	st.SecretKeys = []store.SecretKey{{ID: "k1", Label: "小明"}, {ID: "k2", Label: "小红"}}
	st.SecretDefaultKeyID = "k1"
	_ = a.store.SetSettings(st)
	env, err := secretcodec.Seal("你好", "暗号", secretcodec.NormalizeStyle(""))
	if err != nil {
		t.Fatal(err)
	}
	if _, r := a.store.AddSecret(store.Secret{Text: env, KeyID: "k1", Direction: "out"}); r != "added" {
		t.Fatal(r)
	}
	var asked string
	answer := false
	old := secretKeyAsk
	secretKeyAsk = func(_, msg string) bool { asked = msg; return answer }
	t.Cleanup(func() { secretKeyAsk = old })
	a.confirmRemoveSecretKey(st.SecretKeys[0])
	waitFor(t, func() bool { return asked != "" })
	if !strings.Contains(asked, "有 1 条秘文用「小明」") {
		t.Fatalf("提示 %q", asked)
	}
	time.Sleep(20 * time.Millisecond)
	if len(a.store.Settings().SecretKeys) != 2 {
		t.Fatal("取消不应删除")
	}
	answer = true
	a.confirmRemoveSecretKey(st.SecretKeys[0])
	waitFor(t, func() bool { return len(a.store.Settings().SecretKeys) == 1 })
	if a.store.Settings().SecretDefaultKeyID != "k2" {
		t.Fatalf("默认密钥应改为剩下的 %q", a.store.Settings().SecretDefaultKeyID)
	}
}

// 换了目标、原临时方案暂停待确认：一律不发送（同 Tauri profileOverrideNeedsConfirmation），批量条发送置灰并说明。
func TestStaleProfileBlocksSend(t *testing.T) {
	a, tt := testApp(t, "早上好")
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor", BundleID: "com.todesktop.cursor"}
	a.selectTempProfile("safe")
	a.target = macos.FrontApp{PID: 43, Name: "Notes", BundleID: "com.apple.Notes"}
	a.send(a.store.Notes())
	if len(a.pending) != 0 || a.hudKind != "warn" || !strings.Contains(a.hudText, "原临时发送方案已暂停") {
		t.Fatalf("应拦下 %s %q", a.hudKind, a.hudText)
	}
	a.chosen.Add(a.store.Notes()[0].ID)
	tt.Frame()
	if !tt.HasText("发送不可用：原临时发送方案已暂停") {
		t.Fatalf("批量发送应置灰带原因 %v", tt.Texts())
	}
	a.tempFor = a.targetKey() // 确认沿用
	tt.Frame()
	if tt.HasText("发送不可用：原临时发送方案已暂停") {
		t.Fatal("确认后应恢复可发送")
	}
	time.Sleep(10 * time.Millisecond)
	if len(sys.sent()) != 0 {
		t.Fatal("拦下时不应投递")
	}
}

// 同 Tauri RETENTION_STEPS：最长 2 年 + 无限；旧数据不在档位上取不短于它的一档。
func TestRetentionSteps(t *testing.T) {
	if len(retentionSteps) != 23 || retentionSteps[len(retentionSteps)-2] != 730 || retentionSteps[len(retentionSteps)-1] != 0 {
		t.Fatalf("%v", retentionSteps)
	}
	for days, want := range map[int]string{0: "无限", 3: "3 天", 14: "2 周", 90: "3 个月", 365: "1 年", 730: "2 年"} {
		if got := retentionLabel(retentionSteps[retentionIndex(days)]); got != want {
			t.Errorf("%d → %q want %q", days, got, want)
		}
	}
	if retentionSteps[retentionIndex(10)] != 14 {
		t.Fatal("10 天应落到 2 周")
	}
}

// 同 Tauri billDefaultReminderOffsets：设置里改默认提醒，新建账单按它预选；可全部取消。
func TestBillDefaultRemind(t *testing.T) {
	a, _ := testApp(t)
	if got := a.store.Settings().BillDefaultRemind(); len(got) != 2 || got[0] != 3 || got[1] != 1 {
		t.Fatalf("默认 %v", got)
	}
	a.patchSettings(func(x *store.Settings) { x.BillRemind = []int{7, 0} })
	a.startConfirm(nil, false)
	if f := a.billForm.remind; len(f) != 2 || f[0] != 7 || f[1] != 0 {
		t.Fatalf("新建账单应预选设置值 %v", f)
	}
	a.patchSettings(func(x *store.Settings) { x.BillRemind = []int{} })
	if got := a.store.Settings().BillDefaultRemind(); got == nil || len(got) != 0 {
		t.Fatalf("空列表 = 不提醒，不能回落默认 %v", got)
	}
}

// 同 Tauri CrosshairColorRow：设置里改截图线条颜色与不透明度，截图遮罩取到新值。
func TestCrosshairSettingsRow(t *testing.T) {
	a, _ := testApp(t)
	a.openSettingsState()
	set := ui.NewTester(a.settingsView, 1040, 2400)
	a.setJump = "快捷键"
	set.Frame()
	set.Frame()
	if !set.HasText("截图线条颜色") {
		t.Fatalf("缺设置行 %v", set.Texts())
	}
	mustClick(t, set, "品红")
	if a.store.Settings().Shot.Crosshair != "magenta" {
		t.Fatal("应保存颜色")
	}
	if got := a.shotCross(); got != ui.RGBA(236, 72, 153, 0.7) {
		t.Fatalf("遮罩应用新颜色 %v", got)
	}
}
