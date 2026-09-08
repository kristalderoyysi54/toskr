import { describe, expect, it } from "vitest";
import ts from "typescript";
import settingsSource from "./SettingsView.tsx?raw";
import {
  searchSettings,
  settingsSectionFromLink,
  targetSettingsPageForSearch,
  type SettingsSearchEntry,
  type SettingsSectionId,
} from "@/lib/settingsSearch";

const source = ts.createSourceFile("SettingsView.tsx", settingsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = (name: string) => {
  const node = source.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name);
  if (!node || !ts.isFunctionDeclaration(node) || !node.body) throw new Error(`缺少组件 ${name}`);
  return node.body;
};
const view = component("SettingsView");
const target = component("TargetSection");
const declaration = (name: string) => {
  const node = view.statements.find((item) => ts.isVariableStatement(item) && item.declarationList.declarations.some((item) => item.name.getText(source) === name));
  if (!node) throw new Error(`缺少导航处理函数 ${name}`);
  return node.getText(source);
};
let sectionListener: ts.Expression | undefined;
const findListener = (node: ts.Node) => {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "listen" && node.arguments[0]?.getText(source) === "SETTINGS_SECTION") {
    sectionListener = node.arguments[1];
  }
  ts.forEachChild(node, findListener);
};
findListener(view);
if (!sectionListener) throw new Error("缺少 SETTINGS_SECTION 监听器");

const navigationCode = ts.transpileModule([
  declaration("targetProfileRequestSequence"),
  declaration("clearSearch"),
  declaration("selectSearchResult"),
  declaration("selectSection"),
  `return { link: ${sectionListener.getText(source)}, clearSearch, selectSearchResult, selectSection };`,
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const pageEffectsCode = ts.transpileModule(
  target.statements.filter((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "useLayoutEffect")
    .map((node) => node.getText(source)).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;
const gates = { messagesEnabled: true, secretEnabled: true, subscriptionsEnabled: true };
type ProfileRequest = { profileId: string; sequence: number } | null;
type SearchTarget = { id: string; value: string; sequence: number } | null;
type StateUpdate<T> = T | ((previous: T) => T);

/** 执行源码里的事件处理函数与子页 effects，覆盖深链和跨页重新挂载。 */
function navigation() {
  const state = { section: "general" as SettingsSectionId, query: "旧搜索", search: null as SearchTarget, profile: null as ProfileRequest };
  const runtime = {
    useRef: <T>(current: T) => ({ current }),
    setSection: (next: SettingsSectionId) => { state.section = next; },
    setSearchQuery: (next: string) => { state.query = next; },
    setSearchTarget: (next: StateUpdate<SearchTarget>) => { state.search = typeof next === "function" ? next(state.search) : next; },
    setTargetProfileRequest: (next: StateUpdate<ProfileRequest>) => { state.profile = typeof next === "function" ? next(state.profile) : next; },
    currentSettingsRef: { current: gates },
    activeSearchHighlightRef: { current: null },
    settingsSectionFromLink,
  };
  const handlers = new Function(...Object.keys(runtime), navigationCode)(...Object.values(runtime)) as {
    link: (event: { payload: string | { section: string; targetProfileId?: string } }) => void;
    clearSearch: () => void;
    selectSearchResult: (entry: SettingsSearchEntry) => void;
    selectSection: (section: SettingsSectionId) => void;
  };
  const mountedPage = () => {
    let page = targetSettingsPageForSearch(state.search?.value ?? null);
    const effects: Array<() => void> = [];
    const runtime = {
      useLayoutEffect: (run: () => void) => effects.push(run),
      searchTarget: state.search?.value ?? null,
      searchSequence: state.search?.sequence ?? 0,
      targetProfileRequest: state.profile,
      targetSettingsPageForSearch,
      setPage: (next: typeof page) => { page = next; },
      setAliasesOpen: () => {},
    };
    new Function(...Object.keys(runtime), pageEffectsCode)(...Object.values(runtime));
    effects.forEach((run) => run());
    return page;
  };
  return { state, ...handlers, mountedPage };
}

describe("设置深链与搜索导航回归", () => {
  it.each(["snippets", "prompts"])("旧 %s 深链清理方案请求并打开模板子页", (section) => {
    const nav = navigation();
    nav.link({ payload: { section: "target", targetProfileId: "default-safe" } });
    nav.link({ payload: section });
    expect(nav.state.section).toBe("target");
    expect(nav.state.query).toBe("");
    expect(nav.state.profile).toBeNull();
    expect(nav.mountedPage()).toBe("templates");
  });

  it.each([
    ["提示词组", "templates"],
    ["隐私与化名", "privacy"],
    ["提示级类别", "privacy"],
  ])("旧方案请求不能覆盖新的 %s 搜索导航", (query, page) => {
    const nav = navigation();
    nav.link({ payload: { section: "target", targetProfileId: "default-safe" } });
    const result = searchSettings(query, gates)[0]!;
    nav.selectSearchResult(result);
    expect(nav.state.profile).toBeNull();
    expect(nav.state.section).toBe("target");
    expect(nav.mountedPage()).toBe(page);
  });

  it.each(["普通分区", "清空搜索", "搜索结果", "普通深链"])("%s 清理请求后，同方案再次深链仍产生递增序号", (clearBy) => {
    const nav = navigation();
    const request = () => nav.link({ payload: { section: "target", targetProfileId: "default-safe" } });
    request();
    const firstSequence = nav.state.profile!.sequence;
    if (clearBy === "普通分区") nav.selectSection("general");
    if (clearBy === "清空搜索") nav.clearSearch();
    if (clearBy === "搜索结果") nav.selectSearchResult(searchSettings("提示词组", gates)[0]!);
    if (clearBy === "普通深链") nav.link({ payload: "general" });
    expect(nav.state.profile).toBeNull();
    request();
    expect(nav.state.profile).toEqual({ profileId: "default-safe", sequence: firstSequence + 1 });
    expect(nav.mountedPage()).toBe("paste");
  });
});
