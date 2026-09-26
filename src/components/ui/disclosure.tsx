import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 渐进式披露：默认收起，点标题展开/收起；收起时子树不在 DOM（条件渲染）。
 * 传 open 即受控（配合 onOpenChange），用于「深链自动展开」等场景。
 * 标题与设置分组标题同级（13px 半粗），summary 给出收起时的内容概要。
 */
export function Disclosure({
  title,
  summary,
  children,
  id,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
}: {
  title: string;
  summary?: string;
  children: ReactNode;
  id?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const contentId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const toggle = () => {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  return (
    <div id={id} className="mb-6">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={toggle}
        className="group/disclosure flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-control) group-hover/disclosure:text-foreground motion-reduce:transition-none",
            open && "rotate-90"
          )}
        />
        <span className="text-title font-semibold">{title}</span>
        {summary && (
          <span className="min-w-0 truncate text-label text-muted-foreground">{summary}</span>
        )}
      </button>
      {open && (
        <div id={contentId} className="reveal-in mt-2 [&>:last-child]:mb-0">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * 原生 <details> 的统一标题：去掉浏览器三角，换成与 Disclosure 同款的旋转箭头。
 * 箭头只看直属 <details> 的 open：不用 group-open，否则嵌套在已展开的外层里会跟着转。
 */
export function DetailsSummary({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <summary
      className={cn(
        "flex cursor-pointer list-none items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden",
        className
      )}
    >
      <ChevronRight
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-control) motion-reduce:transition-none [details[open]>summary>&]:rotate-90"
      />
      {children}
    </summary>
  );
}
