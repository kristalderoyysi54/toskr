import { Children, Fragment, isValidElement, type ReactNode } from "react";

import {
  ContextMenuLabel,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import type { ContextMenuItemId } from "@/store/notesStore";

/** 只划分层级，不补回隐藏项，也不改变用户在组内安排的顺序。 */
export function partitionCardMenuIds(ids: readonly ContextMenuItemId[], clipboard: boolean) {
  const primary: ContextMenuItemId[] = [];
  const sendOptions: ContextMenuItemId[] = [];
  const more: ContextMenuItemId[] = [];
  for (const id of ids) {
    if (["send", "copy", "keep"].includes(id) ||
      (!clipboard && ["edit", "done"].includes(id))) {
      primary.push(id);
    } else if (id === "send-template" || id === "send-preflight") {
      sendOptions.push(id);
    } else {
      more.push(id);
    }
  }
  return { primary, sendOptions, more };
}

/** 二级菜单内将原有子菜单展开成标题和原操作，避免窄面板再弹第三层。 */
export function flattenContextMenuSubmenu(node: ReactNode): ReactNode {
  if (!isValidElement<{ children: ReactNode }>(node) || node.type !== ContextMenuSub) return node;
  const parts = Children.toArray(node.props.children);
  const trigger = parts.find((part) => isValidElement(part) && part.type === ContextMenuSubTrigger);
  const content = parts.find((part) => isValidElement(part) && part.type === ContextMenuSubContent);
  if (!isValidElement<{ children: ReactNode }>(trigger) ||
    !isValidElement<{ children: ReactNode }>(content)) return node;
  return (
    <Fragment key={node.key}>
      <ContextMenuLabel className="flex items-center gap-1.5">
        {trigger.props.children}
      </ContextMenuLabel>
      {content.props.children}
    </Fragment>
  );
}
