package store

import (
	"bytes"
	"strings"
	"testing"
)

// 同 Tauri sanitizeNoteTags：最多 8 个、每个 24 字、大小写不敏感去重、去前导 #。
func TestSetTagsLimits(t *testing.T) {
	s, err := OpenDir(t.TempDir(), bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	n, _, _ := s.Add(Note{Section: SectionInbox, Text: "x"})
	tags := []string{"##Go", "go", strings.Repeat("长", 30)}
	for i := 0; i < 10; i++ {
		tags = append(tags, "t"+string(rune('a'+i)))
	}
	_ = s.SetTags(n.ID, tags)
	got, _ := s.Note(n.ID)
	if len(got.Tags) != TagMaxCount || got.Tags[0] != "Go" || len([]rune(got.Tags[1])) != TagMaxLength {
		t.Fatalf("%q", got.Tags)
	}
}
