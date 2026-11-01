//! ScreenCaptureKit 冻结帧（macOS 14+）：进程内截屏、排除本应用窗口，
//! 像素按 BGRA 原样包成 32 位 BMP 交给遮罩窗（免 PNG 编码）。失败由调用方回退 screencapture。
//! 长截屏改走 SCStream 连续取帧。

use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_graphics::{CGDataProvider, CGImage};
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSArray, NSError};
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamOutput, SCStreamOutputType,
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

/// 指定屏的内容过滤器与 pt→像素比、屏 pt 尺寸。`exclude_self` 时排除本应用窗口。
fn display_filter(
    content: &SCShareableContent,
    id: u32,
    exclude_self: bool,
) -> Result<(Retained<SCContentFilter>, f64, f64, f64), String> {
    let me = std::process::id() as i32;
    let apps = unsafe { content.applications() };
    let own: Vec<_> = apps
        .iter()
        .filter(|a| exclude_self && unsafe { a.processID() } == me)
        .collect();
    let excluded = NSArray::from_retained_slice(&own);
    let displays = unsafe { content.displays() };
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
    let (w, h) = unsafe { (display.width() as f64, display.height() as f64) };
    Ok((filter, scale, w, h))
}

fn base_config(px_w: usize, px_h: usize) -> Retained<SCStreamConfiguration> {
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(px_w);
        config.setHeight(px_h);
        config.setShowsCursor(false);
        config.setPixelFormat(PIXEL_FORMAT_BGRA);
        // 转到 sRGB：BMP 不带色彩配置，浏览器按 sRGB 解读
        config.setColorSpaceName(objc2_core_graphics::kCGColorSpaceSRGB);
    }
    config
}

/// SCStream 回调线程写入、拼接线程取走的最新一帧（RGBA 紧排）。
#[derive(Default)]
struct Latest {
    frame: Option<(Vec<u8>, usize, usize)>,
    seq: u64,
}

struct Shared {
    latest: Mutex<Latest>,
    ready: Condvar,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "ToskrLongShotFrameSink"]
    #[ivars = Arc<Shared>]
    struct FrameSink;

    unsafe impl NSObjectProtocol for FrameSink {}

    unsafe impl SCStreamOutput for FrameSink {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn did_output(&self, _stream: &SCStream, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
            if kind != SCStreamOutputType::Screen {
                return;
            }
            // 画面没变时系统发的「空闲」样本不带像素
            let Some(frame) = unsafe { sample.image_buffer() }.and_then(|b| copy_rgba(&b)) else {
                return;
            };
            let shared = self.ivars();
            let mut latest = shared.latest.lock().unwrap();
            latest.frame = Some(frame);
            latest.seq += 1;
            shared.ready.notify_all();
        }
    }
);

impl FrameSink {
    fn new(shared: Arc<Shared>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(shared);
        unsafe { msg_send![super(this), init] }
    }
}

/// 像素缓冲（BGRA）→ RGBA 紧排。
fn copy_rgba(buffer: &CVPixelBuffer) -> Option<(Vec<u8>, usize, usize)> {
    if unsafe { CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) } != 0 {
        return None;
    }
    let (w, h, stride) = (
        CVPixelBufferGetWidth(buffer),
        CVPixelBufferGetHeight(buffer),
        CVPixelBufferGetBytesPerRow(buffer),
    );
    let base = CVPixelBufferGetBaseAddress(buffer) as *const u8;
    let out = (!base.is_null() && stride >= w * 4).then(|| {
        let src = unsafe { std::slice::from_raw_parts(base, stride * h) };
        let mut out = Vec::with_capacity(w * h * 4);
        for row in src.chunks_exact(stride) {
            for px in row[..w * 4].chunks_exact(4) {
                out.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
            }
        }
        out
    });
    unsafe { CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) };
    out.map(|o| (o, w, h))
}

/// 长截屏连续取帧（本屏 pt 区域）：SCStream 最高 60 帧/秒推送，拼接线程只取最新一帧。
/// 逐帧调 SCScreenshotManager 每帧要 40ms 以上，稍快的滚动就超出两帧重叠。
pub struct RegionStream {
    stream: Retained<SCStream>,
    _sink: Retained<FrameSink>,
    shared: Arc<Shared>,
    seen: u64,
    last: Option<(Vec<u8>, usize, usize)>,
}

impl RegionStream {
    pub fn start(id: u32, (x, y, w, h): (f64, f64, f64, f64)) -> Result<Self, String> {
        let content = shareable_content()?;
        // 选区边框与预览面板是本应用窗口，始终排除
        let (filter, scale, _, _) = display_filter(&content, id, true)?;
        let config = base_config((w * scale).round() as usize, (h * scale).round() as usize);
        unsafe {
            config.setSourceRect(objc2_core_foundation::CGRect::new(
                objc2_core_foundation::CGPoint::new(x, y),
                objc2_core_foundation::CGSize::new(w, h),
            ));
            config.setMinimumFrameInterval(CMTime::new(1, 60));
        }
        let shared = Arc::new(Shared {
            latest: Mutex::new(Latest::default()),
            ready: Condvar::new(),
        });
        let sink = FrameSink::new(shared.clone());
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &config,
                None,
            )
        };
        let queue = DispatchQueue::new("com.toskr.longshot", None);
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*sink),
                SCStreamOutputType::Screen,
                Some(&queue),
            )
        }
        .map_err(|e| e.to_string())?;
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |err: *mut NSError| {
            let _ = tx.send(err.is_null());
        });
        unsafe { stream.startCaptureWithCompletionHandler(Some(&block)) };
        if rx.recv_timeout(TIMEOUT) != Ok(true) {
            return Err("region stream start failed".into());
        }
        Ok(Self {
            stream,
            _sink: sink,
            shared,
            seen: 0,
            last: None,
        })
    }

    /// 等下一帧（最多 `wait`，首帧最多 3 秒），返回 RGBA 与像素尺寸；画面静止没有新帧时返回上一帧。
    pub fn next_frame(&mut self, wait: Duration) -> Result<(Vec<u8>, usize, usize), String> {
        let seen = self.seen;
        let wait = if self.last.is_some() { wait } else { TIMEOUT };
        let guard = self.shared.latest.lock().unwrap();
        let (mut latest, _) = self
            .shared
            .ready
            .wait_timeout_while(guard, wait, |l| l.seq == seen)
            .unwrap();
        if let Some(frame) = latest.frame.take().filter(|_| latest.seq != seen) {
            self.seen = latest.seq;
            drop(latest);
            self.last = Some(frame.clone());
            return Ok(frame);
        }
        drop(latest);
        self.last
            .clone()
            .ok_or_else(|| "region stream: no frame".to_string())
    }
}

impl Drop for RegionStream {
    fn drop(&mut self) {
        unsafe { self.stream.stopCaptureWithCompletionHandler(None) };
    }
}

/// 按 `ids` 顺序截各屏；任一屏失败整体报错（调用方回退）。
pub fn capture(ids: &[u32]) -> Result<Vec<Shot>, String> {
    let content = shareable_content()?;
    let mut pending = Vec::with_capacity(ids.len());
    for &id in ids {
        let (filter, scale, w, h) = display_filter(&content, id, crate::screenshot::hides_self())?;
        let config = base_config((w * scale).round() as usize, (h * scale).round() as usize);
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

/// CGImage（32 位 BGRA）的原始像素、宽、高、行跨度；格式不符返回 None。
fn bgra_pixels(image: &CGImage) -> Option<(Vec<u8>, usize, usize, usize)> {
    let img = Some(image);
    let (w, h) = (CGImage::width(img), CGImage::height(img));
    if CGImage::bits_per_pixel(img) != 32 || w == 0 || h == 0 {
        return None;
    }
    let stride = CGImage::bytes_per_row(img);
    let data = CGDataProvider::data(CGImage::data_provider(img).as_deref())?;
    let src = data.to_vec();
    (src.len() >= stride * (h - 1) + w * 4).then_some((src, w, h, stride))
}

/// CGImage → 自顶向下 32 位 BMP。
fn to_bmp(image: &CGImage) -> Option<Shot> {
    let (src, w, h, stride) = bgra_pixels(image)?;
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

    /// 手动：`cargo test sck_region_smoke -- --ignored --nocapture`（需屏幕录制授权）。
    #[test]
    #[ignore]
    fn sck_region_smoke() {
        let id = core_graphics::display::CGDisplay::active_displays().unwrap()[0];
        let t = std::time::Instant::now();
        let mut cap = RegionStream::start(id, (100.0, 100.0, 300.0, 200.0)).unwrap();
        println!("setup {}ms", t.elapsed().as_millis());
        for _ in 0..5 {
            let t = std::time::Instant::now();
            let (rgba, w, h) = cap.next_frame(Duration::from_millis(100)).unwrap();
            println!("region {w}x{h} {}ms", t.elapsed().as_millis());
            assert_eq!(rgba.len(), w * h * 4);
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
