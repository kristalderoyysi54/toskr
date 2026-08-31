//! 版本化完整备份容器。
//!
//! 容器是单文件 ZIP，但只使用 Stored 模式，避免大媒体在导出时产生额外内存峰值。
//! 所有路径、大小、hash、重复项与 symlink 属性都在导入前 fail-closed 校验。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::data_integrity::{
    validate_note_provenance, validate_settings_value, validate_settings_value_for_version,
    MAX_STORE_VERSION,
};
use crate::storage::{DATA_FILE, MEDIA_DIR};

pub const BACKUP_SCHEMA_VERSION: u64 = 1;
const STATE_PATH: &str = "state/toskr-state.json";
const MANIFEST_PATH: &str = "manifest.json";
const MAX_ARCHIVE_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupFormat {
    Complete,
    LegacyJson,
    /// 当前活动数据文件（Data AAD 的 TSK1 信封）；不是可直接合并的旧 JSON。
    NativeData,
    /// 加密迁移前自动留下的原始索引保险档（Recovery AAD + outer bag JSON）。
    PreEncryptSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupFailureCode {
    ExternalConflict,
    SourceChanged,
    DestinationChanged,
    InvalidState,
    ForbiddenField,
    MissingMedia,
    DestinationExists,
    IoFailed,
    CorruptArchive,
    InvalidManifest,
    UnsupportedSchema,
    HashMismatch,
    PathTraversal,
    DuplicatePath,
    SymlinkRejected,
    FileTooLarge,
    OperationInProgress,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFailure {
    pub code: BackupFailureCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCounts {
    pub sections: usize,
    pub notes: usize,
    pub task_sections: usize,
    pub tasks: usize,
    /// v19 起的账单域；旧 manifest 无此键，默认 0 保持可读。
    #[serde(default)]
    pub bills: usize,
    /// v20 起的外部消息结构化投影；旧 manifest 无此键时按 0。
    #[serde(default)]
    pub messages: usize,
    pub media: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub backup_schema_version: u64,
    pub store_schema_version: u64,
    pub created_at_ms: u64,
    pub app_version: String,
    pub counts: BackupCounts,
    pub files: Vec<BackupFileEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInspection {
    pub format: BackupFormat,
    /// NativeData 时供前端转入“数据文件夹预检”；其他格式为空。
    pub source_directory: Option<String>,
    pub archive_revision: String,
    pub backup_schema_version: Option<u64>,
    pub store_schema_version: Option<u64>,
    pub app_version: Option<String>,
    pub created_at_ms: Option<u64>,
    pub counts: BackupCounts,
    pub missing_media: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
struct StateSummary {
    store_version: u64,
    counts: BackupCounts,
    media: BTreeSet<String>,
}

/// 用户主动导出的完整备份**刻意保持明文 ZIP**：这是跨机迁移与钥匙串丢失时
/// 的唯一逃生通道。`seal_archive=true` 仅用于应用内部的自动恢复备份
/// （recovery/），整包封 Recovery 信封，只有本机密钥能解开。
pub fn export_complete_backup(
    data_dir: &Path,
    destination: &Path,
    state_json: &str,
    app_version: &str,
    created_at_ms: u64,
    seal_archive: bool,
) -> Result<BackupInspection, BackupFailure> {
    export_backup_inner(
        data_dir,
        destination,
        state_json,
        app_version,
        created_at_ms,
        false,
        seal_archive,
    )
}

pub fn export_conflict_recovery_backup(
    data_dir: &Path,
    destination: &Path,
    state_json: &str,
    app_version: &str,
    created_at_ms: u64,
) -> Result<BackupInspection, BackupFailure> {
    export_backup_inner(
        data_dir,
        destination,
        state_json,
        app_version,
        created_at_ms,
        true,
        false,
    )
}

fn export_backup_inner(
    data_dir: &Path,
    destination: &Path,
    state_json: &str,
    app_version: &str,
    created_at_ms: u64,
    require_content_identity: bool,
    seal_archive: bool,
) -> Result<BackupInspection, BackupFailure> {
    if destination.exists() {
        return Err(failure(
            BackupFailureCode::DestinationExists,
            "目标备份文件已存在；为防止误覆盖，请选择新文件名",
        ));
    }
    let state_value: Value = serde_json::from_str(state_json).map_err(|error| {
        failure(
            BackupFailureCode::InvalidState,
            format!("业务状态 JSON 无效：{error}"),
        )
    })?;
    reject_forbidden_fields(&state_value)?;
    let summary = summarize_state(&state_value)?;
    if summary.media.len().saturating_add(2) > MAX_ARCHIVE_ENTRIES {
        return Err(failure(
            BackupFailureCode::FileTooLarge,
            "备份条目数量超过 100000",
        ));
    }
    let state_bytes = serde_json::to_vec_pretty(&state_value).map_err(json_failure)?;
    if state_bytes.len() as u64 > MAX_ARCHIVE_FILE_BYTES {
        return Err(failure(
            BackupFailureCode::FileTooLarge,
            "业务状态超过 256 MiB",
        ));
    }
    let mut total_bytes = state_bytes.len() as u64;
    let mut files = vec![BackupFileEntry {
        path: STATE_PATH.into(),
        sha256: sha256_hex(&state_bytes),
        size: state_bytes.len() as u64,
        kind: "state".into(),
    }];
    let mut media_files = Vec::new();
    let mut missing = Vec::new();
    for name in &summary.media {
        validate_media_name(name)?;
        let path = data_dir.join(MEDIA_DIR).join(name);
        let metadata = fs::symlink_metadata(&path).map_err(|_| {
            missing.push(name.clone());
            failure(BackupFailureCode::MissingMedia, "备份存在缺失媒体")
        });
        let Ok(metadata) = metadata else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(failure(
                BackupFailureCode::SymlinkRejected,
                format!("媒体不是普通文件：{name}"),
            ));
        }
        // 磁盘上是加密信封（+33B 开销），预检上限按信封长度放宽；明文尺寸
        // 由 sha256_file 解密后精确校验
        if metadata.len() > MAX_ARCHIVE_FILE_BYTES + crate::data_crypto::ENVELOPE_OVERHEAD as u64 {
            return Err(failure(
                BackupFailureCode::FileTooLarge,
                format!("媒体文件超过 256 MiB：{name}"),
            ));
        }
        let (sha256, size) = sha256_file(&path)?;
        if size > MAX_ARCHIVE_FILE_BYTES {
            return Err(failure(
                BackupFailureCode::FileTooLarge,
                format!("媒体文件超过 256 MiB：{name}"),
            ));
        }
        if require_content_identity {
            verify_content_addressed_media(&path, name)?;
        }
        total_bytes = total_bytes
            .checked_add(size)
            .ok_or_else(|| failure(BackupFailureCode::FileTooLarge, "备份内容总大小溢出"))?;
        if total_bytes > MAX_ARCHIVE_TOTAL_BYTES {
            return Err(failure(
                BackupFailureCode::FileTooLarge,
                "完整备份内容总大小超过 1 GiB",
            ));
        }
        let relative = format!("media/{name}");
        files.push(BackupFileEntry {
            path: relative.clone(),
            sha256: sha256.clone(),
            size,
            kind: "media".into(),
        });
        media_files.push((relative, path, sha256, size));
    }
    if !missing.is_empty() {
        return Err(BackupFailure {
            code: BackupFailureCode::MissingMedia,
            message: format!("缺少 {} 个被引用媒体，未生成伪完整备份", missing.len()),
        });
    }
    let manifest = BackupManifest {
        backup_schema_version: BACKUP_SCHEMA_VERSION,
        store_schema_version: summary.store_version,
        created_at_ms,
        app_version: app_version.into(),
        counts: BackupCounts {
            media: summary.media.len(),
            ..summary.counts.clone()
        },
        files,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(json_failure)?;
    let parent = destination
        .parent()
        .ok_or_else(|| failure(BackupFailureCode::IoFailed, "备份目标没有父目录"))?;
    fs::create_dir_all(parent).map_err(io_failure)?;
    let tmp = parent.join(format!(
        ".{}.partial-{}-{created_at_ms}",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("toskr-backup"),
        std::process::id()
    ));
    let result = (|| {
        let mut tmp_options = OpenOptions::new();
        tmp_options.write(true).create_new(true);
        #[cfg(unix)]
        tmp_options.mode(0o600);
        let file = tmp_options.open(&tmp).map_err(io_failure)?;
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(0o600);
        writer
            .start_file(MANIFEST_PATH, options)
            .map_err(zip_failure)?;
        writer.write_all(&manifest_bytes).map_err(io_failure)?;
        writer
            .start_file(STATE_PATH, options)
            .map_err(zip_failure)?;
        writer.write_all(&state_bytes).map_err(io_failure)?;
        for (relative, path, expected_hash, expected_size) in &media_files {
            writer.start_file(relative, options).map_err(zip_failure)?;
            copy_file_and_verify(&mut writer, path, expected_hash, *expected_size)?;
        }
        let file = writer.finish().map_err(zip_failure)?;
        file.sync_all().map_err(io_failure)?;
        drop(file);
        let publish = if seal_archive {
            // 自动恢复备份整包封 Recovery 信封（AES-GCM 无流式，整包读入内存
            // 一次；恢复备份仅在数据目录事务前生成，属低频路径）
            let zip_bytes = fs::read(&tmp).map_err(io_failure)?;
            let sealed = crate::data_crypto::seal(crate::data_crypto::Purpose::Recovery, &zip_bytes)
                .map_err(|error| {
                    failure(
                        BackupFailureCode::IoFailed,
                        format!("封装恢复备份失败：{}", error.message()),
                    )
                })?;
            drop(zip_bytes);
            let sealed_tmp = sealed_tmp_path(&tmp);
            write_new_file(&sealed_tmp, &sealed)?;
            fs::remove_file(&tmp).map_err(io_failure)?;
            sealed_tmp
        } else {
            tmp.clone()
        };
        // ownership 必须来自仍由本事务持有的 tmp inode，不能发布后再从
        // destination 反推；外部 writer 可能在 hard-link 发布后立即换路径。
        let owned_revision = archive_revision(&publish)?;
        commit_without_overwrite(&publish, destination)?;
        let _ = File::open(parent).and_then(|directory| directory.sync_all());
        if archive_revision(destination).ok().as_deref() != Some(owned_revision.as_str()) {
            return Err(failure(
                BackupFailureCode::DestinationChanged,
                "备份目标在发布后被外部替换；未把外部版本认作成功备份",
            ));
        }
        fs::remove_file(&publish).map_err(io_failure)?;
        let mut inspection = inspection_from_manifest(&manifest, Vec::new());
        inspection.archive_revision = owned_revision;
        Ok(inspection)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_file(sealed_tmp_path(&tmp));
    }
    result
}

fn sealed_tmp_path(tmp: &Path) -> PathBuf {
    let name = tmp
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("toskr-backup.partial");
    tmp.with_file_name(format!("{name}-sealed"))
}

fn verify_content_addressed_media(path: &Path, name: &str) -> Result<(), BackupFailure> {
    let expected = name
        .strip_prefix("img-")
        .and_then(|value| value.strip_suffix(".png"))
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            failure(
                BackupFailureCode::SourceChanged,
                format!("媒体缺少可证明的内容身份：{name}"),
            )
        })?;
    let bytes = read_media_plaintext(path)?;
    let image = image::load_from_memory(&bytes).map_err(|_| {
        failure(
            BackupFailureCode::SourceChanged,
            format!("媒体无法验证内容身份：{name}"),
        )
    })?;
    let rgba = image.to_rgba8();
    let actual = crate::storage::content_hash(
        rgba.width() as usize,
        rgba.height() as usize,
        rgba.as_raw(),
    );
    if actual != expected {
        return Err(failure(
            BackupFailureCode::SourceChanged,
            format!("媒体内容已被外部替换：{name}"),
        ));
    }
    Ok(())
}

static EXPORT_CAPTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn export_capture_path(destination: &Path) -> Result<PathBuf, BackupFailure> {
    let parent = destination
        .parent()
        .ok_or_else(|| failure(BackupFailureCode::IoFailed, "备份目标没有父目录"))?;
    let sequence = EXPORT_CAPTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    Ok(parent.join(format!(
        ".toskr-export-capture-{}-{nanos}-{sequence}",
        std::process::id()
    )))
}

fn capture_export_destination(destination: &Path) -> Result<PathBuf, BackupFailure> {
    for _ in 0..8 {
        let capture = export_capture_path(destination)?;
        match crate::data_integrity::rename_no_replace(destination, &capture) {
            Ok(()) => return Ok(capture),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_failure(error)),
        }
    }
    Err(failure(
        BackupFailureCode::IoFailed,
        "无法分配备份所有权校验隔离路径",
    ))
}

fn restore_captured_destination(capture: &Path, destination: &Path) -> bool {
    let restored = crate::data_integrity::rename_no_replace(capture, destination).is_ok();
    if restored {
        if let Some(parent) = destination.parent() {
            let _ = File::open(parent).and_then(|directory| directory.sync_all());
        }
    }
    restored
}

/// 导出末端的路径所有权门禁。
///
/// 先原子捕获当前路径，再对捕获到的 inode 做 revision 校验。这样即使外部 writer
/// 在校验窗口抢写，也只会让操作失败并保留双方版本，不会误删外部文件。
pub(crate) fn finalize_export_destination(
    destination: &Path,
    owned_revision: &str,
    source_stable: bool,
) -> Result<(), BackupFailure> {
    let capture = match capture_export_destination(destination) {
        Ok(capture) => capture,
        Err(error) => {
            return Err(failure(
                if source_stable {
                    BackupFailureCode::DestinationChanged
                } else {
                    BackupFailureCode::SourceChanged
                },
                format!("导出末端无法捕获备份目标：{}", error.message),
            ));
        }
    };
    let captured_is_owned = archive_revision(&capture)
        .ok()
        .as_deref()
        == Some(owned_revision);

    if !source_stable {
        if captured_is_owned {
            fs::remove_file(&capture).map_err(io_failure)?;
            if let Some(parent) = destination.parent() {
                let _ = File::open(parent).and_then(|directory| directory.sync_all());
            }
            return Err(failure(
                BackupFailureCode::SourceChanged,
                "导出期间活动数据发生外部变化；仅移除了本事务拥有的不一致备份",
            ));
        }
        let restored = restore_captured_destination(&capture, destination);
        return Err(failure(
            BackupFailureCode::SourceChanged,
            if restored {
                "导出期间活动数据和目标文件均发生外部变化；外部目标已原样保留"
            } else {
                "导出期间活动数据和目标文件均发生外部变化；外部目标已保留在隔离路径"
            },
        ));
    }

    if !captured_is_owned {
        let restored = restore_captured_destination(&capture, destination);
        return Err(failure(
            BackupFailureCode::DestinationChanged,
            if restored {
                "备份目标在导出后被外部替换；外部版本已原样保留"
            } else {
                "备份目标在导出后被外部替换；外部版本已保留在隔离路径"
            },
        ));
    }
    if !restore_captured_destination(&capture, destination)
        || archive_revision(destination).ok().as_deref() != Some(owned_revision)
    {
        return Err(failure(
            BackupFailureCode::DestinationChanged,
            "备份目标在最终所有权校验期间发生外部变化；未报告成功",
        ));
    }
    Ok(())
}

pub fn inspect_backup(path: &Path) -> Result<BackupInspection, BackupFailure> {
    let mut probe = open_regular_nofollow(path, MAX_ARCHIVE_TOTAL_BYTES + 64 * 1024 * 1024)?;
    let mut magic = [0u8; 4];
    let sniffed = probe.read(&mut magic).map_err(io_failure)?;
    drop(probe);

    if sniffed == 4 && crate::data_crypto::looks_sealed(&magic) {
        let bytes = read_source_bytes(path, MAX_ARCHIVE_TOTAL_BYTES + 64 * 1024 * 1024)?;
        let revision = revision_for_bytes(&bytes);
        // TSK1 的 AAD 才是格式权威；扩展名可以被用户改名，不能据此把当前
        // Data 信封或 Recovery 保险档投给错误 reader。
        let data_error = match crate::data_crypto::open(crate::data_crypto::Purpose::Data, &bytes) {
            Ok(plain) => {
                return inspect_native_store(path, &plain, revision, BackupFormat::NativeData)
                    .map(|(_, inspection)| inspection);
            }
            Err(error) => error,
        };
        let plain = crate::data_crypto::open(crate::data_crypto::Purpose::Recovery, &bytes)
            .map_err(|recovery_error| {
                let error = if data_error.key_unavailable() {
                    data_error
                } else {
                    recovery_error
                };
                encrypted_source_failure("加密导入来源", error)
            })?;
        if let Ok((_, inspection)) = inspect_native_store(
            path,
            &plain,
            revision.clone(),
            BackupFormat::PreEncryptSnapshot,
        ) {
            return Ok(inspection);
        }
        return ZipArchive::new(Cursor::new(plain))
            .map_err(zip_failure)
            .and_then(|archive| {
                inspect_complete_archive(archive, MAX_ARCHIVE_FILE_BYTES, MAX_ARCHIVE_TOTAL_BYTES)
            })
            .map(|mut inspection| {
                inspection.archive_revision = revision;
                inspection
            });
    }

    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return inspect_legacy_json(path);
    }
    let (file, revision) = open_archive_with_revision(path)?;
    match ZipArchive::new(file) {
        Ok(archive) => inspect_complete_archive(
            archive,
            MAX_ARCHIVE_FILE_BYTES,
            MAX_ARCHIVE_TOTAL_BYTES,
        )
        .map(|mut inspection| {
            inspection.archive_revision = revision;
            inspection
        }),
        Err(error) => Err(failure(
            BackupFailureCode::CorruptArchive,
            format!("完整备份容器损坏：{error}"),
        )),
    }
}

fn read_source_bytes(path: &Path, max: u64) -> Result<Vec<u8>, BackupFailure> {
    let mut file = open_regular_nofollow(path, max)?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(io_failure)?;
    if bytes.len() as u64 > max {
        return Err(failure(
            BackupFailureCode::FileTooLarge,
            "导入来源超过允许大小",
        ));
    }
    Ok(bytes)
}

fn encrypted_source_failure(label: &str, error: crate::data_crypto::CryptoError) -> BackupFailure {
    failure(
        BackupFailureCode::CorruptArchive,
        format!("{label}无法解锁：{}", error.message()),
    )
}

fn inspect_native_store(
    path: &Path,
    plain: &[u8],
    revision: String,
    format: BackupFormat,
) -> Result<(String, BackupInspection), BackupFailure> {
    let bag: Value = serde_json::from_slice(plain).map_err(|error| {
        failure(
            BackupFailureCode::InvalidState,
            format!("原生数据 outer bag 无效：{error}"),
        )
    })?;
    let bag = bag
        .as_object()
        .ok_or_else(|| failure(BackupFailureCode::InvalidState, "原生数据顶层必须是对象"))?;
    let (store_key, persisted) = match bag.get("toskr") {
        Some(Value::String(value)) => ("toskr", value.as_str()),
        Some(_) => {
            return Err(failure(
                BackupFailureCode::InvalidState,
                "原生数据 toskr 状态包类型无效",
            ));
        }
        None => match bag.get("copper") {
            Some(Value::String(value)) => ("copper", value.as_str()),
            Some(_) => {
                return Err(failure(
                    BackupFailureCode::InvalidState,
                    "原生数据 copper 状态包类型无效",
                ));
            }
            None => {
                return Err(failure(
                    BackupFailureCode::InvalidState,
                    "原生数据缺少 toskr/copper 状态包",
                ));
            }
        },
    };
    let envelope: Value = serde_json::from_str(persisted).map_err(|error| {
        failure(
            BackupFailureCode::InvalidState,
            format!("原生数据状态 envelope 无效：{error}"),
        )
    })?;
    let version = envelope
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| failure(BackupFailureCode::InvalidState, "原生数据缺少 version"))?;
    let state = envelope
        .get("state")
        .cloned()
        .ok_or_else(|| failure(BackupFailureCode::InvalidState, "原生数据缺少 state"))?;
    let summary = summarize_state(&serde_json::json!({
        "storeVersion": version,
        "state": state,
    }))?;
    let mut warnings = match format {
        BackupFormat::NativeData => {
            vec!["这是加密活动数据文件，不是旧 JSON；将转为预检它所在的数据文件夹".into()]
        }
        BackupFormat::PreEncryptSnapshot => vec![
            "这是加密迁移前自动保留的索引保险档；恢复前会先备份当前数据并按 ID 保留新增记录".into(),
        ],
        _ => Vec::new(),
    };
    if store_key == "copper" {
        warnings.push("检测到旧版 copper 状态别名，恢复时会迁为 toskr".into());
    }
    let counts = BackupCounts {
        media: summary.media.len(),
        ..summary.counts
    };
    let canonical_native_path = format == BackupFormat::NativeData
        && path.file_name().is_some_and(|name| name == DATA_FILE);
    if format == BackupFormat::NativeData && !canonical_native_path {
        warnings.push(
            "文件名不是 toskr-data.json；请复制到独立文件夹并改为标准文件名后再预检"
                .into(),
        );
    }
    Ok((
        persisted.to_string(),
        BackupInspection {
            format,
            source_directory: canonical_native_path
                .then(|| {
                    path.parent()
                        .map(|parent| parent.to_string_lossy().into_owned())
                })
                .flatten(),
            archive_revision: revision,
            backup_schema_version: None,
            store_schema_version: Some(summary.store_version),
            app_version: None,
            created_at_ms: None,
            counts,
            missing_media: Vec::new(),
            warnings,
        },
    ))
}

pub fn read_pre_encrypt_snapshot(
    path: &Path,
    expected_revision: &str,
) -> Result<String, BackupFailure> {
    let bytes = read_source_bytes(path, MAX_ARCHIVE_FILE_BYTES + 64 * 1024)?;
    let revision = revision_for_bytes(&bytes);
    ensure_archive_revision(&revision, expected_revision)?;
    if !crate::data_crypto::looks_sealed(&bytes) {
        return Err(failure(
            BackupFailureCode::InvalidState,
            "迁移保险档不是 TSK1 加密信封",
        ));
    }
    let plain = crate::data_crypto::open(crate::data_crypto::Purpose::Recovery, &bytes)
        .map_err(|error| encrypted_source_failure("迁移保险档", error))?;
    inspect_native_store(path, &plain, revision, BackupFormat::PreEncryptSnapshot)
        .map(|(persisted, _)| persisted)
}

fn validated_complete_archive(
    path: &Path,
    expected_revision: &str,
) -> Result<
    (
        ZipArchive<Box<dyn ReadSeek>>,
        BackupInspection,
        Vec<u8>,
        BackupManifest,
    ),
    BackupFailure,
> {
    let (file, revision) = open_archive_with_revision(path)?;
    ensure_archive_revision(&revision, expected_revision)?;
    let archive = ZipArchive::new(file).map_err(zip_failure)?;
    read_complete_archive(archive, MAX_ARCHIVE_FILE_BYTES, MAX_ARCHIVE_TOTAL_BYTES).map(
        |(archive, mut inspection, state, manifest)| {
            inspection.archive_revision = revision;
            (archive, inspection, state, manifest)
        },
    )
}

pub fn materialize_complete_backup(
    path: &Path,
    staging_dir: &Path,
    expected_revision: &str,
) -> Result<BackupInspection, BackupFailure> {
    if staging_dir.exists() {
        return Err(failure(
            BackupFailureCode::DestinationExists,
            "导入 staging 已存在",
        ));
    }
    let (mut archive, inspection, state_bytes, manifest) =
        validated_complete_archive(path, expected_revision)?;
    let declared = manifest
        .files
        .iter()
        .map(|entry| (entry.path.clone(), entry.clone()))
        .collect::<BTreeMap<_, _>>();
    let state: Value = serde_json::from_slice(&state_bytes).map_err(json_failure)?;
    let store_version = state
        .get("storeVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| failure(BackupFailureCode::InvalidState, "缺少 storeVersion"))?;
    let business_state = state
        .get("state")
        .cloned()
        .ok_or_else(|| failure(BackupFailureCode::InvalidState, "缺少 state"))?;
    let persisted = serde_json::json!({
        "state": business_state,
        "version": store_version,
    });
    let bag = serde_json::json!({"toskr": persisted.to_string()});
    let result = (|| {
        fs::create_dir_all(staging_dir.join(MEDIA_DIR)).map_err(io_failure)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(staging_dir, fs::Permissions::from_mode(0o700));
            let _ = fs::set_permissions(
                staging_dir.join(MEDIA_DIR),
                fs::Permissions::from_mode(0o700),
            );
        }
        // 备份包内是明文；落进 staging 前重新封信封（state 与媒体一致）
        let state_plain = serde_json::to_vec_pretty(&bag).map_err(json_failure)?;
        let state_sealed =
            crate::data_crypto::seal(crate::data_crypto::Purpose::Data, &state_plain)
                .map_err(crypto_backup_failure)?;
        write_new_file(&staging_dir.join(DATA_FILE), &state_sealed)?;
        let mut extracted_total = 0u64;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(zip_failure)?;
            if entry.is_dir() {
                continue;
            }
            let enclosed = entry
                .enclosed_name()
                .ok_or_else(|| failure(BackupFailureCode::PathTraversal, "归档路径越界"))?;
            let relative = normalized_relative_path(&enclosed)?;
            let Some(name) = relative.strip_prefix("media/") else {
                continue;
            };
            validate_media_name(name)?;
            let expected = declared.get(&relative).ok_or_else(|| {
                failure(
                    BackupFailureCode::InvalidManifest,
                    format!("manifest 未声明媒体：{relative}"),
                )
            })?;
            let output_path = staging_dir.join(MEDIA_DIR).join(name);
            // 先整条读入校验（单条已限 256MiB），hash/大小对上再封信封落盘；
            // 峰值内存仍是单个条目
            let mut content = Vec::new();
            let mut actual_size = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let read = entry.read(&mut buffer).map_err(io_failure)?;
                if read == 0 {
                    break;
                }
                actual_size = actual_size
                    .checked_add(read as u64)
                    .ok_or_else(|| failure(BackupFailureCode::FileTooLarge, "媒体解包大小溢出"))?;
                extracted_total = extracted_total.checked_add(read as u64).ok_or_else(|| {
                    failure(BackupFailureCode::FileTooLarge, "备份解包总大小溢出")
                })?;
                if actual_size > MAX_ARCHIVE_FILE_BYTES || extracted_total > MAX_ARCHIVE_TOTAL_BYTES
                {
                    return Err(failure(
                        BackupFailureCode::FileTooLarge,
                        "媒体实际解包大小超过安全上限",
                    ));
                }
                content.extend_from_slice(&buffer[..read]);
            }
            if actual_size != expected.size || sha256_hex(&content) != expected.sha256 {
                return Err(failure(
                    BackupFailureCode::HashMismatch,
                    format!("提取时媒体 hash/大小发生变化：{relative}"),
                ));
            }
            let sealed = crate::data_crypto::seal(crate::data_crypto::Purpose::Media, &content)
                .map_err(crypto_backup_failure)?;
            write_new_file(&output_path, &sealed)?;
        }
        File::open(staging_dir.join(MEDIA_DIR))
            .and_then(|directory| directory.sync_all())
            .map_err(io_failure)?;
        File::open(staging_dir)
            .and_then(|directory| directory.sync_all())
            .map_err(io_failure)?;
        if let Some(parent) = staging_dir.parent() {
            File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(io_failure)?;
        }
        ensure_archive_revision(&archive_revision(path)?, expected_revision)?;
        Ok(inspection)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging_dir);
    }
    result
}

fn inspect_complete_archive<R: Read + Seek>(
    archive: ZipArchive<R>,
    max_file: u64,
    max_total: u64,
) -> Result<BackupInspection, BackupFailure> {
    read_complete_archive(archive, max_file, max_total).map(|(_, inspection, _, _)| inspection)
}

#[derive(Debug)]
struct ObservedArchiveFile {
    sha256: String,
    size: u64,
}

fn read_complete_archive<R: Read + Seek>(
    mut archive: ZipArchive<R>,
    max_file: u64,
    max_total: u64,
) -> Result<(ZipArchive<R>, BackupInspection, Vec<u8>, BackupManifest), BackupFailure> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(failure(
            BackupFailureCode::FileTooLarge,
            "归档条目数量超过 100000",
        ));
    }
    let mut observed = BTreeMap::<String, ObservedArchiveFile>::new();
    let mut manifest_bytes = None;
    let mut state_bytes = None;
    let mut seen = BTreeSet::new();
    let mut seen_case_folded = BTreeSet::new();
    let mut declared_total = 0u64;
    let mut actual_total = 0u64;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(zip_failure)?;
        let raw_name = file.name().to_string();
        if file.is_symlink() {
            return Err(failure(
                BackupFailureCode::SymlinkRejected,
                format!("归档包含符号链接：{raw_name}"),
            ));
        }
        let enclosed = file.enclosed_name().ok_or_else(|| {
            failure(
                BackupFailureCode::PathTraversal,
                format!("归档路径越界：{raw_name}"),
            )
        })?;
        let normalized = normalized_relative_path(&enclosed)?;
        if !seen.insert(normalized.clone()) || !seen_case_folded.insert(normalized.to_lowercase()) {
            return Err(failure(
                BackupFailureCode::DuplicatePath,
                format!("归档包含重复路径：{normalized}"),
            ));
        }
        if file.is_dir() {
            continue;
        }
        if file.size() > max_file {
            return Err(failure(
                BackupFailureCode::FileTooLarge,
                format!("归档文件过大：{normalized}"),
            ));
        }
        declared_total = declared_total
            .checked_add(file.size())
            .ok_or_else(|| failure(BackupFailureCode::FileTooLarge, "归档总大小溢出"))?;
        if declared_total > max_total {
            return Err(failure(
                BackupFailureCode::FileTooLarge,
                "归档解包总大小超限",
            ));
        }
        let retain = normalized == MANIFEST_PATH || normalized == STATE_PATH;
        let mut retained = retain.then(|| Vec::with_capacity(file.size() as usize));
        let mut hasher = Sha256::new();
        let mut actual_size = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(io_failure)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            actual_size = actual_size
                .checked_add(read as u64)
                .ok_or_else(|| failure(BackupFailureCode::FileTooLarge, "归档文件大小溢出"))?;
            actual_total = actual_total.checked_add(read as u64).ok_or_else(|| {
                failure(BackupFailureCode::FileTooLarge, "归档实际解包总大小溢出")
            })?;
            if actual_size > max_file || actual_total > max_total {
                return Err(failure(
                    BackupFailureCode::FileTooLarge,
                    format!("归档实际解包大小超限：{normalized}"),
                ));
            }
            if let Some(bytes) = &mut retained {
                bytes.extend_from_slice(&buffer[..read]);
            }
        }
        if actual_size != file.size() {
            return Err(failure(
                BackupFailureCode::CorruptArchive,
                format!("归档文件解包大小不一致：{normalized}"),
            ));
        }
        if normalized == MANIFEST_PATH {
            manifest_bytes = retained;
        } else if normalized == STATE_PATH {
            state_bytes = retained;
        }
        observed.insert(
            normalized,
            ObservedArchiveFile {
                sha256: hex_digest(hasher.finalize()),
                size: actual_size,
            },
        );
    }
    let manifest_bytes = manifest_bytes
        .as_deref()
        .ok_or_else(|| failure(BackupFailureCode::InvalidManifest, "归档缺少 manifest.json"))?;
    let manifest: BackupManifest = serde_json::from_slice(manifest_bytes).map_err(|error| {
        failure(
            BackupFailureCode::InvalidManifest,
            format!("manifest.json 无效：{error}"),
        )
    })?;
    if manifest.backup_schema_version != BACKUP_SCHEMA_VERSION
        || manifest.store_schema_version > MAX_STORE_VERSION
    {
        return Err(failure(
            BackupFailureCode::UnsupportedSchema,
            "备份 schema 高于当前版本",
        ));
    }
    let mut declared = BTreeSet::new();
    let mut declared_case_folded = BTreeSet::new();
    for entry in &manifest.files {
        let path = normalized_relative_path(Path::new(&entry.path))?;
        if path == MANIFEST_PATH
            || !declared.insert(path.clone())
            || !declared_case_folded.insert(path.to_lowercase())
        {
            return Err(failure(
                BackupFailureCode::DuplicatePath,
                format!("manifest 路径重复或保留：{path}"),
            ));
        }
        let expected_kind = if path == STATE_PATH {
            "state"
        } else if let Some(name) = path.strip_prefix("media/") {
            validate_media_name(name)?;
            "media"
        } else {
            return Err(failure(
                BackupFailureCode::InvalidManifest,
                format!("manifest 包含非受控 payload：{path}"),
            ));
        };
        if entry.kind != expected_kind {
            return Err(failure(
                BackupFailureCode::InvalidManifest,
                format!("manifest 文件类型不匹配：{path}"),
            ));
        }
        let actual_file = observed.get(&path).ok_or_else(|| {
            failure(
                BackupFailureCode::InvalidManifest,
                format!("manifest 声明的文件缺失：{path}"),
            )
        })?;
        if entry.size != actual_file.size || entry.sha256 != actual_file.sha256 {
            return Err(failure(
                BackupFailureCode::HashMismatch,
                format!("备份文件 hash/大小不匹配：{path}"),
            ));
        }
    }
    let actual = observed
        .keys()
        .filter(|path| path.as_str() != MANIFEST_PATH)
        .cloned()
        .collect::<BTreeSet<_>>();
    if actual != declared {
        return Err(failure(
            BackupFailureCode::InvalidManifest,
            "归档包含未在 manifest 声明的文件",
        ));
    }
    let state_bytes = state_bytes
        .as_deref()
        .ok_or_else(|| failure(BackupFailureCode::InvalidManifest, "备份缺少业务状态"))?;
    let state: Value = serde_json::from_slice(state_bytes).map_err(|error| {
        failure(
            BackupFailureCode::InvalidState,
            format!("备份业务状态无效：{error}"),
        )
    })?;
    reject_forbidden_fields(&state)?;
    let summary = summarize_state(&state)?;
    if summary.store_version != manifest.store_schema_version {
        return Err(failure(
            BackupFailureCode::InvalidManifest,
            "manifest 与业务状态 store schema 不一致",
        ));
    }
    let missing_media = summary
        .media
        .iter()
        .filter(|name| !observed.contains_key(&format!("media/{name}")))
        .cloned()
        .collect::<Vec<_>>();
    if !missing_media.is_empty() {
        return Err(failure(
            BackupFailureCode::MissingMedia,
            format!("完整备份缺少 {} 个被引用媒体", missing_media.len()),
        ));
    }
    let expected_payloads = std::iter::once(STATE_PATH.to_string())
        .chain(summary.media.iter().map(|name| format!("media/{name}")))
        .collect::<BTreeSet<_>>();
    if actual != expected_payloads {
        return Err(failure(
            BackupFailureCode::InvalidManifest,
            "完整备份包含未被业务状态引用的 payload",
        ));
    }
    let expected_counts = BackupCounts {
        media: summary.media.len(),
        ..summary.counts
    };
    if expected_counts != manifest.counts {
        return Err(failure(
            BackupFailureCode::InvalidManifest,
            "manifest 记录数量与业务状态不一致",
        ));
    }
    Ok((
        archive,
        inspection_from_manifest(&manifest, Vec::new()),
        state_bytes.to_vec(),
        manifest,
    ))
}

fn inspect_legacy_json(path: &Path) -> Result<BackupInspection, BackupFailure> {
    let (bytes, state) = read_legacy_value(path)?;
    let object = validate_legacy_state(&state)?;
    let media = collect_media_references(&state)?;
    let mut warnings = vec!["旧 JSON 不含 manifest、hash 与媒体实体".into()];
    if !object.get("taskSections").is_some_and(Value::is_array) {
        warnings.push("旧 JSON 可能不含 taskSections，将回落到默认任务分组".into());
    }
    Ok(BackupInspection {
        format: BackupFormat::LegacyJson,
        source_directory: None,
        archive_revision: revision_for_bytes(&bytes),
        backup_schema_version: None,
        store_schema_version: None,
        app_version: None,
        created_at_ms: None,
        counts: BackupCounts {
            sections: array_len(object.get("sections")),
            notes: array_len(object.get("notes")),
            task_sections: array_len(object.get("taskSections")),
            tasks: array_len(object.get("tasks")),
            bills: array_len(object.get("bills")),
            messages: array_len(object.get("messages")),
            media: 0,
        },
        missing_media: media.into_iter().collect(),
        warnings,
    })
}

pub fn read_legacy_backup(path: &Path, expected_revision: &str) -> Result<String, BackupFailure> {
    let (bytes, state) = read_legacy_value(path)?;
    ensure_archive_revision(&revision_for_bytes(&bytes), expected_revision)?;
    validate_legacy_state(&state)?;
    String::from_utf8(bytes).map_err(|error| {
        failure(
            BackupFailureCode::CorruptArchive,
            format!("旧 JSON 不是 UTF-8：{error}"),
        )
    })
}

fn read_legacy_value(path: &Path) -> Result<(Vec<u8>, Value), BackupFailure> {
    let mut file = open_regular_nofollow(path, MAX_ARCHIVE_FILE_BYTES)?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(MAX_ARCHIVE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_failure)?;
    if bytes.len() as u64 > MAX_ARCHIVE_FILE_BYTES {
        return Err(failure(BackupFailureCode::FileTooLarge, "旧 JSON 备份过大"));
    }
    let state = serde_json::from_slice(&bytes).map_err(|error| {
        failure(
            BackupFailureCode::CorruptArchive,
            format!("文件不是有效旧 JSON：{error}"),
        )
    })?;
    Ok((bytes, state))
}

fn validate_legacy_state(state: &Value) -> Result<&serde_json::Map<String, Value>, BackupFailure> {
    let object = state
        .as_object()
        .ok_or_else(|| failure(BackupFailureCode::InvalidState, "旧 JSON 顶层必须是对象"))?;
    for (key, required) in [
        ("sections", "name"),
        ("notes", "text"),
        ("taskSections", "name"),
        ("tasks", "text"),
    ] {
        let Some(value) = object.get(key) else {
            continue;
        };
        let records = value.as_array().ok_or_else(|| {
            failure(
                BackupFailureCode::InvalidState,
                format!("旧 JSON {key} 必须是数组"),
            )
        })?;
        for record in records {
            let record = record.as_object().ok_or_else(|| {
                failure(
                    BackupFailureCode::InvalidState,
                    format!("旧 JSON {key} 含非对象"),
                )
            })?;
            if !record.get("id").is_some_and(Value::is_string)
                || !record.get(required).is_some_and(Value::is_string)
            {
                return Err(failure(
                    BackupFailureCode::InvalidState,
                    format!("旧 JSON {key} 记录缺少 id/{required}"),
                ));
            }
        }
    }
    if !validate_settings_value(object.get("settings")) {
        return Err(failure(
            BackupFailureCode::InvalidState,
            "旧 JSON settings 必须是对象",
        ));
    }
    Ok(object)
}

fn summarize_state(value: &Value) -> Result<StateSummary, BackupFailure> {
    let root = value
        .as_object()
        .ok_or_else(|| failure(BackupFailureCode::InvalidState, "备份状态顶层必须是对象"))?;
    let store_version = root
        .get("storeVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| failure(BackupFailureCode::InvalidState, "缺少 storeVersion"))?;
    if store_version > MAX_STORE_VERSION {
        return Err(failure(
            BackupFailureCode::UnsupportedSchema,
            "store schema 高于当前版本",
        ));
    }
    let state = root
        .get("state")
        .and_then(Value::as_object)
        .ok_or_else(|| failure(BackupFailureCode::InvalidState, "缺少 state 对象"))?;
    for required in ["sections", "notes", "taskSections", "tasks", "settings"] {
        if !state.contains_key(required) {
            return Err(failure(
                BackupFailureCode::InvalidState,
                format!("完整备份状态缺少 {required}"),
            ));
        }
    }
    // bills 是 v19 新增域：只对 v19+ 备份强制要求，旧备份缺失仍可导入
    if store_version >= 19 && !state.contains_key("bills") {
        return Err(failure(
            BackupFailureCode::InvalidState,
            "完整备份状态缺少 bills".to_string(),
        ));
    }
    if store_version >= 20 && !state.contains_key("messages") {
        return Err(failure(
            BackupFailureCode::InvalidState,
            "完整备份状态缺少 messages".to_string(),
        ));
    }
    if !validate_settings_value_for_version(state.get("settings"), store_version) {
        return Err(failure(
            BackupFailureCode::InvalidState,
            "完整备份 settings 必须是对象",
        ));
    }
    let sections = validate_record_array(state, "sections", "name")?;
    let notes = validate_record_array(state, "notes", "text")?;
    let task_sections = validate_record_array(state, "taskSections", "name")?;
    let tasks = validate_record_array(state, "tasks", "text")?;
    let bills = if state.contains_key("bills") {
        validate_record_array(state, "bills", "name")?
    } else {
        0
    };
    let messages = if state.contains_key("messages") {
        validate_record_array(state, "messages", "text")?
    } else {
        0
    };
    validate_domain_fields(state)?;
    Ok(StateSummary {
        store_version,
        counts: BackupCounts {
            sections,
            notes,
            task_sections,
            tasks,
            bills,
            messages,
            media: 0,
        },
        media: collect_media_references(root.get("state").unwrap())?,
    })
}

fn validate_domain_fields(state: &serde_json::Map<String, Value>) -> Result<(), BackupFailure> {
    let invalid = |message: String| failure(BackupFailureCode::InvalidState, message);
    for note in state
        .get("notes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let object = note
            .as_object()
            .expect("record array was already validated");
        if object
            .get("kind")
            .is_some_and(|value| !matches!(value.as_str(), Some("text" | "image" | "link")))
        {
            return Err(invalid("note.kind 不是受支持枚举".into()));
        }
        if object.get("done").is_some_and(|value| !value.is_boolean()) {
            return Err(invalid("note.done 必须是 boolean".into()));
        }
        validate_optional_nonnegative_number(object.get("createdAt"), "note.createdAt")?;
        validate_optional_nonnegative_number(object.get("updatedAt"), "note.updatedAt")?;
        if object.get("tags").is_some_and(|value| {
            !value
                .as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
        }) {
            return Err(invalid("note.tags 必须是字符串数组".into()));
        }
        if object
            .get("provenance")
            .is_some_and(|value| !validate_note_provenance(value))
        {
            return Err(invalid("note.provenance 字段无效".into()));
        }
    }
    for task in state
        .get("tasks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let object = task
            .as_object()
            .expect("record array was already validated");
        if object
            .get("status")
            .is_some_and(|value| !matches!(value.as_str(), Some("todo" | "doing" | "done")))
        {
            return Err(invalid("task.status 不是受支持枚举".into()));
        }
        if object
            .get("priority")
            .is_some_and(|value| !matches!(value.as_str(), Some("none" | "low" | "mid" | "high")))
        {
            return Err(invalid("task.priority 不是受支持枚举".into()));
        }
        if object
            .get("kind")
            .is_some_and(|value| value.as_str() != Some("spark"))
        {
            return Err(invalid("task.kind 不是受支持枚举".into()));
        }
        validate_optional_nonnegative_number(object.get("createdAt"), "task.createdAt")?;
        validate_optional_nullable_time(object.get("dueAt"), "task.dueAt")?;
        validate_optional_nullable_time(object.get("remindedAt"), "task.remindedAt")?;
        if let Some(checklist) = object.get("checklist") {
            let items = checklist
                .as_array()
                .ok_or_else(|| invalid("task.checklist 必须是数组".into()))?;
            let mut ids = BTreeSet::new();
            for item in items {
                let item = item
                    .as_object()
                    .ok_or_else(|| invalid("task.checklist 含非对象".into()))?;
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| invalid("task.checklist 缺少 id".into()))?;
                if !ids.insert(id) {
                    return Err(invalid(format!("task.checklist 含重复 id：{id}")));
                }
                if !item.get("text").is_some_and(Value::is_string)
                    || item.get("done").is_some_and(|value| !value.is_boolean())
                {
                    return Err(invalid("task.checklist 字段类型无效".into()));
                }
            }
        }
        if object
            .get("sourceRef")
            .is_some_and(|value| !validate_message_source_ref(value))
        {
            return Err(invalid("task.sourceRef 字段无效".into()));
        }
    }
    for bill in state
        .get("bills")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let object = bill
            .as_object()
            .expect("record array was already validated");
        if !object
            .get("kind")
            .is_some_and(|value| matches!(value.as_str(), Some("subscription" | "creditCard")))
        {
            return Err(invalid("bill.kind 不是受支持枚举".into()));
        }
        if !object.get("cycle").is_some_and(|value| {
            matches!(
                value.as_str(),
                Some("weekly" | "monthly" | "quarterly" | "semiannual" | "yearly")
            )
        }) {
            return Err(invalid("bill.cycle 不是受支持枚举".into()));
        }
        if object
            .get("status")
            .is_some_and(|value| !matches!(value.as_str(), Some("active" | "paused" | "canceled")))
        {
            return Err(invalid("bill.status 不是受支持枚举".into()));
        }
        if object
            .get("amount")
            .is_some_and(|value| !value.is_null() && value.as_f64().is_none_or(|n| !n.is_finite()))
        {
            return Err(invalid("bill.amount 必须是有限数字或 null".into()));
        }
        validate_optional_nonnegative_number(object.get("nextDueAt"), "bill.nextDueAt")?;
        validate_optional_nonnegative_number(object.get("createdAt"), "bill.createdAt")?;
        if object.get("iconFile").is_some_and(|value| !value.is_string()) {
            return Err(invalid("bill.iconFile 必须是字符串".into()));
        }
        if object.get("reminderOffsets").is_some_and(|value| {
            !value.as_array().is_some_and(|items| {
                items
                    .iter()
                    .all(|item| matches!(item.as_u64(), Some(0 | 1 | 3 | 7)))
            })
        }) {
            return Err(invalid("bill.reminderOffsets 只允许 0/1/3/7".into()));
        }
        if let Some(history) = object.get("history") {
            let items = history
                .as_array()
                .ok_or_else(|| invalid("bill.history 必须是数组".into()))?;
            let mut ids = BTreeSet::new();
            for item in items {
                let item = item
                    .as_object()
                    .ok_or_else(|| invalid("bill.history 含非对象".into()))?;
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| invalid("bill.history 缺少 id".into()))?;
                if !ids.insert(id) {
                    return Err(invalid(format!("bill.history 含重复 id：{id}")));
                }
                validate_optional_nonnegative_number(item.get("periodDueAt"), "bill.history.periodDueAt")?;
                validate_optional_nonnegative_number(item.get("paidAt"), "bill.history.paidAt")?;
                if item
                    .get("amount")
                    .is_some_and(|value| value.as_f64().is_none_or(|n| !n.is_finite()))
                {
                    return Err(invalid("bill.history.amount 必须是有限数字".into()));
                }
                if item
                    .get("method")
                    .is_some_and(|value| !matches!(value.as_str(), Some("auto" | "manual")))
                {
                    return Err(invalid("bill.history.method 不是受支持枚举".into()));
                }
            }
        }
    }
    for message in state
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let object = message
            .as_object()
            .expect("record array was already validated");
        if !is_message_source(object.get("source").and_then(Value::as_str))
            || !object
                .get("conversationId")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
            || !object
                .get("messageId")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
        {
            return Err(invalid("message 来源或标识无效".into()));
        }
        if !object.get("status").is_some_and(|value| {
            matches!(value.as_str(), Some("new" | "waiting" | "done" | "archived"))
        }) {
            return Err(invalid("message.status 不是受支持枚举".into()));
        }
        validate_optional_nonnegative_number(object.get("occurredAtMs"), "message.occurredAtMs")?;
        validate_optional_nonnegative_number(object.get("receivedAtMs"), "message.receivedAtMs")?;
        validate_optional_nonnegative_number(object.get("aiDraftAtMs"), "message.aiDraftAtMs")?;
        if object.get("matchedRuleIds").is_some_and(|value| {
            !value.as_array().is_some_and(|items| {
                let mut seen = BTreeSet::new();
                items.len() <= 50
                    && items.iter().all(|item| {
                        item.as_str()
                            .is_some_and(|id| !id.is_empty() && seen.insert(id))
                    })
            })
        }) {
            return Err(invalid("message.matchedRuleIds 字段无效".into()));
        }
        if object.get("context").is_some_and(|value| {
            !value.as_array().is_some_and(|items| {
                items.len() <= 8
                    && items.iter().all(|item| {
                        item.as_object().is_some_and(|item| {
                            item.get("messageId")
                                .and_then(Value::as_str)
                                .is_some_and(|id| !id.is_empty())
                                && item.get("text").is_some_and(Value::is_string)
                        })
                    })
            })
        }) {
            return Err(invalid("message.context 字段无效".into()));
        }
    }
    Ok(())
}

/// 消息来源是否受支持：中性标识 `im`；`tuitui` 为历史品牌值，仅为兼容旧备份保留。
fn is_message_source(source: Option<&str>) -> bool {
    matches!(source, Some("im" | "tuitui"))
}

fn validate_message_source_ref(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.get("kind").and_then(Value::as_str) == Some("message")
            && is_message_source(object.get("source").and_then(Value::as_str))
            && object
                .get("conversationId")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
            && object
                .get("messageId")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
    })
}

fn validate_optional_nonnegative_number(
    value: Option<&Value>,
    field: &str,
) -> Result<(), BackupFailure> {
    if value.is_some_and(|value| {
        value
            .as_f64()
            .is_none_or(|number| !number.is_finite() || number < 0.0)
    }) {
        return Err(failure(
            BackupFailureCode::InvalidState,
            format!("{field} 必须是非负有限数字"),
        ));
    }
    Ok(())
}

fn validate_optional_nullable_time(
    value: Option<&Value>,
    field: &str,
) -> Result<(), BackupFailure> {
    if value.is_none_or(Value::is_null) {
        return Ok(());
    }
    validate_optional_nonnegative_number(value, field)
}

fn validate_record_array(
    state: &serde_json::Map<String, Value>,
    key: &str,
    required_text_field: &str,
) -> Result<usize, BackupFailure> {
    let records = state.get(key).and_then(Value::as_array).ok_or_else(|| {
        failure(
            BackupFailureCode::InvalidState,
            format!("完整备份 {key} 必须是数组"),
        )
    })?;
    let mut ids = BTreeSet::new();
    for record in records {
        let object = record.as_object().ok_or_else(|| {
            failure(
                BackupFailureCode::InvalidState,
                format!("{key} 含非对象记录"),
            )
        })?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                failure(
                    BackupFailureCode::InvalidState,
                    format!("{key} 记录缺少有效 id"),
                )
            })?;
        if !ids.insert(id) {
            return Err(failure(
                BackupFailureCode::InvalidState,
                format!("{key} 含重复 id：{id}"),
            ));
        }
        if !object
            .get(required_text_field)
            .is_some_and(Value::is_string)
        {
            return Err(failure(
                BackupFailureCode::InvalidState,
                format!("{key} 记录缺少字符串 {required_text_field}"),
            ));
        }
    }
    Ok(records.len())
}

fn collect_media_references(value: &Value) -> Result<BTreeSet<String>, BackupFailure> {
    fn visit(value: &Value, out: &mut BTreeSet<String>) -> Result<(), BackupFailure> {
        match value {
            Value::Object(map) => {
                for (key, value) in map {
                    match key.as_str() {
                        // iconFile = 账单 favicon 缓存，与 imageFile 同规则打包
                        "imageFile" | "iconFile" => match value {
                            Value::String(name) => {
                                validate_media_name(name)?;
                                out.insert(name.into());
                            }
                            Value::Null => {}
                            _ => {
                                return Err(failure(
                                    BackupFailureCode::InvalidState,
                                    "imageFile/iconFile 必须是字符串",
                                ));
                            }
                        },
                        "attachments" => {
                            let names = value.as_array().ok_or_else(|| {
                                failure(
                                    BackupFailureCode::InvalidState,
                                    "attachments 必须是字符串数组",
                                )
                            })?;
                            for name in names {
                                let name = name.as_str().ok_or_else(|| {
                                    failure(
                                        BackupFailureCode::InvalidState,
                                        "attachments 必须是字符串数组",
                                    )
                                })?;
                                validate_media_name(name)?;
                                out.insert(name.into());
                            }
                        }
                        _ => visit(value, out)?,
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, out)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut out = BTreeSet::new();
    visit(value, &mut out)?;
    Ok(out)
}

fn reject_forbidden_fields(value: &Value) -> Result<(), BackupFailure> {
    fn visit(value: &Value) -> Option<String> {
        match value {
            Value::Object(map) => map.iter().find_map(|(key, value)| {
                let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                if [
                    "aiapikey",
                    "apikey",
                    "accesstoken",
                    "refreshtoken",
                    "secret",
                    "redactionmap",
                    "activitybody",
                ]
                .contains(&normalized.as_str())
                {
                    Some(key.clone())
                } else {
                    visit(value)
                }
            }),
            Value::Array(items) => items.iter().find_map(visit),
            _ => None,
        }
    }
    if let Some(field) = visit(value) {
        return Err(failure(
            BackupFailureCode::ForbiddenField,
            format!("备份状态包含禁止字段：{field}"),
        ));
    }
    Ok(())
}

fn validate_media_name(name: &str) -> Result<(), BackupFailure> {
    let path = Path::new(name);
    if name.is_empty()
        || path.is_absolute()
        || path.components().count() != 1
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(failure(
            BackupFailureCode::PathTraversal,
            format!("媒体引用路径无效：{name}"),
        ));
    }
    Ok(())
}

fn normalized_relative_path(path: &Path) -> Result<String, BackupFailure> {
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(failure(BackupFailureCode::PathTraversal, "归档路径越界"));
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => clean.push(name),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(failure(BackupFailureCode::PathTraversal, "归档路径越界"));
            }
        }
    }
    let normalized = clean.to_string_lossy().replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') {
        return Err(failure(
            BackupFailureCode::PathTraversal,
            "归档路径为空或绝对路径",
        ));
    }
    Ok(normalized)
}

fn inspection_from_manifest(manifest: &BackupManifest, warnings: Vec<String>) -> BackupInspection {
    BackupInspection {
        format: BackupFormat::Complete,
        source_directory: None,
        archive_revision: String::new(),
        backup_schema_version: Some(manifest.backup_schema_version),
        store_schema_version: Some(manifest.store_schema_version),
        app_version: Some(manifest.app_version.clone()),
        created_at_ms: Some(manifest.created_at_ms),
        counts: manifest.counts.clone(),
        missing_media: Vec::new(),
        warnings,
    }
}

fn array_len(value: Option<&Value>) -> usize {
    value.and_then(Value::as_array).map_or(0, Vec::len)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut result = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(result, "{byte:02x}");
    }
    result
}

fn revision_for_bytes(bytes: &[u8]) -> String {
    format!("sha256:{}:{}", sha256_hex(bytes), bytes.len())
}

fn ensure_archive_revision(
    actual: &str,
    expected: &str,
) -> Result<(), BackupFailure> {
    if expected.is_empty() || actual != expected {
        return Err(failure(
            BackupFailureCode::ExternalConflict,
            "备份文件自预检后已变化；请重新预检并确认导入内容",
        ));
    }
    Ok(())
}

fn revision_for_open_file(file: &mut File) -> Result<String, BackupFailure> {
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(io_failure)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| failure(BackupFailureCode::FileTooLarge, "备份文件大小溢出"))?;
    }
    Ok(format!("sha256:{}:{size}", hex_digest(hasher.finalize())))
}

/// ZipArchive 的统一读源：普通备份直接给 File，封装过的恢复备份解开后给内存游标。
pub(crate) trait ReadSeek: Read + Seek {}
impl<T: Read + Seek> ReadSeek for T {}

fn open_archive_with_revision(path: &Path) -> Result<(Box<dyn ReadSeek>, String), BackupFailure> {
    let mut file = open_regular_nofollow(path, MAX_ARCHIVE_TOTAL_BYTES + 64 * 1024 * 1024)?;
    // revision 永远按磁盘原始字节计算（封装与否都一致，外部替换检测不受影响）
    let revision = revision_for_open_file(&mut file)?;
    file.seek(SeekFrom::Start(0)).map_err(io_failure)?;
    let mut magic = [0u8; 4];
    let sniffed = file.read(&mut magic).map_err(io_failure)?;
    file.seek(SeekFrom::Start(0)).map_err(io_failure)?;
    if sniffed == 4 && crate::data_crypto::looks_sealed(&magic) {
        // 应用内部的自动恢复备份：整包 Recovery 信封，只有本机密钥能解开
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(io_failure)?;
        let plain = crate::data_crypto::open(crate::data_crypto::Purpose::Recovery, &bytes)
            .map_err(|error| {
                failure(
                    BackupFailureCode::CorruptArchive,
                    format!("恢复备份由本机密钥封装，无法在此打开：{}", error.message()),
                )
            })?;
        return Ok((Box::new(Cursor::new(plain)), revision));
    }
    Ok((Box::new(file), revision))
}

fn archive_revision(path: &Path) -> Result<String, BackupFailure> {
    let (file, revision) = open_archive_with_revision(path)?;
    drop(file);
    Ok(revision)
}

/// 读媒体文件并解开加密信封，返回明文字节（清扫前的旧明文 PNG 直通）。
/// manifest 哈希/大小自此按**明文**计——清扫改写密文不影响备份等价性，
/// 旧明文时代导出的备份与加密后导出的备份逐字节一致。
fn read_media_plaintext(path: &Path) -> Result<Vec<u8>, BackupFailure> {
    let mut file = open_regular_nofollow(
        path,
        MAX_ARCHIVE_FILE_BYTES + crate::data_crypto::ENVELOPE_OVERHEAD as u64,
    )?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(io_failure)?;
    let (plain, _sealed) =
        crate::data_crypto::open_or_passthrough(crate::data_crypto::Purpose::Media, bytes)
            .map_err(|error| {
                failure(
                    BackupFailureCode::IoFailed,
                    format!("媒体解密失败：{}", error.message()),
                )
            })?;
    if plain.len() as u64 > MAX_ARCHIVE_FILE_BYTES {
        return Err(failure(
            BackupFailureCode::FileTooLarge,
            "媒体文件超过 256 MiB",
        ));
    }
    Ok(plain)
}

fn sha256_file(path: &Path) -> Result<(String, u64), BackupFailure> {
    let plain = read_media_plaintext(path)?;
    Ok((sha256_hex(&plain), plain.len() as u64))
}

fn copy_file_and_verify(
    writer: &mut ZipWriter<File>,
    path: &Path,
    expected_hash: &str,
    expected_size: u64,
) -> Result<(), BackupFailure> {
    // AES-GCM 无流式解密：整文件解密后写入（单条 256MiB 上限内），
    // 两遍结构不变，峰值内存仍是单个文件
    let plain = read_media_plaintext(path)?;
    if plain.len() as u64 != expected_size || sha256_hex(&plain) != expected_hash {
        return Err(failure(
            BackupFailureCode::HashMismatch,
            "媒体在导出期间发生变化，已取消备份",
        ));
    }
    writer.write_all(&plain).map_err(io_failure)
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    let bytes = digest.as_ref();
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(result, "{byte:02x}");
    }
    result
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), BackupFailure> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).map_err(io_failure)?;
    file.write_all(bytes).map_err(io_failure)?;
    file.sync_all().map_err(io_failure)
}

fn open_regular_nofollow(path: &Path, max_bytes: u64) -> Result<File, BackupFailure> {
    let metadata = fs::symlink_metadata(path).map_err(io_failure)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(failure(
            BackupFailureCode::SymlinkRejected,
            "备份来源必须是普通文件，不能是符号链接",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let file = options.open(path).map_err(io_failure)?;
    let opened = file.metadata().map_err(io_failure)?;
    if !opened.is_file() {
        return Err(failure(
            BackupFailureCode::SymlinkRejected,
            "备份来源不是普通文件",
        ));
    }
    if opened.len() > max_bytes {
        return Err(failure(
            BackupFailureCode::FileTooLarge,
            "备份文件超过读取安全上限",
        ));
    }
    Ok(file)
}

fn commit_without_overwrite(source: &Path, destination: &Path) -> Result<(), BackupFailure> {
    match fs::hard_link(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(failure(
            BackupFailureCode::DestinationExists,
            "目标备份文件已存在；未覆盖原文件",
        )),
        Err(error) => Err(io_failure(error)),
    }
}

fn crypto_backup_failure(error: crate::data_crypto::CryptoError) -> BackupFailure {
    failure(
        BackupFailureCode::IoFailed,
        format!("加密失败：{}", error.message()),
    )
}

fn failure(code: BackupFailureCode, message: impl Into<String>) -> BackupFailure {
    BackupFailure {
        code,
        message: message.into(),
    }
}

fn io_failure(error: std::io::Error) -> BackupFailure {
    failure(
        BackupFailureCode::IoFailed,
        format!("文件操作失败：{error}"),
    )
}

fn zip_failure(error: zip::result::ZipError) -> BackupFailure {
    failure(
        BackupFailureCode::CorruptArchive,
        format!("归档处理失败：{error}"),
    )
}

fn json_failure(error: serde_json::Error) -> BackupFailure {
    failure(
        BackupFailureCode::InvalidState,
        format!("JSON 处理失败：{error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tempfile::tempdir;

    /// 测试便捷封装：与旧签名一致，默认不整包封装（封装路径由专门测试覆盖）。
    fn export_complete_backup(
        data_dir: &Path,
        destination: &Path,
        state_json: &str,
        app_version: &str,
        created_at_ms: u64,
    ) -> Result<BackupInspection, BackupFailure> {
        super::export_complete_backup(
            data_dir,
            destination,
            state_json,
            app_version,
            created_at_ms,
            false,
        )
    }

    fn state_json(image: Option<&str>) -> String {
        serde_json::json!({
            "storeVersion": MAX_STORE_VERSION,
            "state": {
                "sections": [{"id": "inbox", "name": "收件箱"}],
                "notes": [{"id": "n1", "text": "正文", "imageFile": image}],
                "taskSections": [{"id": "task-inbox", "name": "收集箱"}],
                "tasks": [{"id": "t1", "text": "任务"}],
                "bills": [{
                    "id": "b1",
                    "kind": "subscription",
                    "name": "Netflix",
                    "fallbackColor": "#ef4444",
                    "amount": 68,
                    "cycle": "monthly",
                    "nextDueAt": 1755619200000u64,
                    "status": "active",
                    "reminderOffsets": [3, 1],
                    "remindedFor": {"dueAt": 1755619200000u64, "offsets": []},
                    "history": [],
                    "createdAt": 1
                }],
                "messages": [{
                    "id": "[\"im\",\"g1\",\"m1\"]",
                    "source": "im",
                    "sourceApp": "示例 IM",
                    "sourceBundle": "com.example.im",
                    "conversationId": "g1",
                    "messageId": "m1",
                    "conversationName": "项目群",
                    "senderUid": "u1",
                    "senderName": "小王",
                    "occurredAtMs": 1,
                    "receivedAtMs": 2,
                    "mentionedSelf": true,
                    "followedSender": false,
                    "matchedRuleIds": [],
                    "isGroup": true,
                    "messageType": "text",
                    "text": "完整消息",
                    "context": [],
                    "status": "new"
                }],
                "settings": {"theme": "system"}
            }
        })
        .to_string()
    }

    fn encoded_png(pixel: [u8; 4]) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(1, 1, image::Rgba(pixel));
        let mut output = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut output, image::ImageFormat::Png)
            .unwrap();
        output.into_inner()
    }

    #[test]
    fn complete_backup_round_trip_includes_groups_tasks_and_media_hashes() {
        let root = tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir_all(data.join(MEDIA_DIR)).unwrap();
        fs::write(data.join(MEDIA_DIR).join("a.png"), b"png-bytes").unwrap();
        let output = root.path().join("backup.toskr-backup");

        let exported =
            export_complete_backup(&data, &output, &state_json(Some("a.png")), "0.14.0", 42)
                .unwrap();
        let inspected = inspect_backup(&output).unwrap();

        assert_eq!(exported, inspected);
        assert_eq!(
            inspected.counts,
            BackupCounts {
                sections: 1,
                notes: 1,
                task_sections: 1,
                tasks: 1,
                bills: 1,
                messages: 1,
                media: 1,
            }
        );
        let file = File::open(&output).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        assert!(archive.by_name("media/a.png").is_ok());
    }

    #[test]
    fn export_fails_closed_for_missing_media_and_secret_fields() {
        let root = tempdir().unwrap();
        let missing = export_complete_backup(
            root.path(),
            &root.path().join("missing.toskr-backup"),
            &state_json(Some("missing.png")),
            "0.14.0",
            1,
        )
        .unwrap_err();
        assert_eq!(missing.code, BackupFailureCode::MissingMedia);

        let secret = state_json(None).replace(
            "\"theme\":\"system\"",
            "\"theme\":\"system\",\"aiApiKey\":\"do-not-export\"",
        );
        let rejected = export_complete_backup(
            root.path(),
            &root.path().join("secret.toskr-backup"),
            &secret,
            "0.14.0",
            1,
        )
        .unwrap_err();
        assert_eq!(rejected.code, BackupFailureCode::ForbiddenField);
    }

    #[test]
    fn conflict_recovery_export_rejects_same_name_replaced_media() {
        let root = tempdir().unwrap();
        let data = root.path().join("data");
        let media = data.join(MEDIA_DIR);
        fs::create_dir_all(&media).unwrap();
        let original = [0x11, 0x22, 0x33, 0xff];
        let name = format!(
            "img-{}.png",
            crate::storage::content_hash(1, 1, &original)
        );
        let path = media.join(&name);
        fs::write(&path, encoded_png(original)).unwrap();

        export_conflict_recovery_backup(
            &data,
            &root.path().join("recovery-a.toskr-backup"),
            &state_json(Some(&name)),
            "0.14.0",
            1,
        )
        .unwrap();

        fs::write(&path, encoded_png([0xaa, 0xbb, 0xcc, 0xff])).unwrap();
        let rejected = root.path().join("recovery-b.toskr-backup");
        let error = export_conflict_recovery_backup(
            &data,
            &rejected,
            &state_json(Some(&name)),
            "0.14.0",
            2,
        )
        .unwrap_err();

        assert_eq!(error.code, BackupFailureCode::SourceChanged);
        assert!(!rejected.exists());
    }

    fn write_custom_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn import_preflight_rejects_path_traversal_duplicate_and_oversized_entries() {
        let root = tempdir().unwrap();
        let traversal = root.path().join("traversal.zip");
        write_custom_zip(&traversal, &[("../escape", b"x")]);
        assert_eq!(
            inspect_backup(&traversal).unwrap_err().code,
            BackupFailureCode::PathTraversal
        );

        let duplicate = root.path().join("duplicate.zip");
        write_custom_zip(
            &duplicate,
            &[("manifest.json", b"{}"), ("./manifest.json", b"{}")],
        );
        assert_eq!(
            inspect_backup(&duplicate).unwrap_err().code,
            BackupFailureCode::DuplicatePath
        );

        let case_duplicate = root.path().join("case-duplicate.zip");
        write_custom_zip(
            &case_duplicate,
            &[("manifest.json", b"{}"), ("MANIFEST.JSON", b"{}")],
        );
        assert_eq!(
            inspect_backup(&case_duplicate).unwrap_err().code,
            BackupFailureCode::DuplicatePath
        );

        let oversized = root.path().join("oversized.zip");
        write_custom_zip(&oversized, &[("manifest.json", b"123456789")]);
        let file = File::open(&oversized).unwrap();
        let archive = ZipArchive::new(file).unwrap();
        assert_eq!(
            inspect_complete_archive(archive, 8, 32).unwrap_err().code,
            BackupFailureCode::FileTooLarge
        );

        let symlink = root.path().join("symlink.zip");
        let file = File::create(&symlink).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer
            .add_symlink("media/link.png", "../outside", options)
            .unwrap();
        writer.finish().unwrap();
        assert_eq!(
            inspect_backup(&symlink).unwrap_err().code,
            BackupFailureCode::SymlinkRejected
        );
    }

    #[test]
    fn v18_backup_without_bills_still_imports() {
        // 旧版本（<19）完整备份没有 bills 键：required-key 校验必须版本门控放行
        let root = tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let output = root.path().join("v18.toskr-backup");
        let legacy_state = serde_json::json!({
            "storeVersion": 18,
            "state": {
                "sections": [{"id": "inbox", "name": "收件箱"}],
                "notes": [{"id": "n1", "text": "正文"}],
                "taskSections": [{"id": "task-inbox", "name": "收集箱"}],
                "tasks": [{"id": "t1", "text": "任务"}],
                "settings": {"theme": "system"}
            }
        })
        .to_string();
        let exported = export_complete_backup(&data, &output, &legacy_state, "0.17.3", 42).unwrap();
        assert_eq!(exported.counts.bills, 0);
        assert!(inspect_backup(&output).is_ok());
    }

    #[test]
    fn v19_backup_missing_bills_or_bad_bill_fields_rejected() {
        let root = tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let missing = serde_json::json!({
            "storeVersion": MAX_STORE_VERSION,
            "state": {
                "sections": [], "notes": [], "taskSections": [], "tasks": [],
                "settings": {}
            }
        })
        .to_string();
        let output = root.path().join("bad.toskr-backup");
        let error = export_complete_backup(&data, &output, &missing, "0.17.3", 1).unwrap_err();
        assert!(error.message.contains("bills"), "{}", error.message);

        let bad_kind = serde_json::json!({
            "storeVersion": MAX_STORE_VERSION,
            "state": {
                "sections": [], "notes": [], "taskSections": [], "tasks": [],
                "bills": [{"id": "b1", "name": "X", "kind": "loan", "cycle": "monthly"}],
                "messages": [],
                "settings": {}
            }
        })
        .to_string();
        let error = export_complete_backup(&data, &output, &bad_kind, "0.17.3", 1).unwrap_err();
        assert!(error.message.contains("bill.kind"), "{}", error.message);
    }

    #[test]
    fn bill_icon_file_counts_as_media_reference() {
        let root = tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir_all(data.join(MEDIA_DIR)).unwrap();
        fs::write(data.join(MEDIA_DIR).join("icon.png"), b"png").unwrap();
        let output = root.path().join("icon.toskr-backup");
        let state = serde_json::json!({
            "storeVersion": MAX_STORE_VERSION,
            "state": {
                "sections": [], "notes": [], "taskSections": [], "tasks": [],
                "bills": [{
                    "id": "b1", "kind": "subscription", "name": "Netflix",
                    "cycle": "monthly", "iconFile": "icon.png"
                }],
                "messages": [],
                "settings": {}
            }
        })
        .to_string();
        let exported = export_complete_backup(&data, &output, &state, "0.17.3", 1).unwrap();
        assert_eq!(exported.counts.media, 1);
        let file = File::open(&output).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        assert!(archive.by_name("media/icon.png").is_ok());
    }

    #[test]
    fn import_preflight_rejects_manifest_hash_mismatch() {
        let root = tempdir().unwrap();
        let archive = root.path().join("bad-hash.toskr-backup");
        let state = state_json(None);
        let manifest = BackupManifest {
            backup_schema_version: BACKUP_SCHEMA_VERSION,
            store_schema_version: MAX_STORE_VERSION,
            created_at_ms: 1,
            app_version: "0.14.0".into(),
            counts: BackupCounts {
                sections: 1,
                notes: 1,
                task_sections: 1,
                tasks: 1,
                bills: 1,
                messages: 1,
                media: 0,
            },
            files: vec![BackupFileEntry {
                path: STATE_PATH.into(),
                sha256: "not-the-real-hash".into(),
                size: state.len() as u64,
                kind: "state".into(),
            }],
        };
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        write_custom_zip(
            &archive,
            &[
                (MANIFEST_PATH, &manifest_bytes),
                (STATE_PATH, state.as_bytes()),
            ],
        );

        assert_eq!(
            inspect_backup(&archive).unwrap_err().code,
            BackupFailureCode::HashMismatch
        );
    }

    #[test]
    fn malformed_complete_archive_is_not_misreported_as_legacy_json() {
        let root = tempdir().unwrap();
        let archive = root.path().join("broken.toskr-backup");
        fs::write(&archive, b"not-a-zip").unwrap();

        assert_eq!(
            inspect_backup(&archive).unwrap_err().code,
            BackupFailureCode::CorruptArchive
        );
    }

    #[test]
    fn complete_state_schema_rejects_invalid_domain_shapes_and_duplicate_ids() {
        let root = tempdir().unwrap();
        let mut invalid_shape: Value = serde_json::from_str(&state_json(None)).unwrap();
        invalid_shape["state"]["notes"] = serde_json::json!({});
        assert_eq!(
            export_complete_backup(
                root.path(),
                &root.path().join("shape.toskr-backup"),
                &invalid_shape.to_string(),
                "0.14.0",
                1,
            )
            .unwrap_err()
            .code,
            BackupFailureCode::InvalidState
        );

        let mut duplicate: Value = serde_json::from_str(&state_json(None)).unwrap();
        let note = duplicate["state"]["notes"][0].clone();
        duplicate["state"]["notes"]
            .as_array_mut()
            .unwrap()
            .push(note);
        assert_eq!(
            export_complete_backup(
                root.path(),
                &root.path().join("duplicate-id.toskr-backup"),
                &duplicate.to_string(),
                "0.14.0",
                2,
            )
            .unwrap_err()
            .code,
            BackupFailureCode::InvalidState
        );

        let mut invalid_settings: Value = serde_json::from_str(&state_json(None)).unwrap();
        invalid_settings["state"]["settings"]["promptSnippets"] =
            Value::String("corrupt".into());
        assert_eq!(
            export_complete_backup(
                root.path(),
                &root.path().join("invalid-settings.toskr-backup"),
                &invalid_settings.to_string(),
                "0.14.0",
                3,
            )
            .unwrap_err()
            .code,
            BackupFailureCode::InvalidState
        );

        // 标签必须是字符串数组；updatedAt 必须是非负数字（缺省则放行）
        let mut invalid_tags: Value = serde_json::from_str(&state_json(None)).unwrap();
        invalid_tags["state"]["notes"][0]["tags"] = serde_json::json!(["ok", 3]);
        assert_eq!(
            export_complete_backup(
                root.path(),
                &root.path().join("invalid-tags.toskr-backup"),
                &invalid_tags.to_string(),
                "0.14.0",
                4,
            )
            .unwrap_err()
            .code,
            BackupFailureCode::InvalidState
        );

        let mut tagged: Value = serde_json::from_str(&state_json(None)).unwrap();
        tagged["state"]["notes"][0]["tags"] = serde_json::json!(["工作"]);
        tagged["state"]["notes"][0]["updatedAt"] = serde_json::json!(1755000000000u64);
        export_complete_backup(
            root.path(),
            &root.path().join("tagged.toskr-backup"),
            &tagged.to_string(),
            "0.14.0",
            5,
        )
        .expect("合法 tags/updatedAt 应可导出");
    }

    #[test]
    fn atomic_backup_commit_never_overwrites_an_existing_destination() {
        let root = tempdir().unwrap();
        let temporary = root.path().join("partial");
        let destination = root.path().join("backup.toskr-backup");
        fs::write(&temporary, b"new-backup").unwrap();
        fs::write(&destination, b"existing-user-file").unwrap();

        assert_eq!(
            commit_without_overwrite(&temporary, &destination)
                .unwrap_err()
                .code,
            BackupFailureCode::DestinationExists
        );
        assert_eq!(fs::read(&destination).unwrap(), b"existing-user-file");
    }

    #[test]
    fn legacy_json_reports_missing_capabilities_without_claiming_completeness() {
        let root = tempdir().unwrap();
        let path = root.path().join("old.json");
        fs::write(
            &path,
            serde_json::json!({
                "sections": [],
                "notes": [{"id": "n", "text": "x", "imageFile": "old.png"}],
                "tasks": []
            })
            .to_string(),
        )
        .unwrap();
        let inspection = inspect_backup(&path).unwrap();
        assert_eq!(inspection.format, BackupFormat::LegacyJson);
        assert_eq!(inspection.missing_media, vec!["old.png"]);
        assert!(inspection
            .warnings
            .iter()
            .any(|warning| warning.contains("taskSections")));
    }

    #[test]
    fn reinstall_recovery_preflight_recognizes_current_encrypted_store_and_keeps_legacy_json() {
        crate::data_crypto::install_test_key();
        let root = tempdir().unwrap();

        let legacy_path = root.path().join("old.json");
        fs::write(
            &legacy_path,
            serde_json::json!({
                "notes": [{"id": "legacy-note", "text": "legacy"}],
                "tasks": []
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            inspect_backup(&legacy_path).unwrap().format,
            BackupFormat::LegacyJson,
            "修复当前加密 store 识别时不得破坏明文旧 JSON 兼容"
        );

        let business: Value = serde_json::from_str(&state_json(None)).unwrap();
        let persisted = serde_json::json!({
            "version": business["storeVersion"],
            "state": business["state"],
        });
        let store_document = serde_json::json!({ "toskr": persisted.to_string() }).to_string();
        let sealed =
            crate::data_crypto::seal(crate::data_crypto::Purpose::Data, store_document.as_bytes())
                .unwrap();
        let current_store_path = root.path().join(DATA_FILE);
        fs::write(&current_store_path, sealed).unwrap();

        let inspection = inspect_backup(&current_store_path)
            .expect("重装恢复预检应识别当前 TSK1 加密 store，不能报‘文件不是有效旧 JSON’");
        assert_eq!(inspection.format, BackupFormat::NativeData);
        assert_eq!(
            inspection.source_directory.as_deref(),
            Some(root.path().to_string_lossy().as_ref())
        );
        assert_eq!(inspection.counts.notes, 1);
        assert_eq!(inspection.counts.tasks, 1);

        // 改成 .bak 仍应按 Data AAD 识别，但不能假装父目录预检会加载改名副本。
        let renamed_path = root.path().join("renamed-current.bak");
        fs::copy(&current_store_path, &renamed_path).unwrap();
        let renamed = inspect_backup(&renamed_path).unwrap();
        assert_eq!(renamed.format, BackupFormat::NativeData);
        assert_eq!(renamed.source_directory, None);
        assert!(renamed
            .warnings
            .iter()
            .any(|warning| warning.contains(DATA_FILE)));

        let malformed_canonical = serde_json::json!({
            "toskr": null,
            "copper": persisted.to_string(),
        })
        .to_string();
        fs::write(
            &current_store_path,
            crate::data_crypto::seal(
                crate::data_crypto::Purpose::Data,
                malformed_canonical.as_bytes(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            inspect_backup(&current_store_path).unwrap_err().code,
            BackupFailureCode::InvalidState,
            "canonical toskr 存在但损坏时不得回退陈旧 copper"
        );
    }

    #[test]
    fn pre_encrypt_snapshot_is_inspectable_and_revision_guarded_for_recovery() {
        crate::data_crypto::install_test_key();
        let root = tempdir().unwrap();
        let business: Value = serde_json::from_str(&state_json(None)).unwrap();
        let persisted = serde_json::json!({
            "version": business["storeVersion"],
            "state": business["state"],
        });
        let store_document = serde_json::json!({ "toskr": persisted.to_string() }).to_string();
        let sealed = crate::data_crypto::seal(
            crate::data_crypto::Purpose::Recovery,
            store_document.as_bytes(),
        )
        .unwrap();
        // 改成 .json 也必须按 Recovery AAD 识别，不能误投 Data/legacy reader。
        let path = root.path().join("pre-encrypt-1.json");
        fs::write(&path, sealed).unwrap();

        let inspection = inspect_backup(&path).expect("迁移保险档应有明确恢复格式");
        assert_eq!(inspection.format, BackupFormat::PreEncryptSnapshot);
        assert_eq!(inspection.counts.notes, 1);
        assert_eq!(inspection.counts.tasks, 1);
        assert_eq!(
            read_pre_encrypt_snapshot(&path, &inspection.archive_revision).unwrap(),
            persisted.to_string()
        );
        assert_eq!(
            read_pre_encrypt_snapshot(&path, "sha256:stale:1")
                .unwrap_err()
                .code,
            BackupFailureCode::ExternalConflict
        );
    }

    #[test]
    fn complete_backup_materializes_a_valid_store_and_media_staging_directory() {
        let root = tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir_all(data.join(MEDIA_DIR)).unwrap();
        fs::write(data.join(MEDIA_DIR).join("a.png"), b"png-bytes").unwrap();
        let backup = root.path().join("backup.toskr-backup");
        export_complete_backup(&data, &backup, &state_json(Some("a.png")), "0.14.0", 42).unwrap();
        let staging = root.path().join("staging");

        let revision = inspect_backup(&backup).unwrap().archive_revision;
        materialize_complete_backup(&backup, &staging, &revision).unwrap();

        assert_eq!(
            crate::data_integrity::inspect_location(&staging, None).kind,
            crate::data_integrity::DataLocationKind::Valid
        );
        // 导入落进 staging 的媒体重新封了信封，解开后才是备份包里的明文
        let staged = fs::read(staging.join(MEDIA_DIR).join("a.png")).unwrap();
        assert!(staged.starts_with(b"TSK1"));
        assert_eq!(
            crate::data_crypto::open(crate::data_crypto::Purpose::Media, &staged).unwrap(),
            b"png-bytes"
        );
        let staged_state = fs::read(staging.join(DATA_FILE)).unwrap();
        assert!(staged_state.starts_with(b"TSK1"), "staging 状态文件也应封装");
    }

    #[test]
    fn export_decrypts_sealed_media_into_plaintext_archive() {
        crate::data_crypto::install_test_key();
        let root = tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir_all(data.join(MEDIA_DIR)).unwrap();
        let sealed =
            crate::data_crypto::seal(crate::data_crypto::Purpose::Media, b"png-bytes").unwrap();
        fs::write(data.join(MEDIA_DIR).join("a.png"), &sealed).unwrap();
        let output = root.path().join("backup.toskr-backup");
        export_complete_backup(&data, &output, &state_json(Some("a.png")), "0.20.0", 7).unwrap();

        let mut archive = ZipArchive::new(File::open(&output).unwrap()).unwrap();
        let mut bytes = Vec::new();
        archive
            .by_name("media/a.png")
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"png-bytes", "备份包内媒体必须是明文（跨机逃生通道）");
        let mut manifest = String::new();
        archive
            .by_name(MANIFEST_PATH)
            .unwrap()
            .read_to_string(&mut manifest)
            .unwrap();
        assert!(
            manifest.contains(&sha256_hex(b"png-bytes")),
            "manifest 哈希按明文计，对清扫前后保持不变量"
        );
    }

    #[test]
    fn sealed_recovery_archive_round_trips_and_requires_local_key() {
        crate::data_crypto::install_test_key();
        let root = tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir_all(data.join(MEDIA_DIR)).unwrap();
        let output = root.path().join("recovery.toskr-backup");
        super::export_complete_backup(&data, &output, &state_json(None), "0.20.0", 7, true)
            .unwrap();

        let raw = fs::read(&output).unwrap();
        assert!(raw.starts_with(b"TSK1"), "自动恢复备份应整包封装");

        let revision = inspect_backup(&output).unwrap().archive_revision;
        let staging = root.path().join("staging");
        materialize_complete_backup(&output, &staging, &revision).unwrap();
        assert_eq!(
            crate::data_integrity::inspect_location(&staging, None).kind,
            crate::data_integrity::DataLocationKind::Valid
        );

        crate::data_crypto::clear_test_key();
        assert!(inspect_backup(&output).is_err(), "外机（无钥）不应能打开恢复档");
        crate::data_crypto::install_test_key();
    }

    #[test]
    fn complete_import_rejects_a_valid_archive_replaced_after_preflight() {
        let root = tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir_all(data.join(MEDIA_DIR)).unwrap();
        let authorized = root.path().join("authorized.toskr-backup");
        let replacement = root.path().join("replacement.toskr-backup");
        export_complete_backup(&data, &authorized, &state_json(None), "0.14.0", 1).unwrap();
        let expected = inspect_backup(&authorized).unwrap().archive_revision;
        let mut replacement_state: Value = serde_json::from_str(&state_json(None)).unwrap();
        replacement_state["state"]["notes"][0]["text"] = Value::String("replacement-b".into());
        export_complete_backup(
            &data,
            &replacement,
            &replacement_state.to_string(),
            "0.14.0",
            2,
        )
        .unwrap();
        fs::rename(&replacement, &authorized).unwrap();
        let staging = root.path().join("staging");

        assert_eq!(
            materialize_complete_backup(&authorized, &staging, &expected)
                .unwrap_err()
                .code,
            BackupFailureCode::ExternalConflict
        );
        assert!(!staging.exists());
    }

    #[test]
    fn legacy_import_rejects_valid_json_replaced_after_preflight() {
        let root = tempdir().unwrap();
        let path = root.path().join("legacy.json");
        let legacy = |text: &str| {
            serde_json::json!({
                "sections": [],
                "notes": [{"id": "n", "text": text}],
                "tasks": []
            })
            .to_string()
        };
        fs::write(&path, legacy("authorized-a")).unwrap();
        let expected = inspect_backup(&path).unwrap().archive_revision;
        fs::write(&path, legacy("replacement-b")).unwrap();

        assert_eq!(
            read_legacy_backup(&path, &expected).unwrap_err().code,
            BackupFailureCode::ExternalConflict
        );
    }

    #[test]
    fn export_finalization_never_reports_an_externally_replaced_destination() {
        let root = tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir_all(data.join(MEDIA_DIR)).unwrap();
        let destination = root.path().join("backup.toskr-backup");
        let inspection =
            export_complete_backup(&data, &destination, &state_json(None), "0.14.0", 1)
                .unwrap();
        let external = root.path().join("external");
        fs::write(&external, b"external-u").unwrap();
        fs::rename(&external, &destination).unwrap();

        assert_eq!(
            finalize_export_destination(&destination, &inspection.archive_revision, true)
                .unwrap_err()
                .code,
            BackupFailureCode::DestinationChanged
        );
        assert_eq!(fs::read(&destination).unwrap(), b"external-u");
    }

    #[test]
    fn source_drift_cleanup_preserves_an_externally_replaced_destination() {
        let root = tempdir().unwrap();
        let data = root.path().join("data");
        fs::create_dir_all(data.join(MEDIA_DIR)).unwrap();
        let destination = root.path().join("backup.toskr-backup");
        let inspection =
            export_complete_backup(&data, &destination, &state_json(None), "0.14.0", 1)
                .unwrap();
        let external = root.path().join("external");
        fs::write(&external, b"external-u").unwrap();
        fs::rename(&external, &destination).unwrap();

        assert_eq!(
            finalize_export_destination(&destination, &inspection.archive_revision, false)
                .unwrap_err()
                .code,
            BackupFailureCode::SourceChanged
        );
        assert_eq!(fs::read(&destination).unwrap(), b"external-u");
    }
}
