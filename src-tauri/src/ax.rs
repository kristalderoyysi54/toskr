//! macOS 辅助功能（Accessibility）FFI：
//! - 进程信任检查 / 弹出授权提示
//! - 经 AX API 读取前台焦点元素的选中文本（无副作用，优先于剪贴板技法）

#![cfg(target_os = "macos")]

use core_foundation::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation::base::{CFGetTypeID, CFRelease, CFRetain, CFTypeRef, TCFType};
use core_foundation::boolean::{CFBoolean, CFBooleanRef};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::{CFString, CFStringGetTypeID, CFStringRef};

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
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
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

/// 读取单个 AX 窗口元素的全局 frame（不接管元素所有权，调用方负责释放）。
unsafe fn window_element_frame(window: AXUIElementRef) -> Option<AxWindowFrame> {
    let mut point = core_graphics::geometry::CGPoint::new(0.0, 0.0);
    let mut size = core_graphics::geometry::CGSize::new(0.0, 0.0);

    let pos_attr = CFString::from_static_string("AXPosition");
    let mut pos_val: CFTypeRef = std::ptr::null();
    let pos_err =
        AXUIElementCopyAttributeValue(window, pos_attr.as_concrete_TypeRef(), &mut pos_val);
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
    let size_err =
        AXUIElementCopyAttributeValue(window, size_attr.as_concrete_TypeRef(), &mut size_val);
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
        let frame = window_element_frame(window as AXUIElementRef);
        CFRelease(window);
        frame
    }
}

/// 单个 AX 元素的字符串属性（AXTitle/AXValue/AXDescription 等）。
/// AXValue 可能是非字符串类型（滑杆数值等），必须先验 TypeID 再包装。
unsafe fn element_string_attr(element: AXUIElementRef, attr: &'static str) -> Option<String> {
    let cf_attr = CFString::from_static_string(attr);
    let mut value: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(element, cf_attr.as_concrete_TypeRef(), &mut value);
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return None;
    }
    if CFGetTypeID(value) != CFStringGetTypeID() {
        CFRelease(value);
        return None;
    }
    Some(CFString::wrap_under_create_rule(value as CFStringRef).to_string())
}

/// 标题/文本与会话名的匹配：包含即中；标题被截断时去尾部省略号、
/// 主干 ≥ 6 字符才反向匹配，避免超短文本吃掉一切。
fn title_matches(title: &str, needle: &str) -> bool {
    let title = title.trim();
    if title.is_empty() {
        return false;
    }
    let core = title.trim_end_matches('…').trim();
    title.contains(needle) || (core.chars().count() >= 6 && needle.contains(core))
}

/// 窗口是否已最小化（读取失败按未最小化处理）。
unsafe fn window_minimized(window: AXUIElementRef) -> bool {
    let cf_attr = CFString::from_static_string("AXMinimized");
    let mut value: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(window, cf_attr.as_concrete_TypeRef(), &mut value);
    if err != K_AX_ERROR_SUCCESS || value.is_null() {
        return false;
    }
    bool::from(CFBoolean::wrap_under_create_rule(value as CFBooleanRef))
}

/// 会话定位结果。
#[derive(Clone, Copy, Debug)]
pub enum LocateOutcome {
    /// 会话行已在列表可视区（可能刚经 AXScrollToVisible 滚入）。
    Row {
        row: AxWindowFrame,
        window: AxWindowFrame,
    },
    /// 找到了会话列表，但里面没有匹配该会话名的行（或滚动后仍不可视）。
    NotInList,
    /// 没有识别出会话列表。
    NoList,
}

/// 在目标进程里定位会话列表中该会话的行：找到离屏行时执行
/// AXScrollToVisible 把它滚进可视区（只滚动，绝不 AXPress/选中——
/// 不打开会话、不改已读），并轮询等待滚动落定。
/// 阻塞最长约 1.5s，必须在非主线程调用。
pub fn locate_conversation(pid: i32, needle: &str) -> LocateOutcome {
    let needle = needle.trim();
    if needle.is_empty() {
        return LocateOutcome::NotInList;
    }
    unsafe {
        let app_el = AXUIElementCreateApplication(pid);
        if app_el.is_null() {
            return LocateOutcome::NoList;
        }
        // Electron/Chromium 网页树未展开时手动展开（推推实测常开；属性不支持时忽略）
        for attr in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
            let cf_attr = CFString::from_static_string(attr);
            let _ = AXUIElementSetAttributeValue(
                app_el,
                cf_attr.as_concrete_TypeRef(),
                CFBoolean::true_value().as_CFTypeRef(),
            );
        }
        let win_attr = CFString::from_static_string("AXWindows");
        let mut windows: CFTypeRef = std::ptr::null();
        let err =
            AXUIElementCopyAttributeValue(app_el, win_attr.as_concrete_TypeRef(), &mut windows);
        CFRelease(app_el as CFTypeRef);
        if err != K_AX_ERROR_SUCCESS || windows.is_null() {
            return LocateOutcome::NoList;
        }

        let mut outcome = LocateOutcome::NoList;
        let count = CFArrayGetCount(windows as CFArrayRef);
        for index in 0..count {
            let window = CFArrayGetValueAtIndex(windows as CFArrayRef, index) as AXUIElementRef;
            if window.is_null() || window_minimized(window) {
                continue;
            }
            let Some(window_frame) = window_element_frame(window) else {
                continue;
            };
            let Some((list_el, list_frame)) = find_conversation_list(window, &window_frame)
            else {
                continue;
            };
            let row = find_row_in_list(list_el, needle);
            CFRelease(list_el as CFTypeRef);
            let Some(row_el) = row else {
                // 这个窗口的列表里没有该会话；继续看其他窗口，但至少已见到列表
                outcome = LocateOutcome::NotInList;
                continue;
            };

            let mut placed = window_element_frame(row_el)
                .filter(|frame| row_in_list_view(frame, &list_frame));
            if placed.is_none() {
                // 离屏（虚拟化行 h≈0 或滚出视口）：让 Chromium 自己滚过去
                let action = CFString::from_static_string("AXScrollToVisible");
                let _ = AXUIElementPerformAction(row_el, action.as_concrete_TypeRef());
                for _ in 0..6 {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    placed = window_element_frame(row_el)
                        .filter(|frame| row_in_list_view(frame, &list_frame));
                    if placed.is_some() {
                        break;
                    }
                }
            }
            CFRelease(row_el as CFTypeRef);
            outcome = match placed {
                Some(row) => LocateOutcome::Row {
                    row,
                    window: window_frame,
                },
                None => LocateOutcome::NotInList,
            };
            break;
        }
        CFRelease(windows);
        outcome
    }
}

/// 行是否落在列表可视范围内（离屏虚拟行高≈0 或 y 在列表区间外）。
fn row_in_list_view(row: &AxWindowFrame, list: &AxWindowFrame) -> bool {
    row.h >= 8.0 && row.y >= list.y - 4.0 && row.y + row.h <= list.y + list.h + 8.0
}

/// 按结构特征找会话列表容器（推推实测：窗口左侧、宽 ≥120、高 ≥ 窗口 35%、
/// 子项多——借此排除同为 AXList 的窄图标侧栏与横向页签条）。
/// 命中的元素已 CFRetain，调用方负责释放。
unsafe fn find_conversation_list(
    window: AXUIElementRef,
    window_frame: &AxWindowFrame,
) -> Option<(AXUIElementRef, AxWindowFrame)> {
    const MAX_NODES: usize = 3500;
    const MAX_DEPTH: usize = 30;
    let mut stack: Vec<(AXUIElementRef, usize, bool)> = vec![(window, 0, false)];
    let mut visited = 0usize;
    let mut result = None;

    while let Some((element, depth, owned)) = stack.pop() {
        visited += 1;
        if element_string_attr(element, "AXRole").as_deref() == Some("AXList") {
            if let Some(frame) = window_element_frame(element) {
                let on_left = frame.x < window_frame.x + window_frame.w * 0.5;
                let tall = frame.h >= window_frame.h * 0.35;
                let wide_enough = frame.w >= 120.0;
                if on_left && tall && wide_enough && element_children_count(element) >= 5 {
                    CFRetain(element as CFTypeRef);
                    result = Some((element, frame));
                }
            }
        }
        if result.is_none() && visited < MAX_NODES && depth < MAX_DEPTH {
            push_children(element, depth, &mut stack);
        }
        if owned {
            CFRelease(element as CFTypeRef);
        }
        if result.is_some() {
            break;
        }
    }
    for (element, _, owned) in stack {
        if owned {
            CFRelease(element as CFTypeRef);
        }
    }
    result
}

/// 在会话列表的**全部**子行（含虚拟化离屏行——它们的文本在树里是完整的）
/// 里找文本匹配的行。命中的行元素已 CFRetain，调用方负责释放。
unsafe fn find_row_in_list(list: AXUIElementRef, needle: &str) -> Option<AXUIElementRef> {
    let children_attr = CFString::from_static_string("AXChildren");
    let mut children: CFTypeRef = std::ptr::null();
    let err =
        AXUIElementCopyAttributeValue(list, children_attr.as_concrete_TypeRef(), &mut children);
    if err != K_AX_ERROR_SUCCESS || children.is_null() {
        return None;
    }
    let mut found = None;
    let count = CFArrayGetCount(children as CFArrayRef);
    for index in 0..count {
        let row = CFArrayGetValueAtIndex(children as CFArrayRef, index) as AXUIElementRef;
        if row.is_null() {
            continue;
        }
        // 每行小预算浅扫（群名在行子树头部；实测 985 行找中位行 <100ms）
        if subtree_text_matches(row, needle, 40) {
            CFRetain(row as CFTypeRef);
            found = Some(row);
            break;
        }
    }
    CFRelease(children);
    found
}

/// 小预算子树文本匹配（单个列表行内：群名/摘要/时间共十几个节点）。
unsafe fn subtree_text_matches(root: AXUIElementRef, needle: &str, budget: usize) -> bool {
    let mut stack: Vec<(AXUIElementRef, usize, bool)> = vec![(root, 0, false)];
    let mut visited = 0usize;
    let mut matched = false;

    while let Some((element, depth, owned)) = stack.pop() {
        visited += 1;
        matched = ["AXTitle", "AXValue", "AXDescription"].iter().any(|attr| {
            element_string_attr(element, attr)
                .map(|text| title_matches(&text, needle))
                .unwrap_or(false)
        });
        if !matched && visited < budget && depth < 10 {
            push_children(element, depth, &mut stack);
        }
        if owned {
            CFRelease(element as CFTypeRef);
        }
        if matched {
            break;
        }
    }
    for (element, _, owned) in stack {
        if owned {
            CFRelease(element as CFTypeRef);
        }
    }
    matched
}

/// 子元素逆序入栈（保持先序遍历）；来自 AXChildren 数组的元素是借用，
/// 入栈前 CFRetain 使其在数组释放后仍有效，出栈方负责释放。
unsafe fn push_children(
    element: AXUIElementRef,
    depth: usize,
    stack: &mut Vec<(AXUIElementRef, usize, bool)>,
) {
    let children_attr = CFString::from_static_string("AXChildren");
    let mut children: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(
        element,
        children_attr.as_concrete_TypeRef(),
        &mut children,
    );
    if err != K_AX_ERROR_SUCCESS || children.is_null() {
        return;
    }
    let count = CFArrayGetCount(children as CFArrayRef);
    for index in (0..count).rev() {
        let child = CFArrayGetValueAtIndex(children as CFArrayRef, index) as AXUIElementRef;
        if !child.is_null() {
            CFRetain(child as CFTypeRef);
            stack.push((child, depth + 1, true));
        }
    }
    CFRelease(children);
}

/// 直接子元素数量（不 retain 元素本身）。
unsafe fn element_children_count(element: AXUIElementRef) -> isize {
    let children_attr = CFString::from_static_string("AXChildren");
    let mut children: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(
        element,
        children_attr.as_concrete_TypeRef(),
        &mut children,
    );
    if err != K_AX_ERROR_SUCCESS || children.is_null() {
        return 0;
    }
    let count = CFArrayGetCount(children as CFArrayRef);
    CFRelease(children);
    count
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
