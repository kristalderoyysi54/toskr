import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitMock = vi.fn(() => Promise.resolve());
const listenMock = vi.fn(() => Promise.resolve(() => {}));
vi.mock("@tauri-apps/api/event", () => ({ emit: emitMock, listen: listenMock }));

const {
  COLOR_SCHEME_EVENT,
  COLOR_SCHEME_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  appearanceFromSettings,
  applyColorScheme,
  getColorScheme,
  installColorScheme,
  nativeVibrancy,
  nativeWindowTheme,
  normalizeAppearance,
  normalizeColorScheme,
  publishAppearance,
  readCachedColorScheme,
  subscribeColorScheme,
} = await import("@/lib/colorScheme");

function stubDom(systemDark: boolean, cached: string | null) {
  const store = new Map<string, string>();
  if (cached !== null) store.set(COLOR_SCHEME_STORAGE_KEY, cached);
  const classes = new Set<string>();
  const root = {
    dataset: {} as Record<string, string>,
    classList: {
      toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
    },
  };
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: systemDark, addEventListener: vi.fn() }),
    addEventListener: vi.fn(),
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  return { root, classes, store };
}

const platinum = { scheme: "platinum", highlight: "teal", scrollbar: "thin" } as const;

describe("colorScheme", () => {
  beforeEach(() => {
    emitMock.mockClear();
    listenMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Platinum 强制原生浅色并停用毛玻璃，默认方案原样透传", () => {
    expect(nativeWindowTheme({ theme: "dark", colorScheme: "platinum" })).toBe("light");
    expect(nativeWindowTheme({ theme: "dark", colorScheme: "default" })).toBe("dark");
    expect(nativeVibrancy({ vibrancy: true, colorScheme: "platinum" })).toBe(false);
    expect(nativeVibrancy({ vibrancy: true, colorScheme: "default" })).toBe(true);
    expect(nativeVibrancy({ vibrancy: false, colorScheme: "default" })).toBe(false);
  });

  it("外观归一：兼容旧的方案字符串缓存，未知值与损坏缓存回落默认", () => {
    expect(normalizeColorScheme("aqua")).toBe("default");
    expect(normalizeAppearance("platinum")).toEqual({ ...DEFAULT_APPEARANCE, scheme: "platinum" });
    expect(normalizeAppearance(JSON.stringify(platinum))).toEqual(platinum);
    expect(normalizeAppearance({ scheme: "platinum", highlight: "pink", scrollbar: 3 })).toEqual({
      ...DEFAULT_APPEARANCE,
      scheme: "platinum",
    });
    expect(
      appearanceFromSettings({ colorScheme: "platinum", platinumHighlight: "teal", platinumScrollbar: "thin" })
    ).toEqual(platinum);
    stubDom(false, "garbage");
    expect(readCachedColorScheme()).toBe("default");
  });

  it("启动时读缓存挂根属性，Platinum 下系统深色也不挂 .dark", () => {
    const { root, classes } = stubDom(true, JSON.stringify(platinum));
    installColorScheme();
    expect(root.dataset).toMatchObject({ theme: "platinum", ptHighlight: "teal", ptScrollbar: "thin" });
    expect(classes.has("dark")).toBe(false);
    expect(listenMock).toHaveBeenCalledWith(COLOR_SCHEME_EVENT, expect.any(Function));
  });

  it("方案变化才通知订阅者，供组件切换 Platinum 布局", () => {
    stubDom(false, null);
    applyColorScheme("default");
    const notify = vi.fn();
    const unsubscribe = subscribeColorScheme(notify);
    applyColorScheme("default");
    expect(notify).not.toHaveBeenCalled();
    applyColorScheme("platinum");
    expect(notify).toHaveBeenCalledOnce();
    expect(getColorScheme()).toBe("platinum");
    unsubscribe();
    applyColorScheme("default");
    expect(notify).toHaveBeenCalledOnce();
  });

  it("发布：本窗切换 + 写缓存 + 广播；切回默认后清掉 Platinum 细项并恢复跟随系统深色", () => {
    const { root, classes, store } = stubDom(true, null);
    installColorScheme();
    expect(classes.has("dark")).toBe(true);

    publishAppearance(platinum);
    expect(root.dataset).toMatchObject({ theme: "platinum", ptHighlight: "teal", ptScrollbar: "thin" });
    expect(classes.has("dark")).toBe(false);
    expect(JSON.parse(store.get(COLOR_SCHEME_STORAGE_KEY)!)).toEqual(platinum);
    expect(emitMock).toHaveBeenCalledWith(COLOR_SCHEME_EVENT, platinum);

    publishAppearance(DEFAULT_APPEARANCE);
    expect(root.dataset.theme).toBeUndefined();
    expect(root.dataset.ptHighlight).toBeUndefined();
    expect(classes.has("dark")).toBe(true);
  });
});
