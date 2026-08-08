import { describe, expect, it } from "vitest";

import { buildBackupPayload } from "./backup";

describe("buildBackupPayload", () => {
  it("exports note and task groups together with their records", () => {
    const payload = buildBackupPayload({
      sections: [{ id: "inbox", name: "收件箱" }],
      notes: [],
      taskSections: [{ id: "task-inbox", name: "收集箱" }],
      tasks: [],
    });

    expect(Object.keys(payload).sort()).toEqual([
      "notes",
      "sections",
      "taskSections",
      "tasks",
    ]);
    expect(payload.taskSections).toEqual([
      { id: "task-inbox", name: "收集箱" },
    ]);
  });
});
