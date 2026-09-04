import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SendTargetAppItem } from "@/components/SendTargetAppItem";

vi.mock("@/lib/icons", () => ({
  useAppIcon: () => ({ url: "data:image/png;base64,aWNvbg==", color: "#123456" }),
}));

vi.mock("@/lib/viewportMedia", () => ({
  useNearViewport: () => true,
}));

describe("SendTargetAppItem", () => {
  it("发送目标行显示对应应用图标与名称", () => {
    const html = renderToStaticMarkup(
      <SendTargetAppItem
        target={{ pid: 7, name: "Google Chrome", bundleId: "com.google.Chrome" }}
        onSelect={vi.fn()}
      />
    );

    expect(html).toContain("Google Chrome 应用图标");
    expect(html).toContain("data:image/png;base64,aWNvbg==");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(">Google Chrome<");
  });
});
