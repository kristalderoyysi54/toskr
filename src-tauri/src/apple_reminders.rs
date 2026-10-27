//! 任务 → 苹果「提醒事项」同步（EventKit）：Toskr 任务推到「Toskr」列表，
//! 在 iPhone / 提醒事项里勾完成后回传。
//!
//! 关联键是 reminder 的 URL `toskr://task/<任务 id>`：不另存映射表，任何时候都能
//! 从列表现状重建。字段单向（Toskr 覆盖）：优先级、完成、响铃；
//! 标题、备注、到期按「上次同步的值」三方比较：只有对端改了就回流，两边都改以 Toskr
//! 为准并报冲突（前端提示被覆盖的对端内容，可一键改用对端版本）。
//! 其余回传只有「对端勾了完成」与「在列表里新建（导入为任务）」。不推重复规则（苹果
//! 完成重复提醒会顺延而不是完成，回传会丢）；响铃（EKAlarm）由设置开关决定。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const URL_PREFIX: &str = "toskr://task/";
const LIST_TITLE: &str = "Toskr";

/// 本地日历时刻（前端按本机时区拆好，Rust 不碰时区）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DueParts {
    pub y: i64,
    pub m: i64,
    pub d: i64,
    pub h: i64,
    pub mi: i64,
}

/// 前端下发的一条待同步任务。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesiredTask {
    pub task_id: String,
    pub title: String,
    pub notes: Option<String>,
    pub due: Option<DueParts>,
    /// EKReminder 优先级：0 无 / 1 高 / 5 中 / 9 低。
    pub priority: u64,
    pub completed: bool,
    /// 曾成功同步过（远端缺失时据此判定「对端删除」而不是「还没建」）。
    pub synced: bool,
    /// 对端已是完成、Toskr 又改回未完成：推「未完成」而不是把对端完成回传。
    #[serde(default)]
    pub reopened: bool,
    /// 响铃：相对到期的秒数（负数 = 提前），升序；空 = 不响。
    #[serde(default)]
    pub alarms: Vec<i64>,
    /// 由对端导入、尚未补写 URL 的提醒 id：本轮按它认领并写上 URL。
    #[serde(default)]
    pub adopt_item_id: Option<String>,
    /// 上次同步成功时两边一致的标题（三方比较的基准）；None = 还没有基准，Toskr 为准。
    #[serde(default)]
    pub base_title: Option<String>,
    /// 上次同步成功时两边一致的备注（"" = 当时为空）；None = 还没有基准。
    #[serde(default)]
    pub base_notes: Option<String>,
    /// 上次同步成功时两边一致的到期（`due_key` 格式，"" = 无到期）；None = 还没有基准。
    #[serde(default)]
    pub base_due: Option<String>,
}

/// 到期的比较键：`y-m-d h:mi`（只有日期的提醒 h / mi 为 -1），无到期为 ""。
/// 前端 `dueKey` 必须与此逐字一致。
pub fn due_key(due: Option<DueParts>) -> String {
    due.map(|d| format!("{}-{}-{} {}:{}", d.y, d.m, d.d, d.h, d.mi))
        .unwrap_or_default()
}

/// 两边在同步间隙都改了同一字段：以 Toskr 为准，`theirs` 是被覆盖的对端内容。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub task_id: String,
    /// "title" | "notes" | "due"（due 的 theirs 是 `due_key`）
    pub field: &'static str,
    pub theirs: String,
}

/// 远端（「Toskr」列表里）的一条提醒。
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteItem {
    pub item_id: String,
    pub task_id: Option<String>,
    pub title: String,
    pub notes: Option<String>,
    pub due: Option<DueParts>,
    pub priority: u64,
    pub completed: bool,
    /// 相对到期的响铃秒数（升序）；绝对时刻的响铃记为 i64::MIN（与 Toskr 永不相等）。
    pub alarms: Vec<i64>,
}

/// 在「Toskr」列表里新建、没有 Toskr URL 的提醒：前端导入成任务。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedItem {
    pub item_id: String,
    pub title: String,
    pub notes: Option<String>,
    pub due: Option<DueParts>,
    pub priority: u64,
}

#[derive(Debug, Default, PartialEq)]
pub struct SyncPlan {
    pub create: Vec<String>,
    /// (远端 item id, 任务 id)
    pub update: Vec<(String, String)>,
    pub delete: Vec<String>,
    /// 对端勾了完成、Toskr 仍未完成：前端标完成。
    pub completed_remote: Vec<String>,
    /// 曾同步但对端已删：前端标记不再同步。
    pub missing: Vec<String>,
    /// 被删除的远端提醒对应的任务 id（前端记下：本会话撤销删除时重建而非判缺失）。
    pub deleted_tasks: Vec<String>,
    /// (远端 item id, 任务 id)：已导入的提醒补写 URL 并按任务内容覆盖。
    pub adopt: Vec<(String, String)>,
    pub import: Vec<ImportedItem>,
    /// (任务 id, 对端标题)：只有对端改了标题，回流到 Toskr。
    pub title_remote: Vec<(String, String)>,
    /// (任务 id, 对端备注，可为空)：只有对端改了备注，回流到 Toskr。
    pub notes_remote: Vec<(String, String)>,
    /// (任务 id, 对端到期)：只有对端改了到期，回流到 Toskr（None = 对端清掉了到期）。
    pub due_remote: Vec<(String, Option<DueParts>)>,
    pub conflicts: Vec<SyncConflict>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub list_id: String,
    pub created: Vec<String>,
    pub completed_remote: Vec<String>,
    pub missing: Vec<String>,
    pub deleted_tasks: Vec<String>,
    pub updated: usize,
    pub imported: Vec<ImportedItem>,
    /// 本轮认领成功的任务 id（前端清掉待认领标记）。
    pub adopted: Vec<String>,
    pub title_remote: Vec<(String, String)>,
    pub notes_remote: Vec<(String, String)>,
    pub due_remote: Vec<(String, Option<DueParts>)>,
    pub conflicts: Vec<SyncConflict>,
}

/// 本次启动以来的同步统计（诊断页显示）。只在内存里，重启清零。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStats {
    pub rounds: u64,
    pub created: u64,
    pub updated: u64,
    pub deleted: u64,
    pub imported: u64,
    pub completed_remote: u64,
    pub missing: u64,
    pub title_back: u64,
    pub notes_back: u64,
    pub due_back: u64,
    pub conflicts: u64,
    pub failures: u64,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_error_at: Option<i64>,
}

static STATS: Mutex<SyncStats> = Mutex::new(SyncStats {
    rounds: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    imported: 0,
    completed_remote: 0,
    missing: 0,
    title_back: 0,
    notes_back: 0,
    due_back: 0,
    conflicts: 0,
    failures: 0,
    last_sync_at: None,
    last_error: None,
    last_error_at: None,
});

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

pub fn stats() -> SyncStats {
    STATS.lock().map(|s| s.clone()).unwrap_or_default()
}

pub fn record_failure(error: &str) {
    if let Ok(mut s) = STATS.lock() {
        s.failures += 1;
        s.last_error = Some(error.to_string());
        s.last_error_at = Some(now_ms());
    }
}

/// 三方比较一个字段（均已规整）：只有对端改了 → Ok(Some(对端))；两边各改各的 →
/// Err(对端)（冲突，Toskr 为准）；其余 → Ok(None)。
fn merge3(base: &str, ours: &str, theirs: &str) -> Result<Option<String>, String> {
    if theirs == base || theirs == ours {
        Ok(None)
    } else if ours == base {
        Ok(Some(theirs.to_string()))
    } else {
        Err(theirs.to_string())
    }
}

/// 只有对端改了标题（Toskr 侧仍等于基准）时返回对端标题；空标题不回流。
fn remote_title(want: &DesiredTask, have: &RemoteItem) -> Option<String> {
    let base = want.base_title.as_deref()?;
    let theirs = have.title.trim();
    (want.title == base && theirs != base && !theirs.is_empty()).then(|| theirs.to_string())
}

pub fn task_id_from_url(url: &str) -> Option<String> {
    url.strip_prefix(URL_PREFIX)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn norm_notes(notes: &Option<String>) -> &str {
    notes.as_deref().map(str::trim).unwrap_or("")
}

fn differs(want: &DesiredTask, have: &RemoteItem) -> bool {
    want.title != have.title
        || norm_notes(&want.notes) != norm_notes(&have.notes)
        || want.due != have.due
        || want.priority != have.priority
        || want.completed != have.completed
        || want.alarms != have.alarms
}

/// 对账：带 Toskr URL 的按任务 id 对齐；没有 URL 的是用户在列表里新建的——
/// 已被导入（任务带 adopt_item_id）的认领，其余未完成的导入为任务。
pub fn plan(desired: &[DesiredTask], remote: &[RemoteItem]) -> SyncPlan {
    let mut out = SyncPlan::default();
    let mut by_task: HashMap<&str, &RemoteItem> = HashMap::new();
    let mut untagged: HashMap<&str, &RemoteItem> = HashMap::new();
    for item in remote {
        let Some(task_id) = item.task_id.as_deref() else {
            untagged.insert(item.item_id.as_str(), item);
            continue;
        };
        if by_task.contains_key(task_id) {
            // 同一任务多条（并发建重了）：保留第一条，其余删掉
            out.delete.push(item.item_id.clone());
        } else {
            by_task.insert(task_id, item);
        }
    }
    let wanted: HashSet<&str> = desired.iter().map(|d| d.task_id.as_str()).collect();
    for want in desired {
        let have = by_task.get(want.task_id.as_str());
        let renamed = have.and_then(|have| remote_title(want, have));
        if let Some(title) = &renamed {
            out.title_remote.push((want.task_id.clone(), title.clone()));
        }
        if let (Some(have), Some(base)) = (have, want.base_title.as_deref()) {
            let theirs = have.title.trim();
            if renamed.is_none() && !theirs.is_empty() {
                if let Err(theirs) = merge3(base, &want.title, theirs) {
                    out.conflicts.push(SyncConflict { task_id: want.task_id.clone(), field: "title", theirs });
                }
            }
        }
        let renoted = match (have, want.base_notes.as_deref()) {
            (Some(have), Some(base)) => {
                match merge3(base.trim(), norm_notes(&want.notes), norm_notes(&have.notes)) {
                    Ok(next) => next,
                    Err(theirs) => {
                        out.conflicts.push(SyncConflict { task_id: want.task_id.clone(), field: "notes", theirs });
                        None
                    }
                }
            }
            _ => None,
        };
        if let Some(notes) = &renoted {
            out.notes_remote.push((want.task_id.clone(), notes.clone()));
        }
        let redued = match (have, want.base_due.as_deref()) {
            (Some(have), Some(base)) => {
                match merge3(base, &due_key(want.due), &due_key(have.due)) {
                    Ok(Some(_)) => Some(have.due),
                    Ok(None) => None,
                    Err(theirs) => {
                        out.conflicts.push(SyncConflict { task_id: want.task_id.clone(), field: "due", theirs });
                        None
                    }
                }
            }
            _ => None,
        };
        if let Some(due) = redued {
            out.due_remote.push((want.task_id.clone(), due));
        }
        match have {
            Some(have) if have.completed && !want.completed && !want.reopened => {
                out.completed_remote.push(want.task_id.clone());
            }
            Some(have) => {
                // 回流的标题 / 备注 / 到期按对端算，不再拿 Toskr 旧值覆盖回去
                let effective;
                let want = if renamed.is_some() || renoted.is_some() || redued.is_some() {
                    effective = DesiredTask {
                        title: renamed.clone().unwrap_or_else(|| want.title.clone()),
                        notes: match &renoted {
                            Some(notes) => Some(notes.clone()).filter(|n| !n.is_empty()),
                            None => want.notes.clone(),
                        },
                        due: redued.unwrap_or(want.due),
                        ..want.clone()
                    };
                    &effective
                } else {
                    want
                };
                if differs(want, have) {
                    out.update.push((have.item_id.clone(), want.task_id.clone()));
                }
            }
            None if want
                .adopt_item_id
                .as_deref()
                .is_some_and(|id| untagged.remove(id).is_some()) =>
            {
                out.adopt.push((
                    want.adopt_item_id.clone().unwrap_or_default(),
                    want.task_id.clone(),
                ));
            }
            None if want.synced => out.missing.push(want.task_id.clone()),
            None if !want.completed => out.create.push(want.task_id.clone()),
            None => {}
        }
    }
    // 已完成的、空标题的手建提醒不导入（开启同步时不把旧的完成记录灌进 Toskr）
    let mut fresh: Vec<&RemoteItem> = untagged
        .into_values()
        .filter(|item| !item.completed && !item.title.trim().is_empty())
        .collect();
    fresh.sort_by(|a, b| a.item_id.cmp(&b.item_id));
    out.import = fresh
        .into_iter()
        .map(|item| ImportedItem {
            item_id: item.item_id.clone(),
            title: item.title.trim().to_string(),
            notes: item.notes.clone().filter(|n| !n.trim().is_empty()),
            due: item.due,
            priority: item.priority,
        })
        .collect();
    // 一条都没下发时不删：数据未就绪 / 读取失败时宁可留着孤儿，也不清空对端
    for (task_id, item) in &by_task {
        if !desired.is_empty() && !wanted.contains(task_id) {
            out.delete.push(item.item_id.clone());
            out.deleted_tasks.push((*task_id).to_string());
        }
    }
    out
}

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObjectProtocol};
    use objc2::sel;
    use objc2_event_kit::{EKAlarm, EKCalendar, EKEntityType, EKEventStore, EKReminder};
    use objc2_foundation::{NSArray, NSDateComponents, NSError, NSString, NSURL};
    use tauri::AppHandle;

    use super::{
        plan, task_id_from_url, DesiredTask, DueParts, RemoteItem, SyncResult, LIST_TITLE,
        URL_PREFIX,
    };
    use crate::apple_calendar::{on_main, status_name, store};

    pub fn status() -> String {
        let raw = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Reminder) };
        status_name(raw.0).into()
    }

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
            let full = store.respondsToSelector(sel!(requestFullAccessToRemindersWithCompletion:));
            unsafe {
                if full {
                    store.requestFullAccessToRemindersWithCompletion(RcBlock::as_ptr(&done));
                } else {
                    #[allow(deprecated)]
                    store.requestAccessToEntityType_completion(
                        EKEntityType::Reminder,
                        RcBlock::as_ptr(&done),
                    );
                }
            }
        })
        .await?;
        receive.await.map_err(|error| error.to_string())?;
        on_main(app, |app| unsafe { store(app).reset() }).await?;
        Ok(status())
    }

    /// 按 id 找「Toskr」列表，找不到按标题找，再没有就在默认提醒账户下新建。
    fn ensure_list(store: &EKEventStore, list_id: Option<&str>) -> Result<Retained<EKCalendar>, String> {
        unsafe {
            if let Some(id) = list_id {
                if let Some(calendar) = store.calendarWithIdentifier(&NSString::from_str(id)) {
                    if calendar.allowsContentModifications() {
                        return Ok(calendar);
                    }
                }
            }
            for calendar in store.calendarsForEntityType(EKEntityType::Reminder).iter() {
                if calendar.title().to_string() == LIST_TITLE && calendar.allowsContentModifications() {
                    return Ok(calendar);
                }
            }
            let source = store
                .defaultCalendarForNewReminders()
                .and_then(|calendar| calendar.source())
                .ok_or_else(|| crate::i18n::pick("找不到可写的提醒事项账户", "No writable Reminders account").to_string())?;
            let calendar = EKCalendar::calendarForEntityType_eventStore(EKEntityType::Reminder, store);
            calendar.setTitle(&NSString::from_str(LIST_TITLE));
            calendar.setSource(Some(&source));
            store
                .saveCalendar_commit_error(&calendar, true)
                .map_err(|error| error.localizedDescription().to_string())?;
            Ok(calendar)
        }
    }

    fn read_due(components: &NSDateComponents) -> Option<DueParts> {
        // NSDateComponentUndefined = NSIntegerMax；只有日期的提醒时分按 0 处理不了，视为不同
        let undefined = isize::MAX;
        let (y, m, d) = (components.year(), components.month(), components.day());
        if [y, m, d].contains(&undefined) {
            return None;
        }
        let h = components.hour();
        let mi = components.minute();
        Some(DueParts {
            y: y as i64,
            m: m as i64,
            d: d as i64,
            h: if h == undefined { -1 } else { h as i64 },
            mi: if mi == undefined { -1 } else { mi as i64 },
        })
    }

    fn read_alarms(reminder: &EKReminder) -> Vec<i64> {
        let mut out: Vec<i64> = unsafe { reminder.alarms() }
            .map(|alarms| {
                alarms
                    .iter()
                    .map(|alarm| unsafe {
                        if alarm.absoluteDate().is_some() {
                            i64::MIN
                        } else {
                            alarm.relativeOffset().round() as i64
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_unstable();
        out
    }

    fn read_item(reminder: &EKReminder) -> RemoteItem {
        unsafe {
            RemoteItem {
                item_id: reminder.calendarItemIdentifier().to_string(),
                task_id: reminder
                    .URL()
                    .and_then(|url| url.absoluteString())
                    .and_then(|url| task_id_from_url(&url.to_string())),
                title: reminder.title().to_string(),
                notes: reminder.notes().map(|n| n.to_string()),
                due: reminder.dueDateComponents().and_then(|c| read_due(&c)),
                priority: reminder.priority() as u64,
                completed: reminder.isCompleted(),
                alarms: read_alarms(reminder),
            }
        }
    }

    fn apply(reminder: &EKReminder, want: &DesiredTask) {
        unsafe {
            reminder.setTitle(Some(&NSString::from_str(&want.title)));
            let notes = want.notes.as_deref().map(str::trim).filter(|n| !n.is_empty());
            reminder.setNotes(notes.map(NSString::from_str).as_deref());
            match want.due {
                Some(due) => {
                    let components = NSDateComponents::new();
                    components.setYear(due.y as isize);
                    components.setMonth(due.m as isize);
                    components.setDay(due.d as isize);
                    components.setHour(due.h as isize);
                    components.setMinute(due.mi as isize);
                    reminder.setDueDateComponents(Some(&components));
                }
                None => reminder.setDueDateComponents(None),
            }
            reminder.setPriority(want.priority as usize);
            if want.alarms.is_empty() || want.due.is_none() {
                reminder.setAlarms(None);
            } else {
                let alarms: Vec<Retained<EKAlarm>> = want
                    .alarms
                    .iter()
                    .map(|&offset| EKAlarm::alarmWithRelativeOffset(offset as f64))
                    .collect();
                reminder.setAlarms(Some(&NSArray::from_retained_slice(&alarms)));
            }
            if reminder.isCompleted() != want.completed {
                reminder.setCompleted(want.completed);
            }
        }
    }

    pub async fn sync(
        app: &AppHandle,
        list_id: Option<String>,
        desired: Vec<DesiredTask>,
    ) -> Result<SyncResult, String> {
        if status() != "granted" {
            return Err(crate::i18n::pick("未获得提醒事项权限", "Reminders access not granted").into());
        }
        // 1. 主线程：确保列表存在，发起拉取（回调在后台线程，只在那里读成纯数据）
        let (send, receive) = tokio::sync::oneshot::channel::<Vec<RemoteItem>>();
        let list_id = on_main(app, move |app| -> Result<String, String> {
            let store = store(app);
            let list = ensure_list(&store, list_id.as_deref())?;
            let predicate = unsafe {
                store.predicateForRemindersInCalendars(Some(&NSArray::from_retained_slice(&[list.clone()])))
            };
            let send = Mutex::new(Some(send));
            let done = RcBlock::new(move |reminders: *mut NSArray<EKReminder>| {
                let items = unsafe { reminders.as_ref() }
                    .map(|list| list.iter().map(|r| read_item(&r)).collect())
                    .unwrap_or_default();
                if let Some(send) = send.lock().ok().and_then(|mut s| s.take()) {
                    let _ = send.send(items);
                }
            });
            let _ = unsafe { store.fetchRemindersMatchingPredicate_completion(&predicate, &done) };
            Ok(unsafe { list.calendarIdentifier() }.to_string())
        })
        .await??;
        let remote = receive.await.map_err(|error| error.to_string())?;
        let actions = plan(&desired, &remote);

        // 2. 主线程：批量写，最后一次 commit
        let mut by_task: HashMap<String, DesiredTask> =
            desired.into_iter().map(|d| (d.task_id.clone(), d)).collect();
        for (task_id, title) in &actions.title_remote {
            if let Some(want) = by_task.get_mut(task_id) {
                want.title = title.clone();
            }
        }
        for (task_id, notes) in &actions.notes_remote {
            if let Some(want) = by_task.get_mut(task_id) {
                want.notes = Some(notes.clone()).filter(|n| !n.is_empty());
            }
        }
        for (task_id, due) in &actions.due_remote {
            if let Some(want) = by_task.get_mut(task_id) {
                want.due = *due;
            }
        }
        let list_for_write = list_id.clone();
        let created = actions.create.clone();
        let adopted: Vec<String> = actions.adopt.iter().map(|(_, task)| task.clone()).collect();
        let imported = actions.import.clone();
        let updated = actions.update.len();
        let deleted = actions.delete.len();
        let write = on_main(app, move |app| -> Result<(), String> {
            let store = store(app);
            let list = unsafe { store.calendarWithIdentifier(&NSString::from_str(&list_for_write)) }
                .ok_or_else(|| crate::i18n::pick("「Toskr」提醒列表不见了", "The Toskr Reminders list is gone").to_string())?;
            let err = |error: Retained<NSError>| error.localizedDescription().to_string();
            unsafe {
                for task_id in &actions.create {
                    let Some(want) = by_task.get(task_id) else { continue };
                    let reminder = EKReminder::reminderWithEventStore(&store);
                    reminder.setCalendar(Some(&list));
                    let url = NSURL::URLWithString(&NSString::from_str(&format!("{URL_PREFIX}{task_id}")));
                    reminder.setURL(url.as_deref());
                    apply(&reminder, want);
                    store.saveReminder_commit_error(&reminder, false).map_err(err)?;
                }
                for (item_id, task_id) in &actions.update {
                    let Some(want) = by_task.get(task_id) else { continue };
                    let Some(item) = store.calendarItemWithIdentifier(&NSString::from_str(item_id)) else { continue };
                    let Ok(reminder) = item.downcast::<EKReminder>() else { continue };
                    apply(&reminder, want);
                    store.saveReminder_commit_error(&reminder, false).map_err(err)?;
                }
                for (item_id, task_id) in &actions.adopt {
                    let Some(want) = by_task.get(task_id) else { continue };
                    let Some(item) = store.calendarItemWithIdentifier(&NSString::from_str(item_id)) else { continue };
                    let Ok(reminder) = item.downcast::<EKReminder>() else { continue };
                    let url = NSURL::URLWithString(&NSString::from_str(&format!("{URL_PREFIX}{task_id}")));
                    reminder.setURL(url.as_deref());
                    apply(&reminder, want);
                    store.saveReminder_commit_error(&reminder, false).map_err(err)?;
                }
                for item_id in &actions.delete {
                    let Some(item) = store.calendarItemWithIdentifier(&NSString::from_str(item_id)) else { continue };
                    let Ok(reminder) = item.downcast::<EKReminder>() else { continue };
                    store.removeReminder_commit_error(&reminder, false).map_err(err)?;
                }
                store.commit().map_err(err)?;
            }
            Ok(())
        });
        write.await??;

        // 有实际动作才记诊断日志（稳态每轮都是零，记了只是噪音）
        let counts = [
            ("新建", created.len()),
            ("更新", updated),
            ("删除", deleted),
            ("导入", imported.len()),
            ("认领", adopted.len()),
            ("对端完成", actions.completed_remote.len()),
            ("对端删除", actions.missing.len()),
            ("标题回流", actions.title_remote.len()),
            ("备注回流", actions.notes_remote.len()),
            ("到期回流", actions.due_remote.len()),
            ("冲突", actions.conflicts.len()),
        ];
        let summary: Vec<String> = counts
            .iter()
            .filter(|(_, n)| *n > 0)
            .map(|(label, n)| format!("{label} {n}"))
            .collect();
        if !summary.is_empty() {
            crate::diag::push(app, format!("提醒事项同步: {}", summary.join(" / ")));
        }
        if let Ok(mut s) = super::STATS.lock() {
            let n = |v: usize| v as u64;
            s.rounds += 1;
            s.created += n(created.len());
            s.updated += n(updated);
            s.deleted += n(deleted);
            s.imported += n(imported.len());
            s.completed_remote += n(actions.completed_remote.len());
            s.missing += n(actions.missing.len());
            s.title_back += n(actions.title_remote.len());
            s.notes_back += n(actions.notes_remote.len());
            s.due_back += n(actions.due_remote.len());
            s.conflicts += n(actions.conflicts.len());
            s.last_sync_at = Some(super::now_ms());
        }

        Ok(SyncResult {
            list_id,
            created,
            completed_remote: actions.completed_remote,
            missing: actions.missing,
            deleted_tasks: actions.deleted_tasks,
            updated,
            imported,
            adopted,
            title_remote: actions.title_remote,
            notes_remote: actions.notes_remote,
            due_remote: actions.due_remote,
            conflicts: actions.conflicts,
        })
    }
}

#[cfg(target_os = "macos")]
pub use imp::{request_access, status, sync};

#[cfg(not(target_os = "macos"))]
pub fn status() -> String {
    "restricted".into()
}

#[cfg(not(target_os = "macos"))]
pub async fn request_access(_app: &tauri::AppHandle) -> Result<String, String> {
    Ok(status())
}

#[cfg(not(target_os = "macos"))]
pub async fn sync(
    _app: &tauri::AppHandle,
    _list_id: Option<String>,
    _desired: Vec<DesiredTask>,
) -> Result<SyncResult, String> {
    Err("unsupported".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn want(id: &str) -> DesiredTask {
        DesiredTask {
            task_id: id.into(),
            title: "写周报".into(),
            notes: None,
            due: Some(DueParts { y: 2026, m: 10, d: 26, h: 18, mi: 0 }),
            priority: 0,
            completed: false,
            synced: false,
            reopened: false,
            alarms: Vec::new(),
            adopt_item_id: None,
            base_title: None,
            base_notes: None,
            base_due: None,
        }
    }

    fn remote(item: &str, task: &str, w: &DesiredTask) -> RemoteItem {
        RemoteItem {
            item_id: item.into(),
            task_id: Some(task.into()),
            title: w.title.clone(),
            notes: w.notes.clone(),
            due: w.due,
            priority: w.priority,
            completed: w.completed,
            alarms: w.alarms.clone(),
        }
    }

    #[test]
    fn parses_task_url() {
        assert_eq!(task_id_from_url("toskr://task/abc"), Some("abc".into()));
        assert_eq!(task_id_from_url("toskr://task/"), None);
        assert_eq!(task_id_from_url("https://x.com"), None);
    }

    #[test]
    fn creates_new_and_skips_identical() {
        let a = want("a");
        let b = want("b");
        let p = plan(&[a.clone(), b], &[remote("r1", "a", &a)]);
        assert_eq!(p.create, vec!["b".to_string()]);
        assert!(p.update.is_empty() && p.delete.is_empty());
    }

    #[test]
    fn updates_when_fields_differ_and_treats_empty_notes_equal() {
        let mut a = want("a");
        let mut r = remote("r1", "a", &a);
        r.notes = Some("  ".into());
        assert!(plan(&[a.clone()], &[r.clone()]).update.is_empty());
        a.title = "改了".into();
        assert_eq!(plan(&[a], &[r]).update, vec![("r1".into(), "a".into())]);
    }

    #[test]
    fn remote_completion_flows_back_without_overwrite() {
        let a = want("a");
        let mut r = remote("r1", "a", &a);
        r.completed = true;
        let p = plan(&[a], &[r]);
        assert_eq!(p.completed_remote, vec!["a".to_string()]);
        assert!(p.update.is_empty());
    }

    #[test]
    fn reopened_in_toskr_pushes_open_instead_of_closing_again() {
        let mut a = want("a");
        let mut r = remote("r1", "a", &a);
        r.completed = true;
        a.reopened = true;
        let p = plan(&[a], &[r]);
        assert!(p.completed_remote.is_empty());
        assert_eq!(p.update, vec![("r1".into(), "a".into())]);
    }

    #[test]
    fn toskr_done_overrides_remote_open() {
        let mut a = want("a");
        let r = remote("r1", "a", &a);
        a.completed = true;
        a.synced = true;
        assert_eq!(plan(&[a], &[r]).update.len(), 1);
    }

    #[test]
    fn synced_but_missing_is_remote_delete_not_recreate() {
        let mut a = want("a");
        a.synced = true;
        let p = plan(&[a], &[]);
        assert_eq!(p.missing, vec!["a".to_string()]);
        assert!(p.create.is_empty());
    }

    #[test]
    fn deletes_orphans_and_duplicates_but_leaves_user_items() {
        let a = want("a");
        let mut user = remote("u", "x", &a);
        user.task_id = None;
        let p = plan(
            &[a.clone()],
            &[remote("r1", "a", &a), remote("r2", "a", &a), remote("r3", "gone", &a), user],
        );
        let mut deleted = p.delete.clone();
        deleted.sort();
        assert_eq!(deleted, vec!["r2".to_string(), "r3".to_string()]);
        assert_eq!(p.deleted_tasks, vec!["gone".to_string()]);
        assert_eq!(p.import.iter().map(|i| i.item_id.as_str()).collect::<Vec<_>>(), vec!["u"]);
    }

    #[test]
    fn empty_desired_never_deletes() {
        let a = want("a");
        assert_eq!(plan(&[], &[remote("r1", "a", &a)]), SyncPlan::default());
    }

    #[test]
    fn done_task_never_synced_is_not_created() {
        let mut a = want("a");
        a.completed = true;
        assert_eq!(plan(&[a], &[]), SyncPlan::default());
    }

    fn untagged(item: &str, title: &str) -> RemoteItem {
        RemoteItem {
            item_id: item.into(),
            task_id: None,
            title: title.into(),
            notes: None,
            due: None,
            priority: 0,
            completed: false,
            alarms: Vec::new(),
        }
    }

    #[test]
    fn imports_open_untagged_and_skips_done_or_blank() {
        let mut done = untagged("d", "旧的");
        done.completed = true;
        let p = plan(&[], &[untagged("n", " 买牛奶 "), done, untagged("b", "  ")]);
        assert_eq!(p.import.len(), 1);
        assert_eq!(p.import[0].title, "买牛奶");
    }

    #[test]
    fn adopts_imported_item_instead_of_importing_again() {
        let mut a = want("t");
        a.synced = true;
        a.adopt_item_id = Some("n".into());
        let p = plan(&[a], &[untagged("n", "买牛奶")]);
        assert_eq!(p.adopt, vec![("n".into(), "t".into())]);
        assert!(p.import.is_empty() && p.missing.is_empty());
    }

    #[test]
    fn imported_then_deleted_remotely_is_missing() {
        let mut a = want("t");
        a.synced = true;
        a.adopt_item_id = Some("n".into());
        assert_eq!(plan(&[a], &[]).missing, vec!["t".to_string()]);
    }

    #[test]
    fn alarm_change_triggers_update() {
        let mut a = want("a");
        let r = remote("r1", "a", &a);
        a.alarms = vec![-600, 0];
        assert_eq!(plan(&[a.clone()], &[r]).update.len(), 1);
        let same = remote("r1", "a", &a);
        assert!(plan(&[a], &[same]).update.is_empty());
    }

    #[test]
    fn remote_rename_flows_back_when_toskr_unchanged() {
        let mut a = want("a");
        a.base_title = Some(a.title.clone());
        let mut r = remote("r1", "a", &a);
        r.title = " 写月报 ".into();
        let p = plan(&[a], &[r]);
        assert_eq!(p.title_remote, vec![("a".into(), "写月报".into())]);
        // 只差首尾空格：仍要更新一次把对端规整成同一标题
        assert_eq!(p.update.len(), 1);
    }

    #[test]
    fn both_renamed_keeps_toskr_title() {
        let mut a = want("a");
        a.base_title = Some("旧标题".into());
        let mut r = remote("r1", "a", &a);
        r.title = "对端新标题".into();
        let p = plan(&[a], &[r]);
        assert!(p.title_remote.is_empty());
        assert_eq!(p.update.len(), 1);
    }

    #[test]
    fn no_base_title_means_toskr_wins() {
        let a = want("a");
        let mut r = remote("r1", "a", &a);
        r.title = "对端".into();
        let p = plan(&[a], &[r]);
        assert!(p.title_remote.is_empty());
        assert_eq!(p.update.len(), 1);
    }

    #[test]
    fn remote_rename_without_other_changes_needs_no_write() {
        let mut a = want("a");
        a.base_title = Some(a.title.clone());
        let mut r = remote("r1", "a", &a);
        r.title = "写月报".into();
        let p = plan(&[a], &[r]);
        assert_eq!(p.title_remote.len(), 1);
        assert!(p.update.is_empty());
    }

    #[test]
    fn merges_three_ways() {
        assert_eq!(merge3("a", "a", "b"), Ok(Some("b".into())));
        assert_eq!(merge3("a", "c", "a"), Ok(None));
        assert_eq!(merge3("a", "c", "c"), Ok(None));
        assert_eq!(merge3("a", "c", "b"), Err("b".into()));
    }

    #[test]
    fn remote_notes_flow_back_including_clearing() {
        let mut a = want("a");
        a.notes = Some("带上数据".into());
        a.base_notes = Some("带上数据".into());
        let mut r = remote("r1", "a", &a);
        r.notes = None;
        let p = plan(&[a], &[r]);
        assert_eq!(p.notes_remote, vec![("a".into(), String::new())]);
        assert!(p.update.is_empty() && p.conflicts.is_empty());
    }

    #[test]
    fn both_sides_changed_reports_conflicts_and_keeps_toskr() {
        let mut a = want("a");
        a.base_title = Some("旧标题".into());
        a.notes = Some("我的备注".into());
        a.base_notes = Some("旧备注".into());
        let mut r = remote("r1", "a", &a);
        r.title = "对端标题".into();
        r.notes = Some("对端备注".into());
        let p = plan(&[a], &[r]);
        assert!(p.title_remote.is_empty() && p.notes_remote.is_empty());
        let fields: Vec<_> = p.conflicts.iter().map(|c| (c.field, c.theirs.as_str())).collect();
        assert_eq!(fields, vec![("title", "对端标题"), ("notes", "对端备注")]);
        assert_eq!(p.update.len(), 1);
    }

    #[test]
    fn no_conflict_without_base() {
        let a = want("a");
        let mut r = remote("r1", "a", &a);
        r.title = "对端".into();
        r.notes = Some("x".into());
        assert!(plan(&[a], &[r]).conflicts.is_empty());
    }

    #[test]
    fn due_key_matches_frontend_format() {
        assert_eq!(due_key(None), "");
        assert_eq!(due_key(Some(DueParts { y: 2026, m: 10, d: 26, h: 18, mi: 0 })), "2026-10-26 18:0");
        assert_eq!(due_key(Some(DueParts { y: 2026, m: 1, d: 2, h: -1, mi: -1 })), "2026-1-2 -1:-1");
    }

    #[test]
    fn remote_due_flows_back_including_clearing() {
        let mut a = want("a");
        a.base_due = Some(due_key(a.due));
        let mut moved = remote("r1", "a", &a);
        moved.due = Some(DueParts { y: 2026, m: 10, d: 28, h: 9, mi: 30 });
        let p = plan(&[a.clone()], &[moved.clone()]);
        assert_eq!(p.due_remote, vec![("a".into(), moved.due)]);
        assert!(p.update.is_empty());
        let mut cleared = remote("r1", "a", &a);
        cleared.due = None;
        assert_eq!(plan(&[a], &[cleared]).due_remote, vec![("a".into(), None)]);
    }

    #[test]
    fn both_sides_changed_due_is_conflict() {
        let mut a = want("a");
        a.base_due = Some("2026-10-1 9:0".into());
        let mut r = remote("r1", "a", &a);
        r.due = Some(DueParts { y: 2026, m: 10, d: 30, h: 8, mi: 0 });
        let p = plan(&[a], &[r]);
        assert!(p.due_remote.is_empty());
        assert_eq!(p.conflicts[0].field, "due");
        assert_eq!(p.conflicts[0].theirs, "2026-10-30 8:0");
        assert_eq!(p.update.len(), 1);
    }
}
