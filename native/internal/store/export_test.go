package store

import (
	"archive/zip"
	"bytes"
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNotesExportBundle(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), bytes.Repeat([]byte{6}, 32))
	png := []byte("\x89PNG fake")
	file, _ := s.SaveImage(png)
	at := time.Date(2026, 11, 6, 9, 30, 0, 0, time.Local)
	sec := s.AddSection("资料")
	text := Note{Section: sec, Title: "会议 *纪要*", Text: "第一行\n```go\nx := 1\n```", Tags: []string{"周会"}, CreatedAt: at}
	img := Note{Section: SectionInbox, Kind: "image", ImageFile: file, ImageW: 2, ImageH: 1, Text: "图片 2×1", CreatedAt: at}
	md, media, err := BuildNotesExport([]Note{text, img, img}, s.Sections(), at)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# Toskr 笔记导出", "> 导出：2026-11-06 09:30 · 共 3 条", "## 会议 \\*纪要\\*", "分组：资料", "标签：#周会",
		"````text\n第一行\n```go\nx := 1\n```\n````", "## 笔记 2", "![图片 1](media/" + file + ")"} {
		if !strings.Contains(md, want) {
			t.Fatalf("缺 %q：\n%s", want, md)
		}
	}
	if strings.Contains(md, "图片 2×1\n") || len(media) != 1 {
		t.Fatalf("图片占位说明不导出、媒体去重 %v", media)
	}
	if _, _, err := BuildNotesExport([]Note{{Section: SectionClipboard}}, nil, at); err != ErrExportClipboard {
		t.Fatal("剪贴历史不得导出")
	}
	out := filepath.Join(t.TempDir(), "笔记.zip")
	if err := s.WriteNotesBundle(out, md, media); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.OpenReader(out)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	got := map[string]string{}
	for _, f := range zr.File {
		r, _ := f.Open()
		b, _ := io.ReadAll(r)
		got[f.Name] = string(b)
	}
	if got["notes.md"] != md || got["media/"+file] != string(png) {
		t.Fatalf("zip 内容 %v", len(got))
	}
	if err := s.WriteNotesBundle(out, md, media); err == nil {
		t.Fatal("已存在不覆盖")
	}
}
