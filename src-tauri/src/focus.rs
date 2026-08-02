//! 前台应用查询/激活、bundle id 识别与应用图标提取。

#![cfg(target_os = "macos")]

use objc2::AnyThread;
use objc2_app_kit::{
    NSApplicationActivationOptions, NSBitmapImageFileType, NSBitmapImageRep,
    NSRunningApplication, NSWorkspace,
};

/// 前台应用信息。
#[derive(Clone, Debug, Default)]
pub struct FrontApp {
    pub pid: i32,
    pub name: Option<String>,
    pub bundle_id: Option<String>,
}

/// 当前前台应用信息。只读操作，任意线程可调。
pub fn frontmost_info() -> Option<FrontApp> {
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    Some(FrontApp {
        pid: app.processIdentifier(),
        name: app.localizedName().map(|n| n.to_string()),
        bundle_id: app.bundleIdentifier().map(|b| b.to_string()),
    })
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

/// 指定 PID 应用的显示名（诊断/发送回执用）。
pub fn app_name_of(pid: i32) -> Option<String> {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .and_then(|a| a.localizedName().map(|n| n.to_string()))
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
    use objc2_foundation::NSString;

    let ns_bundle = NSString::from_str(bundle_id);
    let apps =
        NSRunningApplication::runningApplicationsWithBundleIdentifier(&ns_bundle);
    let app = apps.iter().next()?;
    let icon = app.icon()?;
    let tiff = icon.TIFFRepresentation()?;
    let rep = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)?;
    let props = objc2_foundation::NSDictionary::new();
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }?;
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
