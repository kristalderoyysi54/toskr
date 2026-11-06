package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// 提示词模板独立导出（同 Tauri prompt_export.rs + promptTemplateExport.ts）：只含模板与被引用的分组，
// 格式 toskr-prompt-templates v1，逐字段复制，不混入设置或密钥。

type PromptTemplatesExport struct {
	Format   string          `json:"format"`
	Version  int             `json:"version"`
	Groups   []PromptGroup   `json:"groups"`
	Snippets []PromptSnippet `json:"snippets"`
}

func BuildPromptTemplatesExport(snippets []PromptSnippet, groups []PromptGroup) (PromptTemplatesExport, error) {
	ref := map[string]bool{}
	for _, s := range snippets {
		ref[s.GroupID] = true
	}
	var gs []PromptGroup
	for _, g := range groups {
		if ref[g.ID] {
			gs = append(gs, PromptGroup{ID: g.ID, Name: g.Name, Order: g.Order})
		}
	}
	if len(gs) != len(ref) {
		return PromptTemplatesExport{}, errors.New("模板引用的分组不存在，请先检查模板分组")
	}
	ss := make([]PromptSnippet, len(snippets))
	for i, s := range snippets {
		ss[i] = PromptSnippet{ID: s.ID, Label: s.Label, Text: s.Text, GroupID: s.GroupID, IsCommon: s.IsCommon}
	}
	if gs == nil {
		gs = []PromptGroup{}
	}
	return PromptTemplatesExport{Format: "toskr-prompt-templates", Version: 1, Groups: gs, Snippets: ss}, nil
}

// WritePromptTemplatesExport：目标必须是绝对 .json 路径且不是符号链接 / 目录；先写临时文件再原子替换。
func WritePromptTemplatesExport(path string, p PromptTemplatesExport) error {
	if !filepath.IsAbs(path) || !strings.EqualFold(filepath.Ext(path), ".json") {
		return errors.New("模板导出目标必须是绝对 .json 文件路径")
	}
	if fi, err := os.Lstat(path); err == nil && (!fi.Mode().IsRegular()) {
		return errors.New("模板导出目标不是普通文件")
	}
	if p.Format != "toskr-prompt-templates" || p.Version != 1 || slices.ContainsFunc(p.Snippets, func(s PromptSnippet) bool { return s.ID == "" }) {
		return errors.New("模板导出格式或版本无效")
	}
	raw, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
