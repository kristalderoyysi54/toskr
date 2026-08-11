import type { TargetSnapshot } from "@/lib/tauri";
import type { TransformRecipeId } from "@/lib/aiTransform";
import type { FirewallFinding, FindingCategory } from "@/lib/tauri";
import type {
  DeliveryFormat,
  EnterPolicy,
  PromptSnippet,
  PrivacyPolicy,
  TargetProfileResolution,
  TargetProfileResolutionSource,
} from "@/lib/targetProfiles";
import type { Note, Task } from "@/store/notesStore";
import type {
  FirewallStatus,
  PrivacyDecision,
} from "./firewall";

export type DeliverySourceKind = "note" | "note-batch" | "task";

export type DeliveryDraftWarning =
  | "source-missing"
  | "empty-payload";

/** 会话内投递快照；原始正文不会进入持久化 store。 */
export interface DeliveryDraft {
  id: string;
  revision: number;
  createdAtMs: number;
  sourceKind: DeliverySourceKind;
  sourceItemIds: string[];
  /** 构建时的全局勾选快照；防止旧回执清掉发送途中新增的选择。 */
  selectionItemIds: string[];
  rawText: string;
  /** 纯构建器生成的正文基线；本次手工编辑可恢复到这里。 */
  assembledText: string;
  finalText: string;
  imageFiles: string[];
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
}
