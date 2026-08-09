//! 跨应用划词捕获。
//!
//! 策略（按优先级）：
//! 1. AX API 直读焦点元素选中文本 —— 零副作用，原生应用/Safari 等可用。
//! 2. AX 不可信/不支持时走完整 pasteboard 事务：快照 → 合成 ⌘C →
//!    仅接受唯一稳定 revision 且前台身份/真实输入未漂移 → 按所有权安全恢复。

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::ax::{self, AxSelection};
use crate::input::synth;
use crate::pasteboard::{ClipboardOutcome, PasteboardTransaction};

/// changeCount 轮询：25 次 × 20ms = 最多 500ms（兼容复制偏慢的应用）。
const POLL_ATTEMPTS: usize = 25;
/// ⌘C 无法取消：采纳窗结束后继续持有事务 500ms，只恢复迟到写入、不采用 payload。
const RECOVERY_GRACE_ATTEMPTS: usize = 25;
const POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Default)]
struct RevisionObservation {
    candidate: Option<isize>,
    first_seen_attempt: Option<usize>,
    invalid: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CopyObservation {
    Accepted(isize),
    Late(isize),
    RecoveryOnly(isize),
    None,
    Invalid,
}

impl RevisionObservation {
    fn observe(&mut self, before: isize, current: isize, attempt: usize) {
        if current == before || self.invalid {
            return;
        }
        // 一次复制只接受紧邻 before 的唯一 revision；跳号或再次变化均 fail-closed。
        if current != before.wrapping_add(1)
            || self.candidate.is_some_and(|candidate| candidate != current)
        {
            self.invalid = true;
            return;
        }
        self.first_seen_attempt.get_or_insert(attempt);
        self.candidate = Some(current);
    }

    fn finish(self, acceptance_attempts: usize) -> CopyObservation {
        if self.invalid {
            return CopyObservation::Invalid;
        }
        match (self.candidate, self.first_seen_attempt) {
            (Some(change_count), Some(attempt)) if attempt < acceptance_attempts => {
                CopyObservation::Accepted(change_count)
            }
            (Some(change_count), Some(_)) => CopyObservation::Late(change_count),
            _ => CopyObservation::None,
        }
    }

    fn recovery_candidate(&self) -> Option<isize> {
        (!self.invalid).then_some(self.candidate).flatten()
    }
}

fn same_front_identity(expected: &crate::focus::FrontApp) -> bool {
    crate::focus::frontmost_info().is_some_and(|current| {
        current.pid == expected.pid
            && current.bundle_id == expected.bundle_id
            && current.launched_at_ms == expected.launched_at_ms
    })
}

fn same_capture_context(
    app: &AppHandle,
    source: &crate::focus::FrontApp,
    input_generation: u64,
) -> bool {
    same_front_identity(source)
        && app
            .state::<crate::state::AppState>()
            .physical_input_generation
            .load(Ordering::Acquire)
            == input_generation
}

/// NSPasteboard 通用剪贴板的 changeCount（任意线程可读）。
pub(crate) fn pasteboard_change_count() -> isize {
    let pb = objc2_app_kit::NSPasteboard::generalPasteboard();
    pb.changeCount()
}

/// 捕获结果：文本或图片附件。
pub enum Captured {
    Text(String),
    Image { file: String, w: u32, h: u32 },
}

/// 捕获当前前台应用的选中内容（文本优先，其次剪贴板图片）。
/// 阻塞调用（含 sleep），须在非主线程执行。
pub fn capture_selection(
    app: &AppHandle,
    source: &crate::focus::FrontApp,
    input_generation: u64,
) -> Option<Captured> {
    if !same_capture_context(app, source, input_generation) {
        crate::diag::push(app, "捕获: 前台上下文已变化，已中止");
        return None;
    }
    match ax::selected_text() {
        AxSelection::Text(t) => {
            if !same_capture_context(app, source, input_generation) {
                crate::diag::push(app, "捕获: AX 读取期间前台已变化，已中止");
                return None;
            }
            crate::diag::push(app, "捕获: AX 直读成功");
            normalize(t).map(Captured::Text)
        }
        // 「空」不可信：Otty 等终端的 AX 声明支持 AXSelectedText 但从不填充
        // （连 range 都谎报 0，实测实锤）。空时仍走剪贴板路径。
        AxSelection::Empty => {
            crate::diag::push(app, "捕获: AX 报空(不可信) → 剪贴板路径");
            capture_via_clipboard(app, source, input_generation)
        }
        AxSelection::Unsupported => {
            crate::diag::push(app, "捕获: AX 不支持 → 剪贴板路径");
            capture_via_clipboard(app, source, input_generation)
        }
    }
}

fn capture_via_clipboard(
    app: &AppHandle,
    source: &crate::focus::FrontApp,
    input_generation: u64,
) -> Option<Captured> {
    let Some(permit) = crate::pasteboard::try_claim(app) else {
        crate::diag::push(app, "捕获: 剪贴板事务忙，已跳过复制回退");
        return None;
    };
    let transaction = match PasteboardTransaction::capture_original() {
        Ok(transaction) => transaction,
        Err(error) => {
            crate::diag::push(app, format!("捕获: 剪贴板快照失败 ({error})"));
            return None;
        }
    };
    let mut runtime = NativeClipboardCapture {
        app,
        transaction,
        source: source.clone(),
        input_generation,
    };
    let attempt = execute_clipboard_capture(&mut runtime);
    drop(permit);
    crate::diag::push(
        app,
        format!("捕获: 剪贴板事务 {}", attempt.clipboard_outcome.as_str()),
    );

    match attempt.payload {
        Some(CopyPayload::Text(text)) => normalize(text).map(Captured::Text),
        Some(CopyPayload::Image {
            width,
            height,
            rgba,
        }) => {
            let (Ok(w), Ok(h)) = (u32::try_from(width), u32::try_from(height)) else {
                crate::diag::push(app, "捕获: 图片尺寸超出支持范围");
                return None;
            };
            match crate::storage::save_image_rgba(app, width, height, &rgba) {
                Ok(file) => {
                    crate::diag::push(app, format!("捕获: 图片 {}×{}", width, height));
                    Some(Captured::Image { file, w, h })
                }
                Err(error) => {
                    crate::diag::push(app, format!("捕获: 图片保存失败 {error}"));
                    None
                }
            }
        }
        None => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum CopyPayload {
    Text(String),
    Image {
        width: usize,
        height: usize,
        rgba: Vec<u8>,
    },
}

struct CaptureAttempt {
    payload: Option<CopyPayload>,
    clipboard_outcome: ClipboardOutcome,
}

trait ClipboardCaptureRuntime {
    fn original_change_count(&self) -> isize;
    fn context_valid(&mut self) -> bool;
    fn press_copy(&mut self) -> bool;
    fn wait_for_change(&mut self, before: isize) -> CopyObservation;
    fn claim_change(&mut self, observed: isize) -> bool;
    fn abandon_change(&mut self);
    fn current_change_count(&self) -> isize;
    fn read_payload(&mut self) -> Option<CopyPayload>;
    fn restore(&mut self) -> ClipboardOutcome;
}

fn claim_current(runtime: &mut impl ClipboardCaptureRuntime, change_count: isize) -> bool {
    if !runtime.claim_change(change_count) || runtime.current_change_count() != change_count {
        runtime.abandon_change();
        false
    } else {
        true
    }
}

fn execute_clipboard_capture(runtime: &mut impl ClipboardCaptureRuntime) -> CaptureAttempt {
    let before = runtime.original_change_count();
    let observed = if runtime.context_valid() && runtime.press_copy() {
        runtime.wait_for_change(before)
    } else {
        CopyObservation::None
    };
    let payload = match observed {
        CopyObservation::Accepted(change_count) => {
            let context_valid_for_payload = runtime.context_valid();
            if !claim_current(runtime, change_count) || !context_valid_for_payload {
                None
            } else {
                let payload = runtime.read_payload();
                let context_valid = runtime.context_valid();
                let still_owned = runtime.current_change_count() == change_count;
                if context_valid && still_owned {
                    payload
                } else {
                    // claim 后的普通键鼠输入只影响 payload 可信度；若 generation 未变，
                    // 仍安全恢复原剪贴板。只有 pasteboard 真正改写才放弃所有权。
                    if !still_owned {
                        runtime.abandon_change();
                    }
                    None
                }
            }
        }
        CopyObservation::Late(change_count) | CopyObservation::RecoveryOnly(change_count) => {
            // 超过采纳窗的写入只认领后恢复，绝不作为捕获结果。
            let _ = claim_current(runtime, change_count);
            None
        }
        CopyObservation::Invalid => {
            runtime.abandon_change();
            None
        }
        _ => None,
    };
    CaptureAttempt {
        payload,
        clipboard_outcome: runtime.restore(),
    }
}

struct NativeClipboardCapture<'a> {
    app: &'a AppHandle,
    transaction: PasteboardTransaction,
    source: crate::focus::FrontApp,
    input_generation: u64,
}

impl ClipboardCaptureRuntime for NativeClipboardCapture<'_> {
    fn original_change_count(&self) -> isize {
        self.transaction.original_change_count()
    }

    fn context_valid(&mut self) -> bool {
        same_capture_context(self.app, &self.source, self.input_generation)
    }

    fn press_copy(&mut self) -> bool {
        synth::press_copy().is_ok()
    }

    fn wait_for_change(&mut self, before: isize) -> CopyObservation {
        let mut observation = RevisionObservation::default();
        for attempt in 0..(POLL_ATTEMPTS + RECOVERY_GRACE_ATTEMPTS) {
            std::thread::sleep(POLL_INTERVAL);
            if !self.context_valid() {
                return observation
                    .recovery_candidate()
                    .map(CopyObservation::RecoveryOnly)
                    .unwrap_or(CopyObservation::Invalid);
            }
            observation.observe(before, self.transaction.current_change_count(), attempt);
        }
        observation.finish(POLL_ATTEMPTS)
    }

    fn claim_change(&mut self, observed: isize) -> bool {
        self.transaction.claim_external_write(observed)
    }

    fn abandon_change(&mut self) {
        self.transaction.abandon_external_write();
    }

    fn current_change_count(&self) -> isize {
        self.transaction.current_change_count()
    }

    fn read_payload(&mut self) -> Option<CopyPayload> {
        let mut clipboard = arboard::Clipboard::new().ok()?;
        if let Ok(text) = clipboard.get_text() {
            if !text.is_empty() {
                return Some(CopyPayload::Text(text));
            }
        }
        clipboard.get_image().ok().map(|image| CopyPayload::Image {
            width: image.width,
            height: image.height,
            rgba: image.bytes.into_owned(),
        })
    }

    fn restore(&mut self) -> ClipboardOutcome {
        let outcome = self.transaction.restore_if_owned();
        let last_toskr_write_count = self.transaction.last_toskr_write_count();
        if matches!(
            outcome,
            ClipboardOutcome::Restored | ClipboardOutcome::RestoreFailed
        ) {
            if let Some(exact_count) = last_toskr_write_count {
                crate::clipwatch::mark_self_write_count(self.app, exact_count);
            }
        }
        outcome
    }
}

/// 去掉首尾空白；全空白视为无效捕获。
fn normalize(text: String) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct FakeCaptureRuntime {
        original: isize,
        context_valid: bool,
        context_checks: VecDeque<bool>,
        copy_succeeds: bool,
        observed: CopyObservation,
        claim_succeeds: bool,
        current_counts: Vec<isize>,
        current_index: usize,
        payload: Option<CopyPayload>,
        restore_outcome: ClipboardOutcome,
        read_calls: usize,
        restore_calls: usize,
        copy_calls: usize,
        claim_calls: usize,
        abandon_calls: usize,
    }

    impl Default for FakeCaptureRuntime {
        fn default() -> Self {
            Self {
                original: 10,
                context_valid: true,
                context_checks: VecDeque::new(),
                copy_succeeds: true,
                observed: CopyObservation::Accepted(11),
                claim_succeeds: true,
                current_counts: vec![11, 11],
                current_index: 0,
                payload: Some(CopyPayload::Text("new selection".into())),
                restore_outcome: ClipboardOutcome::Restored,
                read_calls: 0,
                restore_calls: 0,
                copy_calls: 0,
                claim_calls: 0,
                abandon_calls: 0,
            }
        }
    }

    impl ClipboardCaptureRuntime for FakeCaptureRuntime {
        fn original_change_count(&self) -> isize {
            self.original
        }

        fn context_valid(&mut self) -> bool {
            self.context_checks
                .pop_front()
                .unwrap_or(self.context_valid)
        }

        fn press_copy(&mut self) -> bool {
            self.copy_calls += 1;
            self.copy_succeeds
        }

        fn wait_for_change(&mut self, _before: isize) -> CopyObservation {
            self.observed
        }

        fn claim_change(&mut self, _observed: isize) -> bool {
            self.claim_calls += 1;
            self.claim_succeeds
        }

        fn abandon_change(&mut self) {
            self.abandon_calls += 1;
        }

        fn current_change_count(&self) -> isize {
            let index = self.current_index.min(self.current_counts.len() - 1);
            self.current_counts[index]
        }

        fn read_payload(&mut self) -> Option<CopyPayload> {
            self.read_calls += 1;
            self.current_index += 1;
            self.payload.clone()
        }

        fn restore(&mut self) -> ClipboardOutcome {
            self.restore_calls += 1;
            self.restore_outcome
        }
    }

    #[test]
    fn copy_failure_never_reads_historical_clipboard_and_still_finishes_transaction() {
        let mut runtime = FakeCaptureRuntime {
            copy_succeeds: false,
            payload: Some(CopyPayload::Text("historical".into())),
            restore_outcome: ClipboardOutcome::NothingToRestore,
            ..FakeCaptureRuntime::default()
        };

        let result = execute_clipboard_capture(&mut runtime);

        assert!(result.payload.is_none());
        assert_eq!(result.clipboard_outcome, ClipboardOutcome::NothingToRestore);
        assert_eq!(runtime.read_calls, 0);
        assert_eq!(runtime.restore_calls, 1);
    }

    #[test]
    fn context_drift_stops_before_copy_or_clipboard_read() {
        let mut runtime = FakeCaptureRuntime {
            context_valid: false,
            ..FakeCaptureRuntime::default()
        };

        let result = execute_clipboard_capture(&mut runtime);

        assert!(result.payload.is_none());
        assert_eq!(runtime.copy_calls, 0);
        assert_eq!(runtime.read_calls, 0);
        assert_eq!(runtime.restore_calls, 1);
    }

    #[test]
    fn timeout_never_reads_historical_clipboard_and_still_finishes_transaction() {
        let mut runtime = FakeCaptureRuntime {
            observed: CopyObservation::None,
            payload: Some(CopyPayload::Text("historical".into())),
            restore_outcome: ClipboardOutcome::NothingToRestore,
            ..FakeCaptureRuntime::default()
        };

        let result = execute_clipboard_capture(&mut runtime);

        assert!(result.payload.is_none());
        assert_eq!(runtime.read_calls, 0);
        assert_eq!(runtime.restore_calls, 1);
    }

    #[test]
    fn no_selection_payload_restores_without_adopting_historical_content() {
        let mut runtime = FakeCaptureRuntime {
            payload: None,
            ..FakeCaptureRuntime::default()
        };

        let result = execute_clipboard_capture(&mut runtime);

        assert!(result.payload.is_none());
        assert_eq!(result.clipboard_outcome, ClipboardOutcome::Restored);
        assert_eq!(runtime.read_calls, 1);
        assert_eq!(runtime.restore_calls, 1);
    }

    #[test]
    fn delayed_copy_is_accepted_only_after_its_change_count_is_observed() {
        let mut runtime = FakeCaptureRuntime::default();

        let result = execute_clipboard_capture(&mut runtime);

        assert_eq!(
            result.payload,
            Some(CopyPayload::Text("new selection".into()))
        );
        assert_eq!(result.clipboard_outcome, ClipboardOutcome::Restored);
        assert_eq!(runtime.read_calls, 1);
        assert_eq!(runtime.restore_calls, 1);
    }

    #[test]
    fn copy_after_acceptance_window_is_restored_but_never_adopted() {
        let mut runtime = FakeCaptureRuntime {
            observed: CopyObservation::Late(11),
            payload: Some(CopyPayload::Text("late selection".into())),
            ..FakeCaptureRuntime::default()
        };

        let result = execute_clipboard_capture(&mut runtime);

        assert!(result.payload.is_none());
        assert_eq!(result.clipboard_outcome, ClipboardOutcome::Restored);
        assert_eq!(runtime.claim_calls, 1);
        assert_eq!(runtime.read_calls, 0);
        assert_eq!(runtime.restore_calls, 1);
    }

    #[test]
    fn real_input_drift_after_observation_restores_but_never_reads() {
        let mut runtime = FakeCaptureRuntime {
            context_checks: VecDeque::from([true, false]),
            restore_outcome: ClipboardOutcome::Restored,
            ..FakeCaptureRuntime::default()
        };

        let result = execute_clipboard_capture(&mut runtime);

        assert!(result.payload.is_none());
        assert_eq!(result.clipboard_outcome, ClipboardOutcome::Restored);
        assert_eq!(runtime.claim_calls, 1);
        assert_eq!(runtime.read_calls, 0);
        assert_eq!(runtime.abandon_calls, 0);
    }

    #[test]
    fn recovery_only_candidate_restores_when_generation_is_unchanged() {
        let mut runtime = FakeCaptureRuntime {
            observed: CopyObservation::RecoveryOnly(11),
            current_counts: vec![11],
            restore_outcome: ClipboardOutcome::Restored,
            ..FakeCaptureRuntime::default()
        };

        let result = execute_clipboard_capture(&mut runtime);

        assert!(result.payload.is_none());
        assert_eq!(result.clipboard_outcome, ClipboardOutcome::Restored);
        assert_eq!(runtime.claim_calls, 1);
        assert_eq!(runtime.read_calls, 0);
        assert_eq!(runtime.abandon_calls, 0);
    }

    #[test]
    fn recovery_only_candidate_preserves_a_newer_generation() {
        let mut runtime = FakeCaptureRuntime {
            observed: CopyObservation::RecoveryOnly(11),
            current_counts: vec![12],
            restore_outcome: ClipboardOutcome::SkippedUserChanged,
            ..FakeCaptureRuntime::default()
        };

        let result = execute_clipboard_capture(&mut runtime);

        assert!(result.payload.is_none());
        assert_eq!(
            result.clipboard_outcome,
            ClipboardOutcome::SkippedUserChanged
        );
        assert_eq!(runtime.claim_calls, 1);
        assert_eq!(runtime.read_calls, 0);
        assert_eq!(runtime.abandon_calls, 1);
    }

    #[test]
    fn change_during_read_discards_unowned_content() {
        let mut runtime = FakeCaptureRuntime {
            current_counts: vec![11, 12],
            payload: Some(CopyPayload::Text("unrelated user copy".into())),
            restore_outcome: ClipboardOutcome::SkippedUserChanged,
            ..FakeCaptureRuntime::default()
        };

        let result = execute_clipboard_capture(&mut runtime);

        assert!(result.payload.is_none());
        assert_eq!(
            result.clipboard_outcome,
            ClipboardOutcome::SkippedUserChanged
        );
        assert_eq!(runtime.read_calls, 1);
        assert_eq!(runtime.abandon_calls, 1);
        assert_eq!(runtime.restore_calls, 1);
    }

    #[test]
    fn input_drift_after_claim_discards_payload_but_still_restores_owned_revision() {
        let mut runtime = FakeCaptureRuntime {
            context_checks: VecDeque::from([true, true, false]),
            current_counts: vec![11, 11],
            restore_outcome: ClipboardOutcome::Restored,
            ..FakeCaptureRuntime::default()
        };

        let result = execute_clipboard_capture(&mut runtime);

        assert!(result.payload.is_none());
        assert_eq!(result.clipboard_outcome, ClipboardOutcome::Restored);
        assert_eq!(runtime.claim_calls, 1);
        assert_eq!(runtime.read_calls, 1);
        assert_eq!(runtime.abandon_calls, 0);
        assert_eq!(runtime.restore_calls, 1);
    }

    #[test]
    fn one_stable_revision_is_the_only_accepted_observation() {
        let mut observation = RevisionObservation::default();
        for (attempt, current) in [10, 11, 11, 11].into_iter().enumerate() {
            observation.observe(10, current, attempt);
        }

        assert_eq!(
            observation.finish(POLL_ATTEMPTS),
            CopyObservation::Accepted(11)
        );
    }

    #[test]
    fn unrelated_then_target_revisions_are_rejected() {
        let mut observation = RevisionObservation::default();
        for (attempt, current) in [11, 12, 12].into_iter().enumerate() {
            observation.observe(10, current, attempt);
        }

        assert_eq!(observation.finish(POLL_ATTEMPTS), CopyObservation::Invalid);
    }

    #[test]
    fn target_then_user_revisions_are_rejected() {
        let mut observation = RevisionObservation::default();
        for (attempt, current) in [11, 11, 12].into_iter().enumerate() {
            observation.observe(10, current, attempt);
        }

        assert_eq!(observation.finish(POLL_ATTEMPTS), CopyObservation::Invalid);
    }

    #[test]
    fn revision_first_seen_in_recovery_grace_is_late() {
        let mut observation = RevisionObservation::default();
        for attempt in 0..(POLL_ATTEMPTS + RECOVERY_GRACE_ATTEMPTS) {
            let current = if attempt < POLL_ATTEMPTS { 10 } else { 11 };
            observation.observe(10, current, attempt);
        }

        assert_eq!(observation.finish(POLL_ATTEMPTS), CopyObservation::Late(11));
    }

    #[test]
    fn one_unrelated_revision_is_indistinguishable_without_writer_provenance() {
        let mut observation = RevisionObservation::default();
        for attempt in 0..POLL_ATTEMPTS {
            observation.observe(10, 11, attempt);
        }

        // changeCount 没有 writer PID；生产路径还必须同时通过前台身份与真实输入代数门。
        assert_eq!(
            observation.finish(POLL_ATTEMPTS),
            CopyObservation::Accepted(11)
        );
    }
}
