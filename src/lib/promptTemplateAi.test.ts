import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./aiClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("./aiClient")>(),
  requestAi: vi.fn(),
}));

import { requestAi } from "./aiClient";
import { generatePromptTemplate } from "./promptTemplateAi";

const settings = { aiEnabled: true, aiBaseUrl: "https://example.com", aiModel: "model" };
const create = () => generatePromptTemplate({ instruction: "总结重点", settings });

beforeEach(() => { vi.mocked(requestAi).mockReset(); });

describe("generatePromptTemplate", () => {
  it("只发送想法及当前模板的名称与内容，配置和取消信号走共用 transport", async () => {
    const signal = new AbortController().signal;
    const current = { label: "原模板", text: "总结 {内容}", groupId: "不应发送", material: "不应发送" };
    vi.mocked(requestAi).mockResolvedValue('{"label":" 新名称 ","text":" 新内容 {内容} ","extra":"忽略"}');
    expect(await generatePromptTemplate({ instruction: " 改为行动项 ", current, settings, signal }))
      .toEqual({ label: "新名称", text: "新内容 {内容}" });
    const request = vi.mocked(requestAi).mock.calls[0][0];
    expect(request).toMatchObject({ purpose: "improve-prompt", settings, signal, keyAccess: "settings" });
    expect(JSON.parse(request.user)).toEqual({
      instruction: "改为行动项", current: { label: "原模板", text: "总结 {内容}" },
    });
  });

  it("新建模板不附带当前模板，遗漏占位符时补到末尾", async () => {
    vi.mocked(requestAi).mockResolvedValue('```json\n{"label":"总结","text":"请总结重点"}\n```');
    expect(await create()).toEqual({ label: "总结", text: "请总结重点\n\n{内容}" });
    expect(JSON.parse(vi.mocked(requestAi).mock.calls[0][0].user)).toEqual({ instruction: "总结重点" });
  });

  it.each(["", "  \n ", "字".repeat(2001)])("空白或过长想法不发请求", async (instruction) => {
    await expect(generatePromptTemplate({ instruction, settings })).rejects.toThrow("2000");
    expect(requestAi).not.toHaveBeenCalled();
  });

  it.each([
    { label: "字".repeat(81), text: "正文" },
    { label: "模板", text: "字".repeat(12001) },
    { label: 1, text: "正文" },
    { label: "模板", text: null },
  ])("拒绝过长或类型无效的已有模板", async (current) => {
    await expect(generatePromptTemplate({
      instruction: "调整", settings, current: current as never,
    })).rejects.toThrow("当前模板格式无效");
    expect(requestAi).not.toHaveBeenCalled();
  });

  it.each([
    "不是 JSON", '{"label":"名称",}', "null", "[]",
    '[{"label":"名称","text":"正文"}]',
    JSON.stringify({ label: "", text: "正文" }),
    JSON.stringify({ label: " \n ", text: "正文" }),
    JSON.stringify({ label: 123, text: "正文" }),
    JSON.stringify({ label: "名称", text: null }),
    JSON.stringify({ label: "名称", text: " \n " }),
    JSON.stringify({ label: "字".repeat(81), text: "正文" }),
    JSON.stringify({ label: "名称", text: "字".repeat(12001) }),
    JSON.stringify({ label: "名称", text: "{内容}\n{内容}" }),
    JSON.stringify({ label: "名称", text: "字".repeat(12000) }),
  ])("非法 AI 结果不返回可采用草稿", async (raw) => {
    vi.mocked(requestAi).mockResolvedValue(raw);
    await expect(create()).rejects.toMatchObject({ kind: "parse" });
  });

  it("长度按 Unicode 字符计算，恰好达到限制可以接受", async () => {
    const label = "🎉".repeat(80);
    const text = "字".repeat(11996) + "{内容}";
    vi.mocked(requestAi).mockResolvedValue(JSON.stringify({ label, text }));
    expect(await create()).toEqual({ label, text });
  });

  it("网络与取消错误透传，不伪造模板", async () => {
    const error = new Error("取消");
    vi.mocked(requestAi).mockRejectedValue(error);
    await expect(create()).rejects.toBe(error);
  });
});
