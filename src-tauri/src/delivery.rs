//! 单一投递状态机与跨前后端结构化契约。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub use crate::pasteboard::ClipboardOutcome;
use crate::pasteboard::PasteboardTransaction;
use crate::target::{TargetReason, TargetSnapshot, ValidationGate};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendDeliveryRequest {
    pub target_token: Option<String>,
    pub text: String,
    pub image_files: Vec<String>,
    pub press_enter: bool,
    pub keep_panel: bool,
    pub delivery_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Sent,
    Blocked,
    Failed,
}

impl DeliveryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sent => "sent",
            Self::Blocked => "blocked",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryReasonCode {
    Ok,
    TargetMissing,
    TargetTokenMissing,
    TargetTokenStale,
    TargetExited,
    TargetBundleMismatch,
    TargetProcessMismatch,
    TargetIdentityUnavailable,
    TargetNotFrontmost,
    TargetFocusDrift,
    DeliveryInProgress,
    PayloadEmpty,
    ImageUnreadable,
    PasteFailed,
    EnterFailed,
    InternalError,
}

impl DeliveryReasonCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::TargetMissing => "target_missing",
            Self::TargetTokenMissing => "target_token_missing",
            Self::TargetTokenStale => "target_token_stale",
            Self::TargetExited => "target_exited",
            Self::TargetBundleMismatch => "target_bundle_mismatch",
            Self::TargetProcessMismatch => "target_process_mismatch",
            Self::TargetIdentityUnavailable => "target_identity_unavailable",
            Self::TargetNotFrontmost => "target_not_frontmost",
            Self::TargetFocusDrift => "target_focus_drift",
            Self::DeliveryInProgress => "delivery_in_progress",
            Self::PayloadEmpty => "payload_empty",
            Self::ImageUnreadable => "image_unreadable",
            Self::PasteFailed => "paste_failed",
            Self::EnterFailed => "enter_failed",
            Self::InternalError => "internal_error",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendDeliveryResult {
    pub delivery_id: String,
    pub status: DeliveryStatus,
    pub reason_code: DeliveryReasonCode,
    pub message: String,
    pub target: Option<TargetSnapshot>,
    pub paste_completed: bool,
    pub enter_pressed: bool,
    pub clipboard_outcome: ClipboardOutcome,
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
}

#[derive(Clone, Debug)]
pub struct DeliveryFailure {
    pub reason_code: DeliveryReasonCode,
    pub message: String,
}

impl DeliveryFailure {
    pub fn new(reason_code: DeliveryReasonCode, message: impl Into<String>) -> Self {
        Self {
            reason_code,
            message: message.into(),
        }
    }
}

pub trait DeliveryRuntime {
    fn now_ms(&self) -> i64;
    fn target_snapshot(&self) -> TargetSnapshot;
    fn validate_target(
        &mut self,
        snapshot: &TargetSnapshot,
        token: Option<&str>,
        gate: ValidationGate,
    ) -> Result<TargetSnapshot, TargetReason>;
    fn prepare_payload(&mut self, request: &SendDeliveryRequest) -> Result<(), DeliveryFailure>;
    fn activation_context_valid(&mut self, target: &TargetSnapshot) -> bool;
    fn prepare_window(&mut self, target: &TargetSnapshot, keep_panel: bool);
    fn activate_target(&mut self, target: &TargetSnapshot) -> bool;
    fn wait_for_target(&mut self, target: &TargetSnapshot) -> bool;
    fn pause(&mut self, millis: u64);
    fn stage_text(&mut self, text: &str) -> Result<(), DeliveryFailure>;
    fn stage_image(&mut self, index: usize) -> Result<(), DeliveryFailure>;
    fn paste_staged(&mut self, kind: PayloadKind) -> Result<(), DeliveryFailure>;
    fn press_enter(&mut self) -> Result<(), DeliveryFailure>;
    fn finish_clipboard(&mut self, delayed_restore: bool) -> ClipboardOutcome;
}

#[derive(Clone, Copy)]
pub enum PayloadKind {
    Text,
    Image,
}

fn message_with_clipboard(message: impl Into<String>, outcome: ClipboardOutcome) -> String {
    let suffix = match outcome {
        ClipboardOutcome::Restored => " · 原剪贴板已恢复",
        ClipboardOutcome::RestoredPartial => " · 原剪贴板可读内容已恢复（不可读取格式未恢复）",
        ClipboardOutcome::SkippedUserChanged => " · 已保留你刚复制的内容",
        ClipboardOutcome::RestoreFailed => " · 原剪贴板恢复失败",
        ClipboardOutcome::NotOwned => " · 剪贴板所有权已变化",
        ClipboardOutcome::NothingToRestore => "",
    };
    format!("{}{suffix}", message.into())
}

fn reason_code(reason: TargetReason) -> DeliveryReasonCode {
    match reason {
        TargetReason::TargetMissing => DeliveryReasonCode::TargetMissing,
        TargetReason::TargetTokenMissing => DeliveryReasonCode::TargetTokenMissing,
        TargetReason::TargetTokenStale => DeliveryReasonCode::TargetTokenStale,
        TargetReason::TargetExited => DeliveryReasonCode::TargetExited,
        TargetReason::TargetBundleMismatch => DeliveryReasonCode::TargetBundleMismatch,
        TargetReason::TargetProcessMismatch => DeliveryReasonCode::TargetProcessMismatch,
        TargetReason::TargetIdentityUnavailable => DeliveryReasonCode::TargetIdentityUnavailable,
        TargetReason::TargetNotFrontmost => DeliveryReasonCode::TargetNotFrontmost,
    }
}

fn blocked_message(reason: DeliveryReasonCode) -> &'static str {
    match reason {
        DeliveryReasonCode::TargetTokenMissing | DeliveryReasonCode::TargetMissing => {
            "发送中止：没有可验证的目标应用"
        }
        DeliveryReasonCode::TargetExited => "发送中止：目标应用已退出",
        DeliveryReasonCode::TargetBundleMismatch
        | DeliveryReasonCode::TargetProcessMismatch
        | DeliveryReasonCode::TargetTokenStale => "发送中止：目标应用身份已变化，请重试",
        DeliveryReasonCode::TargetIdentityUnavailable => "发送中止：无法确认目标应用身份",
        DeliveryReasonCode::TargetNotFrontmost | DeliveryReasonCode::TargetFocusDrift => {
            "发送中止：目标应用未处于前台"
        }
        DeliveryReasonCode::DeliveryInProgress => "发送中止：已有投递正在进行",
        _ => "发送中止",
    }
}

fn blocked_result(
    runtime: &mut impl DeliveryRuntime,
    delivery_id: &str,
    reason_code: DeliveryReasonCode,
    target: Option<TargetSnapshot>,
    started_at_ms: i64,
    paste_completed: bool,
) -> SendDeliveryResult {
    let clipboard_outcome = runtime.finish_clipboard(false);
    SendDeliveryResult {
        delivery_id: delivery_id.into(),
        status: DeliveryStatus::Blocked,
        reason_code,
        message: message_with_clipboard(blocked_message(reason_code), clipboard_outcome),
        target,
        paste_completed,
        enter_pressed: false,
        clipboard_outcome,
        started_at_ms,
        finished_at_ms: runtime.now_ms().max(started_at_ms),
    }
}

fn sent_result(
    runtime: &mut impl DeliveryRuntime,
    delivery_id: &str,
    target: TargetSnapshot,
    started_at_ms: i64,
    enter_pressed: bool,
) -> SendDeliveryResult {
    let app_name = target.app_name.as_deref().unwrap_or("目标应用").to_string();
    let clipboard_outcome = runtime.finish_clipboard(true);
    SendDeliveryResult {
        delivery_id: delivery_id.into(),
        status: DeliveryStatus::Sent,
        reason_code: DeliveryReasonCode::Ok,
        message: message_with_clipboard(format!("已发送到 {app_name}"), clipboard_outcome),
        target: Some(target),
        paste_completed: true,
        enter_pressed,
        clipboard_outcome,
        started_at_ms,
        finished_at_ms: runtime.now_ms().max(started_at_ms),
    }
}

fn failed_result(
    runtime: &mut impl DeliveryRuntime,
    delivery_id: &str,
    failure: DeliveryFailure,
    target: Option<TargetSnapshot>,
    started_at_ms: i64,
    paste_completed: bool,
) -> SendDeliveryResult {
    let clipboard_outcome = runtime.finish_clipboard(false);
    SendDeliveryResult {
        delivery_id: delivery_id.into(),
        status: DeliveryStatus::Failed,
        reason_code: failure.reason_code,
        message: message_with_clipboard(failure.message, clipboard_outcome),
        target,
        paste_completed,
        enter_pressed: false,
        clipboard_outcome,
        started_at_ms,
        finished_at_ms: runtime.now_ms().max(started_at_ms),
    }
}

pub fn execute_delivery(
    runtime: &mut impl DeliveryRuntime,
    request: &SendDeliveryRequest,
) -> SendDeliveryResult {
    let started_at_ms = runtime.now_ms();
    if request.target_token.as_deref().is_none_or(str::is_empty) {
        return blocked_result(
            runtime,
            &request.delivery_id,
            DeliveryReasonCode::TargetTokenMissing,
            None,
            started_at_ms,
            false,
        );
    }
    let snapshot = runtime.target_snapshot();
    if let Err(reason) = runtime.validate_target(
        &snapshot,
        request.target_token.as_deref(),
        ValidationGate::Identity,
    ) {
        return blocked_result(
            runtime,
            &request.delivery_id,
            reason_code(reason),
            Some(snapshot),
            started_at_ms,
            false,
        );
    }
    if request.text.trim().is_empty() && request.image_files.is_empty() {
        return failed_result(
            runtime,
            &request.delivery_id,
            DeliveryFailure::new(DeliveryReasonCode::PayloadEmpty, "发送失败：内容为空"),
            Some(snapshot),
            started_at_ms,
            false,
        );
    }
    if let Err(failure) = runtime.prepare_payload(request) {
        return failed_result(
            runtime,
            &request.delivery_id,
            failure,
            Some(snapshot),
            started_at_ms,
            false,
        );
    }
    // 图片预读可能耗时；激活旧目标前重新确认观察器 token 与前台上下文都未漂移。
    if let Err(reason) = runtime.validate_target(
        &snapshot,
        request.target_token.as_deref(),
        ValidationGate::Identity,
    ) {
        return blocked_result(
            runtime,
            &request.delivery_id,
            reason_code(reason),
            Some(snapshot),
            started_at_ms,
            false,
        );
    }
    if !runtime.activation_context_valid(&snapshot) {
        return blocked_result(
            runtime,
            &request.delivery_id,
            DeliveryReasonCode::TargetFocusDrift,
            Some(snapshot),
            started_at_ms,
            false,
        );
    }
    runtime.prepare_window(&snapshot, request.keep_panel);
    // 隐藏面板本身会改变前台应用；在真正激活旧目标前再次拒绝第三方抢占。
    if !runtime.activation_context_valid(&snapshot) {
        return blocked_result(
            runtime,
            &request.delivery_id,
            DeliveryReasonCode::TargetFocusDrift,
            Some(snapshot),
            started_at_ms,
            false,
        );
    }
    if !runtime.activate_target(&snapshot) {
        let code = runtime
            .validate_target(
                &snapshot,
                request.target_token.as_deref(),
                ValidationGate::Identity,
            )
            .err()
            .map(reason_code)
            .unwrap_or(DeliveryReasonCode::TargetNotFrontmost);
        return blocked_result(
            runtime,
            &request.delivery_id,
            code,
            Some(snapshot),
            started_at_ms,
            false,
        );
    }
    if !runtime.wait_for_target(&snapshot) {
        let code = runtime
            .validate_target(
                &snapshot,
                request.target_token.as_deref(),
                ValidationGate::Identity,
            )
            .err()
            .map(reason_code)
            .unwrap_or(DeliveryReasonCode::TargetNotFrontmost);
        return blocked_result(
            runtime,
            &request.delivery_id,
            code,
            Some(snapshot),
            started_at_ms,
            false,
        );
    }
    runtime.pause(180);
    if !request.text.trim().is_empty() {
        if let Err(reason) = runtime.validate_target(
            &snapshot,
            request.target_token.as_deref(),
            ValidationGate::Frontmost,
        ) {
            return blocked_result(
                runtime,
                &request.delivery_id,
                reason_code(reason),
                Some(snapshot),
                started_at_ms,
                false,
            );
        }
        if let Err(failure) = runtime.stage_text(&request.text) {
            return failed_result(
                runtime,
                &request.delivery_id,
                failure,
                Some(snapshot),
                started_at_ms,
                false,
            );
        }
        if let Err(reason) = runtime.validate_target(
            &snapshot,
            request.target_token.as_deref(),
            ValidationGate::Frontmost,
        ) {
            let code = if reason == TargetReason::TargetNotFrontmost {
                DeliveryReasonCode::TargetFocusDrift
            } else {
                reason_code(reason)
            };
            return blocked_result(
                runtime,
                &request.delivery_id,
                code,
                Some(snapshot),
                started_at_ms,
                false,
            );
        }
        if let Err(failure) = runtime.paste_staged(PayloadKind::Text) {
            return failed_result(
                runtime,
                &request.delivery_id,
                failure,
                Some(snapshot),
                started_at_ms,
                false,
            );
        }
    }
    let mut completed_pastes = usize::from(!request.text.trim().is_empty());
    let expected_pastes = completed_pastes + request.image_files.len();
    for index in 0..request.image_files.len() {
        runtime.pause(700);
        if let Err(reason) = runtime.validate_target(
            &snapshot,
            request.target_token.as_deref(),
            ValidationGate::Frontmost,
        ) {
            let code = if reason == TargetReason::TargetNotFrontmost && completed_pastes > 0 {
                DeliveryReasonCode::TargetFocusDrift
            } else {
                reason_code(reason)
            };
            return blocked_result(
                runtime,
                &request.delivery_id,
                code,
                Some(snapshot),
                started_at_ms,
                completed_pastes == expected_pastes,
            );
        }
        if let Err(failure) = runtime.stage_image(index) {
            return failed_result(
                runtime,
                &request.delivery_id,
                failure,
                Some(snapshot),
                started_at_ms,
                false,
            );
        }
        if let Err(reason) = runtime.validate_target(
            &snapshot,
            request.target_token.as_deref(),
            ValidationGate::Frontmost,
        ) {
            let code = if reason == TargetReason::TargetNotFrontmost {
                DeliveryReasonCode::TargetFocusDrift
            } else {
                reason_code(reason)
            };
            return blocked_result(
                runtime,
                &request.delivery_id,
                code,
                Some(snapshot),
                started_at_ms,
                completed_pastes == expected_pastes,
            );
        }
        if let Err(failure) = runtime.paste_staged(PayloadKind::Image) {
            return failed_result(
                runtime,
                &request.delivery_id,
                failure,
                Some(snapshot),
                started_at_ms,
                false,
            );
        }
        completed_pastes += 1;
    }
    let paste_completed = completed_pastes == expected_pastes;
    if request.press_enter {
        runtime.pause(200);
        if let Err(reason) = runtime.validate_target(
            &snapshot,
            request.target_token.as_deref(),
            ValidationGate::Frontmost,
        ) {
            let code = if reason == TargetReason::TargetNotFrontmost {
                DeliveryReasonCode::TargetFocusDrift
            } else {
                reason_code(reason)
            };
            return blocked_result(
                runtime,
                &request.delivery_id,
                code,
                Some(snapshot),
                started_at_ms,
                paste_completed,
            );
        }
        if let Err(failure) = runtime.press_enter() {
            return failed_result(
                runtime,
                &request.delivery_id,
                failure,
                Some(snapshot),
                started_at_ms,
                paste_completed,
            );
        }
        return sent_result(runtime, &request.delivery_id, snapshot, started_at_ms, true);
    }
    sent_result(
        runtime,
        &request.delivery_id,
        snapshot,
        started_at_ms,
        false,
    )
}

struct NativeDeliveryRuntime {
    app: AppHandle,
    images: Vec<(usize, usize, Vec<u8>)>,
    transaction: Option<PasteboardTransaction>,
    clipboard_outcome: Option<ClipboardOutcome>,
}

impl NativeDeliveryRuntime {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
            images: Vec::new(),
            transaction: None,
            clipboard_outcome: None,
        }
    }
}

impl DeliveryRuntime for NativeDeliveryRuntime {
    fn now_ms(&self) -> i64 {
        crate::target::now_ms()
    }

    fn target_snapshot(&self) -> TargetSnapshot {
        crate::target::current_snapshot(&self.app.state())
    }

    fn validate_target(
        &mut self,
        snapshot: &TargetSnapshot,
        token: Option<&str>,
        gate: ValidationGate,
    ) -> Result<TargetSnapshot, TargetReason> {
        crate::target::ensure_token_current(&self.app.state(), token)?;
        crate::target::validate_snapshot(snapshot, token, &crate::target::SystemTargetProbe, gate)
    }

    fn prepare_payload(&mut self, request: &SendDeliveryRequest) -> Result<(), DeliveryFailure> {
        let mut images = Vec::with_capacity(request.image_files.len());
        for file in &request.image_files {
            let Some(image) = crate::storage::read_image_rgba(&self.app, file) else {
                return Err(DeliveryFailure::new(
                    DeliveryReasonCode::ImageUnreadable,
                    "发送失败：图片附件不可读取",
                ));
            };
            images.push(image);
        }
        self.transaction = Some(PasteboardTransaction::capture_original().map_err(|error| {
            DeliveryFailure::new(
                DeliveryReasonCode::PasteFailed,
                format!("发送失败：无法完整备份剪贴板（{error}）"),
            )
        })?);
        self.images = images;
        Ok(())
    }

    fn activation_context_valid(&mut self, target: &TargetSnapshot) -> bool {
        let me = std::process::id() as i32;
        crate::focus::frontmost_info()
            .is_some_and(|front| front.pid == me || target.pid.is_some_and(|pid| front.pid == pid))
    }

    fn prepare_window(&mut self, _target: &TargetSnapshot, keep_panel: bool) {
        if !keep_panel {
            crate::window::hide_panel(&self.app, false);
        }
    }

    fn activate_target(&mut self, target: &TargetSnapshot) -> bool {
        target.pid.is_some_and(crate::focus::activate_pid)
    }

    fn wait_for_target(&mut self, target: &TargetSnapshot) -> bool {
        target
            .pid
            .is_some_and(|pid| crate::focus::wait_frontmost(pid, 10, 40))
    }

    fn pause(&mut self, millis: u64) {
        std::thread::sleep(Duration::from_millis(millis));
    }

    fn stage_text(&mut self, text: &str) -> Result<(), DeliveryFailure> {
        let transaction = self.transaction.as_mut().ok_or_else(|| {
            DeliveryFailure::new(
                DeliveryReasonCode::InternalError,
                "发送失败：剪贴板事务未初始化",
            )
        })?;
        transaction.write_text(text).map_err(|error| {
            DeliveryFailure::new(
                DeliveryReasonCode::PasteFailed,
                format!("发送失败：无法写入文本（{error}）"),
            )
        })?;
        Ok(())
    }

    fn stage_image(&mut self, index: usize) -> Result<(), DeliveryFailure> {
        let Some((width, height, rgba)) = self.images.get(index) else {
            return Err(DeliveryFailure::new(
                DeliveryReasonCode::InternalError,
                "发送失败：图片投递状态异常",
            ));
        };
        let transaction = self.transaction.as_mut().ok_or_else(|| {
            DeliveryFailure::new(
                DeliveryReasonCode::InternalError,
                "发送失败：剪贴板事务未初始化",
            )
        })?;
        transaction
            .write_image(*width, *height, rgba)
            .map_err(|error| {
                DeliveryFailure::new(
                    DeliveryReasonCode::PasteFailed,
                    format!("发送失败：无法写入图片（{error}）"),
                )
            })?;
        Ok(())
    }

    fn paste_staged(&mut self, kind: PayloadKind) -> Result<(), DeliveryFailure> {
        let transaction = self.transaction.as_ref().ok_or_else(|| {
            DeliveryFailure::new(
                DeliveryReasonCode::InternalError,
                "发送失败：剪贴板事务未初始化",
            )
        })?;
        if !transaction.still_owns_current() {
            return Err(DeliveryFailure::new(
                DeliveryReasonCode::PasteFailed,
                "发送失败：剪贴板已被其他应用更新",
            ));
        }
        crate::input::synth::press_paste().map_err(|error| {
            DeliveryFailure::new(
                DeliveryReasonCode::PasteFailed,
                format!(
                    "发送失败：{}粘贴失败（{error}）",
                    match kind {
                        PayloadKind::Text => "文本",
                        PayloadKind::Image => "图片",
                    }
                ),
            )
        })?;
        if !transaction.still_owns_current() {
            return Err(DeliveryFailure::new(
                DeliveryReasonCode::PasteFailed,
                "发送失败：粘贴期间剪贴板已被其他应用更新",
            ));
        }
        Ok(())
    }

    fn press_enter(&mut self) -> Result<(), DeliveryFailure> {
        crate::input::synth::press_return().map_err(|error| {
            DeliveryFailure::new(
                DeliveryReasonCode::EnterFailed,
                format!("发送失败：回车失败（{error}）"),
            )
        })
    }

    fn finish_clipboard(&mut self, delayed_restore: bool) -> ClipboardOutcome {
        if let Some(outcome) = self.clipboard_outcome {
            return outcome;
        }
        if delayed_restore {
            std::thread::sleep(Duration::from_millis(1_500));
        }
        let outcome = match self.transaction.as_mut() {
            Some(transaction) => transaction.restore_if_owned(),
            None => ClipboardOutcome::NothingToRestore,
        };
        let last_toskr_write_count = self
            .transaction
            .as_ref()
            .and_then(PasteboardTransaction::last_toskr_write_count);
        if outcome.should_mark_self_write() {
            if let Some(exact_count) = last_toskr_write_count {
                crate::clipwatch::mark_self_write_count(&self.app, exact_count);
            }
        }
        self.clipboard_outcome = Some(outcome);
        outcome
    }
}

/// HUD 只消费结构化结果，command 层不重新猜测成功或失败原因。
pub fn hud_feedback(result: &SendDeliveryResult) -> (&'static str, &str) {
    (
        if result.status != DeliveryStatus::Sent
            || result.clipboard_outcome.warning_message().is_some()
        {
            "warn"
        } else {
            "sent"
        },
        result.message.as_str(),
    )
}

fn busy_result(app: &AppHandle, request: &SendDeliveryRequest) -> SendDeliveryResult {
    let at_ms = crate::target::now_ms();
    SendDeliveryResult {
        delivery_id: request.delivery_id.clone(),
        status: DeliveryStatus::Blocked,
        reason_code: DeliveryReasonCode::DeliveryInProgress,
        message: blocked_message(DeliveryReasonCode::DeliveryInProgress).into(),
        target: Some(crate::target::current_snapshot(&app.state())),
        paste_completed: false,
        enter_pressed: false,
        clipboard_outcome: ClipboardOutcome::NothingToRestore,
        started_at_ms: at_ms,
        finished_at_ms: at_ms,
    }
}

pub async fn execute_native(
    app: AppHandle,
    request: SendDeliveryRequest,
) -> Result<SendDeliveryResult, String> {
    let Some(permit) = crate::pasteboard::try_claim(&app) else {
        return Ok(busy_result(&app, &request));
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let mut runtime = NativeDeliveryRuntime::new(app);
        execute_delivery(&mut runtime, &request)
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::target::{TargetReason, ValidationGate};
    use std::collections::VecDeque;

    struct FakeRuntime {
        snapshot: TargetSnapshot,
        validations: VecDeque<Result<TargetSnapshot, TargetReason>>,
        validation_calls: usize,
        validation_gates: Vec<ValidationGate>,
        wait_ready: bool,
        activation_contexts: VecDeque<bool>,
        activation_context_calls: usize,
        activation_ready: bool,
        prepare_failure: Option<DeliveryFailure>,
        paste_failure_at: Option<usize>,
        enter_failure: bool,
        window_calls: usize,
        activation_calls: usize,
        stage_calls: usize,
        paste_calls: usize,
        enter_calls: usize,
        clipboard_outcome: Option<ClipboardOutcome>,
        clipboard_delays: Vec<bool>,
    }

    impl Default for FakeRuntime {
        fn default() -> Self {
            let snapshot = TargetSnapshot {
                token: Some("token-1".into()),
                pid: Some(42),
                bundle_id: Some("com.openai.codex".into()),
                app_name: Some("Codex".into()),
                launched_at_ms: Some(500),
                captured_at_ms: 900,
                revision: 1,
                ready: true,
                reason: None,
                window_id: None,
            };
            Self {
                validations: VecDeque::new(),
                snapshot,
                validation_calls: 0,
                validation_gates: Vec::new(),
                wait_ready: true,
                activation_contexts: VecDeque::new(),
                activation_context_calls: 0,
                activation_ready: true,
                prepare_failure: None,
                paste_failure_at: None,
                enter_failure: false,
                window_calls: 0,
                activation_calls: 0,
                stage_calls: 0,
                paste_calls: 0,
                enter_calls: 0,
                clipboard_outcome: None,
                clipboard_delays: Vec::new(),
            }
        }
    }

    impl DeliveryRuntime for FakeRuntime {
        fn now_ms(&self) -> i64 {
            1_000
        }

        fn target_snapshot(&self) -> TargetSnapshot {
            self.snapshot.clone()
        }

        fn validate_target(
            &mut self,
            _snapshot: &TargetSnapshot,
            _token: Option<&str>,
            gate: ValidationGate,
        ) -> Result<TargetSnapshot, TargetReason> {
            self.validation_calls += 1;
            self.validation_gates.push(gate);
            self.validations
                .pop_front()
                .unwrap_or_else(|| Ok(self.snapshot.clone()))
        }

        fn prepare_payload(
            &mut self,
            _request: &SendDeliveryRequest,
        ) -> Result<(), DeliveryFailure> {
            match self.prepare_failure.take() {
                Some(failure) => Err(failure),
                None => Ok(()),
            }
        }

        fn activation_context_valid(&mut self, _target: &TargetSnapshot) -> bool {
            self.activation_context_calls += 1;
            self.activation_contexts.pop_front().unwrap_or(true)
        }

        fn prepare_window(&mut self, _target: &TargetSnapshot, _keep_panel: bool) {
            self.window_calls += 1;
        }

        fn activate_target(&mut self, _target: &TargetSnapshot) -> bool {
            self.activation_calls += 1;
            self.activation_ready
        }

        fn wait_for_target(&mut self, _target: &TargetSnapshot) -> bool {
            self.wait_ready
        }

        fn pause(&mut self, _millis: u64) {}

        fn stage_text(&mut self, _text: &str) -> Result<(), DeliveryFailure> {
            self.stage_calls += 1;
            Ok(())
        }

        fn stage_image(&mut self, _index: usize) -> Result<(), DeliveryFailure> {
            self.stage_calls += 1;
            Ok(())
        }

        fn paste_staged(&mut self, _kind: PayloadKind) -> Result<(), DeliveryFailure> {
            self.paste_calls += 1;
            if self.paste_failure_at == Some(self.paste_calls) {
                Err(DeliveryFailure::new(
                    DeliveryReasonCode::PasteFailed,
                    "发送失败：粘贴失败",
                ))
            } else {
                Ok(())
            }
        }

        fn press_enter(&mut self) -> Result<(), DeliveryFailure> {
            self.enter_calls += 1;
            if self.enter_failure {
                Err(DeliveryFailure::new(
                    DeliveryReasonCode::EnterFailed,
                    "发送失败：回车失败",
                ))
            } else {
                Ok(())
            }
        }

        fn finish_clipboard(&mut self, delayed_restore: bool) -> ClipboardOutcome {
            self.clipboard_delays.push(delayed_restore);
            self.clipboard_outcome.unwrap_or_else(|| {
                if self.stage_calls > 0 {
                    ClipboardOutcome::Restored
                } else {
                    ClipboardOutcome::NothingToRestore
                }
            })
        }
    }

    fn request(token: Option<&str>) -> SendDeliveryRequest {
        SendDeliveryRequest {
            target_token: token.map(str::to_string),
            text: "hello".into(),
            image_files: vec![],
            press_enter: true,
            keep_panel: false,
            delivery_id: "delivery-1".into(),
        }
    }

    #[test]
    fn missing_target_token_blocks_without_synthesized_input() {
        let mut runtime = FakeRuntime::default();

        let result = execute_delivery(&mut runtime, &request(None));

        assert_eq!(result.status, DeliveryStatus::Blocked);
        assert_eq!(result.reason_code, DeliveryReasonCode::TargetTokenMissing);
        assert!(!result.paste_completed);
        assert!(!result.enter_pressed);
        assert_eq!(runtime.paste_calls, 0);
        assert_eq!(runtime.enter_calls, 0);
        assert_eq!(runtime.window_calls, 0);
        assert_eq!(runtime.activation_calls, 0);
    }

    #[test]
    fn bundle_mismatch_blocks_before_any_synthesized_input() {
        let mut runtime = FakeRuntime {
            validations: VecDeque::from([Err(TargetReason::TargetBundleMismatch)]),
            ..FakeRuntime::default()
        };

        let result = execute_delivery(&mut runtime, &request(Some("token-1")));

        assert_eq!(result.status, DeliveryStatus::Blocked);
        assert_eq!(result.reason_code, DeliveryReasonCode::TargetBundleMismatch);
        assert_eq!(runtime.validation_calls, 1);
        assert_eq!(runtime.paste_calls, 0);
        assert_eq!(runtime.enter_calls, 0);
        assert_eq!(runtime.window_calls, 0);
        assert_eq!(runtime.activation_calls, 0);
    }

    #[test]
    fn focus_drift_before_paste_blocks_without_paste() {
        let snapshot = FakeRuntime::default().snapshot;
        let mut runtime = FakeRuntime {
            validations: VecDeque::from([
                Ok(snapshot.clone()),
                Ok(snapshot),
                Err(TargetReason::TargetNotFrontmost),
            ]),
            ..FakeRuntime::default()
        };

        let result = execute_delivery(&mut runtime, &request(Some("token-1")));

        assert_eq!(result.status, DeliveryStatus::Blocked);
        assert_eq!(result.reason_code, DeliveryReasonCode::TargetNotFrontmost);
        assert_eq!(runtime.validation_calls, 3);
        assert_eq!(runtime.paste_calls, 0);
        assert_eq!(runtime.enter_calls, 0);
    }

    #[test]
    fn focus_drift_during_image_staging_blocks_before_paste() {
        let snapshot = FakeRuntime::default().snapshot;
        let mut req = request(Some("token-1"));
        req.text.clear();
        req.image_files = vec!["large.png".into()];
        req.press_enter = false;
        let mut runtime = FakeRuntime {
            validations: VecDeque::from([
                Ok(snapshot.clone()),
                Ok(snapshot.clone()),
                Ok(snapshot),
                Err(TargetReason::TargetNotFrontmost),
            ]),
            ..FakeRuntime::default()
        };

        let result = execute_delivery(&mut runtime, &req);

        assert_eq!(result.status, DeliveryStatus::Blocked);
        assert_eq!(result.reason_code, DeliveryReasonCode::TargetFocusDrift);
        assert_eq!(runtime.stage_calls, 1);
        assert_eq!(runtime.paste_calls, 0);
        assert_eq!(runtime.enter_calls, 0);
        assert_eq!(runtime.clipboard_delays, vec![false]);
    }

    #[test]
    fn focus_drift_after_paste_suppresses_enter() {
        let snapshot = FakeRuntime::default().snapshot;
        let mut runtime = FakeRuntime {
            validations: VecDeque::from([
                Ok(snapshot.clone()),
                Ok(snapshot.clone()),
                Ok(snapshot.clone()),
                Ok(snapshot),
                Err(TargetReason::TargetNotFrontmost),
            ]),
            ..FakeRuntime::default()
        };

        let result = execute_delivery(&mut runtime, &request(Some("token-1")));

        assert_eq!(result.status, DeliveryStatus::Blocked);
        assert_eq!(result.reason_code, DeliveryReasonCode::TargetFocusDrift);
        assert!(result.paste_completed);
        assert!(!result.enter_pressed);
        assert_eq!(runtime.paste_calls, 1);
        assert_eq!(runtime.enter_calls, 0);
        assert_eq!(runtime.clipboard_delays, vec![false]);
    }

    #[test]
    fn exited_target_returns_stable_reason_before_input() {
        let mut runtime = FakeRuntime {
            validations: VecDeque::from([Err(TargetReason::TargetExited)]),
            ..FakeRuntime::default()
        };

        let result = execute_delivery(&mut runtime, &request(Some("token-1")));

        assert_eq!(result.status, DeliveryStatus::Blocked);
        assert_eq!(result.reason_code, DeliveryReasonCode::TargetExited);
        assert_eq!(runtime.paste_calls, 0);
        assert_eq!(runtime.enter_calls, 0);
    }

    #[test]
    fn normal_text_send_pastes_then_enters() {
        let mut runtime = FakeRuntime::default();

        let result = execute_delivery(&mut runtime, &request(Some("token-1")));

        assert_eq!(result.status, DeliveryStatus::Sent);
        assert_eq!(result.reason_code, DeliveryReasonCode::Ok);
        assert!(result.paste_completed);
        assert!(result.enter_pressed);
        assert_eq!(runtime.validation_calls, 5);
        assert_eq!(
            runtime.validation_gates,
            vec![
                ValidationGate::Identity,
                ValidationGate::Identity,
                ValidationGate::Frontmost,
                ValidationGate::Frontmost,
                ValidationGate::Frontmost,
            ]
        );
        assert_eq!(runtime.paste_calls, 1);
        assert_eq!(runtime.enter_calls, 1);
        assert_eq!(result.message, "已发送到 Codex · 原剪贴板已恢复");
        assert_eq!(result.clipboard_outcome, ClipboardOutcome::Restored);
        assert_eq!(runtime.clipboard_delays, vec![true]);
        assert_eq!(result.delivery_id, "delivery-1");
    }

    #[test]
    fn every_image_has_its_own_frontmost_gate() {
        let mut req = request(Some("token-1"));
        req.text.clear();
        req.image_files = vec!["a.png".into(), "b.png".into()];
        req.press_enter = false;
        let mut runtime = FakeRuntime::default();

        let result = execute_delivery(&mut runtime, &req);

        assert_eq!(result.status, DeliveryStatus::Sent);
        assert_eq!(runtime.validation_calls, 6);
        assert_eq!(
            runtime.validation_gates,
            vec![
                ValidationGate::Identity,
                ValidationGate::Identity,
                ValidationGate::Frontmost,
                ValidationGate::Frontmost,
                ValidationGate::Frontmost,
                ValidationGate::Frontmost,
            ]
        );
        assert_eq!(runtime.paste_calls, 2);
        assert_eq!(runtime.enter_calls, 0);
    }

    #[test]
    fn observer_token_change_after_initial_gate_blocks_before_activation() {
        let snapshot = FakeRuntime::default().snapshot;
        let mut runtime = FakeRuntime {
            validations: VecDeque::from([Ok(snapshot), Err(TargetReason::TargetTokenStale)]),
            ..FakeRuntime::default()
        };

        let result = execute_delivery(&mut runtime, &request(Some("token-1")));

        assert_eq!(result.status, DeliveryStatus::Blocked);
        assert_eq!(result.reason_code, DeliveryReasonCode::TargetTokenStale);
        assert_eq!(runtime.window_calls, 0);
        assert_eq!(runtime.activation_calls, 0);
        assert_eq!(runtime.paste_calls, 0);
        assert_eq!(runtime.enter_calls, 0);
    }

    #[test]
    fn third_party_frontmost_before_activation_blocks_without_stealing_focus() {
        let mut runtime = FakeRuntime {
            activation_contexts: VecDeque::from([false]),
            ..FakeRuntime::default()
        };

        let result = execute_delivery(&mut runtime, &request(Some("token-1")));

        assert_eq!(result.status, DeliveryStatus::Blocked);
        assert_eq!(result.reason_code, DeliveryReasonCode::TargetFocusDrift);
        assert_eq!(runtime.window_calls, 0);
        assert_eq!(runtime.activation_calls, 0);
        assert_eq!(runtime.paste_calls, 0);
        assert_eq!(runtime.enter_calls, 0);
    }

    #[test]
    fn focus_change_after_window_prepare_blocks_before_activation() {
        let mut runtime = FakeRuntime {
            activation_contexts: VecDeque::from([true, false]),
            ..FakeRuntime::default()
        };

        let result = execute_delivery(&mut runtime, &request(Some("token-1")));

        assert_eq!(result.status, DeliveryStatus::Blocked);
        assert_eq!(result.reason_code, DeliveryReasonCode::TargetFocusDrift);
        assert_eq!(runtime.activation_context_calls, 2);
        assert_eq!(runtime.window_calls, 1);
        assert_eq!(runtime.activation_calls, 0);
        assert_eq!(runtime.paste_calls, 0);
        assert_eq!(runtime.enter_calls, 0);
    }

    #[test]
    fn activation_failure_reprobes_identity_for_accurate_reason() {
        let mut still_running = FakeRuntime {
            activation_ready: false,
            ..FakeRuntime::default()
        };
        let result = execute_delivery(&mut still_running, &request(Some("token-1")));
        assert_eq!(result.reason_code, DeliveryReasonCode::TargetNotFrontmost);
        assert_eq!(still_running.paste_calls, 0);
        assert_eq!(still_running.enter_calls, 0);

        let snapshot = FakeRuntime::default().snapshot;
        let mut exited = FakeRuntime {
            activation_ready: false,
            validations: VecDeque::from([
                Ok(snapshot.clone()),
                Ok(snapshot),
                Err(TargetReason::TargetExited),
            ]),
            ..FakeRuntime::default()
        };
        let result = execute_delivery(&mut exited, &request(Some("token-1")));
        assert_eq!(result.reason_code, DeliveryReasonCode::TargetExited);
        assert_eq!(exited.paste_calls, 0);
        assert_eq!(exited.enter_calls, 0);
    }

    #[test]
    fn unreadable_image_fails_before_window_or_input_side_effects() {
        let mut req = request(Some("token-1"));
        req.image_files = vec!["missing.png".into()];
        let mut runtime = FakeRuntime {
            prepare_failure: Some(DeliveryFailure::new(
                DeliveryReasonCode::ImageUnreadable,
                "发送失败：图片附件不可读取",
            )),
            ..FakeRuntime::default()
        };

        let result = execute_delivery(&mut runtime, &req);

        assert_eq!(result.status, DeliveryStatus::Failed);
        assert_eq!(result.reason_code, DeliveryReasonCode::ImageUnreadable);
        assert_eq!(runtime.window_calls, 0);
        assert_eq!(runtime.activation_calls, 0);
        assert_eq!(runtime.paste_calls, 0);
        assert_eq!(runtime.enter_calls, 0);
    }

    #[test]
    fn target_validation_reasons_map_to_stable_delivery_codes() {
        let cases = [
            (
                TargetReason::TargetMissing,
                DeliveryReasonCode::TargetMissing,
            ),
            (
                TargetReason::TargetTokenMissing,
                DeliveryReasonCode::TargetTokenMissing,
            ),
            (
                TargetReason::TargetTokenStale,
                DeliveryReasonCode::TargetTokenStale,
            ),
            (TargetReason::TargetExited, DeliveryReasonCode::TargetExited),
            (
                TargetReason::TargetBundleMismatch,
                DeliveryReasonCode::TargetBundleMismatch,
            ),
            (
                TargetReason::TargetProcessMismatch,
                DeliveryReasonCode::TargetProcessMismatch,
            ),
            (
                TargetReason::TargetIdentityUnavailable,
                DeliveryReasonCode::TargetIdentityUnavailable,
            ),
            (
                TargetReason::TargetNotFrontmost,
                DeliveryReasonCode::TargetNotFrontmost,
            ),
        ];

        for (target_reason, expected) in cases {
            let mut runtime = FakeRuntime {
                validations: VecDeque::from([Err(target_reason)]),
                ..FakeRuntime::default()
            };
            let result = execute_delivery(&mut runtime, &request(Some("token-1")));

            assert_eq!(result.reason_code, expected);
            assert_eq!(runtime.paste_calls, 0);
            assert_eq!(runtime.enter_calls, 0);
        }
    }

    #[test]
    fn payload_paste_and_enter_failures_keep_distinct_codes() {
        let mut empty_request = request(Some("token-1"));
        empty_request.text.clear();
        empty_request.press_enter = false;
        let mut empty_runtime = FakeRuntime::default();
        assert_eq!(
            execute_delivery(&mut empty_runtime, &empty_request).reason_code,
            DeliveryReasonCode::PayloadEmpty
        );

        let mut paste_runtime = FakeRuntime {
            paste_failure_at: Some(1),
            ..FakeRuntime::default()
        };
        assert_eq!(
            execute_delivery(&mut paste_runtime, &request(Some("token-1"))).reason_code,
            DeliveryReasonCode::PasteFailed
        );

        let mut enter_runtime = FakeRuntime {
            enter_failure: true,
            ..FakeRuntime::default()
        };
        assert_eq!(
            execute_delivery(&mut enter_runtime, &request(Some("token-1"))).reason_code,
            DeliveryReasonCode::EnterFailed
        );
    }

    #[test]
    fn hud_feedback_uses_the_exact_structured_result_message() {
        let mut sent_runtime = FakeRuntime::default();
        let sent = execute_delivery(&mut sent_runtime, &request(Some("token-1")));
        assert_eq!(hud_feedback(&sent), ("sent", sent.message.as_str()));

        let mut blocked_runtime = FakeRuntime {
            validations: VecDeque::from([Err(TargetReason::TargetExited)]),
            ..FakeRuntime::default()
        };
        let blocked = execute_delivery(&mut blocked_runtime, &request(Some("token-1")));
        assert_eq!(hud_feedback(&blocked), ("warn", blocked.message.as_str()));
    }

    #[test]
    fn sent_message_exposes_each_clipboard_outcome_without_reinterpreting_it() {
        let cases = [
            (ClipboardOutcome::Restored, " · 原剪贴板已恢复"),
            (
                ClipboardOutcome::RestoredPartial,
                " · 原剪贴板可读内容已恢复（不可读取格式未恢复）",
            ),
            (
                ClipboardOutcome::SkippedUserChanged,
                " · 已保留你刚复制的内容",
            ),
            (ClipboardOutcome::NothingToRestore, ""),
            (ClipboardOutcome::RestoreFailed, " · 原剪贴板恢复失败"),
            (ClipboardOutcome::NotOwned, " · 剪贴板所有权已变化"),
        ];

        for (clipboard_outcome, suffix) in cases {
            let mut runtime = FakeRuntime {
                clipboard_outcome: Some(clipboard_outcome),
                ..FakeRuntime::default()
            };
            let result = execute_delivery(&mut runtime, &request(Some("token-1")));

            assert_eq!(result.clipboard_outcome, clipboard_outcome);
            assert_eq!(result.message, format!("已发送到 Codex{suffix}"));
            let expected_kind = if clipboard_outcome.warning_message().is_some() {
                "warn"
            } else {
                "sent"
            };
            assert_eq!(
                hud_feedback(&result),
                (expected_kind, result.message.as_str())
            );
        }
    }
}
