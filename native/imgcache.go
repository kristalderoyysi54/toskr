package main

import (
	"fmt"
	"runtime"
	"runtime/debug"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
)

// 图片缓存按字节限额（最近最少使用的先丢）。此前卡片缩略图与详情大图各是一张只进不出的表：
// 翻过的每张图都留在内存里，图片多的库用几个小时就涨到一百多 MB。主线程使用，不加锁。

type imgEntry struct {
	img   ui.ImageSource
	bytes int
	used  uint64
}

type imgCache struct {
	budget int
	total  int
	tick   uint64
	m      map[string]*imgEntry
}

func newImgCache(budget int) *imgCache { return &imgCache{budget: budget, m: map[string]*imgEntry{}} }

// imgBytes：位图解码后的大小（RGBA）；nil（解码失败的占位）不占额度。
func imgBytes(img ui.ImageSource) int {
	if b, ok := img.(*ui.Bitmap); ok && b != nil {
		w, h := b.Size()
		return w * h * 4
	}
	return 0
}

func (c *imgCache) get(key string) (ui.ImageSource, bool) {
	e, ok := c.m[key]
	if !ok {
		return nil, false
	}
	c.tick++
	e.used = c.tick
	return e.img, true
}

// put 存入后超额就从最久没用的丢起；刚放进来的这张不丢（哪怕它一张就超额）。
func (c *imgCache) put(key string, img ui.ImageSource) {
	if old, ok := c.m[key]; ok {
		c.total -= old.bytes
	}
	c.tick++
	e := &imgEntry{img: img, bytes: imgBytes(img), used: c.tick}
	c.m[key] = e
	c.total += e.bytes
	c.shrink(c.budget, e)
}

// shrink：总量压到 limit 以内，从最久没用的丢起；keep（可为 nil）不丢。
func (c *imgCache) shrink(limit int, keep *imgEntry) {
	for c.total > limit {
		oldest := ""
		for k, x := range c.m {
			if x != keep && x.bytes > 0 && (oldest == "" || x.used < c.m[oldest].used) {
				oldest = k
			}
		}
		if oldest == "" {
			return
		}
		c.total -= c.m[oldest].bytes
		delete(c.m, oldest)
	}
}

func (c *imgCache) clear() { c.m, c.total = map[string]*imgEntry{}, 0 }

func (c *imgCache) len() int { return len(c.m) }

const (
	thumbBudget = 32 << 20 // 卡片缩略图：约 30 张 600×400
	bigBudget   = 48 << 20 // 详情窗内嵌大图；详情窗全关后清空
	trimDelay   = 20 * time.Second
)

// trimMemorySoon：面板收起 / 详情窗关闭后过一会儿（期间没再打开）把用不到的内存还给系统——
// 清掉详情大图（没有详情窗开着时）、缩略图只留四分之一额度，再让 Go 运行时归还空闲页。
func (a *app) trimMemorySoon() {
	a.trimGen++
	gen := a.trimGen
	time.AfterFunc(trimDelay, func() {
		a.onMain(func() {
			if gen != a.trimGen || (a.panel != nil && a.panel.IsVisible()) {
				return
			}
			a.trimMemory()
		})
	})
}

func (a *app) trimMemory() {
	if len(a.panes) == 0 {
		a.bigImgs.clear()
	}
	a.thumbs.shrink(a.thumbs.budget/4, nil)
	debug.FreeOSMemory()
	diag.Push("内存整理: %s", a.memLine())
}

// memLine：诊断用的一行内存概况。
func (a *app) memLine() string {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	mb := func(v uint64) float64 { return float64(v) / (1 << 20) }
	return fmt.Sprintf("Go 堆在用 %.0fMB · 向系统申请 %.0fMB · 已归还 %.0fMB · 缩略图 %d 张 %.0fMB · 详情大图 %d 张 %.0fMB · 应用图标 %d",
		mb(m.HeapInuse), mb(m.Sys), mb(m.HeapReleased), a.thumbs.len(), mb(uint64(a.thumbs.total)), a.bigImgs.len(), mb(uint64(a.bigImgs.total)), len(a.appIcons))
}
