import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/persistStorage", () => ({
  tauriStateStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock("motion/react", async () => {
  const React = await import("react");
  const staticDiv = React.forwardRef<HTMLElement, Record<string, unknown>>(
    function StaticMotion(
      {
        children,
        initial: _initial,
        animate: _animate,
        exit: _exit,
        transition: _transition,
        ...props
      },
      ref
    ) {
      return React.createElement("div", { ...props, ref }, children as React.ReactNode);
    }
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: { div: staticDiv },
  };
});

import { SecretPage } from "@/components/SecretPage";
import { defaultSettings, useNotesStore } from "@/store/notesStore";

describe("SecretPage 密文格式入口", () => {
  beforeEach(() => {
    const settings = defaultSettings();
    useNotesStore.setState({
      settings: {
        ...settings,
        secretKeys: [{
          id: "key-1",
          label: "很长的研发协作群密钥名称",
          passphrase: "test-only-passphrase",
          createdAtMs: 1,
          updatedAtMs: 1,
        }],
        secretDefaultKeyId: "key-1",
        secretCipherStyle: "code",
      },
    });
  });

  it("窄面板在同一上下文行展示可截断密钥与固定宽度格式选择器", () => {
    Object.assign(useNotesStore.getInitialState(), useNotesStore.getState());
    const html = renderToStaticMarkup(<SecretPage notes={[]} query="" />);

    expect(html).toContain('class="flex min-w-0 items-center gap-1.5"');
    expect(html).toContain('aria-label="选择加密密钥"');
    expect(html).toContain('class="relative block min-w-0 flex-1"');
    expect(html).toContain("很长的研发协作群密钥名称");
    expect(html).toContain('aria-label="选择密文格式"');
    expect(html).toContain('class="relative block w-24 shrink-0"');
    expect(html).toContain(">代码<");
  });

  it("传统格式使用与其他类型清楚区分的“中文”短标签", () => {
    useNotesStore.setState((state) => ({
      settings: { ...state.settings, secretCipherStyle: "classic" },
    }));
    Object.assign(useNotesStore.getInitialState(), useNotesStore.getState());

    const html = renderToStaticMarkup(<SecretPage notes={[]} query="" />);

    expect(html).toContain(">中文<");
  });
});
