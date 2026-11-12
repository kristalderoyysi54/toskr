package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/core"
	"github.com/toskr/native/internal/detector"
	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 面板页
// 页签与 Tauri 版一致：剪贴 / 笔记 / 任务；账单与秘文从「更多」菜单进入。
const (
	pageClip = iota
	pageNotes
	pageTasks
)

// delivery 是一条发送记录（内存中保留最近 50 条，设置 → 发送记录可查）。
// app 的字段只在主线程读写（view、窗口回调、托盘、快捷键都在主线程）；
// 其他 goroutine 一律经 panel.Update 回到主线程。
type app struct {
	band                                  *deliveryBand           // 卡片底缘发送状态带（delivery_band.go）
	stick                                 stickCtx                // 笔记分组吸顶（sticky.go）
	tsw                                   targetSwitch            // 目标栏切换动效（target_switch.go）
	msgScrollTo                           string                  // 消息列表键盘换选后要滚进视口的消息
	cmpOnly                               bool                    // 对比窗「只看改动」
	cmpCur                                int                     // 对比窗当前第几处改动
	cmpJump                               int                     // 对比窗待滚进视口的行下标 + 1
	cmpWin                                *mygo.Window            // 发送前对比窗（pf_compare.go）
	cmpView                               string                  // 对比窗看的是："" = 当前预检（实时）；否则某次发送的快照 id
	cmpExpand                             map[int]bool            // 对比窗里展开了的折叠段
	cmpMenuRow                            int                     // 对比窗里操作菜单开着的行 + 1
	cmpSnaps                              map[string]*cmpSnapshot // 发送对比快照（只在内存，最多 50 次）
	cmpOrder                              []string
	secColorPick, secColorSrc, secMenuSrc string    // 分组颜色弹层：哪个分组、在哪弹（head / rail / bar）、菜单从哪打开（section_color.go）
	yieldUntil                            time.Time // 发送时面板让出焦点：此前的失焦不自动收起
	// 紧凑行悬停与原图窥视（peek.go）
	rowHov    rowHover
	peekWin   *mygo.Window
	peekImg   ui.ImageSource
	peekFiles []string
	peekIdx   int
	peekOn    bool
	sys       core.System
	store     *store.Store

	panel, hud, settingsWin, detailWin *mygo.Window
	tray                               *mygo.Tray
	shot                               *shotSession                // 进行中的截图
	pins                               []*pinWin                   // 钉图小窗
	longCap                            atomic.Pointer[longCapture] // 进行中的长截屏（键盘 tap 读：Esc 取消）

	// 面板状态
	page                       int
	section                    string // 当前笔记分组
	query                      string
	notes                      []store.Note // 当前分组 + 搜索后的未完成项
	done                       []store.Note // 当前分组已完成项
	counts                     map[string]int
	noteIdx                    map[string]int // 笔记 ID → a.notes 下标（卡片构建时 O(1) 取键盘选中位置）
	vis                        visWindow
	clipList                   []store.Note // 剪贴页列表快照：换页动画里旧页不会读到另一页的 a.notes
	clipScroll                 ui.ScrollState
	selected                   int
	chosen                     ui.Selection[string]
	list                       ui.ListState
	search                     ui.Handle
	draft                      string
	draftIn                    ui.Handle
	clipSrcCollapsed           map[string]bool
	menuTarget                 *store.Note // 右键单卡菜单期间的作用对象（chosenNotes 收窄到它）
	headRename, headRenameText string      // 笔记分组头就地改名（同 Tauri SectionGroup renaming）
	headRenameFocused          bool
	secClickSeq                int      // 分组名单击 / 双击消歧
	secMenuOpen                string   // 「…」分组菜单展开中的分组
	secSort, railSort          sortDrag // 笔记分组拖动排序（列表区头 / 侧栏胶囊）
	secOrder                   []string // 本帧笔记列表的分组顺序（让位计算用）
	secJump, secSeen           bool     // 落下那一帧归零平移 / 本帧拖动源仍在拖
	railJump, railSeen         bool
	tsecSort                   sortDrag // 任务分组拖动排序
	tsecOrder                  []string
	tsecJump, tsecSeen         bool
	dropHov                    dropHover   // 拖入详情编辑器的悬停状态
	permPolled                 time.Time   // 权限页上次重取日历 / 提醒事项授权状态
	permTicking                bool        // 权限页 2 秒重画已排上
	edge                       *edgeAnchor // 拖拽入坞后的贴边锚点（edge_hide.go）
	edgeHidden, edgeArmed      bool
	bar                        barState // 屏幕顶部 / 底部横栏的视图态（hbar.go）
	holdOpen, holdNext         bool     // 快捷键 / 双击唤出：拖动或 Esc 前不随失焦收起、不贴边滑出（同 Tauri shortcutHoldOpen + panel_auto_hide_armed）
	edgeAway                   time.Duration
	edgeMachineUntil           time.Time
	dockSeq, edgeAnimSeq       int // 剪贴页按来源分组时各组的折叠态（仅本次运行，同 Tauri useState）
	pinned                     bool
	showDone                   bool
	newSecOn                   bool
	// 笔记分组侧栏：过滤（"" = 全部）、展开、就地改名
	noteFilter, renamingSec, renameText string
	noteRailOpen                        bool
	detailSize                          [2]int // 详情窗上次的尺寸（用户拖过即沿用；0 = 首次按屏幕定）
	newSec                              string
	target                              macos.FrontApp     // 发送目标：面板唤出前的前台应用
	targetStarted                       int64              // 目标进程启动时刻（身份锁定）
	draftTarget                         draftTarget        // 预检 / 回车确认时冻结的目标（draft_target.go）
	pending                             []store.Note       // 预检命中、等待确认的发送
	pf                                  preflightState     // 发送预检：逐项处理状态
	sendPNG                             map[string][]byte  // 本次发送用的图片遮挡副本（文件 → 遮挡后 PNG，图片隐私检查）
	sendFinal                           string             // 预检里手动改过的最终文本（非空即原样发送，不再套模板 / 格式）
	sendKeep                            *bool              // 预检「发送后保留面板」本次覆盖（nil = 按方案）
	sendMode                            string             // 本次发送的输出格式覆盖（选择条 / 详情窗「输出格式」，发完或取消即清）
	appNames                            map[string]string  // bundle → 应用显示名（设置里的应用名单）
	appMissing                          map[string]bool    // 系统查不到的应用（没装）
	sentCounts                          map[string]int     // 卡片 id → 成功发送次数（reload 时重算）
	lp                                  longPress          // 浮钮长按（收进笔记选分类）
	clipPick                            string             // 长按弹出分组选择的剪贴卡
	clipPickAt                          ui.Rect            // 弹出浮层挂靠的浮钮位置
	thumbs                              *imgCache          // 卡片缩略图与 favicon（按字节限额，imgcache.go）
	trimGen                             int                // 内存整理的代次（再次唤出面板即作废）
	adoptErr                            string             // 正式版：旧版数据没接上的原因（非空时面板顶部常驻横幅）
	aiBusy                              string             // 正在 AI 处理的笔记 ID
	aiReviewing                         *aiReview          // 进行中的 AI 核对（取消时一并作废）
	focus                               *focusState        // 进行中的专注（today_blocks.go；只在内存里，重启即结束）
	fanout                              *fanout            // 进行中的多目标发送（fanout.go）
	fanPick                             []string           // 「同时发到」上次勾选的应用（bundle id，本次运行内记住）
	aiCancel                            context.CancelFunc // 进行中的 AI 改写（可取消）
	draftImgs                           []pastedImage      // 输入区暂存的粘贴 / 拖入图片（提交时与草稿合成一张卡）
	bigImgs                             *imgCache          // 详情窗内嵌大图缓存
	docked                              bool               // 面板当前停靠在伴随应用窗口旁（位置不由自己记）
	comp                                companionTracker   // 伴随跟随（companion_track.go）
	vdrag                               vDrag              // 上 / 下缘把手拖动中
	dragExp                             dragExpand         // 拖拽悬停在折叠分组头上（500ms 后自动展开）
	kbd                                 kbDrag             // 键盘拖拽排序中拾起的卡
	gripFocus                           string             // 键盘焦点所在的拖拽把手（卡片 id）
	redactions                          []redactionSession // 各次发送的占位符映射（只在内存，同 Tauri redactionSessions）
	verify                              verifyState        // 回复检查浮层
	sendPH                              sendRedaction      // 本次发送的「原文 → 占位符」与次数（预检替换时设置）
	tourOpen                            bool               // 首启导览盖在面板上（onboarding.go）
	lesson                              *lessonSession     // 进行中的进阶课（只在内存，同 Tauri lessonStore）
	lastFront                           macos.FrontApp     // 最近一次处于前台的外部应用（edge_hide.go observeFront）
	pfRehearsal                         bool               // 当前预检是安全发送演练：强制脱敏、不回车、保留面板

	// 1:1 主面板
	noteGroups                               []noteGroup
	doneOpen                                 map[string]bool
	searchOpen                               bool
	menuOpen                                 bool
	placementOpen                            bool // 面板菜单「位置与停靠」二级页
	openAtLogin                              bool // 设置页「开机启动」（打开设置时读一次）
	noteScroll                               ui.ScrollState
	prevPage                                 int       // 换页动画中的旧页（-1 = 无）
	flashID                                  string    // 刚捕获、正在闪烁的笔记
	hudAt, hudLogoAt, hudLeaveAt, hudGhostAt time.Time // HUD 进场 / logo / 离场 / 残影的起点（帧时刻；零值 = 下一帧记下）
	hudLeaving                               bool
	panelHiding                              bool       // 面板离场动画中（播完藏窗）
	presenceArm                              bool       // 本次显示需从 0 起播进场
	hudGhost                                 *hudBubble // 被新气泡顶替、正在下沉淡出的上一条
	flashAt                                  time.Time  // 闪烁起点（帧时刻；零值 = 下一帧记下）
	pageAt                                   time.Time  // 旧页开始离场的帧时刻（零值 = 下一帧记下）
	setScroll                                ui.ScrollState
	focusList                                bool

	clock func() time.Time // 可注入时钟（视觉对照测试固定在参照截图时刻）

	// 任务页
	tasks        []store.Task
	taskDraft    string
	taskSub      int // 0 今天 1 任务
	sparkMode    bool
	taskAI       bool            // 速记 ✨ AI 模式（与 💡 互斥）
	dueOpenID    string          // 到期弹层开在哪个任务上
	dueDraft     time.Time       // 到期弹层里的自定义日期时间草稿
	dueCount     string          // 「共几次」输入草稿
	taskAIBusy   bool            // AI 解析中
	taskAIDraft  *taskDraft      // 待确认的 AI 解析结果
	taskQuickOff map[string]bool // 速记本地解析：被点掉的片（due / rec / pri / sec），草稿清空即复位
	// 卡片右键「重命名…」「新标签…」的就地输入
	titleEditID, titleText, tagEditID, tagText string
	placed                                     mygo.Rectangle  // 程序上次摆放面板的位置（与之相同的移动 / 缩放不当作用户操作记忆）
	lastRedactions                             int             // 下一次投递前遮罩的敏感项数（记进发送记录）
	out                                        outcomeDraft    // 使用概览：当前这次发送（发送前生成 ID，直到结果落定）
	drawerOpen                                 bool            // 「最近发送」抽屉
	drawerMore                                 map[string]bool // 抽屉行「更多」展开态
	// 发送方案：临时指定 / 规则覆盖只对 tempFor / ruleFor 记下的目标身份有效
	tempProfile, tempFor                       string
	ruleOv                                     store.RuleOverrides
	ruleFor                                    string
	lensOpen, quickOpen                        bool
	quickIdx                                   int
	editProfileID                              string // 设置里正在编辑的方案
	profName                                   string
	enterAsk                                   []store.Note // 方案为「每次发送前确认」时挂起，等用户选回车与否
	pendingTmpl, enterTmpl                     string       // 挂起中的发送所带的提示词模板
	snipAdd                                    bool         // 设置里正在新增模板
	snipEditID, snipLabel, snipText, snipGroup string
	snip                                       snipUI // 模板编辑区的试用预览 / AI 助手（templates_ai.go）
	// 任务行内编辑与任务分组改名
	taskOpen, taskTitle, taskNote, ckDraft string
	taskTitleFocus                         bool // 展开任务后首帧聚焦标题
	taskCk                                 map[string]*string
	taskSecRename, taskSecName             string
	taskSecFocus                           bool                      // 进入分组改名的首帧聚焦
	taskSecClickSeq                        int                       // 分组名单击延迟折叠的序号（双击作废前一次单击）
	recordingKey                           string                    // 设置里正在录制的全局快捷键（panel / shot / newnote）
	altSince                               time.Time                 // 只按住 ⌥ 的起点（长按 650ms 弹快捷键速查）
	linkSeen                               map[string]string         // 链接卡 ID → 已处理的 URL（新卡 / 新 URL 才抓预览）
	linkSem                                chan struct{}             // 链接预览并发上限
	appIconColors                          map[string]ui.Color       // 来源应用图标主色（同 Tauri AppIconInfo.color，详情窗晕光兜底色）
	appIcons                               map[string]ui.ImageSource // 来源应用图标（bundle → 图，nil = 加载中或无图标）
	calEvents                              []macos.CalendarEvent     // 今天的苹果日历日程（后台刷新）
	calStatus                              string                    // 日历授权状态（空 = 未查）
	calendars                              []macos.CalendarInfo      // 设置页「显示的日历」
	calListing                             bool
	cmdOpen                                bool    // ⌘K 命令面板
	panelCorner                            float64 // 面板窗口当前圆角（建窗 18；主题要直角窗时为 0）
	clipInnerW                             float32 // 剪贴页内容区上一帧的可用宽（方格墙排列用）
	cmdQuery                               string
	cmdCursor                              int
	taskScroll                             ui.ScrollState // 任务页滚动（双击页签回到开头）
	anchorID                               string         // ⇧点击范围选的锚点（上一次普通 / ⌘ 点击的卡）
	fw                                     firewallUI     // 设置「发送前隐私检查」展开态与字段输入
	aliasUI                                aliasUI        // 设置「可逆化名」词典编辑态
	paste                                  pasteUI        // 设置「粘贴规则」主从布局编辑态
	setShortcutsOpen                       bool           // 设置「面板内快捷键」表展开
	setJump                                string         // 设置窗下一帧要跳到的页名
	lastClipID                             string         // 上一次外部复制入库的卡（连续复制两次置顶用）
	lastClipAt                             time.Time
	trayBuilt                              string             // 托盘菜单上次重建时的状态键
	trayIconKey, trayTitleShown            string             // 托盘图标当前状态键 / 图标旁标题
	forceCheck                             bool               // 本次发送强制先过检查条（检查后发送…）
	outRetry                               bool               // 本次发送来自「最近发送 → 重新准备」
	outUI                                  outcomeUI          // 设置 → 使用概览的范围 / 筛选 / 展开
	quitting                               bool               // 正在退出：窗口关闭不再改成隐藏
	permAX                                 bool               // 辅助功能已授权（每 3 秒复查）
	tapReceiving                           atomic.Bool        // 键盘监听收到过真实按键
	tapStarted                             time.Time          // 键盘监听建立时刻
	permNoAuth, permStuck                  int                // 权限守护：输入监控查询连续为否 / 监听连续无事件的 tick 数
	permKeySeen                            bool               // 面板自己看到过键盘活动（判「被拦截」的铁证之一）
	permDraft                              string             // 上一帧的输入区文字（变了即有人在打字）
	tauriImporting                         bool               // 正在从 Tauri 版导入
	migrate                                *migrateState      // 旧版迁移向导（nil = 未打开）
	migrateLater                           bool               // 本次进程选过「稍后」
	lastTauriReport                        *store.TauriReport // 最近一次 Tauri 导入的结果（迁移向导完成页的数字）
	dataDirMissing                         string             // 指针指向的自定义数据目录启动时不可用（本次用默认目录）
	dirPlan                                *dirPlan           // 待确认的数据目录切换
	rem                                    remSync            // 提醒事项同步调度（含锁，app 只按指针传）
	fx                                     *fxCache           // 当日汇率（数据目录 toskr-fx-rates.json 缓存）
	fxLoaded, fxFetching                   bool
	taskFocus                              string // 任务页键盘焦点（↑↓）
	taskQuickFocused                       bool   // 速记框有焦点（上一帧）
	diagFilter                             string // 设置 → 诊断的筛选：all | capture | delivery
	billRange                              string // 消费分析趋势：month | year
	remStatusAsked                         bool   // 设置页已查过提醒事项授权状态
	remRulesOpen                           bool   // 设置页「同步规则」已展开
	shotFrameOpen                          bool   // 截图 / 标注窗的圆角阴影滑块已展开
	// 设置页「本机翻译」状态
	ltStatus                        string
	ltPreparing, ltFailed, ltOpened bool
	// 任务页头部开关：搜索与筛选、任务月历（会话态，同 Tauri）
	taskFilterOn, taskCalOn            bool
	taskFilter                         taskFilter
	taskCalMonth                       int
	taskCalDay                         time.Time
	taskCalDraft                       string
	taskCalHideTasks, taskCalHideBills bool
	clipView                           string    // 剪贴页视图：time | source | image
	clipSwapAt                         time.Time // 剪贴视图切换时刻与方向（clipSwapIn）
	clipSwapDX                         float32
	noteSub                            int // 内容页子视图：subNotes / subSecret / subMessages
	// 内容 → 消息
	messages     []store.Message
	msgFilter    string          // new | waiting | done
	msgChosen    map[string]bool // 勾选
	msgAnchor    string          // ⇧ 范围选锚点
	msgOpen      map[string]bool // x:<id> 展开全文、c:<id> 展开前文
	msgDraftBusy string          // 正在生成 AI 回复草稿的消息
	im           imCtl
	aiUI         aiUI           // 设置 → AI 的会话态（模型列表、请求中）
	dueEdit      dueEditor      // 设置 → 到期快捷档的编辑态
	swapIdx      map[string]int // swapView 各组上一次的序号（定进场方向）
	multiStash   []string       // 双击发送前第一击塌掉的多选（同 Tauri lastMultiSelection）
	multiStashAt time.Time
	locateWin    *mygo.Window // 定位原会话的高亮框
	locateGen    int

	// 秘文
	secretKeyID   string
	secretDraft   string
	secretBusy    bool
	secretOpening map[string]bool      // 正在后台试解的卡
	secretPlain   map[string]string    // 已显现的明文（只在内存）
	secretFx      map[string]time.Time // 秘文卡过场起点（r: 解密 / m: 回遮罩）
	updMu         sync.Mutex
	updQueue      []func() // 无窗口时的主线程回调队列（视图测试）

	// 订阅子视图
	billDay       time.Time
	billView      string // week | month
	billFilter    string // upcoming | all
	billMonth     int    // 月历相对本月的偏移
	billAnalytics bool
	paying        string // 正在「标记已还」的账单
	payAmount     string
	bandOpen      map[string]bool // 智能区 / 分组折叠（已到期、灵感、已完成）
	taskIn        ui.Handle
	taskSel       int
	taskList      ui.ListState
	showDoneT     bool

	// 账单页
	bills    []store.Bill
	billForm billForm

	// 秘文页
	secrets  []store.Secret
	revealed map[string]time.Time

	// 详情窗
	detailText string
	detail     detailState
	panes      []*detailPane // 打开着的详情窗（📌 固定的并存）
	curPane    *detailPane   // a.detail / detailText / detailWin 当前对应的窗

	// HUD
	hudText, hudKind string
	retainAskGen     int // 全局保留时长缩短的待确认代次（settings_confirm.go）
	hudStreak        int // 连续捕获计数：气泡仍在场时再捕获累加（同 Tauri hud.streak）
	hudGen           int
	hudUndo          func()   // 可撤销气泡的撤销动作
	hudHover         bool     // 光标在气泡上（关闭穿透、显出撤销）
	hudTarget        string   // 点气泡查看时定位的卡片（捕获类）
	hudSrc, hudTag   string   // 捕获气泡：来源应用 bundle（状态圆右下角叠小图标）与内容类型小标（图文 ×3 / 链接 / sql…）
	hudDue           []string // 任务到期气泡的任务

	// 设置窗编辑态
	setModifier                         int
	setGap                              float64
	setClip                             bool
	setGlass                            int
	setExcluded                         string
	setClipExcluded                     string
	setRetain                           float64
	setLang                             int
	setAIKey                            string
	setAIEnd                            string
	setAIModel                          string
	setCompan                           string
	axTrusted                           bool
	tapErr                              string
	shortcut                            string
	recovery                            []string
	health                              string
	updateMsg                           string
	upd                                 updateState // 应用更新（updater.go）
	setPage                             int         // 设置窗左侧分类
	setSub                              int         // 分类内子页签
	setQuery                            string      // 设置搜索
	setSearch                           ui.Handle
	newKeyLabel, newKeyPass, newKeyNote string // 设置「秘文」添加密钥的草稿
}

func newApp(sys core.System, st *store.Store) *app {
	a := &app{sys: sys, store: st, page: pageNotes, prevPage: -1, section: store.SectionInbox, doneOpen: map[string]bool{}, bandOpen: map[string]bool{"overdue": true, "spark": true}, clipView: "time", billView: "week", billFilter: "upcoming", clock: time.Now, thumbs: newImgCache(thumbBudget), bigImgs: newImgCache(bigBudget), revealed: map[string]time.Time{}, secretOpening: map[string]bool{}, secretPlain: map[string]string{}, secretFx: map[string]time.Time{}, msgOpen: map[string]bool{}, msgChosen: map[string]bool{}, drawerMore: map[string]bool{}, linkSem: make(chan struct{}, 2), appIcons: map[string]ui.ImageSource{}}
	liveApp = a
	st0 := st.Settings() // 同 Tauri：输入框草稿与所选分组跨重启保留
	a.draft = st0.DraftText
	if st0.LastDraftSection != "" {
		a.section = st0.LastDraftSection
	}
	if v := st0.BillView; v == "week" || v == "month" {
		a.billView = v
	}
	a.reload()
	return a
}

// saveDraftState：把输入框草稿与所选分组写进设置（面板收起 / 退出 / 改选分组时）。
func (a *app) saveDraftState() {
	cur := a.store.Settings()
	if cur.DraftText == a.draft && cur.LastDraftSection == a.section {
		return
	}
	cur.DraftText, cur.LastDraftSection = a.draft, a.section
	_ = a.store.SetSettings(cur)
}

// reload 从 store 重建当前视图（主线程）。
func (a *app) reload() {
	all := a.store.Notes()
	a.sweepLinks(all)
	a.sentCounts = map[string]int{}
	for _, d := range a.store.Deliveries() {
		if d.Status == "sent" {
			for _, id := range d.SourceIDs {
				a.sentCounts[id]++
			}
		}
	}
	a.counts = map[string]int{}
	for _, n := range all {
		if !n.Done {
			a.counts[n.Section]++
		}
	}
	if !slices.ContainsFunc(a.store.Sections(), func(s store.Section) bool { return s.ID == a.section }) {
		a.section = store.SectionInbox
	}
	a.notes, a.done = a.notes[:0], a.done[:0]
	if a.page == pageClip {
		a.notes = arrangeClips(append(a.notes, store.Search(a.store.Section(store.SectionClipboard), a.query)...), a.clipView)
		a.clipList = slices.Clone(a.notes)
	} else {
		// 笔记页：所有非剪贴板分组按顺序展开，键盘选择在扁平列表上移动
		if a.noteFilter == doneFilter && !a.hbar() { // 「已完成」胶囊只在横栏有（同 Tauri：竖栏落回全部）
			a.noteFilter = ""
		}
		a.noteGroups = a.groups()
		bar := a.hbar()
		for _, g := range a.noteGroups {
			if !g.sec.Collapsed || bar { // 横栏卡串不分组：折叠的组照样排进串里（同 Tauri stripNotes）
				a.notes = append(a.notes, g.open...)
			}
			a.done = append(a.done, g.done...)
		}
		if bar && a.noteFilter == doneFilter {
			a.notes = append(a.notes[:0], a.done...)
		}
	}
	for _, id := range slices.Collect(a.chosen.All()) { // 卡片已被删掉（清理示例 / 外部删除）：勾选里不留残影
		if _, ok := a.store.Note(id); !ok {
			a.chosen.Remove(id)
		}
	}
	a.noteIdx = make(map[string]int, len(a.notes))
	for i, n := range a.notes {
		a.noteIdx[n.ID] = i
	}
	a.selected = max(0, min(a.selected, len(a.notes)-1))
	a.tasks = a.store.Tasks()
	a.bills = a.store.Bills()
	a.secrets = searchSecrets(a.store.Secrets(), a.query)
	a.messages = a.store.Messages()
}

func (a *app) current() (store.Note, bool) {
	if a.selected < 0 || a.selected >= len(a.notes) {
		return store.Note{}, false
	}
	return a.notes[a.selected], true
}

// chosenNotes 返回勾选的笔记（按列表顺序，同 Tauri orderedCheckedNotes）：没勾选就是空，
// 不退回键盘焦点卡（⌘⏎ / ⌘C 无勾选时什么也不做）。右键菜单期间 menuTarget 把作用对象收窄到被右键的那张卡。
func (a *app) chosenNotes() []store.Note {
	if a.menuTarget != nil {
		return []store.Note{*a.menuTarget}
	}
	var out []store.Note
	for _, n := range a.notes {
		if a.chosen.Has(n.ID) {
			out = append(out, n)
		}
	}
	return out
}

// ---- 面板 ----

func (a *app) togglePanel() { a.toggleWith(false) }

// toggleFromShortcut：快捷键 / 双击修饰键开关面板（同 Tauri triggerKeepsPanelOpen：hotkey、doubleTap 唤出时保持展开）。
func (a *app) toggleFromShortcut() { a.toggleWith(true) }

// toggleFromDoubleTap：双击触发键开关面板。同 Tauri：面板钉住时双击不收起（只提示），专用面板快捷键（force）照常收起。
func (a *app) toggleFromDoubleTap() {
	if a.pinned && a.panel.IsVisible() && !a.panelHiding && !a.edgeHidden {
		a.showHUD("info", tr("面板已固定 · 按 Esc 或取消图钉可收起"))
		return
	}
	a.toggleFromShortcut()
}

func (a *app) toggleWith(hold bool) {
	if a.panel.IsVisible() && !a.panelHiding && !a.edgeHidden { // 贴边滑出时意图必然是唤出（同 Tauri edgeHidden 分支）
		a.hidePanel()
		return
	}
	a.holdNext = hold
	a.showPanel()
}

func (a *app) showPanel() {
	if a.panelCorner == 0 { // 直角窗：唤出后按画出来的形状重算阴影
		a.refreshPanelShadow()
	}
	a.trimGen++ // 取消排着的内存整理
	a.holdOpen, a.holdNext = a.holdNext, false
	if f, ok := a.sys.Frontmost(); ok && f.PID != a.sys.SelfPID() {
		a.target = f
		a.targetStarted = macos.ProcessStartMs(f.PID)
	}
	a.syncTargetShown()                                                  // 隐藏期间换的目标：唤出时直接显示，不补播切换动效
	if st := a.store.Settings(); !st.FreeMove || a.companionTarget(st) { // 自由移动：保留用户拖到的位置；跟随应用的目标优先
		a.placePanel()
	}
	a.reload()
	a.maybeOpenMigrate()
	a.maybeOpenTour()
	a.presenceArm = !a.panelHiding // 离场中途被叫回则从当前位置折返，否则从 0 起播
	a.panelHiding = false
	a.edgeOnShow()
	a.panel.Show()
	a.panel.Invalidate()
	diag.Push("面板显示 target=%s", a.target.BundleID)
	a.syncCompanionTracking() // 同 Tauri show_panel → start_companion_tracker
}

// hidePanel 收起面板：先播离场（向停靠边退 16px 并淡出，140ms easeIn），播完再藏窗，同 Tauri onAnimationComplete → hidePanel。
func (a *app) hidePanel() {
	a.holdOpen = false
	a.saveDraftState()
	a.remaskAll() // 秘文：面板收起即回遮罩，明文丢弃
	if a.panel == nil || !a.panel.IsVisible() || a.panelHiding {
		return
	}
	a.panelHiding = true
	a.panel.Invalidate()
	go func() {
		time.Sleep(tweenExit.Duration + 10*time.Millisecond)
		a.panel.Update(func() {
			if a.panelHiding {
				a.panel.Hide()
				a.panelHiding = false
				a.stopCompanionTracking() // 同 Tauri hide_panel → stop_companion_tracker
			}
		})
	}()
}

// revealPanelForConfirm：发送停在预检 / 「粘贴后按回车？」时把面板真正唤到用户眼前。确认条只画在面板里，而发送可能从详情窗
// 发起——此时面板可能已收起、正在离场或贴边滑出成细条；只 Show() 不重绘、不滑回、不取焦点，看起来就是「点了发送没反应」。
// 不走 showPanel：它会按前台应用重取目标，覆盖「发送到…」/ 多目标发送刚指定的目标，投递时被判「目标已变化」。
func (a *app) revealPanelForConfirm(why string) {
	diag.Push("发送: 等待%s target=%s", why, a.target.BundleID)
	if a.panel == nil {
		return
	}
	a.trimGen++ // 取消排着的内存整理
	if !a.panel.IsVisible() {
		a.presenceArm = true // 藏窗后再显示：从 0 起播进场
		a.reload()
	}
	a.panelHiding = false
	a.holdOpen, a.edgeArmed, a.edgeAway = true, false, 0 // 等用户确认：不随失焦收起、不贴边滑走（Esc / 拖动照常解除）
	if a.edgeHidden {
		a.edgeSlideTo(false)
	}
	a.panel.Show()
	a.panel.Focus()
	a.panel.Invalidate()
}

// yieldPanelFocus：发送后面板保留（钉住 / 方案「发送后保留面板」/ 演练）时，先让出键盘焦点再粘贴。
// 面板是不激活应用的浮窗：目标应用本就在前台时，激活它不会把键盘焦点从仍是 key 的面板拿走，⌘V 会落到面板上。
// 隐藏后不抢焦点地重新显示（同 HUD 的 ShowInactive）；期间的失焦不触发自动收起。
func (a *app) yieldPanelFocus() {
	if a.panel == nil || !a.panel.IsVisible() {
		return
	}
	a.yieldUntil = time.Now().Add(600 * time.Millisecond)
	a.panel.Hide()
	a.panel.ShowInactive()
	diag.Push("发送: 面板保留，已让出键盘焦点")
}

// hidePanelNow 立即藏窗（发送、截图：焦点必须马上还给目标应用，不能等离场动画）。
func (a *app) hidePanelNow() {
	a.holdOpen = false
	a.remaskAll()
	a.panelHiding = false
	if a.panel != nil {
		a.panel.Hide()
	}
	a.stopCompanionTracking()
	a.trimMemorySoon()
}

// ---- 触发与捕获 ----

// onTrigger 在事件监听线程调用：裁决「捕获选区」还是「开关面板」。
func (a *app) onTrigger() {
	front, ok := a.sys.Frontmost()
	if !ok || front.PID == a.sys.SelfPID() {
		a.panel.Update(a.toggleFromDoubleTap)
		return
	}
	if slices.Contains(a.store.Settings().ExcludedApps, front.BundleID) {
		diag.Push("捕获: %s 在排除名单，跳过", front.BundleID)
		a.panel.Update(a.toggleFromDoubleTap)
		return
	}
	go func() {
		started := time.Now()
		got, ok := core.Capture(a.sys, front)
		if !ok {
			if a.store.Settings().DoubleTapCaptureOnly { // 双击行为「只划词」：无选中不开关面板
				diag.Push("捕获: 无选中内容，只划词模式不动作 (%dms)", time.Since(started).Milliseconds())
				return
			}
			diag.Push("捕获: 无选中内容 → 开关面板 (%dms)", time.Since(started).Milliseconds())
			a.panel.Update(a.toggleFromDoubleTap)
			return
		}
		if a.captureSecret(got.Text, front.Name) {
			return // 秘文信封：解密进秘文页，绝不进普通笔记
		}
		var blocks []store.ContentBlock
		lostImgs := 0
		if got.HTML != "" { // 富文本带图（同 Tauri materializeRichCapture）：图片本地化成内容块，失败的省略并提示
			if r := core.ParseRichHTML(got.Text, got.HTML, got.SourceURL); len(r.Sources) > 0 {
				blocks, lostImgs = core.LocalizeRich(r, got.SourceURL, a.store.SaveImage)
				lostImgs += r.Omitted
				if r.Omitted > 0 {
					diag.Push("富图片: 解析丢弃 %s", strings.Join(r.OmittedSchemes, ","))
				}
				if len(store.ImageBlocks(blocks)) == 0 {
					blocks = nil // 图全失败：按纯文本存
				}
			}
		}
		rehearsalText := isSafeRehearsalText(got.Text) // 演练与还原课按捕获原文判断（还原前）
		restored := 0
		if st := a.store.Settings(); !st.AliasNoAutoRestore {
			restored = core.AliasOccurrences(got.Text, st.AliasEntities)
		}
		if blocks != nil {
			for i := range blocks { // 逐个还原文字块里的化名，图片块与顺序不动
				if blocks[i].Type == "text" {
					blocks[i].Text = a.captureRestoreAliases(blocks[i].Text)
				}
			}
			got.Text = store.TextFromBlocks(blocks)
		} else {
			got.Text = a.captureRestoreAliases(got.Text)
		}
		if strings.TrimSpace(got.Text) == "" && blocks == nil {
			if lostImgs > 0 {
				a.panel.Update(func() { a.showHUD("warn", fmt.Sprintf(tr("%d 张图片未能保存"), lostImgs)) })
			}
			return
		}
		note, dup, err := a.store.Add(store.Note{Section: a.captureSection(), Text: got.Text, HTML: got.HTML, Blocks: blocks,
			SourceApp: front.Name, BundleID: front.BundleID})
		diag.Push("捕获: %d 字符 来自 %s dup=%v %dms", len([]rune(got.Text)), front.BundleID, dup, time.Since(started).Milliseconds())
		a.panel.Update(func() {
			a.target = front
			if err != nil {
				a.showHUD("warn", "保存失败："+err.Error())
				return
			}
			a.afterCaptured(note.ID, dup, rehearsalText, restored)
			if dup {
				a.showHUD("duplicate", preview(note.Text, 40))
				a.hudTarget = note.ID
				a.hudSrc, a.hudTag = front.BundleID, captureTag(note)
				return
			}
			a.playCaptureSound()
			a.flashID, a.flashAt = note.ID, time.Time{} // 卡片琥珀闪烁 1.8s
			msg := preview(note.Text, 40)
			if lostImgs > 0 {
				msg += " · " + fmt.Sprintf(tr("%d 张图片未能保存"), lostImgs)
			}
			if linked := a.autoLinkFanoutReply(note); linked != "" { // 多目标发送的回复：直接关联，凑够两家可对比
				msg += " · " + linked
			} else if ds := store.DeliveryCandidates(note, a.store.Deliveries()); len(ds) == 1 { // 唯一候选只提示，不自动关联（同 Tauri）
				msg += " · " + fmt.Sprintf(tr("可能是发往 %s 的回复，右键可关联"), ds[0].TargetName)
			}
			a.showHUDUndo("added", msg, func() { // 撤销捕获：删掉刚收进的笔记
				a.store.Delete(note.ID)
				a.reload()
			})
			a.hudTarget = note.ID
			a.hudSrc, a.hudTag = front.BundleID, captureTag(note)
		})
	}()
}

// captureSection：划词捕获存入的分组（设置「捕获存入」，分组已删时回收件箱）。
func (a *app) captureSection() string {
	id := a.store.Settings().CaptureSection
	if id != "" && slices.ContainsFunc(a.store.Sections(), func(s store.Section) bool { return s.ID == id }) {
		return id
	}
	return store.SectionInbox
}

// ---- 笔记操作（主线程） ----

func (a *app) addDraft() {
	text := strings.TrimSpace(a.draft)
	if text == "" && len(a.draftImgs) == 0 {
		return
	}
	sec := a.section
	if sec == store.SectionClipboard {
		sec = store.SectionInbox
	}
	if _, dup, err := a.store.Add(draftNote(sec, a.draft, a.draftImgs)); err == nil {
		imgs := len(a.draftImgs)
		a.draft, a.draftImgs = "", nil
		a.section, a.selected = sec, 0 // 同 Tauri DraftInput submit：不清搜索词
		a.saveDraftState()
		switch {
		case dup:
			a.showHUD("duplicate", tr("已存在，移到顶部"))
		case imgs > 0 && text != "":
			a.showHUD("added", tr("已添加图文笔记"))
		case imgs > 0:
			a.showHUD("added", tr("已添加图片"))
		}
	}
}

// draftNote 同 Tauri DraftInput submit：有暂存图时第一张为主图、其余为附件；有文字是组合卡（kind 文本），否则是图片卡。
func draftNote(sec, draft string, imgs []pastedImage) store.Note {
	n := store.Note{Section: sec, Text: strings.TrimSpace(draft)}
	if len(imgs) == 0 {
		n.Text = draft
		return n
	}
	first := imgs[0]
	n.ImageFile, n.ImageW, n.ImageH = first.file, first.w, first.h
	for _, im := range imgs[1:] {
		n.Attachments = append(n.Attachments, im.file)
	}
	if n.Text == "" {
		n.Kind = "image"
		n.Text = fmt.Sprintf("图片 %d×%d", first.w, first.h)
		if len(imgs) > 1 {
			n.Text = fmt.Sprintf("图片 %d 张", len(imgs))
		}
	}
	return n
}

func (a *app) deleteSelected(c *ui.Context) {
	notes := a.chosenNotes()
	if len(notes) == 0 {
		return
	}
	ids := make([]string, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
	}
	a.chosen.Clear()
	a.deleteNotesUndo(ids, "")
}

// deleteNotesUndo 删除一批笔记并挂撤销；msg 为空时按条数生成提示。
func (a *app) deleteNotesUndo(ids []string, msg string) {
	type gone struct {
		n   store.Note
		pos int
	}
	var removed []gone
	for _, id := range ids {
		if r, pos, ok := a.store.Delete(id); ok {
			removed = append(removed, gone{r, pos})
		}
	}
	if len(removed) == 0 {
		return
	}
	if msg == "" {
		msg = "已删除 · " + preview(removed[0].n.Text, 14)
		if len(removed) > 1 {
			msg = fmt.Sprintf("已删除 %d 条", len(removed))
		}
	}
	a.showHUDUndo("ok", msg, func() {
		for i := len(removed) - 1; i >= 0; i-- {
			_ = a.store.Restore(removed[i].n, removed[i].pos)
		}
	})
}

func (a *app) mergeChosen(c *ui.Context) {
	notes := a.chosenNotes()
	if len(notes) < 2 {
		return
	}
	ids := make([]string, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
	}
	if store.MergeDomainsMixed(notes) {
		a.showHUD("warn", tr("剪贴卡与笔记不能混合合并"))
		return
	}
	if notes[0].Section == store.SectionClipboard { // 剪贴域：组合成新卡置顶，原卡保留
		combo, ok := a.store.MergeClipsAsNew(ids, "\n\n")
		if !ok {
			return
		}
		a.chosen.Clear()
		a.showHUDUndo("ok", fmt.Sprintf(tr("已合并 %d 条"), len(ids)), func() { a.store.Delete(combo.ID) })
		return
	}
	merged, originals, ok := a.store.Merge(ids, "\n\n")
	if !ok {
		return
	}
	a.chosen.Clear()
	a.showHUDUndo("ok", fmt.Sprintf("已合并 %d 条", len(originals)), func() { _ = a.store.Unmerge(merged, originals) })
}

func (a *app) repositionPanel() {
	if a.panel != nil {
		a.placePanel()
	}
}

// clearAllDone 是面板菜单「清理已完成」：笔记视图清全部分组的已完成笔记，任务页清已完成任务；均可撤销。
func (a *app) clearAllDone(c *ui.Context) {
	if a.page == pageTasks {
		var removed []store.Task
		var pos []int
		for _, t := range a.store.Tasks() {
			if t.Status == "done" {
				if r, p, ok := a.store.DeleteTask(t.ID); ok {
					removed, pos = append(removed, r), append(pos, p)
				}
			}
		}
		if len(removed) > 0 {
			a.showHUDUndo("ok", fmt.Sprintf(tr("已清理 %d 个已完成任务"), len(removed)), func() {
				for i := len(removed) - 1; i >= 0; i-- {
					_ = a.store.RestoreTask(removed[i], pos[i])
				}
			})
		}
		a.reload()
		return
	}
	var removed []store.Note
	for _, sec := range a.store.Sections() {
		if sec.ID != store.SectionClipboard {
			removed = append(removed, a.store.ClearDone(sec.ID)...)
		}
	}
	if len(removed) > 0 {
		a.showHUDUndo("ok", fmt.Sprintf("已清理 %d 条已完成", len(removed)), func() { _ = a.store.RestoreMany(removed) })
	}
	a.reload()
}

func (a *app) clearDone(c *ui.Context) {
	removed := a.store.ClearDone(a.section)
	if len(removed) > 0 {
		a.showHUDUndo("ok", fmt.Sprintf("已清理 %d 条已完成", len(removed)), func() { _ = a.store.RestoreMany(removed) })
	}
}

func (a *app) startEdit() {
	if n, ok := a.current(); ok {
		a.editInDetail(n)
	}
}

// send 先做敏感内容预检（按方案隐私策略），命中则挂起等确认；再按方案的粘贴后动作投递。
func (a *app) send(notes []store.Note) { a.sendT(notes, "") }

// sendWithTemplate：用提示词模板发送（记最近使用）。
func (a *app) sendWithTemplate(notes []store.Note, sn store.PromptSnippet) {
	st := a.store.Settings()
	st.UseSnippet(sn.ID)
	_ = a.store.SetSettings(st)
	a.sendT(notes, sn.Text)
}

// sendT：tmpl 为本次提示词模板（空 = 不套模板），随挂起状态一起保存，取消即丢弃。
func (a *app) sendT(notes []store.Note, tmpl string) {
	a.pfRehearsal = false // 演练预检由 openSafeRehearsalPreflight 在这之后单独标记
	if len(notes) == 0 {
		return
	}
	if a.target.PID == 0 {
		a.outcomeBlocked("target-not-ready")
		a.showHUD("warn", tr("没有发送目标：先切到要粘贴的应用再唤出面板"))
		return
	}
	if _, stale := a.resolution(); stale { // 同 Tauri profileOverrideNeedsConfirmation：换了目标，原临时方案确认前一律不发
		a.outcomeBlocked("profile-needs-confirmation")
		a.showHUD("warn", tr("发送不可用：原临时发送方案已暂停，请在目标条确认或恢复自动匹配"))
		return
	}
	raw := notes                // 化名前的副本：预检里逐项列出 / 还原词典替换
	notes = a.aliasNotes(notes) // 词典化名先于隐私检查：被化名的实体不会再触发正则命中
	var fs []core.Finding
	rules := a.scanRules()
	for _, n := range notes {
		fs = append(fs, core.Scan(n.Text, rules)...)
	}
	a.outcomeDraftCreated(len(fs))
	hasImage := !rules.Off && slices.ContainsFunc(notes, func(n store.Note) bool { return len(n.MediaFiles()) > 0 }) // 图文 / 多图卡的图片同样要过图片隐私检查
	r, _ := a.resolution()
	mode := a.outputMode(r.Profile)
	// 同 Tauri shouldOpenPreflight（smart）：多张卡、套模板、代码格式、去 Markdown、确认 / 允许回车的方案都先进预检
	smart := len(notes) > 1 || tmpl != "" || mode == "code" || mode == "strip-markdown" ||
		r.Profile.EnterPolicy == "confirm" || r.Profile.EnterPolicy == "allow"
	if len(fs) > 0 || a.forceCheck || hasImage || smart {
		auto := len(fs) == 0 && !a.forceCheck && !smart // 只为图片 OCR 打开：检查干净就自动继续
		a.forceCheck = false
		a.pending, a.pendingTmpl, a.pf = notes, tmpl, preflightState{auto: auto, preAlias: raw}
		a.freezeDraftTarget()
		a.revealPanelForConfirm("预检") // 确认条在面板里
		return
	}
	a.askEnter(notes, false, tmpl)
}

// scanRules：设置里的隐私检查开关、关掉的提示类别与自定义敏感字段。
func (a *app) scanRules() core.Rules {
	st := a.store.Settings()
	return core.Rules{Off: st.FirewallOff, DisabledWarn: st.FirewallDisabledWarn, CustomFields: st.FirewallCustomFields}
}

// askEnter：方案为「每次发送前确认」时先在面板里问是否回车；保留了原文则一律不回车。
func (a *app) askEnter(notes []store.Note, rawKept bool, tmpl string) {
	r, _ := a.resolution()
	switch {
	case rawKept || r.Profile.EnterPolicy == "never":
		a.deliver(notes, false, tmpl)
	case r.Profile.EnterPolicy == "confirm":
		a.enterAsk, a.enterTmpl = notes, tmpl
		if a.draftTarget.pid == 0 {
			a.freezeDraftTarget()
		}
		a.revealPanelForConfirm("回车确认")
	default:
		a.deliver(notes, true, tmpl)
	}
}

func (a *app) deliver(notes []store.Note, enter bool, tmpl string) {
	rehearsal := a.pfRehearsal
	a.pfRehearsal = false
	if a.draftTargetChanged() {
		return
	}
	enter = enter && !rehearsal // 演练安全锁：只粘贴，不按回车
	target := a.target
	r, _ := a.resolution()
	redactions := a.lastRedactions
	a.lastRedactions = 0
	mode := a.outputMode(r.Profile)
	a.sendMode = ""
	override := a.sendPNG
	a.sendPNG = nil
	ph := a.sendPH
	a.sendPH = sendRedaction{}
	final, keepOv := a.sendFinal, a.sendKeep
	a.sendFinal, a.sendKeep = "", nil
	keep := r.Profile.KeepPanel
	if keepOv != nil {
		keep = *keepOv
	}
	// 同 Tauri buildDraft：图片卡的真实文字备注算正文（占位标题不算），每张卡的图片（主图 / 附件 / 图文块）都带上
	var texts []string
	var imgs [][]byte
	seen := map[string]bool{}
	ids := make([]string, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
		if n.Kind == "image" {
			if cap := strings.TrimSpace(imageNoteText(n)); cap != "" && !store.IsImagePlaceholder(cap) {
				texts = append(texts, n.Text)
			}
		} else {
			texts = append(texts, n.Text)
		}
		for _, f := range n.MediaFiles() {
			if seen[f] {
				continue
			}
			seen[f] = true
			if masked, ok := override[f]; ok { // 图片隐私检查遮挡后的发送副本
				imgs = append(imgs, masked)
			} else if raw, err := a.store.LoadImage(f); err == nil {
				imgs = append(imgs, raw)
			}
		}
	}
	payload := ""
	if len(texts) > 0 {
		payload = composePayload(texts, tmpl, mode)
		if final != "" { // 预检里手动编辑过：发送编辑后的最终文本（同 Tauri draft.finalText）
			payload, texts = final, []string{final}
		}
	}
	var png []byte
	if len(imgs) > 0 {
		png = imgs[0]
	}
	steps := deliverySteps(notes, payload, imgs, tmpl == "" && final == "" && mode == "plain")
	if !a.pinned && !keep && !rehearsal {
		a.hidePanelNow()
	} else {
		a.yieldPanelFocus()
	}
	profile := profileName(r.Profile)
	if a.fanout != nil {
		a.fanout.delivering = true
	}
	out := a.outcomeStarted()
	onClip := func(result string) { a.onMain(func() { a.outcomeClipboard(out, result) }) }
	a.beginBand(ids)
	go func() {
		check, err := core.DeliverWith(a.sys, target, core.Payload{Steps: steps}, core.Options{Enter: enter, StartedMs: a.targetStarted, OnClipboard: onClip, StepGap: a.store.Settings().PasteStep(), Trace: diag.Push})
		diag.Push("发送: %d 条 → %s 方案=%s 格式=%s enter=%v check=%s err=%v", len(notes), target.BundleID, r.Profile.ID, mode, enter, check, err)
		a.panelUpdate(func() { // 无窗口的测试里排队，由 drainUpdates 执行（多目标发送要靠这段收尾接着发下一个）
			prev := a.out // 期间可能已开始准备下一次发送
			a.out = out
			var open []string // 发送前未完成的卡：发送后被标记完成的可从状态带撤销
			for _, id := range ids {
				if n, ok := a.store.Note(id); ok && !n.Done {
					open = append(open, id)
				}
			}
			a.finishDeliver(target, ids, texts, png, redactions, ph, profile, check, err)
			var undo []string
			for _, id := range open {
				if n, ok := a.store.Note(id); ok && n.Done {
					undo = append(undo, id)
				}
			}
			a.settleBand(err != nil, err == nil && check != core.CheckUnchanged, enter && err == nil, undo)
			if err == nil {
				a.afterDelivered(ids, rehearsal)
			}
			a.out = prev
			a.fanoutDelivered(err == nil) // 多目标发送：接着发下一个
		})
	}()
}

// finishDeliver：投递结束后（主线程）记历史与「最近发送」、标记已发送、出 HUD。
func (a *app) finishDeliver(target macos.FrontApp, ids, texts []string, png []byte, redactions int, ph sendRedaction, profile string, check core.Check, err error) {
	d := store.Delivery{TargetName: target.Name, TargetBundle: target.BundleID, Status: "sent", SourceIDs: ids,
		TextChars: utf8.RuneCountInString(sendText(texts)), Unconfirmed: check == core.CheckUnchanged, Profile: profile}
	if png != nil {
		d.ImageCount = 1
	}
	d.Redactions = redactions
	if a.fanout != nil && a.fanout.delivering {
		d.Fanout = a.fanout.id
	}
	if err != nil {
		d.Status, d.Err = "failed", err.Error()
	}
	d.ID = a.out.id
	saved := a.store.AddDelivery(d)
	a.outcomeFinal(saved.ID, redactions, err)
	if err == nil {
		a.rememberRedactionMap(saved.ID, ph)
	}
	if err != nil {
		a.showHUD("warn", err.Error())
		return
	}
	_ = a.store.MarkSent(ids, time.Now())
	if check == core.CheckUnchanged {
		a.showHUD("warn", tr("已粘贴，但目标输入框内容没有变化，请确认是否发送成功"))
		return
	}
	a.showHUD("sent", fmt.Sprintf(tr("已发送 %d 条到 %s"), len(ids), target.Name))
}

func (a *app) sendSelected() {
	a.sendFromList(a.chosenNotes()) // 详情窗开着且全是剪贴卡：进卡片而非外发（同 Tauri）
}

// outputMode：本次覆盖优先，否则用发送方案的输出格式。
func (a *app) outputMode(p store.TargetProfile) string {
	if a.sendMode != "" {
		return a.sendMode
	}
	return p.OutputMode()
}

// sendWithMode：仅本次换输出格式发送（同 Tauri sendCheckedToChat(undefined, {format, markdownMode})），不改卡片与方案。
func (a *app) sendWithMode(notes []store.Note, mode string) {
	a.sendMode = mode
	a.send(notes)
	if len(a.pending) == 0 && len(a.enterAsk) == 0 {
		a.sendMode = "" // 已直接投递（deliver 同步读走了格式）或没发出去；挂起中的发送保留到确认 / 取消
	}
}

// outputModeItems：「输出格式」三项（✓ 标当前生效的格式）。
func (a *app) outputModeItems(m *ui.Menu, notes func() []store.Note) {
	r, _ := a.resolution()
	cur := a.outputMode(r.Profile)
	m.Item(tr("输出格式")).Disabled(true)
	for _, o := range []struct{ mode, label, tip string }{
		{"plain", "原文（保留 Markdown）", ""},
		{"strip-markdown", "去 Markdown 后发送", "去除标题、粗体、链接括号等；仅影响本次发送，不修改卡片"},
		{"code", "代码块 ```", "包裹为 Markdown 代码块，单条会带上检测到的语言"},
	} {
		label := tr(o.label)
		if o.mode == cur {
			label += " ✓"
		}
		if m.Item(label).Disabled(a.target.PID == 0).Chosen() {
			a.sendWithMode(notes(), o.mode)
		}
	}
}

// sendQueue 发送当前分组全部未完成项（按队列从下到上，即最早的在前）。
func (a *app) sendQueue() {
	var pending []store.Note
	for i := len(a.notes) - 1; i >= 0; i-- {
		if a.notes[i].Kind != "image" {
			pending = append(pending, a.notes[i])
		}
	}
	a.send(pending)
}

func (a *app) copySelected(c *ui.Context) {
	if n, ok := a.current(); ok {
		if a.copyNoteMedia(n) {
			return
		}
		mygo.Clipboard.WriteText(n.Text)
		a.showHUD("ok", "已复制")
	}
}

// reorder 是 ListState.Reorder 回调：把 rows 移到 to（仅无搜索时可排序）。
func (a *app) reorder(rows []int, to int) {
	if a.query != "" {
		return
	}
	moving := map[int]bool{}
	for _, r := range rows {
		moving[r] = true
	}
	var rest, picked []store.Note
	insert := 0
	for i, n := range a.notes {
		if moving[i] {
			picked = append(picked, n)
			continue
		}
		if i < to {
			insert++
		}
		rest = append(rest, n)
	}
	order := slices.Concat(rest[:insert], picked, rest[insert:], a.done)
	ids := make([]string, len(order))
	for i, n := range order {
		ids[i] = n.ID
	}
	_ = a.store.Reorder(a.section, ids)
	a.selected = insert
}

// ---- 剪贴板监听 ----

func (a *app) watchClipboard() {
	w := &core.ClipWatcher{
		Sys:      a.sys,
		Excluded: func() []string { return a.store.Settings().ClipExcludedApps }, // 剪贴忽略名单（与捕获排除分开，同 Tauri clipExcludedApps）
		Enabled: func() bool {
			st := a.store.Settings()
			return st.ClipboardWatch && !a.now().Before(st.ClipPauseUntil) // 暂停到点自动恢复
		},
		Ignore: func() (bool, bool) {
			st := a.store.Settings()
			return !st.ClipKeepConcealed, !st.ClipKeepTransient
		},
	}
	go func() {
		for range time.Tick(core.ClipPoll) {
			ev, ok := w.Tick()
			if !ok || ev.Source.PID == a.sys.SelfPID() {
				continue
			}
			if _, err := a.addClip(ev); err != nil {
				diag.Push("剪贴板: 入库失败 %v", err)
			}
		}
	}()
}

// richBlocks：富文本 HTML → 本地化后的图文块（同 Tauri materializeRichCapture）。图全失败返回 nil（按纯文本存）。
func (a *app) richBlocks(plain, html, sourceURL string) ([]store.ContentBlock, int) {
	r := core.ParseRichHTML(plain, html, sourceURL)
	if len(r.Sources) == 0 {
		return nil, r.Omitted
	}
	blocks, lost := core.LocalizeRich(r, sourceURL, a.store.SaveImage)
	lost += r.Omitted
	if r.Omitted > 0 {
		diag.Push("富图片: 解析丢弃 %s", strings.Join(r.OmittedSchemes, ","))
	}
	if len(store.ImageBlocks(blocks)) == 0 {
		return nil, lost
	}
	return blocks, lost
}

// addClip：外部复制入剪贴页——文字、整段链接（link 卡）或图片（存媒体库）。
func (a *app) addClip(ev core.ClipEvent) (store.Note, error) {
	n := store.Note{Section: store.SectionClipboard, Text: ev.Text, SourceApp: ev.Source.Name, BundleID: ev.Source.BundleID}
	switch {
	case ev.PNG != nil:
		name, err := a.store.SaveImage(ev.PNG)
		if err != nil {
			return n, err
		}
		n.Kind, n.ImageFile, n.ImageW, n.ImageH = "image", name, ev.W, ev.H
		n.Text = fmt.Sprintf(tr("图片 %d×%d"), ev.W, ev.H)
		diag.Push("剪贴板: 收图片 %d×%d 来自 %s", ev.W, ev.H, ev.Source.Name)
	case ev.Link:
		n.Kind, n.URL = "link", strings.TrimSpace(ev.Text)
		n.Text = n.URL
		diag.Push("剪贴板: 收链接 来自 %s", ev.Source.Name)
	case ev.HTML != "": // 同 Tauri materializeRichCapture：图文复制的图片本地化成内容块，文字与图片在一张剪贴卡里
		blocks, lost := a.richBlocks(ev.Text, ev.HTML, ev.URL)
		if blocks != nil {
			n.Blocks, n.Text, n.HTML = blocks, store.TextFromBlocks(blocks), ev.HTML
		}
		diag.Push("剪贴板: 收图文 %d 字符 %d 图（失败 %d）来自 %s", len([]rune(n.Text)), len(store.ImageBlocks(blocks)), lost, ev.Source.Name)
		if lost > 0 {
			a.onMain(func() {
				a.showHUD("warn", fmt.Sprintf(tr("已保存可读取内容，%d 张图片未能保存"), lost))
			})
		}
	default:
		diag.Push("剪贴板: 收文本 %d 字符 来自 %s", len([]rune(ev.Text)), ev.Source.Name)
	}
	added, dup, err := a.store.Add(n)
	now := a.now()
	if err == nil && dup { // 重复复制：刷新时间与来源，排到历史最新（同 Tauri）
		_ = a.store.BumpClip(added.ID, now, ev.Source.Name, ev.Source.BundleID)
	}
	// 连续复制两次自动置顶（同 Tauri clipDoubleCopyKeep：10 秒内复制两次同一内容 → 固定 ★）
	if err == nil && dup && !a.store.Settings().ClipDoubleCopyOff && a.lastClipID == added.ID && now.Sub(a.lastClipAt) <= 10*time.Second && !added.Kept {
		_ = a.store.SetKept(added.ID, true)
		added.Kept = true
		diag.Push("剪贴板: 连续复制两次，已固定")
	}
	a.lastClipID, a.lastClipAt = added.ID, now
	return added, err
}

// ---- 键盘监听 ----

func (a *app) startTap() {
	d := detector.New()
	var prev uint64
	seen := false
	err := macos.StartKeyTap(func(ev macos.KeyEvent) {
		if ev.Synthetic {
			return
		}
		if !seen { // 事件心跳：缺「输入监控」时 tap 能建但事件被静默扣留
			seen = true
			a.tapReceiving.Store(true)
			diag.Push("键盘事件流已到达（输入监控正常）")
		}
		st := a.store.Settings()
		d.ReleaseGap = time.Duration(max(st.TriggerGapMs, 150)) * time.Millisecond
		target, others := modifierFlags(st.TriggerModifier)
		var in detector.Event
		switch ev.Type {
		case macos.EventKeyDown:
			if ev.Keycode == 53 && a.longEsc() { // 长截屏中按 Esc：焦点在被截的应用上，由这里转为取消
				diag.Push("长截屏: Esc 取消")
			}
			in = detector.Event{Kind: detector.Other}
		case macos.EventFlagsChanged:
			now, was := ev.Flags&target != 0, prev&target != 0
			prev = ev.Flags
			switch {
			case now && !was:
				in = detector.Event{Kind: detector.TargetDown, At: time.Now(), OtherMods: ev.Flags&others != 0}
			case !now && was:
				in = detector.Event{Kind: detector.TargetUp, At: time.Now()}
			default:
				in = detector.Event{Kind: detector.Other}
			}
		default:
			return
		}
		out := d.Feed(in)
		switch {
		case out.Triggered:
			diag.Push("双击触发")
			a.onTrigger()
		case out.Rejected != "":
			diag.Push("双击未触发: %s (%dms)", out.Rejected, out.Ms)
		}
	})
	if err != nil {
		a.tapErr = err.Error()
		diag.Push("键盘监听失败: %v", err)
		return
	}
	a.tapErr, a.tapStarted = "", time.Now()
	diag.Push("键盘监听已建立")
}

func modifierFlags(name string) (target, others uint64) {
	all := macos.FlagShift | macos.FlagControl | macos.FlagOption | macos.FlagCommand
	switch name {
	case "control":
		target = macos.FlagControl
	case "option":
		target = macos.FlagOption
	default:
		target = macos.FlagShift
	}
	return target, all &^ target
}

func (a *app) now() time.Time { return a.clock() }

// deliverySteps 同 Tauri orderedSourceSegments：单张图文穿插的卡、正文未经模板 / 格式 / 预检改写时按块顺序交错粘贴；
// 其余情况文字整段在前、图片按顺序在后（同 Tauri 无 segments 时的旧顺序）。只在块投影与正文一致时交错，
// 防止把预检替换 / 词典化名之前的原文从块里发出去。
func deliverySteps(notes []store.Note, payload string, imgs [][]byte, plain bool) []core.Step {
	if len(notes) == 1 && plain && len(imgs) > 0 {
		n := notes[0]
		if store.HasMixedContent(n.Blocks) && store.TextFromBlocks(n.Blocks) == n.Text && n.Text == payload {
			var out []core.Step
			k := 0
			for _, b := range n.Blocks {
				switch {
				case b.Type == "image" && k < len(imgs):
					out = append(out, core.Step{PNG: imgs[k]})
					k++
				case b.Type != "image" && strings.TrimSpace(b.Text) != "":
					out = append(out, core.Step{Text: b.Text})
				}
			}
			for ; k < len(imgs); k++ {
				out = append(out, core.Step{PNG: imgs[k]})
			}
			return out
		}
	}
	var out []core.Step
	if strings.TrimSpace(payload) != "" {
		out = append(out, core.Step{Text: payload})
	}
	for _, p := range imgs {
		out = append(out, core.Step{PNG: p})
	}
	return out
}

// composePayload：发送正文 = 多条编号列表 → 套提示词模板 → 按方案输出格式加工。
func composePayload(texts []string, tmpl, mode string) string {
	content := sendText(texts)
	if tmpl != "" {
		content = store.ApplyPromptTemplate(tmpl, content)
	}
	return store.FormatForDelivery(content, mode)
}

// checkSend：「检查后发送…」——无论有无敏感项都先在面板里展示将要发送的内容，确认后再发。
func (a *app) checkSend(notes []store.Note) {
	a.forceCheck = true
	a.send(notes)
	a.forceCheck = false
}

// exportNotes：「导出笔记包…」——系统保存面板选位置，写 zip（notes.md + media/）。
func (a *app) exportNotes(notes []store.Note) {
	md, media, err := store.BuildNotesExport(notes, a.store.Sections(), a.now())
	if err != nil {
		a.showHUD("warn", tr(err.Error()))
		return
	}
	name := a.now().Format("Toskr-笔记-2006-01-02")
	if len(notes) > 1 {
		name += fmt.Sprintf("-%d条", len(notes))
	}
	go func() {
		home, _ := os.UserHomeDir()
		path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Title: tr("导出笔记包"), DefaultPath: filepath.Join(home, "Desktop", name+".zip"),
			CreateDirectories: true, Filters: []mygo.FileFilter{{Name: tr("Toskr Markdown 笔记包"), Extensions: []string{"zip"}}}})
		if err != nil || path == "" {
			return
		}
		err = a.store.WriteNotesBundle(path, md, media)
		a.panel.Update(func() {
			switch {
			case err != nil:
				a.showHUD("warn", fmt.Sprintf(tr("导出失败：%s"), err.Error()))
			case len(notes) == 1:
				msg := tr("笔记包已导出")
				if len(media) > 0 {
					msg += fmt.Sprintf(tr("（含 %d 张图）"), len(media))
				}
				a.showHUD("ok", msg)
			default:
				msg := fmt.Sprintf(tr("已导出 %d 条笔记"), len(notes))
				if len(media) > 0 {
					msg += fmt.Sprintf(tr("、%d 张图"), len(media))
				}
				a.showHUD("ok", msg)
			}
		})
	}()
}

// clipRunes 截到 n 个字符（保留换行），超出加省略号。
func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// rangeSelect：⇧点击把锚点到这张卡之间全部勾选（并入已有勾选，同 Tauri / Finder）；没有锚点返回 false 按普通点击处理。
func (a *app) rangeSelect(id string) bool {
	from, ok1 := a.noteIdx[a.anchorID]
	to, ok2 := a.noteIdx[id]
	if a.anchorID == "" || a.anchorID == id || !ok1 || !ok2 {
		return false
	}
	for i := min(from, to); i <= max(from, to); i++ {
		a.chosen.Add(a.notes[i].ID)
	}
	a.selected, a.focusList = to, true
	return true
}

// searchSecrets：秘文按密钥名 / 来源应用过滤（同 Tauri matchSecretNote；密文本身不参与匹配）。
func searchSecrets(list []store.Secret, q string) []store.Secret {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return list
	}
	return slices.DeleteFunc(list, func(x store.Secret) bool {
		return !strings.Contains(strings.ToLower(x.KeyLabel), q) && !strings.Contains(strings.ToLower(x.SourceApp), q)
	})
}
