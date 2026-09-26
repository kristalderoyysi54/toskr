import { FolderOpen, Search, Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppIcon } from "@/components/settings/AppIdentity";
import { ApplicationRuleFields } from "@/components/settings/ApplicationRuleFields";
import { useAppIdentity } from "@/components/settings/useAppIdentity";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import {
  applicationRuleValues,
  applyApplicationRuleDraft,
  equalApplicationRuleValues,
  type ApplicationRuleValues,
} from "@/lib/applicationRules";
import { api, type TargetSnapshot } from "@/lib/tauri";
import { tip } from "@/lib/tip";
import { resolveTargetProfile, type TargetProfile } from "@/lib/targetProfiles";
import { cn } from "@/lib/utils";
import { isDataOperationLocked, useDataOperationStore } from "@/store/dataOperationStore";
import type { Settings } from "@/store/notesStore";

const DEFAULT_SELECTION = "default";
const TOSKR_BUNDLE_ID = "com.toskr.app";
type AppEntry = { bundleId: string; appName: string };
type RuleDraft = {
  values: ApplicationRuleValues;
  baseline: ApplicationRuleValues;
  signature: string;
  scope: "app" | "shared";
  resetToDefault?: boolean;
};

function ApplicationRow({ app, profiles, defaultProfileId, currentBundleId, selected, query, onSelect, onName }: {
  app: AppEntry;
  profiles: TargetProfile[];
  defaultProfileId: string;
  currentBundleId: string | null;
  selected: boolean;
  query: string;
  onSelect: () => void;
  onName: (bundleId: string, name: string) => void;
}) {
  const identity = useAppIdentity(app.bundleId, app.appName);
  const name = identity?.name || app.appName;
  const owner = profiles.find((profile) => profile.bundleIds.includes(app.bundleId));
  const source = owner?.name || "使用默认规则";
  useEffect(() => { onName(app.bundleId, name); }, [app.bundleId, name, onName]);
  if (!`${name} ${app.bundleId} ${source}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return null;
  return (
    <Button
      size="sm"
      aria-label={`设置 ${name} 的粘贴规则`}
      aria-pressed={selected}
      data-application-select={app.bundleId}
      onClick={onSelect}
      className={cn("h-auto min-w-0 w-full justify-start gap-2 whitespace-normal px-2 py-2 text-left", selected && "border-primary/50 bg-primary/10 text-primary hover:bg-primary/10")}
    >
      <AppIcon bundleId={app.bundleId} appName={name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium" title={name}>{name}</span>
        <span className="mt-0.5 line-clamp-2 block text-micro font-normal text-muted-foreground">{source}</span>
        {app.bundleId === currentBundleId && <span className="block text-micro font-normal text-muted-foreground">当前目标</span>}
        {owner?.id === defaultProfileId && <span className="block text-micro font-normal text-muted-foreground">已明确绑定默认方案</span>}
      </span>
    </Button>
  );
}

function SharedApplicationName({ bundleId }: { bundleId: string }) {
  const identity = useAppIdentity(bundleId);
  return <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/60 px-1.5 py-1 text-label"><AppIcon bundleId={bundleId} size="xs" /><span className="break-all">{identity?.name || bundleId}</span></span>;
}

export function ApplicationRuleInspector({ settings, patch, currentTarget, recentApps, request = null }: {
  settings: Settings;
  patch: (patch: Partial<Settings>) => void;
  currentTarget: TargetSnapshot | null;
  recentApps: AppEntry[];
  request?: { bundleId: string | null; sequence: number } | null;
}) {
  const [selected, setSelected] = useState<string | null>(() => request ? request.bundleId : currentTarget?.bundleId ?? null);
  const [query, setQuery] = useState("");
  const [extraApps, setExtraApps] = useState<AppEntry[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, RuleDraft>>({});
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touched = useRef(Boolean(request));
  const handledRequest = useRef(request?.sequence ?? 0);
  const pickSequence = useRef(0);
  const locked = useDataOperationStore((state) => state.locked);

  useEffect(() => () => { pickSequence.current += 1; }, []);
  useEffect(() => {
    if (!touched.current && currentTarget?.bundleId && currentTarget.bundleId !== TOSKR_BUNDLE_ID) setSelected(currentTarget.bundleId);
  }, [currentTarget?.bundleId]);
  useEffect(() => {
    if (!request || request.sequence <= handledRequest.current) return;
    handledRequest.current = request.sequence;
    touched.current = true;
    setSelected(request.bundleId);
    setQuery("");
    setError(null);
    pickSequence.current += 1;
    setPicking(false);
  }, [request]);
  useEffect(() => {
    if (locked) {
      setDrafts({});
      setError(null);
      pickSequence.current += 1;
      setPicking(false);
    }
  }, [locked]);

  const apps = useMemo(() => {
    const entries = new Map<string, AppEntry>();
    const add = (app: AppEntry) => { if (app.bundleId && app.bundleId !== TOSKR_BUNDLE_ID && !entries.has(app.bundleId)) entries.set(app.bundleId, app); };
    if (currentTarget?.bundleId) add({ bundleId: currentTarget.bundleId, appName: currentTarget.appName || currentTarget.bundleId });
    recentApps.forEach(add);
    extraApps.forEach(add);
    settings.targetProfiles.forEach((profile) => profile.bundleIds.forEach((bundleId) => add({ bundleId, appName: bundleId })));
    if (selected) add({ bundleId: selected, appName: selected });
    return [...entries.values()];
  }, [currentTarget?.appName, currentTarget?.bundleId, extraApps, recentApps, selected, settings.targetProfiles]);
  const recordName = useCallback((bundleId: string, name: string) => {
    setNames((previous) => previous[bundleId] === name ? previous : { ...previous, [bundleId]: name });
  }, []);
  const identity = useAppIdentity(selected, apps.find((app) => app.bundleId === selected)?.appName);
  const appName = selected ? identity?.name || names[selected] || selected : "默认规则";
  const owners = settings.targetProfiles.filter((profile) => selected && profile.bundleIds.includes(selected));
  const resolution = resolveTargetProfile({ bundleId: selected, isTargetReady: false, groups: settings.promptGroups, profiles: settings.targetProfiles, defaultProfileId: settings.defaultTargetProfileId, privacyCapabilityActive: settings.firewallEnabled });
  const sourceProfile = settings.targetProfiles.find((profile) => profile.id === resolution.profileId);
  const baseline = applicationRuleValues(resolution.profile);
  const key = selected ?? DEFAULT_SELECTION;
  const draft = drafts[key];
  const resetting = Boolean(draft?.resetToDefault);
  const dirty = Boolean(draft && (resetting || !equalApplicationRuleValues(draft.values, draft.baseline)));
  const defaultProfile = settings.targetProfiles.find(profile => profile.id === settings.defaultTargetProfileId);
  const signatureValues = { profile: sourceProfile, owners: owners.map((profile) => profile.id), fallback: resolution.source === "fallback", isDefault: sourceProfile?.id === settings.defaultTargetProfileId };
  const signature = JSON.stringify({ ...signatureValues, ...(resetting ? { defaultProfile } : {}) });
  const stale = Boolean(dirty && draft?.signature !== signature);
  const values = dirty ? draft!.values : baseline;
  const scope = selected && owners.length ? draft?.scope ?? "app" : selected ? "app" : "shared";
  const canShare = Boolean(selected && owners.length === 1 && !resetting);
  const conflicts = owners.length > 1;
  const editableProfile = { ...(resetting && defaultProfile ? defaultProfile : resolution.profile), ...values };
  const otherDrafts = Object.entries(drafts).filter(([id, value]) => id !== key && (value.resetToDefault || !equalApplicationRuleValues(value.values, value.baseline))).length;
  const visibleApps = apps.filter((app) => `${names[app.bundleId] || app.appName} ${app.bundleId} ${settings.targetProfiles.find(profile => profile.bundleIds.includes(app.bundleId))?.name || "使用默认规则"}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  const selectApp = (bundleId: string | null) => {
    touched.current = true;
    pickSequence.current += 1;
    setPicking(false);
    setSelected(bundleId);
    setError(null);
  };
  const changeDraft = (valuePatch: Partial<ApplicationRuleValues>, nextScope = scope) => {
    if (isDataOperationLocked() || stale || conflicts || resetting || !sourceProfile) return;
    setError(null);
    setDrafts((previous) => ({ ...previous, [key]: { values: { ...values, ...valuePatch }, baseline: dirty ? draft!.baseline : baseline, signature: dirty ? draft!.signature : signature, scope: nextScope } }));
  };
  const discard = () => {
    setDrafts((previous) => { const next = { ...previous }; delete next[key]; return next; });
    setError(null);
  };
  const restoreDefault = () => {
    if (isDataOperationLocked() || !selected || owners.length !== 1 || stale || !sourceProfile || !defaultProfile) return;
    const fallback = resolveTargetProfile({ bundleId: null, isTargetReady: false, groups: settings.promptGroups, profiles: settings.targetProfiles, defaultProfileId: settings.defaultTargetProfileId, privacyCapabilityActive: settings.firewallEnabled });
    setDrafts(previous => ({ ...previous, [key]: { values: applicationRuleValues(fallback.profile), baseline, signature: JSON.stringify({ ...signatureValues, defaultProfile }), scope: "app", resetToDefault: true } }));
    setError(null);
  };
  const apply = () => {
    if (isDataOperationLocked() || !dirty || stale || !sourceProfile) return;
    const result = applyApplicationRuleDraft({ profiles: settings.targetProfiles, defaultProfileId: settings.defaultTargetProfileId, bundleId: selected, sourceProfileId: sourceProfile.id, scope, values, appName, newProfileId: crypto.randomUUID(), resetToDefault: resetting });
    if (!result.ok) {
      setError(result.error === "binding-conflict" ? "此应用有重复绑定，请先在上方解决冲突。" : "应用规则已发生变化，请重新载入后再修改。");
      return;
    }
    patch({ targetProfiles: result.profiles });
    discard();
    tip("ok", resetting ? `${appName} 已恢复默认规则` : selected && scope === "app" ? `已应用到 ${appName}` : "已应用共享规则");
  };
  const pickApp = async () => {
    if (isDataOperationLocked() || picking) return;
    const sequence = ++pickSequence.current;
    setPicking(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      if (sequence !== pickSequence.current || isDataOperationLocked()) return;
      const picked = await open({ multiple: false, defaultPath: "/Applications", filters: [{ name: "应用程序", extensions: ["app"] }] });
      if (typeof picked !== "string" || sequence !== pickSequence.current || isDataOperationLocked()) return;
      const bundleId = await api.bundleIdOfApp(picked);
      if (sequence !== pickSequence.current || isDataOperationLocked()) return;
      if (!bundleId || bundleId === TOSKR_BUNDLE_ID) { setError("请选择需要接收粘贴内容的其他应用。"); return; }
      setExtraApps((previous) => previous.some(app => app.bundleId === bundleId) ? previous : [...previous, { bundleId, appName: bundleId }]);
      selectApp(bundleId);
      setQuery("");
    } catch {
      if (sequence === pickSequence.current) setError("无法选择应用，请稍后重试。");
    } finally {
      if (sequence === pickSequence.current) setPicking(false);
    }
  };

  return (
    <div className="@container min-w-0">
      <div className="grid min-w-0 gap-4 @lg:flex @lg:items-start">
        <section aria-label="应用列表" className="min-w-0 space-y-2 @lg:w-44 @lg:shrink-0">
          <label className="relative block">
            <Search aria-hidden className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
            <input value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索应用或方案" placeholder="搜索应用" className="h-8 w-full rounded-lg border border-border bg-background pl-7 pr-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </label>
          <Button size="sm" aria-pressed={!selected} onClick={() => selectApp(null)} className={cn("h-auto w-full justify-start gap-2 whitespace-normal px-2 py-2 text-left", !selected && "border-primary/50 bg-primary/10 text-primary hover:bg-primary/10")}>
            <Settings2 aria-hidden className="size-5 shrink-0" /><span><span className="block text-body">默认规则</span><span className="block text-micro font-normal text-muted-foreground">未单独设置的应用</span></span>
          </Button>
          <div className="grid max-h-64 grid-cols-2 gap-1 overflow-y-auto @lg:max-h-none @lg:grid-cols-1" onKeyDown={event => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-application-select]")];
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            if (index < 0 || !buttons.length) return;
            event.preventDefault();
            buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
          }}>
            {apps.map(app => <ApplicationRow key={app.bundleId} app={app} profiles={settings.targetProfiles} defaultProfileId={settings.defaultTargetProfileId} currentBundleId={currentTarget?.bundleId ?? null} selected={selected === app.bundleId} query={query} onSelect={() => selectApp(app.bundleId)} onName={recordName} />)}
          </div>
          {!visibleApps.length && <p className="py-2 text-label text-muted-foreground">{apps.length ? "没有匹配的应用" : "选择一个应用，为它设置粘贴规则。"}</p>}
          <Button size="sm" disabled={picking || locked} onClick={() => void pickApp()} className="w-full"><FolderOpen aria-hidden className="size-3.5" />{picking ? "正在选择…" : "选择应用…"}</Button>
          {otherDrafts > 0 && <p className="text-micro text-muted-foreground">另有 {otherDrafts} 个应用的修改尚未应用。</p>}
        </section>

        <article aria-labelledby="application-rule-title" className="min-w-0 rounded-xl border border-border/70 bg-card p-3 @lg:flex-1">
          <header className="mb-3 flex min-w-0 items-center gap-2">
            {selected ? <AppIcon bundleId={selected} appName={appName} size="md" /> : <Settings2 aria-hidden className="size-6 text-muted-foreground" />}
            <div className="min-w-0"><h3 id="application-rule-title" className="break-words text-heading font-semibold">{appName}</h3><p className="text-label text-muted-foreground">{selected ? "设置此应用以后的粘贴行为" : "未绑定应用使用这套默认规则"}</p></div>
          </header>
          <section aria-label="规则影响范围" className="mb-3 space-y-2 rounded-lg bg-muted/35 p-2.5">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="min-w-0"><p className="break-words text-body font-medium">{sourceProfile?.name ?? "默认规则"}</p>{selected && <p className="text-micro text-muted-foreground">{owners.length === 0 ? "尚未单独设置，当前使用默认规则" : `共 ${sourceProfile?.bundleIds.length ?? 0} 个应用使用此方案`}</p>}</div>
              {canShare && <Segmented<"app" | "shared"> ariaLabel="修改范围" value={scope} options={[{ value: "app", label: "仅此应用" }, { value: "shared", label: "共享方案" }]} onChange={nextScope => changeDraft({}, nextScope)} />}
            </div>
            {!!sourceProfile?.bundleIds.length && <div className="flex min-w-0 flex-wrap gap-1" aria-label="共享此方案的应用">{sourceProfile.bundleIds.map(bundleId => <SharedApplicationName key={bundleId} bundleId={bundleId} />)}</div>}
            <p className="text-label text-muted-foreground">{resetting ? "待恢复默认：应用后此应用改为跟随默认规则，原方案和其他应用不变。" : !selected ? "默认规则固定为不自动回车、敏感内容逐项处理；绑定此方案的应用会一起更新格式、面板和模板排序。" : scope === "shared" ? `修改会同时影响上方全部应用${sourceProfile?.id === settings.defaultTargetProfileId ? "，以及未单独设置应用的默认格式、面板和模板排序" : ""}。` : owners.length === 1 && sourceProfile?.bundleIds.length === 1 && sourceProfile.id !== settings.defaultTargetProfileId ? "这套规则仅用于当前应用。" : "应用修改时，为当前应用建立独立规则，其他应用保持原设置。"}</p>
          </section>
          {conflicts && <p role="alert" className="mb-3 rounded-lg bg-warning/10 p-2 text-label text-warning">此应用有重复绑定，请先在上方选择唯一保留方案。</p>}
          {stale && <div role="alert" className="mb-3 space-y-2 rounded-lg bg-warning/10 p-2 text-label text-warning"><p>此应用的规则或绑定已在其他位置更改。当前草稿已保留，请重新载入后再编辑。</p><Button size="sm" onClick={discard}>放弃草稿并载入最新规则</Button></div>}
          {error && <p role="alert" className="mb-3 text-label text-warning">{error}</p>}
          <fieldset disabled={locked || stale || conflicts || resetting || !sourceProfile} className="min-w-0 disabled:opacity-60">
            <legend className="sr-only">{appName} 的粘贴规则</legend>
            <ApplicationRuleFields profile={editableProfile} groups={settings.promptGroups} snippets={settings.promptSnippets} firewallEnabled={settings.firewallEnabled} fallback={!selected || resetting} onUpdate={changeDraft} />
          </fieldset>
          <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
            <p role="status" className="text-micro text-muted-foreground">{locked ? "数据操作期间暂停修改" : resetting ? "待恢复默认，点击应用后生效" : dirty ? "有尚未应用的修改" : "当前规则已应用"}</p>
            <div className="flex flex-wrap gap-1.5">{selected && <Button size="sm" disabled={owners.length !== 1 || resetting || stale || locked || !sourceProfile || !defaultProfile} title={owners.length === 0 ? "当前应用已使用默认规则" : "仅解除当前应用的规则绑定，原方案和其他应用保持不变"} onClick={restoreDefault}>恢复默认</Button>}<Button size="sm" disabled={!dirty || locked} onClick={discard}>放弃修改</Button><Button size="sm" disabled={!dirty || stale || conflicts || locked || !sourceProfile} onClick={apply}>{selected && scope === "app" ? "应用到当前应用" : !selected ? "应用默认规则" : "应用到共享方案"}</Button></div>
          </footer>
        </article>
      </div>
    </div>
  );
}
