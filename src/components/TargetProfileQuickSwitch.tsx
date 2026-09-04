import {
  Check,
  Link2,
  RotateCcw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ApplicationIcon } from "@/components/ApplicationIcon";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { AppIconInfo } from "@/lib/icons";
import {
  DELIVERY_FORMAT_LABEL,
  ENTER_POLICY_STATUS_LABEL,
  profileDiffSummary,
  quickSwitchKeyboardCommand,
  type QuickProfileOption,
} from "@/lib/targetLens";
import {
  targetProfileOutputMode,
  type DeliveryOutputMode,
  type TargetRuleOverrideKey,
  type TargetRuleOverrides,
} from "@/lib/targetProfiles";
import { cn } from "@/lib/utils";
import { targetStatusLabel, type TargetStatus } from "@/store/targetStore";

/** 台账键/值样式（A 版定稿）：键 micro 灰右对齐，值 label 亮字左对齐，行高统一对基线。 */
const LEDGER_KEY_CLS = "text-right text-micro leading-4 text-muted-foreground";
const LEDGER_VALUE_CLS = "min-w-0 break-words text-label font-medium leading-4";

/** 台账行内快捷切换的注入包：缺省时台账保持纯只读展示。 */
export interface RuleLedgerInteractive {
  promptGroupOptions: { value: string; label: string }[];
  overriddenKeys: readonly TargetRuleOverrideKey[];
  disabled?: boolean;
  onOverride: (patch: TargetRuleOverrides) => void;
  onReset: () => void;
}

const OUTPUT_MODE_OPTIONS: readonly {
  value: DeliveryOutputMode;
  label: string;
}[] = [
  { value: "plain", label: DELIVERY_FORMAT_LABEL.plain },
  {
    value: "strip-markdown",
    label: DELIVERY_FORMAT_LABEL["strip-markdown"],
  },
  { value: "code", label: DELIVERY_FORMAT_LABEL.code },
];

/** 覆盖行的「本次」徽标：提示该值只对当前目标临时生效。 */
function OverriddenBadge() {
  return (
    <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-px text-micro font-semibold text-primary">
      本次
    </span>
  );
}

/**
 * 生效规则台账（快速切换浮层与透镜条展开区共用）：
 * 五行两列取代「键：值」胶囊——键弱值强、逐行对齐；
 * 警示值（自动回车 / 隐私未启用）染 warning，其余保持前景色。
 * 注入 interactive 后，前四行变为行内快捷选择（本次生效、换目标即失效）；
 * 隐私检查恒只读——高风险项不做一键降级，仍走「编辑方案」。
 */
export function ProfileRuleLedger({
  profile,
  privacyCapabilityActive,
  interactive,
  className,
}: {
  profile: QuickProfileOption;
  privacyCapabilityActive: boolean;
  interactive?: RuleLedgerInteractive;
  className?: string;
}) {
  const hasOverrides = (interactive?.overriddenKeys.length ?? 0) > 0;
  return (
    <div className={className} data-rule-ledger={interactive ? "" : undefined}>
      <dl
        aria-label="本次生效规则"
        className="grid grid-cols-[52px_1fr] items-center gap-x-3 gap-y-1"
      >
        <dt className={LEDGER_KEY_CLS}>提示词组</dt>
        <dd className={cn(LEDGER_VALUE_CLS, "flex items-center gap-1.5")}>
          {interactive ? (
            <SimpleSelect
              ariaLabel="本次提示词组"
              size="micro"
              disabled={interactive.disabled}
              value={profile.promptGroupId}
              options={interactive.promptGroupOptions}
              onChange={(promptGroupId) =>
                interactive.onOverride({ promptGroupId })
              }
            />
          ) : (
            profile.promptGroupName
          )}
          {interactive?.overriddenKeys.includes("promptGroupId") && (
            <OverriddenBadge />
          )}
        </dd>
        <dt className={LEDGER_KEY_CLS}>输出格式</dt>
        <dd className={cn(LEDGER_VALUE_CLS, "flex items-center gap-1.5")}>
          {interactive ? (
            <SimpleSelect
              ariaLabel="本次输出格式"
              size="micro"
              disabled={interactive.disabled}
              value={targetProfileOutputMode(profile)}
              options={OUTPUT_MODE_OPTIONS}
              onChange={(defaultOutputMode) =>
                interactive.onOverride({ defaultOutputMode })
              }
            />
          ) : (
            DELIVERY_FORMAT_LABEL[targetProfileOutputMode(profile)]
          )}
          {interactive?.overriddenKeys.includes("defaultOutputMode") && (
            <OverriddenBadge />
          )}
        </dd>
        <dt className={LEDGER_KEY_CLS}>粘贴后</dt>
        <dd
          className={cn(
            LEDGER_VALUE_CLS,
            "flex items-center gap-1.5",
            !interactive && profile.enterPolicy === "allow" && "text-warning"
          )}
        >
          {interactive ? (
            <SimpleSelect
              ariaLabel="本次粘贴后动作"
              size="micro"
              disabled={interactive.disabled}
              value={profile.enterPolicy}
              options={[
                { value: "never", label: ENTER_POLICY_STATUS_LABEL.never },
                { value: "confirm", label: ENTER_POLICY_STATUS_LABEL.confirm },
                { value: "allow", label: ENTER_POLICY_STATUS_LABEL.allow },
              ]}
              onChange={(enterPolicy) => interactive.onOverride({ enterPolicy })}
            />
          ) : (
            ENTER_POLICY_STATUS_LABEL[profile.enterPolicy]
          )}
          {interactive && profile.enterPolicy === "allow" && (
            <ShieldAlert aria-hidden className="size-3 shrink-0 text-warning" />
          )}
          {interactive?.overriddenKeys.includes("enterPolicy") && (
            <OverriddenBadge />
          )}
        </dd>
        <dt className={LEDGER_KEY_CLS}>完成后</dt>
        <dd className={cn(LEDGER_VALUE_CLS, "flex items-center gap-1.5")}>
          {interactive ? (
            <SimpleSelect
              ariaLabel="本次发送完成后"
              size="micro"
              disabled={interactive.disabled}
              value={profile.keepPanel ? "keep" : "close"}
              options={[
                { value: "close", label: "关闭面板" },
                { value: "keep", label: "保持打开" },
              ]}
              onChange={(value) =>
                interactive.onOverride({ keepPanel: value === "keep" })
              }
            />
          ) : profile.keepPanel ? (
            "保持打开"
          ) : (
            "关闭面板"
          )}
          {interactive?.overriddenKeys.includes("keepPanel") && (
            <OverriddenBadge />
          )}
        </dd>
        <dt className={LEDGER_KEY_CLS}>隐私检查</dt>
        <dd
          className={cn(
            LEDGER_VALUE_CLS,
            "flex items-center gap-1",
            !privacyCapabilityActive && "text-warning"
          )}
        >
          {privacyCapabilityActive ? (
            <ShieldCheck aria-hidden className="size-3 shrink-0 text-success" />
          ) : (
            <ShieldAlert aria-hidden className="size-3 shrink-0" />
          )}
          {privacyCapabilityActive ? "发送时执行" : "尚未启用"}
        </dd>
      </dl>
      {hasOverrides && interactive && (
        <button
          type="button"
          onClick={interactive.onReset}
          className="mt-1.5 flex items-center gap-1 rounded-sm text-micro text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          <RotateCcw aria-hidden className="size-3" />
          恢复方案默认规则
        </button>
      )}
    </div>
  );
}

/** 区块标题（cap 样式）：中文吃字距不吃大小写，与分组头 tracking 同款。 */
function SectionCap({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 text-micro font-semibold tracking-[0.08em] text-muted-foreground">
      {children}
    </p>
  );
}

export function TargetProfileQuickSwitch({
  appName,
  icon,
  status,
  matchReason,
  currentProfile,
  candidates,
  privacyCapabilityActive,
  ruleInteractive,
  temporaryProfileId,
  automaticProfileName,
  canMakePermanent,
  onSelectTemporary,
  onRestoreAutomatic,
  onMakePermanent,
  onEdit,
  onClose,
}: {
  appName: string;
  icon: AppIconInfo | null;
  status: TargetStatus;
  matchReason: string;
  currentProfile: QuickProfileOption;
  candidates: QuickProfileOption[];
  privacyCapabilityActive: boolean;
  ruleInteractive?: RuleLedgerInteractive;
  temporaryProfileId: string | null;
  automaticProfileName: string;
  canMakePermanent: boolean;
  onSelectTemporary: (profileId: string) => void;
  onRestoreAutomatic: () => void;
  onMakePermanent: () => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const visibleCandidates = useMemo(() => candidates.slice(0, 3), [candidates]);
  const [activeProfileId, setActiveProfileId] = useState(currentProfile.id);
  const activeIndex = visibleCandidates.findIndex(
    (profile) => profile.id === activeProfileId
  );
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const candidateKey = visibleCandidates.map((profile) => profile.id).join("\u0000");
  const statusLabel = targetStatusLabel(status);
  const targetReady = status === "ready";
  const statusTone = targetReady
    ? "bg-success/10 text-success ring-success/30"
    : status === "blocked" || status === "unknown"
      ? "bg-destructive/10 text-destructive ring-destructive/30"
      : "bg-muted text-muted-foreground ring-border";

  useEffect(() => {
    if (activeIndex >= 0) return;
    setActiveProfileId(
      visibleCandidates.some((profile) => profile.id === currentProfile.id)
        ? currentProfile.id
        : (visibleCandidates[0]?.id ?? "")
    );
  }, [activeIndex, candidateKey, currentProfile.id, visibleCandidates]);

  useEffect(() => {
    optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, candidateKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 台账行内下拉展开时，↑↓/Enter/Esc 属于该菜单；方案列表导航让位
      if (
        (event.target as HTMLElement | null)?.closest?.("[data-rule-ledger]")
      ) {
        return;
      }
      const command = quickSwitchKeyboardCommand(
        event.key,
        activeIndex,
        visibleCandidates.length
      );
      if (!command) return;
      if (command.type === "select") {
        if (!targetReady) return;
        if (
          !(event.target as HTMLElement | null)?.closest?.(
            "[data-quick-profile-option]"
          )
        ) {
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      if (command.type === "close") {
        onClose();
      } else if (command.type === "move") {
        const profile = visibleCandidates[command.index];
        if (profile) setActiveProfileId(profile.id);
      } else {
        const profile = visibleCandidates[command.index];
        if (profile && profile.id !== currentProfile.id) {
          onSelectTemporary(profile.id);
        }
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [activeIndex, currentProfile.id, onClose, onSelectTemporary, targetReady, visibleCandidates]);

  return (
    <div className="flex min-w-0 flex-col" aria-label={`发送到 ${appName}`}>
      <header className="flex min-w-0 items-center gap-2">
        <ApplicationIcon
          src={icon?.url}
          name={appName}
          className="size-6 rounded-md"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-title font-semibold" title={appName}>
            发送到 {appName}
          </p>
          {/* 匹配来源直接给结论（前缀「匹配来源：」是系统视角术语，去掉） */}
          <p className="line-clamp-2 break-words text-micro leading-tight text-muted-foreground">
            {matchReason}
          </p>
        </div>
        <span
          role="status"
          aria-live="off"
          aria-label={`目标状态：${statusLabel}`}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-micro font-medium ring-1 ring-inset",
            statusTone
          )}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {statusLabel}
        </span>
      </header>

      <div aria-hidden className="-mx-2 my-2.5 h-px bg-border/60" />

      <section aria-labelledby="quick-profile-options-label">
        <p
          id="quick-profile-options-label"
          className="mb-1.5 text-micro font-semibold tracking-[0.08em] text-muted-foreground"
        >
          发送方案
          <span className="ml-1.5 font-normal tracking-normal text-muted-foreground">
            ↑↓ 移动 · Enter 使用
          </span>
        </p>
        <div role="listbox" aria-label="选择本次临时发送方案" className="space-y-0.5">
          {visibleCandidates.map((profile, index) => {
            const selected = profile.id === currentProfile.id;
            const diffs = selected ? [] : profileDiffSummary(profile, currentProfile);
            const diffText = diffs.length ? diffs.join(" · ") : "与当前参数相同";
            // 差异里引入自动回车属于新增风险，副行整体染警示色
            const diffWarning =
              profile.enterPolicy === "allow" &&
              profile.enterPolicy !== currentProfile.enterPolicy;
            return (
              <button
                key={profile.id}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                role="option"
                aria-selected={selected}
                data-quick-profile-option={profile.id}
                tabIndex={index === activeIndex ? 0 : -1}
                disabled={!targetReady}
                onFocus={() => setActiveProfileId(profile.id)}
                onClick={() => {
                  if (!selected) onSelectTemporary(profile.id);
                }}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-100 motion-reduce:transition-none",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-40",
                  selected
                    ? "bg-primary/10 ring-1 ring-inset ring-primary/25"
                    : "hover:bg-black/5 dark:hover:bg-white/10"
                )}
              >
                <Check
                  aria-hidden
                  className={cn("size-3 shrink-0 text-primary", !selected && "invisible")}
                />
                <span
                  className="min-w-0 shrink-0 truncate text-label font-semibold"
                  title={profile.name}
                >
                  {profile.name}
                </span>
                {selected ? (
                  <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 py-px text-micro font-semibold text-primary">
                    当前
                  </span>
                ) : (
                  <span
                    className={cn(
                      "ml-auto min-w-0 truncate text-micro",
                      diffWarning ? "text-warning" : "text-muted-foreground"
                    )}
                    title={diffText}
                  >
                    {diffText}
                  </span>
                )}
              </button>
            );
          })}
          {visibleCandidates.length === 0 && (
            <p className="rounded-md bg-muted/40 px-2 py-1.5 text-body text-muted-foreground">
              暂无可切换方案
            </p>
          )}
        </div>
      </section>

      <div aria-hidden className="-mx-2 my-2.5 h-px bg-border/60" />

      <section aria-label="本次生效规则">
        <SectionCap>本次生效规则</SectionCap>
        <ProfileRuleLedger
          profile={currentProfile}
          privacyCapabilityActive={privacyCapabilityActive}
          interactive={ruleInteractive}
        />
      </section>

      {temporaryProfileId && canMakePermanent && (
        <button
          type="button"
          onClick={() => {
            onMakePermanent();
            onClose();
          }}
          className="mt-2.5 flex min-w-0 items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-left text-body outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background dark:hover:bg-white/10"
        >
          <Link2 aria-hidden className="size-3.5 shrink-0" />
          <span className="line-clamp-2 break-words">
            以后发给 {appName} 都使用此方案
          </span>
        </button>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2">
        <button
          type="button"
          disabled={!temporaryProfileId}
          title={`恢复自动匹配：${automaticProfileName}`}
          onClick={() => {
            onRestoreAutomatic();
            onClose();
          }}
          className="flex items-center gap-1 rounded-sm text-micro text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-40"
        >
          <RotateCcw aria-hidden className="size-3" />
          恢复自动匹配
        </button>
        <button
          type="button"
          title={`编辑 ${appName} 的发送方案`}
          onClick={() => {
            onClose();
            onEdit();
          }}
          className="ml-auto flex items-center gap-1 rounded-sm text-micro text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          <Settings2 aria-hidden className="size-3" />
          编辑方案
        </button>
      </div>
    </div>
  );
}
