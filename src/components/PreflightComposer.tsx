import { ask } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  Image as ImageIcon,
  LocateFixed,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  VenetianMask,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { ApplicationIcon } from "@/components/ApplicationIcon";
import { ImageFirewallPanel } from "@/components/ImageFirewallPanel";
import { SimpleMenu, SimpleMenuItem } from "@/components/SimpleMenu";
import { SimpleSelect, type SimpleSelectOption } from "@/components/SimpleSelect";
import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import {
  inspectDeliveryDraft,
  inspectDeliveryDraftFreshness,
  inspectDeliveryDraftNonTarget,
  type DeliveryDraftStaleReason,
} from "@/lib/delivery/executeDraft";
import { evaluateDeliveryDraftFirewall } from "@/lib/delivery/firewallController";
import {
  evaluateDeliveryDraftImages,
  rescanOpenDeliveryDraftPrivacy,
  scanOpenDeliveryDraftPrivacy,
} from "@/lib/delivery/imageFirewall";
import {
  addAliasEntityFromText,
  aliasQuickAddCategories,
} from "@/lib/aliasQuickAdd";
import { activeAliasOccurrences } from "@/lib/delivery/aliasEntities";
import { findingSourceText } from "@/lib/privacy";
import {
  FIREWALL_CATEGORY_LABEL,
  FIREWALL_SEVERITY_LABEL,
} from "@/lib/delivery/firewall";
import {
  confirmOpenPreflightTargetChange,
  preflightStaleMessage,
  recoverOpenPreflightTarget,
  submitPreflightDraft,
  updateOpenPreflightDraft,
} from "@/lib/delivery/preflight";
import { imageListLabel } from "@/lib/format";
import { useNoteThumb } from "@/lib/media";
import { tip } from "@/lib/tip";
import { ENTER_POLICY_STATUS_LABEL } from "@/lib/targetLens";
import { api, type FirewallFinding } from "@/lib/tauri";
import { promptSnippetsForGroup } from "@/lib/targetProfiles";
import { cn } from "@/lib/utils";
import { useDeliveryStore } from "@/store/deliveryStore";
import { noteImages, useNotesStore } from "@/store/notesStore";
import { sameTargetIdentity, useTargetStore } from "@/store/targetStore";
import { closeOpenDraftWithTransforms } from "@/lib/aiTransform";

const FORMAT_OPTIONS = [
  { value: "plain", label: "纯文本" },
  { value: "code", label: "代码块" },
] as const satisfies readonly SimpleSelectOption<"plain" | "code">[];

const WARNING_LABEL: Record<string, string> = {
  "source-missing": "部分来源已不存在",
  "empty-payload": "正文和附件均为空",
};

function dialogFocusables(dialog: HTMLElement | null): HTMLElement[] {
  return Array.from(
    dialog?.querySelectorAll<HTMLElement>(
      'summary, button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? []
  ).filter((element) => element.offsetParent !== null);
}

function PreflightAttachment({
  files,
  index,
}: {
  files: string[];
  index: number;
}) {
  const url = useNoteThumb(files[index]);
  return (
    <li className="shrink-0">
      <button
        type="button"
        aria-label={`查看附件原图 ${index + 1}，共 ${files.length} 张`}
        title="点击查看原图"
        onClick={() => void api.quickLook(files, index)}
        className={cn(
          "relative flex size-14 cursor-zoom-in items-center justify-center overflow-hidden rounded-md",
          "border border-foreground/10 bg-background/70 outline-none hover:border-primary/40",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        )}
      >
        {url ? (
          <img src={url} alt="" className="size-full object-contain" />
        ) : (
          <ImageIcon className="size-4 text-muted-foreground" aria-hidden />
        )}
        <span
          aria-hidden
          className="absolute bottom-0.5 right-0.5 rounded-sm bg-black/60 px-1 text-micro tabular-nums text-white"
        >
          {index + 1}
        </span>
      </button>
    </li>
  );
}

export function PreflightComposer({ horizontal = false }: { horizontal?: boolean }) {
  const open = useDeliveryStore((state) => state.open);
  const draft = useDeliveryStore((state) => state.draft);
  const busy = useDeliveryStore((state) => state.busy);
  const activeSection = useDeliveryStore((state) => state.activeSection);
  const lastError = useDeliveryStore((state) => state.lastError);
  const retryBlocked = useDeliveryStore((state) => state.retryBlocked);
  const safeRetryPending = useDeliveryStore((state) => state.safeRetryPending);
  const transformStatus = useDeliveryStore((state) => state.transform.status);
  const notes = useNotesStore((state) => state.notes);
  const tasks = useNotesStore((state) => state.tasks);
  const settings = useNotesStore((state) => state.settings);
  const checkedIds = useNotesStore((state) => state.checkedIds);
  const targetSnapshot = useTargetStore((state) => state.snapshot);
  const targetStatus = useTargetStore((state) => state.status);
  const targetIcon = useTargetStore((state) => state.icon);
  const profileOverrideNeedsConfirmation = useTargetStore(
    (state) => state.profileOverrideNeedsConfirmation
  );
  const profileOverrideId = useTargetStore((state) => state.profileOverrideId);
  const profileOverrideTargetIdentity = useTargetStore(
    (state) => state.profileOverrideTargetIdentity
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const finalTextRef = useRef<HTMLTextAreaElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const staleCacheRef = useRef<{
    inputs: readonly unknown[];
    reason: DeliveryDraftStaleReason | null;
    hiddenReason: DeliveryDraftStaleReason | null;
    freshnessReason: DeliveryDraftStaleReason | null;
  } | null>(null);

  // 手工正文和回车/保留开关不会改变来源新鲜度；排除这些高频字段，
  // 避免长正文每次按键都重建完整 Draft。submit 时仍执行一次 live 全量检查。
  const freshnessInputs: readonly unknown[] = [
    checkedIds,
    draft?.assembledText,
    draft?.dataGeneration,
    draft?.enterPolicy,
    draft?.format,
    draft?.id,
    draft?.originalImageFiles,
    draft?.privacyPolicy,
    draft?.profileDefaultFormat,
    draft?.profileKeepPanel,
    draft?.profileSource,
    draft?.promptGroupId,
    draft?.promptSnippetId,
    draft?.promptSnippetGroupId,
    draft?.promptTemplate,
    draft?.rawText,
    draft?.selectionItemIds,
    draft?.sourceItemIds,
    draft?.sourceKind,
    draft?.targetProfileId,
    draft?.targetSnapshot,
    notes,
    profileOverrideId,
    profileOverrideNeedsConfirmation,
    profileOverrideTargetIdentity,
    safeRetryPending,
    settings.defaultTargetProfileId,
    settings.promptGroups,
    settings.promptSnippets,
    settings.targetProfiles,
    targetSnapshot,
    targetStatus,
    tasks,
  ];
  const cachedStale = staleCacheRef.current;
  if (
    !cachedStale ||
    cachedStale.inputs.length !== freshnessInputs.length ||
    freshnessInputs.some((value, index) => cachedStale.inputs[index] !== value)
  ) {
    const reason = draft ? inspectDeliveryDraft(draft) : null;
    staleCacheRef.current = {
      inputs: freshnessInputs,
      reason,
      hiddenReason:
        draft && safeRetryPending && reason === "target"
          ? inspectDeliveryDraftNonTarget(draft)
          : null,
      freshnessReason:
        draft && reason === "target"
          ? inspectDeliveryDraftFreshness(draft)
          : null,
    };
  }
  const staleReason = staleCacheRef.current?.reason ?? null;
  const hiddenStaleReason = staleCacheRef.current?.hiddenReason ?? null;
  const targetFreshnessReason = staleCacheRef.current?.freshnessReason ?? null;
  const readyDifferentTarget = Boolean(
    staleReason === "target" &&
    targetStatus === "ready" &&
    targetSnapshot?.ready &&
    !sameTargetIdentity(draft?.targetSnapshot ?? null, targetSnapshot)
  );
  const showTargetChangeAction = Boolean(
    readyDifferentTarget &&
    !profileOverrideNeedsConfirmation &&
    !targetFreshnessReason &&
    !retryBlocked
  );
  const canConfirmTargetChange = Boolean(
    showTargetChangeAction && !busy && transformStatus !== "running"
  );
  const visibleStaleReason = readyDifferentTarget && targetFreshnessReason
    ? targetFreshnessReason
    : showTargetChangeAction
      ? staleReason
      : hiddenStaleReason ?? staleReason;
  const staleMessage = preflightStaleMessage(visibleStaleReason);
  const currentTargetName =
    targetSnapshot?.appName || targetSnapshot?.bundleId || "新目标";
  const sourceItemIds = draft?.sourceItemIds;
  const sourceKind = draft?.sourceKind;
  const sourceLabels = useMemo(() => {
    if (!sourceItemIds || !sourceKind) return [];
    const noteById = new Map(notes.map((note) => [note.id, note]));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    return sourceItemIds.map((id, index) => {
      if (sourceKind === "task") {
        const task = taskById.get(id);
        return task?.text.split("\n", 1)[0] || `已删除任务 ${index + 1}`;
      }
      const note = noteById.get(id);
      if (!note) return `已删除卡片 ${index + 1}`;
      if (note.kind === "image") {
        return imageListLabel(note, noteImages(note).length);
      }
      return (note.title || note.text).split("\n", 1)[0] || `空卡片 ${index + 1}`;
    });
  }, [notes, sourceItemIds, sourceKind, tasks]);
  const promptGroupId = draft?.promptGroupId;
  const promptMenu = useMemo(
    () =>
      promptGroupId
        ? promptSnippetsForGroup(settings.promptSnippets, promptGroupId)
        : { prioritized: [], remaining: [] },
    [promptGroupId, settings.promptSnippets]
  );
  const draftPromptSnippetId = draft?.promptSnippetId;
  const draftPromptTemplate = draft?.promptTemplate;
  const promptOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: SimpleSelectOption[] = [{ value: "none", label: "无模板" }];
    for (const snippet of [...promptMenu.prioritized, ...promptMenu.remaining]) {
      if (seen.has(snippet.id)) continue;
      seen.add(snippet.id);
      options.push({ value: snippet.id, label: snippet.label });
    }
    if (draftPromptTemplate && !draftPromptSnippetId) {
      options.push({ value: "custom", label: "本次自定义模板" });
    }
    return options;
  }, [draftPromptSnippetId, draftPromptTemplate, promptMenu]);
  const promptValue = draftPromptSnippetId ?? (draftPromptTemplate ? "custom" : "none");
  const targetProfileId = draft?.targetProfileId;
  const profileName = useMemo(
    () =>
      targetProfileId
        ? settings.targetProfiles.find((item) => item.id === targetProfileId)
            ?.name ?? targetProfileId
        : "",
    [settings.targetProfiles, targetProfileId]
  );
  const hasPayload = Boolean(draft && (draft.finalText || draft.imageFiles.length));
  const enterReady = Boolean(
    draft && (draft.enterPolicy !== "confirm" || draft.enterDecisionConfirmed)
  );
  const enterDecisionLabel = draft?.enterPolicy === "confirm" &&
    !draft.enterDecisionConfirmed
    ? "本次尚未确认"
    : draft?.safeRehearsal
      ? "演练安全锁：只粘贴，不按回车"
      : `本次${draft?.pressEnter ? "会按回车" : "不按回车"}`;
  const canRecoverTarget = safeRetryPending &&
    staleReason === "target" &&
    !hiddenStaleReason;
  const firewall = draft ? evaluateDeliveryDraftFirewall(draft) : null;
  const imageFirewall = draft ? evaluateDeliveryDraftImages(draft) : null;
  const firewallSummary = useMemo(() => {
    const summary = new Map<
      string,
      {
        category: FirewallFinding["category"];
        severity: FirewallFinding["severity"];
        count: number;
      }
    >();
    for (const finding of draft?.findings ?? []) {
      const current = summary.get(finding.category);
      summary.set(finding.category, {
        category: finding.category,
        severity:
          current?.severity === "block" || finding.severity === "block"
            ? "block"
            : finding.severity,
        count: (current?.count ?? 0) + 1,
      });
    }
    return [...summary.values()];
  }, [draft?.findings]);
  const draftFinalText = draft?.finalText;
  // 铁律：占位符出现列表在 useMemo 派生，绝不放进 zustand 选择器
  const aliasOccurrences = useMemo(
    () =>
      draftFinalText && settings.aliasEntitiesEnabled
        ? activeAliasOccurrences(
            draftFinalText,
            settings.aliasEntities,
            settings.aliasCustomCategories
          )
        : [],
    [
      draftFinalText,
      settings.aliasCustomCategories,
      settings.aliasEntities,
      settings.aliasEntitiesEnabled,
    ]
  );
  const canSubmit = Boolean(
    draft &&
    !busy &&
    !retryBlocked &&
    (!staleMessage || canRecoverTarget) &&
    hasPayload &&
    enterReady &&
    firewall?.canSend &&
    imageFirewall?.canSend
    && transformStatus !== "running"
  );
  // 目标失效时按场景给出恢复路径，而不是只报状态：
  // ① 已识别到另一个 ready 目标 → 显式确认并重算方案；② 方案待确认 → 指去目标条；
  // ③ 人在别的应用 → 切回即自动恢复（由下方 effect 调 recoverOpenPreflightTarget 兑现）
  const draftTargetName =
    draft?.targetSnapshot?.appName || draft?.targetSnapshot?.bundleId || "目标应用";
  const staleTargetGuidance =
    visibleStaleReason === "target" && !canRecoverTarget
      ? showTargetChangeAction
        ? `当前为 ${currentTargetName}，确认后将重算发送方案`
        : profileOverrideNeedsConfirmation
        ? "在面板目标条确认本次发送方案后可继续"
        : `切回 ${draftTargetName} 后这里会自动恢复`
      : null;
  const staleDisplay = staleMessage
    ? staleTargetGuidance
      ? `${staleMessage} · ${staleTargetGuidance}`
      : staleMessage
    : null;
  /** 发送按钮被禁用的唯一人话解释；底栏状态行与按钮 tooltip 共用。 */
  const submitBlockedReason = canSubmit || busy || !draft
    ? null
    : staleDisplay && !canRecoverTarget
      ? staleDisplay
      : !hasPayload
        ? "正文与附件为空，没有可发送的内容"
        : firewall && !firewall.canSend
          ? firewall.reason ?? "本地隐私检查未通过"
          : imageFirewall && !imageFirewall.canSend
            ? imageFirewall.reason ?? "图片隐私检查未通过"
            : !enterReady
              ? "请先在上方确认粘贴后是否按回车"
              : transformStatus === "running"
                ? "AI 处理进行中，完成后可发送"
                : retryBlocked
                  ? lastError ?? "上次发送未完成处理，暂不能重试"
                  : null;

  // 目标失效自动恢复：切回同一目标（仅 token 轮换）时静默重基线，兑现底栏「切回后自动恢复」的承诺
  useEffect(() => {
    if (!open || busy || staleReason !== "target") return;
    recoverOpenPreflightTarget();
  }, [open, busy, staleReason, targetSnapshot, targetStatus]);

  useEffect(() => {
    if (
      open &&
      (draft?.firewallStatus === "idle" ||
        draft?.imageFirewall.some((item) => item.status === "idle"))
    ) {
      const timer = window.setTimeout(() => {
        void scanOpenDeliveryDraftPrivacy();
      }, 160);
      return () => window.clearTimeout(timer);
    }
  }, [draft?.firewallStatus, draft?.id, draft?.imageFirewall, open]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    window.setTimeout(() => dialogRef.current?.focus(), 20);
    return () => {
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Tab" &&
        dialogRef.current &&
        !dialogRef.current.contains(document.activeElement)
      ) {
        const focusables = dialogFocusables(dialogRef.current);
        if (focusables.length) {
          event.preventDefault();
          event.stopImmediatePropagation();
          (event.shiftKey ? focusables.at(-1) : focusables[0])?.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!useDeliveryStore.getState().busy) {
          closeOpenDraftWithTransforms();
        }
        return;
      }
      if (event.key === "Enter" && event.metaKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void submitPreflightDraft();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open]);

  if (!open || !draft) return null;

  const close = () => {
    if (!busy) closeOpenDraftWithTransforms();
  };
  const showSummary = horizontal || activeSection === "summary";
  const showContent = horizontal || activeSection === "content";
  const targetName = draft.targetSnapshot?.appName ?? "未识别目标";
  const targetDisplayName = readyDifferentTarget
    ? `${targetName} → ${currentTargetName}`
    : targetName;
  const icon = readyDifferentTarget ||
      targetSnapshot?.bundleId === draft.targetSnapshot?.bundleId
    ? targetIcon?.url
    : null;
  const excludedFindingIds = new Set(
    draft.privacyDecision.excludedFindingIds
  );
  const locateFinding = (start: number, end: number) => {
    useDeliveryStore.getState().setActiveSection("content");
    window.setTimeout(() => {
      finalTextRef.current?.focus();
      finalTextRef.current?.setSelectionRange(start, end);
    });
  };
  /** 隐私命中一键升级为词典实体；草稿未被手工编辑时顺带重建（自动替换+重扫描）。 */
  const addFindingToAliasDictionary = (
    finding: FirewallFinding,
    category: string
  ) => {
    if (!draft) return;
    const source = findingSourceText(draft.finalText, finding);
    if (!source) {
      tip("warn", "该命中位置已变化，请重新检测后再加入词典");
      return;
    }
    if (!addAliasEntityFromText(source, category)) return;
    if (draft.finalText === draft.assembledText) {
      // 无手工编辑：重建草稿让新词条立即生效（自动替换 + 隐私重扫描）
      updateOpenPreflightDraft({});
    } else {
      tip("info", "词条已保存；本次正文已手工编辑，可点「重新检测」应用替换");
    }
  };

  const privacyPolicyLabel = {
    requireRedaction: "敏感项须替换或明确保留后才能发送",
    confirmRaw: "高风险须处理；提示级可确认后保留",
    allowRaw: "允许原文发送；高风险需二次确认",
  }[draft.privacyPolicy];
  const privacyScanPending =
    draft.firewallStatus === "idle" || draft.firewallStatus === "scanning" ||
    draft.imageFirewall.some((item) =>
      item.status === "idle" || item.status === "scanning" || item.status === "redacting"
    );
  const hasImageRedactions = draft.imageFirewall.some(
    (item) => item.sendFile !== item.originalFile
  );
  const privacyRescanLabel = draft.imageFirewall.length
    ? "重新检测当前文本和原始图片"
    : "重新检测当前文本";
  const rerunPrivacyScan = async () => {
    const expectedDraftId = draft.id;
    if (hasImageRedactions) {
      let confirmed = false;
      try {
        confirmed = await ask(
          "重新检测会恢复图片为原图，并清除已完成的遮挡；检测后需要重新处理。是否继续？",
          { title: "重新检测隐私内容", kind: "warning" }
        );
      } catch {
        tip("warn", "无法确认重新检测，请稍后重试");
        return;
      }
      if (!confirmed) return;
    }
    if (useDeliveryStore.getState().draft?.id !== expectedDraftId) return;
    const completed = await rescanOpenDeliveryDraftPrivacy();
    const current = useDeliveryStore.getState();
    const live = current.draft;
    if (!current.open || live?.id !== expectedDraftId) return;
    if (!completed) {
      tip("warn", "本次重新检测已失效，请在内容稳定后重试");
      return;
    }
    const incomplete = live.firewallStatus === "failed" ||
      live.firewallStatus === "incomplete" ||
      live.imageFirewall.some((item) => item.status === "failed");
    if (incomplete) {
      tip("warn", "重新检测完成，但有内容未能完整检查");
      return;
    }
    const findingCount = live.findings.length + live.imageFirewall.reduce(
      (total, item) => total + item.findings.length,
      0
    );
    tip(
      "ok",
      findingCount
        ? `重新检测完成，发现 ${findingCount} 项可能的敏感内容`
        : "重新检测完成，未发现敏感内容"
    );
  };

  return (
    <>
      <div
        className="absolute inset-0 z-50 bg-black/40 backdrop-blur-[2px]"
        aria-hidden="true"
        onClick={close}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preflight-title"
        aria-describedby="preflight-status"
        tabIndex={-1}
        className={cn(
          "absolute inset-3 z-50 flex min-h-0 flex-col overflow-hidden rounded-xl outline-none",
          floatingSurface(3)
        )}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusables = dialogFocusables(dialogRef.current);
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = document.activeElement;
          if (active === dialogRef.current || !dialogRef.current?.contains(active)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          } else if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <h2 id="preflight-title" className="text-title font-semibold">
              {draft.safeRehearsal ? "安全发送演练预检" : "发送预检"}
            </h2>
            <p className="truncate text-micro text-muted-foreground">
              {draft.safeRehearsal
                ? "真实目标 · 假数据 · 只粘贴"
                : "确认目标、内容与粘贴后动作"}
            </p>
          </div>
          {!horizontal && (
            <div className="flex rounded-lg bg-muted/70 p-0.5" role="tablist" aria-label="预检分区">
              {(["summary", "content"] as const).map((section) => (
                <Button
                  key={section}
                  type="button"
                  role="tab"
                  size="xs"
                  variant={activeSection === section ? "secondary" : "ghost"}
                  aria-selected={activeSection === section}
                  onClick={() => useDeliveryStore.getState().setActiveSection(section)}
                >
                  {section === "summary" ? "概览" : "内容"}
                </Button>
              ))}
            </div>
          )}
          <IconButton label="关闭发送预检" size="xs" disabled={busy} onClick={close}>
            <X />
          </IconButton>
        </header>

        <div
          className={cn(
            "min-h-0 flex-1 gap-2 p-2",
            horizontal
              ? "grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] overflow-hidden"
              : "flex flex-col overflow-hidden"
          )}
        >
          <section
            aria-label="发送概览"
            className={cn(
              "min-h-0 space-y-2 overflow-y-auto rounded-lg bg-muted/30 p-2",
              !showSummary && "hidden"
            )}
          >
            <div className="flex items-center gap-2">
              <ApplicationIcon src={icon} name={targetDisplayName} className="size-8 rounded-lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body font-medium">{targetDisplayName}</p>
                <p className="text-micro text-muted-foreground">
                  {readyDifferentTarget
                    ? "待确认新目标"
                    : staleReason === "target"
                      ? "目标已变化"
                      : "可发送"}
                </p>
              </div>
              <span className="rounded-md bg-secondary px-1.5 py-0.5 text-micro">
                {readyDifferentTarget ? "待重算方案" : profileName}
              </span>
            </div>

            <details className="rounded-lg border border-border/70 p-2">
              <summary className="cursor-pointer text-label font-medium">
                来源 {draft.sourceItemIds.length} 项
              </summary>
              <ol className="mt-1 space-y-1 pl-4 text-label text-muted-foreground">
                {sourceLabels.map((label, index) => (
                  <li key={`${draft.sourceItemIds[index]}-${index}`} className="list-decimal truncate">
                    {label}
                  </li>
                ))}
              </ol>
            </details>

            {draft.imageFirewall.length > 0 && (
              <ImageFirewallPanel
                draft={draft}
                busy={busy}
                evaluation={imageFirewall!}
              />
            )}

            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-label">
                <span className="text-muted-foreground">提示词模板</span>
                <SimpleSelect
                  value={promptValue}
                  options={promptOptions}
                  ariaLabel="本次提示词模板"
                  size="micro"
                  disabled={busy}
                  onChange={(value) => {
                    if (value === "custom") return;
                    const snippet = settings.promptSnippets.find((item) => item.id === value);
                    updateOpenPreflightDraft({
                      promptSnippetId: snippet?.id ?? null,
                      promptTemplate: snippet?.text ?? null,
                    });
                  }}
                />
              </label>
              <label className="space-y-1 text-label">
                <span className="text-muted-foreground">输出格式</span>
                <SimpleSelect
                  value={draft.format}
                  options={FORMAT_OPTIONS}
                  ariaLabel="本次输出格式"
                  size="micro"
                  disabled={busy}
                  onChange={(format) => updateOpenPreflightDraft({ format })}
                />
              </label>
            </div>

            {draft.promptTemplate && (
              <pre className="max-h-16 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background/60 p-2 font-mono text-micro text-muted-foreground">
                {draft.promptTemplate}
              </pre>
            )}

            <div className="space-y-1 rounded-lg border border-border/70 p-2 text-label">
              <p>
                粘贴后动作：{ENTER_POLICY_STATUS_LABEL[draft.enterPolicy]}
                <span className="text-muted-foreground">
                  {` · ${enterDecisionLabel}`}
                </span>
              </p>
              {draft.safeRehearsal ? (
                <p role="status" className="font-medium text-success">
                  演练安全锁：只粘贴，不按回车
                </p>
              ) : draft.enterPolicy === "confirm" && (
                <fieldset className="space-y-1">
                  <legend className="sr-only">选择本次粘贴后的回车动作</legend>
                  {([
                    [false, "本次不按回车"],
                    [true, "本次粘贴后按回车"],
                  ] as const).map(([pressEnter, label]) => (
                    <label key={label} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="preflight-enter-decision"
                        checked={
                          draft.enterDecisionConfirmed &&
                          draft.pressEnter === pressEnter
                        }
                        disabled={busy}
                        onChange={() =>
                          useDeliveryStore.getState().confirmEnter(pressEnter)
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              )}
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={draft.keepPanel}
                  disabled={busy || draft.safeRehearsal}
                  onChange={(event) =>
                    useDeliveryStore.getState().setKeepPanel(event.target.checked)
                  }
                />
                发送后保留面板
              </label>
            </div>

            {draft.warnings.length > 0 && (
              <div role="status" aria-label="发送警告" className="rounded-lg bg-warning/10 p-2 text-label text-warning">
                <p className="mb-1 flex items-center gap-1 font-medium">
                  <AlertTriangle className="size-3" /> 当前警告
                </p>
                <ul className="space-y-0.5">
                  {draft.warnings.map((warning) => (
                    <li key={warning}>· {WARNING_LABEL[warning] ?? warning}</li>
                  ))}
                </ul>
              </div>
            )}

            {aliasOccurrences.length > 0 && (
              <section
                aria-label="可逆化名"
                className="space-y-2 rounded-lg border border-border/70 p-2"
              >
                <div className="flex items-center gap-1.5">
                  <VenetianMask
                    className="size-3.5 text-muted-foreground"
                    aria-hidden
                  />
                  <p className="text-label font-medium">可逆化名</p>
                  <span
                    aria-live="polite"
                    className="ml-auto shrink-0 text-micro text-muted-foreground"
                  >
                    已自动替换 {aliasOccurrences.length} 处
                  </span>
                </div>
                <ul className="space-y-1" aria-label="化名替换列表">
                  {aliasOccurrences.map((occurrence) => (
                    <li
                      key={`${occurrence.entityId}:${occurrence.startUtf16}`}
                      className="flex items-center gap-1.5 rounded-md bg-background/60 p-1.5"
                    >
                      <span className="shrink-0 rounded-sm bg-muted/60 px-1 py-0.5 text-micro">
                        {occurrence.categoryLabel}
                      </span>
                      {/* 原文是用户自己录入的词条，直接展示便于核对，不属于 per-delivery 临时映射的脱敏范畴 */}
                      <code className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
                        {occurrence.originalText} → {occurrence.placeholder}
                      </code>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          useDeliveryStore.getState().revertAliasFinding(occurrence)}
                      >
                        还原为原文
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="text-micro text-muted-foreground">
                  已按词典自动替换，发送后可在本机恢复；如需保留原文可逐项还原（仅本次发送有效）
                </p>
              </section>
            )}

            <section
              aria-label="本地隐私检查"
              className="space-y-2 rounded-lg border border-border/70 p-2"
            >
              <div className="flex items-center gap-1.5">
                <ShieldAlert className="size-3.5 text-warning" aria-hidden />
                <p className="text-label font-medium">本地隐私检查</p>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <span aria-live="polite" className="text-micro text-muted-foreground">
                    {draft.firewallStatus === "disabled"
                      ? "已关闭"
                      : draft.firewallStatus === "scanning"
                        ? "扫描中…"
                        : draft.firewallStatus === "ready"
                          ? draft.findings.length
                            ? `${draft.findings.length} 项待处理`
                            : "无待处理项"
                          : draft.firewallStatus === "incomplete"
                            ? "检查不完整"
                            : draft.firewallStatus === "failed"
                              ? "检查失败"
                              : "等待检查"}
                  </span>
                  {draft.firewallEnabled && (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label={privacyRescanLabel}
                      title={privacyRescanLabel}
                      disabled={busy || privacyScanPending}
                      onClick={() => void rerunPrivacyScan()}
                    >
                      <RefreshCw
                        aria-hidden
                        className={cn(
                          "size-3",
                          privacyScanPending && "animate-spin motion-reduce:animate-none"
                        )}
                      />
                      {privacyScanPending ? "检测中" : "重新检测"}
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-micro text-muted-foreground">
                {privacyPolicyLabel} · 检测可能存在误报或漏报
              </p>
              {draft.firewallStatus === "ready" && draft.findings.length === 0 && (
                <p role="status" className="text-label text-success">
                  {draft.privacyDecision.replacedCount > 0
                    ? `已替换 ${draft.privacyDecision.replacedCount} 处敏感内容，本项检查通过`
                    : "未发现敏感内容，本项检查通过"}
                </p>
              )}
              {draft.findings.length > 0 && firewall?.canSend && (
                <p role="status" className="text-label text-success">
                  敏感项已全部处理，可以发送
                </p>
              )}
              {firewallSummary.length > 0 && (
                <div className="flex flex-wrap gap-1" aria-label="敏感项分类汇总">
                  {firewallSummary.map((item) => (
                    <span
                      key={item.category}
                      className={cn(
                        "rounded-sm px-1.5 py-0.5 text-micro",
                        item.severity === "block"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-warning/10 text-warning"
                      )}
                    >
                      {FIREWALL_CATEGORY_LABEL[item.category]} · {FIREWALL_SEVERITY_LABEL[item.severity]} ×{item.count}
                    </span>
                  ))}
                </div>
              )}
              {draft.findings.length > 0 && (
                <>
                  <p className="text-micro text-muted-foreground">
                    推荐替换为占位符（本机替换、发出的是占位符）；确需按原文发出时选「保留原文发送」
                  </p>
                  <ul className="space-y-1.5" aria-label="敏感项列表">
                    {draft.findings.map((finding) => {
                      const excluded = excludedFindingIds.has(finding.id);
                      return (
                        <li
                          key={finding.id}
                          className="rounded-md bg-background/60 p-1.5"
                        >
                          <div className="flex items-center gap-1 text-label">
                            <span className="font-medium">
                              {FIREWALL_CATEGORY_LABEL[finding.category]}
                            </span>
                            <span className={cn(
                              "rounded-sm px-1 py-0.5 text-micro",
                              finding.severity === "block"
                                ? "bg-destructive/10 text-destructive"
                                : "bg-warning/10 text-warning"
                            )}>
                              {FIREWALL_SEVERITY_LABEL[finding.severity]}
                            </span>
                            <code className="min-w-0 flex-1 truncate text-right text-micro text-muted-foreground">
                              {finding.maskedPreview}
                            </code>
                            <IconButton
                              label="在正文中定位这一项"
                              size="2xs"
                              disabled={busy}
                              onClick={() => locateFinding(
                                finding.startUtf16,
                                finding.endUtf16
                              )}
                            >
                              <LocateFixed className="size-3" />
                            </IconButton>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            <Button
                              type="button"
                              size="xs"
                              variant="secondary"
                              disabled={busy}
                              onClick={() =>
                                useDeliveryStore.getState()
                                  .replaceFirewallFinding(finding.id)}
                            >
                              替换为占位符
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              disabled={busy}
                              onClick={() =>
                                useDeliveryStore.getState()
                                  .replaceFirewallCategory(finding.category)}
                            >
                              同类全部替换
                            </Button>
                            {finding.severity === "warn" && (
                              <SimpleMenu
                                side="bottom"
                                align="start"
                                trigger={({ toggle }) => (
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="ghost"
                                    disabled={busy}
                                    title="把这个值升级为持久词典实体：以后自动替换、捕获回复自动恢复"
                                    onClick={toggle}
                                  >
                                    加入词典
                                  </Button>
                                )}
                              >
                                {(close) => (
                                  <>
                                    {aliasQuickAddCategories(
                                      settings.aliasCustomCategories
                                    ).map((category) => (
                                      <SimpleMenuItem
                                        key={category.code}
                                        onClick={() => {
                                          close();
                                          addFindingToAliasDictionary(
                                            finding,
                                            category.code
                                          );
                                        }}
                                      >
                                        {category.label}
                                      </SimpleMenuItem>
                                    ))}
                                  </>
                                )}
                              </SimpleMenu>
                            )}
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              className="ml-auto text-muted-foreground"
                              title="不替换这一项，按原文发出（仅本次发送有效）"
                              disabled={busy || excluded}
                              onClick={() =>
                                useDeliveryStore.getState()
                                  .excludeFirewallFinding(finding.id)}
                            >
                              {excluded ? "已确认保留原文" : "保留原文发送"}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {draft.findings.length > 1 && (
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      disabled={busy}
                      title="把上面所有命中一次性替换为占位符"
                      onClick={() =>
                        useDeliveryStore.getState().replaceAllFirewallFindings()}
                    >
                      一键全部替换
                    </Button>
                  )}
                </>
              )}
              {firewall?.needsRawConfirmation && (
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    useDeliveryStore.getState().confirmRawPrivacy(
                      firewall.needsRawConfirmation!
                    )}
                >
                  {firewall.needsRawConfirmation === "block"
                    ? "再次确认保留高风险原文"
                    : "确认本次保留提示级原文"}
                </Button>
              )}
              {(firewall?.reason || imageFirewall?.reason) && (
                <p role="status" className="text-micro text-warning">
                  {firewall?.reason ?? imageFirewall?.reason}
                </p>
              )}
            </section>
          </section>

          <section
            aria-label="最终发送内容"
            className={cn(
              "min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg bg-muted/30 p-2",
              showContent ? "flex" : "hidden"
            )}
          >
            <div className="flex items-center gap-2">
              <label htmlFor="preflight-final-text" className="text-label font-medium">
                最终文本
              </label>
              <span className="ml-auto text-micro tabular-nums text-muted-foreground">
                {draft.finalText.length} 字符
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy || draft.finalText === draft.assembledText}
                onClick={() => useDeliveryStore.getState().resetFinalText()}
              >
                <RotateCcw className="size-3" /> 恢复自动组装
              </Button>
            </div>
            <textarea
              ref={finalTextRef}
              id="preflight-final-text"
              value={draft.finalText}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => useDeliveryStore.getState().setFinalText(event.target.value)}
              className="min-h-24 flex-1 resize-none rounded-lg border border-border bg-background/70 p-2 font-mono text-body leading-relaxed outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
            />
            {draft.originalImageFiles.length > 0 && (
              <div className="shrink-0 space-y-1">
                <div className="flex items-center gap-2">
                  <p className="text-label font-medium">附件</p>
                  <span className="ml-auto text-micro text-muted-foreground">
                    {draft.originalImageFiles.length} 张 · 点击查看原图
                  </span>
                </div>
                <ul
                  aria-label={`图片附件原图，共 ${draft.originalImageFiles.length} 张`}
                  className="flex gap-1.5 overflow-x-auto pb-0.5"
                >
                  {draft.originalImageFiles.map((file, index) => (
                    <PreflightAttachment
                      key={file}
                      files={draft.originalImageFiles}
                      index={index}
                    />
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-3 py-2">
          <p
            id="preflight-status"
            role="status"
            aria-live="polite"
            title={submitBlockedReason ?? undefined}
            className={cn(
              "line-clamp-2 min-w-0 flex-1 break-words text-label",
              submitBlockedReason || lastError
                ? "text-warning"
                : "text-muted-foreground"
            )}
          >
            {submitBlockedReason ?? lastError ??
              (draft.safeRehearsal
                ? "已就绪：演练只把最终文本粘贴到已确认目标，不会自动回车"
                : "已就绪 · 本次修改不会改动原始卡片")}
          </p>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={close}>
            取消
          </Button>
          {/* disabled 按钮 pointer-events 为 none，tooltip 挂到外层 span 才能悬停可见 */}
          <span
            title={
              showTargetChangeAction
                ? `确认将发送目标改为 ${currentTargetName}`
                : submitBlockedReason ?? undefined
            }
            className="shrink-0"
          >
            <Button
              type="button"
              size="sm"
              disabled={showTargetChangeAction ? !canConfirmTargetChange : !canSubmit}
              aria-describedby="preflight-status"
              aria-label={
                showTargetChangeAction
                  ? `确认将发送目标改为 ${currentTargetName}`
                  : undefined
              }
              onClick={() => {
                if (showTargetChangeAction) {
                  confirmOpenPreflightTargetChange({
                    expectedTarget: targetSnapshot,
                  });
                  return;
                }
                void submitPreflightDraft();
              }}
            >
              {showTargetChangeAction ? (
                <Check className="size-3.5" />
              ) : (
                <Send className="size-3.5" />
              )}
              {showTargetChangeAction
                ? canConfirmTargetChange
                  ? "确认新目标"
                  : "暂不可确认"
                : busy
                ? "发送中…"
                : canRecoverTarget
                  ? "重新识别并重试"
                  : draft.safeRehearsal
                    ? "安全粘贴"
                    : "确认发送"}
              {!showTargetChangeAction && <Kbd inline>⌘⏎</Kbd>}
            </Button>
          </span>
        </footer>
      </div>
    </>
  );
}
