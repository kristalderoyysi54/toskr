//! 链接元数据抓取：curl 拉 HTML，手写轻量解析 og:title / <title> / <link rel=icon>。
//!
//! 不引入 HTTP/HTML 解析依赖：macOS 自带 curl（TLS/重定向/压缩全代劳），
//! 解析目标只有三个固定模式，字符串扫描足够且可单测。
//! 索引技巧：to_ascii_lowercase 不改变字节布局，lower 串上定位、原串上取值。

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkMeta {
    pub title: Option<String>,
    pub icon: Option<String>,
}

/// 部分站点对 curl 默认 UA 返回 403/跳登录，伪装成 Safari（favicon 抓取共用）。
pub(crate) const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

#[tauri::command]
pub async fn fetch_link_meta(url: String) -> Result<LinkMeta, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http(s) 链接".into());
    }
    tauri::async_runtime::spawn_blocking(move || fetch_blocking(&url))
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_blocking(url: &str) -> Result<LinkMeta, String> {
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
            // \x01 分隔正文与重定向后的最终 URL（icon 相对路径要基于它绝对化）
            "-w",
            "\u{1}%{url_effective}",
            "--",
            url,
        ])
        .output()
        .map_err(|e| format!("curl 启动失败: {e}"))?;
    let raw = String::from_utf8_lossy(&out.stdout);
    let (body, effective) = raw.rsplit_once('\u{1}').unwrap_or((raw.as_ref(), url));
    let effective = if effective.starts_with("http") { effective } else { url };
    if body.trim().is_empty() {
        return Err("页面为空或抓取失败".into());
    }
    Ok(extract_meta(body, effective))
}

/// 从 HTML 提取标题与图标（纯函数）。
pub fn extract_meta(html: &str, base_url: &str) -> LinkMeta {
    let lower = html.to_ascii_lowercase();
    let title = meta_content(html, &lower, "og:title")
        .or_else(|| tag_text(html, &lower, "title"))
        .map(|t| decode_entities(t.trim()))
        .filter(|t| !t.is_empty());
    let icon = link_icon_href(html, &lower)
        .and_then(|h| absolutize(&h, base_url))
        .or_else(|| origin_of(base_url).map(|o| format!("{o}/favicon.ico")));
    LinkMeta { title, icon }
}

/// `<meta … property="og:title" … content="…">` 的 content 值。
fn meta_content(html: &str, lower: &str, needle: &str) -> Option<String> {
    let mut from = 0;
    while let Some(rel) = lower[from..].find(needle) {
        let at = from + rel;
        let tag_end = match lower[at..].find('>') {
            Some(e) => at + e + 1,
            None => return None,
        };
        if let Some(tag_start) = lower[..at].rfind('<') {
            if lower[tag_start..].starts_with("<meta") {
                if let Some(v) = attr_value(html, lower, tag_start, tag_end, "content") {
                    return Some(v);
                }
            }
        }
        from = tag_end;
    }
    None
}

/// `<title>…</title>` 的文本。
fn tag_text(html: &str, lower: &str, tag: &str) -> Option<String> {
    let start = lower.find(&format!("<{tag}"))?;
    let text_start = start + lower[start..].find('>')? + 1;
    let text_end = text_start + lower[text_start..].find(&format!("</{tag}"))?;
    Some(html[text_start..text_end].to_string())
}

/// 首个 rel 含 icon 的 `<link>` 的 href；apple-touch-icon 仅作兜底。
fn link_icon_href(html: &str, lower: &str) -> Option<String> {
    let mut from = 0;
    let mut fallback = None;
    while let Some(rel) = lower[from..].find("<link") {
        let start = from + rel;
        let end = match lower[start..].find('>') {
            Some(e) => start + e + 1,
            None => break,
        };
        if let Some(r) = attr_value(html, lower, start, end, "rel") {
            let rl = r.to_ascii_lowercase();
            let is_icon = rl.split_whitespace().any(|w| w == "icon");
            let is_touch = rl.contains("apple-touch-icon");
            if is_icon || is_touch {
                if let Some(href) = attr_value(html, lower, start, end, "href") {
                    if !href.trim().is_empty() {
                        if is_icon {
                            return Some(href);
                        }
                        fallback.get_or_insert(href);
                    }
                }
            }
        }
        from = end;
    }
    fallback
}

/// 标签片段内 `name="value"` / `name='value'` 的 value（保留原文大小写）。
fn attr_value(html: &str, lower: &str, start: usize, end: usize, name: &str) -> Option<String> {
    let seg = &lower[start..end];
    for (pat, quote) in [(format!("{name}=\""), '"'), (format!("{name}='"), '\'')] {
        let mut from = 0;
        while let Some(rel) = seg[from..].find(&pat) {
            let at = from + rel;
            // 属性名前必须是空白，防 data-content 之类误中（跳过继续找）
            if at == 0 || seg.as_bytes()[at - 1].is_ascii_whitespace() {
                let vstart = start + at + pat.len();
                let vend = vstart + lower[vstart..end].find(quote)?;
                return Some(html[vstart..vend].to_string());
            }
            from = at + pat.len();
        }
    }
    None
}

/// 常见 HTML 实体解码（&amp; 最后换，避免二次解码）。
fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

/// 相对 href 基于最终 URL 绝对化。
fn absolutize(href: &str, base: &str) -> Option<String> {
    let href = href.trim();
    if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("data:") {
        return Some(href.to_string());
    }
    let origin = origin_of(base)?;
    if let Some(rest) = href.strip_prefix("//") {
        let scheme = base.split("://").next()?;
        return Some(format!("{scheme}://{rest}"));
    }
    if href.starts_with('/') {
        return Some(format!("{origin}{href}"));
    }
    let dir = match base.rfind('/') {
        Some(i) if i >= origin.len() => &base[..i],
        _ => origin.as_str(),
    };
    Some(format!("{dir}/{href}"))
}

/// `scheme://host[:port]`。
fn origin_of(url: &str) -> Option<String> {
    let scheme_end = url.find("://")? + 3;
    let host_end = url[scheme_end..]
        .find('/')
        .map(|i| scheme_end + i)
        .unwrap_or(url.len());
    Some(url[..host_end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn og_title_wins_over_title_tag() {
        let html = r#"<html><head><title>后备标题</title>
            <meta property="og:title" content="JS 接入指南_抖音开放平台"/></head></html>"#;
        let m = extract_meta(html, "https://developer.open-douyin.com/docs/x");
        assert_eq!(m.title.as_deref(), Some("JS 接入指南_抖音开放平台"));
    }

    #[test]
    fn title_fallback_with_entities_and_case() {
        let html = "<HTML><HEAD><TITLE>A &amp; B &lt;C&gt;</TITLE></HEAD>";
        let m = extract_meta(html, "https://example.com");
        assert_eq!(m.title.as_deref(), Some("A & B <C>"));
    }

    #[test]
    fn icon_relative_href_absolutized() {
        let html = r#"<link rel="shortcut icon" href="/static/fav.png">"#;
        let m = extract_meta(html, "https://a.com/docs/page");
        assert_eq!(m.icon.as_deref(), Some("https://a.com/static/fav.png"));
    }

    #[test]
    fn icon_falls_back_to_favicon_ico() {
        let m = extract_meta("<html></html>", "https://a.com/docs/page");
        assert_eq!(m.icon.as_deref(), Some("https://a.com/favicon.ico"));
        assert_eq!(m.title, None);
    }

    #[test]
    fn apple_touch_icon_is_fallback_only() {
        let html = r#"<link rel="apple-touch-icon" href="/touch.png">
            <link rel="icon" href="//cdn.a.com/fav.svg">"#;
        let m = extract_meta(html, "https://a.com");
        assert_eq!(m.icon.as_deref(), Some("https://cdn.a.com/fav.svg"));
    }

    #[test]
    fn data_content_attr_not_confused() {
        let html = r#"<meta property="og:title" data-content="假的" content="真的">"#;
        let m = extract_meta(html, "https://a.com");
        assert_eq!(m.title.as_deref(), Some("真的"));
    }
}
