// Package store 是原生版的笔记队列与加密持久化。
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/toskr/native/internal/codehl"
	"github.com/toskr/native/internal/linkmeta"
)

const (
	SectionInbox     = "inbox"
	SectionClipboard = "clipboard"
	DataFile         = "toskr-native.json"
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
	// 与 Tauri Note 同名同义的字段（Tauri 数据导入与后续功能对齐用）
	Title       string         `json:"title,omitempty"`       // 自定义标题（右键「重命名」）
	Blur        bool           `json:"blur,omitempty"`        // 模糊内容（卡面打码防肩窥）
	Attachments []string       `json:"attachments,omitempty"` // 附加图片（合并后的组合卡）
	Blocks      []ContentBlock `json:"contentBlocks,omitempty"`
	URL         string         `json:"url,omitempty"` // 链接卡
	LinkIcon    string         `json:"linkIcon,omitempty"`
	CodeLang    string         `json:"codeLang,omitempty"`
	UpdatedAt   time.Time      `json:"updatedAt,omitzero"`
	Provenance  *Provenance    `json:"provenance,omitempty"` // 回复笔记：来自哪次发送
}

// ContentBlock 是富卡的权威内容块（同 Tauri NoteContentBlock）：文字或图片。
type ContentBlock struct {
	Type   string `json:"type"` // text | image
	Text   string `json:"text,omitempty"`
	File   string `json:"file,omitempty"`
	Alt    string `json:"alt,omitempty"`
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
}

// MediaFiles：笔记引用的全部媒体文件（主图、附件、内容块里的图）。
func (n Note) MediaFiles() []string {
	var out []string
	add := func(f string) {
		if f != "" && !slices.Contains(out, f) {
			out = append(out, f)
		}
	}
	add(n.ImageFile)
	for _, f := range n.Attachments {
		add(f)
	}
	for _, b := range n.Blocks {
		add(b.File)
	}
	return out
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
	// 按来源单独设定的保留天数（同 Tauri clipAppRetentionDays，键 = bundle id，没有则应用名），优先于全局
	ClipAppRetention map[string]int `json:"clipAppRetentionDays,omitempty"`
	PasteThenEnter   bool           `json:"pasteThenEnter"`          // 粘贴后回车（终端类目标默认关闭）
	NewNoteKey       string         `json:"newNoteHotkey,omitempty"` // 全局新建笔记（空 = 不注册）
	// 双击行为（同 Tauri doubleTapCaptureOnly：true = 只划词捕获，无选中时不开关面板）与捕获存入的分组（空 = 收件箱）
	DoubleTapCaptureOnly bool   `json:"doubleTapCaptureOnly,omitempty"`
	CaptureSection       string `json:"captureSectionId,omitempty"`
	LastDraftSection     string `json:"lastDraftSectionId,omitempty"` // 底部输入框所选分组（同 Tauri settings.lastDraftSectionId）
	DraftText            string `json:"draftText,omitempty"`          // 输入框未提交的草稿（同 Tauri store.draftText，随数据加密落盘）
	// 剪贴板（同 Tauri clipPauseUntil / clipDoubleCopyKeep / clipIgnoreConcealed / clipIgnoreTransient；布尔用「关闭」语义，缺字段即默认开）
	ClipPauseUntil    time.Time `json:"clipPauseUntil,omitzero"`
	ClipDoubleCopyOff bool      `json:"clipDoubleCopyKeepOff,omitempty"`
	ClipKeepConcealed bool      `json:"clipKeepConcealed,omitempty"` // true = 不忽略密码管理器 / 隐藏内容
	ClipKeepTransient bool      `json:"clipKeepTransient,omitempty"` // true = 不忽略瞬时内容
	// 外观细项（同 Tauri windowOpacity / panelOpacity / cardOpacity / hudDurationMs / companionGap；0 / nil = 默认）
	WindowOpacity  float64      `json:"windowOpacity,omitempty"`          // 0.3–1，默认 1
	PanelOpacity   float64      `json:"panelOpacity,omitempty"`           // 内容底色浓度 0.25–1，默认 0.62
	CardOpacity    float64      `json:"cardOpacity,omitempty"`            // 0.3–1，默认 1
	HUDDurationMs  int          `json:"hudDurationMs,omitempty"`          // 2000–10000，默认 3000
	CompanionGap   *int         `json:"companionGap,omitempty"`           // 0–40，默认 8
	CardTintOff    bool         `json:"cardTintOff,omitempty"`            // 卡片彩色通栏（Tauri cardTint，默认开）
	ClipTemplate   string       `json:"clipCardTemplate,omitempty"`       // 剪贴卡模板：standard | condensed（仅舒适密度）
	ContextMenu    []MenuItem   `json:"contextMenu,omitempty"`            // 卡片右键菜单的显隐与区内顺序（空 = 默认）
	CalendarOn     bool         `json:"appleCalendarEnabled,omitempty"`   // 在「今天」显示苹果日历日程（只读）
	CalendarHidden []string     `json:"appleCalendarHiddenIds,omitempty"` // 不显示的日历
	PageOrder      []string     `json:"pageOrder,omitempty"`              // 一级页签顺序（可拖动重排）
	ScreenshotKey  string       `json:"screenshotKey"`
	ScreenshotOff  bool         `json:"screenshotOff,omitempty"`      // 区域截图总开关（Tauri screenshotEnabled，默认开）
	ShotHideSelf   bool         `json:"screenshotHideSelf,omitempty"` // 截图时隐藏 Toskr 自己的窗口（默认不隐藏）
	AIEndpoint     string       `json:"aiEndpoint"`
	AIModel        string       `json:"aiModel"`
	AIEnabled      *bool        `json:"aiEnabled,omitempty"` // 「AI 智能」总开关（同 Tauri aiEnabled）；nil = 旧数据，按开启
	Companion      []string     `json:"companion"`           // 伴随停靠的应用 bundle id
	EdgeHide       bool         `json:"edgeHide"`
	Currency       string       `json:"currency"`
	DueReminders   bool         `json:"dueReminders"`
	ReminderVia    string       `json:"taskReminderChannel,omitempty"` // 任务提醒方式 hud | system | both（同 Tauri taskReminderChannel，空 = hud）
	DuePresets     *[]DuePreset `json:"duePresets,omitempty"`          // 到期快捷档（同 Tauri duePresets）；nil = 默认七档，空 = 全删了
	// 与 Tauri 一致的可选功能域（默认关闭）：订阅进「提醒」页第三个子视图，秘文进「内容」页
	SubscriptionsEnabled bool   `json:"subscriptionsEnabled"`
	BillView             string `json:"billView,omitempty"` // 订阅页「周 / 月」视图记忆（同 Tauri localStorage）
	SecretEnabled        bool   `json:"secretEnabled"`
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
	// 面板尺寸与位置（同 Tauri set_panel_width / 高度拖拽 / 自由移动位置；0 = 默认：宽 380、高度自动铺满）
	PanelWidth  int    `json:"panelWidth,omitempty"`
	PanelHeight int    `json:"panelHeight,omitempty"`
	PanelTop    int    `json:"panelTopOffset,omitempty"` // 顶部下移量（同 Tauri panelTopOffset；0 = 贴顶）
	PanelX      int    `json:"panelX,omitempty"`
	PanelY      int    `json:"panelY,omitempty"`
	SidebarEdge string `json:"sidebarEdge,omitempty"` // 跟随应用时停在 left | right（默认右侧）
	// 发送方案（同 Tauri promptGroups / targetProfiles / defaultTargetProfileId；空 = 内置默认，见 ProfileConfig）
	PromptGroups     []PromptGroup   `json:"promptGroups,omitempty"`
	TargetProfiles   []TargetProfile `json:"targetProfiles,omitempty"`
	DefaultProfileID string          `json:"defaultTargetProfileId,omitempty"`
	PromptSnippets   []PromptSnippet `json:"promptSnippets,omitempty"`
	RecentSnippets   []string        `json:"recentSnippetIds,omitempty"` // Tauri 存 localStorage
	// 截图编辑器（Tauri 存 localStorage：toskr.screenshotStyle / CalloutStyle / Frame / Crosshair）
	Shot ShotPrefs `json:"shot,omitempty"`
	// IM 消息监听（同 Tauri messagesEnabled / messageWatchRules；监听目标 Tauri 存 localStorage）
	MessagesEnabled bool          `json:"messagesEnabled,omitempty"`
	MessageRules    []MessageRule `json:"messageWatchRules,omitempty"`
	IMProfile       *IMProfile    `json:"imProfile,omitempty"`
	// 定期自动备份（同 Tauri autoBackupEnabled / autoBackupDir / autoBackupKeep / autoBackupLastAtMs；默认开）
	AutoBackupOff  bool      `json:"autoBackupOff,omitempty"`
	AutoBackupDir  string    `json:"autoBackupDir,omitempty"`  // 空 = 文稿/Toskr Native 自动备份
	AutoBackupKeep int       `json:"autoBackupKeep,omitempty"` // 3 | 7 | 14 | 30，0 = 7
	AutoBackupAt   time.Time `json:"autoBackupLastAt,omitempty"`
	// 苹果提醒事项同步（同 Tauri appleReminders*；默认关）
	RemindersOn      bool      `json:"appleRemindersEnabled,omitempty"`
	RemindersListID  string    `json:"appleRemindersListId,omitempty"`
	RemindersAlarm   bool      `json:"appleRemindersAlarm,omitempty"`
	RemindersSection string    `json:"appleRemindersImportSectionId,omitempty"`
	RemindersError   string    `json:"appleRemindersLastError,omitempty"`
	RemindersSyncAt  time.Time `json:"appleRemindersLastSyncAt,omitempty"`
	// 发送前隐私检查（同 Tauri firewallEnabled / firewallDisabledWarnCategories / firewallCustomSensitiveFields；默认开）
	FirewallOff          bool     `json:"firewallOff,omitempty"`
	FirewallDisabledWarn []string `json:"firewallDisabledWarnCategories,omitempty"`
	FirewallCustomFields []string `json:"firewallCustomSensitiveFields,omitempty"`
	// 可逆化名（同 Tauri aliasEntitiesEnabled / aliasEntities / aliasCustomCategories / aliasNextNumberByCategory / aliasAutoRestoreOnCapture；开关用「关闭」语义）
	AliasOff           bool            `json:"aliasOff,omitempty"`
	AliasEntities      []AliasEntity   `json:"aliasEntities,omitempty"`
	AliasCategories    []AliasCategory `json:"aliasCustomCategories,omitempty"`
	AliasNext          map[string]int  `json:"aliasNextNumberByCategory,omitempty"`
	AliasNoAutoRestore bool            `json:"aliasNoAutoRestore,omitempty"`
	// 使用概览（同 Tauri outcomeMetricsEnabled / outcomeRetentionDays / outcomeMetricsEpoch；开关用「关闭」语义）
	OutcomeOff       bool `json:"outcomeMetricsOff,omitempty"`
	OutcomeRetention int  `json:"outcomeRetentionDays,omitempty"` // 7 / 30 / 90，0 = 30
	OutcomeEpoch     int  `json:"outcomeMetricsEpoch,omitempty"`
	// 首启导览与上手演练（同 Tauri welcomeTourSeen / onboarding）
	WelcomeTourSeen bool            `json:"welcomeTourSeen,omitempty"`
	Onboarding      OnboardingState `json:"onboarding,omitzero"`
}

// ShotPrefs 是截图编辑器记住的使用习惯；零值都表示默认（粗细存档位 +1，0 = 默认中档）。
type ShotPrefs struct {
	Ink            string  `json:"ink,omitempty"`        // 标注色，默认 #FF3B30
	SizeLv         int     `json:"sizeLv,omitempty"`     // 粗细档位 +1
	CalloutInk     string  `json:"calloutInk,omitempty"` // 批注单独一套，默认 #007AFF
	CalloutSizeLv  int     `json:"calloutSizeLv,omitempty"`
	Radius         float64 `json:"radius,omitempty"`      // 出图圆角 pt
	Shadow         float64 `json:"shadow,omitempty"`      // 出图阴影 pt，0 = 无
	ShadowAlpha    float64 `json:"shadowAlpha,omitempty"` // 阴影浓淡 %，0 = 默认 45
	Crosshair      string  `json:"crosshair,omitempty"`   // sky | white | lime | magenta
	CrosshairAlpha float64 `json:"crosshairAlpha,omitempty"`
	RedactStyle    int     `json:"redactStyle,omitempty"` // 打码新框样式：0 马赛克 / 1 黑 / 2 白 / 3 取色
}

func DefaultSettings() Settings {
	// 评估期默认值与已安装的 Tauri 版错开（⌥ 双击、⌃⌥Space），两版并存时一次按键
	// 不会同时触发两边；替换 Tauri 版后可在设置里改回 ⇧ 与 ⌘⇧C。
	return Settings{
		TriggerModifier: "option", TriggerGapMs: 400, ClipboardWatch: true, Glass: "glass",
		PanelHotkey: "Ctrl+Alt+Space", Language: "system", ClipRetainDays: 7,
		ScreenshotKey: "Ctrl+Alt+A", AIEndpoint: "https://api.openai.com/v1", AIModel: "gpt-4o-mini", AIEnabled: new(bool),
		Companion: []string{"com.googlecode.iterm2", "com.apple.Terminal", "com.todesktop.230313mzl4w4u92", "com.microsoft.VSCode"},
		EdgeHide:  true, Currency: "¥", DueReminders: true, SecretRevealMs: 8000, DetailFontSize: 12,
		ExcludedApps: []string{"com.1password.1password", "com.apple.keychainaccess", "com.bitwarden.desktop"},
	}
}

type snapshot struct {
	Version      int            `json:"version"`
	Notes        []Note         `json:"notes"`
	Settings     Settings       `json:"settings"`
	Sections     []Section      `json:"sections,omitempty"`
	Tasks        []Task         `json:"tasks,omitempty"`
	TaskSections []Section      `json:"taskSections,omitempty"`
	Bills        []Bill         `json:"bills,omitempty"`
	Secrets      []Secret       `json:"secrets,omitempty"`
	Deliveries   []Delivery     `json:"deliveries,omitempty"`
	Outcomes     []OutcomeEvent `json:"outcomes,omitempty"`
	Messages     []Message      `json:"messages,omitempty"`
	MessagesGone []string       `json:"messagesGone,omitempty"` // 删过的消息标识：重放账本时不再收回
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
	deliveries   []Delivery
	outcomes     []OutcomeEvent
	messages     []Message
	messagesGone []string
	onChange     []func()
	dirty        bool
	timer        *time.Timer
	OnError      func(error) // 后台落盘失败回调
	disk         fileStamp   // 上次读到 / 写出的数据文件状态（外部修改检测）
	conflict     bool        // 数据文件被外部修改：停止自动覆盖，进入只读
	OnConflict   func()      // 检测到外部修改时回调（后台线程）
}

// fileStamp：数据文件的修改时间与大小；外部进程（另一个实例、同步工具）改了文件，二者至少一个会变。
type fileStamp struct {
	mod  time.Time
	size int64
	ok   bool
}

func stampOf(path string) fileStamp {
	fi, err := os.Stat(path)
	if err != nil {
		return fileStamp{}
	}
	return fileStamp{fi.ModTime(), fi.Size(), true}
}

var (
	// ErrConflict：数据文件被外部修改，本次没有覆盖（同 Tauri 持久化 CAS 拒绝）。
	ErrConflict = errors.New("数据文件被外部修改，已停止自动覆盖")
	// ErrReadOnly：冲突待处理期间拒绝修改。
	ErrReadOnly = errors.New("数据只读：请先处理外部修改冲突")
)

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
	s.deliveries, s.outcomes = snap.Deliveries, snap.Outcomes
	s.messages, s.messagesGone = snap.Messages, snap.MessagesGone
	s.disk = stampOf(filepath.Join(dir, DataFile))
	return s, nil
}

// Conflict 报告是否处于「外部修改冲突」只读状态。
func (s *Store) Conflict() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.conflict }

// ReloadFromDisk 丢弃内存里未落盘的修改，重新读入磁盘上的数据文件并解除只读（同 Tauri reloadAfterPersistenceConflict）。
func (s *Store) ReloadFromDisk() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	path := filepath.Join(s.dir, DataFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	plain := raw
	if Sealed(raw) {
		if plain, err = Open(s.key, PurposeData, raw); err != nil {
			return err
		}
	}
	var snap snapshot
	if err := json.Unmarshal(plain, &snap); err != nil {
		return ErrCorrupt
	}
	s.mu.Lock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.notes, s.settings = snap.Notes, mergeSettings(snap.Settings)
	s.sections, s.tasks, s.taskSections, s.bills, s.secrets = snap.Sections, snap.Tasks, snap.TaskSections, snap.Bills, snap.Secrets
	s.deliveries, s.outcomes = snap.Deliveries, snap.Outcomes
	s.messages, s.messagesGone = snap.Messages, snap.MessagesGone
	s.disk, s.conflict, s.dirty = stampOf(path), false, false
	s.mu.Unlock()
	s.ensureDefaults()
	s.notify()
	return nil
}

// SaveMemoryAsRecovery 把内存里的当前数据另存为一个恢复点（冲突时保底，同 Tauri 另存恢复副本），返回路径。
func (s *Store) SaveMemoryAsRecovery(now time.Time) (string, error) {
	s.mu.Lock()
	plain, err := json.Marshal(s.snapshotLocked())
	s.mu.Unlock()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(s.dir, "recovery")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	sealed, err := Seal(s.key, PurposeRecovery, plain)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, fmt.Sprintf("%s%013d-conflict.bak", recoveryPrefix, now.UnixMilli()))
	return path, atomicWrite(path, sealed)
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
	if n.Kind == "" && n.ImageFile == "" && len(n.Attachments) == 0 { // 整段就是链接 → link 卡（同 Tauri detectLink，裸域名补 https://）
		if u := linkmeta.Detect(n.Text); u != "" {
			n.Kind, n.URL = "link", u
		} else if n.CodeLang == "" && len(n.Blocks) == 0 {
			n.CodeLang = codehl.Detect(n.Text) // 同 Tauri addNote：非链接文字卡识别代码语言
		}
	}
	s.mu.Lock()
	if s.conflict {
		s.mu.Unlock()
		s.readOnlyHit()
		return Note{}, false, ErrReadOnly
	}
	dup := false
	if i := slices.IndexFunc(s.notes, func(o Note) bool {
		return o.Section == n.Section && o.Text == n.Text && o.ImageFile == n.ImageFile && slices.Equal(o.Attachments, n.Attachments)
	}); i >= 0 {
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
	s.notes = slices.Insert(s.notes, 0, n) // 剪贴板不设条数上限，只按保留天数清理（同 Tauri pruneClipHistory）
	s.schedulePersistLocked()
	s.mu.Unlock()
	s.notify()
	return n, dup, nil
}

// readOnlyHit：只读期间有修改被拒，交给 OnError 提示（调用方多数忽略返回值，否则用户只会看到「点了没反应」）。
func (s *Store) readOnlyHit() {
	if s.OnError != nil {
		s.OnError(ErrReadOnly)
	}
}

func (s *Store) mutate(fn func() bool) error {
	s.mu.Lock()
	if s.conflict {
		s.mu.Unlock()
		s.readOnlyHit()
		return ErrReadOnly
	}
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
	path := filepath.Join(s.dir, DataFile)
	if s.conflict || stampOf(path) != s.disk { // 别人改过磁盘文件：不覆盖（同 Tauri CAS 拒绝）
		first := !s.conflict
		s.conflict = true
		s.mu.Unlock()
		if first {
			if s.OnConflict != nil {
				s.OnConflict()
			}
			s.notify()
		}
		return ErrConflict
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
	if err := atomicWrite(path, sealed); err != nil {
		s.mu.Lock()
		s.dirty = true
		s.mu.Unlock()
		return err
	}
	s.mu.Lock()
	s.disk = stampOf(path)
	s.mu.Unlock()
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
		n := &s.notes[i]
		n.Text, n.HTML = text, ""
		relink(n)
		return true
	})
}

// relink：编辑后重判链接（同 Tauri normalizeNoteContent）——仍是链接且 URL 变了清掉旧标题图标等重抓；不再是链接则退回文字卡。
func relink(n *Note) {
	if n.Kind != "" && n.Kind != "link" || n.ImageFile != "" || len(n.Attachments) > 0 {
		return
	}
	u := linkmeta.Detect(n.Text)
	switch {
	case u != "":
		if u != n.URL {
			n.LinkTitle, n.LinkIcon = "", ""
		}
		n.Kind, n.URL, n.CodeLang = "link", u, ""
	case n.Kind == "link":
		n.Kind, n.URL, n.LinkTitle, n.LinkIcon = "", "", "", ""
	}
	if n.Kind == "" || n.Kind == "code" { // 同 Tauri normalizeNoteContent：编辑后重判代码语言
		n.CodeLang = codehl.Detect(n.Text)
	}
}

// SetLinkMeta 写入抓到的网页标题 / 图标；抓取期间 URL 被改或卡片已删则丢弃（同 Tauri enrichLinkMeta）。
func (s *Store) SetLinkMeta(id, url, title, icon string) bool {
	ok := false
	_ = s.mutate(func() bool {
		i := s.index(id)
		if i < 0 || s.notes[i].Kind != "link" || s.notes[i].URL != url || title == "" && icon == "" {
			return false
		}
		n := &s.notes[i]
		if title != "" {
			n.LinkTitle = title
		}
		if icon != "" {
			n.LinkIcon = icon
		}
		ok = true
		return true
	})
	return ok
}

// ReplaceImage 换掉图片卡里的图（打码 / 标注写回），返回原图信息供撤销。
func (s *Store) ReplaceImage(id, file string, w, h int) (prevFile string, prevW, prevH int, err error) {
	err = s.mutate(func() bool {
		i := s.index(id)
		if i < 0 || s.notes[i].Kind != "image" {
			return false
		}
		n := &s.notes[i]
		prevFile, prevW, prevH = n.ImageFile, n.ImageW, n.ImageH
		n.ImageFile, n.ImageW, n.ImageH = file, w, h
		return true
	})
	if err == nil && prevFile == "" {
		err = errors.New("图片卡不存在")
	}
	return
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
		Tasks: s.tasks, TaskSections: s.taskSections, Bills: s.bills, Secrets: s.secrets, Deliveries: s.deliveries, Outcomes: s.outcomes,
		Messages: s.messages, MessagesGone: s.messagesGone}
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

// 外观细项的生效值（未设 = Tauri 默认）。
func (st Settings) WindowAlpha() float64 { return orDefault(st.WindowOpacity, 1, 0.3, 1) }
func (st Settings) PanelAlpha() float64  { return orDefault(st.PanelOpacity, 0.62, 0.25, 1) }
func (st Settings) CardAlpha() float64   { return orDefault(st.CardOpacity, 1, 0.3, 1) }
func (st Settings) HUDDuration() time.Duration {
	return time.Duration(orDefault(float64(st.HUDDurationMs), 3000, 2000, 10000)) * time.Millisecond
}
func (st Settings) Gap() int {
	if st.CompanionGap == nil {
		return 8
	}
	return min(max(*st.CompanionGap, 0), 40)
}

func orDefault(v, def, lo, hi float64) float64 {
	if v == 0 {
		return def
	}
	return min(max(v, lo), hi)
}

// DuePreset 到期快捷档（同 Tauri DuePresetCfg）：relative 相对分钟；today / tomorrow 定点；weekday 下个周几定点（0 = 周日）。
type DuePreset struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Minutes int    `json:"minutes,omitempty"`
	Hour    int    `json:"hour"`
	Minute  int    `json:"minute"`
	Weekday int    `json:"weekday"`
}

// DefaultDuePresets 同 Tauri DEFAULT_DUE_PRESETS。
func DefaultDuePresets() []DuePreset {
	return []DuePreset{
		{ID: "rel-30m", Kind: "relative", Minutes: 30}, {ID: "rel-1h", Kind: "relative", Minutes: 60},
		{ID: "rel-3h", Kind: "relative", Minutes: 180}, {ID: "rel-6h", Kind: "relative", Minutes: 360},
		{ID: "today-20", Kind: "today", Hour: 20}, {ID: "tomorrow-9", Kind: "tomorrow", Hour: 9},
		{ID: "next-mon-9", Kind: "weekday", Weekday: 1, Hour: 9},
	}
}

// Presets：未设置时用默认档。
func (s Settings) Presets() []DuePreset {
	if s.DuePresets == nil {
		return DefaultDuePresets()
	}
	return slices.Clone(*s.DuePresets)
}

// Valid 同 Tauri 导入校验：kind 合法、数值在范围内。
func (p DuePreset) Valid() bool {
	switch p.Kind {
	case "relative":
		return p.Minutes > 0
	case "today", "tomorrow", "weekday":
		return p.Hour >= 0 && p.Hour < 24 && p.Minute >= 0 && p.Minute < 60 && (p.Kind != "weekday" || p.Weekday >= 0 && p.Weekday <= 6)
	}
	return false
}

// Due 同 Tauri presetCfgDue：语义固定（「今天 20:00」已过也不跳明天；「下个周几」排除当天）。
func (p DuePreset) Due(now time.Time) time.Time {
	at := func(add int) time.Time {
		return time.Date(now.Year(), now.Month(), now.Day()+add, p.Hour, p.Minute, 0, 0, now.Location())
	}
	switch p.Kind {
	case "relative":
		return now.Add(time.Duration(p.Minutes) * time.Minute).Truncate(time.Minute)
	case "today":
		return at(0)
	case "tomorrow":
		return at(1)
	case "weekday":
		add := (p.Weekday - int(now.Weekday()) + 7) % 7
		if add == 0 {
			add = 7
		}
		return at(add)
	}
	return time.Time{}
}
