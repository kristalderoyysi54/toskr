//! 发送目标的不可变快照与验证。
//!
//! `prev_app_pid` 仍服务于既有窗口/伴随逻辑；发送安全只认本模块生成的 token。
//! 当前代码无法稳定取得目标编辑窗口身份，因此 `window_id` 明确为 `None`。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::focus::FrontApp;
use crate::state::AppState;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetIdentity {
    pub pid: i32,
    pub bundle_id: String,
    pub app_name: String,
    pub launched_at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetReason {
    TargetMissing,
    TargetTokenMissing,
    TargetTokenStale,
    TargetExited,
    TargetBundleMismatch,
    TargetProcessMismatch,
    TargetIdentityUnavailable,
    TargetNotFrontmost,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSnapshot {
    pub token: Option<String>,
    pub pid: Option<i32>,
    pub bundle_id: Option<String>,
    pub app_name: Option<String>,
    pub launched_at_ms: Option<i64>,
    pub captured_at_ms: i64,
    /// 每次目标语义/token mutation 单调递增；前端据此拒绝倒序事件。
    pub revision: u64,
    pub ready: bool,
    pub reason: Option<TargetReason>,
    pub window_id: Option<i64>,
}

impl TargetSnapshot {
    pub fn missing(at_ms: i64) -> Self {
        Self {
            token: None,
            pid: None,
            bundle_id: None,
            app_name: None,
            launched_at_ms: None,
            captured_at_ms: at_ms,
            revision: 0,
            ready: false,
            reason: Some(TargetReason::TargetMissing),
            window_id: None,
        }
    }

    fn unavailable(front: &FrontApp, at_ms: i64) -> Self {
        Self {
            token: None,
            pid: Some(front.pid),
            bundle_id: front.bundle_id.clone(),
            app_name: front.name.clone(),
            launched_at_ms: front.launched_at_ms,
            captured_at_ms: at_ms,
            revision: 0,
            ready: false,
            reason: Some(TargetReason::TargetIdentityUnavailable),
            window_id: None,
        }
    }
}

/// 前台落在给不出进程身份的界面（系统浮层/权限面板等「非发送类」表面）时，
/// 健康目标的保留宽限：这类表面本就不可能成为发送目标，立即清场只会制造
/// 「目标已失效」误报；发送前仍有身份/前台复核兜底，宽限不放松任何校验。
const UNAVAILABLE_FRONT_GRACE_MS: i64 = 30_000;

#[derive(Default)]
pub struct TargetState {
    token_generation: u64,
    revision: u64,
    last_observation_revision: u64,
    pending_observation_after: Option<u64>,
    /// 首次观测到无身份前台的时钟（None = 前台仍在可识别应用上）；
    /// 宽限从「前台离开目标」那一刻起算，而非上次健康观测——观测只在
    /// 焦点切换时发生，用户在目标里停留多久都不该吃掉宽限。
    unavailable_since_ms: Option<i64>,
    current: Option<TargetSnapshot>,
}

impl TargetState {
    pub fn observe(
        &mut self,
        identity: TargetIdentity,
        at_ms: i64,
        observation_revision: u64,
    ) -> TargetSnapshot {
        if !self.accept_observation(observation_revision) {
            return self.current(at_ms);
        }
        if self.current.as_ref().is_some_and(|snapshot| {
            snapshot.ready
                && snapshot.pid == Some(identity.pid)
                && snapshot.bundle_id.as_deref() == Some(identity.bundle_id.as_str())
                && snapshot.launched_at_ms == Some(identity.launched_at_ms)
        }) {
            self.unavailable_since_ms = None;
            return self.current.clone().expect("checked above");
        }
        self.capture(identity, at_ms)
    }

    /// 无法识别身份的前台观测：现有 ready 目标在宽限期内保持可用（不清场、
    /// 不换 token），否则按原样降级为 TargetIdentityUnavailable。
    /// 返回 (快照, 是否采纳了这个前台作为新目标)。
    pub fn observe_unavailable(
        &mut self,
        front: &FrontApp,
        at_ms: i64,
        observation_revision: u64,
    ) -> (TargetSnapshot, bool) {
        if !self.accept_observation(observation_revision) {
            return (self.current(at_ms), false);
        }
        if self.current.as_ref().is_some_and(|snapshot| snapshot.ready) {
            let since = *self.unavailable_since_ms.get_or_insert(at_ms);
            if at_ms.saturating_sub(since) <= UNAVAILABLE_FRONT_GRACE_MS {
                return (self.current.clone().expect("checked above"), false);
            }
        }
        self.unavailable_since_ms = None;
        (self.reject(TargetSnapshot::unavailable(front, at_ms)), true)
    }

    pub fn refresh(&mut self, identity: TargetIdentity, at_ms: i64) -> TargetSnapshot {
        self.capture(identity, at_ms)
    }

    pub fn current(&self, at_ms: i64) -> TargetSnapshot {
        self.current
            .clone()
            .unwrap_or_else(|| TargetSnapshot::missing(at_ms))
    }

    fn reject(&mut self, snapshot: TargetSnapshot) -> TargetSnapshot {
        let mut snapshot = snapshot;
        snapshot.revision = self.next_revision();
        self.current = Some(snapshot.clone());
        snapshot
    }

    fn accept_observation(&mut self, observation_revision: u64) -> bool {
        if observation_revision <= self.last_observation_revision {
            return false;
        }
        self.last_observation_revision = observation_revision;
        if self
            .pending_observation_after
            .is_some_and(|barrier| observation_revision <= barrier)
        {
            return false;
        }
        self.pending_observation_after = None;
        true
    }

    fn require_observation_after(
        &mut self,
        observation_revision: u64,
        at_ms: i64,
    ) -> TargetSnapshot {
        // 查询屏障之后若已有非自身 observation 提交，不得再把更新目标降回 pending。
        if self.last_observation_revision > observation_revision {
            return self.current(at_ms);
        }
        self.last_observation_revision = self.last_observation_revision.max(observation_revision);
        self.pending_observation_after = Some(observation_revision);
        let current = self.current(at_ms);
        if !current.ready && current.reason == Some(TargetReason::TargetNotFrontmost) {
            return current;
        }
        self.reject(TargetSnapshot {
            captured_at_ms: at_ms,
            ready: false,
            reason: Some(TargetReason::TargetNotFrontmost),
            ..current
        })
    }

    fn next_revision(&mut self) -> u64 {
        self.revision = self.revision.wrapping_add(1).max(1);
        self.revision
    }

    fn version_matches(&self, expected: &TargetSnapshot) -> bool {
        self.current.as_ref().is_some_and(|current| {
            current.revision == expected.revision && current.token == expected.token
        })
    }

    fn refresh_if_current(
        &mut self,
        expected: &TargetSnapshot,
        identity: TargetIdentity,
        at_ms: i64,
    ) -> TargetSnapshot {
        if self.pending_observation_after.is_some() || !self.version_matches(expected) {
            return self.current(at_ms);
        }
        self.refresh(identity, at_ms)
    }

    fn reject_reason_if_current(
        &mut self,
        expected: &TargetSnapshot,
        reason: TargetReason,
        at_ms: i64,
    ) -> TargetSnapshot {
        if !self.version_matches(expected) {
            return self.current(at_ms);
        }
        self.reject(TargetSnapshot {
            captured_at_ms: at_ms,
            ready: false,
            reason: Some(reason),
            ..expected.clone()
        })
    }

    fn apply_validation_if_current(
        &mut self,
        expected: &TargetSnapshot,
        mut validated: TargetSnapshot,
        at_ms: i64,
    ) -> TargetSnapshot {
        if self.pending_observation_after.is_some() || !self.version_matches(expected) {
            return self.current(at_ms);
        }
        let previous = self.current.as_ref();
        if target_event_changed(previous, &validated) {
            validated.revision = self.next_revision();
        }
        self.current = Some(validated.clone());
        validated
    }

    fn capture(&mut self, identity: TargetIdentity, at_ms: i64) -> TargetSnapshot {
        self.unavailable_since_ms = None;
        self.token_generation = self.token_generation.wrapping_add(1).max(1);
        let revision = self.next_revision();
        let bundle_hash = identity
            .bundle_id
            .bytes()
            .fold(0xcbf29ce484222325u64, |hash, byte| {
                (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
            });
        let snapshot = TargetSnapshot {
            token: Some(format!(
                "{:x}-{:x}-{:x}-{:x}-{:x}",
                at_ms, self.token_generation, identity.pid, identity.launched_at_ms, bundle_hash
            )),
            pid: Some(identity.pid),
            bundle_id: Some(identity.bundle_id),
            app_name: Some(identity.app_name),
            launched_at_ms: Some(identity.launched_at_ms),
            captured_at_ms: at_ms,
            revision,
            ready: true,
            reason: None,
            window_id: None,
        };
        self.current = Some(snapshot.clone());
        snapshot
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn target_identity(front: &FrontApp) -> Option<TargetIdentity> {
    Some(TargetIdentity {
        pid: front.pid,
        bundle_id: front.bundle_id.clone()?,
        app_name: front.name.clone().or_else(|| front.bundle_id.clone())?,
        launched_at_ms: front.launched_at_ms?,
    })
}

fn target_event_changed(previous: Option<&TargetSnapshot>, next: &TargetSnapshot) -> bool {
    previous.is_none_or(|previous| {
        previous.token != next.token
            || previous.pid != next.pid
            || previous.bundle_id != next.bundle_id
            || previous.app_name != next.app_name
            || previous.launched_at_ms != next.launched_at_ms
            || previous.ready != next.ready
            || previous.reason != next.reason
            || previous.window_id != next.window_id
    })
}

fn emit_target_change(
    app: &AppHandle,
    previous: Option<&TargetSnapshot>,
    snapshot: &TargetSnapshot,
) {
    if target_event_changed(previous, snapshot) {
        let _ = app.emit_to(
            "main",
            crate::events::TARGET_CHANGED_EVENT,
            snapshot.clone(),
        );
    }
}

/// 记录非 Toskr 前台应用。相同进程身份保持 token；仅语义变化时通知 main，
/// captured_at_ms 的时钟变化不会制造前端刷新或图标请求风暴。
pub fn observe_front(app: &AppHandle, front: &FrontApp) -> TargetSnapshot {
    let state = app.state::<AppState>();
    let at_ms = now_ms();
    let mut target = state.delivery_target.lock().unwrap();
    let accepted =
        target.current.is_none() || front.observation_revision > target.last_observation_revision;
    let previous = target.current.clone();
    let (snapshot, adopted) = match target_identity(front) {
        Some(identity) => (
            target.observe(identity, at_ms, front.observation_revision),
            true,
        ),
        None => target.observe_unavailable(front, at_ms, front.observation_revision),
    };
    // 宽限保留旧目标时不改 prev_app_pid：焦点归还必须回到真目标，
    // 不能落在无身份浮层上
    if accepted && adopted {
        *state.prev_app_pid.lock().unwrap() = Some(front.pid);
    }
    // mutation 与 enqueue 共享同一串行区；前端 revision 继续兜底事件传输倒序。
    emit_target_change(app, previous.as_ref(), &snapshot);
    drop(target);
    snapshot
}

/// 面板失焦时若查询已经回到 Toskr 自身，冻结当前 token 为 pending。
/// 只有查询屏障之后真正接受到的非自身 observation 才能重新生成 ready token。
pub fn require_observation_after(app: &AppHandle, observation_revision: u64) -> TargetSnapshot {
    let state = app.state::<AppState>();
    let mut target = state.delivery_target.lock().unwrap();
    let previous = target.current.clone();
    let snapshot = target.require_observation_after(observation_revision, now_ms());
    emit_target_change(app, previous.as_ref(), &snapshot);
    drop(target);
    snapshot
}

/// Toskr 自己在前台（尤其 Pin）时没有新目标可观察，仍复核当前进程身份。
/// 只把同一 token 的验证结果写回；并发切到 B 时旧 A 结果直接丢弃。
pub fn revalidate_observed_target(app: &AppHandle) -> TargetSnapshot {
    let state = app.state::<AppState>();
    let validated = current_snapshot(&state);
    let mut target = state.delivery_target.lock().unwrap();
    let previous = target.current.clone();
    let validated = target.apply_validation_if_current(&validated, validated.clone(), now_ms());
    emit_target_change(app, previous.as_ref(), &validated);
    drop(target);
    validated
}

/// 返回当前快照，并按当前进程身份刷新 ready/reason；不会改变 token。
pub fn current_snapshot(state: &AppState) -> TargetSnapshot {
    let snapshot = state.delivery_target.lock().unwrap().current(now_ms());
    if snapshot.token.is_none() {
        return snapshot;
    }
    match validate_snapshot(
        &snapshot,
        snapshot.token.as_deref(),
        &SystemTargetProbe,
        ValidationGate::Identity,
    ) {
        Ok(valid) => valid,
        Err(reason) => TargetSnapshot {
            ready: false,
            reason: Some(reason),
            ..snapshot
        },
    }
}

/// 为当前记录的进程身份生成新 token。目标已退出时只返回失效原因，不改写身份。
pub fn refresh_current(state: &AppState) -> TargetSnapshot {
    let current = state.delivery_target.lock().unwrap().current(now_ms());
    let Some(pid) = current.pid else {
        return current;
    };
    let Some(front) = crate::focus::app_info_of(pid) else {
        return reject_refresh_if_current(state, current, TargetReason::TargetExited);
    };
    let Some(identity) = target_identity(&front) else {
        return reject_refresh_if_current(state, current, TargetReason::TargetIdentityUnavailable);
    };
    if current.bundle_id.as_deref() != Some(identity.bundle_id.as_str()) {
        return reject_refresh_if_current(state, current, TargetReason::TargetBundleMismatch);
    }
    if current.launched_at_ms != Some(identity.launched_at_ms) {
        return reject_refresh_if_current(state, current, TargetReason::TargetProcessMismatch);
    }
    let at_ms = now_ms();
    let mut target = state.delivery_target.lock().unwrap();
    target.refresh_if_current(&current, identity, at_ms)
}

fn reject_refresh_if_current(
    state: &AppState,
    current: TargetSnapshot,
    reason: TargetReason,
) -> TargetSnapshot {
    let at_ms = now_ms();
    let mut target = state.delivery_target.lock().unwrap();
    target.reject_reason_if_current(&current, reason, at_ms)
}

/// 校验调用方持有的 token，但不要求目标当前处于前台（面板本身通常在前台）。
pub fn validate_current(state: &AppState, token: Option<&str>) -> TargetSnapshot {
    let snapshot = state.delivery_target.lock().unwrap().current(now_ms());
    match validate_snapshot(
        &snapshot,
        token,
        &SystemTargetProbe,
        ValidationGate::Identity,
    ) {
        Ok(valid) => valid,
        Err(reason) => TargetSnapshot {
            ready: false,
            reason: Some(reason),
            ..snapshot
        },
    }
}

/// 确认冻结 token 仍是观察器记录的当前目标；观察器切到 B 后，旧 A token 立即失效。
pub fn ensure_token_current(state: &AppState, token: Option<&str>) -> Result<(), TargetReason> {
    let token = token.ok_or(TargetReason::TargetTokenMissing)?;
    let current = state.delivery_target.lock().unwrap().current(now_ms());
    if !current.ready {
        return Err(current.reason.unwrap_or(TargetReason::TargetMissing));
    }
    let expected = current
        .token
        .as_deref()
        .ok_or(TargetReason::TargetMissing)?;
    if token == expected {
        Ok(())
    } else {
        Err(TargetReason::TargetTokenStale)
    }
}

pub struct SystemTargetProbe;

impl TargetProbe for SystemTargetProbe {
    fn identity_for_pid(&self, pid: i32) -> Option<TargetIdentity> {
        target_identity(&crate::focus::app_info_of(pid)?)
    }

    fn frontmost_identity(&self) -> Option<TargetIdentity> {
        target_identity(&crate::focus::frontmost_info()?)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValidationGate {
    Identity,
    Frontmost,
}

pub trait TargetProbe {
    fn identity_for_pid(&self, pid: i32) -> Option<TargetIdentity>;
    fn frontmost_identity(&self) -> Option<TargetIdentity>;
}

pub fn validate_snapshot(
    snapshot: &TargetSnapshot,
    token: Option<&str>,
    probe: &impl TargetProbe,
    gate: ValidationGate,
) -> Result<TargetSnapshot, TargetReason> {
    let token = token.ok_or(TargetReason::TargetTokenMissing)?;
    let expected_token = snapshot
        .token
        .as_deref()
        .ok_or(TargetReason::TargetMissing)?;
    if token != expected_token {
        return Err(TargetReason::TargetTokenStale);
    }
    let pid = snapshot.pid.ok_or(TargetReason::TargetMissing)?;
    let bundle_id = snapshot
        .bundle_id
        .as_deref()
        .ok_or(TargetReason::TargetMissing)?;
    let running = probe
        .identity_for_pid(pid)
        .ok_or(TargetReason::TargetExited)?;
    if running.bundle_id != bundle_id {
        return Err(TargetReason::TargetBundleMismatch);
    }
    if Some(running.launched_at_ms) != snapshot.launched_at_ms {
        return Err(TargetReason::TargetProcessMismatch);
    }
    if gate == ValidationGate::Frontmost {
        let front = probe
            .frontmost_identity()
            .ok_or(TargetReason::TargetNotFrontmost)?;
        if front.pid != pid
            || front.bundle_id != bundle_id
            || Some(front.launched_at_ms) != snapshot.launched_at_ms
        {
            return Err(TargetReason::TargetNotFrontmost);
        }
    }
    Ok(snapshot.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeProbe {
        running: Option<TargetIdentity>,
        frontmost: Option<TargetIdentity>,
    }

    impl TargetProbe for FakeProbe {
        fn identity_for_pid(&self, _pid: i32) -> Option<TargetIdentity> {
            self.running.clone()
        }

        fn frontmost_identity(&self) -> Option<TargetIdentity> {
            self.frontmost.clone()
        }
    }

    fn codex() -> TargetIdentity {
        TargetIdentity {
            pid: 42,
            bundle_id: "com.openai.codex".into(),
            app_name: "Codex".into(),
            launched_at_ms: 500,
        }
    }

    fn unavailable(pid: i32, bundle_id: &str, app_name: &str) -> TargetSnapshot {
        TargetSnapshot {
            token: None,
            pid: Some(pid),
            bundle_id: Some(bundle_id.into()),
            app_name: Some(app_name.into()),
            launched_at_ms: None,
            captured_at_ms: 1_000,
            revision: 0,
            ready: false,
            reason: Some(TargetReason::TargetIdentityUnavailable),
            window_id: None,
        }
    }

    fn identityless_front(observation_revision: u64) -> FrontApp {
        FrontApp {
            pid: 9_999,
            name: Some("SystemOverlay".into()),
            bundle_id: None,
            launched_at_ms: None,
            observation_revision,
        }
    }

    #[test]
    fn identityless_front_keeps_ready_target_within_grace() {
        let mut state = TargetState::default();
        let healthy = state.observe(codex(), 1_000, 1);

        // 宽限期内：无身份前台不清场，token 与身份保持不变（不采纳该前台）
        let (kept, adopted) =
            state.observe_unavailable(&identityless_front(2), 1_000 + 5_000, 2);
        assert!(!adopted);
        assert!(kept.ready);
        assert_eq!(kept.token, healthy.token);

        // 切回同一目标：立即恢复且 token 不轮换
        let back = state.observe(codex(), 1_000 + 6_000, 3);
        assert!(back.ready);
        assert_eq!(back.token, healthy.token);
    }

    #[test]
    fn identityless_front_degrades_after_grace() {
        let mut state = TargetState::default();
        let healthy = state.observe(codex(), 1_000, 1);

        // 无论在目标里停留多久，首次无身份观测都从此刻起算宽限
        let (kept, adopted) =
            state.observe_unavailable(&identityless_front(2), 600_000, 2);
        assert!(!adopted);
        assert_eq!(kept.token, healthy.token);

        // 持续停留在无身份前台超过宽限：按原样降级失效
        let (degraded, adopted) = state.observe_unavailable(
            &identityless_front(3),
            600_000 + UNAVAILABLE_FRONT_GRACE_MS + 1,
            3,
        );
        assert!(adopted);
        assert!(!degraded.ready);
        assert_eq!(
            degraded.reason,
            Some(TargetReason::TargetIdentityUnavailable)
        );
        assert_ne!(degraded.token, healthy.token);
    }

    #[test]
    fn identityless_front_without_healthy_target_degrades_immediately() {
        let mut state = TargetState::default();
        let (snapshot, adopted) = state.observe_unavailable(&identityless_front(1), 1_000, 1);
        assert!(adopted);
        assert!(!snapshot.ready);
        assert_eq!(
            snapshot.reason,
            Some(TargetReason::TargetIdentityUnavailable)
        );
    }

    #[test]
    fn same_identity_keeps_snapshot_until_explicit_refresh() {
        let mut state = TargetState::default();
        let first = state.observe(codex(), 1_000, 1);
        let observed_again = state.observe(codex(), 2_000, 2);
        let refreshed = state.refresh(codex(), 3_000);

        assert!(first.ready);
        assert_eq!(first.reason, None);
        assert_eq!(first.token, observed_again.token);
        assert_eq!(first.captured_at_ms, observed_again.captured_at_ms);
        assert_ne!(first.token, refreshed.token);
        assert_eq!(refreshed.captured_at_ms, 3_000);
        assert_eq!(refreshed.window_id, None);
    }

    #[test]
    fn target_event_dedupes_clock_only_changes_but_reports_real_switches() {
        let mut state = TargetState::default();
        let a = state.observe(codex(), 1_000, 1);
        let clock_only = TargetSnapshot {
            captured_at_ms: 2_000,
            ..a.clone()
        };
        let b = state.observe(
            TargetIdentity {
                pid: 84,
                bundle_id: "com.apple.Terminal".into(),
                app_name: "Terminal".into(),
                launched_at_ms: 700,
            },
            3_000,
            2,
        );

        assert!(!target_event_changed(Some(&a), &clock_only));
        assert!(target_event_changed(Some(&a), &b));
        assert!(target_event_changed(None, &a));
    }

    #[test]
    fn delayed_old_front_observation_never_rolls_back_new_target() {
        let mut state = TargetState::default();
        let a = state.observe(codex(), 1_000, 1);
        let b = state.observe(
            TargetIdentity {
                pid: 84,
                bundle_id: "com.apple.Terminal".into(),
                app_name: "Terminal".into(),
                launched_at_ms: 700,
            },
            2_000,
            2,
        );

        let delayed_a = state.observe(codex(), 3_000, 1);

        assert_eq!(delayed_a, b);
        assert!(b.revision > a.revision);
        assert_eq!(state.current(4_000), b);
    }

    #[test]
    fn missed_app_switch_stays_blocked_until_post_blur_observation() {
        let state = AppState::default();
        let a = state
            .delivery_target
            .lock()
            .unwrap()
            .observe(codex(), 1_000, 1);
        let blocked = state
            .delivery_target
            .lock()
            .unwrap()
            .require_observation_after(3, 2_000);

        assert!(!blocked.ready);
        assert_eq!(blocked.reason, Some(TargetReason::TargetNotFrontmost));
        assert_eq!(
            ensure_token_current(&state, a.token.as_deref()),
            Err(TargetReason::TargetNotFrontmost)
        );

        // 屏障前已开始但迟到提交的旧样本不能解除 pending。
        let stale = state
            .delivery_target
            .lock()
            .unwrap()
            .observe(codex(), 2_500, 2);
        assert!(!stale.ready);

        let b = TargetIdentity {
            pid: 84,
            bundle_id: "com.apple.Terminal".into(),
            app_name: "Terminal".into(),
            launched_at_ms: 700,
        };
        let confirmed = state.delivery_target.lock().unwrap().observe(b, 3_000, 4);
        assert!(confirmed.ready);
        assert_ne!(confirmed.token, a.token);
    }

    #[test]
    fn unavailable_snapshots_use_revision_for_every_async_writeback_cas() {
        let mut state = TargetState::default();
        let a = state.reject(unavailable(42, "com.example.A", "A"));
        let b = state.reject(unavailable(84, "com.example.B", "B"));
        assert_eq!(a.token, None);
        assert_eq!(b.token, None);
        assert!(b.revision > a.revision);

        let stale_refresh = state.refresh_if_current(&a, codex(), 3_000);
        let stale_reject = state.reject_reason_if_current(&a, TargetReason::TargetExited, 4_000);
        let stale_validation = state.apply_validation_if_current(
            &a,
            TargetSnapshot {
                ready: true,
                reason: None,
                ..a.clone()
            },
            5_000,
        );

        assert_eq!(stale_refresh, b);
        assert_eq!(stale_reject, b);
        assert_eq!(stale_validation, b);
        assert_eq!(state.current(6_000), b);
    }

    #[test]
    fn same_identity_recovers_from_blocked_snapshot_with_a_new_token() {
        let mut state = TargetState::default();
        let ready = state.observe(codex(), 1_000, 1);
        state.reject(TargetSnapshot {
            ready: false,
            reason: Some(TargetReason::TargetExited),
            ..ready.clone()
        });

        let recovered = state.observe(codex(), 2_000, 2);

        assert!(recovered.ready);
        assert_eq!(recovered.reason, None);
        assert_ne!(recovered.token, ready.token);
    }

    #[test]
    fn reused_pid_with_different_bundle_is_blocked() {
        let mut state = TargetState::default();
        let snapshot = state.observe(codex(), 1_000, 1);
        let probe = FakeProbe {
            running: Some(TargetIdentity {
                pid: 42,
                bundle_id: "com.example.other".into(),
                app_name: "Other".into(),
                launched_at_ms: 500,
            }),
            frontmost: None,
        };

        let result = validate_snapshot(
            &snapshot,
            snapshot.token.as_deref(),
            &probe,
            ValidationGate::Identity,
        );

        assert_eq!(result, Err(TargetReason::TargetBundleMismatch));
    }

    #[test]
    fn same_pid_and_bundle_with_new_launch_is_blocked() {
        let mut state = TargetState::default();
        let snapshot = state.observe(codex(), 1_000, 1);
        let probe = FakeProbe {
            running: Some(TargetIdentity {
                launched_at_ms: 999,
                ..codex()
            }),
            frontmost: None,
        };

        let result = validate_snapshot(
            &snapshot,
            snapshot.token.as_deref(),
            &probe,
            ValidationGate::Identity,
        );

        assert_eq!(result, Err(TargetReason::TargetProcessMismatch));
    }

    #[test]
    fn observer_switch_invalidates_frozen_token_even_if_old_app_still_runs() {
        let state = AppState::default();
        let frozen = state
            .delivery_target
            .lock()
            .unwrap()
            .observe(codex(), 1_000, 1);
        assert_eq!(
            ensure_token_current(&state, frozen.token.as_deref()),
            Ok(())
        );

        state.delivery_target.lock().unwrap().observe(
            TargetIdentity {
                pid: 84,
                bundle_id: "com.apple.TextEdit".into(),
                app_name: "TextEdit".into(),
                launched_at_ms: 600,
            },
            2_000,
            2,
        );

        assert_eq!(
            ensure_token_current(&state, frozen.token.as_deref()),
            Err(TargetReason::TargetTokenStale)
        );
    }

    #[test]
    fn exited_and_focus_drift_have_distinct_stable_reasons() {
        let mut state = TargetState::default();
        let snapshot = state.observe(codex(), 1_000, 1);
        let exited = FakeProbe::default();
        assert_eq!(
            validate_snapshot(
                &snapshot,
                snapshot.token.as_deref(),
                &exited,
                ValidationGate::Identity,
            ),
            Err(TargetReason::TargetExited)
        );

        let other = TargetIdentity {
            pid: 77,
            bundle_id: "com.apple.Terminal".into(),
            app_name: "Terminal".into(),
            launched_at_ms: 600,
        };
        let drifted = FakeProbe {
            running: Some(codex()),
            frontmost: Some(other),
        };
        assert_eq!(
            validate_snapshot(
                &snapshot,
                snapshot.token.as_deref(),
                &drifted,
                ValidationGate::Frontmost,
            ),
            Err(TargetReason::TargetNotFrontmost)
        );
    }
}
