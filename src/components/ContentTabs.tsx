import { Fragment } from "react";
import { motion } from "motion/react";

import { focusRing } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";
import { useNotesStore } from "@/store/notesStore";
import { useUIStore } from "@/store/uiStore";

export function ContentTabs() {
  const active = useUIStore((state) => state.contentSubview);
  const messages = useNotesStore((state) => state.messages);
  const messagesEnabled = useNotesStore((state) => state.settings.messagesEnabled);
  const secretEnabled = useNotesStore((state) => state.settings.secretEnabled);
  const items = [
    { value: "notes" as const, label: "笔记" },
    ...(messagesEnabled
      ? [
          {
            value: "messages" as const,
            label: "消息",
            badge: messages.filter((message) => message.status === "new").length,
          },
        ]
      : []),
    ...(secretEnabled ? [{ value: "secret" as const, label: "秘文" }] : []),
  ];

  return (
    <div className="flex min-h-6 items-center pb-2 pl-4 pr-3.5 pt-1">
      <div role="tablist" aria-label="内容子视图" className="flex items-center gap-0.5">
        {items.map((item, index) => {
          const selected = active === item.value;
          return (
            <Fragment key={item.value}>
              {index > 0 && (
                <span aria-hidden className="px-0.5 text-micro text-muted-foreground/45">
                  ·
                </span>
              )}
              <button
                role="tab"
                aria-selected={selected}
                onClick={() => {
                  useNotesStore.getState().clearChecked();
                  useUIStore.getState().setContentSubview(item.value);
                }}
                className={cn(
                  "relative rounded-md px-2 pb-1 pt-0.5 text-label outline-none",
                  "transition-colors duration-(--duration-control)",
                  focusRing,
                  selected
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
                )}
              >
                {item.label}
                {item.badge ? (
                  <span className="ml-1 tabular-nums text-micro text-primary">
                    {item.badge}
                  </span>
                ) : null}
                {selected && (
                  <motion.span
                    aria-hidden
                    layoutId="content-subtab-line"
                    transition={{ duration: 0.12, ease: [0.2, 0.9, 0.3, 1] }}
                    className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground/85"
                  />
                )}
              </button>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
