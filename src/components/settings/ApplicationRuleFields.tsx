import type { ReactNode } from "react";

import { ProfileOutputPreview } from "@/components/settings/ProfileOutputPreview";
import { SimpleSelect } from "@/components/SimpleSelect";
import { DetailsSummary } from "@/components/ui/disclosure";
import { Segmented } from "@/components/ui/segmented";
import type { ApplicationRuleValues } from "@/lib/applicationRules";
import {
  DELIVERY_FORMAT_OPTIONS,
  ENTER_POLICY_OPTIONS,
  PRIVACY_POLICY_OPTIONS,
  formatPromptGroupOption,
} from "@/lib/profileManager";
import {
  targetProfileOutputMode,
  targetProfileOutputPatch,
  type PromptGroup,
  type PromptSnippet,
  type TargetProfile,
} from "@/lib/targetProfiles";

function RuleField({ label, description, searchTarget, children }: {
  label: string;
  description: string;
  searchTarget?: string;
  children: ReactNode;
}) {
  return (
    <div data-settings-search={searchTarget} className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-title">{label}</p>
        <p className="mt-0.5 text-label text-muted-foreground">{description}</p>
      </div>
      <div className="max-w-full shrink-0">{children}</div>
    </div>
  );
}

export function ApplicationRuleFields({ profile, groups, snippets, firewallEnabled, fallback, onUpdate }: {
  profile: TargetProfile;
  groups: PromptGroup[];
  snippets: PromptSnippet[];
  firewallEnabled: boolean;
  fallback: boolean;
  onUpdate: (patch: Partial<ApplicationRuleValues>) => void;
}) {
  const outputMode = targetProfileOutputMode(profile);
  const enterPolicy = fallback ? "never" : profile.enterPolicy;
  const privacyPolicy = fallback ? "requireRedaction" : profile.privacyPolicy;
  const formatDescription = DELIVERY_FORMAT_OPTIONS.find((option) => option.value === outputMode)!.description;
  const enterDescription = fallback
    ? "默认规则始终只粘贴，不自动回车。"
    : ENTER_POLICY_OPTIONS.find((option) => option.value === enterPolicy)!.risk;
  const privacyDescription = !firewallEnabled
    ? "全局隐私检查已关闭，这项规则暂不生效；开启后使用所选策略。"
    : privacyPolicy === "requireRedaction"
      ? "逐项明确选择替换或保留原文，不会自动全部替换。"
      : privacyPolicy === "confirmRaw"
        ? "普通提示项保留原文时，发送前需要确认。"
        : "普通提示项允许保留原文；高风险原文仍需二次确认。";
  const groupOptions = [...groups]
    .sort((left, right) => left.order - right.order)
    .map((group) => formatPromptGroupOption(group, snippets));
  if (!groups.some((group) => group.id === profile.promptGroupId)) {
    groupOptions.unshift({
      value: profile.promptGroupId,
      label: "已删除的提示词组 · 请选择替代项",
      count: 0,
      summary: "当前生效：通用",
    });
  }
  const selectedGroup = groupOptions.find((group) => group.value === profile.promptGroupId);

  return (
    <div className="min-w-0 space-y-4">
      <div className="divide-y divide-border/60">
        <RuleField label="输出格式" description={formatDescription} searchTarget="默认发送方式">
          <SimpleSelect
            className="w-56 max-w-full"
            ariaLabel={`${profile.name} 输出格式`}
            align="end"
            value={outputMode}
            options={DELIVERY_FORMAT_OPTIONS}
            onChange={(mode) => onUpdate(targetProfileOutputPatch(mode))}
          />
        </RuleField>
        <RuleField label="回车策略" description={enterDescription} searchTarget="粘贴后动作">
          <SimpleSelect
            className="w-56 max-w-full"
            ariaLabel={`${profile.name} 回车策略`}
            align="end"
            value={enterPolicy}
            options={ENTER_POLICY_OPTIONS}
            disabled={fallback}
            onChange={(value) => { if (!fallback) onUpdate({ enterPolicy: value }); }}
          />
        </RuleField>
        <RuleField label="敏感处理" description={privacyDescription} searchTarget="敏感内容处理">
          <SimpleSelect
            className="w-56 max-w-full"
            ariaLabel={`${profile.name} 发送前隐私策略`}
            align="end"
            value={privacyPolicy}
            options={PRIVACY_POLICY_OPTIONS}
            disabled={fallback}
            onChange={(value) => { if (!fallback) onUpdate({ privacyPolicy: value }); }}
          />
        </RuleField>
        <RuleField label="完成后面板" description="粘贴成功后收起或保持打开；钉住时始终打开。">
          <Segmented<"close" | "keep">
            ariaLabel={`${profile.name} 发送完成后`}
            value={profile.keepPanel ? "keep" : "close"}
            options={[
              { value: "close", label: "收起面板" },
              { value: "keep", label: "保持打开" },
            ]}
            onChange={(value) => onUpdate({ keepPanel: value === "keep" })}
          />
        </RuleField>
      </div>
      <details className="rounded-lg border border-border/60 px-3 py-2">
        <DetailsSummary className="text-label font-medium text-muted-foreground">模板排序</DetailsSummary>
        <div data-settings-search="模板组" className="mt-3 space-y-2">
          <p className="text-label text-muted-foreground">「其他模板」里优先显示</p>
          <SimpleSelect
            ariaLabel={`${profile.name} 提示词组`}
            menuLabel="提示词组 · 数量 · 摘要"
            value={profile.promptGroupId}
            options={groupOptions}
            onChange={(promptGroupId) => onUpdate({ promptGroupId })}
          />
          <p className="text-micro text-muted-foreground">
            {selectedGroup ? `${selectedGroup.count} 条提示词 · ${selectedGroup.summary}` : "暂无可用提示词组"}
          </p>
          <p className="text-label text-muted-foreground">
            只影响「其他模板」的顺序，不会自动套用模板。
          </p>
        </div>
      </details>
      <section data-settings-search="规则生效预览" aria-label="输出格式预览" className="min-w-0 border-t border-border/60 pt-4">
        <h3 className="text-title">输出预览</h3>
        <p className="mt-0.5 text-label text-muted-foreground">
          用示例内容预览输出格式，不做隐私处理，也不会真实粘贴或回车。
        </p>
        <ProfileOutputPreview mode={outputMode} />
      </section>
    </div>
  );
}
