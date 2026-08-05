import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { emitTo, listen } from "@tauri-apps/api/event";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  Activity,
  AlarmClock,
  Bot,
  Eye,
  EyeOff,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  ClipboardList,
  Database,
  Info,
  Keyboard,
  Magnet,
  Pencil,
  Plus,
  Settings2,
  Shield,
  Sparkles,
  X,
} from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import {
  SETTINGS_CLEAR_CLIP,
  SETTINGS_EXPORT,
  SETTINGS_IMPORT,
  SETTINGS_PATCH,
  SETTINGS_REQUEST,
  SETTINGS_STATE,
} from "@/lib/settingsSync";
import { SHORTCUTS } from "@/lib/shortcuts";
import { api } from "@/lib/tauri";
import { tip } from "@/lib/tip";
import { checkForUpdate, downloadAndInstall } from "@/lib/updater";
import { cn } from "@/lib/utils";
import {
  CONTEXT_MENU_REGISTRY,
  defaultSettings,
  normalizeContextMenu,
  type DuePresetCfg,
  type PromptSnippet,
  type Settings,
  type ThemePref,
  type VibrancyMaterial,
} from "@/store/notesStore";
import { presetCfgLabel } from "@/lib/tasks";
import { AI_PRESETS, matchPreset, testAiConnection } from "@/lib/ai";

type SectionId =
  | "general"
  | "hotkey"
  | "clip"
  | "companion"
  | "exclude"
  | "snippets"
  | "due"
  | "ai"
  | "data"
  | "diagnostics"
  | "about";

const SECTIONS: { id: SectionId; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "通用", icon: <Settings2 className="size-4" /> },
  { id: "hotkey", label: "快捷键", icon: <Keyboard className="size-4" /> },
  { id: "clip", label: "剪贴板", icon: <ClipboardList className="size-4" /> },
  { id: "companion", label: "伴随停靠", icon: <Magnet className="size-4" /> },
  { id: "exclude", label: "捕获排除", icon: <Shield className="size-4" /> },
  { id: "snippets", label: "Prompt 模板", icon: <Sparkles className="size-4" /> },
  { id: "due", label: "到期提醒", icon: <AlarmClock className="size-4" /> },
  { id: "ai", label: "AI 智能", icon: <Bot className="size-4" /> },
  { id: "data", label: "数据", icon: <Database className="size-4" /> },
  { id: "diagnostics", label: "诊断", icon: <Activity className="size-4" /> },
  { id: "about", label: "关于", icon: <Info className="size-4" /> },
];

/** 独立设置窗口：主面板是唯一持久化写入方，这里只收 state / 发 patch。 */
export default function SettingsView() {
  const [settings, setSettings] = useState<Settings>(defaultSettings());
  const [section, setSection] = useState<SectionId>("general");

  useEffect(() => {
    const un = listen<Settings>(SETTINGS_STATE, (e) => setSettings(e.payload));
    void emitTo("main", SETTINGS_REQUEST, {});
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  const patch = (p: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...p }));
    void emitTo("main", SETTINGS_PATCH, p);
  };

  return (
    <div className="flex h-screen w-screen select-none bg-background text-foreground">
      <aside className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border/60 bg-muted/40 p-2">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-body",
              section === s.id
                ? "bg-primary/10 font-medium text-foreground"
                : "text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
            )}
          >
            {s.icon}
            {s.label}
          </button>
        ))}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-5">
        {section === "general" && <GeneralSection settings={settings} patch={patch} />}
        {section === "hotkey" && <HotkeySection settings={settings} patch={patch} />}
        {section === "clip" && <ClipboardSection settings={settings} patch={patch} />}
        {section === "companion" && <CompanionSection settings={settings} patch={patch} />}
        {section === "exclude" && <ExcludeSection settings={settings} patch={patch} />}
        {section === "snippets" && <SnippetsSection settings={settings} patch={patch} />}
        {section === "due" && <DuePresetsSection settings={settings} patch={patch} />}
        {section === "ai" && <AiSection settings={settings} patch={patch} />}
        {section === "data" && <DataSection />}
        {section === "diagnostics" && <DiagnosticsSection />}
        {section === "about" && <AboutSection settings={settings} patch={patch} />}
      </main>
    </div>
  );
}

/* ============ 通用控件 ============ */

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-heading font-semibold">{children}</h2>;
}

function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      {title && (
        <p className="mb-1.5 text-body font-medium text-muted-foreground">{title}</p>
      )}
      <div className="divide-y divide-border/50 rounded-xl border border-border/60 bg-card">
        {children}
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  right,
}: {
  label: string;
  hint?: string;
  right: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
      <div className="min-w-0">
        <p className="text-title">{label}</p>
        {hint && <p className="mt-0.5 text-label text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{right}</div>
    </div>
  );
}

type SP = { settings: Settings; patch: (p: Partial<Settings>) => void };

/** 滑杆 + 数值 label（windowOpacity/panelOpacity/cardOpacity/companionGap 四处复用）。 */
function PercentSlider({
  value,
  min,
  max,
  step,
  onChange,
  format = (v) => `${v}%`,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-32 cursor-pointer accent-primary"
      />
      <span className="w-9 text-right text-label tabular-nums text-muted-foreground">
        {format(value)}
      </span>
    </div>
  );
}

/** 卡片右键菜单自定义：显隐开关 + 顺序调整（合并/删除固定，不参与）。 */
function ContextMenuGroup({ settings, patch }: SP) {
  const cfg = normalizeContextMenu(settings.contextMenu);
  const labelOf = (id: string) =>
    CONTEXT_MENU_REGISTRY.find((i) => i.id === id)?.label ?? id;
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= cfg.length) return;
    const next = [...cfg];
    [next[idx], next[j]] = [next[j], next[idx]];
    patch({ contextMenu: next });
  };
  return (
    <Group title="卡片右键菜单（勾选显示 · 箭头调序；合并与删除固定不动）">
      {cfg.map((item, idx) => (
        <div key={item.id} className="group flex items-center gap-3 px-3.5 py-2">
          <Switch
            checked={item.on}
            onCheckedChange={(v) =>
              patch({
                contextMenu: cfg.map((i) =>
                  i.id === item.id ? { ...i, on: v } : i
                ),
              })
            }
          />
          <span
            className={cn(
              "flex-1 text-title",
              !item.on && "text-muted-foreground/50"
            )}
          >
            {labelOf(item.id)}
          </span>
          <div className="flex gap-0.5">
            <IconButton
              label="上移"
              size="2xs"
              reveal="hover-focus"
              disabled={idx === 0}
              onClick={() => move(idx, -1)}
            >
              <ArrowUp />
            </IconButton>
            <IconButton
              label="下移"
              size="2xs"
              reveal="hover-focus"
              disabled={idx === cfg.length - 1}
              onClick={() => move(idx, 1)}
            >
              <ArrowDown />
            </IconButton>
          </div>
        </div>
      ))}
    </Group>
  );
}

/* ============ 各分区 ============ */

function GeneralSection({ settings, patch }: SP) {
  const [autostart, setAutostart] = useState(false);
  useEffect(() => {
    isEnabled().then(setAutostart).catch(() => {});
  }, []);
  const toggleAutostart = async (next: boolean) => {
    setAutostart(next);
    try {
      if (next) await enable();
      else await disable();
    } catch {
      setAutostart(!next);
    }
  };

  return (
    <div>
      <SectionTitle>通用</SectionTitle>
      <Group title="外观">
        <Row
          label="主题"
          right={
            <Segmented<ThemePref>
              value={settings.theme}
              options={[
                { value: "system", label: "跟随系统" },
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
              ]}
              onChange={(v) => patch({ theme: v })}
              ariaLabel="主题"
            />
          }
        />
        <Row
          label="窗口整体不透明度"
          hint="连毛玻璃一起变透，可真正看穿下层窗口内容"
          right={
            <PercentSlider
              value={Math.round(settings.windowOpacity * 100)}
              min={30}
              max={100}
              step={5}
              onChange={(v) => patch({ windowOpacity: v / 100 })}
            />
          }
        />
        <Row
          label="内容底色浓度"
          hint="面板自绘膜层的浓淡（毛玻璃关闭时效果最直观）"
          right={
            <PercentSlider
              value={Math.round(settings.panelOpacity * 100)}
              min={25}
              max={100}
              step={5}
              onChange={(v) => patch({ panelOpacity: v / 100 })}
            />
          }
        />
        <Row
          label="毛玻璃背景"
          hint="macOS 原生 vibrancy 模糊效果"
          right={
            <Switch
              checked={settings.vibrancy}
              onCheckedChange={(v) => patch({ vibrancy: v })}
            />
          }
        />
        {settings.vibrancy && (
          <Row
            label="毛玻璃材质"
            hint="不同材质的模糊强度与色调不同"
            right={
              <Segmented<VibrancyMaterial>
                value={settings.vibrancyMaterial}
                options={[
                  { value: "hud", label: "HUD" },
                  { value: "popover", label: "浮层" },
                  { value: "sidebar", label: "边栏" },
                  { value: "under-window", label: "窗底" },
                  { value: "fullscreen", label: "全屏" },
                ]}
                onChange={(v) => patch({ vibrancyMaterial: v })}
                ariaLabel="毛玻璃材质"
              />
            }
          />
        )}
        <Row
          label="卡片彩色通栏"
          hint="用来源应用图标主色作卡片顶栏底色；关闭则统一中性灰"
          right={
            <Switch
              checked={settings.cardTint}
              onCheckedChange={(v) => patch({ cardTint: v })}
            />
          }
        />
        <Row
          label="卡片密度"
          hint="紧凑模式单行展示，一屏可见更多卡片"
          right={
            <Segmented<Settings["cardDensity"]>
              value={settings.cardDensity}
              options={[
                { value: "comfortable", label: "舒适" },
                { value: "compact", label: "紧凑" },
              ]}
              onChange={(v) => patch({ cardDensity: v })}
              ariaLabel="卡片密度"
            />
          }
        />
        <Row
          label="卡片底色不透明度"
          hint="调低可透出毛玻璃背景；100% 为实色卡片"
          right={
            <PercentSlider
              value={Math.round(settings.cardOpacity * 100)}
              min={30}
              max={100}
              step={5}
              onChange={(v) => patch({ cardOpacity: v / 100 })}
            />
          }
        />
      </Group>
      <Group title="系统">
        <Row
          label="开机启动"
          hint="登录后自动在后台待命"
          right={<Switch checked={autostart} onCheckedChange={toggleAutostart} />}
        />
      </Group>
      <Group title="行为">
        <Row
          label="发送后自动按回车"
          hint="直接把内容发给 AI，谨慎开启"
          right={
            <Switch
              checked={settings.autoEnter}
              onCheckedChange={(v) => patch({ autoEnter: v })}
            />
          }
        />
        <Row
          label="面板置顶"
          hint="显示在屏幕最上层；关闭后可被其他窗口盖住"
          right={
            <Switch
              checked={settings.panelTopmost}
              onCheckedChange={(v) => patch({ panelTopmost: v })}
            />
          }
        />
        <Row
          label="失焦自动隐藏"
          hint="点击其他应用时收起面板（钉住豁免）；关闭则面板保持显示"
          right={
            <Switch
              checked={settings.hideOnBlur}
              onCheckedChange={(v) => patch({ hideOnBlur: v })}
            />
          }
        />
        <Row
          label="隐身模式"
          hint="不弹「已捕获」气泡（投屏/会议用，失败警示仍显示）"
          right={
            <Switch
              checked={settings.stealth}
              onCheckedChange={(v) => patch({ stealth: v })}
            />
          }
        />
        <Row
          label="音效"
          hint="捕获成功时轻响一声（隐身模式下自动静音）"
          right={
            <Switch
              checked={settings.soundEnabled}
              onCheckedChange={(v) => patch({ soundEnabled: v })}
            />
          }
        />
      </Group>
      <ContextMenuGroup settings={settings} patch={patch} />
    </div>
  );
}



/** 保留时长滑杆（Paste 风格连续细分：1 天 ~ 2 年 ~ 无限，共 23 档）。 */
const RETENTION_STEPS: { days: number | null; label: string }[] = [
  ...[1, 2, 3, 4, 5, 6].map((d) => ({ days: d, label: `${d} 天` })),
  ...[1, 2, 3].map((w) => ({ days: w * 7, label: `${w} 周` })),
  ...Array.from({ length: 11 }, (_, i) => ({
    days: (i + 1) * 30,
    label: `${i + 1} 个月`,
  })),
  { days: 365, label: "1 年" },
  { days: 730, label: "2 年" },
  { days: null, label: "无限" },
];

function RetentionSlider({ settings, patch }: SP) {
  // 拖动中只更新本地视觉，松手才提交（缩短需确认，拖动途中不能连环弹窗）
  const [drag, setDrag] = useState<number | null>(null);
  const committed = RETENTION_STEPS.findIndex(
    (st) => st.days === settings.clipRetentionDays
  );
  const committedIdx = committed >= 0 ? committed : RETENTION_STEPS.length - 1;
  const shownIdx = drag ?? committedIdx;
  const shown = RETENTION_STEPS[shownIdx];

  const commit = () => {
    if (drag === null || drag === committedIdx) {
      setDrag(null);
      return;
    }
    const next = RETENTION_STEPS[drag];
    const cur = settings.clipRetentionDays;
    const shrinking = next.days !== null && (cur === null || next.days < cur);
    if (!shrinking) {
      patch({ clipRetentionDays: next.days });
      setDrag(null);
      return;
    }
    // 缩短会清理更旧记录：原生确认框（取消则滑块弹回原值）
    void ask(
      "比新的时长限制更旧的记录将被立即清理。\n已固定（★）的记录不会被删除。",
      {
        title: `确定把保留时长调整为「${next.label}」吗？`,
        kind: "warning",
        okLabel: "调整并清理",
        cancelLabel: "取消",
      }
    ).then((yes) => {
      if (yes) patch({ clipRetentionDays: next.days });
      setDrag(null);
    });
  };

  return (
    <div className="w-60">
      <input
        type="range"
        min={0}
        max={RETENTION_STEPS.length - 1}
        step={1}
        value={shownIdx}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="w-full accent-primary"
      />
      <p className="mt-0.5 text-center text-body font-medium">{shown.label}</p>
      <div className="flex justify-between text-micro text-muted-foreground/70">
        <span>天</span>
        <span>周</span>
        <span>个月</span>
        <span>年</span>
        <span>无限</span>
      </div>
      {shown.days === null && (
        <p className="mt-1 text-label text-amber-600 dark:text-amber-500">
          ⚠️ 无限历史可能会增加您的磁盘空间使用量
        </p>
      )}
    </div>
  );
}

/** 剪贴板独立配置：收集/暂停/保留/删除历史/规则（参照 Paste）。 */
function ClipboardSection({ settings, patch }: SP) {
  const paused =
    settings.clipPauseUntil !== null && settings.clipPauseUntil > Date.now();
  const resumeAt = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const pauseBtn =
    "rounded-md border border-border px-1.5 py-0.5 text-label text-muted-foreground hover:text-foreground";
  return (
    <div>
      <SectionTitle>剪贴板</SectionTitle>
      <Group title="收集">
        <Row
          label="剪贴板历史"
          hint="自动收集复制的内容到「剪贴板」页"
          right={
            <Switch
              checked={settings.clipHistory}
              onCheckedChange={(v) => patch({ clipHistory: v })}
            />
          }
        />
        {settings.clipHistory && (
          <Row
            label="暂停收集"
            hint={
              paused
                ? `已暂停 · ${resumeAt(settings.clipPauseUntil!)} 自动恢复`
                : "临时停止收集，到点自动恢复"
            }
            right={
              paused ? (
                <button
                  onClick={() => patch({ clipPauseUntil: null })}
                  className="rounded-md border border-primary/50 bg-primary/10 px-2 py-0.5 text-label font-medium"
                >
                  立即恢复
                </button>
              ) : (
                <div className="flex gap-1">
                  {[15, 30, 60, 480].map((m) => (
                    <button
                      key={m}
                      onClick={() =>
                        patch({ clipPauseUntil: Date.now() + m * 60_000 })
                      }
                      className={pauseBtn}
                    >
                      {m < 60 ? `${m}分` : `${m / 60}时`}
                    </button>
                  ))}
                </div>
              )
            }
          />
        )}
      </Group>
      <Group title="保留历史">
        <Row
          label="保留时长"
          hint="超龄记录自动清理（固定 ★ 不清理）"
          right={<RetentionSlider settings={settings} patch={patch} />}
        />
        <Row
          label="删除历史"
          hint="清空全部非固定的剪贴板记录（可在主面板撤销）"
          right={
            <button
              onClick={() => {
                // 破坏性操作先原生确认框（Paste 同款 NSAlert）
                void ask(
                  "已固定（★）的记录不会被删除。\n删除后可在主面板的提示气泡中撤销一次。",
                  {
                    title: "您确定要删除剪贴板历史记录吗？",
                    kind: "warning",
                    okLabel: "清除",
                    cancelLabel: "取消",
                  }
                ).then((yes) => {
                  if (yes) void emitTo("main", SETTINGS_CLEAR_CLIP, {});
                });
              }}
              className="rounded-md border border-destructive/40 px-2 py-0.5 text-label text-destructive hover:bg-destructive/10"
            >
              删除历史…
            </button>
          }
        />
      </Group>
      <Group title="规则">
        <Row
          label="忽略机密内容"
          hint="检测到密码管理器的机密标记时不保存"
          right={
            <Switch
              checked={settings.clipIgnoreConcealed}
              onCheckedChange={(v) => patch({ clipIgnoreConcealed: v })}
            />
          }
        />
        <Row
          label="忽略瞬时内容"
          hint="不保存其他程序生成的临时数据"
          right={
            <Switch
              checked={settings.clipIgnoreTransient}
              onCheckedChange={(v) => patch({ clipIgnoreTransient: v })}
            />
          }
        />
      </Group>
      <p className="mb-2 text-body font-medium text-muted-foreground">忽略应用程序</p>
      <p className="mb-3 text-body text-muted-foreground">
        不保存从以下应用复制的内容（独立于「捕获排除」列表）。
      </p>
      <AppListEditor
        apps={settings.clipExcludedApps}
        onChange={(apps) => patch({ clipExcludedApps: apps })}
        addLabel="把当前应用加入忽略列表"
      />
    </div>
  );
}

function HotkeySection({ settings, patch }: SP) {
  return (
    <div>
      <SectionTitle>快捷键</SectionTitle>
      <Group title="全局触发">
        <Row
          label="触发键（双击）"
          right={
            <Segmented
              value={settings.hotkeyModifier}
              options={[
                { value: "shift", label: "⇧ Shift" },
                { value: "control", label: "⌃ Ctrl" },
                { value: "option", label: "⌥ Opt" },
              ]}
              onChange={(v) => patch({ hotkeyModifier: v })}
              ariaLabel="触发键（双击）"
            />
          }
        />
        <Row
          label="双击间隔"
          hint="第一次抬起到第二次按下的最大间隔"
          right={
            <Segmented
              value={String(settings.hotkeyGapMs) as "300" | "400" | "500"}
              options={[
                { value: "300", label: "快 300ms" },
                { value: "400", label: "标准 400ms" },
                { value: "500", label: "从容 500ms" },
              ]}
              onChange={(v) => patch({ hotkeyGapMs: Number(v) })}
              ariaLabel="双击间隔"
            />
          }
        />
        <Row
          label="双击行为"
          hint="仅捕获：无选中只轻提示、不开关面板（配合下方专用面板快捷键）"
          right={
            <Segmented
              value={settings.doubleTapCaptureOnly ? "capture" : "smart"}
              options={[
                { value: "smart", label: "智能" },
                { value: "capture", label: "仅捕获" },
              ]}
              onChange={(v) => patch({ doubleTapCaptureOnly: v === "capture" })}
              ariaLabel="双击行为"
            />
          }
        />
        <Row
          label="面板显示 / 隐藏"
          hint="独立快捷键，只开关面板不捕获内容；钉住时也可收起"
          right={
            <HotkeyRecorder
              value={settings.panelToggleHotkey}
              onChange={(v) => patch({ panelToggleHotkey: v })}
            />
          }
        />
      </Group>
      <Group title="面板内快捷键（长按 ⌥ 可随时速查）">
        {SHORTCUTS.map(([k, d]) => (
          <Row
              key={k}
              label={d}
              right={
                // 还原重塑前键帽形态（用户定稿）：11px / bg-muted / 不撑最小宽
                <kbd className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-label tabular-nums">
                  {k}
                </kbd>
              }
            />
        ))}
      </Group>
    </div>
  );
}

/** 面板快捷键的 mac 符号展示（存储用 global-shortcut 格式如 "Cmd+Shift+KeyV"）。 */
const HOTKEY_MOD_LABELS: Record<string, string> = {
  Cmd: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};
const HOTKEY_CODE_LABELS: Record<string, string> = {
  Space: "Space",
  Enter: "⏎",
  Tab: "⇥",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Home: "↖",
  End: "↘",
  PageUp: "⇞",
  PageDown: "⇟",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

function hotkeyLabel(shortcut: string): string {
  return shortcut
    .split("+")
    .map(
      (part) =>
        HOTKEY_MOD_LABELS[part] ??
        HOTKEY_CODE_LABELS[part] ??
        (part.startsWith("Key")
          ? part.slice(3)
          : part.startsWith("Digit")
            ? part.slice(5)
            : part)
    )
    .join(" ");
}

/** 可注册为主键的 W3C code（keyboard_types::Code 可解析的子集）。 */
const HOTKEY_CODE_RE =
  /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9])|Space|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Enter|Tab)$/;

/** 快捷键录制器：点击进入录制，按组合键先试注册（可发现占用），成功才落设置。 */
function HotkeyRecorder({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 录制用 window 级捕获监听，不依赖 DOM 焦点：WKWebView 与 Safari 一样
  // 点击按钮不给焦点，且 React 复用按钮节点导致 autoFocus 不触发，
  // 挂在按钮上的 onKeyDown 一个键也收不到。
  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        setError(null);
        return;
      }
      // 纯修饰键按下：继续等主键
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      const code = e.code;
      if (!HOTKEY_CODE_RE.test(code)) return;
      // 纯 Shift/无修饰会拦截正常输入，仅 F 键豁免
      const isFnKey = /^F([1-9]|1[0-9])$/.test(code);
      if (!isFnKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setError("需包含 ⌘ / ⌃ / ⌥");
        return;
      }
      const mods = [
        e.metaKey && "Cmd",
        e.ctrlKey && "Ctrl",
        e.altKey && "Alt",
        e.shiftKey && "Shift",
      ].filter(Boolean) as string[];
      const shortcut = [...mods, code].join("+");
      void api
        .setPanelHotkey(shortcut)
        .then(() => {
          onChange(shortcut);
          setRecording(false);
          setError(null);
        })
        .catch(() => setError("注册失败，可能已被其他应用占用"));
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [recording, onChange]);

  return (
    <div className="flex items-center gap-1.5">
      {/* 两种提示惯例：HUD tip() 是离散完成动作的默认通道；
          这里的就地 role=alert chip 仅用于「正在操作的控件」内的即时错误。 */}
      {error && (
        <span
          role="alert"
          className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-label text-destructive"
        >
          <AlertCircle className="size-3" />
          {error}
        </span>
      )}
      {recording ? (
        <button
          onClick={() => {
            setRecording(false);
            setError(null);
          }}
          className="rounded-md border border-primary/60 bg-primary/10 px-2 py-1 text-body text-muted-foreground"
        >
          按下组合键，Esc 取消
        </button>
      ) : (
        <button
          onClick={() => {
            setRecording(true);
            setError(null);
          }}
          className="rounded-md border border-border bg-muted px-2 py-1 text-body tabular-nums hover:bg-black/5 dark:hover:bg-white/10"
        >
          {value ? hotkeyLabel(value) : "点击录制"}
        </button>
      )}
      {value && !recording && (
        <button
          onClick={() => {
            onChange(null);
            setError(null);
          }}
          className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          title="清除快捷键"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** 应用列表展示信息缓存（bundle id → 名称/图标；设置窗口会话内有效）。 */
const appInfoCache = new Map<
  string,
  Promise<{ name: string; iconUrl: string | null } | null>
>();

function useAppListInfo(bundleId: string) {
  const [info, setInfo] = useState<{ name: string; iconUrl: string | null } | null>(
    null
  );
  useEffect(() => {
    let hit = appInfoCache.get(bundleId);
    if (!hit) {
      hit = api.appListInfo(bundleId).catch(() => null);
      appInfoCache.set(bundleId, hit);
    }
    let alive = true;
    void hit.then((i) => {
      if (alive) setInfo(i);
    });
    return () => {
      alive = false;
    };
  }, [bundleId]);
  return info;
}

/** 列表行：应用图标 + 显示名（未安装/解析失败回退 bundle id）。 */
function AppListRow({
  bundle,
  onRemove,
}: {
  bundle: string;
  onRemove: () => void;
}) {
  const info = useAppListInfo(bundle);
  return (
    <div className="group flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
      {info?.iconUrl ? (
        <img src={info.iconUrl} alt="" className="size-5 shrink-0" />
      ) : (
        <span className="size-5 shrink-0 rounded-sm bg-black/10 dark:bg-white/10" />
      )}
      <span className="truncate text-title" title={bundle}>
        {info?.name ?? bundle}
      </span>
      <IconButton
        label="移除"
        tone="danger"
        size="2xs"
        reveal="hover-focus"
        className="ml-auto"
        onClick={onRemove}
      >
        <X />
      </IconButton>
    </div>
  );
}

function AppListEditor({
  apps,
  onChange,
  addLabel,
}: {
  apps: string[];
  onChange: (apps: string[]) => void;
  addLabel: string;
}) {
  const addCurrent = async () => {
    try {
      const info = await api.prevAppInfo();
      if (!info || apps.includes(info.bundleId)) return;
      onChange([...apps, info.bundleId]);
    } catch {
      /* ignore */
    }
  };
  const pickApp = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        defaultPath: "/Applications",
        filters: [{ name: "应用程序", extensions: ["app"] }],
      });
      if (typeof picked !== "string") return;
      const bundle = await api.bundleIdOfApp(picked);
      if (bundle && !apps.includes(bundle)) onChange([...apps, bundle]);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="rounded-xl border border-border/60 bg-card p-2">
      <div className="mb-1 flex items-center gap-1">
        <button
          onClick={pickApp}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-body text-primary hover:bg-primary/10"
        >
          <Plus className="size-3.5" /> 选择应用…
        </button>
        <button
          onClick={addCurrent}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-body text-primary hover:bg-primary/10"
        >
          <Plus className="size-3.5" /> {addLabel}
        </button>
      </div>
      <div className="max-h-56 overflow-y-auto">
        {apps.map((bundle) => (
          <AppListRow
            key={bundle}
            bundle={bundle}
            onRemove={() => onChange(apps.filter((b) => b !== bundle))}
          />
        ))}
        {apps.length === 0 && (
          <p className="px-1.5 py-1 text-body text-muted-foreground/60">空</p>
        )}
      </div>
    </div>
  );
}

function CompanionSection({ settings, patch }: SP) {
  return (
    <div>
      <SectionTitle>伴随停靠</SectionTitle>
      <Group>
        <Row
          label="启用伴随停靠"
          hint="面板磁吸到列表内应用的窗口右缘、同高并实时跟随"
          right={
            <Switch
              checked={settings.companionEnabled}
              onCheckedChange={(v) => patch({ companionEnabled: v })}
            />
          }
        />
        <Row
          label="与窗口的间隙"
          hint="面板贴靠目标窗口时留出的空隙（0 为紧贴）"
          right={
            <PercentSlider
              value={settings.companionGap}
              min={0}
              max={40}
              step={2}
              onChange={(v) => patch({ companionGap: v })}
              format={(v) => `${v}pt`}
            />
          }
        />
      </Group>
      <p className="mb-1.5 text-body font-medium text-muted-foreground">
        伴随应用列表（bundle id）
      </p>
      <AppListEditor
        apps={settings.companionApps}
        onChange={(apps) => patch({ companionApps: apps })}
        addLabel="把当前应用加入伴随列表（先在目标应用里呼出过面板）"
      />
    </div>
  );
}

function ExcludeSection({ settings, patch }: SP) {
  return (
    <div>
      <SectionTitle>捕获排除</SectionTitle>
      <p className="mb-3 text-body text-muted-foreground">
        列表内的应用中双击只开关面板、绝不读取任何内容（密码管理器等敏感应用）。
      </p>
      <AppListEditor
        apps={settings.excludedApps}
        onChange={(apps) => patch({ excludedApps: apps })}
        addLabel="把当前应用加入排除列表"
      />
    </div>
  );
}

const WEEKDAY_OPTIONS = [
  { value: "1", label: "周一" },
  { value: "2", label: "周二" },
  { value: "3", label: "周三" },
  { value: "4", label: "周四" },
  { value: "5", label: "周五" },
  { value: "6", label: "周六" },
  { value: "0", label: "周日" },
];


/** AI 智能：OpenAI 兼容提供商单配置 + 功能开关 + 连接测试。 */
function AiSection({ settings, patch }: SP) {
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const preset = matchPreset(settings.aiBaseUrl);
  const fetchModels = async () => {
    if (fetchingModels) return;
    setFetchingModels(true);
    try {
      const ids = await api.aiListModels(
        settings.aiBaseUrl.trim(),
        settings.aiApiKey.trim()
      );
      setModels(ids);
      // 当前值不在列表时不强改，让用户自行选择
      tip("ok", `获取到 ${ids.length} 个模型`);
    } catch (e) {
      tip("warn", `获取失败：${String(e).slice(0, 80)}`);
    } finally {
      setFetchingModels(false);
    }
  };
  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    try {
      await testAiConnection(settings.aiBaseUrl, settings.aiApiKey, settings.aiModel);
      tip("ok", "AI 连接成功");
    } catch (e) {
      tip("warn", `连接失败：${String(e).slice(0, 80)}`);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div>
      <SectionTitle>AI 智能</SectionTitle>
      <p className="mb-3 text-body text-muted-foreground">
        配置 OpenAI 兼容的 AI 提供商后：任务输入框 ✨ 模式支持「下午3点提醒我开会」
        「20分钟后提醒我关火」等自然语言建任务；任务右键可 AI 拆解子任务；
        笔记右键可 AI 转任务、AI 起标题。
      </p>
      <Group>
        <Row
          label="启用 AI 智能"
          hint="关闭后各 AI 入口点击提示去配置，不发起请求"
          right={
            <Switch
              checked={settings.aiEnabled}
              onCheckedChange={(v) => patch({ aiEnabled: v })}
            />
          }
        />
      </Group>
      <Group title="提供商（OpenAI 兼容）">
        <div className="flex flex-wrap items-center gap-1 px-3.5 py-2.5">
          {AI_PRESETS.map((pz) => (
            <button
              key={pz.id}
              onClick={() => {
                if (pz.id === "custom") {
                  // 进入自定义：清空 Base URL 待手动输入（模型与 Key 保留）
                  patch({ aiBaseUrl: "" });
                  return;
                }
                patch({
                  aiBaseUrl: pz.baseUrl,
                  // 仅模型名为空时才填充推荐值，避免覆盖用户已填内容
                  ...(settings.aiModel.trim() ? {} : { aiModel: pz.modelHint }),
                });
              }}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-label",
                preset === pz.id
                  ? "border-border bg-primary/10 font-medium text-foreground dark:border-input"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {pz.label}
            </button>
          ))}
        </div>
        <Row
          label="Base URL"
          hint="如 https://api.deepseek.com（自动拼接 /v1/chat/completions）"
          right={
            <input
              value={settings.aiBaseUrl}
              onChange={(e) => patch({ aiBaseUrl: e.target.value })}
              placeholder="https://…"
              autoComplete="off"
              className="h-8 w-64 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus:border-primary/50"
            />
          }
        />
        <Row
          label="API Key"
          hint="明文保存在本地数据文件，仅发往上方 Base URL"
          right={
            <div className="flex items-center gap-1">
              <input
                type={showKey ? "text" : "password"}
                value={settings.aiApiKey}
                onChange={(e) => patch({ aiApiKey: e.target.value })}
                placeholder="sk-…"
                autoComplete="off"
                className="h-8 w-56 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus:border-primary/50"
              />
              <IconButton
                label={showKey ? "隐藏密钥" : "显示密钥"}
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </IconButton>
            </div>
          }
        />
        <Row
          label="模型名"
          hint={
            models.length
              ? `已获取 ${models.length} 个模型，下拉选择`
              : "如 deepseek-chat / gpt-4o-mini，或点「获取列表」拉取"
          }
          right={
            <div className="flex items-center gap-1">
              {models.length ? (
                <select
                  value={models.includes(settings.aiModel) ? settings.aiModel : ""}
                  onChange={(e) => {
                    if (e.target.value === "__manual__") {
                      setModels([]);
                      return;
                    }
                    if (e.target.value) patch({ aiModel: e.target.value });
                  }}
                  className="h-8 w-56 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus:border-primary/50"
                >
                  <option value="" disabled>
                    选择模型…
                  </option>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  <option value="__manual__">手动输入…</option>
                </select>
              ) : (
                <input
                  value={settings.aiModel}
                  onChange={(e) => patch({ aiModel: e.target.value })}
                  placeholder="模型 ID"
                  autoComplete="off"
                  className="h-8 w-44 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus:border-primary/50"
                />
              )}
              <button
                onClick={() => void fetchModels()}
                disabled={fetchingModels}
                className="shrink-0 rounded-lg border border-border px-2 py-1 text-label text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {fetchingModels ? "获取中…" : models.length ? "刷新" : "获取列表"}
              </button>
            </div>
          }
        />
        <Row
          label="连接测试"
          hint="用当前填写的配置发一次最小请求（无需先启用）"
          right={
            <button
              onClick={() => void runTest()}
              disabled={testing}
              className="rounded-lg border border-border px-2.5 py-1 text-label text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {testing ? "测试中…" : "测试连接"}
            </button>
          }
        />
      </Group>
      <p className="text-label text-muted-foreground/70">
        隐私说明：仅在你主动触发 AI 功能时，把相关文本发送到上方配置的服务；
        无中转代理，密钥与内容不写入诊断日志。
      </p>
    </div>
  );
}

/** 到期快捷档编辑：任务「到期」弹层里的快捷选项，可增删改。 */
function DuePresetsSection({ settings, patch }: SP) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DuePresetCfg | null>(null);
  const [unit, setUnit] = useState<"m" | "h">("m");

  const startEdit = (p: DuePresetCfg) => {
    setEditingId(p.id);
    setDraft({ ...p });
    setUnit(p.kind === "relative" && p.minutes % 60 === 0 && p.minutes >= 60 ? "h" : "m");
  };
  const save = () => {
    if (!editingId || !draft) return;
    patch({
      duePresets: settings.duePresets.map((p) => (p.id === editingId ? draft : p)),
    });
    setEditingId(null);
    setDraft(null);
  };
  const remove = (id: string) => {
    if (editingId === id) {
      setEditingId(null);
      setDraft(null);
    }
    patch({ duePresets: settings.duePresets.filter((p) => p.id !== id) });
  };
  const add = () => {
    const p: DuePresetCfg = { id: crypto.randomUUID(), kind: "relative", minutes: 60 };
    patch({ duePresets: [...settings.duePresets, p] });
    startEdit(p);
  };
  const switchKind = (kind: "relative" | "today" | "tomorrow" | "weekday") => {
    if (!draft) return;
    if (kind === "relative") {
      setDraft({ id: draft.id, kind, minutes: 60 });
      setUnit("h");
    } else if (kind === "weekday") {
      setDraft({ id: draft.id, kind, weekday: 1, hour: 9, minute: 0 });
    } else {
      setDraft({ id: draft.id, kind, hour: kind === "today" ? 20 : 9, minute: 0 });
    }
  };
  const hmStr = (h: number, m: number) =>
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const patchTime = (v: string) => {
    if (!draft || draft.kind === "relative") return;
    const [h, m] = v.split(":").map((n) => Number(n));
    if (Number.isFinite(h) && Number.isFinite(m)) {
      setDraft({ ...draft, hour: h, minute: m });
    }
  };

  return (
    <div>
      <SectionTitle>到期提醒快捷档</SectionTitle>
      <p className="mb-3 text-body text-muted-foreground">
        任务「到期」弹层里的快捷选项（按此处顺序排列）。相对档从点选时刻起算；
        「今天」定点即使已过也不隐式跳到明天；周几档为「下一个」该周几（不含当天）。
      </p>
      <div className="mb-3 divide-y divide-border/50 rounded-xl border border-border/60 bg-card">
        {settings.duePresets.map((p) =>
          editingId === p.id && draft ? (
            <div key={p.id} className="flex flex-col gap-2 px-3.5 py-2.5">
              <Segmented<"relative" | "today" | "tomorrow" | "weekday">
                value={draft.kind}
                onChange={switchKind}
                options={[
                  { value: "relative", label: "多久后" },
                  { value: "today", label: "今天" },
                  { value: "tomorrow", label: "明天" },
                  { value: "weekday", label: "下个周几" },
                ]}
              />
              <div className="flex items-center gap-2">
                {draft.kind === "relative" ? (
                  <>
                    <input
                      type="number"
                      min={1}
                      step={unit === "h" ? 0.5 : 1}
                      value={unit === "h" ? draft.minutes / 60 : draft.minutes}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isFinite(n) || n <= 0) return;
                        setDraft({
                          ...draft,
                          minutes: Math.max(1, Math.round(unit === "h" ? n * 60 : n)),
                        });
                      }}
                      className="h-8 w-20 rounded-lg border border-border bg-transparent px-2 text-body tabular-nums outline-none focus:border-primary/50"
                    />
                    <Segmented<"m" | "h">
                      value={unit}
                      onChange={setUnit}
                      options={[
                        { value: "m", label: "分钟" },
                        { value: "h", label: "小时" },
                      ]}
                    />
                  </>
                ) : (
                  <>
                    {draft.kind === "weekday" && (
                      <select
                        value={String(draft.weekday)}
                        onChange={(e) =>
                          setDraft({ ...draft, weekday: Number(e.target.value) })
                        }
                        className="h-8 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus:border-primary/50"
                      >
                        {WEEKDAY_OPTIONS.map((w) => (
                          <option key={w.value} value={w.value}>
                            {w.label}
                          </option>
                        ))}
                      </select>
                    )}
                    <input
                      type="time"
                      value={hmStr(draft.hour, draft.minute)}
                      onChange={(e) => patchTime(e.target.value)}
                      className="h-8 rounded-lg border border-border bg-transparent px-2 text-body tabular-nums outline-none focus:border-primary/50"
                    />
                  </>
                )}
                <span className="text-body text-muted-foreground">
                  → {presetCfgLabel(draft)}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={save}
                    className="rounded-lg bg-primary px-2.5 py-1 text-body text-primary-foreground hover:opacity-90"
                  >
                    保存
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(null);
                      setDraft(null);
                    }}
                    className="rounded-lg px-2 py-1 text-body text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div key={p.id} className="flex items-center gap-2 px-3.5 py-2">
              <span className="text-title">{presetCfgLabel(p)}</span>
              <div className="ml-auto flex items-center gap-0.5">
                <button
                  aria-label="编辑"
                  onClick={() => startEdit(p)}
                  className="rounded-md p-1 text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  aria-label="删除"
                  onClick={() => remove(p.id)}
                  className="rounded-md p-1 text-muted-foreground hover:bg-black/5 hover:text-destructive dark:hover:bg-white/10"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          )
        )}
        {settings.duePresets.length === 0 && (
          <p className="px-3.5 py-3 text-body text-muted-foreground">
            没有快捷档，弹层里只剩自定义日期时间。
          </p>
        )}
      </div>
      <button
        onClick={add}
        className="flex items-center gap-1 rounded-lg border border-border/60 px-2.5 py-1.5 text-body text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
      >
        <Plus className="size-3.5" /> 添加档位
      </button>
    </div>
  );
}

function SnippetsSection({ settings, patch }: SP) {
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editText, setEditText] = useState("");
  const add = () => {
    if (!label.trim() || !text.trim()) return;
    const snippet: PromptSnippet = {
      id: crypto.randomUUID(),
      label: label.trim(),
      text: text.trim(),
    };
    patch({ promptSnippets: [...settings.promptSnippets, snippet] });
    setLabel("");
    setText("");
  };
  const startEdit = (sn: PromptSnippet) => {
    setEditingId(sn.id);
    setEditLabel(sn.label);
    setEditText(sn.text);
  };
  const saveEdit = () => {
    if (!editingId || !editLabel.trim() || !editText.trim()) return;
    patch({
      promptSnippets: settings.promptSnippets.map((s) =>
        s.id === editingId
          ? { ...s, label: editLabel.trim(), text: editText.trim() }
          : s
      ),
    });
    setEditingId(null);
  };
  const move = (id: string, dir: -1 | 1) => {
    const list = [...settings.promptSnippets];
    const i = list.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    patch({ promptSnippets: list });
  };
  return (
    <div>
      <SectionTitle>Prompt 模板</SectionTitle>
      <p className="mb-3 text-body text-muted-foreground">
        发送时可在「发送到对话 ▾」下拉里选择模板（按此处顺序排列），与勾选内容组装后发出。
        模板中写 <code className="rounded-sm bg-muted px-1">{"{内容}"}</code>{" "}
        指定内容插入位置（可多处）；不写则内容拼在模板之后。
      </p>
      <div className="mb-3 divide-y divide-border/50 rounded-xl border border-border/60 bg-card">
        {settings.promptSnippets.map((sn, i) =>
          editingId === sn.id ? (
            <div key={sn.id} className="flex items-start gap-2 px-3.5 py-2">
              <input
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                placeholder="模板名"
                className="h-8 w-32 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus:border-primary/50"
              />
              <textarea
                value={editText}
                rows={3}
                autoFocus
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.metaKey) {
                    e.preventDefault();
                    saveEdit();
                  } else if (e.key === "Escape") {
                    setEditingId(null);
                  }
                }}
                className="min-h-8 flex-1 resize-y rounded-lg border border-border bg-transparent px-2 py-1.5 text-body leading-relaxed outline-none focus:border-primary/50"
              />
              <button
                onClick={saveEdit}
                title="保存（⌘⏎）"
                className="flex h-8 items-center gap-1 rounded-lg bg-primary px-2.5 text-body text-primary-foreground hover:opacity-90"
              >
                <Check className="size-3.5" /> 保存
              </button>
              <button
                onClick={() => setEditingId(null)}
                title="取消（Esc）"
                aria-label="取消编辑"
                className="flex h-8 items-center rounded-lg border border-border px-2 text-body text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : (
            <div key={sn.id} className="group flex items-center gap-2 px-3.5 py-2">
              <span className="shrink-0 text-title font-medium">{sn.label}</span>
              <span className="truncate text-body text-muted-foreground">
                {sn.text.replace(/\n+/g, " ⏎ ")}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                <IconButton
                  label="上移"
                  size="2xs"
                  reveal="hover-focus"
                  disabled={i === 0}
                  onClick={() => move(sn.id, -1)}
                >
                  <ArrowUp />
                </IconButton>
                <IconButton
                  label="下移"
                  size="2xs"
                  reveal="hover-focus"
                  disabled={i === settings.promptSnippets.length - 1}
                  onClick={() => move(sn.id, 1)}
                >
                  <ArrowDown />
                </IconButton>
                <IconButton
                  label="编辑模板"
                  size="2xs"
                  reveal="hover-focus"
                  onClick={() => startEdit(sn)}
                >
                  <Pencil />
                </IconButton>
                <IconButton
                  label="删除模板"
                  tone="danger"
                  size="2xs"
                  reveal="hover-focus"
                  onClick={() =>
                    patch({
                      promptSnippets: settings.promptSnippets.filter(
                        (s) => s.id !== sn.id
                      ),
                    })
                  }
                >
                  <X />
                </IconButton>
              </div>
            </div>
          )
        )}
        {settings.promptSnippets.length === 0 && (
          <p className="px-3.5 py-2 text-body text-muted-foreground/60">暂无模板</p>
        )}
      </div>
      <div className="flex items-start gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="模板名"
          className="h-8 w-32 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus:border-primary/50"
        />
        <textarea
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          placeholder="模板内容，写 {内容} 指定插入位置，支持多行"
          className="min-h-8 flex-1 resize-y rounded-lg border border-border bg-transparent px-2 py-1.5 text-body leading-relaxed outline-none focus:border-primary/50"
        />
        <button
          onClick={add}
          className="flex h-8 items-center gap-1 rounded-lg bg-primary px-3 text-body text-primary-foreground hover:opacity-90"
        >
          <Plus className="size-3.5" /> 添加
        </button>
      </div>
    </div>
  );
}

function DataSection() {
  const [dir, setDir] = useState("");
  useEffect(() => {
    api.getDataDir().then(setDir).catch(() => {});
  }, []);

  const pick = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    try {
      setDir(await api.setDataDir(picked));
    } catch (e) {
      tip("warn", `切换失败：${e}`);
    }
  };

  const reset = async () => {
    try {
      setDir(await api.resetDataDir());
    } catch {
      /* ignore */
    }
  };

  return (
    <div>
      <SectionTitle>数据</SectionTitle>
      <p className="mb-3 text-body text-muted-foreground">
        所有数据仅保存在本机，无账号、无同步、无遥测。
      </p>
      <Group title="存储位置">
        <div className="px-3.5 py-2.5">
          <p className="text-title">数据文件夹</p>
          <p className="mt-1 break-all rounded-lg bg-muted/60 px-2 py-1 font-mono text-label text-muted-foreground">
            {dir || "读取中…"}
          </p>
          <p className="mt-1 text-label text-muted-foreground">
            卡片数据（toskr-data.json）与图片附件（media/）都存放于此；
            切换文件夹会把已有内容一并搬过去。
            选择 iCloud Drive 内的文件夹即可多机同步（避免多台 Mac 同时运行）。
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={pick}
              className="rounded-lg border border-border px-3 py-1 text-body hover:bg-black/5 dark:hover:bg-white/5"
            >
              选择文件夹…
            </button>
            <button
              onClick={reset}
              className="rounded-lg border border-border px-3 py-1 text-body text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5"
            >
              恢复默认
            </button>
          </div>
        </div>
      </Group>
      <Group title="备份">
        <Row
          label="导出备份"
          hint="把全部分组与卡片导出为 JSON 文件"
          right={
            <button
              onClick={() => void emitTo("main", SETTINGS_EXPORT, {})}
              className="rounded-lg border border-border px-3 py-1 text-body hover:bg-black/5 dark:hover:bg-white/5"
            >
              导出…
            </button>
          }
        />
        <Row
          label="导入合并"
          hint="按 id 去重合并，不覆盖现有数据"
          right={
            <button
              onClick={() => void emitTo("main", SETTINGS_IMPORT, {})}
              className="rounded-lg border border-border px-3 py-1 text-body hover:bg-black/5 dark:hover:bg-white/5"
            >
              导入…
            </button>
          }
        />
      </Group>
    </div>
  );
}

function DiagnosticsSection() {
  const [entries, setEntries] = useState<{ atMs: number; msg: string }[]>([]);
  const load = () => {
    api.getDiagnostics().then(setEntries).catch(() => setEntries([]));
  };
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div>
      <SectionTitle>诊断</SectionTitle>
      <p className="mb-3 text-body text-muted-foreground">
        最近 50 条链路事件（自动刷新）：双击触发/拒绝原因、捕获分支、发送结果。
      </p>
      <div className="rounded-xl border border-border/60 bg-card p-2 font-mono">
        {entries.length === 0 ? (
          <p className="px-1.5 py-1 text-body text-muted-foreground/60">
            暂无记录 —— 双击一次触发键就有了
          </p>
        ) : (
          entries.map((d, i) => (
            <p key={i} className="px-1.5 py-0.5 text-label leading-snug text-muted-foreground">
              <span className="tabular-nums text-muted-foreground/50">
                {new Date(d.atMs).toLocaleTimeString("zh-CN", { hour12: false })}
              </span>{" "}
              {d.msg}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function AboutSection({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "latest" | "downloading">(
    "idle"
  );
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => {});
  }, []);

  const onCheck = async () => {
    setPhase("checking");
    const u = await checkForUpdate();
    if (u) {
      setUpdate(u);
      setPhase("idle");
    } else {
      setUpdate(null);
      setPhase("latest");
    }
  };

  const onInstall = async () => {
    if (!update) return;
    setPhase("downloading");
    setProgress(0);
    const ok = await downloadAndInstall(update, setProgress);
    if (!ok) setPhase("idle");
  };

  return (
    <div>
      <SectionTitle>关于</SectionTitle>

      <div className="mb-4 rounded-xl border border-border/60 bg-card p-4 text-center">
        <p className="text-heading font-semibold">Toskr</p>
        <p className="mt-0.5 text-body tabular-nums text-muted-foreground">
          v{version || "…"}
        </p>
        <p className="mt-2 text-body text-muted-foreground">
          面向 AI 工作流的全局划词摘录、Prompt 暂存与一键流转工具
        </p>
        <p className="mt-1 text-label text-muted-foreground/70">
          本地优先 · 无账号 · 无遥测
        </p>
      </div>

      <Group title="更新">
        <Row
          label={
            update
              ? `发现新版本 v${update.version}`
              : phase === "latest"
                ? "已是最新版本 ✓"
                : "检查更新"
          }
          hint={update ? undefined : "从 GitHub Releases 获取"}
          right={
            update ? (
              phase === "downloading" ? (
                <div className="flex items-center gap-2">
                  <ProgressBar value={progress} tactile className="w-24" />
                  <span className="text-label tabular-nums text-muted-foreground">
                    {progress}% · 完成后自动重启
                  </span>
                </div>
              ) : (
                <button
                  onClick={() => void onInstall()}
                  className="rounded-md bg-primary px-2.5 py-1 text-body font-medium text-primary-foreground hover:opacity-90"
                >
                  下载并安装
                </button>
              )
            ) : (
              <button
                onClick={() => void onCheck()}
                disabled={phase === "checking"}
                className="rounded-md border border-border px-2.5 py-1 text-body hover:bg-muted disabled:opacity-50"
              >
                {phase === "checking" ? "检查中…" : "检查更新"}
              </button>
            )
          }
        />
        {update?.body && (
          <div className="px-3 py-2.5">
            <p className="mb-1 text-label font-medium text-muted-foreground">
              本次更新内容
            </p>
            <p className="max-h-28 overflow-y-auto whitespace-pre-wrap text-body leading-relaxed">
              {update.body}
            </p>
          </div>
        )}
        <Row
          label="自动检查更新"
          hint="启动后静默检查；关闭后仅手动点击「检查更新」时查找"
          right={
            <Switch
              checked={settings.autoCheckUpdate}
              onCheckedChange={(v) => patch({ autoCheckUpdate: v })}
            />
          }
        />
        <Row
          label="自动安装更新"
          hint="发现新版后台静默下载替换，重启应用后生效（不打断使用）"
          right={
            <Switch
              checked={settings.autoInstallUpdate}
              onCheckedChange={(v) => patch({ autoInstallUpdate: v })}
            />
          }
        />
        <LinkRow label="更新日志" value="所有版本" url={`${REPO_URL}/releases`} />
      </Group>

      <Group title="链接">
        <LinkRow label="项目主页" value="GitHub" url={REPO_URL} />
        <LinkRow label="报告 Bug" value="提 Issue" url={`${REPO_URL}/issues/new`} />
      </Group>
    </div>
  );
}

const REPO_URL = "https://github.com/kristalderoyysi54/toskr";

/** 关于页链接行：整行可点，外链图标示意跳浏览器。 */
function LinkRow({ label, value, url }: { label: string; value: string; url: string }) {
  return (
    <button
      onClick={() => void api.openUrl(url)}
      className="flex w-full items-center px-3 py-2.5 text-left hover:bg-muted/50"
    >
      <span className="flex-1 text-title">{label}</span>
      <span className="text-body text-muted-foreground">{value} ↗</span>
    </button>
  );
}
