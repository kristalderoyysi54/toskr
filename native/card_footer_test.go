package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 同 Tauri NoteCard 页脚：标签 #chip（最多 3 个 +N）；含词典占位符时「含 N 处化名 · 点击恢复」；回复卡「来自发送结果」/ 来源缺失警示。
func TestCardFooterParity(t *testing.T) {
	a, tt := testApp(t)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "带标签的笔记", SourceApp: "Safari"})
	_ = a.store.SetTags(n.ID, []string{"工作", "周报", "AI", "复盘"})
	tt.Frame()
	for _, s := range []string{"#工作", "#周报", "#AI", "+1", "Safari"} { // 来源应用在通栏上，页脚只留标签
		if !tt.HasText(s) {
			t.Fatalf("缺 %q %v", s, tt.Texts())
		}
	}
	_ = a.addAliasEntity("USER", "张三")
	ph := a.store.Settings().AliasEntities[0].Placeholder
	m, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "请 " + ph + " 处理"})
	tt.Frame()
	mustClick(t, tt, "含 1 处化名 · 点击恢复")
	if got, _ := a.store.Note(m.ID); got.Text != "请 张三 处理" {
		t.Fatalf("点击恢复化名 %q", got.Text)
	}
	src, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "源卡"})
	d := a.store.AddDelivery(store.Delivery{TargetName: "ChatGPT", Status: "sent", SourceIDs: []string{src.ID}})
	reply, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "回复内容"})
	a.store.LinkResult(d.ID, reply.ID)
	tt.Frame()
	if !tt.HasText("来自发送结果") {
		t.Fatalf("回复卡页脚 %v", tt.Texts())
	}
	a.store.Delete(src.ID)
	tt.Frame()
	if !tt.HasText("发送结果 · 来源缺失") {
		t.Fatalf("来源缺失应提示 %v", tt.Texts())
	}
}

// 剪贴票据头：命名过显示标题、非纯文本显示类型徽标，点击就地重命名。
func TestClipTicketTitle(t *testing.T) {
	a, tt := testApp(t)
	fs := addColorImages(t, a, 2)
	c1, _, _ := a.store.Add(store.Note{Section: store.SectionClipboard, Text: "图文剪贴", ImageFile: fs[0], Attachments: fs[1:]})
	a.page = pageClip
	a.reload()
	tt.Frame()
	tt.Frame()
	if !tt.HasText("图文 ×3") {
		t.Fatalf("类型徽标 %v", tt.Texts())
	}
	mustClick(t, tt, "图文 ×3")
	if a.titleEditID != c1.ID {
		t.Fatal("点击应进入重命名")
	}
}

// 紧凑行：命名卡「标题 — 摘要」；完成卡弱化不报错。
func TestCompactRowTitle(t *testing.T) {
	a, tt := testApp(t)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "正文摘要"})
	_ = a.store.SetTitle(n.ID, "周报")
	st := a.store.Settings()
	st.CardDensity = "compact"
	_ = a.store.SetSettings(st)
	a.reload()
	tt.Frame()
	if !tt.HasText("周报 — 正文摘要") {
		t.Fatalf("紧凑行标题 %v", tt.Texts())
	}
}

// 笔记卡信息层级（同 Tauri NoteCard）：通栏写自定义标题或类型；页脚常驻——左来源 / 标签 / 状态，右时间；
// 发过的卡带「已发送 ×N」，失败的发送不计数。
func TestNoteCardHeaderHierarchy(t *testing.T) {
	a, tt := testApp(t)
	plain, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "一段纯文本", SourceApp: "Microsoft Remote Desktop Beta"})
	titled, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "带标题的卡", SourceApp: "Cursor"})
	_ = a.store.SetTitle(titled.ID, "周五对比报告")
	_, _, _ = a.store.Add(store.Note{Section: store.SectionInbox, Text: "SELECT id FROM notes WHERE section = 'inbox' ORDER BY created_at DESC;", SourceApp: "Arc", Kind: "code", CodeLang: "sql"})
	bare, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "没有来源的卡"})
	_, _ = a.store.SetSendCount(plain.ID, 12) // 页脚次数读永久计数（发送成功 MarkSent +1）
	a.store.AddDelivery(store.Delivery{TargetName: "Cursor", Status: "failed", SourceIDs: []string{bare.ID}})
	_ = a.store.SetTags(plain.ID, []string{"报告", "周会", "复盘", "归档"})
	a.reload()
	tt.Frame()
	for _, s := range []string{"文本", "周五对比报告", "来自 Cursor", "来自 Arc", "已发送 ×12", "刚刚", "#报告", "+1"} {
		if !tt.HasText(s) {
			t.Fatalf("缺 %q %v", s, tt.Texts())
		}
	}
	if _, ok := tt.Find("Microsoft Remote Desktop Beta"); ok {
		t.Fatalf("来源不上通栏 %v", tt.Texts())
	}
	if n, _ := a.store.Note(bare.ID); n.SendCount != 0 {
		t.Fatal("失败的发送不计数")
	}
	if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
		for _, dark := range []bool{false, true} {
			v := ui.NewTester(a.panelView, 320, 700)
			v.SetDark(dark)
			v.Frame()
			v.Frame()
			save(t, filepath.Join(dir, "card-a-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), v.Image())
		}
	}
}
