import { describe, expect, it } from "vitest";

import { IconButton } from "./icon-button";

describe("IconButton ref contract", () => {
  it("is a React.forwardRef component for Radix asChild consumers", () => {
    expect(
      (IconButton as unknown as { $$typeof?: symbol }).$$typeof
    ).toBe(Symbol.for("react.forward_ref"));
  });
});
