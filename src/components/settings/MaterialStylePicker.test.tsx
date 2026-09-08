import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { VibrancyMaterial } from "@/store/notesStore";
import { MaterialStylePicker } from "./MaterialStylePicker";

describe("毛玻璃材质样片", () => {
  it.each([
    ["popover", "sidebar"],
    ["fullscreen", "hud"],
    ["liquid", "hud"],
    ["under-window", "under-window"],
  ] as const)("旧材质 %s 只映射选中态，不触发设置写回", (value, selected) => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      <MaterialStylePicker value={value} panelOpacity={0.62} cardOpacity={1} onChange={onChange} />
    );
    const inputs = html.match(/<input\b[^>]*>/g) ?? [];
    const checked = inputs.filter((input) => input.includes("checked="));
    expect(inputs).toHaveLength(3);
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain(`value="${selected}"`);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("三档用同一内容和用户当前透明度比较，不把样片换成预设透明度", () => {
    const html = renderToStaticMarkup(
      <MaterialStylePicker value="sidebar" panelOpacity={0.39} cardOpacity={0.7} onChange={vi.fn()} />
    );
    expect(html.match(/--panel-alpha:0.39;--card-alpha:70%/g)).toHaveLength(3);
    expect(html.match(/灵感片段/g)).toHaveLength(3);
    expect(html).toContain('data-settings-search="毛玻璃风格"');
    expect(html.match(/data-material="[^"]+"/g)).toEqual([
      'data-material="hud"',
      'data-material="sidebar"',
      'data-material="under-window"',
    ]);
  });

  it("每组原生单选共享名称，不同组件不会争用键盘选择组", () => {
    const picker = (value: VibrancyMaterial) => (
      <MaterialStylePicker value={value} panelOpacity={0.62} cardOpacity={1} onChange={vi.fn()} />
    );
    const html = renderToStaticMarkup(<>{picker("hud")}{picker("sidebar")}</>);
    const inputs = html.match(/<input\b[^>]*>/g) ?? [];
    const names = inputs.map((input) => input.match(/ name="([^"]+)"/)?.[1]);
    expect(inputs.every((input) => input.includes('type="radio"'))).toBe(true);
    expect(new Set(names.slice(0, 3)).size).toBe(1);
    expect(new Set(names.slice(3)).size).toBe(1);
    expect(names[0]).not.toEqual(names[3]);
  });
});
