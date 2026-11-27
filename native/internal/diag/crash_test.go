package diag

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"strings"
	"testing"
)

func crashHere() { panic("boom") }

// 真崩一次：子进程 panic 后堆栈落到 toskr-crash.log；下次启动在诊断日志记一行摘要，堆栈改名留档，新文件清空。
func TestCaptureCrash(t *testing.T) {
	if dir := os.Getenv("TOSKR_DIAG_CRASH_DIR"); dir != "" {
		Init(dir)
		CaptureCrash()
		crashHere()
	}
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestCaptureCrash$")
	cmd.Env = append(os.Environ(), "TOSKR_DIAG_CRASH_DIR="+dir)
	if err := cmd.Run(); err == nil {
		t.Fatal("子进程应当崩溃退出")
	}
	p := filepath.Join(dir, crashName)
	if raw, _ := os.ReadFile(p); !strings.Contains(string(raw), "panic: boom") {
		t.Fatalf("堆栈没落盘：%q", raw)
	}
	Init(dir)
	CaptureCrash()
	t.Cleanup(func() { _ = debug.SetCrashOutput(nil, debug.CrashOptions{}) })
	got := Recent(1)
	if len(got) != 1 || !strings.HasPrefix(got[0].Msg, "上次异常退出：panic: boom") || !strings.Contains(got[0].Msg, " @ crash_test.go:") {
		t.Fatalf("诊断日志摘要不对：%+v", got)
	}
	if raw, _ := os.ReadFile(p + ".prev"); !strings.Contains(string(raw), "panic: boom") {
		t.Fatal("旧堆栈应改名留档")
	}
	if raw, err := os.ReadFile(p); err != nil || len(raw) != 0 {
		t.Fatalf("新的崩溃文件应为空：%q %v", raw, err)
	}
	CaptureCrash() // 没崩过：不重复记
	if n := len(Recent(10)); n != 1 {
		t.Fatalf("正常退出后不该再记摘要，共 %d 条", n)
	}
}
