//! macOS 辅助功能（Accessibility）FFI：
//! - 进程信任检查 / 弹出授权提示
//! - 经 AX API 读取前台焦点元素的选中文本（无副作用，优先于剪贴板技法）

#![cfg(target_os = "macos")]

use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::{CFString, CFStringRef};

type AXUIElementRef = *const std::ffi::c_void;
type AXError = i32;

const K_AX_ERROR_SUCCESS: AXError = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut std::ffi::c_void)
        -> bool;
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

const K_AX_VALUE_CGPOINT: u32 = 1;
const K_AX_VALUE_CGSIZE: u32 = 2;

/// 当前进程是否已获辅助功能授权。
pub fn is_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// 检查授权，未授权时弹出系统提示对话框。
pub fn request_trust_with_prompt() -> bool {
    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let dict = CFDictionary::from_CFType_pairs(&[(
            key.as_CFType(),
            CFBoolean::true_value().as_CFType(),
        )]);
        AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as CFDictionaryRef)
    }
}

/// AX 读取选中文本的结果。
pub enum AxSelection {
    /// 焦点元素明确报告了非空选中文本。
    Text(String),
    /// 焦点元素支持该属性且明确为空 —— 确定当前无选区。
    Empty,
    /// 焦点元素不支持 AX 选中文本（如部分 Chrome/Electron），需剪贴板兜底。
    Unsupported,
}

/// 目标应用焦点窗口的全局 frame（顶左原点、逻辑 pt）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AxWindowFrame {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 读取指定进程焦点窗口的 frame（伴随停靠用；任意线程可调）。
/// 应用不支持 AX 或无焦点窗口时返回 None。
pub fn focused_window_frame(pid: i32) -> Option<AxWindowFrame> {
    unsafe {
        let app_el = AXUIElementCreateApplication(pid);
        if app_el.is_null() {
            return None;
        }
        let win_attr = CFString::from_static_string("AXFocusedWindow");
        let mut window: CFTypeRef = std::ptr::null();
        let err =
            AXUIElementCopyAttributeValue(app_el, win_attr.as_concrete_TypeRef(), &mut window);
        CFRelease(app_el as CFTypeRef);
        if err != K_AX_ERROR_SUCCESS || window.is_null() {
            return None;
        }

        let mut point = core_graphics::geometry::CGPoint::new(0.0, 0.0);
        let mut size = core_graphics::geometry::CGSize::new(0.0, 0.0);

        let pos_attr = CFString::from_static_string("AXPosition");
        let mut pos_val: CFTypeRef = std::ptr::null();
        let pos_err = AXUIElementCopyAttributeValue(
            window as AXUIElementRef,
            pos_attr.as_concrete_TypeRef(),
            &mut pos_val,
        );
        let pos_ok = pos_err == K_AX_ERROR_SUCCESS
            && !pos_val.is_null()
            && AXValueGetValue(
                pos_val,
                K_AX_VALUE_CGPOINT,
                &mut point as *mut _ as *mut std::ffi::c_void,
            );
        if !pos_val.is_null() {
            CFRelease(pos_val);
        }

        let size_attr = CFString::from_static_string("AXSize");
        let mut size_val: CFTypeRef = std::ptr::null();
        let size_err = AXUIElementCopyAttributeValue(
            window as AXUIElementRef,
            size_attr.as_concrete_TypeRef(),
            &mut size_val,
        );
        let size_ok = size_err == K_AX_ERROR_SUCCESS
            && !size_val.is_null()
            && AXValueGetValue(
                size_val,
                K_AX_VALUE_CGSIZE,
                &mut size as *mut _ as *mut std::ffi::c_void,
            );
        if !size_val.is_null() {
            CFRelease(size_val);
        }
        CFRelease(window);

        if pos_ok && size_ok && size.width > 1.0 && size.height > 1.0 {
            Some(AxWindowFrame {
                x: point.x,
                y: point.y,
                w: size.width,
                h: size.height,
            })
        } else {
            None
        }
    }
}

/// 通过 AX API 读取系统焦点元素的选中文本（可在任意线程调用）。
pub fn selected_text() -> AxSelection {
    unsafe {
        let system_wide = AXUIElementCreateSystemWide();
        if system_wide.is_null() {
            return AxSelection::Unsupported;
        }

        let focused_attr = CFString::from_static_string("AXFocusedUIElement");
        let mut focused: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(
            system_wide,
            focused_attr.as_concrete_TypeRef(),
            &mut focused,
        );
        CFRelease(system_wide as CFTypeRef);
        if err != K_AX_ERROR_SUCCESS || focused.is_null() {
            return AxSelection::Unsupported;
        }

        let selected_attr = CFString::from_static_string("AXSelectedText");
        let mut selected: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(
            focused as AXUIElementRef,
            selected_attr.as_concrete_TypeRef(),
            &mut selected,
        );
        CFRelease(focused);
        if err != K_AX_ERROR_SUCCESS || selected.is_null() {
            return AxSelection::Unsupported;
        }

        let text = CFString::wrap_under_create_rule(selected as CFStringRef).to_string();
        if text.is_empty() {
            AxSelection::Empty
        } else {
            AxSelection::Text(text)
        }
    }
}
