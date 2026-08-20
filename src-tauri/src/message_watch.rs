//! 实验性 IM 消息桥。
//!
//! 只在用户显式开启后监听随机 loopback 端口；目标 IM 的 DevTools 只读脚本把
//! 已被客户端判定为「@我 / 特别关注」的新消息送到这里。原始对象先落 JSONL，
//! 再向主 WebView 发摘要事件。模块不操作 IM 窗口，也不调用任何已读/发送 API。

use std::collections::{HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

pub const MESSAGE_WATCH_EVENT: &str = "toskr://message-watch";
pub const LEDGER_FILE: &str = "toskr-im-message-watch.jsonl";
/// 旧版账本文件名，仅供启动时一次性迁移到 `LEDGER_FILE`——全代码仅此一处引用。
const LEGACY_LEDGER_FILE: &str = "toskr-tuitui-message-watch.jsonl";

const BRIDGE_VERSION: u8 = 1;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_SEEN: usize = 20_000;

#[derive(Default)]
pub struct MessageWatchState {
    pub(crate) generation: AtomicU64,
    runtime: Mutex<Runtime>,
}

#[derive(Default)]
struct Runtime {
    enabled: bool,
    endpoint: Option<String>,
    session_started_at_ms: Option<u64>,
    accepted_count: u64,
    duplicate_count: u64,
    last_accepted_at_ms: Option<u64>,
    renderer_connected: bool,
    transport: Option<String>,
    last_error: Option<String>,
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWatchStatus {
    pub enabled: bool,
    pub bridge_ready: bool,
    pub session_started_at_ms: Option<u64>,
    pub accepted_count: u64,
    pub duplicate_count: u64,
    pub last_accepted_at_ms: Option<u64>,
    pub renderer_connected: bool,
    pub ledger_path: String,
    pub last_error: Option<String>,
    pub transport: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWatchBridgeInfo {
    pub endpoint: String,
    pub session_started_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingMessage {
    pub bridge_version: u8,
    pub conversation_id: String,
    pub message_id: String,
    #[serde(default)]
    pub conversation_name: Option<String>,
    #[serde(default)]
    pub sender_uid: String,
    #[serde(default)]
    pub sender_name: Option<String>,
    #[serde(default)]
    pub occurred_at_ms: Option<u64>,
    pub captured_at_ms: u64,
    pub mentioned_self: bool,
    pub followed_sender: bool,
    #[serde(default)]
    pub matched_rule_ids: Vec<String>,
    #[serde(default)]
    pub is_group: Option<bool>,
    #[serde(default)]
    pub message_type: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub context: Vec<MessageContextItem>,
    pub raw: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageContextItem {
    pub message_id: String,
    #[serde(default)]
    pub sender_uid: String,
    #[serde(default)]
    pub sender_name: Option<String>,
    #[serde(default)]
    pub occurred_at_ms: Option<u64>,
    #[serde(default)]
    pub message_type: Option<String>,
    #[serde(default)]
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWatchCapture {
    pub conversation_id: String,
    pub message_id: String,
    pub conversation_name: Option<String>,
    pub sender_uid: String,
    pub sender_name: Option<String>,
    pub occurred_at_ms: Option<u64>,
    pub received_at_ms: u64,
    pub mentioned_self: bool,
    pub followed_sender: bool,
    pub matched_rule_ids: Vec<String>,
    pub is_group: Option<bool>,
    pub message_type: Option<String>,
    pub text: String,
    pub context: Vec<MessageContextItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LedgerRecord<'a> {
    schema_version: u8,
    received_at_ms: u64,
    message: &'a IncomingMessage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLedgerRecord {
    received_at_ms: u64,
    message: IncomingMessage,
}

struct HttpRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|error| format!("无法生成本地消息桥令牌：{error}"))?;
    Ok(hex(&bytes))
}

fn ledger_path(app: &AppHandle) -> PathBuf {
    crate::storage::data_dir(app).join(LEDGER_FILE)
}

/// 一次性把旧账本迁移到中性文件名：仅当新文件尚不存在且旧文件是普通文件时原子改名。
fn migrate_legacy_ledger(root: &Path) {
    let current = root.join(LEDGER_FILE);
    if current.exists() {
        return;
    }
    let legacy = root.join(LEGACY_LEDGER_FILE);
    if legacy.is_file() {
        let _ = std::fs::rename(&legacy, &current);
    }
}

fn status(app: &AppHandle, runtime: &Runtime) -> MessageWatchStatus {
    MessageWatchStatus {
        enabled: runtime.enabled,
        bridge_ready: runtime.enabled && runtime.endpoint.is_some(),
        session_started_at_ms: runtime.session_started_at_ms,
        accepted_count: runtime.accepted_count,
        duplicate_count: runtime.duplicate_count,
        last_accepted_at_ms: runtime.last_accepted_at_ms,
        renderer_connected: runtime.renderer_connected,
        ledger_path: ledger_path(app).to_string_lossy().into_owned(),
        last_error: runtime.last_error.clone(),
        transport: runtime.transport.clone(),
    }
}

pub fn current_status(app: &AppHandle) -> MessageWatchStatus {
    let state = app.state::<MessageWatchState>();
    let result = status(app, &state.runtime.lock().unwrap());
    result
}

pub fn bridge_info(app: &AppHandle) -> Result<MessageWatchBridgeInfo, String> {
    let state = app.state::<MessageWatchState>();
    let runtime = state.runtime.lock().unwrap();
    if !runtime.enabled {
        return Err("请先开启实验消息监听".into());
    }
    Ok(MessageWatchBridgeInfo {
        endpoint: runtime
            .endpoint
            .clone()
            .ok_or_else(|| "本地消息桥尚未就绪".to_string())?,
        session_started_at_ms: runtime.session_started_at_ms.unwrap_or_else(now_ms),
    })
}

pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<MessageWatchStatus, String> {
    let state = app.state::<MessageWatchState>();
    if !enabled {
        let mut runtime = state.runtime.lock().unwrap();
        runtime.enabled = false;
        runtime.endpoint = None;
        runtime.renderer_connected = false;
        runtime.transport = None;
        crate::diag::push(app, "实验消息监听已关闭");
        return Ok(status(app, &runtime));
    }

    {
        let runtime = state.runtime.lock().unwrap();
        if runtime.enabled && runtime.endpoint.is_some() {
            return Ok(status(app, &runtime));
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("无法启动本地消息桥：{error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法配置本地消息桥：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("无法读取本地消息桥地址：{error}"))?
        .port();
    let token = random_token()?;
    let endpoint = format!("http://127.0.0.1:{port}/v1/im/{token}");
    let started_at_ms = now_ms();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    {
        let mut runtime = state.runtime.lock().unwrap();
        *runtime = Runtime {
            enabled: true,
            endpoint: Some(endpoint),
            session_started_at_ms: Some(started_at_ms),
            transport: Some("http".to_string()),
            ..Runtime::default()
        };
    }

    let handle = app.clone();
    thread::spawn(move || run_listener(handle, listener, token, generation));
    crate::diag::push(
        app,
        "实验消息监听已开启（仅本机回环；等待 DevTools 只读桥）",
    );
    Ok(current_status(app))
}

// ── CDP 免手动注入的会话状态桥接 ──
// 进程编排与 WS 客户端在 message_watch_cdp.rs；CDP 传输不起 loopback server，
// 用调试通道 binding 回传。这里只维护供 UI 显示的运行态，并用 generation 做
// 「同刻只有一个传输在跑 + toggle 可停」的生命周期闸（开/关都 bump，避免 HTTP 的僵尸线程）。

/// 启动一次 CDP 会话：bump generation（令旧 HTTP listener / 旧 CDP task 退出），
/// 置 runtime 为已启用，返回本会话 generation。
pub(crate) fn cdp_begin(app: &AppHandle) -> u64 {
    let state = app.state::<MessageWatchState>();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let started_at_ms = now_ms();
    let mut runtime = state.runtime.lock().unwrap();
    *runtime = Runtime {
        enabled: true,
        endpoint: Some("cdp://127.0.0.1".to_string()),
        session_started_at_ms: Some(started_at_ms),
        transport: Some("cdp".to_string()),
        ..Runtime::default()
    };
    generation
}

/// 结束 CDP 会话：bump generation（令当前 CDP task 在下一次检查时退出），清运行态。
pub(crate) fn cdp_end(app: &AppHandle) {
    let state = app.state::<MessageWatchState>();
    state.generation.fetch_add(1, Ordering::SeqCst);
    let mut runtime = state.runtime.lock().unwrap();
    runtime.enabled = false;
    runtime.endpoint = None;
    runtime.renderer_connected = false;
    runtime.transport = None;
}

/// CDP 桥已注入并连通（attach page 成功后调用）。
pub(crate) fn cdp_mark_connected(app: &AppHandle) {
    let state = app.state::<MessageWatchState>();
    state.runtime.lock().unwrap().renderer_connected = true;
}

/// 记录 CDP 侧最近一次错误（供设置页展示）。
pub(crate) fn cdp_set_error(app: &AppHandle, error: String) {
    let state = app.state::<MessageWatchState>();
    state.runtime.lock().unwrap().last_error = Some(error);
}

fn run_listener(app: AppHandle, listener: TcpListener, token: String, generation: u64) {
    loop {
        let state = app.state::<MessageWatchState>();
        if state.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        match listener.accept() {
            Ok((stream, _)) => handle_connection(&app, stream, &token, generation),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                let mut runtime = state.runtime.lock().unwrap();
                runtime.last_error = Some(format!("本地接收器异常：{error}"));
                runtime.enabled = false;
                runtime.endpoint = None;
                crate::diag::push(&app, "实验消息监听接收器已停止");
                return;
            }
        }
    }
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, &'static str> {
    // macOS may propagate O_NONBLOCK from the listener to accepted sockets.
    // Switch the per-connection stream back to blocking mode before waiting for
    // WebKit/fetch to finish writing its request headers.
    stream
        .set_nonblocking(false)
        .map_err(|_| "读取模式配置失败")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "读取超时配置失败")?;
    let mut bytes = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let count = stream.read(&mut chunk).map_err(|_| "请求读取失败")?;
        if count == 0 {
            return Err("请求提前结束");
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = find_header_end(&bytes) {
            break end;
        }
        if bytes.len() > MAX_HEADER_BYTES {
            return Err("请求头过大");
        }
    };
    if header_end > MAX_HEADER_BYTES {
        return Err("请求头过大");
    }
    let header = std::str::from_utf8(&bytes[..header_end]).map_err(|_| "请求头编码无效")?;
    let mut lines = header.split("\r\n");
    let mut first = lines.next().ok_or("缺少请求行")?.split_whitespace();
    let method = first.next().ok_or("缺少请求方法")?.to_string();
    let path = first.next().ok_or("缺少请求路径")?.to_string();
    let mut content_length = 0usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.trim().parse().map_err(|_| "请求长度无效")?;
        }
        if name.eq_ignore_ascii_case("transfer-encoding")
            && !value.trim().eq_ignore_ascii_case("identity")
        {
            return Err("不支持分块请求");
        }
    }
    if content_length > MAX_BODY_BYTES {
        return Err("消息超过 4MB 上限");
    }
    let body_start = header_end + 4;
    while bytes.len().saturating_sub(body_start) < content_length {
        let count = stream.read(&mut chunk).map_err(|_| "消息读取失败")?;
        if count == 0 {
            return Err("消息正文不完整");
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len().saturating_sub(body_start) > MAX_BODY_BYTES {
            return Err("消息超过 4MB 上限");
        }
    }
    Ok(HttpRequest {
        method,
        path,
        body: bytes[body_start..body_start + content_length].to_vec(),
    })
}

fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn valid_short(value: &str, max_chars: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max_chars && !value.chars().any(char::is_control)
}

fn validate_message(message: &IncomingMessage) -> Result<(), &'static str> {
    if message.bridge_version != BRIDGE_VERSION {
        return Err("桥版本不兼容");
    }
    if !valid_short(&message.conversation_id, 512) || !valid_short(&message.message_id, 512) {
        return Err("消息标识无效");
    }
    if !message.mentioned_self && !message.followed_sender && message.matched_rule_ids.is_empty() {
        return Err("消息未命中 @我、特别关注或组合规则");
    }
    if message.is_group != Some(true) {
        return Err("实验监听只接收群组消息");
    }
    if message
        .conversation_name
        .as_deref()
        .is_some_and(|value| value.chars().count() > 1_024)
        || message
            .sender_name
            .as_deref()
            .is_some_and(|value| value.chars().count() > 1_024)
        || message.sender_uid.chars().count() > 512
        || message.text.len() > MAX_BODY_BYTES
        || message.matched_rule_ids.len() > 50
        || message
            .matched_rule_ids
            .iter()
            .any(|value| !valid_short(value, 128))
        || message.context.len() > 8
        || message.context.iter().any(|item| {
            !valid_short(&item.message_id, 512)
                || item.sender_uid.chars().count() > 512
                || item
                    .sender_name
                    .as_deref()
                    .is_some_and(|value| value.chars().count() > 1_024)
                || item.text.len() > MAX_BODY_BYTES
        })
    {
        return Err("消息字段过大");
    }
    Ok(())
}

fn capture_from_message(message: IncomingMessage, received_at_ms: u64) -> MessageWatchCapture {
    MessageWatchCapture {
        conversation_id: message.conversation_id,
        message_id: message.message_id,
        conversation_name: message.conversation_name,
        sender_uid: message.sender_uid,
        sender_name: message.sender_name,
        occurred_at_ms: message.occurred_at_ms,
        received_at_ms,
        mentioned_self: message.mentioned_self,
        followed_sender: message.followed_sender,
        matched_rule_ids: message.matched_rule_ids,
        is_group: message.is_group,
        message_type: message.message_type,
        text: message.text,
        context: message.context,
    }
}

/// 从 append-only 原始账本重建结构化投影。只读取本地文件，不触碰 IM 进程。
pub fn recent_captures(app: &AppHandle, limit: usize) -> Result<Vec<MessageWatchCapture>, String> {
    let limit = limit.clamp(1, 2_000);
    crate::storage::with_active_data_dir(app, |root| {
        migrate_legacy_ledger(root);
        let path = root.join(LEDGER_FILE);
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("无法读取消息账本：{error}")),
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err("消息账本路径不是普通文件".into())
            }
            Ok(_) => {}
        }
        let file = File::open(&path).map_err(|error| format!("无法读取消息账本：{error}"))?;
        let mut recent = VecDeque::with_capacity(limit);
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|error| format!("读取消息账本失败：{error}"))?;
            let Ok(record) = serde_json::from_str::<StoredLedgerRecord>(&line) else {
                // 崩溃时末行可能不完整；原账本不修改，投影跳过坏行继续恢复其余消息。
                continue;
            };
            if validate_message(&record.message).is_err() {
                continue;
            }
            recent.push_back(capture_from_message(record.message, record.received_at_ms));
            if recent.len() > limit {
                recent.pop_front();
            }
        }
        Ok(recent.into_iter().collect())
    })
}

fn capture_key(message: &IncomingMessage) -> String {
    format!("{}\0{}", message.conversation_id, message.message_id)
}

fn append_to_dir(
    root: &Path,
    message: &IncomingMessage,
    received_at_ms: u64,
) -> Result<(), String> {
    migrate_legacy_ledger(root);
    let path = root.join(LEDGER_FILE);
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("消息账本路径不是普通文件".into());
        }
    }
    let record = LedgerRecord {
        schema_version: 1,
        received_at_ms,
        message,
    };
    let bytes = serde_json::to_vec(&record).map_err(|error| format!("消息编码失败：{error}"))?;
    if bytes.len() > MAX_BODY_BYTES + 256 * 1024 {
        return Err("消息账本记录超过安全上限".into());
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("无法写入消息账本：{error}"))?;
    #[cfg(unix)]
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("无法收紧消息账本权限：{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_data())
        .map_err(|error| format!("消息账本落盘失败：{error}"))
}

fn remember(runtime: &mut Runtime, key: String) {
    if !runtime.seen.insert(key.clone()) {
        return;
    }
    runtime.seen_order.push_back(key);
    while runtime.seen_order.len() > MAX_SEEN {
        if let Some(expired) = runtime.seen_order.pop_front() {
            runtime.seen.remove(&expired);
        }
    }
}

pub(crate) fn accept_message(
    app: &AppHandle,
    message: IncomingMessage,
    generation: u64,
) -> Result<bool, String> {
    validate_message(&message).map_err(str::to_string)?;
    let key = capture_key(&message);
    let state = app.state::<MessageWatchState>();
    {
        let mut runtime = state.runtime.lock().unwrap();
        if state.generation.load(Ordering::SeqCst) != generation || !runtime.enabled {
            return Err("实验监听已关闭".into());
        }
        runtime.renderer_connected = true;
        if runtime.seen.contains(&key) {
            runtime.duplicate_count = runtime.duplicate_count.saturating_add(1);
            return Ok(false);
        }
    }

    let received_at_ms = now_ms();
    crate::storage::with_active_data_dir(app, |root| append_to_dir(root, &message, received_at_ms))
        .inspect_err(|error| {
            state.runtime.lock().unwrap().last_error = Some(error.clone());
        })?;

    let capture = capture_from_message(message, received_at_ms);
    {
        let mut runtime = state.runtime.lock().unwrap();
        remember(&mut runtime, key);
        runtime.accepted_count = runtime.accepted_count.saturating_add(1);
        runtime.last_accepted_at_ms = Some(received_at_ms);
        runtime.last_error = None;
    }
    let _ = app.emit(MESSAGE_WATCH_EVENT, capture);
    crate::diag::push(app, "实验消息监听已完整落盘 1 条消息");
    Ok(true)
}

fn handle_connection(app: &AppHandle, mut stream: TcpStream, token: &str, generation: u64) {
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            write_response(
                &mut stream,
                "400 Bad Request",
                &format!("{{\"error\":{}}}", serde_json::to_string(error).unwrap()),
            );
            return;
        }
    };
    let expected_path = format!("/v1/im/{token}");
    if request.path != expected_path {
        write_response(&mut stream, "404 Not Found", "{\"error\":\"not found\"}");
        return;
    }
    if request.method == "OPTIONS" {
        write_response(&mut stream, "204 No Content", "");
        return;
    }
    if request.method == "GET" {
        let state = app.state::<MessageWatchState>();
        let generation_matches = state.generation.load(Ordering::SeqCst) == generation;
        let mut runtime = state.runtime.lock().unwrap();
        let enabled = generation_matches && runtime.enabled;
        if enabled {
            runtime.renderer_connected = true;
        }
        drop(runtime);
        if enabled {
            write_response(&mut stream, "200 OK", "{\"enabled\":true}");
        } else {
            write_response(&mut stream, "410 Gone", "{\"enabled\":false}");
        }
        return;
    }
    if request.method != "POST" {
        write_response(
            &mut stream,
            "405 Method Not Allowed",
            "{\"error\":\"method\"}",
        );
        return;
    }
    let message = match serde_json::from_slice::<IncomingMessage>(&request.body) {
        Ok(message) => message,
        Err(_) => {
            write_response(
                &mut stream,
                "400 Bad Request",
                "{\"error\":\"invalid json\"}",
            );
            return;
        }
    };
    match accept_message(app, message, generation) {
        Ok(true) => write_response(&mut stream, "200 OK", "{\"accepted\":true}"),
        Ok(false) => write_response(
            &mut stream,
            "200 OK",
            "{\"accepted\":false,\"duplicate\":true}",
        ),
        Err(error) if error == "实验监听已关闭" => {
            write_response(&mut stream, "410 Gone", "{\"error\":\"disabled\"}")
        }
        Err(error) if error.starts_with("数据目录事务") => write_response(
            &mut stream,
            "503 Service Unavailable",
            "{\"error\":\"data busy\"}",
        ),
        Err(error) => write_response(
            &mut stream,
            "422 Unprocessable Entity",
            &format!("{{\"error\":{}}}", serde_json::to_string(&error).unwrap()),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message() -> IncomingMessage {
        IncomingMessage {
            bridge_version: 1,
            conversation_id: "group-1".into(),
            message_id: "message-1".into(),
            conversation_name: Some("项目群".into()),
            sender_uid: "42".into(),
            sender_name: Some("关注的人".into()),
            occurred_at_ms: Some(1_765_000_000_000),
            captured_at_ms: 1_765_000_000_100,
            mentioned_self: true,
            followed_sender: false,
            matched_rule_ids: Vec::new(),
            is_group: Some(true),
            message_type: Some("text".into()),
            text: "完整正文".into(),
            context: vec![MessageContextItem {
                message_id: "message-0".into(),
                sender_uid: "41".into(),
                sender_name: Some("前文发送者".into()),
                occurred_at_ms: Some(1_764_999_999_000),
                message_type: Some("text".into()),
                text: "完整前文".into(),
            }],
            raw: serde_json::json!({"msg": {"dt": [{"text": "完整正文"}]}}),
        }
    }

    #[test]
    fn rejects_messages_outside_requested_scope() {
        let mut value = message();
        value.mentioned_self = false;
        value.followed_sender = false;
        assert_eq!(
            validate_message(&value),
            Err("消息未命中 @我、特别关注或组合规则")
        );
        value.matched_rule_ids = vec!["release".into()];
        assert_eq!(validate_message(&value), Ok(()));
        let mut direct = message();
        direct.is_group = Some(false);
        assert_eq!(validate_message(&direct), Err("实验监听只接收群组消息"));
    }

    #[test]
    fn ledger_keeps_full_raw_payload_and_private_permissions() {
        let root = tempfile::tempdir().unwrap();
        append_to_dir(root.path(), &message(), 1_765_000_000_200).unwrap();
        let path = root.path().join(LEDGER_FILE);
        let raw = std::fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(raw.trim()).unwrap();
        assert_eq!(value["message"]["raw"]["msg"]["dt"][0]["text"], "完整正文");
        assert_eq!(value["message"]["context"][0]["text"], "完整前文");
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn dedupe_key_is_scoped_by_conversation() {
        let original = message();
        let mut other = message();
        other.conversation_id = "group-2".into();
        assert_ne!(capture_key(&original), capture_key(&other));
    }

    #[test]
    fn http_reader_preserves_utf8_body_exactly() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let body = serde_json::to_vec(&message()).unwrap();
        let expected = body.clone();
        let sender = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            write!(
                stream,
                "POST /v1/im/token HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        });
        let (mut stream, _) = listener.accept().unwrap();
        let request = read_request(&mut stream).unwrap();
        sender.join().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/v1/im/token");
        assert_eq!(request.body, expected);
    }

    #[test]
    fn http_reader_waits_on_an_accepted_nonblocking_stream() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let mut sender = TcpStream::connect(address).unwrap();
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_nonblocking(true).unwrap();
        let reader = thread::spawn(move || read_request(&mut stream));

        thread::sleep(Duration::from_millis(50));
        sender
            .write_all(b"GET /v1/im/token HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();

        let request = reader.join().unwrap().unwrap();
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/v1/im/token");
        assert!(request.body.is_empty());
    }
}
