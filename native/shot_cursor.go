package main

import (
	"bytes"
	"image/png"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
)

// 截图光标（同 Tauri CROSS_CURSOR，参照 iShot）：中心留空的细十字，黑线白边，中心一个小点；25pt，热点在中心。
const shotCursorPt = 25

func shotCursorPNG() []byte {
	img := ui.Render(func(c *ui.Context) {
		c.Root().Background(ui.Transparent)
		ui.Box(c).Fill().Draw(func(p *ui.Painter, r ui.Rect) {
			// 四段臂：(12.5,1)–(12.5,9)、(12.5,16)–(12.5,24) 及横向对称；白 3pt 方头描边垫底、黑 1pt 压上
			arms := func(w float32, col ui.Color) {
				h := w / 2
				for _, s := range [][2]float32{{1, 9}, {16, 24}} {
					p.Fill(ui.Rect{X: 12.5 - h, Y: s[0] - h, W: w, H: s[1] - s[0] + w}, col, 0)
					p.Fill(ui.Rect{X: s[0] - h, Y: 12.5 - h, W: s[1] - s[0] + w, H: w}, col, 0)
				}
			}
			arms(3, colWhite)
			arms(1, colBlack)
			p.Fill(ui.Rect{X: 12.5 - 1.4, Y: 12.5 - 1.4, W: 2.8, H: 2.8}, colWhite, 1.4)
			p.Fill(ui.Rect{X: 12.5 - 0.6, Y: 12.5 - 0.6, W: 1.2, H: 1.2}, colBlack, 0.6)
		})
	}, shotCursorPt, shotCursorPt, 2)
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// setShotCursor：截图遮罩开着时把系统十字换成截图光标（首次调用时安装）。
func setShotCursor(on bool) {
	if on && !macos.InstallCrossCursor(shotCursorPNG(), shotCursorPt, 12) {
		diag.Push("截图光标安装失败，沿用系统十字")
	}
	macos.SetCrossCursor(on)
}
