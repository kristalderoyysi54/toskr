//! IM CDP 免手动注入。
//!
//! 用户开启「自动接入」后：Toskr 优雅退出目标 IM → 以 `--remote-debugging-port=<随机空闲>`
//! 直起目标 IM 的 Electron 主二进制 → 连其 CDP 调试通道 → attach 主 IM page → 注入与手动粘贴
//! **同一套**只读桥脚本（transport=cdp）→ 桥经 `__toskrEmit` binding 回传消息 → 解成
//! `IncomingMessage` 后直接喂给 `message_watch::accept_message`，落账本/去重/emit 全复用。
//!
//! 免掉「手动开 DevTools + 复制粘贴 + 刷新重来」。传输走调试通道，绕开 fetch/CORS/PNA。
//! 生命周期由 `message_watch` 的 generation 闸统一（开/关都 bump）；CDP 不可用时用户仍可
//! 退回手动粘贴 fallback（HTTP loopback 保留未删）。
//!
//! 目标应用不由代码预置：调用方须传入用户「探测并确认」得到的 `ImProfile`
//! （显示名 / bundle id / 主可执行路径），本模块只按 profile 编排进程。

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::Ordering;
use std::thread;
use std::time::{Duration, Instant};

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::message_watch::{self, IncomingMessage, MessageWatchState, MessageWatchStatus};

const BINDING_NAME: &str = "__toskrEmit";

/// 目标 IM 的运行时档案：由用户在设置里「探测并确认」后指定，代码不预置任何具体应用。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImProfile {
    /// 显示名，兼作 `open -a` 目标与 Application Support 数据目录名。
    pub app_name: String,
    /// bundle identifier（安装校验用；本模块保留以便日志/未来扩展）。
    #[allow(dead_code)]
    pub bundle_id: String,
    /// 主可执行文件绝对路径，用于带调试端口重启与主进程匹配。
    pub bin_path: String,
}

impl ImProfile {
    /// 主进程 pgrep -f 匹配串：完整主可执行路径，精确匹配主进程命令行、避开 Helper。
    fn main_pattern(&self) -> &str {
        &self.bin_path
    }

    /// Helper 进程路径前缀（<App>.app/Contents/Frameworks，GPU/Renderer/网络等都在此）。
    fn helpers_pattern(&self) -> String {
        if let Some(idx) = self.bin_path.find(".app/Contents/") {
            format!("{}.app/Contents/Frameworks", &self.bin_path[..idx])
        } else {
            format!("{}/Contents/Frameworks", self.app_name)
        }
    }

    /// 单例锁路径（~/Library/Application Support/<AppName>/SingletonLock）。
    fn singleton_lock(&self) -> Option<PathBuf> {
        std::env::var("HOME").ok().map(|home| {
            PathBuf::from(home)
                .join("Library/Application Support")
                .join(&self.app_name)
                .join("SingletonLock")
        })
    }
}

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type WsWrite = SplitSink<WsStream, Message>;
type WsRead = SplitStream<WsStream>;

// ── 对外入口 ──

/// 开/关 CDP 免手动监听。开启时须由前端传入 transport=cdp 的桥脚本（含 STARTED_AT，
/// 重连时复用同一脚本以复用同一起点门槛）与目标 IM 的 profile。关闭走 generation 闸令
/// 后台 task 自行收尾。
pub fn set_enabled(
    app: &AppHandle,
    enabled: bool,
    script: Option<String>,
    profile: Option<ImProfile>,
) -> Result<MessageWatchStatus, String> {
    if !enabled {
        message_watch::cdp_end(app);
        crate::diag::push(app, "IM CDP 监听关闭中（将恢复目标 IM 正常启动）");
        return Ok(message_watch::current_status(app));
    }

    let script = script.ok_or("缺少 CDP 桥脚本")?;
    let profile = profile.ok_or("未指定要监听的 IM（请先在设置里探测并确认）")?;
    let generation = message_watch::cdp_begin(app);
    let app_task = app.clone();
    tauri::async_runtime::spawn(async move {
        run_cdp(app_task, generation, script, profile).await;
    });
    crate::diag::push(
        app,
        "IM CDP 监听已开启（将以调试模式重启目标 IM 并自动注入只读桥）",
    );
    Ok(message_watch::current_status(app))
}

fn generation_changed(app: &AppHandle, generation: u64) -> bool {
    app.state::<MessageWatchState>()
        .generation
        .load(Ordering::SeqCst)
        != generation
}

// ── 后台驱动：确保带端口的目标 IM 在跑 → 连 CDP → 断连重连 → 收尾 ──

async fn run_cdp(app: AppHandle, generation: u64, script: String, profile: ImProfile) {
    let mut current: Option<(String, Child)> = None;

    loop {
        if generation_changed(&app, generation) {
            break;
        }
        // 确保有一个「带调试端口」的目标 IM 在跑；没有或已退出则杀净后重启。
        if current.is_none() || !im_running(&profile) {
            if let Some((_, mut child)) = current.take() {
                let _ = child.kill();
            }
            let app_blocking = app.clone();
            let profile_blocking = profile.clone();
            match tokio::task::spawn_blocking(move || {
                launch_im_with_cdp(&app_blocking, &profile_blocking)
            })
            .await
            {
                Ok(Ok(endpoint)) => current = Some(endpoint),
                Ok(Err(error)) => {
                    message_watch::cdp_set_error(&app, error);
                    if !sleep_interruptible(&app, generation, Duration::from_secs(3)).await {
                        break;
                    }
                    continue;
                }
                Err(_) => break,
            }
        }

        let browser_ws = current.as_ref().unwrap().0.clone();
        match cdp_session(&app, &browser_ws, &script, generation).await {
            // 正常返回只发生在 generation 变化（toggle off / 被顶替）
            Ok(()) => break,
            Err(error) => {
                message_watch::cdp_set_error(&app, error);
                // 退避后重连：目标 IM 若仍在跑，下一轮直接复用同一 browser_ws（不重启）
                if !sleep_interruptible(&app, generation, Duration::from_secs(2)).await {
                    break;
                }
            }
        }
    }

    if let Some((_, mut child)) = current.take() {
        let _ = child.kill();
    }
    let app_cleanup = app.clone();
    let profile_cleanup = profile.clone();
    let _ = tokio::task::spawn_blocking(move || cleanup_im(&app_cleanup, &profile_cleanup)).await;
}

/// 可被 generation 变化打断的 sleep。返回 false 表示应当退出。
async fn sleep_interruptible(app: &AppHandle, generation: u64, total: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < total {
        if generation_changed(app, generation) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    !generation_changed(app, generation)
}

// ── CDP 会话：attach 主 IM page → 注入 → 收事件 ──

async fn cdp_session(
    app: &AppHandle,
    browser_ws: &str,
    script: &str,
    generation: u64,
) -> Result<(), String> {
    let (ws, _) = connect_async(browser_ws)
        .await
        .map_err(|e| format!("连接 CDP 失败：{e}"))?;
    let (mut write, mut read) = ws.split();
    let mut id: i64 = 0;

    // 1. 找主 IM page target（页面加载稍慢，轮询等它注册）
    let mut page_target = None;
    for _ in 0..15 {
        if generation_changed(app, generation) {
            return Ok(());
        }
        id += 1;
        send_cmd(&mut write, id, "Target.getTargets", json!({}), None).await?;
        let result = await_result(&mut read, id, app, generation, None, &mut write).await?;
        if let Some(target) = find_page_target(&result) {
            page_target = Some(target);
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let page_target = page_target.ok_or("未找到 IM 页面（加载超时）")?;

    // 2. attach（flatten：后续命令/事件带 sessionId）
    id += 1;
    send_cmd(
        &mut write,
        id,
        "Target.attachToTarget",
        json!({ "targetId": page_target, "flatten": true }),
        None,
    )
    .await?;
    let attach = await_result(&mut read, id, app, generation, None, &mut write).await?;
    let session_id = attach
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or("attach 未返回 sessionId")?;

    // 3. 注入：enable → addBinding → 导航后自动重注入的脚本 → 当前页立即执行
    let inject: [(&str, Value); 5] = [
        ("Runtime.enable", json!({})),
        ("Page.enable", json!({})),
        ("Runtime.addBinding", json!({ "name": BINDING_NAME })),
        (
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": script }),
        ),
        (
            "Runtime.evaluate",
            json!({ "expression": script, "awaitPromise": false, "returnByValue": false }),
        ),
    ];
    for (method, params) in inject {
        id += 1;
        send_cmd(&mut write, id, method, params, Some(&session_id)).await?;
        await_result(&mut read, id, app, generation, Some(&session_id), &mut write).await?;
    }
    message_watch::cdp_mark_connected(app);
    crate::diag::push(app, "IM CDP 桥已注入（只读脚本，未改已读、未发送）");

    // 4. 事件循环：收 bindingCalled 喂下游；导航重发 binding；generation 变化优雅退出
    loop {
        if generation_changed(app, generation) {
            return Ok(());
        }
        match tokio::time::timeout(Duration::from_secs(1), read.next()).await {
            Err(_) => continue, // 定期醒来检查 generation
            Ok(None) => return Err("CDP 流结束".into()),
            Ok(Some(msg)) => {
                let msg = msg.map_err(|e| format!("CDP 读失败：{e}"))?;
                let text = match msg {
                    Message::Text(t) => t.as_str().to_owned(),
                    Message::Close(_) => return Err("CDP 连接被关闭".into()),
                    _ => continue,
                };
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    handle_event(&value, app, generation, &session_id, &mut write).await;
                }
            }
        }
    }
}

/// 发一条 JSON-RPC 命令（flatten 模式带 sessionId）。
async fn send_cmd(
    write: &mut WsWrite,
    id: i64,
    method: &str,
    params: Value,
    session_id: Option<&str>,
) -> Result<(), String> {
    let mut obj = json!({ "id": id, "method": method, "params": params });
    if let Some(sid) = session_id {
        obj["sessionId"] = json!(sid);
    }
    write
        .send(Message::text(obj.to_string()))
        .await
        .map_err(|e| format!("CDP 发送失败：{e}"))
}

/// 读到匹配 id 的响应返回其 result；期间到达的事件顺手处理（不丢 bindingCalled）。
async fn await_result(
    read: &mut WsRead,
    want_id: i64,
    app: &AppHandle,
    generation: u64,
    session_id: Option<&str>,
    write: &mut WsWrite,
) -> Result<Value, String> {
    loop {
        match tokio::time::timeout(Duration::from_secs(10), read.next()).await {
            Err(_) => return Err("CDP 命令响应超时".into()),
            Ok(None) => return Err("CDP 流结束".into()),
            Ok(Some(msg)) => {
                let msg = msg.map_err(|e| format!("CDP 读失败：{e}"))?;
                let text = match msg {
                    Message::Text(t) => t.as_str().to_owned(),
                    Message::Close(_) => return Err("CDP 连接被关闭".into()),
                    _ => continue,
                };
                let value: Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if value.get("id").and_then(|v| v.as_i64()) == Some(want_id) {
                    if let Some(error) = value.get("error") {
                        return Err(format!("CDP 命令失败：{error}"));
                    }
                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                }
                handle_event(&value, app, generation, session_id.unwrap_or(""), write).await;
            }
        }
    }
}

/// 处理 CDP 事件：bindingCalled 喂下游；导航后新执行上下文重发 addBinding
/// （binding 随 execution context 走，否则脚本 __toskrEmit 落空）。
async fn handle_event(
    value: &Value,
    app: &AppHandle,
    generation: u64,
    session_id: &str,
    write: &mut WsWrite,
) {
    let method = value.get("method").and_then(|m| m.as_str()).unwrap_or("");
    match method {
        "Runtime.bindingCalled" => {
            let params = &value["params"];
            if params.get("name").and_then(|n| n.as_str()) != Some(BINDING_NAME) {
                return;
            }
            if let Some(payload) = params.get("payload").and_then(|p| p.as_str()) {
                if let Ok(message) = serde_json::from_str::<IncomingMessage>(payload) {
                    let _ = message_watch::accept_message(app, message, generation);
                }
            }
        }
        "Runtime.executionContextCreated" => {
            if !session_id.is_empty() {
                let _ = send_cmd(
                    write,
                    -1,
                    "Runtime.addBinding",
                    json!({ "name": BINDING_NAME }),
                    Some(session_id),
                )
                .await;
            }
        }
        _ => {}
    }
}

/// 从 Target.getTargets 结果里挑主 IM renderer：Electron IM 通常把界面装在
/// `file://` 页里，取首个 type=page 且 url 为 file:// 的目标（IM 单窗口，稳定命中）。
fn find_page_target(result: &Value) -> Option<String> {
    let targets = result.get("targetInfos")?.as_array()?;
    targets
        .iter()
        .find(|t| {
            t.get("type").and_then(|x| x.as_str()) == Some("page")
                && t.get("url")
                    .and_then(|x| x.as_str())
                    .map(|u| u.starts_with("file://"))
                    .unwrap_or(false)
        })
        .and_then(|t| t.get("targetId").and_then(|x| x.as_str()).map(String::from))
}

// ── 进程编排（同步，在 spawn_blocking 中调用）──

/// 杀净目标 IM → 直起带调试端口 → 从 stderr 抓 `DevTools listening on ws://…`。
fn launch_im_with_cdp(app: &AppHandle, profile: &ImProfile) -> Result<(String, Child), String> {
    let port = pick_free_port()?;
    kill_im(profile)?;
    let mut child = spawn_im(profile, port)?;
    let browser_ws = match await_browser_ws(&mut child, Duration::from_secs(15)) {
        Ok(ws) => ws,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    crate::diag::push(app, "目标 IM 已以调试模式启动，CDP 通道就绪");
    Ok((browser_ws, child))
}

/// 关闭时：杀净带端口实例，再以正常方式（无调试端口）恢复目标 IM。
fn cleanup_im(app: &AppHandle, profile: &ImProfile) {
    let _ = kill_im(profile);
    let _ = Command::new("open")
        .args(["-a", &profile.app_name])
        .status();
    crate::diag::push(app, "IM CDP 监听已关闭，已恢复目标 IM 正常启动");
}

fn pick_free_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("选空闲端口失败：{e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("读取端口失败：{e}"))
}

fn im_pids(pattern: &str) -> Vec<i32> {
    Command::new("pgrep")
        .args(["-f", pattern])
        .output()
        .ok()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<i32>().ok())
                .collect()
        })
        .unwrap_or_default()
}

fn im_running(profile: &ImProfile) -> bool {
    !im_pids(profile.main_pattern()).is_empty()
}

/// 单例锁是否已释放：SingletonLock 不存在，或其指向的 pid 已死。
fn singleton_released(profile: &ImProfile) -> bool {
    let lock = match profile.singleton_lock() {
        Some(lock) => lock,
        None => return true,
    };
    match std::fs::read_link(&lock) {
        Err(_) => true,
        Ok(target) => target
            .to_string_lossy()
            .rsplit('-')
            .next()
            .and_then(|pid| pid.parse::<i32>().ok())
            .map(|pid| unsafe { libc::kill(pid, 0) } != 0)
            .unwrap_or(true),
    }
}

/// 优雅退出（SIGTERM 主进程避开 osascript 的 TCC 弹窗，Electron 正常 quit + 清 Singleton），
/// osascript 兜底，再按可执行路径精确杀残留 Helper，最后核验单例锁释放。
fn kill_im(profile: &ImProfile) -> Result<(), String> {
    for pid in im_pids(profile.main_pattern()) {
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    if !wait_until(|| !im_running(profile), Duration::from_secs(8)) {
        let _ = Command::new("osascript")
            .args(["-e", &format!("quit app \"{}\"", profile.app_name)])
            .output();
        wait_until(|| !im_running(profile), Duration::from_secs(5));
    }
    let helpers = profile.helpers_pattern();
    for pid in im_pids(&helpers) {
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
    if wait_until(
        || !im_running(profile) && singleton_released(profile),
        Duration::from_secs(3),
    ) {
        Ok(())
    } else {
        Err("目标 IM 未能完全退出，单例锁可能残留".into())
    }
}

fn spawn_im(profile: &ImProfile, port: u16) -> Result<Child, String> {
    Command::new(&profile.bin_path)
        .arg(format!("--remote-debugging-port={port}"))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动目标 IM 失败：{e}"))
}

/// 后台线程读 stderr 抓首个 `ws://…`（DevTools listening），随后继续读丢以排空管道，
/// 避免目标 IM 因 stderr 管道写满而卡住。
fn await_browser_ws(child: &mut Child, timeout: Duration) -> Result<String, String> {
    let stderr = child.stderr.take().ok_or("无法读取目标 IM 的 stderr")?;
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut sent = false;
        for line in reader.lines().map_while(Result::ok) {
            if !sent {
                if let Some(idx) = line.find("ws://") {
                    let ws = line[idx..].split_whitespace().next().unwrap_or("").to_string();
                    if !ws.is_empty() {
                        let _ = tx.send(ws);
                        sent = true;
                    }
                }
            }
        }
    });
    rx.recv_timeout(timeout)
        .map_err(|_| "等待目标 IM 调试端口就绪超时".to_string())
}

fn wait_until(mut cond: impl FnMut() -> bool, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        if cond() {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_profile() -> ImProfile {
        ImProfile {
            app_name: "Demo IM".into(),
            bundle_id: "com.example.demo-im".into(),
            bin_path: "/Applications/Demo IM.app/Contents/MacOS/Demo IM".into(),
        }
    }

    #[test]
    fn picks_a_bindable_free_port() {
        let port = pick_free_port().unwrap();
        assert!(port > 0);
        // 选出的端口应可再次 bind（确证空闲）
        let again = TcpListener::bind(("127.0.0.1", port));
        assert!(again.is_ok());
    }

    #[test]
    fn derives_helpers_prefix_from_bin_path() {
        assert_eq!(
            sample_profile().helpers_pattern(),
            "/Applications/Demo IM.app/Contents/Frameworks"
        );
    }

    #[test]
    fn finds_first_file_page_target() {
        let result = json!({
            "targetInfos": [
                { "type": "background_page", "url": "chrome://x", "targetId": "bg" },
                { "type": "page", "url": "file:///Applications/Demo%20IM.app/Contents/Resources/app/index.html", "targetId": "main" }
            ]
        });
        assert_eq!(find_page_target(&result).as_deref(), Some("main"));
    }

    #[test]
    fn ignores_non_file_pages() {
        let result = json!({
            "targetInfos": [
                { "type": "page", "url": "https://example.com", "targetId": "web" }
            ]
        });
        assert_eq!(find_page_target(&result), None);
    }
}
