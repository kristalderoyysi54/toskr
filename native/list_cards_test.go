package main

import (
	"image/color"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

func imageRowApp(t *testing.T, count int) (*app, *ui.Tester, store.Note) {
	a, tt := testApp(t)
	fs := addColorImages(t, a, count)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", Text: "图片", ImageFile: fs[0], Attachments: fs[1:]})
	a.reload()
	tt.Frame()
	tt.Frame()
	return a, tt, n
}

// 带图行点在图片上照样选中这一行。
func TestListStylesThumbClickSelects(t *testing.T) {
	a, tt, n := imageRowApp(t, 3)
	r, ok := tt.Find("拖出原图")
	if !ok {
		t.Fatalf("缺图片 %v", tt.Texts())
	}
	tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	if !a.chosen.Has(n.ID) {
		t.Fatal("点图片应选中这一行")
	}
}

// 笔记行整行是一个拖动源：抓图片拖起的也是这一行（出分组坞），不是另一种拖动。
func TestThumbDragLiftsRow(t *testing.T) {
	a, tt, n := imageRowApp(t, 1)
	r, ok := tt.Find("拖出原图")
	if !ok {
		t.Fatalf("缺图片 %v", tt.Texts())
	}
	x, y := r.X+r.W/2, r.Y+r.H/2
	tt.Move(x, y)
	tt.Press(x, y)
	for i := 1; i <= 4; i++ {
		tt.Move(x, y+float32(i)*6)
		tt.Frame()
	}
	if a.rowDragID != n.ID {
		t.Fatalf("抓图片应拖起这一行 drag=%q", a.rowDragID)
	}
	tt.Release(x, y+24)
	tt.Frame()
}

// 行高随内容变（纯文本短 < 多行 < 带图），不超过上限；图片在正文下面；带图带状态行时压矮图片而不是裁掉内容。
func TestCardStyleHeights(t *testing.T) {
	a, tt := testApp(t)
	fs := addColorImages(t, a, 2)
	short, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "短"})
	long, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行\n第九行"})
	pic, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "带图的说明", ImageFile: fs[0], Attachments: fs[1:]})
	_ = a.store.SetKept(pic.ID, true) // 有状态行
	a.reload()
	tt.Frame()
	tt.Frame()
	var ls [3]cardLayout
	for i, n := range []store.Note{short, long, pic} {
		n, _ = a.store.Note(n.ID)
		ls[i] = a.cardLayoutOf(buildCtx, n)
		if ls[i].h > ls[i].capH {
			t.Fatalf("超过上限 %v", ls[i].h)
		}
	}
	if !(ls[0].h < ls[1].h && ls[0].h < ls[2].h) {
		t.Fatalf("行高应随内容变 %v", ls)
	}
	if !tt.HasText("第三行") {
		t.Fatalf("外层应直接看到多行正文 %v", tt.Texts())
	}
	p := ls[2]
	if want := float32(cardPadY*2+cardHeadH) + 4 + float32(p.lines)*p.lineH + 8 + p.mediaH + cardStripGap + cardStripH + 6 + cardFootH; !p.foot || !p.strip || p.mediaH < cardHeroMin || want > p.capH {
		t.Fatalf("带图带状态行应完整放进上限 %+v 需 %v", p, want)
	}
	body, ok1 := tt.Find("带图的说明")
	img, ok2 := tt.Find("拖出原图")
	if !ok1 || !ok2 || img.Y <= body.Y {
		t.Fatalf("图片应在正文下面 body=%v img=%v", body, img)
	}
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
		for _, dark := range []bool{false, true} {
			tt.SetDark(dark)
			a.invalidateAll()
			tt.Frame()
			tt.Advance(time.Second)
			tt.Frame()
			save(t, filepath.Join(dir, "card-image-below-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), tt.Image())
		}
	}
}

// 图片区上限随面板宽放宽；小缩略排按宽度放，放不下的并进最后一格的 +N。
func TestCardMediaSizing(t *testing.T) {
	for _, c := range []struct{ w, want float32 }{{230, 132}, {300, 150}, {600, 220}} {
		if got := cardHeroCap(c.w); got != c.want {
			t.Fatalf("内宽 %v 图片上限 %v，应为 %v", c.w, got, c.want)
		}
	}
	if ws, rest := cardStripCells([]float32{1, 1, 1}, 230); len(ws) != 3 || rest != 0 || ws[0] != cardStripH {
		t.Fatalf("三张方图应全放下 %v %d", ws, rest)
	}
	if ws, rest := cardStripCells([]float32{2, 2, 2, 2, 2, 2}, 230); len(ws) != 4 || rest != 2 || ws[0] != 54 {
		t.Fatalf("六张宽图应放 4 格、余 2 张 %v %d", ws, rest)
	}
}

// 长图铺满宽只露顶部（底缘有暗影）；比例合适的图等比放全；多图卡大图下面有一排小缩略。
func TestCardLongImageAndStrip(t *testing.T) {
	a, tt := testApp(t)
	long, err := a.store.SaveImage(colorPNG(t, 200, 1600, color.RGBA{200, 80, 40, 255}))
	if err != nil {
		t.Fatal(err)
	}
	ln, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", Text: "长截图", ImageFile: long})
	fs := addColorImages(t, a, 3)
	multi, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", Text: "三张", ImageFile: fs[0], Attachments: fs[1:]})
	a.reload()
	tt.Frame()
	tt.Frame()
	w := a.cardInnerW(buildCtx)
	full := func(f string) float32 {
		iw, ih := ui.ImageSize(a.thumb(f))
		return w * float32(ih) / float32(iw)
	}
	l := a.cardLayoutOf(buildCtx, ln)
	if l.strip || l.mediaH < 120 || l.h > l.capH || !cardIsLong(full(long), l.mediaH) {
		t.Fatalf("长图：图片区接近上限、裁顶部、无小缩略排 %+v", l)
	}
	m := a.cardLayoutOf(buildCtx, multi)
	if !m.strip || cardIsLong(full(fs[0]), m.mediaH) || m.h > m.capH || m.capH != l.capH+cardStripGap+cardStripH {
		t.Fatalf("多图：有小缩略排、普通比例不裁 %+v", m)
	}
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
		for _, dark := range []bool{false, true} {
			tt.SetDark(dark)
			a.invalidateAll()
			tt.Frame()
			tt.Advance(time.Second)
			tt.Frame()
			save(t, filepath.Join(dir, "card-long-strip-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), tt.Image())
		}
	}
}

// 剪贴页悬停操作条与内容页同款：一个浮起的胶囊里排图标钮（按钮仍可点）。
func TestClipActionsPill(t *testing.T) {
	a, tt := testApp(t)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "剪贴的一段文字", SourceApp: "Safari"})
	a.switchPage(pageClip)
	a.reload()
	tt.Frame()
	r, ok := tt.Find("剪贴的一段文字")
	if !ok {
		t.Fatal(tt.Texts())
	}
	tt.Move(r.X+r.W/2, r.Y+r.H/2) // 只停 150ms：再久正文的提示气泡会出来盖住操作条
	tt.Frame()
	tt.Advance(150 * time.Millisecond)
	tt.Frame()
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
		for _, dark := range []bool{false, true} {
			tt.SetDark(dark)
			a.invalidateAll()
			tt.Frame()
			tt.Advance(150 * time.Millisecond)
			tt.Frame()
			save(t, filepath.Join(dir, "clip-actions-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), tt.Image())
		}
	}
	if err := tt.Click("置顶（固定不清理）"); err != nil {
		t.Fatalf("%v %v", err, tt.Texts())
	}
	if got, _ := a.store.Note(n.ID); !got.Kept {
		t.Fatal("点置顶应生效")
	}
}
