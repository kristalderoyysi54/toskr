#!/usr/bin/env python3
"""Toskr Native（mygo）启动耗时与内存/空闲开销，口径与 measure-baseline.py 一致。

用法：python3 -I script/perf/measure-native.py [--runs 3] [--settle 15] [--app native/build/darwin-arm64/Toskr\\ Native.app]
单进程应用（无 WebKit 子进程），footprint 只量主进程。会重启 Toskr Native（不碰 Tauri 版）。
"""
import argparse, importlib.util, os, re, statistics, subprocess, time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("base", os.path.join(HERE, "..", "measure-baseline.py"))
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)

LOG = os.path.expanduser("~/Library/Application Support/com.toskr.native/toskr-diag.log")
PROC = "Toskr Native.app/Contents/MacOS"
RX = {
    "boot": re.compile(r"^(\d+) 启动 v(\S+) pid=(\d+)"),
    "hydrated": re.compile(r"^(\d+) 数据水合完成 笔记=(\d+) 剪贴板=(\d+)"),
    "shown": re.compile(r"^(\d+) 面板显示"),
}

def pid():
    out = base.sh("pgrep", "-f", PROC).split()
    return int(out[0]) if out else None

def stop():
    for _ in range(3):  # mygo 发布版第一次 SIGTERM 只请求退出，第二次才立即退出
        p = pid()
        if not p:
            return
        subprocess.run(["kill", str(p)]); time.sleep(1.2)
    raise SystemExit("Toskr Native 未退出")

def read_from(off):
    with open(LOG, "rb") as f:
        f.seek(off); raw = f.read()
    return raw[: raw.rfind(b"\n") + 1].decode("utf-8", "replace")

def one(app, settle):
    stop()
    off = os.path.getsize(LOG) if os.path.exists(LOG) else 0
    t_open = time.time_ns() // 1_000_000
    subprocess.run(["open", app], check=True)
    got, deadline = {}, time.time() + 30
    while time.time() < deadline and len(got) < len(RX):
        for line in read_from(off).splitlines():
            for k, rx in RX.items():
                m = rx.match(line)
                if m and k not in got:
                    got[k] = m
        time.sleep(0.05)
    if "boot" not in got:
        raise SystemExit("30s 内未见启动指纹")
    p = int(got["boot"].group(3))
    ts = {k: int(m.group(1)) for k, m in got.items()}
    t_exec = base.exec_start_ms(p)
    time.sleep(settle)
    return {
        "pid": p,
        "open_to_exec_ms": t_exec - t_open if t_exec else None,
        "exec_to_hydrated_ms": ts["hydrated"] - t_exec if t_exec and "hydrated" in ts else None,
        "exec_to_shown_ms": ts["shown"] - t_exec if t_exec and "shown" in ts else None,
        "open_to_shown_ms": ts["shown"] - t_open if "shown" in ts else None,
        "notes": f"{got['hydrated'].group(2)}+{got['hydrated'].group(3)}" if "hydrated" in got else "?",
        "mb": base.footprint_mb(p),
    }

def idle(p, secs):
    c0, w0 = base.cpu_seconds(p), base.wakeups(p)
    time.sleep(secs)
    c1, w1 = base.cpu_seconds(p), base.wakeups(p)
    return round((c1 - c0) / secs * 100, 2), round((w1 - w0) / secs, 1)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--settle", type=float, default=15)
    ap.add_argument("--app", default=os.path.join(HERE, "..", "..", "native", "build", "darwin-arm64", "Toskr Native.app"))
    ap.add_argument("--idle", action="store_true", help="最后一轮量面板开/关空闲 CPU 与唤醒（会按 ⌃⌥Space 两次）")
    a = ap.parse_args()
    runs = []
    for i in range(a.runs):
        r = one(a.app, a.settle); runs.append(r)
        print(f"#{i+1} open→exec {r['open_to_exec_ms']}ms | exec→水合 {r['exec_to_hydrated_ms']}ms | exec→面板 {r['exec_to_shown_ms']}ms | open→面板 {r['open_to_shown_ms']}ms | 笔记 {r['notes']} | 内存 {r['mb']}MB")
    if all(r["open_to_shown_ms"] is None for r in runs):
        raise SystemExit("没有一轮走到面板显示：多半卡在钥匙串授权弹窗（新构建签名变化），点「始终允许」后重跑")
    med = lambda k: statistics.median([r[k] for r in runs if r[k] is not None])
    print(f"\n中位数 open→面板 {med('open_to_shown_ms')}ms  exec→面板 {med('exec_to_shown_ms')}ms  内存 {med('mb')}MB")
    if a.idle:
        base.require_unlocked("空闲测量")
        p = runs[-1]["pid"]
        visible = any(int(x.split()[4]) > 500 for x in base.sh("/tmp/toskr-perf/winids", str(p)).splitlines() if len(x.split()) == 5)
        first = "面板开" if visible else "面板关"
        cpu, wk = idle(p, 40); print(f"{first} 40s: CPU {cpu}%  唤醒 {wk}/s  内存 {base.footprint_mb(p)}MB")
        base.drive("key", "ctrl+alt+space"); time.sleep(3)
        second = "面板关" if visible else "面板开"
        cpu, wk = idle(p, 40); print(f"{second} 40s: CPU {cpu}%  唤醒 {wk}/s  内存 {base.footprint_mb(p)}MB")

if __name__ == "__main__":
    main()
