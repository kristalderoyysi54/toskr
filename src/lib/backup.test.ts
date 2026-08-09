import { describe, expect, it } from "vitest";

import { buildBackupPayload } from "./backup";
import { defaultSettings, STORE_VERSION } from "@/store/notesStore";

describe("buildBackupPayload", () => {
  it("exports note and task groups together with their records", () => {
    const payload = buildBackupPayload({
      sections: [{ id: "inbox", name: "收件箱" }],
      notes: [],
      taskSections: [{ id: "task-inbox", name: "收集箱" }],
      tasks: [],
      settings: { ...defaultSettings(), aiApiKey: "must-not-leak", dataDir: "/private" },
    });

    expect(payload.storeVersion).toBe(STORE_VERSION);
    expect(Object.keys(payload.state).sort()).toEqual([
      "notes",
      "sections",
      "settings",
      "taskSections",
      "tasks",
    ]);
    expect(payload.state.taskSections).toEqual([
      { id: "task-inbox", name: "收集箱" },
    ]);
    expect(payload.state.settings).not.toHaveProperty("aiApiKey");
    expect(payload.state.settings).not.toHaveProperty("dataDir");
  });
});
