import { describe, expect, it, vi } from "vitest";

import {
  legacyAiApiKey,
  migrateLegacyAiApiKey,
  withoutLegacyAiApiKey,
} from "./aiKeyMigration";
import { defaultSettings, type Settings } from "@/store/notesStore";

function withLegacyKey(key: string): Settings {
  return { ...defaultSettings(), aiApiKey: key } as Settings;
}

describe("legacy AI key migration", () => {
  it("成功写入 Keychain 后才提交无密钥 settings", async () => {
    const source = withLegacyKey("sk-legacy-success");
    const setAiApiKey = vi.fn(async () => ({
      configured: true,
      updatedAtMs: 123,
    }));
    const commit = vi.fn();

    await expect(
      migrateLegacyAiApiKey(source, { setAiApiKey, commit })
    ).resolves.toBe("migrated");

    expect(setAiApiKey).toHaveBeenCalledWith("sk-legacy-success", false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).not.toHaveProperty("aiApiKey");
    expect(source).toHaveProperty("aiApiKey", "sk-legacy-success");
  });

  it("Keychain 写入失败时保留唯一旧副本且不提交清理", async () => {
    const source = withLegacyKey("sk-legacy-recovery");
    const commit = vi.fn();

    await expect(
      migrateLegacyAiApiKey(source, {
        setAiApiKey: vi.fn(async () => {
          throw new Error("keychain unavailable");
        }),
        commit,
      })
    ).resolves.toBe("failed");

    expect(commit).not.toHaveBeenCalled();
    expect(legacyAiApiKey(source)).toBe("sk-legacy-recovery");
  });

  it("空旧字段不会触发迁移，清理函数不改其他未知字段", async () => {
    const source = {
      ...withLegacyKey("  "),
      futureSetting: "kept",
    } as Settings;
    const setAiApiKey = vi.fn();
    const commit = vi.fn();

    await expect(
      migrateLegacyAiApiKey(source, { setAiApiKey, commit })
    ).resolves.toBe("none");
    expect(setAiApiKey).not.toHaveBeenCalled();
    expect(
      withoutLegacyAiApiKey({ ...source, aiApiKey: "sk-x" } as Settings)
    ).toMatchObject({ futureSetting: "kept" });
  });
});
