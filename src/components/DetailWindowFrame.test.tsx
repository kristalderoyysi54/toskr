import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DetailWindowFrame } from "@/components/DetailWindowFrame";

describe("DetailWindowFrame", () => {
  it("只渲染完整圆角边框，不再展示连接尖角", () => {
    const html = renderToStaticMarkup(
      <DetailWindowFrame>
        <span>正文</span>
      </DetailWindowFrame>
    );

    expect(html).toContain('data-detail-window-frame="content"');
    expect(html).toContain("detail-window-frame__surface");
    expect(html).not.toContain("data-detail-frame-notch-side");
    expect(html).not.toContain("detail-window-frame__notch");
    expect(html).toContain("正文");
  });

  it("图片详情窗使用永暗 lightbox 边框语义", () => {
    const html = renderToStaticMarkup(
      <DetailWindowFrame tone="lightbox">图片</DetailWindowFrame>
    );

    expect(html).toContain('data-detail-window-frame="lightbox"');
    expect(html).not.toContain("--detail-frame-cap-image");
  });
});
