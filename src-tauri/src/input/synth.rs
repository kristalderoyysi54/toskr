//! 合成键盘事件（需要辅助功能权限）。
//!
//! 用 macOS 虚拟键码而非 Unicode 映射，保证 Cmd+C / Cmd+V 是「位置性」快捷键，
//! 不受输入法与键盘布局影响。

use std::time::Duration;

use enigo::{Direction, Enigo, Key, Keyboard, Settings};

/// 供 CGEventTap 区分 Toskr 合成事件与用户真实输入。
pub(crate) const EVENT_SOURCE_MARKER: i64 = 0x544f_534b_52;

/// kVK_ANSI_C
const VK_C: u32 = 0x08;
/// kVK_ANSI_V
const VK_V: u32 = 0x09;

fn with_enigo(f: impl FnOnce(&mut Enigo) -> enigo::InputResult<()>) -> Result<(), String> {
    let mut settings = Settings::default();
    settings.event_source_user_data = Some(EVENT_SOURCE_MARKER);
    let mut enigo = Enigo::new(&settings)
        .map_err(|e| format!("初始化按键合成失败（缺少辅助功能权限？）: {e}"))?;
    f(&mut enigo).map_err(|e| format!("合成按键失败: {e}"))
}

/// 合成 Cmd+C。
pub fn press_copy() -> Result<(), String> {
    with_enigo(|e| {
        e.key(Key::Meta, Direction::Press)?;
        e.key(Key::Other(VK_C), Direction::Click)?;
        e.key(Key::Meta, Direction::Release)
    })
}

/// 合成 Cmd+V。
pub fn press_paste() -> Result<(), String> {
    with_enigo(|e| {
        e.key(Key::Meta, Direction::Press)?;
        e.key(Key::Other(VK_V), Direction::Click)?;
        e.key(Key::Meta, Direction::Release)
    })
}

/// 合成回车。
pub fn press_return() -> Result<(), String> {
    with_enigo(|e| {
        e.key(Key::Return, Direction::Press)?;
        // Click 会连续投递 key-down/key-up；保留一个真实按键停留窗口，避免忙碌的
        // Electron/WebView 输入框偶发漏掉零间隔事件。
        std::thread::sleep(Duration::from_millis(20));
        e.key(Key::Return, Direction::Release)
    })
}
