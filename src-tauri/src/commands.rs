//! 前端可调用的 Tauri 命令。
//!
//! 约定：非 async 命令在 Tauri v2 中于主线程执行（可安全做窗口/AppKit 操作）；
//! 含 sleep 的流程一律 async + spawn_blocking。

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{AppState, MOD_CONTROL, MOD_OPTION, MOD_SHIFT};

/// 定位到目标位置并显示面板。快捷键呼出可要求在真实拖动/Esc 前保持展开。
#[tauri::command]
pub fn show_panel(app: AppHandle, shortcut_hold: Option<bool>) {
    crate::window::set_panel_auto_hide_armed(
        &app,
        !shortcut_hold.unwrap_or(false),
        "显示入口",
    );
    crate::window::request_show_panel(&app);
}

/// 隐藏面板；`restore_focus` 时归还焦点给此前的前台应用。
#[tauri::command]
pub fn hide_panel(app: AppHandle, restore_focus: bool) {
    crate::window::hide_panel(&app, restore_focus);
}

/// 写系统剪贴板（「复制为列表」等）。
#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    let _permit = crate::pasteboard::try_claim(&app)
        .ok_or_else(|| "剪贴板事务进行中，请稍后重试".to_string())?;
    let exact_count = crate::pasteboard::write_general_text(&text).map_err(|e| e.to_string())?;
    crate::clipwatch::mark_self_write_count(&app, exact_count);
    Ok(())
}

/// 将 HTML 中解析出的图片源按原顺序本地化；结果只带 index/状态/本地文件，
/// 不回显或记录可能含鉴权参数的完整 URL。
#[tauri::command]
pub async fn localize_rich_clipboard_images(
    app: AppHandle,
    sources: Vec<String>,
    source_url: Option<String>,
) -> Vec<crate::rich_clipboard::LocalizedRichImage> {
    crate::rich_clipboard::localize_images(&app, sources, source_url).await
}

/// 把有序文字/图片块写成同一 pasteboard item 的 plain + HTML 两种表示。
#[tauri::command]
pub async fn copy_rich_clipboard(
    app: AppHandle,
    blocks: Vec<crate::rich_clipboard::RichClipboardBlock>,
) -> Result<crate::rich_clipboard::RichClipboardWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || crate::rich_clipboard::write_blocks(&app, &blocks))
        .await
        .map_err(|_| "创建富剪贴板任务失败".to_string())?
        .map_err(|error| error.to_string())
}

/// 图片附件 OCR（Vision 离线识别，中英）。空结果返回 Err。
#[tauri::command]
pub async fn ocr_image(app: AppHandle, file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ocr::recognize(&app, &file))
        .await
        .map_err(|e| e.to_string())?
}

/// 本地 OCR + 逐观察文本 Firewall；诊断仅记录计数与耗时。
#[tauri::command]
pub async fn scan_image_firewall(
    app: AppHandle,
    file: String,
    force: Option<bool>,
) -> Result<crate::image_firewall::ScanImageFirewallResult, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::image_firewall::scan(&worker_app, &file, force.unwrap_or(false))
    })
    .await
    .map_err(|_| "本地图片隐私检查任务失败".to_string())?
}

/// 从原图创建纯色遮挡副本；缺省只写会话临时目录，图片编辑显式要求时
/// 可写内容寻址媒体文件。两种路径都不覆盖原图。
#[tauri::command]
pub async fn redact_delivery_image(
    app: AppHandle,
    request: crate::image_firewall::RedactImageRequest,
) -> Result<crate::image_firewall::RedactImageResult, String> {
    tauri::async_runtime::spawn_blocking(move || crate::image_firewall::redact(&app, request))
        .await
        .map_err(|_| "创建遮挡图片任务失败".to_string())?
}

#[tauri::command]
pub async fn cleanup_redacted_images(app: AppHandle, files: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::image_firewall::cleanup(&app, &files))
        .await
        .map_err(|_| "清理遮挡图片任务失败".to_string())?
}

#[tauri::command]
pub async fn clear_redacted_images(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::image_firewall::clear_all(&app))
        .await
        .map_err(|_| "清理图片隐私会话任务失败".to_string())?
}

#[tauri::command]
pub async fn delivery_image_data_url(
    app: AppHandle,
    file: String,
    full_size: Option<bool>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::image_firewall::delivery_image_data_url(&app, &file, full_size.unwrap_or(false))
    })
    .await
    .map_err(|_| "读取图片隐私预览任务失败".to_string())
}

/// 剪贴板历史收集开关（设置项下发）。
#[tauri::command]
pub fn set_clip_watch(app: AppHandle, enabled: bool) {
    app.state::<AppState>()
        .clip_watch
        .store(enabled, Ordering::SeqCst);
}

/// 会话级实验开关：重启 Toskr 后默认关闭，不写持久设置。
#[tauri::command]
pub fn set_message_watch(
    app: AppHandle,
    enabled: bool,
) -> Result<crate::message_watch::MessageWatchStatus, String> {
    crate::message_watch::set_enabled(&app, enabled)
}

#[tauri::command]
pub fn get_message_watch_status(
    app: AppHandle,
) -> crate::message_watch::MessageWatchStatus {
    crate::message_watch::current_status(&app)
}

#[tauri::command]
pub fn get_message_watch_bridge_info(
    app: AppHandle,
) -> Result<crate::message_watch::MessageWatchBridgeInfo, String> {
    crate::message_watch::bridge_info(&app)
}

#[tauri::command]
pub fn get_message_watch_captures(
    app: AppHandle,
    limit: Option<usize>,
) -> Result<Vec<crate::message_watch::MessageWatchCapture>, String> {
    crate::message_watch::recent_captures(&app, limit.unwrap_or(1_000))
}

/// 用户指定的目标 IM（按 bundle id）是否已安装；设置页据此降级为「暂不支持」提示。
#[tauri::command]
pub fn message_watch_app_installed(bundle_id: String) -> bool {
    crate::focus::app_installed_for_bundle(&bundle_id)
}

/// 探测当前正在运行的候选 IM：设置页开启监听时列出让用户确认要监听哪一个。
/// 代码不预置任何具体应用；仅返回运行中的常规 GUI 应用（已排除 Toskr 自身）。
#[tauri::command]
pub fn detect_running_im_candidates() -> Vec<crate::focus::RunningApp> {
    crate::focus::running_regular_apps()
}

/// 在来源应用中定位会话（滚动会话列表 + 高亮该行；不打开会话、不改已读）。
/// AX 遍历 + 滚动轮询最长 ~1.5s：走 spawn_blocking，不占主线程与 async 运行时。
#[tauri::command]
pub async fn locate_message_source(
    app: AppHandle,
    payload: crate::window::SourceOverlayPayload,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::window::locate_source_conversation(&app, payload)
    })
    .await
    .map_err(|error| format!("定位任务异常：{error}"))?
}

/// CDP 免手动监听开关（会话级）。开启需前端传入 transport=cdp 的桥脚本，以及用户
/// 探测并确认的目标 IM profile；Rust 侧据此重启目标 IM 为调试模式并自动注入。
#[tauri::command]
pub fn set_message_watch_auto(
    app: AppHandle,
    enabled: bool,
    script: Option<String>,
    profile: Option<crate::message_watch_cdp::ImProfile>,
) -> Result<crate::message_watch::MessageWatchStatus, String> {
    crate::message_watch_cdp::set_enabled(&app, enabled, script, profile)
}

/// 图片原尺寸预览（自建预览窗；面板 320-520pt 放不下大图）。
/// 组合卡传全部图片，`index` 为起始张（预览窗内 ←/→ 翻看）。
/// `note_id`/`note_text`：所属笔记的 id 与当前文字（图片卡详情内联编辑
/// 备注用；不传则预览窗不显示编辑条）；`edit` 为 true 时直接进入编辑态；
/// `transient` 为悬停窥视形态（不抢焦点、鼠标穿透，指针移开由前端收起）。
#[tauri::command]
pub fn quick_look(
    app: AppHandle,
    files: Vec<String>,
    index: Option<usize>,
    note_id: Option<String>,
    note_text: Option<String>,
    data_generation: Option<u64>,
    edit: bool,
    edit_context: Option<serde_json::Value>,
    transient: Option<bool>,
) {
    crate::window::preview_image(
        &app,
        files,
        index.unwrap_or(0),
        note_id,
        note_text,
        data_generation,
        edit,
        edit_context,
        transient.unwrap_or(false),
    );
}

/// 收起悬停窥视的瞬态预览窗（Space/点击打开的常规预览窗不受影响）。
#[tauri::command]
pub fn hide_transient_image_preview(app: AppHandle) {
    crate::window::hide_transient_image_preview(&app);
}

/// 文本详情窗（桌面居中弹出；窄面板放不下长文，预览/编辑都在这个窗口）。
/// 内容由前端 emit 到 textpreview 窗口。
#[tauri::command]
pub fn show_text_preview(app: AppHandle) {
    crate::window::show_text_preview(&app);
}

/// 暂停剪贴板收集下发（设置页改动 → 同步 Rust 与托盘菜单；0 = 恢复）。
#[tauri::command]
pub fn set_clip_pause(app: AppHandle, until_ms: i64) {
    app.state::<AppState>()
        .clip_pause_until
        .store(until_ms.max(0), Ordering::Relaxed);
    crate::tray::refresh(&app);
}

/// 剪贴板规则下发：忽略机密/瞬时内容与独立忽略应用列表。
#[tauri::command]
pub fn set_clip_rules(
    app: AppHandle,
    ignore_concealed: bool,
    ignore_transient: bool,
    apps: Vec<String>,
) {
    let state = app.state::<AppState>();
    state
        .clip_ignore_concealed
        .store(ignore_concealed, Ordering::Relaxed);
    state
        .clip_ignore_transient
        .store(ignore_transient, Ordering::Relaxed);
    *state.clip_excluded_apps.lock().unwrap() = apps;
}

#[tauri::command]
pub fn get_target_snapshot(app: AppHandle) -> crate::target::TargetSnapshot {
    crate::target::revalidate_observed_target(&app)
}

#[tauri::command]
pub fn refresh_target_snapshot(app: AppHandle) -> crate::target::TargetSnapshot {
    crate::target::refresh_current(&app.state::<AppState>())
}

#[tauri::command]
pub fn validate_target_snapshot(
    app: AppHandle,
    target_token: Option<String>,
) -> crate::target::TargetSnapshot {
    crate::target::validate_current(&app.state::<AppState>(), target_token.as_deref())
}

async fn run_delivery(
    app: AppHandle,
    request: crate::delivery::SendDeliveryRequest,
) -> Result<crate::delivery::SendDeliveryResult, String> {
    let enter_requested = request.press_enter;
    let result = crate::delivery::execute_native(app.clone(), request).await?;
    let target = result.target.as_ref();
    crate::diag::push(
        &app,
        format!(
            "delivery={} target={}({}) status={} reason={} enter_requested={} enter_synthesized={}",
            result.delivery_id,
            target
                .and_then(|snapshot| snapshot.bundle_id.as_deref())
                .unwrap_or("?"),
            target
                .and_then(|snapshot| snapshot.pid)
                .map_or_else(|| "?".into(), |pid| pid.to_string()),
            result.status.as_str(),
            result.reason_code.as_str(),
            enter_requested,
            result.enter_pressed,
        ),
    );
    let (hud_kind, hud_message) = crate::delivery::hud_feedback(&result);
    crate::window::show_hud(&app, hud_kind, hud_message.to_string(), false, false, None);
    Ok(result)
}

/// 唯一原生发送契约。所有失败均通过结构化结果返回；只有运行时 join 失败才 reject。
#[tauri::command]
pub async fn send_delivery(
    app: AppHandle,
    request: crate::delivery::SendDeliveryRequest,
) -> Result<crate::delivery::SendDeliveryResult, String> {
    run_delivery(app, request).await
}

/// 完全本地的确定性文本扫描。大文本放入 blocking pool，避免占用 WebView/UI 线程；
/// 诊断摘要由 privacy 模块生成，永不包含正文或命中原值。
#[tauri::command]
pub async fn scan_sensitive_text(
    app: AppHandle,
    request: crate::privacy::ScanSensitiveRequest,
) -> Result<crate::privacy::ScanSensitiveResult, String> {
    let started = std::time::Instant::now();
    let result =
        tauri::async_runtime::spawn_blocking(move || crate::privacy::scan_sensitive_text(request))
            .await
            .map_err(|error| format!("本地隐私扫描任务失败：{error}"))?;
    crate::diag::push(
        &app,
        crate::privacy::diagnostic_summary(&result, started.elapsed()),
    );
    Ok(result)
}

/// 旧调用兼容层：只组装新请求并委托 `send_delivery`，不保留第二套发送逻辑。
#[tauri::command]
pub async fn send_to_chat(
    app: AppHandle,
    text: String,
    image_files: Vec<String>,
    press_enter: bool,
    keep_panel: bool,
) -> Result<bool, String> {
    static LEGACY_DELIVERY_SEQ: AtomicU64 = AtomicU64::new(0);
    let snapshot = crate::target::current_snapshot(&app.state::<AppState>());
    let expected_image_pixel_hashes = vec![None; image_files.len()];
    let request = crate::delivery::SendDeliveryRequest {
        target_token: snapshot.token,
        text,
        image_files,
        expected_image_pixel_hashes,
        segments: None,
        press_enter,
        keep_panel,
        delivery_id: format!(
            "legacy-{}-{}",
            crate::target::now_ms(),
            LEGACY_DELIVERY_SEQ.fetch_add(1, Ordering::Relaxed)
        ),
    };
    Ok(run_delivery(app, request).await?.status == crate::delivery::DeliveryStatus::Sent)
}

/// 辅助功能授权状态；`prompt` 为 true 时未授权会弹系统提示。
#[tauri::command]
pub fn ax_trusted(prompt: bool) -> bool {
    if prompt {
        crate::ax::request_trust_with_prompt()
    } else {
        crate::ax::is_trusted()
    }
}

/// 全局键盘监听健康状态：installed=tap 已创建；receiving=真正收到过键盘事件
/// （Sequoia 上二者可分离：缺输入监控权限时创建成功但事件被静默扣留）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TapHealth {
    pub installed: bool,
    pub receiving: bool,
    pub listening: bool,
}

#[tauri::command]
pub fn tap_status(state: State<'_, AppState>) -> TapHealth {
    TapHealth {
        installed: state.tap_installed.load(Ordering::SeqCst),
        receiving: state.key_events_seen.load(Ordering::Relaxed),
        listening: crate::input::tap::listen_authorized(),
    }
}

/// 用户授权后重试安装监听（免重启）。
#[tauri::command]
pub fn retry_tap(app: AppHandle) {
    crate::input::tap::retry_install(&app);
}

/// 用默认浏览器打开链接（仅放行 http/https）。
#[tauri::command]
pub fn open_url(url: String) {
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastedImage {
    file: String,
    width: u32,
    height: u32,
}

/// 把一组本地图片路径导入媒体库（哈希去重）；坏文件/不支持格式跳过并留痕。
fn import_image_paths(app: &AppHandle, paths: &[String]) -> Vec<PastedImage> {
    let mut imported = Vec::new();
    for path in paths {
        if !crate::storage::is_image_file_path(path) {
            continue;
        }
        match crate::storage::import_image_file(app, path) {
            Ok((file, width, height)) => imported.push(PastedImage {
                file,
                width,
                height,
            }),
            Err(e) => crate::diag::push(app, format!("图片导入失败 {path}: {e}")),
        }
    }
    imported
}

/// 从系统剪贴板读图并入库（⌘V 粘贴图片）。**本地图片文件优先**（与 clipwatch
/// 同序）：Finder 复制文件时剪贴板同时带 file-url 与文件「图标」位图，位图
/// 优先会把图标当成图片入库；只有不含图片文件路径时才读位图（截图/应用内复制）。
/// 无图返回空。走 Rust 直读（与剪贴板历史同款 arboard 路径），避免图片字节过 IPC。
#[tauri::command]
pub async fn paste_images_from_clipboard(app: AppHandle) -> Result<Vec<PastedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_paths = crate::pasteboard::read_file_paths();
        if file_paths
            .iter()
            .any(|p| crate::storage::is_image_file_path(p))
        {
            let imported = import_image_paths(&app, &file_paths);
            if !imported.is_empty() {
                crate::diag::push(&app, format!("粘贴入库: 本地图片文件 ×{}", imported.len()));
            }
            // 含图片文件路径就定死走文件分支：坏文件也不回退位图，
            // 否则又会把 Finder 图标当内容收进来
            return Ok(imported);
        }
        let mut c = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        if let Ok(img) = c.get_image() {
            let (w, h) = (img.width as u32, img.height as u32);
            let file = crate::storage::save_image_rgba(&app, img.width, img.height, &img.bytes)?;
            crate::diag::push(&app, format!("粘贴入库: 图片 {w}×{h}"));
            return Ok(vec![PastedImage {
                file,
                width: w,
                height: h,
            }]);
        }
        Ok(Vec::new())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 拖入的本地图片文件入库（详情窗拖拽添加）。非图片/坏文件跳过。
#[tauri::command]
pub async fn import_image_files(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<PastedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let imported = import_image_paths(&app, &paths);
        if !imported.is_empty() {
            crate::diag::push(&app, format!("拖拽入库: 本地图片文件 ×{}", imported.len()));
        }
        Ok(imported)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把图片附件写入系统剪贴板（图片卡「复制内容」）。
/// 复用全局 pasteboard 写入许可与精确 generation 标记，防止历史收录自家写入。
#[tauri::command]
pub async fn copy_image_to_clipboard(app: AppHandle, file: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let (w, h, rgba) = crate::storage::read_image_rgba(&app, &file)
            .ok_or_else(|| "图片读取失败".to_string())?;
        let _permit = crate::pasteboard::try_claim(&app)
            .ok_or_else(|| "剪贴板事务进行中，请稍后重试".to_string())?;
        let exact_count =
            crate::pasteboard::write_general_image(w, h, &rgba).map_err(|e| e.to_string())?;
        crate::clipwatch::mark_self_write_count(&app, exact_count);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 一键重置「输入监控」授权：等价于系统设置里删除 Toskr 条目（tccutil reset）。
/// 场景：TCC 条目的签名指纹与当前二进制不符时（首装预注册/换签名的经典顽疾），
/// 开关打开也收不到事件，只有删除条目让系统重新登记才能恢复。
#[tauri::command]
pub fn reset_input_monitoring(app: AppHandle) -> Result<(), String> {
    let bundle_id = app.config().identifier.clone();
    let out = std::process::Command::new("tccutil")
        .args(["reset", "ListenEvent", &bundle_id])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        crate::diag::push(&app, "权限: tccutil 已重置输入监控条目");
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        crate::diag::push(&app, format!("权限: tccutil 重置失败 {err}"));
        Err(err)
    }
}

/// 打开系统设置对应隐私面板："accessibility" | "input-monitoring"。
#[tauri::command]
pub fn open_privacy_settings(pane: String) {
    let url = match pane.as_str() {
        "input-monitoring" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        }
        _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    };
    let _ = std::process::Command::new("open").arg(url).spawn();
}

// ===== v2 命令 =====

/// 下发触发键配置（设置项）。
#[tauri::command]
pub fn set_hotkey_config(state: State<'_, AppState>, modifier: String, gap_ms: u16) {
    let m = match modifier.as_str() {
        "control" => MOD_CONTROL,
        "option" => MOD_OPTION,
        _ => MOD_SHIFT,
    };
    state.hotkey_modifier.store(m, Ordering::Relaxed);
    state
        .hotkey_gap_ms
        .store(gap_ms.clamp(200, 800), Ordering::Relaxed);
}

/// 注册/清除「面板显示/隐藏」全局快捷键（RegisterEventHotKey，独占按键）。
/// 与双击触发键完全独立：只开关面板，绝不捕获内容。
/// `shortcut` 为 global-shortcut 格式（如 "Cmd+Shift+KeyV"），None/空串 = 清除。
#[tauri::command]
pub fn set_panel_hotkey(app: AppHandle, shortcut: Option<String>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let gs = app.global_shortcut();
    // 该插件只承载这一个快捷键，整体清空即完成换绑/清除
    gs.unregister_all().map_err(|e| e.to_string())?;
    let Some(s) = shortcut.filter(|s| !s.trim().is_empty()) else {
        return Ok(());
    };
    gs.on_shortcut(s.as_str(), move |app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            on_panel_hotkey(app);
        }
    })
    .map_err(|e| {
        let msg = format!("快捷键注册失败：{e}");
        crate::diag::push(&app, format!("{msg} ({s})"));
        msg
    })?;
    crate::diag::push(&app, format!("面板快捷键已绑定: {s}"));
    Ok(())
}

/// 面板快捷键触发：先建立前台目标快照，再开关面板。
fn on_panel_hotkey(app: &AppHandle) {
    crate::diag::push(app, "面板快捷键触发");
    let me = std::process::id() as i32;
    if let Some(front) = crate::focus::frontmost_info() {
        if front.pid != me {
            crate::target::observe_front(app, &front);
        }
    }
    let _ = app.emit_to(
        "main",
        crate::events::TRIGGER_EVENT,
        crate::events::TriggerPayload::Toggle {
            force: true,
            source: crate::events::TriggerSource::Hotkey,
        },
    );
}

/// 下发伴随停靠配置。`side`："right"（默认，贴目标窗口右缘）| "left"（贴左缘）。
/// 关闭时必须解除接管（停跟踪器 + 复位 docked）——docked 残留会把贴边隐藏
/// 与拖拽入坞一起静默卡死；开启时立即刷新已显示面板，不能等下一次焦点事件。
/// 启动水合期间各项设置并发下发，若这里只换状态，面板可能已经按独立模式落在
/// 另一块屏幕，之后一直沿用旧位置。
#[tauri::command]
pub fn set_companion_config(app: AppHandle, enabled: bool, apps: Vec<String>, side: String) {
    let state = app.state::<AppState>();
    let side = if side == "left" { 1u8 } else { 0 };
    *state.companion.lock().unwrap() = crate::state::CompanionConfig {
        enabled,
        apps,
        side,
    };
    if enabled {
        crate::window::refresh_companion_takeover(&app);
    } else {
        crate::window::release_companion_takeover(&app);
    }
}

/// 伴随停靠间隙（pt，0=紧贴目标窗口）。
#[tauri::command]
pub fn set_companion_gap(app: AppHandle, gap: f64) {
    *app.state::<AppState>().companion_gap.lock().unwrap() = gap.clamp(0.0, 40.0);
}

/// 下发捕获排除列表。
#[tauri::command]
pub fn set_excluded_apps(app: AppHandle, apps: Vec<String>) {
    *app.state::<AppState>().excluded_apps.lock().unwrap() = apps;
}

/// 面板宽度（pt），可见时实时右吸附生效。
#[tauri::command]
pub fn set_panel_width(app: AppHandle, width: f64) {
    crate::window::set_panel_width(&app, width);
}

/// 隐身模式（前端设置持久化，Rust 运行态即时生效）。
#[tauri::command]
pub fn set_stealth(app: AppHandle, on: bool) {
    app.state::<AppState>().stealth.store(on, Ordering::SeqCst);
    crate::tray::refresh(&app);
}

/// 「上一个前台应用」的信息（设置里「把当前应用加入伴随列表」用——
/// 点击设置时前台是 Toskr 自己，真正想加的是打开面板前所在的应用）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrevAppInfo {
    pub bundle_id: String,
    pub name: Option<String>,
}

#[tauri::command]
pub fn prev_app_info(app: AppHandle) -> Option<PrevAppInfo> {
    let pid = (*app.state::<AppState>().prev_app_pid.lock().unwrap())?;
    let running =
        objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
    Some(PrevAppInfo {
        bundle_id: running.bundleIdentifier().map(|b| b.to_string())?,
        name: running.localizedName().map(|n| n.to_string()),
    })
}

/// 面板失焦后由前端调用：刷新「发送目标」为用户切去的应用（防 Pin 场景目标漂移），
/// 并在切到伴随应用时动态重吸附。
fn internal_aux_window_focused(app: &AppHandle) -> bool {
    ["settings", "textpreview", "imgpreview"]
        .into_iter()
        .any(|label| {
            app.get_webview_window(label)
                .and_then(|window| window.is_focused().ok())
                .unwrap_or(false)
        })
}

#[tauri::command]
pub fn refresh_prev_app(app: AppHandle) -> crate::target::TargetSnapshot {
    let me = std::process::id() as i32;
    let (observation_revision, front) = crate::focus::frontmost_info_with_revision();
    let snapshot = match front {
        Some(front) if front.pid != me => crate::target::observe_front(&app, &front),
        _ if internal_aux_window_focused(&app) => crate::target::revalidate_observed_target(&app),
        _ => crate::target::require_observation_after(&app, observation_revision),
    };
    crate::window::maybe_redock(&app);
    snapshot
}

/// 上/下缘拖拽调节（增量）。返回当前偏移与高度供前端持久化。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelVertical {
    pub top_offset: f64,
    pub height: Option<f64>,
}

#[tauri::command]
pub fn adjust_panel_edge(app: AppHandle, edge: String, delta: f64) -> PanelVertical {
    let (top_offset, height) = crate::window::adjust_panel_edge(&app, &edge, delta);
    PanelVertical { top_offset, height }
}

/// 设置/重置上下调节（启动同步、双击复位）。
#[tauri::command]
pub fn set_panel_vertical(app: AppHandle, top_offset: f64, height: Option<f64>) {
    crate::window::set_panel_vertical(&app, top_offset, height);
}

/// 前端入库裁决后回调展示捕获 HUD（kind: "added" | "duplicate"）。
fn capture_hud_feedback(
    kind: &str,
    preview: String,
    warning: Option<String>,
    association_suggested: bool,
    alias_restored_count: Option<u64>,
    auto_linked: bool,
) -> (&'static str, String, bool) {
    let (capture_kind, undoable) = if kind == "duplicate" {
        ("duplicate", false)
    } else {
        ("added", true)
    };
    match warning {
        // warn 在隐身模式也必须可见，因此绝不能携带用户捕获正文。
        Some(warning) => (
            "warn",
            format!(
                "{} · {warning}",
                if capture_kind == "duplicate" {
                    "内容已存在"
                } else {
                    "已捕获"
                }
            ),
            undoable,
        ),
        None => (
            capture_kind,
            {
                // 化名恢复/自动归位回执都以追加行呈现；只报事实，不报映射
                let mut text = preview;
                if capture_kind == "added" {
                    if let Some(count) = alias_restored_count.filter(|count| *count > 0) {
                        text = format!("{text}\n已恢复 {count} 处化名");
                    }
                    if auto_linked {
                        text = format!("{text}\n已自动保存为最近发送的回复");
                    } else if association_suggested {
                        text = format!("{text}\n可关联到最近一次发送，请在卡片右键确认");
                    }
                }
                text
            },
            undoable,
        ),
    }
}

#[tauri::command]
pub fn show_capture_hud(
    app: AppHandle,
    kind: String,
    preview: String,
    warning: Option<String>,
    association_suggested: bool,
    alias_restored_count: Option<u64>,
    auto_linked: bool,
) {
    let (hud_kind, text, undoable) = capture_hud_feedback(
        &kind,
        preview,
        warning,
        association_suggested,
        alias_restored_count,
        auto_linked,
    );
    let capture_kind = if kind == "duplicate" {
        "duplicate"
    } else {
        "added"
    };
    // 前端去重裁决的回执也进诊断：与「捕获:」行拼起来即是完整链路
    crate::diag::push(&app, format!("入库回执: {capture_kind}"));
    // 捕获动作轻响一声（系统音 Pop；重复内容同样响——动作要有听觉回执；
    // 隐身模式/开关关闭时静音）
    let state = app.state::<AppState>();
    if state.sound_enabled.load(Ordering::Relaxed) && !state.stealth.load(Ordering::SeqCst) {
        let _ = std::process::Command::new("afplay")
            .arg("/System/Library/Sounds/Pop.aiff")
            .spawn();
    }
    crate::window::show_hud(&app, hud_kind, text, undoable, false, None);
}

/// 双击触发行为下发：仅捕获 / 智能（无选中时开关面板）。
#[tauri::command]
pub fn set_double_tap_mode(app: AppHandle, capture_only: bool) {
    app.state::<AppState>()
        .double_tap_capture_only
        .store(capture_only, Ordering::Relaxed);
}

/// 捕获音效开关（设置项下发）。
#[tauri::command]
pub fn set_sound(app: AppHandle, enabled: bool) {
    app.state::<AppState>()
        .sound_enabled
        .store(enabled, Ordering::Relaxed);
}

/// 非粘性 HUD 自动隐藏时长（设置持久化，Rust 统一裁决所有提示入口）。
#[tauri::command]
pub fn set_hud_duration(app: AppHandle, duration_ms: u64) {
    app.state::<AppState>().hud_duration_ms.store(
        crate::state::clamp_hud_duration_ms(duration_ms),
        Ordering::Relaxed,
    );
}

/// 面板是否置顶（屏幕最上层）。关闭后面板可被其他窗口盖住。
/// 伴随磁吸期间面板与目标应用同层级（强制非置顶），此处只记偏好；
/// 脱离磁吸（独立/边栏）时按偏好恢复。
#[tauri::command]
pub fn set_panel_topmost(app: AppHandle, enabled: bool) {
    let state = app.state::<AppState>();
    state.panel_topmost.store(enabled, Ordering::SeqCst);
    if !state.docked.load(Ordering::SeqCst) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_always_on_top(enabled);
        }
    }
}

/// 旧设置兼容命令；当前前端固定下发 true。
#[tauri::command]
pub fn set_auto_edge_hide(app: AppHandle, enabled: bool) {
    crate::window::set_auto_edge_hide(&app, enabled);
}

/// 立即贴边滑出；`explicit` 用于 Esc，可解除快捷键保护并越过图钉。
#[tauri::command]
pub fn edge_hide_now(app: AppHandle, explicit: Option<bool>) -> bool {
    crate::window::edge_hide_now(&app, explicit.unwrap_or(false))
}

/// 面板固定（图钉）状态同步（前端 uiStore.pinned）。语义严格限定为
/// 「失焦不隐藏」：只豁免焦点驱动的收起（前端 blur 分支 / `edge_hide_now`），
/// 不影响光标驱动的贴边隐藏——钉住 + 已入坞 = Dock 行为。
#[tauri::command]
pub fn set_panel_pinned(app: AppHandle, pinned: bool) {
    app.state::<AppState>()
        .panel_pinned
        .store(pinned, Ordering::SeqCst);
}

/// 手动拖拽落定（前端拖拽去抖后调用）：拖到屏幕左右真实边界 → 吸平入坞
/// 贴边隐藏；拖到别处 → 保持自由摆放。
#[tauri::command]
pub fn evaluate_drag_dock(app: AppHandle) {
    crate::window::evaluate_drag_dock(&app);
}

/// 用户正在拖拽面板宽度/上下缘（前端 pointerdown~pointerup 期间下发）；
/// 拖拽期间贴边隐藏暂停计时，避免光标途经边界时误触发滑出。
#[tauri::command]
pub fn set_panel_drag_active(app: AppHandle, active: bool) {
    app.state::<AppState>()
        .panel_dragging
        .store(active, Ordering::Relaxed);
}

/// 前台应用是否是本应用（面板失焦判定：焦点移到自家预览/设置窗不算离开）。
#[tauri::command]
pub fn is_self_frontmost() -> bool {
    crate::focus::frontmost_info()
        .map(|f| f.pid == std::process::id() as i32)
        .unwrap_or(false)
}

/// 边栏模式开关与停靠缘（right/left/top/bottom；与伴随磁吸互斥）；
/// 面板可见时立即应用新布局。
#[tauri::command]
pub fn set_sidebar_mode(app: AppHandle, enabled: bool, edge: String) {
    let state = app.state::<AppState>();
    state.right_sidebar.store(enabled, Ordering::SeqCst);
    let code = match edge.as_str() {
        "left" => 1u8,
        "top" => 2,
        "bottom" => 3,
        _ => 0,
    };
    state.sidebar_edge.store(code, Ordering::SeqCst);
    crate::diag::push(
        &app,
        format!("边栏: {} {edge}", if enabled { "开" } else { "关" }),
    );
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            crate::window::request_show_panel(&app);
        }
    }
}

/// 立即隐藏 HUD（点击气泡打开面板时调用）。
#[tauri::command]
pub fn hide_hud(app: AppHandle) {
    crate::window::hide_hud_now(&app);
}

/// 通用 HUD 反馈（操作确认、错误提示等；`undoable` 时悬停可撤销；
/// `sticky` 为粘性气泡（任务到期提醒），仅点击可关闭，`target_id` 为点击跳转目标）。
#[tauri::command]
pub fn hud_feedback(
    app: AppHandle,
    kind: String,
    text: String,
    undoable: Option<bool>,
    sticky: Option<bool>,
    target_id: Option<String>,
) {
    crate::window::show_hud(
        &app,
        &kind,
        text,
        undoable.unwrap_or(false),
        sticky.unwrap_or(false),
        target_id,
    );
}

/// 前端链路诊断回执（Toggle 处理结果等落盘，报障时诊断页可见）。
#[tauri::command]
pub fn diag_note(app: AppHandle, msg: String) {
    crate::diag::push(&app, msg);
}

/// 应用图标 data URL + 主色（卡片顶部通栏底色用；带缓存，主线程命令）。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppIconInfo {
    pub url: String,
    pub color: String,
}

#[tauri::command]
pub fn app_icon(app: AppHandle, bundle_id: String) -> Option<AppIconInfo> {
    let state = app.state::<AppState>();
    let cached = state.icon_cache.lock().unwrap().get(&bundle_id).cloned();
    let pair = match cached {
        Some(hit) => hit,
        None => {
            let fetched =
                crate::focus::app_icon_png_base64(&bundle_id).map(|i| (i.data_url, i.color));
            // 只缓存成功结果：瞬时失败（应用恰好不在运行等）负缓存进 Map
            // 会让该 bundle 整个会话再也取不到图标——目标栏/卡片 logo 一起消失
            if fetched.is_some() {
                state
                    .icon_cache
                    .lock()
                    .unwrap()
                    .insert(bundle_id, fetched.clone());
            }
            fetched
        }
    };
    pair.map(|(url, color)| AppIconInfo { url, color })
}

/// 设置里应用列表的展示信息（不要求应用在运行；未安装返回 None）。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppListInfo {
    pub name: String,
    pub icon_url: Option<String>,
}

#[tauri::command]
pub fn app_list_info(bundle_id: String) -> Option<AppListInfo> {
    crate::focus::app_list_info(&bundle_id).map(|(name, icon_url)| AppListInfo { name, icon_url })
}

/// 从 .app 路径读 bundle id（设置里「选择应用」添加用）。
#[tauri::command]
pub fn bundle_id_of_app(path: String) -> Option<String> {
    let info = format!("{}/Contents/Info", path.trim_end_matches('/'));
    let out = std::process::Command::new("defaults")
        .args(["read", &info, "CFBundleIdentifier"])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// 设置窗口主题（system/light/dark）：同时切换原生外观与
/// webview 的 prefers-color-scheme，前端 CSS 深浅色自动跟随。
const THEMED_WINDOW_LABELS: [&str; 4] = ["main", "settings", "imgpreview", "sourceoverlay"];

#[tauri::command]
pub fn set_window_theme(app: AppHandle, theme: String) {
    let theme = match theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None, // 跟随系统
    };
    for label in THEMED_WINDOW_LABELS {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_theme(theme);
        }
    }
}

/// 外观：动态开关毛玻璃并切换材质（无需重启）。
/// material: "hud" | "popover" | "sidebar" | "under-window" | "fullscreen"
#[tauri::command]
pub fn set_vibrancy(app: AppHandle, enabled: bool, material: String) {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{
            apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
        };
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if !enabled {
            let _ = clear_vibrancy(&window);
            return;
        }
        let mat = match material.as_str() {
            "popover" => NSVisualEffectMaterial::Popover,
            "sidebar" => NSVisualEffectMaterial::Sidebar,
            "under-window" => NSVisualEffectMaterial::UnderWindowBackground,
            "fullscreen" => NSVisualEffectMaterial::FullScreenUI,
            _ => NSVisualEffectMaterial::HudWindow,
        };
        // 切材质需先清除旧的效果视图，否则会叠加。
        // state=Active：强制常亮材质，否则窗口失焦时系统会切到 inactive 外观，
        // 变成更实的灰底，通透感消失。
        let _ = clear_vibrancy(&window);
        let _ = apply_vibrancy(&window, mat, Some(NSVisualEffectState::Active), Some(14.0));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled, material);
    }
}

/// 窗口整体不透明度（毛玻璃层一并变透，实现真正的穿透查看）。
#[tauri::command]
pub fn set_window_alpha(app: AppHandle, alpha: f64) {
    crate::window::set_window_alpha(&app, alpha);
}

/// 独立模式手动位置：传 null 清除（下次回到屏幕右缘默认位）。
#[tauri::command]
pub fn set_panel_free_pos(app: AppHandle, x: Option<f64>, y: Option<f64>) {
    crate::window::set_free_pos(&app, x.zip(y));
}

/// 打开独立设置窗口。
#[tauri::command]
pub fn open_settings_window(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("settings") {
            // 从隐藏态打开时定位到「当前使用屏幕」居中；已可见则不动（尊重手动摆放）
            if !window.is_visible().unwrap_or(false) {
                crate::window::center_on_cursor_screen(&handle, &window);
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
}

/// 重启应用（输入监控授权变更后需要重启进程才能生效）。
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

/// 诊断日志（新→旧，最多 50 条）：触发/拒绝原因、捕获分支、发送结果。
#[tauri::command]
pub fn get_diagnostics(app: AppHandle) -> Vec<crate::diag::DiagEntry> {
    crate::diag::entries(&app)
}

#[tauri::command]
pub async fn append_delivery_event(
    app: AppHandle,
    event: crate::activity::DeliveryEvent,
    retention_days: u16,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::activity::append(&app, event, retention_days)
    })
    .await
    .map_err(|error| format!("后台发送活动写入失败：{error}"))?
}

#[tauri::command]
pub async fn get_recent_delivery_events(
    app: AppHandle,
    limit: usize,
    retention_days: u16,
) -> Result<Vec<crate::activity::DeliveryEvent>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::activity::recent(&app, limit, retention_days)
    })
    .await
    .map_err(|error| format!("后台发送活动读取失败：{error}"))?
}

#[tauri::command]
pub async fn clear_delivery_events(app: AppHandle) -> Result<(), String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || crate::activity::clear(&worker_app))
        .await
        .map_err(|error| format!("后台发送活动清除失败：{error}"))??;
    let _ = app.emit(crate::events::DELIVERY_ACTIVITY_CLEARED_EVENT, ());
    Ok(())
}

// ===== 存储（可自定义数据文件夹 + 图片附件） =====

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportPrepared {
    pub inspection: crate::backup::BackupInspection,
    pub operation: crate::data_integrity::DataOperationResult,
}

fn blocking_data_failure(
    error: impl std::fmt::Display,
) -> crate::data_integrity::DataOperationFailure {
    crate::data_integrity::DataOperationFailure {
        code: crate::data_integrity::DataOperationFailureCode::ReadFailed,
        message: format!("后台文件任务失败：{error}"),
    }
}

fn blocking_backup_failure(error: impl std::fmt::Display) -> crate::backup::BackupFailure {
    crate::backup::BackupFailure {
        code: crate::backup::BackupFailureCode::IoFailed,
        message: format!("后台备份任务失败：{error}"),
    }
}

/// 当前数据文件夹路径。
#[tauri::command]
pub fn get_data_dir(app: AppHandle) -> String {
    crate::storage::data_dir(&app).to_string_lossy().to_string()
}

#[tauri::command]
pub fn get_data_location_status(app: AppHandle) -> crate::storage::DataLocationStatus {
    crate::storage::data_location_status(&app)
}

#[tauri::command]
pub async fn retry_storage_initialization(
    app: AppHandle,
) -> Result<crate::storage::DataLocationStatus, crate::data_integrity::DataOperationFailure> {
    tauri::async_runtime::spawn_blocking(move || crate::storage::retry_storage_initialization(&app))
        .await
        .map_err(blocking_data_failure)?
}

#[tauri::command]
pub async fn load_default_from_recovery(
    app: AppHandle,
) -> Result<crate::storage::DataLocationStatus, crate::data_integrity::DataOperationFailure> {
    tauri::async_runtime::spawn_blocking(move || crate::storage::load_default_from_recovery(&app))
        .await
        .map_err(blocking_data_failure)?
}

#[tauri::command]
pub fn clear_data_conflict(app: AppHandle) {
    crate::storage::clear_data_conflict(&app);
}

#[tauri::command]
pub fn mark_data_conflict(
    app: AppHandle,
) -> Result<(), crate::data_integrity::DataOperationFailure> {
    crate::storage::mark_data_conflict(&app)
}

#[tauri::command]
pub async fn inspect_data_location(
    app: AppHandle,
    path: String,
) -> Result<
    crate::data_integrity::DataLocationInspection,
    crate::data_integrity::DataOperationFailure,
> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::storage::inspect_data_location(&app, std::path::Path::new(&path))
    })
    .await
    .map_err(blocking_data_failure)
}

#[tauri::command]
pub async fn begin_recovery_data_operation(
    app: AppHandle,
    plan: crate::data_integrity::DataOperationPlan,
) -> Result<crate::data_integrity::DataOperationResult, crate::data_integrity::DataOperationFailure>
{
    tauri::async_runtime::spawn_blocking(move || {
        crate::storage::begin_recovery_data_operation(&app, &plan)
    })
    .await
    .map_err(blocking_data_failure)?
}

#[tauri::command]
pub async fn begin_data_operation(
    app: AppHandle,
    plan: crate::data_integrity::DataOperationPlan,
) -> Result<crate::data_integrity::DataOperationResult, crate::data_integrity::DataOperationFailure>
{
    tauri::async_runtime::spawn_blocking(move || crate::storage::begin_data_operation(&app, &plan))
        .await
        .map_err(blocking_data_failure)?
}

#[tauri::command]
pub async fn finalize_data_operation(
    app: AppHandle,
    operation_id: String,
) -> Result<crate::data_integrity::DataOperationResult, crate::data_integrity::DataOperationFailure>
{
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::storage::finalize_data_operation(&worker_app, &operation_id)
    })
    .await
    .map_err(blocking_data_failure)??;
    let _ = app.emit("toskr://data-location-changed", &result);
    Ok(result)
}

#[tauri::command]
pub async fn rollback_data_operation(
    app: AppHandle,
    operation_id: String,
) -> Result<crate::data_integrity::DataOperationResult, crate::data_integrity::DataOperationFailure>
{
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::storage::rollback_data_operation(&worker_app, &operation_id)
    })
    .await
    .map_err(blocking_data_failure)??;
    let _ = app.emit("toskr://data-location-changed", &result);
    Ok(result)
}

#[tauri::command]
pub async fn read_data_snapshot(
    app: AppHandle,
) -> Result<crate::data_integrity::DataFileSnapshot, crate::data_integrity::DataOperationFailure> {
    tauri::async_runtime::spawn_blocking(move || crate::storage::read_data_snapshot(&app))
        .await
        .map_err(blocking_data_failure)?
}

#[tauri::command]
pub async fn write_data_if_current(
    app: AppHandle,
    content: String,
    expected_revision: String,
) -> Result<crate::data_integrity::DataFileSnapshot, crate::data_integrity::DataOperationFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::storage::write_data_if_current(&app, &content, &expected_revision)
    })
    .await
    .map_err(blocking_data_failure)?
}

/// 图片附件的 data URL（前端 <img> 直接渲染）。
#[tauri::command]
pub async fn image_data_url(app: AppHandle, name: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || crate::storage::image_data_url(&app, &name))
        .await
        .ok()
        .flatten()
}

/// 卡片缩略图 data URL（首次生成落盘缓存；解码走阻塞线程池不占 UI）。
#[tauri::command]
pub async fn image_thumb_url(app: AppHandle, name: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || crate::storage::image_thumb_data_url(&app, &name))
        .await
        .ok()
        .flatten()
}

#[tauri::command]
pub async fn export_complete_backup(
    app: AppHandle,
    path: String,
    state_json: String,
    expected_revision: String,
) -> Result<crate::backup::BackupInspection, crate::backup::BackupFailure> {
    let created_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64);
    tauri::async_runtime::spawn_blocking(move || {
        crate::storage::export_complete_backup(
            &app,
            std::path::Path::new(&path),
            &state_json,
            created_at_ms,
            Some(&expected_revision),
        )
    })
    .await
    .map_err(blocking_backup_failure)?
}

/// 把前端生成的 Markdown 与当前活动媒体打包为单一 ZIP。
#[tauri::command]
pub async fn export_notes_bundle(
    app: AppHandle,
    path: String,
    markdown: String,
    media_files: Vec<String>,
) -> Result<(), crate::note_export::NoteExportFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::storage::export_notes_bundle(
            &app,
            std::path::Path::new(&path),
            &markdown,
            &media_files,
        )
    })
    .await
    .map_err(|error| {
        crate::note_export::NoteExportFailure::io(format!("后台笔记导出任务失败：{error}"))
    })?
}

#[tauri::command]
pub async fn export_conflict_recovery_backup(
    app: AppHandle,
    path: String,
    state_json: String,
) -> Result<crate::backup::BackupInspection, crate::backup::BackupFailure> {
    let created_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64);
    tauri::async_runtime::spawn_blocking(move || {
        crate::storage::export_conflict_recovery_backup(
            &app,
            std::path::Path::new(&path),
            &state_json,
            created_at_ms,
        )
    })
    .await
    .map_err(blocking_backup_failure)?
}

#[tauri::command]
pub async fn inspect_backup(
    path: String,
) -> Result<crate::backup::BackupInspection, crate::backup::BackupFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::backup::inspect_backup(std::path::Path::new(&path))
    })
    .await
    .map_err(blocking_backup_failure)?
}

#[tauri::command]
pub async fn create_data_recovery_backup(
    app: AppHandle,
    state_json: String,
    operation_id: String,
    expected_revision: String,
) -> Result<String, crate::backup::BackupFailure> {
    if operation_id.is_empty()
        || operation_id.len() > 80
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(crate::backup::BackupFailure {
            code: crate::backup::BackupFailureCode::InvalidState,
            message: "operation ID 格式无效".into(),
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        let recovery_dir = crate::storage::default_data_dir(&app).join("recovery");
        std::fs::create_dir_all(&recovery_dir).map_err(blocking_backup_failure)?;
        let path = recovery_dir.join(format!("recovery-{operation_id}.toskr-backup"));
        let created_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis() as u64);
        crate::storage::export_complete_backup(
            &app,
            &path,
            &state_json,
            created_at_ms,
            Some(&expected_revision),
        )?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(blocking_backup_failure)?
}

#[tauri::command]
pub async fn begin_complete_backup_import(
    app: AppHandle,
    path: String,
    operation_id: String,
    expected_revision: String,
    expected_active_revision: String,
) -> Result<BackupImportPrepared, crate::storage::BackupImportFailure> {
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        crate::storage::begin_complete_backup_import(
            &app,
            std::path::Path::new(&path),
            &operation_id,
            &expected_revision,
            &expected_active_revision,
        )
    })
    .await
    .map_err(|error| crate::storage::BackupImportFailure {
        code: "ioFailed".into(),
        message: format!("后台导入任务失败：{error}"),
    })?;
    let (inspection, operation) = prepared?;
    Ok(BackupImportPrepared {
        inspection,
        operation,
    })
}

#[tauri::command]
pub async fn read_legacy_backup(
    path: String,
    expected_revision: String,
) -> Result<String, crate::backup::BackupFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::backup::read_legacy_backup(std::path::Path::new(&path), &expected_revision)
    })
    .await
    .map_err(blocking_backup_failure)?
}

#[tauri::command]
pub async fn inspect_media_integrity(
    app: AppHandle,
    state_json: String,
) -> Result<crate::data_integrity::MediaIntegrityReport, crate::data_integrity::DataOperationFailure>
{
    tauri::async_runtime::spawn_blocking(move || {
        crate::storage::inspect_media_integrity(&app, &state_json)
    })
    .await
    .map_err(blocking_data_failure)?
}

#[tauri::command]
pub async fn schedule_media_gc(
    app: AppHandle,
    files: Vec<String>,
    not_before_ms: u64,
) -> Result<(), crate::data_integrity::DataOperationFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::storage::schedule_media_gc(&app, &files, not_before_ms)
    })
    .await
    .map_err(blocking_data_failure)?
}

#[tauri::command]
pub async fn run_media_gc(
    app: AppHandle,
    state_json: String,
    now_ms: u64,
    expected_revision: String,
) -> Result<crate::data_integrity::MediaGcResult, crate::data_integrity::DataOperationFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::storage::run_media_gc(&app, &state_json, now_ms, &expected_revision)
    })
    .await
    .map_err(blocking_data_failure)?
}

#[cfg(test)]
mod tests {
    use super::{capture_hud_feedback, THEMED_WINDOW_LABELS};

    #[test]
    fn manual_theme_reaches_the_image_preview_window() {
        assert_eq!(
            THEMED_WINDOW_LABELS,
            ["main", "settings", "imgpreview", "sourceoverlay"]
        );
    }

    #[test]
    fn clipboard_restore_warning_stays_visible_without_losing_capture_undo() {
        let (kind, text, undoable) = capture_hud_feedback(
            "added",
            "捕获内容".into(),
            Some("原剪贴板仅恢复了可读内容".into()),
            true,
            None,
            false,
        );
        assert_eq!(kind, "warn");
        assert_eq!(text, "已捕获 · 原剪贴板仅恢复了可读内容");
        assert!(!text.contains("捕获内容"));
        assert!(undoable);

        let (kind, text, undoable) = capture_hud_feedback(
            "duplicate",
            "捕获内容".into(),
            Some("原剪贴板恢复失败".into()),
            true,
            None,
            false,
        );
        assert_eq!(kind, "warn");
        assert_eq!(text, "内容已存在 · 原剪贴板恢复失败");
        assert!(!text.contains("捕获内容"));
        assert!(!undoable);

        let (kind, text, undoable) =
            capture_hud_feedback("added", "捕获内容".into(), None, true, None, false);
        assert_eq!(kind, "added");
        assert_eq!(text, "捕获内容\n可关联到最近一次发送，请在卡片右键确认");
        assert!(undoable);
    }

    #[test]
    fn alias_restore_count_appends_line_only_for_added_capture() {
        let (kind, text, undoable) =
            capture_hud_feedback("added", "张三的回复".into(), None, false, Some(2), false);
        assert_eq!(kind, "added");
        assert_eq!(text, "张三的回复\n已恢复 2 处化名");
        assert!(undoable);

        // 数量为 0 不加行；重复捕获不加行
        let (_, text, _) =
            capture_hud_feedback("added", "预览".into(), None, false, Some(0), false);
        assert_eq!(text, "预览");
        let (_, text, _) =
            capture_hud_feedback("duplicate", "预览".into(), None, false, Some(3), false);
        assert_eq!(text, "预览");
    }

    #[test]
    fn auto_linked_line_replaces_association_suggestion() {
        // 自动归位行优先，且不再显示「请右键确认」建议行
        let (kind, text, _) =
            capture_hud_feedback("added", "回复内容".into(), None, true, Some(1), true);
        assert_eq!(kind, "added");
        assert_eq!(text, "回复内容\n已恢复 1 处化名\n已自动保存为最近发送的回复");
        assert!(!text.contains("右键确认"));

        // 重复捕获不追加自动归位行
        let (_, text, _) =
            capture_hud_feedback("duplicate", "预览".into(), None, false, None, true);
        assert_eq!(text, "预览");
    }
}
