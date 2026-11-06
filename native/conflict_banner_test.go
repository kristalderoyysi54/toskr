package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/toskr/native/internal/store"
)

// 数据文件被外部修改：面板出现只读横幅；「另存恢复副本后重新加载」先存恢复点再读回磁盘版本，横幅消失。
func TestConflictBannerReloads(t *testing.T) {
	a, tt := testApp(t, "本机原有")
	if err := a.store.Flush(); err != nil {
		t.Fatal(err)
	}
	other, err := store.OpenDir(a.store.Dir(), bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	_, _, _ = other.Add(store.Note{Section: store.SectionInbox, Text: "别处写入"})
	if err := other.Flush(); err != nil {
		t.Fatal(err)
	}
	_, _, _ = a.store.Add(store.Note{Section: store.SectionInbox, Text: "本机未落盘"})
	_ = a.store.Flush()
	tt.Frame()
	if !tt.HasText("数据只读：检测到数据文件被外部修改") {
		t.Fatalf("应出现只读横幅 %v", tt.Texts())
	}
	if err := tt.Click("另存恢复副本后重新加载"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.store.Conflict() || tt.HasText("数据只读：检测到数据文件被外部修改") {
		t.Fatal("重新加载后应解除只读")
	}
	if !tt.HasText("别处写入") || tt.HasText("本机未落盘") {
		t.Fatalf("应显示磁盘版本 %v", tt.Texts())
	}
	baks, _ := filepath.Glob(filepath.Join(a.store.Dir(), "recovery", "*-conflict.bak"))
	if len(baks) != 1 {
		t.Fatalf("应另存一个恢复副本 %v", baks)
	}
	if fi, _ := os.Stat(baks[0]); fi.Size() == 0 {
		t.Fatal("恢复副本为空")
	}
}

// 只读期间的修改被拒时出 warn 气泡（主程序把 store.OnError 接到 storeError）。
func TestReadOnlyEditWarns(t *testing.T) {
	a, _ := testApp(t, "一")
	a.store.OnError = a.storeError
	_ = a.store.Flush()
	time.Sleep(20 * time.Millisecond)
	now := time.Now()
	_ = os.Chtimes(filepath.Join(a.store.Dir(), store.DataFile), now, now)
	_, _, _ = a.store.Add(store.Note{Section: store.SectionInbox, Text: "二"})
	_ = a.store.Flush()
	_, _, _ = a.store.Add(store.Note{Section: store.SectionInbox, Text: "三"})
	if a.hudKind != "warn" || a.hudText != "数据只读，修改未保存：请先在面板顶部重新加载磁盘版本" {
		t.Fatalf("%s %q", a.hudKind, a.hudText)
	}
}
