import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMessageWatchBridgeScript,
  formatMessageWatchNote,
} from "@/lib/messageWatch";
import type { MessageWatchCapture } from "@/lib/tauri";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("IM实验监听", () => {
  it("笔记摘要保留群、发送者、命中原因、正文与唯一标识", () => {
    const message: MessageWatchCapture = {
      conversationId: "group-1",
      messageId: "message-1",
      conversationName: "项目群",
      senderUid: "42",
      senderName: "关注的人",
      occurredAtMs: 1_765_000_000_000,
      receivedAtMs: 1_765_000_000_100,
      mentionedSelf: true,
      followedSender: true,
      matchedRuleIds: [],
      isGroup: true,
      messageType: "text",
      text: "第一行\n第二行",
      context: [],
    };

    const note = formatMessageWatchNote(message);
    expect(note).toContain("【项目群】");
    expect(note).toContain("关注的人 · @我 + 特别关注");
    expect(note).toContain("第一行\n第二行");
    expect(note).toContain("消息标识：message-1");
  });

  it("DevTools 桥只读内部 store，并提交完整 raw 对象", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const fakeWindow = {
      __ccImStore__: {
        state: {
          message: {
            messageInfo: new Map([
              [
                "message-1",
                {
                  msg_id: "message-1",
                  session_id: "group-1",
                  from_uid: "42",
                  from_name: "关注的人",
                  at_me_msg: 1,
                  msg_time: 2,
                  msg: { dt: [{ text: "完整正文" }], extra: { untouched: true } },
                },
              ],
            ]),
            messageList: new Map([["group-1", [{ id: "message-1" }]]]),
          },
          session: {
            sessionInfo: new Map([["group-1", { gid: "group-1", name: "项目群" }]]),
          },
        },
      },
      __ccMainStore__: { state: { login: { uid: "self" }, msgTrain: { followUsers: [] } } },
    } as Record<string, unknown>;
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "info").mockImplementation(() => {});

    const script = buildMessageWatchBridgeScript({
      endpoint: "http://127.0.0.1:3210/v1/im/test-token",
      sessionStartedAtMs: 1_000,
    });
    new Function(script)();
    await Promise.resolve();
    const status = (
      fakeWindow.__toskrMessageWatchV1 as { status: () => { active: boolean } }
    ).status();

    expect(status.active).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.text).toBe("完整正文");
    expect(body.mentionedSelf).toBe(true);
    expect(body.raw.message.msg.extra.untouched).toBe(true);
    expect(script).not.toContain("readUids");
    expect(script).not.toContain("GoSetSessionRead");
    (fakeWindow.__toskrMessageWatchV1 as { stop: () => void }).stop();
  });

  it("CDP 传输经 __toskrEmit binding 回传，且不触发 fetch", async () => {
    const fetch = vi.fn();
    const emit = vi.fn();
    const fakeWindow = {
      __ccImStore__: {
        state: {
          message: {
            messageInfo: new Map([
              [
                "message-1",
                {
                  msg_id: "message-1",
                  session_id: "group-1",
                  from_uid: "42",
                  from_name: "关注的人",
                  at_me_msg: 1,
                  msg_time: 2,
                  msg: { dt: [{ text: "完整正文" }] },
                },
              ],
            ]),
            messageList: new Map([["group-1", [{ id: "message-1" }]]]),
          },
          session: {
            sessionInfo: new Map([["group-1", { gid: "group-1", name: "项目群" }]]),
          },
        },
      },
      __ccMainStore__: {
        state: { login: { uid: "self" }, msgTrain: { followUsers: [] } },
      },
    } as Record<string, unknown>;
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("__toskrEmit", emit);
    vi.spyOn(console, "info").mockImplementation(() => {});

    const script = buildMessageWatchBridgeScript(
      {
        endpoint: "http://127.0.0.1:3210/v1/im/test-token",
        sessionStartedAtMs: 1_000,
      },
      "cdp"
    );
    new Function(script)();
    await Promise.resolve();
    await Promise.resolve();

    expect(emit).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    const body = JSON.parse(String(emit.mock.calls[0][0]));
    expect(body.text).toBe("完整正文");
    expect(body.mentionedSelf).toBe(true);
    (fakeWindow.__toskrMessageWatchV1 as { stop: () => void }).stop();
  });

  it("临时观察钩子透传IM原方法，并捕获其已归类的完整消息体", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const original = vi.fn();
    const fakeWindow = {
      __ccImStore__: {
        state: {
          message: { messageInfo: new Map(), messageList: new Map() },
          session: { sessionInfo: new Map() },
        },
      },
      __ccMainStore__: {
        state: {
          loginInfo: { loginInfo: new Map([["uid", "self"]]) },
          msgTrain: { items: [], followUsers: new Map() },
        },
        action: { msgTrain: { addAtMeMsg: original, addFollowMsg: vi.fn() } },
      },
    } as Record<string, any>;
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "info").mockImplementation(() => {});

    new Function(
      buildMessageWatchBridgeScript({
        endpoint: "http://127.0.0.1:3210/v1/im/test-token",
        sessionStartedAtMs: 1_000,
      })
    )();
    const signal: Record<string, any> = {
      name: "项目群",
      to_gid: "group-1",
      svr_msg_id: "server-1",
      from_uid: "42",
      from_name: "关注的人",
      send_time: 2,
      msg_type: "1",
      content: "由IM解析的完整正文",
      msg_body: JSON.stringify({ dt: [{ txt: { v: "由IM解析的完整正文" } }] }),
      untouched: { rich: true },
    };
    let deep: Record<string, unknown> = { leaf: "80 层后的原字段" };
    for (let index = 0; index < 80; index += 1) deep = { next: deep };
    signal.untouched = { rich: true, deep };
    fakeWindow.__ccMainStore__.action.msgTrain.addAtMeMsg(signal);
    await Promise.resolve();

    expect(original).toHaveBeenCalledWith(signal);
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body));
    expect(body.text).toBe("由IM解析的完整正文");
    expect(body.mentionedSelf).toBe(true);
    expect(body.raw.signal.msg_body).toBe(signal.msg_body);
    expect(body.raw.signal.untouched.rich).toBe(true);
    let capturedDeep = body.raw.signal.untouched.deep;
    for (let index = 0; index < 80; index += 1) capturedDeep = capturedDeep.next;
    expect(capturedDeep.leaf).toBe("80 层后的原字段");
    (fakeWindow.__toskrMessageWatchV1 as { stop: () => void }).stop();
    expect(fakeWindow.__ccMainStore__.action.msgTrain.addAtMeMsg).toBe(original);
  });

  it("初次安装不回灌开启前的旧消息", () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const fakeWindow = {
      __ccImStore__: {
        state: {
          message: {
            messageInfo: new Map([
              ["old", { msg_id: "old", session_id: "g", at_me_msg: 1, msg_time: 1 }],
            ]),
            messageList: new Map([["g", [{ id: "old" }]]]),
          },
          session: { sessionInfo: new Map([["g", { gid: "g" }]]) },
        },
      },
      __ccMainStore__: { state: { login: { uid: "self" } } },
    } as Record<string, unknown>;
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "info").mockImplementation(() => {});

    new Function(
      buildMessageWatchBridgeScript({
        endpoint: "http://127.0.0.1:3210/v1/im/test-token",
        sessionStartedAtMs: 10_000,
      })
    )();

    expect(fetch).not.toHaveBeenCalled();
    (fakeWindow.__toskrMessageWatchV1 as { stop: () => void }).stop();
  });

  it("Toskr 关闭接收端后，心跳会停止观察并恢复IM原方法", async () => {
    vi.useFakeTimers();
    const original = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 410 });
    const fakeWindow = {
      __ccImStore__: {
        state: {
          message: { messageInfo: new Map(), messageList: new Map() },
          session: { sessionInfo: new Map() },
        },
      },
      __ccMainStore__: {
        state: { msgTrain: { items: [], followUsers: new Map() } },
        action: { msgTrain: { addAtMeMsg: original, addFollowMsg: vi.fn() } },
      },
    } as Record<string, any>;
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "info").mockImplementation(() => {});

    new Function(
      buildMessageWatchBridgeScript({
        endpoint: "http://127.0.0.1:3210/v1/im/test-token",
        sessionStartedAtMs: 1_000,
      })
    )();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(
      (fakeWindow.__toskrMessageWatchV1 as { status: () => { active: boolean } }).status()
        .active
    ).toBe(false);
    expect(fakeWindow.__ccMainStore__.action.msgTrain.addAtMeMsg).toBe(original);
  });
});
