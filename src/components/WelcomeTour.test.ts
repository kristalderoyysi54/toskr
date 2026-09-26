import { createElement, type ButtonHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { welcomeTourExitEvent } from "@/lib/welcomeTour";
import { WelcomeTour } from "./WelcomeTour";

const controls = vi.hoisted(() => ({
  buttons: new Map<string, () => void>(),
  setSettings: vi.fn(),
  transitionOnboarding: vi.fn(),
  setContentSubview: vi.fn(),
  setPage: vi.fn(),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => {
    if (typeof props.children === "string" && props.onClick) {
      controls.buttons.set(props.children, props.onClick as () => void);
    }
    return createElement("button", props);
  },
}));

vi.mock("@/store/notesStore", () => ({
  useNotesStore: Object.assign(
    (select: (state: { settings: { hotkeyModifier: string } }) => unknown) =>
      select({ settings: { hotkeyModifier: "option" } }),
    { getState: () => controls }
  ),
}));

vi.mock("@/store/uiStore", () => ({
  useUIStore: { getState: () => controls },
}));

beforeEach(() => {
  vi.clearAllMocks();
  controls.buttons.clear();
});

describe("新手导览", () => {
  it("一页讲清收集、合并发送、自动替换三件事，并直接提供尝试和使用入口", () => {
    const html = renderToStaticMarkup(createElement(WelcomeTour));

    expect(html).toContain("把散落各处的文字，一次安全地交给 AI");
    expect(html).toContain("收成卡片");
    expect(html).toContain("⌘⏎ 合成一次粘贴");
    expect(html).toContain("发送前自动替换");
    // 动画是带名称的 SVG，键帽跟随用户配置的触发键
    expect(html).toContain('role="img"');
    expect(html).toContain("⌥ ⌥");
    expect(html).toContain("设置 → 帮助与更新");
    expect([...controls.buttons.keys()]).toEqual([
      "花 1 分钟试一下",
      "直接开始使用",
    ]);
    expect(html).not.toMatch(/下一页|上一页|OCR|IP|脱敏|演练|事件流/);
    expect(controls.setSettings).not.toHaveBeenCalled();
    expect(controls.transitionOnboarding).not.toHaveBeenCalled();
  });

  it("直接开始使用只记住导览已看，不强制启动教程或切换所在页面", () => {
    renderToStaticMarkup(createElement(WelcomeTour));
    controls.buttons.get("直接开始使用")!();

    expect(controls.setSettings).toHaveBeenCalledExactlyOnceWith({ welcomeTourSeen: true });
    expect(controls.transitionOnboarding).not.toHaveBeenCalled();
    expect(controls.setContentSubview).not.toHaveBeenCalled();
    expect(controls.setPage).not.toHaveBeenCalled();
    expect(welcomeTourExitEvent("use-now")).toBeNull();
  });

  it("尝试收集前切到内容笔记页，让当前教程可见，再启动真实操作", () => {
    renderToStaticMarkup(createElement(WelcomeTour));
    controls.buttons.get("花 1 分钟试一下")!();

    expect(controls.setContentSubview).toHaveBeenCalledExactlyOnceWith("notes");
    expect(controls.setPage).toHaveBeenCalledExactlyOnceWith("notes");
    expect(controls.setSettings).toHaveBeenCalledExactlyOnceWith({ welcomeTourSeen: true });
    expect(controls.transitionOnboarding).toHaveBeenCalledExactlyOnceWith({ type: "start" });
    expect(controls.setContentSubview.mock.invocationCallOrder[0])
      .toBeLessThan(controls.setPage.mock.invocationCallOrder[0]);
    expect(controls.setPage.mock.invocationCallOrder[0])
      .toBeLessThan(controls.transitionOnboarding.mock.invocationCallOrder[0]);
  });
});
