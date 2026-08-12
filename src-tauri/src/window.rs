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
use crate::events::{HudHoverPayload, HudPayload, HUD_EVENT, HUD_EXIT_EVENT, HUD_HOVER_EVENT};
use crate::focus;
use crate::state::{AppState, EdgeHideAnchor};

/// 面板与 HUD 距工作区边缘的逻辑边距（pt）。
const MARGIN: f64 = 12.0;
const HUD_WIDTH: f64 = 264.0;
// 气泡（两行 ≈48 含顶部投影余量）+ 尾巴/间距 6 + logo 36 + 底部投影余量 ≈ 100
const HUD_HEIGHT: f64 = 100.0;
/// HUD 无悬停时的展示时长（ms）。
const HUD_DURATION_MS: u64 = 1600;
/// 伴随模式自动高度的下限（pt）。
const COMPANION_MIN_HEIGHT: f64 = 400.0;
/// 用户手动调节的高度下限（pt）。
const PANEL_MIN_HEIGHT: f64 = 300.0;
/// 可吸附目标窗口的最小尺寸（pt）——过小的对话框/浮窗不作为吸附目标。
const MIN_TARGET_W: f64 = 480.0;
const MIN_TARGET_H: f64 = 300.0;

// ============ 贴边隐藏（Dock 风格） ============

/// 贴边隐藏光标轮询间隔（ms）。30ms：触边唤回的首帧响应 ≤ 一帧半（60Hz），
/// 「顶到边就出来」的即时感来自这里；轮询体只是一次光标快照 + 几次原子读，
/// 30ms 仍然极轻。
const EDGE_HIDE_TICK_MS: u64 = 30;
/// 光标离开面板到触发滑出的宽限期（ms）。
const EDGE_HIDE_GRACE_MS: u64 = 600;
/// 滑出/滑回动画时长（ms，自驱逐帧动画；Dock 的手感约 0.2-0.25s）。
const EDGE_HIDE_SLIDE_MS: u64 = 240;
/// 自驱动画帧间隔（ms）：~120Hz 步进，60Hz 屏上多余帧无害合并。
const EDGE_HIDE_FRAME_MS: u64 = 8;
/// 动画结束后额外多屏蔽 Moved 事件的缓冲（ms）：覆盖主线程派发排队延迟
/// 与动画收尾时可能补发的尾帧 Moved 通知。
const EDGE_HIDE_MOVE_GUARD_BUFFER_MS: i64 = 150;
/// 非动画的程序化定位（停靠/边栏/伴随重定位/改宽度）屏蔽 Moved 的时间窗
/// （ms）：`set_position` 到 Moved 回调只隔一次主线程派发，250ms 足够宽。
const MACHINE_MOVE_GUARD_MS: i64 = 250;
/// 隐藏态残留的可见细条宽度（pt）。
const EDGE_HIDE_PEEK: f64 = 3.0;
/// 手动拖拽入坞判定：面板左/右缘距所在屏物理边界在此距离内（含拖出屏外）
/// 即视为「拖到了屏缘」，吸平并成为贴边隐藏候选（Dock 式入坞）。
const DRAG_DOCK_SNAP_PT: f64 = 24.0;

/// 光标判定「触到该缘物理屏幕边界」的容差（pt，四缘通用）。取值偏宽松：
/// work_area 在部分布局（Dock 靠边等）下可能比物理屏幕边界窄，卡在 1-2pt
/// 会导致光标永远够不到判定线；宽一点换来「更容易唤回」，不影响误触发
/// （隐藏态本就只有靠近该缘、且落在跨轴范围内才会命中）。round 7 从 14pt
/// 放宽到 24pt：副屏探针实测用户「把箭头指到 3pt 细缝上」而非怼死物理
/// 边缘时，箭头热点落在判定线内侧约 20pt（cursor=3628.2 vs 判定线 3648），
/// 14pt 容差差 6pt 判不中；24pt 覆盖这类瞄准误差，真推到物理边界
/// （光标钉在 line-1 处）恒命中。
const EDGE_HIDE_TOUCH_SLOP: f64 = 24.0;

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
    /// 该屏「物理完整边界」（`Monitor::position()+size()`，非 work_area）
    /// 逻辑 pt。贴边隐藏的滑出目标位/触边判定统一用这套边界而非 work_area
    /// ——work_area 在有菜单栏/靠边 Dock 等布局下会比物理屏幕窄，用它做
    /// 判定线可能落在光标物理上永远够不到的地方（round 4 复现：光标停在
    /// 屏幕边缘也永远唤不回面板）。
    pub mon_x: f64,
    pub mon_y: f64,
    pub mon_w: f64,
    pub mon_h: f64,
}

/// 主线程：把所有显示器工作区+物理完整边界换算为逻辑 pt 快照。
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
                mon_x: m.position().x as f64 / scale,
                mon_y: m.position().y as f64 / scale,
                mon_w: m.size().width as f64 / scale,
                mon_h: m.size().height as f64 / scale,
            }
        })
        .collect()
}

/// 边栏停靠矩形（逻辑 pt）：左右=全高竖栏（宽=面板宽），
/// 上下=全宽横栏（Paste 式卡片串，高≈工作区 32%，钳制在 260-420pt）。四周保留 gap。
fn sidebar_rect(edge: u8, m: &MonitorPt, panel_w: f64, gap: f64) -> (f64, f64, f64, f64) {
    match edge {
        1 => (
            m.wa_x + gap,
            m.wa_y + gap,
            panel_w,
            (m.wa_h - 2.0 * gap).max(200.0),
        ),
        2 | 3 => {
            let max_h = (m.wa_h - 2.0 * gap).max(200.0);
            let h = (m.wa_h * 0.32)
                .clamp(260.0_f64.min(max_h), 420.0)
                .min(max_h);
            let w = (m.wa_w - 2.0 * gap).max(320.0);
            let y = if edge == 2 {
                m.wa_y + gap
            } else {
                m.wa_y + m.wa_h - h - gap
            };
            (m.wa_x + gap, y, w, h)
        }
        _ => (
            m.wa_x + m.wa_w - panel_w - gap,
            m.wa_y + gap,
            panel_w,
            (m.wa_h - 2.0 * gap).max(200.0),
        ),
    }
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

/// 窗口布局目标：前台是外部应用时用前台；Toskr 因面板/设置水合占据前台时，
/// 回退到唤出面板前记录的应用。保持为纯函数，避免配置恢复与显示入口各写一套裁决。
fn select_layout_candidate(
    current: Option<(i32, Option<String>)>,
    own_pid: i32,
    previous: Option<(i32, Option<String>)>,
) -> Option<(i32, Option<String>)> {
    match current {
        Some(candidate) if candidate.0 != own_pid => Some(candidate),
        _ => previous.filter(|candidate| candidate.0 != own_pid),
    }
}

/// 严格按物理完整边界判定坐标点所在屏（无兜底——查不到就是 None）。
/// 与 `monitor_containing_pt` 的区别：后者带首屏兜底 + work_area 容差，
/// 适合「总得选一块屏」的定位场景；这里用于「越过这条线还有没有屏」的
/// 桌面边界判定，兜底会让判定恒真，必须严格。
fn monitor_at_strict(monitors: &[MonitorPt], x: f64, y: f64) -> Option<&MonitorPt> {
    monitors
        .iter()
        .find(|m| x >= m.mon_x && x < m.mon_x + m.mon_w && y >= m.mon_y && y < m.mon_y + m.mon_h)
}

/// 手动拖拽入坞判定（纯函数）：面板右缘落在所在屏物理右边界
/// `DRAG_DOCK_SNAP_PT` 内（含拖出屏外），且该缘是**桌面真实边界**（越过去
/// 没有别的屏）→ 返回入坞缘（0=右，与 `EdgeHideAnchor.edge` 同编码）。
/// 接缝（如内建屏右缘紧邻副屏）不入坞：往接缝「滑出」等于把面板滑到邻屏
/// 中央，视觉上根本不算隐藏。仅右缘参与——停靠位置用户指定只保留
/// 靠右/靠下两档（2026-08），下缘是全宽横条布局走边栏菜单，竖窄面板的
/// 拖拽入坞只对右缘有意义。
fn manual_dock_edge(
    monitors: &[MonitorPt],
    m: &MonitorPt,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Option<u8> {
    let cy = y + h / 2.0;
    let right_line = m.mon_x + m.mon_w;
    if x + w >= right_line - DRAG_DOCK_SNAP_PT
        && monitor_at_strict(monitors, right_line + 2.0, cy).is_none()
    {
        return Some(0);
    }
    None
}

/// 只有“用户曾明确放置”的自由位置才允许恢复为贴边锚点；默认出现位置即使
/// 靠近屏缘，也不能冒充一次拖动并自动收起。
fn manual_dock_target(
    monitors: &[MonitorPt],
    user_positioned: bool,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Option<(u8, MonitorPt)> {
    if !user_positioned {
        return None;
    }
    let m = monitor_at_strict(monitors, x + w / 2.0, y + h / 2.0).copied()?;
    manual_dock_edge(monitors, &m, x, y, w, h).map(|edge| (edge, m))
}

/// 伴随停靠矩形（纯函数，逻辑 pt）：贴目标窗口右缘或左缘（`side`：0=右
/// 1=左，与 `sidebar_edge` 同一套编码，用户在停靠菜单里选的 靠左/靠右
/// 方向），默认同高；支持用户上下调节：`top_offset` 相对目标窗口顶的
/// 偏移、`height_override` 高度覆盖。
pub fn compute_companion_rect(
    frame: AxWindowFrame,
    panel_w: f64,
    top_offset: f64,
    height_override: Option<f64>,
    gap: f64,
    monitor: &MonitorPt,
    side: u8,
) -> (f64, f64, f64, f64) {
    let auto_h = frame.h.max(COMPANION_MIN_HEIGHT);
    let h = height_override
        .unwrap_or(auto_h)
        .clamp(PANEL_MIN_HEIGHT, monitor.wa_h);
    let y = (frame.y + top_offset).clamp(
        monitor.wa_y,
        (monitor.wa_y + monitor.wa_h - h).max(monitor.wa_y),
    );
    let x = if side == 1 {
        // 贴左缘：目标窗口左缘 - 间隙 - 面板宽；屏幕左侧放不下时向右收
        let min_x = monitor.wa_x + MARGIN;
        (frame.x - gap - panel_w).max(min_x)
    } else {
        // 贴右缘（默认）：目标窗口右缘 + 间隙；屏幕右侧放不下时向左收（间隙也一并压缩）
        let max_x = monitor.wa_x + monitor.wa_w - panel_w - MARGIN;
        (frame.x + frame.w + gap).min(max_x).max(monitor.wa_x)
    };
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

    // 任何显示面板的入口（双击/快捷键/HUD 点击/托盘…）都视为「取消贴边隐藏」：
    // 抢占正在进行的滑出/滑回动画，确保面板立刻完整可见（键盘唤出优先级最高）。
    cancel_edge_hide(app, &state, "唤出面板");

    // 面板即将抢占焦点，先记录前台应用（下一次发送快照 + 伴随/焦点目标）
    let front = focus::frontmost_info().filter(|f| f.pid != me);
    if let Some(f) = &front {
        crate::target::observe_front(app, f);
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
        if monitors.is_empty() {
            crate::diag::push(app, "贴边: 显示器解析失败");
            return Ok(());
        }
        // 光标屏优先；取不到光标时退面板当前所在屏（monitor_containing_pt 自带首屏兜底）
        let cursor = cursor_point_pt().or_else(|| {
            let pos = window.outer_position().ok()?;
            let scale = window.scale_factor().ok()?.max(0.5);
            Some((pos.x as f64 / scale + 20.0, pos.y as f64 / scale + 20.0))
        });
        let Some(m) = cursor.and_then(|(cx, cy)| monitor_containing_pt(&monitors, cx, cy)) else {
            return Ok(());
        };
        let gap = *state.companion_gap.lock().unwrap();
        let edge = state.sidebar_edge.load(Ordering::SeqCst);
        let (x, y, w, h) = sidebar_rect(edge, &m, panel_w, gap);
        state.docked.store(false, Ordering::SeqCst);
        // 四缘边栏（P1）都是贴边隐藏候选布局
        set_edge_hide_anchor(
            app,
            &state,
            EdgeHideAnchor {
                edge,
                x,
                y,
                w,
                h,
                screen_full_x: m.mon_x,
                screen_full_y: m.mon_y,
                screen_full_w: m.mon_w,
                screen_full_h: m.mon_h,
            },
        );
        let _ = window.set_always_on_top(state.panel_topmost.load(Ordering::SeqCst));
        mark_machine_move(app);
        window.set_size(LogicalSize::new(w, h))?;
        window.set_position(LogicalPosition::new(x, y))?;
        ensure_fullscreen_auxiliary(&window);
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    // 伴随候选：前台应用；前台是自己（托盘等路径）时回退到上一个应用
    let previous = (*state.prev_app_pid.lock().unwrap()).map(|pid| (pid, focus::bundle_of(pid)));
    let candidate = select_layout_candidate(
        front.as_ref().map(|f| (f.pid, f.bundle_id.clone())),
        me,
        previous,
    );

    // 伴随停靠：候选应用需在预设伴随列表内且有有效窗口 frame
    let (companion_enabled, companion_apps, companion_side) = {
        let cfg = state.companion.lock().unwrap();
        (cfg.enabled, cfg.apps.clone(), cfg.side)
    };
    let companion_target = candidate.as_ref().and_then(|(pid, bundle)| {
        let hit = companion_enabled
            && bundle
                .as_deref()
                .map(|b| companion_apps.iter().any(|a| a == b))
                .unwrap_or(false);
        let frame = if hit { dockable_frame(*pid) } else { None };
        // 伴随诊断（stderr，仅命令行启动可见）
        eprintln!("[toskr] companion: candidate={pid}({bundle:?}) in_list={hit} frame={frame:?}");
        frame.map(|frame| (*pid, frame))
    });

    // 统一用逻辑坐标（pt）定位：tao 的 Physical 定位按「窗口当前所在屏」的
    // scale 反算，跨越不同缩放的屏幕时会错位（副屏不跟随的根因）。
    match companion_target {
        Some((pid, frame)) => {
            // 吸附目标变化 → 高度/偏移覆盖重置为自动（与新应用窗口同高）
            reset_overrides_if_target_changed(&state, pid);
            let monitors = snapshot_monitors_pt(app);
            let monitor =
                monitor_containing_pt(&monitors, frame.x + frame.w / 2.0, frame.y + frame.h / 2.0)
                    .ok_or(tauri::Error::WindowNotFound)?;
            let top_offset = *state.panel_top_offset.lock().unwrap();
            let height_override = *state.panel_height_pt.lock().unwrap();
            let gap = *state.companion_gap.lock().unwrap();
            let (x, y, w, h) = compute_companion_rect(
                frame,
                panel_w,
                top_offset,
                height_override,
                gap,
                &monitor,
                companion_side,
            );
            state.docked.store(true, Ordering::SeqCst);
            // 伴随磁吸与贴边隐藏互斥：目标应用接管期间不作贴边隐藏候选
            clear_edge_hide_anchor(app, &state, "伴随磁吸接管");
            // 伴随磁吸：与目标应用同层级（一起被盖/一起浮现），不悬浮全局
            let _ = window.set_always_on_top(false);
            mark_machine_move(app);
            window.set_size(LogicalSize::new(w, h))?;
            window.set_position(LogicalPosition::new(x, y))?;
            ensure_fullscreen_auxiliary(&window);
            window.show()?;
            window.set_focus()?;
            start_companion_tracker(app, pid, monitors);
        }
        None => {
            // 独立模式：自由摆放（桌面/无有效伴随窗口的应用）。
            // 伴随开启时 tracker 仍常驻，但用 -1 作为未绑定种子；只有之后切到
            // 伴随列表内应用才会接管。不能把当前的非白名单应用 PID 当初始目标，
            // 否则 tracker 下一 tick 会绕过列表检查，跨屏吸到不该跟随的窗口。
            if companion_enabled {
                let monitors = snapshot_monitors_pt(app);
                start_companion_tracker(app, -1, monitors);
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
            let _ = window.set_always_on_top(state.panel_topmost.load(Ordering::SeqCst));
            // 独立模式：优先用用户手动拖到的位置（钳制在工作区内）
            let mut free = *state.panel_free_pos.lock().unwrap();
            // 防御性自愈：free_pos 的 x 落在「贴边隐藏隐藏位」附近 20pt 内，
            // 判定为历史脏数据（曾被贴边隐藏滑出/滑回动画的 Moved 事件污染
            // 误记为「用户手动拖到这里」），当作未设置处理并回写清空——
            // 否则每次显示都会把「非用户拖动」的经典右缘停靠误判成手动位置，
            // 连锁清空贴边隐藏锚点，唤回后再也无法自动隐藏
            if let Some((fx, _)) = free {
                if (fx - (wa_x + wa_w - EDGE_HIDE_PEEK)).abs() <= 20.0 {
                    free = None;
                    *state.panel_free_pos.lock().unwrap() = None;
                    crate::diag::push(app, "贴边隐藏: 清除疑似脏 free_pos");
                }
            }
            let (mut x, y) = match free {
                Some((fx, fy)) => (
                    fx.clamp(wa_x, (wa_x + wa_w - panel_w).max(wa_x)),
                    fy.clamp(wa_y, (wa_y + wa_h - height).max(wa_y)),
                ),
                None => (
                    wa_x + wa_w - panel_w - MARGIN,
                    (wa_y + MARGIN + top_offset).clamp(wa_y, (wa_y + wa_h - height).max(wa_y)),
                ),
            };
            if free.is_some() {
                // 手动位置停在屏幕左右真实边界上 = 拖拽入坞（Dock 式）：吸平
                // 该缘并保持贴边隐藏候选身份，跨开关面板存活——否则「拖走再
                // 拖回屏缘」后自动隐藏永远不再启动（用户实测的缺口）。
                let monitors = snapshot_monitors_pt(app);
                match manual_dock_target(&monitors, true, x, y, panel_w, height) {
                    Some((edge, m)) => {
                        x = m.mon_x + m.mon_w - panel_w;
                        *state.panel_free_pos.lock().unwrap() = Some((x, y));
                        set_edge_hide_anchor(
                            app,
                            &state,
                            EdgeHideAnchor {
                                edge,
                                x,
                                y,
                                w: panel_w,
                                h: height,
                                screen_full_x: m.mon_x,
                                screen_full_y: m.mon_y,
                                screen_full_w: m.mon_w,
                                screen_full_h: m.mon_h,
                            },
                        );
                    }
                    None => clear_edge_hide_anchor(app, &state, "手动拖离屏缘"),
                }
            } else {
                // 首次/未手动放置时仍可默认出现在右侧，但不建立锚点；只有真实
                // 拖动落边后才进入自动收起，避免“刚呼出就自己消失”。
                clear_edge_hide_anchor(app, &state, "默认自由位置");
            }
            mark_machine_move(app);
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
    set_panel_auto_hide_armed(app, true, "面板关闭");
    if let Some(state) = app.try_state::<AppState>() {
        // 显式隐藏（Esc/失焦/开关切换）独立于贴边隐藏态，抢占掉可能正在进行的滑出/滑回动画
        cancel_edge_hide(app, &state, "显式隐藏");
    }
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
        let Ok(scale) = window.scale_factor() else {
            return;
        };
        let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
            return;
        };
        // 同屏操作：物理 → 逻辑后按逻辑坐标写回。默认保持右缘不动；
        // 边栏靠左时锚定左缘（向右生长）
        let state = handle.state::<AppState>();
        let anchor_left = state.right_sidebar.load(Ordering::SeqCst)
            && state.sidebar_edge.load(Ordering::SeqCst) == 1;
        let y_pt = pos.y as f64 / scale;
        let h_pt = size.height as f64 / scale;
        let x_pt = if anchor_left {
            pos.x as f64 / scale
        } else {
            (pos.x as f64 + size.width as f64) / scale - width_pt
        };
        mark_machine_move(&handle);
        let _ = window.set_size(LogicalSize::new(width_pt, h_pt));
        let _ = window.set_position(LogicalPosition::new(x_pt, y_pt));
        // 贴边隐藏候选布局下同步锚点新宽度/x（不存在锚点时是空操作）
        sync_edge_hide_anchor_xy(&state, x_pt, width_pt);
    });
}

// ============ 贴边隐藏（Dock 风格） ============

/// 四缘几何：贴边隐藏锚点按贴靠缘（`edge`：0=右 1=左 2=上 3=下）算出滑出
/// 目标位/触边判定/展开态容差。数据与几何分层——`EdgeHideAnchor` 本身只是
/// 状态（state.rs），这里是 window.rs 唯一负责“怎么算”的地方。
impl EdgeHideAnchor {
    fn edge_label(&self) -> &'static str {
        match self.edge {
            1 => "left",
            2 => "top",
            3 => "bottom",
            _ => "right",
        }
    }

    /// 主轴/跨轴坐标：左右缘沿 x 轴滑动（跨轴 y），上下缘沿 y 轴滑动（跨轴 x）。
    fn axis_coords(&self, cx: f64, cy: f64) -> (f64, f64) {
        match self.edge {
            2 | 3 => (cy, cx),
            _ => (cx, cy),
        }
    }

    /// 触边判定线（沿主轴的物理屏幕边界坐标）与跨轴容许区间
    /// `(start, end)`（面板自身跨轴范围，逻辑 pt）。
    fn line_and_span(&self) -> (f64, (f64, f64)) {
        match self.edge {
            1 => (self.screen_full_x, (self.y, self.y + self.h)),
            2 => (self.screen_full_y, (self.x, self.x + self.w)),
            3 => (
                self.screen_full_y + self.screen_full_h,
                (self.x, self.x + self.w),
            ),
            _ => (
                self.screen_full_x + self.screen_full_w,
                (self.y, self.y + self.h),
            ),
        }
    }

    /// 隐藏态（滑出，仅露出 PEEK px 细条）时窗口左上角坐标（逻辑 pt）。
    fn hidden_origin(&self) -> (f64, f64) {
        match self.edge {
            1 => (self.screen_full_x - (self.w - EDGE_HIDE_PEEK), self.y),
            2 => (self.x, self.screen_full_y - (self.h - EDGE_HIDE_PEEK)),
            3 => (
                self.x,
                self.screen_full_y + self.screen_full_h - EDGE_HIDE_PEEK,
            ),
            _ => (
                self.screen_full_x + self.screen_full_w - EDGE_HIDE_PEEK,
                self.y,
            ),
        }
    }

    /// 唤回触发区的跨轴区间 = **整条物理屏缘**（不是面板自身跨轴范围）。
    /// Dock 对齐：鼠标顶到该屏缘任意位置都该唤回。用面板自身范围会留死区
    /// ——右侧边栏顶部要给菜单栏让出留白，探针实测 cursor=(3648.0,46.8)
    /// 已经压在判定线上，却因 46.8 < 面板顶缘 70 判不中，表现为「鼠标都
    /// 顶到屏幕最右边了还是不出来」。
    fn wake_cross_span(&self) -> (f64, f64) {
        match self.edge {
            2 | 3 => (self.screen_full_x, self.screen_full_x + self.screen_full_w),
            _ => (self.screen_full_y, self.screen_full_y + self.screen_full_h),
        }
    }

    /// 隐藏态下光标是否触到该缘物理屏幕边界（容差 EDGE_HIDE_TOUCH_SLOP）
    /// 且落在该屏缘范围内。主轴两侧都设界：多屏下判定线可能是两屏
    /// 接缝（如面板藏在主屏右缘、副屏在其右侧），越线后光标仍在桌面上
    /// ——若外侧不设界，光标在邻屏任意位置都算「触边」，会陷入
    /// 滑回→离开→滑出→又触边的抖动循环；真物理边界处光标被系统钉在
    /// line 内侧 1pt，恒在带内，不受上界影响。
    fn touching(&self, cx: f64, cy: f64) -> bool {
        let (primary, cross) = self.axis_coords(cx, cy);
        let (line, _) = self.line_and_span();
        let (a, b) = self.wake_cross_span();
        (primary - line).abs() <= EDGE_HIDE_TOUCH_SLOP && cross >= a && cross <= b
    }

    /// 展开态下光标是否仍算「在面板范围内」：主轴外侧（朝屏幕边界方向）
    /// 延伸到物理屏幕边界（含面板与屏幕边缘之间的留白——round 3 修复的
    /// 泛化版：用触边唤回时光标就停在这段留白里，卡在面板自身边界会导致
    /// 唤回后下一 tick 立刻误判「已离开」），内侧维持面板自身范围，
    /// 跨轴维持面板自身范围。
    fn inside(&self, cx: f64, cy: f64) -> bool {
        let (primary, cross) = self.axis_coords(cx, cy);
        let (line, (a, b)) = self.line_and_span();
        let within_primary = match self.edge {
            1 => primary >= line && primary <= self.x + self.w,
            2 => primary >= line && primary <= self.y + self.h,
            3 => primary <= line && primary >= self.y,
            _ => primary <= line && primary >= self.x,
        };
        within_primary && cross >= a && cross <= b
    }
}

/// 写入贴边隐藏锚点并记一条低频「建立」诊断日志——round 4 的「显示器解析
/// 回归」正是因为锚点建立完全没有日志，现网故障排查只能盲猜。
fn set_edge_hide_anchor(app: &AppHandle, state: &AppState, anchor: EdgeHideAnchor) {
    let mut slot = state.edge_hide_anchor.lock().unwrap();
    // 去重：关边栏/重定位时多条命令（set_sidebar_mode / set_panel_free_pos /
    // show_panel）背靠背各自建立一次同值锚点——完全相同则静默覆盖，
    // 「锚点建立」日志只留真实变化（现网曾出现 2ms 内重复两条）
    if let Some(cur) = slot.as_ref() {
        let near = |a: f64, b: f64| (a - b).abs() < 0.5;
        if cur.edge == anchor.edge
            && near(cur.x, anchor.x)
            && near(cur.y, anchor.y)
            && near(cur.w, anchor.w)
            && near(cur.h, anchor.h)
            && near(cur.screen_full_x, anchor.screen_full_x)
            && near(cur.screen_full_y, anchor.screen_full_y)
        {
            *slot = Some(anchor);
            return;
        }
    }
    crate::diag::push(
        app,
        format!(
            "贴边: 锚点建立 edge={} shown=({:.0},{:.0},{:.0},{:.0}) full=({:.0},{:.0},{:.0},{:.0})",
            anchor.edge_label(),
            anchor.x,
            anchor.y,
            anchor.w,
            anchor.h,
            anchor.screen_full_x,
            anchor.screen_full_y,
            anchor.screen_full_w,
            anchor.screen_full_h,
        ),
    );
    *slot = Some(anchor);
}

/// 清空贴边隐藏锚点（伴随磁吸接管 / 独立模式手动拖离 / 显示器解析失败等）。
/// `reason` 仅在锚点确实存在时记一条低频「清除」诊断日志。
fn clear_edge_hide_anchor(app: &AppHandle, state: &AppState, reason: &str) {
    let mut slot = state.edge_hide_anchor.lock().unwrap();
    if slot.is_some() {
        crate::diag::push(app, format!("贴边: 锚点清除({reason})"));
    }
    *slot = None;
}

/// 当前 epoch ms（用于「机器驱动移动」时间窗判定，非计时精度敏感场景）。
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 切换默认贴边收起的单次会话门禁。仅状态变化记日志，避免拖动事件刷屏。
pub fn set_panel_auto_hide_armed(app: &AppHandle, armed: bool, reason: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if state.panel_auto_hide_armed.swap(armed, Ordering::SeqCst) != armed {
        crate::diag::push(
            app,
            format!(
                "贴边: 自动收起{}（{reason}）",
                if armed { "已启用" } else { "已暂停" }
            ),
        );
    }
}

/// 取消贴边隐藏态并抢占飞行中的动画：重新定位面板的入口（唤出面板、
/// 显式隐藏、伴随/边栏跟随重定位）都必须调用，否则会出现「窗口已经被
/// 挪到别处、但 `edge_hidden` 仍停在旧值」的状态-位置脱节（监督线程按
/// 过期状态误判，且下一次 Moved 事件会把当前位置错记成用户拖拽）。
/// 仅在真正从「隐藏」翻到「未隐藏」时记一条低频诊断日志，`reason` 标注
/// 触发源，方便排查设备端「反复滑出却等不到滑回」之类的问题。
fn cancel_edge_hide(app: &AppHandle, state: &AppState, reason: &str) {
    state.edge_hide_gen.fetch_add(1, Ordering::SeqCst);
    // 不能把机器移动时间窗清零：取消往往发生在滑出动画仍在飞行时（显式隐藏/
    // 跟随重定位），归零会让动画的尾帧 Moved 被记成「用户手动拖拽」，把面板
    // 半途的坐标写进 panel_free_pos（实测拿到过 3364 这种中间值）。
    mark_machine_move(app);
    if state.edge_hidden.swap(false, Ordering::SeqCst) {
        crate::diag::push(app, format!("贴边隐藏: 取消（{reason}）"));
    }
}

/// 是否处于「机器驱动移动」期间：贴边隐藏结算态本身（`edge_hidden`）或
/// 程序刚下过定位指令的时间窗内。lib.rs 的 `WindowEvent::Moved` 处理器据此
/// 忽略「记为用户手动拖拽」的副作用——程序自己摆放面板同样会触发 Moved，
/// 不过滤就会把面板自己的停靠位污染进 `panel_free_pos`，下次显示即误判成
/// 「用户已手动拖离右缘」，连锁清空贴边隐藏锚点、功能整体失效。
pub fn is_machine_move(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    state.edge_hidden.load(Ordering::SeqCst)
        || now_ms() < state.machine_move_until_ms.load(Ordering::SeqCst)
}

/// 程序即将下达定位/尺寸指令：开一个短时间窗，期间 Moved 不记为用户拖拽。
/// 任何 `set_position` / `set_size` 之前都要调一次（动画路径有自己的更长
/// 时间窗，见 `animate_edge_slide`）。
fn mark_machine_move(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state
            .machine_move_until_ms
            .store(now_ms() + MACHINE_MOVE_GUARD_MS, Ordering::SeqCst);
    }
}

/// 面板宽度变化时同步锚点 x/宽（仅在锚点已存在时生效，否则空操作）。
fn sync_edge_hide_anchor_xy(state: &AppState, x: f64, w: f64) {
    if let Some(anchor) = state.edge_hide_anchor.lock().unwrap().as_mut() {
        anchor.x = x;
        anchor.w = w;
    }
}

/// 上/下缘拖拽变化时同步锚点 y/高（仅在锚点已存在时生效，否则空操作）。
fn sync_edge_hide_anchor_yh(state: &AppState, y: f64, h: f64) {
    if let Some(anchor) = state.edge_hide_anchor.lock().unwrap().as_mut() {
        anchor.y = y;
        anchor.h = h;
    }
}

/// 滑出/滑回动画：原生 AppKit `NSAnimationContext` + `animator()` 代理
/// setFrameOrigin（180ms，系统默认缓动），取代手搓 `run_on_main_thread`
/// 逐帧步进——16ms 一次的派发抖动在负载下会掉帧，原生动画完全跑在
/// WindowServer/Core Animation 侧，不受这里的线程调度影响。
///
/// 状态是权威源、位置只是观感：`edge_hidden` 在派发动画前就同步翻转
/// （对称于 show_panel_on_main/hide_panel「立即翻状态」的写法），保证
/// 监督线程下一 tick 就能读到目标态、不会对同一次跃迁重复下发指令。
/// 代数（`edge_hide_gen`）只用来丢弃「派发到主线程期间被更晚的指令
/// （显式隐藏/设置关闭/键盘唤出的瞬间落位）抢占」的过期回调——新目标
/// 本身会被 Core Animation 平滑接管旧动画，无需手动打断飞行中的动画。
///
/// 坐标换算：AppKit 全局坐标以主屏左下角为原点、y 轴向上；本文件其余
/// 逻辑全部用 Tauri 的「全局左上角为原点、y 轴向下」逻辑 pt。x 轴两者
/// 方向、原点一致，直接复用；y 轴只需一次翻转：主屏高度 − 顶边 y − 窗口
/// 高 = 目标矩形左下角在 AppKit 坐标下的 y（与 tao/winit 内部换算同源，
/// 换算基准必须用 `NSScreen.screens()[0]`——即主屏——而非窗口当前所在屏，
/// 副屏场景才不会算错）。
fn animate_edge_slide(app: &AppHandle, anchor: EdgeHideAnchor, to_hidden: bool) {
    let state = app.state::<AppState>();
    let (to_x, to_y) = if to_hidden {
        anchor.hidden_origin()
    } else {
        (anchor.x, anchor.y)
    };
    // 唤回重臂锁（round 6）：滑出瞬间光标已经停在触边判定区（典型场景：
    // 失焦触发滑出时，光标本来就停在屏幕边缘）→ 置位，供监督线程的触边
    // 判定门控——必须等光标先离开判定区一次才解除，否则隐藏了又立刻被
    // 自己的光标唤回。对宽限期触发的滑出是无害的空操作：能让「光标离开
    // 面板 600ms」这个宽限期条件成立的光标位置，必然已经不在触边判定区
    // 内（判定区是触边线附近的窄带，落在“仍算 inside”的范围内）。
    if to_hidden {
        if let Some((cx, cy)) = cursor_point_pt() {
            if anchor.touching(cx, cy) && !state.edge_hide_wake_rearm.swap(true, Ordering::SeqCst) {
                crate::diag::push(app, "贴边隐藏: 滑出时光标仍在触边区，唤回需先离开判定区");
            }
        }
    }
    state.edge_hidden.store(to_hidden, Ordering::SeqCst);
    // 原生动画每一帧都会触发 WindowEvent::Moved；开一个「机器驱动移动」
    // 时间窗（动画时长 + 派发/收尾缓冲），期间 lib.rs 忽略「记为用户拖拽」
    state.machine_move_until_ms.store(
        now_ms() + EDGE_HIDE_SLIDE_MS as i64 + EDGE_HIDE_MOVE_GUARD_BUFFER_MS,
        Ordering::SeqCst,
    );
    crate::diag::push(
        app,
        if to_hidden {
            "贴边隐藏: 滑出"
        } else {
            "贴边隐藏: 滑回"
        },
    );
    let my_gen = state.edge_hide_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<AppState>();
        // 派发排队期间被更晚的指令抢占（已经落到别的目标/瞬间显示），放弃。
        // 必须留日志：这条静默 return 会造成「状态说已隐藏、窗口纹丝不动」的
        // 状态-位置脱节，是设备端「日志写了滑出其实没隐藏」的头号嫌疑。
        if state.edge_hide_gen.load(Ordering::SeqCst) != my_gen {
            crate::diag::push(&handle, "贴边动画: 放弃（被更晚的指令抢占）");
            return;
        }
        let Some(win) = handle.get_webview_window("main") else {
            crate::diag::push(&handle, "贴边动画: 放弃（拿不到主窗口）");
            return;
        };
        // 自驱逐帧滑动动画（easeOutCubic，时长 EDGE_HIDE_SLIDE_MS）。
        //
        // 禁止改回 AppKit 动画机器：`animator().setFrameOrigin` 在本应用上被
        // 实测为**完全空操作**（AppKit 对非活跃应用抑制隐式动画，而贴边隐藏
        // 恰恰只在失焦后发生，命中率 100%）——日志照打、窗口纹丝不动，用户
        // 看到的就是「说隐藏了其实没隐藏」。这里只依赖已被实测证明可靠的
        // set_position：位置 = f(经过时间)，帧率抖动只影响顺滑度、不影响终点；
        // 代数变化（被更晚指令抢占）立即停帧，终点由新指令负责。
        let (from_x, from_y) = win
            .outer_position()
            .ok()
            .zip(win.scale_factor().ok())
            .map(|(p, s)| {
                let s = s.max(0.5);
                (p.x as f64 / s, p.y as f64 / s)
            })
            .unwrap_or((to_x, to_y));
        if (from_x - to_x).abs() < 1.0 && (from_y - to_y).abs() < 1.0 {
            let _ = win.set_position(LogicalPosition::new(to_x, to_y));
        } else {
            let h_anim = handle.clone();
            std::thread::spawn(move || {
                let start = std::time::Instant::now();
                loop {
                    let t = (start.elapsed().as_millis() as f64
                        / EDGE_HIDE_SLIDE_MS as f64)
                        .min(1.0);
                    // easeOutQuart：比 cubic 更强的减速尾，落位更「沉」、
                    // 无戛然而止感；起步依旧快，响应不打折
                    let k = 1.0 - (1.0 - t).powi(4);
                    let x = from_x + (to_x - from_x) * k;
                    let y = from_y + (to_y - from_y) * k;
                    let done = t >= 1.0;
                    let h_frame = h_anim.clone();
                    let _ = h_anim.run_on_main_thread(move || {
                        let state = h_frame.state::<AppState>();
                        if state.edge_hide_gen.load(Ordering::SeqCst) != my_gen {
                            return;
                        }
                        if let Some(win) = h_frame.get_webview_window("main") {
                            let _ = win.set_position(LogicalPosition::new(x, y));
                        }
                    });
                    if done {
                        break;
                    }
                    // 抢占检查也在派发外做一次：被取消后立即停帧，不再空转
                    if let Some(state) = h_anim.try_state::<AppState>() {
                        if state.edge_hide_gen.load(Ordering::SeqCst) != my_gen {
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(EDGE_HIDE_FRAME_MS));
                }
            });
        }
        // 落位核验（设备端实测：日志写了滑出、窗口 x 一动没动）。动画是异步的，
        // 等它跑完再读真实位置；仍未到位就强制瞬间落位——「看得见的正确」优先于
        // 「好看的动画」。代数仍匹配才修，避免把更晚指令的落点又拽回旧目标。
        let h2 = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(EDGE_HIDE_SLIDE_MS + 120));
            let h3 = h2.clone();
            let _ = h2.run_on_main_thread(move || {
                let state = h3.state::<AppState>();
                if state.edge_hide_gen.load(Ordering::SeqCst) != my_gen {
                    return;
                }
                let Some(win) = h3.get_webview_window("main") else {
                    return;
                };
                let Some((ax, ay)) = win
                    .outer_position()
                    .ok()
                    .zip(win.scale_factor().ok())
                    .map(|(p, s)| {
                        let s = s.max(0.5);
                        (p.x as f64 / s, p.y as f64 / s)
                    })
                else {
                    return;
                };
                if (ax - to_x).abs() > 2.0 || (ay - to_y).abs() > 2.0 {
                    crate::diag::push(
                        &h3,
                        format!(
                            "贴边动画: 未落位（实际 {ax:.0},{ay:.0} 目标 {to_x:.0},{to_y:.0}）→ 强制落位"
                        ),
                    );
                    mark_machine_move(&h3);
                    let _ = win.set_position(LogicalPosition::new(to_x, to_y));
                }
            });
        });
    });
}

/// 贴边隐藏常驻监督线程：60ms 轮询光标，宽限期后滑出/触边滑回。
/// 启动时装一次即可（generation 抢占保证与其它写位置路径互不打架）。
pub fn spawn_edge_hide_supervisor(app: &AppHandle) {
    let handle = app.clone();
    // 启动即报一次初始态（此刻必为 inactive）：前端刚水合完成时就能拿到
    // 一致的初始快照，不必等第一个 60ms tick。
    let mut last_reported: Option<(bool, bool)> = None;
    report_edge_hide_state(&handle, &mut last_reported, false, false);
    tauri::async_runtime::spawn_blocking(move || {
        let mut away_ms: u64 = 0;
        // round 4 探针限频（epoch ms，0 = 从未打过点）
        let mut last_probe_ms: i64 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(EDGE_HIDE_TICK_MS));
            let state = handle.state::<AppState>();
            if !state.auto_edge_hide.load(Ordering::Relaxed) {
                away_ms = 0;
                report_edge_hide_state(&handle, &mut last_reported, false, false);
                continue;
            }
            let Some(window) = handle.get_webview_window("main") else {
                continue;
            };
            if !window.is_visible().unwrap_or(false) {
                away_ms = 0;
                report_edge_hide_state(&handle, &mut last_reported, false, false);
                continue;
            }
            let Some(anchor) = *state.edge_hide_anchor.lock().unwrap() else {
                away_ms = 0;
                report_edge_hide_state(&handle, &mut last_reported, false, false);
                continue;
            };
            // 伴随磁吸接管：目标应用接管定位，前置条件不再满足，若正贴边隐藏立即滑回。
            // 钉住不在此列（图钉 + 已入坞 = Dock 行为）：
            // 钉住的语义是「失焦不隐藏」，管的是焦点驱动的收起（前端 blur 分支与
            // edge_hide_now 各自为它豁免）；而这里是光标驱动的 Dock 式滑出——
            // 两者正交，钉住只保证「不会因为切走焦点而消失」，不该连鼠标离开
            // 都不许收。
            let active = !state.docked.load(Ordering::SeqCst);
            if !active {
                if state.edge_hidden.load(Ordering::SeqCst) {
                    animate_edge_slide(&handle, anchor, false);
                }
                away_ms = 0;
                report_edge_hide_state(&handle, &mut last_reported, false, false);
                continue;
            }
            // 快捷键/双击呼出保护：锚点仍保留（Esc 可立即沿该缘收起），但
            // 光标离开不计时，失焦入口也会被 edge_hide_now 的同一门禁拦住。
            if !state.panel_auto_hide_armed.load(Ordering::SeqCst) {
                away_ms = 0;
                report_edge_hide_state(
                    &handle,
                    &mut last_reported,
                    true,
                    state.edge_hidden.load(Ordering::SeqCst),
                );
                continue;
            }
            if state.edge_hidden.load(Ordering::SeqCst) {
                // 隐藏态：光标是否触到该缘物理屏幕边界（四缘泛化几何见
                // `impl EdgeHideAnchor`）。用物理完整边界而非 work_area：
                // work_area 在少数布局（Dock 靠边等）下会比物理屏幕窄，判定线
                // 落在光标物理上永远够不到的地方——round 4 复现的「光标停在
                // 屏幕边缘也永远唤不回」正对应这个可能成因。
                let cursor = cursor_point_pt();
                let touching_zone = cursor
                    .map(|(cx, cy)| anchor.touching(cx, cy))
                    .unwrap_or(false);
                // 唤回重臂锁（round 6）：光标一旦离开触边判定区就解除锁——
                // 只在这里清，锁只能靠「先离开一次」解除，不会自己超时失效
                if !touching_zone && state.edge_hide_wake_rearm.swap(false, Ordering::SeqCst) {
                    crate::diag::push(&handle, "贴边隐藏: 已离开触边判定区，重新允许唤回");
                }
                let touching = touching_zone && !state.edge_hide_wake_rearm.load(Ordering::SeqCst);
                // round 4 探针（限频 1/s，永久保留但安静）：光标进入判定线附近
                // 60pt 却仍未命中时把原始数值记下来——代码走查无法 100% 证伪
                // 坐标/单位假设，下次设备复现直接从日志读出 cx/cy 与判定线的
                // 真实偏差，自证或证伪 work_area/coordinate 假说。
                let near = cursor
                    .map(|(cx, cy)| {
                        let (primary, cross) = anchor.axis_coords(cx, cy);
                        let (line, _) = anchor.line_and_span();
                        let (a, b) = anchor.wake_cross_span();
                        (primary - line).abs() <= 60.0 && cross >= a - 60.0 && cross <= b + 60.0
                    })
                    .unwrap_or(false);
                if near && !touching_zone {
                    let now = now_ms();
                    if now - last_probe_ms >= 1000 {
                        last_probe_ms = now;
                        let (cx, cy) = cursor.unwrap_or((f64::NAN, f64::NAN));
                        let (line, _) = anchor.line_and_span();
                        let (a, b) = anchor.wake_cross_span();
                        crate::diag::push(
                            &handle,
                            format!(
                                "贴边探针: cursor=({cx:.1},{cy:.1}) edge={} 判定线={line:.1} 跨轴区间=[{a:.1},{b:.1}] active={active} hidden=true",
                                anchor.edge_label(),
                            ),
                        );
                    }
                }
                if touching {
                    animate_edge_slide(&handle, anchor, false);
                }
                away_ms = 0;
            } else {
                // 展开态：光标是否仍在面板范围内；拖拽宽度/上下缘时暂停计时。
                // 主轴外侧边界故意延伸到物理屏幕边界（见 `inside` 几何注释）：
                // 面板与屏幕边缘之间还留了 MARGIN/gap 的空隙，用触边唤回时
                // 光标就停在这段空隙里——若边界卡在面板自身范围，唤回后下一
                // tick 立刻判定「已离开」，600ms 宽限期重新计时，紧接着又
                // 滑出（round 3 复现的「滑回后 ~1.3s 内再次滑出」正是这个坑）。
                let inside = cursor_point_pt()
                    .map(|(cx, cy)| anchor.inside(cx, cy))
                    .unwrap_or(true); // 拿不到光标时保守当作在内部，不误触发滑出
                if inside || state.panel_dragging.load(Ordering::Relaxed) {
                    away_ms = 0;
                } else {
                    away_ms += EDGE_HIDE_TICK_MS;
                    if away_ms >= EDGE_HIDE_GRACE_MS {
                        animate_edge_slide(&handle, anchor, true);
                        away_ms = 0;
                    }
                }
            }
            // active 分支统一在末尾上报：animate_edge_slide 已同步翻转
            // edge_hidden，这里读到的必是本 tick 的最终值
            report_edge_hide_state(
                &handle,
                &mut last_reported,
                true,
                state.edge_hidden.load(Ordering::SeqCst),
            );
        }
    });
}

/// 增量上报「贴边隐藏」运行态给前端（仅状态变化才发，避免每 60ms 一条事件）。
/// `active`：面板可见 + 已有屏缘锚点 + 非伴随接管；快捷键保护只暂停动作，
/// 不清除锚点。`hidden`：面板当前是否已滑出仅露出细条。
/// 前端据此在 active 时豁免失焦自动隐藏（滑出取代真实 hide），在 hidden
/// 时把快捷键/双击唤出识别为「贴边唤回」而非「开关切换到关闭」。
fn report_edge_hide_state(
    app: &AppHandle,
    last: &mut Option<(bool, bool)>,
    active: bool,
    hidden: bool,
) {
    if *last == Some((active, hidden)) {
        return;
    }
    *last = Some((active, hidden));
    let _ = app.emit_to(
        "main",
        crate::events::EDGE_HIDE_STATE_EVENT,
        crate::events::EdgeHideStatePayload { active, hidden },
    );
}

/// 旧设置兼容入口；当前前端固定开启。关闭时若正处于隐藏态立即滑回。
pub fn set_auto_edge_hide(app: &AppHandle, enabled: bool) {
    let state = app.state::<AppState>();
    state.auto_edge_hide.store(enabled, Ordering::SeqCst);
    if !enabled && state.edge_hidden.load(Ordering::SeqCst) {
        let anchor = *state.edge_hide_anchor.lock().unwrap();
        match anchor {
            Some(anchor) => {
                let handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    animate_edge_slide(&handle, anchor, false);
                });
            }
            None => cancel_edge_hide(app, &state, "设置关闭"),
        }
    }
}

/// 立即贴边滑出。普通调用来自失焦，服从快捷键保护与图钉；`explicit=true`
/// 来自 Esc，解除保护并越过图钉。成功返回 true，前端据此避免再真实 hide。
///
/// 这里比监督线程的宽限期滑出多一条「未钉住」：本入口是**焦点**驱动的，
/// 正对着钉住要豁免的那件事（失焦不隐藏）；监督线程那条是**光标**驱动的
/// Dock 式收起，钉住不该拦。两条路径的门控故意不同，别再合并。
pub fn edge_hide_now(app: &AppHandle, explicit: bool) -> bool {
    let state = app.state::<AppState>();
    if explicit {
        set_panel_auto_hide_armed(app, true, "Esc");
    }
    if !state.auto_edge_hide.load(Ordering::Relaxed) {
        return false;
    }
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    if !window.is_visible().unwrap_or(false) {
        return false;
    }
    let Some(anchor) = *state.edge_hide_anchor.lock().unwrap() else {
        return false;
    };
    let active = (explicit || !state.panel_pinned.load(Ordering::SeqCst))
        && state.panel_auto_hide_armed.load(Ordering::SeqCst)
        && !state.docked.load(Ordering::SeqCst);
    if !active || state.edge_hidden.load(Ordering::SeqCst) {
        return false;
    }
    animate_edge_slide(app, anchor, true);
    if explicit {
        if let Some(pid) = *state.prev_app_pid.lock().unwrap() {
            focus::activate_pid(pid);
        }
    }
    true
}

// ============ 伴随跟随 ============

fn start_companion_tracker(app: &AppHandle, target_pid: i32, monitors: Vec<MonitorPt>) {
    let state = app.state::<AppState>();
    let generation = state.companion_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    let me = std::process::id() as i32;

    tauri::async_runtime::spawn_blocking(move || {
        let mut target = target_pid;
        let mut last: Option<(AxWindowFrame, u32, i32, i32, i32, u8)> = None;
        // 同层级契约的无焦点路径：失焦回调（maybe_redock）只覆盖「面板曾获焦再切走」，
        // 用户不碰面板直接在应用间切换时，压层级/随目标浮现只能靠这里
        let mut last_front: i32 = -1;
        let mut was_docked = false;
        loop {
            std::thread::sleep(Duration::from_millis(60));
            let state = handle.state::<AppState>();
            if state.companion_gen.load(Ordering::SeqCst) != generation {
                return;
            }
            if !state.companion.lock().unwrap().enabled {
                // 配置关闭退出前必须解除接管：docked 是贴边隐藏监督线程与
                // 拖拽入坞共用的一票否决门，留着 true 会把两者一起静默卡死
                // （现场：切磁吸再切回，拖到屏缘零反应、日志零输出）
                state.docked.store(false, Ordering::SeqCst);
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
            let front_pid = match focus::frontmost_info() {
                Some(front) => {
                    if front.pid != me {
                        crate::target::observe_front(&handle, &front);
                    }
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
                            // 高度覆盖随目标切换重置：与新应用窗口同高
                            reset_overrides_if_target_changed(&state, target);
                            last = None;
                        }
                    }
                    front.pid
                }
                None => -1,
            };
            let width_pt = *state.panel_width_pt.lock().unwrap();
            let top_offset = *state.panel_top_offset.lock().unwrap();
            let height_override = *state.panel_height_pt.lock().unwrap();
            let gap = *state.companion_gap.lock().unwrap();
            let side = state.companion.lock().unwrap().side;
            // 目标无有效窗口（桌面/小对话框/已退出）→ 面板原地不动，继续观望
            let Some(frame) = dockable_frame(target) else {
                let released = state.docked.swap(false, Ordering::SeqCst);
                if released {
                    let topmost = state.panel_topmost.load(Ordering::SeqCst);
                    let h2 = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if let Some(win) = h2.get_webview_window("main") {
                            let _ = win.set_always_on_top(topmost);
                        }
                    });
                    crate::diag::push(&handle, "伴随: 目标不可用，恢复自由拖动");
                }
                was_docked = false;
                last = None;
                last_front = front_pid;
                continue;
            };
            // 新建立吸附 → 强制与目标同层级（独立模式唤出时可能带着置顶）；
            // 目标应用刚激活 → 面板一起浮现（不抢焦点）
            let newly_docked = !was_docked;
            was_docked = true;
            // 新建立吸附：伴随磁吸与贴边隐藏互斥，清空锚点并取消隐藏态
            // （目标应用接管，面板即将被重新定位，不能留着过期的隐藏状态）
            if newly_docked {
                clear_edge_hide_anchor(&handle, &state, "伴随接管");
                cancel_edge_hide(&handle, &state, "伴随接管");
            }
            let rise = front_pid == target && last_front != target;
            last_front = front_pid;
            if newly_docked || rise {
                let h2 = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Some(win) = h2.get_webview_window("main") {
                        if !win.is_visible().unwrap_or(false) {
                            return;
                        }
                        if newly_docked {
                            let _ = win.set_always_on_top(false);
                        }
                        if rise {
                            order_front_without_focus(&win);
                        }
                    }
                });
            }
            let key = (
                frame,
                width_pt as u32,
                top_offset as i32,
                height_override.unwrap_or(-1.0) as i32,
                gap as i32,
                side,
            );
            if last == Some(key) {
                continue;
            }
            last = Some(key);
            let Some(monitor) =
                monitor_containing_pt(&monitors, frame.x + frame.w / 2.0, frame.y + frame.h / 2.0)
            else {
                continue;
            };
            let (x, y, w, h) = compute_companion_rect(
                frame,
                width_pt,
                top_offset,
                height_override,
                gap,
                &monitor,
                side,
            );
            state.docked.store(true, Ordering::SeqCst);
            let h2 = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                if let Some(win) = h2.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        // 逻辑坐标：跨缩放不同的屏幕也能正确落位
                        mark_machine_move(&h2);
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

/// 伴随磁吸配置被关闭时的解除接管（命令层调用）：停跟踪器并立即复位
/// `docked`。不能只等跟踪器下个 tick 自检退出——最长 60ms 的窗口里用户的
/// 拖拽落定评估可能已被 `docked=true` 拦掉；而跟踪器根本没在跑时（面板
/// 隐藏期间关磁吸）更是没人复位，`docked` 会一直卡到下次唤出面板为止。
pub fn release_companion_takeover(app: &AppHandle) {
    stop_companion_tracker(app);
    if let Some(state) = app.try_state::<AppState>() {
        if state.docked.swap(false, Ordering::SeqCst) {
            crate::diag::push(app, "伴随: 配置关闭，解除接管（docked 复位）");
        }
    }
}

/// 配置恢复/变更为开启时重新接管已显示面板。不会显示隐藏窗口；`force_tracker`
/// 确保即使矩形恰好没变，也会清理独立模式状态并启动跟踪器。
pub fn refresh_companion_takeover(app: &AppHandle) {
    maybe_redock_inner(app, true);
}

/// 面板可见时用户切换到伴随应用 → 动态重吸附（面板失焦回调触发；主线程）。
/// 解决「先在别处呼出、再切到终端却不跟随」的问题（Pin 场景尤其明显）。
pub fn maybe_redock(app: &AppHandle) {
    maybe_redock_inner(app, false);
}

fn maybe_redock_inner(app: &AppHandle, force_tracker: bool) {
    let state = app.state::<AppState>();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let me = std::process::id() as i32;
    let companion_enabled = state.companion.lock().unwrap().enabled;
    let current = focus::frontmost_info().map(|front| (front.pid, front.bundle_id));
    let previous = (*state.prev_app_pid.lock().unwrap()).map(|pid| (pid, focus::bundle_of(pid)));
    let Some((target_pid, target_bundle_id)) = select_layout_candidate(current, me, previous)
    else {
        // 配置水合时可能还没有外部目标。仍启动观察器，之后目标切到列表内应用
        // 就能首次吸附；否则还得依赖一次偶然的面板 blur 才会开始跟随。
        if force_tracker && companion_enabled && !state.right_sidebar.load(Ordering::SeqCst) {
            start_companion_tracker(app, -1, snapshot_monitors_pt(app));
        }
        return;
    };
    // 靠右边栏模式：不吸附目标，但跟随「当前使用的屏幕」——
    // 前台窗口换屏时把边栏挪到新屏右缘（多屏工作流）
    if state.right_sidebar.load(Ordering::SeqCst) {
        let Some(frame) = ax::focused_window_frame(target_pid) else {
            return;
        };
        let monitors = snapshot_monitors_pt(app);
        if monitors.is_empty() {
            crate::diag::push(app, "贴边: 显示器解析失败");
            return;
        }
        let Some(m) =
            monitor_containing_pt(&monitors, frame.x + frame.w / 2.0, frame.y + frame.h / 2.0)
        else {
            return;
        };
        let panel_w = *state.panel_width_pt.lock().unwrap();
        let gap = *state.companion_gap.lock().unwrap();
        let edge = state.sidebar_edge.load(Ordering::SeqCst);
        let (x, y, w, h) = sidebar_rect(edge, &m, panel_w, gap);
        // 隐藏态下目标矩形与当前锚点一致（同屏/同缘/同宽高）→ 面板本就该在
        // 屏幕外，这只是「前台应用又换了一次焦点」触发的例行跟随，不是真的
        // 需要重新落位：直接跳过，不拽回展开位、不取消隐藏态。否则每次 blur
        // 触发的 refresh_prev_app 都会把刚滑出的窗口拽回来，永远等不到用户
        // 真正摸到屏幕右缘就先被拽回、又在宽限期后重新滑出——round 4 复现的
        // 「滑出 → 取消(跟随重定位) → ~600ms 后再滑出」振荡正是这个成因。
        if state.edge_hidden.load(Ordering::SeqCst) {
            let unchanged = state.edge_hide_anchor.lock().unwrap().is_some_and(|a| {
                a.edge == edge
                    && (a.x - x).abs() < 0.5
                    && (a.y - y).abs() < 0.5
                    && (a.w - w).abs() < 0.5
                    && (a.h - h).abs() < 0.5
            });
            if unchanged {
                return;
            }
        }
        // 四缘边栏（P1）都是贴边隐藏候选布局
        set_edge_hide_anchor(
            app,
            &state,
            EdgeHideAnchor {
                edge,
                x,
                y,
                w,
                h,
                screen_full_x: m.mon_x,
                screen_full_y: m.mon_y,
                screen_full_w: m.mon_w,
                screen_full_h: m.mon_h,
            },
        );
        // 直接把面板挪到「展开态」矩形：必须同步取消隐藏态，否则窗口已经
        // 在展开位置、`edge_hidden` 却还停在 true，监督线程按过期状态继续
        // 检查「触边」而不是「离开」，面板看似卡住、唤不回也收不起
        cancel_edge_hide(app, &state, "跟随重定位(边栏)");
        mark_machine_move(app);
        let _ = window.set_size(LogicalSize::new(w, h));
        let _ = window.set_position(LogicalPosition::new(x, y));
        return;
    }
    let hit = {
        let cfg = state.companion.lock().unwrap();
        cfg.enabled
            && target_bundle_id
                .as_deref()
                .map(|b| cfg.apps.iter().any(|a| a == b))
                .unwrap_or(false)
    };
    if !hit {
        if force_tracker {
            start_companion_tracker(app, -1, snapshot_monitors_pt(app));
        }
        return;
    }
    let Some(frame) = ax::focused_window_frame(target_pid) else {
        return;
    };
    let monitors = snapshot_monitors_pt(app);
    let Some(monitor) =
        monitor_containing_pt(&monitors, frame.x + frame.w / 2.0, frame.y + frame.h / 2.0)
    else {
        return;
    };
    let panel_w = *state.panel_width_pt.lock().unwrap();
    let top_offset = *state.panel_top_offset.lock().unwrap();
    let height_override = *state.panel_height_pt.lock().unwrap();
    let gap = *state.companion_gap.lock().unwrap();
    let side = state.companion.lock().unwrap().side;
    let (x, y, w, h) = compute_companion_rect(
        frame,
        panel_w,
        top_offset,
        height_override,
        gap,
        &monitor,
        side,
    );
    // 目标矩形与窗口当前实际位置/尺寸一致时跳过重定位：同一思路的伴随
    // 版本——每次 blur 触发的 refresh_prev_app 都无差别 set_position/重启
    // tracker 没有意义，伴随模式虽不涉及隐藏态，但同样不该拿「无变化」
    // 当「变化」处理
    let unchanged = window
        .outer_position()
        .ok()
        .zip(window.outer_size().ok())
        .zip(window.scale_factor().ok())
        .is_some_and(|((pos, size), scale)| {
            let scale = scale.max(0.5);
            (pos.x as f64 / scale - x).abs() < 0.5
                && (pos.y as f64 / scale - y).abs() < 0.5
                && (size.width as f64 / scale - w).abs() < 0.5
                && (size.height as f64 / scale - h).abs() < 0.5
        });
    if unchanged && !force_tracker {
        return;
    }
    // 目标激活重吸附：保持同层级并随目标一起浮到前面（不抢焦点）
    state.docked.store(true, Ordering::SeqCst);
    // 伴随磁吸与贴边隐藏互斥；目标应用接管定位，任何过期隐藏态一并取消
    clear_edge_hide_anchor(app, &state, "跟随重定位(伴随)");
    cancel_edge_hide(app, &state, "跟随重定位(伴随)");
    let _ = window.set_always_on_top(false);
    if !unchanged {
        mark_machine_move(app);
        let _ = window.set_size(LogicalSize::new(w, h));
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
    order_front_without_focus(&window);
    start_companion_tracker(app, target_pid, monitors);
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
    mark_machine_move(app);
    let _ = window.set_size(LogicalSize::new(w, new_h));
    let _ = window.set_position(LogicalPosition::new(x, new_y));
    // 贴边隐藏候选布局下同步锚点新 y/h（不存在锚点时是空操作）
    sync_edge_hide_anchor_yh(&state, new_y, new_h);

    *state.panel_top_offset.lock().unwrap() += new_y - y;
    *state.panel_height_pt.lock().unwrap() = Some(new_h);
    read_back(&state)
}

/// 设置/重置上下调节（启动同步与双击复位用）。可见时立即重排。
pub fn set_panel_vertical(app: &AppHandle, top_offset: f64, height: Option<f64>) {
    let state = app.state::<AppState>();
    *state.panel_top_offset.lock().unwrap() = top_offset;
    *state.panel_height_pt.lock().unwrap() = height.map(|h| h.max(PANEL_MIN_HEIGHT));
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
pub fn preview_image(
    app: &AppHandle,
    files: Vec<String>,
    index: usize,
    note_id: Option<String>,
    note_text: Option<String>,
    data_generation: Option<u64>,
    edit: bool,
) {
    let index = if files.get(index).is_some() { index } else { 0 };
    let Some(anchor) = files.get(index) else {
        return;
    };
    let dims =
        crate::storage::image_path(app, anchor).and_then(|p| image::image_dimensions(&p).ok());
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = preview_image_on_main(
            &handle,
            files,
            index,
            dims,
            note_id,
            note_text,
            data_generation,
            edit,
        ) {
            eprintln!("[toskr] 图片预览失败: {e}");
        }
    });
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewPayload {
    files: Vec<String>,
    index: usize,
    /// 所属笔记 id/当前文字（图片卡详情内联编辑备注；None = 无编辑条）。
    note_id: Option<String>,
    note_text: Option<String>,
    data_generation: Option<u64>,
    edit: bool,
}

fn preview_image_on_main(
    app: &AppHandle,
    files: Vec<String>,
    index: usize,
    dims: Option<(u32, u32)>,
    note_id: Option<String>,
    note_text: Option<String>,
    data_generation: Option<u64>,
    edit: bool,
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
    // 顶部 32pt 标题栏 + 底部 24pt 尺寸标注条；带笔记上下文时再留 44pt
    // 备注编辑条；不放大小图（ratio ≤ 1）。
    let chrome = if note_id.is_some() { 100.0 } else { 56.0 };
    let max_w = (wa_w * 0.9).max(240.0);
    let max_h = (wa_h * 0.9 - chrome).max(180.0);
    let ratio = (max_w / img_w).min(max_h / img_h).min(1.0);
    let w = (img_w * ratio).max(280.0);
    let h = img_h * ratio + chrome;
    let x = wa_x + (wa_w - w) / 2.0;
    let y = wa_y + (wa_h - h) / 2.0;
    let _ = app.emit_to(
        "imgpreview",
        "toskr://preview-image",
        PreviewPayload {
            files,
            index,
            note_id,
            note_text,
            data_generation,
            edit,
        },
    );
    window.set_size(LogicalSize::new(w, h))?;
    window.set_position(LogicalPosition::new(x, y))?;
    ensure_fullscreen_auxiliary(&window);
    window.show()?;
    window.set_focus()?;
    Ok(())
}

// ============ 文本详情窗 ============

/// 首次展示标记：窗口隐藏复用，之后保留用户手动调的尺寸、仅重新居中。
static TEXT_PREVIEW_SIZED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 展示文本详情窗：居中于面板所在屏（拿不到面板位置回退光标屏）。
/// 内容由前端另行 emit 到 textpreview 窗口。可从任意线程调用。
pub fn show_text_preview(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = text_preview_on_main(&handle) {
            eprintln!("[toskr] 文本详情窗展示失败: {e}");
        }
    });
}

fn text_preview_on_main(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window("textpreview")
        .ok_or(tauri::Error::WindowNotFound)?;
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
    let (w, h) = if !TEXT_PREVIEW_SIZED.swap(true, Ordering::SeqCst) {
        // 首次：阅读友好的默认尺寸（约半屏宽、七成高，钳制在舒适区间）
        let w = (wa_w * 0.5).clamp(480.0, 640.0).min(wa_w - 24.0);
        let h = (wa_h * 0.7).clamp(400.0, 680.0).min(wa_h - 24.0);
        window.set_size(LogicalSize::new(w, h))?;
        (w, h)
    } else {
        let scale = window.scale_factor().unwrap_or(2.0).max(0.5);
        let size = window.outer_size()?;
        (size.width as f64 / scale, size.height as f64 / scale)
    };
    let x = wa_x + (wa_w - w) / 2.0;
    let y = wa_y + (wa_h - h) / 2.0;
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
fn suppress_hud_in_stealth(stealth: bool, kind: &str) -> bool {
    stealth && kind != "warn"
}

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
    if suppress_hud_in_stealth(state.stealth.load(Ordering::SeqCst), kind) {
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
/// 另每秒做一次位置自愈：睡眠唤醒/显示器增减时系统会挪动 HUD 窗口，
/// 或展示瞬间拿到过渡期屏幕几何——气泡落到屏幕中间，且 hover 判定
/// 用的 rect 与实际位置脱节后穿透永不解除，粘性提醒点不掉。
fn hud_lifecycle(app: AppHandle, generation: u64, sticky: bool) {
    let mut elapsed: u64 = 0;
    let mut heal_ticks: u64 = 0;
    const TICK: u64 = 100;
    loop {
        std::thread::sleep(Duration::from_millis(TICK));
        let state = app.state::<AppState>();
        if state.hud_generation.load(Ordering::SeqCst) != generation {
            return;
        }

        // 位置自愈（主线程）：不在任一屏幕工作区右上锚位 → 按当前光标屏
        // 重算归位（跨缩放屏 Logical 定位可能一次不准，下秒复检收敛）；
        // 在锚位 → 把 rect 同步为实际位置，恢复悬停解锁
        heal_ticks += TICK;
        if heal_ticks >= 1000 {
            heal_ticks = 0;
            let h2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                let Some(w) = h2.get_webview_window("hud") else {
                    return;
                };
                let (pos, scale) = match (w.outer_position(), w.scale_factor()) {
                    (Ok(p), Ok(s)) => (p, s.max(0.5)),
                    _ => return,
                };
                let ax = pos.x as f64 / scale;
                let ay = pos.y as f64 / scale;
                let anchored = snapshot_monitors_pt(&h2).iter().any(|m| {
                    (ax - (m.wa_x + m.wa_w - HUD_WIDTH - MARGIN)).abs() <= 2.0
                        && (ay - (m.wa_y + MARGIN)).abs() <= 2.0
                });
                let st = h2.state::<AppState>();
                if anchored {
                    st.hud.lock().unwrap().rect_pt = (ax, ay, HUD_WIDTH, HUD_HEIGHT);
                } else if let Ok((origin, area, s2)) = cursor_work_area(&h2) {
                    let x = origin.x as f64 / s2 + area.width as f64 / s2 - HUD_WIDTH - MARGIN;
                    let y = origin.y as f64 / s2 + MARGIN;
                    let _ = w.set_position(LogicalPosition::new(x, y));
                    st.hud.lock().unwrap().rect_pt = (x, y, HUD_WIDTH, HUD_HEIGHT);
                }
            });
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
                // 进出场对称：先通知前端播退场动画，稍候再真正隐藏窗口
                //（本函数运行在 spawn_blocking 专属线程，sleep 不阻塞 UI）
                let _ = app.emit_to("hud", HUD_EXIT_EVENT, ());
                std::thread::sleep(Duration::from_millis(160));
                // 退场期间可能有新气泡顶入（代数已变）：放弃隐藏，交给新一轮
                if state.hud_generation.load(Ordering::SeqCst) != generation {
                    return;
                }
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

/// 用户手动拖拽面板（lib.rs Moved 的非机器移动分支）：记住自由位，并立即
/// 退出贴边隐藏候选（清锚）。不清的话拖拽途中监督线程仍按旧锚点判定，
/// 光标一离开旧矩形 600ms 就把面板从用户手里滑走。拖拽落定后由
/// `evaluate_drag_dock`（前端去抖回调）决定是否重新入坞。
pub fn on_user_panel_move(app: &AppHandle, x: f64, y: f64) {
    set_panel_auto_hide_armed(app, true, "用户拖动");
    remember_free_pos(app, x, y);
    if let Some(state) = app.try_state::<AppState>() {
        clear_edge_hide_anchor(app, &state, "拖拽移动");
    }
}

/// 手动拖拽落定评估（前端 400ms 去抖后调用）：面板停在所在屏真实左右
/// 边界 `DRAG_DOCK_SNAP_PT` 内（含拖出屏外）→ 吸平该缘 + 建立贴边隐藏
/// 锚点（Dock 式入坞）；停在别处 → 保持自由摆放（锚点已在拖拽中清掉）。
/// 仅独立自由摆放形态参与：边栏/伴随有各自的布局管理；隐藏态的移动全部
/// 是机器驱动，不会触发本回调。
pub fn evaluate_drag_dock(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<AppState>();
        if !state.auto_edge_hide.load(Ordering::Relaxed)
            || state.right_sidebar.load(Ordering::SeqCst)
            || state.docked.load(Ordering::SeqCst)
            || state.edge_hidden.load(Ordering::SeqCst)
        {
            return;
        }
        let Some(win) = handle.get_webview_window("main") else {
            return;
        };
        if !win.is_visible().unwrap_or(false) {
            return;
        }
        let Some((px, py, pw, ph)) = win
            .outer_position()
            .ok()
            .zip(win.outer_size().ok())
            .zip(win.scale_factor().ok())
            .map(|((p, s), sc)| {
                let sc = sc.max(0.5);
                (
                    p.x as f64 / sc,
                    p.y as f64 / sc,
                    s.width as f64 / sc,
                    s.height as f64 / sc,
                )
            })
        else {
            return;
        };
        let monitors = snapshot_monitors_pt(&handle);
        let cy = py + ph / 2.0;
        // 面板中心可能已被拖出屏外：中心失配时退回左/右缘内侧点解析所在屏
        let target = manual_dock_target(&monitors, true, px, py, pw, ph).or_else(|| {
            // 面板中心可能已被拖出屏外：退回左右内侧点解析所在屏。
            let m = monitor_at_strict(&monitors, px + 2.0, cy)
                .or_else(|| monitor_at_strict(&monitors, px + pw - 2.0, cy))
                .copied()?;
            manual_dock_edge(&monitors, &m, px, py, pw, ph).map(|edge| (edge, m))
        });
        let Some((edge, m)) = target else {
            return;
        };
        let x = m.mon_x + m.mon_w - pw;
        set_edge_hide_anchor(
            &handle,
            &state,
            EdgeHideAnchor {
                edge,
                x,
                y: py,
                w: pw,
                h: ph,
                screen_full_x: m.mon_x,
                screen_full_y: m.mon_y,
                screen_full_w: m.mon_w,
                screen_full_h: m.mon_h,
            },
        );
        if (x - px).abs() > 0.5 {
            *state.panel_free_pos.lock().unwrap() = Some((x, py));
            mark_machine_move(&handle);
            let _ = win.set_position(LogicalPosition::new(x, py));
            // 吸平后的坐标回传前端持久化（机器移动不会再走用户拖拽通道，
            // 不回传的话持久化里留的是吸平前的落点，重启后差一截）
            let _ = handle.emit_to(
                "main",
                "toskr://panel-moved",
                serde_json::json!({ "x": x, "y": py }),
            );
        }
    });
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

    #[test]
    fn stealth_never_suppresses_clipboard_warnings() {
        assert!(!suppress_hud_in_stealth(true, "warn"));
        assert!(suppress_hud_in_stealth(true, "sent"));
        assert!(!suppress_hud_in_stealth(false, "sent"));
    }

    const MON: MonitorPt = MonitorPt {
        wa_x: 0.0,
        wa_y: 25.0,
        wa_w: 1512.0,
        wa_h: 950.0,
        mon_x: 0.0,
        mon_y: 0.0,
        mon_w: 1512.0,
        mon_h: 982.0,
    };

    fn frame(x: f64, y: f64, w: f64, h: f64) -> AxWindowFrame {
        AxWindowFrame { x, y, w, h }
    }

    #[test]
    fn companion_docks_to_right_edge_same_height() {
        let (x, y, w, h) = compute_companion_rect(
            frame(100.0, 100.0, 800.0, 600.0),
            380.0,
            0.0,
            None,
            8.0,
            &MON,
            0,
        );
        // 900 = 目标右缘，+8 间隙
        assert_eq!((x, y, w, h), (908.0, 100.0, 380.0, 600.0));
    }

    #[test]
    fn companion_clamps_inside_screen_when_overflowing() {
        // 目标窗口右缘 + 面板宽超出屏幕 → 左收钳制
        let (x, ..) = compute_companion_rect(
            frame(1000.0, 100.0, 500.0, 600.0),
            380.0,
            0.0,
            None,
            8.0,
            &MON,
            0,
        );
        assert_eq!(x, 1512.0 - 380.0 - MARGIN);
    }

    #[test]
    fn companion_enforces_min_height_and_workarea_y() {
        let (_, y, _, h) = compute_companion_rect(
            frame(100.0, 0.0, 800.0, 200.0),
            380.0,
            0.0,
            None,
            8.0,
            &MON,
            0,
        );
        assert_eq!(h, 400.0);
        assert_eq!(y, 25.0); // 钳回工作区顶部
    }

    #[test]
    fn companion_height_capped_to_workarea() {
        let (_, y, _, h) = compute_companion_rect(
            frame(0.0, 0.0, 800.0, 2000.0),
            380.0,
            0.0,
            None,
            8.0,
            &MON,
            0,
        );
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
            0,
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
            0,
        );
        assert_eq!(h2, 300.0);
    }

    // ===== P2：磁吸方向 =====

    #[test]
    fn companion_docks_to_left_edge_when_side_is_left() {
        let (x, y, w, h) = compute_companion_rect(
            frame(500.0, 100.0, 800.0, 600.0),
            380.0,
            0.0,
            None,
            8.0,
            &MON,
            1,
        );
        // 500 - 8 - 380 = 112：目标左缘 - 间隙 - 面板宽
        assert_eq!((x, y, w, h), (112.0, 100.0, 380.0, 600.0));
    }

    #[test]
    fn companion_left_side_clamps_inside_screen_when_overflowing() {
        // 目标窗口左缘太靠左，贴左缘放不下 → 右收钳制到工作区左缘 + MARGIN
        let (x, ..) = compute_companion_rect(
            frame(50.0, 100.0, 500.0, 600.0),
            380.0,
            0.0,
            None,
            8.0,
            &MON,
            1,
        );
        assert_eq!(x, MARGIN);
    }

    #[test]
    fn companion_refresh_uses_previous_target_while_toskr_is_frontmost() {
        let previous = (42, Some("io.appmakes.otty".to_string()));
        let selected = select_layout_candidate(
            Some((99, Some("cc.ffitch.toskr".to_string()))),
            99,
            Some(previous.clone()),
        );

        assert_eq!(selected, Some(previous));
    }

    #[test]
    fn companion_selects_external_monitor_in_mixed_scale_desktop() {
        let built_in = MonitorPt {
            wa_x: 0.0,
            wa_y: 38.0,
            wa_w: 1728.0,
            wa_h: 1079.0,
            mon_x: 0.0,
            mon_y: 0.0,
            mon_w: 1728.0,
            mon_h: 1117.0,
        };
        let external = MonitorPt {
            wa_x: 1728.0,
            wa_y: 62.0,
            wa_w: 1920.0,
            wa_h: 1055.0,
            mon_x: 1728.0,
            mon_y: 37.0,
            mon_w: 1920.0,
            mon_h: 1080.0,
        };
        let target = frame(1750.0, 81.0, 1450.0, 929.0);
        let monitor = monitor_containing_pt(
            &[built_in, external],
            target.x + target.w / 2.0,
            target.y + target.h / 2.0,
        )
        .expect("副屏目标必须命中副屏");

        let rect = compute_companion_rect(target, 380.0, 0.0, None, 8.0, &monitor, 0);
        assert_eq!(rect, (3208.0, 81.0, 380.0, 929.0));
    }

    // ===== P1：四缘贴边隐藏几何 =====

    fn anchor(edge: u8) -> EdgeHideAnchor {
        // 与 sidebar_rect 对右缘边栏的计算一致：贴 MON 右缘、gap=8
        match edge {
            1 => EdgeHideAnchor {
                edge,
                x: 8.0,
                y: 25.0,
                w: 380.0,
                h: 900.0,
                screen_full_x: MON.mon_x,
                screen_full_y: MON.mon_y,
                screen_full_w: MON.mon_w,
                screen_full_h: MON.mon_h,
            },
            2 => EdgeHideAnchor {
                edge,
                x: 8.0,
                y: 25.0,
                w: 1496.0,
                h: 300.0,
                screen_full_x: MON.mon_x,
                screen_full_y: MON.mon_y,
                screen_full_w: MON.mon_w,
                screen_full_h: MON.mon_h,
            },
            3 => EdgeHideAnchor {
                edge,
                x: 8.0,
                y: 650.0,
                w: 1496.0,
                h: 300.0,
                screen_full_x: MON.mon_x,
                screen_full_y: MON.mon_y,
                screen_full_w: MON.mon_w,
                screen_full_h: MON.mon_h,
            },
            _ => EdgeHideAnchor {
                edge,
                x: 1124.0,
                y: 25.0,
                w: 380.0,
                h: 900.0,
                screen_full_x: MON.mon_x,
                screen_full_y: MON.mon_y,
                screen_full_w: MON.mon_w,
                screen_full_h: MON.mon_h,
            },
        }
    }

    #[test]
    fn hidden_origin_slides_along_each_edges_axis() {
        // 右：贴物理右缘 - PEEK；左：贴物理左缘 + PEEK（窗口右缘）；
        // 上：贴物理上缘 + PEEK（窗口下缘）；下：贴物理下缘 - PEEK（窗口上缘）
        let (x, y) = anchor(0).hidden_origin();
        assert_eq!((x, y), (MON.mon_w - EDGE_HIDE_PEEK, 25.0));
        let (x, y) = anchor(1).hidden_origin();
        assert_eq!((x, y), (MON.mon_x - (380.0 - EDGE_HIDE_PEEK), 25.0));
        let (x, y) = anchor(2).hidden_origin();
        assert_eq!((x, y), (8.0, MON.mon_y - (300.0 - EDGE_HIDE_PEEK)));
        let (x, y) = anchor(3).hidden_origin();
        assert_eq!((x, y), (8.0, MON.mon_h - EDGE_HIDE_PEEK));
    }

    /// 把 (主轴坐标, 跨轴坐标) 按缘映射回屏幕 (cx, cy)：右/左缘主轴是 x，
    /// 上/下缘主轴是 y——与 `EdgeHideAnchor::axis_coords` 互为逆运算。
    fn from_axis_coords(edge: u8, primary: f64, cross: f64) -> (f64, f64) {
        match edge {
            2 | 3 => (cross, primary),
            _ => (primary, cross),
        }
    }

    #[test]
    fn touching_hits_each_edges_physical_line_within_cross_span() {
        for edge in 0u8..4 {
            let a = anchor(edge);
            let (line, (span_a, span_b)) = a.line_and_span();
            let mid = (span_a + span_b) / 2.0;
            let (cx, cy) = from_axis_coords(edge, line, mid);
            assert!(
                a.touching(cx, cy),
                "edge={edge} 应命中触边判定线={line} span=[{span_a},{span_b}]"
            );
            // 从判定线往面板内部退 100pt（左/上缘是 +100，右/下缘是 -100）不应命中
            let inward_primary = match edge {
                1 | 2 => line + 100.0,
                _ => line - 100.0,
            };
            let (ix, iy) = from_axis_coords(edge, inward_primary, mid);
            assert!(!a.touching(ix, iy), "edge={edge} 判定线内侧不应算触边");
        }
    }

    #[test]
    fn touching_tolerates_aiming_at_peek_strip_short_of_line() {
        // round 7 副屏实测：用户把箭头「指向 3pt 细缝」时热点落在判定线
        // 内侧约 20pt（探针 cursor=3628.2 vs 判定线 3648）——容差必须盖住
        for edge in 0u8..4 {
            let a = anchor(edge);
            let (line, (span_a, span_b)) = a.line_and_span();
            let mid = (span_a + span_b) / 2.0;
            let short = match edge {
                1 | 2 => line + 20.0,
                _ => line - 20.0,
            };
            let (cx, cy) = from_axis_coords(edge, short, mid);
            assert!(a.touching(cx, cy), "edge={edge} 判定线内侧 20pt 应在容差内");
        }
    }

    /// 右侧副屏（模拟 DELL：内建屏右邻），y 范围与 MON 重叠。
    const MON_R: MonitorPt = MonitorPt {
        wa_x: 1512.0,
        wa_y: 55.0,
        wa_w: 1920.0,
        wa_h: 1025.0,
        mon_x: 1512.0,
        mon_y: 30.0,
        mon_w: 1920.0,
        mon_h: 1080.0,
    };

    #[test]
    fn drag_dock_only_at_true_right_boundary() {
        let ms = [MON, MON_R];
        let (w, h) = (320.0, 900.0);
        // 副屏右缘：真实桌面边界 → 入坞右（贴近 / 拖出屏外都算）
        let right = MON_R.mon_x + MON_R.mon_w;
        assert_eq!(
            manual_dock_edge(&ms, &MON_R, right - w - 10.0, 100.0, w, h),
            Some(0)
        );
        assert_eq!(
            manual_dock_edge(&ms, &MON_R, right - 200.0, 100.0, w, h),
            Some(0)
        );
        // 内建屏右缘 = 两屏接缝 → 不入坞（滑出去等于滑到副屏中央）
        assert_eq!(
            manual_dock_edge(&ms, &MON, MON.mon_w - w + 5.0, 100.0, w, h),
            None
        );
        // 左缘不参与入坞（位置只保留 靠右/靠下）
        assert_eq!(manual_dock_edge(&ms, &MON, 4.0, 100.0, w, h), None);
        // 屏中间 → 不入坞
        assert_eq!(manual_dock_edge(&ms, &MON, 600.0, 100.0, w, h), None);
        // 单屏时右缘就是真实边界
        assert_eq!(
            manual_dock_edge(&[MON], &MON, MON.mon_w - w - 8.0, 100.0, w, h),
            Some(0)
        );
    }

    #[test]
    fn default_right_side_position_does_not_count_as_user_docking() {
        let x = MON.mon_x + MON.mon_w - 320.0 - MARGIN;
        assert!(
            manual_dock_target(&[MON], false, x, 100.0, 320.0, 700.0).is_none(),
            "默认出现位置不能自动建立贴边锚点"
        );
        assert_eq!(
            manual_dock_target(&[MON], true, x, 100.0, 320.0, 700.0).map(|(edge, _)| edge),
            Some(0),
            "同一位置由用户真实拖到时应入坞"
        );
    }

    #[test]
    fn touching_wakes_anywhere_along_the_physical_screen_edge() {
        // Dock 对齐：鼠标顶到该屏缘任意位置都唤回，不受面板自身跨轴范围限制
        // ——右侧边栏要给菜单栏让出顶部留白，探针实测 cursor=(3648.0,46.8)
        // 压在判定线上却因落在面板顶缘（70）之上判不中
        for edge in 0u8..4 {
            let a = anchor(edge);
            let (line, (panel_a, panel_b)) = a.line_and_span();
            let (wake_a, wake_b) = a.wake_cross_span();
            assert!(
                wake_a < panel_a && wake_b > panel_b,
                "edge={edge} 屏缘应比面板跨轴范围更宽，用例才有意义"
            );
            // 面板跨轴范围之外、仍在屏缘上 → 唤回
            for cross in [wake_a + 1.0, wake_b - 1.0] {
                let (cx, cy) = from_axis_coords(edge, line, cross);
                assert!(
                    a.touching(cx, cy),
                    "edge={edge} 屏缘上 cross={cross} 应唤回"
                );
            }
            // 越出该屏物理边界（屏外/邻屏）→ 不唤回
            for cross in [wake_a - 1.0, wake_b + 1.0] {
                let (cx, cy) = from_axis_coords(edge, line, cross);
                assert!(
                    !a.touching(cx, cy),
                    "edge={edge} 屏外 cross={cross} 不应唤回"
                );
            }
        }
    }

    #[test]
    fn touching_bounded_on_outer_side_across_screen_seam() {
        // 多屏接缝：判定线越过去仍是桌面（邻屏）。外侧超出容差不得算触边，
        // 否则光标在邻屏任意位置都会把面板反复唤回（滑出⇄滑回抖动循环）
        for edge in 0u8..4 {
            let a = anchor(edge);
            let (line, (span_a, span_b)) = a.line_and_span();
            let mid = (span_a + span_b) / 2.0;
            let beyond = match edge {
                1 | 2 => line - EDGE_HIDE_TOUCH_SLOP - 1.0,
                _ => line + EDGE_HIDE_TOUCH_SLOP + 1.0,
            };
            let (cx, cy) = from_axis_coords(edge, beyond, mid);
            assert!(
                !a.touching(cx, cy),
                "edge={edge} 越线超容差（邻屏深处）不应算触边"
            );
        }
    }

    #[test]
    fn inside_extends_to_physical_edge_on_outer_side() {
        // round 3/4 修复的核心断言：刚触边唤回后，光标停在「面板与物理屏幕
        // 边缘之间的空隙」里，inside() 必须仍判定为真，否则唤回后立刻又被
        // 判定为离开、重新计时滑出。
        for edge in 0u8..4 {
            let a = anchor(edge);
            let (line, (span_a, span_b)) = a.line_and_span();
            let mid = (span_a + span_b) / 2.0;
            let (cx, cy) = from_axis_coords(edge, line, mid);
            assert!(a.inside(cx, cy), "edge={edge} 触边线上应仍算 inside");
        }
    }

    #[test]
    fn edge_hide_anchor_full_bounds_differ_from_work_area() {
        // P0 回归的核心前提：锚点的物理完整边界（screen_full_*）必须独立于
        // work_area（MON.wa_y=25 因菜单栏偏移，MON.mon_y=0 是物理原点）——
        // 用「work_area 原点相等」反查这份数据永远不会命中，touching/inside
        // 必须直接用 screen_full_* 而不经过任何跟 work_area 比较的环节。
        let a = anchor(0);
        assert_ne!(a.screen_full_y, 25.0);
        assert_eq!(a.screen_full_y, MON.mon_y);
    }
}
