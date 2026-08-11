//! 当前数据目录内的投递活动账本。
//! 只接受固定元数据结构；正文、Prompt、目标 token 和脱敏映射没有字段可写。

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::data_integrity::{self, DataOperationFailureCode};
use crate::pasteboard::ClipboardOutcome;

pub const ACTIVITY_FILE: &str = "toskr-delivery-activity.jsonl";
pub const ACTIVITY_ARCHIVE_FILE: &str = "toskr-delivery-activity.1.jsonl";
pub const MAX_EVENTS: usize = 500;
#[cfg(test)]
const DEFAULT_RETENTION_DAYS: u16 = 30;
pub const MAIN_FILE_BYTES: u64 = 64 * 1024;
pub const ARCHIVE_FILE_BYTES: u64 = 1024 * 1024;
const MAX_READ_FILE_BYTES: u64 = ARCHIVE_FILE_BYTES + 64 * 1024;
const MAX_EVENT_BYTES: usize = 32 * 1024;
const MAX_SOURCE_IDS: usize = 64;
const FUTURE_TOLERANCE_MS: u64 = 24 * 60 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryEventType {
    DraftCreated,
    PreflightOpened,
    FirewallBlocked,
    SendStarted,
    SendSent,
    SendBlocked,
    SendFailed,
    ClipboardRestored,
    ClipboardSkipped,
    ResultCaptured,
    ResultVerified,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryActivityStatus {
    Prepared,
    Opened,
    Started,
    Sent,
    Blocked,
    Failed,
    Restored,
    Skipped,
    Captured,
    Verified,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationStatus {
    Pass,
    NeedsReview,
    Blocked,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeliverySourceKind {
    Note,
    NoteBatch,
    Task,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransformRecipeId {
    Summarize,
    ExtractActions,
    ImprovePrompt,
    StructureRequirements,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FirewallCounts {
    pub private_key: u64,
    pub authorization: u64,
    pub api_key: u64,
    pub database_url: u64,
    pub email: u64,
    pub phone: u64,
    pub national_id: u64,
    pub bank_card: u64,
    pub ip_address: u64,
    pub cookie: u64,
    pub session: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryEvent {
    pub event_id: String,
    pub delivery_id: String,
    pub event_type: DeliveryEventType,
    pub timestamp_ms: u64,
    pub source_kind: DeliverySourceKind,
    pub source_item_ids: Vec<String>,
    pub target_bundle_id: Option<String>,
    pub target_app_name: Option<String>,
    pub profile_id: String,
    pub status: DeliveryActivityStatus,
    pub reason_code: Option<String>,
    pub duration_ms: Option<u64>,
    pub text_char_count: u64,
    pub image_count: u64,
    pub firewall_counts: FirewallCounts,
    pub redaction_count: u64,
    pub clipboard_outcome: Option<ClipboardOutcome>,
    pub result_note_id: Option<String>,
    #[serde(default = "default_true")]
    pub metrics_eligible: bool,
    #[serde(default)]
    pub metrics_epoch: u64,
    #[serde(default)]
    pub transform_recipe_id: Option<TransformRecipeId>,
    #[serde(default)]
    pub verification_status: Option<VerificationStatus>,
    #[serde(default)]
    pub verification_check_count: Option<u64>,
    #[serde(default)]
    pub verification_issue_count: Option<u64>,
}

fn default_true() -> bool {
    true
}

fn retention_ms(retention_days: u16) -> Result<u64, String> {
    if !matches!(retention_days, 7 | 30 | 90) {
        return Err("投递活动保留期无效".into());
    }
    Ok(u64::from(retention_days) * 24 * 60 * 60 * 1_000)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn validate_text(value: &str, label: &str, max: usize, allow_empty: bool) -> Result<(), String> {
    if (!allow_empty && value.is_empty())
        || value.len() > max
        || value.chars().any(char::is_control)
    {
        return Err(format!("{label} 不符合投递活动元数据约束"));
    }
    Ok(())
}

fn validate_event(event: &DeliveryEvent) -> Result<(), String> {
    validate_text(&event.event_id, "eventId", 160, false)?;
    validate_text(&event.delivery_id, "deliveryId", 160, false)?;
    validate_text(&event.profile_id, "profileId", 160, false)?;
    if event.timestamp_ms == 0 || event.source_item_ids.is_empty() {
        return Err("投递活动缺少时间或来源".into());
    }
    if event.source_item_ids.len() > MAX_SOURCE_IDS {
        return Err("投递活动来源数量超限".into());
    }
    for id in &event.source_item_ids {
        validate_text(id, "sourceItemId", 160, false)?;
    }
    if let Some(value) = &event.target_bundle_id {
        validate_text(value, "targetBundleId", 255, true)?;
    }
    if let Some(value) = &event.target_app_name {
        validate_text(value, "targetAppName", 160, true)?;
    }
    if let Some(value) = &event.reason_code {
        validate_text(value, "reasonCode", 80, false)?;
        if !value.chars().all(|ch| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '-' | ':')
        }) {
            return Err("reasonCode 不是稳定代码".into());
        }
    }
    if let Some(value) = &event.result_note_id {
        validate_text(value, "resultNoteId", 160, false)?;
    }
    let verification_fields = event.verification_status.is_some()
        || event.verification_check_count.is_some()
        || event.verification_issue_count.is_some();
    match event.event_type {
        DeliveryEventType::ResultCaptured
            if event.result_note_id.is_none() || verification_fields =>
        {
            return Err("结果回收活动字段不完整".into());
        }
        DeliveryEventType::ResultVerified
            if event.result_note_id.is_none()
                || event.verification_status.is_none()
                || event.verification_check_count.is_none()
                || event.verification_issue_count.is_none() =>
        {
            return Err("结果核验活动字段不完整".into());
        }
        DeliveryEventType::ResultCaptured | DeliveryEventType::ResultVerified => {}
        _ if event.result_note_id.is_some() || verification_fields => {
            return Err("非结果活动不能携带结果字段".into());
        }
        _ => {}
    }
    let expected_status = match event.event_type {
        DeliveryEventType::DraftCreated => DeliveryActivityStatus::Prepared,
        DeliveryEventType::PreflightOpened => DeliveryActivityStatus::Opened,
        DeliveryEventType::FirewallBlocked | DeliveryEventType::SendBlocked => {
            DeliveryActivityStatus::Blocked
        }
        DeliveryEventType::SendStarted => DeliveryActivityStatus::Started,
        DeliveryEventType::SendSent => DeliveryActivityStatus::Sent,
        DeliveryEventType::SendFailed => DeliveryActivityStatus::Failed,
        DeliveryEventType::ClipboardRestored => DeliveryActivityStatus::Restored,
        DeliveryEventType::ClipboardSkipped => DeliveryActivityStatus::Skipped,
        DeliveryEventType::ResultCaptured => DeliveryActivityStatus::Captured,
        DeliveryEventType::ResultVerified => DeliveryActivityStatus::Verified,
    };
    if event.status != expected_status {
        return Err("投递活动类型与状态不匹配".into());
    }
    if event.duration_ms.unwrap_or(0) > 7 * 24 * 60 * 60 * 1_000
        || event.text_char_count > 100_000_000
        || event.image_count > 10_000
        || event.redaction_count > 1_000_000
        || event.verification_check_count.unwrap_or(0) > 10_000
        || event.verification_issue_count.unwrap_or(0) > 100_000
        || event.metrics_epoch > 9_007_199_254_740_991
    {
        return Err("投递活动计数超限".into());
    }
    let counts = &event.firewall_counts;
    if [
        counts.private_key,
        counts.authorization,
        counts.api_key,
        counts.database_url,
        counts.email,
        counts.phone,
        counts.national_id,
        counts.bank_card,
        counts.ip_address,
        counts.cookie,
        counts.session,
    ]
    .into_iter()
    .any(|count| count > 1_000_000)
    {
        return Err("Firewall 计数超限".into());
    }
    if serde_json::to_vec(event)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_EVENT_BYTES
    {
        return Err("单条投递活动过大".into());
    }
    Ok(())
}

fn read_events_file(path: &Path) -> Result<Vec<DeliveryEvent>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取投递活动文件失败：{error}")),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_READ_FILE_BYTES
    {
        return Err("投递活动文件不是大小合规的普通文件".into());
    }
    let bytes = data_integrity::read_regular_file(path, MAX_READ_FILE_BYTES)
        .map_err(|error| error.message)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str::<DeliveryEvent>(line).ok())
        .filter(|event| validate_event(event).is_ok())
        .collect())
}

fn retained_events(
    root: &Path,
    now: u64,
    retention_days: u16,
) -> Result<Vec<DeliveryEvent>, String> {
    let mut by_id = BTreeMap::new();
    for name in [ACTIVITY_ARCHIVE_FILE, ACTIVITY_FILE] {
        for event in read_events_file(&root.join(name))? {
            by_id.insert(event.event_id.clone(), event);
        }
    }
    let cutoff = now.saturating_sub(retention_ms(retention_days)?);
    let future = now.saturating_add(FUTURE_TOLERANCE_MS);
    let mut events = by_id
        .into_values()
        .filter(|event| event.timestamp_ms >= cutoff && event.timestamp_ms <= future)
        .collect::<Vec<_>>();
    events.sort_by(|left, right| {
        left.timestamp_ms
            .cmp(&right.timestamp_ms)
            .then_with(|| left.event_id.cmp(&right.event_id))
    });
    if events.len() > MAX_EVENTS {
        events.drain(..events.len() - MAX_EVENTS);
    }
    Ok(events)
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清除投递活动文件失败：{error}")),
    }
}

fn sync_root(root: &Path) -> Result<(), String> {
    fs::File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("同步投递活动目录失败：{error}"))
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    data_integrity::atomic_write_file(path, bytes, DataOperationFailureCode::WriteFailed)
        .map_err(|error| error.message)
}

fn joined_lines(lines: &[Vec<u8>]) -> Vec<u8> {
    let size = lines.iter().map(|line| line.len() + 1).sum();
    let mut output = Vec::with_capacity(size);
    for line in lines {
        output.extend_from_slice(line);
        output.push(b'\n');
    }
    output
}

fn persist_events(
    root: &Path,
    events: Vec<DeliveryEvent>,
    now: u64,
    retention_days: u16,
) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("创建投递活动目录失败：{error}"))?;
    let cutoff = now.saturating_sub(retention_ms(retention_days)?);
    let future = now.saturating_add(FUTURE_TOLERANCE_MS);
    let mut by_id = BTreeMap::new();
    for event in events {
        validate_event(&event)?;
        if event.timestamp_ms >= cutoff && event.timestamp_ms <= future {
            by_id.insert(event.event_id.clone(), event);
        }
    }
    let mut events = by_id.into_values().collect::<Vec<_>>();
    events.sort_by(|left, right| {
        left.timestamp_ms
            .cmp(&right.timestamp_ms)
            .then_with(|| left.event_id.cmp(&right.event_id))
    });
    if events.len() > MAX_EVENTS {
        events.drain(..events.len() - MAX_EVENTS);
    }
    let lines = events
        .iter()
        .map(|event| serde_json::to_vec(event).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut split = lines.len();
    let mut main_bytes = 0usize;
    while split > 0 {
        let next = lines[split - 1].len() + 1;
        if main_bytes > 0 && main_bytes + next > MAIN_FILE_BYTES as usize {
            break;
        }
        main_bytes += next;
        split -= 1;
    }
    let mut archive_start = 0usize;
    let mut archive_bytes = lines[..split]
        .iter()
        .map(|line| line.len() + 1)
        .sum::<usize>();
    while archive_start < split && archive_bytes > ARCHIVE_FILE_BYTES as usize {
        archive_bytes -= lines[archive_start].len() + 1;
        archive_start += 1;
    }
    let archive = joined_lines(&lines[archive_start..split]);
    let main = joined_lines(&lines[split..]);
    let archive_path = root.join(ACTIVITY_ARCHIVE_FILE);
    if archive.is_empty() {
        remove_file_if_present(&archive_path)?;
    } else {
        write_file(&archive_path, &archive)?;
    }
    let main_path = root.join(ACTIVITY_FILE);
    if main.is_empty() {
        remove_file_if_present(&main_path)?;
    } else {
        write_file(&main_path, &main)?;
    }
    sync_root(root)
}

fn append_to_dir(
    root: &Path,
    event: DeliveryEvent,
    now: u64,
    retention_days: u16,
) -> Result<(), String> {
    validate_event(&event)?;
    let mut events = retained_events(root, now, retention_days)?;
    if matches!(
        event.event_type,
        DeliveryEventType::ResultCaptured | DeliveryEventType::ResultVerified
    ) && !events.iter().any(|stored| {
        stored.delivery_id == event.delivery_id
            && stored.event_type == DeliveryEventType::SendSent
            && stored.status == DeliveryActivityStatus::Sent
    }) {
        return Err("结果活动缺少当前账本中的成功投递".into());
    }
    if events
        .iter()
        .any(|stored| stored.event_id == event.event_id)
    {
        return Ok(());
    }
    events.push(event);
    persist_events(root, events, now, retention_days)
}

fn read_recent_from_dir(
    root: &Path,
    now: u64,
    limit: usize,
    retention_days: u16,
) -> Result<Vec<DeliveryEvent>, String> {
    let events = retained_events(root, now, retention_days)?;
    persist_events(root, events.clone(), now, retention_days)?;
    Ok(events
        .into_iter()
        .rev()
        .take(limit.min(MAX_EVENTS))
        .collect())
}

fn clear_from_dir(root: &Path) -> Result<(), String> {
    remove_file_if_present(&root.join(ACTIVITY_FILE))?;
    remove_file_if_present(&root.join(ACTIVITY_ARCHIVE_FILE))?;
    sync_root(root)
}

pub fn append(app: &AppHandle, event: DeliveryEvent, retention_days: u16) -> Result<(), String> {
    retention_ms(retention_days)?;
    crate::storage::with_active_data_dir(app, |root| {
        append_to_dir(root, event, now_ms(), retention_days)
    })
}

pub fn recent(
    app: &AppHandle,
    limit: usize,
    retention_days: u16,
) -> Result<Vec<DeliveryEvent>, String> {
    retention_ms(retention_days)?;
    crate::storage::with_active_data_dir(app, |root| {
        read_recent_from_dir(root, now_ms(), limit, retention_days)
    })
}

pub fn clear(app: &AppHandle) -> Result<(), String> {
    crate::storage::with_active_data_dir(app, clear_from_dir)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    fn event(id: usize, timestamp_ms: u64) -> DeliveryEvent {
        DeliveryEvent {
            event_id: format!("event-{id}"),
            delivery_id: format!("delivery-{id}"),
            event_type: DeliveryEventType::SendFailed,
            timestamp_ms,
            source_kind: DeliverySourceKind::Note,
            source_item_ids: vec![format!("note-{id}")],
            target_bundle_id: Some("com.openai.codex".into()),
            target_app_name: Some("Codex".into()),
            profile_id: "safe".into(),
            status: DeliveryActivityStatus::Failed,
            reason_code: Some("paste_failed".into()),
            duration_ms: Some(20),
            text_char_count: 42,
            image_count: 0,
            firewall_counts: FirewallCounts::default(),
            redaction_count: 0,
            clipboard_outcome: Some(ClipboardOutcome::NotOwned),
            result_note_id: None,
            metrics_eligible: true,
            metrics_epoch: 0,
            transform_recipe_id: None,
            verification_status: None,
            verification_check_count: None,
            verification_issue_count: None,
        }
    }

    #[test]
    fn serialized_event_is_metadata_whitelist_only() {
        let mut captured = event(1, 100);
        captured.event_type = DeliveryEventType::ResultCaptured;
        captured.status = DeliveryActivityStatus::Captured;
        captured.result_note_id = Some("result-note-1".into());
        let raw = serde_json::to_string(&captured).unwrap();
        for forbidden in [
            "rawText",
            "finalText",
            "promptTemplate",
            "redactionMap",
            "targetToken",
            "apiKeyValue",
            "secret value",
        ] {
            assert!(
                !raw.contains(forbidden),
                "leaked forbidden field {forbidden}"
            );
        }
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 24);
        assert_eq!(value["resultNoteId"], "result-note-1");

        let mut forbidden = value;
        forbidden["resultBody"] = serde_json::json!("secret result");
        assert!(serde_json::from_value::<DeliveryEvent>(forbidden).is_err());
    }

    #[test]
    fn legacy_event_defaults_to_metric_eligible_without_recipe() {
        let mut value = serde_json::to_value(event(7, 100)).unwrap();
        value.as_object_mut().unwrap().remove("metricsEligible");
        value.as_object_mut().unwrap().remove("metricsEpoch");
        value.as_object_mut().unwrap().remove("transformRecipeId");

        let decoded: DeliveryEvent = serde_json::from_value(value).unwrap();

        assert!(decoded.metrics_eligible);
        assert_eq!(decoded.metrics_epoch, 0);
        assert_eq!(decoded.transform_recipe_id, None);
    }

    #[test]
    fn result_verification_requires_only_status_and_bounded_counts() {
        let mut verified = event(2, 101);
        verified.event_type = DeliveryEventType::ResultVerified;
        verified.status = DeliveryActivityStatus::Verified;
        verified.result_note_id = Some("result-note-2".into());
        verified.verification_status = Some(VerificationStatus::NeedsReview);
        verified.verification_check_count = Some(8);
        verified.verification_issue_count = Some(3);
        validate_event(&verified).unwrap();

        let raw = serde_json::to_string(&verified).unwrap();
        assert!(raw.contains("\"verificationStatus\":\"needsReview\""));
        assert!(!raw.contains("reportBody"));

        verified.verification_status = None;
        assert!(validate_event(&verified).is_err());
    }

    #[test]
    fn result_events_cannot_resurrect_a_cleared_delivery() {
        let root = tempdir().unwrap();
        let mut sent = event(3, 100);
        sent.event_type = DeliveryEventType::SendSent;
        sent.status = DeliveryActivityStatus::Sent;
        sent.reason_code = None;
        append_to_dir(root.path(), sent.clone(), 120, DEFAULT_RETENTION_DAYS).unwrap();

        let mut verified = event(4, 130);
        verified.delivery_id = sent.delivery_id.clone();
        verified.event_type = DeliveryEventType::ResultVerified;
        verified.status = DeliveryActivityStatus::Verified;
        verified.reason_code = None;
        verified.result_note_id = Some("result-note-4".into());
        verified.verification_status = Some(VerificationStatus::Pass);
        verified.verification_check_count = Some(9);
        verified.verification_issue_count = Some(0);
        append_to_dir(root.path(), verified.clone(), 140, DEFAULT_RETENTION_DAYS).unwrap();

        clear_from_dir(root.path()).unwrap();
        assert!(append_to_dir(root.path(), verified, 150, DEFAULT_RETENTION_DAYS).is_err());
        assert!(
            read_recent_from_dir(root.path(), 150, 100, DEFAULT_RETENTION_DAYS)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn corrupt_jsonl_lines_are_skipped() {
        let root = tempdir().unwrap();
        let valid = serde_json::to_string(&event(1, 100)).unwrap();
        fs::write(
            root.path().join(ACTIVITY_FILE),
            format!("not-json\n{valid}\n{{broken\n"),
        )
        .unwrap();

        let loaded = read_recent_from_dir(root.path(), 200, 100, DEFAULT_RETENTION_DAYS).unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].event_id, "event-1");
    }

    #[test]
    fn retention_count_and_rotation_are_bounded() {
        let root = tempdir().unwrap();
        let now = retention_ms(DEFAULT_RETENTION_DAYS).unwrap() + 10_000;
        let mut events = vec![event(9999, 1)];
        events.extend((0..530).map(|id| {
            let mut item = event(id, now + id as u64);
            item.target_app_name = Some("x".repeat(120));
            item
        }));

        persist_events(root.path(), events, now, DEFAULT_RETENTION_DAYS).unwrap();
        let loaded =
            read_recent_from_dir(root.path(), now + 1_000, 1_000, DEFAULT_RETENTION_DAYS).unwrap();

        assert_eq!(loaded.len(), MAX_EVENTS);
        assert!(loaded.iter().all(|item| item.timestamp_ms > 1));
        assert!(root.path().join(ACTIVITY_FILE).is_file());
        assert!(root.path().join(ACTIVITY_ARCHIVE_FILE).is_file());
        assert!(fs::metadata(root.path().join(ACTIVITY_FILE)).unwrap().len() <= MAIN_FILE_BYTES);
        assert!(
            fs::metadata(root.path().join(ACTIVITY_ARCHIVE_FILE))
                .unwrap()
                .len()
                <= ARCHIVE_FILE_BYTES
        );
    }

    #[test]
    fn configured_retention_accepts_only_supported_days_and_compacts() {
        const DAY_MS: u64 = 24 * 60 * 60 * 1_000;
        let root = tempdir().unwrap();
        let now = 100 * DAY_MS;
        persist_events(
            root.path(),
            vec![event(1, now - 8 * DAY_MS), event(2, now - 6 * DAY_MS)],
            now,
            90,
        )
        .unwrap();

        let retained = read_recent_from_dir(root.path(), now, 100, 7).unwrap();

        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].event_id, "event-2");
        assert!(retention_ms(8).is_err());
    }

    #[test]
    fn clear_only_removes_activity_files() {
        let root = tempdir().unwrap();
        let business = root.path().join(crate::storage::DATA_FILE);
        fs::write(&business, b"business-bytes").unwrap();
        persist_events(
            root.path(),
            vec![event(1, 100)],
            100,
            DEFAULT_RETENTION_DAYS,
        )
        .unwrap();

        clear_from_dir(root.path()).unwrap();

        assert_eq!(fs::read(&business).unwrap(), b"business-bytes");
        assert!(!root.path().join(ACTIVITY_FILE).exists());
        assert!(!root.path().join(ACTIVITY_ARCHIVE_FILE).exists());
    }
}
