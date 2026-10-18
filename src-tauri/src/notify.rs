//! 任务到期的 macOS 系统通知（UNUserNotificationCenter）。
//!
//! 只在打包后的 .app 里可用：未打包的 dev 二进制没有 bundle identifier，
//! 调 `currentNotificationCenter` 会直接抛 ObjC 异常，必须先判掉。
//! 首次投递时系统弹授权框；用户拒绝后投递静默失败，HUD 渠道不受影响。
//! 点击通知 = 点击到期气泡：打开面板并定位任务（identifier 里带任务 id）。

/// 单任务通知 identifier：`task:<任务 id>:<时间戳>`；多任务：`task-batch:<时间戳>`。
const TASK_PREFIX: &str = "task:";
const BATCH_PREFIX: &str = "task-batch:";

/// 通知 identifier → 打开面板的载荷（与 HUD 到期气泡同一事件）；不认识的返回 None。
pub fn open_payload_for(identifier: &str) -> Option<serde_json::Value> {
    if identifier.starts_with(BATCH_PREFIX) {
        return Some(serde_json::json!({ "page": "tasks", "taskId": null }));
    }
    let id = identifier.strip_prefix(TASK_PREFIX)?.split(':').next()?;
    (!id.is_empty()).then(|| serde_json::json!({ "page": "tasks", "taskId": id }))
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::{Once, OnceLock};

    use tauri::{AppHandle, Emitter};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    /// 点击回调里要发事件给主窗口；delegate 是 ObjC 对象拿不到 Rust 上下文，存全局。
    static APP: OnceLock<AppHandle> = OnceLock::new();

    define_class!(
        #[unsafe(super(NSObject))]
        #[ivars = ()]
        struct ForegroundPresenter;

        unsafe impl NSObjectProtocol for ForegroundPresenter {}

        unsafe impl UNUserNotificationCenterDelegate for ForegroundPresenter {
            // 面板打开时 Toskr 算前台应用：不实现这个回调，系统会吞掉通知
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                handler: &block2::DynBlock<dyn Fn()>,
            ) {
                // 只处理点击通知本体（默认动作）；划掉/关闭不打开面板
                let default_action = unsafe { UNNotificationDefaultActionIdentifier };
                if response.actionIdentifier().isEqualToString(default_action) {
                    let identifier = response.notification().request().identifier().to_string();
                    if let (Some(app), Some(payload)) =
                        (APP.get(), super::open_payload_for(&identifier))
                    {
                        let _ = app.emit_to("main", "toskr://hud-open-panel", payload);
                    }
                }
                handler.call(());
            }
        }
    );

    impl ForegroundPresenter {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    fn bundled() -> bool {
        NSBundle::mainBundle().bundleIdentifier().is_some()
    }

    static SETUP: Once = Once::new();

    pub fn post(app: &AppHandle, id: &str, title: &str, body: &str) -> Result<(), String> {
        if !bundled() {
            return Err("未打包的开发版不支持系统通知".into());
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        SETUP.call_once(|| {
            let _ = APP.set(app.clone());
            // delegate 是弱引用：常驻对象，进程内只设一次
            let presenter = ForegroundPresenter::new();
            center.setDelegate(Some(ProtocolObject::from_ref(&*presenter)));
            std::mem::forget(presenter);
            let done = RcBlock::new(|_granted: Bool, _err: *mut NSError| {});
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &done,
            );
        });
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(id),
            &content,
            None,
        );
        center.addNotificationRequest_withCompletionHandler(&request, None);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub use imp::post;

#[cfg(not(target_os = "macos"))]
pub fn post(_app: &tauri::AppHandle, _id: &str, _title: &str, _body: &str) -> Result<(), String> {
    Err("当前平台不支持系统通知".into())
}

#[cfg(test)]
mod tests {
    use super::open_payload_for;
    use serde_json::json;

    #[test]
    fn notification_identifier_maps_to_task_target() {
        assert_eq!(
            open_payload_for("task:abc-123:1790000000000"),
            Some(json!({ "page": "tasks", "taskId": "abc-123" }))
        );
        assert_eq!(
            open_payload_for("task-batch:1790000000000"),
            Some(json!({ "page": "tasks", "taskId": null }))
        );
        assert_eq!(open_payload_for("task::1"), None);
        assert_eq!(open_payload_for("bill:1"), None);
    }
}
