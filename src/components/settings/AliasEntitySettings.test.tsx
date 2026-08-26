import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => false) }));

import { AliasEntitySettings } from "@/components/settings/AliasEntitySettings";
import { defaultSettings, type Settings } from "@/store/notesStore";

function settingsWith(patch: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), ...patch };
}

describe("AliasEntitySettings", () => {
  it("默认开启：展示词典空态、预演区与自动恢复开关", () => {
    const html = renderToStaticMarkup(
      <AliasEntitySettings settings={settingsWith()} patch={() => {}} />
    );
    expect(html).toContain("启用可逆化名");
    expect(html).toContain("实体词典");
    expect(html).toContain("暂无词典条目");
    expect(html).toContain("本地预演");
    expect(html).toContain("发出前化名 → 捕获回复时恢复");
    expect(html).toContain("不会发送、不会访问剪贴板");
    expect(html).toContain("捕获时自动恢复化名");
    expect(html).toContain("随本地数据文件加密保存");
  });

  it("列出词典条目：类别标签、原文与固定占位符，自定义类别用自定义显示名", () => {
    const html = renderToStaticMarkup(
      <AliasEntitySettings
        settings={settingsWith({
          aliasEntities: [
            {
              id: "u1",
              category: "USER",
              originalText: "张三",
              placeholder: "[USER_01]",
              createdAtMs: 1,
              updatedAtMs: 1,
            },
            {
              id: "v1",
              category: "VENDOR",
              originalText: "供应商甲",
              placeholder: "[VENDOR_01]",
              createdAtMs: 1,
              updatedAtMs: 1,
            },
          ],
          aliasCustomCategories: [{ code: "VENDOR", label: "供应商" }],
        })}
        patch={() => {}}
      />
    );
    expect(html).toContain("张三");
    expect(html).toContain("[USER_01]");
    expect(html).toContain("用户");
    expect(html).toContain("供应商");
    expect(html).toContain("[VENDOR_01]");
    expect(html).toContain("编辑原文");
    expect(html).toContain("删除条目");
  });

  it("总开关关闭时隐藏词典与预演区，仅保留开关行", () => {
    const html = renderToStaticMarkup(
      <AliasEntitySettings
        settings={settingsWith({ aliasEntitiesEnabled: false })}
        patch={() => {}}
      />
    );
    expect(html).toContain("启用可逆化名");
    expect(html).not.toContain("实体词典");
    expect(html).not.toContain("本地预演");
    expect(html).not.toContain("捕获时自动恢复化名");
  });
});
