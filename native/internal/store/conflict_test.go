package store

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 外部修改检测：别的进程改了数据文件后，本机不再覆盖、进入只读；可重新加载磁盘版本，或先把内存另存为恢复点。
func TestExternalModificationConflict(t *testing.T) {
	dir := t.TempDir()
	key := bytes.Repeat([]byte{7}, 32)
	a, err := OpenDir(dir, key)
	if err != nil {
		t.Fatal(err)
	}
	_, _, _ = a.Add(Note{Section: SectionInbox, Text: "本机一"})
	if err := a.Flush(); err != nil {
		t.Fatal(err)
	}
	// 另一个实例打开同一目录并写入
	b, _ := OpenDir(dir, key)
	time.Sleep(20 * time.Millisecond)
	_, _, _ = b.Add(Note{Section: SectionInbox, Text: "别处写入"})
	if err := b.Flush(); err != nil {
		t.Fatal(err)
	}
	fired := false
	a.OnConflict = func() { fired = true }
	_, _, _ = a.Add(Note{Section: SectionInbox, Text: "本机二"})
	if err := a.Flush(); !errors.Is(err, ErrConflict) || !fired || !a.Conflict() {
		t.Fatalf("应检出冲突 err=%v fired=%v", err, fired)
	}
	if _, _, err := a.Add(Note{Section: SectionInbox, Text: "只读期间"}); !errors.Is(err, ErrReadOnly) {
		t.Fatal("冲突期间应只读", err)
	}
	if err := a.SetSettings(a.Settings()); !errors.Is(err, ErrReadOnly) && err != nil {
		t.Fatal(err)
	}
	p, err := a.SaveMemoryAsRecovery(time.Now())
	if err != nil || filepath.Dir(p) != filepath.Join(dir, "recovery") {
		t.Fatal(p, err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal(err)
	}
	if err := a.ReloadFromDisk(); err != nil {
		t.Fatal(err)
	}
	texts := map[string]bool{}
	for _, n := range a.Notes() {
		texts[n.Text] = true
	}
	if a.Conflict() || !texts["别处写入"] || texts["本机二"] {
		t.Fatalf("重新加载应拿到磁盘版本 %v", texts)
	}
	_, _, _ = a.Add(Note{Section: SectionInbox, Text: "恢复后可写"})
	if err := a.Flush(); err != nil {
		t.Fatal("重新加载后应可正常落盘", err)
	}
}

// 只读期间被拒的修改要经 OnError 报出来（UI 调用方多数忽略返回值）。
func TestReadOnlyRejectReportsError(t *testing.T) {
	dir := t.TempDir()
	key := bytes.Repeat([]byte{7}, 32)
	a, _ := OpenDir(dir, key)
	_, _, _ = a.Add(Note{Section: SectionInbox, Text: "一"})
	_ = a.Flush()
	time.Sleep(20 * time.Millisecond)
	now := time.Now()
	_ = os.Chtimes(filepath.Join(dir, DataFile), now, now)
	_, _, _ = a.Add(Note{Section: SectionInbox, Text: "二"})
	_ = a.Flush()
	var got []error
	a.OnError = func(err error) { got = append(got, err) }
	_, _, _ = a.Add(Note{Section: SectionInbox, Text: "三"})
	if len(got) != 1 || !errors.Is(got[0], ErrReadOnly) {
		t.Fatalf("应报 ErrReadOnly，得到 %v", got)
	}
}
