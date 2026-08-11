import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("privacy scanner architecture", () => {
  it("keeps the production Rust scanner free of network and process calls", () => {
    const path = fileURLToPath(
      new URL("../../src-tauri/src/privacy.rs", import.meta.url)
    );
    const production = readFileSync(path, "utf8").split("#[cfg(test)]")[0];
    expect(production).not.toMatch(
      /reqwest|TcpStream|UdpSocket|Command::new|std::process|curl/i
    );
  });

  it("keeps reversible mappings session-only and diagnostics free of raw values", () => {
    const controller = readFileSync(
      fileURLToPath(new URL("./delivery/firewallController.ts", import.meta.url)),
      "utf8"
    );
    const deliveryStore = readFileSync(
      fileURLToPath(new URL("../store/deliveryStore.ts", import.meta.url)),
      "utf8"
    );
    const executor = readFileSync(
      fileURLToPath(new URL("./delivery/executeDraft.ts", import.meta.url)),
      "utf8"
    );

    expect(deliveryStore).not.toMatch(/zustand\/middleware|persist\(/);
    expect(controller).not.toMatch(/diagNote|console\.|fetch\(|reqwest/i);
    expect(executor).toContain("text: draft.finalText");
    expect(executor).not.toMatch(/redactionMap[^\n]*(diag|tip|sendDelivery)/);
  });
});
