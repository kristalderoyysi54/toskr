import type { DeliverySegment, TargetSnapshot } from "@/lib/tauri";
import type { TransformRecipeId } from "@/lib/aiTransform";
import type {
  FirewallFinding,
  FindingCategory,
  ImageFirewallFinding,
  ImagePixelBox,
} from "@/lib/tauri";
import type {
  DeliveryFormat,
  EnterPolicy,
  PromptSnippet,
  PrivacyPolicy,
  TargetProfileResolution,
  TargetProfileResolutionSource,
} from "@/lib/targetProfiles";
import type { Note, Task } from "@/store/notesStore";
import type { AliasEntity } from "./aliasEntities";
import type {
  FirewallStatus,
  PrivacyDecision,
  RawPrivacyConfirmation,
} from "./firewall";

export type ImageFirewallStatus =
  | "idle"
  | "scanning"
  | "ready"
  | "redacting"
  | "failed"
  | "disabled";

/** OCR 原文永不进入此结构；Draft 只保留遮罩决策所需元数据。 */
export interface ImageFirewallItem {
  originalFile: string;
  sendFile: string;
  status: ImageFirewallStatus;
  pixelHash: string | null;
  redactedPixelHash: string | null;
  width: number | null;
  height: number | null;
  scanRevision: number;
  findings: ImageFirewallFinding[];
  redactedFindingIds: string[];
  /** 用户逐项「明确保留」的 finding（与文本 excludedFindingIds 同语义）；重扫/还原即失效。 */
  keptFindingIds: string[];
  /** 用户手工框选的实色遮挡区域；与 OCR finding 决策分开保存。 */
  manualRegions: ImagePixelBox[];
  rawConfirmation: RawPrivacyConfirmation | null;
  failureMessage: string | null;
}

export type DeliverySourceKind = "note" | "note-batch" | "task";

export type DeliveryDraftWarning =
  | "source-missing"
  | "empty-payload";

/** 会话内发送快照；原始正文不会进入持久化 store。 */
export interface DeliveryDraft {
  id: string;
  revision: number;
  createdAtMs: number;
  sourceKind: DeliverySourceKind;
  sourceItemIds: string[];
  /** 构建时的全局勾选快照；防止旧回执清掉发送途中新增的选择。 */
  selectionItemIds: string[];
  rawText: string;
  /**
   * 片段发送快照（详情窗「发送选中」）；null = 整卡发送。
   * 新鲜度复核与预检重组的重建入参必须回传它，否则片段会被误判「来源已变化」。
   */
  sourceTextOverride: string | null;
  /** 纯构建器生成的正文基线；本次手工编辑可恢复到这里。 */
  assembledText: string;
  finalText: string;
  /** 构建时的权威来源；图片遮挡后新鲜度仍只与原图比较。 */
  originalImageFiles: string[];
  /** Native 实际读取的附件；只允许原图名或当前 Draft 的遮挡副本 token。 */
  imageFiles: string[];
  /**
   * 单卡图文交错发送顺序；null = 整段文字在前、图片在后。
   * 仅在正文未经任何变换（finalText === rawText）时生成，发送前同一条件
   * 复核，预检改过正文即自动退回默认顺序。
   */
  segments: DeliverySegment[] | null;
  imageFirewall: ImageFirewallItem[];
  format: DeliveryFormat;
  promptSnippetId: string | null;
  /** 最后一次实际应用到正文的 AI 配方；手工修改/恢复后清空。 */
  transformRecipeId: TransformRecipeId | null;
  /** 所选模板打开 Draft 时的分组；模板跨组移动会使旧 Draft 失效。 */
  promptSnippetGroupId: string | null;
  /** 会话内 Prompt 快照；与正文一样不持久化、不写诊断日志。 */
  promptTemplate: string | null;
  targetSnapshot: TargetSnapshot | null;
  targetProfileId: string;
  promptGroupId: string;
  profileSource: TargetProfileResolutionSource;
  profileDefaultFormat: DeliveryFormat;
  /** Profile 的原始 keepPanel；与本次可覆写的 keepPanel 分离。 */
  profileKeepPanel: boolean;
  privacyPolicy: PrivacyPolicy;
  /** 本次设置快照；变化后旧 Draft 必须失效，避免策略在预检中途漂移。 */
  firewallEnabled: boolean;
  firewallDisabledWarnCategories: FindingCategory[];
  firewallStatus: FirewallStatus;
  findings: FirewallFinding[];
  /** 原值 → 稳定占位符，仅存在于非持久化 DeliveryStore 会话。 */
  redactionMap: Record<string, string>;
  /** 构建时按词典自动化名的命中数；预检逐项还原会递减。 */
  aliasReplacedCount: number;
  scanRevision: number;
  privacyDecision: PrivacyDecision;
  enterPolicy: EnterPolicy;
  /** confirm 策略是否已在本次预检/确认框明确授权。 */
  enterDecisionConfirmed: boolean;
  pressEnter: boolean;
  keepPanel: boolean;
  /** 受控上手演练：仅当前会话有效，执行器必须强制不按回车并保留面板。 */
  safeRehearsal?: true;
  warnings: DeliveryDraftWarning[];
  /** 只用于阻止跨数据目录副作用，不包含正文。 */
  dataGeneration: number;
}

export interface DeliveryDraftInput {
  id: string;
  revision: number;
  createdAtMs: number;
  sourceKind: DeliverySourceKind;
  sourceItemIds: string[];
  format?: DeliveryFormat;
  promptSnippetId?: string | null;
  promptTemplate?: string;
  /**
   * 片段发送：以该文本取代来源笔记正文（详情窗选词/选段的「发送选中」）。
   * 仅单条 note 来源生效；片段是纯文字，图片附件不随行。
   */
  sourceTextOverride?: string;
}

/** 纯构建所需的只读会话状态。 */
export interface DeliveryDraftBuildState {
  notes: readonly Note[];
  tasks: readonly Task[];
  promptSnippets: readonly PromptSnippet[];
  checkedItemIds: readonly string[];
  targetSnapshot: TargetSnapshot | null;
  profileResolution: TargetProfileResolution;
  panelPinned: boolean;
  dataGeneration: number;
  firewallEnabled: boolean;
  firewallDisabledWarnCategories: readonly FindingCategory[];
  aliasEntitiesEnabled: boolean;
  aliasEntities: readonly AliasEntity[];
}
