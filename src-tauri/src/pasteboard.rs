//! macOS pasteboard 完整快照与 changeCount 所有权事务。

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};

use image::{codecs::png::PngEncoder, ColorType, ImageEncoder};
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardWriting};
use objc2_foundation::{NSArray, NSData, NSString};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardOutcome {
    Restored,
    RestoredPartial,
    SkippedUserChanged,
    NothingToRestore,
    RestoreFailed,
    NotOwned,
}

fn try_claim_flag(flag: &AtomicBool) -> bool {
    flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

/// 发送与捕获回退共享的进程内 pasteboard 事务许可。
pub struct PasteboardPermit(Option<AppHandle>);

pub fn try_claim(app: &AppHandle) -> Option<PasteboardPermit> {
    try_claim_flag(
        &app.state::<crate::state::AppState>()
            .pasteboard_transaction_in_flight,
    )
    .then(|| PasteboardPermit(Some(app.clone())))
}

impl Drop for PasteboardPermit {
    fn drop(&mut self) {
        if let Some(app) = self.0.take() {
            app.state::<crate::state::AppState>()
                .pasteboard_transaction_in_flight
                .store(false, Ordering::Release);
        }
    }
}

impl ClipboardOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Restored => "restored",
            Self::RestoredPartial => "restoredPartial",
            Self::SkippedUserChanged => "skippedUserChanged",
            Self::NothingToRestore => "nothingToRestore",
            Self::RestoreFailed => "restoreFailed",
            Self::NotOwned => "notOwned",
        }
    }

    /// 恢复尝试可能写出一个 Toskr generation，watcher 需据此避免自吞。
    pub fn should_mark_self_write(self) -> bool {
        matches!(
            self,
            Self::Restored | Self::RestoredPartial | Self::RestoreFailed
        )
    }

    /// 部分恢复或恢复失败都可能造成用户剪贴板信息损失，不能被隐身模式吞掉。
    pub fn warning_message(self) -> Option<&'static str> {
        match self {
            Self::RestoredPartial => Some("原剪贴板仅恢复了可读内容（不可读取格式未恢复）"),
            Self::RestoreFailed => Some("原剪贴板恢复失败"),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PasteboardRepresentation {
    type_id: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PasteboardItemSnapshot {
    representations: Vec<PasteboardRepresentation>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PasteboardSnapshot {
    change_count: isize,
    items: Vec<PasteboardItemSnapshot>,
    unavailable_representations: usize,
}

#[derive(Clone, Debug)]
enum PasteboardTarget {
    General,
    #[cfg(test)]
    Named(String),
}

impl PasteboardTarget {
    fn resolve(&self) -> Retained<NSPasteboard> {
        match self {
            Self::General => NSPasteboard::generalPasteboard(),
            #[cfg(test)]
            Self::Named(name) => NSPasteboard::pasteboardWithName(&NSString::from_str(name)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PasteboardError {
    SnapshotChanged,
    RepresentationUnavailable,
    WriteFailed,
    OwnershipLost,
    ImageEncodingFailed,
}

impl fmt::Display for PasteboardError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::SnapshotChanged => "剪贴板在快照期间发生变化",
            Self::RepresentationUnavailable => "剪贴板包含无法读取的表示",
            Self::WriteFailed => "剪贴板写入失败",
            Self::OwnershipLost => "剪贴板已被其他应用更新",
            Self::ImageEncodingFailed => "图片编码失败",
        })
    }
}

fn capture_snapshot(target: &PasteboardTarget) -> Result<PasteboardSnapshot, PasteboardError> {
    // 读取多表示可能触发惰性 provider；前后 changeCount 必须一致才接受。
    for _ in 0..3 {
        let pasteboard = target.resolve();
        let change_count = pasteboard.changeCount();
        let mut items = Vec::new();
        let mut unavailable_representations = 0;
        if let Some(source_items) = pasteboard.pasteboardItems() {
            for source_item in source_items.iter() {
                let mut representations = Vec::new();
                let source_types = source_item.types();
                for type_id in source_types.iter() {
                    if let Some(data) = source_item.dataForType(&type_id) {
                        representations.push(PasteboardRepresentation {
                            type_id: type_id.to_string(),
                            bytes: data.to_vec(),
                        });
                    } else {
                        unavailable_representations += 1;
                    }
                }
                // 辅助/惰性表示失效时仍可备份该条目的可读内容；但整条都不可读
                // 就不能安全替换 general pasteboard，继续 fail-closed。
                if !source_types.is_empty() && representations.is_empty() {
                    return Err(PasteboardError::RepresentationUnavailable);
                }
                items.push(PasteboardItemSnapshot { representations });
            }
        }
        if pasteboard.changeCount() == change_count {
            return Ok(PasteboardSnapshot {
                change_count,
                items,
                unavailable_representations,
            });
        }
    }
    Err(PasteboardError::SnapshotChanged)
}

fn build_items(
    snapshot: &PasteboardSnapshot,
) -> Result<Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>>, PasteboardError> {
    let mut objects = Vec::with_capacity(snapshot.items.len());
    for source_item in &snapshot.items {
        let item = NSPasteboardItem::new();
        for representation in &source_item.representations {
            if !item.setData_forType(
                &NSData::with_bytes(&representation.bytes),
                &NSString::from_str(&representation.type_id),
            ) {
                return Err(PasteboardError::WriteFailed);
            }
        }
        objects.push(ProtocolObject::<dyn NSPasteboardWriting>::from_retained(
            item,
        ));
    }
    Ok(objects)
}

fn text_snapshot(change_count: isize, text: &str) -> PasteboardSnapshot {
    PasteboardSnapshot {
        change_count,
        items: vec![PasteboardItemSnapshot {
            representations: vec![PasteboardRepresentation {
                type_id: "public.utf8-plain-text".into(),
                bytes: text.as_bytes().to_vec(),
            }],
        }],
        unavailable_representations: 0,
    }
}

fn text_and_html_snapshot(change_count: isize, plain: &str, html: &str) -> PasteboardSnapshot {
    PasteboardSnapshot {
        change_count,
        items: vec![PasteboardItemSnapshot {
            representations: vec![
                PasteboardRepresentation {
                    type_id: "public.utf8-plain-text".into(),
                    bytes: plain.as_bytes().to_vec(),
                },
                PasteboardRepresentation {
                    type_id: "public.html".into(),
                    bytes: html.as_bytes().to_vec(),
                },
            ],
        }],
        unavailable_representations: 0,
    }
}

fn image_snapshot(
    change_count: isize,
    width: usize,
    height: usize,
    rgba: &[u8],
) -> Result<PasteboardSnapshot, PasteboardError> {
    let expected_len = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(PasteboardError::ImageEncodingFailed)?;
    if rgba.len() != expected_len {
        return Err(PasteboardError::ImageEncodingFailed);
    }
    let width = u32::try_from(width).map_err(|_| PasteboardError::ImageEncodingFailed)?;
    let height = u32::try_from(height).map_err(|_| PasteboardError::ImageEncodingFailed)?;
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(rgba, width, height, ColorType::Rgba8.into())
        .map_err(|_| PasteboardError::ImageEncodingFailed)?;
    Ok(PasteboardSnapshot {
        change_count,
        items: vec![PasteboardItemSnapshot {
            representations: vec![PasteboardRepresentation {
                type_id: "public.png".into(),
                bytes: png,
            }],
        }],
        unavailable_representations: 0,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WriteAttempt {
    result: Result<(), PasteboardError>,
    owned_change_count: Option<isize>,
}

fn classify_write_generation(
    expected_before: isize,
    cleared_count: isize,
    current_after_write: isize,
    write_succeeded: bool,
) -> WriteAttempt {
    if cleared_count != expected_before.wrapping_add(1) || current_after_write != cleared_count {
        return WriteAttempt {
            result: Err(PasteboardError::OwnershipLost),
            owned_change_count: None,
        };
    }
    WriteAttempt {
        result: write_succeeded
            .then_some(())
            .ok_or(PasteboardError::WriteFailed),
        // 即使 writeObjects 失败，clearContents 取得的空 pasteboard 仍由 Toskr
        // 拥有；记录该代，调用方才可安全回滚原快照。
        owned_change_count: Some(cleared_count),
    }
}

fn write_objects(
    pasteboard: &NSPasteboard,
    objects: &[Retained<ProtocolObject<dyn NSPasteboardWriting>>],
    expected_before: isize,
) -> WriteAttempt {
    if pasteboard.changeCount() != expected_before {
        return WriteAttempt {
            result: Err(PasteboardError::OwnershipLost),
            owned_change_count: None,
        };
    }
    let cleared_count = pasteboard.clearContents();
    if cleared_count != expected_before.wrapping_add(1) || pasteboard.changeCount() != cleared_count
    {
        return WriteAttempt {
            result: Err(PasteboardError::OwnershipLost),
            owned_change_count: None,
        };
    }
    let write_succeeded =
        objects.is_empty() || pasteboard.writeObjects(&NSArray::from_retained_slice(objects));
    classify_write_generation(
        expected_before,
        cleared_count,
        pasteboard.changeCount(),
        write_succeeded,
    )
}

fn write_snapshot_to_target(
    target: &PasteboardTarget,
    snapshot: &PasteboardSnapshot,
) -> Result<isize, PasteboardError> {
    let objects = build_items(snapshot)?;
    let pasteboard = target.resolve();
    let before = pasteboard.changeCount();
    let attempt = write_objects(&pasteboard, &objects, before);
    attempt.result?;
    attempt
        .owned_change_count
        .ok_or(PasteboardError::WriteFailed)
}

/// 显式“复制”入口使用：永久替换 general pasteboard，并返回精确自写 generation。
pub fn write_general_text(text: &str) -> Result<isize, PasteboardError> {
    write_snapshot_to_target(&PasteboardTarget::General, &text_snapshot(0, text))
}

/// 富内容复制：plain fallback 与 HTML 放在同一个 pasteboard item，接收方可按
/// 自身能力选择表示；调用前必须已经完成 HTML/附件构建，避免半截写入。
pub fn write_general_text_and_html(
    plain: &str,
    html: &str,
) -> Result<isize, PasteboardError> {
    write_snapshot_to_target(
        &PasteboardTarget::General,
        &text_and_html_snapshot(0, plain, html),
    )
}

pub fn write_general_image(
    width: usize,
    height: usize,
    rgba: &[u8],
) -> Result<isize, PasteboardError> {
    write_snapshot_to_target(
        &PasteboardTarget::General,
        &image_snapshot(0, width, height, rgba)?,
    )
}

fn restore_snapshot_if_count(
    target: &PasteboardTarget,
    snapshot: &PasteboardSnapshot,
    expected_change_count: isize,
) -> WriteAttempt {
    let objects = match build_items(snapshot) {
        Ok(objects) => objects,
        Err(error) => {
            return WriteAttempt {
                result: Err(error),
                owned_change_count: None,
            }
        }
    };
    let pasteboard = target.resolve();
    write_objects(&pasteboard, &objects, expected_change_count)
}

pub struct PasteboardTransaction {
    target: PasteboardTarget,
    original: PasteboardSnapshot,
    owned_change_count: Option<isize>,
    wrote: bool,
    ownership_lost: bool,
    restore_finished: bool,
    restore_write_count: Option<isize>,
}

impl PasteboardTransaction {
    pub fn capture_original() -> Result<Self, PasteboardError> {
        Self::capture_target(PasteboardTarget::General)
    }

    #[cfg(test)]
    fn capture_named(name: &str) -> Result<Self, PasteboardError> {
        Self::capture_target(PasteboardTarget::Named(name.into()))
    }

    fn capture_target(target: PasteboardTarget) -> Result<Self, PasteboardError> {
        let original = capture_snapshot(&target)?;
        Ok(Self {
            target,
            original,
            owned_change_count: None,
            wrote: false,
            ownership_lost: false,
            restore_finished: false,
            restore_write_count: None,
        })
    }

    pub fn original_change_count(&self) -> isize {
        self.original.change_count
    }

    pub fn current_change_count(&self) -> isize {
        self.target.resolve().changeCount()
    }

    /// 粘贴动作前的最后一道所有权门：当前 generation 必须仍是最近一次 Toskr 写入。
    pub fn still_owns_current(&self) -> bool {
        !self.restore_finished
            && !self.ownership_lost
            && self
                .owned_change_count
                .is_some_and(|owned| self.current_change_count() == owned)
    }

    /// 已观察到变化但上下文不足以安全认领时，明确放弃恢复。
    pub fn abandon_external_write(&mut self) {
        self.wrote = false;
        self.owned_change_count = None;
        self.ownership_lost = true;
    }

    /// 本次恢复实际取得的精确 generation；不会因随后用户写入而改变。
    #[cfg(test)]
    fn restore_write_count(&self) -> Option<isize> {
        self.restore_write_count
    }

    /// 最近一次经事务证明属于 Toskr 的 generation。恢复在 build 阶段失败时，
    /// 仍返回 outgoing payload/copy 的精确 generation，避免 watcher 自吞。
    pub fn last_toskr_write_count(&self) -> Option<isize> {
        self.restore_write_count
            .or_else(|| self.wrote.then_some(self.owned_change_count).flatten())
    }

    /// 将合成 ⌘C 已经产生且仍为当前值的 changeCount 纳入同一所有权事务。
    pub fn claim_external_write(&mut self, observed_change_count: isize) -> bool {
        if self.restore_finished
            || self.wrote
            || self.ownership_lost
            || observed_change_count != self.original.change_count.wrapping_add(1)
            || self.current_change_count() != observed_change_count
        {
            self.ownership_lost = true;
            return false;
        }
        self.wrote = true;
        self.owned_change_count = Some(observed_change_count);
        true
    }

    fn expected_change_count(&self) -> isize {
        self.owned_change_count
            .unwrap_or(self.original.change_count)
    }

    fn replace_owned(&mut self, snapshot: &PasteboardSnapshot) -> Result<(), PasteboardError> {
        // 先构建 detached items，再让最终所有权检查紧贴 clear/write。
        let objects = build_items(snapshot)?;
        let pasteboard = self.target.resolve();
        let before = pasteboard.changeCount();
        if before != self.expected_change_count() {
            self.ownership_lost = true;
            return Err(PasteboardError::OwnershipLost);
        }
        let attempt = write_objects(&pasteboard, &objects, before);
        if let Some(owned) = attempt.owned_change_count {
            self.wrote = true;
            self.owned_change_count = Some(owned);
        } else if matches!(attempt.result, Err(PasteboardError::OwnershipLost)) {
            self.ownership_lost = true;
        }
        attempt.result
    }

    pub fn write_text(&mut self, text: &str) -> Result<(), PasteboardError> {
        let snapshot = text_snapshot(self.current_change_count(), text);
        self.replace_owned(&snapshot)
    }

    pub fn write_image(
        &mut self,
        width: usize,
        height: usize,
        rgba: &[u8],
    ) -> Result<(), PasteboardError> {
        let snapshot = image_snapshot(self.current_change_count(), width, height, rgba)?;
        self.replace_owned(&snapshot)
    }

    pub fn restore_if_owned(&mut self) -> ClipboardOutcome {
        self.restore_if_owned_with(restore_snapshot_if_count)
    }

    fn restore_if_owned_with(
        &mut self,
        restore: impl FnOnce(&PasteboardTarget, &PasteboardSnapshot, isize) -> WriteAttempt,
    ) -> ClipboardOutcome {
        if self.restore_finished {
            return ClipboardOutcome::NotOwned;
        }
        self.restore_finished = true;
        if !self.wrote {
            return if self.ownership_lost {
                ClipboardOutcome::NotOwned
            } else {
                ClipboardOutcome::NothingToRestore
            };
        }
        let Some(owned) = self.owned_change_count else {
            return ClipboardOutcome::NotOwned;
        };
        if self.current_change_count() != owned {
            return ClipboardOutcome::SkippedUserChanged;
        }
        let attempt = restore(&self.target, &self.original, owned);
        self.restore_write_count = attempt.owned_change_count;
        match attempt.result {
            Ok(()) if self.original.unavailable_representations > 0 => {
                ClipboardOutcome::RestoredPartial
            }
            Ok(()) => ClipboardOutcome::Restored,
            Err(PasteboardError::OwnershipLost) => ClipboardOutcome::SkippedUserChanged,
            Err(_) => ClipboardOutcome::RestoreFailed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardItem, NSPasteboardItemDataProvider, NSPasteboardType,
        NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSData, NSObject, NSObjectProtocol, NSString};

    define_class!(
        #[unsafe(super(NSObject))]
        #[ivars = ()]
        struct UnavailableRepresentationProvider;

        unsafe impl NSObjectProtocol for UnavailableRepresentationProvider {}

        unsafe impl NSPasteboardItemDataProvider for UnavailableRepresentationProvider {
            #[unsafe(method(pasteboard:item:provideDataForType:))]
            fn provide_data(
                &self,
                _pasteboard: Option<&NSPasteboard>,
                _item: &NSPasteboardItem,
                _type_id: &NSPasteboardType,
            ) {
                // 模拟来源应用声明了惰性表示，却无法兑现该表示。
            }
        }
    );

    impl UnavailableRepresentationProvider {
        fn new() -> Retained<Self> {
            let provider = Self::alloc().set_ivars(());
            unsafe { msg_send![super(provider), init] }
        }
    }

    #[test]
    fn shared_transaction_gate_allows_only_one_owner() {
        let gate = AtomicBool::new(false);

        let send_claimed = try_claim_flag(&gate);
        let capture_during_send = try_claim_flag(&gate);
        assert!(send_claimed);
        assert!(!capture_during_send);

        gate.store(false, Ordering::Release);
        let capture_claimed = try_claim_flag(&gate);
        let nested_capture = try_claim_flag(&gate);
        assert!(capture_claimed);
        assert!(!nested_capture);
    }

    #[test]
    fn write_generation_only_claims_the_exact_clear_generation() {
        let owned = classify_write_generation(10, 11, 11, true);
        assert_eq!(owned.result, Ok(()));
        assert_eq!(owned.owned_change_count, Some(11));

        let writer_after_clear = classify_write_generation(10, 11, 12, true);
        assert_eq!(
            writer_after_clear.result,
            Err(PasteboardError::OwnershipLost)
        );
        assert_eq!(writer_after_clear.owned_change_count, None);

        let writer_before_clear = classify_write_generation(10, 12, 12, true);
        assert_eq!(
            writer_before_clear.result,
            Err(PasteboardError::OwnershipLost)
        );
        assert_eq!(writer_before_clear.owned_change_count, None);
    }

    #[test]
    fn failed_write_keeps_only_the_clear_generation_for_safe_rollback() {
        let attempt = classify_write_generation(20, 21, 21, false);

        assert_eq!(attempt.result, Err(PasteboardError::WriteFailed));
        assert_eq!(attempt.owned_change_count, Some(21));
    }

    fn png_fixture() -> Vec<u8> {
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&[10, 20, 30, 255], 1, 1, ColorType::Rgba8.into())
            .unwrap();
        png
    }

    fn fixture() -> Vec<Vec<(&'static str, Vec<u8>)>> {
        vec![
            vec![
                (
                    "public.utf8-plain-text",
                    "你好 clipboard".as_bytes().to_vec(),
                ),
                ("public.html", b"<b>hello</b>".to_vec()),
                ("public.rtf", b"{\\rtf1 binary}".to_vec()),
                ("com.example.opaque", vec![0, 1, 2, 255]),
            ],
            vec![
                ("public.png", png_fixture()),
                ("public.file-url", b"file:///tmp/example.txt".to_vec()),
                ("com.example.empty", vec![]),
            ],
        ]
    }

    #[test]
    fn clipboard_outcomes_serialize_to_the_frontend_contract() {
        let cases = [
            (ClipboardOutcome::Restored, "restored"),
            (ClipboardOutcome::RestoredPartial, "restoredPartial"),
            (ClipboardOutcome::SkippedUserChanged, "skippedUserChanged"),
            (ClipboardOutcome::NothingToRestore, "nothingToRestore"),
            (ClipboardOutcome::RestoreFailed, "restoreFailed"),
            (ClipboardOutcome::NotOwned, "notOwned"),
        ];

        for (outcome, expected) in cases {
            assert_eq!(outcome.as_str(), expected);
            assert_eq!(serde_json::to_value(outcome).unwrap(), expected);
        }
    }

    #[test]
    fn only_restore_writes_are_hidden_from_clipboard_history() {
        assert!(ClipboardOutcome::Restored.should_mark_self_write());
        assert!(ClipboardOutcome::RestoredPartial.should_mark_self_write());
        assert!(ClipboardOutcome::RestoreFailed.should_mark_self_write());
        assert!(!ClipboardOutcome::SkippedUserChanged.should_mark_self_write());
        assert!(!ClipboardOutcome::NothingToRestore.should_mark_self_write());
        assert!(!ClipboardOutcome::NotOwned.should_mark_self_write());
    }

    #[test]
    fn only_lossy_restore_outcomes_require_visible_warning() {
        assert!(ClipboardOutcome::RestoredPartial
            .warning_message()
            .is_some());
        assert!(ClipboardOutcome::RestoreFailed.warning_message().is_some());
        assert!(ClipboardOutcome::Restored.warning_message().is_none());
        assert!(ClipboardOutcome::SkippedUserChanged
            .warning_message()
            .is_none());
        assert!(ClipboardOutcome::NothingToRestore
            .warning_message()
            .is_none());
        assert!(ClipboardOutcome::NotOwned.warning_message().is_none());
    }

    fn pasteboard(name: &str) -> objc2::rc::Retained<NSPasteboard> {
        NSPasteboard::pasteboardWithName(&NSString::from_str(name))
    }

    fn write_fixture(name: &str, fixture: &[Vec<(&str, Vec<u8>)>]) {
        let pb = pasteboard(name);
        let mut objects = Vec::with_capacity(fixture.len());
        for source_item in fixture {
            let item = NSPasteboardItem::new();
            for (type_id, bytes) in source_item {
                assert!(
                    item.setData_forType(&NSData::with_bytes(bytes), &NSString::from_str(type_id),)
                );
            }
            objects.push(ProtocolObject::<dyn NSPasteboardWriting>::from_retained(
                item,
            ));
        }
        pb.clearContents();
        assert!(pb.writeObjects(&NSArray::from_retained_slice(&objects)));
    }

    fn read_fixture(name: &str) -> Vec<Vec<(String, Vec<u8>)>> {
        let pb = pasteboard(name);
        pb.pasteboardItems()
            .expect("fixture items")
            .iter()
            .map(|item| {
                item.types()
                    .iter()
                    .map(|type_id| {
                        let bytes = item
                            .dataForType(&type_id)
                            .expect("fixture representation")
                            .to_vec();
                        (type_id.to_string(), bytes)
                    })
                    .collect()
            })
            .collect()
    }

    #[test]
    fn complete_snapshot_roundtrips_multiple_items_and_unknown_types() {
        let name = format!("com.toskr.tests.snapshot.{}", std::process::id());
        let source = fixture();
        write_fixture(&name, &source);
        let expected = read_fixture(&name);

        for (type_id, bytes) in source.into_iter().flatten() {
            assert!(expected
                .iter()
                .flatten()
                .any(
                    |(actual_type, actual_bytes)| actual_type == type_id && actual_bytes == &bytes
                ));
        }

        let mut transaction = PasteboardTransaction::capture_named(&name).unwrap();
        transaction.write_text("temporary payload").unwrap();
        assert_eq!(transaction.restore_if_owned(), ClipboardOutcome::Restored);

        assert_eq!(read_fixture(&name), expected);
        pasteboard(&name).clearContents();
    }

    #[test]
    fn rich_write_keeps_plain_and_html_on_the_same_item() {
        let name = format!("com.toskr.tests.rich-write.{}", std::process::id());
        let target = PasteboardTarget::Named(name.clone());
        let snapshot = text_and_html_snapshot(0, "前图后", "<p>前<img src=\"data:x\">后</p>");

        write_snapshot_to_target(&target, &snapshot).unwrap();

        let items = read_fixture(&name);
        assert_eq!(items.len(), 1);
        assert!(items[0].iter().any(|(type_id, bytes)| {
            type_id == "public.utf8-plain-text" && bytes == "前图后".as_bytes()
        }));
        assert!(items[0].iter().any(|(type_id, bytes)| {
            type_id == "public.html"
                && bytes == "<p>前<img src=\"data:x\">后</p>".as_bytes()
        }));
        pasteboard(&name).clearContents();
    }

    #[test]
    fn unavailable_auxiliary_representation_does_not_block_snapshot() {
        let name = format!("com.toskr.tests.unavailable.{}", std::process::id());
        let pb = pasteboard(&name);
        let item = NSPasteboardItem::new();
        assert!(item.setData_forType(
            &NSData::with_bytes(b"original"),
            &NSString::from_str("public.utf8-plain-text"),
        ));
        let provider = UnavailableRepresentationProvider::new();
        let unavailable_types =
            NSArray::from_retained_slice(&[NSString::from_str("com.example.unavailable")]);
        assert!(item
            .setDataProvider_forTypes(ProtocolObject::from_ref(&*provider), &unavailable_types,));
        let objects = [ProtocolObject::<dyn NSPasteboardWriting>::from_retained(
            item,
        )];
        pb.clearContents();
        assert!(pb.writeObjects(&NSArray::from_retained_slice(&objects)));

        let mut transaction = PasteboardTransaction::capture_named(&name).unwrap();
        transaction.write_text("temporary payload").unwrap();

        assert_eq!(
            transaction.restore_if_owned(),
            ClipboardOutcome::RestoredPartial
        );
        let restored = pb.pasteboardItems().expect("restored item");
        let restored_item = restored.iter().next().expect("first restored item");
        assert_eq!(
            restored_item
                .dataForType(&NSString::from_str("public.utf8-plain-text"))
                .expect("readable representation")
                .to_vec(),
            b"original"
        );
        assert!(!restored_item
            .types()
            .iter()
            .any(|type_id| type_id.to_string() == "com.example.unavailable"));
        pb.clearContents();
    }

    #[test]
    fn entirely_unavailable_item_still_blocks_before_overwrite() {
        let name = format!("com.toskr.tests.unreadable.{}", std::process::id());
        let pb = pasteboard(&name);
        let item = NSPasteboardItem::new();
        let provider = UnavailableRepresentationProvider::new();
        let unavailable_types =
            NSArray::from_retained_slice(&[NSString::from_str("com.example.unavailable")]);
        assert!(item
            .setDataProvider_forTypes(ProtocolObject::from_ref(&*provider), &unavailable_types,));
        let objects = [ProtocolObject::<dyn NSPasteboardWriting>::from_retained(
            item,
        )];
        pb.clearContents();
        assert!(pb.writeObjects(&NSArray::from_retained_slice(&objects)));
        let before = pb.changeCount();

        assert!(matches!(
            PasteboardTransaction::capture_named(&name),
            Err(PasteboardError::RepresentationUnavailable)
        ));
        assert_eq!(pb.changeCount(), before);
        pb.clearContents();
    }

    #[test]
    fn consecutive_image_writes_advance_owned_change_count() {
        let name = format!("com.toskr.tests.images.{}", std::process::id());
        write_fixture(
            &name,
            &[vec![("public.utf8-plain-text", b"original".to_vec())]],
        );
        let original = read_fixture(&name);
        let mut transaction = PasteboardTransaction::capture_named(&name).unwrap();

        transaction.write_image(1, 1, &[255, 0, 0, 255]).unwrap();
        let first_owned = transaction.current_change_count();
        transaction.write_image(1, 1, &[0, 255, 0, 255]).unwrap();
        let last_owned = transaction.current_change_count();

        assert_ne!(first_owned, last_owned);
        assert_eq!(transaction.owned_change_count, Some(last_owned));
        assert_eq!(transaction.restore_if_owned(), ClipboardOutcome::Restored);
        assert_eq!(read_fixture(&name), original);
        pasteboard(&name).clearContents();
    }

    #[test]
    fn user_change_after_toskr_write_is_preserved() {
        let name = format!("com.toskr.tests.user-change.{}", std::process::id());
        write_fixture(
            &name,
            &[vec![("public.utf8-plain-text", b"original".to_vec())]],
        );
        let mut transaction = PasteboardTransaction::capture_named(&name).unwrap();
        transaction.write_text("toskr payload").unwrap();
        let user_value = vec![vec![("public.utf8-plain-text", b"new user value".to_vec())]];
        write_fixture(&name, &user_value);

        assert_eq!(
            transaction.restore_if_owned(),
            ClipboardOutcome::SkippedUserChanged
        );
        assert_eq!(
            read_fixture(&name),
            vec![vec![(
                "public.utf8-plain-text".to_string(),
                b"new user value".to_vec(),
            )]]
        );
        pasteboard(&name).clearContents();
    }

    #[test]
    fn paste_gate_rechecks_the_latest_owned_generation() {
        let name = format!("com.toskr.tests.paste-gate.{}", std::process::id());
        write_fixture(
            &name,
            &[vec![("public.utf8-plain-text", b"original".to_vec())]],
        );
        let mut transaction = PasteboardTransaction::capture_named(&name).unwrap();
        transaction.write_text("toskr payload").unwrap();
        assert!(transaction.still_owns_current());

        write_fixture(
            &name,
            &[vec![("public.utf8-plain-text", b"external".to_vec())]],
        );
        assert!(!transaction.still_owns_current());
        assert_eq!(
            transaction.restore_if_owned(),
            ClipboardOutcome::SkippedUserChanged
        );
        pasteboard(&name).clearContents();
    }

    #[test]
    fn permanent_write_returns_the_exact_named_pasteboard_generation() {
        let name = format!("com.toskr.tests.permanent-write.{}", std::process::id());
        let target = PasteboardTarget::Named(name.clone());
        write_fixture(&name, &[vec![("public.utf8-plain-text", b"old".to_vec())]]);

        let exact_count =
            write_snapshot_to_target(&target, &text_snapshot(0, "explicit copy")).unwrap();

        assert_eq!(pasteboard(&name).changeCount(), exact_count);
        assert_eq!(
            read_fixture(&name),
            vec![vec![(
                "public.utf8-plain-text".to_string(),
                b"explicit copy".to_vec(),
            )]]
        );
        pasteboard(&name).clearContents();
    }

    #[test]
    fn externally_observed_copy_uses_the_same_restore_transaction() {
        let name = format!("com.toskr.tests.external-copy.{}", std::process::id());
        write_fixture(
            &name,
            &[vec![("public.utf8-plain-text", b"original".to_vec())]],
        );
        let original = read_fixture(&name);
        let mut transaction = PasteboardTransaction::capture_named(&name).unwrap();

        write_fixture(
            &name,
            &[vec![(
                "public.utf8-plain-text",
                b"copied selection".to_vec(),
            )]],
        );
        let observed = transaction.current_change_count();

        assert!(transaction.claim_external_write(observed));
        assert_eq!(transaction.restore_if_owned(), ClipboardOutcome::Restored);
        assert_eq!(read_fixture(&name), original);
        pasteboard(&name).clearContents();
    }

    #[test]
    fn failed_restore_is_final_and_never_writes_twice() {
        let name = format!("com.toskr.tests.restore-failure.{}", std::process::id());
        write_fixture(
            &name,
            &[vec![("public.utf8-plain-text", b"original".to_vec())]],
        );
        let mut transaction = PasteboardTransaction::capture_named(&name).unwrap();
        transaction.write_text("toskr payload").unwrap();
        let mut attempts = 0;

        let first = transaction.restore_if_owned_with(|_, _, _| {
            attempts += 1;
            WriteAttempt {
                result: Err(PasteboardError::WriteFailed),
                owned_change_count: None,
            }
        });
        let second = transaction.restore_if_owned_with(|_, _, _| {
            attempts += 1;
            WriteAttempt {
                result: Ok(()),
                owned_change_count: Some(999),
            }
        });

        assert_eq!(first, ClipboardOutcome::RestoreFailed);
        assert_eq!(second, ClipboardOutcome::NotOwned);
        assert_eq!(attempts, 1);
        assert_eq!(
            transaction.last_toskr_write_count(),
            transaction.owned_change_count
        );
        pasteboard(&name).clearContents();
    }

    #[test]
    fn ownership_change_during_snapshot_rebuild_skips_the_restore() {
        let name = format!("com.toskr.tests.late-change.{}", std::process::id());
        write_fixture(
            &name,
            &[vec![("public.utf8-plain-text", b"original".to_vec())]],
        );
        let mut transaction = PasteboardTransaction::capture_named(&name).unwrap();
        transaction.write_text("toskr payload").unwrap();
        let mut attempts = 0;

        let outcome = transaction.restore_if_owned_with(|_, _, _| {
            attempts += 1;
            WriteAttempt {
                result: Err(PasteboardError::OwnershipLost),
                owned_change_count: None,
            }
        });

        assert_eq!(outcome, ClipboardOutcome::SkippedUserChanged);
        assert_eq!(attempts, 1);
        pasteboard(&name).clearContents();
    }

    #[test]
    fn restored_generation_stays_exact_when_user_writes_before_marking() {
        let name = format!("com.toskr.tests.restore-mark.{}", std::process::id());
        write_fixture(
            &name,
            &[vec![("public.utf8-plain-text", b"original".to_vec())]],
        );
        let mut transaction = PasteboardTransaction::capture_named(&name).unwrap();
        transaction.write_text("toskr payload").unwrap();
        assert_eq!(transaction.restore_if_owned(), ClipboardOutcome::Restored);
        let restored_generation = transaction.restore_write_count().unwrap();

        write_fixture(
            &name,
            &[vec![("public.utf8-plain-text", b"user value".to_vec())]],
        );

        assert_ne!(transaction.current_change_count(), restored_generation);
        assert_eq!(transaction.restore_write_count(), Some(restored_generation));
        assert_eq!(
            transaction.last_toskr_write_count(),
            Some(restored_generation)
        );
        pasteboard(&name).clearContents();
    }
}
