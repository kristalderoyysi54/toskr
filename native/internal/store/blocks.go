package store

import (
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
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

// blockSpan：投影正文里某个文字块所占的字节区间；trim = 投影时从块开头去掉的换行字节数（见 TextFromBlocks）。
type blockSpan struct{ block, start, end, trim int }

func blockSpans(bs []ContentBlock) ([]blockSpan, string) {
	var out strings.Builder
	var spans []blockSpan
	for i, b := range bs {
		if b.Type == "image" {
			continue
		}
		body, trim := b.Text, 0
		if len(spans) > 0 {
			if strings.HasSuffix(out.String(), "\n") {
				t := strings.TrimLeft(body, "\n")
				trim, body = len(body)-len(t), t
			} else if !strings.HasPrefix(body, "\n") {
				out.WriteString("\n")
			}
		}
		start := out.Len()
		out.WriteString(body)
		spans = append(spans, blockSpan{i, start, out.Len(), trim})
	}
	return spans, out.String()
}

// BlockAtRune：投影正文里第 r 个字符落在哪个文字块、块内第几个字符（双击 / 划词进编辑时定位到对应块）。
func BlockAtRune(bs []ContentBlock, r int) (block, local int, ok bool) {
	spans, proj := blockSpans(bs)
	if r < 0 || r > utf8.RuneCountInString(proj) {
		return 0, 0, false
	}
	at := len(string([]rune(proj)[:r]))
	for k := len(spans) - 1; k >= 0; k-- {
		sp := spans[k]
		if at >= sp.start {
			off := min(at, sp.end) - sp.start
			return sp.block, utf8.RuneCountInString(bs[sp.block].Text[:sp.trim+off]), true
		}
	}
	return 0, 0, false
}

// SpliceBlocksText：把对投影正文的一次改动（按公共前后缀定位）映射回图文块——改动落在一个文字块里就只改那一块，
// 跨块时并到首块、去掉中间文字块，图片块保持原位。映射不成立时退回「首个文字块位置放全文、其余文字块去掉」。
// 让划词工具条、坞上「处理」、AI 改写等对纯文字有效的操作对图文卡同样生效（不再只改投影、卡面不变）。
func SpliceBlocksText(bs []ContentBlock, text string) []ContentBlock {
	spans, old := blockSpans(bs)
	out := slices.Clone(bs)
	if old == text {
		return out
	}
	if len(spans) == 0 {
		return append([]ContentBlock{{Type: "text", Text: text}}, out...)
	}
	p := 0
	for p < len(old) && p < len(text) && old[p] == text[p] {
		p++
	}
	for p > 0 && (p < len(old) && !utf8.RuneStart(old[p]) || p < len(text) && !utf8.RuneStart(text[p])) {
		p--
	}
	sfx := 0
	for sfx < len(old)-p && sfx < len(text)-p && old[len(old)-1-sfx] == text[len(text)-1-sfx] {
		sfx++
	}
	for sfx > 0 && (!utf8.RuneStart(old[len(old)-sfx]) || !utf8.RuneStart(text[len(text)-sfx])) {
		sfx--
	}
	oe, piece := len(old)-sfx, text[p:len(text)-sfx]
	i, j := 0, 0
	for k, sp := range spans {
		if sp.start <= p {
			i = k
		}
		if sp.start <= oe {
			j = k
		}
	}
	j = max(i, j)
	si, sj := spans[i], spans[j]
	bi, bj := out[si.block].Text, out[sj.block].Text
	pre := bi[:si.trim+min(p-si.start, si.end-si.start)]
	post := bj[sj.trim+max(0, min(oe-sj.start, sj.end-sj.start)):]
	out[si.block].Text = pre + piece + post
	drop := map[int]bool{}
	for _, sp := range spans[i+1 : j+1] {
		drop[sp.block] = true
	}
	var res []ContentBlock
	for k, b := range out {
		if drop[k] || b.Type != "image" && b.Text == "" {
			continue
		}
		res = append(res, b)
	}
	if TextFromBlocks(res) == text {
		return res
	}
	res, placed := nil, false // 退回：首个文字块位置放全文
	for _, b := range bs {
		if b.Type == "image" {
			res = append(res, b)
		} else if !placed {
			res, placed = append(res, ContentBlock{Type: "text", Text: text}), true
		}
	}
	return res
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
			if _, has := n.ImageAlts[file]; has {
				n.ImageAlts = maps.Clone(n.ImageAlts)
				delete(n.ImageAlts, file)
			}
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

// ReplaceMediaFile 把卡片里的一张图（主图 / 附件 / 图文块，任意卡型）换成新文件，位置不变；返回改动前的卡（RestoreContent 撤销）。
// 同 Tauri 图片预览「打码 / 标注」写回 sourceFile。
func (s *Store) ReplaceMediaFile(id, old, file string, w, h int) (prev Note, err error) {
	found := false
	err = s.mutate(func() bool {
		i := s.index(id)
		if i < 0 {
			return false
		}
		n := &s.notes[i]
		prev = cloneContent(*n)
		n.Attachments, n.Blocks = slices.Clone(n.Attachments), slices.Clone(n.Blocks) // 不原地改：Note() 返回的副本与存储共用底层数组
		if n.ImageFile == old {
			n.ImageFile, n.ImageW, n.ImageH, found = file, w, h, true
		}
		for j, f := range n.Attachments {
			if f == old {
				n.Attachments[j], found = file, true
			}
		}
		for j := range n.Blocks {
			if b := &n.Blocks[j]; b.Type == "image" && b.File == old {
				b.File, b.Width, b.Height, found = file, w, h, true
			}
		}
		if found {
			if alt, ok := n.ImageAlts[old]; ok { // 打码 / 标注换了文件，说明跟着这张图走
				n.ImageAlts = maps.Clone(n.ImageAlts)
				delete(n.ImageAlts, old)
				n.ImageAlts[file] = alt
			}
			n.UpdatedAt = time.Now()
		}
		return found
	})
	if err == nil && !found {
		err = errors.New("卡片里没有这张图片")
	}
	return
}

// AltOf：卡片里某张图的说明——图文块的 Alt 优先，其次主图 / 附件的 ImageAlts。
func (n Note) AltOf(file string) string {
	for _, b := range n.Blocks {
		if b.Type == "image" && b.File == file && strings.TrimSpace(b.Alt) != "" {
			return strings.TrimSpace(b.Alt)
		}
	}
	return strings.TrimSpace(n.ImageAlts[file])
}

// ImageLabel：图片的可读名——有说明用说明，否则「图片 N」（同 Tauri RichImageBlock label）。
func (n Note) ImageLabel(file string, index int) string {
	if alt := n.AltOf(file); alt != "" {
		return alt
	}
	return fmt.Sprintf("图片 %d", index+1)
}

// ImageAltMax：图片说明最长字数。
const ImageAltMax = 200

// SetImageAlt 给卡片里的一张图写说明（空 = 清除，超长截断）；图在图文块里写块的 Alt，否则写 ImageAlts。
// 返回改动前的卡（RestoreContent 撤销）与是否有变化。
func (s *Store) SetImageAlt(id, file, alt string) (prev Note, changed bool, err error) {
	alt = strings.TrimSpace(alt)
	if r := []rune(alt); len(r) > ImageAltMax {
		alt = string(r[:ImageAltMax])
	}
	err = s.mutate(func() bool {
		i := s.index(id)
		if i < 0 || !slices.Contains(s.notes[i].MediaFiles(), file) {
			return false
		}
		n := &s.notes[i]
		if n.AltOf(file) == alt {
			return false
		}
		prev = cloneContent(*n)
		inBlock := false
		n.Blocks = slices.Clone(n.Blocks)
		for j := range n.Blocks {
			if b := &n.Blocks[j]; b.Type == "image" && b.File == file {
				b.Alt, inBlock = alt, true
			}
		}
		alts := maps.Clone(n.ImageAlts)
		if alts == nil {
			alts = map[string]string{}
		}
		if inBlock || alt == "" {
			delete(alts, file)
		} else {
			alts[file] = alt
		}
		if len(alts) == 0 {
			alts = nil
		}
		n.ImageAlts, n.UpdatedAt, changed = alts, time.Now(), true
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
		n.ImageFile, n.ImageW, n.ImageH, n.Attachments, n.ImageAlts = prev.ImageFile, prev.ImageW, prev.ImageH, prev.Attachments, prev.ImageAlts
		n.URL, n.LinkTitle, n.LinkIcon = prev.URL, prev.LinkTitle, prev.LinkIcon
		return true
	})
}

func cloneContent(n Note) Note {
	n.Blocks, n.Attachments, n.ImageAlts = slices.Clone(n.Blocks), slices.Clone(n.Attachments), maps.Clone(n.ImageAlts)
	return n
}
