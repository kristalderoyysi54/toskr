package main

import (
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/shot"
)

// 长截屏 / 识别文字 / 图内翻译的入口（后续阶段实现）。

func (a *app) shotStartLong(c *ui.Context, d *shotDisplay) {
	if len(d.ed.hist.Shapes) > 0 {
		d.ed.flash(c, tr("长截屏不保留标注，请先撤销标注"))
		return
	}
	d.ed.flash(c, tr("长截屏开发中"))
}

func (a *app) shotRunOCR(c *ui.Context, d *shotDisplay) { d.ed.flash(c, tr("识别文字开发中")) }

func (a *app) shotTranslate(c *ui.Context, d *shotDisplay) {
	e := &d.ed
	var rest []*shot.Shape
	for _, s := range e.hist.Shapes {
		if s.Kind != shot.Translate {
			rest = append(rest, s)
		}
	}
	if len(rest) != len(e.hist.Shapes) {
		e.hist = shot.CommitShapes(e.hist, rest)
		return
	}
	e.flash(c, tr("图内翻译开发中"))
}
