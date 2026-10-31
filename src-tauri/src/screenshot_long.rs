//! 长截屏：光标移到选区中央，合成滚轮事件逐段下滚，每段截取选区，
//! 按相邻两帧重叠的像素行拼接。到底（画面不再变化）、超长、或用户动了鼠标即停。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use core_graphics::geometry::CGPoint;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::focus::FrontApp;
use crate::screenshot::RectPt;

/// 每段滚动选区高度的一半，保证相邻帧有足够重叠。
const SCROLL_FRACTION: f64 = 0.5;
/// 滚动后等待内容渲染稳定。
const SETTLE_MS: u64 = 280;
const MAX_STEPS: usize = 60;
/// 长图像素上限（约 200MB RGBA），超出即停。
const MAX_PIXELS: usize = 50_000_000;
/// 光标偏离选区中央超过此距离（pt）视为用户要停。
const ABORT_DISTANCE: f64 = 24.0;
/// 有效重叠：非空白行里至少这么多比例对得上。
const MIN_MATCH_RATIO: f64 = 0.6;
const MIN_OVERLAP_ROWS: usize = 12;

/// 每行的哈希与是否纯色（纯色行在任何偏移下都能对上，不参与判定）。
pub fn row_signatures(rgba: &[u8], w: usize, h: usize) -> Vec<(u64, bool)> {
    (0..h)
        .map(|y| {
            let row = &rgba[y * w * 4..(y + 1) * w * 4];
            let mut hash: u64 = 0xcbf29ce484222325;
            for b in row {
                hash ^= *b as u64;
                hash = hash.wrapping_mul(0x100000001b3);
            }
            let blank = row.chunks_exact(4).all(|p| p == &row[..4]);
            (hash, blank)
        })
        .collect()
}

/// 新帧相对上一帧下移的行数：上一帧第 r+dy 行 == 新帧第 r 行。
/// 取非空白行匹配率最高的 dy；没有可信重叠返回 None。
pub fn scroll_offset(prev: &[(u64, bool)], next: &[(u64, bool)]) -> Option<usize> {
    let h = prev.len().min(next.len());
    let mut best: Option<(usize, f64)> = None;
    for dy in 1..h.saturating_sub(MIN_OVERLAP_ROWS) {
        let (mut considered, mut matched) = (0usize, 0usize);
        for r in 0..h - dy {
            let (a, blank) = prev[r + dy];
            if blank && next[r].1 {
                continue;
            }
            considered += 1;
            if a == next[r].0 {
                matched += 1;
            }
        }
        if considered < MIN_OVERLAP_ROWS {
            continue;
        }
        let ratio = matched as f64 / considered as f64;
        if ratio >= MIN_MATCH_RATIO && best.is_none_or(|(_, b)| ratio > b) {
            best = Some((dy, ratio));
        }
    }
    best.map(|(dy, _)| dy)
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateScrollWheelEvent2(
        source: *const std::ffi::c_void,
        units: u32,
        wheel_count: u32,
        wheel1: i32,
        wheel2: i32,
        wheel3: i32,
    ) -> *mut std::ffi::c_void;
    fn CGEventPost(tap: u32, event: *mut std::ffi::c_void);
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const std::ffi::c_void);
}

/// 在光标处合成像素级滚轮事件（正值向下滚）。需要辅助功能授权（Toskr 已有）。
fn scroll_by(pixels: i32) {
    const UNIT_PIXEL: u32 = 0;
    const HID_TAP: u32 = 0;
    unsafe {
        let event = CGEventCreateScrollWheelEvent2(std::ptr::null(), UNIT_PIXEL, 1, -pixels, 0, 0);
        if !event.is_null() {
            CGEventPost(HID_TAP, event);
            CFRelease(event);
        }
    }
}

/// 结束原因（诊断与提示用）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Stop {
    Bottom,
    UserMoved,
    Limit,
    NoOverlap,
}

/// 自动滚动拼接。`capture` 截取选区返回 (RGBA, 宽, 高)；`region` 为全局 pt 选区；
/// 每拼上一段调用 `progress(已拼 RGBA, 宽, 总高)`。
pub fn run(
    region: (f64, f64, f64, f64),
    mut capture: impl FnMut() -> Result<(Vec<u8>, usize, usize), String>,
    mut progress: impl FnMut(&[u8], usize, usize),
) -> Result<(Vec<u8>, usize, usize, Stop), String> {
    let (rx, ry, rw, rh) = region;
    let center = CGPoint::new(rx + rw / 2.0, ry + rh / 2.0);
    let _ = core_graphics::display::CGDisplay::warp_mouse_cursor_position(center);
    std::thread::sleep(std::time::Duration::from_millis(120));

    let (first, w, h) = capture()?;
    let mut st = Stitcher::new(first, w, h);
    progress(&st.out, w, st.total_h);
    let step = (rh * SCROLL_FRACTION).round().max(1.0) as i32;
    let mut stop = Stop::Limit;
    for _ in 0..MAX_STEPS {
        if let Some((cx, cy)) = crate::window::cursor_point_pt() {
            if (cx - center.x).hypot(cy - center.y) > ABORT_DISTANCE {
                stop = Stop::UserMoved;
                break;
            }
        }
        scroll_by(step);
        std::thread::sleep(std::time::Duration::from_millis(SETTLE_MS));
        let (frame, fw, fh) = capture()?;
        if fw != w || fh != h {
            return Err("frame size changed".into());
        }
        match st.push(&frame) {
            Push::Same => {
                stop = Stop::Bottom;
                break;
            }
            Push::NoOverlap => {
                stop = Stop::NoOverlap;
                break;
            }
            Push::Appended => progress(&st.out, w, st.total_h),
        }
        if w * st.total_h >= MAX_PIXELS {
            stop = Stop::Limit;
            break;
        }
    }
    Ok((st.out, w, st.total_h, stop))
}

/// 相邻两帧在原位不变的顶部 / 底部行数（固定页头、固定页尾）。
fn fixed_rows(prev: &[(u64, bool)], next: &[(u64, bool)]) -> (usize, usize) {
    let same = |r: usize| prev[r].0 == next[r].0;
    let h = prev.len().min(next.len());
    let top = (0..h).take_while(|&r| same(r)).count();
    let bottom = (top..h).rev().take_while(|&r| same(r)).count();
    (top, bottom)
}

#[derive(Debug, PartialEq)]
pub enum Push {
    Appended,
    /// 与上一帧完全相同（到底了）
    Same,
    NoOverlap,
}

/// 逐帧拼接。固定页头只参与对位排除；固定页尾每步先从长图末尾摘掉、
/// 追加新内容后再接回，始终只留一份在最底部。
pub struct Stitcher {
    w: usize,
    h: usize,
    pub out: Vec<u8>,
    pub total_h: usize,
    prev: Vec<(u64, bool)>,
    /// 长图末尾有多少行是上一帧底部的原样像素（摘页尾不能超过它）
    tail: usize,
}

impl Stitcher {
    pub fn new(first: Vec<u8>, w: usize, h: usize) -> Self {
        Self {
            prev: row_signatures(&first, w, h),
            out: first,
            total_h: h,
            tail: h,
            w,
            h,
        }
    }

    pub fn push(&mut self, frame: &[u8]) -> Push {
        let (w, h) = (self.w, self.h);
        let sig = row_signatures(frame, w, h);
        if sig == self.prev {
            return Push::Same;
        }
        let (mut top, mut bottom) = fixed_rows(&self.prev, &sig);
        if top + bottom + 2 * MIN_OVERLAP_ROWS >= h {
            (top, bottom) = (0, 0);
        }
        bottom = bottom.min(self.tail);
        let body = top..h - bottom;
        let Some(dy) = scroll_offset(&self.prev[body.clone()], &sig[body]) else {
            return Push::NoOverlap;
        };
        // 摘掉旧页尾 → 接上新帧页尾之上的 dy 行新内容 + 新页尾
        self.out.truncate(self.out.len() - bottom * w * 4);
        self.out
            .extend_from_slice(&frame[(h - bottom - dy) * w * 4..]);
        self.total_h += dy;
        self.tail = dy + bottom;
        self.prev = sig;
        Push::Appended
    }
}

// ===== 拼接预览（屏幕边缘的竖条小窗，随拼接变长） =====

const PREVIEW_LABEL: &str = "longpreview";
pub const PROGRESS_EVENT: &str = "toskr://long-progress";
/// 预览图宽度（像素）；按此宽度最近邻缩小，只追加新行。
const PREVIEW_W: usize = 160;
const PREVIEW_WINDOW_W: f64 = 180.0;

struct Preview {
    rgba: Vec<u8>,
    rows: usize,
}

static PREVIEW: Mutex<Option<Preview>> = Mutex::new(None);

/// 最近邻缩小：把源图中尚未采样的行追加到预览（预览第 k 行取源第 ⌊k·f⌋ 行）。
fn extend_preview(p: &mut Preview, src: &[u8], src_w: usize, src_h: usize) {
    let f = src_w as f64 / PREVIEW_W as f64;
    loop {
        let sy = (p.rows as f64 * f) as usize;
        if sy >= src_h {
            break;
        }
        let row = &src[sy * src_w * 4..(sy + 1) * src_w * 4];
        for k in 0..PREVIEW_W {
            let sx = ((k as f64 * f) as usize).min(src_w - 1) * 4;
            p.rgba.extend_from_slice(&row[sx..sx + 4]);
        }
        p.rows += 1;
    }
}

#[derive(Clone, Serialize)]
struct Progress {
    /// 已拼接高度（像素）
    height: usize,
}

/// 在选区所在屏的右缘（选区挡住时改左缘）放一条预览小窗；鼠标穿透、不抢焦点。
pub fn open_preview(app: &AppHandle, display: RectPt, region: RectPt) {
    *PREVIEW.lock().unwrap() = Some(Preview {
        rgba: Vec::new(),
        rows: 0,
    });
    let right_x = display.x + display.w - PREVIEW_WINDOW_W - 12.0;
    let x = if region.x + region.w > right_x {
        display.x + 12.0
    } else {
        right_x
    };
    let (y, h) = (display.y + 60.0, (display.h * 0.6).max(240.0));
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let built = tauri::WebviewWindowBuilder::new(
            &handle,
            PREVIEW_LABEL,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Toskr Scrolling Capture")
        .inner_size(PREVIEW_WINDOW_W, h)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(true)
        .focused(false)
        .visible_on_all_workspaces(true)
        .build();
        if let Ok(w) = built {
            let _ = w.set_ignore_cursor_events(true);
            crate::window::ensure_fullscreen_auxiliary(&w);
        }
    });
}

pub fn preview_progress(app: &AppHandle, src: &[u8], src_w: usize, src_h: usize) {
    {
        let mut guard = PREVIEW.lock().unwrap();
        let Some(p) = guard.as_mut() else { return };
        extend_preview(p, src, src_w, src_h);
    }
    let _ = app.emit_to(PREVIEW_LABEL, PROGRESS_EVENT, Progress { height: src_h });
}

/// 预览图（BMP）与已拼高度。
pub fn preview_bytes() -> Option<Vec<u8>> {
    let guard = PREVIEW.lock().unwrap();
    let p = guard.as_ref().filter(|p| p.rows > 0)?;
    Some(rgba_bmp(PREVIEW_W, p.rows, &p.rgba))
}

pub fn close_preview(app: &AppHandle) {
    *PREVIEW.lock().unwrap() = None;
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window(PREVIEW_LABEL) {
            let _ = w.destroy();
        }
    });
}

fn rgba_bmp(w: usize, h: usize, rgba: &[u8]) -> Vec<u8> {
    let mut bgra = rgba.to_vec();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    crate::screenshot_sck::bmp_from_bgra(&bgra, w, h, w * 4)
}

// ===== 长图标注窗 =====

const EDITOR_PREFIX: &str = "longshot-";
static NEXT_EDITOR: AtomicU64 = AtomicU64::new(1);

struct LongShot {
    bmp: Vec<u8>,
    px_w: usize,
    px_h: usize,
    /// 像素 / pt
    scale: f64,
    front: Option<FrontApp>,
    /// 从钉图打开时为钉图窗 label：完成即更新那张钉图
    pin: Option<String>,
}

static LONGS: Mutex<Option<HashMap<String, LongShot>>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongInfo {
    pub px_w: usize,
    pub px_h: usize,
    pub scale: f64,
    /// 编辑的是钉图（✓ = 更新钉图）
    pub pin: bool,
}

/// 拼好的长图（或钉图）交给可滚动的标注窗（带系统标题栏，居中于所在屏）。
pub fn open_editor(
    app: &AppHandle,
    rgba: Vec<u8>,
    px_w: usize,
    px_h: usize,
    scale: f64,
    front: Option<FrontApp>,
    display: RectPt,
    pin: Option<String>,
) {
    let label = format!(
        "{EDITOR_PREFIX}{}",
        NEXT_EDITOR.fetch_add(1, Ordering::Relaxed)
    );
    let bmp = rgba_bmp(px_w, px_h, &rgba);
    drop(rgba);
    LONGS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(
            label.clone(),
            LongShot {
                bmp,
                px_w,
                px_h,
                scale,
                front,
                pin: pin.clone(),
            },
        );
    let pt_w = px_w as f64 / scale;
    let win_w = (pt_w + 48.0).clamp(680.0, display.w * 0.9);
    let win_h = (px_h as f64 / scale + 120.0).clamp(400.0, display.h * 0.85);
    let (x, y) = (
        display.x + (display.w - win_w) / 2.0,
        display.y + (display.h - win_h) / 2.0,
    );
    let title = if pin.is_some() {
        crate::tr_fmt!("编辑钉图 {px_w}×{px_h}", "Edit pin {px_w}×{px_h}")
    } else {
        crate::tr_fmt!("长截屏 {px_w}×{px_h}", "Scrolling capture {px_w}×{px_h}")
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let built = tauri::WebviewWindowBuilder::new(
            &handle,
            &label,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title(title)
        .inner_size(win_w, win_h)
        .position(x, y)
        .min_inner_size(640.0, 400.0)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .build();
        match built {
            Ok(w) => {
                crate::window::ensure_fullscreen_auxiliary(&w);
                // 用标题栏关闭按钮关窗时也释放长图内存
                let closing = label.clone();
                w.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        LONGS.lock().unwrap().as_mut().map(|m| m.remove(&closing));
                    }
                });
                let _ = w.set_focus();
            }
            Err(e) => {
                LONGS.lock().unwrap().as_mut().map(|m| m.remove(&label));
                crate::diag::push(&handle, format!("长图标注窗创建失败 {e}"));
            }
        }
    });
}

pub fn info(label: &str) -> Option<LongInfo> {
    let guard = LONGS.lock().unwrap();
    let l = guard.as_ref()?.get(label)?;
    Some(LongInfo {
        px_w: l.px_w,
        px_h: l.px_h,
        scale: l.scale,
        pin: l.pin.is_some(),
    })
}

pub fn image_bytes(label: &str) -> Option<Vec<u8>> {
    Some(LONGS.lock().unwrap().as_ref()?.get(label)?.bmp.clone())
}

/// 标注窗出图：按动作存入「剪贴」/ 指定分组 / 另存为，随后关窗。
pub fn commit(
    window: &tauri::WebviewWindow,
    action: crate::screenshot::Action,
    section: Option<String>,
    w: usize,
    h: usize,
    rgba: Vec<u8>,
) -> Result<(), String> {
    if w == 0 || h == 0 || rgba.len() != w * h * 4 {
        return Err("invalid image".into());
    }
    let entry = LONGS
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|m| m.remove(window.label()));
    let (front, pin) = entry.map_or((None, None), |e| (e.front, e.pin));
    let app = window.app_handle().clone();
    let _ = window.destroy();
    if let (crate::screenshot::Action::Pin, Some(pin)) = (action, pin) {
        crate::screenshot::pin_replace(&app, &pin, w, h, rgba);
        return Ok(());
    }
    std::thread::spawn(move || match action {
        crate::screenshot::Action::SaveAs => {
            crate::screenshot::save_as(&app, w, h, rgba, front.as_ref())
        }
        _ => crate::screenshot::save(&app, action, section, w, h, &rgba, front.as_ref()),
    });
    Ok(())
}

pub fn close(window: &tauri::WebviewWindow) {
    LONGS
        .lock()
        .unwrap()
        .as_mut()
        .map(|m| m.remove(window.label()));
    let _ = window.destroy();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 宽 2 的"页面"：第 i 行像素值由 i 决定，纯色行模拟空白。
    fn page(rows: &[u8]) -> Vec<u8> {
        rows.iter()
            .flat_map(|&v| [v, v.wrapping_mul(7), 1, 255, v.wrapping_add(3), v, 2, 255])
            .collect()
    }

    fn window(content: &[u8], top: usize, h: usize) -> Vec<(u64, bool)> {
        row_signatures(&page(&content[top..top + h]), 2, h)
    }

    #[test]
    fn finds_scroll_distance() {
        let content: Vec<u8> = (0..200).map(|i| (i * 13 % 251) as u8).collect();
        let a = window(&content, 0, 60);
        let b = window(&content, 25, 60);
        assert_eq!(scroll_offset(&a, &b), Some(25));
    }

    #[test]
    fn no_overlap_when_jump_too_far() {
        let content: Vec<u8> = (0..200).map(|i| (i * 13 % 251) as u8).collect();
        let a = window(&content, 0, 40);
        let b = window(&content, 100, 40);
        assert_eq!(scroll_offset(&a, &b), None);
    }

    #[test]
    fn blank_rows_do_not_fake_a_match() {
        let blank = vec![[9u8, 9, 9, 255]; 2].concat();
        let rows = |n: usize| -> Vec<(u64, bool)> { row_signatures(&blank.repeat(n), 2, n) };
        assert_eq!(scroll_offset(&rows(50), &rows(50)), None);
    }

    /// 视口 = 固定页头 + 内容[top..] + 固定页尾，逐段下滚后长图里页头页尾各只一份。
    #[test]
    fn sticky_header_and_footer_kept_once() {
        let content: Vec<u8> = (0..120).map(|i| 100 + i as u8).collect();
        let header: Vec<u8> = (1..9).collect();
        let footer: Vec<u8> = (30..40).collect();
        let body_h = 60 - header.len() - footer.len();
        let frame = |top: usize| -> Vec<u8> {
            page(&[&header[..], &content[top..top + body_h], &footer[..]].concat())
        };
        let mut st = Stitcher::new(frame(0), 2, 60);
        for top in [20, 40, 60] {
            assert_eq!(st.push(&frame(top)), Push::Appended);
        }
        assert_eq!(st.push(&frame(60)), Push::Same);
        let expected = page(&[&header[..], &content[..60 + body_h], &footer[..]].concat());
        assert_eq!(st.total_h, 60 + 60);
        let rows = |v: &[u8]| v.chunks(8).map(|c| c[0]).collect::<Vec<_>>();
        assert_eq!(rows(&st.out), rows(&expected), "页头页尾不重复、内容连续");
    }

    #[test]
    fn plain_page_stitches_contiguously() {
        let content: Vec<u8> = (0..200).map(|i| (i * 13 % 251) as u8).collect();
        let mut st = Stitcher::new(page(&content[..60]), 2, 60);
        assert_eq!(st.push(&page(&content[30..90])), Push::Appended);
        assert_eq!(st.push(&page(&content[55..115])), Push::Appended);
        assert!(st.out == page(&content[..115]));
    }

    #[test]
    fn preview_downsamples_appended_rows_only() {
        let mut p = Preview {
            rgba: Vec::new(),
            rows: 0,
        };
        // 源宽 320 = 预览宽 2 倍 → 预览每行取源第 2k 行
        let src: Vec<u8> = (0..320 * 10)
            .flat_map(|i| [(i / 320) as u8, 0, 0, 255])
            .collect();
        extend_preview(&mut p, &src[..320 * 4 * 4], 320, 4);
        assert_eq!(p.rows, 2);
        extend_preview(&mut p, &src, 320, 10);
        assert_eq!(p.rows, 5);
        assert_eq!(p.rgba.len(), 5 * PREVIEW_W * 4);
        assert_eq!(p.rgba[4 * PREVIEW_W * 4], 8, "第 4 行取源第 8 行");
    }
}
