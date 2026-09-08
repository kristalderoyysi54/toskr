import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";

import { SimpleMenu, SimpleMenuItem, SimpleMenuLabel, SimpleMenuSeparator } from "@/components/SimpleMenu";
import { Button } from "@/components/ui/button";
import type { PromptSnippet } from "@/lib/targetProfiles";

export function PromptTemplateSelect({ value, prioritized, remaining, onChange, disabled }: {
  value: string;
  prioritized: readonly PromptSnippet[];
  remaining: readonly PromptSnippet[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [otherExpanded, setOtherExpanded] = useState(false);
  const otherId = useId();
  const current = [...prioritized, ...remaining].find((snippet) => snippet.id === value);
  const currentLabel = value === "none"
    ? "无模板"
    : value === "custom" ? "本次自定义模板" : current?.label ?? "当前模板";

  return (
    <SimpleMenu
      align="start"
      menuAriaLabel="本次提示词模板"
      className="block"
      menuClassName="max-h-64 w-56 max-w-[calc(100vw-2rem)] overflow-y-auto"
      onOpenChange={(open) => {
        if (open) setOtherExpanded(false);
      }}
      trigger={({ open, toggle, controls }) => (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="w-full min-w-0 justify-between rounded-sm px-1 text-micro"
          aria-label={`本次提示词模板：${currentLabel}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={controls}
          title={currentLabel}
          disabled={disabled}
          onClick={toggle}
        >
          <span className="min-w-0 flex-1 truncate text-left">{currentLabel}</span>
          <ChevronDown aria-hidden className="size-2.5 text-muted-foreground" />
        </Button>
      )}
    >
      {(close) => {
        const choose = (nextValue: string) => {
          close();
          if (nextValue !== value) onChange(nextValue);
        };
        const renderSnippet = (snippet: PromptSnippet) => (
          <SimpleMenuItem
            key={snippet.id}
            selected={snippet.id === value}
            checked={snippet.id === value}
            radio
            title={snippet.text}
            onClick={() => choose(snippet.id)}
          >
            {snippet.label}
          </SimpleMenuItem>
        );
        return (
          <>
            <SimpleMenuItem selected={value === "none"} checked={value === "none"} radio onClick={() => choose("none")}>
              无模板
            </SimpleMenuItem>
            {value === "custom" && (
              <SimpleMenuItem selected checked radio onClick={close}>
                本次自定义模板
              </SimpleMenuItem>
            )}
            {prioritized.length > 0 && (
              <>
                <SimpleMenuSeparator />
                <SimpleMenuLabel>常用模板</SimpleMenuLabel>
                {prioritized.map(renderSnippet)}
              </>
            )}
            {remaining.length > 0 && (
              <>
                <SimpleMenuSeparator />
                <SimpleMenuItem
                  expanded={otherExpanded}
                  controls={otherId}
                  onClick={() => setOtherExpanded(!otherExpanded)}
                >
                  其他模板（{remaining.length}）
                  {otherExpanded
                    ? <ChevronDown aria-hidden className="ml-auto size-3.5" />
                    : <ChevronRight aria-hidden className="ml-auto size-3.5" />}
                </SimpleMenuItem>
                {otherExpanded && <div id={otherId}>{remaining.map(renderSnippet)}</div>}
              </>
            )}
          </>
        );
      }}
    </SimpleMenu>
  );
}
