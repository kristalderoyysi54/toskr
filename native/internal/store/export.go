package store

import (
	"archive/zip"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// 笔记包导出（同 Tauri noteExport.ts + note_export.rs）：zip 里一份 notes.md 与 media/ 图片（解密后的原图）。
// 正文用自适应围栏原样保留；秘文与剪贴历史不属于普通笔记导出，混入即整批拒绝。

var ErrExportClipboard = errors.New("秘文与剪贴历史不能作为普通笔记导出")

var mdEscape = regexp.MustCompile("([`*_\\[\\]<>#|])")

func exportInline(s string) string {
	s = strings.Join(strings.Fields(strings.ReplaceAll(s, "\r\n", "\n")), " ")
	s = strings.ReplaceAll(s, `\`, `\\`)
	return strings.TrimSpace(mdEscape.ReplaceAllString(s, `\$1`))
}

func literalBlock(text, lang string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	longest := 0
	for _, run := range regexp.MustCompile("`+").FindAllString(text, -1) {
		longest = max(longest, len(run))
	}
	fence := strings.Repeat("`", max(3, longest+1))
	if !regexp.MustCompile(`^[a-zA-Z0-9_+.-]{1,32}$`).MatchString(lang) {
		lang = "text"
	}
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return fence + lang + "\n" + text + fence
}

// NoteBlocks：笔记的富内容块；没有块的旧卡按「图片 + 说明」或纯文字恢复。
func NoteBlocks(n Note) []ContentBlock {
	if len(n.Blocks) > 0 {
		return n.Blocks
	}
	if n.Kind == "image" && n.ImageFile != "" {
		out := []ContentBlock{{Type: "image", File: n.ImageFile, Width: n.ImageW, Height: n.ImageH}}
		if !imagePlaceholder.MatchString(n.Text) && strings.TrimSpace(n.Text) != "" {
			out = append(out, ContentBlock{Type: "text", Text: n.Text})
		}
		return out
	}
	return []ContentBlock{{Type: "text", Text: n.Text}}
}

// IsImagePlaceholder：图片卡的自动占位标题（「图片 30×20」「图片 3 张」「截图 W×H」），不算真实备注。
func IsImagePlaceholder(s string) bool { return imagePlaceholder.MatchString(strings.TrimSpace(s)) }

var imagePlaceholder = regexp.MustCompile(`^(?:图片 (?:\d+×\d+|\d+ 张)|截图 \d+×\d+|Screenshot \d+×\d+)$`)

// BuildNotesExport 生成 notes.md 与要打包的媒体文件名（按出现顺序去重）。
func BuildNotesExport(notes []Note, sections []Section, now time.Time) (string, []string, error) {
	if len(notes) == 0 {
		return "", nil, errors.New("没有可导出的笔记")
	}
	names := map[string]string{}
	for _, s := range sections {
		names[s.ID] = s.Name
	}
	ts := func(t time.Time) string { return t.Format("2006-01-02 15:04") }
	chunks := []string{"# Toskr 笔记导出", "", fmt.Sprintf("> 导出：%s · 共 %d 条", ts(now), len(notes))}
	var media []string
	seen := map[string]bool{}
	for i, n := range notes {
		if n.Section == SectionClipboard || n.Kind == "secret" {
			return "", nil, ErrExportClipboard
		}
		title := n.Title
		if title == "" {
			title = n.LinkTitle
		}
		if title = exportInline(title); title == "" {
			title = fmt.Sprintf("笔记 %d", i+1)
		}
		if i > 0 {
			chunks = append(chunks, "", "---")
		}
		chunks = append(chunks, "", "## "+title)
		meta := []string{"创建：" + ts(n.CreatedAt)}
		if !n.UpdatedAt.IsZero() {
			meta = append(meta, "更新："+ts(n.UpdatedAt))
		}
		if name := names[n.Section]; name != "" {
			meta = append(meta, "分组："+exportInline(name))
		}
		if len(n.Tags) > 0 {
			var tags []string
			for _, t := range n.Tags {
				tags = append(tags, "#"+exportInline(t))
			}
			meta = append(meta, "标签："+strings.Join(tags, " "))
		}
		chunks = append(chunks, "", "> "+strings.Join(meta, " · "))
		img := 0
		for _, b := range NoteBlocks(n) {
			if b.Type != "image" {
				if b.Text != "" {
					chunks = append(chunks, "", literalBlock(b.Text, n.CodeLang))
				}
				continue
			}
			img++
			if !seen[b.File] {
				seen[b.File] = true
				media = append(media, b.File)
			}
			alt := exportInline(b.Alt)
			if alt == "" {
				alt = fmt.Sprintf("图片 %d", img)
			}
			chunks = append(chunks, "", fmt.Sprintf("![%s](media/%s)", alt, url.PathEscape(b.File)))
		}
	}
	return strings.TrimSpace(strings.Join(chunks, "\n")) + "\n", media, nil
}

// WriteNotesBundle 把 markdown 与解密后的媒体写成 zip（先写临时文件再改名，不覆盖已有文件）。
func (s *Store) WriteNotesBundle(path, markdown string, media []string) error {
	if !strings.EqualFold(filepath.Ext(path), ".zip") {
		return errors.New("笔记包必须保存为 .zip")
	}
	if _, err := os.Stat(path); err == nil {
		return errors.New("目标文件已存在")
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".toskr-export-*.zip")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	zw := zip.NewWriter(tmp)
	write := func(name string, data []byte) error {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store, Modified: time.Now()})
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	}
	if err := write("notes.md", []byte(markdown)); err != nil {
		tmp.Close()
		return err
	}
	for _, m := range media {
		raw, err := s.LoadImage(m)
		if err != nil {
			tmp.Close()
			return fmt.Errorf("读取图片 %s 失败：%w", m, err)
		}
		if err := write("media/"+m, raw); err != nil {
			tmp.Close()
			return err
		}
	}
	if err := zw.Close(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Link(tmp.Name(), path) // 硬链接发布：目标已存在时失败，不会覆盖
}
