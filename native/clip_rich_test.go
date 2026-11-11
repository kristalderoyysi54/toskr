package main

import (
	"encoding/base64"
	"image/color"
	"testing"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 用户实机：复制图文混排（推推 / Chrome / 飞书），剪贴卡只剩「image_xxx.png」文件名——监听只读纯文本、丢了 HTML。
// 同 Tauri materializeRichCapture：带 <img> 的 HTML 入库前把图片本地化成图文块，文字与图片在同一张剪贴卡里。
func TestClipRichHTMLKeepsImages(t *testing.T) {
	a, _ := testApp(t)
	data := "data:image/png;base64," + base64.StdEncoding.EncodeToString(colorPNG(t, 8, 6, color.RGBA{200, 30, 30, 255}))
	html := `<p>一、数据填表支持千位符</p><img src="` + data + `" alt="image_6aeb095446a1c.png"><p>二、导出的文件命名</p><img src="` + data + `">`
	n, err := a.addClip(core.ClipEvent{Text: "一、数据填表支持千位符\nimage_6aeb095446a1c.png\n二、导出的文件命名", HTML: html,
		Source: macos.FrontApp{Name: "推推", BundleID: "com.tuitui"}})
	if err != nil {
		t.Fatal(err)
	}
	if n.Section != store.SectionClipboard || len(n.MediaFiles()) == 0 || !store.HasMixedContent(n.Blocks) {
		t.Fatalf("应存成图文剪贴卡 %+v", n)
	}
	if n.Text != "一、数据填表支持千位符\n二、导出的文件命名" {
		t.Fatalf("正文不应含图片文件名占位 %q", n.Text)
	}
	if n.Blocks[1].Type != "image" || n.Blocks[1].Alt != "image_6aeb095446a1c.png" {
		t.Fatalf("图片按原位置成块 %+v", n.Blocks)
	}
	// 没有 <img> 的 HTML 照旧纯文本
	plain, _ := a.addClip(core.ClipEvent{Text: "只有字", Source: macos.FrontApp{Name: "Chrome"}})
	if plain.Blocks != nil {
		t.Fatal("纯文字不应生成块")
	}
}
