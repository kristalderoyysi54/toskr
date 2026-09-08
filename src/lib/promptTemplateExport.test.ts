import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ save: vi.fn(), exportPromptTemplates: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: calls.save }));
vi.mock("@/lib/tauri", () => ({ api: { exportPromptTemplates: calls.exportPromptTemplates } }));

import { buildPromptTemplatesExport, exportPromptTemplates } from "./promptTemplateExport";

const groups = [
  { id: "general", name: "通用", order: 0 },
  { id: "project", name: "项目", order: 2 },
  { id: "unused", name: "未引用", order: 3 },
];
const snippets = [
  { id: "mine", label: "我的模板", text: "保留正文\n\n{内容}", groupId: "project" },
  { id: "review", label: "我的代码审查", text: "保留旧 ID 的自定义指令", groupId: "general" },
];

beforeEach(() => {
  calls.save.mockReset().mockResolvedValue("/tmp/templates.json");
  calls.exportPromptTemplates.mockReset().mockResolvedValue(undefined);
});

describe("模板独立导出", () => {
  it("只复制模板和引用分组的定义字段，保留 ID、正文、分组及顺序", () => {
    const withExtraFields = snippets.map((snippet) => ({ ...snippet, aiApiKey: "private-key", notes: ["private-note"] }));
    const withExtraGroupFields = groups.map((group) => ({ ...group, settings: { secretKeys: ["private-key"] } }));
    const exported = buildPromptTemplatesExport(withExtraFields, withExtraGroupFields);
    expect(exported).toEqual({
      format: "toskr-prompt-templates",
      version: 1,
      groups: groups.slice(0, 2),
      snippets,
    });
    expect(JSON.stringify(exported)).not.toMatch(/private-key|private-note|notes|settings|aiApiKey|secretKeys/);
    expect(exported.snippets[0]).not.toBe(withExtraFields[0]);
    expect(exported.groups[0]).not.toBe(withExtraGroupFields[0]);
    expect(withExtraFields[0].text).toBe(snippets[0].text);
  });

  it("空列表导出空模板和空分组，不补回默认项", () => {
    expect(buildPromptTemplatesExport([], groups)).toEqual({
      format: "toskr-prompt-templates", version: 1, groups: [], snippets: [],
    });
  });

  it("缺少引用分组时中止导出，不生成无法还原的模板文件", async () => {
    await expect(exportPromptTemplates(snippets, [])).rejects.toThrow("模板引用的分组不存在");
    expect(calls.save).not.toHaveBeenCalled();
    expect(calls.exportPromptTemplates).not.toHaveBeenCalled();
  });

  it("选择保存路径后只调用模板导出 API，不修改传入内容", async () => {
    const expected = buildPromptTemplatesExport(snippets, groups);
    expect(await exportPromptTemplates(snippets, groups)).toEqual({ path: "/tmp/templates.json", count: 2 });
    expect(calls.save).toHaveBeenCalledExactlyOnceWith({
      defaultPath: "toskr-prompt-templates.json",
      filters: [{ name: "Toskr 提示词模板", extensions: ["json"] }],
    });
    expect(calls.exportPromptTemplates).toHaveBeenCalledExactlyOnceWith("/tmp/templates.json", expected);
    expect(buildPromptTemplatesExport(snippets, groups)).toEqual(expected);
  });

  it("取消保存对话框不调用写文件命令", async () => {
    calls.save.mockResolvedValue(null);
    expect(await exportPromptTemplates(snippets, groups)).toBeNull();
    expect(calls.exportPromptTemplates).not.toHaveBeenCalled();
  });

  it("保存失败向界面返回错误，不伪报成功", async () => {
    calls.exportPromptTemplates.mockRejectedValue(new Error("磁盘不可写"));
    await expect(exportPromptTemplates(snippets, groups)).rejects.toThrow("磁盘不可写");
  });
});
