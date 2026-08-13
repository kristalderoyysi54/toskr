use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TriggerSource {
    Hotkey,
    DoubleTap,
    Tray,
}

/// 双击触发键后发往主窗口的事件载荷。
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TriggerPayload {
    /// 无选中文本：开关面板。`force` 表示来自专用面板快捷键：
    /// 用户意图明确是开关，钉住状态下也执行收起（双击触发则保持防误触）。
    Toggle { force: bool, source: TriggerSource },
    /// 捕获到选中文本：交给前端入库（去重后由前端回调 HUD）。
    #[serde(rename_all = "camelCase")]
    Captured {
        /// 内容类型："text" | "image"（外层 kind 已被枚举标签占用）
        content_kind: String,
        text: String,
        /// 与 text 来自同一 pasteboard item / generation 的富表示。
        html: Option<String>,
        /// 浏览器声明的来源 URL，仅供前端解析相对图片地址。
        source_url: Option<String>,
        /// 来源侧捕获时间；异步图片本地化不得改变卡片时序。
        captured_at_ms: i64,
        /// 图片附件文件名（kind=image 时有值）
        image_file: Option<String>,
        image_w: Option<u32>,
        image_h: Option<u32>,
        app_name: Option<String>,
        bundle_id: Option<String>,
        /// 原剪贴板恢复不完整时的可见告警；正常恢复为 null。
        clipboard_warning: Option<String>,
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

/// 贴边隐藏运行态变化（Rust → 主窗口）：`active` = 当前是否已有可收起的
/// 屏缘锚点且未被伴随目标接管；`hidden` = 面板当前是否已滑出仅露出细条。
/// 前端据此在 active 时豁免失焦自动隐藏（滑出取代真实 hide），
/// 在 hidden 时把快捷键/双击唤出识别为「贴边唤回」而非「开关切换」。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeHideStatePayload {
    pub active: bool,
    pub hidden: bool,
}

pub const TRIGGER_EVENT: &str = "toskr://trigger";
/// 前台观察器确认“下一次发送目标”语义变化；载荷为最新 TargetSnapshot。
pub const TARGET_CHANGED_EVENT: &str = "toskr://target-changed";
/// 任一窗口清空发送活动后广播；其他窗口必须丢弃候选缓存和旧关联会话。
pub const DELIVERY_ACTIVITY_CLEARED_EVENT: &str = "toskr://delivery-activity-cleared";
pub const HUD_EVENT: &str = "toskr://hud";
pub const HUD_HOVER_EVENT: &str = "toskr://hud-hover";
/// 即将隐藏 HUD：先通知前端播退场动画，延迟少许再真正 hide（进出场对称）。
pub const HUD_EXIT_EVENT: &str = "toskr://hud-exit";
/// 贴边隐藏运行态变化，载荷见 [`EdgeHideStatePayload`]。
pub const EDGE_HIDE_STATE_EVENT: &str = "toskr://edge-hide-state";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_source_serializes_for_frontend_hold_policy() {
        let payload = serde_json::to_value(TriggerPayload::Toggle {
            force: true,
            source: TriggerSource::DoubleTap,
        })
        .unwrap();
        assert_eq!(payload["kind"], "toggle");
        assert_eq!(payload["source"], "doubleTap");
        assert_eq!(payload["force"], true);
    }

    #[test]
    fn rich_capture_serializes_same_snapshot_fields_for_frontend() {
        let payload = serde_json::to_value(TriggerPayload::Captured {
            content_kind: "text".into(),
            text: "前\n后".into(),
            html: Some("<p>前</p><img src=\"data:image/png;base64,AA==\"><p>后</p>".into()),
            source_url: Some("https://example.test/page".into()),
            captured_at_ms: 123,
            image_file: None,
            image_w: None,
            image_h: None,
            app_name: Some("Browser".into()),
            bundle_id: Some("test.browser".into()),
            clipboard_warning: None,
        })
        .unwrap();

        assert_eq!(payload["kind"], "captured");
        assert_eq!(&payload["html"].as_str().unwrap()[..3], "<p>");
        assert_eq!(payload["sourceUrl"], "https://example.test/page");
        assert_eq!(payload["capturedAtMs"], 123);
    }
}
