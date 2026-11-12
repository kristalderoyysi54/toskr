//! IM 定位高亮框：原生 NSPanel + CALayer（2026-11-05 替代 locatehl WebView 窗）。
//!
//! 省一个常驻 WebContent 进程（实测 ≈19MB），也不再受隐藏期 WebView 挂起影响——
//! 层动画由 Core Animation 在合成器里跑，窗口可见即有高亮。外观沿用旧 CSS：
//! 圆角 10、2pt 描边、16% 底色、1.1s 透明度呼吸；系统「减少动态效果」时常亮。
//! 取色只区分系统深浅色（Rust 侧不知道前端配色方案）：浅 amber-600、深 amber-400。
//! 所有函数仅限主线程（MainThreadMarker 守卫）。

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSBackingStoreType, NSColor, NSFloatingWindowLevel, NSPanel, NSScreen,
    NSWindowCollectionBehavior, NSWindowStyleMask, NSWorkspace,
};
use objc2_foundation::{NSNumber, NSPoint, NSRect, NSSize, NSString};
use objc2_quartz_core::{
    kCAMediaTimingFunctionEaseInEaseOut, CABasicAnimation, CAMediaTiming, CAMediaTimingFunction,
};

/// 高亮框比目标行四周各外扩的 pt（与旧 WebView 窗一致）。
pub const PAD: f64 = 3.0;
const BREATHE_KEY: &str = "toskr-breathe";

thread_local! {
    static PANEL: RefCell<Option<Retained<NSPanel>>> = const { RefCell::new(None) };
}

/// AX 全局坐标（主屏左上原点、y 向下）的目标行 → Cocoa 窗口 frame（主屏左下原点）。
pub fn cocoa_frame(x: f64, y: f64, w: f64, h: f64, primary_height: f64) -> (f64, f64, f64, f64) {
    let (fw, fh) = (w + PAD * 2.0, h + PAD * 2.0);
    (x - PAD, primary_height - (y - PAD) - fh, fw, fh)
}

fn create(mtm: MainThreadMarker) -> Retained<NSPanel> {
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(10.0, 10.0));
    let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
        NSPanel::alloc(mtm),
        rect,
        NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
        NSBackingStoreType::Buffered,
        false,
    );
    unsafe { panel.setReleasedWhenClosed(false) };
    panel.setOpaque(false);
    panel.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.setHasShadow(false);
    panel.setIgnoresMouseEvents(true);
    // 本应用是 Accessory，几乎从不处于激活态：NSPanel 默认失活即隐藏，必须关掉
    panel.setHidesOnDeactivate(false);
    panel.setLevel(NSFloatingWindowLevel);
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    if let Some(view) = panel.contentView() {
        view.setWantsLayer(true);
    }
    panel
}

fn is_dark(mtm: MainThreadMarker) -> bool {
    NSApplication::sharedApplication(mtm)
        .effectiveAppearance()
        .name()
        .to_string()
        .contains("Dark")
}

fn style(panel: &NSPanel, mtm: MainThreadMarker) {
    let Some(layer) = panel.contentView().and_then(|view| view.layer()) else {
        return;
    };
    // = 旧 CSS 的 --warning：浅色 amber-600 #e17100，深色 amber-400 #ffb900
    let (r, g, b) = if is_dark(mtm) { (1.0, 0.725, 0.0) } else { (0.882, 0.443, 0.0) };
    let stroke = NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, 1.0);
    let fill = NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, 0.16);
    layer.setCornerRadius(10.0);
    layer.setBorderWidth(2.0);
    layer.setBorderColor(Some(&stroke.CGColor()));
    layer.setBackgroundColor(Some(&fill.CGColor()));
    layer.removeAllAnimations();
    if NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion() {
        layer.setOpacity(1.0);
        return;
    }
    let animation = CABasicAnimation::new();
    animation.setKeyPath(Some(&NSString::from_str("opacity")));
    unsafe {
        animation.setFromValue(Some(&NSNumber::new_f64(0.55)));
        animation.setToValue(Some(&NSNumber::new_f64(1.0)));
        animation.setTimingFunction(Some(&CAMediaTimingFunction::functionWithName(
            kCAMediaTimingFunctionEaseInEaseOut,
        )));
    }
    animation.setDuration(0.55);
    animation.setAutoreverses(true);
    animation.setRepeatCount(f32::INFINITY);
    layer.addAnimation_forKey(&animation, Some(&NSString::from_str(BREATHE_KEY)));
}

/// 把高亮框盖到目标行（AX 全局 pt）上并从头播呼吸动画；不抢焦点。
pub fn show(x: f64, y: f64, w: f64, h: f64) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(primary) = NSScreen::screens(mtm).firstObject() else {
        return;
    };
    let (fx, fy, fw, fh) = cocoa_frame(x, y, w, h, primary.frame().size.height);
    PANEL.with(|cell| {
        let mut slot = cell.borrow_mut();
        let panel = slot.get_or_insert_with(|| create(mtm));
        panel.setFrame_display(NSRect::new(NSPoint::new(fx, fy), NSSize::new(fw, fh)), true);
        style(panel, mtm);
        panel.orderFrontRegardless();
    });
}

pub fn hide() {
    if MainThreadMarker::new().is_none() {
        return;
    }
    PANEL.with(|cell| {
        if let Some(panel) = cell.borrow().as_ref() {
            panel.orderOut(None);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flips_ax_top_left_rect_into_cocoa_bottom_left_frame() {
        // 主屏高 1117：AX 行 (100, 200, 300×40) → 外扩 3pt 后翻转 y
        let (x, y, w, h) = cocoa_frame(100.0, 200.0, 300.0, 40.0, 1117.0);
        assert_eq!((x, w, h), (97.0, 306.0, 46.0));
        assert_eq!(y, 1117.0 - 197.0 - 46.0);
    }

    #[test]
    fn rows_on_screens_above_primary_get_frames_above_primary() {
        // 副屏在主屏上方：AX y 为负，Cocoa y 应大于主屏高
        let (_, y, _, h) = cocoa_frame(0.0, -500.0, 200.0, 30.0, 1117.0);
        assert!(y > 1117.0 && y + h > 1117.0);
    }
}
