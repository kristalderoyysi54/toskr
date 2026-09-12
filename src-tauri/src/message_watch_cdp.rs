//! IM CDP 免手动注入。
//!
//! 用户开启「自动接入」后：Toskr 优雅退出目标 IM → 以 `--remote-debugging-port=<随机空闲>`
//! 直起目标 IM 的 Electron 主二进制 → 连其 CDP 调试通道 → attach 主 IM page → 注入与手动粘贴
//! **同一套**只读桥脚本（transport=cdp）→ 桥经 `__toskrEmit` binding 回传消息 → 解成
//! `IncomingMessage` 后直接喂给 `message_watch::accept_message`，落账本/去重/emit 全复用。
//!
//! 免掉「手动开 DevTools + 复制粘贴 + 刷新重来」。传输走调试通道，绕开 fetch/CORS/PNA。
//! 生命周期由 generation 取消信号与串行会话锁共同控制，旧会话恢复后新会话才能启动。用户仍可
//! 退回手动粘贴 fallback（HTTP loopback 保留未删）。
//!
//! 目标应用不由代码预置：调用方须传入用户「探测并确认」得到的 `ImProfile`
//! （bundle id / 主可执行路径），原生重查运行态后只操作已确认主进程与本次 Child。

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::Ordering;

static SESSION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
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
    /// 原生运行态校验的 bundle identifier。
    pub bundle_id: String,
    /// 主可执行文件绝对路径，用于带调试端口重启与主进程匹配。
    pub bin_path: String,
}

#[derive(Clone, Debug, PartialEq)]
struct ProcessIdentity {
    pid: i32,
    launched_at_ms: i64,
    bundle_id: String,
    bin_path: PathBuf,
}

#[derive(Clone)]
struct VerifiedProfile {
    profile: ImProfile,
    bundle_path: PathBuf,
    initial: ProcessIdentity,
}

fn process_identity(pid: i32) -> Option<ProcessIdentity> {
    let info = crate::focus::app_info_of(pid)?;
    let app = objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
    Some(ProcessIdentity {
        pid,
        launched_at_ms: info.launched_at_ms?,
        bundle_id: info.bundle_id?,
        bin_path: std::fs::canonicalize(app.executableURL()?.path()?.to_string()).ok()?,
    })
}

fn verify_profile(profile: ImProfile) -> Result<VerifiedProfile, String> {
    let bin_path =
        std::fs::canonicalize(&profile.bin_path).map_err(|_| "目标 IM 可执行路径无效")?;
    let candidate = crate::focus::running_regular_apps()
        .into_iter()
        .find(|candidate| {
            candidate.bundle_id == profile.bundle_id
                && std::fs::canonicalize(&candidate.bin_path).ok().as_ref() == Some(&bin_path)
        })
        .ok_or("目标应用身份已变化，请重新探测并确认")?;
    let info = crate::focus::running_app_info_for_bundle(&candidate.bundle_id)
        .ok_or("目标 IM 已退出，请重新探测")?;
    let initial = process_identity(info.pid).ok_or("无法确认目标 IM 进程身份")?;
    if initial.bin_path != bin_path || initial.bundle_id != profile.bundle_id {
        return Err("目标 IM 的 bundle 与可执行路径不匹配".into());
    }
    let macos = bin_path.parent().ok_or("目标路径无效")?;
    let contents = macos.parent().ok_or("目标路径无效")?;
    let bundle_path = contents.parent().ok_or("目标路径无效")?;
    if macos.file_name().is_none_or(|name| name != "MacOS")
        || contents.file_name().is_none_or(|name| name != "Contents")
        || bundle_path.extension().is_none_or(|ext| ext != "app")
    {
        return Err("仅支持应用包内的主可执行文件".into());
    }
    Ok(VerifiedProfile {
        bundle_path: bundle_path.to_path_buf(),
        profile: ImProfile {
            bundle_id: candidate.bundle_id,
            bin_path: bin_path.to_string_lossy().into_owned(),
        },
        initial,
    })
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
    let profile = verify_profile(profile)?;
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

fn fail_current_session(app: &AppHandle, generation: u64, error: String) {
    if !generation_changed(app, generation) {
        message_watch::cdp_end(app);
        message_watch::cdp_set_error(app, error);
    }
}

// ── 后台驱动：确保带端口的目标 IM 在跑 → 连 CDP → 断连重连 → 收尾 ──

async fn run_cdp(app: AppHandle, generation: u64, script: String, profile: VerifiedProfile) {
    // 新会话必须等旧会话完成恢复；旧 generation 不能与新会话交叉操作进程。
    let _session = SESSION.lock().await;
    if generation_changed(&app, generation) {
        return;
    }
    // 排队期间旧会话可能已恢复了另一个 PID，重新核实用户选定的 bundle/路径。
    let profile = match verify_profile(profile.profile) {
        Ok(profile) => profile,
        Err(error) => {
            fail_current_session(&app, generation, error);
            return;
        }
    };
    let launch_profile = profile.clone();
    let started = tokio::task::spawn_blocking(move || launch_im_with_cdp(&launch_profile)).await;
    let (browser_ws, child, port) = match started {
        Ok(Ok(session)) => session,
        Ok(Err(error)) => {
            fail_current_session(&app, generation, error);
            return;
        }
        Err(_) => {
            fail_current_session(
                &app,
                generation,
                "IM 启动任务异常，请手动检查目标应用".into(),
            );
            return;
        }
    };
    crate::diag::push(&app, "目标 IM 已以调试模式启动，CDP 通道就绪");
    let mut runtime = NativeSession {
        profile,
        child: Some(child),
        port,
    };
    while !generation_changed(&app, generation) {
        if runtime
            .child
            .as_mut()
            .is_none_or(|child| child.try_wait().ok().flatten().is_some())
        {
            message_watch::cdp_set_error(&app, "目标 IM 已退出，自动接入结束".into());
            break;
        }
        match cdp_session(&app, &browser_ws, &script, generation).await {
            Ok(()) => break,
            Err(error) => {
                if !generation_changed(&app, generation) {
                    message_watch::cdp_set_error(&app, error);
                }
                if !sleep_interruptible(&app, generation, Duration::from_secs(2)).await {
                    break;
                }
            }
        }
    }
    let cleanup = tokio::task::spawn_blocking(move || finish_session(&mut runtime)).await;
    if !generation_changed(&app, generation) {
        message_watch::cdp_end(&app);
    }
    match cleanup {
        Ok(Ok(())) => crate::diag::push(&app, "IM CDP 监听已关闭，已核验目标 IM 正常启动"),
        Ok(Err(error)) => {
            crate::diag::push(&app, "IM CDP 恢复失败，需要手动检查目标应用");
            message_watch::cdp_set_error(&app, error);
        }
        Err(_) => message_watch::cdp_set_error(&app, "IM 恢复任务异常，需要手动检查".into()),
    }
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
        await_result(
            &mut read,
            id,
            app,
            generation,
            Some(&session_id),
            &mut write,
        )
        .await?;
    }
    if generation_changed(app, generation) {
        return Ok(());
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

trait SessionRuntime {
    fn stop_owned(&mut self) -> Result<(), String>;
    fn restore_normal(&mut self) -> Result<(), String>;
}

fn finish_session(runtime: &mut impl SessionRuntime) -> Result<(), String> {
    runtime.stop_owned()?;
    runtime.restore_normal()
}

struct NativeSession {
    profile: VerifiedProfile,
    child: Option<Child>,
    port: u16,
}

impl SessionRuntime for NativeSession {
    fn stop_owned(&mut self) -> Result<(), String> {
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        if child
            .try_wait()
            .map_err(|_| "读取本次 IM 进程状态失败")?
            .is_some()
        {
            self.child.take();
            return Ok(());
        }
        // Child 未被 wait 回收时 PID 不会重用。只请求本次主进程正常退出，不强杀 Helper。
        if unsafe { libc::kill(child.id() as i32, libc::SIGTERM) } != 0 {
            return Err("无法结束本次 IM 调试进程，请手动关闭".into());
        }
        if !wait_until(
            || child.try_wait().ok().flatten().is_some(),
            Duration::from_secs(8),
        ) {
            return Err("本次 IM 调试进程尚未退出，未启动恢复实例；请手动关闭".into());
        }
        self.child.take();
        Ok(())
    }

    fn restore_normal(&mut self) -> Result<(), String> {
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], self.port));
        if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            return Err("本次调试端口仍可访问，未确认恢复；请手动关闭目标 IM".into());
        }
        if crate::focus::running_app_info_for_bundle(&self.profile.profile.bundle_id).is_some() {
            return Err("检测到会话外启动的 IM，未操作该进程；请手动确认调试模式已关闭".into());
        }
        let status = Command::new("/usr/bin/open")
            .arg(&self.profile.bundle_path)
            .status()
            .map_err(|_| "无法启动目标 IM 的正常模式")?;
        if !status.success() {
            return Err("目标 IM 正常启动命令失败".into());
        }
        if !wait_until(
            || {
                crate::focus::running_app_info_for_bundle(&self.profile.profile.bundle_id)
                    .and_then(|info| process_identity(info.pid))
                    .is_some_and(|identity| identity.bin_path == self.profile.initial.bin_path)
            },
            Duration::from_secs(8),
        ) {
            return Err("未能核验目标 IM 正常启动，请手动打开应用".into());
        }
        Ok(())
    }
}

fn launch_im_with_cdp(profile: &VerifiedProfile) -> Result<(String, Child, u16), String> {
    let port = pick_free_port()?;
    terminate_confirmed(&profile.initial)?;
    let mut runtime = NativeSession {
        profile: profile.clone(),
        child: None,
        port,
    };
    let launch: Result<String, String> = (|| {
        runtime.child = Some(spawn_im(&profile.profile, port)?);
        let ws = await_browser_ws(runtime.child.as_mut().unwrap(), Duration::from_secs(15))?;
        let endpoint = reqwest::Url::parse(&ws).map_err(|_| "IM 调试端点格式无效")?;
        if endpoint.scheme() != "ws"
            || endpoint.host_str() != Some("127.0.0.1")
            || endpoint.port() != Some(port)
        {
            return Err("IM 调试端点与本次本机端口不匹配".into());
        }
        Ok(ws)
    })();
    match launch {
        Ok(ws) => Ok((ws, runtime.child.take().unwrap(), port)),
        Err(error) => match finish_session(&mut runtime) {
            Ok(()) => Err(format!("{error}；已核验恢复正常启动")),
            Err(recovery) => Err(format!("{error}；{recovery}")),
        },
    }
}

fn identity_matches(expected: &ProcessIdentity, current: Option<&ProcessIdentity>) -> bool {
    current == Some(expected)
}

fn terminate_checked(
    identity: &ProcessIdentity,
    current: Option<&ProcessIdentity>,
    terminate: impl FnOnce() -> bool,
    wait_for_exit: impl FnOnce() -> bool,
) -> Result<(), String> {
    if !identity_matches(identity, current) {
        return Err("目标 IM 进程身份已变化，未执行重启".into());
    }
    if !terminate() {
        return Err("目标 IM 拒绝退出，请先保存工作并手动关闭".into());
    }
    if !wait_for_exit() {
        return Err("目标 IM 尚未退出，未强制结束进程".into());
    }
    Ok(())
}

fn terminate_confirmed(identity: &ProcessIdentity) -> Result<(), String> {
    let app =
        objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(identity.pid)
            .ok_or("目标 IM 已退出")?;
    terminate_checked(
        identity,
        process_identity(identity.pid).as_ref(),
        || app.terminate(),
        || {
            wait_until(
                || !identity_matches(identity, process_identity(identity.pid).as_ref()),
                Duration::from_secs(8),
            )
        },
    )
}

fn pick_free_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("选空闲端口失败：{e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("读取端口失败：{e}"))
}

fn spawn_im(profile: &ImProfile, port: u16) -> Result<Child, String> {
    Command::new(&profile.bin_path)
        .arg(format!("--remote-debugging-port={port}"))
        .arg("--remote-debugging-address=127.0.0.1")
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
                    let ws = line[idx..]
                        .split_whitespace()
                        .next()
                        .unwrap_or("")
                        .to_string();
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

    #[derive(Default)]
    struct FakeRuntime {
        events: Vec<&'static str>,
        stop_error: bool,
        restore_error: bool,
    }

    impl SessionRuntime for FakeRuntime {
        fn stop_owned(&mut self) -> Result<(), String> {
            self.events.push("stop owned");
            if self.stop_error {
                Err("owned still running".into())
            } else {
                Ok(())
            }
        }
        fn restore_normal(&mut self) -> Result<(), String> {
            self.events.push("restore and verify");
            if self.restore_error {
                Err("restore unverified".into())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn launch_failure_or_cancel_stops_owned_before_verified_restore() {
        let mut runtime = FakeRuntime::default();
        finish_session(&mut runtime).unwrap();
        assert_eq!(runtime.events, ["stop owned", "restore and verify"]);
    }

    #[test]
    fn owned_process_refusing_exit_does_not_launch_another_instance() {
        let mut runtime = FakeRuntime {
            stop_error: true,
            ..Default::default()
        };
        assert_eq!(
            finish_session(&mut runtime).unwrap_err(),
            "owned still running"
        );
        assert_eq!(runtime.events, ["stop owned"]);
    }

    #[test]
    fn failed_restore_is_not_reported_as_success() {
        let mut runtime = FakeRuntime {
            restore_error: true,
            ..Default::default()
        };
        assert_eq!(
            finish_session(&mut runtime).unwrap_err(),
            "restore unverified"
        );
    }

    #[test]
    fn changed_pid_launch_time_bundle_or_path_is_never_terminated() {
        let expected = ProcessIdentity {
            pid: 42,
            launched_at_ms: 123,
            bundle_id: "example.im".into(),
            bin_path: PathBuf::from("/Applications/IM.app/Contents/MacOS/IM"),
        };
        let mut changed = vec![expected.clone(); 4];
        changed[0].pid += 1;
        changed[1].launched_at_ms += 1;
        changed[2].bundle_id = "another.app".into();
        changed[3].bin_path = PathBuf::from("/tmp/untrusted");
        for current in changed.iter().map(Some).chain(std::iter::once(None)) {
            assert!(terminate_checked(
                &expected,
                current,
                || panic!("must not signal an unconfirmed process"),
                || panic!("must not wait on an unconfirmed process")
            )
            .is_err());
        }
        assert!(terminate_checked(&expected, Some(&expected), || true, || true).is_ok());
        assert!(terminate_checked(
            &expected,
            Some(&expected),
            || false,
            || panic!("must not wait after rejected quit")
        )
        .is_err());
        assert!(terminate_checked(&expected, Some(&expected), || true, || false).is_err());
    }

    #[tokio::test]
    async fn rapid_reenable_waits_for_old_session_cleanup_before_new_start() {
        use std::sync::{Arc, Mutex};
        let events = Arc::new(Mutex::new(Vec::new()));
        let old_session = SESSION.lock().await;
        let (queued, ready) = tokio::sync::oneshot::channel();
        let new_events = events.clone();
        let next = tokio::spawn(async move {
            queued.send(()).unwrap();
            let _session = SESSION.lock().await;
            new_events.lock().unwrap().push("start new");
        });
        ready.await.unwrap();
        assert!(events.lock().unwrap().is_empty());
        let mut old = FakeRuntime::default();
        finish_session(&mut old).unwrap();
        events.lock().unwrap().extend(old.events);
        drop(old_session);
        next.await.unwrap();
        assert_eq!(
            *events.lock().unwrap(),
            ["stop owned", "restore and verify", "start new"]
        );
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
