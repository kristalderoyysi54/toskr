import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SimpleMenu } from "./SimpleMenu";

describe("SimpleMenu", () => {
  it("marks selection-dependent menus so outside pointer handling keeps the selection", () => {
    const html = renderToStaticMarkup(
      <SimpleMenu
        preserveTextSelection
        trigger={({ toggle }) => <button onClick={toggle}>处理</button>}
      >
        {() => null}
      </SimpleMenu>
    );

    expect(html).toContain('data-preserve-text-selection="true"');
  });
});
