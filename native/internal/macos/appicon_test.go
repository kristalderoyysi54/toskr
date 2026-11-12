//go:build darwin

package macos

import (
	"bytes"
	"image/png"
	"testing"
)

func TestAppIconPNG(t *testing.T) {
	b := AppIconPNG("com.apple.finder")
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil || img.Bounds().Dx() < 32 {
		t.Fatalf("Finder 图标应可解码 %v", err)
	}
	if AppIconPNG("com.example.not-installed") != nil || AppIconPNG("") != nil {
		t.Fatal("未安装 / 空 bundle 应返回 nil")
	}
}

func TestHeldModifiers(t *testing.T) {
	if HeldModifiers()&FlagCommand != 0 {
		t.Log("测试时恰好按着 ⌘")
	}
}
