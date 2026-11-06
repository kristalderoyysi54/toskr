package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPromptTemplatesExport(t *testing.T) {
	groups := []PromptGroup{{ID: "project", Name: "项目", Order: 2}, {ID: "unused", Name: "未引用", Order: 3}}
	snips := []PromptSnippet{{ID: "mine", Label: "我的模板", Text: "原始正文\n\n{内容}", GroupID: "project", IsCommon: true}}
	p, err := BuildPromptTemplatesExport(snips, groups)
	if err != nil || len(p.Groups) != 1 || p.Groups[0].ID != "project" {
		t.Fatalf("只带被引用的分组 %+v %v", p, err)
	}
	path := filepath.Join(t.TempDir(), "t.json")
	if err := WritePromptTemplatesExport(path, p); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	var back map[string]any
	if json.Unmarshal(raw, &back) != nil || back["format"] != "toskr-prompt-templates" || back["version"].(float64) != 1 {
		t.Fatalf("%s", raw)
	}
	if _, err := BuildPromptTemplatesExport([]PromptSnippet{{ID: "x", GroupID: "missing"}}, groups); err == nil {
		t.Fatal("引用不存在的分组应报错")
	}
	if WritePromptTemplatesExport("rel.json", p) == nil || WritePromptTemplatesExport(filepath.Join(t.TempDir(), "a.txt"), p) == nil {
		t.Fatal("非绝对或非 .json 路径应拒绝")
	}
	dir := t.TempDir()
	link := filepath.Join(dir, "l.json")
	_ = os.Symlink(path, link)
	if WritePromptTemplatesExport(link, p) == nil {
		t.Fatal("符号链接应拒绝")
	}
}
