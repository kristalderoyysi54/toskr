//! 合成键盘事件（需要辅助功能权限）。
//!
//! 用 macOS 虚拟键码而非 Unicode 映射，保证 Cmd+C / Cmd+V 是「位置性」快捷键，
//! 不受输入法与键盘布局影响。

use enigo::{Direction, Enigo, Key, Keyboard, Settings};

/// kVK_ANSI_C
const VK_C: u32 = 0x08;
/// kVK_ANSI_V
const VK_V: u32 = 0x09;

fn with_enigo(f: impl FnOnce(&mut Enigo) -> enigo::InputResult<()>) -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default())
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
    with_enigo(|e| e.key(Key::Return, Direction::Click))
}
