import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function source(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("AI secret and transport architecture", () => {
  it("uses in-process HTTP and never exposes key through command args or diagnostics", () => {
    const rust = source("../../src-tauri/src/ai.rs").split("#[cfg(test)]")[0];
    expect(rust).toContain("reqwest::Client");
    expect(rust).toContain("bearer_auth(key)");
    expect(rust).not.toMatch(/std::process|Command::new|\.args\(|diag::|curl/i);
    expect(rust).not.toMatch(/format!\([^\n]*key|map_err\([^\n]*key/);
  });

  it("keeps the key out of Settings, AI request IPC and settings-window broadcasts", () => {
    const store = source("../store/notesStore.ts");
    const tauri = source("./tauri.ts");
    const sync = source("./settingsSync.ts");
    expect(store).not.toMatch(/aiApiKey:\s*string/);
    expect(tauri).toContain('invoke<string>("ai_chat", { baseUrl, model, system, user, maxTokens })');
    expect(tauri).not.toMatch(/aiChat:[\s\S]{0,250}apiKey/);
    expect(sync).toContain("withoutLegacyAiApiKey(useNotesStore.getState().settings)");
  });

  it("clears legacy JSON only inside the current writable data generation", () => {
    const app = source("../App.tsx");
    expect(app).toContain("matchesDataGeneration(generation)");
    expect(app).toContain("isDataOperationLocked()");
    expect(app).toContain("legacyAiApiKey(current) !== legacyKey");
    expect(app).toContain("SETTINGS_AI_KEY_CHANGED");
  });

  it("only returns boolean/timestamp key status to WebViews", () => {
    const rust = source("../../src-tauri/src/ai.rs").split("#[cfg(test)]")[0];
    const status = rust.slice(
      rust.indexOf("pub struct AiKeyStatus"),
      rust.indexOf("struct StoredAiKey")
    );
    expect(status).toContain("configured: bool");
    expect(status).toContain("updated_at_ms: Option<u64>");
    expect(status).not.toMatch(/key:\s*String/);
  });

  it("routes every frontend AI call through the shared client", () => {
    const client = source("./aiClient.ts");
    const legacy = source("./ai.ts");
    const transform = source("./aiTransform.ts");
    expect(client).toContain("api.aiChat(");
    expect(legacy).not.toContain("api.aiChat(");
    expect(transform).not.toContain("api.aiChat(");
  });
});
