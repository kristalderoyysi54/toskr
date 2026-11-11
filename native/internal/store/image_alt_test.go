package store

import (
	"strings"
	"testing"
	"time"
)

// 图片说明：主图 / 附件写 ImageAlts，图文块写块 Alt；随打码替换、移除、合并、撤销正确流转。
func TestImageAltLifecycle(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), nil)
	n, _, _ := s.Add(Note{Section: SectionInbox, Text: "x", ImageFile: "a.png", Attachments: []string{"b.png"}})
	prev, changed, err := s.SetImageAlt(n.ID, "b.png", "  登录页报错  ")
	got, _ := s.Note(n.ID)
	if err != nil || !changed || got.AltOf("b.png") != "登录页报错" || got.AltOf("a.png") != "" {
		t.Fatalf("%v %v %+v", err, changed, got.ImageAlts)
	}
	if _, changed, _ := s.SetImageAlt(n.ID, "nope.png", "x"); changed {
		t.Fatal("卡里没有的图不应写")
	}
	_, _ = s.ReplaceMediaFile(n.ID, "b.png", "z.png", 1, 1)
	if got, _ := s.Note(n.ID); got.AltOf("z.png") != "登录页报错" || got.AltOf("b.png") != "" {
		t.Fatalf("替换后说明跟着图走 %+v", got.ImageAlts)
	}
	s.RestoreContent(prev)
	if got, _ := s.Note(n.ID); got.AltOf("b.png") != "" || got.ImageAlts != nil {
		t.Fatalf("撤销应回到没有说明 %+v", got.ImageAlts)
	}
	_, _, _ = s.SetImageAlt(n.ID, "a.png", strings.Repeat("长", ImageAltMax+50))
	if got, _ := s.Note(n.ID); len([]rune(got.AltOf("a.png"))) != ImageAltMax {
		t.Fatal("超长应截断")
	}
	_, _ = s.RemoveImage(n.ID, "a.png")
	if got, _ := s.Note(n.ID); got.ImageAlts["a.png"] != "" {
		t.Fatal("移除图片应清掉说明")
	}

	bs := []ContentBlock{{Type: "text", Text: "上"}, {Type: "image", File: "m.png"}}
	m, _, _ := s.Add(Note{Section: SectionInbox, Text: "上", Blocks: bs})
	_, _, _ = s.SetImageAlt(m.ID, "m.png", "架构图")
	if got, _ := s.Note(m.ID); got.Blocks[1].Alt != "架构图" || got.ImageAlts != nil || bs[1].Alt != "" {
		t.Fatalf("图文块写块 Alt、不改调用方切片 %+v", got)
	}

	p1, _, _ := s.Add(Note{Section: SectionInbox, Kind: "image", Text: "图片 1×1", ImageFile: "p.png", CreatedAt: time.Now()})
	_, _, _ = s.SetImageAlt(p1.ID, "p.png", "第一张")
	merged, _, ok := s.Merge([]string{m.ID, p1.ID}, "\n\n")
	if !ok || merged.AltOf("p.png") != "第一张" || merged.AltOf("m.png") != "架构图" {
		t.Fatalf("合并带上说明 %+v %+v", merged.ImageAlts, merged.Blocks)
	}
}

func TestPasteStepSetting(t *testing.T) {
	if (Settings{}).PasteStep() != 350*time.Millisecond || (Settings{PasteStepMs: 1000}).PasteStep() != time.Second || (Settings{PasteStepMs: 7}).PasteStep() != 350*time.Millisecond {
		t.Fatal("档位")
	}
}
