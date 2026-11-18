package main

import (
	"testing"

	"github.com/toskr/native/internal/store"
)

// 5 种列表样式都能渲染；带图行点在缩略图上（拖出源）照样选中这一行；样式不认识时回落到默认「卡片 · 图文左右」。
func TestListStylesThumbClickSelects(t *testing.T) {
	for _, style := range append(slices2(listStyles), "bogus") {
		a, tt := testApp(t)
		a.patchSettings(func(s *store.Settings) { s.NoteListStyle = style })
		fs := addColorImages(t, a, 3)
		n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", Text: "图片 3 张", ImageFile: fs[0], Attachments: fs[1:]})
		a.reload()
		tt.Frame()
		tt.Frame()
		r, ok := tt.Find("拖出原图")
		if !ok {
			t.Fatalf("%s：缺缩略图 %v", style, tt.Texts())
		}
		tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
		tt.Frame()
		if !a.chosen.Has(n.ID) {
			t.Fatalf("%s：点缩略图应选中这一行", style)
		}
		if style == "bogus" && a.listStyle() != listSide {
			t.Fatal("未知样式应回落到图文左右")
		}
	}
}

func slices2(s []string) []string { return append([]string(nil), s...) }

// 卡片样式：行高随内容变（纯文本短 < 多行 < 带图），且不超过上限；分组窗口化按同一个高度走。
func TestCardStyleHeights(t *testing.T) {
	for _, style := range []string{listCard, listSide, listHero} {
		a, tt := testApp(t)
		a.patchSettings(func(s *store.Settings) { s.NoteListStyle = style })
		fs := addColorImages(t, a, 2)
		short, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "短"})
		long, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行\n第九行"})
		pic, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "带图的说明", ImageFile: fs[0], Attachments: fs[1:]})
		a.reload()
		tt.Frame()
		tt.Frame()
		var hs [3]float32
		for i, n := range []store.Note{short, long, pic} {
			n, _ = a.store.Note(n.ID)
			hs[i] = a.cardLayoutOf(buildCtx, n, cardStyleFor(n, style)).h
			if hs[i] > cardMaxH {
				t.Fatalf("%s：超过上限 %v", style, hs[i])
			}
		}
		if !(hs[0] < hs[1] && hs[0] < hs[2]) {
			t.Fatalf("%s：行高应随内容变 %v", style, hs)
		}
		if !tt.HasText("第三行") && style != listHero {
			t.Fatalf("%s：外层应直接看到多行正文 %v", style, tt.Texts())
		}
	}
}
