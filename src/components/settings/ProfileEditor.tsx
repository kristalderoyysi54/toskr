import { ShieldAlert } from "lucide-react";
import { useMemo } from "react";

import { AppAssignmentPicker } from "@/components/settings/AppAssignmentPicker";
import { DeliveryTrack } from "@/components/settings/DeliveryTrack";
import { SimpleSelect } from "@/components/SimpleSelect";
import { Segmented } from "@/components/ui/segmented";
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
  type PromptGroup,
  type PromptSnippet,
  type TargetProfile,
} from "@/lib/targetProfiles";
import { cn } from "@/lib/utils";

function EditorSection({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`profile-editor-section-${number}`} className="border-t border-border/60 py-3 first:border-t-0 first:pt-0">
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
  const promptGroupOptions = useMemo(
    () => {
      const options = [...groups]
        .sort((left, right) => left.order - right.order)
        .map((group) => formatPromptGroupOption(group, snippets));
      if (!groups.some((group) => group.id === profile.promptGroupId)) {
        options.unshift({
          value: profile.promptGroupId,
          label: "已删除的提示词组 · 请选择替代项",
          count: 0,
          summary: "当前生效：通用",
        });
      }
      return options;
    },
    [groups, profile.promptGroupId, snippets]
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
  const targetName = currentTarget?.appName || currentTarget?.bundleId || "未识别目标";

  return (
    <article aria-labelledby="profile-editor-title" className="min-w-0 rounded-xl border border-border/70 bg-card p-3">
      <header className="mb-1 flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-micro font-medium text-muted-foreground">方案编辑器</p>
          <h3 id="profile-editor-title" className="line-clamp-2 break-words text-heading font-semibold" title={profile.name}>
            {profile.name}
          </h3>
        </div>
        {isDefault ? (
          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
            未识别应用的默认方案
          </span>
        ) : (
          <button
            type="button"
            onClick={onSetDefault}
            className="rounded-lg border border-border px-2 py-1 text-label outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background dark:hover:bg-white/10"
          >
            设为未识别应用的默认方案
          </button>
        )}
      </header>

      <EditorSection number={1} title="基本信息">
        <label className="block text-label text-muted-foreground">
          方案名称
          <input
            aria-label={`${profile.name} 方案名称`}
            value={profile.name}
            maxLength={80}
            onChange={(event) => onUpdate({ name: event.target.value })}
            className="mt-1 h-9 w-full rounded-lg border border-border bg-transparent px-2 text-body text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />
        </label>
      </EditorSection>

      <EditorSection number={2} title="适用应用">
        <AppAssignmentPicker
          profile={profile}
          profiles={profiles}
          currentTarget={currentTarget}
          recentApps={recentApps}
          onProfilesChange={onProfilesChange}
        />
      </EditorSection>

      <EditorSection number={3} title="内容与格式">
        <label className="block text-label text-muted-foreground">
          提示词组
          <SimpleSelect
            className="mt-1"
            ariaLabel={`${profile.name} 提示词组`}
            menuLabel="提示词组 · 数量 · 摘要"
            value={profile.promptGroupId}
            options={promptGroupOptions}
            onChange={(promptGroupId) => onUpdate({ promptGroupId })}
          />
        </label>
        <p className="mt-1 text-micro text-muted-foreground">
          {selectedGroup ? `${selectedGroup.count} 条提示词 · ${selectedGroup.summary}` : "暂无可用提示词组"}
        </p>

        <fieldset className="mt-3">
          <legend className="mb-1 text-label text-muted-foreground">输出格式</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {DELIVERY_FORMAT_OPTIONS.map((option) => {
              const selected = profile.defaultFormat === option.value;
              return (
                <label
                  key={option.value}
                  className="min-w-0 cursor-pointer"
                >
                  <input
                    type="radio"
                    name={`profile-output-format-${profile.id}`}
                    checked={selected}
                    onChange={() => onUpdate({ defaultFormat: option.value })}
                    className="peer sr-only"
                  />
                  <span className={cn(
                    "block min-h-full rounded-xl border p-2 text-left outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background",
                    selected ? "border-primary/50 bg-primary/10" : "border-border"
                  )}>
                    <span className="block text-body font-semibold">{option.label}</span>
                    <span className="mt-0.5 block text-micro leading-tight text-muted-foreground">{option.description}</span>
                    <span className="mt-1 line-clamp-2 block whitespace-pre-line rounded-md bg-muted/40 px-1.5 py-1 text-micro text-muted-foreground">
                      {option.example}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </EditorSection>

      <EditorSection number={4} title="发送行为">
        <fieldset>
          <legend className="mb-1 text-label text-muted-foreground">粘贴后动作</legend>
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
                    <span className="block text-body font-medium">{option.label}</span>
                    <span className="block text-micro text-muted-foreground">{option.risk}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/35 px-2 py-2">
          <span className="text-body">发送完成后</span>
          <Segmented<"close" | "keep">
            ariaLabel={`${profile.name} 发送完成后`}
            value={profile.keepPanel ? "keep" : "close"}
            options={[
              { value: "close", label: "关闭面板" },
              { value: "keep", label: "保持打开" },
            ]}
            onChange={(value) => onUpdate({ keepPanel: value === "keep" })}
          />
        </div>
      </EditorSection>

      {/* 与全局「发送前隐私检查」总开关区分：此处只决定命中敏感项后的处置粒度 */}
      <EditorSection number={5} title="隐私命中后处理策略">
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <ShieldAlert aria-hidden className="size-4 text-warning" />
            <p className="text-body font-semibold">隐私命中后处理策略</p>
            <span className={cn(
              "rounded-sm px-1.5 py-0.5 text-micro font-medium",
              firewallEnabled
                ? "bg-success/10 text-success"
                : "bg-warning/15 text-warning"
            )}>
              {firewallEnabled ? "已启用" : "总开关已关闭"}
            </span>
          </div>
          <p className="mt-1 text-label text-foreground">
            发送前在本机检查最终文本；发现敏感项后按此方案决定脱敏、确认或阻止。
          </p>
          <label className="mt-2 block text-label text-muted-foreground">
            隐私策略
            <SimpleSelect
              className="mt-1"
              ariaLabel={`${profile.name} 发送前隐私策略`}
              value={profile.privacyPolicy}
              options={PRIVACY_POLICY_OPTIONS}
              onChange={(privacyPolicy) => onUpdate({ privacyPolicy })}
            />
          </label>
        </div>
      </EditorSection>

      <EditorSection number={6} title="实时效果预览">
        <DeliveryTrack
          configuredProfile={profile}
          configuredPromptGroupName={configuredPromptGroupName}
          previewResolution={previewResolution}
          currentResolution={currentResolution}
          targetBundleId={currentTarget?.bundleId ?? null}
          targetName={targetName}
        />
      </EditorSection>
    </article>
  );
}
