//! 数据存储层：可自定义的数据文件夹 + 笔记 JSON + 图片附件。
//!
//! 布局：
//!   <dataDir>/toskr-data.json    笔记与设置（前端 zustand persist 的后端）
//!   <dataDir>/media/*.png         图片捕获附件
//!
//! dataDir 默认是应用数据目录，可在设置里改到任意文件夹（如 iCloud/同步盘）。
//! 切换目录时把已有数据文件与 media 一并搬过去，避免用户数据割裂。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

pub const DATA_FILE: &str = "toskr-data.json";
pub const MEDIA_DIR: &str = "media";
/// 记录用户自定义数据目录的小配置（始终位于应用数据目录，避免鸡生蛋问题）。
const DIR_CONFIG: &str = "toskr-datadir.txt";

#[derive(Default)]
pub struct Storage(pub Mutex<Option<PathBuf>>);

pub(crate) fn app_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 当前生效的数据目录（已确保存在）。
pub fn data_dir(app: &AppHandle) -> PathBuf {
    let state = app.state::<Storage>();
    let mut cached = state.0.lock().unwrap();
    if cached.is_none() {
        let base = app_data_dir(app);
        let _ = fs::create_dir_all(&base);
        // 读用户自定义目录；不存在或已失效则回落到应用数据目录
        let custom = fs::read_to_string(base.join(DIR_CONFIG))
            .ok()
            .map(|s| PathBuf::from(s.trim()))
            .filter(|p| p.is_dir());
        *cached = Some(custom.unwrap_or(base));
    }
    let dir = cached.clone().unwrap();
    let _ = fs::create_dir_all(&dir);
    let _ = fs::create_dir_all(dir.join(MEDIA_DIR));
    dir
}

/// 切换数据目录：搬运数据文件与 media，然后记录新路径。
pub fn set_data_dir(app: &AppHandle, new_dir: &Path) -> Result<(), String> {
    if !new_dir.is_dir() {
        return Err("目标不是有效文件夹".into());
    }
    let old = data_dir(app);
    if old == new_dir {
        return Ok(());
    }
    fs::create_dir_all(new_dir.join(MEDIA_DIR)).map_err(|e| e.to_string())?;

    // 数据文件：仅当目标没有同名文件时搬运，避免覆盖对方已有数据
    let old_data = old.join(DATA_FILE);
    let new_data = new_dir.join(DATA_FILE);
    if old_data.is_file() && !new_data.is_file() {
        fs::copy(&old_data, &new_data).map_err(|e| e.to_string())?;
    }
    // 图片附件逐个搬运（同名跳过）
    if let Ok(entries) = fs::read_dir(old.join(MEDIA_DIR)) {
        for entry in entries.flatten() {
            let target = new_dir.join(MEDIA_DIR).join(entry.file_name());
            if !target.exists() {
                let _ = fs::copy(entry.path(), target);
            }
        }
    }

    let base = app_data_dir(app);
    let _ = fs::create_dir_all(&base);
    fs::write(base.join(DIR_CONFIG), new_dir.to_string_lossy().as_bytes())
        .map_err(|e| e.to_string())?;
    *app.state::<Storage>().0.lock().unwrap() = Some(new_dir.to_path_buf());
    Ok(())
}

/// 恢复默认数据目录（应用数据目录）。
pub fn reset_data_dir(app: &AppHandle) -> Result<(), String> {
    let base = app_data_dir(app);
    let _ = fs::remove_file(base.join(DIR_CONFIG));
    *app.state::<Storage>().0.lock().unwrap() = None;
    data_dir(app);
    Ok(())
}

/// 读笔记 JSON（不存在返回 None，由前端回落到旧存储做一次性迁移）。
pub fn read_data(app: &AppHandle) -> Option<String> {
    fs::read_to_string(data_dir(app).join(DATA_FILE)).ok()
}

/// 写笔记 JSON（先写临时文件再原子替换，防写入中断损坏）。
pub fn write_data(app: &AppHandle, content: &str) -> Result<(), String> {
    let dir = data_dir(app);
    let tmp = dir.join(format!("{DATA_FILE}.tmp"));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join(DATA_FILE)).map_err(|e| e.to_string())
}

/// 像素内容的 64 位 FNV-1a 哈希：相同图片得到相同文件名，天然去重。
fn content_hash(width: usize, height: usize, rgba: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |b: u8| {
        h ^= b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    };
    for b in (width as u64).to_le_bytes() {
        mix(b);
    }
    for b in (height as u64).to_le_bytes() {
        mix(b);
    }
    // 大图逐字节哈希开销大，按步长采样 + 长度参与，冲突概率足够低
    let step = (rgba.len() / 4096).max(1);
    for b in rgba.iter().step_by(step) {
        mix(*b);
    }
    for b in (rgba.len() as u64).to_le_bytes() {
        mix(b);
    }
    h
}

/// 保存 RGBA 图片为 PNG，返回相对 media 目录的文件名。
/// 内容相同则复用已存在的文件（不重复写盘，供前端按文件名去重）。
pub fn save_image_rgba(
    app: &AppHandle,
    width: usize,
    height: usize,
    rgba: &[u8],
) -> Result<String, String> {
    let name = format!("img-{:016x}.png", content_hash(width, height, rgba));
    let path = data_dir(app).join(MEDIA_DIR).join(&name);
    if path.is_file() {
        return Ok(name);
    }
    let buf = image::RgbaImage::from_raw(width as u32, height as u32, rgba.to_vec())
        .ok_or("图片数据尺寸不匹配")?;
    buf.save(&path).map_err(|e| e.to_string())?;
    Ok(name)
}

/// 读取图片为 data URL（前端 <img> 直接用；不存在返回 None）。
pub fn image_data_url(app: &AppHandle, name: &str) -> Option<String> {
    use base64::Engine;
    // 只允许纯文件名，杜绝路径穿越
    if name.contains('/') || name.contains("..") {
        return None;
    }
    let bytes = fs::read(data_dir(app).join(MEDIA_DIR).join(name)).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:image/png;base64,{b64}"))
}

/// 卡片缩略图 data URL：按需生成并落盘缓存（media/thumbs/<name>，最长边 320px）。
/// 原图按像素哈希命名不可变 → 缩略图永不失效。全尺寸解码只发生一次；
/// 之后前端拿到的是 KB 级小图，卡片列表滚动/切页不再反复解码大位图。
pub fn image_thumb_data_url(app: &AppHandle, name: &str) -> Option<String> {
    use base64::Engine;
    if name.contains('/') || name.contains("..") {
        return None;
    }
    let media = data_dir(app).join(MEDIA_DIR);
    let tdir = media.join("thumbs");
    let tpath = tdir.join(name);
    if !tpath.exists() {
        let src = media.join(name);
        let img = image::open(&src).ok()?;
        if img.width() <= 320 && img.height() <= 320 {
            // 小图直接用原图，不再多存一份
            let bytes = fs::read(&src).ok()?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
            return Some(format!("data:image/png;base64,{b64}"));
        }
        fs::create_dir_all(&tdir).ok()?;
        let thumb = img.thumbnail(320, 320);
        thumb.save_with_format(&tpath, image::ImageFormat::Png).ok()?;
    }
    let bytes = fs::read(&tpath).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:image/png;base64,{b64}"))
}

/// 读取图片附件原始字节（OCR 用；不存在返回 None）。
pub fn read_image_bytes(app: &AppHandle, name: &str) -> Option<Vec<u8>> {
    if name.contains('/') || name.contains("..") {
        return None;
    }
    fs::read(data_dir(app).join(MEDIA_DIR).join(name)).ok()
}

/// 读取图片附件为 RGBA 像素（写入剪贴板用）。
pub fn read_image_rgba(app: &AppHandle, name: &str) -> Option<(usize, usize, Vec<u8>)> {
    if name.contains('/') || name.contains("..") {
        return None;
    }
    let bytes = fs::read(data_dir(app).join(MEDIA_DIR).join(name)).ok()?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    Some((w, h, img.into_raw()))
}

/// 图片附件绝对路径（Quick Look 预览用；含文件名安全检查，不存在返回 None）。
pub fn image_path(app: &AppHandle, name: &str) -> Option<std::path::PathBuf> {
    if name.contains('/') || name.contains("..") {
        return None;
    }
    let p = data_dir(app).join(MEDIA_DIR).join(name);
    p.exists().then_some(p)
}

/// 删除图片附件（卡片删除时清理；缩略图缓存一并清）。
pub fn remove_image(app: &AppHandle, name: &str) {
    if name.contains('/') || name.contains("..") {
        return;
    }
    let media = data_dir(app).join(MEDIA_DIR);
    let _ = fs::remove_file(media.join(name));
    let _ = fs::remove_file(media.join("thumbs").join(name));
}
