import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MessageItem } from "@/lib/messages";
import type { IconButton } from "@/components/ui/icon-button";
import type { PopoverContent } from "@/components/ui/popover";

const captured = vi.hoisted(() => ({
  icons: [] as ComponentProps<typeof IconButton>[],
  panels: [] as ComponentProps<typeof PopoverContent>[],
  state: {
    messages: [] as MessageItem[],
    setMessageStatus: vi.fn(),
    messageToTask: vi.fn(() => ({ result: "added", taskId: "task-1" })),
    removeMessages: vi.fn(),
    restoreMessages: vi.fn(),
  },
  locate: vi.fn(async () => {}),
  undo: vi.fn<(callback: () => void) => void>(),
  tip: vi.fn(),
}));

vi.mock("@/store/notesStore", () => ({
  INBOX_ID: "inbox",
  TASK_INBOX_ID: "tasks-inbox",
  useNotesStore: { getState: () => captured.state },
}));
vi.mock("@/lib/tauri", () => ({ api: { locateMessageSource: captured.locate } }));
vi.mock("@/lib/tip", () => ({ setPendingUndo: captured.undo, tip: captured.tip }));
vi.mock("@/components/ui/icon-button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/icon-button")>();
  return {
    IconButton: (props: ComponentProps<typeof IconButton>) => {
      captured.icons.push(props);
      return <actual.IconButton {...props} />;
    },
  };
});
// 仅替换 portal 挂载：保留 MessageCard 生成的真实按钮与回调供逐项执行。
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: (props: ComponentProps<typeof PopoverContent>) => {
    captured.panels.push(props);
    return <div>{props.children}</div>;
  },
}));

import { MessageCard } from "./MessagePage";

const message: MessageItem = {
  id: "message-1", source: "im", sourceApp: "测试 IM", sourceBundle: "com.example.im",
  conversationId: "group-1", conversationName: "项目群", messageId: "original-1",
  senderUid: "user-1", senderName: "发送者", occurredAtMs: 100, receivedAtMs: 200,
  mentionedSelf: true, followedSender: false, matchedRuleIds: [], isGroup: true,
  messageType: "text", text: "请确认发布时间", context: [], status: "new",
};

function textOf(node: ReactNode): string {
  return Children.toArray(node).map((child): string => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : "";
  }).join("");
}

function buttonsIn(node: ReactNode): ComponentProps<"button">[] {
  return Children.toArray(node).flatMap((child): ComponentProps<"button">[] => {
    if (!isValidElement<ComponentProps<"button">>(child)) return [];
    if (child.props.onClick) return [child.props];
    return buttonsIn(child.props.children);
  });
}

function render(overrides: Partial<ComponentProps<typeof MessageCard>> = {}) {
  const current = overrides.message ?? message;
  captured.state.messages = [current];
  const onDraft = vi.fn();
  const html = renderToStaticMarkup(
    <MessageCard
      message={current}
      reasons={["@我"]}
      busy={false}
      duePresets={[{ id: "later", kind: "relative", minutes: 30 }]}
      onDraft={onDraft}
      {...overrides}
    />
  );
  const more = captured.panels.find((panel) => panel["aria-label"] === "更多消息操作")!;
  const actions = buttonsIn(more.children);
  const click = (label: string) => {
    const button = actions.find((item) => textOf(item.children) === label);
    expect(button, `应存在动作：${label}`).toBeDefined();
    expect(button!.disabled).not.toBe(true);
    button!.onClick!({} as React.MouseEvent<HTMLButtonElement>);
  };
  return { html, more, actions, click, onDraft };
}

describe("消息卡操作层级", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.icons = [];
    captured.panels = [];
  });

  it("待处理卡外提定位入口，更多保留跟进与AI且不增加删除权限", () => {
    const { actions, html, more } = render({ checked: true });
    expect(captured.icons.map((icon) => icon.label)).toEqual(["发送到对话", "标记已处理", "提醒我", "定位原会话", "更多消息操作"]);
    expect(actions.map((action) => textOf(action.children))).toEqual([
      "等待回复", "转为任务", "生成 AI 回复草稿",
    ]);
    expect(html).toContain("list-selection-glow");
    expect(html).toContain('data-checked="true"');
    expect(html).not.toContain("删除消息");
    expect(more.side).toBe("top");
    expect(more.role).not.toBe("menu");
  });

  it("定位、等待回复、转任务和 AI 保持原动作参数", () => {
    const { click, onDraft } = render();
    captured.icons.find((icon) => icon.label === "定位原会话")!.onClick!({} as React.MouseEvent<HTMLButtonElement>);
    expect(captured.locate).toHaveBeenCalledWith({
      sourceApp: "测试 IM", sourceBundle: "com.example.im", conversationName: "项目群",
      senderName: "发送者", text: "请确认发布时间", reason: "@我",
    });
    click("等待回复");
    expect(captured.state.messageToTask).toHaveBeenLastCalledWith("message-1", "waiting", undefined);
    click("转为任务");
    expect(captured.state.messageToTask).toHaveBeenLastCalledWith("message-1", "task", undefined);
    click("生成 AI 回复草稿");
    expect(onDraft).toHaveBeenCalledOnce();
  });

  it("已处理卡提供恢复入口，删除独立放最后并可撤销", () => {
    const done = { ...message, status: "done" as const };
    const { actions, click, html } = render({ message: done });
    expect(captured.icons.map((icon) => icon.label)).toEqual(["发送到对话", "恢复为待处理", "提醒我", "定位原会话", "更多消息操作"]);
    captured.icons.find((icon) => icon.label === "恢复为待处理")!.onClick!({} as React.MouseEvent<HTMLButtonElement>);
    expect(captured.state.setMessageStatus).toHaveBeenLastCalledWith("message-1", "new");
    expect(textOf(actions.at(-1)!.children)).toBe("删除消息");
    expect(html).toMatch(/role="separator"[^>]*><\/div><button[^>]*data-variant="destructive"/);
    click("删除消息");
    expect(captured.state.removeMessages).toHaveBeenCalledWith(["message-1"]);
    captured.undo.mock.calls.at(-1)![0]();
    expect(captured.state.restoreMessages).toHaveBeenCalledWith([done]);
  });

  it("等待回复卡不重复提供等待操作，AI 忙碌时禁用生成", () => {
    const { actions } = render({ message: { ...message, status: "waiting" }, busy: true });
    expect(actions.map((action) => textOf(action.children))).toEqual([
      "转为任务", "AI 草稿生成中…",
    ]);
    expect(actions.at(-1)!.disabled).toBe(true);
  });

  it("处理动作仍可撤销，两个浮层阻止事件到达整卡选择与页面快捷键", () => {
    const { more } = render({ message: { ...message, status: "waiting" } });
    captured.icons.find((icon) => icon.label === "标记已处理")!.onClick!({} as React.MouseEvent<HTMLButtonElement>);
    expect(captured.state.setMessageStatus).toHaveBeenLastCalledWith("message-1", "done");
    captured.undo.mock.calls.at(-1)![0]();
    expect(captured.state.setMessageStatus).toHaveBeenLastCalledWith("message-1", "waiting");
    const stopPropagation = vi.fn();
    for (const panel of captured.panels) {
      panel.onClick!({ stopPropagation } as unknown as React.MouseEvent<HTMLDivElement>);
      panel.onKeyDown!({ stopPropagation } as unknown as React.KeyboardEvent<HTMLDivElement>);
    }
    expect(stopPropagation).toHaveBeenCalledTimes(4);
    expect(more.className).toContain("--radix-popover-content-available-height");
  });

  it("提醒时间仍使用用户配置的预设创建提醒", () => {
    render();
    const reminder = captured.panels.find((panel) => !panel["aria-label"])!;
    const preset = buttonsIn(reminder.children).find((button) => textOf(button.children) === "30 分钟后")!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      preset.onClick!({} as React.MouseEvent<HTMLButtonElement>);
      expect(captured.state.messageToTask).toHaveBeenLastCalledWith("message-1", "reminder", 2_800_000);
    } finally {
      clock.mockRestore();
    }
  });
});
