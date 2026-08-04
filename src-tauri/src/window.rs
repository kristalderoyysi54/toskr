//! 面板 / HUD 窗口管理：经典右缘停靠、伴随停靠跟随、HUD 生命周期。
//!
//! 注意：`cursor_position()` / `available_monitors()` 存在线程安全问题
//! （tauri-apps/tauri#15170），所有显示器/几何查询必须在主线程执行；
//! 跟随线程使用启动时快照的显示器信息。

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
};

use crate::ax::{self, AxWindowFrame};
use crate::events::{HudHoverPayload, HudPayload, HUD_EVENT, HUD_HOVER_EVENT};
use crate::focus;
use crate::state::AppState;

/// 面板与 HUD 距工作区边缘的逻辑边距（pt）。
const MARGIN: f64 = 12.0;
const HUD_WIDTH: f64 = 240.0;
const HUD_HEIGHT: f64 = 56.0;
/// HUD 无悬停时的展示时长（ms）。
const HUD_DURATION_MS: u64 = 1600;
/// 伴随模式自动高度的下限（pt）。
const COMPANION_MIN_HEIGHT: f64 = 400.0;
/// 用户手动调节的高度下限（pt）。
const PANEL_MIN_HEIGHT: f64 = 300.0;
/// 可吸附目标窗口的最小尺寸（pt）——过小的对话框/浮窗不作为吸附目标。
const MIN_TARGET_W: f64 = 480.0;
const MIN_TARGET_H: f64 = 300.0;

/// 读取目标进程焦点窗口 frame，并按最小尺寸过滤。
fn dockable_frame(pid: i32) -> Option<AxWindowFrame> {
    ax::focused_window_frame(pid).filter(|f| f.w >= MIN_TARGET_W && f.h >= MIN_TARGET_H)
}

/// 吸附目标切换时重置高度/顶偏移覆盖：切到新应用即恢复「与其窗口同高」。
/// 手动拖拽调节只对当前目标临时生效。
fn reset_overrides_if_target_changed(state: &AppState, pid: i32) {
    let mut last = state.last_dock_pid.lock().unwrap();
    if *last != Some(pid) {
        *last = Some(pid);
        *state.panel_top_offset.lock().unwrap() = 0.0;
        *state.panel_height_pt.lock().unwrap() = None;
    }
}

// ============ 显示器快照（逻辑 pt） ============

#[derive(Clone, Copy, Debug)]
pub struct MonitorPt {
    pub wa_x: f64,
    pub wa_y: f64,
    pub wa_w: f64,
    pub wa_h: f64,
}

/// 主线程：把所有显示器工作区换算为逻辑 pt 快照。
fn snapshot_monitors_pt(app: &AppHandle) -> Vec<MonitorPt> {
    let Ok(monitors) = app.available_monitors() else {
        return vec![];
    };
    monitors
        .iter()
        .map(|m| {
            let scale = m.scale_factor().max(0.5);
            let wa = m.work_area();
            MonitorPt {
                wa_x: wa.position.x as f64 / scale,
                wa_y: wa.position.y as f64 / scale,
                wa_w: wa.size.width as f64 / scale,
                wa_h: wa.size.height as f64 / scale,
            }
        })
        .collect()
}

fn monitor_containing_pt(monitors: &[MonitorPt], x: f64, y: f64) -> Option<MonitorPt> {
    monitors
        .iter()
        .find(|m| {
            x >= m.wa_x - MARGIN
                && x < m.wa_x + m.wa_w + MARGIN
                && y >= m.wa_y - MARGIN * 4.0
                && y < m.wa_y + m.wa_h + MARGIN
        })
        .or(monitors.first())
        .copied()
}

/// 伴随停靠矩形（纯函数，逻辑 pt）：贴目标窗口右缘，默认同高；
/// 支持用户上下调节：`top_offset` 相对目标窗口顶的偏移、`height_override` 高度覆盖。
pub fn compute_companion_rect(
    frame: AxWindowFrame,
    panel_w: f64,
    top_offset: f64,
    height_override: Option<f64>,
    gap: f64,
    monitor: &MonitorPt,
) -> (f64, f64, f64, f64) {
    let auto_h = frame.h.max(COMPANION_MIN_HEIGHT);
    let h = height_override
        .unwrap_or(auto_h)
        .clamp(PANEL_MIN_HEIGHT, monitor.wa_h);
    let y = (frame.y + top_offset)
        .clamp(monitor.wa_y, (monitor.wa_y + monitor.wa_h - h).max(monitor.wa_y));
    // 目标窗口右缘 + 间隙；屏幕右侧放不下时向左收（间隙也一并压缩）
    let max_x = monitor.wa_x + monitor.wa_w - panel_w - MARGIN;
    let x = (frame.x + frame.w + gap)
        .min(max_x)
        .max(monitor.wa_x);
    (x, y, panel_w, h)
}

// ============ 面板显隐 ============

/// 在主线程上定位并显示面板（可从任意线程调用）。
pub fn request_show_panel(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = show_panel_on_main(&handle) {
            eprintln!("[toskr] 显示面板失败: {e}");
        }
    });
}

fn show_panel_on_main(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let me = std::process::id() as i32;

    // 面板即将抢占焦点，先记录前台应用（发送归还 + 伴随目标）
    let front = focus::frontmost_info().filter(|f| f.pid != me);
    if let Some(f) = &front {
        *state.prev_app_pid.lock().unwrap() = Some(f.pid);
    }

    let window = app
        .get_webview_window("main")
        .ok_or(tauri::Error::WindowNotFound)?;
    let panel_w = *state.panel_width_pt.lock().unwrap();

    // 靠右边栏模式：贴「当前使用屏幕」（光标所在屏）右缘、全高（保留停靠间距），
    // 与伴随磁吸互斥——不做目标吸附、忽略手动拖动位置。
    // 屏幕匹配必须走逻辑 pt 空间：物理坐标在不同缩放的多屏下包含测试会失败、
    // 静默回退主屏（cursor_work_area 的坑）
    if state.right_sidebar.load(Ordering::SeqCst) {
        stop_companion_tracker(app);
        let monitors = snapshot_monitors_pt(app);
        // 光标屏优先；取不到光标时退面板当前所在屏（monitor_containing_pt 自带首屏兜底）
        let anchor = cursor_point_pt().or_else(|| {
            let pos = window.outer_position().ok()?;
            let scale = window.scale_factor().ok()?.max(0.5);
            Some((pos.x as f64 / scale + 20.0, pos.y as f64 / scale + 20.0))
        });
        let Some(m) = anchor.and_then(|(cx, cy)| monitor_containing_pt(&monitors, cx, cy))
        else {
            return Ok(());
        };
        let gap = *state.companion_gap.lock().unwrap();
        let height = (m.wa_h - 2.0 * gap).max(200.0);
        let x = m.wa_x + m.wa_w - panel_w - gap;
        let y = m.wa_y + gap;
        state.docked.store(false, Ordering::SeqCst);
        window.set_size(LogicalSize::new(panel_w, height))?;
        window.set_position(LogicalPosition::new(x, y))?;
        ensure_fullscreen_auxiliary(&window);
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    // 伴随候选：前台应用；前台是自己（托盘等路径）时回退到上一个应用
    let candidate: Option<(i32, Option<String>)> = match &front {
        Some(f) => Some((f.pid, f.bundle_id.clone())),
        None => {
            let pid = *state.prev_app_pid.lock().unwrap();
            pid.map(|p| (p, focus::bundle_of(p)))
        }
    };

    // 伴随停靠：候选应用需在预设伴随列表内且有有效窗口 frame
    let (companion_enabled, companion_apps) = {
        let cfg = state.companion.lock().unwrap();
        (cfg.enabled, cfg.apps.clone())
    };
    let companion_target = candidate.as_ref().and_then(|(pid, bundle)| {
        let hit = companion_enabled
            && bundle
                .as_deref()
                .map(|b| companion_apps.iter().any(|a| a == b))
                .unwrap_or(false);
        let frame = if hit { dockable_frame(*pid) } else { None };
        // 伴随诊断（stderr，仅命令行启动可见）
        eprintln!(
            "[toskr] companion: candidate={pid}({bundle:?}) in_list={hit} frame={frame:?}"
        );
        frame.map(|frame| (*pid, frame))
    });

    // 统一用逻辑坐标（pt）定位：tao 的 Physical 定位按「窗口当前所在屏」的
    // scale 反算，跨越不同缩放的屏幕时会错位（副屏不跟随的根因）。
    match companion_target {
        Some((pid, frame)) => {
            // 吸附目标变化 → 高度/偏移覆盖重置为自动（与新应用窗口同高）
            reset_overrides_if_target_changed(&state, pid);
            let monitors = snapshot_monitors_pt(app);
            let monitor = monitor_containing_pt(
                &monitors,
                frame.x + frame.w / 2.0,
                frame.y + frame.h / 2.0,
            )
            .ok_or(tauri::Error::WindowNotFound)?;
            let top_offset = *state.panel_top_offset.lock().unwrap();
            let height_override = *state.panel_height_pt.lock().unwrap();
            let gap = *state.companion_gap.lock().unwrap();
            let (x, y, w, h) =
                compute_companion_rect(frame, panel_w, top_offset, height_override, gap, &monitor);
            state.docked.store(true, Ordering::SeqCst);
            window.set_size(LogicalSize::new(w, h))?;
            window.set_position(LogicalPosition::new(x, y))?;
            ensure_fullscreen_auxiliary(&window);
            window.show()?;
            window.set_focus()?;
            start_companion_tracker(app, pid, monitors);
        }
        None => {
            // 独立模式：屏幕右缘停靠（桌面/无有效窗口的应用）。
            // 伴随开启时 tracker 仍常驻：之后切到任何有窗口的应用会自动吸附过去。
            if companion_enabled {
                let monitors = snapshot_monitors_pt(app);
                let pid = candidate.as_ref().map(|(p, _)| *p).unwrap_or(-1);
                start_companion_tracker(app, pid, monitors);
            } else {
                stop_companion_tracker(app);
            }
            let (origin, area, scale) = cursor_work_area(app)?;
            let wa_x = origin.x as f64 / scale;
            let wa_y = origin.y as f64 / scale;
            let wa_w = area.width as f64 / scale;
            let wa_h = area.height as f64 / scale;
            let top_offset = *state.panel_top_offset.lock().unwrap();
            let height_override = *state.panel_height_pt.lock().unwrap();
            let auto_h = (wa_h - 2.0 * MARGIN).max(200.0);
            let height = height_override
                .unwrap_or(auto_h)
                .clamp(PANEL_MIN_HEIGHT.min(auto_h), wa_h);
            state.docked.store(false, Ordering::SeqCst);
            // 独立模式：优先用用户手动拖到的位置（钳制在工作区内）
            let free = *state.panel_free_pos.lock().unwrap();
            let (x, y) = match free {
                Some((fx, fy)) => (
                    fx.clamp(wa_x, (wa_x + wa_w - panel_w).max(wa_x)),
                    fy.clamp(wa_y, (wa_y + wa_h - height).max(wa_y)),
                ),
                None => (
                    wa_x + wa_w - panel_w - MARGIN,
                    (wa_y + MARGIN + top_offset).clamp(wa_y, (wa_y + wa_h - height).max(wa_y)),
                ),
            };
            window.set_size(LogicalSize::new(panel_w, height))?;
            window.set_position(LogicalPosition::new(x, y))?;
            ensure_fullscreen_auxiliary(&window);
            window.show()?;
            window.set_focus()?;
        }
    }
    Ok(())
}

/// 隐藏面板；`restore_focus` 时把焦点还给此前记录的前台应用。
pub fn hide_panel(app: &AppHandle, restore_focus: bool) {
    stop_companion_tracker(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    if restore_focus {
        if let Some(state) = app.try_state::<AppState>() {
            let pid = *state.prev_app_pid.lock().unwrap();
            if let Some(pid) = pid {
                focus::activate_pid(pid);
            }
        }
    }
}

/// 调整面板宽度（pt），可见时保持右缘吸附实时生效。
pub fn set_panel_width(app: &AppHandle, width_pt: f64) {
    let state = app.state::<AppState>();
    let width_pt = width_pt.clamp(320.0, 520.0);
    *state.panel_width_pt.lock().unwrap() = width_pt;

    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("main") else {
            return;
        };
        if !window.is_visible().unwrap_or(false) {
            return;
        }
        // 伴随跟随线程会在下个 tick 应用新宽度；经典模式此处立即右吸附重排
        let Ok(scale) = window.scale_factor() else { return };
        let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
            return;
        };
        // 同屏操作：物理 → 逻辑后按逻辑坐标写回，保持右缘不动
        let right_pt = (pos.x as f64 + size.width as f64) / scale;
        let y_pt = pos.y as f64 / scale;
        let h_pt = size.height as f64 / scale;
        let _ = window.set_size(LogicalSize::new(width_pt, h_pt));
        let _ = window.set_position(LogicalPosition::new(right_pt - width_pt, y_pt));
    });
}

// ============ 伴随跟随 ============

fn start_companion_tracker(app: &AppHandle, target_pid: i32, monitors: Vec<MonitorPt>) {
    let state = app.state::<AppState>();
    let generation = state.companion_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    let me = std::process::id() as i32;

    tauri::async_runtime::spawn_blocking(move || {
        let mut target = target_pid;
        let mut last: Option<(AxWindowFrame, u32, i32, i32, i32)> = None;
        loop {
            std::thread::sleep(Duration::from_millis(60));
            let state = handle.state::<AppState>();
            if state.companion_gen.load(Ordering::SeqCst) != generation {
                return;
            }
            if !state.companion.lock().unwrap().enabled {
                return;
            }
            // 面板隐藏即停（hide 也会 bump gen，这里是双保险）
            let visible = handle
                .get_webview_window("main")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            if !visible {
                return;
            }
            // 切到「伴随列表内」的另一应用 → 换吸附目标；
            // 切到列表外应用/桌面 → 不追（面板原地保持独立/上次吸附位置）
            if let Some(front) = focus::frontmost_info() {
                if front.pid != me && front.pid != target {
                    let in_list = {
                        let cfg = state.companion.lock().unwrap();
                        front
                            .bundle_id
                            .as_deref()
                            .map(|b| cfg.apps.iter().any(|a| a == b))
                            .unwrap_or(false)
                    };
                    if in_list {
                        target = front.pid;
                        *state.prev_app_pid.lock().unwrap() = Some(target);
                        // 高度覆盖随目标切换重置：与新应用窗口同高
                        reset_overrides_if_target_changed(&state, target);
                        last = None;
                    }
                }
            }
            let width_pt = *state.panel_width_pt.lock().unwrap();
            let top_offset = *state.panel_top_offset.lock().unwrap();
            let height_override = *state.panel_height_pt.lock().unwrap();
            let gap = *state.companion_gap.lock().unwrap();
            // 目标无有效窗口（桌面/小对话框/已退出）→ 面板原地不动，继续观望
            let Some(frame) = dockable_frame(target) else {
                state.docked.store(false, Ordering::SeqCst);
                continue;
            };
            let key = (
                frame,
                width_pt as u32,
                top_offset as i32,
                height_override.unwrap_or(-1.0) as i32,
                gap as i32,
            );
            if last == Some(key) {
                continue;
            }
            last = Some(key);
            let Some(monitor) = monitor_containing_pt(
                &monitors,
                frame.x + frame.w / 2.0,
                frame.y + frame.h / 2.0,
            ) else {
                continue;
            };
            let (x, y, w, h) =
                compute_companion_rect(frame, width_pt, top_offset, height_override, gap, &monitor);
            state.docked.store(true, Ordering::SeqCst);
            let h2 = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                if let Some(win) = h2.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        // 逻辑坐标：跨缩放不同的屏幕也能正确落位
                        let _ = win.set_size(LogicalSize::new(w, h));
                        let _ = win.set_position(LogicalPosition::new(x, y));
                    }
                }
            });
        }
    });
}

fn stop_companion_tracker(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.companion_gen.fetch_add(1, Ordering::SeqCst);
    }
}

/// 面板可见时用户切换到伴随应用 → 动态重吸附（面板失焦回调触发；主线程）。
/// 解决「先在别处呼出、再切到终端却不跟随」的问题（Pin 场景尤其明显）。
pub fn maybe_redock(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let me = std::process::id() as i32;
    let Some(front) = focus::frontmost_info().filter(|f| f.pid != me) else {
        return;
    };
    // 靠右边栏模式：不吸附目标，但跟随「当前使用的屏幕」——
    // 前台窗口换屏时把边栏挪到新屏右缘（多屏工作流）
    if state.right_sidebar.load(Ordering::SeqCst) {
        let Some(frame) = ax::focused_window_frame(front.pid) else {
            return;
        };
        let monitors = snapshot_monitors_pt(app);
        let Some(m) = monitor_containing_pt(
            &monitors,
            frame.x + frame.w / 2.0,
            frame.y + frame.h / 2.0,
        ) else {
            return;
        };
        let panel_w = *state.panel_width_pt.lock().unwrap();
        let gap = *state.companion_gap.lock().unwrap();
        let height = (m.wa_h - 2.0 * gap).max(200.0);
        let _ = window.set_size(LogicalSize::new(panel_w, height));
        let _ = window.set_position(LogicalPosition::new(
            m.wa_x + m.wa_w - panel_w - gap,
            m.wa_y + gap,
        ));
        return;
    }
    let hit = {
        let cfg = state.companion.lock().unwrap();
        cfg.enabled
            && front
                .bundle_id
                .as_deref()
                .map(|b| cfg.apps.iter().any(|a| a == b))
                .unwrap_or(false)
    };
    if !hit {
        return;
    }
    let Some(frame) = ax::focused_window_frame(front.pid) else {
        return;
    };
    let monitors = snapshot_monitors_pt(app);
    let Some(monitor) = monitor_containing_pt(
        &monitors,
        frame.x + frame.w / 2.0,
        frame.y + frame.h / 2.0,
    ) else {
        return;
    };
    let panel_w = *state.panel_width_pt.lock().unwrap();
    let top_offset = *state.panel_top_offset.lock().unwrap();
    let height_override = *state.panel_height_pt.lock().unwrap();
    let gap = *state.companion_gap.lock().unwrap();
    let (x, y, w, h) =
        compute_companion_rect(frame, panel_w, top_offset, height_override, gap, &monitor);
    let _ = window.set_size(LogicalSize::new(w, h));
    let _ = window.set_position(LogicalPosition::new(x, y));
    start_companion_tracker(app, front.pid, monitors);
}

/// 上/下缘拖拽调节（增量 delta，逻辑 pt；主线程）。
/// 返回当前 (top_offset, height_override) 供前端持久化。
pub fn adjust_panel_edge(app: &AppHandle, edge: &str, delta: f64) -> (f64, Option<f64>) {
    let state = app.state::<AppState>();
    let read_back = |state: &AppState| {
        (
            *state.panel_top_offset.lock().unwrap(),
            *state.panel_height_pt.lock().unwrap(),
        )
    };
    let Some(window) = app.get_webview_window("main") else {
        return read_back(&state);
    };
    let (Ok(scale), Ok(pos), Ok(size)) = (
        window.scale_factor(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return read_back(&state);
    };
    let y = pos.y as f64 / scale;
    let h = size.height as f64 / scale;
    let x = pos.x as f64 / scale;
    let w = size.width as f64 / scale;

    let (new_y, new_h) = match edge {
        "top" => {
            let applied = delta.min(h - PANEL_MIN_HEIGHT); // 不缩到下限以下
            (y + applied, h - applied)
        }
        _ => {
            let new_h = (h + delta).max(PANEL_MIN_HEIGHT);
            (y, new_h)
        }
    };
    let _ = window.set_size(LogicalSize::new(w, new_h));
    let _ = window.set_position(LogicalPosition::new(x, new_y));

    *state.panel_top_offset.lock().unwrap() += new_y - y;
    *state.panel_height_pt.lock().unwrap() = Some(new_h);
    read_back(&state)
}

/// 设置/重置上下调节（启动同步与双击复位用）。可见时立即重排。
pub fn set_panel_vertical(app: &AppHandle, top_offset: f64, height: Option<f64>) {
    let state = app.state::<AppState>();
    *state.panel_top_offset.lock().unwrap() = top_offset;
    *state.panel_height_pt.lock().unwrap() =
        height.map(|h| h.max(PANEL_MIN_HEIGHT));
    let visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if visible {
        // 重新走一次定位（伴随 tracker 也会因 key 变化在下个 tick 对齐）
        request_show_panel(app);
    }
}

// ============ 图片预览窗 ============

/// 自建图片原尺寸预览窗（qlmanage 的 [DEBUG] 窗口带无用调试按钮，观感差）：
/// 按图片尺寸适配光标屏工作区 90% 居中；前端 Esc/点击/失焦即隐藏。任意线程可调。
/// 多图时窗口按起始张定尺寸，其余图在窗内等比适配。
pub fn preview_image(app: &AppHandle, files: Vec<String>, index: usize) {
    let index = if files.get(index).is_some() { index } else { 0 };
    let Some(anchor) = files.get(index) else {
        return;
    };
    let dims = crate::storage::image_path(app, anchor)
        .and_then(|p| image::image_dimensions(&p).ok());
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = preview_image_on_main(&handle, files, index, dims) {
            eprintln!("[toskr] 图片预览失败: {e}");
        }
    });
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewPayload {
    files: Vec<String>,
    index: usize,
}

fn preview_image_on_main(
    app: &AppHandle,
    files: Vec<String>,
    index: usize,
    dims: Option<(u32, u32)>,
) -> tauri::Result<()> {
    let window = app
        .get_webview_window("imgpreview")
        .ok_or(tauri::Error::WindowNotFound)?;
    // 在「面板所在屏幕」弹出（预览由面板上的点击触发，注意力在该屏）；
    // 拿不到面板位置时回退光标所在屏
    let monitors = snapshot_monitors_pt(app);
    let panel_anchor = app.get_webview_window("main").and_then(|w| {
        let pos = w.outer_position().ok()?;
        let scale = w.scale_factor().ok()?.max(0.5);
        Some((pos.x as f64 / scale + 20.0, pos.y as f64 / scale + 20.0))
    });
    let m = panel_anchor.and_then(|(x, y)| monitor_containing_pt(&monitors, x, y));
    let (wa_x, wa_y, wa_w, wa_h) = match m {
        Some(m) => (m.wa_x, m.wa_y, m.wa_w, m.wa_h),
        None => {
            let (origin, area, scale) = cursor_work_area(app)?;
            (
                origin.x as f64 / scale,
                origin.y as f64 / scale,
                area.width as f64 / scale,
                area.height as f64 / scale,
            )
        }
    };
    let (img_w, img_h) = dims
        .map(|(w, h)| (w as f64, h as f64))
        .unwrap_or((800.0, 600.0));
    // 顶部 32pt 标题栏 + 底部 24pt 尺寸标注条；不放大小图（ratio ≤ 1）
    let max_w = (wa_w * 0.9).max(240.0);
    let max_h = (wa_h * 0.9 - 56.0).max(180.0);
    let ratio = (max_w / img_w).min(max_h / img_h).min(1.0);
    let w = (img_w * ratio).max(280.0);
    let h = img_h * ratio + 56.0;
    let x = wa_x + (wa_w - w) / 2.0;
    let y = wa_y + (wa_h - h) / 2.0;
    let _ = app.emit_to(
        "imgpreview",
        "toskr://preview-image",
        PreviewPayload { files, index },
    );
    window.set_size(LogicalSize::new(w, h))?;
    window.set_position(LogicalPosition::new(x, y))?;
    ensure_fullscreen_auxiliary(&window);
    window.show()?;
    window.set_focus()?;
    Ok(())
}

// ============ HUD ============

/// 展示 HUD（kind: added/duplicate/warn/undone/sent/ok/info/due）。隐身模式下静默。
/// `sticky` 为粘性气泡（任务到期提醒）：不自动隐藏，仅点击可关闭。
/// 可从任意线程调用。
pub fn show_hud(
    app: &AppHandle,
    kind: &str,
    text: String,
    undoable: bool,
    sticky: bool,
    target_id: Option<String>,
) {
    let state = app.state::<AppState>();
    // 隐身模式吞掉常规气泡，但 warn（发送失败等）必须让用户看见
    if state.stealth.load(Ordering::SeqCst) && kind != "warn" {
        return;
    }
    let count = {
        let mut hud = state.hud.lock().unwrap();
        if kind == "added" && hud.visible {
            hud.streak += 1;
        } else {
            hud.streak = 1;
        }
        hud.streak
    };
    let payload = HudPayload {
        kind: kind.to_string(),
        text,
        count,
        undoable,
        sticky,
        target_id,
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = show_hud_on_main(&handle, payload) {
            eprintln!("[toskr] HUD 显示失败: {e}");
        }
    });
}

fn show_hud_on_main(app: &AppHandle, payload: HudPayload) -> tauri::Result<()> {
    // bool 是 Copy：先取出，随后 emit_to 整体 move payload 不受影响
    let sticky = payload.sticky;
    let window = app
        .get_webview_window("hud")
        .ok_or(tauri::Error::WindowNotFound)?;
    let (origin, area, scale) = cursor_work_area(app)?;
    let wa_x = origin.x as f64 / scale;
    let wa_y = origin.y as f64 / scale;
    let wa_w = area.width as f64 / scale;
    let x = wa_x + wa_w - HUD_WIDTH - MARGIN;
    let y = wa_y + MARGIN;

    let _ = app.emit_to("hud", HUD_EVENT, payload);
    window.set_size(LogicalSize::new(HUD_WIDTH, HUD_HEIGHT))?;
    window.set_position(LogicalPosition::new(x, y))?;
    let _ = window.set_ignore_cursor_events(true);
    ensure_fullscreen_auxiliary(&window);
    order_front_without_focus(&window);

    let state = app.state::<AppState>();
    {
        let mut hud = state.hud.lock().unwrap();
        hud.visible = true;
        hud.hovered = false;
        hud.rect_pt = (x, y, HUD_WIDTH, HUD_HEIGHT);
    }
    let generation = state.hud_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || hud_lifecycle(handle, generation, sticky));
    Ok(())
}

/// HUD 生命周期：光标 hover 检测（穿透窗口收不到鼠标事件，只能全局轮询）
/// + 无悬停超时隐藏。悬停时暂停倒计时并关闭点击穿透以启用「撤销」按钮。
/// `sticky` 时跳过超时隐藏——到期提醒必须由用户点击关闭。
fn hud_lifecycle(app: AppHandle, generation: u64, sticky: bool) {
    let mut elapsed: u64 = 0;
    const TICK: u64 = 100;
    loop {
        std::thread::sleep(Duration::from_millis(TICK));
        let state = app.state::<AppState>();
        if state.hud_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let rect = state.hud.lock().unwrap().rect_pt;
        let inside = cursor_point_pt()
            .map(|(cx, cy)| {
                cx >= rect.0 && cx <= rect.0 + rect.2 && cy >= rect.1 && cy <= rect.1 + rect.3
            })
            .unwrap_or(false);

        let changed = {
            let mut hud = state.hud.lock().unwrap();
            let changed = hud.hovered != inside;
            hud.hovered = inside;
            changed
        };
        if changed {
            let h2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(w) = h2.get_webview_window("hud") {
                    let _ = w.set_ignore_cursor_events(!inside);
                }
            });
            let _ = app.emit_to("hud", HUD_HOVER_EVENT, HudHoverPayload { hovered: inside });
        }

        if inside {
            elapsed = 0;
        } else if !sticky {
            elapsed += TICK;
            if elapsed >= HUD_DURATION_MS {
                {
                    let mut hud = state.hud.lock().unwrap();
                    hud.visible = false;
                    hud.hovered = false;
                }
                let h2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(w) = h2.get_webview_window("hud") {
                        let _ = w.hide();
                        let _ = w.set_ignore_cursor_events(true);
                    }
                });
                return;
            }
        }
    }
}

/// 立即隐藏 HUD（点击气泡打开面板后收起提示）。任意线程可调。
pub fn hide_hud_now(app: &AppHandle) {
    let state = app.state::<AppState>();
    {
        let mut hud = state.hud.lock().unwrap();
        hud.visible = false;
        hud.hovered = false;
        hud.streak = 0;
    }
    // bump 代数：停掉正在跑的生命周期轮询
    state.hud_generation.fetch_add(1, Ordering::SeqCst);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("hud") {
            let _ = w.hide();
            let _ = w.set_ignore_cursor_events(true);
        }
    });
}

/// 全局光标位置（顶左原点逻辑 pt）。CGEvent 快照，线程安全、无需权限。
fn cursor_point_pt() -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
    let event = CGEvent::new(source).ok()?;
    let p = event.location();
    Some((p.x, p.y))
}

// ============ 窗口底层工具 ============

/// 显示窗口但不成为 key window / 不激活应用（仅限主线程调用）。
/// tao 的 set_visible 走 makeKeyAndOrderFront，会抢键盘焦点。
fn order_front_without_focus(window: &tauri::WebviewWindow) {
    if let Ok(ptr) = window.ns_window() {
        unsafe {
            let ns_window: &objc2_app_kit::NSWindow = &*(ptr as *const objc2_app_kit::NSWindow);
            ns_window.orderFront(None);
        }
    }
}

/// 独立模式下记录用户手动拖动后的位置（逻辑 pt）。
pub fn remember_free_pos(app: &AppHandle, x: f64, y: f64) {
    *app.state::<AppState>().panel_free_pos.lock().unwrap() = Some((x, y));
}

/// 设置/清除独立模式手动位置（启动同步与「回到右缘」用）。
pub fn set_free_pos(app: &AppHandle, pos: Option<(f64, f64)>) {
    *app.state::<AppState>().panel_free_pos.lock().unwrap() = pos;
}

/// 当前是否处于吸附状态。
pub fn is_docked(app: &AppHandle) -> bool {
    app.state::<AppState>().docked.load(Ordering::SeqCst)
}

/// 设置窗口整体不透明度（含毛玻璃层，真正的「看穿」效果）。
pub fn set_window_alpha(app: &AppHandle, alpha: f64) {
    let alpha = alpha.clamp(0.3, 1.0);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            if let Ok(ptr) = window.ns_window() {
                unsafe {
                    let ns_window: &objc2_app_kit::NSWindow =
                        &*(ptr as *const objc2_app_kit::NSWindow);
                    ns_window.setAlphaValue(alpha);
                }
            }
        }
    });
}

/// 让窗口可出现在全屏 App 的 Space 上（开发者全屏跑 IDE/终端的主场景）。
pub fn ensure_fullscreen_auxiliary(window: &tauri::WebviewWindow) {
    use objc2_app_kit::NSWindowCollectionBehavior;
    if let Ok(ptr) = window.ns_window() {
        unsafe {
            let ns_window: &objc2_app_kit::NSWindow = &*(ptr as *const objc2_app_kit::NSWindow);
            let behavior = ns_window.collectionBehavior()
                | NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary;
            ns_window.setCollectionBehavior(behavior);
        }
    }
}

/// 把窗口居中到光标所在屏（逻辑 pt）。仅限主线程调用。
pub fn center_on_cursor_screen(app: &AppHandle, window: &tauri::WebviewWindow) {
    let monitors = snapshot_monitors_pt(app);
    let Some(m) = cursor_point_pt().and_then(|(cx, cy)| monitor_containing_pt(&monitors, cx, cy))
    else {
        return;
    };
    let (w, h) = window
        .outer_size()
        .ok()
        .zip(window.scale_factor().ok())
        .map(|(s, sc)| (s.width as f64 / sc.max(0.5), s.height as f64 / sc.max(0.5)))
        .unwrap_or((680.0, 560.0));
    let x = m.wa_x + (m.wa_w - w) / 2.0;
    let y = m.wa_y + (m.wa_h - h) / 2.0;
    let _ = window.set_position(LogicalPosition::new(x, y));
}

/// 光标所在显示器的工作区（物理原点、物理尺寸、缩放）。仅限主线程调用。
/// 屏幕匹配走逻辑 pt：tao 物理坐标在不同缩放的多屏下包含测试会失败，
/// 曾导致副屏操作静默回退主屏（靠右边栏/设置窗弹错屏的根因）。
fn cursor_work_area(
    app: &AppHandle,
) -> tauri::Result<(PhysicalPosition<i32>, PhysicalSize<u32>, f64)> {
    let cursor_pt = cursor_point_pt();
    let monitors = app.available_monitors()?;
    let monitor = cursor_pt
        .and_then(|(cx, cy)| {
            monitors.into_iter().find(|m| {
                let scale = m.scale_factor().max(0.5);
                let wa = m.work_area();
                let x = wa.position.x as f64 / scale;
                let y = wa.position.y as f64 / scale;
                let w = wa.size.width as f64 / scale;
                let h = wa.size.height as f64 / scale;
                cx >= x - MARGIN
                    && cx < x + w + MARGIN
                    && cy >= y - MARGIN * 4.0
                    && cy < y + h + MARGIN
            })
        })
        .or(app.primary_monitor()?)
        .ok_or(tauri::Error::WindowNotFound)?;

    let area = monitor.work_area();
    Ok((area.position, area.size, monitor.scale_factor()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MON: MonitorPt = MonitorPt {
        wa_x: 0.0,
        wa_y: 25.0,
        wa_w: 1512.0,
        wa_h: 950.0,
    };

    fn frame(x: f64, y: f64, w: f64, h: f64) -> AxWindowFrame {
        AxWindowFrame { x, y, w, h }
    }

    #[test]
    fn companion_docks_to_right_edge_same_height() {
        let (x, y, w, h) =
            compute_companion_rect(frame(100.0, 100.0, 800.0, 600.0), 380.0, 0.0, None, 8.0, &MON);
        // 900 = 目标右缘，+8 间隙
        assert_eq!((x, y, w, h), (908.0, 100.0, 380.0, 600.0));
    }

    #[test]
    fn companion_clamps_inside_screen_when_overflowing() {
        // 目标窗口右缘 + 面板宽超出屏幕 → 左收钳制
        let (x, ..) =
            compute_companion_rect(frame(1000.0, 100.0, 500.0, 600.0), 380.0, 0.0, None, 8.0, &MON);
        assert_eq!(x, 1512.0 - 380.0 - MARGIN);
    }

    #[test]
    fn companion_enforces_min_height_and_workarea_y() {
        let (_, y, _, h) =
            compute_companion_rect(frame(100.0, 0.0, 800.0, 200.0), 380.0, 0.0, None, 8.0, &MON);
        assert_eq!(h, 400.0);
        assert_eq!(y, 25.0); // 钳回工作区顶部
    }

    #[test]
    fn companion_height_capped_to_workarea() {
        let (_, y, _, h) =
            compute_companion_rect(frame(0.0, 0.0, 800.0, 2000.0), 380.0, 0.0, None, 8.0, &MON);
        assert_eq!(h, 950.0);
        assert_eq!(y, 25.0);
    }

    #[test]
    fn companion_respects_user_vertical_overrides() {
        // 顶偏移 +60、高度覆盖 500：y = frame.y+60，h = 500
        let (x, y, _, h) = compute_companion_rect(
            frame(100.0, 100.0, 800.0, 600.0),
            380.0,
            60.0,
            Some(500.0),
            8.0,
            &MON,
        );
        assert_eq!((x, y, h), (908.0, 160.0, 500.0));
        // 高度覆盖低于下限时抬到 300
        let (_, _, _, h2) = compute_companion_rect(
            frame(100.0, 100.0, 800.0, 600.0),
            380.0,
            0.0,
            Some(100.0),
            8.0,
            &MON,
        );
        assert_eq!(h2, 300.0);
    }
}
