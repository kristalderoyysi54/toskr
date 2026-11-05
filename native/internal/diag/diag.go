// Package diag 写诊断日志（元数据，不含正文），格式与 Rust 版 toskr-diag.log 一致：
// 每行「<epoch ms> <消息>」，超 2MiB 轮转到 .1。
package diag

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	mu   sync.Mutex
	path string
)

func Init(dir string) { mu.Lock(); path = filepath.Join(dir, "toskr-diag.log"); mu.Unlock() }

func Push(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, "[toskr-native]", msg)
	mu.Lock()
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
	fmt.Fprintf(f, "%d %s\n", time.Now().UnixMilli(), msg)
	f.Close()
}
