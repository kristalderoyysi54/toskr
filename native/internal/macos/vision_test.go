//go:build darwin

package macos

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"
)

func TestOCRReadsRenderedText(t *testing.T) {
	small := image.NewRGBA(image.Rect(0, 0, 160, 24))
	draw.Draw(small, small.Bounds(), image.White, image.Point{}, draw.Src)
	d := font.Drawer{Dst: small, Src: image.NewUniform(color.Black), Face: basicfont.Face7x13, Dot: fixed.P(6, 17)}
	d.DrawString("TOSKR OCR 2026")
	big := image.NewRGBA(image.Rect(0, 0, 160*6, 24*6))
	draw.NearestNeighbor.Scale(big, big.Bounds(), small, small.Bounds(), draw.Src, nil)
	path := filepath.Join(t.TempDir(), "ocr.png")
	f, _ := os.Create(path)
	_ = png.Encode(f, big)
	f.Close()
	got, err := OCR(path, []string{"en-US"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToUpper(strings.NewReplacer(" ", "", "\n", "").Replace(got)), "TOSKROCR2026") {
		t.Fatalf("识别结果 %q", got)
	}
}

// 截图光标：替换 +[NSCursor crosshairCursor]，开关切换即时生效，关掉后回到系统光标。
func TestCrossCursorSwap(t *testing.T) {
	sys, _ := CrosshairCursor()
	img := image.NewRGBA(image.Rect(0, 0, 50, 50))
	img.Pix[0] = 255
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	if !InstallCrossCursor(buf.Bytes(), 25, 12) {
		t.Fatal("安装失败")
	}
	SetCrossCursor(true)
	cur, custom := CrosshairCursor()
	if cur != custom || custom == 0 {
		t.Fatalf("开：%x 应为自定义 %x", cur, custom)
	}
	SetCrossCursor(false)
	if cur, _ = CrosshairCursor(); cur != sys {
		t.Fatalf("关：%x 应回到系统 %x", cur, sys)
	}
}
