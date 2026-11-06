package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func open(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := OpenDir(dir, key)
	if err != nil {
		t.Fatal(err)
	}
	return s, dir
}

func TestSectionsDeleteMovesNotesToInbox(t *testing.T) {
	s, _ := open(t)
	id := s.AddSection("提示词")
	secs := s.Sections()
	if len(secs) != 3 || secs[1].ID != id || secs[2].ID != SectionClipboard {
		t.Fatalf("新分组应插在剪贴板之前: %+v", secs)
	}
	n, _, _ := s.Add(Note{Section: id, Text: "a"})
	if s.DeleteSection(SectionInbox) {
		t.Fatal("系统分组不可删")
	}
	if !s.DeleteSection(id) {
		t.Fatal("删除失败")
	}
	if got := s.Notes()[0]; got.ID != n.ID || got.Section != SectionInbox {
		t.Fatalf("组内笔记应回收件箱: %+v", got)
	}
}

func TestMergeUnmergeAndMoveToAt(t *testing.T) {
	s, _ := open(t)
	a, _, _ := s.Add(Note{Section: SectionInbox, Text: "a"})
	b, _, _ := s.Add(Note{Section: SectionInbox, Text: "b"})
	c, _, _ := s.Add(Note{Section: SectionInbox, Text: "c"})
	merged, orig, ok := s.Merge([]string{a.ID, c.ID}, "\n")
	if !ok || merged.Text != "a\nc" || len(s.Notes()) != 2 {
		t.Fatalf("合并失败 %+v", s.Notes())
	}
	if err := s.Unmerge(merged, orig); err != nil || len(s.Notes()) != 3 {
		t.Fatalf("撤销合并失败 %+v", s.Notes())
	}
	other := s.AddSection("x")
	_ = s.MoveToAt(b.ID, other, 0)
	_ = s.MoveToAt(a.ID, other, 0)
	var order []string
	for _, n := range s.Notes() {
		if n.Section == other {
			order = append(order, n.Text)
		}
	}
	if strings.Join(order, "") != "ab" {
		t.Fatalf("跨组插入位置错误: %v", order)
	}
	_ = s.MoveToAt(c.ID, other, 99)
	last := s.Notes()
	if last[len(last)-1].ID != c.ID {
		t.Fatal("pos 越界应放组尾")
	}
}

func TestDoneClearAndKeepAfterSend(t *testing.T) {
	s, _ := open(t)
	n, _, _ := s.Add(Note{Section: SectionInbox, Text: "x"})
	_ = s.MarkSent([]string{n.ID}, time.Now())
	if !s.Notes()[0].Done {
		t.Fatal("发送后应标记完成")
	}
	removed := s.ClearDone(SectionInbox)
	if len(removed) != 1 || len(s.Notes()) != 0 {
		t.Fatal("清理已完成失败")
	}
	_ = s.RestoreMany(removed)
	if len(s.Notes()) != 1 {
		t.Fatal("撤销清理失败")
	}
	lib := s.AddSection("提示词库")
	sec, _ := s.section(lib)
	sec.KeepAfterSend = true
	_ = s.UpdateSection(sec)
	m, _, _ := s.Add(Note{Section: lib, Text: "模板"})
	_ = s.MarkSent([]string{m.ID}, time.Now())
	for _, x := range s.Notes() {
		if x.ID == m.ID && x.Done {
			t.Fatal("KeepAfterSend 分组发送后不应完成")
		}
	}
}

func TestPruneClipboardKeepsPinned(t *testing.T) {
	s, _ := open(t)
	old, _, _ := s.Add(Note{Section: SectionClipboard, Text: "old"})
	kept, _, _ := s.Add(Note{Section: SectionClipboard, Text: "kept"})
	_ = s.SetKept(kept.ID, true)
	now := func() int64 { return old.CreatedAt.Unix() + 8*86400 }
	if got := s.PruneClipboard(7, nil, now); got != 1 {
		t.Fatalf("应清掉 1 条，实为 %d", got)
	}
	if len(s.Notes()) != 1 || s.Notes()[0].ID != kept.ID {
		t.Fatal("保留项不应被清理")
	}
}

func TestRecurringTaskSpawnsNextWithFreshChecklist(t *testing.T) {
	s, _ := open(t)
	due := time.Date(2026, 1, 31, 9, 0, 0, 0, time.Local)
	task := s.AddTask(Task{Text: "月报", DueAt: due, Recurrence: "monthly", Checklist: []ChecklistItem{{ID: "1", Text: "汇总", Done: true}}})
	next, spawned := s.CompleteTask(task.ID, true, due)
	if !spawned || !next.DueAt.Equal(time.Date(2026, 2, 28, 9, 0, 0, 0, time.Local)) {
		t.Fatalf("月末应钳制到 2/28: %v", next.DueAt)
	}
	if next.Checklist[0].Done {
		t.Fatal("下一期清单应重置")
	}
	for _, x := range s.Tasks() {
		if x.ID == task.ID && (!x.Checklist[0].Done || x.Recurrence != "") {
			t.Fatalf("本期清单不应被改、重复规则应移走: %+v", x)
		}
	}
	if got := s.DueForReminder(due.AddDate(0, 2, 0)); len(got) != 1 || got[0].ID != next.ID {
		t.Fatalf("应只提醒未完成的下一期: %+v", got)
	}
	if got := s.DueForReminder(due.AddDate(0, 2, 0)); len(got) != 0 {
		t.Fatal("同一任务不应重复提醒")
	}
}

func TestNextOccurrenceWeekdaysSkipsWeekend(t *testing.T) {
	fri := time.Date(2026, 11, 6, 9, 0, 0, 0, time.Local)
	if got := NextOccurrence(fri, "weekdays"); got.Weekday() != time.Monday {
		t.Fatalf("周五的下一个工作日应是周一: %v", got.Weekday())
	}
}

func TestParseQuickTask(t *testing.T) {
	now := time.Date(2026, 11, 5, 10, 0, 0, 0, time.Local)
	got := ParseQuickTask("明天下午3点 交周报 !!", now)
	want := time.Date(2026, 11, 6, 15, 0, 0, 0, time.Local)
	if got.Text != "交周报" || got.Priority != "mid" || !got.DueAt.Equal(want) {
		t.Fatalf("%+v", got)
	}
	if got := ParseQuickTask("买牛奶", now); !got.DueAt.IsZero() || got.Priority != "none" {
		t.Fatalf("无时间词不应设到期: %+v", got)
	}
	if got := ParseQuickTask("今天", now); got.Text != "" || got.DueAt.Hour() != 9 {
		t.Fatalf("只有日期默认 9 点: %+v", got)
	}
}

func TestBillsRollForwardAndRemind(t *testing.T) {
	s, _ := open(t)
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.Local)
	sub := s.AddBill(Bill{Kind: "subscription", Name: "云盘", Amount: 10, Cycle: "monthly", NextDueAt: time.Date(2026, 9, 1, 0, 0, 0, 0, time.Local)})
	card := s.AddBill(Bill{Kind: "creditCard", Name: "招行", Amount: 500, NextDueAt: time.Date(2026, 11, 8, 0, 0, 0, 0, time.Local)})
	if got := s.RollForward(now); got != 3 {
		t.Fatalf("9/1→10/1→11/1→12/1 应滚 3 期，实为 %d", got)
	}
	if SpentInMonth(s.Bills(), 2026, 10) != 10 {
		t.Fatal("10 月应记一笔自动扣费")
	}
	r := s.BillsToRemind(now)
	if len(r) != 1 || r[0].Bill.ID != card.ID || r[0].Days != 3 {
		t.Fatalf("信用卡应在提前 3 天提醒: %+v", r)
	}
	if len(s.BillsToRemind(now)) != 0 {
		t.Fatal("同一档位不应重复提醒")
	}
	_ = s.MarkPaid(card.ID, 0, now)
	for _, b := range s.Bills() {
		if b.ID == card.ID && (b.NextDueAt.Month() != 12 || len(b.Reminded) != 0) {
			t.Fatalf("还款后应推进到下期并清提醒档位: %+v", b)
		}
	}
	if MonthlyCost(s.Bills()) != 10 || sub.ID == "" {
		t.Fatal("月均只算活跃订阅")
	}
}

func TestMediaDedupEncryptedAndGC(t *testing.T) {
	s, dir := open(t)
	png := []byte("\x89PNG fake image bytes")
	a, err := s.SaveImage(png)
	b, _ := s.SaveImage(png)
	if err != nil || a != b {
		t.Fatal("同一图片应同名去重")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "media", a))
	if !Sealed(raw) {
		t.Fatal("媒体文件必须加密")
	}
	if got, _ := s.LoadImage(a); string(got) != string(png) {
		t.Fatal("读回不一致")
	}
	if _, err := s.LoadImage("../store.json"); err == nil {
		t.Fatal("必须拒绝路径穿越")
	}
	if s.GCMedia() != 1 {
		t.Fatal("无引用的媒体应被回收")
	}
}

func TestBackupRoundTripMergesAndWritesRecoveryPoint(t *testing.T) {
	s, dir := open(t)
	img, _ := s.SaveImage([]byte("img"))
	n, _, _ := s.Add(Note{Section: SectionInbox, Text: "备份前", ImageFile: img})
	s.AddTask(Task{Text: "任务"})
	path := filepath.Join(dir, "x.toskr-backup")
	man, err := s.ExportBackup(path)
	if err != nil || man.Counts["notes"] != 1 || len(man.Media) != 1 {
		t.Fatalf("%+v %v", man, err)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "备份前") {
		t.Fatal("备份内不得有明文")
	}
	s.Delete(n.ID)
	_, _, _ = s.Add(Note{Section: SectionInbox, Text: "本机新增"})
	_ = s.Flush()
	p, err := s.InspectBackup(path)
	if err != nil || p.New != 1 || p.Overlap != 0 || p.MissingMedia != 0 {
		t.Fatalf("预检 %+v %v", p, err)
	}
	added, err := s.ImportBackup(p)
	if err != nil || added != 1 || len(s.Notes()) != 2 {
		t.Fatalf("合并导入 added=%d err=%v notes=%d", added, err, len(s.Notes()))
	}
	if len(s.RecoveryPoints()) != 1 {
		t.Fatal("导入前应写恢复点")
	}
	raw[len(raw)/2] ^= 0xff
	bad := filepath.Join(dir, "bad.toskr-backup")
	_ = os.WriteFile(bad, raw, 0o600)
	if _, err := s.InspectBackup(bad); err == nil {
		t.Fatal("损坏的备份必须拒绝")
	}
}

func TestRecoveryPointsDedupRotateAndRestore(t *testing.T) {
	s, _ := open(t)
	base := time.Unix(1_800_000_000, 0)
	for i := range RecoveryKeep + 3 {
		_, _, _ = s.Add(Note{Section: SectionInbox, Text: strings.Repeat("x", i+1)})
		_ = s.Flush()
		if _, err := s.WriteRecoveryPoint("launch", base.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	if p, _ := s.WriteRecoveryPoint("launch", base.Add(time.Hour)); p != "" {
		t.Fatal("内容未变不应再写恢复点")
	}
	pts := s.RecoveryPoints()
	if len(pts) != RecoveryKeep {
		t.Fatalf("应只保留 %d 份，实为 %d", RecoveryKeep, len(pts))
	}
	if err := s.RestoreRecoveryPoint(pts[0]); err != nil {
		t.Fatal(err)
	}
	if got := len(s.Notes()); got != 4 {
		t.Fatalf("最早保留的恢复点应含 4 条，实为 %d", got)
	}
	if h := s.CheckHealth(); h.Notes != 4 || h.OrphanSectionRefs != 0 {
		t.Fatalf("%+v", h)
	}
}
