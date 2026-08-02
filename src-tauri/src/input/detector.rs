//! 双击 Shift 检测状态机。
//!
//! 纯逻辑、无任何平台依赖，可直接单元测试。
//! 判定规则（防误触）：
//! - 「孤立轻击」= Shift 按下到抬起 < MAX_TAP_HOLD，期间无任何其他按键/修饰键；
//! - 按下瞬间若已有 Cmd/Ctrl/Opt 等修饰键按住，视为和弦（污染）；
//! - 两次孤立轻击的「抬起-抬起」间隔 ≤ MAX_RELEASE_GAP 才触发；
//! - 在第二次「抬起」时触发，保证后续合成 Cmd+C 时 Shift 已物理抬起。

use std::time::{Duration, Instant};

/// 单次轻击最长按住时长，超过视为长按（如按住 Shift 选择）。
/// 注意：按住时长不占用两击间隔预算（v2 语义）。
pub const MAX_TAP_HOLD: Duration = Duration::from_millis(650);
/// 两击间隔：第一次「抬起」→ 第二次「按下」的最大间隔（人感知的双击速度）。
pub const MAX_RELEASE_GAP: Duration = Duration::from_millis(400);

/// feed 的结果：触发 / 无事 / 被拒（含原因与毫秒数，供诊断日志）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FeedOutcome {
    None,
    Triggered,
    Rejected { reason: &'static str, ms: u64 },
}

/// 喂给状态机的原始事件。
#[derive(Debug, Clone, Copy)]
pub enum InputEvent {
    /// Shift 位从无到有。`other_mods` 表示此刻是否有 Cmd/Ctrl/Opt 等按住。
    ShiftDown { at: Instant, other_mods: bool },
    /// Shift 位从有到无。
    ShiftUp { at: Instant },
    /// 任何其他按键按下或其他修饰键变化。
    Other,
}

#[derive(Debug, Clone, Copy)]
enum State {
    Idle,
    FirstDown { down_at: Instant, dirty: bool },
    /// 第一次孤立轻击完成，等待第二击。
    FirstUp { up_at: Instant },
    SecondDown { down_at: Instant, dirty: bool, first_up_at: Instant },
}

pub struct DoubleShiftDetector {
    state: State,
    max_tap_hold: Duration,
    max_release_gap: Duration,
}

impl Default for DoubleShiftDetector {
    fn default() -> Self {
        Self {
            state: State::Idle,
            max_tap_hold: MAX_TAP_HOLD,
            max_release_gap: MAX_RELEASE_GAP,
        }
    }
}

impl DoubleShiftDetector {
    /// 运行时调整双击间隔（设置项下发）。
    pub fn set_release_gap(&mut self, gap: Duration) {
        self.max_release_gap = gap;
    }

    /// 喂入一个事件。v2 语义：
    /// - 两击间隔 = 第一次「抬起」→ 第二次「按下」（按住时长不占间隔预算）
    /// - 触发发生在第二次「抬起」（保证合成 ⌘C 时修饰键已物理抬起）
    pub fn feed(&mut self, ev: InputEvent) -> FeedOutcome {
        match (self.state, ev) {
            (State::Idle, InputEvent::ShiftDown { at, other_mods }) => {
                self.state = State::FirstDown { down_at: at, dirty: other_mods };
                FeedOutcome::None
            }
            (State::FirstUp { up_at }, InputEvent::ShiftDown { at, other_mods }) => {
                // 间隔判定提前到第二次按下：超窗即拒（并把这次按下作为新的第一击）
                let gap = at.duration_since(up_at);
                if gap > self.max_release_gap {
                    self.state = State::FirstDown { down_at: at, dirty: other_mods };
                    return FeedOutcome::Rejected {
                        reason: "两击间隔超时",
                        ms: gap.as_millis() as u64,
                    };
                }
                self.state = State::SecondDown {
                    down_at: at,
                    dirty: other_mods,
                    first_up_at: up_at,
                };
                FeedOutcome::None
            }
            // 一只 Shift 按住期间另一只 Shift 不会产生位边沿；
            // 走到这里的 ShiftDown 属于异常序列，重新开始计数。
            (
                State::FirstDown { .. } | State::SecondDown { .. },
                InputEvent::ShiftDown { at, other_mods },
            ) => {
                self.state = State::FirstDown { down_at: at, dirty: other_mods };
                FeedOutcome::None
            }
            (State::FirstDown { down_at, dirty }, InputEvent::ShiftUp { at }) => {
                let held = at.duration_since(down_at);
                if dirty {
                    self.state = State::Idle;
                    FeedOutcome::Rejected { reason: "第一击夹杂其他按键", ms: 0 }
                } else if held >= self.max_tap_hold {
                    self.state = State::Idle;
                    FeedOutcome::Rejected {
                        reason: "第一击按住过长",
                        ms: held.as_millis() as u64,
                    }
                } else {
                    self.state = State::FirstUp { up_at: at };
                    FeedOutcome::None
                }
            }
            (State::SecondDown { down_at, dirty, .. }, InputEvent::ShiftUp { at }) => {
                self.state = State::Idle;
                let held = at.duration_since(down_at);
                if dirty {
                    FeedOutcome::Rejected { reason: "第二击夹杂其他按键", ms: 0 }
                } else if held >= self.max_tap_hold {
                    FeedOutcome::Rejected {
                        reason: "第二击按住过长",
                        ms: held.as_millis() as u64,
                    }
                } else {
                    FeedOutcome::Triggered
                }
            }
            (State::FirstDown { down_at, .. }, InputEvent::Other) => {
                self.state = State::FirstDown { down_at, dirty: true };
                FeedOutcome::None
            }
            (State::SecondDown { down_at, first_up_at, .. }, InputEvent::Other) => {
                self.state = State::SecondDown { down_at, dirty: true, first_up_at };
                FeedOutcome::None
            }
            // 两击之间夹入其他按键：直接作废，宁可漏触发不可误触发。
            (State::FirstUp { .. }, InputEvent::Other) => {
                self.state = State::Idle;
                FeedOutcome::None
            }
            (State::Idle, _) => FeedOutcome::None,
            (State::FirstUp { up_at }, InputEvent::ShiftUp { .. }) => {
                // 异常的重复抬起（例如双 Shift 同按后先后抬起），保持等待态。
                self.state = State::FirstUp { up_at };
                FeedOutcome::None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    fn down(base: Instant, ms: u64) -> InputEvent {
        InputEvent::ShiftDown { at: t(base, ms), other_mods: false }
    }

    fn up(base: Instant, ms: u64) -> InputEvent {
        InputEvent::ShiftUp { at: t(base, ms) }
    }

    fn fired(o: FeedOutcome) -> bool {
        o == FeedOutcome::Triggered
    }

    #[test]
    fn double_tap_triggers() {
        let base = Instant::now();
        let mut d = DoubleShiftDetector::default();
        assert!(!fired(d.feed(down(base, 0))));
        assert!(!fired(d.feed(up(base, 80))));
        assert!(!fired(d.feed(down(base, 200))));
        assert!(fired(d.feed(up(base, 280))));
    }

    #[test]
    fn second_tap_slow_release_still_triggers() {
        // v2 核心修复：按住时长不占两击间隔预算。
        // 间隔 150ms + 第二击按住 350ms —— 旧语义(抬起→抬起 500ms>400)会漏触发
        let base = Instant::now();
        let mut d = DoubleShiftDetector::default();
        d.feed(down(base, 0));
        d.feed(up(base, 100));
        d.feed(down(base, 250));
        assert!(fired(d.feed(up(base, 600))));
    }

    #[test]
    fn slow_second_press_rejected_with_gap_info() {
        let base = Instant::now();
        let mut d = DoubleShiftDetector::default();
        d.feed(down(base, 0));
        d.feed(up(base, 80));
        // 第二次按下距第一次抬起 520ms > 400ms → 拒绝并复用为新第一击
        let outcome = d.feed(down(base, 600));
        assert!(matches!(
            outcome,
            FeedOutcome::Rejected { reason: "两击间隔超时", ms: 520 }
        ));
        // 被拒的那次按下成为新的第一击，接得上后续双击
        d.feed(up(base, 660));
        d.feed(down(base, 800));
        assert!(fired(d.feed(up(base, 860))));
    }

    #[test]
    fn long_hold_is_not_a_tap() {
        let base = Instant::now();
        let mut d = DoubleShiftDetector::default();
        d.feed(down(base, 0));
        let outcome = d.feed(up(base, 700)); // 按住 700ms ≥ 650ms
        assert!(matches!(outcome, FeedOutcome::Rejected { reason: "第一击按住过长", .. }));
        d.feed(down(base, 800));
        assert!(!fired(d.feed(up(base, 860))));
    }

    #[test]
    fn typing_uppercase_does_not_trigger() {
        let base = Instant::now();
        let mut d = DoubleShiftDetector::default();
        d.feed(down(base, 0));
        d.feed(InputEvent::Other); // 'a'
        d.feed(up(base, 120));
        d.feed(down(base, 180));
        d.feed(InputEvent::Other); // 'b'
        assert!(!fired(d.feed(up(base, 300))));
    }

    #[test]
    fn key_between_taps_cancels() {
        let base = Instant::now();
        let mut d = DoubleShiftDetector::default();
        d.feed(down(base, 0));
        d.feed(up(base, 80));
        d.feed(InputEvent::Other); // 两击之间敲了别的键
        d.feed(down(base, 200));
        assert!(!fired(d.feed(up(base, 260))));
    }

    #[test]
    fn chord_with_command_does_not_trigger() {
        let base = Instant::now();
        let mut d = DoubleShiftDetector::default();
        assert!(!fired(d.feed(InputEvent::ShiftDown { at: t(base, 0), other_mods: true })));
        assert!(!fired(d.feed(up(base, 60))));
        assert!(!fired(d.feed(InputEvent::ShiftDown { at: t(base, 150), other_mods: true })));
        assert!(!fired(d.feed(up(base, 210))));
    }

    #[test]
    fn custom_gap_is_respected() {
        let base = Instant::now();
        let mut d = DoubleShiftDetector::default();
        d.set_release_gap(Duration::from_millis(200));
        // 两击间隔（抬起→按下）240ms > 200ms → 拒
        d.feed(down(base, 0));
        d.feed(up(base, 60));
        d.feed(down(base, 300));
        assert!(!fired(d.feed(up(base, 360))));
        // 放宽到 300ms 后同样间隔应触发
        d.set_release_gap(Duration::from_millis(300));
        d.feed(down(base, 1000));
        d.feed(up(base, 1060));
        d.feed(down(base, 1300));
        assert!(fired(d.feed(up(base, 1360))));
    }

    #[test]
    fn second_trigger_needs_fresh_taps() {
        let base = Instant::now();
        let mut d = DoubleShiftDetector::default();
        d.feed(down(base, 0));
        d.feed(up(base, 60));
        d.feed(down(base, 150));
        assert!(fired(d.feed(up(base, 210))));
        // 触发后立刻再按/抬一次不应连带触发
        assert!(!fired(d.feed(down(base, 300))));
        assert!(!fired(d.feed(up(base, 360))));
        // 但新的完整双击应再次触发
        assert!(!fired(d.feed(down(base, 500))));
        assert!(fired(d.feed(up(base, 560))));
    }
}
