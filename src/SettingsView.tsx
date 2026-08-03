import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { emitTo, listen } from "@tauri-apps/api/event";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  Activity,
  Database,
  Info,
  Keyboard,
  Magnet,
  Plus,
  Settings2,
  Shield,
  Sparkles,
  X,
} from "lucide-react";

import { Switch } from "@/components/ui/switch";
import {
  SETTINGS_EXPORT,
  SETTINGS_IMPORT,
  SETTINGS_PATCH,
  SETTINGS_REQUEST,
  SETTINGS_STATE,
} from "@/lib/settingsSync";
import { api } from "@/lib/tauri";
import { checkForUpdate, downloadAndInstall } from "@/lib/updater";
import { cn } from "@/lib/utils";
import {
  defaultSettings,
  type PromptSnippet,
  type Settings,
  type ThemePref,
  type VibrancyMaterial,
} from "@/store/notesStore";

type SectionId =
  | "general"
  | "hotkey"
  | "companion"
  | "exclude"
  | "snippets"
  | "data"
  | "diagnostics"
  | "about";

const SECTIONS: { id: SectionId; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "通用", icon: <Settings2 className="size-4" /> },
  { id: "hotkey", label: "快捷键", icon: <Keyboard className="size-4" /> },
  { id: "companion", label: "伴随停靠", icon: <Magnet className="size-4" /> },
  { id: "exclude", label: "捕获排除", icon: <Shield className="size-4" /> },
  { id: "snippets", label: "Prompt 模板", icon: <Sparkles className="size-4" /> },
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
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
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
        {section === "companion" && <CompanionSection settings={settings} patch={patch} />}
        {section === "exclude" && <ExcludeSection settings={settings} patch={patch} />}
        {section === "snippets" && <SnippetsSection settings={settings} patch={patch} />}
        {section === "data" && <DataSection />}
        {section === "diagnostics" && <DiagnosticsSection />}
        {section === "about" && <AboutSection />}
      </main>
    </div>
  );
}

/* ============ 通用控件 ============ */

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-[15px] font-semibold">{children}</h2>;
}

function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      {title && (
        <p className="mb-1.5 text-[12px] font-medium text-muted-foreground">{title}</p>
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
        <p className="text-[13px]">{label}</p>
        {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{right}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md border px-2 py-1 text-[12px]",
            value === o.value
              ? "border-primary/50 bg-primary/10 font-medium"
              : "border-border text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

type SP = { settings: Settings; patch: (p: Partial<Settings>) => void };

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
            />
          }
        />
        <Row
          label="窗口整体不透明度"
          hint="连毛玻璃一起变透，可真正看穿下层窗口内容"
          right={
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={30}
                max={100}
                step={5}
                value={Math.round(settings.windowOpacity * 100)}
                onChange={(e) => patch({ windowOpacity: Number(e.target.value) / 100 })}
                className="h-1 w-32 cursor-pointer accent-primary"
              />
              <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">
                {Math.round(settings.windowOpacity * 100)}%
              </span>
            </div>
          }
        />
        <Row
          label="内容底色浓度"
          hint="面板自绘膜层的浓淡（毛玻璃关闭时效果最直观）"
          right={
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={25}
                max={100}
                step={5}
                value={Math.round(settings.panelOpacity * 100)}
                onChange={(e) => patch({ panelOpacity: Number(e.target.value) / 100 })}
                className="h-1 w-32 cursor-pointer accent-primary"
              />
              <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">
                {Math.round(settings.panelOpacity * 100)}%
              </span>
            </div>
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
          label="失焦自动隐藏"
          hint="点击其他应用时收起面板（钉住豁免）"
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
      </Group>
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
            />
          }
        />
      </Group>
      <Group title="面板内快捷键（长按 ⌘ 可随时速查）">
        {[
          ["⇧⇧", "捕获选中文本 / 呼出面板"],
          ["↑ ↓", "移动焦点卡片"],
          ["Space", "全文预览（预览中 ↑↓ 切换）"],
          ["Enter", "编辑（预览内 ⌘⏎ 保存）"],
          ["x", "勾选 / 取消勾选"],
          ["⌘A", "全选可见卡片"],
          ["⌘⏎", "发送勾选到对话"],
          ["⌘C", "复制勾选为列表"],
          ["⌘⌫", "删除焦点卡片"],
          ["⌘F", "搜索"],
          ["Esc", "逐层退出"],
        ].map(([k, d]) => (
          <Row
            key={k}
            label={d}
            right={
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">
                {k}
              </kbd>
            }
          />
        ))}
      </Group>
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
  return (
    <div className="rounded-xl border border-border/60 bg-card p-2">
      <button
        onClick={addCurrent}
        className="mb-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-primary hover:bg-primary/10"
      >
        <Plus className="size-3.5" /> {addLabel}
      </button>
      <div className="max-h-56 overflow-y-auto">
        {apps.map((bundle) => (
          <div
            key={bundle}
            className="group flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-muted-foreground hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            <span className="truncate">{bundle}</span>
            <button
              aria-label="移除"
              onClick={() => onChange(apps.filter((b) => b !== bundle))}
              className="ml-auto hidden rounded p-0.5 hover:text-foreground group-hover:block"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        {apps.length === 0 && (
          <p className="px-1.5 py-1 text-[12px] text-muted-foreground/60">空</p>
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
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={40}
                step={2}
                value={settings.companionGap}
                onChange={(e) => patch({ companionGap: Number(e.target.value) })}
                className="h-1 w-32 cursor-pointer accent-primary"
              />
              <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">
                {settings.companionGap}pt
              </span>
            </div>
          }
        />
      </Group>
      <p className="mb-1.5 text-[12px] font-medium text-muted-foreground">
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
      <p className="mb-3 text-[12px] text-muted-foreground">
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

function SnippetsSection({ settings, patch }: SP) {
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
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
  return (
    <div>
      <SectionTitle>Prompt 前缀模板</SectionTitle>
      <p className="mb-3 text-[12px] text-muted-foreground">
        发送时可在「发送到对话 ▾」下拉里选择一个前缀，与勾选内容组装后发出。
      </p>
      <div className="mb-3 divide-y divide-border/50 rounded-xl border border-border/60 bg-card">
        {settings.promptSnippets.map((sn) => (
          <div key={sn.id} className="group flex items-center gap-2 px-3.5 py-2">
            <span className="shrink-0 text-[13px] font-medium">{sn.label}</span>
            <span className="truncate text-[12px] text-muted-foreground">{sn.text}</span>
            <button
              aria-label="删除模板"
              onClick={() =>
                patch({
                  promptSnippets: settings.promptSnippets.filter((s) => s.id !== sn.id),
                })
              }
              className="ml-auto hidden rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
        {settings.promptSnippets.length === 0 && (
          <p className="px-3.5 py-2 text-[12px] text-muted-foreground/60">暂无模板</p>
        )}
      </div>
      <div className="flex gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="模板名"
          className="h-8 w-32 rounded-lg border border-border bg-transparent px-2 text-[12px] outline-none focus:border-primary/50"
        />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="前缀内容（如：请帮我 review 以下代码：）"
          className="h-8 flex-1 rounded-lg border border-border bg-transparent px-2 text-[12px] outline-none focus:border-primary/50"
        />
        <button
          onClick={add}
          className="flex h-8 items-center gap-1 rounded-lg bg-primary px-3 text-[12px] text-primary-foreground hover:opacity-90"
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
      alert(`切换失败：${e}`);
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
      <p className="mb-3 text-[12px] text-muted-foreground">
        所有数据仅保存在本机，无账号、无同步、无遥测。
      </p>
      <Group title="存储位置">
        <div className="px-3.5 py-2.5">
          <p className="text-[13px]">数据文件夹</p>
          <p className="mt-1 break-all rounded-lg bg-muted/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {dir || "读取中…"}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            卡片数据（toskr-data.json）与图片附件（media/）都存放于此；
            切换文件夹会把已有内容一并搬过去。
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={pick}
              className="rounded-lg border border-border px-3 py-1 text-[12px] hover:bg-black/5 dark:hover:bg-white/5"
            >
              选择文件夹…
            </button>
            <button
              onClick={reset}
              className="rounded-lg border border-border px-3 py-1 text-[12px] text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5"
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
              className="rounded-lg border border-border px-3 py-1 text-[12px] hover:bg-black/5 dark:hover:bg-white/5"
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
              className="rounded-lg border border-border px-3 py-1 text-[12px] hover:bg-black/5 dark:hover:bg-white/5"
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
      <p className="mb-3 text-[12px] text-muted-foreground">
        最近 50 条链路事件（自动刷新）：双击触发/拒绝原因、捕获分支、发送结果。
      </p>
      <div className="rounded-xl border border-border/60 bg-card p-2 font-mono">
        {entries.length === 0 ? (
          <p className="px-1.5 py-1 text-[12px] text-muted-foreground/60">
            暂无记录 —— 双击一次触发键就有了
          </p>
        ) : (
          entries.map((d, i) => (
            <p key={i} className="px-1.5 py-0.5 text-[11px] leading-snug text-muted-foreground">
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

function AboutSection() {
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
      <div className="rounded-xl border border-border/60 bg-card p-4">
        <p className="text-[15px] font-semibold">Toskr</p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          面向 AI 工作流的全局划词摘录、Prompt 暂存与一键流转工具。
        </p>
        <p className="mt-3 text-[12px] text-muted-foreground">
          版本 {version || "…"} · 本地优先 · 无账号 · 无遥测
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          双击 ⇧ 捕获选中文本；在终端/编辑器旁磁吸伴随；⌘⏎ 一键发回对话。
        </p>

        <div className="mt-4 flex items-center gap-2 border-t border-border/60 pt-3">
          {update ? (
            phase === "downloading" ? (
              <p className="text-[12px] text-muted-foreground">
                正在下载 v{update.version}… {progress}%（完成后自动重启）
              </p>
            ) : (
              <>
                <p className="flex-1 text-[12px]">
                  发现新版本 <span className="font-semibold">v{update.version}</span>
                </p>
                <button
                  onClick={() => void onInstall()}
                  className="rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground hover:opacity-90"
                >
                  下载并安装
                </button>
              </>
            )
          ) : (
            <>
              <p className="flex-1 text-[12px] text-muted-foreground">
                {phase === "latest" ? "已是最新版本 ✓" : "从 GitHub Releases 获取更新"}
              </p>
              <button
                onClick={() => void onCheck()}
                disabled={phase === "checking"}
                className="rounded-md border border-border px-2.5 py-1 text-[12px] hover:bg-muted disabled:opacity-50"
              >
                {phase === "checking" ? "检查中…" : "检查更新"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
