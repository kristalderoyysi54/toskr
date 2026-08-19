//! 前台应用查询/激活、bundle id 识别与应用图标提取。

#![cfg(target_os = "macos")]

use block2::RcBlock;
use objc2::{runtime::AnyObject, AnyThread};
use objc2_app_kit::{
    NSApplicationActivationOptions, NSBitmapImageFileType, NSBitmapImageRep, NSRunningApplication,
    NSWorkspace, NSWorkspaceApplicationKey, NSWorkspaceDidActivateApplicationNotification,
};
use objc2_foundation::{NSDictionary, NSNotification, NSString};
use std::{
    ptr::NonNull,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::AppHandle;

static FRONT_OBSERVATION_REVISION: Mutex<u64> = Mutex::new(0);
static WORKSPACE_ACTIVATION_OBSERVER_INSTALLED: AtomicBool = AtomicBool::new(false);

/// 前台应用信息。
#[derive(Clone, Debug, Default)]
pub struct FrontApp {
    pub pid: i32,
    pub name: Option<String>,
    pub bundle_id: Option<String>,
    /// LaunchServices 记录的进程启动时刻；用于识别 PID 被同 bundle 新进程复用。
    pub launched_at_ms: Option<i64>,
    /// 与实际查询同序分配的进程内单调序号；并发调用据此丢弃迟到旧采样。
    pub observation_revision: u64,
}

fn launch_time_ms(app: &NSRunningApplication) -> Option<i64> {
    app.launchDate()
        .map(|date| (date.timeIntervalSince1970() * 1_000.0).round() as i64)
        .or_else(|| process_start_time_ms(app.processIdentifier()))
}

/// bundle 是否已安装（LaunchServices 查询；不要求正在运行）。
pub fn app_installed_for_bundle(bundle_id: &str) -> bool {
    let workspace = unsafe { NSWorkspace::sharedWorkspace() };
    unsafe {
        workspace
            .URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))
            .is_some()
    }
}

/// 内核记录的进程启动时刻（sysctl kinfo_proc）。
/// launchDate 只覆盖经 LaunchServices 启动的进程——消息监听自动接入用
/// Command::spawn 重启的推推拿不到 launchDate，目标身份校验会把它误判成
/// 「无法验证身份」并锁死发送。内核启动时刻对任何进程都存在，同样能
/// 识别 PID 被新进程复用（同一进程恒走同一来源，不会两源混比）。
fn process_start_time_ms(pid: i32) -> Option<i64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let written = unsafe {
        libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size)
    };
    if written < size {
        return None;
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_start_tvsec == 0 {
        return None;
    }
    Some(info.pbi_start_tvsec as i64 * 1_000 + (info.pbi_start_tvusec / 1_000) as i64)
}

fn running_app_info(app: &NSRunningApplication) -> FrontApp {
    FrontApp {
        pid: app.processIdentifier(),
        name: app.localizedName().map(|n| n.to_string()),
        bundle_id: app.bundleIdentifier().map(|b| b.to_string()),
        launched_at_ms: launch_time_ms(app),
        observation_revision: 0,
    }
}

fn observed_running_app_info(app: &NSRunningApplication) -> FrontApp {
    let mut revision = FRONT_OBSERVATION_REVISION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *revision = revision.wrapping_add(1).max(1);
    let mut front = running_app_info(app);
    front.observation_revision = *revision;
    front
}

fn activated_app(notification: &NSNotification) -> Option<FrontApp> {
    let user_info = notification.userInfo()?;
    // NSWorkspace guarantees this notification carries NSRunningApplication under this key.
    let typed: &NSDictionary<NSString, AnyObject> = unsafe { user_info.cast_unchecked() };
    let application_key = unsafe { NSWorkspaceApplicationKey };
    let app = typed
        .objectForKey(application_key)?
        .downcast::<NSRunningApplication>()
        .ok()?;
    Some(observed_running_app_info(&app))
}

/// 进程级应用激活事件源。它覆盖 main/settings/textpreview/imgpreview 全部窗口，
/// 并直接读取通知中的 NSRunningApplication，因此不会漏掉短于 250ms 的 B。
pub fn install_workspace_activation_observer(app: AppHandle) {
    if WORKSPACE_ACTIVATION_OBSERVER_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let me = std::process::id() as i32;
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
        let notification = unsafe { notification.as_ref() };
        let Some(front) = activated_app(notification) else {
            return;
        };
        if front.pid == me {
            crate::target::revalidate_observed_target(&app);
        } else {
            crate::target::observe_front(&app, &front);
        }
    });
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidActivateApplicationNotification),
            None,
            None,
            &block,
        )
    };
    // 应用进程只安装一次，生命周期与 NSWorkspace notification center 一致。
    std::mem::forget(observer);
}

/// 当前前台应用与同一次查询的单调序号。即使系统暂时没有 frontmost app，
/// 也推进序号，使调用方能建立“此前采样均不得解除 pending”的明确屏障。
pub fn frontmost_info_with_revision() -> (u64, Option<FrontApp>) {
    // 查询与编号必须同序：若先编号再被抢占，晚读到的 C 可能带旧 revision 被误丢。
    let mut revision = FRONT_OBSERVATION_REVISION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication();
    *revision = revision.wrapping_add(1).max(1);
    let observation_revision = *revision;
    let front = app.map(|app| {
        let mut front = running_app_info(&app);
        front.observation_revision = observation_revision;
        front
    });
    (observation_revision, front)
}

/// 当前前台应用信息。只读操作，任意线程可调。
pub fn frontmost_info() -> Option<FrontApp> {
    frontmost_info_with_revision().1
}

/// 指定 PID 对应的完整进程身份。PID 不存在时返回 None。
pub fn app_info_of(pid: i32) -> Option<FrontApp> {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .map(|app| running_app_info(&app))
}

/// 按 bundle id 查找已运行应用。只读查询，不启动、不激活应用。
pub fn running_app_info_for_bundle(bundle_id: &str) -> Option<FrontApp> {
    let bundle_id = NSString::from_str(bundle_id);
    NSRunningApplication::runningApplicationsWithBundleIdentifier(&bundle_id)
        .iter()
        .next()
        .map(|app| running_app_info(&app))
}

/// 当前前台应用的 (pid, 名称)。
pub fn frontmost() -> Option<(i32, Option<String>)> {
    frontmost_info().map(|f| (f.pid, f.name))
}

/// 指定 PID 应用的 bundle id。
pub fn bundle_of(pid: i32) -> Option<String> {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .and_then(|a| a.bundleIdentifier().map(|b| b.to_string()))
}

/// 激活指定 PID 的应用。空 options：Sonoma+ 的协作式激活默认即把窗口带前
/// （NSApplicationActivateIgnoringOtherApps 已弃用）。
pub fn activate_pid(pid: i32) -> bool {
    match NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
        Some(app) => app.activateWithOptions(NSApplicationActivationOptions(0)),
        None => false,
    }
}

/// 等待目标应用真正到达前台（激活是异步的），最多 `attempts × interval_ms`。
pub fn wait_frontmost(pid: i32, attempts: u32, interval_ms: u64) -> bool {
    for _ in 0..attempts {
        if frontmost().map(|(p, _)| p) == Some(pid) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(interval_ms));
    }
    false
}

/// 应用图标：base64 PNG + 主色（用于卡片顶部通栏底色）。
pub struct AppIcon {
    pub data_url: String,
    /// "#rrggbb"，已保证与白色文字有足够对比度。
    pub color: String,
}

/// 从图标像素提取主色：忽略透明与接近白/黑的像素，按饱和度加权取主色调，
/// 再压暗到可承载白色文字的亮度。
fn dominant_color(png: &[u8]) -> Option<String> {
    let img = image::load_from_memory(png).ok()?.to_rgba8();
    // 16 级色相桶，按饱和度×透明度加权统计
    let mut buckets = [(0f64, 0f64, 0f64, 0f64); 16];
    for p in img.pixels() {
        let [r, g, b, a] = p.0;
        if a < 128 {
            continue;
        }
        let (rf, gf, bf) = (r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
        let max = rf.max(gf).max(bf);
        let min = rf.min(gf).min(bf);
        let sat = if max <= 0.0 { 0.0 } else { (max - min) / max };
        // 极暗/极亮/灰度像素权重很低，避免被图标白底或黑边主导
        let weight = sat.powi(2) * max * (1.0 - (max - 0.5).abs() * 0.5);
        if weight <= 0.02 {
            continue;
        }
        let hue = if max == min {
            0.0
        } else if max == rf {
            (60.0 * (gf - bf) / (max - min) + 360.0) % 360.0
        } else if max == gf {
            60.0 * (bf - rf) / (max - min) + 120.0
        } else {
            60.0 * (rf - gf) / (max - min) + 240.0
        };
        let idx = ((hue / 22.5) as usize).min(15);
        let e = &mut buckets[idx];
        e.0 += rf * weight;
        e.1 += gf * weight;
        e.2 += bf * weight;
        e.3 += weight;
    }
    let best = buckets.iter().max_by(|a, b| a.3.total_cmp(&b.3))?;
    if best.3 <= 0.0 {
        // 无彩色像素（纯灰度图标）→ 中性灰
        return Some("#5b5b60".to_string());
    }
    let (mut r, mut g, mut b) = (best.0 / best.3, best.1 / best.3, best.2 / best.3);
    // 亮度压到 ≤0.62，保证白色文字可读
    let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if lum > 0.62 {
        let k = 0.62 / lum;
        r *= k;
        g *= k;
        b *= k;
    }
    Some(format!(
        "#{:02x}{:02x}{:02x}",
        (r * 255.0).round() as u8,
        (g * 255.0).round() as u8,
        (b * 255.0).round() as u8
    ))
}

/// 提取应用图标为 base64 PNG + 主色（**仅限主线程调用**：NSImage 非线程安全）。
/// 找不到应用/无图标返回 None。
pub fn app_icon_png_base64(bundle_id: &str) -> Option<AppIcon> {
    use base64::Engine;

    let ns_bundle = NSString::from_str(bundle_id);
    let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&ns_bundle);
    // 优先运行中的进程图标；查不到（应用刚退出/启动恢复的目标尚未运行/
    // 枚举瞬时失败）回退 NSWorkspace 按安装路径取——目标栏的 logo 不该
    // 因为一次运行态枚举落空就消失
    let icon = match apps.iter().next().and_then(|app| app.icon()) {
        Some(icon) => icon,
        None => {
            let ws = unsafe { NSWorkspace::sharedWorkspace() };
            let url = unsafe {
                ws.URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))
            }?;
            let path = url.path()?;
            unsafe { ws.iconForFile(&path) }
        }
    };
    let tiff = icon.TIFFRepresentation()?;
    let rep = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)?;
    let props = objc2_foundation::NSDictionary::new();
    let png =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }?;
    let bytes = png.to_vec();
    if bytes.is_empty() {
        return None;
    }
    let color = dominant_color(&bytes).unwrap_or_else(|| "#5b5b60".to_string());
    Some(AppIcon {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
        color,
    })
}

/// 已安装应用的列表展示信息（名称 + 图标 data URL）。与 `app_icon_png_base64`
/// 不同：走 NSWorkspace 查询，**不要求应用正在运行**（设置里的排除/忽略列表用）。
/// 仅限主线程调用（NSImage 非线程安全）。
pub fn app_list_info(bundle_id: &str) -> Option<(String, Option<String>)> {
    use base64::Engine;

    let ws = unsafe { NSWorkspace::sharedWorkspace() };
    let url = unsafe { ws.URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id)) }?;
    let name = unsafe { url.lastPathComponent() }?.to_string();
    let icon_url = (|| {
        let path = url.path()?;
        let img = unsafe { ws.iconForFile(&path) };
        let tiff = unsafe { img.TIFFRepresentation() }?;
        let rep = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)?;
        let props = objc2_foundation::NSDictionary::new();
        let png =
            unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }?;
        let bytes = png.to_vec();
        if bytes.is_empty() {
            return None;
        }
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })();
    Some((name, icon_url))
}
