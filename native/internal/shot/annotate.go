package shot

import (
	"fmt"
	"image"
	"math"
	"strings"
)

// 截图标注：图形模型、历史栈。坐标为本屏左上角原点的 pt。移植自 src/lib/screenshot/annotate.ts。
// 图形以指针标识（同 TS 的对象引用）：历史里每一步都是 []*Shape 快照，改图形一律换新指针。

type Kind string

const (
	Line      Kind = "line"
	RectK     Kind = "rect"
	Ellipse   Kind = "ellipse"
	Arrow     Kind = "arrow"
	Pen       Kind = "pen"
	Text      Kind = "text"
	Mosaic    Kind = "mosaic"
	Spotlight Kind = "spotlight"
	Number    Kind = "number"
	Callout   Kind = "callout"
	Translate Kind = "translate"
)

// Tools 是工具栏顺序。
var Tools = []Kind{Line, RectK, Ellipse, Arrow, Pen, Text, Mosaic, Spotlight, Number, Callout}

type Shape struct {
	Kind           Kind
	X1, Y1, X2, Y2 float64 // 线框类 / 马赛克 / 聚光灯 / 批注
	Points         []Point // 画笔
	X, Y           float64 // 文字 / 序号
	Text           string
	N              int    // 序号
	Note           string // 批注说明（不画进图里）
	Color          string
	Size           int
	Items          []TranslatedLine // 图内翻译
}

// TranslatedLine：图内翻译的一行（pt）：只抹掉原文笔画的补丁 + 译文。
type TranslatedLine struct {
	X, Y, W, H float64
	Text       string
	Patch      *image.RGBA // 识别框外扩 TranslatePad 的补丁（冻结帧像素尺寸）
	FG         string
	FontSize   float64
}

const TranslatePad = 2.0

var (
	LineWidth     = []float64{2, 4, 6}
	FontSize      = []float64{14, 18, 24}
	NumberRadius  = []float64{10, 13, 16}
	MosaicBlock   = []float64{5, 9, 15}
	CalloutTagH   = []float64{18, 22, 26}
	CalloutRadius = []float64{4, 5, 6}
	// Colors：标注色画进截图像素，不随主题变化。
	Colors = []string{"#FF3B30", "#FFCC00", "#34C759", "#007AFF", "#FFFFFF", "#000000"}
)

const (
	TextLineHeight = 1.25
	SpotlightDim   = 0.55 // 聚光灯区域外压暗 rgba(0,0,0,.55)
	CalloutTint    = 0.08
)

// TextWidth 量一行文字宽（pt，字重 600）。界面层换成真实字体测量；默认按 CJK 1 / 其他 0.6 个字号粗估（同 TS 无 canvas 时）。
var TextWidth = func(line string, fs float64) float64 {
	w := 0.0
	for _, r := range line {
		if r >= 0x2e80 {
			w++
		} else {
			w += 0.6
		}
	}
	return w * fs
}

func at(t []float64, i int) float64 {
	if i < 0 || i >= len(t) {
		return t[1]
	}
	return t[i]
}

// FitFontSize：译文字号：从框高的 0.72 起，按实测宽度缩到放得下，最小 8。measure 量字号 size 下的宽度。
func FitFontSize(w, h float64, measure func(size float64) float64) float64 {
	size := math.Max(8, h*0.72)
	width := measure(size)
	if width > w && width > 0 {
		size = math.Max(8, size*w/width)
	}
	return jsRound(size*10) / 10
}

// ContrastText：背景亮度高用黑字，否则白字。
func ContrastText(r, g, b float64) string {
	if 0.299*r+0.587*g+0.114*b > 150 {
		return "#111111"
	}
	return "#FFFFFF"
}

// IsMeaningful：拖得太短的图形视为误触，不入历史。
func IsMeaningful(s *Shape) bool {
	switch s.Kind {
	case Pen:
		return len(s.Points) >= 2
	case Text:
		return strings.TrimSpace(s.Text) != ""
	case Number:
		return true
	case Translate:
		return len(s.Items) > 0
	}
	return math.Hypot(s.X2-s.X1, s.Y2-s.Y1) >= 3
}

// DragEnd：拖动中的终点：直线按住 ⇧ 吸附到 45° 的整数倍，长度不变。
func DragEnd(kind Kind, x1, y1, x, y float64, shift bool) (float64, float64) {
	if kind != Line || !shift {
		return x, y
	}
	l := math.Hypot(x-x1, y-y1)
	a := jsRound(math.Atan2(y-y1, x-x1)/(math.Pi/4)) * (math.Pi / 4)
	return x1 + jsRound(math.Cos(a)*l), y1 + jsRound(math.Sin(a)*l)
}

func Box(s *Shape) Rect {
	return Rect{math.Min(s.X1, s.X2), math.Min(s.Y1, s.Y2), math.Abs(s.X2 - s.X1), math.Abs(s.Y2 - s.Y1)}
}

// Tag 是批注编号贴片。
type Tag struct{ X, Y, W, H, R float64 }

// CalloutTag：嵌在框内左上角，左上随框圆角、右下同半径圆角；两位数加宽。
func CalloutTag(s *Shape, n int) Tag {
	b := Box(s)
	h := at(CalloutTagH, s.Size)
	w := h
	if n >= 10 {
		w = jsRound(h * 1.4)
	}
	return Tag{b.X, b.Y, w, h, at(CalloutRadius, s.Size)}
}

// CalloutNumbers：按在图形列表里的先后从 1 起；删掉一条后后面的自动补齐。
func CalloutNumbers(shapes []*Shape) map[*Shape]int {
	out := map[*Shape]int{}
	for _, s := range shapes {
		if s.Kind == Callout {
			out[s] = len(out) + 1
		}
	}
	return out
}

// CalloutPrompt：「① …」逐行；没填说明的批注不列出，都没填返回空串。
func CalloutPrompt(shapes []*Shape, header string) string {
	var lines []string
	n := 0
	for _, s := range shapes {
		if s.Kind != Callout {
			continue
		}
		n++
		if note := strings.TrimSpace(s.Note); note != "" {
			lines = append(lines, CircledNumber(n)+" "+note)
		}
	}
	if len(lines) == 0 {
		return ""
	}
	return header + "\n" + strings.Join(lines, "\n")
}

// CircledNumber：①–⑳ 用带圈数字，更多用 (21)。
func CircledNumber(n int) string {
	if n >= 1 && n <= 20 {
		return string(rune(0x2460 + n - 1))
	}
	return fmt.Sprintf("(%d)", n)
}

// NoteDraft：正在填写的批注说明：新画的框（尚未入历史），或双击已有批注（Orig）。
type NoteDraft struct {
	Shape *Shape
	Text  string
	Orig  *Shape
}

func clone(s *Shape) *Shape { c := *s; return &c }

func contains(shapes []*Shape, s *Shape) bool {
	for _, x := range shapes {
		if x == s {
			return true
		}
	}
	return false
}

func replace(shapes []*Shape, old, next *Shape) []*Shape {
	out := make([]*Shape, 0, len(shapes))
	for _, s := range shapes {
		if s == old {
			if next != nil {
				out = append(out, next)
			}
			continue
		}
		out = append(out, s)
	}
	return out
}

// CommitNote：新框连同说明一步入历史；改已有批注原地替换。
func CommitNote(h History, d NoteDraft) History {
	next := clone(d.Shape)
	next.Note = strings.TrimSpace(d.Text)
	if d.Orig == nil || !contains(h.Shapes, d.Orig) {
		return PushShape(h, next)
	}
	if d.Orig.Note == next.Note {
		return h
	}
	return CommitShapes(h, replace(h.Shapes, d.Orig, next))
}

// WithNoteDraft：显示与出图用：填写中的批注替代原图形（新框追加在最后）。
func WithNoteDraft(shapes []*Shape, d *NoteDraft) []*Shape {
	if d == nil {
		return shapes
	}
	next := clone(d.Shape)
	next.Note = d.Text
	if d.Orig != nil {
		return replace(shapes, d.Orig, next)
	}
	return append(append([]*Shape{}, shapes...), next)
}

func NextNumber(shapes []*Shape) int {
	n := 0
	for _, s := range shapes {
		if s.Kind == Number && s.N > n {
			n = s.N
		}
	}
	return n + 1
}

// TextDraft：正在输入的文字：新建，或双击已有文字改内容（Orig 为原图形）。
type TextDraft struct {
	X, Y  float64
	Text  string
	Color string
	Size  int
	Orig  *Shape
}

func (d TextDraft) shape() *Shape {
	return &Shape{Kind: Text, X: d.X, Y: d.Y, Text: d.Text, Color: d.Color, Size: d.Size}
}

// CommitText：改已有文字时原地替换（清空即删除），新建时追加；都是一步历史。
func CommitText(h History, d TextDraft) History {
	if d.Orig == nil || !contains(h.Shapes, d.Orig) {
		return PushShape(h, d.shape())
	}
	o := d.Orig
	var next *Shape
	if strings.TrimSpace(d.Text) != "" {
		next = d.shape()
	}
	if next != nil && o.Kind == Text && o.Text == d.Text && o.Color == d.Color && o.Size == d.Size {
		return h
	}
	return CommitShapes(h, replace(h.Shapes, o, next))
}

// WithTextDraft：出图用：编辑中的文字替代原图形（空文字不画）。
func WithTextDraft(shapes []*Shape, d *TextDraft) []*Shape {
	if d == nil {
		return shapes
	}
	rest := shapes
	if d.Orig != nil {
		rest = replace(shapes, d.Orig, nil)
	}
	if strings.TrimSpace(d.Text) == "" {
		return rest
	}
	return append(append([]*Shape{}, rest...), d.shape())
}

// History：快照式历史：每步记下整份图形列表，移动 / 缩放已画的图形也能撤销。
type History struct {
	Shapes     []*Shape
	Undo, Redo [][]*Shape
}

func CommitShapes(h History, shapes []*Shape) History {
	return History{Shapes: shapes, Undo: append(append([][]*Shape{}, h.Undo...), h.Shapes)}
}

func PushShape(h History, s *Shape) History {
	if !IsMeaningful(s) {
		return h
	}
	return CommitShapes(h, append(append([]*Shape{}, h.Shapes...), s))
}

func Undo(h History) History {
	if len(h.Undo) == 0 {
		return h
	}
	return History{Shapes: h.Undo[len(h.Undo)-1], Undo: h.Undo[:len(h.Undo)-1:len(h.Undo)-1], Redo: append(append([][]*Shape{}, h.Redo...), h.Shapes)}
}

func Redo(h History) History {
	if len(h.Redo) == 0 {
		return h
	}
	return History{Shapes: h.Redo[len(h.Redo)-1], Undo: append(append([][]*Shape{}, h.Undo...), h.Shapes), Redo: h.Redo[:len(h.Redo)-1 : len(h.Redo)-1]}
}

// NumberTextColor：序号底色上的数字颜色：浅色底配黑字。
func NumberTextColor(color string) string {
	if color == "#FFFFFF" || color == "#FFCC00" {
		return "#000000"
	}
	return "#FFFFFF"
}

// ArrowGeometry：线身终点（止于箭头底边）与三角形三顶点。
func ArrowGeometry(x1, y1, x2, y2, w float64) (bx, by float64, head [3]Point) {
	a := math.Atan2(y2-y1, x2-x1)
	hd := math.Max(10, w*3.5)
	bx, by = x2-math.Cos(a)*hd*0.8, y2-math.Sin(a)*hd*0.8
	head = [3]Point{
		{x2, y2},
		{x2 - hd*math.Cos(a-math.Pi/7), y2 - hd*math.Sin(a-math.Pi/7)},
		{x2 - hd*math.Cos(a+math.Pi/7), y2 - hd*math.Sin(a+math.Pi/7)},
	}
	return
}

// MosaicGrid：马赛克块数（每块一个取样）。
func MosaicGrid(s *Shape) (cols, rows int) {
	b := Box(s)
	block := at(MosaicBlock, s.Size)
	return max(1, int(math.Ceil(b.W/block))), max(1, int(math.Ceil(b.H/block)))
}
