import { currentDraftSegments, deliverySequencePreview } from "@/lib/delivery/orderedSegments";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Image as ImageIcon,
  LocateFixed,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  VenetianMask,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ApplicationIcon } from "@/components/ApplicationIcon";
import { ImageFirewallPanel } from "@/components/ImageFirewallPanel";
import { PromptTemplateSelect } from "@/components/PromptTemplateSelect";
import { SimpleMenu, SimpleMenuItem } from "@/components/SimpleMenu";
import { SimpleSelect, type SimpleSelectOption } from "@/components/SimpleSelect";
import { Button } from "@/components/ui/button";
import { floatingSurface } from "@/components/ui/floating-surface";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { SlidingTabIndicator } from "@/components/ui/sliding-tab-indicator";
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
import { activeAliasOccurrences, aliasCategoryDisplayLabel } from "@/lib/delivery/aliasEntities";
import { findingReason } from "@/lib/delivery/findingReason";
import { FindingInlineText } from "@/components/preflight/FindingInlineText";
import { SendPreviewText } from "@/components/preflight/SendPreviewText";
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
import { textareaSelectionAnchor } from "@/lib/selectionAnchor";
import { useNoteThumb } from "@/lib/media";
import { tip } from "@/lib/tip";
import { api, type FirewallFinding } from "@/lib/tauri";
import {
  promptSnippetsForGroup,
  type DeliveryOutputMode,
} from "@/lib/targetProfiles";
import { ENTER_POLICY_STATUS_LABEL } from "@/lib/targetLens";
import { useT, type MessageKey } from "@/lib/i18n";
import { profileName as profileDisplayName } from "@/lib/i18n/builtinNames";
import { cn } from "@/lib/utils";
import { useDeliveryStore } from "@/store/deliveryStore";
import { noteImages, useNotesStore } from "@/store/notesStore";
import { sameTargetIdentity, useTargetStore } from "@/store/targetStore";
import { closeOpenDraftWithTransforms } from "@/lib/aiTransform";

const FORMAT_OPTIONS = [
  { value: "plain", label: "原文" },
  { value: "strip-markdown", label: "无 Markdown" },
  { value: "code", label: "代码块" },
] as const satisfies readonly (SimpleSelectOption<DeliveryOutputMode> & { label: MessageKey })[];

const WARNING_LABEL: Record<string, MessageKey> = {
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
  const t = useT();
  const url = useNoteThumb(files[index]);
  return (
    <li className="shrink-0">
      <button
        type="button"
        aria-label={t("查看附件原图 {index}，共 {n} 张", { index: index + 1, n: files.length })}
        title={t("点击查看原图")}
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
  const t = useT();
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
  // 命中定位的闪烁高亮框（相对最终文本框的视口坐标）；2s 自动消失
  const [locateHighlight, setLocateHighlight] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const locateHighlightTimer = useRef(0);
  // 定位自身的程序化 scrollTop 也会异步触发 scroll 事件，不能把刚设的高亮清掉
  const locateScrollGuardUntil = useRef(0);
  useEffect(() => () => window.clearTimeout(locateHighlightTimer.current), []);
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
    draft?.profileDefaultMarkdownMode,
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
    targetSnapshot?.appName || targetSnapshot?.bundleId || t("新目标");
  const sourceItemIds = draft?.sourceItemIds;
  const sourceKind = draft?.sourceKind;
  const sourceLabels = useMemo(() => {
    if (!sourceItemIds || !sourceKind) return [];
    const noteById = new Map(notes.map((note) => [note.id, note]));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    return sourceItemIds.map((id, index) => {
      if (sourceKind === "task") {
        const task = taskById.get(id);
        return task?.text.split("\n", 1)[0] || t("已删除任务 {n}", { n: index + 1 });
      }
      const note = noteById.get(id);
      if (!note) return t("已删除卡片 {n}", { n: index + 1 });
      if (note.kind === "image") {
        return imageListLabel(note, noteImages(note).length);
      }
      return (note.title || note.text).split("\n", 1)[0] || t("空卡片 {n}", { n: index + 1 });
    });
  }, [notes, sourceItemIds, sourceKind, tasks, t]);
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
  const promptValue = draftPromptSnippetId ?? (draftPromptTemplate ? "custom" : "none");
  const targetProfileId = draft?.targetProfileId;
  const profileName = useMemo(
    () => {
      if (!targetProfileId) return "";
      const profile = settings.targetProfiles.find((item) => item.id === targetProfileId);
      return profile ? profileDisplayName(profile) : targetProfileId;
    },
    // t：切换语言时内置方案名随之重算（profileDisplayName 读全局语言，lint 看不出这层依赖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.targetProfiles, targetProfileId, t]
  );
  const formatOptions = useMemo(
    () => FORMAT_OPTIONS.map((option) => ({ ...option, label: t(option.label) })),
    [t]
  );
  const hasPayload = Boolean(draft && (draft.finalText || draft.imageFiles.length));
  // 粘贴后动作不再要求单独选择（用户 2026-09-11）：confirm 方案在预检里点「发送」即确认
  const enterDecisionLabel = draft?.safeRehearsal
    ? t("本次不按回车")
    : draft?.enterPolicy === "confirm" && !draft.enterDecisionConfirmed
      ? t("点击发送即确认，粘贴后按回车")
      : draft?.pressEnter ? t("本次会按回车") : t("本次不按回车");
  // P3：确认按钮文案直接写出动作（confirm 方案点发送即确认回车）
  const willPressEnter =
    !!draft && !draft.safeRehearsal &&
    (draft.pressEnter || (draft.enterPolicy === "confirm" && !draft.enterDecisionConfirmed));
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
    firewall?.canSend &&
    imageFirewall?.canSend
    && transformStatus !== "running"
  );
  // 目标失效时按场景给出恢复路径，而不是只报状态：
  // ① 已识别到另一个 ready 目标 → 显式确认并重算方案；② 方案待确认 → 指去目标条；
  // ③ 人在别的应用 → 切回即自动恢复（由下方 effect 调 recoverOpenPreflightTarget 兑现）
  const draftTargetName =
    draft?.targetSnapshot?.appName || draft?.targetSnapshot?.bundleId || t("目标应用");
  const staleTargetGuidance =
    visibleStaleReason === "target" && !canRecoverTarget
      ? showTargetChangeAction
        ? t("当前为 {name}，确认后将重算发送方案", { name: currentTargetName })
        : profileOverrideNeedsConfirmation
        ? t("在面板目标条确认本次发送方案后可继续")
        : t("切回 {name} 后这里会自动恢复", { name: draftTargetName })
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
        ? t("正文与附件为空，没有可发送的内容")
        : firewall && !firewall.canSend
          ? firewall.reason ?? t("本地隐私检查未通过")
          : imageFirewall && !imageFirewall.canSend
            ? imageFirewall.reason ?? t("图片隐私检查未通过")
            : transformStatus === "running"
              ? t("AI 处理进行中，完成后可发送")
              : retryBlocked
                ? lastError ?? t("上次发送未完成处理，暂不能重试")
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
  const targetName = draft.targetSnapshot?.appName ?? t("未识别目标");
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
      const textarea = finalTextRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(start, end);
      // 长文本里原生选区可能在视口外且不显眼（用户反馈「不知道在哪」）：
      // 镜像测量命中坐标 → textarea 内部滚到命中行居中 → 叠 2s 呼吸高亮框
      const head = textareaSelectionAnchor(textarea, { start, end });
      if (!head) return;
      const contentTop = head.top + textarea.scrollTop;
      const lineHeight = head.bottom - head.top;
      textarea.scrollTop = Math.max(
        0,
        contentTop - (textarea.clientHeight - lineHeight) / 2
      );
      textarea.scrollIntoView({ block: "nearest" });
      const tail = textareaSelectionAnchor(textarea, { start: end, end });
      const sameLine =
        tail && Math.abs(tail.top + textarea.scrollTop - contentTop) < 1;
      // 跨行命中只框起始行到行尾（原生选区仍整段高亮，框负责引导视线）
      const width = sameLine
        ? Math.max(tail.left - head.left, 12)
        : Math.max(textarea.clientWidth - head.left - 8, 12);
      setLocateHighlight({
        left: head.left - 4,
        top: contentTop - textarea.scrollTop - 3,
        width: width + 8,
        height: lineHeight + 6,
      });
      locateScrollGuardUntil.current = performance.now() + 200;
      window.clearTimeout(locateHighlightTimer.current);
      locateHighlightTimer.current = window.setTimeout(
        () => setLocateHighlight(null),
        2000
      );
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
      tip("warn", t("该命中位置已变化，请重新检测后再加入词典"));
      return;
    }
    if (!addAliasEntityFromText(source, category)) return;
    if (draft.finalText === draft.assembledText) {
      // 无手工编辑：重建草稿让新词条立即生效（自动替换 + 隐私重扫描）
      updateOpenPreflightDraft({});
    } else {
      tip("info", t("词条已保存；本次正文已手工编辑，可点「重新检测」应用替换"));
    }
  };

  const privacyPolicyLabel = {
    requireRedaction: t("敏感项须替换或明确保留后才能发送"),
    confirmRaw: t("高风险须处理；提示级可确认后保留"),
    allowRaw: t("允许原文发送；高风险需二次确认"),
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
    ? t("重新检测当前文本和原始图片")
    : t("重新检测当前文本");
  const rerunPrivacyScan = async () => {
    const expectedDraftId = draft.id;
    if (hasImageRedactions) {
      let confirmed = false;
      try {
        confirmed = await ask(
          t("重新检测会恢复图片为原图，并清除已完成的遮挡；检测后需要重新处理。是否继续？"),
          { title: t("重新检测隐私内容"), kind: "warning" }
        );
      } catch {
        tip("warn", t("无法确认重新检测，请稍后重试"));
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
      tip("warn", t("本次重新检测已失效，请在内容稳定后重试"));
      return;
    }
    const incomplete = live.firewallStatus === "failed" ||
      live.firewallStatus === "incomplete" ||
      live.imageFirewall.some((item) => item.status === "failed");
    if (incomplete) {
      tip("warn", t("重新检测完成，但有内容未能完整检查"));
      return;
    }
    const findingCount = live.findings.length + live.imageFirewall.reduce(
      (total, item) => total + item.findings.length,
      0
    );
    tip(
      "ok",
      findingCount
        ? t("重新检测完成，发现 {n} 项可能的敏感内容", { n: findingCount })
        : t("重新检测完成，未发现敏感内容")
    );
  };


  // ——— B 版式「先处理，后确认」派生：分区归属与顶部横幅文案 ———
  const unresolvedTextCount = draft.findings.filter(
    (finding) => !excludedFindingIds.has(finding.id)
  ).length;
  const unresolvedImageCount = draft.imageFirewall.reduce(
    (total, item) =>
      total +
      item.findings.filter(
        (finding) =>
          !item.redactedFindingIds.includes(finding.id) &&
          !item.keptFindingIds.includes(finding.id)
      ).length,
    0
  );
  // 有未了结命中（含按方案放行的）也算待处理：可发送 ≠ 不需要人看一眼
  const textAttention = Boolean(
    draft.firewallEnabled &&
      ((firewall && !firewall.canSend) ||
        unresolvedTextCount > 0 ||
        draft.firewallStatus === "failed" ||
        draft.firewallStatus === "incomplete")
  );
  const imageAttention =
    draft.imageFirewall.length > 0 &&
    Boolean(
      (imageFirewall && !imageFirewall.canSend) ||
        unresolvedImageCount > 0 ||
        draft.imageFirewall.some(
          (item) => item.status !== "ready" && item.status !== "disabled"
        )
    );
  const checksPass = Boolean(
    firewall?.canSend && imageFirewall?.canSend
  );
  const textPassSummary =
    draft.firewallStatus === "disabled"
      ? t("检查已关闭")
      : draft.findings.length === 0
        ? draft.privacyDecision.replacedCount > 0
          ? t("已替换 {n} 处敏感内容", { n: draft.privacyDecision.replacedCount })
          : t("未发现敏感内容")
        : unresolvedTextCount === 0
          ? t("已确认保留 {n} 处原文", { n: draft.findings.length })
          : t("{n} 处命中按方案保留原文", { n: unresolvedTextCount });
  const keptImageFindingCount = draft.imageFirewall.reduce(
    (total, item) => total + item.keptFindingIds.length,
    0
  );
  const imagePassSummary = draft.imageFirewall.every(
    (item) => item.status === "disabled"
  )
    ? hasImageRedactions ? t("检查已关闭，发送副本") : t("检查已关闭，发送原图")
    : hasImageRedactions
      ? t("已遮挡敏感区域，发送副本")
      : keptImageFindingCount > 0
        ? t("已确认保留 {n} 处，发送原图", { n: keptImageFindingCount })
        : t("无敏感区域，发送原图");
  const attentionCount =
    unresolvedTextCount + unresolvedImageCount;
  const bannerTitle = privacyScanPending
    ? t("本地隐私检测中…")
    : checksPass
      ? draft.safeRehearsal
        ? t("检查全部通过，可安全粘贴")
        : t("检查全部通过，可发送")
      : attentionCount > 0
        ? t("{n} 项处理完才能发送", { n: attentionCount })
        : t("检查未通过，暂不能发送");
  const bannerDetail = privacyScanPending
    ? t("文本检测与图片 OCR 均在本机运行，内容不会上传")
    : checksPass
      ? textAttention || imageAttention
        ? t("部分命中按当前方案保留原文，建议复查下方明细")
        : [
            textPassSummary,
            draft.imageFirewall.length
              ? hasImageRedactions
                ? t("{n} 张图片已遮挡", { n: draft.imageFirewall.length })
                : t("{n} 张图片发送原图", { n: draft.imageFirewall.length })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")
      : [
          unresolvedTextCount > 0 ? t("{n} 处文本敏感项", { n: unresolvedTextCount }) : null,
          unresolvedImageCount > 0 ? t("{n} 处图片区域", { n: unresolvedImageCount }) : null,
        ]
          .filter(Boolean)
          .join(" · ") ||
        (firewall?.reason ?? imageFirewall?.reason ?? t("详见下方检查明细"));
  const imageCheckPanel =
    draft.imageFirewall.length > 0 && imageFirewall ? (
      <ImageFirewallPanel draft={draft} busy={busy} evaluation={imageFirewall} />
    ) : null;
  const privacyCheckSection = (
    <section
      aria-label={t("本地隐私检查")}
      className="space-y-2 rounded-lg border border-border/70 p-2"
    >
      <div className="flex items-center gap-1.5">
        <ShieldAlert className="size-3.5 text-warning" aria-hidden />
        <p className="text-label font-medium">{t("本地隐私检查")}</p>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span aria-live="polite" className="text-micro text-muted-foreground">
            {draft.firewallStatus === "disabled"
              ? t("已关闭")
              : draft.firewallStatus === "scanning"
                ? t("扫描中…")
                : draft.firewallStatus === "ready"
                  ? unresolvedTextCount
                    ? t("{n} 项待处理", { n: unresolvedTextCount })
                    : t("无待处理项")
                  : draft.firewallStatus === "incomplete"
                    ? t("检查不完整")
                    : draft.firewallStatus === "failed"
                      ? t("检查失败")
                      : t("等待检查")}
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
              {privacyScanPending ? t("检测中") : t("重新检测")}
            </Button>
          )}
        </div>
      </div>
      <p className="text-micro text-muted-foreground">
        {privacyPolicyLabel} · {t("检测可能存在误报或漏报")}
      </p>
      {draft.firewallStatus === "ready" && draft.findings.length === 0 && (
        <p role="status" className="text-label text-success">
          {draft.privacyDecision.replacedCount > 0
            ? t("已替换 {n} 处敏感内容，本项检查通过", { n: draft.privacyDecision.replacedCount })
            : t("未发现敏感内容，本项检查通过")}
        </p>
      )}
      {draft.findings.length > 0 && firewall?.canSend && (
        <p role="status" className="text-label text-success">
          {t("敏感项已全部处理，可以发送")}
        </p>
      )}
      {firewallSummary.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label={t("敏感项分类汇总")}>
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
              {t(FIREWALL_CATEGORY_LABEL[item.category])} · {t(FIREWALL_SEVERITY_LABEL[item.severity])} ×{item.count}
            </span>
          ))}
        </div>
      )}
      {draft.findings.length > 0 && (
        <>
          <p className="text-micro text-muted-foreground">
            {t("推荐替换为占位符（本机替换、发出的是占位符）；确需按原文发出时选「保留原文发送」")}
          </p>
          {/* 命中就地处理：原文高亮可点；详细列表默认展开，也可手动收起。 */}
          <FindingInlineText
            text={draft.finalText}
            findings={draft.findings}
            excludedIds={excludedFindingIds}
            busy={busy || draft.firewallStatus !== "ready"}
            aliasCategories={aliasQuickAddCategories(settings.aliasCustomCategories)}
            onReplace={(finding) => useDeliveryStore.getState().replaceFirewallFinding(finding.id)}
            onExclude={(finding) => useDeliveryStore.getState().excludeFirewallFinding(finding.id)}
            onAlias={(finding, category) => addFindingToAliasDictionary(finding, category)}
          />
          {draft.findings.length > 1 && (
            <div className="space-y-1">
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  disabled={busy || draft.firewallStatus !== "ready"}
                  title={t("把本次全部命中一次性替换为占位符")}
                  onClick={() => useDeliveryStore.getState().replaceAllFirewallFindings()}
                >
                  {t("一键全部替换")}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  disabled={busy || draft.firewallStatus !== "ready" ||
                    draft.findings.every((finding) => excludedFindingIds.has(finding.id))}
                  title={t("确认本次检测到的全部文本敏感项按原文保留，不改变默认脱敏策略")}
                  onClick={() => useDeliveryStore.getState().excludeAllFirewallFindings()}
                >
                  {draft.findings.every((finding) => excludedFindingIds.has(finding.id))
                    ? t("已全部保留原文")
                    : t("一键保留原文")}
                </Button>
              </div>
              <p className="text-micro text-muted-foreground">
                {t("仅本次有效，随后点击「确认发送」；已替换的内容不会恢复。")}
              </p>
            </div>
          )}
          <details open className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1 py-0.5 text-micro text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
              {t("详细列表（命中依据 · 同类替换 · 定位）")}
            </summary>
          <ul className="mt-1 space-y-1.5" aria-label={t("敏感项列表")}>
            {draft.findings.map((finding) => {
              const excluded = excludedFindingIds.has(finding.id);
              return (
                <li
                  key={finding.id}
                  className="rounded-md bg-background/60 p-1.5"
                >
                  <div className="flex items-center gap-1 text-label">
                    <span className="font-medium">
                      {t(FIREWALL_CATEGORY_LABEL[finding.category])}
                    </span>
                    <span className={cn(
                      "rounded-sm px-1 py-0.5 text-micro",
                      finding.severity === "block"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-warning/10 text-warning"
                    )}>
                      {t(FIREWALL_SEVERITY_LABEL[finding.severity])}
                    </span>
                    <code className="min-w-0 flex-1 truncate text-right text-micro text-muted-foreground">
                      {finding.maskedPreview}
                    </code>
                    <IconButton
                      label={t("在正文中定位这一项")}
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
                  <details className="mt-1 text-micro text-muted-foreground">
                    <summary className="cursor-pointer">{t("命中依据")}</summary>
                    <p className="mt-1 break-words">{findingReason(finding)}</p>
                  </details>
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
                      {t("替换为占位符")}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      disabled={busy}
                      onClick={() =>
                        useDeliveryStore.getState()
                          .replaceFirewallCategory(finding.category)}
                    >
                      {t("同类全部替换")}
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
                            title={t("把这个值升级为持久词典实体：以后自动替换、捕获回复自动恢复")}
                            onClick={toggle}
                          >
                            {t("加入词典")}
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
                                {aliasCategoryDisplayLabel(category)}
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
                      title={t("不替换这一项，按原文发出（仅本次发送有效）")}
                      disabled={busy || excluded}
                      onClick={() =>
                        useDeliveryStore.getState()
                          .excludeFirewallFinding(finding.id)}
                    >
                      {excluded ? t("已确认保留原文") : t("保留原文发送")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          </details>
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
            ? t("再次确认保留高风险原文")
            : t("确认本次保留提示级原文")}
        </Button>
      )}
      {(firewall?.reason || imageFirewall?.reason) && (
        <p role="status" className="text-micro text-warning">
          {firewall?.reason ?? imageFirewall?.reason}
        </p>
      )}
    </section>
  );

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
              {draft.safeRehearsal ? t("检查并粘贴") : t("发送预检")}
            </h2>
            <p className={cn("text-micro text-muted-foreground", !draft.safeRehearsal && "truncate")}>
              {draft.safeRehearsal
                ? horizontal
                  ? t("处理示例邮箱，检查右侧正文，再点「安全粘贴」。")
                  : activeSection === "content"
                    ? t("确认正文后，点下方「安全粘贴」。教程不会自动按回车。")
                    : textAttention
                      ? t("点「替换为占位符」处理示例邮箱，再到「内容」检查正文。")
                      : t("到「内容」检查正文，再点「安全粘贴」。")
                : t("确认目标、内容与粘贴后动作")}
            </p>
          </div>
          {!horizontal && (
            <div className="flex rounded-lg bg-muted/70 p-0.5" role="tablist" aria-label={t("预检分区")}>
              {(["summary", "content"] as const).map((section) => (
                <Button
                  key={section}
                  type="button"
                  role="tab"
                  size="xs"
                  variant="ghost"
                  aria-selected={activeSection === section}
                  onClick={() => useDeliveryStore.getState().setActiveSection(section)}
                  className={cn(
                    "relative",
                    activeSection === section && "hover:bg-transparent"
                  )}
                >
                  {activeSection === section && (
                    <SlidingTabIndicator layoutId="preflight-section-thumb" />
                  )}
                  <span className="relative z-10">
                    {section === "summary" ? t("概览") : t("内容")}
                  </span>
                </Button>
              ))}
            </div>
          )}
          <IconButton label={t("关闭发送预检")} size="xs" disabled={busy} onClick={close}>
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
            aria-label={t("发送概览")}
            className={cn(
              // 案 3（2026-09-11）：分区从 hidden 切回可见时自上而下揭示
              "reveal-in min-h-0 space-y-2 overflow-y-auto rounded-lg bg-muted/30 p-2",
              !showSummary && "hidden"
            )}
          >
            {/* B 版式（2026-08-26 用户选定）：状态横幅 → 需要处理 → 本次发送 → 已通过存档 */}
            <div
              className={cn(
                "flex items-start gap-2 rounded-lg p-2.5",
                privacyScanPending
                  ? "bg-muted/60"
                  : checksPass
                    ? "bg-success/10"
                    : "bg-warning/10"
              )}
            >
              {privacyScanPending ? (
                <RefreshCw
                  className="mt-px size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
                  aria-hidden
                />
              ) : checksPass ? (
                <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" aria-hidden />
              ) : (
                <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-label font-semibold",
                    privacyScanPending
                      ? "text-foreground"
                      : checksPass
                        ? "text-success"
                        : "text-warning"
                  )}
                >
                  {bannerTitle}
                </p>
                {bannerDetail && (
                  <p className="text-micro text-muted-foreground">{bannerDetail}</p>
                )}
              </div>
            </div>

            {draft.warnings.length > 0 && (
              <div role="status" aria-label={t("发送警告")} className="rounded-lg bg-warning/10 p-2 text-label text-warning">
                <p className="mb-1 flex items-center gap-1 font-medium">
                  <AlertTriangle className="size-3" /> {t("当前警告")}
                </p>
                <ul className="space-y-0.5">
                  {draft.warnings.map((warning) => (
                    <li key={warning}>· {WARNING_LABEL[warning] ? t(WARNING_LABEL[warning]) : warning}</li>
                  ))}
                </ul>
              </div>
            )}

            {(textAttention || imageAttention) && (
              <div className="space-y-2">
                <p className="px-0.5 text-micro font-semibold text-warning">{t("需要处理")}</p>
                {textAttention && privacyCheckSection}
                {imageAttention && imageCheckPanel}
              </div>
            )}

            <section
              aria-label={t("本次发送")}
              className="space-y-2 rounded-lg border border-border/70 p-2"
            >
              <div className="flex items-center gap-2">
                <ApplicationIcon src={icon} name={targetDisplayName} className="size-8 rounded-lg" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium">{targetDisplayName}</p>
                  <p className="text-micro text-muted-foreground">
                    {readyDifferentTarget
                      ? t("待确认新目标")
                      : staleReason === "target"
                        ? t("目标已变化")
                        : t("可发送")}
                  </p>
                </div>
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-micro">
                  {readyDifferentTarget ? t("待重算方案") : profileName}
                </span>
              </div>

              <details>
                <summary className="cursor-pointer text-label font-medium">
                  {t("来源 {n} 项", { n: draft.sourceItemIds.length })}
                </summary>
                <ol className="mt-1 space-y-1 pl-4 text-label text-muted-foreground">
                  {sourceLabels.map((label, index) => (
                    <li key={`${draft.sourceItemIds[index]}-${index}`} className="list-decimal truncate">
                      {label}
                    </li>
                  ))}
                </ol>
              </details>

              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-label">
                  <span className="text-muted-foreground">{t("提示词模板")}</span>
                  <PromptTemplateSelect
                    value={promptValue}
                    prioritized={promptMenu.prioritized}
                    remaining={promptMenu.remaining}
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
                  <span className="text-muted-foreground">{t("发送格式")}</span>
                  <SimpleSelect
                    value={
                      draft.markdownMode === "strip"
                        ? "strip-markdown"
                        : draft.format
                    }
                    options={formatOptions}
                    ariaLabel={t("本次发送格式")}
                    size="micro"
                    disabled={busy}
                    onChange={(mode) => updateOpenPreflightDraft(
                      mode === "strip-markdown"
                        ? { format: "plain", markdownMode: "strip" }
                        : { format: mode, markdownMode: "preserve" }
                    )}
                  />
                </label>
              </div>

              {draft.promptTemplate && (
                <pre className="max-h-16 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background/60 p-2 font-mono text-micro text-muted-foreground">
                  {draft.promptTemplate}
                </pre>
              )}

              <div className="space-y-1 text-label">
                <p role="status">
                  {t("粘贴后动作：{policy}", { policy: t(ENTER_POLICY_STATUS_LABEL[draft.enterPolicy]) })}
                  <span className="text-muted-foreground">
                    {` · ${enterDecisionLabel}`}
                  </span>
                </p>
                {draft.safeRehearsal && (
                  <p role="status" className="font-medium text-success">
                    {t("演练安全锁：只粘贴，不按回车")}
                  </p>
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
                  {t("发送后保留面板")}
                </label>
              </div>
            </section>

            {!textAttention && (
              <details className="group px-1">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-label text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <Check className="size-3 shrink-0 text-success" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {t("文本隐私 · {summary}", { summary: textPassSummary })}
                  </span>
                  <ChevronRight
                    className="size-3 shrink-0 transition-transform group-open:rotate-90"
                    aria-hidden
                  />
                </summary>
                <div className="mt-1">{privacyCheckSection}</div>
              </details>
            )}
            {!imageAttention && draft.imageFirewall.length > 0 && (
              <details className="group px-1">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-label text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <Check className="size-3 shrink-0 text-success" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {t("图片隐私 {n} 张 · {summary}", { n: draft.imageFirewall.length, summary: imagePassSummary })}
                  </span>
                  <ChevronRight
                    className="size-3 shrink-0 transition-transform group-open:rotate-90"
                    aria-hidden
                  />
                </summary>
                <div className="mt-1">{imageCheckPanel}</div>
              </details>
            )}
            {aliasOccurrences.length > 0 && (
              <details className="group px-1">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-label text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <VenetianMask className="size-3 shrink-0" aria-hidden />
                  <span aria-live="polite" className="min-w-0 flex-1 truncate">
                    {t("可逆化名 · 已自动替换 {n} 处", { n: aliasOccurrences.length })}
                  </span>
                  <ChevronRight
                    className="size-3 shrink-0 transition-transform group-open:rotate-90"
                    aria-hidden
                  />
                </summary>
              <section
                aria-label={t("可逆化名")}
                className="mt-1 space-y-2 rounded-lg border border-border/70 p-2"
              >
                <ul className="space-y-1" aria-label={t("化名替换列表")}>
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
                        {t("还原为原文")}
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="text-micro text-muted-foreground">
                  {t("已按词典自动替换，发送后可在本机恢复；如需保留原文可逐项还原（仅本次发送有效）")}
                </p>
              </section>
              </details>
            )}
            {!textAttention && draft.firewallEnabled && (
              <div className="flex items-center gap-1.5 px-1 text-micro text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">
                  {t("检测均在本机运行 · 结果可能有误报或漏报")}
                </span>
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
                  {t("重新检测")}
                </Button>
              </div>
            )}
            {/* P3（2026-09-12）：常驻预演——确认的是最终会粘贴出去的字 */}
            {!draft.safeRehearsal && (
              <section
                aria-label={t("将要粘贴的内容")}
                className="space-y-1 rounded-lg border border-border/70 p-2"
              >
                <div className="flex items-center gap-2">
                  <p className="text-label font-medium">{t("将要粘贴的内容")}</p>
                  <span className="ml-auto text-micro tabular-nums text-muted-foreground">
                    {t("{n} 字符", { n: draft.finalText.length })}
                  </span>
                  {!horizontal && (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => useDeliveryStore.getState().setActiveSection("content")}
                    >
                      {t("编辑")}
                    </Button>
                  )}
                </div>
                <SendPreviewText
                  text={draft.finalText}
                  placeholders={Object.values(draft.redactionMap)}
                />
              </section>
            )}
          </section>

          <section
            aria-label={t("最终发送内容")}
            className={cn(
              "reveal-in min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg bg-muted/30 p-2",
              showContent ? "flex" : "hidden"
            )}
          >
            <div className="flex items-center gap-2">
              <label htmlFor="preflight-final-text" className="text-label font-medium">
                {t("最终文本")}
              </label>
              <span className="ml-auto text-micro tabular-nums text-muted-foreground">
                {t("{n} 字符", { n: draft.finalText.length })}
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy || draft.finalText === draft.assembledText}
                onClick={() => useDeliveryStore.getState().resetFinalText()}
              >
                <RotateCcw className="size-3" /> {t("恢复自动组装")}
              </Button>
            </div>
            <div className="relative min-h-24 flex-1">
              <textarea
                ref={finalTextRef}
                id="preflight-final-text"
                value={draft.finalText}
                disabled={busy}
                spellCheck={false}
                onChange={(event) => {
                  setLocateHighlight(null); // 文本一改，命中坐标即失效
                  useDeliveryStore.getState().setFinalText(event.target.value);
                }}
                onScroll={() => {
                  // 手动滚动时高亮框不跟随内容，立即撤（定位自身的滚动除外）
                  if (performance.now() < locateScrollGuardUntil.current) return;
                  setLocateHighlight(null);
                }}
                className="size-full resize-none rounded-lg border border-border bg-background/70 p-2 font-mono text-body leading-relaxed outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
              />
              {locateHighlight && (
                <div
                  aria-hidden
                  className="locate-highlight pointer-events-none absolute"
                  style={locateHighlight}
                />
              )}
            </div>
            {draft.originalImageFiles.length > 0 && (
              <div className="shrink-0 space-y-1">
                <div className="flex items-center gap-2">
                  <p className="text-label font-medium">{t("附件")}</p>
                  <span className="ml-auto text-micro text-muted-foreground">
                    {t("{n} 张 · 点击查看原图", { n: draft.originalImageFiles.length })}
                  </span>
                </div>
                {/* 发送顺序如实展示：自动去 Markdown 后仍可保持同源交错段；
                    用户手改/AI/隐私替换使正文偏离组装基线时才安全降级。 */}
                {currentDraftSegments(draft) ? (
                  <p className="text-micro text-muted-foreground">
                    {t("发送顺序：按卡片原图文交错顺序")}
                  </p>
                ) : draft.segments ? (
                  <p role="status" className="text-micro text-warning">
                    {t("正文已改动，发送顺序改为：全文 → {n} 张图", { n: draft.originalImageFiles.length })}
                  </p>
                ) : (
                  <p className="text-micro text-muted-foreground">
                    {t("发送顺序：全文 → {n} 张图", { n: draft.originalImageFiles.length })}
                  </p>
                )}
                <ol aria-label={t("实际投递顺序")} className="space-y-1 text-micro text-muted-foreground">
                  {deliverySequencePreview(draft).map((label, index) => (
                    <li key={index} className="break-words">{index + 1}. {label}</li>
                  ))}
                </ol>
                <ul
                  aria-label={t("图片附件原图，共 {n} 张", { n: draft.originalImageFiles.length })}
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
                ? t("已就绪：演练只把最终文本粘贴到已确认目标，不会自动回车")
                : t("已就绪 · 本次修改不会改动原始卡片"))}
          </p>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={close}>
            {t("取消")}
          </Button>
          {/* disabled 按钮 pointer-events 为 none，tooltip 挂到外层 span 才能悬停可见 */}
          <span
            title={
              showTargetChangeAction
                ? t("确认将发送目标改为 {name}", { name: currentTargetName })
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
                  ? t("确认将发送目标改为 {name}", { name: currentTargetName })
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
                  ? t("确认新目标")
                  : t("暂不可确认")
                : busy
                ? t("发送中…")
                : canRecoverTarget
                  ? t("重新识别并重试")
                  : draft.safeRehearsal
                    ? t("安全粘贴")
                    : willPressEnter
                      ? t("粘贴并按回车")
                      : t("粘贴，不按回车")}
              {!showTargetChangeAction && <Kbd inline>⌘⏎</Kbd>}
            </Button>
          </span>
        </footer>
      </div>
    </>
  );
}
