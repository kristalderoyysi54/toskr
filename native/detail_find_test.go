package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

func longDoc() string {
	var b strings.Builder
	b.WriteString("# 接口约定\n\n分页参数 page_size 默认 20。\n\n")
	for i := 1; i <= 6; i++ {
		fmt.Fprintf(&b, "## 第 %d 节 一个特别特别长的小节标题用来检查大纲列表的单行截断\n\n", i)
		for j := 0; j < 5; j++ {
			fmt.Fprintf(&b, "这是第 %d 节的第 %d 段，说明 page_size 超限时返回 400 的处理方式，以及客户端应当如何重试。\n\n", i, j+1)
		}
		b.WriteString("- 列表项提到 Page_Size 一次\n- 另一项\n\n```\nGET /v1/notes?page_size=50\n```\n\n")
	}
	return b.String()
}

// 详情窗 ⌘F：命中计数、⏎ / ⇧⏎ 循环跳转并滚动到命中、Esc 先关查找栏不关窗；查找期间空格不关窗。
func TestDetailFind(t *testing.T) {
	a, _ := testApp(t, longDoc())
	n := a.store.Notes()[0]
	dt := detailTester(t, a, n)
	dt.Key(ui.Cmd, ui.KeyF)
	dt.Frame()
	if _, ok := dt.Find("文内查找"); !a.detail.findOn || !ok {
		t.Fatalf("⌘F 应打开查找栏 on=%v", a.detail.findOn)
	}
	dt.Type("page_size")
	for range 4 {
		dt.Frame()
	}
	want := strings.Count(strings.ToLower(longDoc()), "page_size")
	if a.detail.findTotal != want || a.detail.findCur != 0 || !dt.HasText(fmt.Sprintf("1 / %d", want)) {
		t.Fatalf("命中 %d，应为 %d；%v", a.detail.findTotal, want, dt.Texts())
	}
	for range 12 {
		dt.Key(0, ui.KeyEnter)
		dt.Frame()
	}
	for range 30 {
		dt.Advance(50_000_000)
		dt.Frame()
	}
	if a.detail.findCur != 12 || a.detail.scroll.Y < 200 {
		t.Fatalf("⏎ 应前进并滚到命中 cur=%d scroll=%v", a.detail.findCur, a.detail.scroll.Y)
	}
	dt.Key(ui.Shift, ui.KeyEnter)
	dt.Frame()
	if a.detail.findCur != 11 {
		t.Fatalf("⇧⏎ 应后退 %d", a.detail.findCur)
	}
	a.detail.findCur = want - 1
	a.stepDetailFind(1)
	if a.detail.findCur != 0 {
		t.Fatal("到末尾应回到第一个")
	}
	dt.Type(" ")
	dt.Frame()
	if a.detail.id != n.ID {
		t.Fatal("查找栏里按空格不应关窗")
	}
	dt.Key(0, ui.KeyEscape)
	dt.Frame()
	if a.detail.findOn || a.detail.id != n.ID || a.detail.findQuery != "" {
		t.Fatal("Esc 先关查找栏，不关窗")
	}
	// 没有命中
	a.openDetailFind()
	a.detail.findQuery = "不存在的词"
	for range 3 {
		dt.Frame()
	}
	if a.detail.findTotal != 0 || !dt.HasText("无结果") {
		t.Fatalf("%v", dt.Texts())
	}
	// 进编辑即收起查找
	a.detail.edit = true
	dt.Frame()
	if a.detail.findOn {
		t.Fatal("编辑态不保留查找栏")
	}
}

// 大纲：≥ 2 个标题才出现；悬停展开标题列表，点击滚到该节；进度线随滚动出现。
func TestDetailOutlineAndProgress(t *testing.T) {
	a, _ := testApp(t, longDoc(), "# 只有一个标题\n\n正文")
	notes := a.store.Notes()
	long, short := notes[0], notes[1]
	if strings.HasPrefix(long.Text, "# 只有") {
		long, short = short, long
	}
	dt := detailTester(t, a, short)
	dt.Frame()
	if len(a.detail.heads) != 1 {
		t.Fatalf("heads=%d", len(a.detail.heads))
	}
	if _, ok := dt.Find("大纲"); ok {
		t.Fatal("一个标题不出大纲")
	}
	dt = detailTester(t, a, long)
	dt.Frame()
	dt.Frame()
	if len(a.detail.heads) != 7 || a.detail.heads[0].level != 1 || a.detail.heads[1].level != 2 || a.detail.heads[3].y <= a.detail.heads[2].y {
		t.Fatalf("%+v", a.detail.heads)
	}
	ol, ok := dt.Find("大纲")
	if !ok {
		t.Fatalf("应有大纲 %v", dt.Texts())
	}
	shot := func(name string) {
		if dir := os.Getenv("TOSKR_SHOT_DIR"); dir != "" {
			for _, dark := range []bool{false, true} {
				dt.SetDark(dark)
				dt.Frame()
				save(t, filepath.Join(dir, name+"-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), dt.Image())
			}
			dt.SetDark(false)
		}
	}
	dt.Move(ol.X+ol.W/2, ol.Y+10)
	dt.Frame()
	dt.Frame()
	shot("detail-outline")
	if err := dt.Click("跳到：第 4 节 一个特别特别长的小节标题用来检查大纲列表的单行截断"); err != nil {
		t.Fatalf("%v %v", err, dt.Texts())
	}
	for range 40 {
		dt.Advance(50_000_000)
		dt.Frame()
	}
	if y := a.detail.scroll.Y; y < a.detail.heads[4].y-200 || y > a.detail.heads[4].y {
		t.Fatalf("应滚到第 4 节 scroll=%v head=%v", y, a.detail.heads[4].y)
	}
	if _, ok := dt.Find("阅读进度"); !ok || a.detail.scroll.MaxY <= 0 {
		t.Fatal("长文应有进度线")
	}
	dt.Move(100, 300)
	a.openDetailFind()
	a.detail.findQuery = "page_size"
	for range 4 {
		dt.Frame()
	}
	shot("detail-find")
}
