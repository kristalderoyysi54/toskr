import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

/**
 * 上手动画：SVG + Motion，颜色全部取主题 token（明暗 / Platinum 通用）。
 * 按「拍」循环；减少动态效果时停在最后一拍（完整结果），不做循环。
 */

export type TourSceneKind = "welcome" | "merge" | "privacy" | "basic";

const BEATS: Record<TourSceneKind, number> = { welcome: 4, merge: 3, privacy: 4, basic: 3 };
const BEAT_MS = 1700;

function useBeat(count: number, playing: boolean): number {
  const reduced = useReducedMotion();
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    if (reduced || !playing) return;
    const timer = window.setInterval(() => setBeat((b) => (b + 1) % count), BEAT_MS);
    return () => window.clearInterval(timer);
  }, [count, playing, reduced]);
  return reduced || !playing ? count - 1 : beat;
}

const ease = [0.22, 1, 0.36, 1] as const;
const T = { duration: 0.55, ease };

const C = {
  card: "var(--card)",
  bg: "var(--background)",
  border: "var(--border)",
  fg: "var(--foreground)",
  muted: "var(--muted)",
  mutedFg: "var(--muted-foreground)",
  primary: "var(--primary)",
  success: "var(--success)",
};

function Win({ x, y, w, h, title, children }: {
  x: number; y: number; w: number; h: number; title: string; children?: ReactNode;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={C.card} stroke={C.border} />
      <circle cx={x + 9} cy={y + 9} r={2.2} fill={C.border} />
      <circle cx={x + 16} cy={y + 9} r={2.2} fill={C.border} />
      <text x={x + 24} y={y + 12} fontSize={9} fill={C.mutedFg}>{title}</text>
      {children}
    </g>
  );
}

function Keycap({ x, y, label, show }: { x: number; y: number; label: string; show: boolean }) {
  return (
    <motion.g initial={false} animate={{ opacity: show ? 1 : 0, y: show ? 0 : 4 }} transition={T}>
      <rect x={x} y={y} width={label.length * 8 + 12} height={18} rx={4} fill={C.bg} stroke={C.border} />
      <text x={x + 6} y={y + 13} fontSize={10.5} fill={C.fg}>{label}</text>
    </motion.g>
  );
}

/** 一张卡片（可勾选），从 from 飞到 to。 */
function FlyCard({ from, to, at, text, checked, highlight }: {
  from: [number, number]; to: [number, number]; at: boolean; text: ReactNode; checked: boolean; highlight?: boolean;
}) {
  const [x, y] = at ? to : from;
  return (
    <motion.g initial={false} animate={{ x, y, opacity: at ? 1 : 0 }} transition={T}>
      <rect width={140} height={24} rx={6} fill={C.bg} stroke={highlight ? C.primary : C.border} />
      <motion.circle
        cx={11} cy={12} r={4.5}
        initial={false}
        animate={{ fill: checked ? "var(--primary)" : "var(--background)" }}
        stroke={checked ? C.primary : C.mutedFg}
        transition={T}
      />
      <text x={21} y={16} fontSize={9.5} fill={C.fg}>{text}</text>
    </motion.g>
  );
}

function WelcomeScene({ beat, captureKey }: { beat: number; captureKey: string }) {
  const collected = beat >= 1;
  const checked = beat >= 2;
  const sent = beat >= 3;
  return (
    <>
      <Win x={6} y={6} w={160} h={64} title="浏览器">
        <rect x={14} y={26} width={120} height={5} rx={2} fill={C.muted} />
        <motion.rect x={14} y={37} width={140} height={12} rx={3} initial={false}
          animate={{ opacity: beat === 0 ? 1 : 0.35 }} fill={C.primary} fillOpacity={0.18} transition={T} />
        <text x={17} y={46.5} fontSize={9.5} fill={C.fg}>TypeError: cannot read…</text>
        <rect x={14} y={55} width={90} height={5} rx={2} fill={C.muted} />
      </Win>
      <Win x={174} y={6} w={160} h={64} title="文档">
        <rect x={182} y={26} width={110} height={5} rx={2} fill={C.muted} />
        <motion.rect x={182} y={37} width={144} height={12} rx={3} initial={false}
          animate={{ opacity: beat === 0 ? 1 : 0.35 }} fill={C.primary} fillOpacity={0.18} transition={T} />
        <text x={185} y={46.5} fontSize={9.5} fill={C.fg}>联系人 demo.user@…</text>
        <rect x={182} y={55} width={80} height={5} rx={2} fill={C.muted} />
      </Win>
      <Keycap x={140} y={78} label={`${captureKey} ${captureKey}`} show={beat === 0} />

      <Win x={6} y={100} w={160} h={100} title="Toskr">
        <motion.g initial={false} animate={{ opacity: sent ? 0.4 : 1 }} transition={T}>
          <FlyCard from={[16, 36]} to={[16, 124]} at={collected} checked={checked}
            text="TypeError: cannot read…" highlight={beat === 2} />
          <FlyCard from={[184, 36]} to={[16, 154]} at={collected} checked={checked}
            text="联系人 demo.user@…" highlight={beat === 2} />
        </motion.g>
        <motion.text x={16} y={193} fill={C.mutedFg} initial={false}
          animate={{ opacity: sent ? 1 : 0 }} transition={T} fontSize={9}>已一起发送 2 张 ✓</motion.text>
      </Win>
      <Keycap x={62} y={206} label="⌘ ⏎" show={beat === 2} />

      <Win x={174} y={100} w={160} h={128} title="AI 对话">
        <rect x={184} y={122} width={100} height={14} rx={7} fill={C.muted} />
        <motion.g initial={false} animate={{ opacity: sent ? 1 : 0, y: sent ? 0 : 10 }} transition={T}>
          <rect x={184} y={150} width={140} height={48} rx={8} fill={C.bg} stroke={C.primary} />
          <text x={192} y={167} fontSize={9.5} fill={C.fg}>TypeError: cannot read…</text>
          <text x={192} y={184} fontSize={9.5} fill={C.fg}>联系人</text>
          <rect x={222} y={175} width={62} height={13} rx={3} fill={C.success} fillOpacity={0.18} />
          <text x={225} y={185} fontSize={9.5} fill={C.success} fontFamily="ui-monospace, monospace">[EMAIL_01]</text>
        </motion.g>
        <motion.text x={184} y={215} fontSize={9} fill={C.mutedFg} initial={false}
          animate={{ opacity: sent ? 1 : 0 }} transition={T}>邮箱发送前已自动替换</motion.text>
      </Win>
    </>
  );
}

function MergeScene({ beat }: { beat: number }) {
  const checked = beat >= 1;
  const merged = beat >= 2;
  return (
    <>
      <FlyCard from={[8, 10]} to={[8, 10]} at={!merged} checked={checked} text="报错：TypeError…" />
      <FlyCard from={[8, 40]} to={[8, 40]} at={!merged} checked={checked} text="复现：刷新后改动消失" />
      <Keycap x={100} y={70} label="⌘ ⏎" show={beat === 1} />
      <motion.g initial={false} animate={{ opacity: merged ? 1 : 0, y: merged ? 0 : 8 }} transition={T}>
        <rect x={8} y={10} width={140} height={54} rx={8} fill={C.bg} stroke={C.primary} />
        <text x={16} y={26} fontSize={7.5} fill={C.mutedFg}>一次发送 · 2 张</text>
        <text x={16} y={40} fontSize={8} fill={C.fg}>报错：TypeError…</text>
        <text x={16} y={54} fontSize={8} fill={C.fg}>复现：刷新后改动消失</text>
      </motion.g>
    </>
  );
}

function PrivacyScene({ beat }: { beat: number }) {
  const replaced = beat >= 1;
  const replied = beat >= 2;
  const restored = beat >= 3;
  return (
    <>
      <text x={8} y={16} fontSize={7.5} fill={C.mutedFg}>发送</text>
      <rect x={8} y={20} width={146} height={20} rx={6} fill={C.bg} stroke={C.border} />
      <text x={14} y={33} fontSize={8} fill={C.fg}>发给</text>
      <motion.g initial={false} animate={{ opacity: replaced ? 0 : 1 }} transition={T}>
        <text x={34} y={33} fontSize={8} fill={C.fg}>张三</text>
      </motion.g>
      <motion.g initial={false} animate={{ opacity: replaced ? 1 : 0 }} transition={T}>
        <rect x={32} y={25} width={50} height={11} rx={3} fill={C.success} fillOpacity={0.18} />
        <text x={35} y={33.5} fontSize={8} fill={C.success} fontFamily="ui-monospace, monospace">[USER_01]</text>
      </motion.g>
      <motion.g initial={false} animate={{ opacity: replied ? 1 : 0, y: replied ? 0 : 6 }} transition={T}>
        <text x={8} y={56} fontSize={7.5} fill={C.mutedFg}>收回 AI 回复</text>
        <rect x={8} y={60} width={146} height={20} rx={6} fill={C.bg} stroke={restored ? C.primary : C.border} />
        <text x={14} y={73} fontSize={8} fill={C.fg}>已发给</text>
        <motion.text x={42} y={73} fontSize={8} initial={false}
          animate={{ opacity: restored ? 0 : 1 }} fill={C.success} fontFamily="ui-monospace, monospace" transition={T}>[USER_01]</motion.text>
        <motion.text x={42} y={73} fontSize={8} initial={false}
          animate={{ opacity: restored ? 1 : 0 }} fill={C.fg} transition={T}>张三 ✓</motion.text>
      </motion.g>
    </>
  );
}

function BasicScene({ beat, captureKey }: { beat: number; captureKey: string }) {
  return (
    <>
      <motion.rect x={8} y={10} width={100} height={12} rx={3} initial={false}
        animate={{ opacity: beat === 0 ? 1 : 0.3 }} fill={C.primary} fillOpacity={0.18} transition={T} />
      <text x={11} y={19} fontSize={8} fill={C.fg}>选中一段文字</text>
      <Keycap x={116} y={8} label={`${captureKey} ${captureKey}`} show={beat === 0} />
      <FlyCard from={[8, 10]} to={[8, 32]} at={beat >= 1} checked={false} text="收成一张卡片" />
      <motion.g initial={false} animate={{ opacity: beat >= 2 ? 1 : 0 }} transition={T}>
        <rect x={8} y={62} width={140} height={20} rx={6} fill={C.bg} stroke={C.primary} />
        <text x={14} y={75} fontSize={8} fill={C.fg}>检查后粘贴到 AI 输入框</text>
      </motion.g>
    </>
  );
}

const VIEWBOX: Record<TourSceneKind, string> = {
  welcome: "0 0 340 234",
  merge: "0 0 156 90",
  privacy: "0 0 162 88",
  basic: "0 0 156 88",
};

export function TourScene({
  kind,
  playing = true,
  className,
  label,
  captureKey = "⇧",
}: {
  kind: TourSceneKind;
  /** 触发键符号（⇧ / ⌃ / ⌥），跟随用户配置。 */
  captureKey?: string;
  /** false 时静止在结果画面（如设置页列表未悬停时）。 */
  playing?: boolean;
  className?: string;
  label: string;
}) {
  const beat = useBeat(BEATS[kind], playing);
  return (
    <svg role="img" aria-label={label} viewBox={VIEWBOX[kind]} className={className}
      style={{ fontFamily: "var(--font-sans)" }}>
      {kind === "welcome" && <WelcomeScene beat={beat} captureKey={captureKey} />}
      {kind === "merge" && <MergeScene beat={beat} />}
      {kind === "privacy" && <PrivacyScene beat={beat} />}
      {kind === "basic" && <BasicScene beat={beat} captureKey={captureKey} />}
    </svg>
  );
}
