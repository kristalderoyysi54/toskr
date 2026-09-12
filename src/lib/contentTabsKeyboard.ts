import type { KeyboardEvent } from "react";

export type ContentSubview = "notes" | "messages" | "secret";

export function handleContentTabKeyDown(
  event: Pick<KeyboardEvent<HTMLButtonElement>, "key" | "currentTarget" | "preventDefault" | "stopPropagation" | "altKey" | "ctrlKey" | "metaKey">,
  values: readonly ContentSubview[],
  index: number,
  select: (value: ContentSubview) => void
) {
  if (event.altKey || event.ctrlKey || event.metaKey || !values.length) return;
  let next: number;
  switch (event.key) {
    case "ArrowRight": next = (index + 1) % values.length; break;
    case "ArrowLeft": next = (index - 1 + values.length) % values.length; break;
    case "Home": next = 0; break;
    case "End": next = values.length - 1; break;
    default: return;
  }
  event.preventDefault();
  event.stopPropagation();
  select(values[next]);
  event.currentTarget.closest('[role="tablist"]')
    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
}

