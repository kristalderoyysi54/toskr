import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import settingsSource from "./SettingsView.tsx?raw";

import {
  ContextMenuPreview,
  FeaturesSection,
  GeneralSection,
  SettingsChildNavigation,
  SettingsNavigation,
} from "./SettingsView";
import { defaultSettings, normalizeContextMenu } from "@/store/notesStore";
import { normalizeSettingsSearchText } from "@/lib/settingsSearch";

describe("设置导航与层级", () => {
  it("侧栏只有七个目的，诊断深链仍选中帮助与更新", () => {
    const html = renderToStaticMarkup(
      <SettingsNavigation section="diagnostics" onSelect={vi.fn()} />
    );
    const active = html.match(/<button[^>]*aria-current="page"[\s\S]*?<\/button>/)?.[0];

    expect(html.match(/<button/g)).toHaveLength(7);
    expect(active).toContain("帮助与更新");
    expect(html).not.toContain("伴随停靠");
    expect(html).not.toContain("AI 智能");
  });

  it("更多功能子导航不显示禁用的消息与秘文，已启用后可直达", () => {
    const disabled = defaultSettings();
    const closed = renderToStaticMarkup(
      <SettingsChildNavigation section="features" settings={disabled} onSelect={vi.fn()} />
    );
    expect(closed).toContain("AI 智能");
    expect(closed).toContain("到期提醒");
    expect(closed).not.toContain("消息监听");
    expect(closed).not.toContain("秘文");

    const open = renderToStaticMarkup(
      <SettingsChildNavigation
        section="message-watch"
        settings={{ ...disabled, messagesEnabled: true, secretEnabled: true }}
        onSelect={vi.fn()}
      />
    );
    expect(open).toContain("消息监听");
    expect(open).toContain("秘文");
    expect(open.match(/<button[^>]*aria-current="page"[\s\S]*?<\/button>/)?.[0])
      .toContain("消息监听");
  });

  it("常用设置默认可见，细调和右键自定义默认收起", () => {
    const html = renderToStaticMarkup(
      <GeneralSection settings={defaultSettings()} patch={vi.fn()} />
    );
    expect(html).toContain("主题");
    expect(html).toContain("卡片密度");
    expect(html).toContain("面板置顶");
    expect(html).toContain("失焦自动隐藏");
    expect(html).toContain("更多外观与行为");
    expect(html).not.toContain("窗口整体不透明度");
    expect(html).not.toContain("提示显示时长");
    expect(html).not.toContain("卡片右键菜单");
    expect(html).not.toContain("新手导览");
  });

  it.each(["window-opacity", "vibrancy-style", "hud-duration", "context-menu"])(
    "搜索 %s 时实际展开细调区",
    (searchId) => {
      const html = renderToStaticMarkup(
        <GeneralSection settings={defaultSettings()} patch={vi.fn()} searchId={searchId} />
      );
      expect(html).toContain('aria-expanded="true"');
      expect(html).toContain("窗口整体不透明度");
      expect(html).toContain("提示显示时长");
      expect(html).toContain("卡片右键菜单");
    }
  );

  it("已挂载的外观细调区先展开提交，再执行搜索定位帧", () => {
    // 执行两个真实 effect：模拟浏览器先处理 RAF、后提交 passive effect
    // 触发的更新，覆盖首次渲染已经展开的 SSR 用例无法发现的时序缺口。
    const source = ts.createSourceFile(
      "SettingsView.tsx",
      settingsSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const effect = (component: string, marker: string) => {
      const declaration = source.statements.find((node) =>
        ts.isFunctionDeclaration(node) && node.name?.text === component
      );
      if (!declaration || !ts.isFunctionDeclaration(declaration)) throw new Error(component);
      const statement = declaration.body?.statements.find((node) =>
        ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
        ["useEffect", "useLayoutEffect"].includes(node.expression.expression.getText(source)) &&
        node.getText(source).includes(marker)
      );
      if (!statement) throw new Error(marker);
      return statement.getText(source);
    };
    const layout: Array<() => void> = [];
    const passive: Array<() => void> = [];
    const frames: Array<() => void> = [];
    let mounted = false;
    let pendingOpen = false;
    const target = {
      dataset: { settingsSearch: "窗口整体不透明度" } as Record<string, string>,
      scrollIntoView: vi.fn(),
      removeAttribute: vi.fn(),
    };
    const scrollTo = vi.fn();
    const effectCode = ts.transpileModule([
      effect("GeneralSection", "setDetailsOpen(true)"),
      effect("SettingsView", "const key = normalizeSettingsSearchText"),
    ].join("\n"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const runtime = {
      useEffect: (callback: () => void) => passive.push(callback),
      useLayoutEffect: (callback: () => void) => layout.push(callback),
      searchNeedsDetails: true,
      searchSequence: 1,
      setDetailsOpen: (open: boolean) => { pendingOpen = open; },
      section: "general",
      searchTarget: { value: "窗口整体不透明度", sequence: 1 },
      activeSearchHighlightRef: { current: null },
      mainRef: { current: { querySelectorAll: () => mounted ? [target] : [], scrollTo } },
      normalizeSettingsSearchText,
      window: {
        requestAnimationFrame: (callback: () => void) => { frames.push(callback); return 1; },
        setTimeout: () => 1,
      },
    };
    new Function(...Object.keys(runtime), effectCode)(...Object.values(runtime));
    for (const run of layout) run();
    mounted = pendingOpen; // layout 更新在浏览器取得下一帧前同步提交。
    for (const run of passive) run();
    for (const frame of frames) frame();
    mounted = pendingOpen; // passive 更新即使晚提交，也不能丢失本次定位。
    expect(mounted).toBe(true);
    expect(target.dataset.settingsSearchActive).toBe("true");
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("启用扩展功能后显示直接配置按钮", () => {
    const settings = defaultSettings();
    const closed = renderToStaticMarkup(
      <FeaturesSection settings={settings} patch={vi.fn()} onConfigure={vi.fn()} />
    );
    expect(closed).not.toContain("设置消息监听");
    const open = renderToStaticMarkup(
      <FeaturesSection
        settings={{ ...settings, messagesEnabled: true, secretEnabled: true, subscriptionsEnabled: true }}
        patch={vi.fn()}
        onConfigure={vi.fn()}
      />
    );
    expect(open).toContain("设置消息监听");
    expect(open).toContain("设置秘文");
    expect(open).toContain("设置订阅");
  });
});

describe("右键菜单设置预览", () => {
  const rowsOf = (html: string) =>
    [...html.matchAll(/<span class="min-w-0 flex-1 truncate">([^<]*)<\/span>/g)].map((m) => m[1]);

  it("默认配置：低频项关闭后，预览与方案 A 一级菜单一致", () => {
    const ids = normalizeContextMenu(undefined).filter((item) => item.on).map((item) => item.id);
    expect(rowsOf(renderToStaticMarkup(<ContextMenuPreview ids={ids} />))).toEqual([
      "发送到对话", "检查后发送", "用模板发送",
      "预览 / 打开链接", "复制内容", "编辑", "标记完成", "设为常用 / 固定",
      "整理", "转换与导出",
      "删除",
    ]);
  });

  it("某区全部关闭时预览里不出现该二级入口", () => {
    const html = renderToStaticMarkup(<ContextMenuPreview ids={["send", "copy"]} />);
    expect(rowsOf(html)).toEqual(["发送到对话", "复制内容", "删除"]);
  });
});
