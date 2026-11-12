//! 应用内诊断环形缓冲：把关键链路事件（触发/拒绝/捕获分支/发送结果）
//! 记录到内存，设置面板「诊断」页可直接查看——用户报障时自己就能看到原因，
//! 不再依赖命令行启动才可见的 stderr。

use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const CAP: usize = 50;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagEntry {
    pub at_ms: u64,
    pub msg: String,
}

#[derive(Default)]
pub struct DiagLog(Mutex<VecDeque<DiagEntry>>);

/// WebView 文本不可信：仅映射固定事件码，不将异常、URL、卡片 ID 或正文落盘。
pub(crate) fn frontend_event(message: &str) -> &'static str {
    const EVENTS: &[(&str, &str)] = &[
        ("webview 挂载", "frontend.mounted"),
        ("webview JS 错误", "frontend.render_error"),
        ("webview 未处理拒绝", "frontend.unhandled_rejection"),
        ("前端收到 Toggle:", "frontend.toggle_received"),
        ("贴边: 快捷键唤出", "frontend.edge_revealed"),
        ("富图片: 解析丢弃", "frontend.rich_image_omitted"),
        ("详情窗载荷", "frontend.detail_payload_received"),
        ("详情窗投递超时", "frontend.detail_delivery_timeout"),
        ("数据冲突事件:", "frontend.data_conflict"),
        ("旧存储清理延后", "frontend.legacy_cleanup_deferred"),
        ("图片隐私临时副本清理失败", "frontend.image_cleanup_failed"),
        ("图片隐私会话清理失败", "frontend.image_session_cleanup_failed"),
        ("前端阻断:", "frontend.delivery_blocked"),
    ];
    EVENTS.iter().find(|(prefix, _)| message.starts_with(prefix))
        .map(|(_, event)| *event).unwrap_or("frontend.unclassified")
}

/// WKWebView 当前 WebContent 进程 pid（私有 `_webProcessIdentifier`，有
/// respondsToSelector 守卫；取不到返回 -1）。只用于诊断日志。
#[cfg(target_os = "macos")]
pub(crate) fn webcontent_pid(wk_webview: *mut std::ffi::c_void) -> i32 {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    let Some(view) = (unsafe { (wk_webview as *const AnyObject).as_ref() }) else {
        return -1;
    };
    unsafe {
        let ok: bool = msg_send![view, respondsToSelector: sel!(_webProcessIdentifier)];
        if !ok {
            return -1;
        }
        msg_send![view, _webProcessIdentifier]
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn webcontent_pid(_wk_webview: *mut std::ffi::c_void) -> i32 {
    -1
}

#[cfg(test)]
mod frontend_tests {
    use super::frontend_event;

    #[test]
    fn arbitrary_frontend_content_never_enters_diagnostics() {
        for prefix in ["webview JS 错误", "前端阻断:", "数据冲突事件:", "旧存储清理延后", "详情窗载荷", "unknown"] {
            let message = format!("{prefix} API_KEY=synthetic-secret https://example.com/?token=private\n正文");
            let result = frontend_event(&message);
            assert!(result.starts_with("frontend."));
            assert!(!result.contains("private"));
            assert!(!result.contains("synthetic"));
            assert!(!result.contains("https"));
            assert!(!result.contains('\n'));
        }
        assert_eq!(frontend_event("webview 挂载 label=main"), "frontend.mounted");
        assert_eq!(frontend_event("前端收到 Toggle: source=keyboard"), "frontend.toggle_received");
    }

    #[test]
    fn ipc_summary_only_when_frequent_and_ranked() {
        let mut counts = std::collections::HashMap::new();
        counts.insert("a".to_string(), 30);
        assert_eq!(super::ipc_summary(&counts), None);
        counts.insert("b".to_string(), 40);
        assert_eq!(super::ipc_summary(&counts).unwrap(), "IPC 频次(60s): 合计=70 b=40 a=30");
    }
}

/// IPC 调用频次（按命令名计数）。每 60s 结算一次，总数 ≥ 60（≥1 次/秒）才落一行
/// 「IPC 频次(60s): 命令=次数 …」取前 6 名——空闲时前端不该持续调用后端，
/// 这行出现即说明有轮询在跑。只记命令名，不记参数与返回值。
static IPC_COUNTS: Mutex<Option<(u64, std::collections::HashMap<String, u32>)>> = Mutex::new(None);
const IPC_WINDOW_MS: u64 = 60_000;
const IPC_REPORT_MIN: u32 = 60;

pub(crate) fn count_ipc(app: &AppHandle, command: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let report = {
        let mut guard = IPC_COUNTS.lock().unwrap();
        let (since, counts) = guard.get_or_insert_with(|| (now, Default::default()));
        let report = if now.saturating_sub(*since) >= IPC_WINDOW_MS {
            let line = ipc_summary(counts);
            counts.clear();
            *since = now;
            line
        } else {
            None
        };
        if command.len() <= 64 {
            *counts.entry(command.to_string()).or_insert(0) += 1;
        }
        report
    };
    if let Some(line) = report {
        push(app, line);
    }
}

fn ipc_summary(counts: &std::collections::HashMap<String, u32>) -> Option<String> {
    let total: u32 = counts.values().sum();
    if total < IPC_REPORT_MIN {
        return None;
    }
    let mut top: Vec<_> = counts.iter().collect();
    top.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    let parts: Vec<String> = top.iter().take(6).map(|(k, v)| format!("{k}={v}")).collect();
    Some(format!("IPC 频次(60s): 合计={total} {}", parts.join(" ")))
}

/// 记录一条诊断（同时输出到 stderr 供命令行调试）。任意线程可调。
pub fn push(app: &AppHandle, msg: impl Into<String>) {
    let msg = msg.into();
    eprintln!("[toskr] {msg}");
    let at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // 同时落盘到应用数据目录 toskr-diag.log：`open` 启动的 GUI 进程没有
    // 可见的 stderr，落盘让报障可以事后取证。超 2MiB 轮转到 .log.1
    // （单档覆盖式，best-effort）；日志只含元数据，但前台应用名/时间线也算
    // 行为痕迹，文件权限同样收紧到 0600。
    // 注意用应用数据目录而非用户自定义数据目录——日志是应用内部产物，
    // 不该混进用户挑的资料文件夹（且后者可能在 TCC 保护路径下）。
    let path = crate::storage::app_data_dir(app).join("toskr-diag.log");
    if std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.len() > 2 * 1024 * 1024) {
        let _ = std::fs::rename(&path, path.with_file_name("toskr-diag.log.1"));
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut f) = options.open(&path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        let _ = writeln!(f, "{at_ms} {msg}");
    }
    if let Some(log) = app.try_state::<DiagLog>() {
        let mut q = log.0.lock().unwrap();
        q.push_back(DiagEntry { at_ms, msg });
        while q.len() > CAP {
            q.pop_front();
        }
    }
}

/// 读取全部诊断（新→旧）。
pub fn entries(app: &AppHandle) -> Vec<DiagEntry> {
    app.try_state::<DiagLog>()
        .map(|log| log.0.lock().unwrap().iter().rev().cloned().collect())
        .unwrap_or_default()
}
