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
  it("只有 DeliveryDraft 执行器能调用原生 sendDelivery", () => {
    const callers = productionSources(srcRoot)
      .filter((file) => readFileSync(file, "utf8").includes("api.sendDelivery("))
      .map((file) => path.relative(srcRoot, file));

    expect(callers).toEqual([
      path.join("lib", "delivery", "executeDraft.ts"),
    ]);
  });

  it("最终正文只在 buildDeliveryDraft 组装，Tooltip 直接消费 finalText", () => {
    const actions = readFileSync(path.join(srcRoot, "lib", "actions.ts"), "utf8");
    const selection = readFileSync(
      path.join(srcRoot, "components", "SelectionBar.tsx"),
      "utf8"
    );
    const builder = readFileSync(
      path.join(srcRoot, "lib", "delivery", "buildDraft.ts"),
      "utf8"
    );
    const preflight = readFileSync(
      path.join(srcRoot, "lib", "delivery", "preflight.ts"),
      "utf8"
    );

    expect(actions).toContain("buildDeliveryDraft(");
    expect(actions).toContain("dispatchDeliveryDraft(");
    expect(preflight).toContain("executeDeliveryDraft");
    expect(actions).not.toMatch(/buildSendText\(|applyPromptTemplate\(|wrapAsCodeBlock\(/);
    expect(builder).toContain("buildSendText(");
    expect(builder).toContain("applyPromptTemplate(");
    expect(builder).toContain("wrapAsCodeBlock(");
    expect(selection).toContain("buildDeliveryDraft(");
    expect(selection).toContain("{previewDraft.finalText}");
    expect(selection).not.toContain("sendPreview(");
    expect(selection).toContain("revision: 0");
    expect(selection).not.toContain("nextDeliveryDraftRevision");
    expect(selection).toContain("promptSnippetId: sn.id");
    expect(selection).not.toContain("buildSendText(");
    expect(builder).not.toMatch(/Date\.now|crypto\.|useNotesStore|getState\(|localStorage|createJSONStorage/);
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

  it("快捷键与可见按钮共享 target store 门禁，发送前复核目标并交给 Native", () => {
    const actions = readFileSync(path.join(srcRoot, "lib", "actions.ts"), "utf8");
    const executor = readFileSync(
      path.join(srcRoot, "lib", "delivery", "executeDraft.ts"),
      "utf8"
    );
    const preflight = readFileSync(
      path.join(srcRoot, "lib", "delivery", "preflight.ts"),
      "utf8"
    );
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

    expect(actions).toContain("dispatchDeliveryDraft(");
    expect(preflight).toContain("executeDeliveryDraft");
    expect(executor).toContain("targetSendDisabled()");
    expect(executor).toContain("readTarget() : refreshTarget()");
    expect(executor).toContain("api.sendDelivery(");
    expect(app).toContain("void sendCheckedToChat()");
    expect(app).toContain("void sendNotesToChat([id])");
    expect(selection).toContain("useTargetStore");
    expect(preview).toContain("useTargetStore");
    expect(note).toContain("TargetSendMenuItem");
    expect(task).toContain("TargetSendMenuItem");
  });

  it("预检模态阻断主面板快捷键，数据上下文失效时同步清理正文会话", () => {
    const app = readFileSync(path.join(srcRoot, "App.tsx"), "utf8");
    const actions = readFileSync(path.join(srcRoot, "lib", "actions.ts"), "utf8");
    const composer = readFileSync(
      path.join(srcRoot, "components", "PreflightComposer.tsx"),
      "utf8"
    );

    expect(app).toContain("if (useDeliveryStore.getState().open) return;");
    expect(composer).toContain("event.stopImmediatePropagation()");
    expect(app).toContain("useDeliveryStore.getState().closeDraft()");
    expect(app).toContain("<SelectionBar compact={horizontalBar} />");
    expect(app).toContain("<PreflightComposer horizontal={horizontalBar} />");
    expect(readFileSync(path.join(srcRoot, "components", "TaskRow.tsx"), "utf8"))
      .toContain("sendTaskToChat(task.id, { forcePreflight: true })");
    expect(actions).toContain('preflightMode === "always"');
    expect(actions).toContain("!requiresPreflight &&");
  });

  it("SimpleMenu 方向键打开时消费事件，不穿透主面板焦点导航", () => {
    const menu = readFileSync(
      path.join(srcRoot, "components", "SimpleMenu.tsx"),
      "utf8"
    );

    expect(menu).toMatch(
      /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*initialFocusEdge/
    );
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
    // 多详情窗后 note-preview 是窗口级监听（emitTo 定向不串台）
    const previewListener = preview.indexOf(
      ".listen<NotePreviewPayload>("
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

  it("独立图片预览的快捷发送继续走主面板目标与预检链路", () => {
    const preview = readFileSync(path.join(srcRoot, "ImagePreviewView.tsx"), "utf8");
    const textPreview = readFileSync(path.join(srcRoot, "TextPreviewView.tsx"), "utf8");
    const richContent = readFileSync(
      path.join(srcRoot, "components", "RichNoteContent.tsx"),
      "utf8"
    );
    const overlay = readFileSync(
      path.join(srcRoot, "components", "PreviewOverlay.tsx"),
      "utf8"
    );
    const app = readFileSync(path.join(srcRoot, "App.tsx"), "utf8");
    const targetListener = preview.indexOf(
      "listen<TargetSnapshot>(TARGET_CHANGED_EVENT"
    );
    const previewListener = preview.indexOf(
      'listen<{\n      files: string[];'
    );

    expect(targetListener).toBeGreaterThanOrEqual(0);
    expect(previewListener).toBeGreaterThan(targetListener);
    expect(preview).toContain("void readTarget()");
    expect(preview).toContain('emitTo("main", "toskr://note-send"');
    expect(preview).toContain('id="image-preview-target-status"');
    expect(preview).toContain("disabled={!targetReady}");
    expect(preview).toContain("!imageEditing && !editing");
    expect(preview).toContain("noteId && dataGeneration !== null");
    expect(preview).toContain("发送整张卡片（含 ${files.length} 张图片）");
    expect(textPreview).toContain(
      "const imagePreviewSource = writable && !editing"
    );
    expect(textPreview).toContain("const imageEditContext");
    const editorSync = textPreview.indexOf(
      "const applied = await emitNoteEditWithAck"
    );
    const editorQuickLook = textPreview.indexOf(
      "await api.quickLook(files, index, undefined",
      editorSync
    );
    expect(editorSync).toBeGreaterThanOrEqual(0);
    expect(editorQuickLook).toBeGreaterThan(editorSync);
    expect(textPreview).toContain("previewSource={imagePreviewSource}");
    expect(richContent).toContain(
      "api.quickLook(files, index, previewSource, editContext)"
    );
    expect(overlay).toContain("previewSource={imagePreviewSource}");
    expect(app).toContain(
      'listen<{ id: string; dataGeneration: number; text?: string }>(\n        "toskr://note-send"'
    );
    // 片段发送：text 存在时以 overrideText 只发选中片段，仍以该卡为来源
    expect(app).toContain("void sendNotesToChat(\n          [e.payload.id],");
    expect(app).toContain("{ overrideText: e.payload.text }");
  });

  it("剪贴板卡内部追加由共享事件契约连接 actions 与文本编辑器", () => {
    const actions = readFileSync(path.join(srcRoot, "lib", "actions.ts"), "utf8");
    const preview = readFileSync(path.join(srcRoot, "TextPreviewView.tsx"), "utf8");

    expect(actions).toContain("NOTE_EDITOR_INSERT_EVENT");
    expect(actions).toContain('"textpreview",\n      NOTE_EDITOR_INSERT_EVENT');
    expect(preview).toContain("listen<NoteEditorInsertPayload>");
    expect(preview).toContain("NOTE_EDITOR_INSERT_EVENT");
    expect(preview).toContain("appendPreviewContent(");
    expect(actions).toContain("NOTE_EDITOR_INSERT_RESULT_EVENT");
    expect(actions).toContain("emitEditorInsert(() =>");
    expect(actions).toContain("lastDetailSessionId");
    expect(preview).toContain("editorInsertRejectionReason(currentNote, payload)");
    expect(preview).toContain("NOTE_EDITOR_INSERT_RESULT_EVENT,");
    expect(preview).toContain(").catch(() => {});");
  });

  it("未保存编辑草稿的图片进入媒体 GC 活动引用，保存或关闭后释放", () => {
    const actions = readFileSync(path.join(srcRoot, "lib", "actions.ts"), "utf8");
    const preview = readFileSync(path.join(srcRoot, "TextPreviewView.tsx"), "utf8");
    const app = readFileSync(path.join(srcRoot, "App.tsx"), "utf8");

    expect(actions).toContain("retainEditorOperationMedia(");
    expect(app).toContain("editorSessionMediaFiles()");
    expect(app).toContain("releaseEditorSessionMedia(e.payload.sessionId)");
    expect(preview).toContain("NOTE_EDITOR_SESSION_RELEASE_EVENT");
    expect(preview).toContain("sessionId: current.sessionId");
  });

  it("剪贴板页可在外部目标未就绪时进入内部编辑器路由", () => {
    const menu = readFileSync(
      path.join(srcRoot, "components", "TargetSendMenuItem.tsx"),
      "utf8"
    );
    const note = readFileSync(path.join(srcRoot, "components", "NoteCard.tsx"), "utf8");
    const selection = readFileSync(
      path.join(srcRoot, "components", "SelectionBar.tsx"),
      "utf8"
    );
    const overlay = readFileSync(
      path.join(srcRoot, "components", "PreviewOverlay.tsx"),
      "utf8"
    );

    expect(menu).toContain("ready || allowInternal");
    expect(note).toContain("allowInternal={note.sectionId === CLIPBOARD_ID}");
    expect(selection).toContain('page === "clipboard"');
    expect(overlay).toContain("targetReady || internalSendAvailable");
  });

  it("Profile 策略只有一个解析入口，旧 autoEnter 不再参与发送", () => {
    const actions = readFileSync(path.join(srcRoot, "lib", "actions.ts"), "utf8");
    const executor = readFileSync(
      path.join(srcRoot, "lib", "delivery", "executeDraft.ts"),
      "utf8"
    );
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
    expect(executor).toContain('draft.enterPolicy === "confirm"');
    // Lens 只消费统一 resolver，快速切换是独立决策浮层而非第二套匹配器
    expect(lens).toContain("TargetProfileQuickSwitch");
    expect(lens).toContain("shouldClearOpenQuickSwitchOverride");
    expect(lens).toContain("onSelectTemporary={onSelectProfile}");
    expect(lens).toContain("assignTargetProfileBundle");
    expect(lens).toContain("canPermanentlyAssignTargetProfileOverride");
    expect(lens).toContain("快速切换发送方案");
    expect(lens).toContain("原临时发送方案已暂停");
    expect(selection).toContain("当前提示词组 ·");
    expect(selection).toContain("其他模板");
    expect(selection).toContain("snippetMenu.remaining");
    expect(selection).toContain("setTargetProfileOverride");
  });

  it("Settings 分区：目标与发送方案主从管理，提示词仍在同区，伴随停靠独立", () => {
    const settings = readFileSync(path.join(srcRoot, "SettingsView.tsx"), "utf8");
    const manager = readFileSync(
      path.join(srcRoot, "components", "settings", "TargetProfileManager.tsx"),
      "utf8"
    );
    const editor = readFileSync(
      path.join(srcRoot, "components", "settings", "ProfileEditor.tsx"),
      "utf8"
    );
    const assignments = readFileSync(
      path.join(srcRoot, "components", "settings", "AppAssignmentPicker.tsx"),
      "utf8"
    );

    expect(settings).toContain('{ id: "target", label: "目标与发送方案"');
    expect(settings).toContain('{ id: "companion", label: "伴随停靠"');
    // 提示词不独立成区：snippets/prompts 深链仍落到目标与发送方案
    expect(settings).not.toContain('{ id: "snippets", label:');
    expect(settings).not.toContain('{ id: "prompts", label:');
    expect(settings).toContain('["snippets", "prompts"].includes(rawSection)');
    expect(settings).toContain("TargetProfileManager");
    expect(settings).not.toContain("TargetProfilesEditor");
    expect(settings).toContain("deletePromptGroup");
    expect(manager).toContain("CurrentTargetPreview");
    expect(manager).toContain("ProfileList");
    expect(manager).toContain("ProfileEditor");
    expect(manager).toContain("ProfileCreateSheet");
    expect(manager).toContain("ProfileConflictResolver");
    expect(manager).toContain("resolveTargetProfile({");
    expect(manager).toContain("settingsTargetAfterObservation");
    expect(manager).toContain("handledRequestSequence");
    expect(manager).toContain("requestSequence <= handledRequestSequence.current");
    expect(editor).toContain("previewSelectedProfile({");
    expect(editor).toContain("currentResolution");
    expect(settings).toContain("targetProfileId");
    expect(assignments).toContain("updateTargetProfileBundleIds(");
    expect(assignments).toContain("assignTargetProfileBundle(");
    expect(assignments.indexOf("const requestId = ++requestSequence.current")).toBeLessThan(
      assignments.indexOf("let liveProfiles = latestProfiles.current")
    );
    expect(manager).not.toMatch(/clipboard|paste|pressEnter/i);
  });

  it("发送方案 UI 共享单一事件监听，图标缓存且 50 项派生状态按输入引用复用", () => {
    const manager = readFileSync(
      path.join(srcRoot, "components", "settings", "TargetProfileManager.tsx"),
      "utf8"
    );
    const identity = readFileSync(
      path.join(srcRoot, "components", "settings", "useAppIdentity.ts"),
      "utf8"
    );
    const profileList = readFileSync(
      path.join(srcRoot, "components", "settings", "ProfileList.tsx"),
      "utf8"
    );
    const applicationIcon = readFileSync(
      path.join(srcRoot, "components", "ApplicationIcon.tsx"),
      "utf8"
    );

    expect(manager.match(/listen<TargetSnapshot>/g)).toHaveLength(1);
    expect(manager).not.toContain("setInterval");
    expect(manager).toContain("latestTargetRevision");
    expect(manager).toContain("snapshot.revision < latestTargetRevision.current");
    expect(identity).toContain("const appInfoCache = new Map");
    expect(identity).toContain("appInfoCache.get(bundleId)");
    expect(identity).toContain("appInfoCache.set(bundleId, request)");
    expect(identity).toContain("resolved?.bundleId === bundleId");
    expect(applicationIcon).toContain("onError");
    expect(profileList).toContain("profileReorderAvailability(profiles, defaultProfileId)");
    expect(profileList).toContain("useMemo(");
  });

  it("用户界面不再暴露旧发送术语或缩写标签", () => {
    const relatedSources = [
      "components/TargetLensBar.tsx",
      "components/TargetProfileQuickSwitch.tsx",
      "components/SelectionBar.tsx",
      "components/settings/AppAssignmentPicker.tsx",
      "components/settings/CurrentTargetPreview.tsx",
      "components/settings/DeliveryPolicySummary.tsx",
      "components/settings/DeliveryTrack.tsx",
      "components/settings/ProfileCreateSheet.tsx",
      "components/settings/ProfileEditor.tsx",
      "components/settings/ProfileList.tsx",
    ].map((file) => readFileSync(path.join(srcRoot, file), "utf8"));

    for (const source of relatedSources) {
      expect(source).not.toMatch(/["'`]Profile["'`]/);
      expect(source).not.toMatch(/Target Profiles|Prompt Group|Enter Policy|Privacy Policy/);
      expect(source).not.toMatch(/回车：|粘贴后：|发送后：|发送后面板|目标不可用|隐私未检查/);
      expect(source).not.toMatch(/["'`]未识别应用默认["'`]|默认项固定/);
    }
  });

  it("受控新建 Sheet 关闭后把焦点交还原触发按钮", () => {
    const manager = readFileSync(
      path.join(srcRoot, "components", "settings", "TargetProfileManager.tsx"),
      "utf8"
    );
    const list = readFileSync(
      path.join(srcRoot, "components", "settings", "ProfileList.tsx"),
      "utf8"
    );
    const sheet = readFileSync(
      path.join(srcRoot, "components", "settings", "ProfileCreateSheet.tsx"),
      "utf8"
    );

    expect(manager).toContain("createReturnFocusRef");
    expect(list).toContain("onCreate(event.currentTarget)");
    expect(sheet).toContain("onCloseAutoFocus");
    expect(sheet).toContain("returnFocusRef.current?.focus()");
  });

  it("冲突修复按钮消失后把焦点移到下一修复动作或保留方案", () => {
    const resolver = readFileSync(
      path.join(srcRoot, "components", "settings", "ProfileConflictResolver.tsx"),
      "utf8"
    );

    expect(resolver).toContain("focusAfterConflictResolution");
    expect(resolver).toContain("data-profile-conflict-action");
    expect(resolver).toContain("data-profile-select");
    expect(resolver).toContain("data-profile-list-focus-fallback");
  });

  it("设置页下拉菜单使用真实语义、方向键并在关闭后恢复触发焦点", () => {
    const menu = readFileSync(
      path.join(srcRoot, "components", "SimpleMenu.tsx"),
      "utf8"
    );
    const select = readFileSync(
      path.join(srcRoot, "components", "SimpleSelect.tsx"),
      "utf8"
    );

    expect(menu).toContain('role={menuRole === "listbox" ? "option" : "menuitem"}');
    expect(menu).toContain('["ArrowDown", "ArrowUp", "Home", "End"]');
    expect(menu).toContain("restoreTriggerFocus");
    expect(select).toContain('menuRole="listbox"');
    expect(select).toContain("aria-controls={controls}");
  });

  it("Popover 与 Sheet 的 Reduce Motion 覆盖状态选择器动效", () => {
    const popover = readFileSync(
      path.join(srcRoot, "components", "ui", "popover.tsx"),
      "utf8"
    );
    const sheet = readFileSync(
      path.join(srcRoot, "components", "settings", "ProfileCreateSheet.tsx"),
      "utf8"
    );
    const lens = readFileSync(
      path.join(srcRoot, "components", "TargetLensBar.tsx"),
      "utf8"
    );
    const targetPreview = readFileSync(
      path.join(srcRoot, "components", "settings", "CurrentTargetPreview.tsx"),
      "utf8"
    );
    const menu = readFileSync(
      path.join(srcRoot, "components", "SimpleMenu.tsx"),
      "utf8"
    );
    const segmented = readFileSync(
      path.join(srcRoot, "components", "ui", "segmented.tsx"),
      "utf8"
    );
    const iconButton = readFileSync(
      path.join(srcRoot, "components", "ui", "icon-button.tsx"),
      "utf8"
    );

    expect(popover).toContain("motion-reduce:!animate-none");
    expect(sheet.match(/motion-reduce:!animate-none/g)).toHaveLength(2);
    expect(menu).toContain("motion-reduce:!animate-none");
    expect(segmented).toContain("motion-reduce:transition-none");
    expect(iconButton).toContain("motion-reduce:active:scale-100");
    expect(lens).not.toContain("animate-spin");
    expect(targetPreview).not.toContain("animate-spin");
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
