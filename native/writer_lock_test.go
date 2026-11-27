package main

import (
	"strings"
	"testing"
)

// 同一个数据目录第二次占锁失败并说出持有者；放开后可以再占。
func TestWriterLock(t *testing.T) {
	dir := t.TempDir()
	unlock, err := lockDataDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lockDataDir(dir); err == nil || !strings.Contains(err.Error(), "Toskr Native（pid ") {
		t.Fatalf("第二次应失败并指出持有者 %v", err)
	}
	unlock()
	again, err := lockDataDir(dir)
	if err != nil {
		t.Fatalf("放开后应能再占 %v", err)
	}
	again()
}
