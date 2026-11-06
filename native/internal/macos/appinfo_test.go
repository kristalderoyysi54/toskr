//go:build darwin

package macos

import "testing"

func TestAppDisplayNameAndBundle(t *testing.T) {
	if got := BundleIDOfApp("/System/Applications/Calculator.app"); got != "com.apple.calculator" {
		t.Fatalf("bundle %q", got)
	}
	if got := AppDisplayName("com.apple.calculator"); got == "" {
		t.Fatal("应能取到显示名")
	}
	if BundleIDOfApp("/tmp/not-an-app") != "" || AppDisplayName("com.example.nope.zz") != "" {
		t.Fatal("不存在时返回空串")
	}
}
