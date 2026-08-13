import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * 渐进式披露：默认收起，点标题展开/收起；收起时子树不在 DOM（条件渲染）。
 * 传 open 即受控（配合 onOpenChange），用于「深链自动展开」等场景。
 */
export function Disclosure({
  title,
  children,
  id,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
}: {
  title: string;
  children: React.ReactNode;
  id?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const toggle = () => {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  return (
    <div id={id} className="mb-5">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex items-center gap-1 rounded-md py-0.5 text-body font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        <ChevronRight
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {title}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}
