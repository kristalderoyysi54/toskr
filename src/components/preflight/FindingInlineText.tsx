import { useState } from "react";

import { Button } from "@/components/ui/button";
import { sliceFindingSegments } from "@/lib/delivery/findingSegments";
import { FIREWALL_CATEGORY_LABEL } from "@/lib/delivery/firewall";
import type { FirewallFinding } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * P2（2026-09-12 用户选定）：命中就地处理——原文里高亮命中值，点一处弹出
 * 替换 / 保留 / 加入词典 三个动作；已保留原文的命中改为浅色下划线。
 */
export function FindingInlineText({
  text,
  findings,
  excludedIds,
  busy,
  aliasCategories,
  onReplace,
  onExclude,
  onAlias,
}: {
  text: string;
  findings: readonly FirewallFinding[];
  excludedIds: ReadonlySet<string>;
  busy: boolean;
  aliasCategories: readonly { code: string; label: string }[];
  onReplace: (finding: FirewallFinding) => void;
  onExclude: (finding: FirewallFinding) => void;
  onAlias: (finding: FirewallFinding, category: string) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [aliasPicking, setAliasPicking] = useState(false);
  const segments = sliceFindingSegments(text, findings);
  const active = findings.find((f) => f.id === activeId) ?? null;
  return (
    <div className="space-y-1.5" data-finding-inline>
      <p className="text-micro text-muted-foreground">原文（点击高亮处处理）</p>
      <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono text-label leading-relaxed">
        {segments.map((segment, index) =>
          segment.finding ? (
            <button
              key={`${segment.finding.id}:${index}`}
              type="button"
              disabled={busy}
              aria-pressed={activeId === segment.finding.id}
              aria-label={`${FIREWALL_CATEGORY_LABEL[segment.finding.category]}命中：点击处理`}
              onClick={() => {
                setAliasPicking(false);
                setActiveId((current) => (current === segment.finding!.id ? null : segment.finding!.id));
              }}
              className={cn(
                "rounded-[2px] px-0.5 text-inherit outline-none focus-visible:ring-2 focus-visible:ring-ring",
                excludedIds.has(segment.finding.id)
                  ? "underline decoration-warning/60 decoration-dotted underline-offset-2"
                  : segment.finding.severity === "block"
                    ? "bg-destructive/20"
                    : "bg-warning/25",
                activeId === segment.finding.id && "ring-2 ring-ring"
              )}
            >
              {segment.text}
            </button>
          ) : (
            <span key={index}>{segment.text}</span>
          )
        )}
      </div>
      {active && (
        <div role="group" aria-label="处理这一项" className="flex flex-wrap items-center gap-1 rounded-md bg-background/60 p-1.5">
          <span className="text-micro text-muted-foreground">
            {FIREWALL_CATEGORY_LABEL[active.category]} · {active.maskedPreview}
          </span>
          <Button type="button" size="xs" variant="secondary" disabled={busy} onClick={() => { onReplace(active); setActiveId(null); }}>
            替换为 {active.suggestedPlaceholder}
          </Button>
          <Button type="button" size="xs" disabled={busy || excludedIds.has(active.id)} onClick={() => { onExclude(active); setActiveId(null); }}>
            {excludedIds.has(active.id) ? "已保留原文" : "保留原文"}
          </Button>
          {active.severity === "warn" && aliasCategories.length > 0 && (
            <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setAliasPicking((v) => !v)}>
              加入词典
            </Button>
          )}
          {aliasPicking && (
            <div className="flex w-full flex-wrap gap-1 pt-0.5">
              {aliasCategories.map((category) => (
                <Button key={category.code} type="button" size="xs" variant="ghost" disabled={busy} onClick={() => { onAlias(active, category.code); setActiveId(null); setAliasPicking(false); }}>
                  {category.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
