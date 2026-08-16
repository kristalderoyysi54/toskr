//! 域名 → 本地媒体库图标：抓站点 HTML 拿 `<link rel=icon>`（复用 linkmeta 解析），
//! 下载图标字节、image 解码、`save_image_rgba` 落盘（内容寻址去重，与笔记图片
//! 同一套 GC/备份）。失败即 Err，前端回退首字色块，不重试不排队。
//!
//! 与 linkmeta 拆开：那边是「抓标题+猜图标 URL」的纯 HTTP 解析，这边多了
//! 图片 IO 与媒体库写入，职责不同。

use tauri::AppHandle;

use crate::linkmeta::{extract_meta, UA};
use crate::storage::save_image_rgba;

/// 图标文件大小上限（比 og 图小得多，1MB 足够并防 zip bomb 型 PNG）。
const MAX_ICON_BYTES: &str = "1048576";

#[tauri::command]
pub async fn fetch_favicon(app: AppHandle, domain: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_blocking(&app, &domain))
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_blocking(app: &AppHandle, domain: &str) -> Result<String, String> {
    let domain = sanitize_domain(domain)?;
    let fallback = format!("https://{domain}/favicon.ico");
    // HTML 里声明的 icon 优先；抓不到 HTML / data: 内联 / SVG 都退到 /favicon.ico
    let mut candidates = Vec::new();
    if let Some(icon) = html_icon_url(&format!("https://{domain}")) {
        if !icon.starts_with("data:") && icon != fallback {
            candidates.push(icon);
        }
    }
    candidates.push(fallback);
    let mut last_err = String::from("未找到可用图标");
    for url in candidates {
        match download_and_store(app, &url) {
            Ok(name) => return Ok(name),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
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

/// 抓站点首页 HTML，返回其中声明的 icon 绝对 URL（失败返回 None，不阻断主流程）。
fn html_icon_url(page_url: &str) -> Option<String> {
    let out = std::process::Command::new("curl")
        .args([
            "-sL",
            "--compressed",
            "--max-time",
            "6",
            "--max-filesize",
            "3145728",
            "-A",
            UA,
            "-w",
            "\u{1}%{url_effective}",
            "--",
            page_url,
        ])
        .output()
        .ok()?;
    let raw = String::from_utf8_lossy(&out.stdout);
    let (body, effective) = raw.rsplit_once('\u{1}').unwrap_or((raw.as_ref(), page_url));
    let effective = if effective.starts_with("http") { effective } else { page_url };
    if body.trim().is_empty() {
        return None;
    }
    extract_meta(body, effective).icon
}

fn download_and_store(app: &AppHandle, url: &str) -> Result<String, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("图标地址不是 http(s)".into());
    }
    let out = std::process::Command::new("curl")
        .args([
            "-sL",
            "--max-time",
            "6",
            "--max-filesize",
            MAX_ICON_BYTES,
            "-A",
            UA,
            "--",
            url,
        ])
        .output()
        .map_err(|e| format!("curl 启动失败: {e}"))?;
    let bytes = out.stdout;
    if bytes.is_empty() {
        return Err("图标下载为空".into());
    }
    if looks_like_svg(&bytes) {
        // image crate 不解 SVG；不为图标引入光栅化依赖（YAGNI）
        return Err("SVG 图标暂不支持".into());
    }
    let decoded = image::load_from_memory(&bytes).map_err(|e| format!("图标解码失败: {e}"))?;
    let rgba = decoded.to_rgba8();
    let (width, height) = (rgba.width() as usize, rgba.height() as usize);
    save_image_rgba(app, width, height, rgba.as_raw())
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
