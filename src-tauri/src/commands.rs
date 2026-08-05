//! 前端可调用的 Tauri 命令。
//!
//! 约定：非 async 命令在 Tauri v2 中于主线程执行（可安全做窗口/AppKit 操作）；
//! 含 sleep 的流程一律 async + spawn_blocking。

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::input::synth;
use crate::state::{AppState, MOD_CONTROL, MOD_OPTION, MOD_SHIFT};

/// 定位到目标位置并显示面板（伴随/经典模式由 Rust 侧裁决）。
#[tauri::command]
pub fn show_panel(app: AppHandle) {
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
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())?;
    crate::clipwatch::mark_self_write(&app);
    Ok(())
}

/// 图片附件 OCR（Vision 离线识别，中英）。空结果返回 Err。
#[tauri::command]
pub async fn ocr_image(app: AppHandle, file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::ocr::recognize(&app, &file))
        .await
        .map_err(|e| e.to_string())?
}

/// 剪贴板历史收集开关（设置项下发）。
#[tauri::command]
pub fn set_clip_watch(app: AppHandle, enabled: bool) {
    app.state::<AppState>()
        .clip_watch
        .store(enabled, Ordering::SeqCst);
}

/// 图片原尺寸预览（自建预览窗；面板 320-520pt 放不下大图）。
/// 组合卡传全部图片，`index` 为起始张（预览窗内 ←/→ 翻看）。
#[tauri::command]
pub fn quick_look(app: AppHandle, files: Vec<String>, index: Option<usize>) {
    crate::window::preview_image(&app, files, index.unwrap_or(0));
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

/// 一键发送：备份剪贴板 → 收面板 → 激活目标并确认到达 →
/// 先粘贴文本，再逐张粘贴图片附件（图片必须以图片形式写入剪贴板，
/// 否则只会粘出占位文字）→ 可选回车 → 延迟还原剪贴板。
/// 目标未到达则**中止**并返回 false（不粘贴、不标完成）。
#[tauri::command]
pub async fn send_to_chat(
    app: AppHandle,
    text: String,
    image_files: Vec<String>,
    press_enter: bool,
    keep_panel: bool,
) -> Result<bool, String> {
    // 备份用户原剪贴板（文本），发送完成后还原，避免静默吞掉用户内容
    let saved = arboard::Clipboard::new()
        .ok()
        .and_then(|mut c| c.get_text().ok());

    // 图片先在主线程外读成像素，避免粘贴过程中再读盘拖慢节奏
    let images: Vec<(usize, usize, Vec<u8>)> = image_files
        .iter()
        .filter_map(|f| crate::storage::read_image_rgba(&app, f))
        .collect();

    let target_pid = *app.state::<AppState>().prev_app_pid.lock().unwrap();
    let target_name = target_pid
        .and_then(crate::focus::app_name_of)
        .unwrap_or_else(|| "目标应用".to_string());
    crate::diag::push(
        &app,
        format!(
            "发送 → {target_name}({}) 文本{}字 图{}张",
            target_pid.map_or("?".into(), |p| p.to_string()),
            text.chars().count(),
            images.len()
        ),
    );
    // 钉住时保留面板（仅把焦点交回目标应用），否则收起面板
    if keep_panel {
        if let Some(pid) = target_pid {
            crate::focus::activate_pid(pid);
        }
    } else {
        crate::window::hide_panel(&app, false);
    }

    let has_text = !text.trim().is_empty();
    let mark_handle = app.clone();
    let sent = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        if let Some(pid) = target_pid {
            crate::focus::activate_pid(pid);
            // 激活是异步的：确认目标真正到达前台，未到达即中止（防误粘贴）
            if !crate::focus::wait_frontmost(pid, 10, 40) {
                return Ok(false);
            }
        }
        std::thread::sleep(Duration::from_millis(180));

        if has_text {
            {
                let mut c = arboard::Clipboard::new().map_err(|e| e.to_string())?;
                c.set_text(text).map_err(|e| e.to_string())?;
            }
            crate::clipwatch::mark_self_write(&mark_handle);
            synth::press_paste()?;
        }

        for (w, h, rgba) in images {
            // 每张图单独写入剪贴板再粘贴。间隔必须足够长：慢应用（聊天类）
            // 异步消化上一张图期间就覆盖剪贴板会导致后续粘贴被吞（只发出一张）
            std::thread::sleep(Duration::from_millis(700));
            if let Some(pid) = target_pid {
                // 目标中途失焦（图片预览弹层抢焦等）时重新激活，防粘错地方/丢图
                if !crate::focus::wait_frontmost(pid, 5, 40) {
                    crate::focus::activate_pid(pid);
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
            {
                let mut c = arboard::Clipboard::new().map_err(|e| e.to_string())?;
                c.set_image(arboard::ImageData {
                    width: w,
                    height: h,
                    bytes: rgba.into(),
                })
                .map_err(|e| e.to_string())?;
            }
            crate::clipwatch::mark_self_write(&mark_handle);
            synth::press_paste()?;
        }

        if press_enter {
            std::thread::sleep(Duration::from_millis(200));
            synth::press_return()?;
        }
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())??;

    crate::diag::push(
        &app,
        if sent { "发送: 粘贴完成" } else { "发送: 目标未就绪，已中止" },
    );
    // 发送回执 HUD：成功报告去向（发错目标一眼可见），失败明确警示
    if sent {
        crate::window::show_hud(&app, "sent", format!("已发送到 {target_name}"), false, false, None);
    } else {
        // 单条合并文案：原先这里与下方 else 连发两条 warn，HUD 单槽互相覆盖
        crate::window::show_hud(
            &app,
            "warn",
            format!("发送中止：{target_name} 未到达前台 · 内容已在剪贴板"),
            false, false, None,
        );
    }
    if sent {
        // 目标应用已在按键事件处理中读取粘贴板；延迟还原用户原剪贴板
        let restore_handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(1500));
            if let Some(text) = saved {
                if let Ok(mut c) = arboard::Clipboard::new() {
                    let _ = c.set_text(text);
                    crate::clipwatch::mark_self_write(&restore_handle);
                }
            }
        });
    }
    Ok(sent)
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

/// 面板快捷键触发：快照前台应用（供「发送到对话」归还焦点）后开关面板。
fn on_panel_hotkey(app: &AppHandle) {
    crate::diag::push(app, "面板快捷键触发");
    let me = std::process::id() as i32;
    if let Some(front) = crate::focus::frontmost_info() {
        if front.pid != me {
            *app.state::<AppState>().prev_app_pid.lock().unwrap() = Some(front.pid);
        }
    }
    let _ = app.emit_to(
        "main",
        crate::events::TRIGGER_EVENT,
        crate::events::TriggerPayload::Toggle { force: true },
    );
}

/// 下发伴随停靠配置。
#[tauri::command]
pub fn set_companion_config(app: AppHandle, enabled: bool, apps: Vec<String>) {
    let state = app.state::<AppState>();
    *state.companion.lock().unwrap() = crate::state::CompanionConfig { enabled, apps };
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
#[tauri::command]
pub fn refresh_prev_app(app: AppHandle) {
    let me = std::process::id() as i32;
    if let Some(front) = crate::focus::frontmost_info() {
        if front.pid != me {
            *app.state::<AppState>().prev_app_pid.lock().unwrap() = Some(front.pid);
        }
    }
    crate::window::maybe_redock(&app);
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
#[tauri::command]
pub fn show_capture_hud(app: AppHandle, kind: String, preview: String) {
    let kind = if kind == "duplicate" { "duplicate" } else { "added" };
    // 前端去重裁决的回执也进诊断：与「捕获:」行拼起来即是完整链路
    crate::diag::push(&app, format!("入库回执: {kind}「{preview}」"));
    // 捕获动作轻响一声（系统音 Pop；重复内容同样响——动作要有听觉回执；
    // 隐身模式/开关关闭时静音）
    let state = app.state::<AppState>();
    if state.sound_enabled.load(Ordering::Relaxed)
        && !state.stealth.load(Ordering::SeqCst)
    {
        let _ = std::process::Command::new("afplay")
            .arg("/System/Library/Sounds/Pop.aiff")
            .spawn();
    }
    crate::window::show_hud(&app, kind, preview, kind == "added", false, None);
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
            let fetched = crate::focus::app_icon_png_base64(&bundle_id)
                .map(|i| (i.data_url, i.color));
            state
                .icon_cache
                .lock()
                .unwrap()
                .insert(bundle_id, fetched.clone());
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
    crate::focus::app_list_info(&bundle_id)
        .map(|(name, icon_url)| AppListInfo { name, icon_url })
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
#[tauri::command]
pub fn set_window_theme(app: AppHandle, theme: String) {
    let theme = match theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None, // 跟随系统
    };
    for label in ["main", "settings"] {
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
        let _ = apply_vibrancy(
            &window,
            mat,
            Some(NSVisualEffectState::Active),
            Some(14.0),
        );
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

// ===== 存储（可自定义数据文件夹 + 图片附件） =====

/// 当前数据文件夹路径。
#[tauri::command]
pub fn get_data_dir(app: AppHandle) -> String {
    crate::storage::data_dir(&app).to_string_lossy().to_string()
}

/// 切换数据文件夹（搬运已有数据与图片）。
#[tauri::command]
pub fn set_data_dir(app: AppHandle, path: String) -> Result<String, String> {
    crate::storage::set_data_dir(&app, std::path::Path::new(&path))?;
    Ok(crate::storage::data_dir(&app).to_string_lossy().to_string())
}

/// 恢复默认数据文件夹。
#[tauri::command]
pub fn reset_data_dir(app: AppHandle) -> Result<String, String> {
    crate::storage::reset_data_dir(&app)?;
    Ok(crate::storage::data_dir(&app).to_string_lossy().to_string())
}

/// 读取笔记数据文件（不存在返回 None，前端回落旧存储做一次性迁移）。
#[tauri::command]
pub fn read_data_file(app: AppHandle) -> Option<String> {
    crate::storage::read_data(&app)
}

/// 写入笔记数据文件（原子替换）。
#[tauri::command]
pub fn write_data_file(app: AppHandle, content: String) -> Result<(), String> {
    crate::storage::write_data(&app, &content)
}

/// 图片附件的 data URL（前端 <img> 直接渲染）。
#[tauri::command]
pub fn image_data_url(app: AppHandle, name: String) -> Option<String> {
    crate::storage::image_data_url(&app, &name)
}

/// 卡片缩略图 data URL（首次生成落盘缓存；解码走阻塞线程池不占 UI）。
#[tauri::command]
pub async fn image_thumb_url(app: AppHandle, name: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::storage::image_thumb_data_url(&app, &name)
    })
    .await
    .ok()
    .flatten()
}

/// 删除图片附件（卡片删除时清理）。
#[tauri::command]
pub fn remove_image(app: AppHandle, name: String) {
    crate::storage::remove_image(&app, &name);
}

/// 导出备份到用户选定路径。
#[tauri::command]
pub fn export_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("写入失败: {e}"))
}

/// 从用户选定路径读入备份。
#[tauri::command]
pub fn import_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))
}
