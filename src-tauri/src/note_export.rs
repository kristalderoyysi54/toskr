//! 人类可读的笔记导出容器：单一 ZIP，根目录为 notes.md，媒体位于 media/。
//!
//! 这里只接收活动媒体目录中的安全文件名，不接受任意来源路径。归档先写入目标
//! 同目录的 0600 临时文件，完整落盘后再以 no-replace 语义发布。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const NOTES_PATH: &str = "notes.md";
const MAX_MARKDOWN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MEDIA_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const COPY_BUFFER_BYTES: usize = 64 * 1024;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteExportFailureCode {
    InvalidDestination,
    DestinationExists,
    InvalidMediaName,
    MissingMedia,
    SourceChanged,
    SymlinkRejected,
    FileTooLarge,
    TooManyEntries,
    OperationInProgress,
    IoFailed,
    ArchiveFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteExportFailure {
    pub code: NoteExportFailureCode,
    pub message: String,
}

impl NoteExportFailure {
    pub(crate) fn operation_in_progress(message: impl Into<String>) -> Self {
        failure(NoteExportFailureCode::OperationInProgress, message)
    }

    pub(crate) fn io(message: impl Into<String>) -> Self {
        failure(NoteExportFailureCode::IoFailed, message)
    }
}

#[derive(Debug)]
struct PreparedMedia {
    name: String,
    path: PathBuf,
    expected_size: u64,
    expected_sha256: [u8; 32],
}

#[derive(Debug)]
struct MediaCandidate {
    name: String,
    path: PathBuf,
}

/// 生成只包含 `notes.md` 与引用媒体的便携 ZIP。
pub fn export_notes_bundle(
    media_dir: &Path,
    destination: &Path,
    markdown: &str,
    media_files: &[String],
) -> Result<(), NoteExportFailure> {
    let parent = validate_destination(destination)?;
    validate_markdown_size(markdown.len())?;
    validate_entry_count(media_files.len())?;
    let media = prepare_media(media_dir, media_files, markdown.len() as u64)?;
    validate_entry_count(media.len())?;

    write_prepared_bundle(&parent, destination, markdown, &media)
}

/// `prepare_media` 与实际归档写入之间的测试 seam：外部进程可能不经过
/// `Storage::write_gate` 修改同步盘文件，第二遍读取必须证明内容仍与预检一致。
fn write_prepared_bundle(
    parent: &Path,
    destination: &Path,
    markdown: &str,
    media: &[PreparedMedia],
) -> Result<(), NoteExportFailure> {
    let (temporary, file) = create_temporary_file(parent)?;
    let result = (|| {
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(0o600);
        archive
            .start_file(NOTES_PATH, options)
            .map_err(archive_failure)?;
        archive.write_all(markdown.as_bytes()).map_err(io_failure)?;

        let mut total_bytes = markdown.len() as u64;
        for item in media {
            let mut source = open_prepared_media_source(item)?;
            archive
                .start_file(format!("media/{}", item.name), options)
                .map_err(archive_failure)?;
            copy_media(&mut source, &mut archive, item, &mut total_bytes)?;
        }

        let file = archive.finish().map_err(archive_failure)?;
        file.sync_all().map_err(io_failure)?;
        drop(file);
        publish_without_overwrite(&temporary, destination)?;
        File::open(&parent)
            .and_then(|directory| directory.sync_all())
            .map_err(io_failure)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_destination(destination: &Path) -> Result<PathBuf, NoteExportFailure> {
    if !destination.is_absolute()
        || !destination
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
        || destination.file_name().is_none()
    {
        return Err(failure(
            NoteExportFailureCode::InvalidDestination,
            "笔记导出目标必须是绝对 .zip 文件路径",
        ));
    }
    match fs::symlink_metadata(destination) {
        Ok(_) => {
            return Err(failure(
                NoteExportFailureCode::DestinationExists,
                "目标导出文件已存在；未覆盖原文件",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_failure(error)),
    }
    let parent = destination.parent().ok_or_else(|| {
        failure(
            NoteExportFailureCode::InvalidDestination,
            "笔记导出目标没有父目录",
        )
    })?;
    let metadata = fs::metadata(parent).map_err(io_failure)?;
    if !metadata.is_dir() {
        return Err(failure(
            NoteExportFailureCode::InvalidDestination,
            "笔记导出目标的父路径不是目录",
        ));
    }
    Ok(parent.to_path_buf())
}

fn validate_markdown_size(size: usize) -> Result<(), NoteExportFailure> {
    if size as u64 > MAX_MARKDOWN_BYTES {
        return Err(failure(
            NoteExportFailureCode::FileTooLarge,
            "notes.md 超过 64 MiB 上限",
        ));
    }
    Ok(())
}

/// `media_count` 是媒体条目数；根 notes.md 还会占一个条目。
fn validate_entry_count(media_count: usize) -> Result<(), NoteExportFailure> {
    if media_count
        .checked_add(1)
        .is_none_or(|count| count > MAX_ENTRIES)
    {
        return Err(failure(
            NoteExportFailureCode::TooManyEntries,
            "笔记导出条目数超过 100000",
        ));
    }
    Ok(())
}

fn prepare_media(
    media_dir: &Path,
    media_files: &[String],
    markdown_bytes: u64,
) -> Result<Vec<PreparedMedia>, NoteExportFailure> {
    if !media_files.is_empty() {
        let metadata = fs::symlink_metadata(media_dir).map_err(io_failure)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(failure(
                NoteExportFailureCode::SymlinkRejected,
                "活动媒体目录不是普通目录",
            ));
        }
    }

    let mut seen = HashSet::with_capacity(media_files.len());
    let mut candidates = Vec::with_capacity(media_files.len());
    let mut metadata_total = markdown_bytes;
    for name in media_files {
        validate_media_name(name)?;
        if !seen.insert(name.clone()) {
            continue;
        }
        let path = media_dir.join(name);
        let metadata = media_metadata(&path, name)?;
        if metadata.len() > MAX_MEDIA_BYTES {
            return Err(failure(
                NoteExportFailureCode::FileTooLarge,
                format!("媒体文件超过 256 MiB：{name}"),
            ));
        }
        metadata_total = metadata_total.checked_add(metadata.len()).ok_or_else(|| {
            failure(
                NoteExportFailureCode::FileTooLarge,
                "笔记导出内容总大小溢出",
            )
        })?;
        if metadata_total > MAX_TOTAL_BYTES {
            return Err(failure(
                NoteExportFailureCode::FileTooLarge,
                "笔记导出内容总大小超过 1 GiB",
            ));
        }
        candidates.push(MediaCandidate {
            name: name.clone(),
            path,
        });
    }

    // metadata 只用于廉价的早期上限判断；权威预检必须从 O_NOFOLLOW 打开的
    // 文件描述符流式计算实际 size + SHA-256，不能信路径上的可替换元数据。
    let mut prepared = Vec::with_capacity(candidates.len());
    let mut actual_total = markdown_bytes;
    for candidate in candidates {
        let mut source = open_media_source(&candidate.path, &candidate.name)?;
        let (expected_size, expected_sha256) = fingerprint_media(&mut source, &candidate.name)?;
        actual_total = actual_total.checked_add(expected_size).ok_or_else(|| {
            failure(
                NoteExportFailureCode::FileTooLarge,
                "笔记导出内容总大小溢出",
            )
        })?;
        if actual_total > MAX_TOTAL_BYTES {
            return Err(failure(
                NoteExportFailureCode::FileTooLarge,
                "笔记导出内容总大小超过 1 GiB",
            ));
        }
        prepared.push(PreparedMedia {
            name: candidate.name,
            path: candidate.path,
            expected_size,
            expected_sha256,
        });
    }
    Ok(prepared)
}

fn validate_media_name(name: &str) -> Result<(), NoteExportFailure> {
    let mut components = Path::new(name).components();
    let one_normal_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains('\0')
        || name.chars().any(char::is_control)
        || !one_normal_component
    {
        return Err(failure(
            NoteExportFailureCode::InvalidMediaName,
            format!("媒体文件名不安全：{name}"),
        ));
    }
    Ok(())
}

fn media_metadata(path: &Path, name: &str) -> Result<fs::Metadata, NoteExportFailure> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            failure(
                NoteExportFailureCode::MissingMedia,
                format!("找不到媒体文件：{name}"),
            )
        } else {
            io_failure(error)
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(failure(
            NoteExportFailureCode::SymlinkRejected,
            format!("媒体来源不是普通文件：{name}"),
        ));
    }
    Ok(metadata)
}

fn open_media_source(path: &Path, name: &str) -> Result<File, NoteExportFailure> {
    let metadata = media_metadata(path, name)?;
    if metadata.len() > MAX_MEDIA_BYTES {
        return Err(failure(
            NoteExportFailureCode::FileTooLarge,
            format!("媒体文件超过 256 MiB：{name}"),
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let file = options.open(path).map_err(|error| {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return failure(
                NoteExportFailureCode::SymlinkRejected,
                format!("媒体来源不能是符号链接：{name}"),
            );
        }
        io_failure(error)
    })?;
    let opened = file.metadata().map_err(io_failure)?;
    if !opened.is_file() {
        return Err(failure(
            NoteExportFailureCode::SymlinkRejected,
            format!("媒体来源不是普通文件：{name}"),
        ));
    }
    if opened.len() > MAX_MEDIA_BYTES {
        return Err(failure(
            NoteExportFailureCode::FileTooLarge,
            format!("媒体文件超过 256 MiB：{name}"),
        ));
    }
    Ok(file)
}

fn fingerprint_media(source: &mut File, name: &str) -> Result<(u64, [u8; 32]), NoteExportFailure> {
    let mut size = 0_u64;
    let mut sha256 = Sha256::new();
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    loop {
        let count = source.read(&mut buffer).map_err(io_failure)?;
        if count == 0 {
            break;
        }
        size = size.checked_add(count as u64).ok_or_else(|| {
            failure(
                NoteExportFailureCode::FileTooLarge,
                format!("媒体文件大小溢出：{name}"),
            )
        })?;
        if size > MAX_MEDIA_BYTES {
            return Err(failure(
                NoteExportFailureCode::FileTooLarge,
                format!("媒体文件超过 256 MiB：{name}"),
            ));
        }
        sha256.update(&buffer[..count]);
    }
    Ok((size, sha256.finalize().into()))
}

fn open_prepared_media_source(item: &PreparedMedia) -> Result<File, NoteExportFailure> {
    match open_media_source(&item.path, &item.name) {
        Ok(file) => {
            if file.metadata().map_err(io_failure)?.len() != item.expected_size {
                Err(source_changed(&item.name))
            } else {
                Ok(file)
            }
        }
        Err(error)
            if matches!(
                error.code,
                NoteExportFailureCode::MissingMedia
                    | NoteExportFailureCode::SymlinkRejected
                    | NoteExportFailureCode::FileTooLarge
            ) =>
        {
            Err(source_changed(&item.name))
        }
        Err(error) => Err(error),
    }
}

fn copy_media(
    source: &mut File,
    archive: &mut ZipWriter<File>,
    item: &PreparedMedia,
    total_bytes: &mut u64,
) -> Result<(), NoteExportFailure> {
    let mut copied = 0_u64;
    let mut sha256 = Sha256::new();
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    loop {
        let count = source.read(&mut buffer).map_err(io_failure)?;
        if count == 0 {
            break;
        }
        copied = copied.checked_add(count as u64).ok_or_else(|| {
            failure(
                NoteExportFailureCode::FileTooLarge,
                format!("媒体文件大小溢出：{}", item.name),
            )
        })?;
        if copied > item.expected_size {
            return Err(source_changed(&item.name));
        }
        *total_bytes = total_bytes.checked_add(count as u64).ok_or_else(|| {
            failure(
                NoteExportFailureCode::FileTooLarge,
                "笔记导出内容总大小溢出",
            )
        })?;
        if *total_bytes > MAX_TOTAL_BYTES {
            return Err(failure(
                NoteExportFailureCode::FileTooLarge,
                "笔记导出内容总大小超过 1 GiB",
            ));
        }
        sha256.update(&buffer[..count]);
        archive.write_all(&buffer[..count]).map_err(io_failure)?;
    }
    let actual_sha256: [u8; 32] = sha256.finalize().into();
    if copied != item.expected_size || actual_sha256 != item.expected_sha256 {
        return Err(source_changed(&item.name));
    }
    Ok(())
}

fn create_temporary_file(parent: &Path) -> Result<(PathBuf, File), NoteExportFailure> {
    for _ in 0..16 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let path = parent.join(format!(
            ".toskr-notes-export-{}-{nanos}-{sequence}.tmp",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        match options.open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_failure(error)),
        }
    }
    Err(failure(
        NoteExportFailureCode::IoFailed,
        "无法创建唯一的笔记导出临时文件",
    ))
}

fn publish_without_overwrite(
    temporary: &Path,
    destination: &Path,
) -> Result<(), NoteExportFailure> {
    crate::data_integrity::rename_no_replace(temporary, destination).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            failure(
                NoteExportFailureCode::DestinationExists,
                "目标导出文件已存在；未覆盖原文件",
            )
        } else {
            io_failure(error)
        }
    })
}

fn failure(code: NoteExportFailureCode, message: impl Into<String>) -> NoteExportFailure {
    NoteExportFailure {
        code,
        message: message.into(),
    }
}

fn source_changed(name: &str) -> NoteExportFailure {
    failure(
        NoteExportFailureCode::SourceChanged,
        format!("媒体在导出预检后发生变化：{name}"),
    )
}

fn io_failure(error: std::io::Error) -> NoteExportFailure {
    failure(
        NoteExportFailureCode::IoFailed,
        format!("文件操作失败：{error}"),
    )
}

fn archive_failure(error: zip::result::ZipError) -> NoteExportFailure {
    failure(
        NoteExportFailureCode::ArchiveFailed,
        format!("生成笔记归档失败：{error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    use tempfile::tempdir;
    use zip::ZipArchive;

    fn write_media(media: &Path, name: &str, bytes: &[u8]) {
        fs::create_dir_all(media).unwrap();
        fs::write(media.join(name), bytes).unwrap();
    }

    #[test]
    fn exports_markdown_and_deduplicated_media_to_one_zip() {
        let root = tempdir().unwrap();
        let media = root.path().join("media");
        write_media(&media, "img-a.png", b"first-image");
        write_media(&media, "img-b.png", b"second-image");
        let destination = root.path().join("notes.zip");

        export_notes_bundle(
            &media,
            &destination,
            "# 导出\n\n![A](media/img-a.png)",
            &["img-a.png".into(), "img-a.png".into(), "img-b.png".into()],
        )
        .unwrap();

        let mut archive = ZipArchive::new(File::open(&destination).unwrap()).unwrap();
        assert_eq!(archive.len(), 3);
        let mut markdown = String::new();
        archive
            .by_name("notes.md")
            .unwrap()
            .read_to_string(&mut markdown)
            .unwrap();
        assert_eq!(markdown, "# 导出\n\n![A](media/img-a.png)");
        let mut first = Vec::new();
        archive
            .by_name("media/img-a.png")
            .unwrap()
            .read_to_end(&mut first)
            .unwrap();
        assert_eq!(first, b"first-image");
        assert!(archive.by_name("media/img-b.png").is_ok());

        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn prepared_export_rejects_same_size_media_content_drift() {
        let root = tempdir().unwrap();
        let media = root.path().join("media");
        write_media(&media, "img-a.png", b"original");
        let destination = root.path().join("notes.zip");
        let parent = validate_destination(&destination).unwrap();
        let prepared = prepare_media(&media, &["img-a.png".into()], 4).unwrap();

        // 与预检时长度相同，只改变内容；仅比较 metadata 无法发现这个漂移。
        fs::write(media.join("img-a.png"), b"mutated!").unwrap();
        let error = write_prepared_bundle(&parent, &destination, "text", &prepared).unwrap_err();

        assert_eq!(error.code, NoteExportFailureCode::SourceChanged);
        assert!(!destination.exists());
        assert!(!fs::read_dir(root.path()).unwrap().any(|entry| {
            entry
                .ok()
                .and_then(|entry| entry.file_name().into_string().ok())
                .is_some_and(|name| name.starts_with(".toskr-notes-export-"))
        }));
    }

    #[test]
    fn rejects_non_absolute_non_zip_and_existing_destinations() {
        let root = tempdir().unwrap();
        let relative = Path::new("notes.zip");
        let error = export_notes_bundle(root.path(), relative, "text", &[]).unwrap_err();
        assert_eq!(error.code, NoteExportFailureCode::InvalidDestination);

        let wrong_extension = root.path().join("notes.md");
        let error = export_notes_bundle(root.path(), &wrong_extension, "text", &[]).unwrap_err();
        assert_eq!(error.code, NoteExportFailureCode::InvalidDestination);

        let existing = root.path().join("notes.zip");
        fs::write(&existing, b"keep-me").unwrap();
        let error = export_notes_bundle(root.path(), &existing, "text", &[]).unwrap_err();
        assert_eq!(error.code, NoteExportFailureCode::DestinationExists);
        assert_eq!(fs::read(existing).unwrap(), b"keep-me");
    }

    #[test]
    fn rejects_unsafe_missing_and_symlinked_media() {
        let root = tempdir().unwrap();
        let media = root.path().join("media");
        fs::create_dir(&media).unwrap();

        for name in [
            "../escape.png",
            "nested/file.png",
            "nested\\file.png",
            "a..png",
            "bad\nname.png",
        ] {
            let destination = root.path().join(format!("unsafe-{}.zip", name.len()));
            let error =
                export_notes_bundle(&media, &destination, "text", &[name.into()]).unwrap_err();
            assert_eq!(error.code, NoteExportFailureCode::InvalidMediaName);
        }

        let missing = root.path().join("missing.zip");
        let error =
            export_notes_bundle(&media, &missing, "text", &["missing.png".into()]).unwrap_err();
        assert_eq!(error.code, NoteExportFailureCode::MissingMedia);

        #[cfg(unix)]
        {
            write_media(&media, "real.png", b"image");
            symlink(media.join("real.png"), media.join("alias.png")).unwrap();
            let destination = root.path().join("symlink.zip");
            let error = export_notes_bundle(&media, &destination, "text", &["alias.png".into()])
                .unwrap_err();
            assert_eq!(error.code, NoteExportFailureCode::SymlinkRejected);
        }
    }

    #[test]
    fn no_replace_publish_preserves_a_racing_destination() {
        let root = tempdir().unwrap();
        let temporary = root.path().join("partial.tmp");
        let destination = root.path().join("notes.zip");
        fs::write(&temporary, b"new").unwrap();
        fs::write(&destination, b"existing").unwrap();

        let error = publish_without_overwrite(&temporary, &destination).unwrap_err();

        assert_eq!(error.code, NoteExportFailureCode::DestinationExists);
        assert_eq!(fs::read(&destination).unwrap(), b"existing");
        assert_eq!(fs::read(&temporary).unwrap(), b"new");
    }

    #[test]
    fn enforces_markdown_entry_media_and_total_limits_before_writing() {
        assert!(validate_markdown_size(MAX_MARKDOWN_BYTES as usize).is_ok());
        assert_eq!(
            validate_markdown_size(MAX_MARKDOWN_BYTES as usize + 1)
                .unwrap_err()
                .code,
            NoteExportFailureCode::FileTooLarge
        );
        assert!(validate_entry_count(MAX_ENTRIES - 1).is_ok());
        assert_eq!(
            validate_entry_count(MAX_ENTRIES).unwrap_err().code,
            NoteExportFailureCode::TooManyEntries
        );

        let root = tempdir().unwrap();
        let media = root.path().join("media");
        fs::create_dir(&media).unwrap();
        let oversized = media.join("oversized.png");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_MEDIA_BYTES + 1)
            .unwrap();
        let destination = root.path().join("oversized.zip");
        let error = export_notes_bundle(&media, &destination, "text", &["oversized.png".into()])
            .unwrap_err();
        assert_eq!(error.code, NoteExportFailureCode::FileTooLarge);
        assert!(!destination.exists());

        let names = (0..4)
            .map(|index| format!("part-{index}.png"))
            .collect::<Vec<_>>();
        for name in &names {
            File::create(media.join(name))
                .unwrap()
                .set_len(MAX_MEDIA_BYTES)
                .unwrap();
        }
        let destination = root.path().join("total.zip");
        let error = export_notes_bundle(&media, &destination, "x", &names).unwrap_err();
        assert_eq!(error.code, NoteExportFailureCode::FileTooLarge);
        assert!(!destination.exists());
    }
}
