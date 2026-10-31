//! 长截屏：光标移到选区中央，合成滚轮事件逐段下滚，每段截取选区，
//! 按相邻两帧重叠的像素行拼接。到底（画面不再变化）、超长、或用户动了鼠标即停。

use core_graphics::geometry::CGPoint;

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

/// 自动滚动拼接。`capture` 截取选区返回 (RGBA, 宽, 高)；`region` 为全局 pt 选区。
pub fn run(
    region: (f64, f64, f64, f64),
    mut capture: impl FnMut() -> Result<(Vec<u8>, usize, usize), String>,
) -> Result<(Vec<u8>, usize, usize, Stop), String> {
    let (rx, ry, rw, rh) = region;
    let center = CGPoint::new(rx + rw / 2.0, ry + rh / 2.0);
    let _ = core_graphics::display::CGDisplay::warp_mouse_cursor_position(center);
    std::thread::sleep(std::time::Duration::from_millis(120));

    let (first, w, h) = capture()?;
    let mut prev = row_signatures(&first, w, h);
    let mut out = first;
    let mut total_h = h;
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
        let sig = row_signatures(&frame, w, h);
        if sig == prev {
            stop = Stop::Bottom;
            break;
        }
        let Some(dy) = scroll_offset(&prev, &sig) else {
            stop = Stop::NoOverlap;
            break;
        };
        // 新内容 = 新帧末尾 dy 行
        out.extend_from_slice(&frame[(h - dy) * w * 4..]);
        total_h += dy;
        prev = sig;
        if w * total_h >= MAX_PIXELS {
            stop = Stop::Limit;
            break;
        }
    }
    Ok((out, w, total_h, stop))
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
}
