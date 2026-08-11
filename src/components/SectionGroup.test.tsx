import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SectionGroup } from "@/components/SectionGroup";

describe("SectionGroup", () => {
  it("分组头提供键盘可达的添加内容快捷入口", () => {
    const html = renderToStaticMarkup(
      <SectionGroup
        section={{ id: "ideas", name: "新功能记录" }}
        activeNotes={[]}
        doneNotes={[]}
        query=""
      />
    );

    expect(html).toContain('aria-label="在「新功能记录」中添加内容"');
    expect(html).toContain("lucide-plus");
    expect(html).toContain("group-hover:opacity-100");
  });
});
