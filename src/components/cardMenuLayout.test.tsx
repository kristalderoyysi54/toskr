import { Fragment } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { TargetSendMenuItem } from "@/components/TargetSendMenuItem";
import { FileText, Send } from "lucide-react";
import {
  CONTEXT_MENU_REGISTRY,
  normalizeContextMenu,
} from "@/store/notesStore";
import { useTargetStore } from "@/store/targetStore";
import { collectMenuFlyoutEntries, menuNodeText, partitionCardMenuIds } from "./cardMenuLayout";

describe("卡片菜单层级", () => {
  it("笔记卡按方案 A 骨架分区，每个原有能力恰好出现一次", () => {
    const ids = CONTEXT_MENU_REGISTRY.map((item) => item.id);
    const layout = partitionCardMenuIds(ids, false);
    expect(layout.send).toEqual(["send", "send-preflight", "send-template"]);
    expect(layout.main).toEqual(["preview", "copy", "edit", "done", "keep"]);
    expect(layout.organize).toEqual(["blur", "rename", "tags", "move"]);
    expect(layout.convert).toEqual(["copy-list", "export", "ocr", "to-task", "ai-to-task", "ai-title"]);
    const all = Object.values(layout).flat();
    expect(all).toHaveLength(ids.length);
    expect(new Set(all)).toEqual(new Set(ids));
  });

  it("剪贴卡把移入笔记分组提到一级，编辑与完成落到整理", () => {
    const layout = partitionCardMenuIds(CONTEXT_MENU_REGISTRY.map((item) => item.id), true);
    expect(layout.main).toEqual(["preview", "copy", "keep", "move"]);
    expect(layout.organize).toEqual(expect.arrayContaining(["edit", "done"]));
    expect(layout.organize).not.toContain("move");
  });

  it("每个二级小窗只放一类操作：发送区不混入整理或转换项", () => {
    const layout = partitionCardMenuIds(CONTEXT_MENU_REGISTRY.map((item) => item.id), false);
    expect(layout.send.every((id) => id.startsWith("send"))).toBe(true);
    expect(layout.organize).not.toContain("send-template");
    expect(layout.convert).not.toContain("move");
  });

  it("文本处理已移出卡片右键菜单（详情窗工具栏提供），旧配置里的该项被剔除", () => {
    expect(CONTEXT_MENU_REGISTRY.map((item) => item.id)).not.toContain("textops");
    const config = normalizeContextMenu([
      { id: "textops" as never, on: true },
      { id: "copy", on: true },
    ]);
    expect(config.map((item) => item.id)).not.toContain("textops");
    expect(config[0]).toEqual({ id: "copy", on: true });
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
    expect(layout.main).toEqual(["keep", "edit", "preview", "done"]);
    expect(layout.send).toEqual(["send-preflight", "send-template", "send"]);
    expect(Object.values(layout).flat()).not.toContain("copy");
    expect(layout.convert).not.toContain("ai-title");
  });

});

describe("子菜单小窗条目序列化", () => {
  const register = () => {
    const handlers = new Map<string, () => void>();
    return {
      handlers,
      register: (handler: () => void) => {
        const id = `fly-${handlers.size + 1}`;
        handlers.set(id, handler);
        return id;
      },
    };
  };

  it("二级子菜单展开为标题 + 原操作，图标名、快捷键、禁用与危险态原样投影", () => {
    const action = vi.fn();
    const registry = register();
    const entries = collectMenuFlyoutEntries(
      <Fragment>
        <ContextMenuSub key="template">
          <ContextMenuSubTrigger>
            <FileText className="mr-2 size-3.5" /> 用模板发送
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onClick={action}>整理需求</ContextMenuItem>
            <ContextMenuItem disabled>去设置里添加模板</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuLabel>内容</ContextMenuLabel>
        <ContextMenuItem variant="destructive" onClick={() => {}}>
          <Send className="size-3.5" /> 删除
          <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </Fragment>,
      registry.register
    );
    expect(entries.map((entry) => entry.kind)).toEqual([
      "label", "item", "item", "separator", "label", "item",
    ]);
    expect(entries[0]).toMatchObject({ kind: "label", label: "用模板发送" });
    expect(entries[1]).toMatchObject({ kind: "item", label: "整理需求", disabled: false, destructive: false });
    expect(entries[2]).toMatchObject({ kind: "item", label: "去设置里添加模板", disabled: true });
    expect(entries[5]).toMatchObject({
      kind: "item", label: "删除", icon: "Send", shortcut: "⌘⌫", destructive: true,
    });
    const templateId = (entries[1] as { id: string }).id;
    registry.handlers.get(templateId)!();
    expect(action).toHaveBeenCalledOnce();
  });

  it("目标发送项按目标就绪态决定禁用；文字提取跳过图标与快捷键", () => {
    const registry = register();
    useTargetStore.setState({ status: "blocked", profileOverrideNeedsConfirmation: false });
    const blocked = collectMenuFlyoutEntries(
      <TargetSendMenuItem onClick={() => {}}>
        <Send className="size-3.5" /> 发送到对话
        <ContextMenuShortcut>⌘⏎</ContextMenuShortcut>
      </TargetSendMenuItem>,
      registry.register
    );
    expect(blocked[0]).toMatchObject({ label: "发送到对话", shortcut: "⌘⏎", disabled: true });
    const allowed = collectMenuFlyoutEntries(
      <TargetSendMenuItem allowInternal onClick={() => {}}>发送 / 添加</TargetSendMenuItem>,
      registry.register
    );
    expect(allowed[0]).toMatchObject({ label: "发送 / 添加", disabled: false });
    expect(menuNodeText(<span><Send className="size-3.5" /> 标签 <span className="truncate">工作</span></span>)).toBe("标签 工作");
  });
});
