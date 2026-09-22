import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
  dirty: false,
}));
const mocks = vi.hoisted(() => ({ generate: vi.fn(), tip: vi.fn() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useId: () => "template-assistant",
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = initial;
      return [hooks.values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(hooks.values[index], next)) hooks.dirty = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.values[index] as readonly unknown[] | undefined;
      if (!previous || dependencies.some((value, at) => !Object.is(value, previous[at]))) {
        hooks.values[index] = dependencies;
        hooks.effects.push(effect);
      }
    },
  };
});
vi.mock("@/lib/promptTemplateAi", () => ({ generatePromptTemplate: mocks.generate }));
vi.mock("@/lib/tip", () => ({ tip: mocks.tip }));
vi.mock("@/store/dataOperationStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/dataOperationStore")>();
  return {
    ...actual,
    useDataOperationStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useDataOperationStore.getState>) => unknown) => selector(actual.useDataOperationStore.getState()),
      actual.useDataOperationStore
    ),
  };
});

import { PromptTemplateAssistant } from "./PromptTemplateAssistant";
import { AiError } from "@/lib/aiClient";
import { useNotesStore } from "@/store/notesStore";
import { useDataOperationStore } from "@/store/dataOperationStore";

type Props = ComponentProps<typeof PromptTemplateAssistant>;
type Draft = Parameters<Props["onApply"]>[0];
type Node = ReactElement<Record<string, unknown>>;

function elements(node: ReactNode): Node[] {
  return Children.toArray(node).flatMap((child) => isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as ReactNode)]
    : []);
}

function mount(overrides: Partial<Props> = {}) {
  let props: Props = {
    label: "", text: "",
    settings: { aiEnabled: true, aiBaseUrl: "https://example.test/v1", aiModel: "test-model" },
    onApply: vi.fn(),
    ...overrides,
  };
  let nodes: Node[] = [];
  const render = (next: Partial<Props> = {}) => {
    props = { ...props, ...next };
    let passes = 0;
    do {
      hooks.cursor = 0;
      hooks.dirty = false;
      nodes = elements(PromptTemplateAssistant(props));
      hooks.effects.splice(0).forEach((effect) => {
        const cleanup = effect();
        if (cleanup) hooks.cleanups.push(cleanup);
      });
      if (++passes > 10) throw new Error("AI 助手状态未稳定");
    } while (hooks.dirty);
  };
  const button = (label: string) => {
    const node = nodes.find((item) => item.props.children === label && typeof item.props.onClick === "function");
    if (!node) throw new Error(`Missing button: ${label}`);
    return node.props;
  };
  const click = (label: string) => {
    const control = button(label);
    expect(control.disabled).not.toBe(true);
    (control.onClick as () => void)();
    render();
  };
  const input = () => nodes.find((node) => node.props.id === "template-assistant-instruction")!.props;
  const type = (value: string) => {
    (input().onChange as (event: { target: { value: string } }) => void)({ target: { value } });
    render();
  };
  const settle = async () => { await Promise.resolve(); render(); };
  render();
  return {
    render, button, click, input, type, settle,
    props: () => props,
    nodes: () => nodes,
    candidate: () => nodes.find((node) => node.props["aria-label"] === "AI 模板建议")?.props.children,
    unmount: () => { hooks.cleanups.splice(0).forEach((cleanup) => cleanup()); },
  };
}

function deferred() {
  let resolve!: (value: Draft) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Draft>((ok, fail) => { resolve = ok; reject = fail; });
  mocks.generate.mockReturnValueOnce(promise);
  return { resolve, reject };
}

const first: Draft = { label: "反馈整理", text: "整理反馈：\n{内容}" };
const second: Draft = { label: "反馈要点", text: "三条要点：\n{内容}" };

beforeEach(() => {
  hooks.values = [];
  hooks.effects = [];
  hooks.cleanups = [];
  hooks.dirty = false;
  useDataOperationStore.setState({ locked: false, phase: "idle", message: "" });
  mocks.generate.mockReset();
  mocks.tip.mockReset();
});

describe("AI 模板助手", () => {
  it("空想法禁止生成，示例按钮只填写想法", () => {
    const view = mount();
    expect(view.button("生成模板建议").disabled).toBe(true);
    view.type("   ");
    expect(view.button("生成模板建议").disabled).toBe(true);
    view.click("排查问题");
    expect(view.input().value).toContain("复现步骤和预期结果");
    expect(view.button("生成模板建议").disabled).toBe(false);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(view.props().onApply).not.toHaveBeenCalled();
  });

  it("生成使用当前设置、想法及手动草稿，只展示候选，采用时才回填", async () => {
    const pending = deferred();
    const view = mount({ label: "原模板", text: "原要求：{内容}" });
    const beforeSettings = useNotesStore.getState().settings;
    view.type("按客户反馈整理需求");
    view.click("生成调整建议");
    expect(mocks.generate).toHaveBeenCalledExactlyOnceWith({
      instruction: "按客户反馈整理需求",
      current: { label: "原模板", text: "原要求：{内容}" },
      settings: view.props().settings,
      signal: expect.any(AbortSignal),
    });
    expect(view.input().disabled).toBe(true);
    pending.resolve(first);
    await view.settle();
    expect(view.candidate()).toBe(first.text);
    expect(view.input().value).toBe("");
    expect(view.props().onApply).not.toHaveBeenCalled();
    expect(useNotesStore.getState().settings).toBe(beforeSettings);
    view.click("采用到编辑区");
    expect(view.props().onApply).toHaveBeenCalledExactlyOnceWith(first);
  });

  it("空白新模板不补造 current，继续调整使用已生成候选", async () => {
    const pending = deferred();
    const view = mount();
    view.type("整理反馈");
    view.click("生成模板建议");
    expect(mocks.generate.mock.calls[0][0].current).toBeUndefined();
    pending.resolve(first);
    await view.settle();
    const next = deferred();
    view.type("改成三条要点");
    view.click("生成调整建议");
    expect(mocks.generate.mock.calls[1][0]).toMatchObject({ instruction: "改成三条要点", current: first });
    expect(view.button("采用到编辑区").disabled).toBe(true);
    next.resolve(second);
    await view.settle();
    expect(view.candidate()).toBe(second.text);
    expect(view.props().onApply).not.toHaveBeenCalled();
  });

  it.each([
    new AiError("network", "服务暂时不可用"),
    new Error("当前模板格式无效，名称最多 80 个字符，内容最多 12000 个字符"),
  ])("生成失败保留想法和旧候选，并反馈实际原因：%s", async (error) => {
    const pending = deferred();
    const view = mount();
    view.type("整理反馈");
    view.click("生成模板建议");
    pending.resolve(first);
    await view.settle();
    const next = deferred();
    view.type("再简短一点");
    view.click("生成调整建议");
    next.reject(error);
    await view.settle();
    expect(view.input().value).toBe("再简短一点");
    expect(view.candidate()).toBe(first.text);
    expect(view.button("生成调整建议").disabled).toBe(false);
    expect(mocks.tip).toHaveBeenCalledExactlyOnceWith("warn", error.message);
    expect(view.props().onApply).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("取消后重试，旧请求迟到 %s 不覆盖新请求或清除忙态", async (outcome) => {
    const old = deferred();
    const view = mount();
    view.type("旧想法");
    view.click("生成模板建议");
    const oldSignal = mocks.generate.mock.calls[0][0].signal as AbortSignal;
    view.click("取消生成");
    expect(oldSignal.aborted).toBe(true);
    const next = deferred();
    view.type("新想法");
    view.click("生成模板建议");
    if (outcome === "resolve") old.resolve(first);
    else old.reject(new AiError("cancelled", "已取消"));
    await view.settle();
    expect(view.candidate()).toBeUndefined();
    expect(view.input().value).toBe("新想法");
    expect(view.input().disabled).toBe(true);
    expect(view.button("正在生成…").disabled).toBe(true);
    expect(mocks.tip).not.toHaveBeenCalled();
    next.resolve(second);
    await view.settle();
    expect(view.candidate()).toBe(second.text);
    expect(view.input().disabled).toBe(false);
    expect(view.props().onApply).not.toHaveBeenCalled();
  });

  it("卸载中止请求，迟到结果不修改任何 hook 状态或调用回填", async () => {
    const pending = deferred();
    const view = mount();
    view.type("整理反馈");
    view.click("生成模板建议");
    const signal = mocks.generate.mock.calls[0][0].signal as AbortSignal;
    view.unmount();
    const before = [...hooks.values];
    pending.resolve(first);
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(hooks.values).toEqual(before);
    expect(view.props().onApply).not.toHaveBeenCalled();
    expect(mocks.tip).not.toHaveBeenCalled();
  });

  it("生成期间手动草稿改变也不自动覆盖，明确采用才替换为候选", async () => {
    const pending = deferred();
    const view = mount({ label: "原模板", text: "原内容：{内容}" });
    view.type("整理反馈");
    view.click("生成调整建议");
    view.render({ label: "手填新名称", text: "手填新内容：{内容}" });
    pending.resolve(first);
    await view.settle();
    expect(view.props()).toMatchObject({ label: "手填新名称", text: "手填新内容：{内容}" });
    expect(view.props().onApply).not.toHaveBeenCalled();
    expect(view.candidate()).toBe(first.text);
    view.click("采用到编辑区");
    expect(view.props().onApply).toHaveBeenCalledExactlyOnceWith(first);
  });

  it("数据操作锁定会取消在途请求，解锁后的迟到结果也不回填", async () => {
    const pending = deferred();
    const view = mount();
    view.type("整理反馈");
    view.click("生成模板建议");
    const signal = mocks.generate.mock.calls[0][0].signal as AbortSignal;
    useDataOperationStore.setState({ locked: true });
    view.render();
    expect(signal.aborted).toBe(true);
    expect(view.button("生成模板建议").disabled).toBe(true);
    expect(view.candidate()).toBeUndefined();
    useDataOperationStore.setState({ locked: false });
    view.render();
    pending.resolve(first);
    await view.settle();
    expect(view.candidate()).toBeUndefined();
    expect(view.input().value).toBe("整理反馈");
    expect(view.props().onApply).not.toHaveBeenCalled();
    expect(mocks.tip).not.toHaveBeenCalled();
  });

  it("数据操作锁定清除已有候选，解锁不会恢复旧候选", async () => {
    const pending = deferred();
    const view = mount();
    view.type("整理反馈");
    view.click("生成模板建议");
    pending.resolve(first);
    await view.settle();
    expect(view.candidate()).toBe(first.text);
    useDataOperationStore.setState({ locked: true });
    view.render();
    expect(view.candidate()).toBeUndefined();
    useDataOperationStore.setState({ locked: false });
    view.render();
    expect(view.candidate()).toBeUndefined();
    expect(view.props().onApply).not.toHaveBeenCalled();
  });

  it("锁定后尚未重渲染的旧采用和生成点击也不能绕过同步门禁", async () => {
    const pending = deferred();
    const view = mount();
    view.type("整理反馈");
    view.click("生成模板建议");
    pending.resolve(first);
    await view.settle();
    view.type("进一步调整");
    const staleApply = view.button("采用到编辑区").onClick as () => void;
    const staleGenerate = view.button("生成调整建议").onClick as () => void;
    useDataOperationStore.setState({ locked: true });
    staleApply();
    staleGenerate();
    expect(view.props().onApply).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("放弃建议不修改手动模板，下次生成重新使用当前手动草稿", async () => {
    const pending = deferred();
    const view = mount({ label: "手动模板", text: "手动内容：{内容}" });
    view.type("整理反馈");
    view.click("生成调整建议");
    pending.resolve(first);
    await view.settle();
    view.type("未提交的新想法");
    view.click("放弃建议");
    expect(view.candidate()).toBeUndefined();
    expect(view.input().value).toBe("");
    expect(view.props().onApply).not.toHaveBeenCalled();
    const next = deferred();
    view.type("重新生成");
    view.click("生成调整建议");
    expect(mocks.generate.mock.calls[1][0].current).toEqual({ label: "手动模板", text: "手动内容：{内容}" });
    next.resolve(second);
    await view.settle();
  });

  it.each([
    { aiEnabled: false, aiBaseUrl: "https://example.test/v1", aiModel: "model" },
    { aiEnabled: true, aiBaseUrl: "", aiModel: "model" },
    { aiEnabled: true, aiBaseUrl: "https://example.test/v1", aiModel: "" },
  ])("AI 未配置时只禁用生成入口，手动草稿不被锁定或修改：%j", (settings) => {
    const view = mount({ settings, label: "手动模板", text: "手动内容" });
    view.type("整理反馈");
    expect(view.button("生成调整建议").disabled).toBe(true);
    expect(view.input().disabled).toBe(false);
    expect(view.nodes().some((node) => typeof node.props.children === "string" && node.props.children.includes("或直接手动编辑"))).toBe(true);
    (view.button("生成调整建议").onClick as () => void)();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(view.props().onApply).not.toHaveBeenCalled();
  });
});
