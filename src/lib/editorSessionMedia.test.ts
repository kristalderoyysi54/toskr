import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearEditorSessionMedia,
  editorSessionMediaFiles,
  releaseEditorOperationMedia,
  releaseEditorSessionMedia,
  retainEditorOperationMedia,
  subscribeEditorMediaReleases,
} from "./editorSessionMedia";

describe("编辑会话媒体引用", () => {
  beforeEach(clearEditorSessionMedia);

  it("按会话与操作持有图片，重试同一操作不会增加重复引用", () => {
    retainEditorOperationMedia("session-1", "operation-1", 7, [
      "clip.png",
      "clip.png",
    ]);
    retainEditorOperationMedia("session-1", "operation-1", 7, ["clip.png"]);

    expect(editorSessionMediaFiles()).toEqual(["clip.png"]);
  });

  it("释放操作或整个会话时通知 GC，并携带原数据代际", () => {
    const released = vi.fn();
    const stop = subscribeEditorMediaReleases(released);
    retainEditorOperationMedia("session-1", "operation-1", 7, ["a.png"]);
    retainEditorOperationMedia("session-1", "operation-2", 7, ["b.png"]);

    releaseEditorOperationMedia("session-1", "operation-1");
    expect(editorSessionMediaFiles()).toEqual(["b.png"]);
    expect(released).toHaveBeenLastCalledWith({
      files: ["a.png"],
      dataGeneration: 7,
    });

    releaseEditorSessionMedia("session-1");
    expect(editorSessionMediaFiles()).toEqual([]);
    expect(released).toHaveBeenLastCalledWith({
      files: ["b.png"],
      dataGeneration: 7,
    });
    stop();
  });

  it("数据目录失效时只清旧代际内存引用，不向新目录发送释放任务", () => {
    const released = vi.fn();
    const stop = subscribeEditorMediaReleases(released);
    retainEditorOperationMedia("session-1", "operation-1", 7, ["clip.png"]);

    clearEditorSessionMedia();

    expect(editorSessionMediaFiles()).toEqual([]);
    expect(released).not.toHaveBeenCalled();
    stop();
  });
});
