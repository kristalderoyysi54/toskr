package store

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var key = bytes.Repeat([]byte{7}, 32)

func TestEnvelopeRoundTripAndPurposeBinding(t *testing.T) {
	sealed, err := Seal(key, PurposeData, []byte(`{"a":1}`))
	if err != nil || !Sealed(sealed) {
		t.Fatal(err)
	}
	if got, err := Open(key, PurposeData, sealed); err != nil || string(got) != `{"a":1}` {
		t.Fatalf("%s %v", got, err)
	}
	if _, err := Open(key, PurposeRecovery, sealed); err != ErrCorrupt {
		t.Fatal("用途标签不同必须解不开")
	}
	sealed[len(sealed)-1] ^= 1
	if _, err := Open(key, PurposeData, sealed); err != ErrCorrupt {
		t.Fatal("篡改必须解不开")
	}
	if _, err := Seal(key[:16], PurposeData, nil); err != ErrKey {
		t.Fatal("错误长度的密钥应报密钥错误")
	}
}

func TestPersistedFileIsEncryptedAndReloads(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenDir(dir, key)
	if _, _, err := s.Add(Note{Section: SectionInbox, Text: "机密内容"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, DataFile)); err == nil {
		t.Fatal("落盘应延迟合并，不应同步写")
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, DataFile))
	if !Sealed(raw) || bytes.Contains(raw, []byte("机密内容")) {
		t.Fatal("磁盘上不得有明文")
	}
	info, _ := os.Stat(filepath.Join(dir, DataFile))
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("权限应为 0600，实为 %v", info.Mode().Perm())
	}
	again, err := OpenDir(dir, key)
	if err != nil || len(again.Notes()) != 1 || again.Notes()[0].Text != "机密内容" {
		t.Fatalf("重载失败 %v", err)
	}
	if _, err := OpenDir(dir, bytes.Repeat([]byte{8}, 32)); err != ErrCorrupt {
		t.Fatal("换钥必须显式报错，不能返回空队列")
	}
}

func TestAddDedupesWithinSectionAndMovesToTop(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), key)
	a, _, _ := s.Add(Note{Section: SectionInbox, Text: "A"})
	s.Add(Note{Section: SectionInbox, Text: "B"})
	again, dup, _ := s.Add(Note{Section: SectionInbox, Text: "A"})
	if !dup || again.ID != a.ID {
		t.Fatal("同分组同正文应去重并保留原 ID")
	}
	if got := s.Section(SectionInbox); got[0].Text != "A" || len(got) != 2 {
		t.Fatalf("%+v", got)
	}
	if _, dup, _ := s.Add(Note{Section: SectionClipboard, Text: "A"}); dup {
		t.Fatal("跨分组不去重")
	}
	if _, _, err := s.Add(Note{Section: SectionInbox, Text: "  \n"}); err == nil {
		t.Fatal("空白内容应拒绝")
	}
}

func TestDeleteRestoreKeepsPosition(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), key)
	for _, x := range []string{"c", "b", "a"} {
		s.Add(Note{Section: SectionInbox, Text: x})
	}
	mid := s.Notes()[1]
	n, pos, ok := s.Delete(mid.ID)
	if !ok || pos != 1 || len(s.Notes()) != 2 {
		t.Fatal("删除失败")
	}
	s.Restore(n, pos)
	if s.Notes()[1].ID != mid.ID {
		t.Fatal("撤销应回到原位")
	}
}

func TestReorderOnlyTouchesSection(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), key)
	s.Add(Note{Section: SectionInbox, Text: "i1"})
	s.Add(Note{Section: SectionClipboard, Text: "c1"})
	s.Add(Note{Section: SectionInbox, Text: "i2"})
	inbox := s.Section(SectionInbox) // i2, i1
	if err := s.Reorder(SectionInbox, []string{inbox[1].ID, inbox[0].ID}); err != nil {
		t.Fatal(err)
	}
	all := s.Notes()
	if all[0].Text != "i1" || all[1].Text != "c1" || all[2].Text != "i2" {
		t.Fatalf("%v", []string{all[0].Text, all[1].Text, all[2].Text})
	}
	if s.Reorder(SectionInbox, []string{inbox[0].ID}) != nil || s.Section(SectionInbox)[0].Text != "i1" {
		t.Fatal("ID 集合不匹配时不得改动")
	}
}

func TestClipboardTrimKeepsKept(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), key)
	kept, _, _ := s.Add(Note{Section: SectionClipboard, Text: "keep"})
	s.SetKept(kept.ID, true)
	for i := 0; i < ClipboardLimit+5; i++ {
		s.Add(Note{Section: SectionClipboard, Text: time.Duration(i).String()})
	}
	clip := s.Section(SectionClipboard)
	if len(clip) != ClipboardLimit+1 {
		t.Fatalf("应保留上限 %d + 置顶 1，实为 %d", ClipboardLimit, len(clip))
	}
	if s.ClearSection(SectionClipboard) != ClipboardLimit || len(s.Section(SectionClipboard)) != 1 {
		t.Fatal("清空应保留置顶项")
	}
}

func TestSearchAndMoveAndMarkSent(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), key)
	n, _, _ := s.Add(Note{Section: SectionClipboard, Text: "Hello 世界", SourceApp: "Safari"})
	if len(Search(s.Notes(), "世界")) != 1 || len(Search(s.Notes(), "safari")) != 1 || len(Search(s.Notes(), "zzz")) != 0 {
		t.Fatal("搜索")
	}
	s.MoveTo(n.ID, SectionInbox)
	s.MarkSent([]string{n.ID}, time.Unix(5, 0))
	got := s.Section(SectionInbox)
	if len(got) != 1 || got[0].SentAt.Unix() != 5 {
		t.Fatalf("%+v", got)
	}
}

func TestDebouncedPersistCoalescesWrites(t *testing.T) {
	old := PersistDelay
	PersistDelay = 50 * time.Millisecond
	defer func() { PersistDelay = old }()
	dir := t.TempDir()
	s, _ := OpenDir(dir, key)
	for i := 0; i < 100; i++ {
		s.Add(Note{Section: SectionInbox, Text: time.Duration(i).String()})
	}
	time.Sleep(200 * time.Millisecond)
	again, err := OpenDir(dir, key)
	if err != nil || len(again.Notes()) != 100 {
		t.Fatalf("后台合并落盘后应可完整重载，实为 %d %v", len(again.Notes()), err)
	}
}
