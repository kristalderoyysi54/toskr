//! 原生侧界面语言（托盘菜单、窗口标题）。与前端同口径：中文原文即 key，
//! 英文表缺条目时回落中文。语言由前端解析后经 `set_locale` 下发；
//! 前端就绪前按系统首选语言初始化，避免英文系统首次启动看到中文托盘。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

static EN: AtomicBool = AtomicBool::new(false);

pub fn is_en() -> bool {
    EN.load(Ordering::Relaxed)
}

pub fn tr(zh: &'static str) -> &'static str {
    if is_en() {
        en(zh).unwrap_or(zh)
    } else {
        zh
    }
}

/// 行内双语：中文环境返回 `zh`（逐字不变），英文环境返回 `en`。
/// 新增原生侧文案优先用它，不再往下方查表里加条目。
pub fn pick(zh: &'static str, en: &'static str) -> &'static str {
    pick_for(is_en(), zh, en)
}

fn pick_for(en: bool, zh: &'static str, en_text: &'static str) -> &'static str {
    if en {
        en_text
    } else {
        zh
    }
}

/// 行内双语的 `format!`：`tr_fmt!("图片读取失败：{e}", "Failed to read image: {e}")`。
/// 两个模板各自按 `format!` 规则展开（支持内联捕获与追加参数），只求值当前语言那一支。
#[macro_export]
macro_rules! tr_fmt {
    ($zh:literal, $en:literal $(, $($arg:tt)*)?) => {
        $crate::tr_fmt_with!($crate::i18n::is_en(), $zh, $en $(, $($arg)*)?)
    };
}

/// `tr_fmt!` 的显式语言版本（单测用，避免改动全局语言影响并行测试）。
#[doc(hidden)]
#[macro_export]
macro_rules! tr_fmt_with {
    ($is_en:expr, $zh:literal, $en:literal $(, $($arg:tt)*)?) => {
        if $is_en {
            ::std::format!($en $(, $($arg)*)?)
        } else {
            ::std::format!($zh $(, $($arg)*)?)
        }
    };
}

fn en(zh: &str) -> Option<&'static str> {
    Some(match zh {
        "显示 / 隐藏面板" => "Show / Hide Panel",
        "暂停剪贴板收集" => "Pause Clipboard Collection",
        "暂停 15 分钟" => "Pause for 15 Minutes",
        "暂停 30 分钟" => "Pause for 30 Minutes",
        "暂停 1 小时" => "Pause for 1 Hour",
        "暂停 3 小时" => "Pause for 3 Hours",
        "暂停 8 小时" => "Pause for 8 Hours",
        "恢复剪贴板收集（约 {mins} 分钟后自动恢复）" => {
            "Resume Clipboard Collection (auto-resumes in ~{mins} min)"
        }
        "隐身模式（不弹捕获提示）" => "Stealth Mode (No Capture Notices)",
        "开机启动" => "Launch at Login",
        "设置…" => "Settings…",
        "退出 Toskr" => "Quit Toskr",
        "⚠️ 需要输入监控权限（点击设置）" => "⚠️ Input Monitoring Required (Click to Fix)",
        "⚠️ 需要辅助功能权限（点击设置）" => "⚠️ Accessibility Required (Click to Fix)",
        "Toskr 设置" => "Toskr Settings",
        "内容详情" => "Details",
        "图片预览" => "Image Preview",
        _ => return None,
    })
}

/// 系统首选语言标签（如 "zh-Hans-CN"、"en-US"）。
#[cfg(target_os = "macos")]
pub fn system_language_tag() -> Option<String> {
    objc2_foundation::NSLocale::preferredLanguages()
        .firstObject()
        .map(|tag| tag.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn system_language_tag() -> Option<String> {
    None
}

fn is_zh_tag(tag: Option<&str>) -> bool {
    tag.is_some_and(|tag| tag.to_ascii_lowercase().starts_with("zh"))
}

/// 启动时按系统语言初始化（前端随后会以用户设置覆盖）。
pub fn init_from_system() {
    EN.store(!is_zh_tag(system_language_tag().as_deref()), Ordering::Relaxed);
}

#[tauri::command]
pub fn system_locale() -> Option<String> {
    system_language_tag()
}

#[tauri::command]
pub fn set_locale(app: AppHandle, locale: String) {
    let en = locale == "en";
    if EN.swap(en, Ordering::Relaxed) == en {
        return;
    }
    crate::tray::refresh(&app);
    for (label, title) in [("settings", "Toskr 设置"), ("imgpreview", "图片预览")] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_title(tr(title));
        }
    }
    for (label, window) in app.webview_windows() {
        if label.starts_with("textpreview") {
            let _ = window.set_title(tr("内容详情"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_tags_detected() {
        assert!(is_zh_tag(Some("zh-Hans-CN")));
        assert!(is_zh_tag(Some("ZH-Hant")));
        assert!(!is_zh_tag(Some("en-US")));
        assert!(!is_zh_tag(None));
    }

    #[test]
    fn english_table_keeps_placeholders() {
        let key = "恢复剪贴板收集（约 {mins} 分钟后自动恢复）";
        assert!(en(key).unwrap().contains("{mins}"));
        assert_eq!(en("未收录的文案"), None);
    }

    #[test]
    fn pick_selects_by_locale() {
        assert_eq!(pick_for(false, "图片预览", "Image Preview"), "图片预览");
        assert_eq!(pick_for(true, "图片预览", "Image Preview"), "Image Preview");
    }

    #[test]
    fn default_locale_is_chinese() {
        // 测试进程从不调用 set_locale / init_from_system，中文文案须逐字保留。
        assert_eq!(pick("确认", "Confirm"), "确认");
        let e = "boom";
        assert_eq!(crate::tr_fmt!("图片读取失败：{e}", "Failed to read image: {e}"), "图片读取失败：boom");
    }

    #[test]
    fn tr_fmt_supports_captures_and_args() {
        let e = "boom";
        assert_eq!(
            crate::tr_fmt_with!(true, "图片读取失败：{e}", "Failed to read image: {e}"),
            "Failed to read image: boom"
        );
        assert_eq!(
            crate::tr_fmt_with!(false, "已删除 {} 条（{n}）", "Deleted {} ({n})", 3, n = "x"),
            "已删除 3 条（x）"
        );
        assert_eq!(
            crate::tr_fmt_with!(true, "已删除 {} 条（{n}）", "Deleted {} ({n})", 3, n = "x"),
            "Deleted 3 (x)"
        );
        assert_eq!(crate::tr_fmt_with!(true, "无参数", "No args"), "No args");
    }
}
