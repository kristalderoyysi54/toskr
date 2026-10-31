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
    frames: Vec<Frame>,
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
}

/// 截完后的动作（遮罩工具条按钮）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    /// 复制并存入「剪贴」
    Save,
    /// 钉在屏幕上（不入库）
    Pin,
    /// 识别文字：文字存入「剪贴」并复制
    Ocr,
    /// 存入「剪贴」后发送到当前目标
    Send,
    /// 存入「剪贴」后打开图片编辑器
    Edit,
}

impl Action {
    pub fn parse(s: &str) -> Self {
        match s {
            "pin" => Self::Pin,
            "ocr" => Self::Ocr,
            "send" => Self::Send,
            "edit" => Self::Edit,
            _ => Self::Save,
        }
    }
}

#[derive(Clone, Serialize)]
struct AfterPayload {
    clip: ClipPayload,
    action: &'static str,
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

/// SCK 冻结各屏（截图自动排除本应用窗口，无需先藏面板）。
fn capture_all_sck(displays: &[(u32, RectPt)]) -> Result<Vec<Frame>, String> {
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

/// 按屏摆放遮罩窗并显示，光标所在屏取得键盘焦点。仅限主线程。
fn show_overlays(app: &AppHandle, displays: &[RectPt], session_id: u64, focus_index: usize) {
    for (i, b) in displays.iter().enumerate() {
        let label = format!("{LABEL_PREFIX}{i}");
        let window = match app.get_webview_window(&label) {
            Some(w) => w,
            None => match create_overlay(app, &label) {
                Ok(w) => w,
                Err(e) => {
                    crate::diag::push(app, format!("截图: 遮罩窗创建失败 {e}"));
                    continue;
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
        if i == focus_index {
            let _ = window.set_focus();
        }
        let _ = window.emit_to(&label, SESSION_EVENT, session_id);
    }
    // 屏数变少时把多余的旧遮罩藏起来
    for i in displays.len()..8 {
        if let Some(w) = app.get_webview_window(&format!("{LABEL_PREFIX}{i}")) {
            let _ = w.hide();
        }
    }
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
        let mut via = "sck";
        let sck = if crate::screenshot_sck::supported() {
            capture_all_sck(&with_ids)
        } else {
            Err("macOS < 14".into())
        };
        let frames = match sck {
            Ok(f) => Ok(f),
            Err(e) => {
                crate::diag::push(&app, format!("截图: SCK 不可用，回退 screencapture（{e}）"));
                via = "screencapture";
                let saved = hide_own_windows(&app);
                if !saved.is_empty() {
                    // 等透明度落到合成器，避免面板残影进入冻结帧
                    std::thread::sleep(std::time::Duration::from_millis(40));
                }
                let frames = capture_all(&displays);
                restore_own_windows(&app, saved);
                frames
            }
        };
        let frames = match frames {
            Ok(f) => f,
            Err(e) => {
                crate::diag::push(&app, format!("截图失败：{e}"));
                crate::window::show_hud(
                    &app,
                    "warn",
                    pick(
                        "截图失败，详情见诊断日志",
                        "Screenshot failed; see the diagnostics log",
                    )
                    .into(),
                    false,
                    false,
                    None,
                );
                return;
            }
        };
        let focus_index = cursor
            .and_then(|(x, y)| displays.iter().position(|d| d.contains(x, y)))
            .unwrap_or(0);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        *SESSION.lock().unwrap() = Some(Session {
            id,
            frames,
            windows,
            cursor,
            front,
        });
        crate::diag::push(
            &app,
            format!(
                "截图冻结 {} 屏 {via} 耗时 {}ms",
                displays.len(),
                started.elapsed().as_millis()
            ),
        );
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || show_overlays(&handle, &displays, id, focus_index));
    });
}

/// 本屏会话信息；无会话或屏序号越界时返回 None。
pub fn session_info(label: &str) -> Option<SessionInfo> {
    let index = shot_index(label)?;
    let guard = SESSION.lock().unwrap();
    let s = guard.as_ref()?;
    let f = s.frames.get(index)?;
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

/// 本屏冻结帧原始字节（PNG 或 BMP）。
pub fn frame_bytes(label: &str, session_id: u64) -> Option<Vec<u8>> {
    let index = shot_index(label)?;
    let guard = SESSION.lock().unwrap();
    let s = guard.as_ref().filter(|s| s.id == session_id)?;
    Some(s.frames.get(index)?.bytes.clone())
}

/// 结束会话：通知各遮罩窗清空画面，稍后藏窗并把焦点还给截图前的前台应用。
fn end_session(app: &AppHandle) -> Option<Session> {
    let session = SESSION.lock().unwrap().take()?;
    let count = session.frames.len();
    for i in 0..count {
        let _ = app.emit_to(format!("{LABEL_PREFIX}{i}"), END_EVENT, session.id);
    }
    let pid = session.front.as_ref().map(|f| f.pid);
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

pub fn cancel(app: &AppHandle) {
    if end_session(app).is_some() {
        crate::diag::push(app, "截图已取消");
    }
}

/// 选区在发起窗口所在屏的位置（本屏 pt），钉图定位用。
pub struct Placement {
    pub label: String,
    pub x: f64,
    pub y: f64,
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
        shot_index(&placement.label)
            .and_then(|i| guard.as_ref()?.frames.get(i).map(|f| (f.bounds, f.px_w)))
    };
    let session = end_session(app).ok_or("no screenshot session")?;
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
                },
                bounds.x + placement.x,
                bounds.y + placement.y,
            );
        }
        Action::Ocr => ocr(&app, width, height, &rgba, &session),
        _ => save(&app, action, width, height, &rgba, session),
    });
    Ok(())
}

fn source_of(session: &Session) -> (Option<String>, Option<String>) {
    session
        .front
        .as_ref()
        .map(|f| (f.name.clone(), f.bundle_id.clone()))
        .unwrap_or((None, None))
}

fn ocr(app: &AppHandle, width: usize, height: usize, rgba: &[u8], session: &Session) {
    let text = crate::ocr::recognize_observations(&rgba_to_bmp(width, height, rgba))
        .map(|obs| {
            obs.into_iter()
                .map(|o| o.text)
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
    crate::diag::push(app, format!("截图识别文字 {n} 字"));
    let (app_name, bundle_id) = source_of(session);
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
            "已识别 {n} 字并复制，存入「剪贴」",
            "Recognized {n} characters, copied and saved to Clipboard"
        ),
        false,
        false,
        None,
    );
}

fn save(
    app: &AppHandle,
    action: Action,
    width: usize,
    height: usize,
    rgba: &[u8],
    session: Session,
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
        let (app_name, bundle_id) = source_of(&session);
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
        if action != Action::Save {
            let name = if action == Action::Send {
                "send"
            } else {
                "edit"
            };
            let _ = app.emit_to("main", AFTER_EVENT, AfterPayload { clip, action: name });
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
    fn parses_overlay_label() {
        assert_eq!(shot_index("shot-1"), Some(1));
        assert_eq!(shot_index("main"), None);
    }
}
