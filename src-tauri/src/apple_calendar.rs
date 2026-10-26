//! 苹果日历只读叠加（EventKit）：读取系统日历里的日程，供「提醒 → 今天」与月历
//! 显示为灰色时间块。只读不写，不碰提醒事项。
//!
//! EKEventStore 及其取回的对象非线程安全：进程内只建一个 store，常驻主线程，
//! 命令经 run_on_main_thread 进出。系统日历库变化（本机编辑或 iCloud 同步）时
//! EventKit 发 EKEventStoreChangedNotification，转发给前端重新拉取。

use serde::Serialize;

/// 日历库变化事件（前端收到后重新拉取当前区间）。
pub const CHANGED_EVENT: &str = "toskr://apple-calendar-changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub id: String,
    pub title: String,
    /// 账户名（iCloud / 本地 / Google…），同名日历靠它区分。
    pub source: String,
    /// 日历在系统里的颜色（sRGB `#rrggbb`）；取不到为 None。
    pub color: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    /// 重复日程的各期共享 eventIdentifier，拼上开始时刻保证每期唯一。
    pub id: String,
    pub title: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub all_day: bool,
    pub calendar_id: String,
    pub calendar_title: String,
    pub calendar_color: Option<String>,
    pub location: Option<String>,
    /// calendarItemIdentifier：在「日历」App 里定位这条日程用。
    pub item_id: String,
    pub recurring: bool,
}

/// 「日历」App 定位日程的 URL。重复日程要带上这一期的开始时刻（UTC），否则只能打开首期。
/// 标识符只放行常见字符，异常时退化为直接打开「日历」App。
pub fn event_url(item_id: &str, start_ms: i64, recurring: bool) -> String {
    let safe = !item_id.is_empty()
        && item_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.' | '@'));
    if !safe {
        return "ical://".into();
    }
    if recurring {
        let stamp = chrono_utc_stamp(start_ms);
        format!("ical://ekevent/{stamp}/{item_id}?method=show&options=more")
    } else {
        format!("ical://ekevent/{item_id}?method=show&options=more")
    }
}

/// epoch ms → `yyyyMMddTHHmmssZ`（不引入日期库，按 civil-from-days 换算）。
fn chrono_utc_stamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// EKAuthorizationStatus → 前端状态名。13 的 Authorized 与 14 的 FullAccess 同值。
fn status_name(raw: isize) -> &'static str {
    match raw {
        0 => "notDetermined",
        1 => "restricted",
        2 => "denied",
        3 => "granted",
        4 => "writeOnly",
        _ => "denied",
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::OnceCell;
    use std::ptr::NonNull;
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObjectProtocol};
    use objc2::sel;
    use objc2_app_kit::{NSColor, NSColorSpace};
    use objc2_event_kit::{EKCalendar, EKEntityType, EKEventStore, EKEventStoreChangedNotification};
    use objc2_foundation::{NSDate, NSError, NSNotification, NSNotificationCenter};
    use tauri::{AppHandle, Emitter};

    use super::{status_name, CalendarEvent, CalendarInfo, CHANGED_EVENT};

    thread_local! {
        static STORE: OnceCell<Retained<EKEventStore>> = const { OnceCell::new() };
    }

    /// 主线程上的唯一 store；首次创建时挂上变化通知。
    fn store(app: &AppHandle) -> Retained<EKEventStore> {
        STORE.with(|cell| {
            cell.get_or_init(|| {
                let store = unsafe { EKEventStore::new() };
                let app = app.clone();
                let block = RcBlock::new(move |_: NonNull<NSNotification>| {
                    let _ = app.emit(CHANGED_EVENT, ());
                });
                let observer = unsafe {
                    NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                        Some(EKEventStoreChangedNotification),
                        Some(&store),
                        None,
                        &block,
                    )
                };
                // store 常驻进程，观察者随之常驻
                std::mem::forget(observer);
                store
            })
            .clone()
        })
    }

    async fn on_main<T: Send + 'static>(
        app: &AppHandle,
        job: impl FnOnce(&AppHandle) -> T + Send + 'static,
    ) -> Result<T, String> {
        let (send, receive) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = send.send(job(&handle));
        })
        .map_err(|error| error.to_string())?;
        receive.await.map_err(|error| error.to_string())
    }

    fn hex_color(calendar: &EKCalendar) -> Option<String> {
        let color: Retained<NSColor> = unsafe { calendar.color() };
        let rgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
        let byte = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        Some(format!(
            "#{:02x}{:02x}{:02x}",
            byte(rgb.redComponent()),
            byte(rgb.greenComponent()),
            byte(rgb.blueComponent())
        ))
    }

    pub fn status() -> String {
        let raw = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) };
        status_name(raw.0).into()
    }

    /// 弹系统授权框（已决定过则直接回调），返回授权后的状态。
    pub async fn request_access(app: &AppHandle) -> Result<String, String> {
        let (send, receive) = tokio::sync::oneshot::channel::<()>();
        on_main(app, move |app| {
            let store = store(app);
            let send = Mutex::new(Some(send));
            let done = RcBlock::new(move |_granted: Bool, _error: *mut NSError| {
                if let Some(send) = send.lock().ok().and_then(|mut s| s.take()) {
                    let _ = send.send(());
                }
            });
            // 14 起必须走 FullAccess 接口（旧接口在 14 上只给只写权限）；13 无此方法
            let full = store.respondsToSelector(sel!(requestFullAccessToEventsWithCompletion:));
            unsafe {
                if full {
                    store.requestFullAccessToEventsWithCompletion(RcBlock::as_ptr(&done));
                } else {
                    #[allow(deprecated)]
                    store.requestAccessToEntityType_completion(
                        EKEntityType::Event,
                        RcBlock::as_ptr(&done),
                    );
                }
            }
        })
        .await?;
        receive.await.map_err(|error| error.to_string())?;
        // 授权前建的 store 看不到日历，重置后才读得到
        on_main(app, |app| unsafe { store(app).reset() }).await?;
        Ok(status())
    }

    fn granted() -> bool {
        status() == "granted"
    }

    pub async fn calendars(app: &AppHandle) -> Result<Vec<CalendarInfo>, String> {
        if !granted() {
            return Ok(Vec::new());
        }
        on_main(app, |app| {
            let store = store(app);
            unsafe { store.calendarsForEntityType(EKEntityType::Event) }
                .iter()
                .map(|calendar| unsafe {
                    CalendarInfo {
                        id: calendar.calendarIdentifier().to_string(),
                        title: calendar.title().to_string(),
                        source: calendar
                            .source()
                            .map(|source| source.title().to_string())
                            .unwrap_or_default(),
                        color: hex_color(&calendar),
                    }
                })
                .collect()
        })
        .await
    }

    /// [start_ms, end_ms) 区间内与之相交的全部日程（含跨区间的长日程）。
    pub async fn events(
        app: &AppHandle,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<Vec<CalendarEvent>, String> {
        if !granted() || end_ms <= start_ms {
            return Ok(Vec::new());
        }
        on_main(app, move |app| {
            let store = store(app);
            let start = NSDate::dateWithTimeIntervalSince1970(start_ms as f64 / 1000.0);
            let end = NSDate::dateWithTimeIntervalSince1970(end_ms as f64 / 1000.0);
            let predicate =
                unsafe { store.predicateForEventsWithStartDate_endDate_calendars(&start, &end, None) };
            let ms = |date: &NSDate| (date.timeIntervalSince1970() * 1000.0).round() as i64;
            unsafe { store.eventsMatchingPredicate(&predicate) }
                .iter()
                .map(|event| unsafe {
                    let start_ms = ms(&event.startDate());
                    let calendar = event.calendar();
                    CalendarEvent {
                        id: format!(
                            "{}@{start_ms}",
                            event.eventIdentifier().map(|id| id.to_string()).unwrap_or_default()
                        ),
                        title: event.title().to_string(),
                        start_ms,
                        end_ms: ms(&event.endDate()),
                        all_day: event.isAllDay(),
                        calendar_id: calendar
                            .as_ref()
                            .map(|c| c.calendarIdentifier().to_string())
                            .unwrap_or_default(),
                        calendar_title: calendar
                            .as_ref()
                            .map(|c| c.title().to_string())
                            .unwrap_or_default(),
                        calendar_color: calendar.as_deref().and_then(hex_color),
                        location: event
                            .location()
                            .map(|l| l.to_string())
                            .filter(|l| !l.trim().is_empty()),
                        item_id: event.calendarItemIdentifier().to_string(),
                        recurring: event.hasRecurrenceRules(),
                    }
                })
                .collect()
        })
        .await
    }
}

#[cfg(target_os = "macos")]
pub use imp::{calendars, events, request_access, status};

#[cfg(not(target_os = "macos"))]
pub fn status() -> String {
    "restricted".into()
}

#[cfg(not(target_os = "macos"))]
pub async fn request_access(_app: &tauri::AppHandle) -> Result<String, String> {
    Ok(status())
}

#[cfg(not(target_os = "macos"))]
pub async fn calendars(_app: &tauri::AppHandle) -> Result<Vec<CalendarInfo>, String> {
    Ok(Vec::new())
}

#[cfg(not(target_os = "macos"))]
pub async fn events(
    _app: &tauri::AppHandle,
    _start_ms: i64,
    _end_ms: i64,
) -> Result<Vec<CalendarEvent>, String> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::{chrono_utc_stamp, event_url, status_name};

    #[test]
    fn formats_utc_stamp() {
        assert_eq!(chrono_utc_stamp(0), "19700101T000000Z");
        // 2026-10-26 13:05:09 UTC
        assert_eq!(chrono_utc_stamp(1_793_019_909_000), "20261026T130509Z");
        assert_eq!(chrono_utc_stamp(951_782_400_000), "20000229T000000Z");
    }

    #[test]
    fn builds_event_url() {
        assert_eq!(
            event_url("ABC-123", 0, false),
            "ical://ekevent/ABC-123?method=show&options=more"
        );
        assert_eq!(
            event_url("ABC-123", 0, true),
            "ical://ekevent/19700101T000000Z/ABC-123?method=show&options=more"
        );
        assert_eq!(event_url("a b/../x", 0, false), "ical://");
        assert_eq!(event_url("", 0, false), "ical://");
    }

    #[test]
    fn maps_authorization_status() {
        assert_eq!(status_name(0), "notDetermined");
        assert_eq!(status_name(2), "denied");
        assert_eq!(status_name(3), "granted");
        assert_eq!(status_name(4), "writeOnly");
        assert_eq!(status_name(99), "denied");
    }
}
