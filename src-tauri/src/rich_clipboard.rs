//! 富剪贴板边界：稳定读取 HTML 表示、把外部图片本地化，并生成可回写的图文 HTML。
//!
//! 这里刻意不解析 DOM。调用方负责把 HTML 变成有序 block；本模块只处理
//! pasteboard generation、媒体字节预算和本地媒体边界。

use std::fmt;
use std::io::Cursor;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use image::{ImageFormat, ImageReader};
use objc2_app_kit::{NSPasteboard, NSPasteboardItem};
use objc2_foundation::NSString;
use reqwest::header::{LOCATION, REFERER};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use url::{Host, Url};

const PLAIN_TYPES: &[&str] = &[
    "public.utf8-plain-text",
    "public.utf16-plain-text",
    "NSStringPboardType",
];
const HTML_TYPES: &[&str] = &["public.html"];
const SOURCE_URL_TYPES: &[&str] = &["org.chromium.source-url", "public.url"];

const MAX_READ_ITEMS: usize = 32;
const MAX_PLAIN_BYTES: usize = 512 * 1024;
const MAX_HTML_BYTES: usize = 4 * 1024 * 1024;
const MAX_SOURCE_URL_BYTES: usize = 16 * 1024;
const MAX_READ_TOTAL_BYTES: usize = MAX_PLAIN_BYTES + MAX_HTML_BYTES + MAX_SOURCE_URL_BYTES;

const MAX_LOCALIZE_SOURCES: usize = 32;
const MAX_SOURCE_CHARS: usize = 24 * 1024 * 1024;
const MAX_REMOTE_URL_BYTES: usize = 16 * 1024;
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_BATCH_IMAGE_BYTES: usize = 48 * 1024 * 1024;
const MAX_BATCH_DURATION: Duration = Duration::from_secs(30);
const MAX_IMAGE_EDGE: u32 = 16_384;
const MAX_IMAGE_PIXELS: u64 = 24_000_000;
const MAX_IMAGE_ALLOC_BYTES: u64 = 128 * 1024 * 1024;

const MAX_WRITE_BLOCKS: usize = 128;
const MAX_WRITE_PLAIN_BYTES: usize = 2 * 1024 * 1024;
const MAX_WRITE_IMAGE_BYTES: usize = 48 * 1024 * 1024;
const MAX_WRITE_HTML_BYTES: usize = 72 * 1024 * 1024;
const MAX_ALT_BYTES: usize = 4 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RichClipboardRead {
    pub change_count: isize,
    pub plain_text: Option<String>,
    pub html: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadField {
    Plain,
    Html,
    SourceUrl,
}

impl ReadField {
    fn label(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Html => "html",
            Self::SourceUrl => "sourceUrl",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RichClipboardReadError {
    GenerationChanged,
    TooManyItems,
    RepresentationUnavailable(ReadField),
    RepresentationTooLarge(ReadField),
}

impl fmt::Display for RichClipboardReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::GenerationChanged => formatter.write_str("剪贴板内容已变化"),
            Self::TooManyItems => formatter.write_str("剪贴板条目过多"),
            Self::RepresentationUnavailable(field) => {
                write!(formatter, "剪贴板 {} 表示不可读取", field.label())
            }
            Self::RepresentationTooLarge(field) => {
                write!(formatter, "剪贴板 {} 表示超过安全上限", field.label())
            }
        }
    }
}

#[derive(Default)]
struct ReadBudget {
    used: usize,
}

impl ReadBudget {
    fn accept(
        &mut self,
        field: ReadField,
        value: String,
        field_limit: usize,
    ) -> Result<String, RichClipboardReadError> {
        let bytes = value.len();
        if bytes > field_limit
            || self.used.checked_add(bytes).is_none()
            || self.used + bytes > MAX_READ_TOTAL_BYTES
        {
            return Err(RichClipboardReadError::RepresentationTooLarge(field));
        }
        self.used += bytes;
        Ok(value)
    }
}

/// 读取且只读取调用方已经观察到的 generation。惰性 provider 在读取期间若让
/// changeCount 变化，整次读取失败，不会采纳后来的剪贴板内容。
pub(crate) fn read_expected(
    expected_change_count: isize,
) -> Result<RichClipboardRead, RichClipboardReadError> {
    let pasteboard = NSPasteboard::generalPasteboard();
    read_expected_from(&pasteboard, expected_change_count, || {})
}

fn read_expected_from(
    pasteboard: &NSPasteboard,
    expected_change_count: isize,
    mut after_representation_read: impl FnMut(),
) -> Result<RichClipboardRead, RichClipboardReadError> {
    ensure_generation(pasteboard, expected_change_count)?;
    let Some(items) = pasteboard.pasteboardItems() else {
        ensure_generation(pasteboard, expected_change_count)?;
        return Ok(RichClipboardRead {
            change_count: expected_change_count,
            plain_text: None,
            html: None,
            source_url: None,
        });
    };
    if items.iter().take(MAX_READ_ITEMS + 1).count() > MAX_READ_ITEMS {
        return Err(RichClipboardReadError::TooManyItems);
    }
    ensure_generation(pasteboard, expected_change_count)?;

    // 一个 pasteboard generation 可以包含多个逻辑 item。它们不是同一份内容的
    // 可互换表示，不能把 item A 的 plain 与 item B 的 HTML 拼成一张图文卡。
    // 优先选择声明 HTML 的 item；没有时再选 plain，最后才选 source URL。
    let selected_item = items
        .iter()
        .find(|item| item_declares_any(item, HTML_TYPES))
        .or_else(|| {
            items
                .iter()
                .find(|item| item_declares_any(item, PLAIN_TYPES))
        })
        .or_else(|| {
            items
                .iter()
                .find(|item| item_declares_any(item, SOURCE_URL_TYPES))
        });
    let Some(selected_item) = selected_item else {
        ensure_generation(pasteboard, expected_change_count)?;
        return Ok(RichClipboardRead {
            change_count: expected_change_count,
            plain_text: None,
            html: None,
            source_url: None,
        });
    };

    let mut budget = ReadBudget::default();
    let plain_text = read_first_string(
        pasteboard,
        &selected_item,
        expected_change_count,
        ReadField::Plain,
        PLAIN_TYPES,
        MAX_PLAIN_BYTES,
        &mut budget,
        &mut after_representation_read,
    )?
    .filter(|value| !value.is_empty());
    let html = read_first_string(
        pasteboard,
        &selected_item,
        expected_change_count,
        ReadField::Html,
        HTML_TYPES,
        MAX_HTML_BYTES,
        &mut budget,
        &mut after_representation_read,
    )?
    .filter(|value| !value.is_empty());
    let source_url = read_first_string(
        pasteboard,
        &selected_item,
        expected_change_count,
        ReadField::SourceUrl,
        SOURCE_URL_TYPES,
        MAX_SOURCE_URL_BYTES,
        &mut budget,
        &mut after_representation_read,
    )?
    .and_then(valid_source_url);
    ensure_generation(pasteboard, expected_change_count)?;

    Ok(RichClipboardRead {
        change_count: expected_change_count,
        plain_text,
        html,
        source_url,
    })
}

#[allow(clippy::too_many_arguments)]
fn read_first_string(
    pasteboard: &NSPasteboard,
    item: &NSPasteboardItem,
    expected_change_count: isize,
    field: ReadField,
    type_ids: &[&str],
    field_limit: usize,
    budget: &mut ReadBudget,
    after_representation_read: &mut impl FnMut(),
) -> Result<Option<String>, RichClipboardReadError> {
    for type_id in type_ids {
        if !item_declares_any(item, &[*type_id]) {
            continue;
        }
        ensure_generation(pasteboard, expected_change_count)?;
        let type_id = NSString::from_str(type_id);
        // 先读取原始表示并做宽松的编码后预算，再让 AppKit 转成 NSString。
        // UTF-16 的原始字节可约为 UTF-8 ASCII 的两倍，因此预检上限取 2x；
        // 真正返回值仍由 ReadBudget 按 UTF-8 字节精确限制。
        let raw_limit = field_limit.saturating_mul(2).saturating_add(4);
        let raw = item
            .dataForType(&type_id)
            .ok_or(RichClipboardReadError::RepresentationUnavailable(field))?;
        if raw.len() > raw_limit {
            return Err(RichClipboardReadError::RepresentationTooLarge(field));
        }
        ensure_generation(pasteboard, expected_change_count)?;
        let value = item
            .stringForType(&type_id)
            .ok_or(RichClipboardReadError::RepresentationUnavailable(field))?
            .to_string();
        after_representation_read();
        ensure_generation(pasteboard, expected_change_count)?;
        return budget.accept(field, value, field_limit).map(Some);
    }
    Ok(None)
}

fn item_declares_any(item: &NSPasteboardItem, type_ids: &[&str]) -> bool {
    item.types().iter().any(|declared| {
        let declared = declared.to_string();
        type_ids.iter().any(|type_id| declared == *type_id)
    })
}

fn ensure_generation(
    pasteboard: &NSPasteboard,
    expected_change_count: isize,
) -> Result<(), RichClipboardReadError> {
    (pasteboard.changeCount() == expected_change_count)
        .then_some(())
        .ok_or(RichClipboardReadError::GenerationChanged)
}

fn valid_source_url(raw: String) -> Option<String> {
    let raw = raw.trim();
    let parsed = Url::parse(raw).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    Some(raw.to_owned())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RichImageFailureReason {
    TooManyImages,
    InvalidSource,
    UnsupportedScheme,
    UnsupportedDataType,
    InvalidData,
    NetworkFailed,
    HttpFailed,
    TooLarge,
    BatchTooLarge,
    BatchTimeout,
    UnsupportedImage,
    DecodeFailed,
    TooManyPixels,
    StorageFailed,
    InternalFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalizedRichImage {
    pub index: usize,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<RichImageFailureReason>,
}

impl LocalizedRichImage {
    fn success(index: usize, file: String, width: u32, height: u32) -> Self {
        Self {
            index,
            ok: true,
            file: Some(file),
            width: Some(width),
            height: Some(height),
            reason: None,
        }
    }

    fn failure(index: usize, reason: RichImageFailureReason) -> Self {
        Self {
            index,
            ok: false,
            file: None,
            width: None,
            height: None,
            reason: Some(reason),
        }
    }
}

/// 将图片源按输入顺序本地化。结果不回显源 URL，网络错误也统一映射成稳定原因码，
/// 避免 reqwest 错误字符串把带 token 的 URL 写入日志或前端状态。
pub(crate) async fn localize_images(
    app: &AppHandle,
    sources: Vec<String>,
    source_url: Option<String>,
) -> Vec<LocalizedRichImage> {
    let source_origin = source_url.as_deref().and_then(safe_source_origin);
    let mut results = Vec::with_capacity(sources.len());
    let mut remaining_batch = MAX_BATCH_IMAGE_BYTES;
    let deadline = Instant::now() + MAX_BATCH_DURATION;
    for (index, source) in sources.into_iter().enumerate() {
        if index >= MAX_LOCALIZE_SOURCES {
            results.push(LocalizedRichImage::failure(
                index,
                RichImageFailureReason::TooManyImages,
            ));
            continue;
        }
        if remaining_batch == 0 {
            results.push(LocalizedRichImage::failure(
                index,
                RichImageFailureReason::BatchTooLarge,
            ));
            continue;
        }
        if remaining_until(deadline).is_none() {
            results.push(LocalizedRichImage::failure(
                index,
                RichImageFailureReason::BatchTimeout,
            ));
            continue;
        }
        let limit = remaining_batch.min(MAX_IMAGE_BYTES);
        let bytes = match load_source_bytes(source, limit, source_origin.as_deref(), deadline).await
        {
            Ok(bytes) => bytes,
            Err(reason) => {
                results.push(LocalizedRichImage::failure(index, reason));
                continue;
            }
        };
        remaining_batch = remaining_batch.saturating_sub(bytes.len());

        let worker_app = app.clone();
        let localized = tauri::async_runtime::spawn_blocking(move || {
            let decoded = decode_supported_image(&bytes)?;
            let file = crate::storage::save_image_rgba(
                &worker_app,
                decoded.width as usize,
                decoded.height as usize,
                &decoded.rgba,
            )
            .map_err(|_| RichImageFailureReason::StorageFailed)?;
            Ok::<_, RichImageFailureReason>((file, decoded.width, decoded.height))
        })
        .await;
        match localized {
            Ok(Ok((file, width, height))) => {
                results.push(LocalizedRichImage::success(index, file, width, height));
            }
            Ok(Err(reason)) => results.push(LocalizedRichImage::failure(index, reason)),
            Err(_) => results.push(LocalizedRichImage::failure(
                index,
                RichImageFailureReason::InternalFailed,
            )),
        }
    }
    // 失败只落原因码计数（图片 URL 可能带鉴权参数，绝不回显/落盘）。
    let failures = results.iter().filter(|image| !image.ok).count();
    if failures > 0 {
        let mut reasons: Vec<(RichImageFailureReason, usize)> = Vec::new();
        for image in results.iter().filter(|image| !image.ok) {
            let Some(reason) = image.reason else { continue };
            match reasons.iter_mut().find(|(seen, _)| *seen == reason) {
                Some((_, count)) => *count += 1,
                None => reasons.push((reason, 1)),
            }
        }
        let summary = reasons
            .iter()
            .map(|(reason, count)| format!("{reason:?}×{count}"))
            .collect::<Vec<_>>()
            .join(", ");
        crate::diag::push(
            app,
            format!(
                "富图片: 本地化 {}/{} 失败 ({summary})",
                failures,
                results.len()
            ),
        );
    }
    results
}

async fn load_source_bytes(
    source: String,
    limit: usize,
    source_origin: Option<&str>,
    deadline: Instant,
) -> Result<Vec<u8>, RichImageFailureReason> {
    if source.len() > MAX_SOURCE_CHARS {
        return Err(RichImageFailureReason::TooLarge);
    }
    if source.starts_with("data:") {
        return tauri::async_runtime::spawn_blocking(move || decode_data_url(&source, limit))
            .await
            .map_err(|_| RichImageFailureReason::InternalFailed)?;
    }
    if source.starts_with("file:") {
        let from_web_page = source_origin.is_some();
        return tauri::async_runtime::spawn_blocking(move || {
            read_local_image_file(&source, limit, from_web_page)
        })
        .await
        .map_err(|_| RichImageFailureReason::InternalFailed)?;
    }
    fetch_http_image(&source, limit, source_origin, deadline).await
}

/// 读取 IM 等本地应用复制的 HTML 里引用的 `file://` 图片。
///
/// 策略门：复制若来自真实网页（携带有效公网 http(s) sourceUrl），一律拒绝——
/// 远程页面本身无法渲染 file:// 图片，这类组合只可能是伪造的剪贴板 HTML。
/// 路径 canonicalize（吃掉符号链接）后必须落在应用缓存类根目录内，
/// 用户文稿树（~/Documents、~/Desktop、~/Pictures 等）永不可达。
fn read_local_image_file(
    source: &str,
    limit: usize,
    from_web_page: bool,
) -> Result<Vec<u8>, RichImageFailureReason> {
    if from_web_page {
        return Err(RichImageFailureReason::UnsupportedScheme);
    }
    let url = Url::parse(source).map_err(|_| RichImageFailureReason::InvalidSource)?;
    if url.scheme() != "file" {
        return Err(RichImageFailureReason::UnsupportedScheme);
    }
    let path = url
        .to_file_path()
        .map_err(|_| RichImageFailureReason::InvalidSource)?;
    let path =
        std::fs::canonicalize(&path).map_err(|_| RichImageFailureReason::InvalidSource)?;
    if !local_image_path_allowed(&path) {
        return Err(RichImageFailureReason::UnsupportedScheme);
    }
    let metadata =
        std::fs::symlink_metadata(&path).map_err(|_| RichImageFailureReason::InvalidSource)?;
    if !metadata.is_file() {
        return Err(RichImageFailureReason::InvalidSource);
    }
    if metadata.len() > limit as u64 {
        return Err(RichImageFailureReason::TooLarge);
    }
    let bytes = std::fs::read(&path).map_err(|_| RichImageFailureReason::InvalidSource)?;
    if bytes.len() > limit {
        return Err(RichImageFailureReason::TooLarge);
    }
    Ok(bytes)
}

/// 允许的本地图片根：各应用数据/缓存（~/Library）与系统临时目录。
fn local_image_path_allowed(path: &std::path::Path) -> bool {
    let mut roots = vec![
        std::path::PathBuf::from("/private/var/folders"),
        std::path::PathBuf::from("/private/tmp"),
        std::path::PathBuf::from("/var/folders"),
        std::path::PathBuf::from("/tmp"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        if home.is_absolute() {
            roots.push(home.join("Library"));
        }
    }
    roots.iter().any(|root| path.starts_with(root))
}

fn decode_data_url(source: &str, limit: usize) -> Result<Vec<u8>, RichImageFailureReason> {
    let (metadata, payload) = source
        .strip_prefix("data:")
        .and_then(|body| body.split_once(','))
        .ok_or(RichImageFailureReason::InvalidData)?;
    let mut parts = metadata.split(';');
    let media_type = parts.next().unwrap_or_default().to_ascii_lowercase();
    if !matches!(
        media_type.as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp" | "image/bmp"
    ) {
        return Err(RichImageFailureReason::UnsupportedDataType);
    }
    let base64 = parts.any(|part| part.eq_ignore_ascii_case("base64"));
    let bytes = if base64 {
        let encoded_limit = limit.saturating_add(2) / 3 * 4 + 4;
        if payload.len() > encoded_limit {
            return Err(RichImageFailureReason::TooLarge);
        }
        STANDARD
            .decode(payload)
            .map_err(|_| RichImageFailureReason::InvalidData)?
    } else {
        percent_decode(payload, limit)?
    };
    if bytes.len() > limit {
        return Err(RichImageFailureReason::TooLarge);
    }
    Ok(bytes)
}

fn percent_decode(payload: &str, limit: usize) -> Result<Vec<u8>, RichImageFailureReason> {
    let input = payload.as_bytes();
    let mut output = Vec::with_capacity(input.len().min(limit));
    let mut at = 0;
    while at < input.len() {
        if output.len() == limit {
            return Err(RichImageFailureReason::TooLarge);
        }
        if input[at] == b'%' {
            if at + 2 >= input.len() {
                return Err(RichImageFailureReason::InvalidData);
            }
            let high = hex_value(input[at + 1]).ok_or(RichImageFailureReason::InvalidData)?;
            let low = hex_value(input[at + 2]).ok_or(RichImageFailureReason::InvalidData)?;
            output.push((high << 4) | low);
            at += 3;
        } else {
            output.push(input[at]);
            at += 1;
        }
    }
    Ok(output)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

async fn fetch_http_image(
    source: &str,
    limit: usize,
    source_origin: Option<&str>,
    deadline: Instant,
) -> Result<Vec<u8>, RichImageFailureReason> {
    if source.len() > MAX_REMOTE_URL_BYTES {
        return Err(RichImageFailureReason::TooLarge);
    }
    let mut current = Url::parse(source).map_err(|_| RichImageFailureReason::InvalidSource)?;
    let mut response = None;
    for redirect_count in 0..=4 {
        let request_timeout = remaining_until(deadline)
            .ok_or(RichImageFailureReason::BatchTimeout)?
            .min(Duration::from_secs(10));
        validate_http_url(&current)?;
        let allow_benchmark_dns = fake_ip_proxy_allowed(&current);
        let (host, addresses) = resolve_public_addresses(&current, allow_benchmark_dns).await?;
        // Fake-IP（benchmark 段）没有可钉住的真实地址——直连它在「仅系统代理」
        // 模式下是黑洞。此时按域名把请求交给用户自己的代理（环境变量或 macOS
        // 系统代理），真实解析与分流本来就由代理决定；公网结果维持钉住+禁代理。
        let fake_ip_only = addresses.iter().all(|address| benchmark_proxy_ip(address.ip()));
        let client = if fake_ip_only {
            proxied_fake_ip_client(request_timeout)?
        } else {
            pinned_http_client(&host, &addresses, request_timeout)?
        };
        let mut request = client
            .get(current.clone())
            .header(
                "Accept",
                "image/png,image/webp,image/jpeg;q=0.9,image/gif;q=0.8",
            );
        if let Some(source_origin) = source_origin {
            request = request.header(REFERER, source_origin);
        }
        let candidate = request
            .send()
            .await
            .map_err(|_| RichImageFailureReason::NetworkFailed)?;
        if candidate.status().is_redirection() {
            if redirect_count == 4 {
                return Err(RichImageFailureReason::HttpFailed);
            }
            let location = candidate
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(RichImageFailureReason::HttpFailed)?;
            let next = current
                .join(location)
                .map_err(|_| RichImageFailureReason::HttpFailed)?;
            if current.scheme() == "https" && next.scheme() == "http" {
                return Err(RichImageFailureReason::UnsupportedScheme);
            }
            current = next;
            continue;
        }
        response = Some(candidate);
        break;
    }
    let mut response = response.ok_or(RichImageFailureReason::HttpFailed)?;
    if !response.status().is_success() {
        return Err(RichImageFailureReason::HttpFailed);
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(RichImageFailureReason::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| RichImageFailureReason::NetworkFailed)?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(RichImageFailureReason::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn pinned_http_client(
    host: &str,
    addresses: &[SocketAddr],
    request_timeout: Duration,
) -> Result<reqwest::Client, RichImageFailureReason> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .connect_timeout(request_timeout.min(Duration::from_secs(4)))
        .timeout(request_timeout)
        .redirect(reqwest::redirect::Policy::none())
        // 禁用系统代理，避免代理绕过下面已钉住且已校验的公网 DNS 结果。
        .no_proxy()
        .resolve_to_addrs(host, addresses)
        .user_agent("Toskr/RichClipboard")
        .build()
        .map_err(|_| RichImageFailureReason::InternalFailed)
}

/// Fake-IP 场景专用：不钉地址、不禁代理，让请求按域名走用户的代理链
/// （reqwest 读环境变量与 macOS 系统代理，见 Cargo `system-proxy` feature）。
fn proxied_fake_ip_client(
    request_timeout: Duration,
) -> Result<reqwest::Client, RichImageFailureReason> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .connect_timeout(request_timeout.min(Duration::from_secs(4)))
        .timeout(request_timeout)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Toskr/RichClipboard")
        .build()
        .map_err(|_| RichImageFailureReason::InternalFailed)
}

fn remaining_until(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
}

fn validate_http_url(url: &Url) -> Result<(), RichImageFailureReason> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(RichImageFailureReason::UnsupportedScheme);
    }
    if url.host_str().is_none()
        || url.host_str().is_some_and(|host| host.ends_with('.'))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default().is_none()
    {
        return Err(RichImageFailureReason::InvalidSource);
    }
    Ok(())
}

fn safe_source_origin(source: &str) -> Option<String> {
    if source.len() > MAX_REMOTE_URL_BYTES {
        return None;
    }
    let parsed = Url::parse(source).ok()?;
    validate_http_url(&parsed).ok()?;
    match parsed.host()? {
        Host::Domain(host) if reserved_hostname(host) => return None,
        Host::Ipv4(ip) if !public_ipv4(ip) => return None,
        Host::Ipv6(ip) if !public_ipv6(ip) => return None,
        _ => {}
    }
    let origin = parsed.origin().ascii_serialization();
    (origin != "null").then(|| format!("{origin}/"))
}

async fn resolve_public_addresses(
    url: &Url,
    allow_benchmark_dns: bool,
) -> Result<(String, Vec<SocketAddr>), RichImageFailureReason> {
    validate_http_url(url)?;
    let host = url
        .host_str()
        .ok_or(RichImageFailureReason::InvalidSource)?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if reserved_hostname(&host) {
        return Err(RichImageFailureReason::InvalidSource);
    }
    let port = url
        .port_or_known_default()
        .ok_or(RichImageFailureReason::InvalidSource)?;
    let lookup_host = host.clone();
    let addresses = tauri::async_runtime::spawn_blocking(move || {
        (lookup_host.as_str(), port)
            .to_socket_addrs()
            .map(|addresses| addresses.collect::<Vec<_>>())
    })
    .await
    .map_err(|_| RichImageFailureReason::NetworkFailed)?
    .map_err(|_| RichImageFailureReason::NetworkFailed)?;
    if addresses.is_empty()
        || addresses.iter().any(|address| {
            !public_ip(address.ip()) && !(allow_benchmark_dns && benchmark_proxy_ip(address.ip()))
        })
    {
        return Err(RichImageFailureReason::InvalidSource);
    }
    Ok((host, addresses))
}

fn reserved_hostname(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || host == "metadata.google.internal"
        || host.ends_with(".metadata.google.internal")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_ipv4(ip),
        IpAddr::V6(ip) => public_ipv6(ip),
    }
}

/// Surge 等增强 DNS（Fake-IP 模式）会把 HTTPS 域名映射到 RFC 2544 benchmark 段，
/// 实际去向由代理按 TLS SNI 域名转发；无代理的机器该段不可路由，连接自然失败。
/// 因此只要目标是域名形态的 HTTPS 就允许该段——本地应用（IM 等）复制的图文没有
/// 网页 sourceUrl，同样受 Fake-IP 影响（某些 IM 客户端会把 im.live.<厂商> 域名解析成 198.18.x）。
/// URL 直接写 benchmark IP 或走 HTTP 仍拒绝。TLS SNI 与手动逐跳 DNS 钉住继续
/// 生效，因此不会放宽 loopback/RFC1918/link-local/metadata。
fn fake_ip_proxy_allowed(url: &Url) -> bool {
    url.scheme() == "https" && matches!(url.host(), Some(Host::Domain(_)))
}

fn benchmark_proxy_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            a == 198 && (b == 18 || b == 19)
        }
        IpAddr::V6(ip) => ip.to_ipv4_mapped().is_some_and(|ip| {
            let [a, b, _, _] = ip.octets();
            a == 198 && (b == 18 || b == 19)
        }),
    }
}

fn public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return public_ipv4(mapped);
    }
    let segments = ip.segments();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

struct DecodedImage {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

fn decode_supported_image(bytes: &[u8]) -> Result<DecodedImage, RichImageFailureReason> {
    let format =
        image::guess_format(bytes).map_err(|_| RichImageFailureReason::UnsupportedImage)?;
    if !matches!(
        format,
        ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::Gif
            | ImageFormat::WebP
            | ImageFormat::Bmp
    ) {
        return Err(RichImageFailureReason::UnsupportedImage);
    }
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| RichImageFailureReason::DecodeFailed)?;
    if width == 0
        || height == 0
        || width > MAX_IMAGE_EDGE
        || height > MAX_IMAGE_EDGE
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return Err(RichImageFailureReason::TooManyPixels);
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_EDGE);
    limits.max_image_height = Some(MAX_IMAGE_EDGE);
    limits.max_alloc = Some(MAX_IMAGE_ALLOC_BYTES);
    reader.limits(limits);
    let rgba = reader
        .decode()
        .map_err(|_| RichImageFailureReason::DecodeFailed)?
        .to_rgba8()
        .into_raw();
    Ok(DecodedImage {
        width,
        height,
        rgba,
    })
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum RichClipboardBlock {
    Text { text: String },
    Image { file: String, alt: Option<String> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RichClipboardWriteResult {
    pub change_count: isize,
    pub plain_bytes: usize,
    pub html_bytes: usize,
    pub image_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RichClipboardWriteError {
    Empty,
    Busy,
    TooManyBlocks,
    PlainTooLarge,
    HtmlTooLarge,
    ImagesTooLarge,
    AltTooLarge,
    ImageUnreadable,
    ImageNotPng,
    Pasteboard(crate::pasteboard::PasteboardError),
}

impl fmt::Display for RichClipboardWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Empty => "没有可复制的图文内容",
            Self::Busy => "剪贴板事务进行中，请稍后重试",
            Self::TooManyBlocks => "图文块数量超过安全上限",
            Self::PlainTooLarge => "纯文本回退超过安全上限",
            Self::HtmlTooLarge => "富文本内容超过安全上限",
            Self::ImagesTooLarge => "图片总大小超过安全上限",
            Self::AltTooLarge => "图片替代文字超过安全上限",
            Self::ImageUnreadable => "图片附件不可读取",
            Self::ImageNotPng => "图片附件不是 PNG",
            Self::Pasteboard(error) => return error.fmt(formatter),
        })
    }
}

impl From<crate::pasteboard::PasteboardError> for RichClipboardWriteError {
    fn from(value: crate::pasteboard::PasteboardError) -> Self {
        Self::Pasteboard(value)
    }
}

struct RichDocument {
    plain: String,
    html: String,
    image_count: usize,
}

/// 所有附件读取与 HTML 构建完成后才替换 pasteboard；任一附件失败不会产生半截内容。
pub(crate) fn write_blocks(
    app: &AppHandle,
    blocks: &[RichClipboardBlock],
) -> Result<RichClipboardWriteResult, RichClipboardWriteError> {
    let document = build_document(blocks, |file| crate::storage::read_image_bytes(app, file))?;
    // 图片读取/base64 构建完成后才占用全局 pasteboard 许可，避免长时间阻塞
    // watcher、捕获或发送事务。
    let _permit = crate::pasteboard::try_claim(app).ok_or(RichClipboardWriteError::Busy)?;
    let change_count =
        crate::pasteboard::write_general_text_and_html(&document.plain, &document.html)?;
    crate::clipwatch::mark_self_write_count(app, change_count);
    Ok(RichClipboardWriteResult {
        change_count,
        plain_bytes: document.plain.len(),
        html_bytes: document.html.len(),
        image_count: document.image_count,
    })
}

fn build_document(
    blocks: &[RichClipboardBlock],
    mut read_image: impl FnMut(&str) -> Option<Vec<u8>>,
) -> Result<RichDocument, RichClipboardWriteError> {
    if blocks.is_empty() {
        return Err(RichClipboardWriteError::Empty);
    }
    if blocks.len() > MAX_WRITE_BLOCKS {
        return Err(RichClipboardWriteError::TooManyBlocks);
    }
    let mut plain = String::new();
    let mut body = String::new();
    let mut image_bytes = 0usize;
    let mut image_count = 0usize;
    for block in blocks {
        let boundary_text = match block {
            RichClipboardBlock::Text { text } => {
                if text.is_empty() {
                    continue;
                }
                text.as_str()
            }
            RichClipboardBlock::Image { alt, .. } => alt
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("图片"),
        };
        if ensure_plain_block_boundary(&mut plain, boundary_text)? {
            push_bounded(
                &mut body,
                "<br>",
                MAX_WRITE_HTML_BYTES,
                RichClipboardWriteError::HtmlTooLarge,
            )?;
        }
        match block {
            RichClipboardBlock::Text { text } => {
                push_bounded(
                    &mut plain,
                    text,
                    MAX_WRITE_PLAIN_BYTES,
                    RichClipboardWriteError::PlainTooLarge,
                )?;
                push_bounded(
                    &mut body,
                    "<span style=\"white-space: pre-wrap\">",
                    MAX_WRITE_HTML_BYTES,
                    RichClipboardWriteError::HtmlTooLarge,
                )?;
                push_escaped_html(&mut body, text, MAX_WRITE_HTML_BYTES)?;
                push_bounded(
                    &mut body,
                    "</span>",
                    MAX_WRITE_HTML_BYTES,
                    RichClipboardWriteError::HtmlTooLarge,
                )?;
            }
            RichClipboardBlock::Image { file, alt } => {
                let alt = alt
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .unwrap_or("图片");
                if alt.len() > MAX_ALT_BYTES {
                    return Err(RichClipboardWriteError::AltTooLarge);
                }
                push_bounded(
                    &mut plain,
                    alt,
                    MAX_WRITE_PLAIN_BYTES,
                    RichClipboardWriteError::PlainTooLarge,
                )?;
                let bytes = read_image(file).ok_or(RichClipboardWriteError::ImageUnreadable)?;
                if image::guess_format(&bytes).ok() != Some(ImageFormat::Png) {
                    return Err(RichClipboardWriteError::ImageNotPng);
                }
                image_bytes = image_bytes
                    .checked_add(bytes.len())
                    .filter(|total| *total <= MAX_WRITE_IMAGE_BYTES)
                    .ok_or(RichClipboardWriteError::ImagesTooLarge)?;
                let data = STANDARD.encode(bytes);
                push_bounded(
                    &mut body,
                    "<img src=\"data:image/png;base64,",
                    MAX_WRITE_HTML_BYTES,
                    RichClipboardWriteError::HtmlTooLarge,
                )?;
                push_bounded(
                    &mut body,
                    &data,
                    MAX_WRITE_HTML_BYTES,
                    RichClipboardWriteError::HtmlTooLarge,
                )?;
                push_bounded(
                    &mut body,
                    "\" alt=\"",
                    MAX_WRITE_HTML_BYTES,
                    RichClipboardWriteError::HtmlTooLarge,
                )?;
                push_escaped_html(&mut body, alt, MAX_WRITE_HTML_BYTES)?;
                push_bounded(
                    &mut body,
                    "\">",
                    MAX_WRITE_HTML_BYTES,
                    RichClipboardWriteError::HtmlTooLarge,
                )?;
                image_count += 1;
            }
        }
    }
    if plain.is_empty() && image_count == 0 {
        return Err(RichClipboardWriteError::Empty);
    }
    let prefix =
        "<html><head><meta charset=\"utf-8\"></head><body><div data-toskr-rich-clipboard=\"1\">";
    let suffix = "</div></body></html>";
    if prefix
        .len()
        .saturating_add(body.len())
        .saturating_add(suffix.len())
        > MAX_WRITE_HTML_BYTES
    {
        return Err(RichClipboardWriteError::HtmlTooLarge);
    }
    let mut html = String::with_capacity(prefix.len() + body.len() + suffix.len());
    html.push_str(prefix);
    html.push_str(&body);
    html.push_str(suffix);
    Ok(RichDocument {
        plain,
        html,
        image_count,
    })
}

/// block 契约是逐块正文，不要求调用方自带分隔符。两侧都没有换行时补一个；
/// 任一侧已有换行则复用，避免 `image.png一、...` 黏连或重复空行。
fn ensure_plain_block_boundary(
    target: &mut String,
    next: &str,
) -> Result<bool, RichClipboardWriteError> {
    if target.is_empty() || target.ends_with('\n') || next.starts_with('\n') {
        return Ok(false);
    }
    push_bounded(
        target,
        "\n",
        MAX_WRITE_PLAIN_BYTES,
        RichClipboardWriteError::PlainTooLarge,
    )?;
    Ok(true)
}

fn push_bounded(
    target: &mut String,
    value: &str,
    limit: usize,
    error: RichClipboardWriteError,
) -> Result<(), RichClipboardWriteError> {
    if target.len().saturating_add(value.len()) > limit {
        return Err(error);
    }
    target.push_str(value);
    Ok(())
}

fn push_escaped_html(
    target: &mut String,
    value: &str,
    limit: usize,
) -> Result<(), RichClipboardWriteError> {
    for character in value.chars() {
        let escaped = match character {
            '&' => "&amp;",
            '<' => "&lt;",
            '>' => "&gt;",
            '"' => "&quot;",
            '\'' => "&#39;",
            _ => {
                if target.len().saturating_add(character.len_utf8()) > limit {
                    return Err(RichClipboardWriteError::HtmlTooLarge);
                }
                target.push(character);
                continue;
            }
        };
        push_bounded(
            target,
            escaped,
            limit,
            RichClipboardWriteError::HtmlTooLarge,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::jpeg::JpegEncoder;
    use image::codecs::png::PngEncoder;
    use image::{ColorType, ImageEncoder};
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboardItem, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString};
    use std::cell::Cell;

    fn named_pasteboard(name: &str) -> objc2::rc::Retained<NSPasteboard> {
        NSPasteboard::pasteboardWithName(&NSString::from_str(name))
    }

    fn write_strings(pasteboard: &NSPasteboard, values: &[(&str, &str)]) -> isize {
        let item = NSPasteboardItem::new();
        for (type_id, value) in values {
            assert!(
                item.setString_forType(&NSString::from_str(value), &NSString::from_str(type_id),)
            );
        }
        let objects = [ProtocolObject::<dyn NSPasteboardWriting>::from_retained(
            item,
        )];
        pasteboard.clearContents();
        assert!(pasteboard.writeObjects(&NSArray::from_retained_slice(&objects)));
        pasteboard.changeCount()
    }

    fn png_fixture() -> Vec<u8> {
        let mut bytes = Vec::new();
        PngEncoder::new(&mut bytes)
            .write_image(&[10, 20, 30, 255], 1, 1, ColorType::Rgba8.into())
            .unwrap();
        bytes
    }

    fn jpeg_fixture() -> Vec<u8> {
        let mut bytes = Vec::new();
        JpegEncoder::new(&mut bytes)
            .write_image(&[10, 20, 30], 1, 1, ColorType::Rgb8.into())
            .unwrap();
        bytes
    }

    fn gif_fixture() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            encoder
                .encode(&[10, 20, 30, 255], 1, 1, ColorType::Rgba8.into())
                .unwrap();
        }
        bytes
    }

    fn bmp_fixture() -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::bmp::BmpEncoder::new(&mut bytes)
            .encode(&[10, 20, 30], 1, 1, ColorType::Rgb8.into())
            .unwrap();
        bytes
    }

    #[test]
    fn expected_generation_reads_plain_html_and_safe_source_url() {
        let name = format!("com.toskr.tests.rich-read.{}", std::process::id());
        let pasteboard = named_pasteboard(&name);
        let expected = write_strings(
            &pasteboard,
            &[
                ("public.utf8-plain-text", "正文\nimage.png"),
                ("public.html", "<p>正文<img src=\"x.png\"></p>"),
                ("org.chromium.source-url", "https://example.test/docs/1"),
            ],
        );

        let rich = read_expected_from(&pasteboard, expected, || {}).unwrap();

        assert_eq!(rich.change_count, expected);
        assert_eq!(rich.plain_text.as_deref(), Some("正文\nimage.png"));
        assert!(rich.html.as_deref().unwrap().contains("<img"));
        assert_eq!(
            rich.source_url.as_deref(),
            Some("https://example.test/docs/1")
        );
        pasteboard.clearContents();
    }

    #[test]
    fn multiple_items_never_mix_representations() {
        let name = format!("com.toskr.tests.rich-multi-item.{}", std::process::id());
        let pasteboard = named_pasteboard(&name);

        let plain_item = NSPasteboardItem::new();
        assert!(plain_item.setString_forType(
            &NSString::from_str("另一个条目的正文"),
            &NSString::from_str("public.utf8-plain-text"),
        ));
        assert!(plain_item.setString_forType(
            &NSString::from_str("https://wrong.example.test/docs/1"),
            &NSString::from_str("org.chromium.source-url"),
        ));

        let html_item = NSPasteboardItem::new();
        assert!(html_item.setString_forType(
            &NSString::from_str("<p>图文条目</p>"),
            &NSString::from_str("public.html"),
        ));

        let objects = [
            ProtocolObject::<dyn NSPasteboardWriting>::from_retained(plain_item),
            ProtocolObject::<dyn NSPasteboardWriting>::from_retained(html_item),
        ];
        pasteboard.clearContents();
        assert!(pasteboard.writeObjects(&NSArray::from_retained_slice(&objects)));
        let expected = pasteboard.changeCount();

        let rich = read_expected_from(&pasteboard, expected, || {}).unwrap();

        assert_eq!(rich.plain_text, None);
        assert_eq!(rich.html.as_deref(), Some("<p>图文条目</p>"));
        assert_eq!(rich.source_url, None);
        pasteboard.clearContents();
    }

    #[test]
    fn generation_change_during_lazy_read_fails_closed() {
        let name = format!("com.toskr.tests.rich-race.{}", std::process::id());
        let pasteboard = named_pasteboard(&name);
        let expected = write_strings(
            &pasteboard,
            &[
                ("public.utf8-plain-text", "original"),
                ("public.html", "<b>x</b>"),
            ],
        );
        let changed = Cell::new(false);

        let result = read_expected_from(&pasteboard, expected, || {
            if !changed.replace(true) {
                pasteboard.clearContents();
            }
        });

        assert_eq!(result, Err(RichClipboardReadError::GenerationChanged));
        pasteboard.clearContents();
    }

    #[test]
    fn oversized_html_rejects_the_entire_read() {
        let name = format!("com.toskr.tests.rich-budget.{}", std::process::id());
        let pasteboard = named_pasteboard(&name);
        let html = "x".repeat(MAX_HTML_BYTES + 1);
        let expected = write_strings(
            &pasteboard,
            &[("public.utf8-plain-text", "small"), ("public.html", &html)],
        );

        assert_eq!(
            read_expected_from(&pasteboard, expected, || {}),
            Err(RichClipboardReadError::RepresentationTooLarge(
                ReadField::Html
            ))
        );
        pasteboard.clearContents();
    }

    #[test]
    fn unsafe_source_url_is_not_exposed() {
        let name = format!("com.toskr.tests.rich-url.{}", std::process::id());
        let pasteboard = named_pasteboard(&name);
        let expected = write_strings(
            &pasteboard,
            &[(
                "org.chromium.source-url",
                "file:///Users/example/private.html",
            )],
        );

        let rich = read_expected_from(&pasteboard, expected, || {}).unwrap();

        assert_eq!(rich.source_url, None);
        pasteboard.clearContents();
    }

    #[test]
    fn data_urls_support_base64_and_percent_encoded_png_and_jpeg() {
        let png = png_fixture();
        let png_base64 = format!("data:image/png;base64,{}", STANDARD.encode(&png));
        assert_eq!(decode_data_url(&png_base64, MAX_IMAGE_BYTES).unwrap(), png);

        let jpeg = jpeg_fixture();
        let encoded = jpeg
            .iter()
            .map(|byte| format!("%{byte:02X}"))
            .collect::<String>();
        let jpeg_percent = format!("data:image/jpeg,{encoded}");
        assert_eq!(
            decode_data_url(&jpeg_percent, MAX_IMAGE_BYTES).unwrap(),
            jpeg
        );
    }

    #[test]
    fn decoder_accepts_bounded_bitmap_formats_only() {
        let png = decode_supported_image(&png_fixture()).unwrap();
        assert_eq!((png.width, png.height, png.rgba.len()), (1, 1, 4));

        let jpeg = decode_supported_image(&jpeg_fixture()).unwrap();
        assert_eq!((jpeg.width, jpeg.height, jpeg.rgba.len()), (1, 1, 4));

        let gif = decode_supported_image(&gif_fixture()).unwrap();
        assert_eq!((gif.width, gif.height, gif.rgba.len()), (1, 1, 4));

        let bmp = decode_supported_image(&bmp_fixture()).unwrap();
        assert_eq!((bmp.width, bmp.height, bmp.rgba.len()), (1, 1, 4));

        // 未启用的格式（TIFF 魔数）仍拒收；截断 GIF 头过得了嗅探但解码必败。
        assert!(matches!(
            decode_supported_image(b"II*\x00rest"),
            Err(RichImageFailureReason::UnsupportedImage)
        ));
        assert!(matches!(
            decode_supported_image(b"GIF89a"),
            Err(RichImageFailureReason::DecodeFailed)
        ));
    }

    #[test]
    fn data_urls_accept_im_common_bitmap_types_only() {
        for mime in ["image/gif", "image/webp", "image/bmp"] {
            let url = format!("data:{mime};base64,{}", STANDARD.encode(b"stub-bytes"));
            assert_eq!(
                decode_data_url(&url, MAX_IMAGE_BYTES).unwrap(),
                b"stub-bytes"
            );
        }
        assert!(matches!(
            decode_data_url("data:image/svg+xml;base64,PHN2Zz4=", MAX_IMAGE_BYTES),
            Err(RichImageFailureReason::UnsupportedDataType)
        ));
    }

    #[test]
    fn local_file_images_only_from_cache_roots_and_never_for_web_copies() {
        let dir = std::env::temp_dir().join(format!("toskr-rich-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fixture.png");
        std::fs::write(&path, png_fixture()).unwrap();
        let url = Url::from_file_path(&path).unwrap().to_string();

        // 本地应用复制（无网页来源）→ 读取成功（temp 目录 canonicalize 后在缓存根内）
        assert_eq!(
            read_local_image_file(&url, MAX_IMAGE_BYTES, false).unwrap(),
            png_fixture()
        );
        // 真实网页复制携带 file:// → 一律拒绝
        assert!(matches!(
            read_local_image_file(&url, MAX_IMAGE_BYTES, true),
            Err(RichImageFailureReason::UnsupportedScheme)
        ));
        // 大小上限
        assert!(matches!(
            read_local_image_file(&url, 3, false),
            Err(RichImageFailureReason::TooLarge)
        ));
        // 带主机名的 file URL 与不存在的文件 → 拒绝
        assert!(matches!(
            read_local_image_file("file://evil-host/x.png", MAX_IMAGE_BYTES, false),
            Err(RichImageFailureReason::InvalidSource)
        ));
        assert!(matches!(
            read_local_image_file(
                Url::from_file_path(dir.join("missing.png")).unwrap().as_str(),
                MAX_IMAGE_BYTES,
                false
            ),
            Err(RichImageFailureReason::InvalidSource)
        ));
        std::fs::remove_dir_all(&dir).ok();

        // 缓存根白名单：系统临时/应用数据可达，用户文稿树永不可达
        assert!(local_image_path_allowed(std::path::Path::new(
            "/private/var/folders/ab/cd/T/im-cache/img.png"
        )));
        assert!(!local_image_path_allowed(std::path::Path::new(
            "/Users/someone/Documents/secret.png"
        )));
        if let Some(home) = std::env::var_os("HOME") {
            let library = std::path::PathBuf::from(home).join("Library/Caches/im/img.png");
            assert!(local_image_path_allowed(&library));
        }
    }

    #[test]
    fn rich_document_keeps_block_order_and_embeds_png() {
        let png = png_fixture();
        let blocks = vec![
            RichClipboardBlock::Text {
                text: "前 <段>\n".into(),
            },
            RichClipboardBlock::Image {
                file: "a.png".into(),
                alt: Some("图 & 一".into()),
            },
            RichClipboardBlock::Text {
                text: "\n后段".into(),
            },
        ];

        let document =
            build_document(&blocks, |file| (file == "a.png").then(|| png.clone())).unwrap();

        assert_eq!(document.plain, "前 <段>\n图 & 一\n后段");
        let before = document.html.find("前 &lt;段&gt;").unwrap();
        let image = document
            .html
            .find("<img src=\"data:image/png;base64,")
            .unwrap();
        let after = document.html.find("后段").unwrap();
        assert!(before < image && image < after);
        assert!(document.html.contains("alt=\"图 &amp; 一\""));
        assert_eq!(document.image_count, 1);
    }

    #[test]
    fn rich_document_is_atomic_when_any_image_is_unreadable() {
        let blocks = vec![
            RichClipboardBlock::Text {
                text: "正文".into(),
            },
            RichClipboardBlock::Image {
                file: "missing.png".into(),
                alt: None,
            },
        ];

        assert_eq!(
            build_document(&blocks, |_| None).err(),
            Some(RichClipboardWriteError::ImageUnreadable)
        );
    }

    #[test]
    fn rich_document_inserts_exactly_one_missing_block_newline() {
        let blocks = vec![
            RichClipboardBlock::Text {
                text: "路径：审批管理\nimage.png".into(),
            },
            RichClipboardBlock::Text {
                text: "一、商户类型".into(),
            },
            RichClipboardBlock::Text {
                text: "\n二、结算规则".into(),
            },
        ];

        let document = build_document(&blocks, |_| None).unwrap();

        assert_eq!(
            document.plain,
            "路径：审批管理\nimage.png\n一、商户类型\n二、结算规则"
        );
        assert_eq!(document.html.matches("<br>").count(), 1);
    }

    #[test]
    fn public_network_policy_rejects_ssrf_ranges_without_same_origin_restriction() {
        for private in [
            Ipv4Addr::new(127, 0, 0, 1),
            Ipv4Addr::new(10, 1, 2, 3),
            Ipv4Addr::new(169, 254, 169, 254),
            Ipv4Addr::new(192, 168, 1, 1),
            Ipv4Addr::new(198, 51, 100, 7),
        ] {
            assert!(!public_ipv4(private));
        }
        assert!(public_ipv4(Ipv4Addr::new(1, 1, 1, 1)));
        assert!(!public_ipv6(Ipv6Addr::LOCALHOST));
        assert!(!public_ipv6("fe80::1".parse().unwrap()));
        assert!(!public_ipv6("fc00::1".parse().unwrap()));
        assert!(public_ipv6("2606:4700:4700::1111".parse().unwrap()));

        // 页面与图片可以是不同公网域；安全边界是逐跳公网地址，不是同源。
        let page = safe_source_origin("https://docs.example.test/path?q=secret").unwrap();
        assert_eq!(page, "https://docs.example.test/");
        assert!(
            validate_http_url(&Url::parse("https://assets.example-cdn.test/a.png").unwrap())
                .is_ok()
        );
        assert!(safe_source_origin("http://127.0.0.1/private").is_none());

        let synthetic = IpAddr::V4(Ipv4Addr::new(198, 18, 4, 50));
        assert!(!public_ip(synthetic));
        assert!(benchmark_proxy_ip(synthetic));

        // Fake-IP 豁免不要求网页来源（本地 IM 复制同样受 Fake-IP DNS 影响），
        // 但仅限域名形态的 HTTPS：直接写 benchmark IP 或走 HTTP 仍拒绝。
        assert!(fake_ip_proxy_allowed(
            &Url::parse("https://im.example-corp.test:8989/img/a.png").unwrap()
        ));
        assert!(!fake_ip_proxy_allowed(
            &Url::parse("http://im.example-corp.test/img/a.png").unwrap()
        ));
        assert!(!fake_ip_proxy_allowed(
            &Url::parse("https://198.18.4.50/a.png").unwrap()
        ));
    }
}
