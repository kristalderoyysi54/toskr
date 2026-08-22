import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("motion/react", async () => {
  const React = await import("react");
  return {
    motion: {
      span: React.forwardRef<
        HTMLSpanElement,
        React.ComponentProps<"span"> & { layoutId?: string; transition?: unknown }
      >(
        function StaticMotionSpan(
          { children, layoutId: _layoutId, transition: _transition, ...props },
          ref
        ) {
          return (
            <span ref={ref} {...props}>
              {children}
            </span>
          );
        }
      ),
    },
  };
});

import { SlidingTabIndicator } from "@/components/ui/sliding-tab-indicator";
import { springControl } from "@/lib/motion";

describe("SlidingTabIndicator", () => {
  it("共享一套无回弹控件 spring", () => {
    expect(springControl).toEqual({
      type: "spring",
      stiffness: 600,
      damping: 42,
      mass: 0.65,
    });
  });

  it("提供浮块与下划线两种统一选中态", () => {
    const thumb = renderToStaticMarkup(
      <SlidingTabIndicator layoutId="test-thumb" />
    );
    const underline = renderToStaticMarkup(
      <SlidingTabIndicator layoutId="test-line" variant="underline" />
    );

    expect(thumb).toContain("bg-segmented-thumb");
    expect(thumb).toContain('aria-hidden="true"');
    expect(underline).toContain("bottom-0");
    expect(underline).toContain("bg-foreground/85");
  });
});
