import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(srcRoot, "..");
const source = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");

describe("数据事务架构门禁", () => {
  it("目录指针只通过两阶段事务 API 修改", () => {
    const operations = source("src/lib/dataOperations.ts");
    const tauri = source("src/lib/tauri.ts");
    const commands = source("src-tauri/src/commands.rs");
    const registration = source("src-tauri/src/lib.rs");

    expect(operations).toContain("api.beginDataOperation(plan)");
    expect(operations).toContain("rehydrateFromActiveDataDir");
    expect(operations).toContain("api.finalizeDataOperation");
    expect(operations).toContain("api.rollbackDataOperation");
    expect(tauri).toContain('invoke<DataOperationResult>("begin_data_operation"');
    expect(commands).not.toMatch(/pub fn (set_data_dir|reset_data_dir|write_data_file)/);
    expect(registration).toContain("commands::begin_data_operation");
    expect(registration).toContain("commands::finalize_data_operation");
    expect(registration).toContain("commands::rollback_data_operation");
  });

  it("main 与 Settings 使用同一个全窗口目录变化事件", () => {
    const operations = source("src/lib/dataOperations.ts");
    const settings = source("src/SettingsView.tsx");
    const commands = source("src-tauri/src/commands.rs");

    expect(operations).toContain(
      'DATA_LOCATION_CHANGED_EVENT = "toskr://data-location-changed"'
    );
    expect(settings).toContain("listen(DATA_LOCATION_CHANGED_EVENT");
    expect(commands.match(/app\.emit\("toskr:\/\/data-location-changed"/g)).toHaveLength(2);
    expect(operations).toContain("emit(DATA_ACTIVITY_EVENT");
    expect(source("src/TextPreviewView.tsx")).toContain("DataReadOnlyGuard");
    expect(source("src/ImagePreviewView.tsx")).toContain("DataReadOnlyGuard");
  });

  it("Settings 解锁快照与使用记录读取共享同一数据操作状态", () => {
    const settings = source("src/SettingsView.tsx");
    const outcome = source("src/components/settings/OutcomeInsightsSection.tsx");

    expect(settings).toContain("const dataActivity = useDataOperationStore()");
    expect(settings).toContain(
      "useDataOperationStore.getState().update(event.payload)"
    );
    expect(settings).not.toContain("const [dataActivity, setDataActivity]");
    expect(settings).toContain("Promise.all([un, unSection, unDataActivity])");
    expect(outcome).toContain(
      "const dataLocked = useDataOperationStore((state) => state.locked)"
    );
    expect(outcome).toContain("if (dataLocked) return");
  });

  it("存储初始化失败仍保留专用的有效目录恢复入口", () => {
    const operations = source("src/lib/dataOperations.ts");
    const settings = source("src/SettingsView.tsx");
    const settingsSync = source("src/lib/settingsSync.ts");
    const tauri = source("src/lib/tauri.ts");

    expect(settingsSync).toContain("SETTINGS_DATA_RECOVERY_OPERATION");
    expect(settings).toContain("status?.initializationFailure");
    expect(settings).toContain("SETTINGS_DATA_RECOVERY_OPERATION");
    expect(settings).toContain(
      "activity.locked && !status?.initializationFailure"
    );
    expect(operations).toContain("api.beginRecoveryDataOperation(plan)");
    expect(tauri).toContain('invoke<DataOperationResult>("begin_recovery_data_operation"');

    // 主面板只读遮罩在可恢复态必须提供跳转设置数据分区的引导入口
    const app = source("src/App.tsx");
    expect(app).toContain("前往设置处理");
    expect(app).toContain('emitTo("settings", SETTINGS_SECTION, "data")');
  });

  it("冲突标记与解锁后的运行态 ready 信号不会依赖瞬时 HUD", () => {
    const app = source("src/App.tsx");
    const operations = source("src/lib/dataOperations.ts");
    const settings = source("src/SettingsView.tsx");
    const tauri = source("src/lib/tauri.ts");

    expect(app).toContain(".markDataConflict()");
    expect(tauri).toContain('invoke<void>("mark_data_conflict")');
    expect(settings).toContain('event.payload.phase === "conflict"');
    expect(operations).toContain("DATA_RUNTIME_READY_EVENT");
    expect(operations).toContain(
      "window.dispatchEvent(new Event(DATA_RUNTIME_READY_EVENT))"
    );
  });

  it("冻结期间捕获、剪贴板、详情编辑、键盘与设置写入均 fail closed", () => {
    const app = source("src/App.tsx");
    const settingsSync = source("src/lib/settingsSync.ts");

    expect(app.match(/if \(isDataOperationLocked\(\)\) return;/g).length).toBeGreaterThanOrEqual(8);
    expect(app).toContain("数据暂时只读");
    expect(app.match(/locked: isDataOperationLocked\(\)/g).length).toBeGreaterThanOrEqual(1);
    expect(source("src/lib/dataGeneration.ts")).toContain(
      "DATA_CONTEXT_INVALIDATED_EVENT"
    );
    expect(source("src/TextPreviewView.tsx")).toContain(
      "DATA_CONTEXT_INVALIDATED_EVENT"
    );
    expect(source("src/ImagePreviewView.tsx")).toContain(
      "DATA_CONTEXT_INVALIDATED_EVENT"
    );
    expect(settingsSync).toContain("if (isDataOperationLocked())");
    expect(settingsSync).toContain("数据操作进行中，设置暂时只读");
  });

  it("媒体实体只经延迟 GC 删除，不暴露直接 removeImage command", () => {
    const app = source("src/App.tsx");
    const tauri = source("src/lib/tauri.ts");
    const commands = source("src-tauri/src/commands.rs");

    expect(app).toContain("scheduleMediaGc");
    expect(app).toContain("runScheduledMediaGc");
    expect(tauri).not.toContain("removeImage:");
    expect(commands).not.toMatch(/pub fn remove_image/);
  });
});
