package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 冒充的辅助程序（能完成 hello 握手，但签名不是锁定的产物）必须被拒绝，且不发出请求。
func TestKeychainHelperRejectsImpostor(t *testing.T) {
	fake := filepath.Join(t.TempDir(), "fake-helper")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nprintf TSKKEY01\nexec cat >/dev/null\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, _, err := helperRequest(fake, "load", nil)
	if err == nil || !strings.Contains(err.Error(), "身份校验失败") {
		t.Fatalf("冒充者应被身份校验拒绝，得 %v", err)
	}
}
