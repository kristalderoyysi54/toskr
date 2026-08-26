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
