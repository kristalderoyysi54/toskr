import { useT, type MessageKey } from "@/lib/i18n";
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
  const t = useT();
  const privacyLabel = PRIVACY_POLICY_OPTIONS.find((option) => option.value === profile.privacyPolicy)?.label;
  // targetLens 标签表仍是 string；有英文条目即翻译，缺条目时 t 回落中文原文
  const rules = [
    { label: t("粘贴格式"), value: t(DELIVERY_FORMAT_LABEL[targetProfileOutputMode(profile)] as MessageKey), warning: false },
    {
      label: t("粘贴后动作"), value: t(ENTER_POLICY_STATUS_LABEL[profile.enterPolicy] as MessageKey),
      warning: profile.enterPolicy === "allow",
    },
    {
      label: t("完成后面板"), value: profile.keepPanel ? t("保持打开") : t("关闭面板"),
      warning: false,
    },
    {
      label: t("隐私检查"), value: privacyCapabilityActive ? t("已开启") : t("已关闭 · 不检查"),
      warning: !privacyCapabilityActive,
    },
    {
      label: t("发现敏感内容"),
      value: `${privacyLabel ? t(privacyLabel) : t("未设置")}${privacyCapabilityActive ? "" : t("（检查关闭时不生效）")}`,
      warning: false,
    },
  ];

  return (
    <dl className={cn("space-y-1.5 text-label", className)} aria-label={t("应用默认粘贴规则")}>
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
