//! 版本化完整备份容器。
//!
//! 容器是单文件 ZIP，但只使用 Stored 模式，避免大媒体在导出时产生额外内存峰值。
//! 所有路径、大小、hash、重复项与 symlink 属性都在导入前 fail-closed 校验。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
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

pub fn export_complete_backup(
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
        false,
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
    )
}

fn export_backup_inner(
    data_dir: &Path,
    destination: &Path,
    state_json: &str,
    app_version: &str,
    created_at_ms: u64,
    require_content_identity: bool,
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
        if metadata.len() > MAX_ARCHIVE_FILE_BYTES {
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
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(io_failure)?;
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
        // ownership 必须来自仍由本事务持有的 tmp inode，不能发布后再从
        // destination 反推；外部 writer 可能在 hard-link 发布后立即换路径。
        let owned_revision = archive_revision(&tmp)?;
        commit_without_overwrite(&tmp, destination)?;
        let _ = File::open(parent).and_then(|directory| directory.sync_all());
        if archive_revision(destination).ok().as_deref() != Some(owned_revision.as_str()) {
            return Err(failure(
                BackupFailureCode::DestinationChanged,
                "备份目标在发布后被外部替换；未把外部版本认作成功备份",
            ));
        }
        fs::remove_file(&tmp).map_err(io_failure)?;
        let mut inspection = inspection_from_manifest(&manifest, Vec::new());
        inspection.archive_revision = owned_revision;
        Ok(inspection)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
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
    let bytes = fs::read(path).map_err(io_failure)?;
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

fn validated_complete_archive(
    path: &Path,
    expected_revision: &str,
) -> Result<(ZipArchive<File>, BackupInspection, Vec<u8>, BackupManifest), BackupFailure> {
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
        write_new_file(
            &staging_dir.join(DATA_FILE),
            &serde_json::to_vec_pretty(&bag).map_err(json_failure)?,
        )?;
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
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(output_path)
                .map_err(io_failure)?;
            let mut hasher = Sha256::new();
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
                hasher.update(&buffer[..read]);
                output.write_all(&buffer[..read]).map_err(io_failure)?;
            }
            if actual_size != expected.size || hex_digest(hasher.finalize()) != expected.sha256 {
                return Err(failure(
                    BackupFailureCode::HashMismatch,
                    format!("提取时媒体 hash/大小发生变化：{relative}"),
                ));
            }
            output.sync_all().map_err(io_failure)?;
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

fn inspect_complete_archive(
    archive: ZipArchive<File>,
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

fn read_complete_archive(
    mut archive: ZipArchive<File>,
    max_file: u64,
    max_total: u64,
) -> Result<(ZipArchive<File>, BackupInspection, Vec<u8>, BackupManifest), BackupFailure> {
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
    validate_domain_fields(state)?;
    Ok(StateSummary {
        store_version,
        counts: BackupCounts {
            sections,
            notes,
            task_sections,
            tasks,
            bills,
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
    Ok(())
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

fn open_archive_with_revision(path: &Path) -> Result<(File, String), BackupFailure> {
    let mut file = open_regular_nofollow(path, MAX_ARCHIVE_TOTAL_BYTES + 64 * 1024 * 1024)?;
    let revision = revision_for_open_file(&mut file)?;
    file.seek(SeekFrom::Start(0)).map_err(io_failure)?;
    Ok((file, revision))
}

fn archive_revision(path: &Path) -> Result<String, BackupFailure> {
    let (file, revision) = open_archive_with_revision(path)?;
    drop(file);
    Ok(revision)
}

fn sha256_file(path: &Path) -> Result<(String, u64), BackupFailure> {
    let mut file = open_regular_nofollow(path, MAX_ARCHIVE_FILE_BYTES)?;
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
            .ok_or_else(|| failure(BackupFailureCode::FileTooLarge, "媒体大小溢出"))?;
    }
    Ok((hex_digest(hasher.finalize()), size))
}

fn copy_file_and_verify(
    writer: &mut ZipWriter<File>,
    path: &Path,
    expected_hash: &str,
    expected_size: u64,
) -> Result<(), BackupFailure> {
    let mut file = open_regular_nofollow(path, MAX_ARCHIVE_FILE_BYTES)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(io_failure)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read]).map_err(io_failure)?;
        hasher.update(&buffer[..read]);
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| failure(BackupFailureCode::FileTooLarge, "媒体大小溢出"))?;
        if size > expected_size || size > MAX_ARCHIVE_FILE_BYTES {
            return Err(failure(
                BackupFailureCode::HashMismatch,
                "媒体在导出期间增长或超过安全上限",
            ));
        }
    }
    if size != expected_size || hex_digest(hasher.finalize()) != expected_hash {
        return Err(failure(
            BackupFailureCode::HashMismatch,
            "媒体在导出期间发生变化，已取消备份",
        ));
    }
    Ok(())
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
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(io_failure)?;
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
        assert_eq!(
            fs::read(staging.join(MEDIA_DIR).join("a.png")).unwrap(),
            b"png-bytes"
        );
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
