package store

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// MergeInto：迭代期数据并入正式版那份（另一把密钥）——只补目标没有的、同一条取较新的、同名分组对上、相同剪贴不重复；
// 预览不写盘；可反复执行；目标那边删掉的不再带回；目标的设置与源数据都不动。
func TestMergeInto(t *testing.T) {
	k1, k2 := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	dst := filepath.Join(t.TempDir(), "v1")
	rel, _ := OpenDir(dst, k2)
	relSec := rel.AddSection("提示词")
	shared, _, _ := rel.Add(Note{Section: relSec, Text: "两边都有 · 正式版旧稿"})
	_ = rel.SetDone(shared.ID, true)
	_, _, _ = rel.Add(Note{Section: SectionClipboard, Text: "相同的剪贴"})
	relOnly, _, _ := rel.Add(Note{Section: SectionInbox, Text: "只在正式版"})
	st := rel.Settings()
	st.PanelHotkey = "Ctrl+Alt+R"
	_ = rel.SetSettings(st)
	_ = rel.Flush()

	src, _ := OpenDir(t.TempDir(), k1)
	if _, err := src.MergeInto(filepath.Join(t.TempDir(), "空"), k2, true); err == nil {
		t.Fatal("目标没有数据应拒绝")
	}
	devSec := src.AddSection("提示词") // 同名、不同 ID
	newSec := src.AddSection("只在迭代期的组")
	img, _ := src.SaveImage([]byte("假装是一张 PNG"))
	a, _, _ := src.Add(Note{Section: devSec, Text: "迭代期新增", Kind: "image", ImageFile: img})
	b, _, _ := src.Add(Note{Section: newSec, Text: "新组里的"})
	_, _, _ = src.Add(Note{Section: SectionClipboard, Text: "相同的剪贴"})
	_, _, _ = src.Add(Note{Section: SectionClipboard, Text: "新的剪贴 · 置顶", Kept: true})
	_, _, _ = src.Add(Note{Section: SectionClipboard, Text: "没置顶的剪贴"})
	_, _, _ = src.Add(Note{ID: shared.ID, Section: devSec, Text: "两边都有 · 迭代期新稿", CreatedAt: shared.CreatedAt, UpdatedAt: time.Now().Add(time.Hour)})
	task := src.AddTask(Task{Text: "迭代期的任务"})
	_ = src.Flush()
	before, _ := os.ReadFile(filepath.Join(src.dir, DataFile))
	relBefore, _ := os.ReadFile(filepath.Join(dst, DataFile))

	pre, err := src.MergeInto(dst, k2, false)
	if err != nil || pre.Notes != 3 || pre.Clips != 1 || pre.ClipSkip != 1 || pre.Updated != 1 || pre.ClipDup != 1 || pre.Sections != 1 || pre.Tasks != 1 || pre.Media != 1 {
		t.Fatalf("预览 %+v %v", pre, err)
	}
	time.Sleep(PersistDelay + 200*time.Millisecond) // 等过延迟落盘
	if now, _ := os.ReadFile(filepath.Join(dst, DataFile)); !bytes.Equal(now, relBefore) {
		t.Fatal("预览不该写目标")
	}
	rep, err := src.MergeInto(dst, k2, true)
	if err != nil || rep.Notes != 3 || rep.Recovery == "" || rep.Media != 1 {
		t.Fatalf("并入 %+v %v", rep, err)
	}
	got, err := OpenDir(dst, k2)
	if err != nil {
		t.Fatal(err)
	}
	if x, ok := got.Note(a.ID); !ok || x.Section != relSec {
		t.Fatalf("同名分组应对到正式版那个组 %+v", x)
	}
	if x, ok := got.Note(b.ID); !ok || x.Section != newSec {
		t.Fatal("新分组连同里面的卡带过去")
	}
	if x, _ := got.Note(shared.ID); x.Text != "两边都有 · 迭代期新稿" || x.Section != relSec || !x.Done {
		t.Fatalf("同一条取较新的，分组与完成状态以正式版为准 %+v", x)
	}
	if _, ok := got.Note(relOnly.ID); !ok || len(got.Section(SectionClipboard)) != 2 || len(got.Notes()) != 6 {
		t.Fatalf("正式版原有的都在、相同剪贴不重复：共 %d", len(got.Notes()))
	}
	if raw, err := got.LoadImage(img); err != nil || string(raw) != "假装是一张 PNG" {
		t.Fatalf("图片应能用正式版密钥读出 %v", err)
	}
	if ts := got.Tasks(); len(ts) != 1 || ts[0].ID != task.ID || got.Settings().PanelHotkey != "Ctrl+Alt+R" {
		t.Fatal("任务带过去，正式版设置不动")
	}
	if len(got.RecoveryPoints()) != 1 {
		t.Fatal("并入前应在目标留恢复点")
	}
	if now, _ := os.ReadFile(filepath.Join(src.dir, DataFile)); !bytes.Equal(now, before) {
		t.Fatal("源数据不该变")
	}

	// 正式版删掉一条 → 再并一次：不带回，也没有别的可并
	if _, _, ok := got.Delete(a.ID); !ok {
		t.Fatal("删除失败")
	}
	_ = got.Flush()
	again, err := src.MergeInto(dst, k2, true)
	if err != nil || !again.Empty() || again.Gone != 1 || again.Recovery != "" {
		t.Fatalf("再次并入应为空且不带回已删的 %+v %v", again, err)
	}
	// 迭代期又新增一条 → 只带这一条
	c, _, _ := src.Add(Note{Section: SectionInbox, Text: "后来新增的"})
	third, err := src.MergeInto(dst, k2, true)
	if err != nil || third.Notes != 1 {
		t.Fatalf("%+v %v", third, err)
	}
	fin, _ := OpenDir(dst, k2)
	if _, ok := fin.Note(c.ID); !ok || len(fin.Notes()) != 6 {
		t.Fatalf("最终 %d 条", len(fin.Notes()))
	}
}
