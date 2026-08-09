import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(srcRoot, "..");

function productionSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return productionSources(file);
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) {
      return [];
    }
    return [file];
  });
}

describe("发送入口路由", () => {
  it("只有 actions 能调用原生 sendDelivery", () => {
    const callers = productionSources(srcRoot)
      .filter((file) => readFileSync(file, "utf8").includes("api.sendDelivery("))
      .map((file) => path.relative(srcRoot, file));

    expect(callers).toEqual([path.join("lib", "actions.ts")]);
  });

  it.each([
    ["App.tsx", "sendCheckedToChat"],
    ["App.tsx", "sendNotesToChat"],
    ["components/NoteCard.tsx", "sendNotesToChat"],
    ["components/SelectionBar.tsx", "sendCheckedToChat"],
    ["components/TaskRow.tsx", "sendTaskToChat"],
    ["components/PreviewOverlay.tsx", "sendNotesToChat"],
  ])("%s 的快捷/按钮入口委托 %s", (relativeFile, action) => {
    expect(readFileSync(path.join(srcRoot, relativeFile), "utf8")).toContain(action);
  });

  it("快捷键与可见按钮共享 target store 门禁，发送前仍刷新并交给 Native", () => {
    const actions = readFileSync(path.join(srcRoot, "lib", "actions.ts"), "utf8");
    const app = readFileSync(path.join(srcRoot, "App.tsx"), "utf8");
    const selection = readFileSync(
      path.join(srcRoot, "components", "SelectionBar.tsx"),
      "utf8"
    );
    const preview = readFileSync(
      path.join(srcRoot, "components", "PreviewOverlay.tsx"),
      "utf8"
    );
    const note = readFileSync(path.join(srcRoot, "components", "NoteCard.tsx"), "utf8");
    const task = readFileSync(path.join(srcRoot, "components", "TaskRow.tsx"), "utf8");

    expect(actions).toContain("targetSendDisabled()");
    expect(actions).toContain("await refreshTarget()");
    expect(actions).toContain("api.sendDelivery(");
    expect(app).toContain("void sendCheckedToChat()");
    expect(app).toContain("void sendNotesToChat([id])");
    expect(selection).toContain("useTargetStore");
    expect(preview).toContain("useTargetStore");
    expect(note).toContain("TargetSendMenuItem");
    expect(task).toContain("TargetSendMenuItem");
  });

  it("目标变化由 Rust 事件驱动，前端 target store 不增加轮询", () => {
    const store = readFileSync(path.join(srcRoot, "store", "targetStore.ts"), "utf8");
    const app = readFileSync(path.join(srcRoot, "App.tsx"), "utf8");
    const target = readFileSync(
      path.join(repoRoot, "src-tauri", "src", "target.rs"),
      "utf8"
    );

    expect(app).toContain("listen<TargetSnapshot>(TARGET_CHANGED_EVENT");
    expect(target).toContain("target_event_changed");
    expect(target).toContain("TARGET_CHANGED_EVENT");
    expect(store).not.toContain("setInterval");
  });

  it("Pin 失焦同步进入 observation pending，焦点回到 Toskr 不得复活旧目标", () => {
    const store = readFileSync(path.join(srcRoot, "store", "targetStore.ts"), "utf8");
    const app = readFileSync(path.join(srcRoot, "App.tsx"), "utf8");
    const target = readFileSync(
      path.join(repoRoot, "src-tauri", "src", "target.rs"),
      "utf8"
    );

    expect(app).toContain("beginTargetBlurObservation()");
    expect(app).toContain("void observeTargetAfterBlur()");
    expect(app).toContain("!targetObservationPending()");
    expect(store).toContain("if (targetObservationPending()) return observeTargetAfterBlur()");
    expect(target).toContain("pending_observation_after");
    expect(target).toContain("require_observation_after");
  });

  it("Toskr 自家辅助窗有明确焦点证据，不误触外部目标 pending", () => {
    const commands = readFileSync(
      path.join(repoRoot, "src-tauri", "src", "commands.rs"),
      "utf8"
    );

    expect(commands).toContain("internal_aux_window_focused");
    for (const label of ["settings", "textpreview", "imgpreview"]) {
      expect(commands).toContain(`"${label}"`);
    }
    expect(commands).toContain("window.is_focused()");
    expect(commands).toContain("revalidate_observed_target(&app)");
  });

  it("所有 Toskr 窗口共享 NSWorkspace 外部应用激活事件，不依赖 250ms 轮询", () => {
    const focus = readFileSync(
      path.join(repoRoot, "src-tauri", "src", "focus.rs"),
      "utf8"
    );
    const lib = readFileSync(path.join(repoRoot, "src-tauri", "src", "lib.rs"), "utf8");

    expect(focus).toContain("NSWorkspaceDidActivateApplicationNotification");
    expect(focus).toContain("NSWorkspaceApplicationKey");
    expect(focus).toContain("install_workspace_activation_observer");
    expect(focus).toContain("target::observe_front");
    expect(lib).toContain("focus::install_workspace_activation_observer");
  });

  it("独立文本预览先订阅目标事件，并只读同步可丢弃的旧响应", () => {
    const preview = readFileSync(path.join(srcRoot, "TextPreviewView.tsx"), "utf8");
    const targetListener = preview.indexOf(
      "listen<TargetSnapshot>(TARGET_CHANGED_EVENT"
    );
    const previewListener = preview.indexOf(
      'listen<NotePreviewPayload>("toskr://note-preview"'
    );

    expect(targetListener).toBeGreaterThanOrEqual(0);
    expect(previewListener).toBeGreaterThan(targetListener);
    expect(preview).toContain("void readTarget()");
    expect(preview).not.toContain("void refreshTarget()");
    expect(preview).not.toContain("getTargetSnapshot().then(applyTargetEvent)");
    expect(preview).toContain('id="text-preview-target-status"');
    expect(preview).toContain('aria-live="polite"');
    expect(preview).toContain("targetBlockMessage(state.status, state.reason)");
    expect(preview).toContain('"text-preview-target-status"');
  });

  it("Profile 策略只有一个解析入口，旧 autoEnter 不再参与投递", () => {
    const actions = readFileSync(path.join(srcRoot, "lib", "actions.ts"), "utf8");
    const lens = readFileSync(
      path.join(srcRoot, "components", "TargetLensBar.tsx"),
      "utf8"
    );
    const selection = readFileSync(
      path.join(srcRoot, "components", "SelectionBar.tsx"),
      "utf8"
    );

    expect(actions).toContain("currentTargetProfileResolution()");
    expect(actions).not.toContain("settings.autoEnter");
    expect(actions).toContain('enterPolicy === "confirm"');
    // SimpleSelect 组件经 ariaLabel prop 落到触发钮的 aria-label（渲染级断言在 TargetLensBar.test.tsx）
  expect(lens).toContain('ariaLabel="本次投递 Profile"');
    expect(lens).toContain("目标已变化，请确认 Profile");
    expect(selection).toContain("当前分组 ·");
    expect(selection).toContain("全部模板");
    expect(selection).toContain("setTargetProfileOverride");
  });

  it("Settings 分区：目标与模板合并（Profile+Prompt），伴随停靠独立（用户指定）", () => {
    const settings = readFileSync(path.join(srcRoot, "SettingsView.tsx"), "utf8");

    expect(settings).toContain('{ id: "target", label: "目标与模板"');
    expect(settings).toContain('{ id: "companion", label: "伴随停靠"');
    // 模板不独立成区：snippets/prompts 深链都落到目标与模板
    expect(settings).not.toContain('{ id: "snippets", label:');
    expect(settings).not.toContain('{ id: "prompts", label:');
    expect(settings).toContain('["snippets", "prompts"].includes(e.payload)');
    expect(settings).toContain("TargetProfilesEditor");
    expect(settings).toContain("findDuplicateBundleAssignments");
    expect(settings).toContain("deletePromptGroup");
    expect(settings).toContain("把当前投递目标加入 Profile");
  });
});

describe("剪贴板事务架构", () => {
  const rustSource = (file) =>
    readFileSync(path.join(repoRoot, "src-tauri", "src", file), "utf8");

  it("发送与捕获共享唯一 PasteboardTransaction 实现", () => {
    const pasteboard = rustSource("pasteboard.rs");
    const delivery = rustSource("delivery.rs");
    const capture = rustSource("capture.rs");
    const clipwatch = rustSource("clipwatch.rs");
    const commands = rustSource("commands.rs");
    const tap = rustSource(path.join("input", "tap.rs"));
    const synth = rustSource(path.join("input", "synth.rs"));

    expect(pasteboard).toContain("pub struct PasteboardTransaction");
    expect(pasteboard).toContain("struct PasteboardSnapshot");
    expect(delivery).toContain("PasteboardTransaction");
    expect(capture).toContain("PasteboardTransaction");
    expect(delivery).toContain("pasteboard::try_claim(&app)");
    expect(capture).toContain("pasteboard::try_claim(app)");
    expect(clipwatch).toContain("pasteboard::try_claim(&app)");
    expect(delivery.match(/still_owns_current\(\)/g)).toHaveLength(2);
    expect(capture).toContain("RECOVERY_GRACE_ATTEMPTS");
    expect(capture).toContain("physical_input_generation");
    expect(tap).toContain("EVENT_SOURCE_MARKER");
    expect(synth).toContain("event_source_user_data = Some(EVENT_SOURCE_MARKER)");
    expect(commands.match(/pasteboard::try_claim\(&app\)/g)).toHaveLength(2);
    expect(commands.match(/mark_self_write_count\(&app, exact_count\)/g)).toHaveLength(2);
    expect(delivery).not.toContain("struct PasteboardSnapshot");
    expect(capture).not.toContain("struct PasteboardSnapshot");
  });

  it("pasteboard 原始内容不会进入诊断，捕获回执也不记录 preview", () => {
    const pasteboard = rustSource("pasteboard.rs");
    const commands = rustSource("commands.rs");

    expect(pasteboard).not.toContain("diag::");
    expect(commands).not.toContain('format!("入库回执: {kind}「{preview}」")');
  });
});
