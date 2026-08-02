//! 全局键盘监听：CGEventTap 挂载到主线程 CFRunLoop。
//!
//! 为什么不用 rdev：其 macOS 后台线程 `listen` 存在多年未修复的段错误
//! （Narsil/rdev#74），根源是 TIS 键码转译仅限主线程。本实现只订阅
//! flagsChanged + keyDown 且不做任何键码转译，天然绕开该崩溃路径。
//!
//! 回调必须保持零分配、亚毫秒级返回；触发后的捕获流程派发到阻塞线程池。
//! （模块由 input/mod.rs 以 cfg(target_os = "macos") 门控。）

use std::cell::RefCell;
use std::sync::atomic::Ordering;
use std::time::Instant;

use core_foundation::base::TCFType;
use core_foundation::mach_port::CFMachPortRef;
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use core_graphics::event::{
    CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType,
};
use tauri::{AppHandle, Emitter, Manager};

use super::detector::{DoubleShiftDetector, FeedOutcome, InputEvent};
use crate::events::{TriggerPayload, TRIGGER_EVENT};
use crate::state::AppState;

use std::sync::atomic::AtomicPtr;

/// tap 端口指针，供回调内收到 TapDisabledByTimeout 时重新启用。
static TAP_PORT: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

extern "C" {
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGPreflightListenEventAccess() -> bool;
}

/// 当前签名是否已获「输入监控」授权。与 tap 是否创建成功分开判断：
/// Sequoia 上 tap 可创建但事件仍会被 TCC 静默拦截。
pub fn listen_authorized() -> bool {
    unsafe { CGPreflightListenEventAccess() }
}

/// 安装事件 tap。必须在主线程调用（setup 阶段或 run_on_main_thread 内）。
/// 未授权「辅助功能」时创建会失败。
pub fn install(app: AppHandle) -> Result<(), String> {
    let shared = RefCell::new((DoubleShiftDetector::default(), CGEventFlags::empty()));

    let tap = CGEventTap::new(
        CGEventTapLocation::Session,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
        move |_proxy, event_type, event| {
            handle_event(&app, &shared, event_type, event);
            None
        },
    )
    .map_err(|_| "创建 CGEventTap 失败：需要「辅助功能」权限".to_string())?;

    let source = tap
        .mach_port
        .create_runloop_source(0)
        .map_err(|_| "创建 RunLoop source 失败".to_string())?;
    CFRunLoop::get_current().add_source(&source, unsafe { kCFRunLoopCommonModes });
    tap.enable();

    TAP_PORT.store(
        tap.mach_port.as_concrete_TypeRef() as *mut _,
        Ordering::SeqCst,
    );
    // tap（含回调闭包）常驻整个进程生命周期。
    std::mem::forget(tap);
    Ok(())
}

/// 前端「我已授权」按钮触发的重试安装（免重启应用）。
pub fn retry_install(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<AppState>();
        if state.tap_installed.load(Ordering::SeqCst) {
            return;
        }
        if install(handle.clone()).is_ok() {
            state.tap_installed.store(true, Ordering::SeqCst);
            crate::diag::push(&handle, "权限已生效，键盘监听已安装");
            // 权限就绪后移除托盘警示项
            crate::tray::refresh(&handle);
        }
    });
}

fn handle_event(
    app: &AppHandle,
    shared: &RefCell<(DoubleShiftDetector, CGEventFlags)>,
    event_type: CGEventType,
    event: &core_graphics::event::CGEvent,
) {
    // 事件心跳：首个键盘事件到达即标记（诊断输入监控权限是否放行投递）
    {
        let state = app.state::<AppState>();
        if !state.key_events_seen.swap(true, Ordering::Relaxed) {
            crate::diag::push(app, "键盘事件流已到达（输入监控正常）");
        }
    }
    match event_type {
        // 回调超时/用户输入导致 tap 被系统禁用时自动恢复（经典陷阱）。
        CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
            let port = TAP_PORT.load(Ordering::SeqCst);
            if !port.is_null() {
                unsafe { CGEventTapEnable(port as CFMachPortRef, true) };
            }
        }
        CGEventType::FlagsChanged => {
            let now = Instant::now();
            let flags = event.get_flags();
            let triggered = {
                let mut guard = shared.borrow_mut();
                let prev = guard.1;
                guard.1 = flags;

                // 运行时读取触发键配置（设置项可改双击 ⇧/⌃/⌥ 与间隔）
                let (target_flag, other_flags) = match app
                    .state::<AppState>()
                    .hotkey_modifier
                    .load(Ordering::Relaxed)
                {
                    crate::state::MOD_CONTROL => (
                        CGEventFlags::CGEventFlagControl,
                        CGEventFlags::CGEventFlagShift
                            | CGEventFlags::CGEventFlagAlternate
                            | CGEventFlags::CGEventFlagCommand,
                    ),
                    crate::state::MOD_OPTION => (
                        CGEventFlags::CGEventFlagAlternate,
                        CGEventFlags::CGEventFlagShift
                            | CGEventFlags::CGEventFlagControl
                            | CGEventFlags::CGEventFlagCommand,
                    ),
                    _ => (
                        CGEventFlags::CGEventFlagShift,
                        CGEventFlags::CGEventFlagControl
                            | CGEventFlags::CGEventFlagAlternate
                            | CGEventFlags::CGEventFlagCommand,
                    ),
                };
                let gap_ms =
                    app.state::<AppState>().hotkey_gap_ms.load(Ordering::Relaxed) as u64;
                guard
                    .0
                    .set_release_gap(std::time::Duration::from_millis(gap_ms));

                let target_now = flags.contains(target_flag);
                let target_prev = prev.contains(target_flag);
                let other_mods = flags.intersects(other_flags);

                let input = if target_now && !target_prev {
                    InputEvent::ShiftDown { at: now, other_mods }
                } else if !target_now && target_prev {
                    InputEvent::ShiftUp { at: now }
                } else {
                    // 其他修饰键（含 CapsLock）变化
                    InputEvent::Other
                };
                guard.0.feed(input)
            };
            match triggered {
                FeedOutcome::Triggered => {
                    crate::diag::push(app, "双击触发");
                    on_trigger(app);
                }
                FeedOutcome::Rejected { reason, ms } => {
                    // 近失诊断：帮用户/开发定位「为什么这次没触发」
                    crate::diag::push(app, format!("双击未触发: {reason} ({ms}ms)"));
                }
                FeedOutcome::None => {}
            }
        }
        CGEventType::KeyDown => {
            let _ = shared.borrow_mut().0.feed(InputEvent::Other);
        }
        _ => {}
    }
}

/// 双击 Shift 触发裁决：
/// - 前台是本应用 → 开关面板；
/// - 前台是其他应用 → 尝试捕获选中文本；有 → 静默入库 + HUD；无 → 开关面板。
fn on_trigger(app: &AppHandle) {
    let me = std::process::id() as i32;
    match crate::focus::frontmost_info() {
        Some(front) if front.pid != me => {
            if let Some(state) = app.try_state::<AppState>() {
                *state.prev_app_pid.lock().unwrap() = Some(front.pid);
            }
            // 捕获排除名单（密码管理器等）：只做面板开关，绝不读取内容
            let excluded = front
                .bundle_id
                .as_deref()
                .map(|b| {
                    app.state::<AppState>()
                        .excluded_apps
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|a| a == b)
                })
                .unwrap_or(false);
            if excluded {
                crate::diag::push(
                    app,
                    format!(
                        "捕获: {} 在排除名单，跳过",
                        front.name.as_deref().unwrap_or("?")
                    ),
                );
                let _ = app.emit_to("main", TRIGGER_EVENT, TriggerPayload::Toggle);
                return;
            }
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                match crate::capture::capture_selection(&handle) {
                    // 只发事件：入库与去重由前端裁决后回调 show_capture_hud
                    Some(crate::capture::Captured::Text(text)) => {
                        let _ = handle.emit_to(
                            "main",
                            TRIGGER_EVENT,
                            TriggerPayload::Captured {
                                content_kind: "text".into(),
                                text,
                                image_file: None,
                                image_w: None,
                                image_h: None,
                                app_name: front.name,
                                bundle_id: front.bundle_id,
                            },
                        );
                    }
                    Some(crate::capture::Captured::Image { file, w, h }) => {
                        let _ = handle.emit_to(
                            "main",
                            TRIGGER_EVENT,
                            TriggerPayload::Captured {
                                content_kind: "image".into(),
                                text: format!("图片 {w}×{h}"),
                                image_file: Some(file),
                                image_w: Some(w),
                                image_h: Some(h),
                                app_name: front.name,
                                bundle_id: front.bundle_id,
                            },
                        );
                    }
                    None => {
                        // 捕获失败的兜底：面板已可见（尤其钉住场景）时，用户意图
                        // 几乎必是捕获——绝不能把面板藏了，只给轻提示；
                        // 面板隐藏时才视为「开关面板」。
                        let visible = handle
                            .get_webview_window("main")
                            .and_then(|w| w.is_visible().ok())
                            .unwrap_or(false);
                        if visible {
                            crate::window::show_hud(
                                &handle,
                                "warn",
                                "未检测到选中内容".into(),
                                false,
                            );
                        } else {
                            let _ =
                                handle.emit_to("main", TRIGGER_EVENT, TriggerPayload::Toggle);
                        }
                    }
                }
            });
        }
        _ => {
            let _ = app.emit_to("main", TRIGGER_EVENT, TriggerPayload::Toggle);
        }
    }
}
