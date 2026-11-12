package store

import "testing"

func mixed() []ContentBlock {
	return []ContentBlock{{Type: "text", Text: "第一段 hello"}, {Type: "image", File: "a.png"}, {Type: "text", Text: "第二段 world"}, {Type: "image", File: "b.png"}}
}

// 投影正文的改动映射回块：块内改动只动那一块，图片位置不变；跨块改动并到首块。
func TestSpliceBlocksText(t *testing.T) {
	bs := mixed()
	proj := TextFromBlocks(bs)
	for _, c := range []struct{ name, text, want0, want2 string }{
		{"首块内加粗", "第一段 **hello**\n第二段 world", "第一段 **hello**", "第二段 world"},
		{"次块内替换", "第一段 hello\n第二段 WORLD", "第一段 hello", "第二段 WORLD"},
		{"末尾追加", proj + "!", "第一段 hello", "第二段 world!"},
		{"开头插入", "# " + proj, "# 第一段 hello", "第二段 world"},
	} {
		got := SpliceBlocksText(bs, c.text)
		if TextFromBlocks(got) != c.text || got[0].Text != c.want0 || got[1].File != "a.png" || got[2].Text != c.want2 || got[3].File != "b.png" {
			t.Errorf("%s: %+v", c.name, got)
		}
	}
	cross := SpliceBlocksText(bs, "第一段 X world")
	if TextFromBlocks(cross) != "第一段 X world" || len(ImageBlocks(cross)) != 2 {
		t.Fatalf("跨块 %+v", cross)
	}
	if bs[0].Text != "第一段 hello" {
		t.Fatal("不应改动原块")
	}
	if b, l, ok := BlockAtRune(bs, 12); !ok || b != 2 || l != 2 { // 投影「第一段 hello\n第二段 world」第 12 字 = 第二段第 2 位
		t.Fatalf("BlockAtRune %d %d %v", b, l, ok)
	}
}

// Store.Update 对图文卡：块随之改，卡面（块）与投影正文一致。
func TestUpdateMixedCardUpdatesBlocks(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), nil)
	n, _, _ := s.Add(Note{Section: SectionInbox, Text: TextFromBlocks(mixed()), Blocks: mixed()})
	_ = s.Update(n.ID, "第一段 HELLO\n第二段 world")
	got, _ := s.Note(n.ID)
	if got.Blocks[0].Text != "第一段 HELLO" || got.Blocks[1].File != "a.png" || got.Text != "第一段 HELLO\n第二段 world" {
		t.Fatalf("%+v", got)
	}
}
