package diag

import (
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
)

const crashName = "toskr-crash.log"

// CaptureCrash：进程崩溃（没被恢复的 panic / 运行时致命错误）时把堆栈另写到日志目录的 toskr-crash.log——
// `open` 拉起的应用 stderr 没人接，Go 的 panic 也不产生系统崩溃报告，不留这份就无从查起。
// 上次留下的堆栈先在诊断日志记一行摘要，文件改名 .prev 留档。须在 Init 之后调用。
func CaptureCrash() {
	p := filepath.Join(filepath.Dir(Path()), crashName)
	if raw, err := os.ReadFile(p); err == nil && len(raw) > 0 {
		_ = os.Rename(p, p+".prev")
		Push("上次异常退出：%s（堆栈见 %s.prev）", crashSummary(string(raw)), crashName)
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return
	}
	_ = debug.SetCrashOutput(f, debug.CrashOptions{}) // 运行时自己复制描述符，这里可以关
	f.Close()
}

// crashSummary：崩溃原因那一行 + 堆栈里第一处本项目源码位置（文件名:行号）。
func crashSummary(dump string) string {
	var reason, at string
	for _, line := range strings.Split(dump, "\n") {
		if reason == "" && (strings.HasPrefix(line, "panic: ") || strings.HasPrefix(line, "fatal error: ")) {
			reason = line
		}
		if at == "" && strings.HasPrefix(line, "\t") && strings.Contains(line, "toskr/native/") {
			at, _, _ = strings.Cut(filepath.Base(strings.TrimSpace(line)), " ")
		}
	}
	if reason == "" {
		reason = "原因未知"
	}
	if r := []rune(reason); len(r) > 160 {
		reason = string(r[:160]) + "…"
	}
	if at != "" {
		reason += " @ " + at
	}
	return reason
}
