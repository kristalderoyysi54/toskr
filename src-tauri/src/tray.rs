//! 菜单栏托盘：常驻入口 + 状态仪表（权限警示、隐身模式、开机启动）。
//! 菜单在状态变化时整体重建（refresh），避免持有 item 句柄的复杂度。

use std::sync::atomic::Ordering;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;

use crate::events::{TriggerPayload, TRIGGER_EVENT};
use crate::state::AppState;

const TRAY_ID: &str = "toskr-tray";
const TRAY_ICON: &[u8] = include_bytes!("../icons/trayTemplate.png");
/// 隐身模式变化（tray → 主窗口，用于设置持久化同步）。
pub const STEALTH_EVENT: &str = "toskr://stealth-changed";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Toskr")
        .on_menu_event(|app, event| handle_menu(app, event.id.as_ref()));

    builder = builder
        .icon(Image::from_bytes(TRAY_ICON)?)
        .icon_as_template(true);
    builder.build(app)?;
    Ok(())
}

/// 状态变化后重建菜单（权限就绪、隐身切换、开机启动切换）。
pub fn refresh(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let state = app.state::<AppState>();
    let tap_installed = state.tap_installed.load(Ordering::SeqCst);
    let listen_authorized = crate::input::tap::listen_authorized();
    let tap_ok = tap_installed && listen_authorized;
    let stealth = state.stealth.load(Ordering::SeqCst);
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);

    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏面板", true, None::<&str>)?;
    let stealth_item =
        CheckMenuItem::with_id(app, "stealth", "隐身模式（不弹捕获提示）", true, stealth, None::<&str>)?;
    let autostart_item =
        CheckMenuItem::with_id(app, "autostart", "开机启动", true, autostart_enabled, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Toskr", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    if tap_ok {
        Menu::with_items(
            app,
            &[&toggle, &sep1, &stealth_item, &autostart_item, &sep2, &quit],
        )
    } else {
        let label = if tap_installed {
            "⚠️ 需要输入监控权限（点击设置）"
        } else {
            "⚠️ 需要辅助功能权限（点击设置）"
        };
        let warn = MenuItem::with_id(
            app,
            "fix-permission",
            label,
            true,
            None::<&str>,
        )?;
        let sep0 = PredefinedMenuItem::separator(app)?;
        Menu::with_items(
            app,
            &[&warn, &sep0, &toggle, &sep1, &stealth_item, &autostart_item, &sep2, &quit],
        )
    }
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "toggle" => {
            let visible = app
                .get_webview_window("main")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            if visible {
                let _ = app.emit_to("main", TRIGGER_EVENT, TriggerPayload::Toggle);
            } else {
                crate::window::request_show_panel(app);
                let _ = app.emit_to("main", TRIGGER_EVENT, TriggerPayload::Toggle);
            }
        }
        "fix-permission" => {
            let pane = if app
                .state::<AppState>()
                .tap_installed
                .load(Ordering::SeqCst)
            {
                "Privacy_ListenEvent"
            } else {
                "Privacy_Accessibility"
            };
            let _ = std::process::Command::new("open")
                .arg(format!(
                    "x-apple.systempreferences:com.apple.preference.security?{pane}"
                ))
                .spawn();
            crate::input::tap::retry_install(app);
        }
        "stealth" => {
            let state = app.state::<AppState>();
            let next = !state.stealth.load(Ordering::SeqCst);
            state.stealth.store(next, Ordering::SeqCst);
            // 同步给前端持久化到 settings
            let _ = app.emit_to("main", STEALTH_EVENT, next);
            refresh(app);
        }
        "autostart" => {
            let manager = app.autolaunch();
            let enabled = manager.is_enabled().unwrap_or(false);
            let _ = if enabled {
                manager.disable()
            } else {
                manager.enable()
            };
            refresh(app);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}
