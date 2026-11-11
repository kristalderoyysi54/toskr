package main

// colorPNG：纯色测试图（多图卡渲染 / 替换测试共用）。

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func colorPNG(t *testing.T, w, h int, c color.RGBA) []byte {
	m := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(m, m.Bounds(), &image.Uniform{c}, image.Point{}, draw.Src)
	var b bytes.Buffer
	_ = png.Encode(&b, m)
	return b.Bytes()
}

func addColorImages(t *testing.T, a *app, n int) []string {
	t.Helper()
	var fs []string
	for i := range n {
		f, err := a.store.SaveImage(colorPNG(t, 40+i*10, 30, color.RGBA{uint8(40 * i), 120, 200, 255}))
		if err != nil {
			t.Fatal(err)
		}
		fs = append(fs, f)
	}
	return fs
}

// 同 Tauri NoteCard：多图卡并排 3 张、第 3 张盖「+N」；图文卡正文下一排最多 4 张 +N，紧凑行显示「N图」。
func TestCardShowsMultipleImages(t *testing.T) {
	a, tt := testApp(t)
	fs := addColorImages(t, a, 5)
	_, _, _ = a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", Text: "图片 5 张", ImageFile: fs[0], Attachments: fs[1:]})
	_, _, _ = a.store.Add(store.Note{Section: store.SectionInbox, Text: "带五张图的说明", ImageFile: fs[0], Attachments: fs[1:]})
	tt.Frame()
	tt.Frame()
	for _, s := range []string{"图片 ×5", "+2", "图文 ×6", "带五张图的说明", "+1"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q %v", s, tt.Texts())
		}
	}
	st := a.store.Settings()
	st.CardDensity = "compact"
	_ = a.store.SetSettings(st)
	a.reload()
	tt.Frame()
	if !tt.HasText("5图") {
		t.Fatalf("紧凑行应显示张数 %v", tt.Texts())
	}
}

// 详情：图文卡底部缩略条点开第 2 张进看图层；打码 / 标注写回替换的是这一张（原位），撤销换回；Esc 回正文。
func TestDetailGalleryEditsCurrentImage(t *testing.T) {
	a, _ := testApp(t)
	fs := addColorImages(t, a, 3)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "三张图", ImageFile: fs[0], Attachments: fs[1:]})
	dt := detailTester(t, a, n)
	if r, ok := dt.Find("查看图片"); !ok || r.W != 48 {
		t.Fatalf("缺底部缩略条 %v %v", r, dt.Texts())
	}
	a.openDetailGallery(n, fs[1])
	dt.Frame()
	if !a.detail.gallery || a.detail.img != 1 || !dt.HasText("图片 2/3") || !dt.HasText("返回正文（Esc）") {
		t.Fatalf("应进看图层第 2 张 %v", dt.Texts())
	}
	if dt.HasText("添加文字备注") {
		t.Fatal("图文卡看图层不应出图片备注条")
	}
	a.replaceNoteImage(n, fs[1], colorPNG(t, 64, 48, color.RGBA{1, 2, 3, 255}), 64, 48, "已替换卡片里的图片")
	cur, _ := a.store.Note(n.ID)
	got := cur.MediaFiles()
	if len(got) != 3 || got[0] != fs[0] || got[1] == fs[1] || got[2] != fs[2] {
		t.Fatalf("应原位替换第 2 张 %v", got)
	}
	dt.Frame()
	if a.detail.fullFile != got[1] {
		t.Fatal("看图层应重载为新图")
	}
	a.hudUndo()
	if back, _ := a.store.Note(n.ID); back.MediaFiles()[1] != fs[1] {
		t.Fatal("撤销应换回原图")
	}
	dt.Key(0, ui.KeyEscape)
	dt.Frame()
	if a.detail.gallery || !dt.HasText("三张图") {
		t.Fatal("Esc 回到正文")
	}
}

// 混排卡编辑态（同 Tauri EditableRichImageBlock）：图片块「图片 N」头 + 查看 / 删除；单击选中出「发送选中」；
// 刚粘贴未保存的图被标注时只换草稿。
func TestDetailBlocksImageEditing(t *testing.T) {
	a, _ := testApp(t)
	fs := addColorImages(t, a, 2)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "甲", Blocks: []store.ContentBlock{{Type: "text", Text: "甲"}, {Type: "image", File: fs[0]}, {Type: "text", Text: "乙"}}})
	dt := detailTester(t, a, n)
	a.enterDetailEdit(n)
	dt.Frame()
	for _, s := range []string{"图片 1", "查看图片 1", "删除图片 1"} {
		if !dt.HasText(s) {
			t.Fatalf("缺 %q %v", s, dt.Texts())
		}
	}
	mustClick(t, dt, "选择图片 1")
	if a.detail.imgSel != 2 || !dt.HasText("发送选中") {
		t.Fatalf("单击应选中 %d %v", a.detail.imgSel, dt.Texts())
	}
	a.detail.blocks = append(a.detail.blocks, store.ContentBlock{Type: "image", File: fs[1]}) // 草稿里新粘贴、未保存
	a.replaceNoteImage(n, fs[1], colorPNG(t, 20, 20, color.RGBA{9, 9, 9, 255}), 20, 20, "已替换")
	if last := a.detail.blocks[len(a.detail.blocks)-1]; last.File == fs[1] || last.Width != 20 {
		t.Fatalf("草稿里那张应被替换 %+v", last)
	}
	mustClick(t, dt, "删除图片 1")
	if store.ImageBlocks(a.detail.blocks)[0] == fs[0] {
		t.Fatal("删除应移出草稿")
	}
}

// 图文卡与纯文字卡功能一致：编辑态某段文字划选出工具条，粗体 / 处理只改这一段；阅读态工具条与坞上「处理」改的是块（卡面跟着变）。
func TestMixedCardTextToolsMatchPlainText(t *testing.T) {
	a, _ := testApp(t)
	fs := addColorImages(t, a, 1)
	bs := []store.ContentBlock{{Type: "text", Text: "第一段 hello"}, {Type: "image", File: fs[0]}, {Type: "text", Text: "第二段 world"}}
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: store.TextFromBlocks(bs), Blocks: bs})
	dt := detailTester(t, a, n)
	a.enterDetailEdit(n)
	a.detail.blkSet = [3]int{3, 4, 9} // 第二段的「world」
	for range 4 {
		dt.Frame()
	}
	if !dt.HasText("已选 5 字") {
		t.Fatalf("图文卡编辑态划选应出工具条 %v", dt.Texts())
	}
	mustClick(t, dt, "粗体（⌘B）")
	if a.detail.blocks[2].Text != "第二段 **world**" || a.detail.blocks[0].Text != "第一段 hello" || a.detail.blocks[1].File != fs[0] {
		t.Fatalf("粗体只改当前段 %+v", a.detail.blocks)
	}
	dt.Frame()
	if a.detail.blkRange != [2]int{4, 13} {
		t.Fatalf("新选区留在结果上 %v", a.detail.blkRange)
	}
	if !a.commitDetailEdit(n) {
		t.Fatal("保存失败")
	}
	cur, _ := a.store.Note(n.ID)
	if cur.Blocks[2].Text != "第二段 **world**" {
		t.Fatalf("保存写回块 %+v", cur.Blocks)
	}
	// 阅读态：划词工具条改写（Store.Update）只改对应块
	_ = a.store.Update(n.ID, strings.Replace(cur.Text, "hello", "HELLO", 1))
	up, _ := a.store.Note(n.ID)
	if up.Blocks[0].Text != "第一段 HELLO" || up.Blocks[1].Type != "image" || up.Blocks[2].Text != "第二段 **world**" {
		t.Fatalf("阅读态改写应只改对应块 %+v", up.Blocks)
	}
	// 坞上整篇「处理」：逐块，图片不动
	bs2, _ := mapTextBlocks(up.Blocks, func(s string) (string, error) { return strings.ToUpper(s), nil })
	if bs2[0].Text != "第一段 HELLO" || bs2[2].Text != "第二段 **WORLD**" || bs2[1].File != fs[0] {
		t.Fatalf("逐块处理 %+v", bs2)
	}
}

// 卡片右键：多图 / 图文卡的「钉到屏幕 / 标注… / 图片打码…」按张选择。
func TestCardMenuImageToolsPerImage(t *testing.T) {
	a, tt := testApp(t)
	fs := addColorImages(t, a, 2)
	_, _, _ = a.store.Add(store.Note{Section: store.SectionInbox, Text: "两张图的说明", ImageFile: fs[0], Attachments: fs[1:2]})
	tt.Frame()
	_ = tt.RightClick("两张图的说明")
	menu := strings.Join(tt.Menu(), "|")
	for _, s := range []string{"钉到屏幕", "标注…", "图片打码…"} {
		if !strings.Contains(menu, s) {
			t.Fatalf("缺 %q %v", s, menu)
		}
	}
	var got string
	old := redactFileFn
	redactFileFn = func(_ *app, _ store.Note, f string) { got = f }
	t.Cleanup(func() { redactFileFn = old })
	if err := tt.ChooseMenuItem("图片打码…", "图片 2"); err != nil || got != fs[1] {
		t.Fatalf("应按张打码第 2 张 %v got=%q %v", err, got, tt.Menu())
	}
}

// 看图层给当前这张图写说明：↵ 保存（可撤销），翻页 / 返回自动保存，正文内嵌图下出图注。
func TestGalleryImageAlt(t *testing.T) {
	a, _ := testApp(t)
	fs := addColorImages(t, a, 2)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "两张图", ImageFile: fs[0], Attachments: fs[1:]})
	dt := detailTester(t, a, n)
	a.openDetailGallery(n, fs[1])
	dt.Frame()
	mustClick(t, dt, "添加图片说明")
	if !a.detail.altEdit {
		t.Fatal("应进入说明编辑")
	}
	dt.Type("报错截图")
	dt.Key(0, ui.KeyEnter)
	dt.Frame()
	cur, _ := a.store.Note(n.ID)
	if cur.AltOf(fs[1]) != "报错截图" || a.detail.altEdit || a.hudText != "已保存图片说明" {
		t.Fatalf("↵ 保存 %+v %q", cur.ImageAlts, a.hudText)
	}
	if !dt.HasText("报错截图") {
		t.Fatalf("页脚显示说明 %v", dt.Texts())
	}
	mustClick(t, dt, "图片说明：报错截图")
	a.detail.altDraft = "改过的说明"
	a.detailImageAt(cur, 0) // 翻页自动保存
	if c2, _ := a.store.Note(n.ID); c2.AltOf(fs[1]) != "改过的说明" || a.detail.altEdit {
		t.Fatalf("翻页应保存 %+v", c2.ImageAlts)
	}
	a.hudUndo()
	if c3, _ := a.store.Note(n.ID); c3.AltOf(fs[1]) != "报错截图" {
		t.Fatal("撤销回到上一版说明")
	}
	// 只读合并预览不可写
	a.detail.virt = &store.Note{}
	dt.Frame()
	if dt.HasText("添加图片说明") {
		t.Fatal("只读预览不应出写说明入口")
	}
}

// 同 Tauri 详情标题栏：晕光取分组色（关掉彩色通栏为中性灰，剪贴卡不取分组色）；剪贴卡有「存入笔记分组」。
func TestDetailAccentAndSaveToNotes(t *testing.T) {
	a, _ := testApp(t)
	sec := a.store.AddSection("工作")
	ss := a.store.Sections()
	for i := range ss {
		if ss[i].ID == sec {
			ss[i].Color = "#3b82f6"
			_ = a.store.UpdateSection(ss[i])
		}
	}
	n, _, _ := a.store.Add(store.Note{Section: sec, Text: "分组笔记"})
	if a.detailAccent(n) != hexColor("#3b82f6") {
		t.Fatal("应取分组色")
	}
	a.patchSettings(func(x *store.Settings) { x.CardTintOff = true })
	if a.detailAccent(n) != hexColor("#7c8494") {
		t.Fatal("关掉彩色通栏应为中性灰")
	}
	a.patchSettings(func(x *store.Settings) { x.CardTintOff = false })
	clip, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴内容"})
	dt := detailTester(t, a, clip)
	if _, ok := dt.Find("存入笔记分组"); !ok {
		t.Fatalf("剪贴卡应有存入笔记分组 %v", dt.Texts())
	}
	if err := dt.ChooseMenuItem("存入笔记分组", "工作"); err != nil {
		_ = dt.Click("存入笔记分组")
		if err := dt.ChooseMenuItem("工作"); err != nil {
			t.Fatalf("%v %v", err, dt.Menu())
		}
	}
	if moved, _ := a.store.Note(clip.ID); moved.Section != sec {
		t.Fatalf("应移入分组 %q", moved.Section)
	}
	dt.Frame()
	if _, ok := dt.Find("存入笔记分组"); ok {
		t.Fatal("移入后不再显示入口")
	}
}

// 图标主色同 Tauri dominant_color：彩色取主色并压暗，灰度图标给中性灰。
func TestDominantColor(t *testing.T) {
	if c := dominantColor(image.NewUniform(color.RGBA{255, 255, 255, 255})); c != ui.RGB(0x5b, 0x5b, 0x60) {
		t.Fatalf("灰度 %v", c)
	}
	m := image.NewRGBA(image.Rect(0, 0, 16, 16))
	draw.Draw(m, m.Bounds(), &image.Uniform{color.RGBA{240, 60, 60, 255}}, image.Point{}, draw.Src)
	c := dominantColor(m)
	r, g, b := c.R, c.G, c.B
	if r < 150 || g > 80 || b > 80 {
		t.Fatalf("红色图标主色 %v", c)
	}
}
