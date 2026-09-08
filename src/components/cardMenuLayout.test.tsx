import { Children, isValidElement, type KeyboardEvent, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  CONTEXT_MENU_REGISTRY,
  normalizeContextMenu,
} from "@/store/notesStore";
import { CardMenuPageItem } from "./CardMenuPageItem";
import { flattenContextMenuSubmenu, partitionCardMenuIds } from "./cardMenuLayout";

describe("卡片菜单层级", () => {
  it.each(["send", "more", "main", "other-templates"] as const)("点击 %s 切页入口保留当前菜单", (page) => {
    const navigate = vi.fn();
    const item = CardMenuPageItem({ page, onNavigate: navigate, children: "菜单入口" });
    const event = new Event("select", { cancelable: true });
    item.props.onSelect(event);
    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith(page);
  });

  it.each([
    ["send", "ArrowRight"],
    ["more", "ArrowRight"],
    ["other-templates", "ArrowRight"],
    ["main", "ArrowLeft"],
  ] as const)("%s 入口用 %s 切页，不把方向键继续交给父菜单", (page, key) => {
    const navigate = vi.fn();
    const item = CardMenuPageItem({ page, onNavigate: navigate, children: "菜单入口" });
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const press = (pressedKey: string) => item.props.onKeyDown({
      key: pressedKey, preventDefault, stopPropagation,
    } as unknown as KeyboardEvent<HTMLDivElement>);
    press("ArrowDown");
    expect(navigate).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    press(key);
    expect(navigate).toHaveBeenCalledWith(page);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("返回发送选项的入口用左方向键，而不是重新向右进入", () => {
    const navigate = vi.fn();
    const item = CardMenuPageItem({ page: "send", back: true, onNavigate: navigate, children: "返回发送选项" });
    const event = {
      key: "ArrowLeft", preventDefault: vi.fn(), stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent<HTMLDivElement>;
    item.props.onKeyDown(event);
    expect(navigate).toHaveBeenCalledWith("send");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("默认笔记只保留五个主要动作，每个原有能力仍恰好出现一次", () => {
    const ids = CONTEXT_MENU_REGISTRY.map((item) => item.id);
    const layout = partitionCardMenuIds(ids, false);
    expect(layout.primary).toEqual(["send", "copy", "edit", "done", "keep"]);
    expect(layout.sendOptions).toEqual(["send-template", "send-preflight"]);
    const all = [...layout.primary, ...layout.sendOptions, ...layout.more];
    expect(all).toHaveLength(ids.length);
    expect(new Set(all)).toEqual(new Set(ids));
  });

  it("剪贴卡首层只留发送、复制和保留，编辑与完成仍能在更多中找到", () => {
    const layout = partitionCardMenuIds(CONTEXT_MENU_REGISTRY.map((item) => item.id), true);
    expect(layout.primary).toEqual(["send", "copy", "keep"]);
    expect(layout.more).toContain("edit");
    expect(layout.more).toContain("done");
  });

  it("不复活用户隐藏的操作，并保留用户配置的组内顺序", () => {
    const config = normalizeContextMenu([
      { id: "keep", on: true },
      { id: "edit", on: true },
      { id: "copy", on: false },
      { id: "send-preflight", on: true },
      { id: "send-template", on: true },
      { id: "ai-title", on: false },
    ]);
    const enabled = config.filter((item) => item.on).map((item) => item.id);
    const layout = partitionCardMenuIds(enabled, false);
    expect(layout.primary).toEqual(["keep", "edit", "send", "done"]);
    expect(layout.sendOptions).toEqual(["send-preflight", "send-template"]);
    expect([...layout.primary, ...layout.more]).not.toContain("copy");
    expect(layout.more).not.toContain("ai-title");
  });

  it("二级中展开原有子菜单，保留实际操作回调与禁用状态", () => {
    const action = vi.fn();
    const item = <ContextMenuItem onClick={action} disabled>添加标签</ContextMenuItem>;
    const flattened = flattenContextMenuSubmenu(
      <ContextMenuSub key="tags">
        <ContextMenuSubTrigger>标签</ContextMenuSubTrigger>
        <ContextMenuSubContent>{item}</ContextMenuSubContent>
      </ContextMenuSub>
    );
    expect(isValidElement<{ children: ReactNode }>(flattened)).toBe(true);
    if (!isValidElement<{ children: ReactNode }>(flattened)) return;
    const [label, preservedItem] = Children.toArray(flattened.props.children);
    expect(isValidElement(label) && label.type).toBe(ContextMenuLabel);
    expect(isValidElement(preservedItem) && preservedItem.type).toBe(ContextMenuItem);
    if (!isValidElement<{ disabled: boolean; onClick: () => void }>(preservedItem)) return;
    expect(preservedItem.props.disabled).toBe(true);
    preservedItem.props.onClick();
    expect(action).toHaveBeenCalledOnce();
    expect(flattenContextMenuSubmenu(item)).toBe(item);
  });
});
