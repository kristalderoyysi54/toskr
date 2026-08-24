import { api } from "@/lib/tauri";
import type {
  FindingCategory,
  ImageFirewallFinding,
  ImagePixelBox,
  RedactDeliveryImageResult,
  ScanImageFirewallResult,
} from "@/lib/tauri";
import type { PrivacyPolicy } from "@/lib/targetProfiles";
import { useDeliveryStore } from "@/store/deliveryStore";

import { nextDeliveryDraftRevision } from "./executeDraft";
import { rawConfirmationIsCurrent } from "./firewall";
import {
  rescanOpenDeliveryDraft,
  scanOpenDeliveryDraft,
  type ScanSensitiveText,
} from "./firewallController";
import type { DeliveryDraft, ImageFirewallItem } from "./types";

export type ImageFirewallEvaluation = {
  canSend: boolean;
  forcePressEnterOff: boolean;
  needsRawConfirmation: "warn" | "block" | null;
  unresolvedCount: number;
  reason: string | null;
};

type EvaluateInput = {
  enabled: boolean;
  items: readonly ImageFirewallItem[];
  policy: PrivacyPolicy;
  targetToken: string | null;
};

const REDACTED_PREFIX = "toskr-redacted:";
const FINDING_CATEGORIES = new Set<FindingCategory>([
  "privateKey",
  "authorization",
  "apiKey",
  "databaseUrl",
  "email",
  "phone",
  "nationalId",
  "bankCard",
  "ipAddress",
  "cookie",
  "session",
]);
const FINDING_SEVERITIES = new Set(["info", "warn", "block"]);
const MAX_IMAGE_FINDINGS = 4_096;
const PREVIEW_ASPECT_RATIO = 4 / 3;

function percent(value: number) {
  return `${Math.round(value * 10_000) / 10_000}%`;
}

/** 把原图归一化框映射到 4:3 object-contain 预览，包含 letterbox 偏移。 */
export function containedImageRegionStyle(
  box: ImageFirewallFinding["boundingBox"],
  imageWidth: number | null,
  imageHeight: number | null
) {
  const imageAspect = imageWidth && imageHeight ? imageWidth / imageHeight : 1;
  const contentWidth = imageAspect >= PREVIEW_ASPECT_RATIO
    ? 1
    : imageAspect / PREVIEW_ASPECT_RATIO;
  const contentHeight = imageAspect >= PREVIEW_ASPECT_RATIO
    ? PREVIEW_ASPECT_RATIO / imageAspect
    : 1;
  const offsetX = (1 - contentWidth) / 2;
  const offsetY = (1 - contentHeight) / 2;
  return {
    left: percent((offsetX + box.x * contentWidth) * 100),
    top: percent((offsetY + box.y * contentHeight) * 100),
    width: percent(box.width * contentWidth * 100),
    height: percent(box.height * contentHeight * 100),
  };
}

function confirmationCurrent(
  item: ImageFirewallItem,
  targetToken: string | null,
  requiredLevel: "warn" | "block"
) {
  return rawConfirmationIsCurrent({
    confirmation: item.rawConfirmation,
    revision: item.scanRevision,
    targetToken,
    requiredLevel,
  });
}

/** 图片失败与未处理区域和文本 Firewall 使用同一 Profile 策略矩阵。 */
export function evaluateImageFirewallPolicy(
  input: EvaluateInput
): ImageFirewallEvaluation {
  if (!input.enabled || input.items.every((item) => item.status === "disabled")) {
    return {
      canSend: true,
      forcePressEnterOff: false,
      needsRawConfirmation: null,
      unresolvedCount: 0,
      reason: null,
    };
  }
  const pending = input.items.filter((item) =>
    item.status === "idle" || item.status === "scanning" || item.status === "redacting"
  );
  if (pending.length) {
    return {
      canSend: false,
      forcePressEnterOff: true,
      needsRawConfirmation: null,
      unresolvedCount: pending.length,
      reason: pending.some((item) => item.status === "redacting")
        ? "正在生成图片遮挡副本"
        : "图片本地隐私检查尚未完成",
    };
  }

  const failed = input.items.filter((item) => item.status === "failed");
  const failedConfirmed = failed.every((item) =>
    confirmationCurrent(item, input.targetToken, "block")
  );
  if (failed.length && (input.policy === "requireRedaction" || !failedConfirmed)) {
    return {
      canSend: false,
      forcePressEnterOff: true,
      needsRawConfirmation: input.policy === "requireRedaction" ? null : "block",
      unresolvedCount: failed.length,
      reason: input.policy === "requireRedaction"
        ? "图片 OCR 失败；当前方案禁止发送未经检查的原图"
        : "图片 OCR 失败，请显式确认本次发送未经检查的原图",
    };
  }

  let unresolvedCount = 0;
  let unresolvedBlocks = 0;
  let unresolvedWarns = 0;
  let anyBlock = failed.length > 0;
  let allWarnConfirmed = true;
  let allBlockConfirmed = true;
  for (const item of input.items) {
    // 已遮挡与逐项「明确保留」的 finding 均视为已处理（与文本 excluded 同语义）。
    const resolved = new Set([...item.redactedFindingIds, ...item.keptFindingIds]);
    const unresolved = item.findings.filter(
      (finding) =>
        (finding.severity === "warn" || finding.severity === "block") &&
        !resolved.has(finding.id)
    );
    const blocks = unresolved.filter((finding) => finding.severity === "block");
    const warns = unresolved.filter((finding) => finding.severity === "warn");
    unresolvedCount += unresolved.length;
    unresolvedBlocks += blocks.length;
    unresolvedWarns += warns.length;
    anyBlock ||= item.findings.some((finding) => finding.severity === "block");
    if (warns.length) {
      allWarnConfirmed &&= confirmationCurrent(item, input.targetToken, "warn");
    }
    if (blocks.length) {
      allBlockConfirmed &&= confirmationCurrent(item, input.targetToken, "block");
    }
  }

  if (input.policy === "requireRedaction") {
    return {
      canSend: unresolvedCount === 0,
      forcePressEnterOff: anyBlock,
      needsRawConfirmation: null,
      unresolvedCount,
      reason: unresolvedCount ? "请遮挡或逐项明确保留全部图片敏感区域" : null,
    };
  }
  if (input.policy === "confirmRaw") {
    if (unresolvedBlocks) {
      return {
        canSend: false,
        forcePressEnterOff: true,
        needsRawConfirmation: null,
        unresolvedCount,
        reason: "图片高风险区域必须遮挡或逐项明确保留",
      };
    }
    return {
      canSend: unresolvedWarns === 0 || allWarnConfirmed,
      forcePressEnterOff: anyBlock,
      needsRawConfirmation:
        unresolvedWarns > 0 && !allWarnConfirmed ? "warn" : null,
      unresolvedCount,
      reason:
        unresolvedWarns > 0 && !allWarnConfirmed
          ? "请确认本次保留图片中的提示级原文"
          : null,
    };
  }
  // allowRaw：未处理 block 可经 item 级 block 确认放行（与文本全局确认对齐）。
  const blocksConfirmed = unresolvedBlocks === 0 || allBlockConfirmed;
  return {
    canSend: blocksConfirmed,
    forcePressEnterOff: anyBlock,
    needsRawConfirmation: blocksConfirmed ? null : "block",
    unresolvedCount,
    reason: blocksConfirmed ? null : "图片高风险原文需要再次确认",
  };
}

export function evaluateDeliveryDraftImages(draft: DeliveryDraft) {
  return evaluateImageFirewallPolicy({
    enabled: draft.firewallEnabled,
    items: draft.imageFirewall,
    policy: draft.privacyPolicy,
    targetToken: draft.targetSnapshot?.token ?? null,
  });
}

function validFinite(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function validNormalizedBox(box: ImageFirewallFinding["boundingBox"]) {
  return [box.x, box.y, box.width, box.height].every(validFinite) &&
    box.x + box.width <= 1.000_001 && box.y + box.height <= 1.000_001;
}

function validFinding(
  finding: ImageFirewallFinding,
  observationCount: number,
  width: number,
  height: number
) {
  const pixel = finding.pixelBox;
  return Number.isSafeInteger(finding.observationIndex) &&
    finding.observationIndex >= 0 && finding.observationIndex < observationCount &&
    FINDING_CATEGORIES.has(finding.category) &&
    FINDING_SEVERITIES.has(finding.severity) &&
    typeof finding.id === "string" && finding.id.length > 0 && finding.id.length <= 240 &&
    typeof finding.ruleId === "string" && finding.ruleId.length > 0 && finding.ruleId.length <= 240 &&
    typeof finding.maskedPreview === "string" && finding.maskedPreview.length <= 512 &&
    validNormalizedBox(finding.boundingBox) &&
    [pixel.x, pixel.y, pixel.width, pixel.height].every(Number.isSafeInteger) &&
    pixel.width > 0 && pixel.height > 0 &&
    pixel.x + pixel.width <= width && pixel.y + pixel.height <= height;
}

export function applyImageScanResult(
  item: ImageFirewallItem,
  result: ScanImageFirewallResult,
  disabledWarnCategories: readonly FindingCategory[]
): ImageFirewallItem {
  const valid = result.file === item.originalFile &&
    typeof result.pixelHash === "string" && result.pixelHash.length === 64 &&
    Number.isSafeInteger(result.ruleVersion) && result.ruleVersion > 0 &&
    Number.isSafeInteger(result.imageWidth) && result.imageWidth > 0 &&
    Number.isSafeInteger(result.imageHeight) && result.imageHeight > 0 &&
    result.observations.length <= MAX_IMAGE_FINDINGS &&
    result.findings.length <= MAX_IMAGE_FINDINGS &&
    result.observations.every((observation) =>
      observation.imageWidth === result.imageWidth &&
      observation.imageHeight === result.imageHeight &&
      typeof observation.text === "string" &&
      Number.isFinite(observation.confidence) &&
      observation.confidence >= 0 && observation.confidence <= 1 &&
      validNormalizedBox(observation.boundingBox)
    ) &&
    result.findings.every((finding) =>
      validFinding(
        finding,
        result.observations.length,
        result.imageWidth,
        result.imageHeight
      )
    );
  if (!valid) {
    return {
      ...item,
      status: "failed",
      findings: [],
      rawConfirmation: null,
      failureMessage: "图片隐私检查返回了无效结果",
    };
  }
  const disabled = new Set(disabledWarnCategories);
  return {
    ...item,
    status: "ready",
    pixelHash: result.pixelHash,
    width: result.imageWidth,
    height: result.imageHeight,
    // OCR observations（含原文）到此为止；Draft 只保留安全遮罩元数据。
    findings: result.findings.filter(
      (finding) => finding.severity !== "warn" || !disabled.has(finding.category)
    ),
    rawConfirmation: null,
    failureMessage: null,
  };
}

export function replaceImageFirewallItem(
  items: readonly ImageFirewallItem[],
  originalFile: string,
  replacement: ImageFirewallItem
): ImageFirewallItem[] {
  return items.map((item) =>
    item.originalFile === originalFile ? replacement : item
  );
}

function failedImageScan(item: ImageFirewallItem): ImageFirewallItem {
  return {
    ...item,
    status: "failed",
    findings: [],
    rawConfirmation: null,
    failureMessage: "本地 OCR 失败；未将图片标记为安全",
  };
}

function beginImageScans(draft: DeliveryDraft): DeliveryDraft {
  if (!draft.firewallEnabled) {
    return {
      ...draft,
      imageFirewall: draft.imageFirewall.map((item) => ({
        ...item,
        status: "disabled",
      })),
    };
  }
  return {
    ...draft,
    imageFirewall: draft.imageFirewall.map((item) =>
      item.status === "idle"
        ? {
            ...item,
            status: "scanning" as const,
            scanRevision: item.scanRevision + 1,
            rawConfirmation: null,
            failureMessage: null,
          }
        : item
    ),
  };
}

export type ScanImageFirewall = (
  file: string
) => Promise<ScanImageFirewallResult>;

const forceImageScan: ScanImageFirewall = (file) =>
  api.scanImageFirewall(file, true);

export async function scanDeliveryDraftImages(
  draft: DeliveryDraft,
  scan: ScanImageFirewall = api.scanImageFirewall
): Promise<DeliveryDraft> {
  if (!draft.imageFirewall.length || !draft.firewallEnabled) {
    return beginImageScans(draft);
  }
  const scanning = beginImageScans(draft);
  // 多张大图串行解码，避免同时展开多份 RGBA 造成内存峰值；每张独立结算。
  const results: ImageFirewallItem[] = [];
  for (const item of scanning.imageFirewall) {
    if (item.status !== "scanning") {
      results.push(item);
      continue;
    }
    try {
      results.push(applyImageScanResult(
        item,
        await scan(item.originalFile),
        scanning.firewallDisabledWarnCategories
      ));
    } catch {
      results.push(failedImageScan(item));
    }
  }
  return {
    ...scanning,
    imageFirewall: results,
    imageFiles: results.map((item) => item.sendFile),
  };
}

export async function scanOpenDeliveryDraftImages(
  scan: ScanImageFirewall = api.scanImageFirewall
): Promise<void> {
  const state = useDeliveryStore.getState();
  const draft = state.draft;
  if (
    !state.open || !draft ||
    !draft.imageFirewall.some((item) => item.status === "idle")
  ) return;
  const scanning = beginImageScans(draft);
  useDeliveryStore.setState({ draft: scanning, lastError: null });
  const completed = await scanDeliveryDraftImages(scanning, scan);
  const current = useDeliveryStore.getState();
  const live = current.draft;
  if (
    !current.open || !live || live.id !== scanning.id ||
    live.imageFirewall.length !== scanning.imageFirewall.length ||
    live.imageFirewall.some((item, index) =>
      item.originalFile !== scanning.imageFirewall[index]?.originalFile ||
      item.scanRevision !== scanning.imageFirewall[index]?.scanRevision ||
      item.status !== scanning.imageFirewall[index]?.status
    )
  ) return;
  useDeliveryStore.setState({
    draft: {
      ...live,
      imageFirewall: completed.imageFirewall,
      imageFiles: completed.imageFirewall.map((item) => item.sendFile),
    },
    lastError: null,
  });
}

export async function scanOpenDeliveryDraftPrivacy(): Promise<void> {
  await scanOpenDeliveryDraft();
  await scanOpenDeliveryDraftImages();
}

/**
 * 用户主动重检：正文完成后再串行重跑原图 OCR，避免同时展开大图；旧确认和
 * 遮挡副本先失效，图片调用显式绕过像素缓存，确保这次确实重新识别。
 */
export async function rescanOpenDeliveryDraftPrivacy(
  scanText: ScanSensitiveText = api.scanSensitiveText,
  scanImage: ScanImageFirewall = forceImageScan
): Promise<boolean> {
  const state = useDeliveryStore.getState();
  const draft = state.draft;
  if (
    !state.open || state.busy || !draft || !draft.firewallEnabled ||
    draft.firewallStatus === "idle" || draft.firewallStatus === "scanning" ||
    draft.imageFirewall.some((item) =>
      item.status === "idle" || item.status === "scanning" || item.status === "redacting"
    )
  ) return false;
  const expectedId = draft.id;
  if (!await rescanOpenDeliveryDraft(scanText)) return false;

  const afterText = useDeliveryStore.getState();
  const live = afterText.draft;
  if (!afterText.open || !live || live.id !== expectedId) return false;
  if (!live.imageFirewall.length) return true;

  const oldTokens = redactedTokens(live);
  const resetPayload = live.imageFirewall.some(
    (item) => item.sendFile !== item.originalFile
  );
  const revision = resetPayload
    ? nextDeliveryDraftRevision(live.revision)
    : live.revision;
  const imageFirewall = live.imageFirewall.map((item) => ({
    ...item,
    sendFile: item.originalFile,
    status: "idle" as const,
    pixelHash: null,
    redactedPixelHash: null,
    width: null,
    height: null,
    findings: [],
    redactedFindingIds: [],
    keptFindingIds: [],
    manualRegions: [],
    rawConfirmation: null,
    failureMessage: null,
  }));
  useDeliveryStore.setState({
    draft: {
      ...live,
      revision,
      imageFiles: imageFirewall.map((item) => item.originalFile),
      imageFirewall,
    },
    transform:
      resetPayload && afterText.transform.status === "ready" &&
      afterText.transform.result?.draftRevision !== revision
        ? { ...afterText.transform, status: "stale" }
        : afterText.transform,
    lastError: null,
  });
  cleanupTokens(oldTokens);
  await scanOpenDeliveryDraftImages(scanImage);

  const settled = useDeliveryStore.getState();
  return Boolean(
    settled.open && settled.draft?.id === expectedId &&
    settled.draft.revision === revision &&
    settled.draft.imageFirewall.every((item) =>
      item.status !== "idle" && item.status !== "scanning" && item.status !== "redacting"
    )
  );
}

function redactedTokens(draft: DeliveryDraft | null): string[] {
  return draft?.imageFirewall
    .map((item) => item.sendFile)
    .filter((file) => file.startsWith(REDACTED_PREFIX)) ?? [];
}

function cleanupTokens(tokens: string[]): void {
  if (!tokens.length) return;
  void api.cleanupRedactedImages(tokens).catch(() => {
    void api.diagNote("图片隐私临时副本清理失败").catch(() => {});
  });
}

export function cleanupDeliveryDraftImages(draft: DeliveryDraft | null): void {
  cleanupTokens(redactedTokens(draft));
}

export function clearDeliveryDraftImages(): void {
  void api.clearRedactedImages().catch(() => {
    void api.diagNote("图片隐私会话清理失败").catch(() => {});
  });
}

function pixelBoxKey(box: ImagePixelBox) {
  return `${box.x}:${box.y}:${box.width}:${box.height}`;
}

function selectedFindingIds(item: ImageFirewallItem, findingId?: string) {
  if (!findingId) return new Set(item.findings.map((finding) => finding.id));
  const selected = item.findings.find((finding) => finding.id === findingId);
  if (!selected) return new Set<string>();
  // 字符级框各自独立遮挡；仅当多个 finding 退回同一整条观察框（像素框完全
  // 相同）时，遮挡一个才顺带覆盖其余同框 finding。
  const selectedKey = pixelBoxKey(selected.pixelBox);
  return new Set(
    item.findings
      .filter((finding) => pixelBoxKey(finding.pixelBox) === selectedKey)
      .map((finding) => finding.id)
  );
}

function uniqueRegions(
  item: ImageFirewallItem,
  findingIds: ReadonlySet<string>,
  manualRegions: readonly ImagePixelBox[] = item.manualRegions
) {
  const seen = new Set<string>();
  return [
    ...item.findings
    .filter((finding) => findingIds.has(finding.id))
    .map((finding) => finding.pixelBox),
    ...manualRegions,
  ]
    .filter((region) => {
      const key = `${region.x}:${region.y}:${region.width}:${region.height}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function validRedactionResult(
  item: ImageFirewallItem,
  result: RedactDeliveryImageResult
) {
  return result.originalFile === item.originalFile &&
    (!item.pixelHash || result.originalPixelHash === item.pixelHash) &&
    result.redactedFile.startsWith(REDACTED_PREFIX) &&
    result.redactedPixelHash.length === 64 &&
    (!item.width || result.imageWidth === item.width) &&
    (!item.height || result.imageHeight === item.height);
}

type AppliedImageRedaction = {
  file: string;
  width: number;
  height: number;
  draftRevision: number;
};

async function renderOpenDeliveryRedaction(input: {
  draft: DeliveryDraft;
  item: ImageFirewallItem;
  findingIds: Set<string>;
  manualRegions: ImagePixelBox[];
  cancelled?: () => boolean;
}): Promise<AppliedImageRedaction | null> {
  const { draft, item, findingIds, manualRegions, cancelled } = input;
  const regions = uniqueRegions(item, findingIds, manualRegions);
  if (!regions.length) return null;
  const returnStatus = item.status;
  const scanningItem = {
    ...item,
    status: "redacting" as const,
    rawConfirmation: null,
  };
  useDeliveryStore.setState({
    draft: {
      ...draft,
      imageFirewall: replaceImageFirewallItem(
        draft.imageFirewall,
        item.originalFile,
        scanningItem
      ),
    },
    lastError: null,
  });
  let result: RedactDeliveryImageResult;
  try {
    // 每次都从来源原图一次性合成 OCR + 手工区域，避免临时副本层层加工。
    result = await api.redactDeliveryImage(item.originalFile, regions);
  } catch {
    const current = useDeliveryStore.getState();
    const live = current.draft?.imageFirewall.find(
      (entry) => entry.originalFile === item.originalFile
    );
    if (
      current.open && current.draft?.id === draft.id &&
      live?.status === "redacting"
    ) {
      useDeliveryStore.setState({
        draft: {
          ...current.draft,
          imageFirewall: replaceImageFirewallItem(
            current.draft.imageFirewall,
            item.originalFile,
            { ...live, status: returnStatus }
          ),
        },
        lastError: "创建图片遮挡副本失败，原图未变更",
      });
    }
    return null;
  }
  const current = useDeliveryStore.getState();
  const liveDraft = current.draft;
  const live = liveDraft?.imageFirewall.find(
    (entry) => entry.originalFile === item.originalFile
  );
  const wasCancelled = cancelled?.() ?? false;
  if (
    wasCancelled ||
    !current.open || !liveDraft || liveDraft.id !== draft.id ||
    liveDraft.revision !== draft.revision ||
    !live || live.status !== "redacting" ||
    live.scanRevision !== item.scanRevision || !validRedactionResult(item, result)
  ) {
    cleanupTokens([result.redactedFile]);
    if (
      current.open && liveDraft?.id === draft.id &&
      live?.status === "redacting"
    ) {
      useDeliveryStore.setState({
        draft: {
          ...liveDraft,
          imageFirewall: replaceImageFirewallItem(
            liveDraft.imageFirewall,
            item.originalFile,
            { ...live, status: returnStatus }
          ),
        },
        lastError: wasCancelled ? null : "遮挡结果已失效，请重试",
      });
    }
    return null;
  }
  const replaced: ImageFirewallItem = {
    ...live,
    sendFile: result.redactedFile,
    status: returnStatus,
    pixelHash: live.pixelHash ?? result.originalPixelHash,
    redactedPixelHash: result.redactedPixelHash,
    width: live.width ?? result.imageWidth,
    height: live.height ?? result.imageHeight,
    redactedFindingIds: [...findingIds],
    manualRegions,
    rawConfirmation: null,
  };
  const items = replaceImageFirewallItem(
    liveDraft.imageFirewall,
    item.originalFile,
    replaced
  );
  const revision = nextDeliveryDraftRevision(liveDraft.revision);
  useDeliveryStore.setState({
    draft: {
      ...liveDraft,
      revision,
      imageFirewall: items,
      imageFiles: items.map((entry) => entry.sendFile),
    },
    transform:
      current.transform.status === "ready" &&
      current.transform.result?.draftRevision !== revision
        ? { ...current.transform, status: "stale" }
        : current.transform,
    lastError: null,
  });
  if (item.sendFile.startsWith(REDACTED_PREFIX)) {
    cleanupTokens([item.sendFile]);
  }
  return {
    file: result.redactedFile,
    width: result.imageWidth,
    height: result.imageHeight,
    draftRevision: revision,
  };
}

export async function redactOpenDeliveryImage(
  originalFile: string,
  findingId?: string
): Promise<boolean> {
  const state = useDeliveryStore.getState();
  const draft = state.draft;
  const item = draft?.imageFirewall.find((entry) => entry.originalFile === originalFile);
  if (!state.open || !draft || !item || item.status !== "ready") return false;
  const findingIds = selectedFindingIds(item, findingId);
  for (const id of item.redactedFindingIds) findingIds.add(id);
  return !!await renderOpenDeliveryRedaction({
    draft,
    item,
    findingIds,
    manualRegions: item.manualRegions,
  });
}

function validManualRegion(region: ImagePixelBox) {
  const maxU32 = 0xffff_ffff;
  return [region.x, region.y, region.width, region.height].every(
    (value) => Number.isSafeInteger(value) && value >= 0 && value <= maxU32
  ) && region.width > 0 && region.height > 0;
}

function regionContains(outer: ImagePixelBox, inner: ImagePixelBox) {
  return outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height;
}

export type ManualDeliveryRedactionRequest = {
  draftId: string;
  draftRevision: number;
  originalFile: string;
  sourceFile: string;
  regions: ImagePixelBox[];
};

/** 手工实色打码：已知 finding 只有被完整覆盖时才计为已处理。 */
export async function manuallyRedactOpenDeliveryImage(
  request: ManualDeliveryRedactionRequest,
  cancelled?: () => boolean
): Promise<AppliedImageRedaction | null> {
  const state = useDeliveryStore.getState();
  const draft = state.draft;
  const item = draft?.imageFirewall.find(
    (entry) => entry.originalFile === request.originalFile
  );
  if (
    !state.open || !draft || !item || state.busy ||
    draft.id !== request.draftId || draft.revision !== request.draftRevision ||
    item.sendFile !== request.sourceFile ||
    !["ready", "failed", "disabled"].includes(item.status) ||
    !request.regions.length || !request.regions.every(validManualRegion)
  ) return null;
  const manualRegions = uniqueRegions(
    item,
    new Set<string>(),
    [...item.manualRegions, ...request.regions]
  );
  const findingIds = new Set(item.redactedFindingIds);
  for (const finding of item.findings) {
    if (manualRegions.some((region) => regionContains(region, finding.pixelBox))) {
      findingIds.add(finding.id);
    }
  }
  return renderOpenDeliveryRedaction({
    draft,
    item,
    findingIds,
    manualRegions,
    cancelled,
  });
}

export async function redactAllOpenDeliveryImages(): Promise<void> {
  const draft = useDeliveryStore.getState().draft;
  if (!draft) return;
  for (const item of draft.imageFirewall) {
    if (
      item.status === "ready" &&
      item.findings.some((finding) => !item.redactedFindingIds.includes(finding.id))
    ) {
      await redactOpenDeliveryImage(item.originalFile);
    }
  }
}

export function restoreOpenDeliveryImage(originalFile: string): void {
  const state = useDeliveryStore.getState();
  const draft = state.draft;
  const item = draft?.imageFirewall.find((entry) => entry.originalFile === originalFile);
  if (!state.open || !draft || !item || item.sendFile === item.originalFile) return;
  const restored = {
    ...item,
    sendFile: item.originalFile,
    redactedPixelHash: null,
    redactedFindingIds: [],
    keptFindingIds: [],
    manualRegions: [],
    rawConfirmation: null,
  };
  const items = replaceImageFirewallItem(draft.imageFirewall, originalFile, restored);
  const revision = nextDeliveryDraftRevision(draft.revision);
  useDeliveryStore.setState({
    draft: {
      ...draft,
      revision,
      imageFirewall: items,
      imageFiles: items.map((entry) => entry.sendFile),
    },
    transform:
      state.transform.status === "ready" &&
      state.transform.result?.draftRevision !== revision
        ? { ...state.transform, status: "stale" }
        : state.transform,
    lastError: null,
  });
  cleanupTokens([item.sendFile]);
}

export function confirmOpenDeliveryImageRaw(
  originalFile: string,
  level: "warn" | "block"
): void {
  const state = useDeliveryStore.getState();
  const draft = state.draft;
  const item = draft?.imageFirewall.find((entry) => entry.originalFile === originalFile);
  if (!state.open || !draft || !item) return;
  const replacement = {
    ...item,
    rawConfirmation: {
      revision: item.scanRevision,
      targetToken: draft.targetSnapshot?.token ?? null,
      level,
    },
  };
  useDeliveryStore.setState({
    draft: {
      ...draft,
      imageFirewall: replaceImageFirewallItem(
        draft.imageFirewall,
        originalFile,
        replacement
      ),
    },
    lastError: null,
  });
}

/**
 * 逐项「明确保留」图片 finding：与文本 excludeFirewallFinding 同语义。
 * 保留会作废该图旧的批量确认；重扫、还原原图后保留决定随之失效。
 */
export function keepOpenDeliveryImageFinding(
  originalFile: string,
  findingId: string
): void {
  const state = useDeliveryStore.getState();
  const draft = state.draft;
  const item = draft?.imageFirewall.find((entry) => entry.originalFile === originalFile);
  if (
    !state.open || !draft || !item || item.status !== "ready" ||
    !item.findings.some((finding) => finding.id === findingId) ||
    item.keptFindingIds.includes(findingId)
  ) return;
  const replacement = {
    ...item,
    keptFindingIds: [...item.keptFindingIds, findingId],
    rawConfirmation: null,
  };
  useDeliveryStore.setState({
    draft: {
      ...draft,
      imageFirewall: replaceImageFirewallItem(
        draft.imageFirewall,
        originalFile,
        replacement
      ),
    },
    lastError: null,
  });
}

export function retryOpenDeliveryImageScan(originalFile: string): void {
  const state = useDeliveryStore.getState();
  const draft = state.draft;
  const item = draft?.imageFirewall.find((entry) => entry.originalFile === originalFile);
  if (!state.open || !draft || !item || item.status !== "failed") return;
  useDeliveryStore.setState({
    draft: {
      ...draft,
      imageFirewall: replaceImageFirewallItem(
        draft.imageFirewall,
        originalFile,
        {
          ...item,
          status: "idle",
          findings: [],
          rawConfirmation: null,
          failureMessage: null,
        }
      ),
    },
    lastError: null,
  });
  void scanOpenDeliveryDraftImages();
}
