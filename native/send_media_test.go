package main

import (
	"slices"
	"sync"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// stepSys 记录每次写剪贴板是文字还是图片（多段粘贴的顺序）。
type stepSys struct {
	recSys
	smu   sync.Mutex
	steps []string
}

func (s *stepSys) Write(items []macos.Item, own bool) int {
	s.smu.Lock()
	if len(items) > 0 {
		if t := items[0][macos.TypeString]; len(t) > 0 {
			s.steps = append(s.steps, "T:"+string(t))
		} else if len(items[0][macos.TypePNG]) > 0 {
			s.steps = append(s.steps, "IMG")
		}
	}
	s.smu.Unlock()
	return s.recSys.Write(items, own)
}

func (s *stepSys) got() []string { s.smu.Lock(); defer s.smu.Unlock(); return slices.Clone(s.steps) }

func sendAndWait(t *testing.T, a *app, sys *stepSys, n store.Note, want int) []string {
	t.Helper()
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	st := a.store.Settings()
	st.FirewallOff = true // 只验证投递顺序，不走 OCR 预检
	_ = a.store.SetSettings(st)
	a.deliver([]store.Note{n}, false, "")
	waitFor(t, func() bool { return len(sys.got()) >= want })
	return sys.got()
}

// 图片卡写了文字备注：发送时文字与图片都发出去（同 Tauri buildDraft noteText = imageCaption），分两段粘贴。
func TestSendImageCardWithCaption(t *testing.T) {
	a, _ := testApp(t)
	sys := &stepSys{}
	a.sys = sys
	fs := addColorImages(t, a, 2)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", Text: "登录页设计稿", ImageFile: fs[0], Attachments: fs[1:]})
	got := sendAndWait(t, a, sys, n, 3)
	if !slices.Equal(got[:3], []string{"T:登录页设计稿", "IMG", "IMG"}) {
		t.Fatalf("应先文字再两张图 %v", got)
	}
}

// 占位标题不算文字：只发图片。
func TestSendImageCardPlaceholderOnlyImage(t *testing.T) {
	a, _ := testApp(t)
	sys := &stepSys{}
	a.sys = sys
	fs := addColorImages(t, a, 1)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Kind: "image", Text: "图片 40×30", ImageFile: fs[0]})
	got := sendAndWait(t, a, sys, n, 1)
	if len(got) < 1 || got[0] != "IMG" || slices.ContainsFunc(got, func(s string) bool { return s == "T:图片 40×30" }) {
		t.Fatalf("占位标题不应发出 %v", got)
	}
}

// 图文穿插的卡按块顺序交错粘贴（同 Tauri orderedSourceSegments）。
func TestSendMixedCardInterleaved(t *testing.T) {
	a, _ := testApp(t)
	sys := &stepSys{}
	a.sys = sys
	fs := addColorImages(t, a, 1)
	bs := []store.ContentBlock{{Type: "text", Text: "上文"}, {Type: "image", File: fs[0]}, {Type: "text", Text: "下文"}}
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: store.TextFromBlocks(bs), Blocks: bs})
	got := sendAndWait(t, a, sys, n, 3)
	if !slices.Equal(got[:3], []string{"T:上文", "IMG", "T:下文"}) {
		t.Fatalf("应按块顺序交错 %v", got)
	}
}

// 图片隐私检查覆盖卡里的每一张图（之前只查主图，其余图不经检查就发出去）。
func TestImagePreflightScansEveryImage(t *testing.T) {
	a, _ := testApp(t)
	fs := addColorImages(t, a, 3)
	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "三张图", ImageFile: fs[0], Attachments: fs[1:]})
	a.pending = []store.Note{n}
	a.pfScanImages()
	if len(a.pf.images) != 3 {
		t.Fatalf("应逐张检查 %d", len(a.pf.images))
	}
}

// 详情编辑态：点标题框输入，焦点不被正文编辑器抢走（之前正文每帧 Focus，标题写不进去）。
func TestDetailTitleEditable(t *testing.T) {
	a, _ := testApp(t, "正文内容")
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	a.enterDetailEdit(n)
	dt.Frame()
	dt.Frame()
	mustClick(t, dt, "笔记标题")
	dt.Type("周报")
	dt.Frame()
	if a.detail.title != "周报" || a.detailText != "正文内容" {
		t.Fatalf("标题应可输入 title=%q body=%q", a.detail.title, a.detailText)
	}
	_ = ui.KeyEnter
}
