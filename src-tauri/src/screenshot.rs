//! 区域截图：屏幕录制权限、按屏冻结帧、遮罩窗会话、出图入库。
//!
//! 冻结帧：macOS 14+ 走 ScreenCaptureKit（`screenshot_sck`，排除本应用窗口、BMP 直出）；
//! 13 或 SCK 失败时回退系统 `/usr/sbin/screencapture`（PNG，临时文件读完即删）。
//! 不用 15 SDK 已废弃的 `CGWindowListCreateImage`。选区裁剪与标注合成在前端完成，回传原始 RGBA。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::display::CGDisplay;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::clipwatch::{ClipPayload, CLIP_EVENT};
use crate::focus::FrontApp;
use crate::i18n::pick;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// 遮罩窗 label 前缀：`shot-<屏序号>`。
const LABEL_PREFIX: &str = "shot-";
/// 遮罩窗层级：高于菜单栏（24）与弹出菜单（101），等同屏保层。
const OVERLAY_LEVEL: isize = 1000;
pub const SESSION_EVENT: &str = "toskr://screenshot-session";
pub const END_EVENT: &str = "toskr://screenshot-end";
/// 截完「发送 / 在编辑器中打开」：主窗口先落进剪贴再执行动作。
pub const AFTER_EVENT: &str = "toskr://screenshot-after";
/// 遮罩文字面板请求翻译：转给主窗口用已配置的 AI 处理，结果由主窗口直接回发给遮罩。
pub const TRANSLATE_EVENT: &str = "toskr://screenshot-translate";
const PIN_PREFIX: &str = "pin-";

/// 是否已获屏幕录制授权；`prompt` 时首次会弹系统授权框（授权后需重启应用才生效）。
pub fn access(prompt: bool) -> bool {
    unsafe {
        if CGPreflightScreenCaptureAccess() {
            return true;
        }
        prompt && CGRequestScreenCaptureAccess()
    }
}

/// 顶左原点逻辑 pt 矩形（与 CG 全局坐标、Tauri 逻辑坐标同系）。
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct RectPt {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl RectPt {
    fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && py >= self.y && px < self.x + self.w && py < self.y + self.h
    }

    fn intersects(&self, o: &RectPt) -> bool {
        self.x < o.x + o.w && o.x < self.x + self.w && self.y < o.y + o.h && o.y < self.y + self.h
    }
}

/// 屏上普通窗口（自顶向下排列）。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenWindow {
    pub bounds: RectPt,
    pub pid: i32,
    pub owner: Option<String>,
}

struct Frame {
    bounds: RectPt,
    /// 图片字节（PNG 或 BMP，见 mime），原样交给遮罩窗显示。
    bytes: Vec<u8>,
    mime: &'static str,
    px_w: u32,
    px_h: u32,
}

struct Session {
    id: u64,
    /// 按屏序号；光标所在屏先到，其余屏后台补齐前为 None。
    frames: Vec<Option<Frame>>,
    windows: Vec<ScreenWindow>,
    cursor: Option<(f64, f64)>,
    front: Option<FrontApp>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// 钉图窗 label → (BMP, 原始 pt 尺寸)；窗口关闭即移除。
static PINS: Mutex<Option<HashMap<String, Pin>>> = Mutex::new(None);
static NEXT_PIN: AtomicU64 = AtomicU64::new(1);

struct Pin {
    bmp: Vec<u8>,
    rgba: Vec<u8>,
    px_w: usize,
    px_h: usize,
    pt_w: f64,
    pt_h: f64,
    /// 编辑标注前的原图（多次编辑只留最初那张），右键「还原原图」用
    original: Option<Box<Pin>>,
}

/// 截完后的动作（遮罩工具条按钮）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    /// 复制并存入「剪贴」
    Save,
    /// 钉在屏幕上（不入库）
    Pin,
    /// 存入「剪贴」后发送到当前目标
    Send,
    /// 存入「剪贴」后打开图片编辑器
    Edit,
    /// 另存为 PNG 文件（系统保存对话框）
    SaveAs,
    /// 复制并存入指定笔记分组（长按 ✓ 选分组）
    Section,
}

impl Action {
    pub fn parse(s: &str) -> Self {
        match s {
            "pin" => Self::Pin,
            "send" => Self::Send,
            "edit" => Self::Edit,
            "saveas" => Self::SaveAs,
            "section" => Self::Section,
            _ => Self::Save,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AfterPayload {
    clip: ClipPayload,
    action: &'static str,
    /// action = "section" 时的目标笔记分组。
    section_id: Option<String>,
}

/// 遮罩窗拉取的本屏会话信息；坐标均已换成本屏左上角为原点的 pt。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: u64,
    pub width: f64,
    pub height: f64,
    pub px_w: u32,
    pub px_h: u32,
    pub mime: &'static str,
    pub windows: Vec<RectPt>,
    pub cursor: Option<(f64, f64)>,
}

/// 活动屏（CGGetActiveDisplayList 顺序）的 id 与 pt 矩形。
fn active_displays() -> Vec<(u32, RectPt)> {
    CGDisplay::active_displays()
        .unwrap_or_default()
        .into_iter()
        .map(|id| {
            let b = CGDisplay::new(id).bounds();
            (
                id,
                RectPt {
                    x: b.origin.x,
                    y: b.origin.y,
                    w: b.size.width,
                    h: b.size.height,
                },
            )
        })
        .collect()
}

/// PNG IHDR 里的像素尺寸（字节 16..24，大端）。
fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(png[20..24].try_into().ok()?);
    Some((w, h))
}

/// 冻结第 `index` 块屏（CGGetActiveDisplayList 顺序，即 screencapture -D 的 1 基序号）。
fn capture_display(index: usize, bounds: RectPt) -> Result<Frame, String> {
    let dir = std::env::temp_dir().join(format!("toskr-shot-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("d{index}.png"));
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "png", &format!("-D{}", index + 1)])
        .arg(&path)
        .status()
        .map_err(|e| e.to_string());
    let png = status.and_then(|s| {
        if !s.success() {
            return Err(format!("screencapture exit {s}"));
        }
        std::fs::read(&path).map_err(|e| e.to_string())
    });
    let _ = std::fs::remove_file(&path);
    let bytes = png?;
    let (px_w, px_h) = png_size(&bytes).ok_or("invalid png")?;
    Ok(Frame {
        bounds,
        bytes,
        mime: "image/png",
        px_w,
        px_h,
    })
}

/// SCK 冻结指定各屏（截图自动排除本应用窗口，无需先藏面板）。
fn capture_sck(displays: &[(u32, RectPt)]) -> Result<Vec<Frame>, String> {
    let ids: Vec<u32> = displays.iter().map(|d| d.0).collect();
    let shots = crate::screenshot_sck::capture(&ids)?;
    Ok(shots
        .into_iter()
        .zip(displays)
        .map(|(s, &(_, bounds))| Frame {
            bounds,
            bytes: s.bmp,
            mime: "image/bmp",
            px_w: s.px_w,
            px_h: s.px_h,
        })
        .collect())
}

/// screencapture 各屏并行冻结（回退路径）。
fn capture_all(displays: &[RectPt]) -> Result<Vec<Frame>, String> {
    let handles: Vec<_> = displays
        .iter()
        .copied()
        .enumerate()
        .map(|(i, b)| std::thread::spawn(move || capture_display(i, b)))
        .collect();
    handles
        .into_iter()
        .map(|h| {
            h.join()
                .map_err(|_| "capture thread panicked".to_string())?
        })
        .collect()
}

fn dict_number(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<f64> {
    dict.find(CFString::new(key))
        .and_then(|v| v.downcast::<CFNumber>())
        .and_then(|n| n.to_f64())
}

/// 屏上 layer 0 可见普通窗口，自顶向下。未授权屏幕录制时 owner 可能为空，矩形照常可用。
pub fn list_windows() -> Vec<ScreenWindow> {
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly,
    };
    let Some(arr) = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    ) else {
        return Vec::new();
    };
    let me = std::process::id() as i32;
    let mut out = Vec::new();
    for item in arr.iter() {
        let dict: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
        if dict_number(&dict, "kCGWindowLayer") != Some(0.0)
            || dict_number(&dict, "kCGWindowAlpha").is_some_and(|a| a <= 0.0)
        {
            continue;
        }
        let pid = dict_number(&dict, "kCGWindowOwnerPID").unwrap_or(0.0) as i32;
        if pid == me {
            continue;
        }
        let Some(b) = dict
            .find(CFString::new("kCGWindowBounds"))
            .and_then(|v| v.downcast::<CFDictionary>())
        else {
            continue;
        };
        let b: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(b.as_concrete_TypeRef()) };
        let (Some(x), Some(y), Some(w), Some(h)) = (
            dict_number(&b, "X"),
            dict_number(&b, "Y"),
            dict_number(&b, "Width"),
            dict_number(&b, "Height"),
        ) else {
            continue;
        };
        if w < 8.0 || h < 8.0 {
            continue;
        }
        let owner = dict
            .find(CFString::new("kCGWindowOwnerName"))
            .and_then(|v| v.downcast::<CFString>())
            .map(|s| s.to_string());
        out.push(ScreenWindow {
            bounds: RectPt { x, y, w, h },
            pid,
            owner,
        });
    }
    out
}

/// 与本屏相交的窗口矩形，换成本屏局部坐标（保持自顶向下顺序）。
fn local_windows(display: RectPt, windows: &[ScreenWindow]) -> Vec<RectPt> {
    windows
        .iter()
        .filter(|w| w.bounds.intersects(&display))
        .map(|w| RectPt {
            x: w.bounds.x - display.x,
            y: w.bounds.y - display.y,
            ..w.bounds
        })
        .collect()
}

fn shot_index(label: &str) -> Option<usize> {
    label.strip_prefix(LABEL_PREFIX)?.parse().ok()
}

/// 在主线程执行并等待结果（截图前后的窗口透明度切换必须落定后才能截屏）。
fn on_main_sync<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&AppHandle) -> T + Send + 'static,
) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(&handle));
    })
    .ok()?;
    rx.recv_timeout(std::time::Duration::from_secs(2)).ok()
}

fn ns_window(window: &tauri::WebviewWindow) -> Option<&objc2_app_kit::NSWindow> {
    let ptr = window.ns_window().ok()?;
    Some(unsafe { &*(ptr as *const objc2_app_kit::NSWindow) })
}

/// 截图前把面板与 HUD 透明化，返回原透明度供恢复。
fn hide_own_windows(app: &AppHandle) -> Vec<(String, f64)> {
    on_main_sync(app, |app| {
        ["main", "hud"]
            .iter()
            .filter_map(|label| {
                let w = app.get_webview_window(label)?;
                let ns = ns_window(&w)?;
                let alpha = ns.alphaValue();
                ns.setAlphaValue(0.0);
                Some((label.to_string(), alpha))
            })
            .collect()
    })
    .unwrap_or_default()
}

fn restore_own_windows(app: &AppHandle, saved: Vec<(String, f64)>) {
    let _ = app.run_on_main_thread({
        let app = app.clone();
        move || {
            for (label, alpha) in saved {
                if let Some(ns) = app.get_webview_window(&label).as_ref().and_then(ns_window) {
                    ns.setAlphaValue(alpha);
                }
            }
        }
    });
}

fn create_overlay(app: &AppHandle, label: &str) -> tauri::Result<tauri::WebviewWindow> {
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .title("Toskr Screenshot")
        .visible(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .accept_first_mouse(true)
        .visible_on_all_workspaces(true)
        .build()
}

/// 摆放并显示第 `i` 屏遮罩窗；`focus` 时取得键盘焦点。仅限主线程。
fn show_overlay(app: &AppHandle, i: usize, b: RectPt, session_id: u64, focus: bool) {
    let label = format!("{LABEL_PREFIX}{i}");
    let window = match app.get_webview_window(&label) {
        Some(w) => w,
        None => match create_overlay(app, &label) {
            Ok(w) => w,
            Err(e) => {
                crate::diag::push(app, format!("截图: 遮罩窗创建失败 {e}"));
                return;
            }
        },
    };
    let _ = window.set_position(tauri::LogicalPosition::new(b.x, b.y));
    let _ = window.set_size(tauri::LogicalSize::new(b.w, b.h));
    crate::window::ensure_fullscreen_auxiliary(&window);
    if let Some(ns) = ns_window(&window) {
        ns.setLevel(OVERLAY_LEVEL);
    }
    let _ = window.show();
    if focus {
        let _ = window.set_focus();
    }
    let _ = window.emit_to(&label, SESSION_EVENT, session_id);
}

/// 屏数变少时把多余的旧遮罩藏起来。仅限主线程。
fn hide_extra_overlays(app: &AppHandle, count: usize) {
    for i in count..8 {
        if let Some(w) = app.get_webview_window(&format!("{LABEL_PREFIX}{i}")) {
            let _ = w.hide();
        }
    }
}

fn capture_failed(app: &AppHandle, e: String) {
    crate::diag::push(app, format!("截图失败：{e}"));
    warn(
        app,
        pick(
            "截图失败，详情见诊断日志",
            "Screenshot failed; see the diagnostics log",
        ),
    );
}

/// 截图快捷键入口：冻结各屏 → 显示遮罩窗。会话进行中重复按键忽略。
pub fn on_hotkey(app: &AppHandle) {
    crate::diag::push(app, "截图快捷键触发");
    if SESSION.lock().unwrap().is_some() {
        return;
    }
    if !access(true) {
        crate::diag::push(app, "截图: 未获屏幕录制授权");
        crate::window::show_hud(
            app,
            "warn",
            pick(
                "截图需要「屏幕录制」权限：在系统设置里允许 Toskr 后重启应用",
                "Screenshots need Screen Recording permission: allow Toskr in System Settings, then restart the app",
            )
            .into(),
            false,
            false,
            None,
        );
        return;
    }
    let front = crate::focus::frontmost_info().filter(|f| f.pid != std::process::id() as i32);
    let app = app.clone();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let with_ids = active_displays();
        if with_ids.is_empty() {
            return;
        }
        let displays: Vec<RectPt> = with_ids.iter().map(|d| d.1).collect();
        let windows = list_windows();
        let cursor = crate::window::cursor_point_pt();
        let focus_index = cursor
            .and_then(|(x, y)| displays.iter().position(|d| d.contains(x, y)))
            .unwrap_or(0);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let start_session = |frames: Vec<Option<Frame>>| {
            *SESSION.lock().unwrap() = Some(Session {
                id,
                frames,
                windows: windows.clone(),
                cursor,
                front: front.clone(),
            });
        };

        // 逐屏出遮罩：SCK 先冻结光标所在屏并立即显示，其余屏后台补齐
        let first = if crate::screenshot_sck::supported() {
            capture_sck(&with_ids[focus_index..=focus_index])
        } else {
            Err("macOS < 14".into())
        };
        match first {
            Ok(mut f) => {
                let mut frames: Vec<Option<Frame>> = (0..displays.len()).map(|_| None).collect();
                frames[focus_index] = f.pop();
                start_session(frames);
                crate::diag::push(
                    &app,
                    format!(
                        "截图冻结 光标屏 sck 耗时 {}ms",
                        started.elapsed().as_millis()
                    ),
                );
                let (handle, b, n) = (app.clone(), displays[focus_index], displays.len());
                let _ = app.run_on_main_thread(move || {
                    show_overlay(&handle, focus_index, b, id, true);
                    hide_extra_overlays(&handle, n);
                });
                let rest: Vec<_> = (0..with_ids.len()).filter(|&i| i != focus_index).collect();
                if rest.is_empty() {
                    return;
                }
                let subset: Vec<_> = rest.iter().map(|&i| with_ids[i]).collect();
                match capture_sck(&subset) {
                    Ok(more) => {
                        let mut guard = SESSION.lock().unwrap();
                        // 会话已结束或换了一轮：丢弃迟到的帧
                        let Some(s) = guard.as_mut().filter(|s| s.id == id) else {
                            return;
                        };
                        for (&i, frame) in rest.iter().zip(more) {
                            s.frames[i] = Some(frame);
                        }
                        drop(guard);
                        crate::diag::push(
                            &app,
                            format!(
                                "截图冻结 全部 {} 屏 耗时 {}ms",
                                displays.len(),
                                started.elapsed().as_millis()
                            ),
                        );
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            for &i in &rest {
                                show_overlay(&handle, i, displays[i], id, false);
                            }
                        });
                    }
                    Err(e) => crate::diag::push(&app, format!("截图: 其余屏冻结失败 {e}")),
                }
            }
            Err(e) => {
                crate::diag::push(&app, format!("截图: SCK 不可用，回退 screencapture（{e}）"));
                let saved = hide_own_windows(&app);
                if !saved.is_empty() {
                    // 等透明度落到合成器，避免面板残影进入冻结帧
                    std::thread::sleep(std::time::Duration::from_millis(40));
                }
                let frames = capture_all(&displays);
                restore_own_windows(&app, saved);
                let frames = match frames {
                    Ok(f) => f,
                    Err(e) => return capture_failed(&app, e),
                };
                start_session(frames.into_iter().map(Some).collect());
                crate::diag::push(
                    &app,
                    format!(
                        "截图冻结 {} 屏 screencapture 耗时 {}ms",
                        displays.len(),
                        started.elapsed().as_millis()
                    ),
                );
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    for (i, &b) in displays.iter().enumerate() {
                        show_overlay(&handle, i, b, id, i == focus_index);
                    }
                    hide_extra_overlays(&handle, displays.len());
                });
            }
        }
    });
}

/// 本屏会话信息；无会话或屏序号越界时返回 None。
pub fn session_info(label: &str) -> Option<SessionInfo> {
    let index = shot_index(label)?;
    let guard = SESSION.lock().unwrap();
    let s = guard.as_ref()?;
    let f = s.frames.get(index)?.as_ref()?;
    let cursor = s
        .cursor
        .filter(|&(x, y)| f.bounds.contains(x, y))
        .map(|(x, y)| (x - f.bounds.x, y - f.bounds.y));
    Some(SessionInfo {
        id: s.id,
        width: f.bounds.w,
        height: f.bounds.h,
        px_w: f.px_w,
        px_h: f.px_h,
        mime: f.mime,
        windows: local_windows(f.bounds, &s.windows),
        cursor,
    })
}

/// 光标在本屏的位置（本屏 pt）；不在本屏或无会话为 None。
/// 遮罩刚出现时应用未必已激活，WKWebView 收不到 mousemove，前端靠它轮询跟随。
pub fn cursor_local(label: &str) -> Option<(f64, f64)> {
    let index = shot_index(label)?;
    let bounds = SESSION
        .lock()
        .unwrap()
        .as_ref()?
        .frames
        .get(index)?
        .as_ref()?
        .bounds;
    let (x, y) = crate::window::cursor_point_pt()?;
    bounds.contains(x, y).then(|| (x - bounds.x, y - bounds.y))
}

/// 本屏冻结帧原始字节（PNG 或 BMP）。
pub fn frame_bytes(label: &str, session_id: u64) -> Option<Vec<u8>> {
    let index = shot_index(label)?;
    let guard = SESSION.lock().unwrap();
    let s = guard.as_ref().filter(|s| s.id == session_id)?;
    Some(s.frames.get(index)?.as_ref()?.bytes.clone())
}

/// 结束会话：通知各遮罩窗清空画面，稍后藏窗并把焦点还给截图前的前台应用。
fn end_session(app: &AppHandle, restore_focus: bool) -> Option<Session> {
    let session = SESSION.lock().unwrap().take()?;
    let count = session.frames.len();
    for i in 0..count {
        let _ = app.emit_to(format!("{LABEL_PREFIX}{i}"), END_EVENT, session.id);
    }
    let pid = session
        .front
        .as_ref()
        .map(|f| f.pid)
        .filter(|_| restore_focus);
    let app = app.clone();
    std::thread::spawn(move || {
        // 先让遮罩清空成透明再藏窗：复用窗口下次显示时不会闪出上一次的冻结帧
        std::thread::sleep(std::time::Duration::from_millis(60));
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            for i in 0..count {
                if let Some(w) = handle.get_webview_window(&format!("{LABEL_PREFIX}{i}")) {
                    let _ = w.hide();
                }
            }
            if let Some(pid) = pid {
                crate::focus::activate_pid(pid);
            }
        });
    });
    Some(session)
}

/// screencapture 截全局 pt 区域（13 或 SCK 失败时的长截屏回退）。
fn capture_region_fallback(
    (x, y, w, h): (f64, f64, f64, f64),
) -> Result<(Vec<u8>, usize, usize), String> {
    let dir = std::env::temp_dir().join(format!("toskr-shot-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("long.png");
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "png", &format!("-R{x},{y},{w},{h}")])
        .arg(&path)
        .status()
        .map_err(|e| e.to_string());
    let decoded = status.and_then(|s| {
        if !s.success() {
            return Err(format!("screencapture exit {s}"));
        }
        image::open(&path).map_err(|e| e.to_string())
    });
    let _ = std::fs::remove_file(&path);
    let img = decoded?.to_rgba8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    Ok((img.into_raw(), w, h))
}

/// 长截屏：结束遮罩会话，在选区内自动滚动拼接，结果复制并存入「剪贴」。
/// `x/y/w/h` 为发起遮罩窗所在屏的本屏 pt 选区。
pub fn long(
    app: &AppHandle,
    label: &str,
    (x, y, w, h): (f64, f64, f64, f64),
    manual: bool,
) -> Result<(), String> {
    let bounds = {
        let guard = SESSION.lock().unwrap();
        shot_index(label)
            .and_then(|i| guard.as_ref()?.frames.get(i)?.as_ref().map(|f| f.bounds))
            .ok_or("no screenshot session")?
    };
    let display_id = active_displays()
        .into_iter()
        .find(|(_, b)| *b == bounds)
        .map(|(id, _)| id);
    let session = end_session(app, true).ok_or("no screenshot session")?;
    let app = app.clone();
    std::thread::spawn(move || {
        // 等遮罩藏好、焦点回到原应用，滚轮事件才落到目标窗口
        std::thread::sleep(std::time::Duration::from_millis(300));
        let sck = crate::screenshot_sck::supported() && display_id.is_some();
        let global = (bounds.x + x, bounds.y + y, w, h);
        if sck {
            // SCK 截图排除本应用窗口，提示气泡与预览条不会入画
            crate::screenshot_long::open_preview(
                &app,
                bounds,
                RectPt {
                    x: global.0,
                    y: global.1,
                    w,
                    h,
                },
            );
            crate::window::show_hud(
                &app,
                "info",
                if manual {
                    pick(
                        "手动长截屏：往下滚动，滚完点预览条上的「完成」",
                        "Manual scrolling capture: scroll down, then click Done on the preview strip",
                    )
                } else {
                    pick(
                        "长截屏中…动一下鼠标即可停止",
                        "Scrolling capture… move the mouse to stop",
                    )
                }
                .into(),
                false,
                false,
                None,
            );
        }
        let started = std::time::Instant::now();
        let result = crate::screenshot_long::run(
            global,
            manual,
            || match (sck, display_id) {
                (true, Some(id)) => crate::screenshot_sck::capture_region(id, (x, y, w, h)),
                _ => capture_region_fallback(global),
            },
            |event| {
                if !manual && matches!(event, crate::screenshot_long::Event::Manual) {
                    crate::window::show_hud(
                        &app,
                        "info",
                        pick(
                            "页面没有跟着自动滚动：请手动往下滚，滚完点预览条上的「完成」（停 15 秒自动结束）",
                            "The page didn't scroll by itself: scroll down manually, then click Done on the preview strip (stops after 15 s idle)",
                        )
                        .into(),
                        false,
                        false,
                        None,
                    );
                }
                if sck {
                    crate::screenshot_long::preview_event(&app, event);
                }
            },
        );
        crate::screenshot_long::close_preview(&app);
        match result {
            Ok((rgba, pw, ph, stop)) => {
                crate::diag::push(
                    &app,
                    format!(
                        "长截屏 {pw}×{ph} 结束={stop:?} 耗时 {}ms",
                        started.elapsed().as_millis()
                    ),
                );
                // 拼好后进可滚动的标注窗，在那里完成 / 存入分组 / 另存为
                crate::screenshot_long::open_editor(
                    &app,
                    rgba,
                    pw,
                    ph,
                    pw as f64 / w,
                    session.front,
                    bounds,
                    None,
                );
            }
            Err(e) => {
                crate::diag::push(&app, format!("长截屏失败：{e}"));
                warn(
                    &app,
                    pick(
                        "长截屏失败，详情见诊断日志",
                        "Scrolling capture failed; see the diagnostics log",
                    ),
                );
            }
        }
    });
    Ok(())
}

pub fn cancel(app: &AppHandle) {
    if end_session(app, true).is_some() {
        crate::diag::push(app, "截图已取消");
    }
}

/// 选区在发起窗口所在屏的位置（本屏 pt），钉图定位用。
pub struct Placement {
    pub label: String,
    pub x: f64,
    pub y: f64,
    /// 存入分组（Action::Section）的目标分组 id。
    pub section: Option<String>,
}

fn rgba_to_bmp(w: usize, h: usize, rgba: &[u8]) -> Vec<u8> {
    let mut bgra = rgba.to_vec();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    crate::screenshot_sck::bmp_from_bgra(&bgra, w, h, w * 4)
}

fn warn(app: &AppHandle, text: &str) {
    crate::window::show_hud(app, "warn", text.into(), false, false, None);
}

/// 出图：前端裁剪合成后的 RGBA，按动作分流。默认动作复制并存入「剪贴」（用户 2026-10-31 指定）。
pub fn commit(
    app: &AppHandle,
    action: Action,
    placement: Placement,
    width: usize,
    height: usize,
    rgba: Vec<u8>,
) -> Result<(), String> {
    if width == 0 || height == 0 || rgba.len() != width * height * 4 {
        return Err("invalid image".into());
    }
    // 结束会话前先取本屏几何（钉图要换算 pt 尺寸与全局位置）
    let geometry = {
        let guard = SESSION.lock().unwrap();
        shot_index(&placement.label).and_then(|i| {
            guard
                .as_ref()?
                .frames
                .get(i)?
                .as_ref()
                .map(|f| (f.bounds, f.px_w))
        })
    };
    // 另存为要弹保存对话框：先不还焦点，对话框关闭后再还
    let session = end_session(app, action != Action::SaveAs).ok_or("no screenshot session")?;
    let app = app.clone();
    std::thread::spawn(move || match action {
        Action::Pin => {
            let Some((bounds, px_w)) = geometry else {
                return;
            };
            let scale = px_w as f64 / bounds.w;
            open_pin(
                &app,
                Pin {
                    bmp: rgba_to_bmp(width, height, &rgba),
                    rgba,
                    px_w: width,
                    px_h: height,
                    pt_w: width as f64 / scale,
                    pt_h: height as f64 / scale,
                    original: None,
                },
                bounds.x + placement.x,
                bounds.y + placement.y,
            );
        }
        Action::SaveAs => save_as(&app, width, height, rgba, session.front.as_ref()),
        _ => save(
            &app,
            action,
            placement.section,
            width,
            height,
            &rgba,
            session.front.as_ref(),
        ),
    });
    Ok(())
}

/// 本地时间 (年, 月, 日, 时, 分, 秒)。
fn local_now() -> (i32, u32, u32, u32, u32, u32) {
    let t = unsafe { libc::time(std::ptr::null_mut()) };
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&t, &mut tm) };
    (
        tm.tm_year + 1900,
        tm.tm_mon as u32 + 1,
        tm.tm_mday as u32,
        tm.tm_hour as u32,
        tm.tm_min as u32,
        tm.tm_sec as u32,
    )
}

/// 默认文件名：「Toskr 截图 2026-10-31 14.05.03.png」（与系统截图同样避开冒号）。
fn default_file_name((y, mo, d, h, mi, s): (i32, u32, u32, u32, u32, u32)) -> String {
    format!(
        "{} {y}-{mo:02}-{d:02} {h:02}.{mi:02}.{s:02}.png",
        pick("Toskr 截图", "Toskr Screenshot")
    )
}

pub(crate) fn save_as(
    app: &AppHandle,
    width: usize,
    height: usize,
    rgba: Vec<u8>,
    front: Option<&FrontApp>,
) {
    use tauri_plugin_dialog::DialogExt;
    crate::focus::activate_pid(std::process::id() as i32);
    let mut dialog = app
        .dialog()
        .file()
        .set_file_name(default_file_name(local_now()))
        .add_filter("PNG", &["png"]);
    if let Some(home) = std::env::var_os("HOME") {
        dialog = dialog.set_directory(std::path::Path::new(&home).join("Desktop"));
    }
    let picked = dialog.blocking_save_file().and_then(|p| p.into_path().ok());
    if let Some(pid) = front.map(|f| f.pid) {
        crate::focus::activate_pid(pid);
    }
    let Some(path) = picked else { return };
    let saved = image::RgbaImage::from_raw(width as u32, height as u32, rgba)
        .ok_or_else(|| "invalid image".to_string())
        .and_then(|img| {
            img.save_with_format(&path, image::ImageFormat::Png)
                .map_err(|e| e.to_string())
        });
    match saved {
        Ok(()) => {
            crate::diag::push(app, format!("截图另存为 {width}×{height}"));
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            crate::window::show_hud(
                app,
                "ok",
                crate::tr_fmt!("已保存「{name}」", "Saved “{name}”"),
                false,
                false,
                None,
            );
        }
        Err(e) => {
            crate::diag::push(app, format!("截图另存为失败：{e}"));
            warn(
                app,
                pick(
                    "保存失败，详情见诊断日志",
                    "Save failed; see the diagnostics log",
                ),
            );
        }
    }
}

fn source_of(front: Option<&FrontApp>) -> (Option<String>, Option<String>) {
    front
        .map(|f| (f.name.clone(), f.bundle_id.clone()))
        .unwrap_or((None, None))
}

/// 识别出的一行文字与它在图中的像素框（左上原点）。
#[derive(Debug, PartialEq, Serialize)]
pub struct OcrLine {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Vision 归一化框（左下原点）→ 图像像素框（左上原点）。
fn vision_to_pixels(
    (vx, vy, vw, vh): (f64, f64, f64, f64),
    width: usize,
    height: usize,
) -> (f64, f64, f64, f64) {
    let (w, h) = (width as f64, height as f64);
    (vx * w, (1.0 - vy - vh) * h, vw * w, vh * h)
}

/// 识别选区文字（不结束会话，供遮罩文字面板与图内翻译）。
pub fn recognize(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<OcrLine>, String> {
    if width == 0 || height == 0 || rgba.len() != width * height * 4 {
        return Err("invalid image".into());
    }
    let obs = crate::ocr::recognize_observations(&rgba_to_bmp(width, height, rgba))?;
    Ok(obs
        .into_iter()
        .map(|o| {
            let (x, y, w, h) = vision_to_pixels(o.vision_box, width, height);
            OcrLine {
                text: o.text,
                x,
                y,
                w,
                h,
            }
        })
        .collect())
}

/// 文字面板「存入剪贴」：结束会话，复制并存入「剪贴」。
pub fn save_text(app: &AppHandle, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty text".into());
    }
    let session = end_session(app, true).ok_or("no screenshot session")?;
    if let Some(_permit) = crate::pasteboard::try_claim(app) {
        if let Ok(count) = crate::pasteboard::write_general_text(&text) {
            crate::clipwatch::mark_self_write_count(app, count);
        }
    }
    let n = text.chars().filter(|c| !c.is_whitespace()).count();
    crate::diag::push(app, format!("截图文字存入剪贴 {n} 字"));
    let (app_name, bundle_id) = source_of(session.front.as_ref());
    let _ = app.emit_to(
        "main",
        CLIP_EVENT,
        ClipPayload {
            content_kind: "text".into(),
            text,
            html: None,
            source_url: None,
            captured_at_ms: crate::target::now_ms(),
            image_file: None,
            image_w: None,
            image_h: None,
            app_name,
            bundle_id,
        },
    );
    crate::window::show_hud(
        app,
        "ok",
        crate::tr_fmt!(
            "{n} 字已复制，存入「剪贴」",
            "{n} characters copied and saved to Clipboard"
        ),
        false,
        false,
        None,
    );
    Ok(())
}

pub(crate) fn save(
    app: &AppHandle,
    action: Action,
    section_id: Option<String>,
    width: usize,
    height: usize,
    rgba: &[u8],
    front: Option<&FrontApp>,
) {
    let app = app.clone();
    {
        let file = match crate::storage::save_image_rgba(&app, width, height, rgba) {
            Ok(f) => f,
            Err(e) => {
                crate::diag::push(&app, format!("截图入库失败：{e}"));
                crate::window::show_hud(&app, "warn", e, false, false, None);
                return;
            }
        };
        crate::diag::push(&app, format!("截图入库 {width}×{height} {action:?}"));
        let (w, h) = (width as u32, height as u32);
        let (app_name, bundle_id) = source_of(front);
        let clip = ClipPayload {
            content_kind: "image".into(),
            text: crate::tr_fmt!("截图 {w}×{h}", "Screenshot {w}×{h}"),
            html: None,
            source_url: None,
            captured_at_ms: crate::target::now_ms(),
            image_file: Some(file),
            image_w: Some(w),
            image_h: Some(h),
            app_name,
            bundle_id,
        };
        if action == Action::Section {
            copy_to_clipboard(&app, width, height, rgba);
        }
        if action != Action::Save {
            let name = match action {
                Action::Send => "send",
                Action::Section => "section",
                _ => "edit",
            };
            let _ = app.emit_to(
                "main",
                AFTER_EVENT,
                AfterPayload {
                    clip,
                    action: name,
                    section_id,
                },
            );
            return;
        }
        copy_to_clipboard(&app, width, height, rgba);
        let _ = app.emit_to("main", CLIP_EVENT, clip);
        crate::window::show_hud(
            &app,
            "ok",
            pick(
                "截图已复制，存入「剪贴」",
                "Screenshot copied and saved to Clipboard",
            )
            .into(),
            false,
            false,
            None,
        );
    }
}

// ===== 钉图 =====

/// 钉图小窗：置顶、无边框、可拖动；内容由窗口按 label 拉取。
fn open_pin(app: &AppHandle, pin: Pin, x: f64, y: f64) {
    let label = format!("{PIN_PREFIX}{}", NEXT_PIN.fetch_add(1, Ordering::Relaxed));
    let (w, h) = (pin.pt_w, pin.pt_h);
    PINS.lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(label.clone(), pin);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let built = tauri::WebviewWindowBuilder::new(
            &handle,
            &label,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Toskr Pin")
        .inner_size(w, h)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(true)
        .accept_first_mouse(true)
        .visible_on_all_workspaces(true)
        .build();
        match built {
            Ok(window) => {
                crate::window::ensure_fullscreen_auxiliary(&window);
                let menu_app = handle.clone();
                let menu_label = label.clone();
                window.on_menu_event(move |_, event| {
                    if let Some(w) = menu_app.get_webview_window(&menu_label) {
                        pin_menu_action(&menu_app, &w, event.id().as_ref());
                    }
                });
                // 关窗（含关闭全部）都释放钉图内存
                let closing = label.clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        PINS.lock().unwrap().as_mut().map(|m| m.remove(&closing));
                    }
                });
                let _ = window.set_focus();
                crate::diag::push(&handle, "截图已钉在屏幕上");
            }
            Err(e) => {
                PINS.lock().unwrap().as_mut().map(|m| m.remove(&label));
                crate::diag::push(&handle, format!("钉图窗创建失败 {e}"));
            }
        }
    });
}

/// 钉图窗信息：原始 pt 尺寸。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInfo {
    pub width: f64,
    pub height: f64,
}

pub fn pin_info(label: &str) -> Option<PinInfo> {
    let guard = PINS.lock().unwrap();
    let p = guard.as_ref()?.get(label)?;
    Some(PinInfo {
        width: p.pt_w,
        height: p.pt_h,
    })
}

pub fn pin_bytes(label: &str) -> Option<Vec<u8>> {
    Some(PINS.lock().unwrap().as_ref()?.get(label)?.bmp.clone())
}

pub fn pin_copy(app: &AppHandle, label: &str) {
    let guard = PINS.lock().unwrap();
    if let Some(p) = guard.as_ref().and_then(|m| m.get(label)) {
        copy_to_clipboard(app, p.px_w, p.px_h, &p.rgba);
        crate::window::show_hud(
            app,
            "ok",
            pick("已复制钉图", "Pinned image copied").into(),
            false,
            false,
            None,
        );
    }
}

/// 按原尺寸倍率缩放钉图窗（左上角不动）。
pub fn pin_zoom(window: &tauri::WebviewWindow, factor: f64) {
    let Some(info) = pin_info(window.label()) else {
        return;
    };
    let f = factor.clamp(0.2, 4.0);
    let _ = window.set_size(tauri::LogicalSize::new(info.width * f, info.height * f));
}

pub fn pin_close(window: &tauri::WebviewWindow) {
    PINS.lock()
        .unwrap()
        .as_mut()
        .map(|m| m.remove(window.label()));
    let _ = window.destroy();
}

/// 钉图右键菜单里可选的笔记分组（由前端向主窗口要来后传入）。
#[derive(serde::Deserialize)]
pub struct PinSection {
    pub id: String,
    pub name: String,
}

const PIN_ZOOM_RESET_EVENT: &str = "toskr://pin-zoom-reset";

/// 钉图右键：原生弹出菜单（钉图窗常常很小，网页内菜单会被裁掉）。
pub fn pin_menu(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    sections: Vec<PinSection>,
) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let mut sec = SubmenuBuilder::new(app, pick("存入分组", "Save to group"));
    if sections.is_empty() {
        sec = sec.item(
            &MenuItemBuilder::with_id("pin:none", pick("没有可存入的分组", "No groups to save to"))
                .enabled(false)
                .build(app)?,
        );
    }
    for s in sections {
        sec = sec.text(format!("pin:section:{}", s.id), s.name);
    }
    let mut alpha = SubmenuBuilder::new(app, pick("透明度", "Opacity"));
    for pct in [100, 80, 60, 40] {
        alpha = alpha.text(format!("pin:alpha:{pct}"), format!("{pct}%"));
    }
    let edited = PINS
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(window.label()))
        .is_some_and(|p| p.original.is_some());
    let menu = MenuBuilder::new(app)
        .text("pin:edit", pick("编辑标注…", "Annotate…"))
        .item(
            &MenuItemBuilder::with_id("pin:restore", pick("还原原图", "Restore original"))
                .enabled(edited)
                .build(app)?,
        )
        .separator()
        .text("pin:copy", pick("复制", "Copy"))
        .text("pin:clip", pick("存入「剪贴」", "Save to Clipboard"))
        .item(&sec.build()?)
        .text("pin:saveas", pick("另存为图片…", "Save image as…"))
        .text("pin:ocr", pick("识别文字并复制", "Recognize text and copy"))
        .separator()
        .item(&alpha.build()?)
        .text("pin:reset", pick("恢复原大小", "Actual size"))
        .separator()
        .text("pin:close", pick("关闭", "Close"))
        .text("pin:closeall", pick("关闭全部钉图", "Close all pins"))
        .build()?;
    window.popup_menu(&menu)
}

/// 钉图图片的副本（像素尺寸 + RGBA）。
fn pin_pixels(label: &str) -> Option<(usize, usize, Vec<u8>)> {
    let guard = PINS.lock().unwrap();
    let p = guard.as_ref()?.get(label)?;
    Some((p.px_w, p.px_h, p.rgba.clone()))
}

fn pin_menu_action(app: &AppHandle, window: &tauri::WebviewWindow, id: &str) {
    let label = window.label().to_string();
    match id {
        "pin:copy" => pin_copy(app, &label),
        "pin:close" => pin_close(window),
        "pin:closeall" => {
            let labels: Vec<String> = PINS
                .lock()
                .unwrap()
                .as_ref()
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            for l in labels {
                if let Some(w) = app.get_webview_window(&l) {
                    pin_close(&w);
                }
            }
        }
        "pin:edit" => pin_edit(app, window),
        "pin:restore" => pin_restore(app, &label),
        "pin:reset" => {
            pin_zoom(window, 1.0);
            let _ = window.emit_to(&label, PIN_ZOOM_RESET_EVENT, ());
        }
        _ if id.starts_with("pin:alpha:") => {
            let pct: f64 = id["pin:alpha:".len()..].parse().unwrap_or(100.0);
            if let Some(ns) = ns_window(window) {
                ns.setAlphaValue((pct / 100.0).clamp(0.2, 1.0));
            }
        }
        _ => {
            let Some((w, h, rgba)) = pin_pixels(&label) else {
                return;
            };
            let app = app.clone();
            let id = id.to_string();
            std::thread::spawn(move || match id.as_str() {
                "pin:clip" => save(&app, Action::Save, None, w, h, &rgba, None),
                "pin:saveas" => save_as(&app, w, h, rgba, None),
                "pin:ocr" => pin_ocr(&app, w, h, &rgba),
                _ => {
                    if let Some(section) = id.strip_prefix("pin:section:") {
                        save(
                            &app,
                            Action::Section,
                            Some(section.to_string()),
                            w,
                            h,
                            &rgba,
                            None,
                        );
                    }
                }
            });
        }
    }
}

/// 窗口所在屏（全局 pt），取不到时给个常见尺寸。
fn window_display(window: &tauri::WebviewWindow) -> RectPt {
    window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let (pos, size) = (
                m.position().to_logical::<f64>(m.scale_factor()),
                m.size().to_logical::<f64>(m.scale_factor()),
            );
            RectPt {
                x: pos.x,
                y: pos.y,
                w: size.width,
                h: size.height,
            }
        })
        .unwrap_or(RectPt {
            x: 0.0,
            y: 0.0,
            w: 1440.0,
            h: 900.0,
        })
}

/// 图片卡「标注 / 裁剪」：把附件图交给标注窗，完成后作为新图存入「剪贴」（原卡不动）。
pub fn annotate_image(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    file: &str,
) -> Result<(), String> {
    let (w, h, rgba) = crate::storage::read_image_rgba(app, file)
        .ok_or_else(|| pick("图片读取失败", "Failed to read the image").to_string())?;
    let scale = window.scale_factor().unwrap_or(2.0).max(1.0);
    crate::screenshot_long::open_editor(app, rgba, w, h, scale, None, window_display(window), None);
    Ok(())
}

/// 钉图编辑标注：用长图标注窗打开钉图原图，完成后写回这张钉图。
fn pin_edit(app: &AppHandle, window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let Some((w, h, rgba, pt_w)) = ({
        let guard = PINS.lock().unwrap();
        guard
            .as_ref()
            .and_then(|m| m.get(&label))
            .map(|p| (p.px_w, p.px_h, p.rgba.clone(), p.pt_w))
    }) else {
        return;
    };
    let display = window_display(window);
    crate::screenshot_long::open_editor(
        app,
        rgba,
        w,
        h,
        w as f64 / pt_w,
        None,
        display,
        Some(label),
    );
}

const PIN_RELOAD_EVENT: &str = "toskr://pin-reload";

/// 标注 / 裁剪后的图写回钉图，首次写回时留下原图。
pub fn pin_replace(app: &AppHandle, label: &str, w: usize, h: usize, rgba: Vec<u8>) {
    let bmp = rgba_to_bmp(w, h, &rgba);
    let resized = {
        let mut guard = PINS.lock().unwrap();
        let Some(p) = guard.as_mut().and_then(|m| m.get_mut(label)) else {
            warn(
                app,
                pick(
                    "钉图已关闭，标注未保存",
                    "The pin was closed; annotations not saved",
                ),
            );
            return;
        };
        let scale = p.px_w as f64 / p.pt_w;
        let edited = Pin {
            bmp,
            rgba,
            px_w: w,
            px_h: h,
            pt_w: w as f64 / scale,
            pt_h: h as f64 / scale,
            original: None,
        };
        let mut old = std::mem::replace(p, edited);
        p.original = Some(match old.original.take() {
            Some(first) => first,
            None => Box::new(old),
        });
        let o = p.original.as_ref().unwrap();
        (o.px_w, o.px_h) != (w, h)
    };
    pin_refresh(app, label, resized);
}

fn pin_restore(app: &AppHandle, label: &str) {
    let resized = {
        let mut guard = PINS.lock().unwrap();
        let Some(p) = guard.as_mut().and_then(|m| m.get_mut(label)) else {
            return;
        };
        let Some(original) = p.original.take() else {
            return;
        };
        let resized = (original.px_w, original.px_h) != (p.px_w, p.px_h);
        *p = *original;
        resized
    };
    pin_refresh(app, label, resized);
}

/// 换图后钉图窗重新拉图；尺寸变了（裁剪过）则按新尺寸复位到 100%。
fn pin_refresh(app: &AppHandle, label: &str, resized: bool) {
    if resized {
        if let Some(w) = app.get_webview_window(label) {
            pin_zoom(&w, 1.0);
            let _ = app.emit_to(label, PIN_ZOOM_RESET_EVENT, ());
        }
    }
    let _ = app.emit_to(label, PIN_RELOAD_EVENT, ());
}

/// 钉图识别文字：复制到剪贴板（不入库）。
fn pin_ocr(app: &AppHandle, w: usize, h: usize, rgba: &[u8]) {
    let text = recognize(w, h, rgba)
        .map(|lines| {
            lines
                .into_iter()
                .map(|l| l.text)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        warn(app, pick("未识别到文字", "No text recognized"));
        return;
    }
    if let Some(_permit) = crate::pasteboard::try_claim(app) {
        if let Ok(count) = crate::pasteboard::write_general_text(&text) {
            crate::clipwatch::mark_self_write_count(app, count);
        }
    }
    let n = text.chars().filter(|c| !c.is_whitespace()).count();
    crate::window::show_hud(
        app,
        "ok",
        crate::tr_fmt!("已复制识别出的 {n} 字", "Copied {n} recognized characters"),
        false,
        false,
        None,
    );
}

/// 同步写剪贴板并标记自写，避免进剪贴历史；剪贴板忙时只记诊断，不影响入库。
fn copy_to_clipboard(app: &AppHandle, w: usize, h: usize, rgba: &[u8]) {
    let Some(_permit) = crate::pasteboard::try_claim(app) else {
        crate::diag::push(app, "截图: 剪贴板事务进行中，未复制");
        return;
    };
    match crate::pasteboard::write_general_image(w, h, rgba) {
        Ok(count) => crate::clipwatch::mark_self_write_count(app, count),
        Err(e) => crate::diag::push(app, format!("截图: 写剪贴板失败 {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, w: f64, h: f64) -> RectPt {
        RectPt { x, y, w, h }
    }

    #[test]
    fn reads_png_pixel_size_from_header() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&3456u32.to_be_bytes());
        png.extend_from_slice(&2234u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((3456, 2234)));
        assert_eq!(png_size(b"not a png at all, definitely"), None);
    }

    #[test]
    fn windows_are_localized_to_display() {
        let d = r(1440.0, -200.0, 1920.0, 1080.0);
        let ws = vec![
            ScreenWindow {
                bounds: r(1500.0, -100.0, 300.0, 200.0),
                pid: 1,
                owner: None,
            },
            ScreenWindow {
                bounds: r(0.0, 0.0, 800.0, 600.0),
                pid: 2,
                owner: None,
            },
        ];
        assert_eq!(local_windows(d, &ws), vec![r(60.0, 100.0, 300.0, 200.0)]);
    }

    #[test]
    fn default_file_name_avoids_colons() {
        let name = default_file_name((2026, 10, 31, 9, 5, 3));
        assert!(name.ends_with(" 2026-10-31 09.05.03.png"), "{name}");
        assert!(!name.contains(':'));
    }

    #[test]
    fn vision_box_flips_to_top_left_pixels() {
        // 左下原点 (0.1, 0.7, 0.5, 0.2) 在 200×100 图里 = 顶部往下 10px 的那一行
        let (x, y, w, h) = vision_to_pixels((0.1, 0.7, 0.5, 0.2), 200, 100);
        assert!((x - 20.0).abs() < 1e-9 && (y - 10.0).abs() < 1e-9);
        assert!((w - 100.0).abs() < 1e-9 && (h - 20.0).abs() < 1e-9);
    }

    #[test]
    fn parses_overlay_label() {
        assert_eq!(shot_index("shot-1"), Some(1));
        assert_eq!(shot_index("main"), None);
    }
}
