import { describe, expect, it } from "vitest";
import {
  isCommonPromptSnippet,
  promptSnippetSourceLabel,
  replaceCommonPromptSnippet,
  WORKFLOW_PROMPT_SNIPPETS,
} from "./promptTemplates";

describe("模板来源标记", () => {
  it("新常用预设按原 ID、名称、正文和分组识别为内置", () => {
    for (const snippet of WORKFLOW_PROMPT_SNIPPETS) {
      expect(promptSnippetSourceLabel({ ...snippet })).toBe("内置");
    }
  });

  it.each([
    ["review", "代码审查", "请帮我 review 以下代码，指出问题与改进建议：\n\n{内容}"],
    ["translate", "翻译成中文", "请把以下内容翻译成中文：\n\n{内容}"],
    ["summarize", "总结要点", "请总结以下内容的要点：\n\n{内容}"],
    ["explain", "解释内容", "请解释以下内容：\n\n{内容}"],
    ["optimize-prompt", "优化提示词", "请你不要执行接下来的任务。你现在的身份是世界顶级的提示工程专家，请仔细阅读我提供的提示词：\n\n{内容}\n\n并从清晰度、专业度、结构化、模型适应性四个维度进行批判性优化。请仅输出优化后的提示词内容，并用 ``` 包裹起来。"],
  ])("保留下来的旧预设 %s 仍标记内置", (id, label, text) => {
    expect(promptSnippetSourceLabel({ id, label, text, groupId: "general" })).toBe("内置");
  });

  it.each([
    { label: "我的需求模板" },
    { text: "自定义正文" },
    { groupId: "project" },
  ])("内置 ID 修改名称、正文或分组后标记已修改：%j", (patch) => {
    expect(promptSnippetSourceLabel({ ...WORKFLOW_PROMPT_SNIPPETS[0], ...patch }))
      .toBe("内置·已修改");
    expect(promptSnippetSourceLabel({ id: "review", label: "我的代码审查", text: "我的规则", groupId: "project" }))
      .toBe("内置·已修改");
  });

  it("其他 ID 即使正文与预设相同也只标记自建，不推测导入历史", () => {
    expect(promptSnippetSourceLabel({ ...WORKFLOW_PROMPT_SNIPPETS[0], id: "my-template" }))
      .toBe("自建");
  });
});

describe("替换常用模板", () => {
  const original = WORKFLOW_PROMPT_SNIPPETS[0];
  const custom = { id: "custom", label: "我的模板", text: "原始正文 {内容}", groupId: "project" };
  const untouched = WORKFLOW_PROMPT_SNIPPETS[1];

  it("缺省使用原内置常用身份，显式标记覆盖默认", () => {
    expect(isCommonPromptSnippet(original)).toBe(true);
    expect(isCommonPromptSnippet(custom)).toBe(false);
    expect(isCommonPromptSnippet({ ...original, isCommon: false })).toBe(false);
    expect(isCommonPromptSnippet({ ...custom, isCommon: true })).toBe(true);
  });

  it.each([false, true])("双向位置均可替换，保留两份模板字段且不修改输入（候选在前=%s）", (before) => {
    const input = before ? [custom, untouched, original] : [original, untouched, custom];
    const snapshot = structuredClone(input);
    const next = replaceCommonPromptSnippet(input, original.id, custom.id);
    expect(next).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect(next[before ? 2 : 0]).toEqual({ ...custom, isCommon: true });
    expect(next[before ? 0 : 2]).toEqual({ ...original, isCommon: false });
    expect(next[1]).toBe(untouched);
    expect(next).toHaveLength(input.length);
    expect(new Set(next.map((snippet) => snippet.id))).toEqual(new Set(input.map((snippet) => snippet.id)));
  });

  it("可以再换回原模板，来源标记不受常用身份影响", () => {
    const replaced = replaceCommonPromptSnippet([original, untouched, custom], original.id, custom.id);
    expect(promptSnippetSourceLabel(replaced[0])).toBe("自建");
    expect(promptSnippetSourceLabel(replaced[2])).toBe("内置");
    const restored = replaceCommonPromptSnippet(replaced, custom.id, original.id);
    expect(restored).toEqual([{ ...original, isCommon: true }, untouched, { ...custom, isCommon: false }]);
  });

  it.each([
    [original.id, original.id], ["missing", custom.id], [original.id, "missing"],
    [custom.id, original.id], [original.id, untouched.id],
  ])("无效替换 %s → %s 返回原数组", (currentId, replacementId) => {
    const input = [original, untouched, custom];
    expect(replaceCommonPromptSnippet(input, currentId, replacementId)).toBe(input);
  });
});
