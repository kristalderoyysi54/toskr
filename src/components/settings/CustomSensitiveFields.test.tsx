import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CustomSensitiveFields } from "./CustomSensitiveFields";
import { defaultSettings, decodePersistedState, STORE_VERSION } from "@/store/notesStore";
import { searchSettings, targetSettingsPageForSearch } from "@/lib/settingsSearch";

describe("敏感字段设置", () => {
  it("说明只输入字段名，展示删除入口与关闭状态", () => {
    const html = renderToStaticMarkup(<CustomSensitiveFields fields={["内部口令"]} onChange={vi.fn()} enabled={false} />);
    expect(html).toContain("不需要填写真实密钥");
    expect(html).toContain('aria-label="删除敏感字段 内部口令"');
    expect(html).toContain("隐私检查已关闭");
  });
  it("旧设置默认无自定义字段，新字段可持久化往返且拒绝重复", () => {
    const parse = (settings: unknown) => decodePersistedState(JSON.stringify({version:STORE_VERSION,state:{settings,notes:[],tasks:[],sections:[],taskSections:[]}}));
    const legacy = {...defaultSettings()} as Record<string, unknown>;
    delete legacy.firewallCustomSensitiveFields;
    expect(parse(legacy).settings.firewallCustomSensitiveFields).toEqual([]);
    expect(parse({...legacy,firewallCustomSensitiveFields:["内部口令"]}).settings.firewallCustomSensitiveFields).toEqual(["内部口令"]);
    expect(() => parse({...legacy,firewallCustomSensitiveFields:["KEY", "key"]})).toThrow();
  });
  it("设置搜索直达隐私子页的字段入口", () => {
    const match = searchSettings("自定义敏感字段", {messagesEnabled:true,secretEnabled:true,subscriptionsEnabled:true}).find((entry) => entry.id === "firewall-custom-fields");
    expect(match).toBeDefined();
    expect(targetSettingsPageForSearch(match!.title)).toBe("privacy");
  });
});
