package main

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/linkmeta"
	"github.com/toskr/native/internal/store"
)

func init() { // 视图测试一律不联网
	linkFetch = func(context.Context, string, string) (linkmeta.Meta, error) {
		return linkmeta.Meta{}, errors.New("测试不联网")
	}
}

// 链接预览：启动时已有的链接不抓；新加的链接卡、改了 URL 的卡自动抓并写回标题 / 图标；一小时前的旧卡（导入）不抓。
func TestLinkPreviewSweep(t *testing.T) {
	var mu sync.Mutex
	var got []string
	done := make(chan struct{}, 8)
	old := linkFetch
	defer func() { linkFetch = old }()
	linkFetch = func(_ context.Context, u, allow string) (linkmeta.Meta, error) {
		mu.Lock()
		got = append(got, u+"|"+allow)
		mu.Unlock()
		defer func() { done <- struct{}{} }()
		return linkmeta.Meta{Title: "标题 " + u, Icon: "data:image/png;base64,AAAA"}, nil
	}
	// 不挂 OnChange：真实应用经 panel.Update 回主线程 reload，这里由测试线程手动 reload，免得后台写回直接跑 reload
	st, err := store.OpenDir(t.TempDir(), bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	_, _, _ = st.Add(store.Note{Section: store.SectionInbox, Text: "https://before.com"})
	a := newApp(nopSys{}, st)
	a.permAX = true
	tt := ui.NewTester(a.panelView, 360, 720)
	wait := func() {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("应发起抓取")
		}
		time.Sleep(20 * time.Millisecond)
	}

	n, _, _ := a.store.Add(store.Note{Section: store.SectionInbox, Text: "github.com/egoist/mygo"})
	a.reload()
	if n.Kind != "link" || n.URL != "https://github.com/egoist/mygo" {
		t.Fatalf("裸域名应识别为链接 %+v", n)
	}
	wait()
	if cur, _ := a.store.Note(n.ID); cur.LinkTitle != "标题 https://github.com/egoist/mygo" || cur.LinkIcon == "" {
		t.Fatalf("应写回标题与图标 %+v", cur)
	}
	a.reload()
	tt.Frame()
	if !tt.HasText("标题 https://github.com/egoist/mygo") || !tt.HasText("github.com/egoist/mygo") {
		t.Fatalf("链接卡应显示标题与域名路径 %v", tt.Texts())
	}

	_ = a.store.Update(n.ID, "https://other.com/x")
	a.reload()
	if cur, _ := a.store.Note(n.ID); cur.LinkTitle != "" || cur.URL != "https://other.com/x" {
		t.Fatalf("改 URL 应清旧标题 %+v", cur)
	}
	wait()

	_, _, _ = a.store.Add(store.Note{Section: store.SectionInbox, Text: "https://imported.com", CreatedAt: time.Now().Add(-48 * time.Hour)})
	_ = a.store.Update(n.ID, "不再是链接")
	a.reload()
	if cur, _ := a.store.Note(n.ID); cur.Kind != "" || cur.URL != "" || cur.LinkTitle != "" {
		t.Fatalf("改成文字应退回文字卡 %+v", cur)
	}
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	if len(got) != 2 || got[0] != "https://github.com/egoist/mygo|" || got[1] != "https://other.com/x|" {
		t.Fatalf("只应抓新卡与新 URL，且自动抓取不放行内网：%v", got)
	}
	mu.Unlock()

	// 右键手动获取：已有标题也重抓，并放行该链接自己的 origin（同意对话框之后）
	imp, _ := a.store.Note(a.store.Section(store.SectionInbox)[0].ID)
	a.fetchLink(imp, true)
	wait()
	mu.Lock()
	defer mu.Unlock()
	if last := got[len(got)-1]; last != "https://imported.com|https://imported.com" {
		t.Fatalf("手动获取应放行本 origin：%v", got)
	}
}
