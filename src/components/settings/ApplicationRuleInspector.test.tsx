import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, dirty: false,
  effects: [] as (() => void)[], cleanups: new Map<number, () => void>(),
}));
const mocks = vi.hoisted(() => ({ tip: vi.fn(), open: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.dirty = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useMemo: (calculate: () => unknown) => calculate(),
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.values[index] as readonly unknown[] | undefined;
      if (!previous || dependencies.some((value, at) => !Object.is(value, previous[at]))) {
        hooks.values[index] = dependencies;
        hooks.effects.push(() => {
          hooks.cleanups.get(index)?.();
          const cleanup = effect();
          if (cleanup) hooks.cleanups.set(index, cleanup);
          else hooks.cleanups.delete(index);
        });
      }
    },
  };
});
vi.mock("./useAppIdentity", () => ({ useAppIdentity: (bundleId: string | null, fallback?: string) => bundleId ? { name: fallback || bundleId, iconUrl: null } : null }));
vi.mock("@/lib/tip", () => ({ tip: mocks.tip }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@/store/dataOperationStore", async (original) => {
  const actual = await original<typeof import("@/store/dataOperationStore")>();
  return { ...actual, useDataOperationStore: Object.assign(
    (selector: (state: ReturnType<typeof actual.useDataOperationStore.getState>) => unknown) => selector(actual.useDataOperationStore.getState()),
    actual.useDataOperationStore,
  ) };
});

import { ApplicationRuleInspector } from "./ApplicationRuleInspector";
import { ApplicationRuleFields } from "./ApplicationRuleFields";
import { Segmented } from "@/components/ui/segmented";
import { defaultSettings, type Settings } from "@/store/notesStore";
import { useDataOperationStore } from "@/store/dataOperationStore";
import { api, type TargetSnapshot } from "@/lib/tauri";
import type { TargetProfile } from "@/lib/targetProfiles";

type Props = ComponentProps<typeof ApplicationRuleInspector>;
type Node = ReactElement<Record<string, unknown>>;
const A = "com.example.alpha", B = "com.example.beta";
const profile = (id: string, bundleIds: string[] = []): TargetProfile => ({
  id, name: id, bundleIds, promptGroupId: "general", defaultFormat: "plain", defaultMarkdownMode: "preserve",
  enterPolicy: "never", privacyPolicy: "requireRedaction", keepPanel: false,
});
const settings = (): Settings => ({ ...defaultSettings(), defaultTargetProfileId: "default", targetProfiles: [profile("default"), profile("shared", [A, B])] });
const target = (bundleId = A): TargetSnapshot => ({ token: bundleId, bundleId, appName: bundleId === A ? "Alpha" : "Beta", pid: 42, launchedAtMs: 1, capturedAtMs: 2, revision: 1, ready: true, reason: null, windowId: null });
const nodesOf = (node: ReactNode): Node[] => Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child) ? [child, ...nodesOf(child.props.children as ReactNode)] : []);
const textOf = (node: ReactNode): string => Children.toArray(node).map(child => isValidElement<Record<string, unknown>>(child) ? textOf(child.props.children as ReactNode) : String(child)).join("");

function mount(overrides: Partial<Props> = {}) {
  let props: Props = { settings: settings(), patch: vi.fn(), currentTarget: target(), recentApps: [], ...overrides };
  let nodes: Node[] = [];
  const render = (next: Partial<Props> = {}) => {
    props = { ...props, ...next };
    let count = 0;
    do {
      hooks.cursor = 0; hooks.dirty = false;
      nodes = nodesOf(ApplicationRuleInspector(props));
      hooks.effects.splice(0).forEach(effect => effect());
      if (++count > 15) throw new Error("应用规则状态未稳定");
    } while (hooks.dirty);
  };
  const button = (label: string) => {
    const result = nodes.find(node => typeof node.props.onClick === "function" && textOf(node.props.children as ReactNode) === label);
    if (!result) throw new Error(`缺少按钮：${label}`);
    return result.props;
  };
  const click = (label: string) => { const control = button(label); expect(control.disabled).not.toBe(true); (control.onClick as () => void)(); render(); };
  const fields = () => nodes.find(node => node.type === ApplicationRuleFields)!.props as ComponentProps<typeof ApplicationRuleFields>;
  const edit = (change: Parameters<ReturnType<typeof fields>["onUpdate"]>[0]) => { fields().onUpdate(change); render(); };
  const select = (bundleId: string) => {
    const row = nodes.find(node => (node.props.app as { bundleId?: string } | undefined)?.bundleId === bundleId)!;
    (row.props.onSelect as () => void)(); render();
  };
  const scope = (next: "app" | "shared") => { (nodes.find(node => node.type === Segmented)!.props.onChange as (value: string) => void)(next); render(); };
  render();
  return { render, button, click, fields, edit, select, scope, unmount: () => { hooks.cleanups.forEach(cleanup => cleanup()); hooks.cleanups.clear(); }, nodes: () => nodes, props: () => props, text: () => nodes.filter(node => typeof node.type === "string").map(node => textOf(node.props.children as ReactNode)).join("\n") };
}

beforeEach(() => {
  hooks.cleanups.forEach(cleanup => cleanup());
  hooks.values = []; hooks.effects = []; hooks.cleanups.clear(); hooks.cursor = 0;
  useDataOperationStore.setState({ locked: false, phase: "idle", message: "" });
  mocks.tip.mockReset(); mocks.open.mockReset(); vi.restoreAllMocks();
});

describe("应用优先规则检查器", () => {
  it("编辑只留草稿，放弃恢复原值且不发送设置", () => {
    const view = mount();
    expect(view.button("应用到当前应用").disabled).toBe(true);
    view.edit({ keepPanel: true });
    expect(view.fields().profile.keepPanel).toBe(true);
    expect(view.props().patch).not.toHaveBeenCalled();
    view.click("放弃修改");
    expect(view.fields().profile.keepPanel).toBe(false);
    expect(view.props().patch).not.toHaveBeenCalled();
  });

  it("仅此应用应用草稿时唯一重绑，其他共享应用与原方案保留", () => {
    const view = mount();
    view.edit({ enterPolicy: "confirm" });
    view.click("应用到当前应用");
    expect(view.props().patch).toHaveBeenCalledTimes(1);
    const patch = vi.mocked(view.props().patch).mock.calls[0]![0];
    expect(Object.keys(patch)).toEqual(["targetProfiles"]);
    expect(patch.targetProfiles!.find(item => item.id === "shared")).toMatchObject({ bundleIds: [B], enterPolicy: "never" });
    expect(patch.targetProfiles!.find(item => item.bundleIds.includes(A))).toMatchObject({ bundleIds: [A], enterPolicy: "confirm" });
    view.render({ settings: { ...view.props().settings, ...patch } });
    expect(view.fields().profile.enterPolicy).toBe("confirm");
    expect(view.button("应用到当前应用").disabled).toBe(true);
  });

  it("明确选择共享方案后应用同一个方案，不创建独立绑定", () => {
    const view = mount();
    view.scope("shared");
    expect(view.props().patch).not.toHaveBeenCalled();
    view.edit({ keepPanel: true });
    view.click("应用到共享方案");
    const profiles = vi.mocked(view.props().patch).mock.calls[0]![0].targetProfiles!;
    expect(profiles).toHaveLength(2);
    expect(profiles.find(item => item.id === "shared")).toMatchObject({ bundleIds: [A, B], keepPanel: true });
  });

  it("切换应用保留各自草稿，应用一项不提交其他应用草稿", () => {
    const view = mount();
    view.edit({ keepPanel: true });
    view.select(B);
    expect(view.fields().profile.keepPanel).toBe(false);
    view.edit({ enterPolicy: "confirm" });
    view.select(A);
    expect(view.fields().profile.keepPanel).toBe(true);
    expect(view.fields().profile.enterPolicy).toBe("never");
    view.click("应用到当前应用");
    const patch = vi.mocked(view.props().patch).mock.calls[0]![0];
    expect(patch.targetProfiles!.find(item => item.bundleIds.includes(B))!.enterPolicy).toBe("never");
  });

  it("无关设置或其他方案更新不清除草稿，应用保留最新的其他方案", () => {
    const view = mount();
    view.edit({ keepPanel: true });
    const next = { ...view.props().settings, firewallEnabled: !view.props().settings.firewallEnabled, targetProfiles: view.props().settings.targetProfiles.map(item => item.id === "default" ? { ...item, name: "新版默认" } : { ...item }) };
    view.render({ settings: next });
    expect(view.fields().profile.keepPanel).toBe(true);
    expect(view.button("应用到当前应用").disabled).toBe(false);
    view.click("应用到当前应用");
    expect(vi.mocked(view.props().patch).mock.calls[0]![0].targetProfiles![0]!.name).toBe("新版默认");
  });

  it.each(["profile", "binding", "default"])("相关 %s 外部变化保留草稿但阻止覆盖，重载后使用新规则", (change) => {
    const view = mount();
    view.edit({ keepPanel: true });
    const next = { ...view.props().settings, targetProfiles: view.props().settings.targetProfiles.map(item => item.id !== "shared" ? item : change === "profile" ? { ...item, enterPolicy: "allow" as const } : change === "binding" ? { ...item, bundleIds: [B] } : item), defaultTargetProfileId: change === "default" ? "shared" : "default" };
    view.render({ settings: next });
    expect(view.text()).toContain("当前草稿已保留");
    expect(view.fields().profile.keepPanel).toBe(true);
    expect(view.button("应用到当前应用").disabled).toBe(true);
    (view.button("应用到当前应用").onClick as () => void)();
    view.fields().onUpdate({ defaultFormat: "code" });
    expect(view.props().patch).not.toHaveBeenCalled();
    view.click("放弃草稿并载入最新规则");
    expect(view.fields().profile.keepPanel).toBe(false);
    expect(view.text()).not.toContain("当前草稿已保留");
    if (change === "profile") expect(view.fields().profile.enterPolicy).toBe("allow");
  });

  it("锁定后未重渲染的旧修改与应用处理器不能写入，重渲染清除草稿", () => {
    const view = mount();
    view.edit({ keepPanel: true });
    const oldApply = view.button("应用到当前应用").onClick as () => void;
    const oldUpdate = view.fields().onUpdate;
    useDataOperationStore.setState({ locked: true });
    oldApply(); oldUpdate({ enterPolicy: "allow" });
    expect(view.props().patch).not.toHaveBeenCalled();
    view.render();
    expect(view.fields().profile.keepPanel).toBe(false);
    expect(view.button("应用到当前应用").disabled).toBe(true);
    expect(view.text()).toContain("数据操作期间暂停修改");
    useDataOperationStore.setState({ locked: false }); view.render();
    expect(view.button("应用到当前应用").disabled).toBe(true);
  });

  it("用户手动选择后，当前目标变化不抢走选择或草稿", () => {
    const view = mount({ currentTarget: null });
    view.render({ currentTarget: target() });
    view.select(B); view.edit({ keepPanel: true });
    view.render({ currentTarget: { ...target(), revision: 2 } });
    expect(view.fields().profile.keepPanel).toBe(true);
    view.click("应用到当前应用");
    expect(vi.mocked(view.props().patch).mock.calls[0]![0].targetProfiles!.find(item => item.bundleIds.includes(B))!.keepPanel).toBe(true);
  });

  it("请求可以定位未列出的应用；新序号重新定位，旧序号不抢选择", () => {
    const unknown = "com.example.unbound";
    const view = mount({ request: { bundleId: unknown, sequence: 1 } });
    expect(view.text()).toContain("尚未单独设置");
    view.select(B);
    view.render({ request: { bundleId: unknown, sequence: 1 } });
    expect(view.fields().profile.id).toBe("shared");
    view.render({ request: { bundleId: unknown, sequence: 2 } });
    expect(view.fields().profile.id).toBe("default");
    view.render({ request: { bundleId: null, sequence: 3 } });
    expect(view.button("应用默认规则").disabled).toBe(true);
    expect(view.fields().fallback).toBe(true);
    expect(view.props().patch).not.toHaveBeenCalled();
  });

  it("没有草稿时接受外部规则更新，不报冲突", () => {
    const view = mount();
    view.render({ settings: { ...view.props().settings, targetProfiles: view.props().settings.targetProfiles.map(item => item.id === "shared" ? { ...item, keepPanel: true } : item) } });
    expect(view.fields().profile.keepPanel).toBe(true);
    expect(view.text()).not.toContain("当前草稿已保留");
    expect(view.button("应用到当前应用").disabled).toBe(true);
  });
});

describe("应用恢复默认", () => {
  it("先暂存安全默认规则，应用后仅解除当前绑定并保留所有方案", () => {
    const initial = settings();
    initial.firewallEnabled = true;
    initial.targetProfiles[0] = { ...initial.targetProfiles[0]!, defaultFormat: "code", enterPolicy: "allow", privacyPolicy: "allowRaw", keepPanel: true };
    initial.targetProfiles[1] = { ...initial.targetProfiles[1]!, enterPolicy: "confirm" };
    const view = mount({ settings: initial });
    view.click("恢复默认");
    expect(view.text()).toContain("待恢复默认");
    expect(view.fields().profile).toMatchObject({ defaultFormat: "code", enterPolicy: "never", privacyPolicy: "requireRedaction", keepPanel: true });
    expect(view.props().patch).not.toHaveBeenCalled();
    expect(view.nodes().find(node => node.type === "fieldset")!.props.disabled).toBe(true);
    view.edit({ defaultFormat: "plain", enterPolicy: "allow" });
    expect(view.fields().profile).toMatchObject({ defaultFormat: "code", enterPolicy: "never" });
    view.click("应用到当前应用");
    expect(view.props().patch).toHaveBeenCalledTimes(1);
    const patch = vi.mocked(view.props().patch).mock.calls[0]![0];
    expect(Object.keys(patch)).toEqual(["targetProfiles"]);
    expect(patch.targetProfiles).toEqual([initial.targetProfiles[0], { ...initial.targetProfiles[1], bundleIds: [B] }]);
    view.render({ settings: { ...initial, ...patch } });
    expect(view.text()).not.toContain("待恢复默认");
    expect(view.fields().profile).toMatchObject({ defaultFormat: "code", enterPolicy: "never", privacyPolicy: "requireRedaction" });
    expect(view.button("恢复默认").disabled).toBe(true);
  });

  it("共享范围的恢复默认也只解除当前应用，不修改其他应用", () => {
    const view = mount();
    const initial = view.props().settings;
    view.scope("shared");
    view.edit({ keepPanel: true });
    view.click("恢复默认");
    view.click("应用到当前应用");
    expect(vi.mocked(view.props().patch).mock.calls[0]![0].targetProfiles).toEqual([
      initial.targetProfiles[0], { ...initial.targetProfiles[1], bundleIds: [B] },
    ]);
  });

  it("放弃恢复默认草稿后显示原绑定规则，不写入设置", () => {
    const initial = settings();
    initial.targetProfiles[1] = { ...initial.targetProfiles[1]!, keepPanel: true, enterPolicy: "confirm" };
    const view = mount({ settings: initial });
    view.click("恢复默认");
    expect(view.fields().profile.keepPanel).toBe(false);
    view.click("放弃修改");
    expect(view.text()).not.toContain("待恢复默认");
    expect(view.fields().profile).toMatchObject({ id: "shared", keepPanel: true, enterPolicy: "confirm" });
    expect(view.button("应用到当前应用").disabled).toBe(true);
    expect(view.props().patch).not.toHaveBeenCalled();
  });

  it("默认与源字段相同仍保留恢复草稿，切换应用后可继续应用", () => {
    const view = mount();
    view.click("恢复默认");
    expect(view.button("应用到当前应用").disabled).toBe(false);
    view.select(B);
    expect(view.text()).not.toContain("待恢复默认");
    expect(view.text()).toContain("另有 1 个应用的修改尚未应用");
    expect(view.button("应用到当前应用").disabled).toBe(true);
    view.select(A);
    expect(view.text()).toContain("待恢复默认");
    view.click("应用到当前应用");
    expect(vi.mocked(view.props().patch).mock.calls[0]![0].targetProfiles!.find(item => item.id === "shared")!.bundleIds).toEqual([B]);
  });

  it("默认规则无恢复入口，未绑定应用的恢复按钮禁用且处理器不写入", () => {
    const view = mount({ request: { bundleId: null, sequence: 1 } });
    expect(() => view.button("恢复默认")).toThrow("缺少按钮");
    view.render({ request: { bundleId: "com.example.unbound", sequence: 2 } });
    expect(view.button("恢复默认").disabled).toBe(true);
    (view.button("恢复默认").onClick as () => void)();
    view.render();
    expect(view.text()).not.toContain("待恢复默认");
    expect(view.button("应用到当前应用").disabled).toBe(true);
    expect(view.props().patch).not.toHaveBeenCalled();
  });

  it("锁定阻止旧恢复与应用处理器，重渲染后清除恢复草稿", () => {
    const view = mount();
    const oldReset = view.button("恢复默认").onClick as () => void;
    view.click("恢复默认");
    const oldApply = view.button("应用到当前应用").onClick as () => void;
    useDataOperationStore.setState({ locked: true });
    oldReset(); oldApply();
    expect(view.props().patch).not.toHaveBeenCalled();
    view.render();
    expect(view.text()).not.toContain("待恢复默认");
    expect(view.button("恢复默认").disabled).toBe(true);
    expect(view.button("应用到当前应用").disabled).toBe(true);
    useDataOperationStore.setState({ locked: false }); view.render();
    expect(view.button("应用到当前应用").disabled).toBe(true);
  });

  it.each(["source", "binding", "default-content", "default-id"])("恢复期间 %s 变化保留草稿但阻止应用", (change) => {
    const view = mount();
    view.click("恢复默认");
    const next = { ...view.props().settings, targetProfiles: view.props().settings.targetProfiles.map(item =>
      change === "default-content" && item.id === "default" ? { ...item, defaultFormat: "code" as const }
      : change === "source" && item.id === "shared" ? { ...item, keepPanel: true }
      : change === "binding" && item.id === "shared" ? { ...item, bundleIds: [B] }
      : item), defaultTargetProfileId: change === "default-id" ? "shared" : "default" };
    view.render({ settings: next });
    expect(view.text()).toContain("当前草稿已保留");
    expect(view.button("应用到当前应用").disabled).toBe(true);
    (view.button("应用到当前应用").onClick as () => void)();
    expect(view.props().patch).not.toHaveBeenCalled();
    view.click("放弃草稿并载入最新规则");
    expect(view.text()).not.toContain("待恢复默认");
    expect(view.text()).not.toContain("当前草稿已保留");
  });

  it("明确绑定默认方案的应用恢复后使用安全默认值，其他明确绑定不变", () => {
    const initial = settings();
    initial.firewallEnabled = true;
    initial.targetProfiles = [{ ...profile("default", [A, B]), enterPolicy: "allow", privacyPolicy: "allowRaw" }];
    const view = mount({ settings: initial });
    expect(view.fields().profile).toMatchObject({ enterPolicy: "allow", privacyPolicy: "allowRaw" });
    view.click("恢复默认");
    expect(view.fields().profile).toMatchObject({ enterPolicy: "never", privacyPolicy: "requireRedaction" });
    view.click("应用到当前应用");
    expect(vi.mocked(view.props().patch).mock.calls[0]![0].targetProfiles).toEqual([
      { ...initial.targetProfiles[0], bundleIds: [B] },
    ]);
  });

  it("重复绑定时禁止恢复，避免隐式选择或覆盖冲突规则", () => {
    const initial = settings();
    initial.targetProfiles.push(profile("conflict", [A]));
    const view = mount({ settings: initial });
    expect(view.button("恢复默认").disabled).toBe(true);
    (view.button("恢复默认").onClick as () => void)();
    view.render();
    expect(view.text()).not.toContain("待恢复默认");
    expect(view.props().patch).not.toHaveBeenCalled();
  });

  it("解除单应用方案绑定后保留空方案，避免删除可复用规则", () => {
    const initial = settings();
    initial.targetProfiles[1] = { ...initial.targetProfiles[1]!, bundleIds: [A] };
    const view = mount({ settings: initial });
    view.click("恢复默认");
    view.click("应用到当前应用");
    expect(vi.mocked(view.props().patch).mock.calls[0]![0].targetProfiles).toEqual([
      initial.targetProfiles[0], { ...initial.targetProfiles[1], bundleIds: [] },
    ]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("应用选择器的迟到结果", () => {
  it("锁定取消旧选择器，解锁后的旧返回不清除新请求忙态", async () => {
    const old = deferred<string | null>(), current = deferred<string | null>();
    mocks.open.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const bundle = vi.spyOn(api, "bundleIdOfApp").mockResolvedValue("com.example.new");
    const view = mount();
    view.click("选择应用…");
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1));
    useDataOperationStore.setState({ locked: true }); view.render();
    useDataOperationStore.setState({ locked: false }); view.render();
    view.click("选择应用…");
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
    old.resolve("/Applications/Old.app"); await settle(); view.render();
    expect(view.button("正在选择…").disabled).toBe(true);
    expect(bundle).not.toHaveBeenCalled();
    current.resolve("/Applications/New.app");
    await vi.waitFor(() => expect(bundle).toHaveBeenCalledExactlyOnceWith("/Applications/New.app"));
    await settle(); view.render();
    expect(view.button("选择应用…").disabled).toBe(false);
    expect(view.text()).toContain("com.example.new");
    expect(view.props().patch).not.toHaveBeenCalled();
  });

  it.each(["selection", "request"])("读取应用身份时 %s 改变，迟到身份不会抢走新选择", async (change) => {
    const result = deferred<string | null>();
    mocks.open.mockResolvedValue("/Applications/Old.app");
    const bundle = vi.spyOn(api, "bundleIdOfApp").mockReturnValue(result.promise);
    const view = mount();
    view.click("选择应用…");
    await vi.waitFor(() => expect(bundle).toHaveBeenCalledTimes(1));
    if (change === "selection") view.select(B);
    else view.render({ request: { bundleId: B, sequence: 1 } });
    result.resolve("com.example.old"); await settle(); view.render();
    expect(view.text()).not.toContain("com.example.old");
    expect(view.button("选择应用…").disabled).toBe(false);
    view.edit({ keepPanel: true }); view.click("应用到当前应用");
    expect(vi.mocked(view.props().patch).mock.calls[0]![0].targetProfiles!.find(item => item.bundleIds.includes(B))!.keepPanel).toBe(true);
  });

  it("卸载后选择器返回不读取身份也不更新状态", async () => {
    const pending = deferred<string | null>();
    mocks.open.mockReturnValue(pending.promise);
    const bundle = vi.spyOn(api, "bundleIdOfApp").mockResolvedValue("com.example.old");
    const view = mount(); view.click("选择应用…");
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1));
    view.unmount(); hooks.dirty = false;
    pending.resolve("/Applications/Old.app"); await settle();
    expect(bundle).not.toHaveBeenCalled();
    expect(hooks.dirty).toBe(false);
    expect(view.props().patch).not.toHaveBeenCalled();
  });
});
