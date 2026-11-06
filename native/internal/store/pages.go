package store

import "slices"

// DefaultPageOrder 是一级页签默认顺序（同 Tauri DEFAULT_PAGE_ORDER；secret 在原生版是「内容」下的子页，只为导入保留）。
var DefaultPageOrder = []string{"clipboard", "notes", "tasks", "secret"}

// NormalizePageOrder 去未知与重复，缺的按默认补在末尾（同 Tauri normalizePageOrder）。
func NormalizePageOrder(order []string) []string {
	var out []string
	for _, p := range order {
		if slices.Contains(DefaultPageOrder, p) && !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	for _, p := range DefaultPageOrder {
		if !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	return out
}

// MovePage 把 from 移到 to 的位置（同 dnd-kit arrayMove）。
func MovePage(order []string, from, to string) []string {
	order = NormalizePageOrder(order)
	i, j := slices.Index(order, from), slices.Index(order, to)
	if i < 0 || j < 0 || i == j {
		return order
	}
	p := order[i]
	order = slices.Delete(order, i, i+1)
	return slices.Insert(order, j, p)
}
