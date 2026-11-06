package store

import (
	"slices"
	"strings"
	"time"
)

// ContentBlocks 同 Tauri noteContentBlocks：有 contentBlocks 用它，否则由正文 + 主图 + 附件投影成有序块。
func (n Note) ContentBlocks() []ContentBlock {
	if n.Blocks != nil {
		return n.Blocks
	}
	var out []ContentBlock
	if n.Text != "" && n.Kind != "image" {
		out = append(out, ContentBlock{Type: "text", Text: n.Text})
	}
	var seen []string
	for _, f := range append([]string{n.ImageFile}, n.Attachments...) {
		if f == "" || slices.Contains(seen, f) {
			continue
		}
		seen = append(seen, f)
		b := ContentBlock{Type: "image", File: f}
		if f == n.ImageFile {
			b.Width, b.Height = n.ImageW, n.ImageH
		}
		out = append(out, b)
	}
	return out
}

// ImageBlocks 返回块里的图片文件（有序去重）。
func ImageBlocks(bs []ContentBlock) []string {
	var out []string
	for _, b := range bs {
		if b.Type == "image" && b.File != "" && !slices.Contains(out, b.File) {
			out = append(out, b.File)
		}
	}
	return out
}

// HasMixedContent 同 Tauri hasMixedNoteContent：块里同时有文字和图片。
func HasMixedContent(bs []ContentBlock) bool {
	var t, i bool
	for _, b := range bs {
		if b.Type == "image" {
			i = true
		} else {
			t = true
		}
	}
	return t && i
}

// TextFromBlocks 同 Tauri textFromContentBlocks：文字块依次相接，交界两侧都没有换行才补一个；图片不贡献文字。
func TextFromBlocks(bs []ContentBlock) string {
	var out strings.Builder
	seen := 0
	for _, b := range bs {
		if b.Type == "image" {
			continue
		}
		body := b.Text
		if seen > 0 {
			if strings.HasSuffix(out.String(), "\n") {
				body = strings.TrimLeft(body, "\n")
			} else if !strings.HasPrefix(body, "\n") {
				out.WriteString("\n")
			}
		}
		seen++
		out.WriteString(body)
	}
	return out.String()
}

// AddImages 把图片追加进卡片（同 Tauri addImagesToCard）：图文混排卡追加图片块，其余追加为主图 / 附件。
// 已在卡里的图跳过；返回改动前的卡（撤销用）与新增张数。
func (s *Store) AddImages(id string, imgs []ContentBlock) (prev Note, added int, err error) {
	err = s.mutate(func() bool {
		i := s.index(id)
		if i < 0 {
			return false
		}
		n := &s.notes[i]
		prev = cloneContent(*n)
		have := n.MediaFiles()
		for _, im := range imgs {
			if im.File == "" || slices.Contains(have, im.File) {
				continue
			}
			have = append(have, im.File)
			added++
			im.Type = "image"
			switch {
			case HasMixedContent(n.Blocks):
				n.Blocks = append(n.Blocks, im)
			case n.ImageFile == "":
				n.ImageFile, n.ImageW, n.ImageH = im.File, im.Width, im.Height
			default:
				n.Attachments = append(n.Attachments, im.File)
			}
		}
		if added == 0 {
			return false
		}
		if n.Kind == "link" { // 加了图就不再是链接卡（同 Tauri 组合卡 kind 固定 text）
			n.Kind, n.URL, n.LinkTitle, n.LinkIcon = "", "", "", ""
		}
		n.UpdatedAt = time.Now()
		return true
	})
	return
}

// RemoveImage 从卡片移除一张图（图文块或主图 / 附件）；返回改动前的卡。图片卡只剩一张时不移除。
func (s *Store) RemoveImage(id, file string) (prev Note, ok bool) {
	_ = s.mutate(func() bool {
		i := s.index(id)
		if i < 0 {
			return false
		}
		n := &s.notes[i]
		if n.Kind == "image" && len(n.MediaFiles()) <= 1 {
			return false
		}
		prev = cloneContent(*n)
		if j := slices.IndexFunc(n.Blocks, func(b ContentBlock) bool { return b.Type == "image" && b.File == file }); j >= 0 {
			n.Blocks = slices.Delete(n.Blocks, j, j+1)
			ok = true
		}
		if j := slices.Index(n.Attachments, file); j >= 0 {
			n.Attachments = slices.Delete(n.Attachments, j, j+1)
			ok = true
		}
		if n.ImageFile == file {
			n.ImageFile, n.ImageW, n.ImageH = "", 0, 0
			if len(n.Attachments) > 0 {
				n.ImageFile, n.Attachments = n.Attachments[0], n.Attachments[1:]
			}
			ok = true
		}
		if ok {
			n.UpdatedAt = time.Now()
		}
		return ok
	})
	return
}

// SetBlocks 覆盖图文卡的内容块（富卡编辑保存）：去掉空文字块，正文同步为投影文字。
func (s *Store) SetBlocks(id string, bs []ContentBlock) (prev Note, err error) {
	var clean []ContentBlock
	for _, b := range bs {
		if b.Type == "image" && b.File != "" || b.Type != "image" && strings.TrimSpace(b.Text) != "" {
			clean = append(clean, b)
		}
	}
	err = s.mutate(func() bool {
		i := s.index(id)
		if i < 0 {
			return false
		}
		n := &s.notes[i]
		prev = cloneContent(*n)
		text := TextFromBlocks(clean)
		if strings.TrimSpace(text) == "" && len(ImageBlocks(clean)) == 0 {
			return false
		}
		if slices.Equal(n.Blocks, clean) {
			return false
		}
		n.Blocks, n.Text, n.HTML, n.UpdatedAt = clean, text, "", time.Now()
		return true
	})
	return
}

// RestoreContent 撤销内容改动：正文、内容块、主图与附件回到 prev。
func (s *Store) RestoreContent(prev Note) {
	_ = s.mutate(func() bool {
		i := s.index(prev.ID)
		if i < 0 {
			return false
		}
		n := &s.notes[i]
		n.Text, n.HTML, n.Kind, n.Blocks = prev.Text, prev.HTML, prev.Kind, prev.Blocks
		n.ImageFile, n.ImageW, n.ImageH, n.Attachments = prev.ImageFile, prev.ImageW, prev.ImageH, prev.Attachments
		n.URL, n.LinkTitle, n.LinkIcon = prev.URL, prev.LinkTitle, prev.LinkIcon
		return true
	})
}

func cloneContent(n Note) Note {
	n.Blocks, n.Attachments = slices.Clone(n.Blocks), slices.Clone(n.Attachments)
	return n
}
