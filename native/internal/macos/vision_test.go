//go:build darwin

package macos

import (
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
