import { describe, expect, it } from "vitest";

import { buildBackupPayload, buildMediaIntegrityPayload } from "./backup";
import { defaultSettings, STORE_VERSION } from "@/store/notesStore";

describe("buildBackupPayload", () => {
  it("exports note and task groups together with their records", () => {
    const payload = buildBackupPayload({
      sections: [{ id: "inbox", name: "收件箱" }],
      notes: [],
      taskSections: [{ id: "task-inbox", name: "收集箱" }],
      tasks: [],
      bills: [],
      messages: [],
      settings: {
        ...defaultSettings(),
        aiApiKey: "must-not-leak",
        dataDir: "/private",
      } as ReturnType<typeof defaultSettings>,
    });

    expect(payload.storeVersion).toBe(STORE_VERSION);
    expect(Object.keys(payload.state).sort()).toEqual([
      "bills",
      "messages",
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

  it("完整备份只携带结果来源元数据，不携带会话 redactionMap", () => {
    const payload = buildBackupPayload({
      sections: [{ id: "inbox", name: "收件箱" }],
      notes: [{
        id: "result-1",
        text: "结果正文",
        sectionId: "inbox",
        done: false,
        createdAt: 2,
        provenance: {
          kind: "deliveryResult",
          deliveryId: "delivery-1",
          capturedAtMs: 2,
          sourceBundle: "com.openai.chat",
          sourceItemIds: ["source-1"],
        },
      }],
      taskSections: [{ id: "task-inbox", name: "收集箱" }],
      tasks: [],
      bills: [],
      messages: [],
      settings: defaultSettings(),
    });

    expect(payload.state.notes[0].provenance).toMatchObject({
      deliveryId: "delivery-1",
      sourceItemIds: ["source-1"],
    });
    expect(JSON.stringify(payload)).not.toContain("redactionMap");
  });

  it("完整备份保留目标方案的 Markdown 默认模式", () => {
    const settings = defaultSettings();
    const profileId = settings.defaultTargetProfileId;
    const payload = buildBackupPayload({
      sections: [],
      notes: [],
      taskSections: [],
      tasks: [],
      bills: [],
      messages: [],
      settings: {
        ...settings,
        targetProfiles: settings.targetProfiles.map((profile) =>
          profile.id === profileId
            ? {
                ...profile,
                defaultFormat: "plain",
                defaultMarkdownMode: "strip",
              }
            : profile
        ),
      },
    });

    expect(
      payload.state.settings.targetProfiles.find(
        (profile) => profile.id === profileId
      )
    ).toMatchObject({
      defaultFormat: "plain",
      defaultMarkdownMode: "strip",
    });
  });
});

describe("buildMediaIntegrityPayload", () => {
  it("把未保存编辑草稿图片作为运行态活动引用交给媒体 GC", () => {
    const payload = buildMediaIntegrityPayload(
      {
        sections: [],
        notes: [],
        taskSections: [],
        tasks: [],
        bills: [],
        messages: [],
        settings: defaultSettings(),
        undoStack: [],
      },
      ["clip.png", "clip.png"]
    );

    expect(payload.state.editorDrafts).toEqual([
      { attachments: ["clip.png"] },
    ]);
  });
});
