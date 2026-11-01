//! 长截屏：选区四周画框、旁边放预览面板，用户自己滚动页面；
//! 定时截取选区，按相邻两帧重叠的像素行拼接（可往回滚，不重复追加）。
//! 点面板「完成」进标注窗，「取消」放弃。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;

use core_graphics::geometry::CGPoint;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::focus::FrontApp;
use crate::screenshot::RectPt;

/// 长图像素上限（约 200MB RGBA），超出即停。
const MAX_PIXELS: usize = 50_000_000;
/// 有效重叠：非空白行里至少这么多比例对得上。
const MIN_MATCH_RATIO: f64 = 0.6;
const MIN_OVERLAP_ROWS: usize = 12;
/// 截帧间隔；长时间不滚视为忘了点完成，按完成处理。
const POLL_MS: u64 = 120;
const IDLE_LIMIT: std::time::Duration = std::time::Duration::from_secs(120);

/// 面板按钮：0 = 继续，1 = 完成，2 = 取消。
static STOP_REQUEST: AtomicU8 = AtomicU8::new(0);

pub fn request_stop(cancel: bool) {
    STOP_REQUEST.store(if cancel { 2 } else { 1 }, Ordering::Relaxed);
}

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

/// 结束原因（诊断与提示用）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Stop {
    /// 点了「完成」
    Finished,
    /// 点了「取消」
    Cancelled,
    /// 长时间没滚动
    Idle,
    /// 超出长图上限
    Limit,
}

/// 拼接过程通知（预览面板用）。
pub enum Event<'a> {
    /// 已拼 RGBA、宽、总高
    Stitched(&'a [u8], usize, usize),
    /// 新帧对不上（滚太快）/ 恢复
    Stalled(bool),
}

/// 拼接主循环。`capture` 截取选区返回 (RGBA, 宽, 高)；`region` 为全局 pt 选区。
/// 光标先移到选区中央，用户的滚轮才落在要截的区域上。
pub fn run(
    region: (f64, f64, f64, f64),
    mut capture: impl FnMut() -> Result<(Vec<u8>, usize, usize), String>,
    mut progress: impl FnMut(Event),
) -> Result<(Vec<u8>, usize, usize, Stop), String> {
    let (rx, ry, rw, rh) = region;
    let center = CGPoint::new(rx + rw / 2.0, ry + rh / 2.0);
    let _ = core_graphics::display::CGDisplay::warp_mouse_cursor_position(center);
    std::thread::sleep(std::time::Duration::from_millis(120));

    let (first, w, h) = capture()?;
    let mut st = Stitcher::new(first, w, h);
    progress(Event::Stitched(&st.out, w, st.total_h));
    let stop = follow(&mut st, &mut capture, &mut progress)?;
    Ok((st.out, w, st.total_h, stop))
}

/// 定时截帧，画面变了就拼；对不上的帧丢弃（等用户往回滚到能接上）。
fn follow(
    st: &mut Stitcher,
    capture: &mut impl FnMut() -> Result<(Vec<u8>, usize, usize), String>,
    progress: &mut impl FnMut(Event),
) -> Result<Stop, String> {
    STOP_REQUEST.store(0, Ordering::Relaxed);
    let mut last_change = std::time::Instant::now();
    let mut stalled = false;
    loop {
        match STOP_REQUEST.swap(0, Ordering::Relaxed) {
            1 => return Ok(Stop::Finished),
            2 => return Ok(Stop::Cancelled),
            _ => {}
        }
        if last_change.elapsed() > IDLE_LIMIT {
            return Ok(Stop::Idle);
        }
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        let (frame, fw, fh) = capture()?;
        if fw != st.w || fh != st.h {
            return Err("frame size changed".into());
        }
        let result = st.push(&frame);
        if result != Push::Same {
            last_change = std::time::Instant::now();
        }
        if (result == Push::NoOverlap) != stalled {
            stalled = !stalled;
            progress(Event::Stalled(stalled));
        }
        if result == Push::Appended {
            progress(Event::Stitched(&st.out, st.w, st.total_h));
            if st.w * st.total_h >= MAX_PIXELS {
                return Ok(Stop::Limit);
            }
        }
    }
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
    /// 往回滚，或往下滚但还没越过已拼部分：只更新位置，不追加
    Moved,
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
    /// 当前帧内容底边比已拼长图底边高出的行数（往回滚产生）
    behind: usize,
}

impl Stitcher {
    pub fn new(first: Vec<u8>, w: usize, h: usize) -> Self {
        Self {
            prev: row_signatures(&first, w, h),
            out: first,
            total_h: h,
            tail: h,
            behind: 0,
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
        let forward = scroll_offset(&self.prev[body.clone()], &sig[body.clone()]);
        let Some(dy) = forward else {
            // 往回滚：新帧在上一帧之上 dy 行
            let Some(dy) = scroll_offset(&sig[body.clone()], &self.prev[body]) else {
                return Push::NoOverlap;
            };
            self.behind += dy;
            self.moved(sig, bottom);
            return Push::Moved;
        };
        if dy <= self.behind {
            self.behind -= dy;
            self.moved(sig, bottom);
            return Push::Moved;
        }
        let new = dy - self.behind;
        self.behind = 0;
        // 摘掉旧页尾 → 接上新帧页尾之上的 new 行新内容 + 新页尾
        self.out.truncate(self.out.len() - bottom * w * 4);
        self.out
            .extend_from_slice(&frame[(h - bottom - new) * w * 4..]);
        self.total_h += new;
        self.tail = new + bottom;
        self.prev = sig;
        Push::Appended
    }

    /// 只换位置不追加：长图末尾与新帧底部仍一致的只剩两者共同的页尾行。
    fn moved(&mut self, sig: Vec<(u64, bool)>, bottom: usize) {
        self.tail = self.tail.min(bottom);
        self.prev = sig;
    }
}

// ===== 拼接预览：选区边框 + 旁边的预览面板（缩略长图、提示、取消 / 完成） =====

const PREVIEW_LABEL: &str = "longpreview";
const FRAME_LABEL: &str = "longframe";
pub const PROGRESS_EVENT: &str = "toskr://long-progress";
/// 预览图宽度（像素）；按此宽度最近邻缩小，只追加新行。
const PREVIEW_W: usize = 400;
const PANEL_W: f64 = 220.0;
const PANEL_MIN_H: f64 = 320.0;
const PANEL_GAP: f64 = 12.0;
/// 边框窗比选区每边大出的 pt（边框画在选区外，不会被截进去）。
const FRAME_PAD: f64 = 4.0;

struct Preview {
    rgba: Vec<u8>,
    rows: usize,
    width: usize,
    height: usize,
    stalled: bool,
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
    /// 已拼接尺寸（像素）
    width: usize,
    height: usize,
    /// 滚太快、新画面接不上
    stalled: bool,
}

/// 面板位置：选区右侧放得下放右侧，否则左侧，都放不下贴屏幕右缘；纵向与选区顶对齐并收进屏内。
fn panel_rect(display: RectPt, region: RectPt) -> RectPt {
    let h = region.h.max(PANEL_MIN_H).min(display.h - 2.0 * PANEL_GAP);
    let right = region.x + region.w + PANEL_GAP;
    let left = region.x - PANEL_GAP - PANEL_W;
    let x = if right + PANEL_W <= display.x + display.w - PANEL_GAP {
        right
    } else if left >= display.x + PANEL_GAP {
        left
    } else {
        display.x + display.w - PANEL_W - PANEL_GAP
    };
    let y = region
        .y
        .clamp(display.y + PANEL_GAP, display.y + display.h - h - PANEL_GAP);
    RectPt {
        x,
        y,
        w: PANEL_W,
        h,
    }
}

pub fn open_preview(app: &AppHandle, display: RectPt, region: RectPt) {
    STOP_REQUEST.store(0, Ordering::Relaxed);
    *PREVIEW.lock().unwrap() = Some(Preview {
        rgba: Vec::new(),
        rows: 0,
        width: 0,
        height: 0,
        stalled: false,
    });
    let panel = panel_rect(display, region);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let window = |label: &str, r: RectPt| {
            tauri::WebviewWindowBuilder::new(
                &handle,
                label,
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Toskr Scrolling Capture")
            .inner_size(r.w, r.h)
            .position(r.x, r.y)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .focused(false)
            .accept_first_mouse(true)
            .visible_on_all_workspaces(true)
            .build()
        };
        let frame = RectPt {
            x: region.x - FRAME_PAD,
            y: region.y - FRAME_PAD,
            w: region.w + 2.0 * FRAME_PAD,
            h: region.h + 2.0 * FRAME_PAD,
        };
        // 边框窗鼠标穿透：滚轮要落到选区下面的页面
        if let Ok(w) = window(FRAME_LABEL, frame) {
            let _ = w.set_ignore_cursor_events(true);
            crate::window::ensure_fullscreen_auxiliary(&w);
        }
        // 面板窗透明，图与工具条各自带阴影，窗口本身不加阴影（否则空白处也有框）
        if let Ok(w) = window(PREVIEW_LABEL, panel) {
            crate::window::ensure_fullscreen_auxiliary(&w);
        }
    });
}

/// 拼接事件 → 更新预览面板。
pub fn preview_event(app: &AppHandle, event: Event) {
    let payload = {
        let mut guard = PREVIEW.lock().unwrap();
        let Some(p) = guard.as_mut() else { return };
        match event {
            Event::Stitched(src, src_w, src_h) => {
                extend_preview(p, src, src_w, src_h);
                (p.width, p.height) = (src_w, src_h);
            }
            Event::Stalled(v) => p.stalled = v,
        }
        Progress {
            width: p.width,
            height: p.height,
            stalled: p.stalled,
        }
    };
    let _ = app.emit_to(PREVIEW_LABEL, PROGRESS_EVENT, payload);
}

/// 预览图（BMP）。
pub fn preview_bytes() -> Option<Vec<u8>> {
    let guard = PREVIEW.lock().unwrap();
    let p = guard.as_ref().filter(|p| p.rows > 0)?;
    Some(rgba_bmp(PREVIEW_W, p.rows, &p.rgba))
}

pub fn close_preview(app: &AppHandle) {
    *PREVIEW.lock().unwrap() = None;
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        for label in [PREVIEW_LABEL, FRAME_LABEL] {
            if let Some(w) = handle.get_webview_window(label) {
                let _ = w.destroy();
            }
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
    origin: Origin,
}

/// 标注窗的图从哪来：决定 ✓（写回）做什么。
#[derive(Clone)]
pub enum Origin {
    /// 新截的长图：✓ 存入「剪贴」
    Capture,
    /// 钉图窗 label：✓ 更新那张钉图
    Pin(String),
    /// 图片卡：✓ 替换卡里这张图（主窗口负责校验、替换与撤销）
    Note(NoteImage),
}

#[derive(Clone)]
pub struct NoteImage {
    pub note_id: String,
    pub data_generation: u64,
    pub file: String,
}

pub const NOTE_REPLACE_EVENT: &str = "toskr://annotate-note-image";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteReplace {
    operation_id: String,
    note_id: String,
    data_generation: u64,
    source_file: String,
    edited_file: String,
    width: usize,
    height: usize,
    /// 批注编号说明：主窗口追加到图片卡备注。
    caption: Option<String>,
}

static LONGS: Mutex<Option<HashMap<String, LongShot>>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongInfo {
    pub px_w: usize,
    pub px_h: usize,
    pub scale: f64,
    /// ✓ 的去向：capture = 存入「剪贴」，pin = 更新钉图，note = 替换图片卡里的图
    pub origin: &'static str,
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
    origin: Origin,
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
                origin: origin.clone(),
            },
        );
    let pt_w = px_w as f64 / scale;
    let win_w = (pt_w + 48.0).clamp(680.0, display.w * 0.9);
    let win_h = (px_h as f64 / scale + 120.0).clamp(400.0, display.h * 0.85);
    let (x, y) = (
        display.x + (display.w - win_w) / 2.0,
        display.y + (display.h - win_h) / 2.0,
    );
    let title = match origin {
        Origin::Pin(_) => crate::tr_fmt!("编辑钉图 {px_w}×{px_h}", "Edit pin {px_w}×{px_h}"),
        Origin::Note(_) => crate::tr_fmt!("标注图片 {px_w}×{px_h}", "Annotate image {px_w}×{px_h}"),
        Origin::Capture => {
            crate::tr_fmt!("长截屏 {px_w}×{px_h}", "Scrolling capture {px_w}×{px_h}")
        }
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
        origin: match l.origin {
            Origin::Capture => "capture",
            Origin::Pin(_) => "pin",
            Origin::Note(_) => "note",
        },
    })
}

pub fn image_bytes(label: &str) -> Option<Vec<u8>> {
    Some(LONGS.lock().unwrap().as_ref()?.get(label)?.bmp.clone())
}

/// 标注窗出图：写回来源（钉图 / 图片卡），或按动作存入「剪贴」/ 指定分组 / 另存为，随后关窗。
pub fn commit(
    window: &tauri::WebviewWindow,
    writeback: bool,
    action: crate::screenshot::Action,
    section: Option<String>,
    caption: Option<String>,
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
    let (front, origin) = entry.map_or((None, Origin::Capture), |e| (e.front, e.origin));
    let label = window.label().to_string();
    let app = window.app_handle().clone();
    let _ = window.destroy();
    match (writeback, origin) {
        (true, Origin::Pin(pin)) => {
            crate::screenshot::pin_replace(&app, &pin, w, h, rgba);
            return Ok(());
        }
        (true, Origin::Note(target)) => {
            std::thread::spawn(move || note_replace(&app, label, target, caption, w, h, &rgba));
            return Ok(());
        }
        _ => {}
    }
    std::thread::spawn(move || match action {
        crate::screenshot::Action::SaveAs => {
            crate::screenshot::save_as(&app, w, h, rgba, front.as_ref())
        }
        _ => crate::screenshot::save(&app, action, section, caption, w, h, &rgba, front.as_ref()),
    });
    Ok(())
}

/// 标注后的图写进媒体库，交主窗口替换图片卡里的原图（校验数据代际、可撤销）。
fn note_replace(
    app: &AppHandle,
    label: String,
    target: NoteImage,
    caption: Option<String>,
    w: usize,
    h: usize,
    rgba: &[u8],
) {
    match crate::storage::save_image_rgba(app, w, h, rgba) {
        Ok(edited_file) => {
            let _ = app.emit_to(
                "main",
                NOTE_REPLACE_EVENT,
                NoteReplace {
                    operation_id: format!("{label}-{}", NEXT_EDITOR.load(Ordering::Relaxed)),
                    note_id: target.note_id,
                    data_generation: target.data_generation,
                    source_file: target.file,
                    edited_file,
                    width: w,
                    height: h,
                    caption,
                },
            );
        }
        Err(e) => {
            crate::diag::push(app, format!("标注图片写入失败：{e}"));
            crate::window::show_hud(
                app,
                "warn",
                crate::i18n::pick("标注图片保存失败", "Failed to save the annotated image").into(),
                false,
                false,
                None,
            );
        }
    }
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

    /// 静止帧不拼、跳太远的帧丢弃并报 stalled、接回后继续，点「完成」结束。
    #[test]
    fn manual_mode_skips_unaligned_frames_until_finished() {
        let content: Vec<u8> = (0..200).map(|i| (i * 13 % 251) as u8).collect();
        let mut st = Stitcher::new(page(&content[..60]), 2, 60);
        let tops = [0, 20, 120, 40];
        let mut n = 0;
        let mut capture = || {
            let top = tops[n.min(tops.len() - 1)];
            n += 1;
            if n == tops.len() {
                request_stop(false);
            }
            Ok((page(&content[top..top + 60]), 2, 60))
        };
        let mut stalls = Vec::new();
        let mut progress = |e: Event| {
            if let Event::Stalled(v) = e {
                stalls.push(v);
            }
        };
        let stop = follow(&mut st, &mut capture, &mut progress).unwrap();
        assert_eq!(stop, Stop::Finished);
        assert_eq!(stalls, vec![true, false]);
        assert!(st.out == page(&content[..100]));
    }

    /// 往回滚再往下：回滚与回到原位都不追加，越过已拼部分才接新内容。
    #[test]
    fn manual_scroll_back_does_not_duplicate() {
        let content: Vec<u8> = (0..200).map(|i| (i * 13 % 251) as u8).collect();
        let frame = |top: usize| page(&content[top..top + 60]);
        let mut st = Stitcher::new(frame(0), 2, 60);
        assert_eq!(st.push(&frame(30)), Push::Appended);
        assert_eq!(st.push(&frame(10)), Push::Moved);
        assert_eq!(st.push(&frame(25)), Push::Moved);
        assert_eq!(st.push(&frame(50)), Push::Appended);
        assert!(st.out == page(&content[..110]));
    }

    #[test]
    fn cancel_request_stops_with_cancelled() {
        let content: Vec<u8> = (0..200).map(|i| (i * 13 % 251) as u8).collect();
        let mut st = Stitcher::new(page(&content[..60]), 2, 60);
        let mut capture = || {
            request_stop(true);
            Ok((page(&content[..60]), 2, 60))
        };
        let stop = follow(&mut st, &mut capture, &mut |_| {}).unwrap();
        assert_eq!(stop, Stop::Cancelled);
    }

    #[test]
    fn panel_sits_beside_region_inside_display() {
        let display = RectPt {
            x: 0.0,
            y: 0.0,
            w: 1440.0,
            h: 900.0,
        };
        let r = |x, y, w, h| RectPt { x, y, w, h };
        let right = panel_rect(display, r(100.0, 100.0, 600.0, 500.0));
        assert_eq!((right.x, right.y, right.h), (712.0, 100.0, 500.0));
        let left = panel_rect(display, r(900.0, 100.0, 500.0, 200.0));
        assert_eq!((left.x, left.h), (900.0 - 12.0 - 220.0, 320.0));
        let full = panel_rect(display, r(0.0, 800.0, 1440.0, 100.0));
        assert_eq!(full.x, 1440.0 - 220.0 - 12.0);
        assert!(full.y + full.h <= 900.0 - 12.0);
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
            width: 0,
            height: 0,
            stalled: false,
        };
        // 源宽 = 预览宽 2 倍 → 预览每行取源第 2k 行
        let sw = PREVIEW_W * 2;
        let src: Vec<u8> = (0..sw * 10)
            .flat_map(|i| [(i / sw) as u8, 0, 0, 255])
            .collect();
        extend_preview(&mut p, &src[..sw * 4 * 4], sw, 4);
        assert_eq!(p.rows, 2);
        extend_preview(&mut p, &src, sw, 10);
        assert_eq!(p.rows, 5);
        assert_eq!(p.rgba.len(), 5 * PREVIEW_W * 4);
        assert_eq!(p.rgba[4 * PREVIEW_W * 4], 8, "第 4 行取源第 8 行");
    }
}
