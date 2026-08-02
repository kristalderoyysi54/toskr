//! 跨应用划词捕获。
//!
//! 策略（按优先级）：
//! 1. AX API 直读焦点元素选中文本 —— 零副作用，原生应用/Safari 等可用。
//! 2. AX 不可信/不支持时走剪贴板路径：记录 NSPasteboard changeCount →
//!    合成 ⌘C → 轮询 changeCount 变化（不清空剪贴板，不破坏终端
//!    copy-on-select 已写入的内容；同文本重复复制也能被 changeCount 识别）。
//! 3. 「新鲜度兜底」：合成 ⌘C 落空（如流式终端的选区被新输出冲掉）时，
//!    若剪贴板文本相比上次捕获尝试发生过变化（= 用户选中时 copy-on-select
//!    刚写入的内容），采用它。首次尝试无基线，不兜底（防捕获陈旧内容）。
//!
//! 副作用说明：捕获成功后剪贴板保留捕获文本（等同一次普通复制），不再回滚。

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::ax::{self, AxSelection};
use crate::input::synth;
use crate::state::AppState;

/// changeCount 轮询：25 次 × 20ms = 最多 500ms（兼容复制偏慢的应用）。
const POLL_ATTEMPTS: u32 = 25;
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// NSPasteboard 通用剪贴板的 changeCount（任意线程可读）。
fn pasteboard_change_count() -> isize {
    let pb = objc2_app_kit::NSPasteboard::generalPasteboard();
    pb.changeCount()
}

/// 捕获结果：文本或图片附件。
pub enum Captured {
    Text(String),
    Image { file: String, w: u32, h: u32 },
}

/// 捕获当前前台应用的选中内容（文本优先，其次剪贴板图片）。
/// 阻塞调用（含 sleep），须在非主线程执行。
pub fn capture_selection(app: &AppHandle) -> Option<Captured> {
    match ax::selected_text() {
        AxSelection::Text(t) => {
            crate::diag::push(app, "捕获: AX 直读成功");
            normalize(t).map(Captured::Text)
        }
        // 「空」不可信：Otty 等终端的 AX 声明支持 AXSelectedText 但从不填充
        // （连 range 都谎报 0，实测实锤）。空时仍走剪贴板路径。
        AxSelection::Empty => {
            crate::diag::push(app, "捕获: AX 报空(不可信) → 剪贴板路径");
            capture_via_clipboard(app)
        }
        AxSelection::Unsupported => {
            crate::diag::push(app, "捕获: AX 不支持 → 剪贴板路径");
            capture_via_clipboard(app)
        }
    }
}

fn capture_via_clipboard(app: &AppHandle) -> Option<Captured> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    let before_text = clipboard.get_text().ok().filter(|t| !t.is_empty());
    let before_count = pasteboard_change_count();

    if synth::press_copy().is_err() {
        return None;
    }

    let mut captured: Option<String> = None;
    for _ in 0..POLL_ATTEMPTS {
        std::thread::sleep(POLL_INTERVAL);
        if pasteboard_change_count() != before_count {
            // 目标应用完成了复制（即使文本与旧剪贴板相同也能识别）
            if let Ok(text) = clipboard.get_text() {
                if !text.is_empty() {
                    captured = Some(text);
                }
            }
            break;
        }
    }

    let state = app.state::<AppState>();
    if captured.is_none() {
        // 新鲜度兜底：剪贴板相比上次捕获尝试变化过 → 采用
        //（典型：流式终端里选中即复制入剪贴板，随后选区被新输出冲掉）
        let last = state.last_clipboard_text.lock().unwrap().clone();
        match (&before_text, &last) {
            (Some(now), Some(prev)) if now != prev => {
                crate::diag::push(app, "捕获: 合成⌘C落空 → 新鲜度兜底成功");
                captured = Some(now.clone());
            }
            (Some(_), None) => {
                crate::diag::push(app, "捕获: 合成⌘C落空，首次无基线不兜底");
            }
            _ => {
                crate::diag::push(app, "捕获: 合成⌘C落空，剪贴板无新内容");
            }
        }
    }

    // 更新基线：本次尝试结束时的剪贴板文本
    let final_text = clipboard.get_text().ok().filter(|t| !t.is_empty());
    *state.last_clipboard_text.lock().unwrap() = final_text;

    if let Some(text) = captured.and_then(normalize) {
        return Some(Captured::Text(text));
    }

    // 无文本 → 试图片（截图/复制的图片）
    if let Ok(img) = clipboard.get_image() {
        match crate::storage::save_image_rgba(app, img.width, img.height, &img.bytes) {
            Ok(file) => {
                crate::diag::push(app, format!("捕获: 图片 {}×{}", img.width, img.height));
                return Some(Captured::Image {
                    file,
                    w: img.width as u32,
                    h: img.height as u32,
                });
            }
            Err(e) => crate::diag::push(app, format!("捕获: 图片保存失败 {e}")),
        }
    }
    None
}

/// 去掉首尾空白；全空白视为无效捕获。
fn normalize(text: String) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
