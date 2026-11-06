package store

// AliasEntity 同 Tauri AliasEntity：用户录入的原文 → 稳定占位符（创建时一次性分配，永不改变；删除不回收编号）。
type AliasEntity struct {
	ID           string `json:"id"`
	Category     string `json:"category"`
	OriginalText string `json:"originalText"`
	Placeholder  string `json:"placeholder"`
	CreatedAtMs  int64  `json:"createdAtMs"`
	UpdatedAtMs  int64  `json:"updatedAtMs"`
}

// AliasCategory：自定义化名类别（预置类别硬编码，不落设置）。
type AliasCategory struct {
	Code  string `json:"code"`
	Label string `json:"label"`
}
