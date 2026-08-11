//! 可逆数据目录事务、磁盘 revision 与媒体完整性纯文件系统核心。
//!
//! Tauri command 只负责把 AppHandle 解析成真实路径；所有危险判断和文件
//! 操作集中在本模块，单测始终使用临时目录，不接触用户数据。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::activity::{
    ACTIVITY_ARCHIVE_FILE, ACTIVITY_FILE, ARCHIVE_FILE_BYTES, MAIN_FILE_BYTES,
};
use crate::storage::{DATA_FILE, MEDIA_DIR};

pub const MAX_STORE_VERSION: u64 = 14;
const MISSING_REVISION: &str = "missing";
const MEDIA_GC_FILE: &str = "toskr-media-gc.json";
const DATA_JOURNAL_FILE: &str = "toskr-data-transaction.json";
const JOURNAL_VERSION: u64 = 1;
const MAX_DATA_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MANAGED_FILE_BYTES: u64 = 1024 * 1024 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataLocationKind {
    Missing,
    Empty,
    NonToskr,
    Valid,
    Corrupt,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocationInspection {
    pub path: String,
    pub kind: DataLocationKind,
    pub revision: Option<String>,
    pub readable: bool,
    pub writable: bool,
    pub same_as_active: bool,
    pub external_sync_likely: bool,
    pub store_version: Option<u64>,
    pub note_count: usize,
    pub task_count: usize,
    pub media_count: usize,
    pub ordinary_file_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFileSnapshot {
    pub content: Option<String>,
    pub revision: String,
    pub size: u64,
    pub modified_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataOperationFailureCode {
    ExternalConflict,
    ReadFailed,
    WriteFailed,
    InvalidPlan,
    SamePath,
    TargetMissing,
    TargetNotEmpty,
    TargetHasNoData,
    TargetHasData,
    CorruptData,
    UnsupportedSchema,
    PermissionDenied,
    ReplaceConfirmationRequired,
    RecoveryPointFailed,
    CopyFailed,
    VerificationFailed,
    PointerCommitFailed,
    RollbackFailed,
    OperationInProgress,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataOperationFailure {
    pub code: DataOperationFailureCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMediaReference {
    pub file: String,
    pub references: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaIntegrityReport {
    pub referenced_count: usize,
    pub actual_count: usize,
    pub missing: Vec<String>,
    pub orphaned: Vec<String>,
    pub shared: Vec<SharedMediaReference>,
    pub pending_undo_references: Vec<String>,
    pub tombstoned: Vec<String>,
    pub unsafe_entries: Vec<String>,
    pub suggestions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaGcEntry {
    file: String,
    not_before_ms: u64,
    #[serde(default)]
    file_revision: Option<String>,
    #[serde(default)]
    quarantine: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaGcResult {
    pub deleted: Vec<String>,
    pub retained: Vec<String>,
}

pub fn scan_media_integrity(
    data_dir: &Path,
    state_json: &str,
) -> Result<MediaIntegrityReport, DataOperationFailure> {
    let value: serde_json::Value = serde_json::from_str(state_json).map_err(|error| {
        failure(
            DataOperationFailureCode::CorruptData,
            format!("媒体引用状态 JSON 无效：{error}"),
        )
    })?;
    let (active, undo) = media_reference_counts(&value)?;
    let mut all = active.clone();
    for (file, count) in &undo {
        *all.entry(file.clone()).or_default() += count;
    }
    let (actual, unsafe_entries) = actual_media_files(&data_dir.join(MEDIA_DIR))?;
    let missing = all
        .keys()
        .filter(|file| !actual.contains(*file))
        .cloned()
        .collect::<Vec<_>>();
    let orphaned = actual
        .iter()
        .filter(|file| !all.contains_key(*file))
        .cloned()
        .collect::<Vec<_>>();
    let shared = all
        .iter()
        .filter(|(_, count)| **count > 1)
        .map(|(file, references)| SharedMediaReference {
            file: file.clone(),
            references: *references,
        })
        .collect::<Vec<_>>();
    let tombstoned = read_gc_entries(data_dir)?
        .into_iter()
        .map(|entry| entry.file)
        .collect::<Vec<_>>();
    let mut suggestions = Vec::new();
    if !missing.is_empty() {
        suggestions.push("从完整备份恢复缺失媒体；不要自动删除对应记录".into());
    }
    if !orphaned.is_empty() {
        suggestions.push("孤立媒体仅报告；确认无撤销/备份 staging 引用后再清理".into());
    }
    if !unsafe_entries.is_empty() {
        suggestions.push("media 中存在 symlink 或非普通文件，需人工检查".into());
    }
    Ok(MediaIntegrityReport {
        referenced_count: all.len(),
        actual_count: actual.len(),
        missing,
        orphaned,
        shared,
        pending_undo_references: undo.keys().cloned().collect(),
        tombstoned,
        unsafe_entries,
        suggestions,
    })
}

pub fn schedule_media_gc(
    data_dir: &Path,
    files: &[String],
    not_before_ms: u64,
) -> Result<(), DataOperationFailure> {
    let mut entries = read_gc_entries(data_dir)?;
    let mut scheduled = entries
        .drain(..)
        .map(|entry| (entry.file.clone(), entry))
        .collect::<BTreeMap<_, _>>();
    for file in files {
        validate_media_file_name(file)?;
        let file_revision = media_file_revision(&data_dir.join(MEDIA_DIR).join(file))?;
        if let Some(entry) = scheduled.get_mut(file) {
            if entry.file_revision.as_deref() != file_revision.as_deref() {
                return Err(failure(
                    DataOperationFailureCode::ExternalConflict,
                    format!("媒体 {file} 自首次排期后已变化；未重绑定墓碑"),
                ));
            }
            entry.not_before_ms = entry.not_before_ms.max(not_before_ms);
        } else {
            scheduled.insert(
                file.clone(),
                MediaGcEntry {
                    file: file.clone(),
                    not_before_ms,
                    file_revision,
                    quarantine: None,
                },
            );
        }
    }
    write_gc_entries(data_dir, scheduled.into_values().collect())
}

fn media_file_revision(path: &Path) -> Result<Option<String>, DataOperationFailure> {
    if !path.exists() {
        return Ok(Some("missing".into()));
    }
    let metadata = fs::symlink_metadata(path).map_err(copy_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(failure(
            DataOperationFailureCode::VerificationFailed,
            "媒体 generation 只能绑定普通文件",
        ));
    }
    let mut file = open_regular_file(path, MAX_MANAGED_FILE_BYTES)?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(copy_error)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > MAX_MANAGED_FILE_BYTES {
            return Err(failure(
                DataOperationFailureCode::VerificationFailed,
                "媒体 generation 校验超过大小上限",
            ));
        }
        digest.update(&buffer[..read]);
    }
    let mut revision = String::from("sha256:");
    for byte in digest.finalize() {
        use std::fmt::Write as _;
        let _ = write!(revision, "{byte:02x}");
    }
    revision.push(':');
    revision.push_str(&total.to_string());
    Ok(Some(revision))
}

fn gc_quarantine_name(entry: &MediaGcEntry) -> Result<String, DataOperationFailure> {
    let revision = entry.file_revision.as_deref().ok_or_else(|| {
        failure(
            DataOperationFailureCode::ExternalConflict,
            "旧媒体墓碑缺少 generation；已阻止删除",
        )
    })?;
    let mut digest = Sha256::new();
    digest.update(entry.file.as_bytes());
    digest.update([0]);
    digest.update(revision.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest.finalize() {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(format!(".toskr-gc-{hex}"))
}

fn recover_staged_media_gc(
    data_dir: &Path,
    entries: &mut Vec<MediaGcEntry>,
) -> Result<(), DataOperationFailure> {
    let media = data_dir.join(MEDIA_DIR);
    let mut changed = false;
    let mut remove = BTreeSet::new();
    for (index, entry) in entries.iter_mut().enumerate() {
        let Some(quarantine_name) = entry.quarantine.clone() else {
            continue;
        };
        let original = media.join(&entry.file);
        let quarantine = media.join(&quarantine_name);
        let original_exists = original.exists();
        let quarantine_exists = quarantine.exists();
        match (original_exists, quarantine_exists) {
            (false, true) => {
                if media_file_revision(&quarantine)?.as_deref() != entry.file_revision.as_deref() {
                    return Err(failure(
                        DataOperationFailureCode::ExternalConflict,
                        format!("媒体 {} 的崩溃隔离版本 generation 不匹配", entry.file),
                    ));
                }
                rename_no_replace(&quarantine, &original).map_err(|error| {
                    failure(
                        DataOperationFailureCode::RollbackFailed,
                        format!("恢复崩溃隔离媒体失败：{error}"),
                    )
                })?;
                entry.quarantine = None;
                changed = true;
            }
            (true, false) => {
                if media_file_revision(&original)?.as_deref() != entry.file_revision.as_deref() {
                    return Err(failure(
                        DataOperationFailureCode::ExternalConflict,
                        format!("媒体 {} 在 GC journal 后被外部替换", entry.file),
                    ));
                }
                entry.quarantine = None;
                changed = true;
            }
            (false, false) => {
                // 隔离文件已 unlink、墓碑尚未来得及提交：删除已完成。
                remove.insert(index);
                changed = true;
            }
            (true, true) => {
                if media_file_revision(&quarantine)?.as_deref() != entry.file_revision.as_deref() {
                    return Err(failure(
                        DataOperationFailureCode::ExternalConflict,
                        format!("媒体 {} 的隔离版本无法证明所有权", entry.file),
                    ));
                }
                // 原路径出现新版本时只删除已证明的旧隔离版本，并取消旧墓碑。
                fs::remove_file(&quarantine).map_err(copy_error)?;
                remove.insert(index);
                changed = true;
            }
        }
    }
    if !remove.is_empty() {
        let mut index = 0_usize;
        entries.retain(|_| {
            let keep = !remove.contains(&index);
            index += 1;
            keep
        });
    }
    if changed {
        File::open(&media)
            .and_then(|directory| directory.sync_all())
            .map_err(copy_error)?;
        write_gc_entries(data_dir, entries.clone())?;
    }
    Ok(())
}

pub fn run_media_gc(
    data_dir: &Path,
    authoritative_state_json: &str,
    runtime_state_json: &str,
    now_ms: u64,
    mut verify_revision: impl FnMut() -> Result<(), DataOperationFailure>,
) -> Result<MediaGcResult, DataOperationFailure> {
    let authoritative: serde_json::Value =
        serde_json::from_str(authoritative_state_json).map_err(|error| {
            failure(
                DataOperationFailureCode::CorruptData,
                format!("媒体 GC 状态 JSON 无效：{error}"),
            )
        })?;
    let runtime: serde_json::Value = serde_json::from_str(runtime_state_json).map_err(|error| {
        failure(
            DataOperationFailureCode::CorruptData,
            format!("媒体 GC 运行态 JSON 无效：{error}"),
        )
    })?;
    let (authoritative_active, _) = media_reference_counts(&authoritative)?;
    let (runtime_active, undo) = media_reference_counts(&runtime)?;
    let media_root = data_dir.join(MEDIA_DIR);
    require_plain_directory(&media_root)?;
    let thumbs_root = media_root.join("thumbs");
    if thumbs_root.exists() {
        require_plain_directory(&thumbs_root)?;
    }
    let mut entries = read_gc_entries(data_dir)?;
    recover_staged_media_gc(data_dir, &mut entries)?;
    let original_entries = entries.clone();
    let mut deleted = Vec::new();
    let mut retained = Vec::new();
    let mut remove_indices = BTreeSet::new();
    let mut staged_indices = Vec::new();
    let mut thumbs_to_remove = Vec::new();
    let stage_result = (|| -> Result<(), DataOperationFailure> {
        for index in 0..entries.len() {
            let entry = entries[index].clone();
            // 只有已持久化的活动记录能证明删除已撤销并取消墓碑。运行态草稿与
            // undo 只延后本轮删除；进程退出后墓碑仍在，下一次 sweep 可清理孤儿。
            if authoritative_active.contains_key(&entry.file) {
                retained.push(entry.file.clone());
                remove_indices.insert(index);
                continue;
            }
            if runtime_active.contains_key(&entry.file)
                || undo.contains_key(&entry.file)
                || entry.not_before_ms > now_ms
            {
                retained.push(entry.file.clone());
                continue;
            }
            let media = data_dir.join(MEDIA_DIR);
            let file = media.join(&entry.file);
            let current_file_revision = media_file_revision(&file)?;
            if entry.file_revision.is_none()
                || current_file_revision.as_deref() != entry.file_revision.as_deref()
            {
                return Err(failure(
                    DataOperationFailureCode::ExternalConflict,
                    format!("媒体 {} 自排期后已变化；保留文件与墓碑", entry.file),
                ));
            }
            if file.exists() {
                verify_revision()?;
                let quarantine_name = gc_quarantine_name(&entry)?;
                let quarantine = media.join(&quarantine_name);
                if quarantine.exists() {
                    return Err(failure(
                        DataOperationFailureCode::OperationInProgress,
                        format!("媒体 {} 已存在未恢复 GC 隔离版本", entry.file),
                    ));
                }
                entries[index].quarantine = Some(quarantine_name);
                // journal 必须先于破坏动作持久化；重启可据此恢复或完成。
                write_gc_entries(data_dir, entries.clone())?;
                rename_no_replace(&file, &quarantine).map_err(|error| {
                    failure(
                        DataOperationFailureCode::WriteFailed,
                        format!("隔离到期媒体失败：{error}"),
                    )
                })?;
                File::open(&media)
                    .and_then(|directory| directory.sync_all())
                    .map_err(copy_error)?;
                if media_file_revision(&quarantine)?.as_deref()
                    != entries[index].file_revision.as_deref()
                {
                    return Err(failure(
                        DataOperationFailureCode::ExternalConflict,
                        format!("媒体 {} 在隔离边界发生变化；未删除新版本", entry.file),
                    ));
                }
                staged_indices.push(index);
            }
            thumbs_to_remove.push(media.join("thumbs").join(&entry.file));
            deleted.push(entry.file.clone());
            remove_indices.insert(index);
        }
        verify_revision()
    })();
    if let Err(error) = stage_result {
        for index in staged_indices.iter().rev() {
            let entry = &entries[*index];
            let original = media_root.join(&entry.file);
            if let Some(quarantine) = &entry.quarantine {
                let _ = rename_no_replace(&media_root.join(quarantine), &original);
            }
        }
        let _ = File::open(&media_root).and_then(|directory| directory.sync_all());
        let _ = write_gc_entries(data_dir, original_entries);
        return Err(error);
    }
    for index in &staged_indices {
        let quarantine = entries[*index]
            .quarantine
            .as_ref()
            .expect("staged entry has quarantine");
        fs::remove_file(media_root.join(quarantine)).map_err(|error| {
            failure(
                DataOperationFailureCode::WriteFailed,
                format!("删除已验证媒体隔离文件失败：{error}"),
            )
        })?;
    }
    for thumb in thumbs_to_remove {
        let _ = fs::remove_file(thumb);
    }
    File::open(&media_root)
        .and_then(|directory| directory.sync_all())
        .map_err(copy_error)?;
    let mut index = 0_usize;
    entries.retain(|_| {
        let keep = !remove_indices.contains(&index);
        index += 1;
        keep
    });
    for entry in &mut entries {
        entry.quarantine = None;
    }
    write_gc_entries(data_dir, entries)?;
    Ok(MediaGcResult { deleted, retained })
}

fn media_reference_counts(
    value: &serde_json::Value,
) -> Result<(BTreeMap<String, usize>, BTreeMap<String, usize>), DataOperationFailure> {
    let mut active = BTreeMap::new();
    let mut undo = BTreeMap::new();
    if let Some(object) = value.as_object() {
        if let Some(state) = object.get("state") {
            collect_media_counts(state, &mut active)?;
        } else {
            collect_media_counts(value, &mut active)?;
        }
        if let Some(stack) = object.get("undoStack") {
            collect_media_counts(stack, &mut undo)?;
        }
    } else {
        collect_media_counts(value, &mut active)?;
    }
    Ok((active, undo))
}

fn collect_media_counts(
    value: &serde_json::Value,
    counts: &mut BTreeMap<String, usize>,
) -> Result<(), DataOperationFailure> {
    match value {
        serde_json::Value::Object(map) => {
            for (key, value) in map {
                match key.as_str() {
                    "imageFile" => {
                        if let Some(file) = value.as_str() {
                            validate_media_file_name(file)?;
                            *counts.entry(file.into()).or_default() += 1;
                        }
                    }
                    "attachments" => {
                        if let Some(files) = value.as_array() {
                            for file in files.iter().filter_map(serde_json::Value::as_str) {
                                validate_media_file_name(file)?;
                                *counts.entry(file.into()).or_default() += 1;
                            }
                        }
                    }
                    _ => collect_media_counts(value, counts)?,
                }
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                collect_media_counts(value, counts)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn actual_media_files(
    media_dir: &Path,
) -> Result<(BTreeSet<String>, Vec<String>), DataOperationFailure> {
    let mut files = BTreeSet::new();
    let mut unsafe_entries = Vec::new();
    if media_dir.exists() {
        require_plain_directory(media_dir)?;
    }
    let Ok(entries) = fs::read_dir(media_dir) else {
        return Ok((files, unsafe_entries));
    };
    for entry in entries {
        let entry = entry.map_err(|error| {
            failure(
                DataOperationFailureCode::ReadFailed,
                format!("扫描 media 失败：{error}"),
            )
        })?;
        if entry.file_name() == "thumbs" {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = entry.file_type().map_err(|error| {
            failure(
                DataOperationFailureCode::ReadFailed,
                format!("读取媒体类型失败：{error}"),
            )
        })?;
        if kind.is_file() {
            files.insert(name);
        } else {
            unsafe_entries.push(name);
        }
    }
    Ok((files, unsafe_entries))
}

fn require_plain_directory(path: &Path) -> Result<(), DataOperationFailure> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        failure(
            DataOperationFailureCode::ReadFailed,
            format!("读取目录元数据失败：{error}"),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(failure(
            DataOperationFailureCode::CorruptData,
            "受管目录不是普通目录",
        ));
    }
    Ok(())
}

fn validate_media_file_name(file: &str) -> Result<(), DataOperationFailure> {
    let path = Path::new(file);
    if file.is_empty()
        || path.is_absolute()
        || path.components().count() != 1
        || file.contains("..")
        || file.contains('/')
        || file.contains('\\')
    {
        return Err(failure(
            DataOperationFailureCode::InvalidPlan,
            format!("媒体文件名无效：{file}"),
        ));
    }
    Ok(())
}

fn read_gc_entries(data_dir: &Path) -> Result<Vec<MediaGcEntry>, DataOperationFailure> {
    let path = data_dir.join(MEDIA_GC_FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = read_regular_file(&path, MAX_DATA_FILE_BYTES)?;
    let entries: Vec<MediaGcEntry> = serde_json::from_slice(&bytes).map_err(|error| {
        failure(
            DataOperationFailureCode::CorruptData,
            format!("媒体墓碑损坏：{error}"),
        )
    })?;
    for entry in &entries {
        validate_media_file_name(&entry.file)?;
        if let Some(quarantine) = &entry.quarantine {
            if quarantine != &gc_quarantine_name(entry)? {
                return Err(failure(
                    DataOperationFailureCode::CorruptData,
                    "媒体墓碑 quarantine 路径无效",
                ));
            }
        }
    }
    Ok(entries)
}

fn write_gc_entries(
    data_dir: &Path,
    entries: Vec<MediaGcEntry>,
) -> Result<(), DataOperationFailure> {
    fs::create_dir_all(data_dir).map_err(write_error)?;
    let path = data_dir.join(MEDIA_GC_FILE);
    if entries.is_empty() {
        if path.exists() {
            fs::remove_file(&path).map_err(write_error)?;
            sync_parent(&path).map_err(write_error)?;
        }
        return Ok(());
    }
    let bytes = serde_json::to_vec_pretty(&entries).map_err(|error| {
        failure(
            DataOperationFailureCode::WriteFailed,
            format!("序列化媒体墓碑失败：{error}"),
        )
    })?;
    atomic_write_file(&path, &bytes, DataOperationFailureCode::WriteFailed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataOperationAction {
    MigrateCurrentToTarget,
    LoadExistingTarget,
    ReplaceTargetWithCurrent,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataOperationPhase {
    Prepare,
    RecoveryPoint,
    Copy,
    Verify,
    CommitPointer,
    Rehydrate,
    Complete,
    Rollback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataOperationStatus {
    AwaitingRehydrate,
    Completed,
    RolledBack,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataOperationResult {
    pub operation_id: String,
    pub status: DataOperationStatus,
    pub phase: DataOperationPhase,
    pub active_dir: String,
    pub rolled_back: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataOperationPlan {
    pub operation_id: String,
    pub source_path: String,
    pub target_path: String,
    pub action: DataOperationAction,
    pub replace_confirmed: bool,
    #[serde(default)]
    pub expected_target_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DataOperationJournal {
    version: u64,
    operation_id: String,
    active_dir: PathBuf,
    source: PathBuf,
    target: PathBuf,
    action: DataOperationAction,
    old_pointer: Option<Vec<u8>>,
    recovery_dir: Option<PathBuf>,
    staging_dir: Option<PathBuf>,
    displaced_dir: Option<PathBuf>,
    #[serde(default)]
    rollback_capture_dir: Option<PathBuf>,
    target_created: bool,
    cleanup_paths: Vec<PathBuf>,
    source_revision: String,
    target_revision: String,
    expected_committed_revision: Option<String>,
    commit_started: bool,
    #[serde(default)]
    commit_completed: bool,
}

#[derive(Debug)]
pub struct PendingDataOperation {
    pub operation_id: String,
    pub active_dir: PathBuf,
    source: PathBuf,
    target: PathBuf,
    action: DataOperationAction,
    old_pointer: Option<Vec<u8>>,
    recovery_dir: Option<PathBuf>,
    staging_dir: Option<PathBuf>,
    displaced_dir: Option<PathBuf>,
    rollback_capture_dir: Option<PathBuf>,
    target_created: bool,
    cleanup_paths: Vec<PathBuf>,
    source_revision: String,
    target_revision: String,
    expected_committed_revision: Option<String>,
    commit_started: bool,
    commit_completed: bool,
    journal_path: PathBuf,
}

impl PendingDataOperation {
    pub fn finalize(&self) -> Result<(), DataOperationFailure> {
        if let Some(expected) = &self.expected_committed_revision {
            let current = managed_revision(&self.target)?;
            if &current != expected {
                return Err(failure(
                    DataOperationFailureCode::ExternalConflict,
                    "重新水合期间目标数据发生外部变化；事务保持可恢复状态",
                ));
            }
        }
        // journal 是崩溃恢复的提交位：必须先可靠移除，再清理 recovery。
        // 反过来会在“recovery 已删、journal 尚存”的崩溃点误触发回滚。
        remove_journal(&self.journal_path)?;
        // 数据与内存已经完成重新水合后，临时目录清理只是维护工作，不能再把
        // 已提交事务翻转成“失败”并尝试使用可能已删除的 recovery 回滚。
        // 清理失败会留下可识别的隐藏目录，但不会破坏已验证的活动数据集。
        for path in self
            .cleanup_paths
            .iter()
            .map(Some)
            .chain([self.staging_dir.as_ref(), self.recovery_dir.as_ref()])
            .chain([self.displaced_dir.as_ref()])
            .chain([self.rollback_capture_dir.as_ref()])
            .into_iter()
            .flatten()
        {
            if path.exists() {
                let _ = fs::remove_dir_all(path);
            }
        }
        Ok(())
    }

    pub fn rollback(
        &self,
        pointer_path: &Path,
        _default_dir: &Path,
    ) -> Result<PathBuf, DataOperationFailure> {
        if self.commit_started {
            rollback_target(self)?;
        }
        restore_pointer(pointer_path, self.old_pointer.as_deref())?;
        for path in &self.cleanup_paths {
            let _ = fs::remove_dir_all(path);
        }
        if let Some(displaced) = &self.displaced_dir {
            let _ = fs::remove_dir_all(displaced);
        }
        if let Some(capture) = &self.rollback_capture_dir {
            let _ = fs::remove_dir_all(capture);
        }
        remove_journal(&self.journal_path)?;
        Ok(self.source.clone())
    }

    fn journal(&self) -> DataOperationJournal {
        DataOperationJournal {
            version: JOURNAL_VERSION,
            operation_id: self.operation_id.clone(),
            active_dir: self.active_dir.clone(),
            source: self.source.clone(),
            target: self.target.clone(),
            action: self.action,
            old_pointer: self.old_pointer.clone(),
            recovery_dir: self.recovery_dir.clone(),
            staging_dir: self.staging_dir.clone(),
            displaced_dir: self.displaced_dir.clone(),
            rollback_capture_dir: self.rollback_capture_dir.clone(),
            target_created: self.target_created,
            cleanup_paths: self.cleanup_paths.clone(),
            source_revision: self.source_revision.clone(),
            target_revision: self.target_revision.clone(),
            expected_committed_revision: self.expected_committed_revision.clone(),
            commit_started: self.commit_started,
            commit_completed: self.commit_completed,
        }
    }

    fn persist_journal(&self) -> Result<(), DataOperationFailure> {
        let bytes = serde_json::to_vec_pretty(&self.journal()).map_err(|error| {
            failure(
                DataOperationFailureCode::WriteFailed,
                format!("序列化数据事务 journal 失败：{error}"),
            )
        })?;
        atomic_write_file(
            &self.journal_path,
            &bytes,
            DataOperationFailureCode::WriteFailed,
        )
    }
}

/// 启动时恢复未完成的目录事务。journal 只在指针所在的默认 app-data
/// 目录读取；任何损坏都会 fail closed，绝不静默切到另一份数据。
pub fn recover_pending_data_operation(
    pointer_path: &Path,
    default_dir: &Path,
) -> Result<Option<PathBuf>, DataOperationFailure> {
    let journal_path = pointer_path
        .parent()
        .unwrap_or(default_dir)
        .join(DATA_JOURNAL_FILE);
    if !journal_path.exists() {
        return Ok(None);
    }
    let bytes = read_regular_file(&journal_path, MAX_DATA_FILE_BYTES).map_err(|error| {
        failure(
            DataOperationFailureCode::RollbackFailed,
            format!("读取未完成事务 journal 失败：{}", error.message),
        )
    })?;
    let journal: DataOperationJournal = serde_json::from_slice(&bytes).map_err(|error| {
        failure(
            DataOperationFailureCode::RollbackFailed,
            format!("未完成事务 journal 已损坏：{error}"),
        )
    })?;
    validate_recovery_journal(&journal)?;
    let pending = PendingDataOperation {
        operation_id: journal.operation_id,
        active_dir: journal.active_dir,
        source: journal.source,
        target: journal.target,
        action: journal.action,
        old_pointer: journal.old_pointer,
        recovery_dir: journal.recovery_dir,
        staging_dir: journal.staging_dir,
        displaced_dir: journal.displaced_dir,
        rollback_capture_dir: journal.rollback_capture_dir,
        target_created: journal.target_created,
        cleanup_paths: journal.cleanup_paths,
        source_revision: journal.source_revision,
        target_revision: journal.target_revision,
        expected_committed_revision: journal.expected_committed_revision,
        commit_started: journal.commit_started,
        commit_completed: journal.commit_completed,
        journal_path,
    };
    pending.rollback(pointer_path, default_dir).map(Some)
}

pub fn recovery_journal_exists(pointer_path: &Path, default_dir: &Path) -> bool {
    pointer_path
        .parent()
        .unwrap_or(default_dir)
        .join(DATA_JOURNAL_FILE)
        .exists()
}

fn validate_recovery_journal(journal: &DataOperationJournal) -> Result<(), DataOperationFailure> {
    validate_operation_id(&journal.operation_id)?;
    if journal.version != JOURNAL_VERSION
        || !journal.source.is_absolute()
        || !journal.target.is_absolute()
    {
        return Err(failure(
            DataOperationFailureCode::RollbackFailed,
            "未完成事务 journal 版本或路径无效",
        ));
    }
    if let Some(recovery) = &journal.recovery_dir {
        let expected = journal
            .target
            .join(format!(".toskr-recovery-{}", journal.operation_id));
        if normalize_path(recovery) != normalize_path(&expected) {
            return Err(failure(
                DataOperationFailureCode::RollbackFailed,
                "未完成事务 recovery 路径无效",
            ));
        }
    }
    if let Some(staging) = &journal.staging_dir {
        let normal = journal
            .target
            .join(format!(".toskr-staging-{}", journal.operation_id));
        let import = journal
            .target
            .parent()
            .map(|parent| parent.join(format!(".toskr-import-source-{}", journal.operation_id)));
        if normalize_path(staging) != normalize_path(&normal)
            && import
                .as_ref()
                .is_none_or(|path| normalize_path(staging) != normalize_path(path))
        {
            return Err(failure(
                DataOperationFailureCode::RollbackFailed,
                "未完成事务 staging 路径无效",
            ));
        }
    }
    if let Some(displaced) = &journal.displaced_dir {
        let expected = journal
            .target
            .join(format!(".toskr-displaced-{}", journal.operation_id));
        if normalize_path(displaced) != normalize_path(&expected) {
            return Err(failure(
                DataOperationFailureCode::RollbackFailed,
                "未完成事务 displaced 路径无效",
            ));
        }
    }
    if let Some(capture) = &journal.rollback_capture_dir {
        let expected = journal
            .target
            .join(format!(".toskr-rollback-capture-{}", journal.operation_id));
        if normalize_path(capture) != normalize_path(&expected) {
            return Err(failure(
                DataOperationFailureCode::RollbackFailed,
                "未完成事务 rollback capture 路径无效",
            ));
        }
    }
    let import_source = journal
        .target
        .parent()
        .map(|parent| parent.join(format!(".toskr-import-source-{}", journal.operation_id)));
    if journal.cleanup_paths.iter().any(|path| {
        import_source
            .as_ref()
            .is_none_or(|expected| normalize_path(path) != normalize_path(expected))
    }) {
        return Err(failure(
            DataOperationFailureCode::RollbackFailed,
            "未完成事务 cleanup 路径无效",
        ));
    }
    Ok(())
}

pub fn begin_data_operation(
    plan: &DataOperationPlan,
    pointer_path: &Path,
    default_dir: &Path,
) -> Result<PendingDataOperation, DataOperationFailure> {
    begin_data_operation_inner(plan, pointer_path, default_dir, None)
}

fn begin_data_operation_inner(
    plan: &DataOperationPlan,
    pointer_path: &Path,
    default_dir: &Path,
    fail_at: Option<DataOperationPhase>,
) -> Result<PendingDataOperation, DataOperationFailure> {
    validate_operation_id(&plan.operation_id)?;
    if plan.action == DataOperationAction::Cancel {
        return Err(failure(
            DataOperationFailureCode::InvalidPlan,
            "取消动作不会启动数据事务",
        ));
    }
    let journal_path = pointer_path
        .parent()
        .unwrap_or(default_dir)
        .join(DATA_JOURNAL_FILE);
    if journal_path.exists() {
        return Err(failure(
            DataOperationFailureCode::OperationInProgress,
            "存在未恢复的数据事务 journal；已阻止新事务",
        ));
    }
    let source = PathBuf::from(&plan.source_path);
    let target = PathBuf::from(&plan.target_path);
    if same_path(&source, &target)
        || (plan.action != DataOperationAction::LoadExistingTarget
            && paths_overlap(&source, &target))
    {
        return Err(failure(
            DataOperationFailureCode::SamePath,
            "源目录与目标目录不能相同，也不能互为祖先/后代",
        ));
    }
    let source_inspection = inspect_location(&source, None);
    if plan.action != DataOperationAction::LoadExistingTarget
        && source_inspection.kind != DataLocationKind::Valid
    {
        return Err(failure(
            match source_inspection.kind {
                DataLocationKind::Unsupported => DataOperationFailureCode::UnsupportedSchema,
                DataLocationKind::Corrupt => DataOperationFailureCode::CorruptData,
                _ => DataOperationFailureCode::TargetHasNoData,
            },
            "当前数据目录不是可迁移的 Toskr 数据集",
        ));
    }
    let target_inspection = inspect_location(&target, Some(&source));
    let expected_target_revision = plan.expected_target_revision.as_deref().ok_or_else(|| {
        failure(
            DataOperationFailureCode::InvalidPlan,
            "目录操作缺少预检版本，请重新预检目标目录",
        )
    })?;
    if target_inspection.revision.as_deref() != Some(expected_target_revision) {
        return Err(failure(
            DataOperationFailureCode::ExternalConflict,
            "目标目录自预检后已变化；请重新预检并确认操作",
        ));
    }
    validate_target_for_action(plan, &target_inspection)?;
    let source_revision = if plan.action == DataOperationAction::LoadExistingTarget {
        source_inspection
            .revision
            .unwrap_or_else(empty_managed_revision)
    } else {
        managed_revision(&source)?
    };
    let target_revision = match target_inspection.kind {
        DataLocationKind::Valid => managed_revision(&target)?,
        DataLocationKind::Missing | DataLocationKind::Empty => empty_managed_revision(),
        _ => String::new(),
    };
    inject_failure(fail_at, DataOperationPhase::Prepare)?;
    let target_created = !target.exists();
    if target_created {
        fs::create_dir_all(&target).map_err(|error| DataOperationFailure {
            code: DataOperationFailureCode::PermissionDenied,
            message: format!("创建目标目录失败：{error}"),
        })?;
    }
    let old_pointer = fs::read(pointer_path).ok();
    let mut pending = PendingDataOperation {
        operation_id: plan.operation_id.clone(),
        active_dir: target.clone(),
        source,
        target,
        action: plan.action,
        old_pointer,
        recovery_dir: None,
        staging_dir: None,
        displaced_dir: None,
        rollback_capture_dir: None,
        target_created,
        cleanup_paths: Vec::new(),
        source_revision,
        target_revision,
        expected_committed_revision: None,
        commit_started: false,
        commit_completed: false,
        journal_path,
    };

    if plan.action == DataOperationAction::LoadExistingTarget {
        let current_target_revision = managed_revision(&pending.target)?;
        if current_target_revision != pending.target_revision {
            return Err(failure(
                DataOperationFailureCode::ExternalConflict,
                "提交目录指针前目标数据已变化；请重新预检",
            ));
        }
        pending.expected_committed_revision = Some(pending.target_revision.clone());
        pending.persist_journal()?;
        if let Err(error) = write_pointer(pointer_path, &pending.target, default_dir) {
            let _ = remove_journal(&pending.journal_path);
            return Err(error);
        }
        return Ok(pending);
    }

    let staging = pending
        .target
        .join(format!(".toskr-staging-{}", plan.operation_id));
    if staging.exists() {
        return Err(failure(
            DataOperationFailureCode::OperationInProgress,
            "目标目录存在同名未完成事务",
        ));
    }
    if plan.action == DataOperationAction::ReplaceTargetWithCurrent {
        let recovery = pending
            .target
            .join(format!(".toskr-recovery-{}", plan.operation_id));
        if recovery.exists() {
            cleanup_precommit(&pending);
            return Err(failure(
                DataOperationFailureCode::OperationInProgress,
                "目标目录存在同名未完成 recovery；未触碰其内容",
            ));
        }
        if let Err(error) = copy_managed(&pending.target, &recovery) {
            let _ = fs::remove_dir_all(&recovery);
            return Err(DataOperationFailure {
                code: DataOperationFailureCode::RecoveryPointFailed,
                message: format!("创建目标恢复点失败：{}", error.message),
            });
        }
        pending.recovery_dir = Some(recovery);
        if let Err(error) = inject_failure(fail_at, DataOperationPhase::RecoveryPoint) {
            cleanup_precommit(&pending);
            return Err(error);
        }
    }
    pending.staging_dir = Some(staging.clone());
    if let Err(error) = copy_managed(&pending.source, &staging) {
        cleanup_precommit(&pending);
        return Err(DataOperationFailure {
            code: DataOperationFailureCode::CopyFailed,
            message: format!("复制当前数据失败：{}", error.message),
        });
    }
    if let Err(error) = inject_failure(fail_at, DataOperationPhase::Copy) {
        cleanup_precommit(&pending);
        return Err(error);
    }
    let source_revision = managed_revision(&pending.source);
    let staging_revision = managed_revision(&staging);
    let (Ok(source_revision), Ok(staging_revision)) = (source_revision, staging_revision) else {
        cleanup_precommit(&pending);
        return Err(failure(
            DataOperationFailureCode::VerificationFailed,
            "无法完成复制后的数据 hash 验证",
        ));
    };
    if source_revision != pending.source_revision || staging_revision != pending.source_revision {
        cleanup_precommit(&pending);
        return Err(failure(
            DataOperationFailureCode::ExternalConflict,
            "复制期间源数据发生外部变化；目标未修改",
        ));
    }
    if let Err(error) = inject_failure(fail_at, DataOperationPhase::Verify) {
        cleanup_precommit(&pending);
        return Err(error);
    }
    let target_now = match target_inspection.kind {
        DataLocationKind::Valid => managed_revision(&pending.target),
        DataLocationKind::Missing | DataLocationKind::Empty => {
            Ok(managed_partial_revision(&pending.target)?)
        }
        _ => unreachable!(),
    }?;
    if target_now != pending.target_revision {
        cleanup_precommit(&pending);
        return Err(failure(
            DataOperationFailureCode::ExternalConflict,
            "创建恢复点后目标数据发生外部变化；已停止替换",
        ));
    }
    pending.expected_committed_revision = Some(pending.source_revision.clone());
    let displaced = pending
        .target
        .join(format!(".toskr-displaced-{}", plan.operation_id));
    if displaced.exists() {
        cleanup_precommit(&pending);
        return Err(failure(
            DataOperationFailureCode::OperationInProgress,
            "目标目录存在同名 displaced 事务目录",
        ));
    }
    pending.displaced_dir = Some(displaced.clone());
    pending.rollback_capture_dir = Some(
        pending
            .target
            .join(format!(".toskr-rollback-capture-{}", plan.operation_id)),
    );
    pending.commit_started = true;
    if let Err(error) = pending.persist_journal() {
        cleanup_precommit(&pending);
        return Err(error);
    }
    if let Err(error) = commit_staging(
        &staging,
        &pending.target,
        &displaced,
        &pending.target_revision,
    ) {
        if error.external_restored {
            pending.commit_started = false;
            cleanup_precommit(&pending);
            return Err(error.failure);
        }
        return Err(rollback_after_begin_failure(
            &pending,
            pointer_path,
            default_dir,
            error.failure,
        ));
    }
    pending.commit_completed = true;
    if let Err(error) = pending.persist_journal() {
        return Err(rollback_after_begin_failure(
            &pending,
            pointer_path,
            default_dir,
            error,
        ));
    }
    if managed_revision(&pending.target).ok().as_deref()
        != pending.expected_committed_revision.as_deref()
        || managed_revision(&pending.source).ok().as_deref()
            != Some(pending.source_revision.as_str())
    {
        return Err(rollback_after_begin_failure(
            &pending,
            pointer_path,
            default_dir,
            failure(
                DataOperationFailureCode::ExternalConflict,
                "提交校验时源或目标数据发生外部变化；已回滚",
            ),
        ));
    }
    if let Err(error) = inject_failure(fail_at, DataOperationPhase::CommitPointer) {
        return Err(rollback_after_begin_failure(
            &pending,
            pointer_path,
            default_dir,
            error,
        ));
    }
    if let Err(error) = write_pointer(pointer_path, &pending.target, default_dir) {
        return Err(rollback_after_begin_failure(
            &pending,
            pointer_path,
            default_dir,
            DataOperationFailure {
                code: DataOperationFailureCode::PointerCommitFailed,
                message: error.message,
            },
        ));
    }
    Ok(pending)
}

fn rollback_after_begin_failure(
    pending: &PendingDataOperation,
    pointer_path: &Path,
    default_dir: &Path,
    original: DataOperationFailure,
) -> DataOperationFailure {
    match pending.rollback(pointer_path, default_dir) {
        Ok(_) => original,
        Err(rollback) => failure(
            DataOperationFailureCode::RollbackFailed,
            format!(
                "{}；自动回滚失败并已保留 journal：{}",
                original.message, rollback.message
            ),
        ),
    }
}

pub fn begin_import_operation(
    staging_dir: &Path,
    active_dir: &Path,
    operation_id: &str,
    expected_active_revision: &str,
    pointer_path: &Path,
    default_dir: &Path,
) -> Result<PendingDataOperation, DataOperationFailure> {
    let plan = DataOperationPlan {
        operation_id: operation_id.into(),
        source_path: staging_dir.to_string_lossy().into_owned(),
        target_path: active_dir.to_string_lossy().into_owned(),
        action: DataOperationAction::ReplaceTargetWithCurrent,
        replace_confirmed: true,
        expected_target_revision: Some(expected_active_revision.into()),
    };
    let mut pending = begin_data_operation(&plan, pointer_path, default_dir)?;
    pending.source = active_dir.to_path_buf();
    pending.active_dir = active_dir.to_path_buf();
    pending.cleanup_paths.push(staging_dir.to_path_buf());
    if let Err(error) = pending.persist_journal() {
        return Err(rollback_after_begin_failure(
            &pending,
            pointer_path,
            default_dir,
            error,
        ));
    }
    Ok(pending)
}

fn inject_failure(
    fail_at: Option<DataOperationPhase>,
    phase: DataOperationPhase,
) -> Result<(), DataOperationFailure> {
    if fail_at != Some(phase) {
        return Ok(());
    }
    let code = match phase {
        DataOperationPhase::Prepare => DataOperationFailureCode::InvalidPlan,
        DataOperationPhase::RecoveryPoint => DataOperationFailureCode::RecoveryPointFailed,
        DataOperationPhase::Copy => DataOperationFailureCode::CopyFailed,
        DataOperationPhase::Verify => DataOperationFailureCode::VerificationFailed,
        DataOperationPhase::CommitPointer => DataOperationFailureCode::PointerCommitFailed,
        DataOperationPhase::Rehydrate => DataOperationFailureCode::RollbackFailed,
        DataOperationPhase::Complete | DataOperationPhase::Rollback => {
            DataOperationFailureCode::WriteFailed
        }
    };
    Err(failure(code, format!("测试注入失败：{phase:?}")))
}

fn failure(code: DataOperationFailureCode, message: impl Into<String>) -> DataOperationFailure {
    DataOperationFailure {
        code,
        message: message.into(),
    }
}

fn canonicalish(path: &Path) -> PathBuf {
    if let Ok(path) = fs::canonicalize(path) {
        return path;
    }
    let mut cursor = path;
    let mut suffix = Vec::new();
    while let Some(name) = cursor.file_name() {
        suffix.push(name.to_os_string());
        let Some(parent) = cursor.parent() else {
            break;
        };
        cursor = parent;
        if let Ok(mut resolved) = fs::canonicalize(cursor) {
            for component in suffix.iter().rev() {
                resolved.push(component);
            }
            return normalize_path(&resolved);
        }
    }
    normalize_path(path)
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    let left = canonicalish(left);
    let right = canonicalish(right);
    left == right || left.starts_with(&right) || right.starts_with(&left)
}

fn empty_managed_revision() -> String {
    revision_for(b"{}")
}

fn managed_revision(root: &Path) -> Result<String, DataOperationFailure> {
    let manifest = managed_manifest(root)?;
    manifest_revision(&manifest)
}

fn manifest_revision(manifest: &BTreeMap<String, String>) -> Result<String, DataOperationFailure> {
    let bytes = serde_json::to_vec(&manifest).map_err(|error| {
        failure(
            DataOperationFailureCode::VerificationFailed,
            format!("序列化受管数据清单失败：{error}"),
        )
    })?;
    Ok(revision_for(&bytes))
}

fn managed_partial_revision(root: &Path) -> Result<String, DataOperationFailure> {
    let manifest = managed_manifest_partial(root)?;
    let bytes = serde_json::to_vec(&manifest).map_err(|error| {
        failure(
            DataOperationFailureCode::VerificationFailed,
            format!("序列化受管数据清单失败：{error}"),
        )
    })?;
    Ok(revision_for(&bytes))
}

fn cleanup_precommit(pending: &PendingDataOperation) {
    for path in [
        pending.staging_dir.as_ref(),
        pending.recovery_dir.as_ref(),
        pending.displaced_dir.as_ref(),
        pending.rollback_capture_dir.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        let _ = fs::remove_dir_all(path);
    }
    if pending.target_created {
        let _ = fs::remove_dir(&pending.target);
    }
    let _ = remove_journal(&pending.journal_path);
}

fn next_temp_path(parent: &Path, stem: &str) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    parent.join(format!(
        ".{stem}-{}-{nanos}-{sequence}.tmp",
        std::process::id()
    ))
}

fn sync_parent(path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

pub(crate) fn atomic_write_file(
    path: &Path,
    bytes: &[u8],
    code: DataOperationFailureCode,
) -> Result<(), DataOperationFailure> {
    let parent = path
        .parent()
        .ok_or_else(|| failure(code, "原子写入路径没有父目录"))?;
    fs::create_dir_all(parent)
        .map_err(|error| failure(code, format!("创建原子写入目录失败：{error}")))?;
    let temp = next_temp_path(
        parent,
        path.file_name().and_then(|v| v.to_str()).unwrap_or("data"),
    );
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW);
        let mut file = options
            .open(&temp)
            .map_err(|error| failure(code, format!("创建原子临时文件失败：{error}")))?;
        file.write_all(bytes)
            .map_err(|error| failure(code, format!("写入原子临时文件失败：{error}")))?;
        file.sync_all()
            .map_err(|error| failure(code, format!("同步原子临时文件失败：{error}")))?;
        fs::rename(&temp, path)
            .map_err(|error| failure(code, format!("提交原子文件失败：{error}")))?;
        sync_parent(path).map_err(|error| failure(code, format!("同步原子文件目录失败：{error}")))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn remove_journal(path: &Path) -> Result<(), DataOperationFailure> {
    match fs::remove_file(path) {
        Ok(()) => sync_parent(path).map_err(|error| {
            failure(
                DataOperationFailureCode::WriteFailed,
                format!("同步事务 journal 目录失败：{error}"),
            )
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(failure(
            DataOperationFailureCode::WriteFailed,
            format!("移除事务 journal 失败：{error}"),
        )),
    }
}

fn open_regular_file(path: &Path, max_bytes: u64) -> Result<File, DataOperationFailure> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        failure(
            DataOperationFailureCode::ReadFailed,
            format!("读取普通文件元数据失败：{error}"),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > max_bytes {
        return Err(failure(
            DataOperationFailureCode::ReadFailed,
            "受管路径不是大小合规的普通文件",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let file = options.open(path).map_err(|error| {
        failure(
            DataOperationFailureCode::ReadFailed,
            format!("安全打开普通文件失败：{error}"),
        )
    })?;
    let opened = file.metadata().map_err(|error| {
        failure(
            DataOperationFailureCode::ReadFailed,
            format!("复核普通文件失败：{error}"),
        )
    })?;
    if !opened.is_file() || opened.len() > max_bytes {
        return Err(failure(
            DataOperationFailureCode::ReadFailed,
            "打开后的受管文件类型或大小发生变化",
        ));
    }
    Ok(file)
}

pub(crate) fn read_regular_file(
    path: &Path,
    max_bytes: u64,
) -> Result<Vec<u8>, DataOperationFailure> {
    let mut file = open_regular_file(path, max_bytes)?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            failure(
                DataOperationFailureCode::ReadFailed,
                format!("读取普通文件失败：{error}"),
            )
        })?;
    if bytes.len() as u64 > max_bytes {
        return Err(failure(
            DataOperationFailureCode::ReadFailed,
            "受管文件读取过程中超过大小上限",
        ));
    }
    Ok(bytes)
}

pub(crate) fn validate_operation_id(operation_id: &str) -> Result<(), DataOperationFailure> {
    if operation_id.is_empty()
        || operation_id.len() > 80
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(failure(
            DataOperationFailureCode::InvalidPlan,
            "operation ID 格式无效",
        ));
    }
    Ok(())
}

fn validate_target_for_action(
    plan: &DataOperationPlan,
    inspection: &DataLocationInspection,
) -> Result<(), DataOperationFailure> {
    if inspection.same_as_active {
        return Err(failure(
            DataOperationFailureCode::SamePath,
            "目标与当前目录相同",
        ));
    }
    if !inspection.writable {
        return Err(failure(
            DataOperationFailureCode::PermissionDenied,
            "目标目录不可写",
        ));
    }
    match plan.action {
        DataOperationAction::MigrateCurrentToTarget => match inspection.kind {
            DataLocationKind::Missing | DataLocationKind::Empty => Ok(()),
            DataLocationKind::Valid => Err(failure(
                DataOperationFailureCode::TargetHasData,
                "目标已有 Toskr 数据，禁止直接迁移覆盖",
            )),
            DataLocationKind::Corrupt => Err(failure(
                DataOperationFailureCode::CorruptData,
                "目标数据损坏，禁止覆盖",
            )),
            DataLocationKind::Unsupported => Err(failure(
                DataOperationFailureCode::UnsupportedSchema,
                "目标数据 schema 高于当前版本",
            )),
            DataLocationKind::NonToskr => Err(failure(
                DataOperationFailureCode::TargetNotEmpty,
                "目标含普通文件，必须选择空目录",
            )),
        },
        DataOperationAction::LoadExistingTarget => match inspection.kind {
            DataLocationKind::Valid => Ok(()),
            DataLocationKind::Missing => Err(failure(
                DataOperationFailureCode::TargetMissing,
                "目标目录不存在",
            )),
            DataLocationKind::Unsupported => Err(failure(
                DataOperationFailureCode::UnsupportedSchema,
                "目标数据 schema 高于当前版本",
            )),
            DataLocationKind::Corrupt => Err(failure(
                DataOperationFailureCode::CorruptData,
                "目标数据损坏",
            )),
            _ => Err(failure(
                DataOperationFailureCode::TargetHasNoData,
                "目标没有可加载的 Toskr 数据",
            )),
        },
        DataOperationAction::ReplaceTargetWithCurrent => {
            if inspection.kind != DataLocationKind::Valid {
                return Err(failure(
                    DataOperationFailureCode::TargetHasNoData,
                    "显式替换只适用于已有有效 Toskr 数据的目标",
                ));
            }
            if !plan.replace_confirmed {
                return Err(failure(
                    DataOperationFailureCode::ReplaceConfirmationRequired,
                    "替换目标需要二次明确确认",
                ));
            }
            Ok(())
        }
        DataOperationAction::Cancel => Err(failure(
            DataOperationFailureCode::InvalidPlan,
            "取消动作不会启动数据事务",
        )),
    }
}

fn copy_managed(source: &Path, destination: &Path) -> Result<(), DataOperationFailure> {
    if destination.exists() {
        return Err(failure(
            DataOperationFailureCode::CopyFailed,
            "事务 staging/recovery 已存在",
        ));
    }
    fs::create_dir(destination).map_err(copy_error)?;
    sync_parent(destination).map_err(copy_error)?;
    copy_regular_file(
        &source.join(DATA_FILE),
        &destination.join(DATA_FILE),
        MAX_DATA_FILE_BYTES,
    )?;
    let source_media = source.join(MEDIA_DIR);
    let destination_media = destination.join(MEDIA_DIR);
    if source_media.exists() {
        copy_directory(&source_media, &destination_media)?;
    }
    copy_optional_managed_file(source, destination, MEDIA_GC_FILE, MAX_DATA_FILE_BYTES)?;
    // 活动账本随数据集迁移/回滚，但刻意不进入 managed revision：
    // 元数据追加不能让笔记持久化误判成外部业务冲突。
    copy_optional_managed_file(
        source,
        destination,
        ACTIVITY_FILE,
        MAIN_FILE_BYTES + 64 * 1024,
    )?;
    copy_optional_managed_file(
        source,
        destination,
        ACTIVITY_ARCHIVE_FILE,
        ARCHIVE_FILE_BYTES + 64 * 1024,
    )?;
    File::open(destination)
        .and_then(|directory| directory.sync_all())
        .map_err(copy_error)
}

fn copy_optional_managed_file(
    source: &Path,
    destination: &Path,
    name: &str,
    max_bytes: u64,
) -> Result<(), DataOperationFailure> {
    let path = source.join(name);
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(&path).map_err(copy_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(failure(
            DataOperationFailureCode::CopyFailed,
            format!("受管数据不是普通文件：{name}"),
        ));
    }
    copy_regular_file(&path, &destination.join(name), max_bytes)
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), DataOperationFailure> {
    let source_metadata = fs::symlink_metadata(source).map_err(copy_error)?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err(failure(
            DataOperationFailureCode::CopyFailed,
            "媒体目录不是普通目录",
        ));
    }
    fs::create_dir(destination).map_err(copy_error)?;
    sync_parent(destination).map_err(copy_error)?;
    let entries = fs::read_dir(source).map_err(copy_error)?;
    for entry in entries {
        let entry = entry.map_err(copy_error)?;
        let kind = entry.file_type().map_err(copy_error)?;
        if source.file_name().is_some_and(|name| name == MEDIA_DIR) && entry.file_name() == "thumbs"
        {
            continue;
        }
        if kind.is_symlink() {
            return Err(failure(
                DataOperationFailureCode::CopyFailed,
                "数据目录包含符号链接，已拒绝复制",
            ));
        }
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else if kind.is_file() {
            copy_regular_file(&entry.path(), &target, MAX_MANAGED_FILE_BYTES)?;
        }
    }
    File::open(destination)
        .and_then(|directory| directory.sync_all())
        .map_err(copy_error)
}

fn copy_regular_file(
    source: &Path,
    destination: &Path,
    max_bytes: u64,
) -> Result<(), DataOperationFailure> {
    let mut input = open_regular_file(source, max_bytes)
        .map_err(|error| failure(DataOperationFailureCode::CopyFailed, error.message))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let mut output = options.open(destination).map_err(copy_error)?;
    let copied = std::io::copy(
        &mut std::io::Read::by_ref(&mut input).take(max_bytes + 1),
        &mut output,
    )
    .map_err(copy_error)?;
    if copied > max_bytes {
        let _ = fs::remove_file(destination);
        return Err(failure(
            DataOperationFailureCode::CopyFailed,
            "受管文件复制过程中超过大小上限",
        ));
    }
    output.sync_all().map_err(copy_error)?;
    sync_parent(destination).map_err(copy_error)
}

fn copy_error(error: std::io::Error) -> DataOperationFailure {
    failure(
        DataOperationFailureCode::CopyFailed,
        format!("复制文件失败：{error}"),
    )
}

fn managed_manifest(root: &Path) -> Result<BTreeMap<String, String>, DataOperationFailure> {
    if !root.join(DATA_FILE).exists() {
        return Err(failure(
            DataOperationFailureCode::VerificationFailed,
            "数据集缺少主数据文件",
        ));
    }
    managed_manifest_partial(root)
}

fn managed_manifest_partial(root: &Path) -> Result<BTreeMap<String, String>, DataOperationFailure> {
    let mut manifest = BTreeMap::new();
    let data = root.join(DATA_FILE);
    if data.exists() {
        collect_manifest(root, &data, &mut manifest)?;
    }
    let media = root.join(MEDIA_DIR);
    if media.exists() {
        let metadata = fs::symlink_metadata(&media).map_err(copy_error)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(failure(
                DataOperationFailureCode::VerificationFailed,
                "media 不是普通目录",
            ));
        }
        collect_manifest_tree(root, &media, &mut manifest)?;
    }
    let gc = root.join(MEDIA_GC_FILE);
    if gc.exists() {
        collect_manifest(root, &gc, &mut manifest)?;
    }
    Ok(manifest)
}

fn collect_manifest_tree(
    root: &Path,
    directory: &Path,
    manifest: &mut BTreeMap<String, String>,
) -> Result<(), DataOperationFailure> {
    for entry in fs::read_dir(directory).map_err(copy_error)? {
        let entry = entry.map_err(copy_error)?;
        let kind = entry.file_type().map_err(copy_error)?;
        if directory == root.join(MEDIA_DIR) && entry.file_name() == "thumbs" {
            continue;
        }
        if kind.is_symlink() {
            return Err(failure(
                DataOperationFailureCode::VerificationFailed,
                "数据目录包含符号链接",
            ));
        }
        if kind.is_dir() {
            collect_manifest_tree(root, &entry.path(), manifest)?;
        } else if kind.is_file() {
            collect_manifest(root, &entry.path(), manifest)?;
        }
    }
    Ok(())
}

fn collect_manifest(
    root: &Path,
    path: &Path,
    manifest: &mut BTreeMap<String, String>,
) -> Result<(), DataOperationFailure> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| {
            failure(
                DataOperationFailureCode::VerificationFailed,
                "文件越出数据目录",
            )
        })?
        .to_string_lossy()
        .replace('\\', "/");
    let max = if relative == DATA_FILE || relative == MEDIA_GC_FILE {
        MAX_DATA_FILE_BYTES
    } else {
        MAX_MANAGED_FILE_BYTES
    };
    let mut file = open_regular_file(path, max)
        .map_err(|error| failure(DataOperationFailureCode::VerificationFailed, error.message))?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(copy_error)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > max {
            return Err(failure(
                DataOperationFailureCode::VerificationFailed,
                "受管文件校验过程中超过大小上限",
            ));
        }
        digest.update(&buffer[..read]);
    }
    let mut revision = String::from("sha256:");
    for byte in digest.finalize() {
        use std::fmt::Write as _;
        let _ = write!(revision, "{byte:02x}");
    }
    revision.push(':');
    revision.push_str(&total.to_string());
    manifest.insert(relative, revision);
    Ok(())
}

struct CommitStagingFailure {
    failure: DataOperationFailure,
    external_restored: bool,
}

fn commit_staging(
    staging: &Path,
    target: &Path,
    displaced: &Path,
    expected_target_revision: &str,
) -> Result<(), CommitStagingFailure> {
    fs::create_dir(displaced).map_err(|error| CommitStagingFailure {
        failure: copy_error(error),
        external_restored: false,
    })?;
    move_managed_no_replace(target, displaced).map_err(|failure| CommitStagingFailure {
        failure,
        external_restored: false,
    })?;
    let displaced_revision =
        managed_partial_revision(displaced).map_err(|failure| CommitStagingFailure {
            failure,
            external_restored: false,
        })?;
    if displaced_revision != expected_target_revision {
        let restored = move_managed_no_replace(displaced, target).is_ok()
            && managed_partial_revision(target).ok().as_deref()
                == Some(displaced_revision.as_str());
        if restored {
            let _ = fs::remove_dir_all(displaced);
        }
        return Err(CommitStagingFailure {
            failure: failure(
                DataOperationFailureCode::ExternalConflict,
                "最终提交捕获到未授权目标版本；已恢复或隔离该版本",
            ),
            external_restored: restored,
        });
    }
    move_managed_no_replace(staging, target).map_err(|failure| CommitStagingFailure {
        failure,
        external_restored: false,
    })?;
    sync_parent(&target.join(DATA_FILE)).map_err(|error| CommitStagingFailure {
        failure: copy_error(error),
        external_restored: false,
    })
}

fn move_managed_no_replace(source: &Path, destination: &Path) -> Result<(), DataOperationFailure> {
    for name in [
        DATA_FILE,
        MEDIA_DIR,
        MEDIA_GC_FILE,
        ACTIVITY_FILE,
        ACTIVITY_ARCHIVE_FILE,
    ] {
        let from = source.join(name);
        if !from.exists() {
            continue;
        }
        let metadata = fs::symlink_metadata(&from).map_err(copy_error)?;
        if metadata.file_type().is_symlink()
            || !(metadata.is_file() || (name == MEDIA_DIR && metadata.is_dir()))
        {
            return Err(failure(
                DataOperationFailureCode::VerificationFailed,
                format!("受管路径类型无效：{name}"),
            ));
        }
        rename_no_replace(&from, &destination.join(name)).map_err(copy_error)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    rename_with_flags(from, to, libc::RENAME_EXCL)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    if to.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "destination exists",
        ));
    }
    fs::rename(from, to)
}

#[cfg(test)]
fn remove_managed(root: &Path) -> Result<(), DataOperationFailure> {
    let data = root.join(DATA_FILE);
    if data.exists() {
        fs::remove_file(data).map_err(copy_error)?;
    }
    let media = root.join(MEDIA_DIR);
    if media.exists() {
        fs::remove_dir_all(media).map_err(copy_error)?;
    }
    let gc = root.join(MEDIA_GC_FILE);
    if gc.exists() {
        fs::remove_file(gc).map_err(copy_error)?;
    }
    for name in [ACTIVITY_FILE, ACTIVITY_ARCHIVE_FILE] {
        let path = root.join(name);
        if path.exists() {
            fs::remove_file(path).map_err(copy_error)?;
        }
    }
    Ok(())
}

fn rollback_target(pending: &PendingDataOperation) -> Result<(), DataOperationFailure> {
    if pending.action == DataOperationAction::LoadExistingTarget {
        return Ok(());
    }
    let current = managed_partial_revision(&pending.target).map_err(rollback_error)?;
    if current == empty_managed_revision()
        && pending.target_revision != empty_managed_revision()
        && pending.commit_completed
        && !rollback_capture_proves_vacated_target(pending)?
    {
        return Err(failure(
            DataOperationFailureCode::RollbackFailed,
            "目标数据已被外部删除；未恢复旧版本并保留 journal",
        ));
    }
    let owned_partial = if current == pending.target_revision {
        // 上次回滚已恢复目标，只需继续清理/恢复指针，保证幂等可重试。
        None
    } else if pending
        .expected_committed_revision
        .as_ref()
        .is_some_and(|expected| current != *expected)
    {
        let owned = current_target_owned_partial(pending)?;
        if owned.is_none() {
            return Err(failure(
                DataOperationFailureCode::RollbackFailed,
                "目标含无法证明属于本事务的外部版本；已保留目标与 journal",
            ));
        }
        owned
    } else {
        None
    };
    if current != pending.target_revision && current != empty_managed_revision() {
        match owned_partial {
            Some(OwnedPartialKind::ForwardDisplace) => {
                rejoin_forward_displaced(pending)?;
            }
            Some(OwnedPartialKind::RollbackRestore) => {
                rejoin_rollback_staging(pending)?;
            }
            _ => capture_current_for_rollback(pending, &current)?,
        }
    }
    if let Some(recovery) = &pending.recovery_dir {
        if current == pending.target_revision {
            let _ = fs::remove_dir_all(recovery);
        } else {
            let rollback_staging = pending
                .target
                .join(format!(".toskr-rollback-{}", pending.operation_id));
            let preserved_partial = prepare_rollback_staging(pending, recovery, &rollback_staging)?;
            move_managed_no_replace(&rollback_staging, &pending.target).map_err(rollback_error)?;
            let _ = fs::remove_dir(&rollback_staging);
            if managed_revision(&pending.target).map_err(rollback_error)? != pending.target_revision
            {
                return Err(failure(
                    DataOperationFailureCode::RollbackFailed,
                    "恢复后的目标数据校验失败",
                ));
            }
            fs::remove_dir_all(recovery).map_err(|error| {
                failure(
                    DataOperationFailureCode::RollbackFailed,
                    format!("清理已使用恢复点失败：{error}"),
                )
            })?;
            if let Some(partial) = preserved_partial {
                let _ = fs::remove_dir_all(partial);
            }
        }
    } else if managed_partial_revision(&pending.target).map_err(rollback_error)?
        != empty_managed_revision()
    {
        return Err(failure(
            DataOperationFailureCode::RollbackFailed,
            "迁移目标未能回滚为空目录",
        ));
    }
    if let Some(staging) = &pending.staging_dir {
        let _ = fs::remove_dir_all(staging);
    }
    if let Some(capture) = &pending.rollback_capture_dir {
        if capture.exists() {
            fs::remove_dir_all(capture).map_err(|error| {
                failure(
                    DataOperationFailureCode::RollbackFailed,
                    format!("清理回滚隔离版本失败：{error}"),
                )
            })?;
        }
    }
    if pending.target_created {
        let _ = fs::remove_dir(&pending.target);
    }
    Ok(())
}

fn prepare_rollback_staging(
    pending: &PendingDataOperation,
    recovery: &Path,
    rollback_staging: &Path,
) -> Result<Option<PathBuf>, DataOperationFailure> {
    let recovery_manifest = managed_manifest_partial(recovery).map_err(rollback_error)?;
    if manifest_revision(&recovery_manifest).map_err(rollback_error)? != pending.target_revision {
        return Err(failure(
            DataOperationFailureCode::RollbackFailed,
            "目标恢复点 hash 不匹配",
        ));
    }
    let preserved = pending
        .target
        .join(format!(".toskr-rollback-partial-{}", pending.operation_id));
    if preserved.exists() {
        let manifest = managed_manifest_partial(&preserved).map_err(rollback_error)?;
        if manifest.is_empty() || !manifest_is_subset(&manifest, &recovery_manifest) {
            return Err(failure(
                DataOperationFailureCode::RollbackFailed,
                "已隔离的 rollback partial 无法证明属于恢复点",
            ));
        }
    }
    if rollback_staging.exists() {
        let manifest = managed_manifest_partial(rollback_staging).map_err(rollback_error)?;
        if manifest_revision(&manifest).map_err(rollback_error)? == pending.target_revision {
            return Ok(preserved.exists().then_some(preserved));
        }
        if manifest.is_empty()
            || !manifest_is_subset(&manifest, &recovery_manifest)
            || preserved.exists()
        {
            return Err(failure(
                DataOperationFailureCode::RollbackFailed,
                "rollback staging 含无法证明的外部版本",
            ));
        }
        rename_no_replace(rollback_staging, &preserved)
            .map_err(|error| rollback_error(copy_error(error)))?;
        sync_parent(&preserved).map_err(|error| rollback_error(copy_error(error)))?;
    }
    let build = next_temp_path(&pending.target, "toskr-rollback-build");
    copy_managed(recovery, &build).map_err(rollback_error)?;
    if managed_revision(&build).map_err(rollback_error)? != pending.target_revision {
        return Err(failure(
            DataOperationFailureCode::RollbackFailed,
            "重建 rollback staging 后 hash 不匹配",
        ));
    }
    rename_no_replace(&build, rollback_staging)
        .map_err(|error| rollback_error(copy_error(error)))?;
    sync_parent(rollback_staging).map_err(|error| rollback_error(copy_error(error)))?;
    Ok(preserved.exists().then_some(preserved))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OwnedPartialKind {
    ForwardDisplace,
    ForwardOrCapture,
    RollbackCopyPartial,
    RollbackRestore,
}

fn rejoin_forward_displaced(pending: &PendingDataOperation) -> Result<(), DataOperationFailure> {
    let displaced = pending.displaced_dir.as_ref().ok_or_else(|| {
        failure(
            DataOperationFailureCode::RollbackFailed,
            "forward partial 缺少 displaced 目录",
        )
    })?;
    move_managed_no_replace(&pending.target, displaced).map_err(rollback_error)?;
    if managed_revision(displaced).map_err(rollback_error)? != pending.target_revision {
        return Err(failure(
            DataOperationFailureCode::RollbackFailed,
            "forward displaced 重新合并后 hash 不匹配",
        ));
    }
    Ok(())
}

fn rejoin_rollback_staging(pending: &PendingDataOperation) -> Result<(), DataOperationFailure> {
    let rollback_staging = pending
        .target
        .join(format!(".toskr-rollback-{}", pending.operation_id));
    if !rollback_staging.exists() {
        return Err(failure(
            DataOperationFailureCode::RollbackFailed,
            "回滚恢复 partial 缺少互补 staging",
        ));
    }
    move_managed_no_replace(&pending.target, &rollback_staging).map_err(rollback_error)?;
    if managed_revision(&rollback_staging).map_err(rollback_error)? != pending.target_revision {
        return Err(failure(
            DataOperationFailureCode::RollbackFailed,
            "回滚恢复 partial 重新合并后 hash 不匹配",
        ));
    }
    Ok(())
}

fn rollback_capture_proves_vacated_target(
    pending: &PendingDataOperation,
) -> Result<bool, DataOperationFailure> {
    let Some(expected) = pending.expected_committed_revision.as_ref() else {
        return Ok(false);
    };
    let capture = rollback_capture_manifest(pending)?;
    Ok(!capture.is_empty() && manifest_revision(&capture).map_err(rollback_error)? == *expected)
}

fn merge_manifest(
    destination: &mut BTreeMap<String, String>,
    source: BTreeMap<String, String>,
) -> bool {
    for (path, revision) in source {
        if destination.insert(path, revision).is_some() {
            return false;
        }
    }
    true
}

fn combined_manifest_matches(
    parts: impl IntoIterator<Item = BTreeMap<String, String>>,
    expected_revision: &str,
) -> Result<bool, DataOperationFailure> {
    let mut combined = BTreeMap::new();
    for part in parts {
        if !merge_manifest(&mut combined, part) {
            return Ok(false);
        }
    }
    Ok(manifest_revision(&combined).map_err(rollback_error)? == expected_revision)
}

fn manifest_is_subset(
    candidate: &BTreeMap<String, String>,
    complete: &BTreeMap<String, String>,
) -> bool {
    candidate
        .iter()
        .all(|(path, revision)| complete.get(path) == Some(revision))
}

fn rollback_capture_manifest(
    pending: &PendingDataOperation,
) -> Result<BTreeMap<String, String>, DataOperationFailure> {
    let Some(root) = pending.rollback_capture_dir.as_ref() else {
        return Ok(BTreeMap::new());
    };
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(BTreeMap::new());
    };
    let mut manifest = BTreeMap::new();
    for entry in entries {
        let entry = entry.map_err(|error| rollback_error(copy_error(error)))?;
        if !entry
            .file_type()
            .map_err(|error| rollback_error(copy_error(error)))?
            .is_dir()
        {
            return Err(failure(
                DataOperationFailureCode::RollbackFailed,
                "回滚隔离目录含非目录条目",
            ));
        }
        if !merge_manifest(
            &mut manifest,
            managed_manifest_partial(&entry.path()).map_err(rollback_error)?,
        ) {
            return Err(failure(
                DataOperationFailureCode::RollbackFailed,
                "回滚隔离目录含重复受管版本",
            ));
        }
    }
    Ok(manifest)
}

fn capture_current_for_rollback(
    pending: &PendingDataOperation,
    expected_revision: &str,
) -> Result<(), DataOperationFailure> {
    let root = pending.rollback_capture_dir.as_ref().ok_or_else(|| {
        failure(
            DataOperationFailureCode::RollbackFailed,
            "事务 journal 缺少回滚隔离目录",
        )
    })?;
    if !root.exists() {
        fs::create_dir(root).map_err(|error| rollback_error(copy_error(error)))?;
        sync_parent(root).map_err(|error| rollback_error(copy_error(error)))?;
    }
    let capture = next_temp_path(root, "captured-managed-version");
    fs::create_dir(&capture).map_err(|error| rollback_error(copy_error(error)))?;
    sync_parent(&capture).map_err(|error| rollback_error(copy_error(error)))?;
    move_managed_no_replace(&pending.target, &capture).map_err(rollback_error)?;
    let captured = managed_partial_revision(&capture).map_err(rollback_error)?;
    if captured != expected_revision {
        let restored = move_managed_no_replace(&capture, &pending.target).is_ok()
            && managed_partial_revision(&pending.target).ok().as_deref() == Some(captured.as_str());
        if restored {
            let _ = fs::remove_dir_all(&capture);
        }
        return Err(failure(
            DataOperationFailureCode::RollbackFailed,
            "回滚捕获到未授权外部版本；已恢复或隔离该版本并保留 journal",
        ));
    }
    if managed_partial_revision(&pending.target).map_err(rollback_error)?
        != empty_managed_revision()
    {
        return Err(failure(
            DataOperationFailureCode::RollbackFailed,
            "回滚隔离后目标又出现外部版本；已停止恢复",
        ));
    }
    Ok(())
}

fn current_target_owned_partial(
    pending: &PendingDataOperation,
) -> Result<Option<OwnedPartialKind>, DataOperationFailure> {
    let current = managed_manifest_partial(&pending.target).map_err(rollback_error)?;
    let Some(expected_committed) = pending.expected_committed_revision.as_ref() else {
        return Ok(None);
    };

    // forward commit 在逐项把旧目标搬进 displaced 时崩溃：target 与 displaced
    // 必须精确组成冻结的旧目标，且 staging 仍是完整的新 committed 版本。
    if !pending.commit_completed {
        let staging = pending
            .staging_dir
            .as_ref()
            .filter(|path| path.exists())
            .map(|path| managed_manifest_partial(path).map_err(rollback_error))
            .transpose()?
            .unwrap_or_default();
        let displaced = pending
            .displaced_dir
            .as_ref()
            .filter(|path| path.exists())
            .map(|path| managed_manifest_partial(path).map_err(rollback_error))
            .transpose()?
            .unwrap_or_default();
        if !displaced.is_empty()
            && manifest_revision(&staging).map_err(rollback_error)? == *expected_committed
            && combined_manifest_matches([current.clone(), displaced], &pending.target_revision)?
        {
            return Ok(Some(OwnedPartialKind::ForwardDisplace));
        }
    }

    // forward commit 在逐项搬 staging 时崩溃：只有 target + staging 精确组成
    // 已冻结 committed revision 才能认领；“只是其子集”也可能是外部删除。
    if !pending.commit_completed {
        let staging = pending
            .staging_dir
            .as_ref()
            .filter(|path| path.exists())
            .map(|path| managed_manifest_partial(path).map_err(rollback_error))
            .transpose()?
            .unwrap_or_default();
        if combined_manifest_matches([current.clone(), staging], expected_committed)? {
            return Ok(Some(OwnedPartialKind::ForwardOrCapture));
        }
    }

    // rollback capture 逐项搬运 committed 版本时崩溃：target 与所有 capture
    // 子目录的并集必须精确等于 committed revision。
    let capture = rollback_capture_manifest(pending)?;
    if !capture.is_empty()
        && combined_manifest_matches([current.clone(), capture.clone()], expected_committed)?
    {
        return Ok(Some(OwnedPartialKind::ForwardOrCapture));
    }

    // 已完整捕获 committed 版本后，恢复旧目标也可能逐项中断。必须再由
    // target + rollback staging 精确证明旧 target revision，不能猜测来源。
    if capture.is_empty()
        || manifest_revision(&capture).map_err(rollback_error)? != *expected_committed
    {
        return Ok(None);
    }
    let rollback_staging = pending
        .target
        .join(format!(".toskr-rollback-{}", pending.operation_id));
    if !rollback_staging.exists() {
        return Ok(None);
    }
    let remaining = managed_manifest_partial(&rollback_staging).map_err(rollback_error)?;
    if combined_manifest_matches(
        [current.clone(), remaining.clone()],
        &pending.target_revision,
    )? {
        return Ok(Some(OwnedPartialKind::RollbackRestore));
    }
    if current.is_empty() {
        let recovery = pending
            .recovery_dir
            .as_ref()
            .filter(|path| path.exists())
            .map(|path| managed_manifest_partial(path).map_err(rollback_error))
            .transpose()?
            .unwrap_or_default();
        if !remaining.is_empty()
            && manifest_revision(&recovery).map_err(rollback_error)? == pending.target_revision
            && manifest_is_subset(&remaining, &recovery)
        {
            return Ok(Some(OwnedPartialKind::RollbackCopyPartial));
        }
    }
    Ok(None)
}

fn rollback_error(error: DataOperationFailure) -> DataOperationFailure {
    failure(DataOperationFailureCode::RollbackFailed, error.message)
}

fn write_pointer(
    pointer_path: &Path,
    target: &Path,
    default_dir: &Path,
) -> Result<(), DataOperationFailure> {
    if same_path(target, default_dir) {
        if pointer_path.exists() {
            fs::remove_file(pointer_path).map_err(pointer_error)?;
            sync_parent(pointer_path).map_err(pointer_error)?;
        }
        return Ok(());
    }
    atomic_write_file(
        pointer_path,
        target.to_string_lossy().as_bytes(),
        DataOperationFailureCode::PointerCommitFailed,
    )
}

fn restore_pointer(
    pointer_path: &Path,
    old_pointer: Option<&[u8]>,
) -> Result<(), DataOperationFailure> {
    match old_pointer {
        Some(bytes) => atomic_write_file(
            pointer_path,
            bytes,
            DataOperationFailureCode::RollbackFailed,
        ),
        None => {
            if pointer_path.exists() {
                fs::remove_file(pointer_path).map_err(|error| {
                    failure(
                        DataOperationFailureCode::RollbackFailed,
                        format!("恢复默认目录指针失败：{error}"),
                    )
                })?;
                sync_parent(pointer_path).map_err(|error| {
                    failure(
                        DataOperationFailureCode::RollbackFailed,
                        format!("同步默认目录指针删除失败：{error}"),
                    )
                })?;
            }
            Ok(())
        }
    }
}

fn pointer_error(error: std::io::Error) -> DataOperationFailure {
    failure(
        DataOperationFailureCode::PointerCommitFailed,
        format!("提交数据目录指针失败：{error}"),
    )
}

pub fn read_data_snapshot(path: &Path) -> Result<DataFileSnapshot, DataOperationFailure> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DataFileSnapshot {
                content: None,
                revision: MISSING_REVISION.into(),
                size: 0,
                modified_at_ms: None,
            });
        }
        Err(error) => {
            return Err(DataOperationFailure {
                code: DataOperationFailureCode::ReadFailed,
                message: format!("读取数据指纹失败：{error}"),
            });
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(failure(
            DataOperationFailureCode::ReadFailed,
            "数据路径不是普通文件",
        ));
    }
    let bytes = read_regular_file(path, MAX_DATA_FILE_BYTES)?;
    let content = String::from_utf8(bytes.clone()).map_err(|_| DataOperationFailure {
        code: DataOperationFailureCode::ReadFailed,
        message: "数据文件不是有效 UTF-8".into(),
    })?;
    Ok(DataFileSnapshot {
        content: Some(content),
        revision: revision_for(&bytes),
        size: metadata.len(),
        modified_at_ms: metadata.modified().ok().and_then(system_time_ms),
    })
}

pub fn write_if_current(
    path: &Path,
    content: &str,
    expected_revision: &str,
) -> Result<DataFileSnapshot, DataOperationFailure> {
    if content.len() as u64 > MAX_DATA_FILE_BYTES {
        return Err(failure(
            DataOperationFailureCode::WriteFailed,
            "数据文件超过写入上限",
        ));
    }
    let current = read_data_snapshot(path)?;
    if current.revision != expected_revision {
        return Err(DataOperationFailure {
            code: DataOperationFailureCode::ExternalConflict,
            message: "数据文件已被外部修改；已停止覆盖".into(),
        });
    }
    let parent = path.parent().ok_or_else(|| DataOperationFailure {
        code: DataOperationFailureCode::WriteFailed,
        message: "数据文件路径没有父目录".into(),
    })?;
    fs::create_dir_all(parent).map_err(|error| DataOperationFailure {
        code: DataOperationFailureCode::WriteFailed,
        message: format!("创建数据目录失败：{error}"),
    })?;
    let tmp = next_temp_path(parent, DATA_FILE);
    let new_revision = revision_for(content.as_bytes());
    let attempt = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW);
        let mut file = options.open(&tmp).map_err(write_error)?;
        file.write_all(content.as_bytes()).map_err(write_error)?;
        file.sync_all().map_err(write_error)?;
        // 写临时文件期间外部 writer 仍可能抢先，提交前必须再核一次。
        if read_data_snapshot(path)?.revision != expected_revision {
            return Err(DataOperationFailure {
                code: DataOperationFailureCode::ExternalConflict,
                message: "数据文件在提交前发生外部变化；已停止覆盖".into(),
            });
        }
        commit_if_revision(path, &tmp, expected_revision, &new_revision)?;
        let snapshot = read_data_snapshot(path)?;
        if snapshot.revision != new_revision {
            return Err(failure(
                DataOperationFailureCode::ExternalConflict,
                "数据提交后被外部 writer 改写；已保留外部版本",
            ));
        }
        Ok(snapshot)
    })();
    if attempt.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    attempt
}

#[cfg(target_os = "macos")]
fn rename_with_flags(from: &Path, to: &Path, flags: libc::c_uint) -> std::io::Result<()> {
    let from = CString::new(from.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "路径含 NUL"))?;
    let to = CString::new(to.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "路径含 NUL"))?;
    // SAFETY: CString 保证 NUL 结尾且调用期间地址有效；flags 来自 libc 常量。
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), flags) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn commit_if_revision(
    path: &Path,
    temp: &Path,
    expected_revision: &str,
    new_revision: &str,
) -> Result<(), DataOperationFailure> {
    if expected_revision == MISSING_REVISION {
        rename_with_flags(temp, path, libc::RENAME_EXCL).map_err(|error| {
            let code = if error.raw_os_error() == Some(libc::EEXIST) {
                DataOperationFailureCode::ExternalConflict
            } else {
                DataOperationFailureCode::WriteFailed
            };
            failure(code, format!("原子创建数据文件失败：{error}"))
        })?;
        sync_parent(path).map_err(write_error)?;
        return Ok(());
    }

    rename_with_flags(temp, path, libc::RENAME_SWAP).map_err(write_error)?;
    let displaced = read_data_snapshot(temp);
    if displaced.as_ref().map(|value| value.revision.as_str()) != Ok(expected_revision) {
        // 第一次交换带出的并非预期基线：再交换一次恢复可见版本。若两次交换
        // 之间又出现 writer，其版本会落入 temp，必须隔离保存，绝不删除。
        if let Err(error) = rename_with_flags(temp, path, libc::RENAME_SWAP) {
            let _ = preserve_cas_conflict(temp, path);
            return Err(failure(
                DataOperationFailureCode::ExternalConflict,
                format!("恢复抢先版本失败，已隔离交换版本：{error}"),
            ));
        }
        match read_data_snapshot(temp) {
            Ok(snapshot) if snapshot.revision == new_revision => {
                let _ = fs::remove_file(temp);
            }
            _ => {
                preserve_cas_conflict(temp, path)?;
            }
        }
        let _ = sync_parent(path);
        return Err(failure(
            DataOperationFailureCode::ExternalConflict,
            "原子交换发现外部 writer 已抢先；已恢复或保留其版本",
        ));
    }
    if !read_data_snapshot(path).is_ok_and(|snapshot| snapshot.revision == new_revision) {
        // path 已被新的外部 writer 替换；temp 中保存着交换前版本，不能覆盖用户新值。
        return Err(failure(
            DataOperationFailureCode::ExternalConflict,
            "原子交换后出现外部 writer；已保留其版本",
        ));
    }
    let _ = fs::remove_file(temp);
    sync_parent(path).map_err(write_error)
}

#[cfg(target_os = "macos")]
fn preserve_cas_conflict(temp: &Path, target: &Path) -> Result<(), DataOperationFailure> {
    if !temp.exists() {
        return Ok(());
    }
    let parent = target.parent().ok_or_else(|| {
        failure(
            DataOperationFailureCode::WriteFailed,
            "CAS 冲突文件没有父目录",
        )
    })?;
    let quarantine = next_temp_path(parent, "toskr-cas-conflict");
    fs::rename(temp, &quarantine).map_err(|error| {
        failure(
            DataOperationFailureCode::WriteFailed,
            format!("隔离 CAS 冲突版本失败：{error}"),
        )
    })?;
    sync_parent(&quarantine).map_err(write_error)
}

#[cfg(not(target_os = "macos"))]
fn commit_if_revision(
    path: &Path,
    temp: &Path,
    expected_revision: &str,
    _new_revision: &str,
) -> Result<(), DataOperationFailure> {
    if read_data_snapshot(path)?.revision != expected_revision {
        return Err(failure(
            DataOperationFailureCode::ExternalConflict,
            "提交前数据 revision 已变化",
        ));
    }
    fs::rename(temp, path).map_err(write_error)?;
    sync_parent(path).map_err(write_error)
}

fn write_error(error: std::io::Error) -> DataOperationFailure {
    DataOperationFailure {
        code: DataOperationFailureCode::WriteFailed,
        message: format!("写入数据失败：{error}"),
    }
}

fn revision_for(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2 + 16);
    hex.push_str("sha256:");
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex.push(':');
    hex.push_str(&bytes.len().to_string());
    hex
}

fn system_time_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

pub fn inspect_location(path: &Path, active: Option<&Path>) -> DataLocationInspection {
    let same_as_active = active.is_some_and(|current| same_path(current, path));
    let external_sync_likely = is_external_sync_path(path);
    let missing = !path.exists();
    if missing {
        return DataLocationInspection {
            path: path.to_string_lossy().into_owned(),
            kind: DataLocationKind::Missing,
            revision: Some(MISSING_REVISION.into()),
            readable: false,
            writable: path.parent().is_some_and(can_write_directory),
            same_as_active,
            external_sync_likely,
            store_version: None,
            note_count: 0,
            task_count: 0,
            media_count: 0,
            ordinary_file_count: 0,
        };
    }

    let readable = path.is_dir() && fs::read_dir(path).is_ok();
    let writable = path.is_dir() && can_write_directory(path);
    if !readable {
        return DataLocationInspection {
            path: path.to_string_lossy().into_owned(),
            kind: DataLocationKind::NonToskr,
            revision: None,
            readable,
            writable,
            same_as_active,
            external_sync_likely,
            store_version: None,
            note_count: 0,
            task_count: 0,
            media_count: 0,
            ordinary_file_count: usize::from(path.exists()),
        };
    }

    let entries = fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    let ordinary_file_count = entries
        .iter()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name != DATA_FILE
                && name != MEDIA_DIR
                && !name.starts_with(".toskr-")
                && !matches!(
                    name.as_ref(),
                    "toskr-datadir.txt"
                        | "toskr-data-meta.json"
                        | "toskr-diag.log"
                        | "toskr-media-gc.json"
                )
        })
        .count();
    let data_path = path.join(DATA_FILE);
    let media_count = count_media_files(&path.join(MEDIA_DIR));
    let data_metadata = fs::symlink_metadata(&data_path).ok();
    if data_metadata
        .as_ref()
        .is_none_or(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
    {
        let kind = if data_metadata.is_some() {
            DataLocationKind::Corrupt
        } else if ordinary_file_count == 0 && media_count == 0 {
            DataLocationKind::Empty
        } else {
            DataLocationKind::NonToskr
        };
        return DataLocationInspection {
            path: path.to_string_lossy().into_owned(),
            kind,
            revision: (kind == DataLocationKind::Empty).then(empty_managed_revision),
            readable,
            writable,
            same_as_active,
            external_sync_likely,
            store_version: None,
            note_count: 0,
            task_count: 0,
            media_count,
            ordinary_file_count,
        };
    }

    let parsed = read_regular_file(&data_path, MAX_DATA_FILE_BYTES)
        .ok()
        .and_then(|raw| String::from_utf8(raw).ok())
        .and_then(|raw| parse_store_document(&raw));
    let (mut kind, store_version, note_count, task_count) = match parsed {
        Some(StoreSummary {
            version,
            note_count,
            task_count,
        }) if version <= MAX_STORE_VERSION => (
            DataLocationKind::Valid,
            Some(version),
            note_count,
            task_count,
        ),
        Some(summary) => (
            DataLocationKind::Unsupported,
            Some(summary.version),
            summary.note_count,
            summary.task_count,
        ),
        None => (DataLocationKind::Corrupt, None, 0, 0),
    };

    let revision = match kind {
        DataLocationKind::Valid => match managed_revision(path) {
            Ok(revision) => Some(revision),
            Err(_) => {
                kind = DataLocationKind::Corrupt;
                None
            }
        },
        _ => None,
    };

    DataLocationInspection {
        path: path.to_string_lossy().into_owned(),
        kind,
        revision,
        readable,
        writable,
        same_as_active,
        external_sync_likely,
        store_version,
        note_count,
        task_count,
        media_count,
        ordinary_file_count,
    }
}

#[derive(Debug)]
struct StoreSummary {
    version: u64,
    note_count: usize,
    task_count: usize,
}

fn parse_store_document(raw: &str) -> Option<StoreSummary> {
    let bag: serde_json::Value = serde_json::from_str(raw).ok()?;
    let persisted = bag.get("toskr")?.as_str()?;
    let root: serde_json::Value = serde_json::from_str(persisted).ok()?;
    let version = root.get("version").and_then(serde_json::Value::as_u64)?;
    let state = root.get("state")?.as_object()?;
    let allow_legacy_duplicates = version < 9;
    let sections = validate_record_array(
        state.get("sections"),
        validate_section,
        allow_legacy_duplicates,
    )?;
    let notes = validate_record_array(state.get("notes"), validate_note, allow_legacy_duplicates)?;
    let task_sections = validate_record_array(
        state.get("taskSections"),
        validate_section,
        allow_legacy_duplicates,
    )?;
    let tasks = validate_record_array(
        state.get("tasks"),
        |task| validate_task(task, allow_legacy_duplicates),
        allow_legacy_duplicates,
    )?;
    if !validate_settings_value_for_version(state.get("settings"), version) {
        return None;
    }
    let _ = (sections, task_sections);
    Some(StoreSummary {
        version,
        note_count: notes,
        task_count: tasks,
    })
}

fn validate_record_array(
    value: Option<&serde_json::Value>,
    validate: impl Fn(&serde_json::Map<String, serde_json::Value>) -> bool,
    allow_duplicates: bool,
) -> Option<usize> {
    let Some(value) = value else {
        return Some(0);
    };
    let records = value.as_array()?;
    let mut ids = BTreeSet::new();
    records.iter().try_for_each(|record| {
        let object = record.as_object()?;
        let id = object
            .get("id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())?;
        if !allow_duplicates && !ids.insert(id) {
            return None;
        }
        validate(object).then_some(())
    })?;
    Some(records.len())
}

fn optional_type(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    validate: impl FnOnce(&serde_json::Value) -> bool,
) -> bool {
    object.get(key).is_none_or(validate)
}

pub(crate) fn validate_settings_value(value: Option<&serde_json::Value>) -> bool {
    validate_settings_value_for_version(value, 0)
}

pub(crate) fn validate_settings_value_for_version(
    value: Option<&serde_json::Value>,
    store_version: u64,
) -> bool {
    let Some(value) = value else {
        return true;
    };
    let Some(settings) = value.as_object() else {
        return false;
    };
    let finite = |value: &serde_json::Value| value.as_f64().is_some_and(f64::is_finite);
    for key in [
        "vibrancy",
        "cardTint",
        "autoCheckUpdate",
        "autoInstallUpdate",
        "clipHistory",
        "clipIgnoreConcealed",
        "clipIgnoreTransient",
        "autoEnter",
        "hideOnBlur",
        "autoEdgeHide",
        "doubleTapCaptureOnly",
        "stealth",
        "soundEnabled",
        "companionEnabled",
        "rightSidebar",
        "panelTopmost",
        "aiEnabled",
        "firewallEnabled",
        "outcomeMetricsEnabled",
    ] {
        if !optional_type(settings, key, serde_json::Value::is_boolean) {
            return false;
        }
    }
    for key in [
        "panelOpacity",
        "windowOpacity",
        "cardOpacity",
        "hotkeyGapMs",
        "companionGap",
        "panelWidth",
        "panelTopOffset",
    ] {
        if !optional_type(settings, key, finite) {
            return false;
        }
    }
    for key in ["aiBaseUrl", "aiApiKey", "aiModel", "dataDir"] {
        if !optional_type(settings, key, serde_json::Value::is_string) {
            return false;
        }
    }
    for key in [
        "clipPauseUntil",
        "panelFreeX",
        "panelFreeY",
        "panelHeight",
    ] {
        if !optional_type(settings, key, |value| value.is_null() || finite(value)) {
            return false;
        }
    }
    if !optional_type(settings, "clipRetentionDays", |value| {
        value.is_null() || valid_nonnegative_number(value)
    }) || !optional_type(settings, "panelToggleHotkey", |value| {
        value.is_null() || value.is_string()
    }) || !optional_type(settings, "outcomeRetentionDays", |value| {
        matches!(value.as_u64(), Some(7 | 30 | 90))
    }) {
        return false;
    }
    if !optional_type(settings, "outcomeMetricsEpoch", |value| {
        value.as_u64().is_some_and(|epoch| epoch <= 9_007_199_254_740_991)
    }) {
        return false;
    }
    for (key, allowed) in [
        ("theme", &["system", "light", "dark"][..]),
        (
            "vibrancyMaterial",
            &["hud", "popover", "sidebar", "under-window", "fullscreen"][..],
        ),
        ("cardDensity", &["comfortable", "compact"][..]),
        ("hotkeyModifier", &["shift", "control", "option"][..]),
        ("sidebarEdge", &["right", "left", "top", "bottom"][..]),
    ] {
        if !optional_type(settings, key, |value| {
            value.as_str().is_some_and(|value| allowed.contains(&value))
        }) {
            return false;
        }
    }
    for key in ["clipExcludedApps", "companionApps", "excludedApps"] {
        if !optional_type(settings, key, |value| {
            value
                .as_array()
                .is_some_and(|items| items.iter().all(serde_json::Value::is_string))
        }) {
            return false;
        }
    }
    if !optional_type(settings, "firewallDisabledWarnCategories", |value| {
        value.as_array().is_some_and(|items| {
            items.iter().all(|item| {
                matches!(
                    item.as_str(),
                    Some("email" | "phone" | "nationalId" | "bankCard" | "ipAddress")
                )
            })
        })
    }) {
        return false;
    }
    if !optional_type(settings, "outcomeBaselines", |value| {
        value.as_array().is_some_and(|items| {
            items.len() <= 64 && items.iter().all(|item| {
                item.as_object().is_some_and(|item| {
                    let scope = item.get("scope").and_then(serde_json::Value::as_str);
                    let scope_id = item.get("scopeId").and_then(serde_json::Value::as_str);
                    let minutes = item.get("minutes").and_then(serde_json::Value::as_f64);
                    let scope_valid = match scope {
                        Some("profile") => true,
                        Some("recipe") => matches!(
                            scope_id,
                            Some(
                                "summarize"
                                    | "extract-actions"
                                    | "improve-prompt"
                                    | "structure-requirements"
                            )
                        ),
                        _ => false,
                    };
                    scope_valid
                        && scope_id.is_some_and(|id| !id.is_empty() && id.len() <= 160)
                        && minutes.is_some_and(|number| {
                            number.is_finite() && number > 0.0 && number <= 10_080.0
                        })
                })
            })
        })
    }) || !optional_type(settings, "outcomeQualityFeedback", |value| {
        value.as_array().is_some_and(|items| {
            items.len() <= 500 && items.iter().all(|item| {
                item.as_object().is_some_and(|item| {
                    let delivery_id = item.get("deliveryId").and_then(serde_json::Value::as_str);
                    delivery_id.is_some_and(|id| !id.is_empty() && id.len() <= 160) && item
                        .get("resultNoteId")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|id| !id.is_empty() && id.len() <= 160)
                        && matches!(
                            item.get("quality").and_then(serde_json::Value::as_str),
                            Some("directUse" | "minorEdit" | "majorEdit" | "discarded")
                        )
                        && item.get("updatedAtMs").is_some_and(valid_nonnegative_number)
                })
            })
        })
    }) || !optional_type(settings, "outcomeProblemSessions", |value| {
        value.as_array().is_some_and(|items| {
            items.len() <= 100 && items.iter().all(|item| {
                item.as_object().is_some_and(|item| {
                    let id = item.get("id").and_then(serde_json::Value::as_str);
                    let started = item.get("startedAtMs").and_then(serde_json::Value::as_f64);
                    let delivery = item.get("deliveryId");
                    let result_note = item.get("resultNoteId");
                    let linked = item.get("linkedAtMs");
                    let solved = item.get("solvedAtMs");
                    let cancelled = item.get("cancelledAtMs");
                    let nullable_after_start = |candidate: Option<&serde_json::Value>| {
                        candidate.is_some_and(|candidate| {
                            candidate.is_null()
                                || candidate.as_f64().is_some_and(|time| {
                                    time.is_finite()
                                        && started.is_some_and(|start| time >= start)
                                })
                        })
                    };
                    id.is_some_and(|id| !id.is_empty() && id.len() <= 160)
                        && started.is_some_and(|time| time.is_finite() && time >= 0.0)
                        && delivery.is_some_and(|value| {
                            value.is_null()
                                || value.as_str().is_some_and(|id| !id.is_empty() && id.len() <= 160)
                        })
                        && result_note.is_none_or(|value| {
                            value.is_null()
                                || value.as_str().is_some_and(|id| !id.is_empty() && id.len() <= 160)
                        })
                        && nullable_after_start(linked)
                        && nullable_after_start(solved)
                        && nullable_after_start(cancelled)
                        && !(solved.is_some_and(|value| !value.is_null())
                            && cancelled.is_some_and(|value| !value.is_null()))
                        && (delivery.is_some_and(serde_json::Value::is_null)
                            == linked.is_some_and(serde_json::Value::is_null))
                        && !(delivery.is_some_and(serde_json::Value::is_null)
                            && result_note.is_some_and(|value| !value.is_null()))
                })
            })
        })
    }) {
        return false;
    }
    if !optional_type(settings, "pageOrder", |value| {
        value.as_array().is_some_and(|items| {
            items
                .iter()
                .all(|item| matches!(item.as_str(), Some("clipboard" | "notes" | "tasks")))
        })
    }) || !optional_type(settings, "promptSnippets", |value| {
        let mut ids = BTreeSet::new();
        value.as_array().is_some_and(|items| {
            items.iter().all(|item| {
                item.as_object().is_some_and(|item| {
                    let fields_valid = ["id", "label", "text"]
                        .iter()
                        .all(|key| item.get(*key).is_some_and(serde_json::Value::is_string));
                    let id = item.get("id").and_then(serde_json::Value::as_str);
                    fields_valid
                        && (store_version < 9
                            || item
                                .get("groupId")
                                .is_some_and(serde_json::Value::is_string))
                        && (store_version < 9
                            || id.is_some_and(|id| !id.is_empty() && ids.insert(id)))
                })
            })
        })
    }) || !optional_type(settings, "promptGroups", |value| {
        let mut ids = BTreeSet::new();
        value.as_array().is_some_and(|items| {
            items.iter().all(|item| {
                item.as_object().is_some_and(|item| {
                    let id = item.get("id").and_then(serde_json::Value::as_str);
                    id.is_some_and(|id| !id.is_empty())
                        && item.get("name").is_some_and(serde_json::Value::is_string)
                        && item.get("order").is_some_and(finite)
                        && (store_version < 9
                            || id.is_some_and(|id| ids.insert(id)))
                })
            })
        })
    }) || !optional_type(settings, "targetProfiles", |value| {
        let mut ids = BTreeSet::new();
        value.as_array().is_some_and(|items| {
            items.iter().all(|item| {
                item.as_object().is_some_and(|item| {
                    let id = item.get("id").and_then(serde_json::Value::as_str);
                    id.is_some_and(|id| !id.is_empty())
                        && item.get("name").is_some_and(serde_json::Value::is_string)
                        && item
                            .get("bundleIds")
                            .and_then(serde_json::Value::as_array)
                            .is_some_and(|bundles| bundles.iter().all(serde_json::Value::is_string))
                        && item
                            .get("promptGroupId")
                            .is_some_and(serde_json::Value::is_string)
                        && matches!(
                            item.get("defaultFormat")
                                .and_then(serde_json::Value::as_str),
                            Some("plain" | "code")
                        )
                        && matches!(
                            item.get("enterPolicy").and_then(serde_json::Value::as_str),
                            Some("never" | "confirm" | "allow")
                        )
                        && matches!(
                            item.get("privacyPolicy")
                                .and_then(serde_json::Value::as_str),
                            Some("requireRedaction" | "confirmRaw" | "allowRaw")
                        )
                        && item
                            .get("keepPanel")
                            .is_some_and(serde_json::Value::is_boolean)
                        && (store_version < 9
                            || id.is_some_and(|id| ids.insert(id)))
                })
            })
        })
    }) || !optional_type(
        settings,
        "defaultTargetProfileId",
        serde_json::Value::is_string,
    ) || !optional_type(settings, "contextMenu", |value| {
        value.as_array().is_some_and(|items| {
            items.iter().all(|item| {
                item.as_object().is_some_and(|item| {
                    item.get("id").is_some_and(serde_json::Value::is_string)
                        && item.get("on").is_some_and(serde_json::Value::is_boolean)
                })
            })
        })
    }) {
        return false;
    }
    if !optional_type(settings, "onboarding", |value| {
        value.as_object().is_some_and(|onboarding| {
            ["captured", "sent", "done", "rehearsalActive"]
                .iter()
                .all(|key| optional_type(onboarding, key, serde_json::Value::is_boolean))
                && optional_type(onboarding, "onboardingVersion", |value| {
                    value.as_u64() == Some(2)
                })
                && optional_type(onboarding, "rehearsalStep", |value| {
                    matches!(
                        value.as_str(),
                        Some(
                            "permissions"
                                | "capture"
                                | "target"
                                | "firewall"
                                | "delivery"
                                | "complete"
                        )
                    )
                })
                && optional_type(onboarding, "rehearsalNoteId", |value| {
                    value.is_null() || value.is_string()
                })
                && [
                    "rehearsalStartedAtMs",
                    "rehearsalPausedAtMs",
                    "rehearsalCompletedAtMs",
                    "rehearsalDeferredAtMs",
                    "activationStartedAtMs",
                ]
                .iter()
                .all(|key| optional_type(onboarding, key, valid_nullable_time))
                && optional_type(onboarding, "activationWithin60s", |value| {
                    value.is_null() || value.is_boolean()
                })
        })
    }) || !optional_type(settings, "duePresets", |value| {
        value.as_array().is_some_and(|items| {
            items.iter().all(|item| {
                let Some(item) = item.as_object() else {
                    return false;
                };
                if !item.get("id").is_some_and(serde_json::Value::is_string) {
                    return false;
                }
                match item.get("kind").and_then(serde_json::Value::as_str) {
                    Some("relative") => item.get("minutes").is_some_and(finite),
                    Some("today" | "tomorrow") => {
                        item.get("hour").is_some_and(finite)
                            && item.get("minute").is_some_and(finite)
                    }
                    Some("weekday") => {
                        item.get("weekday").is_some_and(finite)
                            && item.get("hour").is_some_and(finite)
                            && item.get("minute").is_some_and(finite)
                    }
                    _ => false,
                }
            })
        })
    }) {
        return false;
    }
    true
}

fn validate_section(object: &serde_json::Map<String, serde_json::Value>) -> bool {
    optional_type(object, "name", serde_json::Value::is_string)
        && optional_type(object, "collapsed", serde_json::Value::is_boolean)
}

fn valid_nonnegative_number(value: &serde_json::Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number >= 0.0)
}

fn valid_nullable_time(value: &serde_json::Value) -> bool {
    value.is_null() || valid_nonnegative_number(value)
}

pub(crate) fn validate_note_provenance(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|provenance| {
        provenance.get("kind").and_then(serde_json::Value::as_str)
            == Some("deliveryResult")
            && provenance
                .get("deliveryId")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.is_empty())
            && provenance
                .get("capturedAtMs")
                .is_some_and(valid_nonnegative_number)
            && provenance
                .get("sourceBundle")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.is_empty())
            && provenance
                .get("sourceItemIds")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|ids| {
                    !ids.is_empty()
                        && ids.iter().all(|id| {
                            id.as_str().is_some_and(|value| !value.is_empty())
                        })
                })
    })
}

fn validate_note(object: &serde_json::Map<String, serde_json::Value>) -> bool {
    optional_type(object, "text", serde_json::Value::is_string)
        && optional_type(object, "sectionId", serde_json::Value::is_string)
        && optional_type(object, "done", serde_json::Value::is_boolean)
        && optional_type(object, "createdAt", valid_nonnegative_number)
        && optional_type(object, "kind", |value| {
            matches!(value.as_str(), Some("text" | "image" | "link"))
        })
        && optional_type(object, "attachments", |value| {
            value
                .as_array()
                .is_some_and(|items| items.iter().all(serde_json::Value::is_string))
        })
        && optional_type(object, "provenance", validate_note_provenance)
}

fn validate_task(
    object: &serde_json::Map<String, serde_json::Value>,
    allow_duplicates: bool,
) -> bool {
    optional_type(object, "text", serde_json::Value::is_string)
        && optional_type(object, "status", |value| {
            matches!(value.as_str(), Some("todo" | "doing" | "done"))
        })
        && optional_type(object, "priority", |value| {
            matches!(value.as_str(), Some("none" | "low" | "mid" | "high"))
        })
        && optional_type(object, "dueAt", valid_nullable_time)
        && optional_type(object, "remindedAt", valid_nullable_time)
        && optional_type(object, "createdAt", valid_nonnegative_number)
        && optional_type(object, "kind", |value| value.as_str() == Some("spark"))
        && optional_type(object, "checklist", |value| {
            value.as_array().is_some_and(|items| {
                let mut ids = BTreeSet::new();
                items.iter().all(|item| {
                    item.as_object().is_some_and(|item| {
                        let Some(id) = item
                            .get("id")
                            .and_then(serde_json::Value::as_str)
                            .filter(|id| !id.is_empty())
                        else {
                            return false;
                        };
                        (allow_duplicates || ids.insert(id))
                            && optional_type(item, "text", serde_json::Value::is_string)
                            && optional_type(item, "done", serde_json::Value::is_boolean)
                    })
                })
            })
        })
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => normalize_path(left) == normalize_path(right),
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn is_external_sync_path(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    [
        "mobile documents",
        "icloud",
        "dropbox",
        "onedrive",
        "google drive",
        "box sync",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn can_write_directory(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let probe = path.join(format!(".toskr-write-probe-{}-{stamp}", std::process::id()));
    match OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(file) => {
            drop(file);
            fs::remove_file(probe).is_ok()
        }
        Err(_) => false,
    }
}

fn count_media_files(media_dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(media_dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    use tempfile::tempdir;

    #[test]
    fn inspection_distinguishes_empty_and_non_toskr_directories() {
        let root = tempdir().unwrap();
        let empty = root.path().join("empty");
        let ordinary = root.path().join("ordinary");
        fs::create_dir_all(&empty).unwrap();
        fs::create_dir_all(&ordinary).unwrap();
        fs::write(ordinary.join("keep-me.txt"), b"user file").unwrap();

        assert_eq!(inspect_location(&empty, None).kind, DataLocationKind::Empty);
        let inspected = inspect_location(&ordinary, None);
        assert_eq!(inspected.kind, DataLocationKind::NonToskr);
        assert_eq!(inspected.ordinary_file_count, 1);
    }

    #[test]
    fn inspection_reports_missing_and_non_writable_targets() {
        let root = tempdir().unwrap();
        let missing = root.path().join("not-created");
        let missing_report = inspect_location(&missing, None);
        assert_eq!(missing_report.kind, DataLocationKind::Missing);
        assert!(missing_report.writable);

        #[cfg(unix)]
        {
            let read_only = root.path().join("read-only");
            fs::create_dir_all(&read_only).unwrap();
            let original = fs::metadata(&read_only).unwrap().permissions();
            fs::set_permissions(&read_only, fs::Permissions::from_mode(0o500)).unwrap();
            assert!(!inspect_location(&read_only, None).writable);
            fs::set_permissions(&read_only, original).unwrap();
        }
    }

    #[test]
    fn inspection_rejects_present_wrong_type_records_and_settings() {
        for (name, state_patch) in [
            ("wrong-notes", serde_json::json!({"notes": "corrupt"})),
            (
                "wrong-settings",
                serde_json::json!({"settings": {"promptSnippets": "corrupt"}}),
            ),
            (
                "invalid-firewall-category",
                serde_json::json!({"settings": {
                    "firewallEnabled": true,
                    "firewallDisabledWarnCategories": ["apiKey"]
                }}),
            ),
            (
                "v9-snippet-without-group",
                serde_json::json!({"settings": {"promptSnippets": [
                    {"id": "snippet", "label": "Snippet", "text": "text"}
                ]}}),
            ),
            (
                "invalid-profile-policy",
                serde_json::json!({"settings": {"targetProfiles": [{
                    "id": "profile", "name": "Profile", "bundleIds": [],
                    "promptGroupId": "general", "defaultFormat": "plain",
                    "enterPolicy": "always", "privacyPolicy": "allowRaw",
                    "keepPanel": false
                }]}}),
            ),
            (
                "duplicate-profile-id",
                serde_json::json!({"settings": {"targetProfiles": [
                    {
                        "id": "same", "name": "First", "bundleIds": [],
                        "promptGroupId": "general", "defaultFormat": "plain",
                        "enterPolicy": "never", "privacyPolicy": "requireRedaction",
                        "keepPanel": false
                    },
                    {
                        "id": "same", "name": "Second", "bundleIds": [],
                        "promptGroupId": "general", "defaultFormat": "plain",
                        "enterPolicy": "never", "privacyPolicy": "requireRedaction",
                        "keepPanel": false
                    }
                ]}}),
            ),
            (
                "duplicate-notes",
                serde_json::json!({"notes": [
                    {"id": "same", "text": "first"},
                    {"id": "same", "text": "second"}
                ]}),
            ),
            (
                "duplicate-checklist",
                serde_json::json!({"tasks": [{
                    "id": "task",
                    "text": "task",
                    "checklist": [
                        {"id": "same", "text": "first"},
                        {"id": "same", "text": "second"}
                    ]
                }]}),
            ),
        ] {
            let root = tempdir().unwrap();
            let dir = root.path().join(name);
            fs::create_dir_all(dir.join(MEDIA_DIR)).unwrap();
            let mut state = serde_json::json!({
                "sections": [], "notes": [], "tasks": [], "taskSections": [], "settings": {}
            });
            for (key, value) in state_patch.as_object().unwrap() {
                state[key] = value.clone();
            }
            let persisted = serde_json::json!({"version": MAX_STORE_VERSION, "state": state});
            fs::write(
                dir.join(DATA_FILE),
                serde_json::json!({"toskr": persisted.to_string()}).to_string(),
            )
            .unwrap();

            assert_eq!(inspect_location(&dir, None).kind, DataLocationKind::Corrupt);
        }
    }

    #[test]
    fn current_store_accepts_only_disableable_firewall_warn_categories() {
        let settings = serde_json::json!({
            "firewallEnabled": true,
            "firewallDisabledWarnCategories": [
                "email", "phone", "nationalId", "bankCard", "ipAddress"
            ]
        });
        assert!(validate_settings_value_for_version(
            Some(&settings),
            MAX_STORE_VERSION
        ));
    }

    #[test]
    fn current_store_validates_resumable_onboarding_state() {
        let valid = serde_json::json!({
            "onboarding": {
                "captured": true,
                "sent": false,
                "done": false,
                "onboardingVersion": 2,
                "rehearsalStep": "firewall",
                "rehearsalActive": true,
                "rehearsalNoteId": "note-1",
                "rehearsalStartedAtMs": 10,
                "rehearsalPausedAtMs": null,
                "rehearsalCompletedAtMs": null,
                "rehearsalDeferredAtMs": null,
                "activationStartedAtMs": 20,
                "activationWithin60s": null
            }
        });
        assert_eq!(MAX_STORE_VERSION, 14);
        assert!(validate_settings_value_for_version(
            Some(&valid),
            MAX_STORE_VERSION
        ));

        for invalid in [
            serde_json::json!({"onboarding": {
                "onboardingVersion": 3, "rehearsalStep": "capture"
            }}),
            serde_json::json!({"onboarding": {
                "onboardingVersion": 2, "rehearsalStep": "unknown"
            }}),
            serde_json::json!({"onboarding": {
                "onboardingVersion": 2, "rehearsalStartedAtMs": -1
            }}),
        ] {
            assert!(!validate_settings_value_for_version(
                Some(&invalid),
                MAX_STORE_VERSION
            ));
        }
    }

    #[test]
    fn current_store_validates_bounded_outcome_settings() {
        let valid = serde_json::json!({
            "outcomeMetricsEnabled": false,
            "outcomeRetentionDays": 90,
            "outcomeMetricsEpoch": 1,
            "outcomeBaselines": [
                {"scope": "profile", "scopeId": "safe", "minutes": 20},
                {"scope": "recipe", "scopeId": "summarize", "minutes": 8}
            ],
            "outcomeQualityFeedback": [{
                "deliveryId": "delivery-1", "resultNoteId": "result-1",
                "quality": "minorEdit", "updatedAtMs": 100
            }],
            "outcomeProblemSessions": [{
                "id": "session-1", "startedAtMs": 10,
                "deliveryId": "delivery-1", "linkedAtMs": 20,
                "resultNoteId": "result-1",
                "solvedAtMs": 30, "cancelledAtMs": null
            }]
        });
        assert!(validate_settings_value_for_version(
            Some(&valid),
            MAX_STORE_VERSION
        ));
        let compatible_duplicates = serde_json::json!({
            "outcomeBaselines": [
                {"scope": "profile", "scopeId": "safe", "minutes": 10},
                {"scope": "profile", "scopeId": "safe", "minutes": 15, "futureField": true}
            ],
            "outcomeProblemSessions": [{
                "id": "legacy-session", "startedAtMs": 10,
                "deliveryId": "delivery-1", "linkedAtMs": 20,
                "solvedAtMs": null, "cancelledAtMs": null
            }]
        });
        assert!(validate_settings_value_for_version(
            Some(&compatible_duplicates),
            MAX_STORE_VERSION
        ));

        for invalid in [
            serde_json::json!({"outcomeRetentionDays": 8}),
            serde_json::json!({"outcomeMetricsEpoch": -1}),
            serde_json::json!({"outcomeBaselines": [
                {"scope": "profile", "scopeId": "safe", "minutes": 0}
            ]}),
            serde_json::json!({"outcomeQualityFeedback": [{
                "deliveryId": "delivery-1", "resultNoteId": "result-1",
                "quality": "unknown", "updatedAtMs": 100
            }]}),
            serde_json::json!({"outcomeProblemSessions": [{
                "id": "session-1", "startedAtMs": 10,
                "deliveryId": null, "linkedAtMs": 20,
                "resultNoteId": null,
                "solvedAtMs": null, "cancelledAtMs": null
            }]}),
            serde_json::json!({"outcomeProblemSessions": [{
                "id": "session-2", "startedAtMs": 10,
                "deliveryId": "delivery-1", "linkedAtMs": null,
                "resultNoteId": null,
                "solvedAtMs": null, "cancelledAtMs": null
            }]})
        ] {
            assert!(!validate_settings_value_for_version(
                Some(&invalid),
                MAX_STORE_VERSION
            ));
        }
    }

    #[test]
    fn current_store_accepts_delivery_result_provenance_and_rejects_invalid_shape() {
        let valid = serde_json::json!({
            "kind": "deliveryResult",
            "deliveryId": "delivery-1",
            "capturedAtMs": 100,
            "sourceBundle": "com.openai.chat",
            "sourceItemIds": ["note-1"]
        });
        assert!(validate_note_provenance(&valid));
        let mut invalid = valid;
        invalid["sourceItemIds"] = serde_json::json!([]);
        assert!(!validate_note_provenance(&invalid));
    }

    #[test]
    fn v8_prompt_snippet_without_group_remains_migratable() {
        let root = tempdir().unwrap();
        let dir = root.path().join("legacy-v8");
        fs::create_dir_all(dir.join(MEDIA_DIR)).unwrap();
        let persisted = serde_json::json!({
            "version": 8,
            "state": {
                "sections": [], "notes": [], "tasks": [], "taskSections": [],
                "settings": {"promptSnippets": [
                    {"id": "legacy", "label": "Legacy", "text": "kept"}
                ]}
            }
        });
        fs::write(
            dir.join(DATA_FILE),
            serde_json::json!({"toskr": persisted.to_string()}).to_string(),
        )
        .unwrap();

        assert_eq!(inspect_location(&dir, None).kind, DataLocationKind::Valid);
    }

    #[test]
    fn operation_ids_reject_path_components_before_any_staging_path_is_built() {
        for invalid in ["", "../escape", "a/b", "a\\b", "white space"] {
            assert_eq!(
                validate_operation_id(invalid).unwrap_err().code,
                DataOperationFailureCode::InvalidPlan
            );
        }
        assert!(validate_operation_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
    }

    #[test]
    fn optimistic_write_preserves_an_external_revision() {
        let root = tempdir().unwrap();
        let data = root.path().join(DATA_FILE);
        fs::write(&data, "A").unwrap();
        let based_on_a = read_data_snapshot(&data).unwrap();
        fs::write(&data, "B from another writer").unwrap();

        let failure =
            write_if_current(&data, "C from stale memory", &based_on_a.revision).unwrap_err();

        assert_eq!(failure.code, DataOperationFailureCode::ExternalConflict);
        assert_eq!(fs::read_to_string(&data).unwrap(), "B from another writer");
    }

    fn write_valid_store(dir: &Path, note: &str) {
        fs::create_dir_all(dir.join(MEDIA_DIR)).unwrap();
        let persisted = serde_json::json!({
            "version": MAX_STORE_VERSION,
            "state": {
                "sections": [{"id": "inbox", "name": "收件箱"}],
                "notes": [{"id": note, "text": note}],
                "taskSections": [{"id": "task-inbox", "name": "收集箱"}],
                "tasks": []
            }
        });
        let bag = serde_json::json!({"toskr": persisted.to_string()});
        fs::write(dir.join(DATA_FILE), bag.to_string()).unwrap();
    }

    fn expected_revision(path: &Path) -> Option<String> {
        inspect_location(path, None).revision
    }

    #[test]
    fn migrate_to_empty_target_can_rollback_without_touching_source() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        fs::write(source.join(MEDIA_DIR).join("image.png"), b"png").unwrap();
        schedule_media_gc(&source, &["image.png".into()], 500).unwrap();
        fs::write(source.join(ACTIVITY_FILE), b"activity-main\n").unwrap();
        fs::write(
            source.join(ACTIVITY_ARCHIVE_FILE),
            b"activity-archive\n",
        )
        .unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "op-migrate".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::MigrateCurrentToTarget,
            replace_confirmed: false,
            expected_target_revision: expected_revision(&target),
        };

        let pending = begin_data_operation(&plan, &pointer, &default_dir).unwrap();
        assert!(target.join(DATA_FILE).is_file());
        assert!(target.join(MEDIA_DIR).join("image.png").is_file());
        assert!(target.join(MEDIA_GC_FILE).is_file());
        assert_eq!(
            fs::read(target.join(ACTIVITY_FILE)).unwrap(),
            b"activity-main\n"
        );
        assert_eq!(
            fs::read(target.join(ACTIVITY_ARCHIVE_FILE)).unwrap(),
            b"activity-archive\n"
        );
        let restored = pending.rollback(&pointer, &default_dir).unwrap();

        assert_eq!(restored, source);
        assert_eq!(
            fs::read_to_string(&pointer).unwrap(),
            source.to_string_lossy()
        );
        assert!(source.join(DATA_FILE).is_file());
        assert_eq!(
            fs::read(source.join(ACTIVITY_FILE)).unwrap(),
            b"activity-main\n"
        );
        assert!(!target.join(ACTIVITY_FILE).exists());
        assert!(source.join(MEDIA_DIR).join("image.png").is_file());
        assert!(source.join(MEDIA_GC_FILE).is_file());
        assert!(!target.join(DATA_FILE).exists());
        assert!(!target.join(MEDIA_DIR).exists());
        assert!(!target.join(MEDIA_GC_FILE).exists());
    }

    #[test]
    fn recovery_load_allows_a_valid_target_when_current_source_is_corrupt() {
        let root = tempdir().unwrap();
        let source = root.path().join("corrupt-source");
        let target = root.path().join("valid-target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(source.join(MEDIA_DIR)).unwrap();
        fs::create_dir_all(&default_dir).unwrap();
        fs::write(source.join(DATA_FILE), b"not-json").unwrap();
        write_valid_store(&target, "recovered-note");
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "recovery-load-valid-target".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::LoadExistingTarget,
            replace_confirmed: false,
            expected_target_revision: expected_revision(&target),
        };

        let pending = begin_data_operation(&plan, &pointer, &default_dir).unwrap();
        assert_eq!(pending.active_dir, target);
        pending.finalize().unwrap();
        assert_eq!(
            fs::read_to_string(&pointer).unwrap(),
            target.to_string_lossy()
        );
        assert_eq!(fs::read(source.join(DATA_FILE)).unwrap(), b"not-json");
    }

    #[test]
    fn inspection_reports_valid_corrupt_unsupported_same_and_sync_paths() {
        let root = tempdir().unwrap();
        let active = root.path().join("active");
        write_valid_store(&active, "n1");
        fs::write(active.join(MEDIA_DIR).join("one.png"), b"one").unwrap();
        let valid = inspect_location(&active, Some(&active));
        assert_eq!(valid.kind, DataLocationKind::Valid);
        assert!(valid.same_as_active);
        assert_eq!((valid.note_count, valid.media_count), (1, 1));

        let corrupt = root.path().join("corrupt");
        fs::create_dir_all(&corrupt).unwrap();
        fs::write(corrupt.join(DATA_FILE), "not-json").unwrap();
        assert_eq!(
            inspect_location(&corrupt, None).kind,
            DataLocationKind::Corrupt
        );

        let unsupported = root.path().join("unsupported");
        write_valid_store(&unsupported, "future");
        let raw = fs::read_to_string(unsupported.join(DATA_FILE)).unwrap();
        let mut bag: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut inner: serde_json::Value =
            serde_json::from_str(bag["toskr"].as_str().unwrap()).unwrap();
        inner["version"] = serde_json::json!(MAX_STORE_VERSION + 1);
        bag["toskr"] = serde_json::Value::String(inner.to_string());
        fs::write(unsupported.join(DATA_FILE), bag.to_string()).unwrap();
        assert_eq!(
            inspect_location(&unsupported, None).kind,
            DataLocationKind::Unsupported
        );

        let sync = root.path().join("iCloud Drive").join("Toskr");
        assert!(inspect_location(&sync, None).external_sync_likely);
    }

    #[test]
    fn replace_requires_confirmation_and_rollback_restores_target_dataset() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        write_valid_store(&target, "target-note");
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let mut plan = DataOperationPlan {
            operation_id: "op-replace".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::ReplaceTargetWithCurrent,
            replace_confirmed: false,
            expected_target_revision: expected_revision(&target),
        };
        assert_eq!(
            begin_data_operation(&plan, &pointer, &default_dir)
                .unwrap_err()
                .code,
            DataOperationFailureCode::ReplaceConfirmationRequired
        );
        plan.replace_confirmed = true;
        let pending = begin_data_operation(&plan, &pointer, &default_dir).unwrap();
        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("source-note"));
        pending.rollback(&pointer, &default_dir).unwrap();
        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("target-note"));
    }

    #[test]
    fn valid_target_load_is_reversible_and_cancel_never_changes_pointer() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        write_valid_store(&target, "target-note");
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();

        let load = DataOperationPlan {
            operation_id: "op-load".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::LoadExistingTarget,
            replace_confirmed: false,
            expected_target_revision: expected_revision(&target),
        };
        let pending = begin_data_operation(&load, &pointer, &default_dir).unwrap();
        assert_eq!(
            fs::read_to_string(&pointer).unwrap(),
            target.to_string_lossy()
        );
        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("target-note"));
        pending.rollback(&pointer, &default_dir).unwrap();
        assert_eq!(
            fs::read_to_string(&pointer).unwrap(),
            source.to_string_lossy()
        );

        let cancel = DataOperationPlan {
            operation_id: "op-cancel".into(),
            action: DataOperationAction::Cancel,
            ..load
        };
        assert_eq!(
            begin_data_operation(&cancel, &pointer, &default_dir)
                .unwrap_err()
                .code,
            DataOperationFailureCode::InvalidPlan
        );
        assert_eq!(
            fs::read_to_string(&pointer).unwrap(),
            source.to_string_lossy()
        );
    }

    #[test]
    fn stale_target_revision_blocks_load_replace_and_migrate_without_touching_b() {
        for action in [
            DataOperationAction::LoadExistingTarget,
            DataOperationAction::ReplaceTargetWithCurrent,
            DataOperationAction::MigrateCurrentToTarget,
        ] {
            let root = tempdir().unwrap();
            let source = root.path().join("source");
            let target = root.path().join("target");
            let default_dir = root.path().join("default");
            let pointer = default_dir.join("toskr-datadir.txt");
            fs::create_dir_all(&default_dir).unwrap();
            write_valid_store(&source, "source-a");
            if action == DataOperationAction::MigrateCurrentToTarget {
                fs::create_dir_all(&target).unwrap();
            } else {
                write_valid_store(&target, "authorized-a");
            }
            let authorized_revision = expected_revision(&target);
            write_valid_store(&target, "external-b");
            fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
            let plan = DataOperationPlan {
                operation_id: format!("stale-{action:?}"),
                source_path: source.to_string_lossy().into_owned(),
                target_path: target.to_string_lossy().into_owned(),
                action,
                replace_confirmed: action == DataOperationAction::ReplaceTargetWithCurrent,
                expected_target_revision: authorized_revision,
            };

            assert_eq!(
                begin_data_operation(&plan, &pointer, &default_dir)
                    .unwrap_err()
                    .code,
                DataOperationFailureCode::ExternalConflict
            );
            assert!(fs::read_to_string(target.join(DATA_FILE))
                .unwrap()
                .contains("external-b"));
            assert_eq!(
                fs::read_to_string(&pointer).unwrap(),
                source.to_string_lossy()
            );
        }
    }

    #[test]
    fn load_target_drift_before_rehydrate_finalize_rolls_back_pointer_and_preserves_b() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-a");
        write_valid_store(&target, "authorized-a");
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "load-rehydrate-drift".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::LoadExistingTarget,
            replace_confirmed: false,
            expected_target_revision: expected_revision(&target),
        };
        let pending = begin_data_operation(&plan, &pointer, &default_dir).unwrap();
        write_valid_store(&target, "external-b");

        assert_eq!(
            pending.finalize().unwrap_err().code,
            DataOperationFailureCode::ExternalConflict
        );
        pending.rollback(&pointer, &default_dir).unwrap();
        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("external-b"));
        assert_eq!(
            fs::read_to_string(&pointer).unwrap(),
            source.to_string_lossy()
        );
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_recovery_source_is_rejected_before_target_copy() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        write_valid_store(&target, "target-note");
        symlink("outside.png", target.join(MEDIA_DIR).join("unsafe.png")).unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "op-recovery-fail".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::ReplaceTargetWithCurrent,
            replace_confirmed: true,
            expected_target_revision: expected_revision(&target),
        };

        let error = begin_data_operation(&plan, &pointer, &default_dir).unwrap_err();

        assert_eq!(error.code, DataOperationFailureCode::InvalidPlan);
        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("target-note"));
        assert!(target.join(MEDIA_DIR).join("unsafe.png").is_symlink());
        assert!(!target.join(".toskr-recovery-op-recovery-fail").exists());
        assert_eq!(
            fs::read_to_string(&pointer).unwrap(),
            source.to_string_lossy()
        );
    }

    #[test]
    fn valid_target_without_media_directory_can_still_be_replaced_and_rolled_back() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        write_valid_store(&target, "target-note");
        fs::remove_dir(target.join(MEDIA_DIR)).unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "op-no-media".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::ReplaceTargetWithCurrent,
            replace_confirmed: true,
            expected_target_revision: expected_revision(&target),
        };

        let pending = begin_data_operation(&plan, &pointer, &default_dir).unwrap();
        pending.rollback(&pointer, &default_dir).unwrap();

        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("target-note"));
        assert!(!target.join(MEDIA_DIR).exists());
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_staging_source_leaves_no_half_target_or_hidden_staging() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        symlink("outside.png", source.join(MEDIA_DIR).join("unsafe.png")).unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "op-copy-fail".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::MigrateCurrentToTarget,
            replace_confirmed: false,
            expected_target_revision: expected_revision(&target),
        };

        let error = begin_data_operation(&plan, &pointer, &default_dir).unwrap_err();

        assert_eq!(error.code, DataOperationFailureCode::CorruptData);
        assert!(!target.join(DATA_FILE).exists());
        assert!(!target.join(MEDIA_DIR).exists());
        assert!(!target.join(".toskr-staging-op-copy-fail").exists());
        assert_eq!(
            fs::read_to_string(&pointer).unwrap(),
            source.to_string_lossy()
        );
    }

    #[test]
    fn complete_import_replacement_rolls_back_to_original_active_dataset() {
        let root = tempdir().unwrap();
        let active = root.path().join("active");
        let imported = root.path().join("import-source");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&active, "before-import");
        write_valid_store(&imported, "from-backup");
        fs::write(&pointer, active.to_string_lossy().as_bytes()).unwrap();

        let pending = begin_import_operation(
            &imported,
            &active,
            "op-import",
            &expected_revision(&active).unwrap(),
            &pointer,
            &default_dir,
        )
        .unwrap();
        assert!(fs::read_to_string(active.join(DATA_FILE))
            .unwrap()
            .contains("from-backup"));

        let restored = pending.rollback(&pointer, &default_dir).unwrap();
        assert_eq!(restored, active);
        assert!(fs::read_to_string(active.join(DATA_FILE))
            .unwrap()
            .contains("before-import"));
        assert!(!imported.exists());
    }

    #[test]
    fn injected_transaction_failures_leave_pointer_and_target_unchanged() {
        for phase in [
            DataOperationPhase::Prepare,
            DataOperationPhase::RecoveryPoint,
            DataOperationPhase::Copy,
            DataOperationPhase::Verify,
            DataOperationPhase::CommitPointer,
        ] {
            let root = tempdir().unwrap();
            let source = root.path().join("source");
            let target = root.path().join("target");
            let default_dir = root.path().join("default");
            let pointer = default_dir.join("toskr-datadir.txt");
            fs::create_dir_all(&default_dir).unwrap();
            write_valid_store(&source, "source-note");
            write_valid_store(&target, "target-note");
            fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
            let plan = DataOperationPlan {
                operation_id: format!("op-{phase:?}"),
                source_path: source.to_string_lossy().into_owned(),
                target_path: target.to_string_lossy().into_owned(),
                action: DataOperationAction::ReplaceTargetWithCurrent,
                replace_confirmed: true,
                expected_target_revision: expected_revision(&target),
            };

            let error =
                begin_data_operation_inner(&plan, &pointer, &default_dir, Some(phase)).unwrap_err();

            assert_ne!(error.code, DataOperationFailureCode::RollbackFailed);
            assert_eq!(
                fs::read_to_string(&pointer).unwrap(),
                source.to_string_lossy()
            );
            assert!(fs::read_to_string(target.join(DATA_FILE))
                .unwrap()
                .contains("target-note"));
            assert!(source.join(DATA_FILE).is_file());
        }
    }

    #[test]
    fn media_health_reports_missing_orphan_shared_and_undo_references_without_deleting() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(MEDIA_DIR)).unwrap();
        for file in ["shared.png", "undo.png", "orphan.png"] {
            fs::write(root.path().join(MEDIA_DIR).join(file), file).unwrap();
        }
        let state = serde_json::json!({
            "state": {
                "notes": [
                    {"imageFile": "shared.png"},
                    {"attachments": ["shared.png", "missing.png"]}
                ]
            },
            "undoStack": [{"notes": [{"imageFile": "undo.png"}]}]
        });

        let report = scan_media_integrity(root.path(), &state.to_string()).unwrap();

        assert_eq!(report.missing, vec!["missing.png"]);
        assert_eq!(report.orphaned, vec!["orphan.png"]);
        assert_eq!(report.pending_undo_references, vec!["undo.png"]);
        assert_eq!(
            report.shared,
            vec![SharedMediaReference {
                file: "shared.png".into(),
                references: 2,
            }]
        );
        assert!(root.path().join(MEDIA_DIR).join("orphan.png").exists());
    }

    #[test]
    fn media_tombstones_survive_restart_and_delete_only_after_deadline_without_references() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(MEDIA_DIR)).unwrap();
        fs::write(root.path().join(MEDIA_DIR).join("late.png"), b"late").unwrap();
        schedule_media_gc(root.path(), &["late.png".into()], 200).unwrap();

        let state = "{\"state\":{\"notes\":[]}}";
        let before = run_media_gc(root.path(), state, state, 199, || Ok(())).unwrap();
        assert!(before.deleted.is_empty());
        assert!(root.path().join(MEDIA_DIR).join("late.png").exists());

        // 模拟重启：仅依赖落盘墓碑，不依赖调用方内存集合。
        let after = run_media_gc(root.path(), state, state, 200, || Ok(())).unwrap();
        assert_eq!(after.deleted, vec!["late.png"]);
        assert!(!root.path().join(MEDIA_DIR).join("late.png").exists());
    }

    #[test]
    fn media_gc_never_deletes_a_file_referenced_again_by_undo_or_active_state() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(MEDIA_DIR)).unwrap();
        fs::write(root.path().join(MEDIA_DIR).join("kept.png"), b"kept").unwrap();
        schedule_media_gc(root.path(), &["kept.png".into()], 1).unwrap();
        let state = serde_json::json!({
            "state": {"notes": []},
            "undoStack": [{"notes": [{"imageFile": "kept.png"}]}]
        });
        let result = run_media_gc(
            root.path(),
            &state.to_string(),
            &state.to_string(),
            2,
            || Ok(()),
        )
        .unwrap();
        assert_eq!(result.retained, vec!["kept.png"]);
        assert!(root.path().join(MEDIA_DIR).join("kept.png").exists());
        assert!(root.path().join(MEDIA_GC_FILE).exists());

        let empty = "{\"state\":{\"notes\":[]}}";
        let expired = run_media_gc(root.path(), empty, empty, 3, || Ok(())).unwrap();
        assert_eq!(expired.deleted, vec!["kept.png"]);
        assert!(!root.path().join(MEDIA_GC_FILE).exists());
    }

    #[test]
    fn media_gc_keeps_an_editor_draft_image_after_its_source_note_is_deleted() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(MEDIA_DIR)).unwrap();
        fs::write(root.path().join(MEDIA_DIR).join("clip.png"), b"clip").unwrap();
        schedule_media_gc(root.path(), &["clip.png".into()], 1).unwrap();
        let disk = serde_json::json!({"state": {"notes": []}});
        let draft = serde_json::json!({
            "state": {
                "notes": [],
                "editorDrafts": [{"attachments": ["clip.png"]}]
            }
        });

        let retained = run_media_gc(
            root.path(),
            &disk.to_string(),
            &draft.to_string(),
            2,
            || Ok(()),
        )
        .unwrap();
        assert_eq!(retained.retained, vec!["clip.png"]);
        assert!(root.path().join(MEDIA_DIR).join("clip.png").exists());
        assert!(root.path().join(MEDIA_GC_FILE).exists());

        // 模拟强退/重启：内存草稿消失且没有显式 release，原墓碑仍可完成清理。
        let released = run_media_gc(root.path(), &disk.to_string(), &disk.to_string(), 3, || {
            Ok(())
        })
        .unwrap();
        assert_eq!(released.deleted, vec!["clip.png"]);
    }

    #[test]
    fn media_gc_unions_authoritative_disk_and_runtime_references() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(MEDIA_DIR)).unwrap();
        fs::write(root.path().join(MEDIA_DIR).join("shared.png"), b"shared").unwrap();
        schedule_media_gc(root.path(), &["shared.png".into()], 1).unwrap();
        let disk = serde_json::json!({
            "state": {"notes": [{"imageFile": "shared.png"}]}
        });
        let memory = serde_json::json!({"state": {"notes": []}});

        let result = run_media_gc(
            root.path(),
            &disk.to_string(),
            &memory.to_string(),
            2,
            || Ok(()),
        )
        .unwrap();

        assert_eq!(result.retained, vec!["shared.png"]);
        assert!(root.path().join(MEDIA_DIR).join("shared.png").exists());
    }

    #[test]
    fn media_gc_restores_quarantine_when_revision_drifts_at_commit_boundary() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(MEDIA_DIR)).unwrap();
        fs::write(root.path().join(MEDIA_DIR).join("late.png"), b"late").unwrap();
        schedule_media_gc(root.path(), &["late.png".into()], 1).unwrap();
        let state = "{\"state\":{\"notes\":[]}}";
        let mut checks = 0;

        let error = run_media_gc(root.path(), state, state, 2, || {
            checks += 1;
            if checks == 1 {
                Ok(())
            } else {
                Err(failure(
                    DataOperationFailureCode::ExternalConflict,
                    "injected revision drift",
                ))
            }
        })
        .unwrap_err();

        assert_eq!(error.code, DataOperationFailureCode::ExternalConflict);
        assert_eq!(
            fs::read(root.path().join(MEDIA_DIR).join("late.png")).unwrap(),
            b"late"
        );
        assert!(root.path().join(MEDIA_GC_FILE).exists());
    }

    #[test]
    fn media_gc_preserves_same_name_external_replacement() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(MEDIA_DIR)).unwrap();
        let file = root.path().join(MEDIA_DIR).join("same.png");
        fs::write(&file, b"owned-a").unwrap();
        schedule_media_gc(root.path(), &["same.png".into()], 1).unwrap();
        fs::write(&file, b"external-b").unwrap();

        assert_eq!(
            schedule_media_gc(root.path(), &["same.png".into()], 2)
                .unwrap_err()
                .code,
            DataOperationFailureCode::ExternalConflict
        );

        let state = "{\"state\":{\"notes\":[]}}";
        let error = run_media_gc(root.path(), state, state, 2, || Ok(())).unwrap_err();

        assert_eq!(error.code, DataOperationFailureCode::ExternalConflict);
        assert_eq!(fs::read(&file).unwrap(), b"external-b");
        assert!(root.path().join(MEDIA_GC_FILE).exists());
    }

    #[test]
    fn media_gc_restores_earlier_quarantines_when_a_later_file_drifts() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(MEDIA_DIR)).unwrap();
        let first = root.path().join(MEDIA_DIR).join("a.png");
        let second = root.path().join(MEDIA_DIR).join("b.png");
        fs::write(&first, b"first-a").unwrap();
        fs::write(&second, b"second-a").unwrap();
        schedule_media_gc(root.path(), &["a.png".into(), "b.png".into()], 1).unwrap();
        fs::write(&second, b"second-b").unwrap();

        let state = "{\"state\":{\"notes\":[]}}";
        let error = run_media_gc(root.path(), state, state, 2, || Ok(())).unwrap_err();

        assert_eq!(error.code, DataOperationFailureCode::ExternalConflict);
        assert_eq!(fs::read(&first).unwrap(), b"first-a");
        assert_eq!(fs::read(&second).unwrap(), b"second-b");
        assert_eq!(read_gc_entries(root.path()).unwrap().len(), 2);
    }

    #[test]
    fn media_gc_recovers_each_durable_quarantine_crash_point() {
        for crash_point in ["journal", "rename", "unlink"] {
            let root = tempdir().unwrap();
            fs::create_dir_all(root.path().join(MEDIA_DIR)).unwrap();
            let original = root.path().join(MEDIA_DIR).join("a.png");
            fs::write(&original, b"owned-a").unwrap();
            schedule_media_gc(root.path(), &["a.png".into()], 100).unwrap();
            let mut entries = read_gc_entries(root.path()).unwrap();
            let quarantine_name = gc_quarantine_name(&entries[0]).unwrap();
            entries[0].quarantine = Some(quarantine_name.clone());
            write_gc_entries(root.path(), entries).unwrap();
            let quarantine = root.path().join(MEDIA_DIR).join(quarantine_name);
            if crash_point != "journal" {
                rename_no_replace(&original, &quarantine).unwrap();
            }
            if crash_point == "unlink" {
                fs::remove_file(&quarantine).unwrap();
            }

            let state = "{\"state\":{\"notes\":[]}}";
            run_media_gc(root.path(), state, state, 1, || Ok(())).unwrap();

            if crash_point == "unlink" {
                assert!(!original.exists());
                assert!(read_gc_entries(root.path()).unwrap().is_empty());
            } else {
                assert_eq!(fs::read(&original).unwrap(), b"owned-a");
                let recovered = read_gc_entries(root.path()).unwrap();
                assert_eq!(recovered.len(), 1);
                assert!(recovered[0].quarantine.is_none());
            }
        }
    }

    #[test]
    fn crash_recovery_restores_migrate_replace_and_load_transactions() {
        for action in [
            DataOperationAction::MigrateCurrentToTarget,
            DataOperationAction::ReplaceTargetWithCurrent,
            DataOperationAction::LoadExistingTarget,
        ] {
            let root = tempdir().unwrap();
            let source = root.path().join("source");
            let target = root.path().join("target");
            let default_dir = root.path().join("default");
            let pointer = default_dir.join("toskr-datadir.txt");
            fs::create_dir_all(&default_dir).unwrap();
            write_valid_store(&source, "source-note");
            if action == DataOperationAction::MigrateCurrentToTarget {
                fs::create_dir_all(&target).unwrap();
            } else {
                write_valid_store(&target, "target-note");
            }
            fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
            let operation_id = format!("crash-{action:?}");
            let plan = DataOperationPlan {
                operation_id,
                source_path: source.to_string_lossy().into_owned(),
                target_path: target.to_string_lossy().into_owned(),
                action,
                replace_confirmed: action == DataOperationAction::ReplaceTargetWithCurrent,
                expected_target_revision: expected_revision(&target),
            };

            let pending = begin_data_operation(&plan, &pointer, &default_dir).unwrap();
            drop(pending); // 模拟 commit pointer 后进程退出，runtime.pending 丢失。
            assert!(default_dir.join(DATA_JOURNAL_FILE).exists());

            let restored = recover_pending_data_operation(&pointer, &default_dir)
                .unwrap()
                .unwrap();
            assert_eq!(restored, source);
            assert_eq!(
                fs::read_to_string(&pointer).unwrap(),
                source.to_string_lossy()
            );
            assert!(!default_dir.join(DATA_JOURNAL_FILE).exists());
            if action == DataOperationAction::MigrateCurrentToTarget {
                assert!(!target.join(DATA_FILE).exists());
            } else {
                assert!(fs::read_to_string(target.join(DATA_FILE))
                    .unwrap()
                    .contains("target-note"));
            }
        }
    }

    #[test]
    fn crash_mid_forward_displace_rejoins_old_target_before_rollback() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        fs::write(source.join(MEDIA_DIR).join("new.png"), b"new-media").unwrap();
        write_valid_store(&target, "target-note");
        fs::write(target.join(MEDIA_DIR).join("old.png"), b"old-media").unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "forward-displace-crash".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::ReplaceTargetWithCurrent,
            replace_confirmed: true,
            expected_target_revision: expected_revision(&target),
        };

        let mut pending = begin_data_operation(&plan, &pointer, &default_dir).unwrap();
        let staging = pending.staging_dir.as_ref().unwrap();
        let displaced = pending.displaced_dir.as_ref().unwrap();
        // 还原到 forward commit 的中间态：A 仍完整位于 staging；旧 B 的 data
        // 已进入 displaced，而 media 尚留 target，随后进程退出。
        move_managed_no_replace(&target, staging).unwrap();
        rename_no_replace(&displaced.join(MEDIA_DIR), &target.join(MEDIA_DIR)).unwrap();
        pending.commit_completed = false;
        pending.persist_journal().unwrap();
        drop(pending);

        recover_pending_data_operation(&pointer, &default_dir).unwrap();

        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("target-note"));
        assert_eq!(
            fs::read(target.join(MEDIA_DIR).join("old.png")).unwrap(),
            b"old-media"
        );
        assert!(!default_dir.join(DATA_JOURNAL_FILE).exists());
    }

    #[test]
    fn rollback_never_recreates_a_target_explicitly_deleted_after_commit() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-new");
        write_valid_store(&target, "target-old");
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "external-delete-before-rollback".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::ReplaceTargetWithCurrent,
            replace_confirmed: true,
            expected_target_revision: expected_revision(&target),
        };
        let pending = begin_data_operation(&plan, &pointer, &default_dir).unwrap();
        remove_managed(&target).unwrap();

        assert_eq!(
            pending.rollback(&pointer, &default_dir).unwrap_err().code,
            DataOperationFailureCode::RollbackFailed
        );
        assert_eq!(
            managed_partial_revision(&target).unwrap(),
            empty_managed_revision()
        );
        assert!(default_dir.join(DATA_JOURNAL_FILE).exists());
    }

    #[test]
    fn rollback_rejects_an_external_partial_delete_after_commit() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-new");
        fs::create_dir_all(source.join(MEDIA_DIR)).unwrap();
        fs::write(source.join(MEDIA_DIR).join("new.png"), b"new").unwrap();
        write_valid_store(&target, "target-old");
        fs::create_dir_all(target.join(MEDIA_DIR)).unwrap();
        fs::write(target.join(MEDIA_DIR).join("old.png"), b"old").unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let pending = begin_data_operation(
            &DataOperationPlan {
                operation_id: "external-partial-delete".into(),
                source_path: source.to_string_lossy().into_owned(),
                target_path: target.to_string_lossy().into_owned(),
                action: DataOperationAction::ReplaceTargetWithCurrent,
                replace_confirmed: true,
                expected_target_revision: expected_revision(&target),
            },
            &pointer,
            &default_dir,
        )
        .unwrap();
        fs::remove_dir_all(target.join(MEDIA_DIR)).unwrap();

        assert_eq!(
            pending.rollback(&pointer, &default_dir).unwrap_err().code,
            DataOperationFailureCode::RollbackFailed
        );
        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("source-new"));
        assert!(!target.join(MEDIA_DIR).exists());
        assert!(default_dir.join(DATA_JOURNAL_FILE).exists());
    }

    #[test]
    fn crash_mid_rollback_capture_is_proven_by_the_full_manifest_union() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-new");
        fs::create_dir_all(source.join(MEDIA_DIR)).unwrap();
        fs::write(source.join(MEDIA_DIR).join("new.png"), b"new").unwrap();
        write_valid_store(&target, "target-old");
        fs::create_dir_all(target.join(MEDIA_DIR)).unwrap();
        fs::write(target.join(MEDIA_DIR).join("old.png"), b"old").unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let pending = begin_data_operation(
            &DataOperationPlan {
                operation_id: "crash-mid-rollback-capture".into(),
                source_path: source.to_string_lossy().into_owned(),
                target_path: target.to_string_lossy().into_owned(),
                action: DataOperationAction::ReplaceTargetWithCurrent,
                replace_confirmed: true,
                expected_target_revision: expected_revision(&target),
            },
            &pointer,
            &default_dir,
        )
        .unwrap();
        let capture_root = pending.rollback_capture_dir.as_ref().unwrap();
        let interrupted = capture_root.join("captured-interrupted");
        fs::create_dir_all(&interrupted).unwrap();
        fs::rename(target.join(MEDIA_DIR), interrupted.join(MEDIA_DIR)).unwrap();

        pending.rollback(&pointer, &default_dir).unwrap();

        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("target-old"));
        assert_eq!(
            fs::read(target.join(MEDIA_DIR).join("old.png")).unwrap(),
            b"old"
        );
        assert!(!default_dir.join(DATA_JOURNAL_FILE).exists());
    }

    #[test]
    fn crash_mid_recovery_copy_rebuilds_rollback_staging() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-new");
        fs::write(source.join(MEDIA_DIR).join("new.png"), b"new").unwrap();
        write_valid_store(&target, "target-old");
        fs::write(target.join(MEDIA_DIR).join("old.png"), b"old").unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let pending = begin_data_operation(
            &DataOperationPlan {
                operation_id: "crash-mid-recovery-copy".into(),
                source_path: source.to_string_lossy().into_owned(),
                target_path: target.to_string_lossy().into_owned(),
                action: DataOperationAction::ReplaceTargetWithCurrent,
                replace_confirmed: true,
                expected_target_revision: expected_revision(&target),
            },
            &pointer,
            &default_dir,
        )
        .unwrap();
        let capture = pending
            .rollback_capture_dir
            .as_ref()
            .unwrap()
            .join("captured-committed");
        fs::create_dir_all(&capture).unwrap();
        move_managed_no_replace(&target, &capture).unwrap();
        let rollback_staging = target.join(".toskr-rollback-crash-mid-recovery-copy");
        fs::create_dir_all(&rollback_staging).unwrap();
        fs::copy(
            pending.recovery_dir.as_ref().unwrap().join(DATA_FILE),
            rollback_staging.join(DATA_FILE),
        )
        .unwrap();
        drop(pending);

        recover_pending_data_operation(&pointer, &default_dir).unwrap();

        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("target-old"));
        assert_eq!(
            fs::read(target.join(MEDIA_DIR).join("old.png")).unwrap(),
            b"old"
        );
        assert!(!default_dir.join(DATA_JOURNAL_FILE).exists());
    }

    #[test]
    fn complete_import_journal_recovers_original_and_cleans_isolated_source() {
        let root = tempdir().unwrap();
        let active = root.path().join("active");
        let import = root.path().join(".toskr-import-source-crash-import");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&active, "before-import");
        write_valid_store(&import, "from-backup");
        fs::write(&pointer, active.to_string_lossy().as_bytes()).unwrap();

        drop(
            begin_import_operation(
                &import,
                &active,
                "crash-import",
                &expected_revision(&active).unwrap(),
                &pointer,
                &default_dir,
            )
            .unwrap(),
        );
        recover_pending_data_operation(&pointer, &default_dir).unwrap();

        assert!(fs::read_to_string(active.join(DATA_FILE))
            .unwrap()
            .contains("before-import"));
        assert!(!import.exists());
        assert!(!default_dir.join(DATA_JOURNAL_FILE).exists());
    }

    #[test]
    fn complete_import_missing_source_cannot_self_prove_an_external_target() {
        let root = tempdir().unwrap();
        let active = root.path().join("active");
        let import = root.path().join(".toskr-import-source-import-external");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&active, "before-import");
        write_valid_store(&import, "from-backup");
        fs::write(&pointer, active.to_string_lossy().as_bytes()).unwrap();
        drop(
            begin_import_operation(
                &import,
                &active,
                "import-external",
                &expected_revision(&active).unwrap(),
                &pointer,
                &default_dir,
            )
            .unwrap(),
        );
        fs::remove_dir_all(&import).unwrap();
        write_valid_store(&active, "external-after-import");

        assert_eq!(
            recover_pending_data_operation(&pointer, &default_dir)
                .unwrap_err()
                .code,
            DataOperationFailureCode::RollbackFailed
        );
        assert!(fs::read_to_string(active.join(DATA_FILE))
            .unwrap()
            .contains("external-after-import"));
        assert!(default_dir.join(DATA_JOURNAL_FILE).exists());
    }

    #[test]
    fn finalize_consumes_journal_but_rejects_rehydrate_window_drift() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        fs::create_dir_all(&target).unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "finalize-drift".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::MigrateCurrentToTarget,
            replace_confirmed: false,
            expected_target_revision: expected_revision(&target),
        };
        let pending = begin_data_operation(&plan, &pointer, &default_dir).unwrap();
        write_valid_store(&target, "external-after-rehydrate");

        assert_eq!(
            pending.finalize().unwrap_err().code,
            DataOperationFailureCode::ExternalConflict
        );
        assert!(default_dir.join(DATA_JOURNAL_FILE).exists());
        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("external-after-rehydrate"));
    }

    #[test]
    fn restart_never_overwrites_an_external_target_version() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        write_valid_store(&target, "old-target");
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "external-restart".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::ReplaceTargetWithCurrent,
            replace_confirmed: true,
            expected_target_revision: expected_revision(&target),
        };
        drop(begin_data_operation(&plan, &pointer, &default_dir).unwrap());
        write_valid_store(&target, "external-new-version");

        assert_eq!(
            recover_pending_data_operation(&pointer, &default_dir)
                .unwrap_err()
                .code,
            DataOperationFailureCode::RollbackFailed
        );
        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("external-new-version"));
        assert!(default_dir.join(DATA_JOURNAL_FILE).exists());
    }

    #[test]
    fn recovery_subset_without_capture_or_staging_proof_fails_closed() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        write_valid_store(&target, "target-note");
        fs::write(target.join(MEDIA_DIR).join("old.png"), b"old-media").unwrap();
        fs::write(source.join(MEDIA_DIR).join("new.png"), b"new-media").unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "rollback-crash".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::ReplaceTargetWithCurrent,
            replace_confirmed: true,
            expected_target_revision: expected_revision(&target),
        };
        let pending = begin_data_operation(&plan, &pointer, &default_dir).unwrap();
        let recovery = pending.recovery_dir.clone().unwrap();
        remove_managed(&target).unwrap();
        copy_regular_file(
            &recovery.join(DATA_FILE),
            &target.join(DATA_FILE),
            MAX_DATA_FILE_BYTES,
        )
        .unwrap();
        drop(pending); // 旧 data 已恢复、旧 media 尚未恢复时崩溃。

        assert_eq!(
            recover_pending_data_operation(&pointer, &default_dir)
                .unwrap_err()
                .code,
            DataOperationFailureCode::RollbackFailed
        );
        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("target-note"));
        assert!(!target.join(MEDIA_DIR).exists());
        assert!(default_dir.join(DATA_JOURNAL_FILE).exists());
    }

    #[test]
    fn crash_after_old_partial_is_rejoined_resumes_from_complete_rollback_staging() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        write_valid_store(&target, "target-note");
        fs::write(target.join(MEDIA_DIR).join("old.png"), b"old-media").unwrap();
        fs::write(source.join(MEDIA_DIR).join("new.png"), b"new-media").unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let pending = begin_data_operation(
            &DataOperationPlan {
                operation_id: "rollback-rejoin-crash".into(),
                source_path: source.to_string_lossy().into_owned(),
                target_path: target.to_string_lossy().into_owned(),
                action: DataOperationAction::ReplaceTargetWithCurrent,
                replace_confirmed: true,
                expected_target_revision: expected_revision(&target),
            },
            &pointer,
            &default_dir,
        )
        .unwrap();

        let capture_root = pending.rollback_capture_dir.as_ref().unwrap();
        let committed_capture = capture_root.join("captured-committed");
        fs::create_dir_all(&committed_capture).unwrap();
        move_managed_no_replace(&target, &committed_capture).unwrap();
        let rollback_staging = target.join(".toskr-rollback-rollback-rejoin-crash");
        copy_managed(pending.recovery_dir.as_ref().unwrap(), &rollback_staging).unwrap();
        rename_no_replace(&rollback_staging.join(DATA_FILE), &target.join(DATA_FILE)).unwrap();
        rejoin_rollback_staging(&pending).unwrap();
        drop(pending); // B partial 已合回完整 staging、目标为空时进程退出。

        recover_pending_data_operation(&pointer, &default_dir).unwrap();

        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("target-note"));
        assert_eq!(
            fs::read(target.join(MEDIA_DIR).join("old.png")).unwrap(),
            b"old-media"
        );
        assert!(!default_dir.join(DATA_JOURNAL_FILE).exists());
    }

    #[test]
    fn derived_thumbnails_are_excluded_from_transaction_revision_and_copy() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        fs::create_dir_all(source.join(MEDIA_DIR).join("thumbs")).unwrap();
        fs::write(source.join(MEDIA_DIR).join("image.png"), b"original").unwrap();
        fs::write(source.join(MEDIA_DIR).join("thumbs/image.png"), b"derived").unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "thumb-cache".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            action: DataOperationAction::MigrateCurrentToTarget,
            replace_confirmed: false,
            expected_target_revision: expected_revision(&target),
        };

        let pending = begin_data_operation(&plan, &pointer, &default_dir).unwrap();
        assert!(target.join(MEDIA_DIR).join("image.png").exists());
        assert!(!target.join(MEDIA_DIR).join("thumbs").exists());
        pending.finalize().unwrap();
    }

    #[test]
    fn corrupt_journal_and_wrong_type_store_fail_closed() {
        let root = tempdir().unwrap();
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        fs::write(default_dir.join(DATA_JOURNAL_FILE), b"{}").unwrap();
        assert_eq!(
            recover_pending_data_operation(&pointer, &default_dir)
                .unwrap_err()
                .code,
            DataOperationFailureCode::RollbackFailed
        );
        assert!(default_dir.join(DATA_JOURNAL_FILE).exists());

        let corrupt = root.path().join("wrong-type");
        fs::create_dir_all(corrupt.join(MEDIA_DIR)).unwrap();
        let persisted = serde_json::json!({
            "version": MAX_STORE_VERSION,
            "state": {"notes": "corrupt", "tasks": []}
        });
        fs::write(
            corrupt.join(DATA_FILE),
            serde_json::json!({"toskr": persisted.to_string()}).to_string(),
        )
        .unwrap();
        assert_eq!(
            inspect_location(&corrupt, None).kind,
            DataLocationKind::Corrupt
        );
    }

    #[cfg(unix)]
    #[test]
    fn overlap_detection_resolves_symlinked_existing_ancestor_with_missing_suffix() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let alias = root.path().join("alias");
        let default_dir = root.path().join("default");
        let pointer = default_dir.join("toskr-datadir.txt");
        fs::create_dir_all(&default_dir).unwrap();
        write_valid_store(&source, "source-note");
        symlink(&source, &alias).unwrap();
        fs::write(&pointer, source.to_string_lossy().as_bytes()).unwrap();
        let plan = DataOperationPlan {
            operation_id: "nested-symlink".into(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: alias.join("new/deep").to_string_lossy().into_owned(),
            action: DataOperationAction::MigrateCurrentToTarget,
            replace_confirmed: false,
            expected_target_revision: expected_revision(&alias.join("new/deep")),
        };

        assert_eq!(
            begin_data_operation(&plan, &pointer, &default_dir)
                .unwrap_err()
                .code,
            DataOperationFailureCode::SamePath
        );
        assert!(!source.join("new").exists());
    }

    #[test]
    fn final_commit_identity_captures_and_restores_a_last_moment_target_writer() {
        let root = tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        let staging = root.path().join("staging");
        let displaced = target.join(".toskr-displaced-race");
        write_valid_store(&source, "source-note");
        write_valid_store(&target, "baseline-target");
        let expected_target = managed_revision(&target).unwrap();
        copy_managed(&source, &staging).unwrap();

        // 模拟最终 precheck 通过后、破坏动作前同步盘写入 U。
        write_valid_store(&target, "last-moment-external");
        let error = commit_staging(&staging, &target, &displaced, &expected_target).unwrap_err();

        assert_eq!(
            error.failure.code,
            DataOperationFailureCode::ExternalConflict
        );
        assert!(error.external_restored);
        assert!(fs::read_to_string(target.join(DATA_FILE))
            .unwrap()
            .contains("last-moment-external"));
        assert!(staging.join(DATA_FILE).exists());
        assert!(!displaced.exists());
    }

    #[test]
    fn corrupt_gc_metadata_is_reported_instead_of_silently_reset() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(MEDIA_DIR)).unwrap();
        fs::write(root.path().join(MEDIA_GC_FILE), b"not-json").unwrap();

        assert_eq!(
            scan_media_integrity(root.path(), "{\"state\":{\"notes\":[]}}")
                .unwrap_err()
                .code,
            DataOperationFailureCode::CorruptData
        );
        assert_eq!(
            schedule_media_gc(root.path(), &["a.png".into()], 1)
                .unwrap_err()
                .code,
            DataOperationFailureCode::CorruptData
        );
    }
}
