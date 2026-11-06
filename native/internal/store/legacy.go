package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// LegacyJSONFormat：Tauri 早期导出的明文 JSON 备份（顶层就是 sections / notes / tasks… 状态对象）。
const LegacyJSONFormat = "legacy-json"

const maxLegacyJSON = 256 << 20

// inspectLegacyJSON 同 Tauri read_legacy_backup + validate_legacy_state：校验结构后转成原生快照供合并预览。
// 只支持合并导入（同 Tauri runLegacyJsonImport → importMerge：本机已有的 ID 跳过）；旧 JSON 不带图片。
func (s *Store) inspectLegacyJSON(raw []byte) (*Preview, error) {
	if len(raw) > maxLegacyJSON {
		return nil, errors.New("旧 JSON 备份过大")
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil || top == nil {
		return nil, errors.New("文件不是有效的备份或旧 JSON（顶层必须是对象）")
	}
	for _, f := range [][2]string{{"sections", "name"}, {"notes", "text"}, {"taskSections", "name"}, {"tasks", "text"}} {
		v, ok := top[f[0]]
		if !ok {
			continue
		}
		var recs []map[string]any
		if err := json.Unmarshal(v, &recs); err != nil {
			return nil, fmt.Errorf("旧 JSON %s 必须是对象数组", f[0])
		}
		for _, r := range recs {
			id, ok1 := r["id"].(string)
			_, ok2 := r[f[1]].(string)
			if !ok1 || id == "" || !ok2 {
				return nil, fmt.Errorf("旧 JSON %s 记录缺少 id/%s", f[0], f[1])
			}
		}
	}
	if v, ok := top["settings"]; ok && string(v) != "null" {
		var m map[string]any
		if json.Unmarshal(v, &m) != nil {
			return nil, errors.New("旧 JSON settings 必须是对象")
		}
	}
	var st tauriState
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, fmt.Errorf("旧 JSON 字段类型无法识别：%w", err)
	}
	m := &tauriMedia{s: s, mapped: map[string]string{}}
	cv := convertTauri(&st, m)
	var msgs []Message
	importTauriMessages(&msgs, st.Messages)

	s.mu.Lock()
	valid := map[string]bool{SectionInbox: true, SectionClipboard: true}
	for _, x := range s.sections {
		valid[x.ID] = true
	}
	for _, x := range cv.sections {
		valid[x.ID] = true
	}
	for i := range cv.notes { // 同 Tauri normalizeNoteRecord：分组不存在的卡落到收件箱
		if !valid[cv.notes[i].Section] {
			cv.notes[i].Section = SectionInbox
		}
	}
	p := &Preview{Manifest: Manifest{Format: LegacyJSONFormat}, media: map[string][]byte{}}
	for _, n := range cv.notes {
		if s.index(n.ID) >= 0 {
			p.Overlap++
		} else {
			p.New++
		}
	}
	s.mu.Unlock()
	p.snap = snapshot{Notes: cv.notes, Sections: cv.sections, Tasks: cv.tasks, TaskSections: cv.taskSecs,
		Bills: cv.bills, Secrets: cv.secrets, Messages: msgs}
	p.Manifest.Counts = counts(p.snap)
	p.MissingMedia = m.missing
	return p, nil
}

func readFileCapped(path string) ([]byte, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if fi.Size() > maxLegacyJSON {
		return nil, errors.New("文件过大")
	}
	return os.ReadFile(path)
}

// TauriSnapshotFormat：Tauri 加密迁移时留下的「迁移保险档」recovery/pre-encrypt-*.bak（TSK1 信封，Recovery 用途）。
const TauriSnapshotFormat = "tauri-pre-encrypt"

// InspectTauriSnapshot 同 Tauri read_pre_encrypt_snapshot：用 Tauri 数据密钥解开保险档，转成原生快照供合并预览。
// mediaDir 是保险档所属的 Tauri 数据目录（图片从它的 media/ 读，预览时就存进本机媒体库）。
func (s *Store) InspectTauriSnapshot(path, mediaDir string, key []byte) (*Preview, error) {
	raw, err := readFileCapped(path)
	if err != nil {
		return nil, err
	}
	if !Sealed(raw) {
		return nil, errors.New("迁移保险档不是 TSK1 加密信封")
	}
	plain, err := Open(key, PurposeRecovery, raw)
	if err != nil {
		return nil, fmt.Errorf("迁移保险档解密失败（需要 Tauri 版的数据密钥）：%w", err)
	}
	st, err := parseTauriDoc(plain)
	if err != nil {
		return nil, err
	}
	m := &tauriMedia{s: s, dir: mediaDir, key: key, mapped: map[string]string{}}
	cv := convertTauri(st, m)
	var msgs []Message
	importTauriMessages(&msgs, st.Messages)
	p := &Preview{Manifest: Manifest{Format: TauriSnapshotFormat}, media: map[string][]byte{}, MissingMedia: m.missing,
		snap: snapshot{Notes: cv.notes, Sections: cv.sections, Tasks: cv.tasks, TaskSections: cv.taskSecs,
			Bills: cv.bills, Secrets: cv.secrets, Messages: msgs}}
	p.Manifest.Counts = counts(p.snap)
	s.mu.Lock()
	for _, n := range p.snap.Notes {
		if s.index(n.ID) >= 0 {
			p.Overlap++
		} else {
			p.New++
		}
	}
	s.mu.Unlock()
	return p, nil
}

// mergeSnapshotNotes 同 Tauri mergePreEncryptSnapshotWithCurrent 的笔记规则：同 ID 取改动时间更新的一侧（缺改动时间用创建时间）。
func mergeSnapshotNotes(cur *[]Note, hist []Note, added *int) {
	at := func(n Note) int64 {
		if !n.UpdatedAt.IsZero() {
			return n.UpdatedAt.UnixMilli()
		}
		return n.CreatedAt.UnixMilli()
	}
	idx := map[string]int{}
	for i, n := range *cur {
		idx[n.ID] = i
	}
	for _, h := range hist {
		if i, ok := idx[h.ID]; ok {
			if at((*cur)[i]) < at(h) {
				(*cur)[i] = h
			}
			continue
		}
		*cur = append(*cur, h)
		*added++
	}
}
