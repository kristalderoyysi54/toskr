import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GlowingEffect } from "@/components/ui/glowing-effect";

describe("GlowingEffect", () => {
  it("无鼠标输入时默认显示右上与左下的固定双弧", () => {
    const html = renderToStaticMarkup(<GlowingEffect />);

    expect(html).not.toContain("--glow-opacity:0");
    expect(html).not.toContain("opacity:var(--glow-opacity)");
    expect(html).toContain("--twin:1");
    expect(html).toContain("rgb(255 255 255 / var(--twin))");
  });
});
