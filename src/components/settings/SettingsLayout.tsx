import { ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * 设置页版式骨架（2026-09-26 主次分明重排）：
 * 页标题 15px 半粗 → 分组标题 13px 半粗 → 行标签 13px 常规 → 说明 11px 灰。
 * 说明只在标签不够用时出现且限一行；状态用行右侧的 value 表达，不写成句子。
 */

/** 搜索命中高亮（外扩光环）：页标题、分组等整块容器。 */
export const SETTINGS_SEARCH_HIGHLIGHT =
  "scroll-m-5 transition-shadow data-[settings-search-active=true]:ring-2 data-[settings-search-active=true]:ring-primary/40 data-[settings-search-active=true]:ring-offset-2 data-[settings-search-active=true]:ring-offset-background";

/** 卡片内的行用内描光环，避免被圆角卡片裁掉。 */
const ROW_SEARCH_HIGHLIGHT =
  "scroll-m-5 transition-shadow data-[settings-search-active=true]:ring-2 data-[settings-search-active=true]:ring-inset data-[settings-search-active=true]:ring-primary/40";

export function SettingsPageTitle({ children }: { children: string }) {
  return (
    <h2
      data-settings-search={children}
      className={cn("mb-3 rounded-sm text-heading font-semibold", SETTINGS_SEARCH_HIGHLIGHT)}
    >
      {children}
    </h2>
  );
}

/** 子页开头的一句话说明。 */
export function SettingsIntro({ children }: { children: ReactNode }) {
  return <p className="mb-4 text-body text-muted-foreground">{children}</p>;
}

/**
 * 分组：标题在卡片外，补充说明放卡片下方脚注（macOS 设置的 footer 位置）。
 * 标题下不放说明：Platinum 把标题压在分组框上沿，上方再有文字会把框顶开。
 */
export function SettingsGroup({
  title,
  footer,
  footerTone,
  searchKey,
  children,
}: {
  title?: string;
  footer?: ReactNode;
  footerTone?: "warning";
  searchKey?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-settings-search={searchKey ?? title}
      data-settings-group
      className={cn("mb-6 rounded-xl", SETTINGS_SEARCH_HIGHLIGHT)}
    >
      {title && (
        <h3 data-settings-group-title className="mb-2 px-0.5 text-title font-semibold">
          {title}
        </h3>
      )}
      <div
        data-settings-group-box
        className="divide-y divide-border/50 rounded-xl border border-border/60 bg-card"
      >
        {children}
      </div>
      {footer && (
        <p
          className={cn(
            "mt-1.5 px-3.5 text-label",
            footerTone === "warning" ? "text-warning" : "text-muted-foreground"
          )}
        >
          {footer}
        </p>
      )}
    </section>
  );
}

export function SettingsRow({
  label,
  hint,
  hintTone,
  value,
  right,
  searchKey,
  children,
}: {
  label: string;
  hint?: ReactNode;
  hintTone?: "warning";
  /** 当前状态（如「2 条」「尚未备份」），显示在控件左侧。 */
  value?: ReactNode;
  right?: ReactNode;
  searchKey?: string;
  /** 行下方的附属内容（列表、路径等），与行同属一块。 */
  children?: ReactNode;
}) {
  return (
    <div
      data-settings-search={searchKey ?? label}
      className={cn("rounded-lg px-3.5 py-2.5", ROW_SEARCH_HIGHLIGHT)}
    >
      <div className="flex min-h-7 items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-title">{label}</p>
          {hint && (
            <p
              className={cn(
                "mt-0.5 text-label",
                hintTone === "warning" ? "text-warning" : "text-muted-foreground"
              )}
            >
              {hint}
            </p>
          )}
        </div>
        {value != null && (
          <span className="shrink-0 text-body text-muted-foreground">{value}</span>
        )}
        {right && <div className="shrink-0">{right}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * 功能总开关：作为卡片首行，图标 + 标题 + 一句话 + 开关；
 * 从属设置排在同一张卡片下方，关闭时由调用方决定隐藏或置灰。
 */
export function FeatureRow({
  icon,
  title,
  badge,
  description,
  checked,
  onCheckedChange,
  disabled,
  switchLabel,
  searchKey,
  actions,
}: {
  icon: ReactNode;
  title: string;
  badge?: string;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  switchLabel?: string;
  searchKey?: string;
  /** 开关左侧的附加操作（如「设置」按钮）。 */
  actions?: ReactNode;
}) {
  return (
    <div
      data-settings-search={searchKey ?? title}
      className={cn("flex items-center gap-3 rounded-lg px-3.5 py-3", ROW_SEARCH_HIGHLIGHT)}
    >
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground/75 [&_svg]:size-4"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-title font-semibold">
          {title}
          {badge && (
            <span className="rounded-sm bg-muted px-1 text-micro font-medium text-muted-foreground">
              {badge}
            </span>
          )}
        </p>
        {description && (
          <p className="mt-0.5 text-label text-muted-foreground">{description}</p>
        )}
      </div>
      {actions}
      <Switch
        aria-label={switchLabel ?? title}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

/**
 * 行式折叠：整行可点，右侧显示当前状态摘要，展开内容留在同一张卡片里。
 * keepMounted 用于有未保存输入的内容：收起时只隐藏，不卸载。
 */
export function DisclosureRow({
  label,
  value,
  open,
  onOpenChange,
  searchKey,
  keepMounted = false,
  children,
}: {
  label: string;
  value?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  searchKey?: string;
  keepMounted?: boolean;
  children: ReactNode;
}) {
  const contentId = useId();
  return (
    <div data-settings-search={searchKey ?? label} className={cn("rounded-lg", ROW_SEARCH_HIGHLIGHT)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => onOpenChange(!open)}
        className="group/disclosure flex min-h-12 w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 text-title">{label}</span>
        {value != null && (
          <span className="shrink-0 text-body text-muted-foreground">{value}</span>
        )}
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-control) group-hover/disclosure:text-foreground motion-reduce:transition-none",
            open && "rotate-90"
          )}
        />
      </button>
      {(open || keepMounted) && (
        <div id={contentId} hidden={!open} className="px-3.5 pb-3">
          {children}
        </div>
      )}
    </div>
  );
}

/** 同一张卡片里的跳转行：外观同 DisclosureRow，点击去往别处。 */
export function NavigateRow({
  label,
  value,
  onClick,
  searchKey,
}: {
  label: string;
  value?: ReactNode;
  onClick: () => void;
  searchKey?: string;
}) {
  return (
    <button
      type="button"
      data-settings-search={searchKey ?? label}
      onClick={onClick}
      className={cn(
        "group/link flex min-h-12 w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        ROW_SEARCH_HIGHLIGHT
      )}
    >
      <span className="min-w-0 flex-1 text-title">{label}</span>
      {value != null && (
        <span className="shrink-0 text-body text-muted-foreground">{value}</span>
      )}
      <ChevronRight
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground group-hover/link:text-foreground"
      />
    </button>
  );
}
