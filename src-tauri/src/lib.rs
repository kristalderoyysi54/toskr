mod ax;
mod activity;
mod backup;
mod capture;
mod clipwatch;
mod commands;
mod data_integrity;
mod delivery;
mod diag;
mod events;
mod exchange;
mod favicon;
mod focus;
mod input;
mod image_firewall;
mod ocr;
mod ai;
mod linkmeta;
mod message_watch;
mod message_watch_cdp;
mod pasteboard;
mod privacy;
mod rich_clipboard;
mod state;
mod storage;
mod target;
mod tray;
mod window;

use tauri::{Emitter, Manager};

use state::AppState;

pub fn run() {
    tauri::Builder::default()
        // 单实例必须最先注册：二次启动时聚焦已有面板。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            window::set_panel_auto_hide_armed(app, true, "二次启动");
            window::request_show_panel(app);
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState::default())
        .manage(message_watch::MessageWatchState::default())
        .manage(diag::DiagLog::default())
        .manage(storage::Storage::default())
        .setup(|app| {
            if let Err(error) = storage::initialize_storage(app.handle()) {
                diag::push(
                    app.handle(),
                    format!("数据存储进入只读恢复模式: {:?}", error.code),
                );
                storage::enter_storage_recovery_mode(app.handle(), error);
            }
            // Draft 遮挡副本只活在当前进程会话；启动即清理崩溃遗留。
            if let Err(error) = image_firewall::initialize_transient_store(app.handle()) {
                diag::push(app.handle(), format!("图片隐私临时区初始化失败: {error}"));
            }
            // 启动指纹：证明当前运行的是哪个构建的哪个进程（排查部署未生效）
            diag::push(
                app.handle(),
                format!(
                    "启动 v{} pid={}",
                    app.package_info().version,
                    std::process::id()
                ),
            );

            // 前台应用观察者：持续更新窗口布局用的 prev_app_pid，以及“下一次发送”
            // 的目标快照。相同进程身份保持 token；一次发送开始后持有自己的不可变
            // snapshot，不会被观察器后续切到 B 的更新改写。
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let me = std::process::id() as i32;
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        if let Some(f) = focus::frontmost_info() {
                            if f.pid != me {
                                target::observe_front(&handle, &f);
                            } else {
                                target::revalidate_observed_target(&handle);
                            }
                        }
                    }
                });
            }

            // 轮询只作低频身份复核；所有 Toskr 窗口共享的应用激活事件才是
            // 短暂 A→B→self 切换的安全关键目标来源。
            focus::install_workspace_activation_observer(app.handle().clone());

            // Sequoia 上 Accessory 策略是 CGEventTap 能创建成功的前提，
            // 必须先于 tap 安装（Prohibited 策略即使已授权也会静默失败）。
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{
                    apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
                };
                // state=Active：失焦时也保持通透材质（默认会切 inactive 变实）
                let active = Some(NSVisualEffectState::Active);
                if let Some(win) = app.get_webview_window("main") {
                    let _ =
                        apply_vibrancy(&win, NSVisualEffectMaterial::HudWindow, active, Some(14.0));
                    window::ensure_fullscreen_auxiliary(&win);
                }
                if let Some(win) = app.get_webview_window("hud") {
                    // HUD 自绘纸白气泡 + 尾巴 + logo（异形剪影），不再贴整窗 vibrancy 圆角膜
                    let _ = win.set_ignore_cursor_events(true);
                    window::ensure_fullscreen_auxiliary(&win);
                }
                if let Some(win) = app.get_webview_window("sourceoverlay") {
                    let _ = win.set_ignore_cursor_events(true);
                    window::ensure_fullscreen_auxiliary(&win);
                }
                if let Some(win) = app.get_webview_window("locatehl") {
                    let _ = win.set_ignore_cursor_events(true);
                    window::ensure_fullscreen_auxiliary(&win);
                }

                let installed = match input::tap::install(app.handle().clone()) {
                    Ok(()) => true,
                    Err(e) => {
                        eprintln!("[toskr] {e}");
                        false
                    }
                };
                app.state::<AppState>()
                    .tap_installed
                    .store(installed, std::sync::atomic::Ordering::SeqCst);
                if !installed {
                    // 弹出系统「辅助功能」授权提示，前端横幅同步引导。
                    let _ = ax::request_trust_with_prompt();
                }
            }

            // 剪贴板历史 watcher 常驻线程（开关由设置项经 set_clip_watch 门控）
            clipwatch::spawn(app.handle().clone());

            // 贴边隐藏光标轮询 + 滑出/滑回动画常驻线程（开关由 auto_edge_hide 门控）
            window::spawn_edge_hide_supervisor(app.handle());

            // 托盘在 tap 安装之后创建，初始菜单即可反映权限状态。
            tray::create(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // 常驻应用：任何窗口的关闭请求都转为隐藏。
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let _ = window.hide();
                    api.prevent_close();
                }
                // 独立模式下用户拖动面板 → 记住位置并通知前端持久化
                tauri::WindowEvent::Moved(pos) => {
                    if window.label() != "main" {
                        return;
                    }
                    let app = window.app_handle();
                    if window::is_docked(app) {
                        return;
                    }
                    // 机器驱动的移动一律不当成「用户手动拖拽」记录：贴边滑出/
                    // 滑回动画（原生 NSAnimationContext 每帧都触发 Moved）、以及
                    // 程序自己摆放面板（停靠/边栏/伴随重定位/改宽度）。否则会把
                    // 面板自己算出的停靠位污染进 panel_free_pos，下次显示即误判成
                    // 手动拖离右缘，连锁清空贴边隐藏锚点——贴边隐藏整体失效。
                    if window::is_machine_move(app) {
                        return;
                    }
                    let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
                    let (x, y) = (pos.x as f64 / scale, pos.y as f64 / scale);
                    window::on_user_panel_move(app, x, y);
                    let _ = app.emit_to(
                        "main",
                        "toskr://panel-moved",
                        serde_json::json!({ "x": x, "y": y }),
                    );
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::show_panel,
            commands::hide_panel,
            commands::copy_text,
            commands::copy_rich_clipboard,
            commands::localize_rich_clipboard_images,
            commands::get_target_snapshot,
            commands::refresh_target_snapshot,
            commands::validate_target_snapshot,
            commands::send_delivery,
            commands::scan_sensitive_text,
            commands::scan_image_firewall,
            commands::redact_delivery_image,
            commands::cleanup_redacted_images,
            commands::clear_redacted_images,
            commands::delivery_image_data_url,
            commands::send_to_chat,
            commands::ax_trusted,
            commands::tap_status,
            commands::retry_tap,
            commands::restart_app,
            commands::set_window_theme,
            commands::open_settings_window,
            commands::set_vibrancy,
            commands::set_window_alpha,
            commands::set_panel_free_pos,
            commands::open_privacy_settings,
            commands::reset_input_monitoring,
            commands::copy_image_to_clipboard,
            commands::paste_images_from_clipboard,
            commands::import_image_files,
            commands::open_url,
            commands::set_hotkey_config,
            commands::set_panel_hotkey,
            commands::set_companion_config,
            commands::set_excluded_apps,
            commands::set_companion_gap,
            commands::set_panel_width,
            commands::adjust_panel_edge,
            commands::set_panel_vertical,
            commands::set_stealth,
            commands::set_sound,
            commands::set_hud_duration,
            commands::set_sidebar_mode,
            commands::is_self_frontmost,
            commands::set_panel_topmost,
            commands::set_auto_edge_hide,
            commands::edge_hide_now,
            commands::set_panel_pinned,
            commands::set_panel_drag_active,
            commands::evaluate_drag_dock,
            commands::set_double_tap_mode,
            commands::set_clip_watch,
            commands::set_clip_rules,
            commands::set_clip_pause,
            commands::set_message_watch,
            commands::get_message_watch_status,
            commands::get_message_watch_bridge_info,
            commands::get_message_watch_captures,
            commands::locate_message_source,
            commands::message_watch_app_installed,
            commands::detect_running_im_candidates,
            commands::set_message_watch_auto,
            commands::quick_look,
            commands::hide_transient_image_preview,
            commands::show_text_preview,
            commands::ocr_image,
            commands::prev_app_info,
            commands::refresh_prev_app,
            commands::show_capture_hud,
            commands::hud_feedback,
            commands::hide_hud,
            commands::app_icon,
            commands::app_list_info,
            commands::bundle_id_of_app,
            commands::diag_note,
            commands::get_diagnostics,
            commands::append_delivery_event,
            commands::get_recent_delivery_events,
            commands::clear_delivery_events,
            commands::get_data_dir,
            commands::get_data_location_status,
            commands::retry_storage_initialization,
            commands::load_default_from_recovery,
            commands::clear_data_conflict,
            commands::mark_data_conflict,
            commands::inspect_data_location,
            commands::begin_data_operation,
            commands::begin_recovery_data_operation,
            commands::finalize_data_operation,
            commands::rollback_data_operation,
            commands::read_data_snapshot,
            commands::write_data_if_current,
            commands::image_data_url,
            commands::image_thumb_url,
            commands::export_complete_backup,
            commands::export_conflict_recovery_backup,
            commands::inspect_backup,
            commands::create_data_recovery_backup,
            commands::begin_complete_backup_import,
            commands::read_legacy_backup,
            commands::inspect_media_integrity,
            commands::schedule_media_gc,
            commands::run_media_gc,
            linkmeta::fetch_link_meta,
            favicon::fetch_favicon,
            exchange::fetch_exchange_rates,
            ai::set_ai_api_key,
            ai::get_ai_key_status,
            ai::delete_ai_api_key,
            ai::ai_chat,
            ai::ai_list_models,
        ])
        .run(tauri::generate_context!())
        .expect("Toskr 启动失败");
}
