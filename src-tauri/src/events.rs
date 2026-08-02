use serde::Serialize;

/// 双击触发键后发往主窗口的事件载荷。
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TriggerPayload {
    /// 无选中文本：开关面板。
    Toggle,
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
    /// "added" | "duplicate" | "warn" | "undone" | "sent" | "ok" | "info"
    pub kind: String,
    pub text: String,
    /// 连拍计数（仅 added 有意义，≥2 时展示 ×N）。
    pub count: u32,
    /// 悬停时展示「撤销」按钮（捕获入库、可撤销的批量操作）。
    pub undoable: bool,
}

/// HUD hover 状态变化（Rust → hud 窗口）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HudHoverPayload {
    pub hovered: bool,
}

pub const TRIGGER_EVENT: &str = "toskr://trigger";
pub const HUD_EVENT: &str = "toskr://hud";
pub const HUD_HOVER_EVENT: &str = "toskr://hud-hover";
