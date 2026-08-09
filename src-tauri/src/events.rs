use serde::Serialize;

/// 双击触发键后发往主窗口的事件载荷。
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TriggerPayload {
    /// 无选中文本：开关面板。`force` 表示来自专用面板快捷键：
    /// 用户意图明确是开关，钉住状态下也执行收起（双击触发则保持防误触）。
    Toggle { force: bool },
    /// 捕获到选中文本：交给前端入库（去重后由前端回调 HUD）。
    #[serde(rename_all = "camelCase")]
    Captured {
        /// 内容类型："text" | "image"（外层 kind 已被枚举标签占用）
        content_kind: String,
        text: String,
        /// 图片附件文件名（kind=image 时有值）
        image_file: Option<String>,
        image_w: Option<u32>,
        image_h: Option<u32>,
        app_name: Option<String>,
        bundle_id: Option<String>,
    },
}

/// 发往 HUD 窗口的展示载荷。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HudPayload {
    /// "added" | "duplicate" | "warn" | "undone" | "sent" | "ok" | "info" | "due"
    pub kind: String,
    pub text: String,
    /// 连拍计数（仅 added 有意义，≥2 时展示 ×N）。
    pub count: u32,
    /// 悬停时展示「撤销」按钮（捕获入库、可撤销的批量操作）。
    pub undoable: bool,
    /// 粘性气泡：不自动隐藏，仅用户点击可关闭（任务到期提醒）。
    pub sticky: bool,
    /// 点击气泡的跳转目标（任务 id；无则走默认「定位最近捕获」）。
    pub target_id: Option<String>,
}

/// HUD hover 状态变化（Rust → hud 窗口）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HudHoverPayload {
    pub hovered: bool,
}

/// 贴边隐藏运行态变化（Rust → 主窗口）：`active` = 当前是否处于可自动
/// 隐藏的布局（设置开启 + 面板可见 + 右缘独立停靠/右侧边栏 + 非钉住 +
/// 非伴随磁吸）；`hidden` = 面板当前是否已滑出仅露出细条。
/// 前端据此在 active 时豁免失焦自动隐藏（滑出取代真实 hide），
/// 在 hidden 时把快捷键/双击唤出识别为「贴边唤回」而非「开关切换」。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeHideStatePayload {
    pub active: bool,
    pub hidden: bool,
}

pub const TRIGGER_EVENT: &str = "toskr://trigger";
/// 前台观察器确认“下一次投递目标”语义变化；载荷为最新 TargetSnapshot。
pub const TARGET_CHANGED_EVENT: &str = "toskr://target-changed";
pub const HUD_EVENT: &str = "toskr://hud";
pub const HUD_HOVER_EVENT: &str = "toskr://hud-hover";
/// 即将隐藏 HUD：先通知前端播退场动画，延迟少许再真正 hide（进出场对称）。
pub const HUD_EXIT_EVENT: &str = "toskr://hud-exit";
/// 贴边隐藏运行态变化，载荷见 [`EdgeHideStatePayload`]。
pub const EDGE_HIDE_STATE_EVENT: &str = "toskr://edge-hide-state";
