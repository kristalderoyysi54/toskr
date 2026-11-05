package shot

import (
	"encoding/json"
	"fmt"
	"math"
)

// 出图的圆角与阴影（移植自 frame.ts）与十字线颜色（crosshair.ts）。

const (
	MaxRadius          = 100.0 // 圆角上限（pt）
	MaxShadow          = 60.0  // 阴影大小上限（pt）：即四周透明边距，0 = 无阴影
	ShadowAlphaMin     = 10.0
	ShadowAlphaMax     = 90.0
	ShadowAlphaDefault = 45.0
)

// ClampRadius：圆角不超过短边一半。
func ClampRadius(r, w, h float64) float64 { return math.Max(0, math.Min(r, math.Min(w/2, h/2))) }

// ShadowGeometry：模糊半径与下移量随大小变化（与屏上预览同源）。
func ShadowGeometry(size float64) (blur, offsetY float64) { return size * 0.6, size * 0.2 }

// CrosshairPresets：十字线、选框与手柄的颜色（画在任意屏幕内容之上，不随主题变化）。
var CrosshairPresets = map[string][3]uint8{
	"sky":     {125, 211, 252},
	"white":   {255, 255, 255},
	"lime":    {179, 217, 52},
	"magenta": {236, 72, 153},
}

var CrosshairPresetNames = []string{"sky", "white", "lime", "magenta"}

const (
	CrosshairAlphaMin = 30.0
	CrosshairAlphaMax = 100.0
)

type Crosshair struct {
	Preset string  `json:"preset"`
	Alpha  float64 `json:"alpha"`
}

var DefaultCrosshair = Crosshair{"sky", 70}

// LoadCrosshair 解析存下的十字线样式：非法预设回落默认，不透明度夹在范围内。
func LoadCrosshair(raw string) Crosshair {
	var v struct {
		Preset any `json:"preset"`
		Alpha  any `json:"alpha"`
	}
	if raw == "" || json.Unmarshal([]byte(raw), &v) != nil {
		return DefaultCrosshair
	}
	out := DefaultCrosshair
	if p, ok := v.Preset.(string); ok {
		if _, known := CrosshairPresets[p]; known {
			out.Preset = p
		}
	}
	if a, ok := v.Alpha.(float64); ok {
		out.Alpha = math.Min(CrosshairAlphaMax, math.Max(CrosshairAlphaMin, a))
	}
	return out
}

// CSS 同 crosshairCss（用于对照与测试）。
func (c Crosshair) CSS() string {
	p := CrosshairPresets[c.Preset]
	return fmt.Sprintf("rgba(%d, %d, %d, %s)", p[0], p[1], p[2], trimFloat(c.Alpha/100))
}

func trimFloat(v float64) string { return fmt.Sprint(v) }
