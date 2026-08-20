import { beforeEach, describe, expect, it, vi } from "vitest";

// 单测环境没有 Tauri runtime，把持久化后端替换为内存实现
vi.mock("./persistStorage", () => {
  const memory = new Map<string, string>();
  return {
    tauriStateStorage: {
      getItem: async (name: string) => memory.get(name) ?? null,
      setItem: async (name: string, value: string) => {
        memory.set(name, value);
      },
      removeItem: async (name: string) => {
        memory.delete(name);
      },
    },
  };
});

import {
  CLIPBOARD_ID,
  CONTEXT_MENU_REGISTRY,
  decodePersistedState,
  defaultSettings,
  doneIdsAfterSend,
  groupContextMenuIds,
  HUD_DURATION_DEFAULT_MS,
  INBOX_ID,
  mergePersistedNotesState,
  NOTE_TAG_MAX_COUNT,
  noteContentBlocks,
  orderedCheckedNotes,
  replaceNotesStoreFromPersisted,
  sanitizeNoteTags,
  SECRET_ID,
  STORE_VERSION,
  TASK_INBOX_ID,
  useNotesStore,
} from "./notesStore";
import {
  GENERAL_PROMPT_GROUP_ID,
  SAFETY_PROFILE_ID,
} from "@/lib/targetProfiles";

function reset() {
  useNotesStore.setState({
    sections: [{ id: INBOX_ID, name: "收件箱" }],
    notes: [],
    tasks: [],
    taskSections: [{ id: TASK_INBOX_ID, name: "收集箱" }],
    bills: [],
    messages: [],
    checkedIds: [],
    settings: defaultSettings(),
    undoStack: [],
  });
}

describe("notesStore 基础", () => {
  beforeEach(reset);

  it("右键菜单按语义完整分组，并保留每组内的用户顺序", () => {
    const allIds = CONTEXT_MENU_REGISTRY.map((item) => item.id);
    const groupedIds = groupContextMenuIds(allIds).flatMap((group) => group.ids);

    expect(new Set(groupedIds)).toEqual(new Set(allIds));
    expect(groupedIds).toHaveLength(allIds.length);

    const custom = groupContextMenuIds([
      "move",
      "preview",
      "copy",
      "edit",
      "keep",
      "send",
      "textops",
    ]);
    expect(custom.map((group) => [group.id, group.ids])).toEqual([
      ["view", ["preview", "edit"]],
      ["content", ["copy", "textops"]],
      ["send", ["send"]],
      ["organize", ["move", "keep"]],
    ]);
    expect(groupContextMenuIds(["move"]).map((group) => group.id)).toEqual([
      "view",
      "content",
      "send",
      "organize",
    ]);
  });

  it("v12 迁移到最新版时正文不变、生成权威块，并补齐本地成效设置", () => {
    expect(STORE_VERSION).toBe(21);
    const decoded = decodePersistedState(JSON.stringify({
      version: 12,
      state: {
        sections: [{ id: INBOX_ID, name: "收件箱" }],
        notes: [{ id: "legacy", text: "旧结果", sectionId: INBOX_ID, done: false, createdAt: 1 }],
      },
    }));
    expect(decoded.notes[0]).toMatchObject({ id: "legacy", text: "旧结果" });
    expect(decoded.notes[0].contentBlocks).toEqual([
      { type: "text", text: "旧结果" },
    ]);
    expect(decoded.notes[0].provenance).toBeUndefined();
    expect(decoded.settings).toMatchObject({
      outcomeMetricsEnabled: true,
      outcomeRetentionDays: 30,
      outcomeMetricsEpoch: 0,
      outcomeBaselines: [],
      outcomeProblemSessions: [],
    });
  });

  it("v21 将消息来源从旧品牌标识迁移为中性 im，并重写复合 id（旧数据零残留）", () => {
    const decoded = decodePersistedState(JSON.stringify({
      version: 20,
      state: {
        sections: [{ id: INBOX_ID, name: "收件箱" }],
        notes: [],
        messages: [{
          id: JSON.stringify(["tuitui", "g1", "m1"]),
          source: "tuitui",
          sourceApp: "旧应用",
          sourceBundle: "com.example.old",
          conversationId: "g1",
          messageId: "m1",
          conversationName: "项目群",
          senderUid: "u1",
          senderName: "张三",
          occurredAtMs: 1,
          receivedAtMs: 2,
          mentionedSelf: true,
          followedSender: false,
          matchedRuleIds: [],
          isGroup: true,
          messageType: "text",
          text: "正文",
          context: [],
          status: "new",
        }],
        settings: defaultSettings(),
      },
    }));
    expect(decoded.messages).toHaveLength(1);
    expect(decoded.messages[0].source).toBe("im");
    expect(decoded.messages[0].id).toBe(JSON.stringify(["im", "g1", "m1"]));
    // 显示用的来源元数据属用户数据，原样保留
    expect(decoded.messages[0].sourceApp).toBe("旧应用");
    expect(decoded.messages[0].text).toBe("正文");
  });

  it("v14 迁移到 v17 补齐可逆化名默认值，不改动既有设置", () => {
    const {
      aliasEntitiesEnabled: _enabled,
      aliasEntities: _entities,
      aliasCustomCategories: _categories,
      aliasNextNumberByCategory: _counters,
      aliasAutoRestoreOnCapture: _autoRestore,
      ...legacySettings
    } = defaultSettings();
    const decoded = decodePersistedState(JSON.stringify({
      version: 14,
      state: {
        sections: [{ id: INBOX_ID, name: "收件箱" }],
        notes: [],
        tasks: [],
        taskSections: [],
        settings: { ...legacySettings, stealth: true },
      },
    }));
    expect(decoded.settings).toMatchObject({
      stealth: true,
      aliasEntitiesEnabled: true,
      aliasEntities: [],
      aliasCustomCategories: [],
      aliasNextNumberByCategory: {},
      aliasAutoRestoreOnCapture: true,
    });
  });

  it("v17 迁移到 v18 补齐秘文默认值（默认关闭）且页序追加秘文页", () => {
    const {
      secretEnabled: _secretEnabled,
      secretKeys: _secretKeys,
      secretDefaultKeyId: _secretDefaultKeyId,
      secretRevealTimeoutMs: _secretRevealTimeoutMs,
      ...legacySettings
    } = defaultSettings();
    const decoded = decodePersistedState(JSON.stringify({
      version: 17,
      state: {
        sections: [{ id: INBOX_ID, name: "收件箱" }],
        notes: [],
        tasks: [],
        taskSections: [],
        settings: {
          ...legacySettings,
          stealth: true,
          pageOrder: ["clipboard", "notes", "tasks"],
        },
      },
    }));
    expect(decoded.settings).toMatchObject({
      stealth: true,
      secretEnabled: false,
      secretKeys: [],
      secretDefaultKeyId: null,
      secretRevealTimeoutMs: 8000,
    });
    // 旧页序缺秘文页，normalizePageOrder 应把它补进来
    expect(decoded.settings.pageOrder).toContain("secret");
  });

  it("v18 迁移到 v19 补齐账单域：bills 空数组 + 货币符号/默认提醒档", () => {
    const {
      currencySymbol: _currency,
      billDefaultReminderOffsets: _offsets,
      ...legacySettings
    } = defaultSettings();
    const decoded = decodePersistedState(JSON.stringify({
      version: 18,
      state: {
        sections: [{ id: INBOX_ID, name: "收件箱" }],
        notes: [],
        tasks: [],
        taskSections: [],
        settings: { ...legacySettings, stealth: true },
      },
    }));
    expect(decoded.bills).toEqual([]);
    expect(decoded.settings).toMatchObject({
      stealth: true,
      currencySymbol: "¥",
      billDefaultReminderOffsets: [3, 1],
    });
  });

  it("秘文卡：addSecretNote 建组入库；历史键 secret 迁移为 secretMeta 且不再落盘", () => {
    useNotesStore.setState({
      sections: [{ id: INBOX_ID, name: "收件箱" }],
      notes: [],
      settings: defaultSettings(),
      undoStack: [],
    });
    const { result, id } = useNotesStore
      .getState()
      .addSecretNote("「话说密文信封」", { keyId: "k1", keyLabel: "同事", direction: "in" });
    expect(result).toBe("added");
    const note = useNotesStore.getState().notes.find((n) => n.id === id)!;
    expect(note.kind).toBe("secret");
    expect(note.sectionId).toBe("secret");
    expect(note.secretMeta).toEqual({ keyId: "k1", keyLabel: "同事", direction: "in" });
    // 同信封重复 → duplicate
    expect(
      useNotesStore.getState().addSecretNote("「话说密文信封」", { keyId: "k1", direction: "in" }).result
    ).toBe("duplicate");

    // 历史键名 secret 的旧数据经归一后迁到 secretMeta，且裸 secret 键被剥除（不触发备份黑名单）
    const decoded = decodePersistedState(JSON.stringify({
      version: STORE_VERSION,
      state: {
        sections: [{ id: INBOX_ID, name: "收件箱" }, { id: "secret", name: "秘文" }],
        notes: [
          {
            id: "legacy-secret",
            text: "「话说旧密文」",
            kind: "secret",
            sectionId: "secret",
            done: false,
            createdAt: 1,
            secret: { keyId: "old", keyLabel: "旧钥", direction: "out" },
          },
        ],
      },
    }));
    const migrated = decoded.notes.find((n) => n.id === "legacy-secret")!;
    expect(migrated.secretMeta).toEqual({ keyId: "old", keyLabel: "旧钥", direction: "out" });
    expect(JSON.stringify(migrated)).not.toContain('"secret":{');
  });

  it("首装面板默认态仅留给新档案，v16 旧档案迁移后不触发", () => {
    expect(defaultSettings()).toMatchObject({
      initialPanelSetupDone: false,
      companionEnabled: false,
    });

    const {
      initialPanelSetupDone: _initialPanelSetupDone,
      ...v16Settings
    } = defaultSettings();
    const migrated = decodePersistedState(JSON.stringify({
      version: 16,
      state: {
        settings: { ...v16Settings, companionEnabled: false },
      },
    }));
    expect(migrated.settings).toMatchObject({
      initialPanelSetupDone: true,
      companionEnabled: false,
    });

    const legacyWithoutSettings = decodePersistedState(JSON.stringify({
      version: 16,
      state: {},
    }));
    expect(legacyWithoutSettings.settings.initialPanelSetupDone).toBe(true);

    expect(() => decodePersistedState(JSON.stringify({
      version: STORE_VERSION,
      state: { settings: { initialPanelSetupDone: "yes" } },
    }))).toThrow("settings.initialPanelSetupDone 类型无效");
  });

  it("v15 只从当时权威旧字段建块，不采信同名未知字段", () => {
    const decoded = decodePersistedState(JSON.stringify({
      version: 15,
      state: {
        sections: [{ id: INBOX_ID, name: "收件箱" }],
        notes: [{
          id: "legacy-rich-name",
          text: "旧正文",
          imageFile: "old.png",
          contentBlocks: [{ type: "text", text: "不应采信" }],
          sectionId: INBOX_ID,
          done: false,
          createdAt: 1,
        }],
      },
    }));

    expect(decoded.notes[0].contentBlocks).toEqual([
      { type: "text", text: "旧正文" },
      { type: "image", file: "old.png" },
    ]);
  });

  it("v16 只信权威块并覆盖漂移兼容投影，损坏块 fail-closed", () => {
    const state = {
      sections: [{ id: INBOX_ID, name: "收件箱" }],
      notes: [{
        id: "rich",
        text: "过期正文",
        imageFile: "stale.png",
        contentBlocks: [
          { type: "text", text: "第一段" },
          { type: "image", file: "real.png", width: 20, height: 10 },
          { type: "text", text: "第二段" },
        ],
        sectionId: INBOX_ID,
        done: false,
        createdAt: 1,
      }],
    };
    const decoded = decodePersistedState(JSON.stringify({ version: 16, state }));
    expect(decoded.notes[0]).toMatchObject({
      text: "第一段\n第二段",
      imageFile: "real.png",
      imageW: 20,
      imageH: 10,
    });

    const invalid = structuredClone(state);
    invalid.notes[0].contentBlocks[1] = { type: "image", file: "" } as never;
    expect(() =>
      decodePersistedState(JSON.stringify({ version: 16, state: invalid }))
    ).toThrow("contentBlocks.image.file");
  });

  it("提示显示时长缺省回填 3 秒，并拒绝越界或小数设置", () => {
    const decodeDuration = (settings: object) =>
      decodePersistedState(JSON.stringify({
        version: STORE_VERSION,
        state: { settings },
      })).settings;

    expect(defaultSettings().hudDurationMs).toBe(HUD_DURATION_DEFAULT_MS);
    expect(decodeDuration({}).hudDurationMs).toBe(HUD_DURATION_DEFAULT_MS);
    expect(decodeDuration({ hudDurationMs: 5_000 }).hudDurationMs).toBe(5_000);
    for (const hudDurationMs of [1_999, 10_001, 2_500.5]) {
      expect(() => decodeDuration({ hudDurationMs })).toThrow(
        "settings.hudDurationMs 超出允许范围"
      );
    }
  });

  it("v15 拒绝损坏的化名词典与计数器", () => {
    const decodeAlias = (patch: object) => () =>
      decodePersistedState(JSON.stringify({
        version: 15,
        state: {
          sections: [{ id: INBOX_ID, name: "收件箱" }],
          notes: [],
          tasks: [],
          taskSections: [],
          settings: { ...defaultSettings(), ...patch },
        },
      }));
    const entity = {
      id: "alias-1",
      category: "USER",
      originalText: "张三",
      placeholder: "[USER_01]",
      createdAtMs: 1,
      updatedAtMs: 1,
    };

    expect(decodeAlias({ aliasEntities: [entity] })).not.toThrow();
    // 占位符编号不足两位
    expect(
      decodeAlias({ aliasEntities: [{ ...entity, placeholder: "[USER_1]" }] })
    ).toThrow();
    // 不同 id 但原文重复
    expect(
      decodeAlias({
        aliasEntities: [entity, { ...entity, id: "alias-2", placeholder: "[USER_02]" }],
      })
    ).toThrow();
    // 自定义类别命中保留字
    expect(
      decodeAlias({ aliasCustomCategories: [{ code: "EMAIL", label: "邮箱" }] })
    ).toThrow();
    // 计数器出现零值
    expect(decodeAlias({ aliasNextNumberByCategory: { USER: 0 } })).toThrow();
  });

  it("剪贴卡模板：仅保留标准与浓缩，旧单行迁入浓缩", () => {
    const decodeTemplate = (settings: object) =>
      decodePersistedState(JSON.stringify({
        version: STORE_VERSION,
        state: {
          sections: [{ id: INBOX_ID, name: "收件箱" }],
          notes: [],
          tasks: [],
          taskSections: [],
          settings,
        },
      }));

    expect(
      decodeTemplate({ ...defaultSettings(), clipCardTemplate: "standard" }).settings
        .clipCardTemplate
    ).toBe("standard");
    expect(
      decodeTemplate({ ...defaultSettings(), clipCardTemplate: "condensed" }).settings
        .clipCardTemplate
    ).toBe("condensed");
    expect(
      decodeTemplate({ ...defaultSettings(), clipCardTemplate: "banner" }).settings
        .clipCardTemplate
    ).toBe("condensed");
    // 旧备份没有该字段：合并默认值
    const { clipCardTemplate: _tpl, ...legacy } = defaultSettings();
    expect(decodeTemplate(legacy).settings.clipCardTemplate).toBe("standard");
    expect(() =>
      decodeTemplate({ ...defaultSettings(), clipCardTemplate: "huge" })
    ).toThrow(/枚举无效/);
  });

  it("v13 上手状态迁入可恢复演练，已完成旧用户不会被强制重做", () => {
    const decodeOnboarding = (onboarding: object) =>
      decodePersistedState(JSON.stringify({
        version: 13,
        state: {
          sections: [{ id: INBOX_ID, name: "收件箱" }],
          notes: [],
          tasks: [],
          taskSections: [],
          settings: { ...defaultSettings(), onboarding },
        },
      })).settings.onboarding;

    expect(decodeOnboarding({ captured: true, sent: true, done: true }))
      .toMatchObject({
        onboardingVersion: 2,
        rehearsalStep: "complete",
        rehearsalActive: false,
        done: true,
      });
    expect(decodeOnboarding({ captured: true, sent: false, done: false }))
      .toMatchObject({
        onboardingVersion: 2,
        rehearsalStep: "permissions",
        rehearsalActive: true,
        done: false,
      });
  });

  it("v14 拒绝未来演练版本与损坏步骤", () => {
    const decodeOnboarding = (onboarding: object) => () =>
      decodePersistedState(JSON.stringify({
        version: 14,
        state: {
          settings: { ...defaultSettings(), onboarding },
        },
      }));

    expect(decodeOnboarding({
      ...defaultSettings().onboarding,
      onboardingVersion: 3,
    })).toThrow("settings.onboarding 字段无效");
    expect(decodeOnboarding({
      ...defaultSettings().onboarding,
      rehearsalStep: "unknown",
    })).toThrow("settings.onboarding 字段无效");
  });

  it("v13 拒绝损坏的成效设置，并保留合法本机元数据", () => {
    const state = {
      settings: {
        ...defaultSettings(),
        outcomeRetentionDays: 90,
        outcomeBaselines: [{ scope: "profile", scopeId: "safe", minutes: 20 }],
        outcomeProblemSessions: [{
          id: "session-1",
          startedAtMs: 1,
          deliveryId: "delivery-1",
          resultNoteId: "result-1",
          linkedAtMs: 2,
          solvedAtMs: 3,
          cancelledAtMs: null,
        }],
      },
    };
    const decoded = decodePersistedState(JSON.stringify({ version: 13, state }));
    expect(decoded.settings.outcomeRetentionDays).toBe(90);
    expect(decoded.settings.outcomeBaselines).toHaveLength(1);
    expect(decoded.settings.outcomeProblemSessions).toHaveLength(1);

    const invalid = structuredClone(state);
    invalid.settings.outcomeProblemSessions[0].solvedAtMs = 0;
    expect(() => decodePersistedState(JSON.stringify({ version: 13, state: invalid })))
      .toThrow("settings.outcomeProblemSessions 字段无效");
  });

  it("v13 成效数组兼容缺失新字段、未知字段与重复项，并稳定保留最后值", () => {
    const decoded = decodePersistedState(JSON.stringify({
      version: 13,
      state: {
        settings: {
          ...defaultSettings(),
          outcomeBaselines: [
            { scope: "profile", scopeId: "safe", minutes: 10 },
            { scope: "profile", scopeId: "safe", minutes: 15, futureField: "kept" },
          ],
          outcomeProblemSessions: [
            {
              id: "s", startedAtMs: 1, deliveryId: "d", linkedAtMs: 2,
              solvedAtMs: null, cancelledAtMs: null,
            },
            {
              id: "s", startedAtMs: 1, deliveryId: "d", resultNoteId: "r",
              linkedAtMs: 2, solvedAtMs: 3, cancelledAtMs: null,
            },
          ],
        },
      },
    }));

    expect(decoded.settings.outcomeBaselines).toEqual([expect.objectContaining({
      scopeId: "safe",
      minutes: 15,
      futureField: "kept",
    })]);
    expect(decoded.settings.outcomeProblemSessions).toMatchObject([{
      id: "s",
      resultNoteId: "r",
      solvedAtMs: 3,
    }]);
  });

  it("清除成效用户数据只清计时，不改卡片、任务或人工基线", () => {
    const noteId = useNotesStore.getState().addNote("业务卡片").id!;
    const taskId = useNotesStore.getState().addTask("业务任务").id!;
    useNotesStore.getState().setSettings({
      outcomeBaselines: [{ scope: "profile", scopeId: "safe", minutes: 20 }],
      outcomeProblemSessions: [{
        id: "s",
        startedAtMs: 1,
        deliveryId: null,
        resultNoteId: null,
        linkedAtMs: null,
        solvedAtMs: null,
        cancelledAtMs: null,
      }],
    });

    useNotesStore.getState().setSettings({
      outcomeMetricsEpoch: 1,
      outcomeProblemSessions: [],
    });

    const state = useNotesStore.getState();
    expect(state.notes.find((note) => note.id === noteId)?.text).toBe("业务卡片");
    expect(state.tasks.find((task) => task.id === taskId)?.text).toBe("业务任务");
    expect(state.settings.outcomeBaselines).toHaveLength(1);
    expect(state.settings.outcomeMetricsEpoch).toBe(1);
    expect(state.settings.outcomeProblemSessions).toEqual([]);
  });

  it("link、relink、unlink 只更新单一 provenance，不删除 Note", () => {
    const added = useNotesStore.getState().addNote("结果");
    const first = {
      kind: "deliveryResult" as const,
      deliveryId: "delivery-a",
      capturedAtMs: 10,
      sourceBundle: "com.a",
      sourceItemIds: ["source-a"],
    };
    const second = { ...first, deliveryId: "delivery-b" };
    expect(useNotesStore.getState().setNoteProvenance(added.id!, first)).toBe(true);
    expect(useNotesStore.getState().notes[0].provenance?.deliveryId).toBe("delivery-a");
    expect(useNotesStore.getState().setNoteProvenance(added.id!, second)).toBe(true);
    expect(useNotesStore.getState().notes[0].provenance?.deliveryId).toBe("delivery-b");
    expect(useNotesStore.getState().setNoteProvenance(added.id!, undefined)).toBe(true);
    expect(useNotesStore.getState().notes[0]).toMatchObject({ id: added.id, text: "结果" });
    expect(useNotesStore.getState().notes[0].provenance).toBeUndefined();
  });

  it("v12 provenance 去重来源 ID、容忍 Note 未知字段并拒绝缺失必填项", () => {
    const base = {
      sections: [{ id: INBOX_ID, name: "收件箱" }],
      notes: [{
        id: "result",
        text: "结果",
        sectionId: INBOX_ID,
        done: false,
        createdAt: 1,
        futureField: "kept",
        provenance: {
          kind: "deliveryResult",
          deliveryId: "delivery-1",
          capturedAtMs: 1,
          sourceBundle: "com.openai.chat",
          sourceItemIds: ["source-1", "source-1"],
        },
      }],
    };
    const decoded = decodePersistedState(JSON.stringify({ version: 12, state: base }));
    expect(decoded.notes[0].provenance?.sourceItemIds).toEqual(["source-1"]);
    expect(decoded.notes[0]).toHaveProperty("futureField", "kept");

    const invalid = structuredClone(base);
    delete (invalid.notes[0].provenance as Partial<typeof base.notes[0]["provenance"]>).sourceBundle;
    expect(() => decodePersistedState(JSON.stringify({ version: 12, state: invalid })))
      .toThrow("note.provenance 字段无效");
  });

  it("由 Native status bootstrap 显式水合，模块加载不自动读取待续目标", () => {
    expect(useNotesStore.persist.getOptions().skipHydration).toBe(true);
  });

  it("水合前捕获的新卡片 merge 后保持在列表顶部而不是沉底", () => {
    useNotesStore.getState().addNote("早期捕获");
    const current = useNotesStore.getState();
    const merged = mergePersistedNotesState(
      {
        notes: [
          { id: "disk-new", text: "磁盘较新", createdAt: 2 },
          { id: "disk-old", text: "磁盘较旧", createdAt: 1 },
        ],
      },
      current
    );
    expect(merged.notes.map((n) => n.text)).toEqual([
      "早期捕获",
      "磁盘较新",
      "磁盘较旧",
    ]);
  });

  it("addNote 去除首尾空白并落入收件箱", () => {
    const { result } = useNotesStore.getState().addNote("  hello  ");
    expect(result).toBe("added");
    const notes = useNotesStore.getState().notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe("hello");
    expect(notes[0].sectionId).toBe(INBOX_ID);
  });

  it("addNote 以有序富块为权威并确定性同步兼容投影", () => {
    const blocks = [
      { type: "text" as const, text: "路径：审批管理" },
      { type: "image" as const, file: "a.png", alt: "注册页", width: 800, height: 600 },
      { type: "text" as const, text: "一、商户类型" },
      { type: "image" as const, file: "b.png" },
    ];
    const added = useNotesStore.getState().addNote("调用方旧文本会被忽略", {
      contentBlocks: blocks,
    });
    const note = useNotesStore.getState().notes.find((item) => item.id === added.id)!;

    expect(noteContentBlocks(note)).toEqual(blocks);
    expect(note).toMatchObject({
      text: "路径：审批管理\n一、商户类型",
      imageFile: "a.png",
      attachments: ["b.png"],
      imageW: 800,
      imageH: 600,
      kind: "text",
    });
  });

  it("updateNoteContent 原子同步块与旧投影，updateNoteText 也不产生漂移", () => {
    const id = useNotesStore.getState().addNote("旧正文").id!;
    useNotesStore.getState().updateNoteContent(id, [
      { type: "text", text: "前文" },
      { type: "image", file: "one.png" },
      { type: "text", text: "后文" },
      { type: "image", file: "two.png" },
    ]);
    let note = useNotesStore.getState().notes.find((item) => item.id === id)!;
    expect(note.text).toBe("前文\n后文");
    expect(note.imageFile).toBe("one.png");
    expect(note.attachments).toEqual(["two.png"]);

    useNotesStore.getState().updateNoteText(id, "统一编辑后的正文");
    note = useNotesStore.getState().notes.find((item) => item.id === id)!;
    expect(noteContentBlocks(note)).toEqual([
      { type: "text", text: "统一编辑后的正文" },
      { type: "image", file: "one.png" },
      { type: "image", file: "two.png" },
    ]);
    expect(note.text).toBe("统一编辑后的正文");
    expect(note.imageFile).toBe("one.png");
    expect(note.attachments).toEqual(["two.png"]);
  });

  it("addNote 可指定目标分组，无效分组回退收件箱", () => {
    useNotesStore.getState().addSection("研究");
    const section = useNotesStore.getState().sections[1];
    const grouped = useNotesStore
      .getState()
      .addNote("分组笔记", { sectionId: section.id });
    const fallback = useNotesStore
      .getState()
      .addNote("回退笔记", { sectionId: "missing" });

    expect(
      useNotesStore.getState().notes.find((n) => n.id === grouped.id)?.sectionId
    ).toBe(section.id);
    expect(
      useNotesStore.getState().notes.find((n) => n.id === fallback.id)?.sectionId
    ).toBe(INBOX_ID);
  });

  it("addNote 在特殊分组排到收件箱前时仍默认落入收件箱", () => {
    useNotesStore.setState({
      sections: [
        { id: CLIPBOARD_ID, name: "剪贴板" },
        { id: SECRET_ID, name: "秘文" },
        { id: INBOX_ID, name: "收件箱" },
      ],
    });

    const added = useNotesStore.getState().addNote("监听捕获正文");

    expect(
      useNotesStore.getState().notes.find((note) => note.id === added.id)?.sectionId
    ).toBe(INBOX_ID);
  });

  it("addNote 忽略纯空白", () => {
    expect(useNotesStore.getState().addNote("   \n  ").result).toBe("empty");
    expect(useNotesStore.getState().notes).toHaveLength(0);
  });

  it("addNote 对未完成同文本去重", () => {
    useNotesStore.getState().addNote("同一段话");
    const second = useNotesStore.getState().addNote("  同一段话  ");
    expect(second.result).toBe("duplicate");
    expect(useNotesStore.getState().notes).toHaveLength(1);
  });

  it("已完成的同文本同样去重（发送后再捕获不新建）", () => {
    const first = useNotesStore.getState().addNote("再来一次");
    useNotesStore.getState().setDone([first.id!], true);
    const again = useNotesStore.getState().addNote("再来一次");
    expect(again.result).toBe("duplicate");
    expect(again.id).toBe(first.id);
    expect(useNotesStore.getState().notes).toHaveLength(1);
  });

  it("新卡片置顶插入", () => {
    const s = useNotesStore.getState();
    s.addNote("旧");
    s.addNote("新");
    expect(useNotesStore.getState().notes.map((n) => n.text)).toEqual(["新", "旧"]);
  });

  it("mergeNotes 按列表底→顶（捕获先后）合并并保留首条位置", () => {
    const s = useNotesStore.getState();
    s.addNote("一");
    s.addNote("二");
    s.addNote("三");
    // 置顶插入后展示顺序为 [三, 二, 一]；合并内容按捕获先后（一在前）
    const [a, , c] = useNotesStore.getState().notes;
    useNotesStore.getState().mergeNotes([c.id, a.id]);
    const notes = useNotesStore.getState().notes;
    expect(notes).toHaveLength(2);
    expect(notes[0].text).toBe("一\n\n三");
    expect(notes[1].text).toBe("二");
  });

  it("addClipNote 重复内容：已有卡提升到最新并刷新时间来源", () => {
    const s = useNotesStore.getState();
    s.addClipNote("重复的", { sourceApp: "A" });
    s.addClipNote("另一条", {});
    const before = useNotesStore.getState().notes; // [另一条, 重复的]
    const dupId = before[1].id;
    const oldAt = before[1].createdAt;
    s.addClipNote("重复的", { sourceApp: "B" });
    const after = useNotesStore.getState().notes;
    expect(after).toHaveLength(2);
    expect(after[0].id).toBe(dupId);
    expect(after[0].sourceApp).toBe("B");
    expect(after[0].createdAt).toBeGreaterThanOrEqual(oldAt);
  });

  it("异步富剪贴按来源 createdAt 排序，重复内容用来源时间提升", () => {
    const s = useNotesStore.getState();
    const older = [
      { type: "text" as const, text: "旧来源" },
      { type: "image" as const, file: "old.png" },
    ];
    s.addClipNote("较新文字", { createdAt: 200 });
    // 旧来源图片稍后完成本地化，但不能因完成较晚而越过较新记录。
    s.addClipNote("旧来源", { contentBlocks: older, createdAt: 100 });
    expect(useNotesStore.getState().notes.map((note) => note.createdAt)).toEqual([
      200,
      100,
    ]);

    useNotesStore.getState().addClipNote("旧来源", {
      contentBlocks: older,
      createdAt: 300,
      sourceApp: "Geelib",
    });
    const after = useNotesStore.getState().notes;
    expect(after).toHaveLength(2);
    expect(after.map((note) => note.createdAt)).toEqual([300, 200]);
    expect(after[0].sourceApp).toBe("Geelib");
  });

  it("addNote orderByTime：监听消息乱序到达仍按时间最新在上", () => {
    const s = useNotesStore.getState();
    const sectionId = s.ensureSection("消息");
    // 桥批量上报顺序跟随 IM 列表（最新在前）：新的先到、旧的后到
    s.addNote("最新消息", { sectionId, createdAt: 300, orderByTime: true });
    s.addNote("中间消息", { sectionId, createdAt: 200, orderByTime: true });
    s.addNote("最旧消息", { sectionId, createdAt: 100, orderByTime: true });
    const texts = () =>
      useNotesStore
        .getState()
        .notes.filter((n) => n.sectionId === sectionId)
        .map((n) => n.text);
    expect(texts()).toEqual(["最新消息", "中间消息", "最旧消息"]);
    // 实时到达的更新消息插到分组顶部
    s.addNote("更新的消息", { sectionId, createdAt: 400, orderByTime: true });
    expect(texts()[0]).toBe("更新的消息");
  });

  it("addClipNote 重复图片（同像素哈希文件）：同样提升置顶", () => {
    const s = useNotesStore.getState();
    s.addClipNote("图片 1×1", { kind: "image", imageFile: "img-x.png" });
    s.addClipNote("挡在前面", {});
    s.addClipNote("图片 1×1", { kind: "image", imageFile: "img-x.png" });
    const after = useNotesStore.getState().notes;
    expect(after).toHaveLength(2);
    expect(after[0].imageFile).toBe("img-x.png");
  });

  it("连续复制两次手势：10 秒内二次复制自动置顶并回传 autoKept", () => {
    const s = useNotesStore.getState();
    s.addClipNote("重要地址内容", { createdAt: 1_000 });
    const res = s.addClipNote("重要地址内容", { createdAt: 9_000 });
    const card = useNotesStore.getState().notes[0];
    expect(card.keep).toBe(true);
    expect(res.autoKept).toEqual({ id: card.id, preview: "重要地址内容" });
  });

  it("连续复制两次手势：超出 10 秒窗口只提升不置顶", () => {
    const s = useNotesStore.getState();
    s.addClipNote("过会儿再复制", { createdAt: 1_000 });
    const res = s.addClipNote("过会儿再复制", { createdAt: 12_001 });
    const card = useNotesStore.getState().notes[0];
    expect(card.keep).toBeUndefined();
    expect(res.autoKept).toBeUndefined();
    expect(card.createdAt).toBe(12_001);
  });

  it("连续复制两次手势：已置顶卡不重复触发信号", () => {
    const s = useNotesStore.getState();
    s.addClipNote("已经钉住", { createdAt: 1_000 });
    s.addClipNote("已经钉住", { createdAt: 2_000 }); // 首次触发置顶
    const res = s.addClipNote("已经钉住", { createdAt: 3_000 });
    expect(useNotesStore.getState().notes[0].keep).toBe(true);
    expect(res.autoKept).toBeUndefined();
  });

  it("连续复制两次手势：设置关闭后不触发", () => {
    useNotesStore.setState({
      settings: { ...defaultSettings(), clipDoubleCopyKeep: false },
    });
    const s = useNotesStore.getState();
    s.addClipNote("开关已关", { createdAt: 1_000 });
    const res = s.addClipNote("开关已关", { createdAt: 2_000 });
    expect(useNotesStore.getState().notes[0].keep).toBeUndefined();
    expect(res.autoKept).toBeUndefined();
  });

  it("mergeNotes 剪贴板域：产出新组合卡置顶，原卡保持原样", () => {
    const s = useNotesStore.getState();
    s.addClipNote("甲", {});
    s.addClipNote("乙", {});
    const before = useNotesStore.getState().notes;
    expect(before).toHaveLength(2);
    useNotesStore.getState().mergeNotes([before[1].id, before[0].id]);
    const after = useNotesStore.getState().notes;
    expect(after).toHaveLength(3);
    // 新组合卡置顶且在剪贴板域，按捕获先后拼接（甲先复制在前）
    expect(after[0].text).toBe("甲\n\n乙");
    expect(after[0].sectionId).toBe(CLIPBOARD_ID);
    // 原卡原样保留
    expect(after.slice(1).map((n) => n.id)).toEqual(before.map((n) => n.id));
    // 选中态落在新卡上
    expect(useNotesStore.getState().checkedIds).toEqual([after[0].id]);
  });

  it("mergeNotes 剪贴板域图片卡：图片全部并入新卡附件", () => {
    const s = useNotesStore.getState();
    s.addClipNote("图片 1×1", { kind: "image", imageFile: "img-a.png", imageW: 1, imageH: 1 });
    s.addClipNote("图片 2×2", { kind: "image", imageFile: "img-b.png", imageW: 2, imageH: 2 });
    const before = useNotesStore.getState().notes; // [b, a]
    useNotesStore.getState().mergeNotes([before[0].id, before[1].id]);
    const combo = useNotesStore.getState().notes[0];
    expect(combo.kind).toBe("image");
    // 按捕获先后拼接：先复制的 a 成为主图
    expect(combo.imageFile).toBe("img-a.png");
    expect(combo.attachments).toEqual(["img-b.png"]);
    expect(useNotesStore.getState().notes).toHaveLength(3);
  });

  it("mergeNotes 混域（剪贴卡 + 笔记卡）：拒绝执行，任何数据与撤销栈不动", () => {
    const s = useNotesStore.getState();
    s.addClipNote("剪贴内容", {});
    s.addNote("笔记内容");
    const before = useNotesStore.getState().notes;
    useNotesStore.getState().mergeNotes(before.map((n) => n.id));
    expect(useNotesStore.getState().notes).toEqual(before);
    expect(useNotesStore.getState().undoStack).toHaveLength(0);
  });

  it("moveClipsToNotes：移入收件箱并重置 done/keep；非剪贴卡入参被忽略", () => {
    const s = useNotesStore.getState();
    s.addClipNote("要收编的", {});
    const clip = useNotesStore.getState().notes[0];
    s.setDone([clip.id], true);
    s.toggleNoteKeep(clip.id);
    s.addNote("普通笔记");
    const note = useNotesStore
      .getState()
      .notes.find((n) => n.text === "普通笔记")!;
    useNotesStore.getState().setChecked([clip.id, note.id]);
    const moved = useNotesStore.getState().moveClipsToNotes([clip.id, note.id]);
    expect(moved).toBe(1);
    const movedCard = useNotesStore
      .getState()
      .notes.find((n) => n.id === clip.id)!;
    expect(movedCard.sectionId).toBe(INBOX_ID);
    expect(movedCard.done).toBe(false);
    expect(movedCard.keep).toBe(false);
    // 移走的卡从勾选集摘除（剪贴页已不可见），未移动的保留勾选
    expect(useNotesStore.getState().checkedIds).toEqual([note.id]);
    // 非剪贴卡原对象原样保留
    expect(useNotesStore.getState().notes.find((n) => n.id === note.id)).toBe(
      note
    );
  });

  it("moveClipsToNotes 撤销：恢复原域、原位置与 done 状态", () => {
    const s = useNotesStore.getState();
    s.addClipNote("A", {});
    s.addClipNote("B", {});
    const before = useNotesStore.getState().notes; // [B, A]
    const target = before[1];
    useNotesStore.getState().setDone([target.id], true);
    useNotesStore.getState().moveClipsToNotes([target.id]);
    expect(
      useNotesStore.getState().notes.find((n) => n.id === target.id)!.sectionId
    ).toBe(INBOX_ID);
    const label = useNotesStore.getState().undo();
    expect(label).toBe("移入笔记");
    const restored = useNotesStore
      .getState()
      .notes.find((n) => n.id === target.id)!;
    expect(restored.sectionId).toBe(CLIPBOARD_ID);
    expect(restored.done).toBe(true);
    expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(
      before.map((n) => n.id)
    );
  });

  it("reorderNotes 在数组内移动", () => {
    const s = useNotesStore.getState();
    s.addNote("一");
    s.addNote("二");
    s.addNote("三");
    const [a, , c] = useNotesStore.getState().notes; // [三, 二, 一]
    useNotesStore.getState().reorderNotes(a.id, c.id);
    expect(useNotesStore.getState().notes.map((n) => n.text)).toEqual(["二", "一", "三"]);
  });

  it("deleteSection 把笔记回收进收件箱且不能删除收件箱", () => {
    useNotesStore.getState().addSection("研究");
    const section = useNotesStore.getState().sections[1];
    useNotesStore.getState().addNote("x", { sectionId: section.id });
    useNotesStore.getState().deleteSection(section.id);
    let state = useNotesStore.getState();
    expect(state.sections).toHaveLength(1);
    expect(state.notes[0].sectionId).toBe(INBOX_ID);
    useNotesStore.getState().deleteSection(INBOX_ID);
    state = useNotesStore.getState();
    expect(state.sections).toHaveLength(1);
  });

  it("moveSection 上移/下移并做边界保护", () => {
    const s = useNotesStore.getState();
    s.addSection("A");
    s.addSection("B");
    const [, a, b] = useNotesStore.getState().sections;
    useNotesStore.getState().moveSection(b.id, -1);
    expect(useNotesStore.getState().sections.map((x) => x.name)).toEqual([
      "收件箱",
      "B",
      "A",
    ]);
    // 收件箱已在顶部，上移无效
    useNotesStore.getState().moveSection(INBOX_ID, -1);
    expect(useNotesStore.getState().sections[0].id).toBe(INBOX_ID);
    void a;
  });

  it("reorderSections 支持拖拽跨多项调整顺序", () => {
    const s = useNotesStore.getState();
    s.addSection("A");
    s.addSection("B");
    s.addSection("C");
    const [, a, , c] = useNotesStore.getState().sections;

    useNotesStore.getState().reorderSections(c.id, a.id);

    expect(useNotesStore.getState().sections.map((section) => section.name)).toEqual([
      "收件箱",
      "C",
      "A",
      "B",
    ]);
  });

  it("orderedCheckedNotes 按展示顺序返回", () => {
    const s = useNotesStore.getState();
    s.addNote("一");
    s.addNote("二");
    const [a, b] = useNotesStore.getState().notes; // [二, 一]
    useNotesStore.getState().setChecked([b.id, a.id]);
    expect(orderedCheckedNotes(useNotesStore.getState()).map((n) => n.text)).toEqual([
      "二",
      "一",
    ]);
  });
});

describe("消息投影与后续动作", () => {
  beforeEach(reset);

  const capture = {
    conversationId: "group-1",
    messageId: "message-1",
    conversationName: "项目群",
    senderUid: "user-1",
    senderName: "小王",
    occurredAtMs: 100,
    receivedAtMs: 120,
    mentionedSelf: true,
    followedSender: false,
    matchedRuleIds: ["release"],
    isGroup: true,
    messageType: "text",
    text: "请确认今晚发布",
    context: [
      {
        messageId: "message-0",
        senderUid: "user-2",
        senderName: "小李",
        occurredAtMs: 90,
        messageType: "text",
        text: "前文保持完整",
      },
    ],
  };

  it("按来源消息去重并保留完整正文、上下文与工作流状态", () => {
    const first = useNotesStore.getState().ingestMessageCaptures([capture]);
    expect(first).toMatchObject({ added: 1, updated: 0 });
    const id = first.ids[0];
    useNotesStore.getState().setMessageStatus(id, "waiting");
    useNotesStore.getState().saveMessageAiDraft(id, "收到，我先确认窗口。 ");

    useNotesStore.getState().ingestMessageCaptures([
      { ...capture, text: "请确认今晚发布，失败时立即回滚" },
    ]);
    const message = useNotesStore.getState().messages[0];
    expect(message.text).toBe("请确认今晚发布，失败时立即回滚");
    expect(message.context[0].text).toBe("前文保持完整");
    expect(message.status).toBe("waiting");
    expect(message.aiDraft).toBe("收到，我先确认窗口。");
  });

  it("setMessagesStatus 批量改状态且不波及未选中项", () => {
    const other = { ...capture, messageId: "message-b", occurredAtMs: 60 };
    const ids = useNotesStore.getState().ingestMessageCaptures([capture, other]).ids;
    useNotesStore.getState().setMessagesStatus([ids[0]], "done");
    const byId = new Map(useNotesStore.getState().messages.map((m) => [m.id, m.status]));
    expect(byId.get(ids[0])).toBe("done");
    expect(byId.get(ids[1])).toBe("new");
    // 撤销语义：同一批 id 一步还原
    useNotesStore.getState().setMessagesStatus([ids[0]], "new");
    expect(
      useNotesStore.getState().messages.every((m) => m.status === "new")
    ).toBe(true);
  });

  it("removeMessages 删除投影，restoreMessages 按时间回插且跳过已存在的 id", () => {
    const older = { ...capture, messageId: "message-old", occurredAtMs: 50 };
    const ids = useNotesStore
      .getState()
      .ingestMessageCaptures([capture, older]).ids;
    const removed = useNotesStore
      .getState()
      .messages.find((message) => message.id === ids[1])!;

    useNotesStore.getState().removeMessages([removed.id]);
    expect(useNotesStore.getState().messages.map((m) => m.id)).toEqual([ids[0]]);

    // 回插归位：老消息按 occurredAtMs 排回列表末尾
    useNotesStore.getState().restoreMessages([removed]);
    expect(useNotesStore.getState().messages.map((m) => m.id)).toEqual([
      ids[0],
      removed.id,
    ]);

    // 已存在的 id 不重复插入
    useNotesStore.getState().restoreMessages([removed]);
    expect(useNotesStore.getState().messages).toHaveLength(2);
  });

  it("转任务一次完成引用关联，重复点击不产生第二个任务", () => {
    const [{ id }] = [
      useNotesStore.getState().ingestMessageCaptures([capture]),
    ].map((result) => ({ id: result.ids[0] }));
    const first = useNotesStore.getState().messageToTask(id, "reminder", 1_000);
    const second = useNotesStore.getState().messageToTask(id, "task");

    expect(first.result).toBe("added");
    expect(second).toEqual({ result: "existing", taskId: first.taskId });
    expect(useNotesStore.getState().tasks).toHaveLength(1);
    expect(useNotesStore.getState().tasks[0]).toMatchObject({
      dueAt: 1_000,
      sourceRef: {
        kind: "message",
        source: "im",
        conversationId: "group-1",
        messageId: "message-1",
      },
    });
    expect(useNotesStore.getState().messages[0]).toMatchObject({
      status: "done",
      linkedTaskId: first.taskId,
    });
  });
});

describe("store v13 migration and directory rehydrate", () => {
  it("v10 旧 key 只保留为 Keychain 迁移恢复副本，默认 v11 不再创建该字段", () => {
    const decoded = decodePersistedState(JSON.stringify({
      version: 10,
      state: {
        sections: [],
        notes: [],
        tasks: [],
        taskSections: [],
        settings: { ...defaultSettings(), aiApiKey: "sk-legacy-recovery" },
      },
    }));

    expect(defaultSettings()).not.toHaveProperty("aiApiKey");
    expect(decoded.settings).toHaveProperty("aiApiKey", "sk-legacy-recovery");
    expect(() => decodePersistedState(JSON.stringify({
      version: STORE_VERSION,
      state: {
        sections: [], notes: [], tasks: [], taskSections: [],
        settings: { ...defaultSettings(), aiApiKey: 42 },
      },
    }))).toThrow("settings.aiApiKey 类型无效");
  });

  it("v9 向前迁移默认开启 Firewall，且只允许关闭提示级类别", () => {
    const legacy = { ...defaultSettings() } as Partial<ReturnType<typeof defaultSettings>>;
    delete legacy.firewallEnabled;
    delete legacy.firewallDisabledWarnCategories;
    const decoded = decodePersistedState(JSON.stringify({
      version: 9,
      state: {
        sections: [],
        notes: [],
        tasks: [],
        taskSections: [],
        settings: legacy,
      },
    }));

    expect(decoded.settings).toMatchObject({
      firewallEnabled: true,
      firewallDisabledWarnCategories: [],
    });
    expect(() => decodePersistedState(JSON.stringify({
      version: STORE_VERSION,
      state: {
        sections: [], notes: [], tasks: [], taskSections: [],
        settings: {
          ...defaultSettings(),
          firewallDisabledWarnCategories: ["apiKey"],
        },
      },
    }))).toThrow("settings.firewallDisabledWarnCategories 含不可关闭类别");
  });
  it("同版本旧数据缺少新增框目标时回填默认值，并保留已记录分组", () => {
    const withoutField = defaultSettings() as Partial<ReturnType<typeof defaultSettings>>;
    delete withoutField.lastDraftSectionId;
    const decode = (settings: object) =>
      decodePersistedState(
        JSON.stringify({
          version: STORE_VERSION,
          state: {
            sections: [{ id: INBOX_ID, name: "收件箱" }],
            notes: [],
            tasks: [],
            taskSections: [],
            settings,
          },
        })
      );

    expect(decode(withoutField).settings.lastDraftSectionId).toBeNull();
    expect(
      decode({ ...defaultSettings(), lastDraftSectionId: "project" }).settings
        .lastDraftSectionId
    ).toBe("project");
  });

  it("v8 模板迁入通用分组且 autoEnter=true 只迁为 confirm", () => {
    const legacySnippets = [
      { id: "one", label: "一", text: "first" },
      { id: "two", label: "二", text: "second" },
    ];
    const decoded = decodePersistedState(
      JSON.stringify({
        version: 8,
        state: {
          sections: [],
          notes: [],
          tasks: [],
          taskSections: [],
          settings: {
            ...defaultSettings(),
            autoEnter: true,
            promptGroups: undefined,
            targetProfiles: undefined,
            defaultTargetProfileId: undefined,
            promptSnippets: legacySnippets,
          },
        },
      })
    );

    expect(decoded.settings.promptGroups).toEqual([
      { id: GENERAL_PROMPT_GROUP_ID, name: "通用", order: 0 },
    ]);
    expect(decoded.settings.promptSnippets).toEqual(
      legacySnippets.map((snippet) => ({
        ...snippet,
        groupId: GENERAL_PROMPT_GROUP_ID,
      }))
    );
    expect(decoded.settings.targetProfiles.find((item) => item.id === SAFETY_PROFILE_ID))
      .toMatchObject({ enterPolicy: "confirm" });
    expect(decoded.settings.targetProfiles.every((item) => item.enterPolicy !== "allow"))
      .toBe(true);
    expect(decoded.settings.autoEnter).toBe(false);
  });

  it("v8 重复或空 snippet id 稳定重编号，v9 round-trip 不丢模板", () => {
    const legacySnippets = [
      { id: "same", label: "一", text: "first" },
      { id: "same", label: "二", text: "second" },
      { id: "", label: "三", text: "third" },
    ];
    const decoded = decodePersistedState(JSON.stringify({
      version: 8,
      state: {
        sections: [],
        notes: [],
        tasks: [],
        taskSections: [],
        settings: { ...defaultSettings(), promptSnippets: legacySnippets },
      },
    }));
    const migrated = decoded.settings.promptSnippets;

    expect(migrated.map((item) => item.text)).toEqual(["first", "second", "third"]);
    expect(new Set(migrated.map((item) => item.id)).size).toBe(3);
    expect(migrated.every((item) => item.groupId === GENERAL_PROMPT_GROUP_ID)).toBe(true);

    const roundTrip = decodePersistedState(JSON.stringify({
      version: STORE_VERSION,
      state: decoded,
    }));
    expect(roundTrip.settings.promptSnippets).toEqual(migrated);
  });

  it("deduplicates old records, restores required groups, and tolerates unknown fields", () => {
    const decoded = decodePersistedState(
      JSON.stringify({
        version: 7,
        state: {
          sections: [
            { id: "x", name: "X", future: true },
            { id: "x", name: "duplicate" },
          ],
          notes: [
            { id: "n", text: "first", sectionId: "missing", done: false, createdAt: 1 },
            { id: "n", text: "duplicate", sectionId: "x", done: false, createdAt: 2 },
          ],
          tasks: [],
          taskSections: [],
          settings: { ...defaultSettings(), futureSetting: "kept" },
          futureTopLevel: true,
        },
      })
    );

    expect(decoded.sections.map((section) => section.id)).toEqual([INBOX_ID, "x"]);
    expect(decoded.notes).toHaveLength(1);
    expect(decoded.notes[0].sectionId).toBe(INBOX_ID);
    expect(decoded.taskSections[0].id).toBe(TASK_INBOX_ID);
    expect((decoded.settings as unknown as { futureSetting: string }).futureSetting).toBe(
      "kept"
    );
  });

  it("rejects duplicate ids in the current schema instead of silently dropping records", () => {
    expect(() =>
      decodePersistedState(
        JSON.stringify({
          version: STORE_VERSION,
          state: {
            sections: [],
            notes: [
              { id: "same", text: "first" },
              { id: "same", text: "second" },
            ],
            tasks: [],
            taskSections: [],
          },
        })
      )
    ).toThrow("notes 含重复 id");
  });

  it("rejects empty Phase04 ids in the current schema", () => {
    const settings = defaultSettings();
    expect(() => decodePersistedState(JSON.stringify({
      version: STORE_VERSION,
      state: {
        sections: [],
        notes: [],
        tasks: [],
        taskSections: [],
        settings: {
          ...settings,
          promptGroups: [{ id: "", name: "坏分组", order: 0 }],
        },
      },
    }))).toThrow("settings.promptGroups 字段无效");
    expect(() => decodePersistedState(JSON.stringify({
      version: STORE_VERSION,
      state: {
        sections: [],
        notes: [],
        tasks: [],
        taskSections: [],
        settings: {
          ...settings,
          targetProfiles: [{
            id: "",
            name: "坏 Profile",
            bundleIds: [],
            promptGroupId: GENERAL_PROMPT_GROUP_ID,
            defaultFormat: "plain",
            enterPolicy: "never",
            privacyPolicy: "requireRedaction",
            keepPanel: false,
          }],
        },
      },
    }))).toThrow("settings.targetProfiles 字段无效");
  });

  it.each([
    ["present non-array records", { notes: "corrupt" }],
    ["wrong settings array type", { settings: { promptSnippets: "corrupt" } }],
    ["invalid settings enum", { settings: { theme: "neon" } }],
  ])("rejects %s instead of silently normalizing it", (_label, patch) => {
    expect(() =>
      decodePersistedState(
        JSON.stringify({
          version: STORE_VERSION,
          state: {
            sections: [],
            notes: [],
            tasks: [],
            taskSections: [],
            settings: defaultSettings(),
            ...patch,
          },
        })
      )
    ).toThrow();
  });

  it("directory rehydrate replaces old memory instead of merging it", () => {
    useNotesStore.getState().addNote("old-directory");
    const raw = JSON.stringify({
      version: STORE_VERSION,
      state: {
        sections: [{ id: INBOX_ID, name: "收件箱" }],
        notes: [
          {
            id: "new",
            text: "new-directory",
            sectionId: INBOX_ID,
            done: false,
            createdAt: 1,
          },
        ],
        tasks: [],
        taskSections: [{ id: TASK_INBOX_ID, name: "收集箱" }],
        settings: defaultSettings(),
      },
    });

    replaceNotesStoreFromPersisted(raw);

    expect(useNotesStore.getState().notes.map((note) => note.text)).toEqual([
      "new-directory",
    ]);
    expect(useNotesStore.getState().undoStack).toEqual([]);
  });

  it("rejects a future store schema before replacing memory", () => {
    expect(() =>
      decodePersistedState(
        JSON.stringify({ version: STORE_VERSION + 1, state: {} })
      )
    ).toThrow(/高于当前支持/);
  });
});

describe("撤销安全网", () => {
  beforeEach(reset);

  it("deleteNotes 可撤销恢复原位", () => {
    const s = useNotesStore.getState();
    s.addNote("一");
    s.addNote("二");
    const [a] = useNotesStore.getState().notes; // [二, 一]
    useNotesStore.getState().deleteNotes([a.id]);
    expect(useNotesStore.getState().notes).toHaveLength(1);
    const label = useNotesStore.getState().undo();
    expect(label).toContain("删除");
    expect(useNotesStore.getState().notes.map((n) => n.text)).toEqual(["二", "一"]);
  });

  it("clearDone 只清已完成且可撤销", () => {
    const s = useNotesStore.getState();
    const a = s.addNote("留下");
    const b = s.addNote("清掉");
    useNotesStore.getState().setDone([b.id!], true);
    const cleared = useNotesStore.getState().clearDone();
    expect(cleared).toBe(1);
    expect(useNotesStore.getState().notes.map((n) => n.text)).toEqual(["留下"]);
    useNotesStore.getState().undo();
    expect(useNotesStore.getState().notes).toHaveLength(2);
    void a;
  });

  it("撤销栈有深度上限且空栈返回 null", () => {
    const s = useNotesStore.getState();
    for (let i = 0; i < 8; i++) {
      s.addNote(`n${i}`);
    }
    const ids = useNotesStore.getState().notes.map((n) => n.id);
    for (const id of ids.slice(0, 7)) {
      useNotesStore.getState().deleteNotes([id]);
    }
    expect(useNotesStore.getState().undoStack.length).toBeLessThanOrEqual(5);
    let undone = 0;
    while (useNotesStore.getState().undo() !== null) undone++;
    expect(undone).toBeLessThanOrEqual(5);
    expect(useNotesStore.getState().undo()).toBeNull();
  });

  it("deleteNotes 同步清理勾选态", () => {
    const s = useNotesStore.getState();
    s.addNote("一");
    const [a] = useNotesStore.getState().notes;
    useNotesStore.getState().setChecked([a.id]);
    useNotesStore.getState().deleteNotes([a.id]);
    expect(useNotesStore.getState().checkedIds).toHaveLength(0);
  });
});

describe("导入合并", () => {
  beforeEach(reset);

  it("按 id 去重追加，孤儿分组归收件箱", () => {
    const s = useNotesStore.getState();
    const kept = s.addNote("本地已有");
    const localId = kept.id!;
    const added = useNotesStore.getState().importMerge({
      sections: [{ id: "sec-x", name: "外部组" }],
      notes: [
        {
          id: localId,
          text: "重复导入应跳过",
          sectionId: INBOX_ID,
          done: false,
          createdAt: 1,
        },
        { id: "new-1", text: "新条目", sectionId: "sec-x", done: false, createdAt: 2 },
        { id: "new-2", text: "孤儿", sectionId: "ghost", done: false, createdAt: 3 },
      ],
    });
    expect(added.notes).toBe(2);
    const state = useNotesStore.getState();
    expect(state.notes).toHaveLength(3);
    expect(state.sections.map((x) => x.name)).toEqual(["收件箱", "外部组"]);
    expect(state.notes.find((n) => n.id === "new-2")?.sectionId).toBe(INBOX_ID);
    expect(state.notes.find((n) => n.id === localId)?.text).toBe("本地已有");
  });
});

describe("图片卡片：文字备注编辑", () => {
  beforeEach(reset);

  it("保存文字后保持图片类型，并把编辑内容写回列表数据源", () => {
    const { id } = useNotesStore.getState().addNote("图片 231×242", {
      kind: "image",
      imageFile: "shot.png",
      imageW: 231,
      imageH: 242,
    });

    useNotesStore.getState().updateNoteText(id!, "编辑后的图片说明");
    const note = useNotesStore.getState().notes.find((item) => item.id === id)!;

    expect(note.kind).toBe("image");
    expect(note.text).toBe("编辑后的图片说明");
    expect(note.imageFile).toBe("shot.png");
  });
});

describe("链接卡片：updateNoteText 升降级与 setLinkMeta", () => {
  beforeEach(reset);

  it("捕获/输入纯 URL 自动成为链接卡", () => {
    const { id } = useNotesStore.getState().addNote("https://a.com/docs");
    const n = useNotesStore.getState().notes.find((x) => x.id === id)!;
    expect(n.kind).toBe("link");
    expect(n.url).toBe("https://a.com/docs");
  });

  it("编辑成另一个 URL：保持链接卡并清掉旧简介待重抓", () => {
    const { id } = useNotesStore.getState().addNote("https://a.com/1");
    useNotesStore.getState().setLinkMeta(id!, { title: "旧标题", icon: "https://a.com/f.ico" });
    useNotesStore.getState().updateNoteText(id!, "https://b.com/2");
    const n = useNotesStore.getState().notes.find((x) => x.id === id)!;
    expect(n.kind).toBe("link");
    expect(n.url).toBe("https://b.com/2");
    expect(n.linkTitle).toBeUndefined();
    expect(n.linkIcon).toBeUndefined();
  });

  it("链接卡编辑成普通文本：降级为文本卡", () => {
    const { id } = useNotesStore.getState().addNote("https://a.com/1");
    useNotesStore.getState().setLinkMeta(id!, { title: "标题" });
    useNotesStore.getState().updateNoteText(id!, "只是普通笔记");
    const n = useNotesStore.getState().notes.find((x) => x.id === id)!;
    expect(n.kind).toBe("text");
    expect(n.url).toBeUndefined();
    expect(n.linkTitle).toBeUndefined();
  });

  it("文本卡编辑成 URL：升级为链接卡", () => {
    const { id } = useNotesStore.getState().addNote("普通文本");
    useNotesStore.getState().updateNoteText(id!, "https://c.com/x");
    const n = useNotesStore.getState().notes.find((x) => x.id === id)!;
    expect(n.kind).toBe("link");
    expect(n.url).toBe("https://c.com/x");
  });

  it("详情编辑可附加并去重粘贴的图片", () => {
    const { id } = useNotesStore.getState().addNote("正文");
    useNotesStore
      .getState()
      .updateNoteText(id!, "正文", ["a.png", "a.png", "b.png"]);
    const n = useNotesStore.getState().notes.find((x) => x.id === id)!;

    expect(n.kind).toBe("text");
    expect(n.imageFile).toBe("a.png");
    expect(n.attachments).toEqual(["b.png"]);
  });

  it("详情编辑清空文字但保留图片时转为图片卡", () => {
    const { id } = useNotesStore.getState().addNote("稍后删掉");
    useNotesStore.getState().updateNoteText(id!, "", ["a.png"]);
    const n = useNotesStore.getState().notes.find((x) => x.id === id)!;

    expect(n.kind).toBe("image");
    expect(n.text).toBe("");
    expect(n.imageFile).toBe("a.png");
  });

  it("setLinkMeta 只作用于链接卡且 URL 未变时生效", () => {
    const { id } = useNotesStore.getState().addNote("普通文本");
    useNotesStore.getState().setLinkMeta(id!, { title: "不应写入" });
    expect(
      useNotesStore.getState().notes.find((x) => x.id === id)!.linkTitle
    ).toBeUndefined();
  });
});

describe("发送后保留：doneIdsAfterSend", () => {
  beforeEach(reset);

  it("普通卡发送后进入完成列表", () => {
    const { id } = useNotesStore.getState().addNote("普通内容");
    expect(doneIdsAfterSend(useNotesStore.getState(), [id!])).toEqual([id]);
  });

  it("「常用」卡发送后不标完成", () => {
    const a = useNotesStore.getState().addNote("常用 Prompt").id!;
    const b = useNotesStore.getState().addNote("一次性内容").id!;
    useNotesStore.getState().toggleNoteKeep(a);
    expect(doneIdsAfterSend(useNotesStore.getState(), [a, b])).toEqual([b]);
    // 再次切换恢复常规行为
    useNotesStore.getState().toggleNoteKeep(a);
    expect(doneIdsAfterSend(useNotesStore.getState(), [a, b]).sort()).toEqual(
      [a, b].sort()
    );
  });

  it("「发送后保留」分组内的卡不标完成", () => {
    useNotesStore.getState().toggleSectionKeep(INBOX_ID);
    const a = useNotesStore.getState().addNote("Prompt 库内容").id!;
    expect(doneIdsAfterSend(useNotesStore.getState(), [a])).toEqual([]);
  });
});

describe("剪贴板历史 addClipNote", () => {
  beforeEach(reset);

  it("首次收集自动建「剪贴板」组并插在收件箱之后", () => {
    useNotesStore.getState().addClipNote("copied");
    const sections = useNotesStore.getState().sections;
    expect(sections.map((s) => s.id)).toEqual([INBOX_ID, CLIPBOARD_ID]);
    expect(useNotesStore.getState().notes[0].sectionId).toBe(CLIPBOARD_ID);
  });

  it("重复文本静默跳过不新建", () => {
    useNotesStore.getState().addClipNote("same");
    useNotesStore.getState().addClipNote("same");
    expect(useNotesStore.getState().notes).toHaveLength(1);
  });

  it("去重只在域内：剪贴板有同文本仍可捕获为笔记，反之亦然", () => {
    // 剪贴板先收集了某段文字 → 用户双击捕获同文本，应入库为笔记而非误报重复
    useNotesStore.getState().addClipNote("跨域文本");
    const captured = useNotesStore.getState().addNote("跨域文本");
    expect(captured.result).toBe("added");
    // 反向：笔记里已有的内容复制时，剪贴板历史照常记录
    useNotesStore.getState().addNote("先是笔记");
    useNotesStore.getState().addClipNote("先是笔记");
    const clips = useNotesStore
      .getState()
      .notes.filter((n) => n.sectionId === CLIPBOARD_ID)
      .map((n) => n.text);
    expect(clips.sort()).toEqual(["先是笔记", "跨域文本"]);
  });
});

describe("任务：CRUD / 撤销 / 转换原子性 / 导入", () => {
  beforeEach(reset);

  it("addTask 去空白、空串 empty、默认 todo/none/无到期", () => {
    expect(useNotesStore.getState().addTask("   ").result).toBe("empty");
    const { result, id } = useNotesStore.getState().addTask("  写周报  ");
    expect(result).toBe("added");
    const t = useNotesStore.getState().tasks.find((x) => x.id === id)!;
    expect(t.text).toBe("写周报");
    expect(t.status).toBe("todo");
    expect(t.priority).toBe("none");
    expect(t.dueAt).toBeNull();
    expect(t.remindedAt).toBeNull();
  });

  it("addTask 不去重（与 addNote 的刻意差异）", () => {
    useNotesStore.getState().addTask("回复邮件");
    useNotesStore.getState().addTask("回复邮件");
    expect(useNotesStore.getState().tasks).toHaveLength(2);
  });

  it("cycleTaskStatus 三态循环；toggleTaskDone 二态直切", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    const st = () => useNotesStore.getState().tasks[0].status;
    useNotesStore.getState().cycleTaskStatus(id);
    expect(st()).toBe("doing");
    useNotesStore.getState().cycleTaskStatus(id);
    expect(st()).toBe("done");
    useNotesStore.getState().cycleTaskStatus(id);
    expect(st()).toBe("todo");
    // doing 状态下 toggle 直达 done（跳过中间态），再 toggle 回 todo
    useNotesStore.getState().cycleTaskStatus(id);
    expect(st()).toBe("doing");
    useNotesStore.getState().toggleTaskDone(id);
    expect(st()).toBe("done");
    useNotesStore.getState().toggleTaskDone(id);
    expect(st()).toBe("todo");
  });

  it("setTaskDue 变更会清空 remindedAt", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().setTaskDue(id, 1000);
    useNotesStore.getState().markTasksReminded([id]);
    expect(useNotesStore.getState().tasks[0].remindedAt).not.toBeNull();
    useNotesStore.getState().setTaskDue(id, 2000);
    expect(useNotesStore.getState().tasks[0].remindedAt).toBeNull();
  });

  it("deleteTasks / clearDoneTasks 可撤销", () => {
    const a = useNotesStore.getState().addTask("A").id!;
    useNotesStore.getState().addTask("B");
    useNotesStore.getState().deleteTasks([a]);
    expect(useNotesStore.getState().tasks).toHaveLength(1);
    useNotesStore.getState().undo();
    expect(useNotesStore.getState().tasks).toHaveLength(2);
    useNotesStore.getState().toggleTaskDone(a);
    expect(useNotesStore.getState().clearDoneTasks()).toBe(1);
    expect(useNotesStore.getState().tasks).toHaveLength(1);
    useNotesStore.getState().undo();
    expect(useNotesStore.getState().tasks).toHaveLength(2);
  });

  it("convertNoteToTask：原子转换，一次 undo 同时恢复笔记并移除任务", () => {
    const noteId = useNotesStore.getState().addNote("变成待办的笔记").id!;
    expect(useNotesStore.getState().convertNoteToTask(noteId)).toBe(true);
    expect(useNotesStore.getState().notes).toHaveLength(0);
    expect(useNotesStore.getState().tasks).toHaveLength(1);
    expect(useNotesStore.getState().tasks[0].text).toBe("变成待办的笔记");
    useNotesStore.getState().undo();
    expect(useNotesStore.getState().notes).toHaveLength(1);
    expect(useNotesStore.getState().tasks).toHaveLength(0);
  });

  it("convertNoteToTask：图片卡拒绝且无副作用", () => {
    const imgId = useNotesStore
      .getState()
      .addNote("图片 100×100", { kind: "image", imageFile: "a.png" }).id!;
    expect(useNotesStore.getState().convertNoteToTask(imgId)).toBe(false);
    expect(useNotesStore.getState().notes).toHaveLength(1);
    expect(useNotesStore.getState().tasks).toHaveLength(0);
  });

  it("convertNoteToTaskSmart：AI 标题+检查项原子转换，一次 undo 全恢复", () => {
    const noteId = useNotesStore.getState().addNote("整理季度汇报材料的一大段笔记").id!;
    expect(
      useNotesStore
        .getState()
        .convertNoteToTaskSmart(noteId, "整理季度汇报", ["收集数据", " 排版 ", ""])
    ).toBe(true);
    const task = useNotesStore.getState().tasks[0];
    expect(task.text).toBe("整理季度汇报");
    expect(task.checklist?.map((c) => c.text)).toEqual(["收集数据", "排版"]);
    expect(useNotesStore.getState().notes).toHaveLength(0);
    useNotesStore.getState().undo();
    expect(useNotesStore.getState().notes).toHaveLength(1);
    expect(useNotesStore.getState().tasks).toHaveLength(0);
  });

  it("convertNoteToTaskSmart：空检查项 → checklist 为 undefined；空标题回退原文", () => {
    const noteId = useNotesStore.getState().addNote("原文标题").id!;
    expect(
      useNotesStore.getState().convertNoteToTaskSmart(noteId, "  ", [])
    ).toBe(true);
    const task = useNotesStore.getState().tasks[0];
    expect(task.text).toBe("原文标题");
    expect(task.checklist).toBeUndefined();
  });

  it("convertNoteToTaskSmart：图片卡拒绝", () => {
    const imgId = useNotesStore
      .getState()
      .addNote("图片 1×1", { kind: "image", imageFile: "b.png" }).id!;
    expect(
      useNotesStore.getState().convertNoteToTaskSmart(imgId, "标题", ["x"])
    ).toBe(false);
    expect(useNotesStore.getState().tasks).toHaveLength(0);
  });

  it("importMerge 合并 tasks：按 id 去重并计数", () => {
    const kept = useNotesStore.getState().addTask("本地任务").id!;
    const r = useNotesStore.getState().importMerge({
      tasks: [
        {
          id: kept,
          text: "重复导入应跳过",
          status: "todo",
          priority: "none",
          dueAt: null,
          createdAt: 1,
          remindedAt: null,
        },
        {
          id: "t-new",
          text: "外部任务",
          status: "doing",
          priority: "high",
          dueAt: null,
          createdAt: 2,
          remindedAt: null,
        },
      ],
    });
    expect(r).toEqual({
      notes: 0,
      tasks: 1,
      bills: 0,
      messages: 0,
      skippedDuplicates: 1,
    });
    expect(useNotesStore.getState().tasks).toHaveLength(2);
    expect(useNotesStore.getState().tasks.find((t) => t.id === kept)?.text).toBe(
      "本地任务"
    );
  });
});

describe("任务：备注与检查列表", () => {
  beforeEach(reset);

  it("updateTaskNote 设置与清除（空串 = 清除）", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().updateTaskNote(id, "  一些备注  ");
    expect(useNotesStore.getState().tasks[0].note).toBe("一些备注");
    useNotesStore.getState().updateTaskNote(id, "   ");
    expect(useNotesStore.getState().tasks[0].note).toBeUndefined();
  });

  it("addChecklistItem 追加、忽略空白", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().addChecklistItem(id, "  子项A ");
    useNotesStore.getState().addChecklistItem(id, "   ");
    useNotesStore.getState().addChecklistItem(id, "子项B");
    const list = useNotesStore.getState().tasks[0].checklist!;
    expect(list.map((c) => c.text)).toEqual(["子项A", "子项B"]);
    expect(list.every((c) => !c.done)).toBe(true);
  });

  it("toggleChecklistItem 勾选/取消", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().addChecklistItem(id, "子项");
    const itemId = useNotesStore.getState().tasks[0].checklist![0].id;
    useNotesStore.getState().toggleChecklistItem(id, itemId);
    expect(useNotesStore.getState().tasks[0].checklist![0].done).toBe(true);
    useNotesStore.getState().toggleChecklistItem(id, itemId);
    expect(useNotesStore.getState().tasks[0].checklist![0].done).toBe(false);
  });

  it("updateChecklistItem 改文本；清空文本即删除该项", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().addChecklistItem(id, "旧文本");
    const itemId = useNotesStore.getState().tasks[0].checklist![0].id;
    useNotesStore.getState().updateChecklistItem(id, itemId, "新文本");
    expect(useNotesStore.getState().tasks[0].checklist![0].text).toBe("新文本");
    useNotesStore.getState().updateChecklistItem(id, itemId, "   ");
    expect(useNotesStore.getState().tasks[0].checklist).toHaveLength(0);
  });

  it("deleteChecklistItem 删除指定项", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().addChecklistItem(id, "A");
    useNotesStore.getState().addChecklistItem(id, "B");
    const first = useNotesStore.getState().tasks[0].checklist![0].id;
    useNotesStore.getState().deleteChecklistItem(id, first);
    expect(useNotesStore.getState().tasks[0].checklist!.map((c) => c.text)).toEqual([
      "B",
    ]);
  });

  it("删除任务后撤销可恢复备注与检查列表", () => {
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().updateTaskNote(id, "备注");
    useNotesStore.getState().addChecklistItem(id, "子项");
    useNotesStore.getState().deleteTasks([id]);
    expect(useNotesStore.getState().tasks).toHaveLength(0);
    useNotesStore.getState().undo();
    const t = useNotesStore.getState().tasks[0];
    expect(t.note).toBe("备注");
    expect(t.checklist!.map((c) => c.text)).toEqual(["子项"]);
  });
});

describe("任务：闪念与分组", () => {
  beforeEach(reset);

  it("addTask 支持 spark 类型；sparkToTask 转正式待办", () => {
    const id = useNotesStore.getState().addTask("一个灵感", { kind: "spark" }).id!;
    expect(useNotesStore.getState().tasks[0].kind).toBe("spark");
    useNotesStore.getState().sparkToTask(id);
    const t = useNotesStore.getState().tasks[0];
    expect(t.kind).toBeUndefined();
    expect(t.status).toBe("todo");
  });

  it("addTask 指定分组；未知分组回落收集箱", () => {
    useNotesStore.getState().addTaskSection("工作");
    const g = useNotesStore.getState().taskSections[1];
    const a = useNotesStore.getState().addTask("入组", { sectionId: g.id }).id!;
    const b = useNotesStore.getState().addTask("孤儿", { sectionId: "ghost" }).id!;
    expect(useNotesStore.getState().tasks.find((t) => t.id === a)?.sectionId).toBe(g.id);
    expect(
      useNotesStore.getState().tasks.find((t) => t.id === b)?.sectionId
    ).toBeUndefined();
  });

  it("moveTasksToSection 移动；移回收集箱归一为 undefined", () => {
    useNotesStore.getState().addTaskSection("工作");
    const g = useNotesStore.getState().taskSections[1];
    const id = useNotesStore.getState().addTask("任务").id!;
    useNotesStore.getState().moveTasksToSection([id], g.id);
    expect(useNotesStore.getState().tasks[0].sectionId).toBe(g.id);
    useNotesStore.getState().moveTasksToSection([id], TASK_INBOX_ID);
    expect(useNotesStore.getState().tasks[0].sectionId).toBeUndefined();
  });

  it("reorderTasks 在数组内移动（分组内拖拽排序，同 reorderNotes 心智）", () => {
    const s = useNotesStore.getState();
    s.addTask("一");
    s.addTask("二");
    s.addTask("三");
    const [a, , c] = useNotesStore.getState().tasks; // 置顶插入：[三, 二, 一]
    useNotesStore.getState().reorderTasks(a.id, c.id);
    expect(useNotesStore.getState().tasks.map((t) => t.text)).toEqual([
      "二",
      "一",
      "三",
    ]);
  });

  it("deleteTaskSection：组内任务归收集箱、收集箱不可删、可撤销", () => {
    useNotesStore.getState().addTaskSection("临时");
    const g = useNotesStore.getState().taskSections[1];
    const id = useNotesStore.getState().addTask("组内", { sectionId: g.id }).id!;
    useNotesStore.getState().deleteTaskSection(g.id);
    expect(useNotesStore.getState().taskSections).toHaveLength(1);
    expect(useNotesStore.getState().tasks[0].sectionId).toBeUndefined();
    useNotesStore.getState().undo();
    expect(useNotesStore.getState().taskSections).toHaveLength(2);
    expect(useNotesStore.getState().tasks.find((t) => t.id === id)?.sectionId).toBe(
      g.id
    );
    useNotesStore.getState().deleteTaskSection(TASK_INBOX_ID);
    expect(
      useNotesStore.getState().taskSections.some((s) => s.id === TASK_INBOX_ID)
    ).toBe(true);
  });

  it("importMerge：taskSections 合并、任务孤儿分组兜底收集箱", () => {
    const r = useNotesStore.getState().importMerge({
      taskSections: [{ id: "ext-g", name: "外部组" }],
      tasks: [
        {
          id: "t1",
          text: "带组",
          status: "todo",
          priority: "none",
          dueAt: null,
          createdAt: 1,
          remindedAt: null,
          sectionId: "ext-g",
        },
        {
          id: "t2",
          text: "孤儿组",
          status: "todo",
          priority: "none",
          dueAt: null,
          createdAt: 2,
          remindedAt: null,
          sectionId: "nowhere",
        },
      ],
    });
    expect(r.tasks).toBe(2);
    const st = useNotesStore.getState();
    expect(st.taskSections.map((s) => s.id)).toEqual([TASK_INBOX_ID, "ext-g"]);
    expect(st.tasks.find((t) => t.id === "t1")?.sectionId).toBe("ext-g");
    expect(st.tasks.find((t) => t.id === "t2")?.sectionId).toBeUndefined();
  });
});

describe("剪贴板 tab：发送不标完成 / 清空 / 超龄清理", () => {
  beforeEach(reset);

  function addClip(text: string, createdAt?: number) {
    const id = useNotesStore.getState().addNote(text).id!;
    useNotesStore.setState({
      notes: useNotesStore.getState().notes.map((n) =>
        n.id === id
          ? { ...n, sectionId: CLIPBOARD_ID, ...(createdAt ? { createdAt } : {}) }
          : n
      ),
    });
    return id;
  }

  it("doneIdsAfterSend 排除剪贴板卡（历史流水无完成语义）", () => {
    const clip = addClip("剪贴板内容");
    const normal = useNotesStore.getState().addNote("普通笔记").id!;
    expect(doneIdsAfterSend(useNotesStore.getState(), [clip, normal])).toEqual([
      normal,
    ]);
  });

  it("clearClipHistory 清空非固定卡且可撤销", () => {
    const a = addClip("A");
    addClip("B");
    useNotesStore.getState().toggleNoteKeep(a); // 固定 A
    const r = useNotesStore.getState().clearClipHistory();
    expect(r.removed).toBe(1);
    expect(
      useNotesStore.getState().notes.filter((n) => n.sectionId === CLIPBOARD_ID)
    ).toHaveLength(1);
    useNotesStore.getState().undo();
    expect(
      useNotesStore.getState().notes.filter((n) => n.sectionId === CLIPBOARD_ID)
    ).toHaveLength(2);
  });

  it("pruneClipHistory 按保留时长清理超龄非固定卡；永久不清", () => {
    const old = addClip("过期", Date.now() - 10 * 86_400_000);
    const fresh = addClip("新鲜");
    const pinnedOld = addClip("固定过期", Date.now() - 10 * 86_400_000);
    useNotesStore.getState().toggleNoteKeep(pinnedOld);
    // 永久：不清
    useNotesStore.getState().setSettings({ clipRetentionDays: null });
    useNotesStore.getState().pruneClipHistory();
    expect(
      useNotesStore.getState().notes.filter((n) => n.sectionId === CLIPBOARD_ID)
    ).toHaveLength(3);
    // 7 天：只清超龄且未固定的
    useNotesStore.getState().setSettings({ clipRetentionDays: 7 });
    useNotesStore.getState().pruneClipHistory();
    const rest = useNotesStore
      .getState()
      .notes.filter((n) => n.sectionId === CLIPBOARD_ID)
      .map((n) => n.id)
      .sort();
    expect(rest).toEqual([fresh, pinnedOld].sort());
    expect(rest).not.toContain(old);
  });
});

describe("剪贴板分组不干扰默认落点与分组排序", () => {
  it("剪贴板组被顶到首位时，捕获默认仍落入首个非剪贴板分组", () => {
    useNotesStore.setState({
      sections: [
        { id: CLIPBOARD_ID, name: "剪贴板" },
        { id: INBOX_ID, name: "收件箱" },
      ],
      notes: [],
    });
    const { result, id } = useNotesStore.getState().addNote("捕获正文", {});
    expect(result).toBe("added");
    expect(
      useNotesStore.getState().notes.find((note) => note.id === id)?.sectionId
    ).toBe(INBOX_ID);
  });

  it("上下移分组跳过隐藏的剪贴板组，顶部分组上移为无操作", () => {
    useNotesStore.setState({
      sections: [
        { id: INBOX_ID, name: "收件箱" },
        { id: CLIPBOARD_ID, name: "剪贴板" },
        { id: "group-a", name: "A" },
      ],
      notes: [],
    });
    // 收件箱下移：应越过隐藏的剪贴板组，与可见的 A 组换位
    useNotesStore.getState().moveSection(INBOX_ID, 1);
    expect(useNotesStore.getState().sections.map((section) => section.id)).toEqual([
      CLIPBOARD_ID,
      "group-a",
      INBOX_ID,
    ]);
    // A 组现在是可见首位：继续上移不得与剪贴板组发生隐形换位
    useNotesStore.getState().moveSection("group-a", -1);
    expect(useNotesStore.getState().sections.map((section) => section.id)).toEqual([
      CLIPBOARD_ID,
      "group-a",
      INBOX_ID,
    ]);
  });
});

describe("标签与更新时间", () => {
  beforeEach(() => {
    useNotesStore.setState({
      sections: [{ id: INBOX_ID, name: "收件箱" }],
      notes: [],
      tasks: [],
      taskSections: [{ id: TASK_INBOX_ID, name: "收集箱" }],
      checkedIds: [],
      settings: defaultSettings(),
      undoStack: [],
    });
  });

  it("sanitizeNoteTags 去空白与前导 #、大小写去重保首个写法、双上限封顶", () => {
    expect(sanitizeNoteTags([" #工作 ", "工作", "WORK", "work", ""])).toEqual([
      "工作",
      "WORK",
    ]);
    expect(sanitizeNoteTags([])).toBeUndefined();
    expect(sanitizeNoteTags(["x".repeat(40)])).toEqual(["x".repeat(24)]);
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(sanitizeNoteTags(many)).toHaveLength(NOTE_TAG_MAX_COUNT);
  });

  it("setNoteTags 归一化覆写且不打 updatedAt；addNoteTags 批量并集", () => {
    useNotesStore.getState().addNote("甲");
    useNotesStore.getState().addNote("乙");
    const [b, a] = useNotesStore.getState().notes;
    useNotesStore.getState().setNoteTags(a.id, ["#前端", "前端", "架构"]);
    const tagged = useNotesStore.getState().notes.find((n) => n.id === a.id)!;
    expect(tagged.tags).toEqual(["前端", "架构"]);
    expect(tagged.updatedAt).toBeUndefined();

    useNotesStore.getState().addNoteTags([a.id, b.id], ["评审"]);
    const after = useNotesStore.getState().notes;
    expect(after.find((n) => n.id === a.id)!.tags).toEqual([
      "前端",
      "架构",
      "评审",
    ]);
    expect(after.find((n) => n.id === b.id)!.tags).toEqual(["评审"]);

    useNotesStore.getState().setNoteTags(a.id, []);
    expect(
      useNotesStore.getState().notes.find((n) => n.id === a.id)!.tags
    ).toBeUndefined();
  });

  it("编辑正文与重命名打 updatedAt；无变化的重命名不打", () => {
    useNotesStore.getState().addNote("原文");
    const id = useNotesStore.getState().notes[0].id;
    expect(useNotesStore.getState().notes[0].updatedAt).toBeUndefined();

    useNotesStore.getState().updateNoteText(id, "改后");
    const edited = useNotesStore.getState().notes[0];
    expect(edited.updatedAt).toBeGreaterThan(0);

    useNotesStore.getState().updateNoteTitle(id, "标题");
    const renamed = useNotesStore.getState().notes[0];
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(edited.updatedAt!);

    const stamp = renamed.updatedAt;
    useNotesStore.getState().updateNoteTitle(id, "标题");
    expect(useNotesStore.getState().notes[0].updatedAt).toBe(stamp);
  });

  it("合并笔记：标签取并集，合并产物打 updatedAt", () => {
    useNotesStore.getState().addNote("第二");
    useNotesStore.getState().addNote("第一");
    const [first, second] = useNotesStore.getState().notes;
    useNotesStore.getState().setNoteTags(first.id, ["工作"]);
    useNotesStore.getState().setNoteTags(second.id, ["工作", "评审"]);

    useNotesStore.getState().mergeNotes([first.id, second.id]);
    const merged = useNotesStore
      .getState()
      .notes.find((n) => n.id === first.id)!;
    expect(merged.tags).toEqual(["工作", "评审"]);
    expect(merged.updatedAt).toBeGreaterThan(0);
  });

  it("持久化归一化：非法 tags 拒绝，合法 tags/updatedAt 原样保留", () => {
    const base = {
      version: STORE_VERSION,
      state: {
        sections: [{ id: INBOX_ID, name: "收件箱" }],
        notes: [
          {
            id: "n1",
            text: "正文",
            sectionId: INBOX_ID,
            done: false,
            createdAt: 100,
            updatedAt: 200,
            tags: [" #工作 ", "评审"],
          },
        ],
      },
    };
    const decoded = decodePersistedState(JSON.stringify(base));
    expect(decoded.notes[0]).toMatchObject({
      updatedAt: 200,
      tags: ["工作", "评审"],
    });

    const bad = JSON.parse(JSON.stringify(base));
    bad.state.notes[0].tags = ["ok", 3];
    expect(() => decodePersistedState(JSON.stringify(bad))).toThrow(
      "note.tags"
    );
  });
});

describe("ensureSection（来源自动归组）", () => {
  it("同名分组复用其 id，否则新建一次", () => {
    const name = "消息-ensure-test";
    const before = useNotesStore.getState().sections.length;
    const id1 = useNotesStore.getState().ensureSection(name);
    const created = useNotesStore.getState().sections;
    expect(created.some((s) => s.id === id1 && s.name === name)).toBe(true);
    expect(created.length).toBe(before + 1);

    const id2 = useNotesStore.getState().ensureSection(name);
    expect(id2).toBe(id1);
    expect(useNotesStore.getState().sections.length).toBe(before + 1);
  });
});
