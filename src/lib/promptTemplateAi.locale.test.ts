import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./aiClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("./aiClient")>(),
  requestAi: vi.fn(),
}));

import { requestAi } from "./aiClient";
import { applyLocale } from "./i18n";
import { generatePromptTemplate } from "./promptTemplateAi";

const settings = { aiEnabled: true, aiBaseUrl: "https://example.com", aiModel: "model" };

describe("generatePromptTemplate 英文界面", () => {
  afterEach(() => {
    applyLocale("zh");
    vi.mocked(requestAi).mockReset();
  });

  it("用英文提示词，占位符仍为字面量 {内容}，解析不变", async () => {
    applyLocale("en");
    vi.mocked(requestAi).mockResolvedValue('{"label":"Summary","text":"Summarize: {内容}"}');
    expect(await generatePromptTemplate({ instruction: "summarize", settings }))
      .toEqual({ label: "Summary", text: "Summarize: {内容}" });
    const system = vi.mocked(requestAi).mock.calls[0][0].system;
    expect(system).toContain("You edit send templates");
    expect(system).toContain("{内容}");
  });

  it("英文界面缺占位符时同样补到末尾，错误文案为英文", async () => {
    applyLocale("en");
    vi.mocked(requestAi).mockResolvedValue('{"label":"Short","text":"Be brief"}');
    expect(await generatePromptTemplate({ instruction: "short", settings }))
      .toEqual({ label: "Short", text: "Be brief\n\n{内容}" });
    vi.mocked(requestAi).mockResolvedValue('{"label":"X","text":"{内容} {内容}"}');
    await expect(generatePromptTemplate({ instruction: "x", settings }))
      .rejects.toThrow("AI template contains {内容} more than once. Generate again");
  });
});
