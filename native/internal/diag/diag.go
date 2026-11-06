// Package diag 写诊断日志（元数据，不含正文），格式与 Rust 版 toskr-diag.log 一致：
// 每行「<epoch ms> <消息>」，超 2MiB 轮转到 .1。
package diag

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	mu     sync.Mutex
	path   string
	recent []Entry // 最近事件（内存环，设置 → 诊断页显示）
	onPush func()  // 新事件回调（诊断页实时刷新）
)

// Entry 是一条诊断事件。
type Entry struct {
	At  time.Time
	Msg string
}

const keep = 200

// Recent 返回最近 n 条，新的在前。
func Recent(n int) []Entry {
	mu.Lock()
	defer mu.Unlock()
	out := make([]Entry, 0, min(n, len(recent)))
	for i := len(recent) - 1; i >= 0 && len(out) < n; i-- {
		out = append(out, recent[i])
	}
	return out
}

// OnPush 设置新事件回调（在 Push 的调用线程上执行，不持锁）。
func OnPush(fn func()) { mu.Lock(); onPush = fn; mu.Unlock() }

// Path 是日志文件路径。
func Path() string { mu.Lock(); defer mu.Unlock(); return path }

func remember(e Entry) {
	recent = append(recent, e)
	if len(recent) > keep {
		recent = append(recent[:0:0], recent[len(recent)-keep:]...)
	}
}

// Init 设定日志目录，并把文件末尾的事件读回内存环（重启后诊断页不至于空白）。
func Init(dir string) {
	mu.Lock()
	defer mu.Unlock()
	path = filepath.Join(dir, "toskr-diag.log")
	recent = nil
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	if len(raw) > 64<<10 {
		raw = raw[len(raw)-64<<10:]
	}
	for _, line := range strings.Split(string(raw), "\n") {
		ms, msg, ok := strings.Cut(line, " ")
		v, err := strconv.ParseInt(ms, 10, 64)
		if !ok || err != nil || v < 1e12 {
			continue
		}
		remember(Entry{time.UnixMilli(v), msg})
	}
}

func Push(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, "[toskr-native]", msg)
	now := time.Now()
	mu.Lock()
	remember(Entry{now, msg})
	hook := onPush
	if hook != nil {
		defer hook() // 在解锁之后执行（defer 先进后出）
	}
	defer mu.Unlock()
	if path == "" {
		return
	}
	if st, err := os.Stat(path); err == nil && st.Size() > 2<<20 {
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	fmt.Fprintf(f, "%d %s\n", now.UnixMilli(), msg)
	f.Close()
}
