package store

import "slices"

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
