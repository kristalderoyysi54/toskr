package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// MergeReport：一次并入的结果（预览时是「将会」的数量）。
type MergeReport struct {
	Notes, Updated   int // 新增的笔记与置顶剪贴（其中剪贴 Clips 条），同一条两边都有且这边更新的
	Clips, ClipSkip  int // 新增里的置顶剪贴数；没置顶而不带的剪贴数（剪贴历史量大、会过期，只带置顶的）
	ClipDup, Gone    int // 内容与目标已有剪贴相同而跳过的；上次并入过、目标那边已删而不再带回的
	Sections, Tasks  int
	Bills, Secrets   int
	Messages, Media  int
	TargetNotes      int // 并入后目标的笔记总数
	Recovery, Target string
}

// Empty：没有任何东西要并过去。
func (r MergeReport) Empty() bool {
	return r.Notes+r.Updated+r.Sections+r.Tasks+r.Bills+r.Secrets+r.Messages == 0
}

const mergeStateFile = "toskr-merged-ids.json" // 放在源目录：并入过哪些记录（目标那边删掉的不再带回）

func (s *Store) mergeState(dst string) map[string]bool {
	out := map[string]bool{}
	raw, err := os.ReadFile(filepath.Join(s.dir, mergeStateFile))
	if err != nil {
		return out
	}
	var all map[string][]string
	if json.Unmarshal(raw, &all) == nil {
		for _, id := range all[filepath.Clean(dst)] {
			out[id] = true
		}
	}
	return out
}

func (s *Store) saveMergeState(dst string, ids map[string]bool) error {
	path := filepath.Join(s.dir, mergeStateFile)
	all := map[string][]string{}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &all)
	}
	list := make([]string, 0, len(ids))
	for id := range ids {
		list = append(list, id)
	}
	slices.Sort(list)
	all[filepath.Clean(dst)] = list
	raw, err := json.Marshal(all)
	if err != nil {
		return err
	}
	return atomicWrite(path, raw)
}

// MergeInto 把本库的内容并入 dst 里用另一把密钥 key 加密的那份数据（迭代期 → 正式版，可反复执行）：
//   - 按记录 ID 去重：目标没有的补进去；笔记两边都有时取改动时间更新的一侧，其余记录以目标为准；
//   - 上次并入过、目标那边已经删掉的不再带回（并入过的 ID 记在本库目录的 toskr-merged-ids.json）；
//   - 本库有而目标没有的分组：目标有同名分组就归到那个分组，否则新建；
//   - 剪贴只带置顶（★）的，且内容与目标已有剪贴相同的不重复带；目标的设置不动；
//   - apply = false 只算数量，不写任何东西；apply = true 先在目标写恢复点，再写入并回读核对。
//
// 本库与原密钥下的文件不动。调用方须保证此刻没有别的进程在写 dst。
func (s *Store) MergeInto(dst string, key []byte, apply bool) (MergeReport, error) {
	rep := MergeReport{Target: dst}
	if len(key) != 32 {
		return rep, errors.New("目标密钥长度不对")
	}
	if SameOrNested(s.dir, dst) {
		return rep, errors.New("目标目录不能与当前数据目录重叠")
	}
	if _, err := os.Stat(filepath.Join(dst, DataFile)); err != nil {
		return rep, errors.New("目标目录里还没有数据")
	}
	if err := s.Flush(); err != nil {
		return rep, err
	}
	s.mu.Lock()
	plain, err := json.Marshal(s.snapshotLocked())
	s.mu.Unlock()
	if err != nil {
		return rep, err
	}
	var src snapshot // 经 JSON 深拷贝，与本库不共享切片
	if err := json.Unmarshal(plain, &src); err != nil {
		return rep, err
	}
	t, err := OpenDir(dst, key)
	if err != nil {
		return rep, fmt.Errorf("打不开目标数据：%w", err)
	}
	t.mu.Lock()
	if t.timer != nil { // 打开时补默认值排的那次落盘：撤掉，预览绝不写目标
		t.timer.Stop()
		t.timer = nil
	}
	t.dirty = false
	plain, err = json.Marshal(t.snapshotLocked())
	t.mu.Unlock()
	if err != nil {
		return rep, err
	}
	var cur snapshot
	if err := json.Unmarshal(plain, &cur); err != nil {
		return rep, err
	}

	sent := s.mergeState(dst)
	media := map[string]bool{}
	// 分组：同 ID 以目标为准；目标没有的按名字对上，否则新建（排在剪贴板前）
	remap := func(curSecs *[]Section, in []Section) map[string]string {
		m := map[string]string{}
		for _, x := range in {
			if slices.ContainsFunc(*curSecs, func(y Section) bool { return y.ID == x.ID }) {
				continue
			}
			if i := slices.IndexFunc(*curSecs, func(y Section) bool { return y.Name != "" && strings.EqualFold(y.Name, x.Name) }); i >= 0 {
				m[x.ID] = (*curSecs)[i].ID
				continue
			}
			at := len(*curSecs)
			if i := slices.IndexFunc(*curSecs, func(y Section) bool { return y.ID == SectionClipboard }); i >= 0 {
				at = i
			}
			*curSecs = slices.Insert(*curSecs, at, x)
			rep.Sections++
		}
		return m
	}
	noteSec := remap(&cur.Sections, src.Sections)
	taskSec := remap(&cur.TaskSections, src.TaskSections)

	at := func(n Note) time.Time {
		if !n.UpdatedAt.IsZero() {
			return n.UpdatedAt
		}
		return n.CreatedAt
	}
	clipKey := func(n Note) string {
		return n.Text + "\x00" + n.ImageFile + "\x00" + strings.Join(n.Attachments, "\x00")
	}
	idx, clips := map[string]int{}, map[string]bool{}
	for i, n := range cur.Notes {
		idx[n.ID] = i
		if n.Section == SectionClipboard {
			clips[clipKey(n)] = true
		}
	}
	var fresh []Note
	for _, n := range src.Notes {
		if to, ok := noteSec[n.Section]; ok {
			n.Section = to
		}
		if i, ok := idx[n.ID]; ok {
			if at(cur.Notes[i]).Before(at(n)) {
				old := cur.Notes[i] // 归在哪个分组、完成与否、发送次数以目标为准（这些改动不更新改动时间）
				n.Section, n.Done, n.SendCount = old.Section, old.Done, max(old.SendCount, n.SendCount)
				cur.Notes[i] = n
				rep.Updated++
				for _, f := range n.MediaFiles() {
					media[f] = true
				}
			}
			continue
		}
		if n.Section == SectionClipboard && clips[clipKey(n)] {
			rep.ClipDup++
			continue
		}
		if sent[n.ID] {
			rep.Gone++
			continue
		}
		if n.Section == SectionClipboard {
			if !n.Kept {
				rep.ClipSkip++
				continue
			}
			rep.Clips++
		}
		fresh = append(fresh, n)
		for _, f := range n.MediaFiles() {
			media[f] = true
		}
	}
	rep.Notes = len(fresh)
	cur.Notes = append(fresh, cur.Notes...) // 新带来的排前面（列表新的在上）

	for i := range src.Tasks {
		if to, ok := taskSec[src.Tasks[i].Section]; ok {
			src.Tasks[i].Section = to
		}
	}
	src.Tasks = slices.DeleteFunc(src.Tasks, func(x Task) bool { return sent[x.ID] })
	src.Bills = slices.DeleteFunc(src.Bills, func(x Bill) bool { return sent[x.ID] })
	src.Secrets = slices.DeleteFunc(src.Secrets, func(x Secret) bool { return sent[x.ID] })
	gone := map[string]bool{}
	for _, id := range cur.MessagesGone {
		gone[id] = true
	}
	src.Messages = slices.DeleteFunc(src.Messages, func(x Message) bool { return sent[x.ID] || gone[x.ID] })
	had := map[string]bool{} // 目标原有的消息
	for _, m := range cur.Messages {
		had[m.ID] = true
	}
	bills, dummy := len(cur.Bills), 0
	mergeByID(&cur.Tasks, src.Tasks, func(x Task) string { return x.ID }, &rep.Tasks)
	mergeByID(&cur.Bills, src.Bills, func(x Bill) string { return x.ID }, &rep.Bills)
	mergeByID(&cur.Secrets, src.Secrets, func(x Secret) string { return x.ID }, &rep.Secrets)
	mergeByID(&cur.Deliveries, src.Deliveries, func(x Delivery) string { return x.ID }, &dummy)
	mergeByID(&cur.Messages, src.Messages, func(x Message) string { return x.ID }, &rep.Messages)
	mergeOutcomes(&cur.Outcomes, src.Outcomes)
	sortMessages(cur.Messages)
	for _, b := range cur.Bills[bills:] {
		if b.IconFile != "" {
			media[b.IconFile] = true
		}
	}
	for _, m := range cur.Messages {
		if had[m.ID] {
			continue
		}
		for _, f := range m.Images {
			media[f] = true
		}
		for _, x := range m.Context {
			for _, f := range x.Images {
				media[f] = true
			}
		}
	}
	rep.Media, rep.TargetNotes = len(media), len(cur.Notes)
	if !apply || rep.Empty() {
		return rep, nil
	}

	if rep.Recovery, err = t.WriteRecoveryPoint("pre-merge", time.Now()); err != nil {
		return rep, fmt.Errorf("目标的恢复点写入失败，没有并入：%w", err)
	}
	rep.Media = 0
	for f := range media {
		raw, err := s.LoadImage(f)
		if err != nil {
			continue // 本来就读不出的图：不带（引用它的笔记照旧显示缺图）
		}
		if _, err := t.SaveImage(raw); err != nil {
			return rep, err
		}
		rep.Media++
	}
	if err := t.mutate(func() bool {
		t.notes, t.sections, t.tasks, t.taskSections = cur.Notes, cur.Sections, cur.Tasks, cur.TaskSections
		t.bills, t.secrets, t.deliveries, t.outcomes, t.messages = cur.Bills, cur.Secrets, cur.Deliveries, cur.Outcomes, cur.Messages
		return true
	}); err != nil {
		return rep, err
	}
	if err := t.Flush(); err != nil {
		return rep, err
	}
	info, err := InspectDir(dst, key)
	if err != nil {
		return rep, err
	}
	if info.Notes != len(cur.Notes) || info.Tasks != len(cur.Tasks) {
		return rep, fmt.Errorf("并入后核对不一致：笔记 %d/%d、任务 %d/%d", info.Notes, len(cur.Notes), info.Tasks, len(cur.Tasks))
	}
	for _, n := range src.Notes {
		if n.Section != SectionClipboard || n.Kept { // 没带的剪贴不记：以后置顶了还能带
			sent[n.ID] = true
		}
	}
	for _, x := range src.Tasks {
		sent[x.ID] = true
	}
	for _, x := range src.Bills {
		sent[x.ID] = true
	}
	for _, x := range src.Secrets {
		sent[x.ID] = true
	}
	for _, x := range src.Messages {
		sent[x.ID] = true
	}
	return rep, s.saveMergeState(dst, sent)
}
