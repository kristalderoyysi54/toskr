import { describe, expect, it } from "vitest";

import {
  WELCOME_TOUR_COPY,
  welcomeTourExitEvent,
} from "@/lib/welcomeTour";

describe("新手导览", () => {
  it("用四屏先解释产品，再说明收集、粘贴和隐私", () => {
    expect(WELCOME_TOUR_COPY).toHaveLength(4);
    expect(WELCOME_TOUR_COPY.map((page) => page.title)).toEqual([
      "Mac 上的 AI 消息中转站",
      "从其他应用收集内容",
      "整理后粘贴到目标",
      "粘贴前检查隐私",
    ]);
    expect(WELCOME_TOUR_COPY[0]?.body).toContain("当前 AI 输入框");
    expect(WELCOME_TOUR_COPY[2]?.body).toContain("默认不按回车");
    expect(WELCOME_TOUR_COPY[3]?.body).toContain("原图不变");
    expect(WELCOME_TOUR_COPY[3]?.body).toContain("人脸和二维码不在检查范围");

    const copy = WELCOME_TOUR_COPY
      .map((page) => `${page.mini}${page.title}${page.body}`)
      .join(" ");
    expect(copy).not.toMatch(/消息监听|秘文|订阅|可逆化名/);
  });

  it("开始使用不改演练状态，只有示例按钮才启动", () => {
    expect(welcomeTourExitEvent("use-now")).toBeNull();
    expect(welcomeTourExitEvent("rehearse")).toEqual({ type: "start" });
  });
});
