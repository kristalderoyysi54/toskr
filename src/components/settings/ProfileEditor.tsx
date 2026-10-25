import { ShieldAlert } from "lucide-react";
import { useMemo } from "react";

import { AppAssignmentPicker } from "@/components/settings/AppAssignmentPicker";
import { DeliveryTrack } from "@/components/settings/DeliveryTrack";
import { ProfileOutputPreview } from "@/components/settings/ProfileOutputPreview";
import { SimpleSelect } from "@/components/SimpleSelect";
import { DetailsSummary } from "@/components/ui/disclosure";
import { Segmented } from "@/components/ui/segmented";
import { useT } from "@/lib/i18n";
import {
  DELIVERY_FORMAT_OPTIONS,
  ENTER_POLICY_OPTIONS,
  PRIVACY_POLICY_OPTIONS,
  formatPromptGroupOption,
  previewSelectedProfile,
} from "@/lib/profileManager";
import type { TargetSnapshot } from "@/lib/tauri";
import {
  resolveTargetProfile,
  targetProfileOutputMode,
  targetProfileOutputPatch,
  type PromptGroup,
  type PromptSnippet,
  type TargetProfile,
} from "@/lib/targetProfiles";
import { cn } from "@/lib/utils";
import { profileName } from "@/lib/i18n/builtinNames";

function EditorSection({
  number,
  title,
  searchTarget,
  children,
}: {
  number: number;
  title: string;
  searchTarget?: string;
  children: React.ReactNode;
}) {
  return (
    <section data-settings-search={searchTarget} aria-labelledby={`profile-editor-section-${number}`} className="scroll-m-5 rounded-md border-t border-border/60 py-3 transition-shadow first:border-t-0 first:pt-0 data-[settings-search-active=true]:ring-2 data-[settings-search-active=true]:ring-primary/40 data-[settings-search-active=true]:ring-offset-2 data-[settings-search-active=true]:ring-offset-background">
      <h4 id={`profile-editor-section-${number}`} className="mb-2 flex items-center gap-1.5 text-label font-semibold text-muted-foreground">
        <span className="flex size-4 items-center justify-center rounded-full bg-muted text-micro">{number}</span>
        {title}
      </h4>
      {children}
    </section>
  );
}

export function ProfileEditor({
  profile,
  profiles,
  groups,
  snippets,
  defaultProfileId,
  firewallEnabled = true,
  currentTarget,
  recentApps,
  onUpdate,
  onProfilesChange,
  onSetDefault,
}: {
  profile: TargetProfile;
  profiles: TargetProfile[];
  groups: PromptGroup[];
  snippets: PromptSnippet[];
  defaultProfileId: string;
  firewallEnabled?: boolean;
  currentTarget: TargetSnapshot | null;
  recentApps: { bundleId: string; appName: string }[];
  onUpdate: (patch: Partial<Omit<TargetProfile, "id" | "bundleIds">>) => void;
  onProfilesChange: (profiles: TargetProfile[]) => void;
  onSetDefault: () => void;
}) {
  const t = useT();
  const promptGroupOptions = useMemo(
    () => {
      const options = [...groups]
        .sort((left, right) => left.order - right.order)
        .map((group) => formatPromptGroupOption(group, snippets));
      if (!groups.some((group) => group.id === profile.promptGroupId)) {
        options.unshift({
          value: profile.promptGroupId,
          label: t("已删除的提示词组 · 请选择替代项"),
          count: 0,
          summary: t("当前生效：通用"),
        });
      }
      return options;
    },
    [groups, profile.promptGroupId, snippets, t]
  );
  const selectedGroup = promptGroupOptions.find((option) => option.value === profile.promptGroupId);
  const configuredPromptGroupName = groups.find(
    (group) => group.id === profile.promptGroupId
  )?.name ?? null;
  const previewResolution = useMemo(
    () =>
      previewSelectedProfile({
        bundleId: currentTarget?.bundleId ?? null,
        isTargetReady: Boolean(currentTarget?.ready),
        selectedProfileId: profile.id,
        profiles,
        groups,
        defaultProfileId,
        privacyCapabilityActive: firewallEnabled,
      }),
    [currentTarget?.bundleId, currentTarget?.ready, defaultProfileId, firewallEnabled, groups, profile.id, profiles]
  );
  const currentResolution = useMemo(
    () =>
      resolveTargetProfile({
        bundleId: currentTarget?.bundleId ?? null,
        isTargetReady: Boolean(currentTarget?.ready),
        groups,
        profiles,
        defaultProfileId,
        privacyCapabilityActive: firewallEnabled,
      }),
    [currentTarget?.bundleId, currentTarget?.ready, defaultProfileId, firewallEnabled, groups, profiles]
  );
  const isDefault = profile.id === defaultProfileId;
  const targetName = currentTarget?.appName || currentTarget?.bundleId || t("未识别目标");

  const privacyDescription = t(({
    requireRedaction: "每个敏感项都需替换或明确保留，处理完再粘贴。",
    confirmRaw: "普通提示可统一确认保留原文；高风险项仍需替换或明确保留。",
    allowRaw: "普通提示可直接保留原文；高风险原文仍需再次确认。",
  } as const)[profile.privacyPolicy]);

  return (
    <article aria-labelledby="profile-editor-title" className="min-w-0 rounded-xl border border-border/70 bg-card p-3">
      <header className="mb-3">
        <p className="text-micro font-medium text-muted-foreground">{t("应用粘贴规则")}</p>
        <h3 id="profile-editor-title" className="line-clamp-2 break-words text-heading font-semibold" title={profileName(profile)}>
          {profileName(profile)}
        </h3>
        <p className="mt-1 text-label text-muted-foreground">
          {t("修改立即保存，应用于使用此方案的应用。")}
        </p>
        {isDefault && (
          <p className="mt-1 text-label text-muted-foreground">
            {t("未单独设置的应用使用这套格式，不自动回车；隐私检查开启时，敏感内容仍需明确处理。")}
          </p>
        )}
      </header>

      <EditorSection number={1} title={t("粘贴格式")} searchTarget="默认发送方式">
        <fieldset>
          <legend className="sr-only">{t("默认发送方式")}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {DELIVERY_FORMAT_OPTIONS.map((option) => {
              const selected = targetProfileOutputMode(profile) === option.value;
              return (
                <label
                  key={option.value}
                  className="min-w-0 cursor-pointer"
                >
                  <input
                    type="radio"
                    name={`profile-output-format-${profile.id}`}
                    checked={selected}
                    onChange={() => onUpdate(targetProfileOutputPatch(option.value))}
                    className="peer sr-only"
                  />
                  <span className={cn(
                    "block min-h-full rounded-xl border p-2 text-left outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background",
                    selected ? "border-primary/50 bg-primary/10" : "border-border"
                  )}>
                    <span className="block text-body font-semibold">{t(option.label)}</span>
                    <span className="mt-0.5 block text-micro leading-tight text-muted-foreground">{t(option.description)}</span>
                    <span className="mt-1 line-clamp-2 block whitespace-pre-line rounded-md bg-muted/40 px-1.5 py-1 text-micro text-muted-foreground">
                      {t(option.example)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-micro text-muted-foreground">
            {t("仅影响发送副本；代码卡和秘文始终保留原内容。")}
          </p>
        </fieldset>
      </EditorSection>

      <EditorSection number={2} title={t("粘贴后动作")} searchTarget="粘贴后动作">
        <fieldset>
          <legend className="sr-only">{t("粘贴后动作")}</legend>
          <div className="grid gap-1.5">
            {ENTER_POLICY_OPTIONS.map((option) => {
              const selected = profile.enterPolicy === option.value;
              return (
                <label
                  key={option.value}
                  className="cursor-pointer"
                >
                  <input
                    type="radio"
                    name={`profile-enter-policy-${profile.id}`}
                    checked={selected}
                    onChange={() => onUpdate({ enterPolicy: option.value })}
                    className="peer sr-only"
                  />
                  <span className={cn(
                    "block rounded-lg border px-2 py-1.5 text-left outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background",
                    selected ? "border-primary/50 bg-primary/10" : "border-border"
                  )}>
                    <span className="block text-body font-medium">{t(option.label)}</span>
                    <span className="block text-micro text-muted-foreground">{t(option.risk)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/35 px-2 py-2">
          <span className="text-body">{t("粘贴完成后面板")}</span>
          <Segmented<"close" | "keep">
            ariaLabel={t("{name} 发送完成后", { name: profileName(profile) })}
            value={profile.keepPanel ? "keep" : "close"}
            options={[
              { value: "close", label: t("关闭面板") },
              { value: "keep", label: t("保持打开") },
            ]}
            onChange={(value) => onUpdate({ keepPanel: value === "keep" })}
          />
        </div>
      </EditorSection>

      <EditorSection number={3} title={t("敏感内容处理")} searchTarget="敏感内容处理">
        <div className={cn(
          "rounded-xl border p-2.5",
          firewallEnabled ? "border-border/60 bg-muted/20" : "border-warning/40 bg-warning/10"
        )}>
          <div className="flex flex-wrap items-center gap-1.5 text-label">
            <ShieldAlert aria-hidden className="size-4 text-muted-foreground" />
            <p className={cn(!firewallEnabled && "text-warning")}>
              {firewallEnabled ? t("隐私检查已开启") : t("全局隐私检查已关闭，这项规则暂不生效")}
            </p>
          </div>
          <label className="mt-2 block text-label text-muted-foreground">
            {t("发现敏感内容时")}
            <SimpleSelect
              className="mt-1"
              ariaLabel={t("{name} 发送前隐私策略", { name: profileName(profile) })}
              value={profile.privacyPolicy}
              options={PRIVACY_POLICY_OPTIONS.map(({ value, label }) => ({ value, label: t(label) }))}
              onChange={(privacyPolicy) => onUpdate({ privacyPolicy })}
            />
          </label>
          <p className="mt-2 text-label">{privacyDescription}</p>
          <p className="mt-1 text-micro text-muted-foreground">
            {t("隐私检查开启时，保留高风险原文不会自动按回车。")}
          </p>
        </div>
      </EditorSection>

      <details className="border-t border-border/60 py-3">
        <DetailsSummary className="text-label font-semibold text-muted-foreground">{t("名称、应用与模板组")}</DetailsSummary>
        <div className="mt-3">
          <EditorSection number={4} title={t("方案名称")}>
            <label className="block text-label text-muted-foreground">
              {t("方案名称")}
              <input
                aria-label={t("{name} 方案名称", { name: profileName(profile) })}
                value={profileName(profile)}
                maxLength={80}
                onChange={(event) => onUpdate({ name: event.target.value })}
                className="mt-1 h-9 w-full rounded-lg border border-border bg-transparent px-2 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              />
            </label>
            <div className="mt-2">
              {isDefault ? (
                <span className="text-label text-muted-foreground">{t("未单独设置的应用默认使用此方案")}</span>
              ) : (
                <button
                  type="button"
                  onClick={onSetDefault}
                  className="rounded-lg border border-border px-2 py-1 text-label outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background dark:hover:bg-white/10"
                >
                  {t("设为未单独设置应用的默认方案")}
                </button>
              )}
            </div>
          </EditorSection>
          <EditorSection number={5} title={t("适用应用")}>
            <AppAssignmentPicker
              profile={profile}
              profiles={profiles}
              currentTarget={currentTarget}
              recentApps={recentApps}
              onProfilesChange={onProfilesChange}
            />
          </EditorSection>
          <EditorSection number={6} title={t("模板组")}>
            <label className="block text-label text-muted-foreground">
              {t("其他模板优先显示")}
              <SimpleSelect
                className="mt-1"
                ariaLabel={t("{name} 提示词组", { name: profileName(profile) })}
                menuLabel={t("提示词组 · 数量 · 摘要")}
                value={profile.promptGroupId}
                options={promptGroupOptions}
                onChange={(promptGroupId) => onUpdate({ promptGroupId })}
              />
            </label>
            <p className="mt-1 text-micro text-muted-foreground">
              {selectedGroup ? t("{n} 条提示词 · {summary}", { n: selectedGroup.count, summary: selectedGroup.summary }) : t("暂无可用提示词组")}
            </p>
            <p className="mt-1 text-label text-muted-foreground">
              {t("只调整“其他模板”的显示顺序，不会自动套用模板；粘贴时仍由你选择。")}
            </p>
          </EditorSection>
        </div>
      </details>

      <details className="border-t border-border/60 py-3">
        <DetailsSummary className="text-label font-semibold text-muted-foreground">{t("规则生效预览")}</DetailsSummary>
        <p className="mt-2 text-label text-muted-foreground">
          {t("对比方案配置与应用默认规则，不包含主面板的本次临时调整。")}
        </p>
        <div className="mt-3 space-y-3">
          <ProfileOutputPreview mode={targetProfileOutputMode(profile)} />
          <DeliveryTrack
            configuredProfile={profile}
            configuredPromptGroupName={configuredPromptGroupName}
            previewResolution={previewResolution}
            currentResolution={currentResolution}
            targetBundleId={currentTarget?.bundleId ?? null}
            targetName={targetName}
          />
        </div>
      </details>
    </article>
  );
}
