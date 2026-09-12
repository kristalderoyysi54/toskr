//! 域名 → 本地媒体库图标：抓站点 HTML 拿 `<link rel=icon>`（复用 linkmeta 解析），
//! 下载图标字节、image 解码、`save_image_rgba` 落盘（内容寻址去重，与笔记图片
//! 同一套 GC/备份）。失败即 Err，前端回退首字色块，不重试不排队。
//!
//! 与 linkmeta 拆开：那边是「抓标题+猜图标 URL」的纯 HTTP 解析，这边多了
//! 图片 IO 与媒体库写入，职责不同。

use tauri::AppHandle;

use crate::linkmeta::extract_meta;
use crate::storage::save_image_rgba;

/// 图标文件大小上限（比 og 图小得多，1MB 足够并防 zip bomb 型 PNG）。
const MAX_ICON_BYTES: usize = 1024 * 1024;

#[tauri::command]
pub async fn fetch_favicon(app: AppHandle, domain: String) -> Result<String, String> {
    let domain = sanitize_domain(&domain)?;
    let fallback = format!("https://{domain}/favicon.ico");
    let mut candidates = Vec::new();
    if let Ok((body, effective)) = crate::preview_network::fetch(&format!("https://{domain}"), 3 * 1024 * 1024, None).await {
        if let Some(icon) = extract_meta(&String::from_utf8_lossy(&body), effective.as_str()).icon {
            if icon != fallback { candidates.push(icon); }
        }
    }
    candidates.push(fallback);
    for url in candidates {
        if let Ok(image) = download_icon(&url, None).await {
            return save_image_rgba(&app, image.width() as usize, image.height() as usize, image.as_raw());
        }
    }
    Err("未找到可用图标".into())
}

/// 域名白名单校验：仅主机名字符，杜绝把任意 URL/本地路径塞进 curl。
fn sanitize_domain(input: &str) -> Result<String, String> {
    let d = input.trim().trim_end_matches('/').to_ascii_lowercase();
    let valid = !d.is_empty()
        && d.len() <= 253
        && d.contains('.')
        && d.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && !d.starts_with(['.', '-'])
        && !d.ends_with(['.', '-']);
    if valid {
        Ok(d)
    } else {
        Err("域名格式无效".into())
    }
}

async fn download_icon(url: &str, private_origin: Option<&str>) -> Result<image::RgbaImage, String> {
    let (bytes, _) = crate::preview_network::fetch(url, MAX_ICON_BYTES, private_origin).await?;
    if looks_like_svg(&bytes) { return Err("SVG 图标暂不支持".into()); }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format().map_err(|_| "图标格式无效")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(1024);
    limits.max_image_height = Some(1024);
    limits.max_alloc = Some(8 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| "图标解码失败或尺寸超限")?;
    Ok(decoded.thumbnail(64, 64).to_rgba8())
}

pub(crate) async fn icon_data_url(url: &str, private_origin: Option<&str>) -> Result<String, String> {
    use base64::Engine;
    let image = download_icon(url, private_origin).await?;
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).map_err(|_| "图标编码失败")?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())))
}

/// 嗅探 SVG：跳过 BOM/空白后以 `<svg` 或 `<?xml` 开头（favicon 场景足够）。
fn looks_like_svg(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("<svg") || lower.starts_with("<?xml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_sanitizer_accepts_hosts_only() {
        assert_eq!(sanitize_domain(" Netflix.com ").as_deref(), Ok("netflix.com"));
        assert_eq!(sanitize_domain("v.qq.com/").as_deref(), Ok("v.qq.com"));
        assert!(sanitize_domain("https://a.com").is_err());
        assert!(sanitize_domain("a.com/path").is_err());
        assert!(sanitize_domain("localhost").is_err());
        assert!(sanitize_domain("-bad.com").is_err());
        assert!(sanitize_domain("").is_err());
        assert!(sanitize_domain("a b.com").is_err());
    }

    #[test]
    fn svg_sniff_catches_xml_and_svg_heads() {
        assert!(looks_like_svg(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"));
        assert!(looks_like_svg(b"  <?xml version=\"1.0\"?><svg/>"));
        assert!(looks_like_svg("\u{feff}<svg/>".as_bytes()));
        assert!(!looks_like_svg(&[0x89, b'P', b'N', b'G']));
        assert!(!looks_like_svg(&[0x00, 0x00, 0x01, 0x00])); // ico
    }
}
