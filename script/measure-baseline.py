#!/usr/bin/env python3
"""Toskr 启动耗时与常驻内存基线。

用法：python3 -I script/measure-baseline.py [--runs 3] [--settle 15] [--app /Applications/Toskr.app]

每轮：结束 toskr → open 应用 → 从诊断日志读里程碑
（启动 v… pid=… / frontend.mounted / 数据水合完成）→ 静置 settle 秒 →
用 footprint 量 toskr 主进程与归属它的 WebKit 子进程（GPU/Networking/WebContent）。
注意：会重启正在运行的 Toskr；文件缓存是热的，测的是「重启」而非开机冷启动。
"""
import argparse
import ctypes
import json
import os
import re
import statistics
import subprocess
import time

LOG = os.path.expanduser("~/Library/Application Support/com.toskr.app/toskr-diag.log")
MILESTONES = {
    "key": re.compile(r"^(\d+) 读取数据加密密钥"),
    "boot": re.compile(r"^(\d+) 启动 v(\S+) pid=(\d+)"),
    "mounted": re.compile(r"^(\d+) frontend\.mounted"),
    "hydrated": re.compile(r"^(\d+) 数据水合完成(.*)"),
}


_libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
_responsible = ctypes.CDLL("/usr/lib/libSystem.B.dylib").responsibility_get_pid_responsible_for_pid
_responsible.restype = ctypes.c_int
_responsible.argtypes = [ctypes.c_int]


def exec_start_ms(pid):
    """内核记录的进程启动时刻（proc_bsdinfo.pbi_start_tvsec/tvusec，偏移 120/128）。"""
    buf = ctypes.create_string_buffer(136)
    if _libproc.proc_pidinfo(pid, 3, ctypes.c_uint64(0), buf, 136) != 136:  # PROC_PIDTBSDINFO
        return None
    sec = int.from_bytes(buf.raw[120:128], "little")
    usec = int.from_bytes(buf.raw[128:136], "little")
    return sec * 1000 + usec // 1000


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def webkit_pids(owner):
    """归属于 owner 的 WebKit 辅助进程（按「责任进程」认领，不会算进其他应用的 WebView）。"""
    out = sh("pgrep", "-f", "com.apple.WebKit.")
    return {int(p) for p in out.split() if _responsible(int(p)) == owner}


def proc_name(pid):
    return os.path.basename(sh("ps", "-o", "comm=", "-p", str(pid)).strip()) or "?"


def footprint_mb(pid):
    out = sh("footprint", "--noCategories", "-f", "bytes", "-p", str(pid))
    m = re.search(r"phys_footprint:\s*(\d+)", out)
    return round(int(m.group(1)) / 2**20, 1) if m else None


def wait_gone(timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        if not sh("pgrep", "-x", "toskr").strip():
            return True
        time.sleep(0.2)
    return False


def one_run(app, settle):
    subprocess.run(["pkill", "-x", "toskr"])
    if not wait_gone():
        raise SystemExit("toskr 未退出")
    time.sleep(2)  # 等旧 WebKit 子进程回收
    offset = os.path.getsize(LOG)
    t_open = time.time_ns() // 1_000_000
    subprocess.run(["open", app], check=True)

    got = {}
    deadline = time.time() + 30
    while time.time() < deadline and len(got) < len(MILESTONES):
        if os.path.getsize(LOG) < offset:  # 日志被截断/轮转
            offset = 0
        with open(LOG, "rb") as f:
            f.seek(offset)
            text = f.read().decode("utf-8", "replace")
        for line in text.splitlines():
            for key, rx in MILESTONES.items():
                m = rx.match(line)
                if m and key not in got:
                    got[key] = m
        time.sleep(0.1)
    if "boot" not in got:
        raise SystemExit("30s 内未见启动指纹，检查应用是否起来")

    pid = int(got["boot"].group(3))
    ts = {k: int(m.group(1)) for k, m in got.items()}
    t_exec = exec_start_ms(pid)
    time.sleep(settle)

    helpers = []
    for p in sorted(webkit_pids(pid)):
        helpers.append({"pid": p, "name": proc_name(p).replace("com.apple.WebKit.", ""), "mb": footprint_mb(p)})
    return {
        "version": got["boot"].group(2),
        "pid": pid,
        "open_to_exec_ms": t_exec - t_open if t_exec else None,
        "exec_to_key_ms": ts["key"] - t_exec if t_exec and "key" in ts else None,
        "key_to_boot_ms": ts["boot"] - ts["key"] if "key" in ts else None,
        "open_to_boot_ms": ts["boot"] - t_open,
        "boot_to_mounted_ms": ts["mounted"] - ts["boot"] if "mounted" in ts else None,
        "mounted_to_hydrated_ms": ts["hydrated"] - ts["mounted"] if {"mounted", "hydrated"} <= ts.keys() else None,
        "open_to_hydrated_ms": ts["hydrated"] - t_open if "hydrated" in ts else None,
        "hydrated_detail": got["hydrated"].group(2).strip() if "hydrated" in got else None,
        "main_mb": footprint_mb(pid),
        "helpers": helpers,
    }


def med(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--settle", type=float, default=15)
    ap.add_argument("--app", default="/Applications/Toskr.app")
    ap.add_argument("--json", help="把逐轮原始数据写到该文件")
    a = ap.parse_args()

    runs = []
    for i in range(a.runs):
        r = one_run(a.app, a.settle)
        runs.append(r)
        by = {}
        for h in r["helpers"]:
            by.setdefault(h["name"], []).append(h["mb"])
        parts = ", ".join(
            f"{n}×{len(v)}={sum(x for x in v if x is not None):.0f}MB"
            + ("(含不可读)" if None in v else "")
            for n, v in sorted(by.items())
        )
        print(
            f"#{i + 1} v{r['version']} open→exec {r['open_to_exec_ms']}ms | exec→读密钥 {r['exec_to_key_ms']}ms | "
            f"读密钥→启动 {r['key_to_boot_ms']}ms | 启动→挂载 {r['boot_to_mounted_ms']}ms | "
            f"挂载→水合 {r['mounted_to_hydrated_ms']}ms | 总 {r['open_to_hydrated_ms']}ms ({r['hydrated_detail']})"
        )
        print(f"   内存 主进程 {r['main_mb']}MB | WebKit {parts}")

    def helper_sum(r, name=None):
        return sum(h["mb"] or 0 for h in r["helpers"] if name is None or h["name"] == name)

    print("\n中位数")
    for key, label in [
        ("open_to_exec_ms", "open→进程exec"),
        ("exec_to_key_ms", "exec→读密钥"),
        ("key_to_boot_ms", "读密钥→启动"),
        ("open_to_boot_ms", "open→启动"),
        ("boot_to_mounted_ms", "启动→前端挂载"),
        ("mounted_to_hydrated_ms", "挂载→数据水合"),
        ("open_to_hydrated_ms", "open→可用(水合)"),
    ]:
        print(f"  {label:<14} {med([r[key] for r in runs])} ms")
    print(f"  主进程(Rust)      {med([r['main_mb'] for r in runs])} MB")
    for name in ("WebContent", "GPU", "Networking"):
        print(f"  WebKit {name:<11}{med([helper_sum(r, name) for r in runs])} MB")
    print(f"  合计              {med([round((r['main_mb'] or 0) + helper_sum(r), 1) for r in runs])} MB")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(runs, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
