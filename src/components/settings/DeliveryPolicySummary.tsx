import { DELIVERY_FORMAT_LABEL, ENTER_POLICY_STATUS_LABEL } from "@/lib/targetLens";
import { PRIVACY_POLICY_OPTIONS } from "@/lib/profileManager";
import { cn } from "@/lib/utils";
import { targetProfileOutputMode, type TargetProfile } from "@/lib/targetProfiles";

export function DeliveryPolicySummary({
  profile,
  privacyCapabilityActive = false,
  className,
}: {
  profile: TargetProfile;
  privacyCapabilityActive?: boolean;
  className?: string;
}) {
  const rules = [
    { label: "粘贴格式", value: DELIVERY_FORMAT_LABEL[targetProfileOutputMode(profile)], warning: false },
    {
      label: "粘贴后动作", value: ENTER_POLICY_STATUS_LABEL[profile.enterPolicy],
      warning: profile.enterPolicy === "allow",
    },
    {
      label: "完成后面板", value: profile.keepPanel ? "保持打开" : "关闭面板",
      warning: false,
    },
    {
      label: "隐私检查", value: privacyCapabilityActive ? "已开启" : "已关闭 · 不检查",
      warning: !privacyCapabilityActive,
    },
    {
      label: "发现敏感内容",
      value: `${PRIVACY_POLICY_OPTIONS.find((option) => option.value === profile.privacyPolicy)?.label ?? "未设置"}${privacyCapabilityActive ? "" : "（检查关闭时不生效）"}`,
      warning: false,
    },
  ];

  return (
    <dl className={cn("space-y-1.5 text-label", className)} aria-label="应用默认粘贴规则">
      {rules.map((rule) => (
        <div key={rule.label} className="flex min-w-0 items-start justify-between gap-3">
          <dt className="shrink-0 text-muted-foreground">{rule.label}</dt>
          <dd className={cn("min-w-0 break-words text-right", rule.warning && "text-warning")}>
            {rule.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
