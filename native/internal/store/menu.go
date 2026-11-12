package store

// 卡片右键菜单自定义（同 Tauri notesStore CONTEXT_MENU_REGISTRY / CONTEXT_MENU_GROUPS，方案 A）：
// 骨架固定——「发送」「常用」两区直接列在一级菜单，「整理」「转换与导出」各是一个二级菜单；
// 用户只在区内开关与排序。合并、回复关联与删除始终显示。

// MenuItem 是一项右键菜单配置。
type MenuItem struct {
	ID string `json:"id"`
	On bool   `json:"on"`
}

// MenuRegistry：全部可配置项（ID 与 Tauri ContextMenuItemId 一致，导入时直接沿用）。
var MenuRegistry = []struct{ ID, Label, Group string }{
	{"preview", "预览 / 打开链接", "main"},
	{"send", "发送到对话", "send"},
	{"send-preflight", "检查后发送", "send"},
	{"send-template", "用模板发送", "send"},
	{"copy", "复制内容", "main"},
	{"copy-list", "复制为列表", "convert"},
	{"export", "导出笔记包", "convert"},
	{"edit", "编辑", "main"},
	{"ocr", "识别文字 (OCR)", "convert"},
	{"done", "标记完成", "main"},
	{"keep", "设为常用 / 固定", "main"},
	{"blur", "模糊内容", "organize"},
	{"rename", "重命名", "organize"},
	{"tags", "标签", "organize"},
	{"to-task", "转为任务", "convert"},
	{"ai-to-task", "AI 转任务", "convert"},
	{"ai-title", "AI 起标题", "convert"},
	{"move", "移动到分组", "organize"},
}

// MenuGroups 是四个分区（设置页按此分区展示）。
var MenuGroups = []struct{ ID, Label string }{
	{"send", "一级菜单 · 发送"}, {"main", "一级菜单 · 常用"}, {"organize", "整理"}, {"convert", "转换与导出"},
}

// 低频项默认关闭（同 Tauri CONTEXT_MENU_LOW_FREQUENCY）。
var menuLowFrequency = map[string]bool{"export": true, "ai-title": true}

// DefaultMenu 是默认配置（注册顺序，低频项关）。
func DefaultMenu() []MenuItem {
	out := make([]MenuItem, len(MenuRegistry))
	for i, r := range MenuRegistry {
		out[i] = MenuItem{r.ID, !menuLowFrequency[r.ID]}
	}
	return out
}

// MenuGroupOf 返回某项所在分区。
func MenuGroupOf(id string) string {
	for _, r := range MenuRegistry {
		if r.ID == id {
			return r.Group
		}
	}
	return ""
}

// NormalizeMenu 去掉未知与重复项，缺的项按默认补在末尾（同 Tauri normalizeContextMenu）。
func NormalizeMenu(cfg []MenuItem) []MenuItem {
	seen := map[string]bool{}
	var out []MenuItem
	for _, x := range cfg {
		if MenuGroupOf(x.ID) != "" && !seen[x.ID] {
			out = append(out, x)
			seen[x.ID] = true
		}
	}
	for _, x := range DefaultMenu() {
		if !seen[x.ID] {
			out = append(out, x)
		}
	}
	return out
}

// PartitionMenu 按分区拆开启用项（保留区内顺序）；剪贴卡「移入笔记分组」提到常用区，编辑与完成落到整理（同 Tauri partitionCardMenuIds）。
func PartitionMenu(cfg []MenuItem, clipboard bool) map[string][]string {
	out := map[string][]string{}
	for _, x := range NormalizeMenu(cfg) {
		if !x.On {
			continue
		}
		g := MenuGroupOf(x.ID)
		switch {
		case clipboard && x.ID == "move":
			g = "main"
		case clipboard && (x.ID == "edit" || x.ID == "done"):
			g = "organize"
		}
		out[g] = append(out[g], x.ID)
	}
	return out
}

// MoveMenuItem 在同一分区内与相邻项交换（dir = -1 上移 / 1 下移）；越界或跨区不动。
func MoveMenuItem(cfg []MenuItem, id string, dir int) []MenuItem {
	cfg = NormalizeMenu(cfg)
	g := MenuGroupOf(id)
	var idx []int // 本区各项在 cfg 中的位置
	at := -1
	for i, x := range cfg {
		if MenuGroupOf(x.ID) == g {
			if x.ID == id {
				at = len(idx)
			}
			idx = append(idx, i)
		}
	}
	to := at + dir
	if at < 0 || to < 0 || to >= len(idx) {
		return cfg
	}
	cfg[idx[at]], cfg[idx[to]] = cfg[idx[to]], cfg[idx[at]]
	return cfg
}
