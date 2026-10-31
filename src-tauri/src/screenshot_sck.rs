//! ScreenCaptureKit 冻结帧（macOS 14+）：进程内截屏、排除本应用窗口，
//! 像素按 BGRA 原样包成 32 位 BMP 交给遮罩窗（免 PNG 编码）。失败由调用方回退 screencapture。

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_core_graphics::{CGDataProvider, CGImage};
use objc2_foundation::{NSArray, NSError};
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration,
};

/// kCVPixelFormatType_32BGRA（'BGRA'）。
const PIXEL_FORMAT_BGRA: u32 = u32::from_be_bytes(*b"BGRA");
const TIMEOUT: Duration = Duration::from_secs(3);

pub struct Shot {
    pub bmp: Vec<u8>,
    pub px_w: u32,
    pub px_h: u32,
}

pub fn supported() -> bool {
    objc2::available!(macos = 14.0)
}

fn shareable_content() -> Result<Retained<SCShareableContent>, String> {
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(
        move |content: *mut SCShareableContent, _err: *mut NSError| {
            let _ = tx.send(unsafe { Retained::retain(content) });
        },
    );
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            false, true, &block,
        );
    }
    rx.recv_timeout(TIMEOUT)
        .map_err(|_| "shareable content timeout".to_string())?
        .ok_or_else(|| "shareable content unavailable".to_string())
}

/// 按 `ids` 顺序截各屏；任一屏失败整体报错（调用方回退）。
pub fn capture(ids: &[u32]) -> Result<Vec<Shot>, String> {
    let content = shareable_content()?;
    let me = std::process::id() as i32;
    let apps = unsafe { content.applications() };
    let own: Vec<_> = apps
        .iter()
        .filter(|a| unsafe { a.processID() } == me)
        .collect();
    let excluded = NSArray::from_retained_slice(&own);
    let displays = unsafe { content.displays() };

    let mut pending = Vec::with_capacity(ids.len());
    for &id in ids {
        let display = displays
            .iter()
            .find(|d| unsafe { d.displayID() } == id)
            .ok_or_else(|| format!("display {id} not shareable"))?;
        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                SCContentFilter::alloc(),
                &display,
                &excluded,
                &NSArray::new(),
            )
        };
        let scale = unsafe { filter.pointPixelScale() } as f64;
        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setWidth((display.width() as f64 * scale).round() as usize);
            config.setHeight((display.height() as f64 * scale).round() as usize);
            config.setShowsCursor(false);
            config.setPixelFormat(PIXEL_FORMAT_BGRA);
            // 转到 sRGB：BMP 不带色彩配置，浏览器按 sRGB 解读
            config.setColorSpaceName(objc2_core_graphics::kCGColorSpaceSRGB);
        }
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |image: *mut CGImage, _err: *mut NSError| {
            let _ = tx.send(unsafe { image.as_ref() }.and_then(to_bmp));
        });
        unsafe {
            SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                &filter,
                &config,
                Some(&block),
            );
        }
        pending.push((id, rx));
    }
    pending
        .into_iter()
        .map(|(id, rx)| {
            rx.recv_timeout(TIMEOUT)
                .map_err(|_| format!("display {id} capture timeout"))?
                .ok_or_else(|| format!("display {id} capture failed"))
        })
        .collect()
}

/// CGImage（32 位 BGRA）→ 自顶向下 32 位 BMP；格式不符返回 None。
fn to_bmp(image: &CGImage) -> Option<Shot> {
    let img = Some(image);
    let (w, h) = (CGImage::width(img), CGImage::height(img));
    if CGImage::bits_per_pixel(img) != 32 || w == 0 || h == 0 {
        return None;
    }
    let stride = CGImage::bytes_per_row(img);
    let data = CGDataProvider::data(CGImage::data_provider(img).as_deref())?;
    let src = data.to_vec();
    if src.len() < stride * (h - 1) + w * 4 {
        return None;
    }
    Some(Shot {
        bmp: bmp_from_bgra(&src, w, h, stride),
        px_w: w as u32,
        px_h: h as u32,
    })
}

/// 32 位 BI_RGB BMP（负高度 = 自顶向下），逐行去掉 stride 填充。
pub(crate) fn bmp_from_bgra(src: &[u8], w: usize, h: usize, stride: usize) -> Vec<u8> {
    const HEADER: usize = 14 + 40;
    let row = w * 4;
    let size = HEADER + row * h;
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(size as u32).to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(HEADER as u32).to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(w as i32).to_le_bytes());
    out.extend_from_slice(&(-(h as i32)).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&((row * h) as u32).to_le_bytes());
    out.extend_from_slice(&[0; 16]);
    for y in 0..h {
        out.extend_from_slice(&src[y * stride..y * stride + row]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手动：`cargo test sck_capture_smoke -- --ignored --nocapture`（需屏幕录制授权）。
    #[test]
    #[ignore]
    fn sck_capture_smoke() {
        let ids = core_graphics::display::CGDisplay::active_displays().unwrap();
        for round in 0..3 {
            let t = std::time::Instant::now();
            let shots = capture(&ids).unwrap();
            println!(
                "sck 第{round}轮 {} 屏 {}ms",
                shots.len(),
                t.elapsed().as_millis()
            );
        }
    }

    #[test]
    fn bmp_strips_row_padding_and_is_top_down() {
        // 2×2，stride 12（每行 4 字节填充）
        let src = [
            1, 2, 3, 255, 4, 5, 6, 255, 0, 0, 0, 0, //
            7, 8, 9, 255, 10, 11, 12, 255, 0, 0, 0, 0,
        ];
        let bmp = bmp_from_bgra(&src, 2, 2, 12);
        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(bmp.len(), 54 + 16);
        assert_eq!(i32::from_le_bytes(bmp[22..26].try_into().unwrap()), -2);
        assert_eq!(
            &bmp[54..],
            &[1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]
        );
    }
}
