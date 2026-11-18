package store

import (
	"bytes"
	"testing"
	"time"
)

// 剪贴卡「收下」：复制一份进目标分组，原卡留在剪贴页、记下 SavedTo、不再按保留时长清理；撤销恢复原状。
func TestKeepClips(t *testing.T) {
	st, err := OpenDir(t.TempDir(), bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-40 * 24 * time.Hour)
	clip, _, _ := st.Add(Note{Section: SectionClipboard, Text: "发票抬头", CreatedAt: old, Kept: true})
	_ = st.SetKept(clip.ID, false)

	undo, copies := st.KeepClips([]string{clip.ID}, SectionInbox)
	if len(copies) != 1 || copies[0].Section != SectionInbox || copies[0].ID == clip.ID || copies[0].Text != "发票抬头" {
		t.Fatalf("应在收件箱生成一份副本：%+v", copies)
	}
	orig, _ := st.Note(clip.ID)
	if orig.Section != SectionClipboard || orig.SavedTo != copies[0].ID {
		t.Fatalf("原卡应留在剪贴页并指向副本：%+v", orig)
	}
	if got := st.SavedSection(orig); got != SectionInbox {
		t.Fatalf("SavedSection = %q", got)
	}
	// 再收一次不重复生成
	if _, again := st.KeepClips([]string{clip.ID}, SectionInbox); len(again) != 0 {
		t.Fatalf("已收下的卡不应再生成副本")
	}
	// 超过保留时长也不清理
	if n := st.PruneClipboard(30, nil, func() int64 { return time.Now().Unix() }); n != 0 {
		t.Fatalf("已收下的剪贴卡不应被清理，清了 %d", n)
	}
	// 副本归到别的分组后，小标跟着变
	sec := st.AddSection("报销")
	_ = st.MoveTo(copies[0].ID, sec)
	if got := st.SavedSection(orig); got != sec {
		t.Fatalf("副本移组后 SavedSection = %q", got)
	}
	undo()
	if _, ok := st.Note(copies[0].ID); ok {
		t.Fatal("撤销应删掉副本")
	}
	if orig, _ = st.Note(clip.ID); orig.SavedTo != "" {
		t.Fatal("撤销应清掉 SavedTo")
	}
	if n := st.PruneClipboard(30, nil, func() int64 { return time.Now().Unix() }); n != 1 {
		t.Fatalf("撤销后过期剪贴卡应照常清理，清了 %d", n)
	}
}

// 内容页那份被删：原卡恢复未收下——可重新收下，过期照常清理。
func TestKeepClipsCopyDeleted(t *testing.T) {
	st, err := OpenDir(t.TempDir(), bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	clip, _, _ := st.Add(Note{Section: SectionClipboard, Text: "旧剪贴", CreatedAt: time.Now().Add(-40 * 24 * time.Hour)})
	_, copies := st.KeepClips([]string{clip.ID}, SectionInbox)
	orig, _ := st.Note(clip.ID)
	// 内容页那份被删：原卡恢复未收下（可重新收下、照常清理）
	st.Delete(copies[0].ID)
	if got := st.SavedSection(orig); got != "" {
		t.Fatalf("副本删除后应视为未收下 %q", got)
	}
	_, again := st.KeepClips([]string{clip.ID}, SectionInbox)
	if len(again) != 1 {
		t.Fatal("副本删除后应能重新收下")
	}
	st.Delete(again[0].ID)
	if n := st.PruneClipboard(30, nil, func() int64 { return time.Now().Unix() }); n != 1 {
		t.Fatalf("副本删除后过期剪贴卡应照常清理，清了 %d", n)
	}
}
