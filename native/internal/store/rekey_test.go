package store

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// RekeyTo：整库换一把密钥写到新目录——内容、设置、图片都在，新密钥能开、旧密钥开不了；原目录不动；目标已有数据则拒绝。
func TestRekeyTo(t *testing.T) {
	k1, k2 := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	src := t.TempDir()
	s, err := OpenDir(src, k1)
	if err != nil {
		t.Fatal(err)
	}
	img, _ := s.SaveImage([]byte("假装是一张 PNG"))
	n, _, _ := s.Add(Note{Section: SectionInbox, Text: "带图的笔记", Kind: "image", ImageFile: img})
	sec := s.AddSection("资料")
	_, _, _ = s.Add(Note{Section: sec, Text: "分组里的"})
	task := s.AddTask(Task{Text: "任务", DurationMin: 45})
	s.AddBill(Bill{Kind: "subscription", Name: "云盘", Amount: 21, Cycle: "monthly"})
	d := s.AddDelivery(Delivery{TargetName: "Cursor", Status: "sent", SourceIDs: []string{n.ID}})
	st := s.Settings()
	st.PanelHotkey, st.KeyHintsOff, st.RemindersListID = "Ctrl+Alt+T", true, "list-1"
	_ = s.SetSettings(st)
	_ = os.WriteFile(filepath.Join(src, "toskr-im-message-watch.jsonl"), []byte("{}\n"), 0o600)
	_ = s.Flush()
	before, _ := os.ReadFile(filepath.Join(src, DataFile))

	dst := filepath.Join(t.TempDir(), "v1")
	info, err := s.RekeyTo(dst, k2)
	if err != nil || info.Notes != 2 || info.Tasks != 1 {
		t.Fatalf("%+v %v", info, err)
	}
	got, err := OpenDir(dst, k2)
	if err != nil {
		t.Fatal(err)
	}
	if x, ok := got.Note(n.ID); !ok || x.ImageFile != img || len(got.Notes()) != 2 || len(got.Sections()) != len(s.Sections()) {
		t.Fatalf("笔记与分组应带过来 %+v", got.Notes())
	}
	if raw, err := got.LoadImage(img); err != nil || string(raw) != "假装是一张 PNG" {
		t.Fatalf("图片应能用新密钥读出 %v", err)
	}
	if ts := got.Tasks(); len(ts) != 1 || ts[0].ID != task.ID || ts[0].DurationMin != 45 || len(got.Bills()) != 1 || got.Deliveries()[0].ID != d.ID {
		t.Fatal("任务 / 账单 / 发送记录")
	}
	if g := got.Settings(); g.PanelHotkey != "Ctrl+Alt+T" || !g.KeyHintsOff || g.RemindersListID != "list-1" {
		t.Fatalf("设置应带过来 %+v", g.PanelHotkey)
	}
	if _, err := os.Stat(filepath.Join(dst, "toskr-im-message-watch.jsonl")); err != nil {
		t.Fatal("消息账本应带过来")
	}
	if _, err := OpenDir(dst, k1); err == nil {
		t.Fatal("旧密钥不应能打开新目录")
	}
	if after, _ := os.ReadFile(filepath.Join(src, DataFile)); !bytes.Equal(before, after) {
		t.Fatal("原目录不应被改动")
	}
	if _, err := s.RekeyTo(dst, k2); err == nil {
		t.Fatal("目标已有数据应拒绝")
	}
	if _, err := s.RekeyTo(filepath.Join(src, "inner"), k2); err == nil {
		t.Fatal("目标不能在原目录里")
	}
}

// 旧版的剪贴板保留时长必须带过来（数字 / null = 永久 / 缺省 = 旧版默认 30 天），否则导入后第一次整理就会删历史；
// 正式版默认值同旧版。
func TestTauriClipRetentionCarriedOver(t *testing.T) {
	base := DefaultSettings()
	if base.ClipRetainDays != 7 || base.TriggerModifier != "option" {
		t.Fatalf("迭代期默认值 %d %s", base.ClipRetainDays, base.TriggerModifier)
	}
	for raw, want := range map[string]int{`90`: 90, `null`: 0, ``: 30, `3`: 3} {
		if got := applyTauriSettings(base, tauriSettings{ClipRetention: []byte(raw)}).ClipRetainDays; got != want {
			t.Fatalf("%q → %d，应为 %d", raw, got, want)
		}
	}
	forever := base
	forever.ClipRetainDays = 0
	if applyTauriSettings(forever, tauriSettings{}).ClipRetainDays != 0 {
		t.Fatal("本机设了永久保留时不缩短")
	}
	ReleaseDefaults = true
	defer func() { ReleaseDefaults = false }()
	if d := DefaultSettings(); d.ClipRetainDays != 30 || d.TriggerModifier != "shift" {
		t.Fatalf("正式版默认值应同旧版 %d %s", d.ClipRetainDays, d.TriggerModifier)
	}
}
