use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU16, AtomicU64, AtomicU8};
use std::sync::Mutex;

/// 触发修饰键编码（AtomicU8）。
pub const MOD_SHIFT: u8 = 0;
pub const MOD_CONTROL: u8 = 1;
pub const MOD_OPTION: u8 = 2;

/// 伴随停靠配置（由前端 settings 下发；下发前用与前端一致的默认值，
/// 避免启动初期存在「伴随未启用」的窗口期）。
#[derive(Clone)]
pub struct CompanionConfig {
    pub enabled: bool,
    pub apps: Vec<String>,
}

/// 与前端 DEFAULT_COMPANION_APPS 保持一致的预置伴随应用。
pub const DEFAULT_COMPANION_APPS: &[&str] = &[
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "com.github.wez.wezterm",
    "net.kovidgoyal.kitty",
    "io.alacritty",
    "com.mitchellh.ghostty",
    "com.todesktop.230313mzl4w4u92",
    "com.microsoft.VSCode",
    "com.microsoft.VSCodeInsiders",
    "com.dimillian.codexmonitor",
    "com.codepilot.app",
    "io.appmakes.otty",
    "com.openai.codex",
];

impl Default for CompanionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            apps: DEFAULT_COMPANION_APPS.iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// HUD 运行态（hover 轮询与连拍计数共享）。
#[derive(Default)]
pub struct HudRuntime {
    pub visible: bool,
    pub hovered: bool,
    /// HUD 逻辑坐标矩形（顶左原点全局 pt），供光标命中判定。
    pub rect_pt: (f64, f64, f64, f64),
    /// 连拍捕获计数（HUD 可见期内递增）。
    pub streak: u32,
}

/// 全局共享状态。
pub struct AppState {
    /// 面板弹出/触发前记录的前台应用 PID，用于「发送到对话」时归还焦点。
    pub prev_app_pid: Mutex<Option<i32>>,
    /// HUD 显示代数计数：防止早到的隐藏/轮询任务干扰新 HUD。
    pub hud_generation: AtomicU64,
    /// CGEventTap 是否安装成功（未授权辅助功能时会失败）。
    pub tap_installed: AtomicBool,
    /// tap 是否真正收到过键盘事件（Sequoia：创建成功≠事件投递，
    /// 输入监控权限缺失时事件被系统静默扣留）。
    pub key_events_seen: AtomicBool,

    // ===== v2 =====
    /// 触发修饰键（MOD_*）。
    pub hotkey_modifier: AtomicU8,
    /// 双击「抬起→抬起」最大间隔 ms。
    pub hotkey_gap_ms: AtomicU16,
    /// 隐身模式：不弹任何 HUD。
    pub stealth: AtomicBool,
    /// 面板逻辑宽度 pt。
    pub panel_width_pt: Mutex<f64>,
    /// 面板顶缘相对基准（伴随=目标窗口顶 / 经典=工作区顶+边距）的偏移 pt。
    pub panel_top_offset: Mutex<f64>,
    /// 面板高度覆盖 pt（None = 自动：伴随=同目标窗口高 / 经典=近全高）。
    /// 会话内临时值：吸附目标切换时重置为自动（高度跟随当前应用）。
    pub panel_height_pt: Mutex<Option<f64>>,
    /// 当前吸附目标 pid（用于检测目标切换以重置高度/偏移覆盖）。
    pub last_dock_pid: Mutex<Option<i32>>,
    /// 伴随停靠配置。
    pub companion: Mutex<CompanionConfig>,
    /// 伴随停靠时面板与目标窗口的间隙 pt（设置项，0=紧贴）。
    pub companion_gap: Mutex<f64>,
    /// 独立模式下用户手动拖到的位置（逻辑 pt，左上角）。
    pub panel_free_pos: Mutex<Option<(f64, f64)>>,
    /// 当前是否处于伴随吸附状态（决定移动事件是否记为手动位置）。
    pub docked: AtomicBool,
    /// 捕获排除列表（bundle id）：这些应用内双击只开关面板、绝不捕获。
    pub excluded_apps: Mutex<Vec<String>>,
    /// 伴随跟随任务代数（bump 即停止旧任务）。
    pub companion_gen: AtomicU64,
    /// HUD 运行态。
    pub hud: Mutex<HudRuntime>,
    /// 应用图标缓存：bundle id → (data URL, 主色)。
    pub icon_cache: Mutex<HashMap<String, Option<(String, String)>>>,
    /// 上次捕获尝试结束时的剪贴板文本快照（「新鲜度兜底」判定用：
    /// 流式终端选区被新输出冲掉时，copy-on-select 已入剪贴板的内容仍可捕获）。
    pub last_clipboard_text: Mutex<Option<String>>,
    /// 剪贴板历史收集开关（设置项下发；watcher 线程常驻按此门控）。
    pub clip_watch: AtomicBool,
    /// 应用自身最近一次写剪贴板后的 changeCount（watcher 忽略该次变更）。
    pub pasteboard_self_count: AtomicI64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            prev_app_pid: Mutex::new(None),
            hud_generation: AtomicU64::new(0),
            tap_installed: AtomicBool::new(false),
            key_events_seen: AtomicBool::new(false),
            hotkey_modifier: AtomicU8::new(MOD_SHIFT),
            hotkey_gap_ms: AtomicU16::new(400),
            stealth: AtomicBool::new(false),
            panel_width_pt: Mutex::new(380.0),
            panel_top_offset: Mutex::new(0.0),
            panel_height_pt: Mutex::new(None),
            last_dock_pid: Mutex::new(None),
            companion: Mutex::new(CompanionConfig::default()),
            companion_gap: Mutex::new(8.0),
            panel_free_pos: Mutex::new(None),
            docked: AtomicBool::new(false),
            excluded_apps: Mutex::new(
                [
                    "com.1password.1password",
                    "com.agilebits.onepassword7",
                    "com.bitwarden.desktop",
                    "com.apple.Passwords",
                    "com.apple.keychainaccess",
                ]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            ),
            companion_gen: AtomicU64::new(0),
            hud: Mutex::new(HudRuntime::default()),
            icon_cache: Mutex::new(HashMap::new()),
            last_clipboard_text: Mutex::new(None),
            clip_watch: AtomicBool::new(false),
            pasteboard_self_count: AtomicI64::new(0),
        }
    }
}
