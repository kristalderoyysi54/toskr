use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use image::{DynamicImage, Rgba, RgbaImage};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::privacy::{
    FindingCategory, FindingSeverity, ScanSensitiveRequest, FIREWALL_RULE_VERSION,
};

const TOKEN_PREFIX: &str = "toskr-redacted:";
const TRANSIENT_DIR: &str = "delivery-redactions";
const CACHE_LIMIT: usize = 32;
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const MASK_PADDING_PX: u32 = 2;
// 6K 屏幕截图约 20.4MP；25MP 同时给原 RGBA、遮挡副本和 PNG 编码留出内存余量。
const MAX_IMAGE_PIXELS: u64 = 25_000_000;
const MAX_OCR_OBSERVATIONS: usize = 4_096;
const MAX_MASK_REGIONS: usize = 4_096;
static REDACTION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelBox {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageOcrObservation {
    pub text: String,
    pub confidence: f32,
    pub bounding_box: NormalizedBox,
    pub image_width: u32,
    pub image_height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFirewallFinding {
    pub id: String,
    pub observation_index: usize,
    pub category: FindingCategory,
    pub severity: FindingSeverity,
    pub bounding_box: NormalizedBox,
    pub pixel_box: PixelBox,
    pub masked_preview: String,
    pub rule_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanImageFirewallResult {
    pub file: String,
    pub pixel_hash: String,
    pub rule_version: u32,
    pub image_width: u32,
    pub image_height: u32,
    pub cache_hit: bool,
    pub observations: Vec<ImageOcrObservation>,
    pub findings: Vec<ImageFirewallFinding>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactImageRequest {
    pub original_file: String,
    pub regions: Vec<PixelBox>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactImageResult {
    pub original_file: String,
    pub redacted_file: String,
    pub original_pixel_hash: String,
    pub redacted_pixel_hash: String,
    pub image_width: u32,
    pub image_height: u32,
}

#[derive(Clone)]
struct CachedScan {
    key: String,
    result: ScanImageFirewallResult,
    cached_at: Instant,
}

static SCAN_CACHE: OnceLock<Mutex<VecDeque<CachedScan>>> = OnceLock::new();
static OCR_PUNCTUATION_SPACING: OnceLock<Regex> = OnceLock::new();

fn finite(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

/// Vision 使用左下原点；前端与像素遮罩统一为左上原点，并先裁到图像边界。
pub(crate) fn vision_box_to_top_left(x: f64, y: f64, width: f64, height: f64) -> NormalizedBox {
    let left = finite(x).clamp(0.0, 1.0);
    let right = finite(x + width.max(0.0)).clamp(0.0, 1.0).max(left);
    let bottom = finite(y).clamp(0.0, 1.0);
    let top = finite(y + height.max(0.0)).clamp(0.0, 1.0).max(bottom);
    NormalizedBox {
        x: left,
        y: 1.0 - top,
        width: right - left,
        height: top - bottom,
    }
}

pub(crate) fn normalized_to_pixels(
    bounds: NormalizedBox,
    image_width: u32,
    image_height: u32,
    padding: u32,
) -> PixelBox {
    if image_width == 0 || image_height == 0 {
        return PixelBox {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
    }
    let left = (bounds.x.clamp(0.0, 1.0) * image_width as f64).floor() as u32;
    let top = (bounds.y.clamp(0.0, 1.0) * image_height as f64).floor() as u32;
    let right = ((bounds.x + bounds.width).clamp(0.0, 1.0) * image_width as f64).ceil() as u32;
    let bottom = ((bounds.y + bounds.height).clamp(0.0, 1.0) * image_height as f64).ceil() as u32;
    let x = left.saturating_sub(padding);
    let y = top.saturating_sub(padding);
    let right = right.saturating_add(padding).min(image_width);
    let bottom = bottom.saturating_add(padding).min(image_height);
    PixelBox {
        x,
        y,
        width: right.saturating_sub(x),
        height: bottom.saturating_sub(y),
    }
}

fn pixel_hash(image: &RgbaImage) -> String {
    crate::storage::content_hash(
        image.width() as usize,
        image.height() as usize,
        image.as_raw(),
    )
}

pub(crate) fn solid_redacted_copy(original: &RgbaImage, boxes: &[PixelBox]) -> RgbaImage {
    let mut redacted = original.clone();
    let fill = Rgba([20, 20, 22, 255]);
    for bounds in boxes {
        let right = bounds.x.saturating_add(bounds.width).min(redacted.width());
        let bottom = bounds
            .y
            .saturating_add(bounds.height)
            .min(redacted.height());
        for y in bounds.y.min(redacted.height())..bottom {
            for x in bounds.x.min(redacted.width())..right {
                redacted.put_pixel(x, y, fill);
            }
        }
    }
    redacted
}

pub(crate) fn cache_key(pixel_hash: &str) -> String {
    format!("{pixel_hash}:v{FIREWALL_RULE_VERSION}")
}

fn transient_root(app: &AppHandle) -> PathBuf {
    crate::storage::app_data_dir(app).join(TRANSIENT_DIR)
}

fn remove_root_entry(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).map_err(|error| format!("清理临时图片失败：{error}"))
    } else if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|error| format!("清理临时图片失败：{error}"))
    } else {
        Err("临时图片目录类型异常".into())
    }
}

pub(crate) fn initialize_transient_root(path: &Path) -> Result<(), String> {
    remove_root_entry(path)?;
    fs::create_dir_all(path).map_err(|error| format!("创建临时图片目录失败：{error}"))
}

fn ensure_transient_root(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err("临时图片目录类型异常".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|error| format!("创建临时图片目录失败：{error}"))
        }
        Err(error) => Err(format!("读取临时图片目录失败：{error}")),
    }
}

pub fn initialize_transient_store(app: &AppHandle) -> Result<(), String> {
    clear_scan_cache();
    initialize_transient_root(&transient_root(app))
}

fn clear_scan_cache() {
    if let Some(cache) = SCAN_CACHE.get() {
        if let Ok(mut cache) = cache.lock() {
            cache.clear();
        }
    }
}

fn safe_transient_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 180
        && name.ends_with(".png")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn token_name(token: &str) -> Option<&str> {
    let name = token.strip_prefix(TOKEN_PREFIX)?;
    safe_transient_name(name).then_some(name)
}

fn transient_file(app: &AppHandle, token: &str) -> Option<PathBuf> {
    let name = token_name(token)?;
    let path = transient_root(app).join(name);
    fs::symlink_metadata(&path)
        .ok()
        .filter(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .map(|_| path)
}

fn write_png_create_new(path: &Path, image: &RgbaImage) -> Result<(), String> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|error| format!("编码遮挡图片失败：{error}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("创建遮挡图片失败：{error}"))?;
    if let Err(error) = file
        .write_all(bytes.get_ref())
        .and_then(|_| file.sync_all())
    {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(format!("写入遮挡图片失败：{error}"));
    }
    Ok(())
}

fn redacted_name(redacted_pixel_hash: &str, sequence: u64) -> String {
    format!("redacted-{}-{sequence}.png", &redacted_pixel_hash[..32])
}

fn cached_scan(key: &str, file: &str) -> Option<ScanImageFirewallResult> {
    let mut cache = SCAN_CACHE.get_or_init(Default::default).lock().ok()?;
    cache.retain(|entry| entry.cached_at.elapsed() <= CACHE_TTL);
    let index = cache.iter().position(|entry| entry.key == key)?;
    let mut entry = cache.remove(index)?;
    entry.result.file = file.to_string();
    entry.result.cache_hit = true;
    let result = entry.result.clone();
    cache.push_back(entry);
    Some(result)
}

fn cached_scan_for_request(key: &str, file: &str, force: bool) -> Option<ScanImageFirewallResult> {
    if force {
        None
    } else {
        cached_scan(key, file)
    }
}

fn store_scan(key: String, result: &ScanImageFirewallResult) {
    let Ok(mut cache) = SCAN_CACHE.get_or_init(Default::default).lock() else {
        return;
    };
    cache.retain(|entry| entry.key != key);
    let mut cached_result = result.clone();
    // 跨 Draft 缓存只保留框、置信度和 finding；OCR 原文在首次 IPC 结算后不驻留。
    for observation in &mut cached_result.observations {
        observation.text.clear();
    }
    cache.push_back(CachedScan {
        key,
        result: cached_result,
        cached_at: Instant::now(),
    });
    while cache.len() > CACHE_LIMIT {
        cache.pop_front();
    }
}

fn image_dimensions_within_budget(width: u32, height: u32) -> bool {
    width > 0
        && height > 0
        && u64::from(width).saturating_mul(u64::from(height)) <= MAX_IMAGE_PIXELS
}

fn decode_image(bytes: &[u8]) -> Result<RgbaImage, String> {
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "图片格式无法识别".to_string())?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "图片尺寸无法读取".to_string())?;
    if !image_dimensions_within_budget(width, height) {
        return Err("图片尺寸超出本地隐私检查上限".into());
    }
    image::load_from_memory(bytes)
        .map_err(|_| "图片解码失败".to_string())
        .map(|image| image.to_rgba8())
}

pub(crate) fn findings_for_observation(
    observation_index: usize,
    text: &str,
    bounding_box: NormalizedBox,
    pixel_box: PixelBox,
) -> Vec<ImageFirewallFinding> {
    // Vision 偶尔会在邮箱/API key 标点两侧插入空白；只规范化规则输入，
    // observation.text 仍保留原始识别结果，坐标继续覆盖完整 observation。
    let normalized = OCR_PUNCTUATION_SPACING
        .get_or_init(|| Regex::new(r"[ \t]*([@=._])[ \t]*").expect("内建 OCR 归一化规则有效"))
        .replace_all(text, "$1");
    crate::privacy::scan_sensitive_text(ScanSensitiveRequest {
        text: normalized.into_owned(),
    })
    .findings
    .into_iter()
    .map(|finding| ImageFirewallFinding {
        id: format!("image-{observation_index}-{}", finding.id),
        observation_index,
        category: finding.category,
        severity: finding.severity,
        bounding_box,
        pixel_box,
        masked_preview: finding.masked_preview,
        rule_id: finding.rule_id,
    })
    .collect()
}

fn scan_uncached(
    file: &str,
    bytes: &[u8],
    original: &RgbaImage,
    source_pixel_hash: String,
) -> Result<ScanImageFirewallResult, String> {
    let width = original.width();
    let height = original.height();
    let recognized = crate::ocr::recognize_observations(bytes)?;
    if recognized.len() > MAX_OCR_OBSERVATIONS {
        return Err("图片文字区域过多，无法完整检查".into());
    }
    let mut observations = Vec::with_capacity(recognized.len());
    let mut findings = Vec::new();
    for (observation_index, recognized) in recognized.into_iter().enumerate() {
        let (x, y, box_width, box_height) = recognized.vision_box;
        let bounding_box = vision_box_to_top_left(x, y, box_width, box_height);
        let pixel_box = normalized_to_pixels(bounding_box, width, height, MASK_PADDING_PX);
        findings.extend(findings_for_observation(
            observation_index,
            &recognized.text,
            bounding_box,
            pixel_box,
        ));
        if findings.len() > MAX_MASK_REGIONS {
            return Err("图片敏感区域过多，无法完整检查".into());
        }
        observations.push(ImageOcrObservation {
            text: recognized.text,
            confidence: recognized.confidence,
            bounding_box,
            image_width: width,
            image_height: height,
        });
    }
    Ok(ScanImageFirewallResult {
        file: file.to_string(),
        pixel_hash: source_pixel_hash,
        rule_version: FIREWALL_RULE_VERSION,
        image_width: width,
        image_height: height,
        cache_hit: false,
        observations,
        findings,
    })
}

#[cfg(test)]
pub(crate) fn scan_fixture_bytes(
    file: &str,
    bytes: &[u8],
) -> Result<ScanImageFirewallResult, String> {
    let original = decode_image(bytes)?;
    scan_uncached(file, bytes, &original, pixel_hash(&original))
}

pub fn scan(app: &AppHandle, file: &str, force: bool) -> Result<ScanImageFirewallResult, String> {
    let bytes = crate::storage::read_image_bytes(app, file).ok_or("图片不存在或不可读取")?;
    let original = decode_image(&bytes)?;
    let pixel_hash = pixel_hash(&original);
    let key = cache_key(&pixel_hash);
    if let Some(result) = cached_scan_for_request(&key, file, force) {
        return Ok(result);
    }
    let started = Instant::now();
    let result = scan_uncached(file, &bytes, &original, pixel_hash)?;
    crate::diag::push(app, diagnostic_summary(&result, started.elapsed()));
    store_scan(key, &result);
    Ok(result)
}

pub fn diagnostic_summary(result: &ScanImageFirewallResult, elapsed: Duration) -> String {
    let block = result
        .findings
        .iter()
        .filter(|finding| finding.severity == FindingSeverity::Block)
        .count();
    let warn = result
        .findings
        .iter()
        .filter(|finding| finding.severity == FindingSeverity::Warn)
        .count();
    format!(
        "image_firewall observations={} findings={} block={} warn={} cache_hit={} elapsed_ms={}",
        result.observations.len(),
        result.findings.len(),
        block,
        warn,
        result.cache_hit,
        elapsed.as_millis(),
    )
}

pub fn redact(app: &AppHandle, request: RedactImageRequest) -> Result<RedactImageResult, String> {
    if request.regions.is_empty() {
        return Err("至少选择一个遮挡区域".into());
    }
    if request.regions.len() > MAX_MASK_REGIONS {
        return Err("遮挡区域数量超出上限".into());
    }
    let bytes = crate::storage::read_image_bytes(app, &request.original_file)
        .ok_or("原图不存在或不可读取")?;
    let original = decode_image(&bytes)?;
    let (width, height) = (original.width() as usize, original.height() as usize);
    let original_pixel_hash = pixel_hash(&original);
    let regions: Vec<_> = request
        .regions
        .into_iter()
        .map(|region| {
            normalized_to_pixels(
                NormalizedBox {
                    x: region.x as f64 / width.max(1) as f64,
                    y: region.y as f64 / height.max(1) as f64,
                    width: region.width as f64 / width.max(1) as f64,
                    height: region.height as f64 / height.max(1) as f64,
                },
                width as u32,
                height as u32,
                0,
            )
        })
        .filter(|region| region.width > 0 && region.height > 0)
        .collect();
    if regions.is_empty() {
        return Err("遮挡区域不在图片范围内".into());
    }
    let redacted = solid_redacted_copy(&original, &regions);
    let redacted_pixel_hash = pixel_hash(&redacted);
    let sequence = REDACTION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = redacted_name(&redacted_pixel_hash, sequence);
    let root = transient_root(app);
    ensure_transient_root(&root)?;
    write_png_create_new(&root.join(&name), &redacted)?;
    Ok(RedactImageResult {
        original_file: request.original_file,
        redacted_file: format!("{TOKEN_PREFIX}{name}"),
        original_pixel_hash,
        redacted_pixel_hash,
        image_width: width as u32,
        image_height: height as u32,
    })
}

fn cleanup_at(root: &Path, tokens: &[String]) -> Result<(), String> {
    for token in tokens {
        let Some(name) = token_name(token) else {
            continue;
        };
        let path = root.join(name);
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("拒绝清理异常临时图片".into());
        }
        fs::remove_file(path).map_err(|error| format!("清理遮挡图片失败：{error}"))?;
    }
    Ok(())
}

pub fn cleanup(app: &AppHandle, tokens: &[String]) -> Result<(), String> {
    cleanup_at(&transient_root(app), tokens)
}

pub fn clear_all(app: &AppHandle) -> Result<(), String> {
    clear_scan_cache();
    initialize_transient_root(&transient_root(app))
}

pub fn read_delivery_image_rgba(app: &AppHandle, file: &str) -> Option<(usize, usize, Vec<u8>)> {
    if !file.starts_with(TOKEN_PREFIX) {
        return crate::storage::read_image_rgba(app, file);
    }
    let bytes = fs::read(transient_file(app, file)?).ok()?;
    let image = image::load_from_memory(&bytes).ok()?.to_rgba8();
    Some((
        image.width() as usize,
        image.height() as usize,
        image.into_raw(),
    ))
}

pub fn delivery_image_data_url(app: &AppHandle, file: &str) -> Option<String> {
    if !file.starts_with(TOKEN_PREFIX) {
        return crate::storage::image_thumb_data_url(app, file);
    }
    let bytes = fs::read(transient_file(app, file)?).ok()?;
    let thumbnail = image::load_from_memory(&bytes).ok()?.thumbnail(320, 320);
    let mut png = Cursor::new(Vec::new());
    thumbnail.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png.get_ref())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};
    use tempfile::tempdir;

    #[test]
    fn vision_coordinates_become_clamped_top_left_pixel_boxes_at_retina_sizes() {
        let normalized = vision_box_to_top_left(0.125, 0.25, 0.5, 0.25);
        assert_eq!(
            normalized,
            NormalizedBox {
                x: 0.125,
                y: 0.5,
                width: 0.5,
                height: 0.25,
            }
        );
        assert_eq!(
            normalized_to_pixels(normalized, 800, 400, 0),
            PixelBox {
                x: 100,
                y: 200,
                width: 400,
                height: 100,
            }
        );
        assert_eq!(
            normalized_to_pixels(normalized, 1600, 800, 0),
            PixelBox {
                x: 200,
                y: 400,
                width: 800,
                height: 200,
            }
        );

        let rotated_edge = vision_box_to_top_left(-0.02, 0.92, 0.25, 0.2);
        assert_eq!(
            normalized_to_pixels(rotated_edge, 100, 50, 2),
            PixelBox {
                x: 0,
                y: 0,
                width: 25,
                height: 6,
            }
        );
    }

    #[test]
    fn solid_mask_produces_new_pixels_without_mutating_original() {
        let original = RgbaImage::from_pixel(12, 8, Rgba([240, 240, 240, 255]));
        let before = pixel_hash(&original);
        let redacted = solid_redacted_copy(
            &original,
            &[PixelBox {
                x: 2,
                y: 1,
                width: 5,
                height: 3,
            }],
        );

        assert_eq!(pixel_hash(&original), before);
        assert_ne!(pixel_hash(&redacted), before);
        assert_eq!(redacted.get_pixel(3, 2), &Rgba([20, 20, 22, 255]));
        assert_eq!(original.get_pixel(3, 2), &Rgba([240, 240, 240, 255]));
    }

    #[test]
    fn transient_cleanup_never_touches_original_and_restart_removes_stale_copy() {
        let temp = tempdir().unwrap();
        let original = temp.path().join("img-original.png");
        std::fs::write(&original, b"original").unwrap();
        let transient = temp.path().join("delivery-redactions");
        initialize_transient_root(&transient).unwrap();
        let name = redacted_name(&"a".repeat(64), 7);
        assert!(name.contains(&"a".repeat(32)));
        let owned = transient.join(&name);
        std::fs::write(&owned, b"redacted").unwrap();

        cleanup_at(
            &transient,
            &["img-original.png".into(), format!("{TOKEN_PREFIX}{name}")],
        )
        .unwrap();

        assert!(original.exists());
        assert!(!owned.exists());
        std::fs::write(&owned, b"crash-stale-redacted").unwrap();

        initialize_transient_root(&transient).unwrap();

        assert!(original.exists());
        assert!(!owned.exists());
        assert!(transient.is_dir());
    }

    #[test]
    fn cache_key_binds_pixel_hash_and_firewall_rule_version() {
        assert_eq!(
            cache_key("abc"),
            format!("abc:v{}", crate::privacy::FIREWALL_RULE_VERSION)
        );
    }

    #[test]
    fn scan_cache_keeps_geometry_but_never_retains_ocr_text() {
        clear_scan_cache();
        let result = ScanImageFirewallResult {
            file: "first.png".into(),
            pixel_hash: "a".repeat(64),
            rule_version: FIREWALL_RULE_VERSION,
            image_width: 100,
            image_height: 50,
            cache_hit: false,
            observations: vec![ImageOcrObservation {
                text: "synthetic-secret@example.test".into(),
                confidence: 0.95,
                bounding_box: NormalizedBox {
                    x: 0.1,
                    y: 0.2,
                    width: 0.4,
                    height: 0.2,
                },
                image_width: 100,
                image_height: 50,
            }],
            findings: vec![],
        };
        let key = cache_key(&result.pixel_hash);
        store_scan(key.clone(), &result);

        assert!(cached_scan_for_request(&key, "forced.png", true).is_none());
        let cached = cached_scan_for_request(&key, "second.png", false).expect("cache hit");
        assert!(cached.cache_hit);
        assert_eq!(cached.file, "second.png");
        assert_eq!(cached.observations.len(), 1);
        assert!(cached.observations[0].text.is_empty());
        assert_eq!(
            cached.observations[0].bounding_box,
            result.observations[0].bounding_box
        );
        clear_scan_cache();
    }

    #[test]
    fn image_budget_accepts_a_6k_screen_but_rejects_memory_heavy_inputs() {
        assert!(image_dimensions_within_budget(6_016, 3_384));
        assert!(!image_dimensions_within_budget(8_000, 4_000));
    }

    #[test]
    fn scan_diagnostic_never_contains_ocr_text_or_regions() {
        let result = ScanImageFirewallResult {
            file: "img.png".into(),
            pixel_hash: "hash".into(),
            rule_version: 1,
            image_width: 100,
            image_height: 80,
            cache_hit: false,
            observations: vec![ImageOcrObservation {
                text: "sk-secret-must-not-be-logged".into(),
                confidence: 0.98,
                bounding_box: NormalizedBox {
                    x: 0.1,
                    y: 0.2,
                    width: 0.3,
                    height: 0.1,
                },
                image_width: 100,
                image_height: 80,
            }],
            findings: Vec::new(),
        };
        let summary = diagnostic_summary(&result, std::time::Duration::from_millis(4));
        assert!(!summary.contains("sk-secret"));
        assert!(!summary.contains("0.1"));
        assert!(summary.contains("observations=1"));
    }

    #[test]
    fn multiline_observations_keep_independent_boxes_and_severity() {
        let first_box = NormalizedBox {
            x: 0.1,
            y: 0.1,
            width: 0.5,
            height: 0.1,
        };
        let second_box = NormalizedBox {
            x: 0.2,
            y: 0.6,
            width: 0.6,
            height: 0.15,
        };
        let first_pixels = PixelBox {
            x: 10,
            y: 10,
            width: 50,
            height: 10,
        };
        let second_pixels = PixelBox {
            x: 20,
            y: 60,
            width: 60,
            height: 15,
        };
        let first = findings_for_observation(0, "alice@example.com", first_box, first_pixels);
        let second =
            findings_for_observation(1, "api_key=abcdefghijklmnop", second_box, second_pixels);

        assert_eq!(first[0].observation_index, 0);
        assert_eq!(first[0].bounding_box, first_box);
        assert_eq!(first[0].pixel_box, first_pixels);
        assert_eq!(first[0].severity, FindingSeverity::Warn);
        assert_eq!(second[0].observation_index, 1);
        assert_eq!(second[0].bounding_box, second_box);
        assert_eq!(second[0].pixel_box, second_pixels);
        assert_eq!(second[0].severity, FindingSeverity::Block);
    }

    #[test]
    fn ocr_spacing_noise_around_email_and_assignment_punctuation_is_normalized_for_scan() {
        let findings = findings_for_observation(
            0,
            "email: fake.user @example.test  api_key = sk_test_1234567890abcdef",
            NormalizedBox {
                x: 0.1,
                y: 0.1,
                width: 0.8,
                height: 0.2,
            },
            PixelBox {
                x: 10,
                y: 10,
                width: 80,
                height: 20,
            },
        );
        assert!(findings
            .iter()
            .any(|finding| finding.category == FindingCategory::Email));
        assert!(findings
            .iter()
            .any(|finding| finding.category == FindingCategory::ApiKey));
    }

    #[test]
    fn ocr_and_finding_serde_contract_is_camel_case() {
        let observation = ImageOcrObservation {
            text: "fake@example.com".into(),
            confidence: 0.9,
            bounding_box: NormalizedBox {
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.1,
            },
            image_width: 200,
            image_height: 100,
        };
        let finding = findings_for_observation(
            0,
            &observation.text,
            observation.bounding_box,
            PixelBox {
                x: 20,
                y: 20,
                width: 60,
                height: 10,
            },
        )
        .remove(0);
        let json = serde_json::to_value(ScanImageFirewallResult {
            file: "img.png".into(),
            pixel_hash: "a".repeat(64),
            rule_version: FIREWALL_RULE_VERSION,
            image_width: 200,
            image_height: 100,
            cache_hit: false,
            observations: vec![observation],
            findings: vec![finding],
        })
        .unwrap();

        assert_eq!(json["observations"][0]["imageWidth"], 200);
        assert!(json["observations"][0].get("boundingBox").is_some());
        assert!(json["findings"][0].get("observationIndex").is_some());
        assert!(json["findings"][0].get("pixelBox").is_some());
        assert_eq!(json["findings"][0]["category"], "email");
    }
}
