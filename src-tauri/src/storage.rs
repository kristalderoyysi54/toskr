//! 数据存储层：可自定义的数据文件夹 + 笔记 JSON + 图片附件。
//!
//! 布局：
//!   <dataDir>/toskr-data.json    笔记与设置（前端 zustand persist 的后端）
//!   <dataDir>/media/*.png         图片捕获附件
//!
//! dataDir 默认是应用数据目录，可在设置里改到任意文件夹（如 iCloud/同步盘）。
//! 切换目录时把已有数据文件与 media 一并搬过去，避免用户数据割裂。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::data_integrity::{
    self, DataFileSnapshot, DataLocationInspection, DataOperationFailure,
    DataOperationFailureCode, DataOperationPhase, DataOperationPlan, DataOperationResult,
    DataOperationStatus, PendingDataOperation,
};

pub const DATA_FILE: &str = "toskr-data.json";
pub const MEDIA_DIR: &str = "media";
/// 记录用户自定义数据目录的小配置（始终位于应用数据目录，避免鸡生蛋问题）。
const DIR_CONFIG: &str = "toskr-datadir.txt";
const DATA_META_FILE: &str = "toskr-data-meta.json";

#[derive(Default)]
struct StorageRuntime {
    cached_dir: Option<PathBuf>,
    pending: Option<PendingDataOperation>,
    initialization_failure: Option<DataOperationFailure>,
    configured_dir: Option<PathBuf>,
}

#[derive(Default)]
pub struct Storage {
    runtime: Mutex<StorageRuntime>,
    write_gate: Mutex<()>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataRuntimeMetadata {
    last_successful_switch_at_ms: Option<u64>,
    last_conflict_at_ms: Option<u64>,
    conflict_pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocationStatus {
    pub active_dir: String,
    pub default_dir: String,
    pub last_successful_switch_at_ms: Option<u64>,
    pub last_conflict_at_ms: Option<u64>,
    pub conflict_pending: bool,
    pub pending_operation_id: Option<String>,
    pub initialization_failure: Option<DataOperationFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportFailure {
    pub code: String,
    pub message: String,
}

impl BackupImportFailure {
    fn from_backup(failure: crate::backup::BackupFailure) -> Self {
        Self {
            code: serialized_failure_code(&failure.code),
            message: failure.message,
        }
    }

    fn from_data(failure: DataOperationFailure) -> Self {
        Self {
            code: serialized_failure_code(&failure.code),
            message: failure.message,
        }
    }
}

fn import_managed_baseline(
    active: &Path,
    expected_business_revision: &str,
) -> Result<String, BackupImportFailure> {
    let snapshot = data_integrity::read_data_snapshot(&active.join(DATA_FILE))
        .map_err(BackupImportFailure::from_data)?;
    if snapshot.revision != expected_business_revision {
        return Err(BackupImportFailure {
            code: "sourceChanged".into(),
            message: "活动业务数据自冻结后已变化".into(),
        });
    }
    data_integrity::inspect_location(active, None)
        .revision
        .ok_or_else(|| BackupImportFailure {
            code: "corruptData".into(),
            message: "活动数据目录无法生成完整受管 revision".into(),
        })
}

fn serialized_failure_code(code: &impl Serialize) -> String {
    serde_json::to_value(code)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".into())
}

pub(crate) fn app_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 在任何业务读写前完成 crash recovery 与活动指针校验。自定义目录暂时
/// 不可用时启动直接失败，禁止静默回默认目录形成第二份数据。
pub fn initialize_storage(app: &AppHandle) -> Result<(), DataOperationFailure> {
    let base = app_data_dir(app);
    fs::create_dir_all(&base).map_err(|error| DataOperationFailure {
        code: DataOperationFailureCode::PermissionDenied,
        message: format!("创建默认数据目录失败：{error}"),
    })?;
    let pointer = base.join(DIR_CONFIG);
    let _ = data_integrity::recover_pending_data_operation(&pointer, &base)?;
    let active = if pointer.exists() {
        let metadata = fs::symlink_metadata(&pointer).map_err(|error| DataOperationFailure {
            code: DataOperationFailureCode::ReadFailed,
            message: format!("读取数据目录指针失败：{error}"),
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 16 * 1024 {
            return Err(DataOperationFailure {
                code: DataOperationFailureCode::CorruptData,
                message: "数据目录指针不是大小合规的普通文件".into(),
            });
        }
        let raw = String::from_utf8(data_integrity::read_regular_file(&pointer, 16 * 1024)?)
            .map_err(|_| DataOperationFailure {
                code: DataOperationFailureCode::CorruptData,
                message: "数据目录指针不是 UTF-8".into(),
            })?;
        let custom = PathBuf::from(raw.trim());
        if !custom.is_absolute() {
            return Err(DataOperationFailure {
                code: DataOperationFailureCode::CorruptData,
                message: "数据目录指针必须是绝对路径".into(),
            });
        }
        let inspection = data_integrity::inspect_location(&custom, None);
        if inspection.kind != data_integrity::DataLocationKind::Valid {
            return Err(DataOperationFailure {
                code: match inspection.kind {
                    data_integrity::DataLocationKind::Unsupported => {
                        DataOperationFailureCode::UnsupportedSchema
                    }
                    data_integrity::DataLocationKind::Corrupt => {
                        DataOperationFailureCode::CorruptData
                    }
                    _ => DataOperationFailureCode::TargetMissing,
                },
                message: "自定义数据目录不可用；已阻止回落到默认目录".into(),
            });
        }
        custom
    } else {
        base.clone()
    };
    fs::create_dir_all(&active).map_err(|error| DataOperationFailure {
        code: DataOperationFailureCode::PermissionDenied,
        message: format!("创建活动数据目录失败：{error}"),
    })?;
    if active.join(DATA_FILE).exists() {
        let inspection = data_integrity::inspect_location(&active, None);
        if inspection.kind != data_integrity::DataLocationKind::Valid {
            return Err(DataOperationFailure {
                code: match inspection.kind {
                    data_integrity::DataLocationKind::Unsupported => {
                        DataOperationFailureCode::UnsupportedSchema
                    }
                    _ => DataOperationFailureCode::CorruptData,
                },
                message: "活动数据文件 schema 或字段类型无效；已阻止启动写入".into(),
            });
        }
    }
    let media = active.join(MEDIA_DIR);
    if media.exists() {
        let metadata = fs::symlink_metadata(&media).map_err(|error| DataOperationFailure {
            code: DataOperationFailureCode::ReadFailed,
            message: format!("读取媒体目录失败：{error}"),
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(DataOperationFailure {
                code: DataOperationFailureCode::CorruptData,
                message: "media 路径不是普通目录".into(),
            });
        }
    } else {
        fs::create_dir(&media).map_err(|error| DataOperationFailure {
            code: DataOperationFailureCode::PermissionDenied,
            message: format!("创建媒体目录失败：{error}"),
        })?;
    }
    let storage = app.state::<Storage>();
    let mut runtime = storage.runtime.lock().unwrap();
    runtime.cached_dir = Some(active.clone());
    runtime.configured_dir = Some(active);
    runtime.initialization_failure = None;
    Ok(())
}

fn configured_dir_from_pointer(base: &Path) -> PathBuf {
    let pointer = base.join(DIR_CONFIG);
    data_integrity::read_regular_file(&pointer, 16 * 1024)
        .ok()
        .and_then(|raw| String::from_utf8(raw).ok())
        .map(|raw| PathBuf::from(raw.trim()))
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| base.to_path_buf())
}

/// 初始化失败时进入只读 recovery-only 模式，App 仍可打开并给出可行动出口。
pub fn enter_storage_recovery_mode(app: &AppHandle, failure: DataOperationFailure) {
    let base = app_data_dir(app);
    let configured = configured_dir_from_pointer(&base);
    let sentinel = base.join(".toskr-recovery-only");
    let storage = app.state::<Storage>();
    let mut runtime = storage.runtime.lock().unwrap();
    runtime.cached_dir = Some(sentinel);
    runtime.configured_dir = Some(configured);
    runtime.initialization_failure = Some(failure);
}

pub fn retry_storage_initialization(
    app: &AppHandle,
) -> Result<DataLocationStatus, DataOperationFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    match initialize_storage(app) {
        Ok(()) => Ok(data_location_status(app)),
        Err(failure) => {
            enter_storage_recovery_mode(app, failure.clone());
            Err(failure)
        }
    }
}

pub fn load_default_from_recovery(
    app: &AppHandle,
) -> Result<DataLocationStatus, DataOperationFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    let base = app_data_dir(app);
    let pointer = base.join(DIR_CONFIG);
    if !pointer.exists() {
        return match initialize_storage(app) {
            Ok(()) => Ok(data_location_status(app)),
            Err(failure) => {
                enter_storage_recovery_mode(app, failure.clone());
                Err(failure)
            }
        };
    }
    ensure_default_dataset(&base)?;
    let backup = base.join(format!(".toskr-datadir-recovery-{}", now_ms()));
    data_integrity::rename_no_replace(&pointer, &backup).map_err(|error| DataOperationFailure {
        code: DataOperationFailureCode::PointerCommitFailed,
        message: format!("隔离旧数据目录指针失败：{error}"),
    })?;
    let _ = File::open(&base).and_then(|directory| directory.sync_all());
    match initialize_storage(app) {
        Ok(()) => Ok(data_location_status(app)),
        Err(failure) => {
            let _ = data_integrity::rename_no_replace(&backup, &pointer);
            enter_storage_recovery_mode(app, failure.clone());
            Err(failure)
        }
    }
}

fn ensure_default_dataset(base: &Path) -> Result<(), DataOperationFailure> {
    let inspection = data_integrity::inspect_location(base, None);
    match inspection.kind {
        data_integrity::DataLocationKind::Valid => Ok(()),
        data_integrity::DataLocationKind::Empty => {
            let persisted = serde_json::json!({
                "version": data_integrity::MAX_STORE_VERSION,
                "state": {
                    "sections": [],
                    "notes": [],
                    "tasks": [],
                    "taskSections": [],
                    "bills": [],
                    "messages": []
                }
            });
            let document = serde_json::json!({ "toskr": persisted.to_string() }).to_string();
            let snapshot = data_integrity::read_data_snapshot(&base.join(DATA_FILE))?;
            data_integrity::write_if_current(
                &base.join(DATA_FILE),
                &document,
                &snapshot.revision,
            )?;
            if data_integrity::inspect_location(base, None).kind
                != data_integrity::DataLocationKind::Valid
            {
                return Err(DataOperationFailure {
                    code: DataOperationFailureCode::VerificationFailed,
                    message: "默认空数据集物化后校验失败".into(),
                });
            }
            Ok(())
        }
        _ => Err(DataOperationFailure {
            code: DataOperationFailureCode::CorruptData,
            message: "默认数据目录不是可安全采用的空目录或有效数据集".into(),
        }),
    }
}

/// 当前生效的数据目录（已确保存在）。
pub fn data_dir(app: &AppHandle) -> PathBuf {
    let state = app.state::<Storage>();
    let dir = state
        .runtime
        .lock()
        .unwrap()
        .cached_dir
        .clone()
        .expect("storage must be initialized during Tauri setup");
    dir
}

/** 与数据目录事务共用写闸；活动账本读写期间目录不能被切换。 */
pub(crate) fn with_active_data_dir<T>(
    app: &AppHandle,
    action: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    let transaction_pending = { storage.runtime.lock().unwrap().pending.is_some() };
    if transaction_pending || recovery_required(app) {
        return Err("数据目录事务进行中".into());
    }
    let root = data_dir(app);
    action(&root)
}

fn recovery_required(app: &AppHandle) -> bool {
    if app
        .state::<Storage>()
        .runtime
        .lock()
        .unwrap()
        .initialization_failure
        .is_some()
    {
        return true;
    }
    let default = default_data_dir(app);
    data_integrity::recovery_journal_exists(&default.join(DIR_CONFIG), &default)
}

pub fn default_data_dir(app: &AppHandle) -> PathBuf {
    app_data_dir(app)
}

pub fn inspect_data_location(app: &AppHandle, path: &Path) -> DataLocationInspection {
    data_integrity::inspect_location(path, Some(&data_dir(app)))
}

pub fn data_location_status(app: &AppHandle) -> DataLocationStatus {
    let state = app.state::<Storage>();
    let runtime = state.runtime.lock().unwrap();
    let pending_operation_id = runtime
        .pending
        .as_ref()
        .map(|pending| pending.operation_id.clone());
    let initialization_failure = runtime.initialization_failure.clone();
    let active_dir = runtime
        .configured_dir
        .clone()
        .or_else(|| runtime.cached_dir.clone())
        .unwrap_or_else(|| default_data_dir(app));
    drop(runtime);
    let metadata = read_runtime_metadata(app);
    DataLocationStatus {
        active_dir: active_dir.to_string_lossy().into_owned(),
        default_dir: default_data_dir(app).to_string_lossy().into_owned(),
        last_successful_switch_at_ms: metadata.last_successful_switch_at_ms,
        last_conflict_at_ms: metadata.last_conflict_at_ms,
        conflict_pending: metadata.conflict_pending,
        pending_operation_id,
        initialization_failure,
    }
}

pub fn begin_data_operation(
    app: &AppHandle,
    plan: &DataOperationPlan,
) -> Result<DataOperationResult, DataOperationFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    if recovery_required(app) {
        return Err(operation_in_progress());
    }
    {
        let runtime = storage.runtime.lock().unwrap();
        if runtime.pending.is_some() {
            return Err(operation_in_progress());
        }
    }
    // 必须在取得唯一写锁后复核源目录；否则另一个事务可能在等待锁期间
    // 已完成切换，使旧计划重新激活陈旧目录。
    let current = data_dir(app);
    let planned_source = PathBuf::from(&plan.source_path);
    let source_matches = match (
        fs::canonicalize(&current),
        fs::canonicalize(&planned_source),
    ) {
        (Ok(current), Ok(planned)) => current == planned,
        _ => current == planned_source,
    };
    if !source_matches {
        return Err(DataOperationFailure {
            code: DataOperationFailureCode::InvalidPlan,
            message: "操作计划的源目录已过期，请重新预检".into(),
        });
    }
    let default_dir = default_data_dir(app);
    let pointer = default_dir.join(DIR_CONFIG);
    let pending = data_integrity::begin_data_operation(plan, &pointer, &default_dir)?;
    let active_dir = pending.active_dir.clone();
    let operation_id = pending.operation_id.clone();
    let mut runtime = storage.runtime.lock().unwrap();
    runtime.cached_dir = Some(active_dir.clone());
    runtime.pending = Some(pending);
    Ok(DataOperationResult {
        operation_id,
        status: DataOperationStatus::AwaitingRehydrate,
        phase: DataOperationPhase::Rehydrate,
        active_dir: active_dir.to_string_lossy().into_owned(),
        rolled_back: false,
        message: "目录事务已提交指针，等待从目标目录重新水合".into(),
    })
}

pub fn begin_recovery_data_operation(
    app: &AppHandle,
    plan: &DataOperationPlan,
) -> Result<DataOperationResult, DataOperationFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    {
        let runtime = storage.runtime.lock().unwrap();
        if runtime.initialization_failure.is_none() || runtime.pending.is_some() {
            return Err(operation_in_progress());
        }
        if runtime.configured_dir.as_ref().is_some_and(|configured| {
            configured.to_string_lossy() != plan.source_path
        }) {
            return Err(DataOperationFailure {
                code: DataOperationFailureCode::InvalidPlan,
                message: "恢复计划的源目录已变化，请重新预检".into(),
            });
        }
    }
    if plan.action != data_integrity::DataOperationAction::LoadExistingTarget {
        return Err(DataOperationFailure {
            code: DataOperationFailureCode::InvalidPlan,
            message: "恢复模式只允许加载已预检的有效数据目录".into(),
        });
    }
    let default_dir = default_data_dir(app);
    let pointer = default_dir.join(DIR_CONFIG);
    let pending = data_integrity::begin_data_operation(plan, &pointer, &default_dir)?;
    let active_dir = pending.active_dir.clone();
    let operation_id = pending.operation_id.clone();
    let mut runtime = storage.runtime.lock().unwrap();
    runtime.cached_dir = Some(active_dir.clone());
    runtime.pending = Some(pending);
    Ok(DataOperationResult {
        operation_id,
        status: DataOperationStatus::AwaitingRehydrate,
        phase: DataOperationPhase::Rehydrate,
        active_dir: active_dir.to_string_lossy().into_owned(),
        rolled_back: false,
        message: "恢复目录指针已提交，等待重新水合".into(),
    })
}

pub fn begin_complete_backup_import(
    app: &AppHandle,
    backup_path: &Path,
    operation_id: &str,
    expected_revision: &str,
    expected_active_revision: &str,
) -> Result<
    (crate::backup::BackupInspection, DataOperationResult),
    BackupImportFailure,
> {
    data_integrity::validate_operation_id(operation_id)
        .map_err(BackupImportFailure::from_data)?;
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    if recovery_required(app) {
        return Err(BackupImportFailure {
            code: "operationInProgress".into(),
            message: "存在未恢复的数据事务，已阻止新的完整导入".into(),
        });
    }
    {
        let runtime = storage.runtime.lock().unwrap();
        if runtime.pending.is_some() {
            return Err(BackupImportFailure {
                code: "operationInProgress".into(),
                message: "已有数据事务正在等待完成".into(),
            });
        }
    }
    let active = data_dir(app);
    let expected_active_managed_revision = match import_managed_baseline(
        &active,
        expected_active_revision,
    ) {
        Ok(revision) => revision,
        Err(failure) => {
        update_runtime_metadata(app, |metadata| {
            metadata.last_conflict_at_ms = Some(now_ms());
            metadata.conflict_pending = true;
        });
            return Err(failure);
        }
    };
    let staging = active
        .parent()
        .ok_or_else(|| BackupImportFailure {
            code: "invalidPlan".into(),
            message: "活动数据目录没有父目录，无法创建隔离导入区".into(),
        })?
        .join(format!(".toskr-import-source-{operation_id}"));
    let inspection = crate::backup::materialize_complete_backup(
        backup_path,
        &staging,
        expected_revision,
    )
        .map_err(BackupImportFailure::from_backup)?;
    if !import_managed_baseline(&active, expected_active_revision)
        .is_ok_and(|revision| revision == expected_active_managed_revision)
    {
        let _ = fs::remove_dir_all(&staging);
        update_runtime_metadata(app, |metadata| {
            metadata.last_conflict_at_ms = Some(now_ms());
            metadata.conflict_pending = true;
        });
        return Err(BackupImportFailure {
            code: "sourceChanged".into(),
            message: "完整备份解包期间活动数据发生外部变化；未修改活动目录".into(),
        });
    }
    let default_dir = default_data_dir(app);
    let pointer = default_dir.join(DIR_CONFIG);
    let pending = data_integrity::begin_import_operation(
        &staging,
        &active,
        operation_id,
        &expected_active_managed_revision,
        &pointer,
        &default_dir,
    )
    .map_err(|failure| {
        // RollbackFailed 时 journal 仍需 import staging 证明部分提交属于本事务；
        // 只有确认没有 recovery journal 才能清理该不可变来源。
        if !recovery_required(app) {
            let _ = fs::remove_dir_all(&staging);
        }
        if failure.code == DataOperationFailureCode::ExternalConflict {
            update_runtime_metadata(app, |metadata| {
                metadata.last_conflict_at_ms = Some(now_ms());
                metadata.conflict_pending = true;
            });
            BackupImportFailure {
                code: "sourceChanged".into(),
                message: failure.message,
            }
        } else {
            BackupImportFailure::from_data(failure)
        }
    })?;
    let mut runtime = storage.runtime.lock().unwrap();
    runtime.cached_dir = Some(active.clone());
    runtime.pending = Some(pending);
    Ok((
        inspection,
        DataOperationResult {
            operation_id: operation_id.into(),
            status: DataOperationStatus::AwaitingRehydrate,
            phase: DataOperationPhase::Rehydrate,
            active_dir: active.to_string_lossy().into_owned(),
            rolled_back: false,
            message: "完整备份已原子置换，等待重新水合".into(),
        },
    ))
}

pub fn finalize_data_operation(
    app: &AppHandle,
    operation_id: &str,
) -> Result<DataOperationResult, DataOperationFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    let mut runtime = storage.runtime.lock().unwrap();
    let pending = runtime.pending.as_ref().ok_or_else(operation_in_progress)?;
    if pending.operation_id != operation_id {
        return Err(operation_in_progress());
    }
    pending.finalize()?;
    let active = pending.active_dir.clone();
    runtime.pending = None;
    runtime.cached_dir = Some(active.clone());
    runtime.configured_dir = Some(active.clone());
    runtime.initialization_failure = None;
    drop(runtime);
    update_runtime_metadata(app, |metadata| {
        metadata.last_successful_switch_at_ms = Some(now_ms());
    });
    Ok(DataOperationResult {
        operation_id: operation_id.into(),
        status: DataOperationStatus::Completed,
        phase: DataOperationPhase::Complete,
        active_dir: active.to_string_lossy().into_owned(),
        rolled_back: false,
        message: "数据事务已验证完成".into(),
    })
}

pub fn rollback_data_operation(
    app: &AppHandle,
    operation_id: &str,
) -> Result<DataOperationResult, DataOperationFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    let mut runtime = storage.runtime.lock().unwrap();
    let matches = runtime
        .pending
        .as_ref()
        .is_some_and(|pending| pending.operation_id == operation_id);
    if !matches {
        return Err(operation_in_progress());
    }
    let default_dir = default_data_dir(app);
    let pointer = default_dir.join(DIR_CONFIG);
    let restored = runtime
        .pending
        .as_ref()
        .expect("matching pending checked")
        .rollback(&pointer, &default_dir)?;
    runtime.pending = None;
    runtime.cached_dir = Some(restored.clone());
    Ok(DataOperationResult {
        operation_id: operation_id.into(),
        status: DataOperationStatus::RolledBack,
        phase: DataOperationPhase::Rollback,
        active_dir: restored.to_string_lossy().into_owned(),
        rolled_back: true,
        message: "数据目录指针、目标内容与内存基线已回滚".into(),
    })
}

fn operation_in_progress() -> DataOperationFailure {
    DataOperationFailure {
        code: DataOperationFailureCode::OperationInProgress,
        message: "没有匹配的待完成事务，或已有事务正在进行".into(),
    }
}

pub fn read_data_snapshot(app: &AppHandle) -> Result<DataFileSnapshot, DataOperationFailure> {
    data_integrity::read_data_snapshot(&data_dir(app).join(DATA_FILE))
}

pub fn write_data_if_current(
    app: &AppHandle,
    content: &str,
    expected_revision: &str,
) -> Result<DataFileSnapshot, DataOperationFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    if storage.runtime.lock().unwrap().pending.is_some() || recovery_required(app) {
        return Err(operation_in_progress());
    }
    let result = data_integrity::write_if_current(
        &data_dir(app).join(DATA_FILE),
        content,
        expected_revision,
    );
    if result
        .as_ref()
        .is_err_and(|failure| failure.code == DataOperationFailureCode::ExternalConflict)
    {
        update_runtime_metadata(app, |metadata| {
            metadata.last_conflict_at_ms = Some(now_ms());
            metadata.conflict_pending = true;
        });
    }
    result
}

pub fn clear_data_conflict(app: &AppHandle) {
    update_runtime_metadata(app, |metadata| metadata.conflict_pending = false);
}

pub fn mark_data_conflict(app: &AppHandle) -> Result<(), DataOperationFailure> {
    let mut metadata = read_runtime_metadata(app);
    metadata.last_conflict_at_ms = Some(now_ms());
    metadata.conflict_pending = true;
    let bytes = serde_json::to_vec_pretty(&metadata).map_err(|error| DataOperationFailure {
        code: DataOperationFailureCode::WriteFailed,
        message: format!("序列化数据冲突状态失败：{error}"),
    })?;
    data_integrity::atomic_write_file(
        &runtime_metadata_path(app),
        &bytes,
        DataOperationFailureCode::WriteFailed,
    )
}

pub fn export_complete_backup(
    app: &AppHandle,
    destination: &Path,
    state_json: &str,
    created_at_ms: u64,
    expected_revision: Option<&str>,
) -> Result<crate::backup::BackupInspection, crate::backup::BackupFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    if storage.runtime.lock().unwrap().pending.is_some() || recovery_required(app) {
        return Err(crate::backup::BackupFailure {
            code: crate::backup::BackupFailureCode::OperationInProgress,
            message: "数据目录事务进行中，已阻止备份读取".into(),
        });
    }
    let source_changed = |message: String| {
        update_runtime_metadata(app, |metadata| {
            metadata.last_conflict_at_ms = Some(now_ms());
            metadata.conflict_pending = true;
        });
        crate::backup::BackupFailure {
            code: crate::backup::BackupFailureCode::SourceChanged,
            message,
        }
    };
    let before = read_data_snapshot(app)
        .map_err(|failure| source_changed(failure.message))?;
    if expected_revision.is_some_and(|expected| expected != before.revision) {
        return Err(source_changed(
            "活动数据自冻结后已变化；已阻止导出陈旧内存".into(),
        ));
    }
    let inspection = crate::backup::export_complete_backup(
        &data_dir(app),
        destination,
        state_json,
        &app.package_info().version.to_string(),
        created_at_ms,
    )?;
    let source_stable = read_data_snapshot(app)
        .is_ok_and(|after| after.revision == before.revision);
    let result = crate::backup::finalize_export_destination(
        destination,
        &inspection.archive_revision,
        source_stable,
    );
    if result
        .as_ref()
        .is_err_and(|failure| failure.code == crate::backup::BackupFailureCode::SourceChanged)
    {
        update_runtime_metadata(app, |metadata| {
            metadata.last_conflict_at_ms = Some(now_ms());
            metadata.conflict_pending = true;
        });
    }
    result?;
    Ok(inspection)
}

/// 导出人类可读的 Markdown + 媒体 ZIP。与数据目录事务共用写闸，确保导出
/// 期间活动目录不会切换、媒体也不会被 GC 隔离。
pub fn export_notes_bundle(
    app: &AppHandle,
    destination: &Path,
    markdown: &str,
    media_files: &[String],
) -> Result<(), crate::note_export::NoteExportFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    let transaction_pending = { storage.runtime.lock().unwrap().pending.is_some() };
    if transaction_pending || recovery_required(app) {
        return Err(
            crate::note_export::NoteExportFailure::operation_in_progress(
                "数据目录事务或恢复进行中，已阻止笔记导出",
            ),
        );
    }
    crate::note_export::export_notes_bundle(
        &data_dir(app).join(MEDIA_DIR),
        destination,
        markdown,
        media_files,
    )
}

pub fn export_conflict_recovery_backup(
    app: &AppHandle,
    destination: &Path,
    state_json: &str,
    created_at_ms: u64,
) -> Result<crate::backup::BackupInspection, crate::backup::BackupFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    if storage.runtime.lock().unwrap().pending.is_some() || recovery_required(app) {
        return Err(crate::backup::BackupFailure {
            code: crate::backup::BackupFailureCode::OperationInProgress,
            message: "数据目录事务进行中，已阻止恢复副本读取".into(),
        });
    }
    if !read_runtime_metadata(app).conflict_pending {
        return Err(crate::backup::BackupFailure {
            code: crate::backup::BackupFailureCode::InvalidState,
            message: "当前没有待处理的数据冲突".into(),
        });
    }
    let inspection = crate::backup::export_conflict_recovery_backup(
        &data_dir(app),
        destination,
        state_json,
        &app.package_info().version.to_string(),
        created_at_ms,
    )?;
    crate::backup::finalize_export_destination(
        destination,
        &inspection.archive_revision,
        true,
    )?;
    Ok(inspection)
}

fn runtime_metadata_path(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join(DATA_META_FILE)
}

fn read_runtime_metadata(app: &AppHandle) -> DataRuntimeMetadata {
    data_integrity::read_regular_file(&runtime_metadata_path(app), 1024 * 1024)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn update_runtime_metadata(app: &AppHandle, update: impl FnOnce(&mut DataRuntimeMetadata)) {
    let mut metadata = read_runtime_metadata(app);
    update(&mut metadata);
    if let Ok(bytes) = serde_json::to_vec_pretty(&metadata) {
        let _ = data_integrity::atomic_write_file(
            &runtime_metadata_path(app),
            &bytes,
            DataOperationFailureCode::WriteFailed,
        );
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

pub(crate) fn content_hash(width: usize, height: usize, rgba: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update((width as u64).to_le_bytes());
    digest.update((height as u64).to_le_bytes());
    digest.update((rgba.len() as u64).to_le_bytes());
    digest.update(rgba);
    let mut hex = String::with_capacity(64);
    for byte in digest.finalize() {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// 保存 RGBA 图片为 PNG，返回相对 media 目录的文件名。
/// 内容相同则复用已存在的文件（不重复写盘，供前端按文件名去重）。
pub fn save_image_rgba(
    app: &AppHandle,
    width: usize,
    height: usize,
    rgba: &[u8],
) -> Result<String, String> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    if storage.runtime.lock().unwrap().pending.is_some() || recovery_required(app) {
        return Err("数据目录事务进行中，已阻止媒体写入".into());
    }
    let expected_len = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or("图片尺寸溢出")?;
    if width == 0 || height == 0 || rgba.len() != expected_len {
        return Err("图片数据尺寸不匹配".into());
    }
    let width_u32 = u32::try_from(width).map_err(|_| "图片宽度过大")?;
    let height_u32 = u32::try_from(height).map_err(|_| "图片高度过大")?;
    let name = format!("img-{}.png", content_hash(width, height, rgba));
    let path = verified_media_dir(app)
        .ok_or("媒体目录不是活动数据目录内的普通目录")?
        .join(&name);
    if path.exists() {
        if let Some(bytes) = read_regular_media_file(&path) {
            if let Ok(existing) = image::load_from_memory(&bytes) {
                let existing = existing.to_rgba8();
                if existing.width() == width_u32
                    && existing.height() == height_u32
                    && existing.as_raw() == rgba
                {
                    return Ok(name);
                }
            }
        }
        let quarantine = path.with_file_name(format!(
            ".toskr-invalid-image-{}-{}.png",
            std::process::id(),
            now_ms()
        ));
        fs::rename(&path, quarantine)
            .map_err(|error| format!("隔离损坏的内容寻址图片失败：{error}"))?;
        File::open(path.parent().ok_or("图片路径没有父目录")?)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("同步图片隔离目录失败：{error}"))?;
    }
    let buf = image::RgbaImage::from_raw(width_u32, height_u32, rgba.to_vec())
        .ok_or("图片数据尺寸不匹配")?;
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(buf)
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let mut file = options
        .open(&path)
        .map_err(|error| format!("创建内容寻址图片失败：{error}"))?;
    file.write_all(png.get_ref()).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    File::open(path.parent().ok_or("图片路径没有父目录")?)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("同步图片目录失败：{error}"))?;
    Ok(name)
}

/// 按扩展名判断本地路径是否为可导入图片（与 image crate 已启用的解码器一致；
/// HEIC 等无解码器的格式刻意不认，避免读了字节才失败）。
pub fn is_image_file_path(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());
    matches!(
        ext.as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp")
    )
}

/// 单文件解码上限：防拖入超大文件把解码内存打爆。
const MAX_IMPORT_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

/// 本地图片文件导入：解码为 RGBA 后走 save_image_rgba（像素哈希去重，
/// 同图重复导入复用同一文件名）。返回 (媒体文件名, 宽, 高)。
pub fn import_image_file(app: &AppHandle, path: &str) -> Result<(String, u32, u32), String> {
    if !is_image_file_path(path) {
        return Err("不支持的图片格式".into());
    }
    let meta = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !meta.is_file() {
        return Err("不是普通文件".into());
    }
    if meta.len() > MAX_IMPORT_IMAGE_BYTES {
        return Err("图片超过 64MB 上限".into());
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let decoded = image::load_from_memory(&bytes).map_err(|error| error.to_string())?;
    let rgba = decoded.to_rgba8();
    let (width, height) = (rgba.width(), rgba.height());
    let file = save_image_rgba(app, width as usize, height as usize, rgba.as_raw())?;
    Ok((file, width, height))
}

fn safe_media_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && Path::new(name).components().count() == 1
}

fn verified_media_dir(app: &AppHandle) -> Option<PathBuf> {
    let root = fs::canonicalize(data_dir(app)).ok()?;
    let media = data_dir(app).join(MEDIA_DIR);
    let metadata = fs::symlink_metadata(&media).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return None;
    }
    let resolved = fs::canonicalize(&media).ok()?;
    (resolved.parent() == Some(root.as_path())).then_some(resolved)
}

fn read_regular_media_file(path: &Path) -> Option<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 1024 * 1024 * 1024 {
        return None;
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let mut file = options.open(path).ok()?;
    let mut bytes = Vec::with_capacity(metadata.len().min(16 * 1024 * 1024) as usize);
    std::io::Read::by_ref(&mut file)
        .take(1024 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= 1024 * 1024 * 1024).then_some(bytes)
}

pub fn inspect_media_integrity(
    app: &AppHandle,
    state_json: &str,
) -> Result<data_integrity::MediaIntegrityReport, DataOperationFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    if storage.runtime.lock().unwrap().pending.is_some() || recovery_required(app) {
        return Err(operation_in_progress());
    }
    data_integrity::scan_media_integrity(&data_dir(app), state_json)
}

pub fn schedule_media_gc(
    app: &AppHandle,
    files: &[String],
    not_before_ms: u64,
) -> Result<(), DataOperationFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    if storage.runtime.lock().unwrap().pending.is_some() || recovery_required(app) {
        return Err(operation_in_progress());
    }
    data_integrity::schedule_media_gc(&data_dir(app), files, not_before_ms)
}

pub fn run_media_gc(
    app: &AppHandle,
    state_json: &str,
    now_ms: u64,
    expected_revision: &str,
) -> Result<data_integrity::MediaGcResult, DataOperationFailure> {
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    if storage.runtime.lock().unwrap().pending.is_some() || recovery_required(app) {
        return Err(operation_in_progress());
    }
    let snapshot = read_data_snapshot(app)?;
    if snapshot.revision != expected_revision {
        update_runtime_metadata(app, |metadata| {
            metadata.last_conflict_at_ms = Some(now_ms);
            metadata.conflict_pending = true;
        });
        return Err(DataOperationFailure {
            code: DataOperationFailureCode::ExternalConflict,
            message: "媒体 GC 前活动数据 revision 已变化；未删除媒体".into(),
        });
    }
    let authoritative_state = snapshot
        .content
        .as_deref()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(content).ok())
        .and_then(|bag| bag.get("toskr").and_then(serde_json::Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| "{}".into());
    let result = data_integrity::run_media_gc(
        &data_dir(app),
        &authoritative_state,
        state_json,
        now_ms,
        || {
            let current = read_data_snapshot(app)?;
            if current.revision == expected_revision {
                Ok(())
            } else {
                Err(DataOperationFailure {
                    code: DataOperationFailureCode::ExternalConflict,
                    message: "媒体 GC 提交边界检测到活动数据变化；已恢复隔离媒体".into(),
                })
            }
        },
    );
    if result
        .as_ref()
        .is_err_and(|failure| failure.code == DataOperationFailureCode::ExternalConflict)
    {
        update_runtime_metadata(app, |metadata| {
            metadata.last_conflict_at_ms = Some(now_ms);
            metadata.conflict_pending = true;
        });
    }
    result
}

/// 读取图片为 data URL（前端 <img> 直接用；不存在返回 None）。
pub fn image_data_url(app: &AppHandle, name: &str) -> Option<String> {
    use base64::Engine;
    // 只允许纯文件名，杜绝路径穿越
    if !safe_media_name(name) {
        return None;
    }
    let bytes = read_regular_media_file(&verified_media_dir(app)?.join(name))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:image/png;base64,{b64}"))
}

/// 卡片缩略图 data URL：按需生成并落盘缓存（media/thumbs/<name>，最长边 320px）。
/// 原图按像素哈希命名不可变 → 缩略图永不失效。全尺寸解码只发生一次；
/// 之后前端拿到的是 KB 级小图，卡片列表滚动/切页不再反复解码大位图。
pub fn image_thumb_data_url(app: &AppHandle, name: &str) -> Option<String> {
    use base64::Engine;
    if !safe_media_name(name) {
        return None;
    }
    let storage = app.state::<Storage>();
    let _write = storage.write_gate.lock().unwrap();
    let cache_writable = storage.runtime.lock().unwrap().pending.is_none()
        && !recovery_required(app);
    let media = verified_media_dir(app)?;
    let tdir = media.join("thumbs");
    if tdir.exists() {
        let metadata = fs::symlink_metadata(&tdir).ok()?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return None;
        }
    }
    let tpath = tdir.join(name);
    if !tpath.exists() {
        let src = media.join(name);
        let source_bytes = read_regular_media_file(&src)?;
        let img = image::load_from_memory(&source_bytes).ok()?;
        if img.width() <= 320 && img.height() <= 320 {
            // 小图直接用原图，不再多存一份
            let b64 = base64::engine::general_purpose::STANDARD.encode(source_bytes);
            return Some(format!("data:image/png;base64,{b64}"));
        }
        let thumb = img.thumbnail(320, 320);
        let mut png = std::io::Cursor::new(Vec::new());
        thumb.write_to(&mut png, image::ImageFormat::Png).ok()?;
        if !cache_writable {
            let b64 = base64::engine::general_purpose::STANDARD.encode(png.get_ref());
            return Some(format!("data:image/png;base64,{b64}"));
        }
        if !tdir.exists() {
            fs::create_dir(&tdir).ok()?;
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW);
        let mut file = options.open(&tpath).ok()?;
        file.write_all(png.get_ref()).ok()?;
        file.sync_all().ok()?;
        File::open(&tdir).ok()?.sync_all().ok()?;
    }
    let bytes = read_regular_media_file(&tpath)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:image/png;base64,{b64}"))
}

/// 读取图片附件原始字节（OCR 用；不存在返回 None）。
pub fn read_image_bytes(app: &AppHandle, name: &str) -> Option<Vec<u8>> {
    if !safe_media_name(name) {
        return None;
    }
    read_regular_media_file(&verified_media_dir(app)?.join(name))
}

/// 读取图片附件为 RGBA 像素（写入剪贴板用）。
pub fn read_image_rgba(app: &AppHandle, name: &str) -> Option<(usize, usize, Vec<u8>)> {
    if !safe_media_name(name) {
        return None;
    }
    let bytes = read_regular_media_file(&verified_media_dir(app)?.join(name))?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    Some((w, h, img.into_raw()))
}

/// 图片附件绝对路径（Quick Look 预览用；含文件名安全检查，不存在返回 None）。
pub fn image_path(app: &AppHandle, name: &str) -> Option<std::path::PathBuf> {
    if !safe_media_name(name) {
        return None;
    }
    let p = verified_media_dir(app)?.join(name);
    fs::symlink_metadata(&p)
        .ok()
        .filter(|metadata| !metadata.file_type().is_symlink() && metadata.is_file())
        .map(|_| p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn image_identity_hashes_every_pixel_byte_and_dimensions() {
        let mut first = vec![0_u8; 4096 * 4];
        let mut second = first.clone();
        second[137] = 1;

        assert_ne!(content_hash(64, 64, &first), content_hash(64, 64, &second));
        first[137] = 1;
        assert_ne!(content_hash(64, 64, &first), content_hash(32, 128, &first));
        assert_eq!(content_hash(64, 64, &first).len(), 64);
    }

    #[test]
    fn image_file_paths_filter_by_decodable_extension() {
        for good in [
            "/Users/kai/图 片/猫 咪.PNG",
            "/tmp/a.jpeg",
            "/tmp/b.jpg",
            "/tmp/c.webp",
            "/tmp/d.gif",
            "/tmp/e.bmp",
        ] {
            assert!(is_image_file_path(good), "{good}");
        }
        for bad in [
            "/tmp/a.heic",
            "/tmp/b.pdf",
            "/tmp/noext",
            "/tmp/a.png.txt",
            "/tmp/dir.png/file",
        ] {
            assert!(!is_image_file_path(bad), "{bad}");
        }
    }

    #[test]
    fn media_names_are_single_relative_components() {
        assert!(safe_media_name("img-deadbeef.png"));
        for unsafe_name in ["", "../x.png", "a/b.png", "a\\b.png", ".hidden..png"] {
            assert!(!safe_media_name(unsafe_name));
        }
    }

    #[test]
    fn complete_import_translates_business_revision_to_a_managed_baseline() {
        let root = tempdir().unwrap();
        let active = root.path().join("active");
        fs::create_dir_all(active.join(MEDIA_DIR)).unwrap();
        let persisted = serde_json::json!({
            "state": {
                "sections": [],
                "notes": [],
                "tasks": [],
                "taskSections": [],
                "settings": {}
            },
            "version": 8
        });
        fs::write(
            active.join(DATA_FILE),
            serde_json::json!({"toskr": persisted.to_string()}).to_string(),
        )
        .unwrap();
        fs::write(active.join(MEDIA_DIR).join("a.png"), b"media").unwrap();
        let business = data_integrity::read_data_snapshot(&active.join(DATA_FILE)).unwrap();

        let managed = import_managed_baseline(&active, &business.revision).unwrap();

        assert_ne!(managed, business.revision);
        assert_eq!(
            Some(managed),
            data_integrity::inspect_location(&active, None).revision
        );
        assert_eq!(
            import_managed_baseline(&active, "stale").unwrap_err().code,
            "sourceChanged"
        );
    }

    #[test]
    fn explicit_default_recovery_materializes_a_valid_empty_dataset() {
        let root = tempdir().unwrap();
        let base = root.path().join("default");
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join(DIR_CONFIG), b"/offline/custom").unwrap();

        ensure_default_dataset(&base).unwrap();
        fs::write(base.join(".toskr-datadir-recovery-1"), b"/offline/custom").unwrap();

        let inspection = data_integrity::inspect_location(&base, None);
        assert_eq!(inspection.kind, data_integrity::DataLocationKind::Valid);
        assert_eq!(inspection.ordinary_file_count, 0);
    }
}
