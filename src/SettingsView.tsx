import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { emitTo, listen } from "@tauri-apps/api/event";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  Activity,
  AlarmClock,
  Bot,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Blocks,
  Check,
  ClipboardList,
  Copy,
  Database,
  Eye,
  Info,
  Keyboard,
  KeyRound,
  Crosshair,
  Lock,
  Magnet,
  Pencil,
  Plus,
  Radio,
  Settings2,
  ShieldCheck,
  Star,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";

import { SimpleSelect } from "@/components/SimpleSelect";
import { AliasEntitySettings } from "@/components/settings/AliasEntitySettings";
import { TargetProfileManager } from "@/components/settings/TargetProfileManager";
import { OutcomeInsightsSection } from "@/components/settings/OutcomeInsightsSection";
import { useAppIdentity } from "@/components/settings/useAppIdentity";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { IconButton } from "@/components/ui/icon-button";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import {
  SETTINGS_CLEAR_CLIP,
  SETTINGS_DATA_HEALTH,
  SETTINGS_DATA_HEALTH_RESULT,
  SETTINGS_DATA_CONFLICT_ACTION,
  SETTINGS_DATA_OPERATION,
  SETTINGS_DATA_RECOVERY_OPERATION,
  SETTINGS_EXPORT,
  SETTINGS_IMPORT,
  SETTINGS_AI_KEY_CHANGED,
  SETTINGS_PATCH,
  SETTINGS_REQUEST,
  SETTINGS_SECTION,
  SETTINGS_STATE,
  type SettingsSectionPayload,
} from "@/lib/settingsSync";
import {
  DATA_ACTIVITY_EVENT,
  DATA_LOCATION_CHANGED_EVENT,
} from "@/lib/dataOperations";
import {
  availableDataActions,
  needsBlockingDataOverlay,
} from "@/lib/dataLocation";
import { SHORTCUTS } from "@/lib/shortcuts";
import {
  FIREWALL_CATEGORY_LABEL,
  FIREWALL_WARN_CATEGORIES,
} from "@/lib/delivery/firewall";
import {
  api,
  type AiKeyStatus,
  type DataLocationInspection,
  type DataLocationStatus,
  type DataOperationPlan,
  type MediaIntegrityReport,
  type MessageWatchStatus,
} from "@/lib/tauri";
import { buildMessageWatchBridgeScript } from "@/lib/messageWatch";
import { getImProfile, setImProfile, type ImProfile } from "@/lib/imProfile";
import type { ImCandidate } from "@/lib/tauri";

async function requestStorageRecoveryAction(
  action: "retryStorage" | "loadDefault"
): Promise<void> {
  if (action === "loadDefault") {
    const confirmed = await ask(
      "这会明确停用当前自定义目录并加载默认数据目录。原目录指针会保留为恢复副本，不会删除原数据。确认继续吗？",
      { title: "加载默认数据目录", kind: "warning" }
    );
    if (!confirmed) return;
  }
  await emitTo("main", SETTINGS_DATA_CONFLICT_ACTION, action);
}
import { tip } from "@/lib/tip";
import { checkForUpdate, downloadAndInstall } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/media";
import {
  CONTEXT_MENU_REGISTRY,
  HUD_DURATION_MAX_MS,
  HUD_DURATION_MIN_MS,
  DETAIL_FONT_SIZE_DEFAULT,
  DETAIL_FONT_SIZE_MAX,
  DETAIL_FONT_SIZE_MIN,
  groupContextMenuIds,
  defaultSettings,
  normalizeContextMenu,
  useNotesStore,
  type ContextMenuItemId,
  type DuePresetCfg,
  type ReminderOffsetDays,
  type MessageWatchRule,
  type PromptSnippet,
  type SecretKey,
  type Settings,
  type ThemePref,
  type VibrancyMaterial,
} from "@/store/notesStore";
import {
  GENERAL_PROMPT_GROUP_ID,
  deletePromptGroup,
} from "@/lib/targetProfiles";
import { onboardingStateFromPersisted } from "@/lib/onboarding";
import { presetCfgLabel } from "@/lib/tasks";
import { AI_PRESETS, matchPreset, testAiConnection } from "@/lib/ai";
import { subscribeAiKeyStatus } from "@/lib/aiKeyStatus";
import {
  useDataOperationStore,
  type DataActivity,
} from "@/store/dataOperationStore";

type SectionId =
  | "general"
  | "hotkey"
  | "clip"
  | "features"
  | "message-watch"
  | "secret"
  | "target"
  | "outcome"
  | "due"
  | "ai"
  | "companion"
  | "data"
  | "diagnostics"
  | "about";

/** 侧栏分章（用户指定 2026-08：菜单要有章法——按 面板/捕获/发送/助手/系统
 *  五章组织，小项合并进相邻章节，次要细节在分区内做渐进式披露）。 */
const SECTION_GROUPS: {
  title: string;
  items: { id: SectionId; label: string; icon: React.ReactNode }[];
}[] = [
  {
    title: "面板",
    items: [
      { id: "general", label: "通用", icon: <Settings2 className="size-4" /> },
      { id: "companion", label: "伴随停靠", icon: <Magnet className="size-4" /> },
      { id: "features", label: "功能开关", icon: <Blocks className="size-4" /> },
    ],
  },
  {
    title: "捕获",
    items: [
      { id: "hotkey", label: "捕获与快捷键", icon: <Keyboard className="size-4" /> },
      { id: "clip", label: "剪贴板", icon: <ClipboardList className="size-4" /> },
      { id: "message-watch", label: "消息监听", icon: <Radio className="size-4" /> },
      { id: "secret", label: "秘文", icon: <Lock className="size-4" /> },
    ],
  },
  {
    title: "发送",
    items: [
      { id: "target", label: "目标与发送方案", icon: <Crosshair className="size-4" /> },
      { id: "outcome", label: "使用概览", icon: <TrendingUp className="size-4" /> },
    ],
  },
  {
    title: "助手",
    items: [
      { id: "due", label: "到期提醒", icon: <AlarmClock className="size-4" /> },
      { id: "ai", label: "AI 智能", icon: <Bot className="size-4" /> },
    ],
  },
  {
    title: "系统",
    items: [
      { id: "data", label: "数据", icon: <Database className="size-4" /> },
      { id: "diagnostics", label: "诊断", icon: <Activity className="size-4" /> },
      { id: "about", label: "关于", icon: <Info className="size-4" /> },
    ],
  },
];

/** 独立设置窗口：主面板是唯一持久化写入方，这里只收 state / 发 patch。 */
function initialSettingsForView(): Settings {
  const settings = defaultSettings();
  if (!import.meta.env.DEV || typeof location === "undefined") {
    return settings;
  }
  const tutorial = new URLSearchParams(location.search).get("tutorial");
  if (!tutorial || !["2", "3", "4"].includes(tutorial)) return settings;
  // 浏览器静态验收没有 main WebView 回播状态；仅显式教程预览解除诊断桩的初始锁。
  useDataOperationStore.setState({ locked: false, phase: "idle", message: "" });
  const sent = tutorial === "3" || tutorial === "4";
  return {
    ...settings,
    onboarding: onboardingStateFromPersisted({
      ...settings.onboarding,
      permissionsCompletedAtMs: 1,
      captured: true,
      sent,
      done: sent,
      rehearsalStep: sent ? "complete" : "target",
      rehearsalActive: !sent,
      rehearsalNoteId: "browser-tutorial-preview",
      recoveryTutorialCompletedAtMs: tutorial === "4" ? 2 : null,
    }),
  };
}

export default function SettingsView() {
  const [settings, setSettings] = useState<Settings>(initialSettingsForView);
  const [section, setSection] = useState<SectionId>("general");
  // 功能域被关闭时其设置页从导航消失；若正停在该页则回退到功能开关页
  useEffect(() => {
    if (
      (section === "message-watch" && !settings.messagesEnabled) ||
      (section === "secret" && !settings.secretEnabled)
    ) {
      setSection("features");
    }
  }, [section, settings.messagesEnabled, settings.secretEnabled]);
  const [targetProfileRequest, setTargetProfileRequest] = useState<{
    profileId: string;
    sequence: number;
  } | null>(null);
  const dataActivity = useDataOperationStore();

  useEffect(() => {
    const un = listen<Settings>(SETTINGS_STATE, (e) => setSettings(e.payload));
    // 外部指路（更新提醒气泡点击等）→ 切到指定分区
    const unSection = listen<SettingsSectionPayload>(SETTINGS_SECTION, (e) => {
      const rawSection = typeof e.payload === "string"
        ? e.payload
        : e.payload.section;
      const requested = ["snippets", "prompts"].includes(rawSection)
        ? "target"
        : rawSection === "exclude"
          ? "hotkey"
          : rawSection;
      const targetProfileId = typeof e.payload === "string"
        ? null
        : e.payload.targetProfileId ?? null;
      if (targetProfileId) {
        setTargetProfileRequest((previous) => ({
          profileId: targetProfileId,
          sequence: (previous?.sequence ?? 0) + 1,
        }));
      }
      setSection(requested as SectionId);
    });
    const unDataActivity = listen<DataActivity>(
      DATA_ACTIVITY_EVENT,
      (event) => useDataOperationStore.getState().update(event.payload)
    );
    // 先完成三个监听器注册再请求快照，避免冷启动时错过唯一一次解锁回执。
    void Promise.all([un, unSection, unDataActivity])
      .then(() => emitTo("main", SETTINGS_REQUEST, {}))
      .catch(() => {});
    return () => {
      un.then((fn) => fn());
      unSection.then((fn) => fn());
      unDataActivity.then((fn) => fn());
    };
  }, []);

  const patch = (p: Partial<Settings>) => {
    if (dataActivity.locked) {
      tip("warn", "数据操作进行中，设置暂时只读");
      return;
    }
    setSettings((s) => ({ ...s, ...p }));
    void emitTo("main", SETTINGS_PATCH, p);
  };

  return (
    <div className="flex h-screen w-screen select-none bg-background text-foreground">
      {needsBlockingDataOverlay(dataActivity) && (
        <div
          role="status"
          aria-live="assertive"
          aria-busy="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 px-6 backdrop-blur-sm"
        >
          <div className="rounded-xl border border-border bg-popover px-4 py-3 text-center shadow-lg">
            <p className="text-title font-medium">数据暂时只读</p>
            <p className="mt-1 text-body text-muted-foreground">
              {dataActivity.message || "正在验证并切换数据目录…"}
            </p>
          </div>
        </div>
      )}
      {dataActivity.locked &&
        (dataActivity.phase === "conflict" ||
          dataActivity.phase === "storageRecovery") && (
        <div
          role="alert"
          className="fixed inset-x-4 top-4 z-50 rounded-xl border border-destructive/40 bg-popover p-3 shadow-lg"
        >
          <p className="text-title font-medium">
            {dataActivity.phase === "storageRecovery"
              ? "数据目录需要恢复"
              : "检测到外部数据版本"}
          </p>
          <p className="mt-1 text-body text-muted-foreground">
            {dataActivity.message || "自动写入已停止；请选择如何处理磁盘新版本。"}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {dataActivity.phase === "storageRecovery" ? (
              <>
                <button
                  onClick={() =>
                    void requestStorageRecoveryAction("retryStorage")
                  }
                  className="rounded-lg bg-primary px-3 py-1 text-body text-primary-foreground"
                >
                  重试挂载
                </button>
                <button
                  onClick={() =>
                    void requestStorageRecoveryAction("loadDefault")
                  }
                  className="rounded-lg border border-border px-3 py-1 text-body"
                >
                  明确加载默认目录
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() =>
                    void emitTo("main", SETTINGS_DATA_CONFLICT_ACTION, "reload")
                  }
                  className="rounded-lg bg-primary px-3 py-1 text-body text-primary-foreground"
                >
                  重新加载磁盘
                </button>
                <button
                  onClick={() =>
                    void emitTo(
                      "main",
                      SETTINGS_DATA_CONFLICT_ACTION,
                      "saveRecovery"
                    )
                  }
                  className="rounded-lg border border-border px-3 py-1 text-body"
                >
                  另存恢复副本后加载
                </button>
              </>
            )}
            <button
              onClick={() => tip("info", "已保持只读；冲突仍待处理")}
              className="rounded-lg border border-border px-3 py-1 text-body text-muted-foreground"
            >
              暂不处理
            </button>
          </div>
        </div>
      )}
      <aside className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border/60 bg-muted/40 p-2">
        {SECTION_GROUPS.map((group) => (
          <div key={group.title} className="mb-1 flex flex-col gap-0.5">
            <p className="px-2.5 pb-0.5 pt-1.5 text-micro font-medium tracking-wide text-muted-foreground">
              {group.title}
            </p>
            {group.items
              .filter(
                // 未开启的功能域不占导航；总开关集中在「功能开关」页
                (s) =>
                  (s.id !== "message-watch" || settings.messagesEnabled) &&
                  (s.id !== "secret" || settings.secretEnabled)
              )
              .map((s) => (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-body outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  section === s.id
                    ? "bg-primary/10 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
                )}
              >
                {s.icon}
                {s.label}
              </button>
              ))}
          </div>
        ))}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-5">
        {section === "general" && <GeneralSection settings={settings} patch={patch} />}
        {section === "hotkey" && (
          <>
            <HotkeySection settings={settings} patch={patch} />
            <ExcludeSection settings={settings} patch={patch} />
          </>
        )}
        {section === "clip" && <ClipboardSection settings={settings} patch={patch} />}
        {section === "features" && <FeaturesSection settings={settings} patch={patch} />}
        {section === "message-watch" && (
          <MessageWatchSection settings={settings} patch={patch} />
        )}
        {section === "secret" && <SecretSection settings={settings} patch={patch} />}
        {section === "target" && (
          <TargetSection
            settings={settings}
            patch={patch}
            targetProfileRequest={targetProfileRequest}
          />
        )}
        {section === "outcome" && <OutcomeInsightsSection settings={settings} patch={patch} />}
        {section === "companion" && <CompanionSection settings={settings} patch={patch} />}
        {section === "due" && (
          <>
            <DuePresetsSection settings={settings} patch={patch} />
            <BillReminderDefaultsSection settings={settings} patch={patch} />
          </>
        )}
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

/** 滑杆 + 数值 label；onCommit 仅在松手/键盘调整落定后触发。 */
function PercentSlider({
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel,
  format = (v) => `${v}%`,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  ariaLabel: string;
  format?: (v: number) => string;
  onCommit?: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label={ariaLabel}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number(e.currentTarget.value))}
        onKeyUp={(e) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
            onCommit?.(Number(e.currentTarget.value));
          }
        }}
        className="h-1 w-32 cursor-pointer accent-primary"
      />
      <span className="w-9 text-right text-label tabular-nums text-muted-foreground">
        {format(value)}
      </span>
    </div>
  );
}

/** 卡片右键菜单自定义：按用途分组，显隐与组内顺序可调。 */
function ContextMenuGroup({ settings, patch }: SP) {
  const cfg = normalizeContextMenu(settings.contextMenu);
  const cfgById = new Map(cfg.map((item) => [item.id, item]));
  const groups = groupContextMenuIds(cfg.map((item) => item.id));
  const labelOf = (id: string) =>
    CONTEXT_MENU_REGISTRY.find((i) => i.id === id)?.label ?? id;
  const move = (ids: readonly ContextMenuItemId[], idx: number, dir: -1 | 1) => {
    const swapId = ids[idx + dir];
    if (!swapId) return;
    const current = cfg.findIndex((item) => item.id === ids[idx]);
    const target = cfg.findIndex((item) => item.id === swapId);
    const next = [...cfg];
    [next[current], next[target]] = [next[target], next[current]];
    patch({ contextMenu: next });
  };
  return (
    <Group title="卡片右键菜单（勾选显示 · 组内调序；合并、回复关系与删除固定）">
      {groups.map((group, groupIndex) => (
        <div key={group.id}>
          <div
            className={cn(
              "border-t border-border/60 bg-muted/25 px-3.5 py-1 text-micro font-medium text-muted-foreground",
              groupIndex === 0 && "border-t-0"
            )}
          >
            {group.label}
          </div>
          {group.ids.map((id, idx) => {
            const item = cfgById.get(id)!;
            return (
              <div key={item.id} className="group flex items-center gap-3 px-3.5 py-2">
                <Switch
                  aria-label={`${labelOf(item.id)}：显示`}
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
                    !item.on && "text-muted-foreground"
                  )}
                >
                  {labelOf(item.id)}
                </span>
                <div className="flex gap-0.5">
                  <IconButton
                    label="组内上移"
                    size="2xs"
                    reveal="hover-focus"
                    disabled={idx === 0}
                    onClick={() => move(group.ids, idx, -1)}
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    label="组内下移"
                    size="2xs"
                    reveal="hover-focus"
                    disabled={idx === group.ids.length - 1}
                    onClick={() => move(group.ids, idx, 1)}
                  >
                    <ArrowDown />
                  </IconButton>
                </div>
              </div>
            );
          })}
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
      <Group title="上手">
        <Row
          label="新手导览"
          hint="重新播放首次启动的功能介绍轮播"
          right={
            <Button
              size="xs"
              onClick={() => {
                patch({ welcomeTourSeen: false });
                void api.showPanel();
                tip("ok", "导览已就绪，回到主面板查看");
              }}
            >
              重看导览
            </Button>
          }
        />
      </Group>
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
              ariaLabel="窗口整体不透明度"
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
              ariaLabel="内容底色浓度"
              value={Math.round(settings.panelOpacity * 100)}
              min={25}
              max={100}
              step={1}
              onChange={(v) => patch({ panelOpacity: v / 100 })}
            />
          }
        />
        <Row
          label="毛玻璃背景"
          hint="macOS 原生 vibrancy 模糊效果"
          right={
            <Switch
              aria-label="毛玻璃背景"
              checked={settings.vibrancy}
              onCheckedChange={(v) => patch({ vibrancy: v })}
            />
          }
        />
        {settings.vibrancy && (
          <Row
            label="毛玻璃风格"
            hint="从最通透到最厚重；配合下方不透明度调整感受最直观"
            right={
              <Segmented<VibrancyMaterial>
                // 原生材质有 5 种枚举，但叠上面板内容膜层后视觉差异极小，
                // 五选一等于盲选（用户实测否决）。压缩为 3 档可感知风格：
                // 通透=hud（最亮最透）、柔和=sidebar（居中）、厚重=
                // under-window（最实）。旧持久化值就近映射高亮，选择即写规范值
                value={
                  settings.vibrancyMaterial === "popover"
                    ? "sidebar"
                    : settings.vibrancyMaterial === "fullscreen"
                      ? "hud"
                      : settings.vibrancyMaterial
                }
                options={[
                  { value: "hud", label: "通透" },
                  { value: "sidebar", label: "柔和" },
                  { value: "under-window", label: "厚重" },
                ]}
                onChange={(v) => patch({ vibrancyMaterial: v })}
                ariaLabel="毛玻璃风格"
              />
            }
          />
        )}
        <Row
          label="卡片彩色通栏"
          hint="笔记卡顶栏底色：分组色优先、无分组色用来源应用主色；关闭统一中性灰"
          right={
            <Switch
              aria-label="卡片彩色通栏"
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
        {settings.cardDensity === "comfortable" && (
          <Row
            label="剪贴卡模板"
            hint="只影响剪贴页：标准显示完整票据；浓缩保留票据头＋单行摘要"
            right={
              <Segmented<Settings["clipCardTemplate"]>
                value={settings.clipCardTemplate}
                options={[
                  { value: "standard", label: "标准" },
                  { value: "condensed", label: "浓缩" },
                ]}
                onChange={(v) => patch({ clipCardTemplate: v })}
                ariaLabel="剪贴卡模板"
              />
            }
          />
        )}
        <Row
          label="卡片底色不透明度"
          hint="调低可透出毛玻璃背景；100% 为实色卡片"
          right={
            <PercentSlider
              ariaLabel="卡片底色不透明度"
              value={Math.round(settings.cardOpacity * 100)}
              min={30}
              max={100}
              step={5}
              onChange={(v) => patch({ cardOpacity: v / 100 })}
            />
          }
        />
        <Row
          label="详情窗字号"
          hint="文本详情窗正文字号；窗内 ⌘+ / ⌘− 同步调整，⌘0 复位"
          right={
            <PercentSlider
              ariaLabel="详情窗字号"
              value={settings.detailFontSize ?? DETAIL_FONT_SIZE_DEFAULT}
              min={DETAIL_FONT_SIZE_MIN}
              max={DETAIL_FONT_SIZE_MAX}
              step={1}
              format={(v) => `${v}px`}
              onChange={(v) => patch({ detailFontSize: v })}
            />
          }
        />
      </Group>
      <Group title="系统">
        <Row
          label="开机启动"
          hint="登录后自动在后台待命"
          right={
            <Switch
              aria-label="开机启动"
              checked={autostart}
              onCheckedChange={toggleAutostart}
            />
          }
        />
      </Group>
      <Group title="行为">
        <Row
          label="面板置顶"
          hint="显示在屏幕最上层；关闭后可被其他窗口盖住"
          right={
            <Switch
              aria-label="面板置顶"
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
              aria-label="失焦自动隐藏"
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
              aria-label="隐身模式"
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
              aria-label="音效"
              checked={settings.soundEnabled}
              onCheckedChange={(v) => patch({ soundEnabled: v })}
            />
          }
        />
        <Row
          label="提示显示时长"
          hint="适用于所有自动关闭的提示气泡；悬停时暂停倒计时"
          right={
            <PercentSlider
              ariaLabel="提示显示时长"
              value={settings.hudDurationMs / 1_000}
              min={HUD_DURATION_MIN_MS / 1_000}
              max={HUD_DURATION_MAX_MS / 1_000}
              step={1}
              onChange={(seconds) => patch({ hudDurationMs: seconds * 1_000 })}
              onCommit={(seconds) => {
                void api
                  .setHudDuration(seconds * 1_000)
                  .then(() => tip("info", `提示会显示 ${seconds} 秒`))
                  .catch(() => {});
              }}
              format={(seconds) => `${seconds} 秒`}
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
        aria-label="剪贴板历史保留时长"
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
      <div className="flex justify-between text-micro text-muted-foreground">
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
              aria-label="剪贴板历史"
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
        {settings.clipHistory && (
          <Row
            label="连续复制两次自动置顶"
            hint="10 秒内再次复制同一内容，视为想留住它：自动固定 ★，气泡可撤销"
            right={
              <Switch
                aria-label="连续复制两次自动置顶"
                checked={settings.clipDoubleCopyKeep}
                onCheckedChange={(v) => patch({ clipDoubleCopyKeep: v })}
              />
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
      <Disclosure title="收集规则与忽略应用">
      <Group title="规则">
        <Row
          label="忽略机密内容"
          hint="检测到密码管理器的机密标记时不保存"
          right={
            <Switch
              aria-label="忽略机密内容"
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
              aria-label="忽略瞬时内容"
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
      </Disclosure>
    </div>
  );
}

const SECRET_FIELD =
  "h-8 w-full rounded-lg border border-border bg-transparent px-2 text-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-primary/50";

const REVEAL_TIMEOUT_OPTIONS = [
  { value: "5000", label: "5 秒" },
  { value: "8000", label: "8 秒" },
  { value: "15000", label: "15 秒" },
  { value: "0", label: "常驻" },
];

const SECRET_FORM_FIELD = `mt-1 ${SECRET_FIELD}`;

/**
 * 共享密钥管理：列表态一行一条（名称为主，备注/时间为次，操作悬浮显现），
 * 新增/编辑走展开式表单（与化名词典同款交互）。passphrase 创建后不可再编辑——
 * 改暗号等于换锁，历史秘文将永久不可解；要换请新增一把。
 */
function SecretKeysEditor({ settings, patch }: SP) {
  const keys = settings.secretKeys;
  const [formOpen, setFormOpen] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftPass, setDraftPass] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [formIssue, setFormIssue] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editPass, setEditPass] = useState("");
  const [revealedId, setRevealedId] = useState<string | null>(null);

  const closeForm = () => {
    setFormOpen(false);
    setDraftLabel("");
    setDraftPass("");
    setDraftNote("");
    setFormIssue(null);
  };

  const saveNew = () => {
    const label = draftLabel.trim();
    const passphrase = draftPass.trim();
    if (!label) {
      setFormIssue("先给密钥起个名字（给谁 / 场景）");
      return;
    }
    if (!passphrase) {
      setFormIssue("共享密钥不能为空");
      return;
    }
    const now = Date.now();
    const k: SecretKey = {
      id: crypto.randomUUID(),
      label,
      passphrase,
      note: draftNote.trim() || undefined,
      createdAtMs: now,
      updatedAtMs: now,
    };
    patch({
      secretKeys: [...keys, k],
      secretDefaultKeyId: settings.secretDefaultKeyId ?? k.id,
    });
    closeForm();
  };

  const startEdit = (k: SecretKey) => {
    setEditingId(k.id);
    setEditLabel(k.label);
    setEditNote(k.note ?? "");
    setEditPass("");
    setRevealedId(null);
  };

  const saveEdit = (k: SecretKey) => {
    const label = editLabel.trim();
    if (!label) return;
    const p: Partial<SecretKey> = { label, note: editNote.trim() || undefined };
    // 仅历史遗留的空钥允许补设一次；已有 passphrase 恒不可改
    if (!k.passphrase && editPass.trim()) p.passphrase = editPass.trim();
    patch({
      secretKeys: keys.map((item) =>
        item.id === k.id ? { ...item, ...p, updatedAtMs: Date.now() } : item
      ),
    });
    setEditingId(null);
  };

  const removeKey = async (key: SecretKey) => {
    const dependents = useNotesStore
      .getState()
      .notes.filter(
        (n) => n.kind === "secret" && n.secretMeta?.keyId === key.id
      ).length;
    const confirmed = await ask(
      dependents > 0
        ? `有 ${dependents} 条秘文用「${key.label || "未命名"}」加解密，删除后这些卡片将变为锁定态（用相同密钥文本重新添加可救回）。确定删除？`
        : `确定删除密钥「${key.label || "未命名"}」？`,
      { title: "删除秘文密钥", kind: "warning" }
    );
    if (!confirmed) return;
    const next = keys.filter((k) => k.id !== key.id);
    patch({
      secretKeys: next,
      secretDefaultKeyId:
        settings.secretDefaultKeyId === key.id
          ? next[0]?.id ?? null
          : settings.secretDefaultKeyId,
    });
  };

  return (
    <Group title="共享密钥">
      <div className="px-3.5 py-2.5">
        <p className="text-label text-muted-foreground">
          每位聊天对象一把；密钥文本双方须一字不差。加密发送默认用 ★ 密钥，收到密文时自动逐把匹配
        </p>

        {keys.length === 0 ? (
          <p className="mt-2 text-body text-muted-foreground">
            还没有密钥。点「添加密钥」，与对方约定同一句暗号即可开始收发。
          </p>
        ) : (
          <ul className="mt-2 space-y-1" aria-label="共享密钥列表">
            {keys.map((k) => {
              const isDefault = settings.secretDefaultKeyId === k.id;
              const revealed = revealedId === k.id;
              const editing = editingId === k.id;
              return (
                <li key={k.id} className="rounded-lg bg-muted/40 px-2 py-1.5">
                  {editing ? (
                    <div className="space-y-2 py-1">
                      <label className="block text-label text-muted-foreground">
                        名称（给谁 / 场景）
                        <input
                          aria-label="密钥名称"
                          value={editLabel}
                          maxLength={24}
                          autoFocus
                          onChange={(e) => setEditLabel(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit(k);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className={SECRET_FORM_FIELD}
                        />
                      </label>
                      <label className="block text-label text-muted-foreground">
                        备注（可选，何时 / 因何约定）
                        <input
                          aria-label="密钥备注"
                          value={editNote}
                          maxLength={120}
                          onChange={(e) => setEditNote(e.target.value)}
                          className={SECRET_FORM_FIELD}
                        />
                      </label>
                      {!k.passphrase && (
                        <label className="block text-label text-warning">
                          补设共享密钥（这把还没设置；保存后不可再改）
                          <input
                            aria-label="补设共享密钥"
                            value={editPass}
                            maxLength={120}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="中文 / 字符皆可，双方须完全一致"
                            onChange={(e) => setEditPass(e.target.value)}
                            className={SECRET_FORM_FIELD}
                          />
                        </label>
                      )}
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setEditingId(null)}
                          className="rounded-lg px-2.5 py-1 text-label text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          取消
                        </button>
                        <button
                          onClick={() => saveEdit(k)}
                          className="rounded-lg bg-paper px-3 py-1 text-label font-medium text-paper-foreground outline-none hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          完成
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="group flex items-center gap-2">
                      <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                      <span
                        className="min-w-0 shrink-0 truncate text-body font-medium"
                        title={k.label}
                      >
                        {k.label || "未命名"}
                      </span>
                      {isDefault && (
                        <span className="shrink-0 rounded-sm bg-primary/10 px-1 py-0.5 text-micro text-primary">
                          默认
                        </span>
                      )}
                      {!k.passphrase && (
                        <span className="shrink-0 rounded-sm bg-warning/10 px-1 py-0.5 text-micro text-warning">
                          未设密钥
                        </span>
                      )}
                      <span
                        className="min-w-0 flex-1 truncate text-label text-muted-foreground"
                        title={k.note}
                      >
                        {k.note ?? ""}
                      </span>
                      <span className="shrink-0 text-micro text-muted-foreground">
                        {timeAgo(k.createdAtMs)}
                      </span>
                      <IconButton
                        label={isDefault ? "默认密钥" : "设为默认（加密发送预选）"}
                        size="xs"
                        pressed={isDefault}
                        reveal={isDefault ? "always" : "hover-focus"}
                        onClick={() => patch({ secretDefaultKeyId: k.id })}
                      >
                        <Star className="size-3" />
                      </IconButton>
                      <IconButton
                        label={revealed ? "隐藏密钥" : "显示密钥（与对方核对）"}
                        size="xs"
                        pressed={revealed}
                        reveal="hover-focus"
                        onClick={() => setRevealedId(revealed ? null : k.id)}
                      >
                        <Eye className="size-3" />
                      </IconButton>
                      <IconButton
                        label="编辑名称与备注"
                        size="xs"
                        reveal="hover-focus"
                        onClick={() => startEdit(k)}
                      >
                        <Pencil className="size-3" />
                      </IconButton>
                      <IconButton
                        label="删除密钥"
                        size="xs"
                        tone="danger"
                        reveal="hover-focus"
                        onClick={() => void removeKey(k)}
                      >
                        <Trash2 className="size-3" />
                      </IconButton>
                    </div>
                  )}
                  {revealed && !editing && (
                    <p className="mt-1 flex items-center gap-1.5 rounded-md bg-background/70 px-2 py-1">
                      <span className="shrink-0 text-micro text-muted-foreground">
                        密钥
                      </span>
                      <code className="min-w-0 flex-1 truncate text-body">
                        {k.passphrase || "（未设置）"}
                      </code>
                      <span className="shrink-0 text-micro text-muted-foreground">
                        创建后不可改
                      </span>
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {formOpen ? (
          <div className="mt-2 rounded-lg border border-border/60 p-2.5">
            <label className="block text-label text-muted-foreground">
              名称（给谁 / 场景）
              <input
                aria-label="新密钥名称"
                value={draftLabel}
                maxLength={24}
                autoFocus
                placeholder="如「家人」「和小李」「测试群」"
                onChange={(e) => {
                  setDraftLabel(e.target.value);
                  setFormIssue(null);
                }}
                className={SECRET_FORM_FIELD}
              />
            </label>
            <label className="mt-2 block text-label text-muted-foreground">
              共享密钥（中文 / 字符皆可）
              <input
                aria-label="新共享密钥"
                value={draftPass}
                maxLength={120}
                autoComplete="off"
                spellCheck={false}
                placeholder="双方须一字不差；首尾空格自动去除"
                onChange={(e) => {
                  setDraftPass(e.target.value);
                  setFormIssue(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveNew();
                }}
                className={SECRET_FORM_FIELD}
              />
            </label>
            <p className="mt-1 text-micro text-muted-foreground">
              保存后不可修改（改钥 = 换锁，历史秘文会解不开）；当面或经可信渠道告诉对方同一句话
            </p>
            <label className="mt-2 block text-label text-muted-foreground">
              备注（可选）
              <input
                aria-label="新密钥备注"
                value={draftNote}
                maxLength={120}
                placeholder="何时 / 因何约定，帮将来的自己想起来"
                onChange={(e) => setDraftNote(e.target.value)}
                className={SECRET_FORM_FIELD}
              />
            </label>
            {formIssue && (
              <p role="alert" className="mt-1.5 text-label text-warning">
                {formIssue}
              </p>
            )}
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={closeForm}
                className="rounded-lg px-2.5 py-1 text-label text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                取消
              </button>
              <button
                onClick={saveNew}
                className="rounded-lg bg-paper px-3 py-1 text-label font-medium text-paper-foreground outline-none hover:brightness-105 focus-visible:ring-2 focus-visible:ring-ring"
              >
                保存密钥
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setFormOpen(true)}
            className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-label text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            <Plus className="size-3.5" /> 添加密钥
          </button>
        )}
      </div>
    </Group>
  );
}

/** 功能开关（用户 2026-08-19 指定集中）：三个默认关闭的功能域统一在此启停，
 *  开启后对应设置页才出现在左侧导航。 */
function FeaturesSection({ settings, patch }: SP) {
  const FEATURES: {
    key: "messagesEnabled" | "secretEnabled" | "subscriptionsEnabled";
    label: string;
    experimental?: boolean;
    hint: string;
    where: string;
  }[] = [
    {
      key: "messagesEnabled",
      label: "消息监听",
      experimental: true,
      hint: "只读监听 IM 群消息（@我/特别关注/组合规则），在「内容 → 消息」里处理、转任务、AI 草稿",
      where: "开启后在左侧「捕获 → 消息监听」配置接入与规则",
    },
    {
      key: "secretEnabled",
      label: "秘文",
      hint: "把文字加密成中文句式发进 IM，对方双击 ⇧ 捕获自动解密",
      where: "开启后在左侧「捕获 → 秘文」管理密钥",
    },
    {
      key: "subscriptionsEnabled",
      label: "订阅",
      hint: "账单/信用卡到期管理与提醒，「提醒」页出现订阅子页",
      where: "开启后在左侧「助手 → 到期提醒」调整账单偏好",
    },
  ];
  return (
    <div>
      <SectionTitle>功能开关</SectionTitle>
      <p className="mb-3 text-body text-muted-foreground">
        以下功能默认关闭，保持初始界面精简；开启后主面板出现对应入口，左侧导航出现其设置页。
      </p>
      <Group>
        {FEATURES.map((feature) => (
          <Row
            key={feature.key}
            label={feature.label + (feature.experimental ? "（实验）" : "")}
            hint={settings[feature.key] ? feature.where : feature.hint}
            right={
              <Switch
                aria-label={`启用${feature.label}`}
                checked={settings[feature.key]}
                onCheckedChange={(enabled) => patch({ [feature.key]: enabled })}
              />
            }
          />
        ))}
      </Group>
    </div>
  );
}

/** 组合规则的人话描述：规则列表与新建预览共用同一句式，避免用户自行推演 AND/OR 逻辑。 */
function ruleSummaryText(
  groupTerms: string[],
  senderTerms: string[],
  keywords: string[]
): string {
  const quote = (terms: string[]) => `「${terms.join("」或「")}」`;
  return [
    groupTerms.length ? `群名/群号含${quote(groupTerms)}` : "",
    senderTerms.length ? `发送者是${quote(senderTerms)}` : "",
    keywords.length ? `内容含${quote(keywords)}` : "",
  ]
    .filter(Boolean)
    .join("，且");
}

/** IM 软件实验监听：会话级开关，重启自动关闭；完整原始消息由 Rust 先落账本。 */
function MessageWatchSection({ settings, patch }: SP) {
  const [status, setStatus] = useState<MessageWatchStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  // 监听目标由用户「探测并确认」后写入本机 profile；代码不预置任何具体应用。
  const [profile, setProfileState] = useState<ImProfile | null>(() => getImProfile());
  const [candidates, setCandidates] = useState<ImCandidate[] | null>(null);
  const [detecting, setDetecting] = useState(false);

  const detectTargets = async () => {
    setDetecting(true);
    try {
      const list = await api.detectRunningImCandidates();
      setCandidates(list);
      if (!list.length) {
        tip("warn", "未检测到正在运行的应用；请先打开要监听的 IM 再试");
      }
    } catch (error) {
      tip("warn", `探测失败：${String(error).slice(0, 100)}`);
    } finally {
      setDetecting(false);
    }
  };

  const confirmTarget = (candidate: ImCandidate) => {
    const chosen: ImProfile = {
      appName: candidate.name,
      bundleId: candidate.bundleId,
      binPath: candidate.binPath,
    };
    setImProfile(chosen);
    setProfileState(chosen);
    setCandidates(null);
    tip("ok", `已选择监听目标：${candidate.name}`);
  };

  const clearTarget = () => {
    setImProfile(null);
    setProfileState(null);
    setCandidates(null);
    tip("info", "已清除监听目标");
  };
  const [ruleName, setRuleName] = useState("");
  const [groupTerms, setGroupTerms] = useState("");
  const [senderTerms, setSenderTerms] = useState("");
  const [keywords, setKeywords] = useState("");

  const splitTerms = (value: string) =>
    [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))];

  const addRule = () => {
    const rule: MessageWatchRule = {
      id: crypto.randomUUID(),
      name: ruleName.trim() || `关注规则 ${settings.messageWatchRules.length + 1}`,
      enabled: true,
      groupTerms: splitTerms(groupTerms),
      senderTerms: splitTerms(senderTerms),
      keywords: splitTerms(keywords),
    };
    if (!rule.groupTerms.length && !rule.senderTerms.length && !rule.keywords.length) {
      tip("warn", "至少填写群、发送者或关键词中的一项");
      return;
    }
    patch({ messageWatchRules: [...settings.messageWatchRules, rule] });
    setRuleName("");
    setGroupTerms("");
    setSenderTerms("");
    setKeywords("");
    setFormOpen(false);
    tip("ok", status?.enabled ? "规则已保存；下次重开监听后生效" : "组合关注规则已保存");
  };

  const reload = () => {
    void api.getMessageWatchStatus().then(setStatus).catch(() => setStatus(null));
  };

  useEffect(() => {
    reload();
    const timer = window.setInterval(reload, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const transport = status?.enabled ? status.transport : null;

  // 自动接入（CDP）：前端生成 transport=cdp 脚本（含本次会话 STARTED_AT），交 Rust 注入；
  // 重连复用同一脚本以复用同一起点门槛。
  const toggleAuto = async (enabled: boolean) => {
    if (busy) return;
    if (enabled && !profile) {
      void detectTargets();
      return;
    }
    setBusy(true);
    try {
      const next = enabled
        ? await api.setMessageWatchAuto(
            true,
            buildMessageWatchBridgeScript(
              { endpoint: "cdp", sessionStartedAtMs: Date.now() },
              "cdp",
              settings.messageWatchRules
            ),
            profile ?? undefined
          )
        : await api.setMessageWatchAuto(false);
      setStatus(next);
      tip(
        enabled ? "ok" : "info",
        enabled
          ? "正在以调试模式重启 IM 软件并自动注入…约 10 秒内完成"
          : "已关闭自动接入，正在恢复 IM 软件正常启动"
      );
    } catch (error) {
      tip("warn", `切换失败：${String(error).slice(0, 100)}`);
      reload();
    } finally {
      setBusy(false);
    }
  };

  // 手动模式（HTTP fallback）：开本地接收端，用户手动复制脚本粘贴。
  const toggleManual = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await api.setMessageWatch(enabled);
      setStatus(next);
      tip(
        enabled ? "ok" : "info",
        enabled
          ? "本地接收端已开启；请复制并手动粘贴脚本"
          : "手动监听已关闭"
      );
    } catch (error) {
      tip("warn", `切换失败：${String(error).slice(0, 100)}`);
      reload();
    } finally {
      setBusy(false);
    }
  };

  const copyBridge = async () => {
    try {
      const info = await api.getMessageWatchBridgeInfo();
      await api.copyText(
        buildMessageWatchBridgeScript(info, "http", settings.messageWatchRules)
      );
      tip("ok", "只读桥脚本已复制；请在 IM 软件 DevTools 的 Console 里手动粘贴执行");
    } catch (error) {
      tip("warn", `复制失败：${String(error).slice(0, 100)}`);
    }
  };

  const copyLedgerPath = async () => {
    if (!status?.ledgerPath) return;
    await api.copyText(status.ledgerPath);
    tip("ok", "原始消息账本路径已复制");
  };

  const connected = Boolean(status?.enabled && status.rendererConnected);
  const stateText = !status?.enabled
    ? "未开启"
    : transport === "cdp"
      ? connected
        ? "已自动接入"
        : "正在接入…"
      : connected
        ? "手动桥已连接"
        : "等待粘贴脚本";
  const formPreview = ruleSummaryText(
    splitTerms(groupTerms),
    splitTerms(senderTerms),
    splitTerms(keywords)
  );

  return (
    <div>
      <SectionTitle>消息监听</SectionTitle>
      <p className="mb-3 text-body text-muted-foreground">
        实验性监听 IM 软件的群消息。Toskr 的只读桥不主动打开会话，也不调用已读或发送接口。
      </p>

      <Group title="监听目标">
        {profile ? (
          <Row
            label={`当前目标：${profile.appName}`}
            hint={profile.bundleId}
            right={
              <Button size="xs" onClick={clearTarget}>
                更换
              </Button>
            }
          />
        ) : (
          <div className="px-3.5 py-3">
            <p className="text-title font-medium">先选择要监听的 IM</p>
            <p className="mt-0.5 text-label leading-normal text-muted-foreground">
              点下方按钮探测当前正在运行的应用，选中你要监听的那个即可——Toskr 不预置任何应用。
            </p>
            <Button
              size="xs"
              className="mt-2"
              disabled={detecting}
              onClick={() => void detectTargets()}
            >
              {detecting ? "探测中…" : "探测正在运行的应用"}
            </Button>
            {candidates && candidates.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {candidates.map((candidate) => (
                  <button
                    key={candidate.bundleId}
                    type="button"
                    onClick={() => confirmTarget(candidate)}
                    className="flex flex-col items-start rounded-md border border-border px-2.5 py-1.5 text-left hover:bg-accent"
                  >
                    <span className="text-label font-medium">{candidate.name}</span>
                    <span className="text-micro text-muted-foreground">
                      {candidate.bundleId}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Group>
      {profile && (
      <Group title="接入方式（二选一）">
        <Row
          label="自动接入（推荐）"
          hint={
            transport === "http"
              ? "手动模式运行中；先关闭手动监听再切换"
              : "以调试模式重启 IM 软件并自动注入只读桥，免手动操作；开关时各重启一次（约 10 秒），登录状态通常保留"
          }
          right={
            <Switch
              aria-label="IM 软件自动监听"
              checked={transport === "cdp"}
              disabled={busy || status === null || transport === "http"}
              onCheckedChange={(enabled) => void toggleAuto(enabled)}
            />
          }
        />
        {transport !== "http" && (
          <p className="px-3.5 py-2 text-label text-warning">
            ⚠️ 自动接入期间 IM 软件会开一个仅限本机、无需认证的调试端口，本机其他程序理论上可借此读取会话内容；关闭后立即恢复。
          </p>
        )}
        <Row
          label="手动模式（备选）"
          hint={
            transport === "cdp"
              ? "自动接入运行中；先关闭自动接入再切换"
              : "不重启 IM 软件；开启后复制脚本，在 IM 软件「查看 → 开发者工具」的 Console 里粘贴执行"
          }
          right={
            <Switch
              aria-label="IM 软件手动监听"
              checked={transport === "http"}
              disabled={busy || status === null || transport === "cdp"}
              onCheckedChange={(enabled) => void toggleManual(enabled)}
            />
          }
        />
        {transport === "http" && (
          <Row
            label="安装 DevTools 只读桥"
            hint="IM 软件刷新或重启后需重新复制执行；手动打开 DevTools 会激活窗口、当前会话可能被标记已读"
            right={
              <Button size="xs" onClick={() => void copyBridge()}>
                <Copy data-icon="inline-start" />复制脚本
              </Button>
            }
          />
        )}
        <div className="flex items-start gap-2 px-3.5 py-2.5">
          <span
            aria-hidden
            className={cn(
              "mt-[5px] size-1.5 shrink-0 rounded-full", // token-exception: 状态点对齐 text-label 首行的光学微调
              !status?.enabled
                ? "bg-muted-foreground/40"
                : connected
                  ? "bg-success"
                  : "bg-warning"
            )}
          />
          <div className="min-w-0 flex-1 space-y-0.5 text-label text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">{stateText}</span>
              {status?.enabled ? ` · 已完整落盘 ${status.acceptedCount} 条` : ""}
            </p>
            {status?.lastAcceptedAtMs && (
              <p>
                最近捕获：
                {new Date(status.lastAcceptedAtMs).toLocaleString("zh-CN", { hour12: false })}
              </p>
            )}
            {status?.lastError && <p className="text-warning">最近错误：{status.lastError}</p>}
          </div>
        </div>
      </Group>
      )}

      <Group title="收哪些消息">
        <div className="space-y-2 px-3.5 py-3">
          <p className="text-label text-muted-foreground">
            被 @ 和特别关注的消息<span className="font-medium text-foreground">始终</span>会收进「内容 → 消息」，无需配置。
            组合规则用于在此之外盯住特定的群、人、关键词；多条规则任一命中即收。
          </p>
          {settings.messageWatchRules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-start gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2"
            >
              <Switch
                aria-label={`${rule.name}启用状态`}
                checked={rule.enabled}
                onCheckedChange={(enabled) =>
                  patch({
                    messageWatchRules: settings.messageWatchRules.map((item) =>
                      item.id === rule.id ? { ...item, enabled } : item
                    ),
                  })
                }
              />
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium">{rule.name}</p>
                <p className="mt-0.5 break-words text-label text-muted-foreground">
                  收下{" "}
                  {ruleSummaryText(rule.groupTerms, rule.senderTerms, rule.keywords)}{" "}
                  的消息
                </p>
              </div>
              <IconButton
                label={`删除${rule.name}`}
                size="xs"
                tone="danger"
                onClick={() =>
                  patch({
                    messageWatchRules: settings.messageWatchRules.filter(
                      (item) => item.id !== rule.id
                    ),
                  })
                }
              >
                <Trash2 />
              </IconButton>
            </div>
          ))}
          {formOpen ? (
            <div className="space-y-2 rounded-lg border border-border/70 bg-background/60 p-2.5">
              <input
                value={ruleName}
                onChange={(event) => setRuleName(event.target.value)}
                placeholder="规则名称（可选）"
                className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-body outline-none focus:border-primary/60"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={groupTerms}
                  onChange={(event) => setGroupTerms(event.target.value)}
                  placeholder="群名或群号，逗号分隔"
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-body outline-none focus:border-primary/60"
                />
                <input
                  value={senderTerms}
                  onChange={(event) => setSenderTerms(event.target.value)}
                  placeholder="发送者或 UID，逗号分隔"
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-body outline-none focus:border-primary/60"
                />
                <input
                  value={keywords}
                  onChange={(event) => setKeywords(event.target.value)}
                  placeholder="关键词，逗号分隔"
                  className="col-span-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-body outline-none focus:border-primary/60"
                />
              </div>
              <p className="text-label leading-normal text-muted-foreground">
                {formPreview ? (
                  <>
                    将收下 <span className="text-foreground">{formPreview}</span> 的消息
                  </>
                ) : (
                  "至少填一栏。同一栏内多个值任一匹配即可；填了多栏则需同时满足。"
                )}
              </p>
              <div className="flex items-center gap-1.5">
                <Button size="xs" onClick={addRule}>
                  保存规则
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setFormOpen(false)}>
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <Button size="xs" onClick={() => setFormOpen(true)}>
              <Plus data-icon="inline-start" />添加规则
            </Button>
          )}
          {status?.enabled && (
            <p className="text-label text-warning">
              监听运行中；为避免无提示重启 IM 软件，规则改动将在下次重开监听时生效。
            </p>
          )}
        </div>
      </Group>

      <Group title="数据存储">
        <div className="space-y-1.5 px-3.5 py-2.5 text-label text-muted-foreground">
          <p>
            原始消息整条写入权限 600 的 JSONL 账本（正文不截断；单条超 4MB 整条拒收并留队重试），「内容 → 消息」展示其结构化投影。
          </p>
          <p>实验账本不随 .toskr-backup 导出；需长期保留请单独备份账本文件。</p>
          {status?.ledgerPath && (
            <Button
              size="xs"
              onClick={() => void copyLedgerPath()}
              title={status.ledgerPath}
            >
              <Copy data-icon="inline-start" />复制账本路径
            </Button>
          )}
        </div>
      </Group>
    </div>
  );
}

/** 秘文（中文加密通信）：共享密钥管理 + 揭示超时。
 *  总开关集中在「功能开关」页；本页仅开启后可达。 */
function SecretSection({ settings, patch }: SP) {
  return (
    <div>
      <SectionTitle>秘文</SectionTitle>
      <Group>
        <Row
          label="揭示后自动遮罩"
          hint="卡片解密显现后，多久自动回到模糊（切走应用/隐藏面板也会立即遮罩）"
          right={
            <Segmented
              ariaLabel="揭示超时"
              value={String(settings.secretRevealTimeoutMs)}
              options={REVEAL_TIMEOUT_OPTIONS}
              onChange={(v) => patch({ secretRevealTimeoutMs: Number(v) })}
            />
          }
        />
      </Group>
      <SecretKeysEditor settings={settings} patch={patch} />
      <p className="flex items-start gap-1.5 px-1 text-label text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        <span>
          密钥以明文保存在本机数据目录并随备份进出——用于防 IM 服务器、旁人与肩窥，
          不防本机取证。加解密全程在本机完成，不联网。
        </span>
      </p>
    </div>
  );
}

function HotkeySection({ settings, patch }: SP) {
  return (
    <div>
      <SectionTitle>捕获与快捷键</SectionTitle>
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

/** 列表行：应用图标 + 显示名（未安装/解析失败回退 bundle id）。 */
function AppListRow({
  bundle,
  onRemove,
}: {
  bundle: string;
  onRemove: () => void;
}) {
  const info = useAppIdentity(bundle);
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
  getCurrentBundle,
}: {
  apps: string[];
  onChange: (apps: string[]) => void;
  addLabel: string;
  getCurrentBundle?: () => Promise<string | null>;
}) {
  const addCurrent = async () => {
    try {
      const bundleId = getCurrentBundle
        ? await getCurrentBundle()
        : (await api.prevAppInfo())?.bundleId;
      if (!bundleId || apps.includes(bundleId)) return;
      onChange([...apps, bundleId]);
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
          <p className="px-1.5 py-1 text-body text-muted-foreground">空</p>
        )}
      </div>
    </div>
  );
}

function TargetSection({
  settings,
  patch,
  targetProfileRequest,
}: SP & {
  targetProfileRequest: { profileId: string; sequence: number } | null;
}) {
  return (
    <div>
      <SectionTitle>目标与发送方案</SectionTitle>
      <p className="mb-3 text-body text-muted-foreground">
        Toskr 会根据当前目标应用自动选择发送方案。方案决定提示词组、输出格式、粘贴后动作和出站隐私策略。
      </p>
      <TargetProfileManager
        settings={settings}
        patch={patch}
        requestedProfileId={targetProfileRequest?.profileId ?? null}
        requestSequence={targetProfileRequest?.sequence ?? 0}
      />
      <Disclosure title="隐私与化名">
        <FirewallSettings settings={settings} patch={patch} />
        <AliasEntitySettings settings={settings} patch={patch} />
      </Disclosure>
      <Disclosure title="提示词组">
        <SnippetsSection settings={settings} patch={patch} />
      </Disclosure>
    </div>
  );
}

function FirewallSettings({ settings, patch }: SP) {
  const disabled = new Set(settings.firewallDisabledWarnCategories);
  return (
    <Group title="发送前隐私检查（仅本机文本检查）">
      <Row
        label="启用隐私检查"
        hint="默认开启；快速发送也会先检查，有风险时自动进入预检"
        right={
          <Switch
            aria-label="发送前隐私检查"
            checked={settings.firewallEnabled}
            onCheckedChange={(firewallEnabled) => patch({ firewallEnabled })}
          />
        }
      />
      <div className="px-3.5 py-2.5">
        <p className="text-title">提示级类别</p>
        <p className="mt-0.5 text-label text-muted-foreground">
          可按类别关闭提示；私钥、授权、API 密钥、数据库连接、Cookie 与会话等高风险规则不能单独关闭。
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {FIREWALL_WARN_CATEGORIES.map((category) => (
            <label key={category} className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2 py-1.5 text-body">
              {FIREWALL_CATEGORY_LABEL[category]}
              <Switch
                size="sm"
                disabled={!settings.firewallEnabled}
                aria-label={`${FIREWALL_CATEGORY_LABEL[category]}提示`}
                checked={!disabled.has(category)}
                onCheckedChange={(enabled) => patch({
                  firewallDisabledWarnCategories: enabled
                    ? settings.firewallDisabledWarnCategories.filter(
                        (item) => item !== category
                      )
                    : [...settings.firewallDisabledWarnCategories, category],
                })}
              />
            </label>
          ))}
        </div>
        <p className="mt-2 text-label text-warning">
          检测基于本地规则，可能存在误报或漏报；“未发现”不代表绝对安全。
        </p>
      </div>
    </Group>
  );
}

function CompanionSection({ settings, patch }: SP) {
  return (
    <div>
      <SectionTitle>伴随停靠</SectionTitle>
      <CompanionSettings settings={settings} patch={patch} />
    </div>
  );
}

function CompanionSettings({ settings, patch }: SP) {
  return (
    <div className="mb-5">
      <Group>
        <Row
          label="启用伴随停靠"
          hint="有目标时磁吸并跟随；无可用目标时自由拖动，拖到屏幕外缘会自动收起"
          right={
            <Switch
              aria-label="启用伴随停靠"
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
              ariaLabel="与窗口的间隙"
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
      <p className="mb-2 text-body font-medium text-muted-foreground">捕获排除</p>
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


/** AI 智能：配置留在普通设置，secret 只经 Rust 进入 macOS Keychain。 */
function AiSection({ settings, patch }: SP) {
  const [keyStatus, setKeyStatus] = useState<AiKeyStatus>({
    configured: false,
    updatedAtMs: null,
  });
  const [keyStatusKnown, setKeyStatusKnown] = useState(false);
  const [keyStatusError, setKeyStatusError] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [deletingKey, setDeletingKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const preset = matchPreset(settings.aiBaseUrl);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeAiKeyStatus(
      (status) => {
        if (disposed) return;
        setKeyStatus(status);
        setKeyStatusKnown(true);
        setKeyStatusError(false);
      },
      api.getAiKeyStatus,
      () => {
        if (disposed) return;
        setKeyStatusKnown(true);
        setKeyStatusError(true);
      }
    ).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const saveKey = async () => {
    const key = newKey.trim();
    if (!key || savingKey) return;
    setSavingKey(true);
    try {
      const status = await api.setAiApiKey(key, true);
      setKeyStatus(status);
      setKeyStatusKnown(true);
      setKeyStatusError(false);
      setNewKey("");
      await emitTo("main", SETTINGS_AI_KEY_CHANGED, status).catch(() => {});
      tip("ok", keyStatus.configured ? "AI 密钥已覆盖" : "AI 密钥已存入钥匙串");
    } catch {
      tip("warn", "AI 密钥保存失败；原密钥未被删除");
    } finally {
      setSavingKey(false);
    }
  };

  const removeKey = async () => {
    if (deletingKey) return;
    const confirmed = await ask(
      "删除后 AI 功能会停止，且 Toskr 无法恢复原密钥。确认从 macOS 钥匙串删除吗？",
      { title: "删除 AI 密钥", kind: "warning" }
    );
    if (!confirmed) return;
    setDeletingKey(true);
    try {
      const status = await api.deleteAiApiKey();
      setKeyStatus(status);
      setNewKey("");
      await emitTo("main", SETTINGS_AI_KEY_CHANGED, status).catch(() => {});
      tip("ok", "AI 密钥已删除");
    } catch {
      tip("warn", "AI 密钥删除失败；原密钥仍保留");
    } finally {
      setDeletingKey(false);
    }
  };

  const requireKey = () => {
    if (!keyStatusKnown) {
      tip("info", "正在读取 macOS 钥匙串状态，请稍候");
      return false;
    }
    if (keyStatusError) {
      tip("warn", "无法读取 macOS 钥匙串状态，请稍后重试");
      return false;
    }
    if (keyStatus.configured) return true;
    tip("info", "请先把 AI API Key 存入 macOS 钥匙串");
    return false;
  };

  const fetchModels = async () => {
    if (fetchingModels || !requireKey()) return;
    setFetchingModels(true);
    try {
      const ids = await api.aiListModels(settings.aiBaseUrl.trim());
      setModels(ids);
      tip("ok", `获取到 ${ids.length} 个模型`);
    } catch (error) {
      tip("warn", `获取失败：${String(error).slice(0, 80)}`);
    } finally {
      setFetchingModels(false);
    }
  };

  const runTest = async () => {
    if (testing || !requireKey()) return;
    setTesting(true);
    try {
      await testAiConnection(settings.aiBaseUrl, settings.aiModel);
      tip("ok", "AI 连接成功");
    } catch (error) {
      tip(
        "warn",
        `连接失败：${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`
      );
    } finally {
      setTesting(false);
    }
  };

  const keyHint = keyStatusError
    ? "无法读取钥匙串状态，请稍后重试"
    : !keyStatusKnown
      ? "正在读取 macOS 钥匙串…"
      : keyStatus.configured
        ? `已配置${keyStatus.updatedAtMs ? ` · ${new Date(keyStatus.updatedAtMs).toLocaleString()}` : ""}`
        : "未配置；输入新密钥后只可覆盖或删除，不会回显";

  return (
    <div>
      <SectionTitle>AI 智能</SectionTitle>
      <p className="mb-3 text-body text-muted-foreground">
        配置 OpenAI 兼容的 AI 提供商后：任务输入框 ✨ 模式支持自然语言建任务；
        任务可 AI 拆解，笔记可 AI 转任务或起标题。
      </p>
      <Group>
        <Row
          label="启用 AI 智能"
          hint="关闭后各 AI 入口不发起请求"
          right={
            <Switch
              aria-label="启用 AI 智能"
              checked={settings.aiEnabled}
              onCheckedChange={(value) => patch({ aiEnabled: value })}
            />
          }
        />
      </Group>
      <Group title="提供商（OpenAI 兼容）">
        <div className="flex flex-wrap items-center gap-1 px-3.5 py-2.5">
          {AI_PRESETS.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                if (item.id === "custom") {
                  patch({ aiBaseUrl: "" });
                  return;
                }
                patch({
                  aiBaseUrl: item.baseUrl,
                  ...(settings.aiModel.trim() ? {} : { aiModel: item.modelHint }),
                });
              }}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-label",
                preset === item.id
                  ? "border-border bg-primary/10 font-medium text-foreground dark:border-input"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <Row
          label="Base URL"
          hint="远端仅允许 HTTPS；HTTP 只允许 localhost、127.0.0.1 或 ::1"
          right={
            <input
              value={settings.aiBaseUrl}
              onChange={(event) => patch({ aiBaseUrl: event.target.value })}
              placeholder="https://…"
              autoComplete="off"
              className="h-8 w-64 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus:border-primary/50"
            />
          }
        />
        <Row
          label="API Key"
          hint={keyHint}
          right={
            <div className="flex max-w-80 flex-wrap items-center justify-end gap-1" aria-live="polite">
              <input
                type="password"
                value={newKey}
                onChange={(event) => setNewKey(event.target.value)}
                placeholder={keyStatus.configured ? "输入新密钥以覆盖" : "输入新密钥"}
                autoComplete="new-password"
                className="h-8 w-48 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus:border-primary/50"
              />
              <button
                onClick={() => void saveKey()}
                disabled={!newKey.trim() || savingKey}
                className="rounded-lg border border-border px-2 py-1 text-label text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {savingKey ? "保存中…" : keyStatus.configured ? "覆盖" : "保存"}
              </button>
              {keyStatus.configured && (
                <button
                  onClick={() => void removeKey()}
                  disabled={deletingKey}
                  className="rounded-lg border border-destructive/30 px-2 py-1 text-label text-destructive disabled:opacity-50"
                >
                  {deletingKey ? "删除中…" : "删除"}
                </button>
              )}
            </div>
          }
        />
        <Row
          label="模型名"
          hint={models.length ? `已获取 ${models.length} 个模型` : "手动填写，或从已配置服务获取列表"}
          right={
            <div className="flex items-center gap-1">
              {models.length ? (
                <select
                  value={models.includes(settings.aiModel) ? settings.aiModel : ""}
                  onChange={(event) => {
                    if (event.target.value === "__manual__") {
                      setModels([]);
                      return;
                    }
                    if (event.target.value) patch({ aiModel: event.target.value });
                  }}
                  className="h-8 w-56 rounded-lg border border-border bg-transparent px-2 text-body outline-none focus:border-primary/50"
                >
                  <option value="" disabled>选择模型…</option>
                  {models.map((model) => <option key={model} value={model}>{model}</option>)}
                  <option value="__manual__">手动输入…</option>
                </select>
              ) : (
                <input
                  value={settings.aiModel}
                  onChange={(event) => patch({ aiModel: event.target.value })}
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
          hint="从 macOS 钥匙串读取密钥并发送一次最小请求（无需先启用）"
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
      <p className="text-label text-muted-foreground">
        隐私说明：API Key 只保存在 macOS 钥匙串，不进入数据文件、完整备份、
        诊断或进程参数；只有你主动触发 AI 功能时，相关文本才会直达所选服务。
      </p>
    </div>
  );
}

/** 到期快捷档编辑：任务「到期」弹层里的快捷选项，可增删改。 */
/** 账单（订阅/信用卡）提醒偏好：新建账单的默认提前档 + 金额货币符号。 */
function BillReminderDefaultsSection({ settings, patch }: SP) {
  const OFFSETS: { value: ReminderOffsetDays; label: string }[] = [
    { value: 7, label: "提前 7 天" },
    { value: 3, label: "提前 3 天" },
    { value: 1, label: "提前 1 天" },
    { value: 0, label: "当天" },
  ];
  const current = settings.billDefaultReminderOffsets;
  const toggle = (offset: ReminderOffsetDays) => {
    patch({
      billDefaultReminderOffsets: current.includes(offset)
        ? current.filter((o) => o !== offset)
        : [...current, offset],
    });
  };
  if (!settings.subscriptionsEnabled) return null;
  return (
    <div className="mt-6">
      <SectionTitle>账单到期提醒</SectionTitle>
      <p className="mb-3 text-body text-muted-foreground">
        「提醒 → 订阅」里新建账单默认勾选的提前提醒档；只影响之后新建的账单，
        已有账单在各自编辑页单独调整。
      </p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {OFFSETS.map(({ value, label }) => {
          const on = current.includes(value);
          return (
            <button
              key={value}
              role="checkbox"
              aria-checked={on}
              onClick={() => toggle(value)}
              className={cn(
                "rounded-full px-2.5 py-1 text-label transition-colors",
                on
                  ? "bg-primary text-primary-foreground"
                  : "bg-black/5 text-muted-foreground hover:text-foreground dark:bg-white/10"
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-body text-muted-foreground">金额货币符号</span>
        <input
          value={settings.currencySymbol}
          onChange={(e) => patch({ currencySymbol: e.target.value.slice(0, 3) || "¥" })}
          className="h-8 w-14 rounded-lg border border-border bg-transparent px-2 text-center text-body outline-none focus:border-primary/50"
          aria-label="金额货币符号"
        />
      </div>
    </div>
  );
}

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
  const sortedGroups = useMemo(
    () => [...settings.promptGroups].sort((a, b) => a.order - b.order),
    [settings.promptGroups]
  );
  const groupOptions = useMemo(
    () => sortedGroups.map((group) => ({ value: group.id, label: group.name })),
    [sortedGroups]
  );
  const [groupName, setGroupName] = useState("");
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [groupId, setGroupId] = useState(GENERAL_PROMPT_GROUP_ID);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editText, setEditText] = useState("");
  const [editGroupId, setEditGroupId] = useState(GENERAL_PROMPT_GROUP_ID);
  const addGroup = () => {
    const name = groupName.trim();
    if (!name) return;
    patch({
      promptGroups: [
        ...settings.promptGroups,
        {
          id: crypto.randomUUID(),
          name,
          order: Math.max(-1, ...settings.promptGroups.map((item) => item.order)) + 1,
        },
      ],
    });
    setGroupName("");
  };
  const removeGroup = (id: string) => {
    const next = deletePromptGroup(
      {
        groups: settings.promptGroups,
        snippets: settings.promptSnippets,
        profiles: settings.targetProfiles,
        defaultProfileId: settings.defaultTargetProfileId,
      },
      id
    );
    patch({
      promptGroups: next.groups,
      promptSnippets: next.snippets,
      targetProfiles: next.profiles,
      defaultTargetProfileId: next.defaultProfileId,
    });
    if (groupId === id) setGroupId(GENERAL_PROMPT_GROUP_ID);
    if (editGroupId === id) setEditGroupId(GENERAL_PROMPT_GROUP_ID);
    if (next.affectedReferences > 0) {
      tip("info", `已将 ${next.affectedReferences} 个引用回落到“通用”提示词组`);
    }
  };
  const moveGroup = (id: string, direction: -1 | 1) => {
    const ordered = [...sortedGroups];
    const index = ordered.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    patch({
      promptGroups: ordered.map((item, order) => ({ ...item, order })),
    });
  };
  const add = () => {
    if (!label.trim() || !text.trim()) return;
    const snippet: PromptSnippet = {
      id: crypto.randomUUID(),
      label: label.trim(),
      text: text.trim(),
      groupId,
    };
    patch({ promptSnippets: [...settings.promptSnippets, snippet] });
    setLabel("");
    setText("");
  };
  const startEdit = (sn: PromptSnippet) => {
    setEditingId(sn.id);
    setEditLabel(sn.label);
    setEditText(sn.text);
    setEditGroupId(sn.groupId);
  };
  const saveEdit = () => {
    if (!editingId || !editLabel.trim() || !editText.trim()) return;
    patch({
      promptSnippets: settings.promptSnippets.map((s) =>
        s.id === editingId
          ? {
              ...s,
              label: editLabel.trim(),
              text: editText.trim(),
              groupId: editGroupId,
            }
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
      <p className="mb-1.5 text-body font-medium text-muted-foreground">提示词组</p>
      <div className="mb-2 divide-y divide-border/50 rounded-xl border border-border/60 bg-card">
        {sortedGroups.map((group, index) => (
          <div key={group.id} className="flex items-center gap-2 px-3.5 py-2">
            <input
              aria-label={`${group.name} 提示词组名称`}
              value={group.name}
              disabled={group.id === GENERAL_PROMPT_GROUP_ID}
              onChange={(event) =>
                patch({
                  promptGroups: settings.promptGroups.map((item) =>
                    item.id === group.id ? { ...item, name: event.target.value } : item
                  ),
                })
              }
              className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2 text-title disabled:border-transparent disabled:opacity-100"
            />
            <IconButton
              label="上移提示词组"
              size="2xs"
              disabled={index === 0}
              onClick={() => moveGroup(group.id, -1)}
            ><ArrowUp /></IconButton>
            <IconButton
              label="下移提示词组"
              size="2xs"
              disabled={index === sortedGroups.length - 1}
              onClick={() => moveGroup(group.id, 1)}
            ><ArrowDown /></IconButton>
            <IconButton
              label={`删除提示词组 ${group.name}`}
              tone="danger"
              size="2xs"
              disabled={group.id === GENERAL_PROMPT_GROUP_ID}
              onClick={() => removeGroup(group.id)}
            ><X /></IconButton>
          </div>
        ))}
      </div>
      <div className="mb-5 flex items-center gap-2">
        <input
          aria-label="新提示词组名称"
          value={groupName}
          onChange={(event) => setGroupName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addGroup();
          }}
          placeholder="新提示词组名称"
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2 text-body"
        />
        <button
          type="button"
          onClick={addGroup}
          className="flex h-8 items-center gap-1 rounded-lg border border-border px-3 text-body text-primary"
        >
          <Plus className="size-3.5" /> 新建提示词组
        </button>
      </div>
      <p className="mb-1.5 text-body font-medium text-muted-foreground">提示词模板</p>
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
              <SimpleSelect
                ariaLabel="模板所属提示词组"
                className="w-28 shrink-0"
                align="end"
                value={editGroupId}
                options={groupOptions}
                onChange={setEditGroupId}
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
              <SimpleSelect
                ariaLabel={`${sn.label} 所属提示词组`}
                className="w-28 shrink-0"
                align="end"
                value={sn.groupId}
                options={groupOptions}
                onChange={(groupId) =>
                  patch({
                    promptSnippets: settings.promptSnippets.map((item) =>
                      item.id === sn.id ? { ...item, groupId } : item
                    ),
                  })
                }
              />
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
          <p className="px-3.5 py-2 text-body text-muted-foreground">暂无模板</p>
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
        <SimpleSelect
          ariaLabel="新模板所属提示词组"
          className="w-28 shrink-0"
          align="end"
          value={groupId}
          options={groupOptions}
          onChange={setGroupId}
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
  const [status, setStatus] = useState<DataLocationStatus | null>(null);
  const [inspection, setInspection] = useState<DataLocationInspection | null>(null);
  const [activity, setActivity] = useState({
    locked: false,
    phase: "idle",
    message: "",
  });
  const [health, setHealth] = useState<MediaIntegrityReport | null>(null);

  const reloadStatus = () => {
    void api.getDataLocationStatus().then(setStatus).catch(() => {});
  };

  useEffect(() => {
    reloadStatus();
    const subscriptions = [
      listen<{ locked: boolean; phase: string; message: string }>(
        DATA_ACTIVITY_EVENT,
        (event) => {
          setActivity(event.payload);
          if (
            !event.payload.locked ||
            event.payload.phase === "conflict" ||
            event.payload.phase === "storageRecovery"
          )
            reloadStatus();
        }
      ),
      listen(DATA_LOCATION_CHANGED_EVENT, () => reloadStatus()),
      listen<MediaIntegrityReport>(SETTINGS_DATA_HEALTH_RESULT, (event) =>
        setHealth(event.payload)
      ),
    ];
    return () => subscriptions.forEach((subscription) => subscription.then((stop) => stop()));
  }, []);

  const inspectPath = async (path: string) => {
    try {
      setInspection(await api.inspectDataLocation(path));
    } catch (error) {
      tip("warn", `预检失败：${String(error)}`);
    }
  };

  const pick = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    await inspectPath(picked);
  };

  const inspectDefault = async () => {
    if (status) await inspectPath(status.defaultDir);
  };

  const execute = async (
    action: DataOperationPlan["action"],
    replaceConfirmed = false
  ) => {
    if (!status || !inspection) return;
    if (action === "replaceTargetWithCurrent") {
      const confirmed = await ask(
        "目标已有有效 Toskr 数据。应用会先创建目标恢复快照，再以当前数据替换目标；不提供自动合并。确认继续吗？",
        { title: "二次确认替换目标", kind: "warning" }
      );
      if (!confirmed) return;
      replaceConfirmed = true;
    }
    const plan: DataOperationPlan = {
      operationId: crypto.randomUUID(),
      sourcePath: status.activeDir,
      targetPath: inspection.path,
      action,
      replaceConfirmed,
      expectedTargetRevision: inspection.revision ?? "",
    };
    setActivity({ locked: true, phase: "prepare", message: "正在刷新并冻结写入…" });
    await emitTo(
      "main",
      status.initializationFailure
        ? SETTINGS_DATA_RECOVERY_OPERATION
        : SETTINGS_DATA_OPERATION,
      plan
    );
  };

  const targetLabel: Record<DataLocationInspection["kind"], string> = {
    missing: "目录不存在（可创建后迁移）",
    empty: "空目录",
    nonToskr: "含普通文件但没有 Toskr 数据",
    valid: "有效 Toskr 数据",
    corrupt: "Toskr JSON 损坏",
    unsupported: "schema 高于当前版本",
  };
  const availableActions: DataOperationPlan["action"][] = inspection
    ? status?.initializationFailure
      ? inspection.kind === "valid" && !inspection.sameAsActive
        ? ["loadExistingTarget", "cancel"]
        : ["cancel"]
      : availableDataActions(inspection)
    : [];

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
            {status?.activeDir || "读取中…"}
          </p>
          <p className="mt-1 text-label text-muted-foreground">
            切换前会刷新待写数据、预检目标、创建恢复点并重新水合。
            iCloud、Dropbox 等目录只作为外部同步位置，不承诺无冲突多设备同步。
          </p>
          {status?.lastSuccessfulSwitchAtMs && (
            <p className="mt-1 text-label text-muted-foreground">
              最近成功切换：{new Date(status.lastSuccessfulSwitchAtMs).toLocaleString()}
            </p>
          )}
          {status?.lastConflictAtMs && (
            <p className="mt-1 text-label text-destructive">
              最近磁盘冲突：{new Date(status.lastConflictAtMs).toLocaleString()}
            </p>
          )}
          {status?.initializationFailure && (
            <div className="mt-2 rounded-lg border border-destructive/40 p-2" role="alert">
              <p className="text-body font-medium">数据目录初始化失败，当前保持只读。</p>
              <p className="mt-1 text-label text-muted-foreground">
                错误代码：{status.initializationFailure.code}
              </p>
              <p className="mt-1 text-label text-muted-foreground">
                {status.initializationFailure.message}
              </p>
              <p className="mt-1 break-all font-mono text-label text-muted-foreground">
                已配置目录：{status.activeDir}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() =>
                    void requestStorageRecoveryAction("retryStorage")
                  }
                  className="rounded-lg bg-primary px-3 py-1 text-body text-primary-foreground"
                >
                  重试挂载
                </button>
                <button
                  onClick={() =>
                    void requestStorageRecoveryAction("loadDefault")
                  }
                  className="rounded-lg border border-border px-3 py-1 text-body"
                >
                  明确加载默认目录
                </button>
              </div>
            </div>
          )}
          {status?.conflictPending && !status.initializationFailure && (
            <div className="mt-2 rounded-lg border border-destructive/40 p-2" role="alert">
              <p className="text-body">外部版本尚未处理，自动写入已停止。</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() =>
                    void emitTo("main", SETTINGS_DATA_CONFLICT_ACTION, "reload")
                  }
                  className="rounded-lg bg-primary px-3 py-1 text-body text-primary-foreground"
                >
                  重新加载磁盘
                </button>
                <button
                  onClick={() =>
                    void emitTo("main", SETTINGS_DATA_CONFLICT_ACTION, "saveRecovery")
                  }
                  className="rounded-lg border border-border px-3 py-1 text-body"
                >
                  另存恢复副本后加载
                </button>
                <button
                  onClick={() =>
                    tip("info", "已保持只读；冲突仍待处理，不会覆盖磁盘新版本")
                  }
                  className="rounded-lg border border-border px-3 py-1 text-body text-muted-foreground"
                >
                  暂不处理
                </button>
              </div>
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <button
              onClick={pick}
              disabled={activity.locked && !status?.initializationFailure}
              className="rounded-lg border border-border px-3 py-1 text-body hover:bg-black/5 dark:hover:bg-white/5"
            >
              预检新目录…
            </button>
            <button
              onClick={() => void inspectDefault()}
              disabled={activity.locked || !status}
              className="rounded-lg border border-border px-3 py-1 text-body text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5"
            >
              预检默认目录
            </button>
          </div>
          {activity.message && (
            <div
              role="status"
              aria-live="polite"
              className="mt-2 rounded-lg border border-border bg-muted/40 px-2 py-1.5 text-body"
            >
              {activity.message}
            </div>
          )}
          {inspection && (
            <div className="mt-3 rounded-xl border border-border bg-muted/30 p-2.5">
              <p className="text-title font-medium">目标预检：{targetLabel[inspection.kind]}</p>
              <p className="mt-1 break-all font-mono text-label text-muted-foreground">
                {inspection.path}
              </p>
              <p className="mt-1 text-label text-muted-foreground">
                笔记 {inspection.noteCount} · 任务 {inspection.taskCount} · 媒体 {inspection.mediaCount}
              </p>
              {inspection.externalSyncLikely && (
                <p className="mt-1 text-label text-muted-foreground">
                  检测到外部同步目录：并发修改会被阻止，但本阶段不自动合并。
                </p>
              )}
              {!inspection.writable && (
                <p className="mt-1 text-label text-destructive">目标不可写，已阻止执行。</p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {inspection.sameAsActive ? (
                  <span className="text-label text-muted-foreground">这就是当前活动目录，无需切换。</span>
                ) : availableActions.includes("migrateCurrentToTarget") ? (
                  <button
                    onClick={() => void execute("migrateCurrentToTarget")}
                    disabled={activity.locked}
                    className="rounded-lg bg-primary px-3 py-1 text-body text-primary-foreground"
                  >
                    迁移当前数据
                  </button>
                ) : availableActions.includes("loadExistingTarget") ? (
                  <>
                    <button
                      onClick={() => void execute("loadExistingTarget")}
                      disabled={activity.locked && !status?.initializationFailure}
                      className="rounded-lg bg-primary px-3 py-1 text-body text-primary-foreground"
                    >
                      加载目标数据
                    </button>
                    <button
                      onClick={() => void execute("replaceTargetWithCurrent")}
                      disabled={activity.locked}
                      className="rounded-lg border border-destructive/40 px-3 py-1 text-body text-destructive"
                    >
                      创建恢复点后替换目标
                    </button>
                  </>
                ) : (
                  <span className="text-label text-muted-foreground">
                    当前目标不可安全加载或覆盖，请修复后重新预检。
                  </span>
                )}
                <button
                  onClick={() => setInspection(null)}
                  disabled={activity.locked && !status?.initializationFailure}
                  className="rounded-lg border border-border px-3 py-1 text-body text-muted-foreground"
                >
                  取消
                </button>
              </div>
              {inspection.kind === "valid" && (
                <p className="mt-2 text-label text-muted-foreground">
                  两个有效数据集不会自动 record-level merge。
                </p>
              )}
            </div>
          )}
        </div>
      </Group>
      <Group title="备份">
        <Row
          label="导出完整备份"
          hint="版本化 manifest + 状态 + taskSections + 被引用媒体；缺媒体会失败"
          right={
            <button
              onClick={() => void emitTo("main", SETTINGS_EXPORT, {})}
              disabled={activity.locked}
              className="rounded-lg border border-border px-3 py-1 text-body hover:bg-black/5 dark:hover:bg-white/5"
            >
              导出…
            </button>
          }
        />
        <Row
          label="导入并预检"
          hint="完整备份原子恢复（不含 API Key）；旧 JSON 仅兼容合并并显示缺失能力"
          right={
            <button
              onClick={() => void emitTo("main", SETTINGS_IMPORT, {})}
              disabled={activity.locked}
              className="rounded-lg border border-border px-3 py-1 text-body hover:bg-black/5 dark:hover:bg-white/5"
            >
              导入…
            </button>
          }
        />
      </Group>
      <Group title="数据健康">
        <div className="px-3.5 py-2.5">
          <button
            onClick={() => void emitTo("main", SETTINGS_DATA_HEALTH, {})}
            disabled={activity.locked}
            className="rounded-lg border border-border px-3 py-1 text-body hover:bg-black/5 dark:hover:bg-white/5"
          >
            运行健康检查
          </button>
          {health && (
            <div className="mt-2 text-label text-muted-foreground" role="status" aria-live="polite">
              <p>
                引用 {health.referencedCount} · 文件 {health.actualCount} · 缺失 {health.missing.length} · 孤立 {health.orphaned.length} · 待 GC {health.tombstoned.length}
              </p>
              {health.suggestions.map((suggestion) => (
                <p key={suggestion} className="mt-1">• {suggestion}</p>
              ))}
              {!health.missing.length && !health.orphaned.length && !health.unsafeEntries.length && (
                <p className="mt-1 text-primary">媒体引用完整，未自动删除任何可疑文件。</p>
              )}
            </div>
          )}
        </div>
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
          <p className="px-1.5 py-1 text-body text-muted-foreground">
            暂无记录 —— 双击一次触发键就有了
          </p>
        ) : (
          entries.map((d, i) => (
            <p key={i} className="px-1.5 py-0.5 text-label leading-snug text-muted-foreground">
              <span className="tabular-nums text-muted-foreground">
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
        <p className="mt-1 text-label text-muted-foreground">
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
              aria-label="自动检查更新"
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
              aria-label="自动安装更新"
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
