package store

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 旧 JSON 备份（同 Tauri runLegacyJsonImport）：合并导入，本机已有 ID 跳过，分组失联的卡落收件箱，先写恢复点。
func TestLegacyJSONImport(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenDir(dir, bytes.Repeat([]byte{3}, 32))
	have, _, _ := s.Add(Note{Section: SectionInbox, Text: "本机已有"})
	_ = s.Flush()
	js := `{"sections":[{"id":"s1","name":"旧分组"}],
	"notes":[{"id":"n1","text":"旧卡一","sectionId":"s1","createdAt":1700000000000},
	         {"id":"n2","text":"失联分组","sectionId":"gone"},
	         {"id":"` + have.ID + `","text":"同 ID 不覆盖"}],
	"taskSections":[{"id":"t1","name":"旧任务组"}],
	"tasks":[{"id":"k1","text":"旧任务","sectionId":"t1"}],
	"settings":{"theme":"dark"}}`
	path := filepath.Join(dir, "old.json")
	_ = os.WriteFile(path, []byte(js), 0o600)
	p, err := s.InspectBackup(path)
	if err != nil {
		t.Fatal(err)
	}
	if p.Manifest.Format != LegacyJSONFormat || p.New != 2 || p.Overlap != 1 || p.Manifest.Counts["tasks"] != 1 {
		t.Fatalf("预览不对 %+v", p)
	}
	n, err := s.ImportBackup(p)
	if err != nil || n != 2 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	got := map[string]Note{}
	for _, x := range s.Notes() {
		got[x.ID] = x
	}
	if got["n1"].Section != "s1" || got["n2"].Section != SectionInbox || got[have.ID].Text != "本机已有" {
		t.Fatalf("合并结果不对 %+v", got)
	}
	if len(s.Tasks()) != 1 || len(s.RecoveryPoints()) == 0 {
		t.Fatal("任务没并进来或没写恢复点")
	}
}

func TestLegacyJSONRejectsBadShape(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenDir(dir, bytes.Repeat([]byte{3}, 32))
	for js, want := range map[string]string{
		`{"notes":{"id":"x"}}`:           "notes 必须是对象数组",
		`{"notes":[{"id":"x"}]}`:         "缺少 id/text",
		`{"sections":[{"name":"无 id"}]}`: "缺少 id/name",
		`{"settings":[1]}`:               "settings 必须是对象",
		`not json`:                       "不是有效的备份文件",
	} {
		path := filepath.Join(dir, "bad.json")
		_ = os.WriteFile(path, []byte(js), 0o600)
		if _, err := s.InspectBackup(path); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s → %v，应含 %q", js, err, want)
		}
	}
}

// Tauri 迁移保险档：TSK1 Recovery 信封，合并时同一笔记取较新一侧、分组名称以保险档为准。
func TestTauriSnapshotImport(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenDir(dir, bytes.Repeat([]byte{3}, 32))
	old, _, _ := s.Add(Note{Section: SectionInbox, Text: "本机旧版"})
	newer, _, _ := s.Add(Note{Section: SectionInbox, Text: "本机新版"})
	_ = s.Flush()
	tkey := bytes.Repeat([]byte{9}, 32)
	state := `{"state":{"sections":[{"id":"inbox","name":"历史收件箱"}],"notes":[` +
		`{"id":"` + old.ID + `","text":"保险档较新","sectionId":"inbox","createdAt":1,"updatedAt":` + "9999999999999" + `},` +
		`{"id":"` + newer.ID + `","text":"保险档较旧","sectionId":"inbox","createdAt":1,"updatedAt":2},` +
		`{"id":"h1","text":"只在保险档","sectionId":"inbox","createdAt":1}]},"version":16}`
	bag, _ := json.Marshal(map[string]string{"toskr": state})
	sealed, err := Seal(tkey, PurposeRecovery, bag)
	if err != nil {
		t.Fatal(err)
	}
	tdir := t.TempDir()
	path := filepath.Join(tdir, "recovery", "pre-encrypt-1.bak")
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	_ = os.WriteFile(path, sealed, 0o600)
	if _, err := s.InspectTauriSnapshot(path, tdir, bytes.Repeat([]byte{1}, 32)); err == nil {
		t.Fatal("密钥不对应失败")
	}
	p, err := s.InspectTauriSnapshot(path, tdir, tkey)
	if err != nil || p.New != 1 || p.Overlap != 2 {
		t.Fatalf("p=%+v err=%v", p, err)
	}
	if n, err := s.ImportBackup(p); err != nil || n != 1 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	got := map[string]string{}
	for _, x := range s.Notes() {
		got[x.ID] = x.Text
	}
	if got[old.ID] != "保险档较新" || got[newer.ID] != "本机新版" || got["h1"] != "只在保险档" {
		t.Fatalf("%v", got)
	}
	for _, x := range s.Sections() {
		if x.ID == SectionInbox && x.Name != "历史收件箱" {
			t.Fatalf("分组名应取保险档 %q", x.Name)
		}
	}
}
