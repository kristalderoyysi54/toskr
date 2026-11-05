// Package store 是原生版的笔记队列与加密持久化。
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	SectionInbox     = "inbox"
	SectionClipboard = "clipboard"
	DataFile         = "toskr-native.json"
	// ClipboardLimit 剪贴板分组最多保留条数（超出丢最旧的未置顶项）。
	ClipboardLimit = 200
)

type Note struct {
	ID        string    `json:"id"`
	Section   string    `json:"section"`
	Text      string    `json:"text"`
	HTML      string    `json:"html,omitempty"`
	SourceApp string    `json:"sourceApp,omitempty"`
	BundleID  string    `json:"bundleId,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	SentAt    time.Time `json:"sentAt,omitzero"`
	Kept      bool      `json:"kept,omitempty"`
	Done      bool      `json:"done,omitempty"`
	Kind      string    `json:"kind,omitempty"` // text | link | code | image
	LinkTitle string    `json:"linkTitle,omitempty"`
	Tags      []string  `json:"tags,omitempty"` // 标签（详情窗编辑；同 Tauri note.tags） // 链接卡的网页标题（与 Tauri 数据同名字段；缺省展示 URL）
	ImageFile string    `json:"imageFile,omitempty"`
	ImageW    int       `json:"imageW,omitempty"`
	ImageH    int       `json:"imageH,omitempty"`
}

type Settings struct {
	TriggerModifier string   `json:"triggerModifier"` // shift | control | option
	TriggerGapMs    int      `json:"triggerGapMs"`
	ClipboardWatch  bool     `json:"clipboardWatch"`
	ExcludedApps    []string `json:"excludedApps"`
	Glass           string   `json:"glass"` // glass | clear | none
	PanelHotkey     string   `json:"panelHotkey"`
	Language        string   `json:"language"`       // system | zh | en
	Stealth         bool     `json:"stealth"`        // 隐身：只保留 warn 气泡
	ClipRetainDays  int      `json:"clipRetainDays"` // 剪贴板保留天数（0 = 不按时间清理）
	PasteThenEnter  bool     `json:"pasteThenEnter"` // 粘贴后回车（终端类目标默认关闭）
	ScreenshotKey   string   `json:"screenshotKey"`
	AIEndpoint      string   `json:"aiEndpoint"`
	AIModel         string   `json:"aiModel"`
	Companion       []string `json:"companion"` // 伴随停靠的应用 bundle id
	EdgeHide        bool     `json:"edgeHide"`
	Currency        string   `json:"currency"`
	DueReminders    bool     `json:"dueReminders"`
	// 与 Tauri 一致的可选功能域（默认关闭）：订阅进「提醒」页第三个子视图，秘文进「内容」页
	SubscriptionsEnabled bool `json:"subscriptionsEnabled"`
	SecretEnabled        bool `json:"secretEnabled"`
	// 面板菜单「位置与停靠」：CompanionOff 关闭跟随应用；FreeMove 不再自动贴屏幕右缘
	SecretKeys         []SecretKey `json:"secretKeys,omitempty"`
	SecretDefaultKeyID string      `json:"secretDefaultKeyId,omitempty"`
	SecretCipherStyle  string      `json:"secretCipherStyle,omitempty"` // classic | code | log | quote
	SecretRevealMs     int         `json:"secretRevealTimeoutMs"`       // 显现后自动回遮罩（0 = 不自动）
	// 窗口与外观（与 Tauri 同名设置；布尔用「关闭」语义，旧数据缺字段即默认开启）
	Theme          string `json:"theme,omitempty"`             // system | light | dark
	ColorScheme    string `json:"colorScheme,omitempty"`       // default | platinum | paper | matcha | sakura | fog
	CardDensity    string `json:"cardDensity,omitempty"`       // comfortable | compact
	PtHighlight    string `json:"platinumHighlight,omitempty"` // lavender | blue | teal | graphite
	PtScrollbar    string `json:"platinumScrollbar,omitempty"` // classic | thin
	PanelNotOnTop  bool   `json:"panelNotOnTop,omitempty"`     // 面板置顶（默认开）
	KeepOnBlur     bool   `json:"keepOnBlur,omitempty"`        // 失焦自动隐藏（默认开）
	SoundOff       bool   `json:"soundOff,omitempty"`          // 捕获音效（默认开）
	DetailFontSize int    `json:"detailFontSize,omitempty"`    // 详情窗字号 10–24，0 = 12
	CompanionOff   bool   `json:"companionOff,omitempty"`
	FreeMove       bool   `json:"freeMove,omitempty"`
}

func DefaultSettings() Settings {
	// 评估期默认值与已安装的 Tauri 版错开（⌥ 双击、⌃⌥Space），两版并存时一次按键
	// 不会同时触发两边；替换 Tauri 版后可在设置里改回 ⇧ 与 ⌘⇧C。
	return Settings{
		TriggerModifier: "option", TriggerGapMs: 400, ClipboardWatch: true, Glass: "glass",
		PanelHotkey: "Ctrl+Alt+Space", Language: "system", ClipRetainDays: 7,
		ScreenshotKey: "Ctrl+Alt+A", AIEndpoint: "https://api.openai.com/v1", AIModel: "gpt-4o-mini",
		Companion: []string{"com.googlecode.iterm2", "com.apple.Terminal", "com.todesktop.230313mzl4w4u92", "com.microsoft.VSCode"},
		EdgeHide:  true, Currency: "¥", DueReminders: true, SecretRevealMs: 8000, DetailFontSize: 12,
		ExcludedApps: []string{"com.1password.1password", "com.apple.keychainaccess", "com.bitwarden.desktop"},
	}
}

type snapshot struct {
	Version      int       `json:"version"`
	Notes        []Note    `json:"notes"`
	Settings     Settings  `json:"settings"`
	Sections     []Section `json:"sections,omitempty"`
	Tasks        []Task    `json:"tasks,omitempty"`
	TaskSections []Section `json:"taskSections,omitempty"`
	Bills        []Bill    `json:"bills,omitempty"`
	Secrets      []Secret  `json:"secrets,omitempty"`
}

// PersistDelay 合并连续修改的落盘延迟：内存与界面即时生效，磁盘写入在后台线程合并执行
// （每次全量加密 + fsync 约 8ms/800 条，逐次同步写会卡住主线程，实测 900 次写入 7.4s）。
var PersistDelay = 300 * time.Millisecond

// Store 线程安全；修改即时生效并通知，落盘延迟合并（Flush 立即写出）。
type Store struct {
	mu           sync.Mutex
	writeMu      sync.Mutex // 串行化磁盘写入
	dir          string
	key          []byte
	notes        []Note
	settings     Settings
	sections     []Section
	tasks        []Task
	taskSections []Section
	bills        []Bill
	secrets      []Secret
	onChange     []func()
	dirty        bool
	timer        *time.Timer
	OnError      func(error) // 后台落盘失败回调
}

// Open 读取 dir 下的数据文件；文件不存在视为全新安装。密钥错误显式报错，不返回空集合。
func OpenDir(dir string, key []byte) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, key: key, settings: DefaultSettings()}
	defer s.ensureDefaults()
	raw, err := os.ReadFile(filepath.Join(dir, DataFile))
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	plain := raw
	if Sealed(raw) {
		if plain, err = Open(key, PurposeData, raw); err != nil {
			return nil, err
		}
	}
	var snap snapshot
	if err := json.Unmarshal(plain, &snap); err != nil {
		return nil, ErrCorrupt
	}
	s.notes, s.settings = snap.Notes, mergeSettings(snap.Settings)
	s.sections, s.tasks, s.taskSections, s.bills, s.secrets = snap.Sections, snap.Tasks, snap.TaskSections, snap.Bills, snap.Secrets
	return s, nil
}

func (s *Store) OnChange(fn func()) { s.mu.Lock(); s.onChange = append(s.onChange, fn); s.mu.Unlock() }

func (s *Store) Notes() []Note      { s.mu.Lock(); defer s.mu.Unlock(); return slices.Clone(s.notes) }
func (s *Store) Settings() Settings { s.mu.Lock(); defer s.mu.Unlock(); return s.settings }

// Section 返回某分组的笔记（保持队列顺序）。
func (s *Store) Section(section string) []Note {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Note
	for _, n := range s.notes {
		if n.Section == section {
			out = append(out, n)
		}
	}
	return out
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Add 入库到分组顶部；同分组已有相同正文则移到顶部并返回 duplicate=true。
func (s *Store) Add(n Note) (Note, bool, error) {
	n.Text = strings.TrimRight(n.Text, "\n")
	if strings.TrimSpace(n.Text) == "" {
		return Note{}, false, errors.New("空内容")
	}
	s.mu.Lock()
	dup := false
	if i := slices.IndexFunc(s.notes, func(o Note) bool { return o.Section == n.Section && o.Text == n.Text }); i >= 0 {
		n = s.notes[i]
		s.notes = slices.Delete(s.notes, i, i+1)
		dup = true
	} else {
		if n.ID == "" {
			n.ID = newID()
		}
		if n.CreatedAt.IsZero() {
			n.CreatedAt = time.Now()
		}
	}
	s.notes = slices.Insert(s.notes, 0, n)
	if n.Section == SectionClipboard {
		s.trimClipboard()
	}
	s.schedulePersistLocked()
	s.mu.Unlock()
	s.notify()
	return n, dup, nil
}

func (s *Store) trimClipboard() {
	count := 0
	s.notes = slices.DeleteFunc(s.notes, func(n Note) bool {
		if n.Section != SectionClipboard || n.Kept {
			return false
		}
		count++
		return count > ClipboardLimit
	})
}

func (s *Store) mutate(fn func() bool) error {
	s.mu.Lock()
	if !fn() {
		s.mu.Unlock()
		return nil
	}
	s.schedulePersistLocked()
	s.mu.Unlock()
	s.notify()
	return nil
}

func (s *Store) schedulePersistLocked() {
	s.dirty = true
	if s.timer == nil {
		s.timer = time.AfterFunc(PersistDelay, func() {
			if err := s.Flush(); err != nil && s.OnError != nil {
				s.OnError(err)
			}
		})
	}
}

// Flush 立即把未落盘的修改写出（退出前、测试中调用）。
func (s *Store) Flush() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	if !s.dirty {
		s.mu.Unlock()
		return nil
	}
	plain, err := json.Marshal(s.snapshotLocked())
	s.dirty = false
	s.mu.Unlock()
	if err != nil {
		return err
	}
	sealed, err := Seal(s.key, PurposeData, plain)
	if err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(s.dir, DataFile), sealed); err != nil {
		s.mu.Lock()
		s.dirty = true
		s.mu.Unlock()
		return err
	}
	return nil
}

func (s *Store) index(id string) int {
	return slices.IndexFunc(s.notes, func(n Note) bool { return n.ID == id })
}

// Delete 删除并返回被删项（供撤销）。
func (s *Store) Delete(id string) (Note, int, bool) {
	var removed Note
	pos, ok := -1, false
	_ = s.mutate(func() bool {
		if pos = s.index(id); pos < 0 {
			return false
		}
		removed, ok = s.notes[pos], true
		s.notes = slices.Delete(s.notes, pos, pos+1)
		return true
	})
	return removed, pos, ok
}

// Restore 把撤销的项放回原位置。
func (s *Store) Restore(n Note, pos int) error {
	return s.mutate(func() bool {
		if s.index(n.ID) >= 0 {
			return false
		}
		pos = min(max(pos, 0), len(s.notes))
		s.notes = slices.Insert(s.notes, pos, n)
		return true
	})
}

func (s *Store) Update(id, text string) error {
	return s.mutate(func() bool {
		i := s.index(id)
		if i < 0 || s.notes[i].Text == text {
			return false
		}
		s.notes[i].Text, s.notes[i].HTML = text, ""
		return true
	})
}

// SetTags 覆盖笔记标签（去空白、去重、保序）。
func (s *Store) SetTags(id string, tags []string) error {
	var clean []string
	for _, t := range tags {
		if t = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(t), "#")); t != "" && !slices.Contains(clean, t) {
			clean = append(clean, t)
		}
	}
	return s.mutate(func() bool {
		i := s.index(id)
		if i < 0 || slices.Equal(s.notes[i].Tags, clean) {
			return false
		}
		s.notes[i].Tags = clean
		return true
	})
}

// Note 按 id 取一条（详情窗刷新用）。
func (s *Store) Note(id string) (Note, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i := s.index(id); i >= 0 {
		return s.notes[i], true
	}
	return Note{}, false
}

// MarkSent 发送成功：记录发送时间；所在分组未设 KeepAfterSend 时同时标记完成。
func (s *Store) MarkSent(ids []string, at time.Time) error {
	return s.mutate(func() bool {
		changed := false
		for _, id := range ids {
			if i := s.index(id); i >= 0 {
				s.notes[i].SentAt, changed = at, true
				if sec, ok := s.section(s.notes[i].Section); !ok || !sec.KeepAfterSend {
					s.notes[i].Done = true
				}
			}
		}
		return changed
	})
}

func (s *Store) SetKept(id string, kept bool) error {
	return s.mutate(func() bool {
		i := s.index(id)
		if i < 0 || s.notes[i].Kept == kept {
			return false
		}
		s.notes[i].Kept = kept
		return true
	})
}

// MoveTo 把 id 移到某分组顶部（例如剪贴板项「转为笔记」）。
func (s *Store) MoveTo(id, section string) error {
	return s.mutate(func() bool {
		i := s.index(id)
		if i < 0 || s.notes[i].Section == section {
			return false
		}
		n := s.notes[i]
		n.Section = section
		s.notes = slices.Insert(slices.Delete(s.notes, i, i+1), 0, n)
		return true
	})
}

// Reorder 在分组内把 ids 按给定顺序排列（分组外的项位置不变）。
func (s *Store) Reorder(section string, ids []string) error {
	return s.mutate(func() bool {
		var slots []int
		byID := map[string]Note{}
		for i, n := range s.notes {
			if n.Section == section {
				slots = append(slots, i)
				byID[n.ID] = n
			}
		}
		if len(ids) != len(slots) {
			return false
		}
		for k, id := range ids {
			n, ok := byID[id]
			if !ok {
				return false
			}
			s.notes[slots[k]] = n
		}
		return true
	})
}

// ClearSection 清空分组（保留置顶项），返回被清掉的数量。
func (s *Store) ClearSection(section string) int {
	removed := 0
	_ = s.mutate(func() bool {
		s.notes = slices.DeleteFunc(s.notes, func(n Note) bool {
			if n.Section == section && !n.Kept {
				removed++
				return true
			}
			return false
		})
		return removed > 0
	})
	return removed
}

func (s *Store) SetSettings(st Settings) error {
	return s.mutate(func() bool { s.settings = st; return true })
}

// Search 在全部笔记中做不区分大小写的子串匹配。
func Search(notes []Note, q string) []Note {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return notes
	}
	var out []Note
	for _, n := range notes {
		if strings.Contains(strings.ToLower(n.Text), q) || strings.Contains(strings.ToLower(n.SourceApp), q) {
			out = append(out, n)
		}
	}
	return out
}

func (s *Store) notify() {
	s.mu.Lock()
	fns := slices.Clone(s.onChange)
	s.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
}

func atomicWrite(path string, data []byte) error {
	tmp := path + ".tmp-" + newID()
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// Fingerprint 只含条数与内容哈希前缀，供诊断日志（不含正文）。
func Fingerprint(notes []Note) string {
	h := sha256.New()
	for _, n := range notes {
		h.Write([]byte(n.ID))
	}
	return hex.EncodeToString(h.Sum(nil))[:12]
}

func (s *Store) snapshotLocked() snapshot {
	return snapshot{Version: 2, Notes: s.notes, Settings: s.settings, Sections: s.sections,
		Tasks: s.tasks, TaskSections: s.taskSections, Bills: s.bills, Secrets: s.secrets}
}

// mergeSettings 用默认值补齐旧版本数据里缺的字段（只补零值）。
func mergeSettings(st Settings) Settings {
	d := DefaultSettings()
	if st.TriggerModifier == "" {
		return d
	}
	if st.DetailFontSize == 0 {
		st.DetailFontSize = 12
	}
	if st.Language == "" {
		st.Language = d.Language
	}
	if st.ScreenshotKey == "" {
		st.ScreenshotKey = d.ScreenshotKey
	}
	if st.AIEndpoint == "" {
		st.AIEndpoint, st.AIModel = d.AIEndpoint, d.AIModel
	}
	if st.Currency == "" {
		st.Currency = d.Currency
	}
	if st.Companion == nil {
		st.Companion = d.Companion
	}
	return st
}
