import { Children, Fragment, isValidElement, type ReactNode } from "react";

import { TargetSendMenuItem } from "@/components/TargetSendMenuItem";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import type { MenuFlyoutEntry } from "@/lib/menuFlyout";
import type { ContextMenuItemId } from "@/store/notesStore";
import { useTargetStore } from "@/store/targetStore";

/** 只划分层级，不补回隐藏项，也不改变用户在组内安排的顺序。 */
export function partitionCardMenuIds(ids: readonly ContextMenuItemId[], clipboard: boolean) {
  const primary: ContextMenuItemId[] = [];
  const sendOptions: ContextMenuItemId[] = [];
  const more: ContextMenuItemId[] = [];
  for (const id of ids) {
    // 剪贴卡「移入笔记分组」是收编主路径，提到一级（用户 2026-09-25 指定）
    if (["send", "copy", "keep"].includes(id) ||
      (!clipboard && ["edit", "done"].includes(id)) ||
      (clipboard && id === "move")) {
      primary.push(id);
    } else if (id === "send-template" || id === "send-preflight") {
      sendOptions.push(id);
    } else {
      more.push(id);
    }
  }
  return { primary, sendOptions, more };
}

/** lucide 图标是 forwardRef 组件且带 displayName；菜单行里无子节点的这类元素视为图标。 */
function iconNameOf(node: ReactNode): string | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  const type = node.type as { displayName?: string; $$typeof?: symbol };
  if (
    typeof type === "object" &&
    type !== null &&
    typeof type.displayName === "string" &&
    node.props.children === undefined
  ) {
    return type.displayName;
  }
  return undefined;
}

/** 菜单行可见文字：跳过快捷键与图标，合并空白。 */
export function menuNodeText(node: ReactNode): string {
  const collect = (value: ReactNode): string => {
    if (value === null || value === undefined || typeof value === "boolean") return "";
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (Array.isArray(value)) return value.map(collect).join("");
    if (!isValidElement<{ children?: ReactNode }>(value)) return "";
    if (value.type === ContextMenuShortcut || iconNameOf(value)) return "";
    return collect(value.props.children);
  };
  return collect(node).replace(/\s+/g, " ").trim();
}

function firstChild<T>(children: ReactNode, pick: (node: ReactNode) => T | undefined): T | undefined {
  let found: T | undefined;
  Children.forEach(children, (child) => {
    if (found === undefined) found = pick(child);
  });
  return found;
}

function targetSendEnabled(allowInternal: boolean | undefined): boolean {
  const state = useTargetStore.getState();
  return (state.status === "ready" && !state.profileOverrideNeedsConfirmation) || !!allowInternal;
}

/**
 * 把右键菜单的 JSX 子树序列化成子菜单小窗可渲染的条目：动作换成登记 id，
 * 二级 Radix 子菜单展开为「标题 + 原操作」（与旧版同位切页一致，不再弹第三层）。
 * 单一事实来源仍是各 renderMenuItem 的 JSX，这里只做投影。
 */
export function collectMenuFlyoutEntries(
  node: ReactNode,
  register: (handler: () => void) => string
): MenuFlyoutEntry[] {
  const out: MenuFlyoutEntry[] = [];
  const walk = (value: ReactNode) => {
    if (value === null || value === undefined || typeof value === "boolean") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isValidElement<Record<string, unknown> & { children?: ReactNode }>(value)) return;
    const element = value;
    if (element.type === Fragment) {
      walk(element.props.children);
      return;
    }
    if (element.type === ContextMenuSeparator) {
      out.push({ kind: "separator", id: `sep-${out.length}` });
      return;
    }
    if (element.type === ContextMenuLabel) {
      out.push({ kind: "label", id: `label-${out.length}`, label: menuNodeText(element.props.children) });
      return;
    }
    if (element.type === ContextMenuSub) {
      const parts = Children.toArray(element.props.children);
      const trigger = parts.find((part) => isValidElement(part) && part.type === ContextMenuSubTrigger);
      const content = parts.find((part) => isValidElement(part) && part.type === ContextMenuSubContent);
      if (isValidElement<{ children?: ReactNode }>(trigger)) {
        out.push({ kind: "label", id: `label-${out.length}`, label: menuNodeText(trigger.props.children) });
      }
      if (isValidElement<{ children?: ReactNode }>(content)) walk(content.props.children);
      return;
    }
    if (element.type === ContextMenuItem || element.type === TargetSendMenuItem) {
      const props = element.props as {
        children?: ReactNode;
        disabled?: boolean;
        variant?: string;
        allowInternal?: boolean;
        onClick?: () => void;
        onSelect?: (event: Event) => void;
      };
      const disabled =
        element.type === TargetSendMenuItem
          ? !targetSendEnabled(props.allowInternal)
          : Boolean(props.disabled);
      const id = register(() => {
        props.onSelect?.(new Event("select", { cancelable: true }));
        props.onClick?.();
      });
      out.push({
        kind: "item",
        id,
        label: menuNodeText(props.children),
        icon: firstChild(props.children, iconNameOf),
        shortcut: firstChild(props.children, (child) =>
          isValidElement<{ children?: ReactNode }>(child) && child.type === ContextMenuShortcut
            ? menuNodeText(child.props.children)
            : undefined
        ),
        disabled,
        destructive: props.variant === "destructive",
      });
      return;
    }
    // 其他包装元素（div/span 等）：向下递归
    walk(element.props.children);
  };
  walk(node);
  return out;
}
