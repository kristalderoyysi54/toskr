package main

import (
	"image"
	"testing"

	"github.com/egoist/mygo/ui"
)

func bmp(w, h int) *ui.Bitmap { return ui.NewBitmap(image.NewRGBA(image.Rect(0, 0, w, h))) }

// 图片缓存按字节限额：超额从最久没用的丢起，刚放入的不丢；解码失败的 nil 占位不占额度也不被淘汰；shrink / clear。
func TestImgCacheBudget(t *testing.T) {
	c := newImgCache(3 * 100 * 100 * 4)
	c.put("a", bmp(100, 100))
	c.put("b", bmp(100, 100))
	c.put("bad", nil)
	c.put("c", bmp(100, 100))
	if _, ok := c.get("a"); !ok || c.total != 3*40000 { // 碰一下 a：b 成为最久没用
		t.Fatalf("total=%d", c.total)
	}
	c.put("d", bmp(100, 100))
	if _, ok := c.get("b"); ok || c.len() != 4 || c.total != 3*40000 {
		t.Fatalf("应丢掉最久没用的 b：len=%d total=%d", c.len(), c.total)
	}
	if img, ok := c.get("bad"); !ok || img != nil {
		t.Fatal("失败占位应保留（避免每帧重解）")
	}
	c.put("huge", bmp(400, 400)) // 一张就超额：其余全丢，自己留下
	if _, ok := c.get("huge"); !ok || c.total != 640000 || c.len() != 2 {
		t.Fatalf("len=%d total=%d", c.len(), c.total)
	}
	c.put("huge", bmp(10, 10)) // 同键覆盖：额度按新图算
	if c.total != 400 {
		t.Fatalf("total=%d", c.total)
	}
	c.put("x", bmp(100, 100))
	c.shrink(1000, nil)
	if _, ok := c.get("huge"); ok || c.total > 1000 { // 从最久没用的丢起：huge 先走，仍超额再丢 x
		t.Fatalf("shrink 应丢到限额内 total=%d", c.total)
	}
	c.clear()
	if c.len() != 0 || c.total != 0 {
		t.Fatal("clear")
	}
}

// 窄而长的图也要缩（此前只按宽度缩）；普通图照旧按宽 600。
func TestScaledThumbCapsHeight(t *testing.T) {
	if w, h := scaledThumb(image.NewRGBA(image.Rect(0, 0, 600, 20000))).Size(); h > thumbMaxH || w != 36 {
		t.Fatalf("长图 %d×%d", w, h)
	}
	if w, h := scaledThumb(image.NewRGBA(image.Rect(0, 0, 1800, 1200))).Size(); w != 600 || h != 400 {
		t.Fatalf("宽图 %d×%d", w, h)
	}
	if w, h := scaledThumb(image.NewRGBA(image.Rect(0, 0, 300, 200))).Size(); w != 300 || h != 200 {
		t.Fatalf("小图不放大 %d×%d", w, h)
	}
	if w, h := scaledThumb(image.NewRGBA(image.Rect(0, 0, 3000, 6000))).Size(); w != 600 || h != 1200 {
		t.Fatalf("大竖图 %d×%d", w, h)
	}
}

// 面板收起后的内存整理：详情窗全关时清掉内嵌大图，缩略图压到四分之一额度；有详情窗开着时大图保留。
func TestTrimMemory(t *testing.T) {
	a, _ := testApp(t)
	for i := range 40 {
		a.thumbs.put(itoa(i), bmp(600, 400))
	}
	if a.thumbs.total > thumbBudget {
		t.Fatalf("缩略图应受限额约束 %d", a.thumbs.total)
	}
	a.bigImgs.put("big", bmp(1040, 2000))
	a.panes = []*detailPane{{}}
	a.trimMemory()
	if a.bigImgs.len() != 1 || a.thumbs.total > thumbBudget/4 {
		t.Fatalf("有详情窗时保留大图；缩略图 %d", a.thumbs.total)
	}
	a.panes = nil
	a.trimMemory()
	if a.bigImgs.len() != 0 {
		t.Fatal("详情窗全关后应清掉大图")
	}
	if _, ok := a.thumbs.get("39"); !ok {
		t.Fatal("最近用过的缩略图应留着")
	}
}
