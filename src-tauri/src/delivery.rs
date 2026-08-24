//! 单一发送状态机与跨前后端结构化契约。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub use crate::pasteboard::ClipboardOutcome;
use crate::pasteboard::PasteboardTransaction;
use crate::target::{TargetReason, TargetSnapshot, ValidationGate};

fn firewall_enabled_default() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendDeliveryRequest {
    pub target_token: Option<String>,
    pub text: String,
    pub image_files: Vec<String>,
    #[serde(default)]
    pub expected_image_pixel_hashes: Vec<Option<String>>,
    /// 预检中被用户逐项保留/确认的高风险文本 finding id（`rule_id:start:end`）。
    /// Native 发送前对 `text` 复扫，任何名单外的 Block finding 都拒发；
    /// id 绑定内容与位置，正文一改即失配，陈旧确认自动失效。
    #[serde(default)]
    pub allowed_text_finding_ids: Vec<String>,
    /// 缺省 true（fail-closed）：调用方漏传时按防火墙开启复核。
    #[serde(default = "firewall_enabled_default")]
    pub firewall_text_enabled: bool,
    /// 图文交错发送顺序（可选）。缺省时保持「文字整段在前、图片按清单序在后」。
    /// text 段必须是 `text` 字段的切片、image 段按下标引用 `image_files`，
    /// 完整性预读与像素哈希校验仍按清单执行，段只决定粘贴次序。
    #[serde(default)]
    pub segments: Option<Vec<DeliverySegment>>,
    pub press_enter: bool,
    pub keep_panel: bool,
    pub delivery_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeliverySegment {
    Text {
        text: String,
    },
    Image {
        #[serde(rename = "fileIndex")]
        file_index: usize,
    },
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
    ImageChanged,
    PrivacyIncomplete,
    PrivacyNativeBlocked,
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
            Self::ImageChanged => "image_changed",
            Self::PrivacyIncomplete => "privacy_incomplete",
            Self::PrivacyNativeBlocked => "privacy_native_blocked",
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
        DeliveryReasonCode::DeliveryInProgress => "发送中止：已有发送正在进行",
        DeliveryReasonCode::PrivacyIncomplete => {
            "发送中止：文本超出本地隐私扫描上限，无法在发送前复核"
        }
        DeliveryReasonCode::PrivacyNativeBlocked => {
            "发送中止：内容含未经预检确认的高风险敏感信息，请重新预检"
        }
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

enum PayloadStep<'a> {
    Text(&'a str),
    Image(usize),
}

const TEXT_ENTER_SETTLE_MS: u64 = 500;
const IMAGE_ENTER_SETTLE_MS: u64 = 900;

fn enter_settle_ms(steps: &[PayloadStep<'_>]) -> u64 {
    if matches!(steps.last(), Some(PayloadStep::Image(_))) {
        IMAGE_ENTER_SETTLE_MS
    } else {
        TEXT_ENTER_SETTLE_MS
    }
}

/// 把请求规范化为有序粘贴步骤。有 segments 时按段交错并校验引用完整
/// （下标越界、重复或漏图都判请求无效，宁可失败也不静默错序）；
/// 无 segments 时保持旧顺序：文字整段在前、图片按清单序在后。
fn payload_steps(request: &SendDeliveryRequest) -> Result<Vec<PayloadStep<'_>>, DeliveryFailure> {
    let Some(segments) = &request.segments else {
        let mut steps = Vec::with_capacity(1 + request.image_files.len());
        if !request.text.trim().is_empty() {
            steps.push(PayloadStep::Text(&request.text));
        }
        steps.extend((0..request.image_files.len()).map(PayloadStep::Image));
        return Ok(steps);
    };
    let invalid =
        || DeliveryFailure::new(DeliveryReasonCode::InternalError, "发送失败：图文顺序信息无效");
    let mut used = vec![false; request.image_files.len()];
    let mut steps = Vec::with_capacity(segments.len());
    for segment in segments {
        match segment {
            DeliverySegment::Text { text } => {
                if text.trim().is_empty() {
                    return Err(invalid());
                }
                steps.push(PayloadStep::Text(text));
            }
            DeliverySegment::Image { file_index } => {
                let slot = used.get_mut(*file_index).ok_or_else(invalid)?;
                if *slot {
                    return Err(invalid());
                }
                *slot = true;
                steps.push(PayloadStep::Image(*file_index));
            }
        }
    }
    if used.contains(&false) {
        return Err(invalid());
    }
    Ok(steps)
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
    // 原生防火墙门禁：不信任前端状态，对将要粘贴的最终文本原样复扫。
    // 任何名单外的 Block finding 拒发；只要存在 Block（含已确认保留）就
    // 强制关闭自动回车。此闸先于剪贴板事务与图片预读，无副作用可回滚。
    let mut press_enter = request.press_enter;
    if request.firewall_text_enabled && !request.text.is_empty() {
        let scan = crate::privacy::scan_sensitive_text(crate::privacy::ScanSensitiveRequest {
            text: request.text.clone(),
        });
        if !scan.complete {
            return blocked_result(
                runtime,
                &request.delivery_id,
                DeliveryReasonCode::PrivacyIncomplete,
                Some(snapshot),
                started_at_ms,
                false,
            );
        }
        let blocks = scan
            .findings
            .iter()
            .filter(|finding| finding.severity == crate::privacy::FindingSeverity::Block)
            .collect::<Vec<_>>();
        if blocks
            .iter()
            .any(|finding| !request.allowed_text_finding_ids.contains(&finding.id))
        {
            return blocked_result(
                runtime,
                &request.delivery_id,
                DeliveryReasonCode::PrivacyNativeBlocked,
                Some(snapshot),
                started_at_ms,
                false,
            );
        }
        press_enter = press_enter && blocks.is_empty();
    }
    let steps = match payload_steps(request) {
        Ok(steps) if !steps.is_empty() => steps,
        Ok(_) => {
            return failed_result(
                runtime,
                &request.delivery_id,
                DeliveryFailure::new(DeliveryReasonCode::PayloadEmpty, "发送失败：内容为空"),
                Some(snapshot),
                started_at_ms,
                false,
            );
        }
        Err(failure) => {
            return failed_result(
                runtime,
                &request.delivery_id,
                failure,
                Some(snapshot),
                started_at_ms,
                false,
            );
        }
    };
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
    // 统一按步粘贴：默认顺序与交错 segments 走同一条路径。首个文字段前不
    // 加间隔（面板已让位），图片段以及后续任何段之间都留 700ms 给目标消化。
    let expected_pastes = steps.len();
    let mut completed_pastes = 0usize;
    for (step_index, step) in steps.iter().enumerate() {
        let needs_gap = step_index > 0 || matches!(step, PayloadStep::Image(_));
        if needs_gap {
            runtime.pause(700);
        }
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
        let staged = match step {
            PayloadStep::Text(text) => runtime.stage_text(text),
            PayloadStep::Image(index) => runtime.stage_image(*index),
        };
        if let Err(failure) = staged {
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
        let kind = match step {
            PayloadStep::Text(_) => PayloadKind::Text,
            PayloadStep::Image(_) => PayloadKind::Image,
        };
        if let Err(failure) = runtime.paste_staged(kind) {
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
    if press_enter {
        // Electron/WebView 编辑器通常异步消费 paste；过早的 Return 即使成功投递到
        // HID，也可能在编辑器提交状态就绪前被丢弃。图片落地更慢，单独留出余量。
        runtime.pause(enter_settle_ms(&steps));
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

fn verify_image_integrity(
    file: &str,
    expected: Option<&str>,
    width: usize,
    height: usize,
    rgba: &[u8],
) -> Result<(), DeliveryFailure> {
    let Some(expected) = expected else {
        if file.starts_with("toskr-redacted:") {
            return Err(DeliveryFailure::new(
                DeliveryReasonCode::ImageChanged,
                "发送失败：遮挡图片缺少完整性证明，请重新预检",
            ));
        }
        return Ok(());
    };
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(DeliveryFailure::new(
            DeliveryReasonCode::ImageChanged,
            "发送失败：图片完整性证明无效，请重新预检",
        ));
    }
    let actual = crate::storage::content_hash(width, height, rgba);
    if actual != expected {
        return Err(DeliveryFailure::new(
            DeliveryReasonCode::ImageChanged,
            "发送失败：图片内容已变化，请重新扫描",
        ));
    }
    Ok(())
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
        if request.image_files.len() != request.expected_image_pixel_hashes.len() {
            return Err(DeliveryFailure::new(
                DeliveryReasonCode::ImageChanged,
                "发送失败：图片完整性信息不完整，请重新预检",
            ));
        }
        let mut images = Vec::with_capacity(request.image_files.len());
        for (file, expected_hash) in request
            .image_files
            .iter()
            .zip(&request.expected_image_pixel_hashes)
        {
            let Some(image) = crate::image_firewall::read_delivery_image_rgba(&self.app, file)
            else {
                return Err(DeliveryFailure::new(
                    DeliveryReasonCode::ImageUnreadable,
                    "发送失败：图片附件不可读取",
                ));
            };
            verify_image_integrity(file, expected_hash.as_deref(), image.0, image.1, &image.2)?;
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
                "发送失败：图片发送状态异常",
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
        staged_order: Vec<String>,
        paste_calls: usize,
        enter_calls: usize,
        elapsed_ms: u64,
        last_paste_at_ms: Option<u64>,
        minimum_enter_settle_ms: u64,
        target_consumed_enter: bool,
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
                staged_order: Vec::new(),
                paste_calls: 0,
                enter_calls: 0,
                elapsed_ms: 0,
                last_paste_at_ms: None,
                minimum_enter_settle_ms: 0,
                target_consumed_enter: false,
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

        fn pause(&mut self, millis: u64) {
            self.elapsed_ms += millis;
        }

        fn stage_text(&mut self, text: &str) -> Result<(), DeliveryFailure> {
            self.stage_calls += 1;
            self.staged_order.push(format!("text:{text}"));
            Ok(())
        }

        fn stage_image(&mut self, index: usize) -> Result<(), DeliveryFailure> {
            self.stage_calls += 1;
            self.staged_order.push(format!("image:{index}"));
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
                self.last_paste_at_ms = Some(self.elapsed_ms);
                Ok(())
            }
        }

        fn press_enter(&mut self) -> Result<(), DeliveryFailure> {
            self.enter_calls += 1;
            self.target_consumed_enter = self.last_paste_at_ms.is_some_and(|pasted_at| {
                self.elapsed_ms.saturating_sub(pasted_at) >= self.minimum_enter_settle_ms
            });
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
            expected_image_pixel_hashes: vec![],
            segments: None,
            allowed_text_finding_ids: vec![],
            firewall_text_enabled: true,
            press_enter: true,
            keep_panel: false,
            delivery_id: "delivery-1".into(),
        }
    }

    #[test]
    fn image_integrity_rejects_same_name_pixel_drift_before_delivery() {
        let original = vec![10, 20, 30, 255];
        let expected = crate::storage::content_hash(1, 1, &original);
        assert!(
            verify_image_integrity("img-synthetic.png", Some(&expected), 1, 1, &original,).is_ok()
        );

        let changed = vec![200, 20, 30, 255];
        let failure = verify_image_integrity("img-synthetic.png", Some(&expected), 1, 1, &changed)
            .expect_err("same name with changed pixels must fail closed");
        assert_eq!(failure.reason_code, DeliveryReasonCode::ImageChanged);

        let missing = verify_image_integrity(
            "toskr-redacted:redacted-synthetic.png",
            None,
            1,
            1,
            &original,
        )
        .expect_err("redacted tokens always require an expected hash");
        assert_eq!(missing.reason_code, DeliveryReasonCode::ImageChanged);
    }

    fn block_finding_ids(text: &str) -> Vec<String> {
        crate::privacy::scan_sensitive_text(crate::privacy::ScanSensitiveRequest {
            text: text.into(),
        })
        .findings
        .into_iter()
        .filter(|finding| finding.severity == crate::privacy::FindingSeverity::Block)
        .map(|finding| finding.id)
        .collect()
    }

    #[test]
    fn native_gate_blocks_unauthorized_block_finding_without_side_effects() {
        let mut runtime = FakeRuntime::default();
        let mut req = request(Some("token-1"));
        req.text = "api_key=super_secret_value_123456789".into();

        let result = execute_delivery(&mut runtime, &req);

        assert_eq!(result.status, DeliveryStatus::Blocked);
        assert_eq!(result.reason_code, DeliveryReasonCode::PrivacyNativeBlocked);
        assert!(!result.message.contains("super_secret_value"));
        assert_eq!(runtime.window_calls, 0);
        assert_eq!(runtime.activation_calls, 0);
        assert_eq!(runtime.stage_calls, 0);
        assert_eq!(runtime.paste_calls, 0);
        assert_eq!(runtime.enter_calls, 0);
    }

    #[test]
    fn native_gate_allows_explicitly_confirmed_block_but_clamps_enter() {
        let mut runtime = FakeRuntime::default();
        let text = "api_key=super_secret_value_123456789";
        let mut req = request(Some("token-1"));
        req.text = text.into();
        req.allowed_text_finding_ids = block_finding_ids(text);
        assert!(!req.allowed_text_finding_ids.is_empty());
        req.press_enter = true;

        let result = execute_delivery(&mut runtime, &req);

        assert_eq!(result.status, DeliveryStatus::Sent);
        assert!(!result.enter_pressed, "Block 命中存在时必须钳制自动回车");
        assert_eq!(runtime.enter_calls, 0);
        assert_eq!(runtime.paste_calls, 1);
    }

    #[test]
    fn native_gate_rejects_stale_allowance_after_text_edit() {
        let mut runtime = FakeRuntime::default();
        let confirmed = "api_key=super_secret_value_123456789";
        let mut req = request(Some("token-1"));
        // 预检确认发生在旧正文；随后正文被改写（偏移漂移），旧名单必须失效。
        req.allowed_text_finding_ids = block_finding_ids(confirmed);
        req.text = format!("前缀改动 {confirmed}");

        let result = execute_delivery(&mut runtime, &req);

        assert_eq!(result.status, DeliveryStatus::Blocked);
        assert_eq!(result.reason_code, DeliveryReasonCode::PrivacyNativeBlocked);
        assert_eq!(runtime.paste_calls, 0);
    }

    #[test]
    fn native_gate_fails_closed_on_oversize_text() {
        let mut runtime = FakeRuntime::default();
        let mut req = request(Some("token-1"));
        req.text = "x".repeat(crate::privacy::MAX_SCAN_INPUT_BYTES + 1);

        let result = execute_delivery(&mut runtime, &req);

        assert_eq!(result.status, DeliveryStatus::Blocked);
        assert_eq!(result.reason_code, DeliveryReasonCode::PrivacyIncomplete);
        assert_eq!(runtime.paste_calls, 0);
    }

    #[test]
    fn native_gate_passthrough_when_firewall_disabled() {
        let mut runtime = FakeRuntime::default();
        let mut req = request(Some("token-1"));
        req.text = "api_key=super_secret_value_123456789".into();
        req.firewall_text_enabled = false;
        req.press_enter = true;

        let result = execute_delivery(&mut runtime, &req);

        assert_eq!(result.status, DeliveryStatus::Sent);
        assert!(result.enter_pressed, "防火墙关闭时不做原生钳制");
    }

    #[test]
    fn native_gate_ignores_warn_findings() {
        let mut runtime = FakeRuntime::default();
        let mut req = request(Some("token-1"));
        req.text = "请联系 alice@example.com 获取报告".into();
        req.press_enter = true;

        let result = execute_delivery(&mut runtime, &req);

        assert_eq!(result.status, DeliveryStatus::Sent);
        assert!(result.enter_pressed, "Warn 级命中不触发原生拦截或回车钳制");
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
    fn auto_enter_waits_for_slow_text_editor_after_paste() {
        let mut runtime = FakeRuntime {
            minimum_enter_settle_ms: 500,
            ..FakeRuntime::default()
        };

        let result = execute_delivery(&mut runtime, &request(Some("token-1")));

        assert_eq!(result.status, DeliveryStatus::Sent);
        assert_eq!(runtime.enter_calls, 1);
        assert!(
            runtime.target_consumed_enter,
            "Return was synthesized before the target editor finished consuming the paste"
        );
    }

    #[test]
    fn auto_enter_waits_longer_after_interleaved_pastes_ending_in_an_image() {
        let mut req = request(Some("token-1"));
        req.text = "开头\n结尾".into();
        req.image_files = vec!["a.png".into(), "b.png".into()];
        req.expected_image_pixel_hashes = vec![None, None];
        req.segments = Some(vec![
            DeliverySegment::Text {
                text: "开头".into(),
            },
            DeliverySegment::Image { file_index: 0 },
            DeliverySegment::Text {
                text: "结尾".into(),
            },
            DeliverySegment::Image { file_index: 1 },
        ]);
        let mut runtime = FakeRuntime {
            minimum_enter_settle_ms: 900,
            ..FakeRuntime::default()
        };

        let result = execute_delivery(&mut runtime, &req);

        assert_eq!(result.status, DeliveryStatus::Sent);
        assert_eq!(
            runtime.staged_order,
            vec!["text:开头", "image:0", "text:结尾", "image:1"]
        );
        assert_eq!(runtime.paste_calls, 4);
        assert_eq!(runtime.enter_calls, 1);
        assert!(runtime.target_consumed_enter);
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
    fn interleaved_segments_paste_in_declared_order() {
        let mut req = request(Some("token-1"));
        req.text = "开头\n结尾".into();
        req.image_files = vec!["a.png".into(), "b.png".into()];
        req.expected_image_pixel_hashes = vec![None, None];
        req.segments = Some(vec![
            DeliverySegment::Text {
                text: "开头".into(),
            },
            DeliverySegment::Image { file_index: 0 },
            DeliverySegment::Text {
                text: "结尾".into(),
            },
            DeliverySegment::Image { file_index: 1 },
        ]);
        req.press_enter = false;
        let mut runtime = FakeRuntime::default();

        let result = execute_delivery(&mut runtime, &req);

        assert_eq!(result.status, DeliveryStatus::Sent);
        assert!(result.paste_completed);
        assert_eq!(
            runtime.staged_order,
            vec!["text:开头", "image:0", "text:结尾", "image:1"]
        );
        assert_eq!(runtime.paste_calls, 4);
        // 每段 stage 前后各一道 Frontmost 哨卡 + 起始两道 Identity
        assert_eq!(runtime.validation_calls, 2 + 4 * 2);
    }

    #[test]
    fn invalid_segments_fail_closed_before_any_input() {
        let broken: [Vec<DeliverySegment>; 4] = [
            // 下标越界
            vec![DeliverySegment::Image { file_index: 1 }],
            // 同图重复
            vec![
                DeliverySegment::Image { file_index: 0 },
                DeliverySegment::Image { file_index: 0 },
            ],
            // 漏图（image_files 有 1 张、段里 0 张）
            vec![DeliverySegment::Text {
                text: "文字".into(),
            }],
            // 空文字段
            vec![
                DeliverySegment::Text { text: "  ".into() },
                DeliverySegment::Image { file_index: 0 },
            ],
        ];
        for segments in broken {
            let mut req = request(Some("token-1"));
            req.image_files = vec!["a.png".into()];
            req.expected_image_pixel_hashes = vec![None];
            req.segments = Some(segments);
            let mut runtime = FakeRuntime::default();

            let result = execute_delivery(&mut runtime, &req);

            assert_eq!(result.status, DeliveryStatus::Failed);
            assert_eq!(result.reason_code, DeliveryReasonCode::InternalError);
            assert_eq!(runtime.stage_calls, 0);
            assert_eq!(runtime.paste_calls, 0);
            assert_eq!(runtime.window_calls, 0);
        }
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
