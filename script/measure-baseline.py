#!/usr/bin/env python3
"""Toskr 启动耗时与常驻内存基线。

用法：python3 -I script/measure-baseline.py [--runs 3] [--settle 15] [--app /Applications/Toskr.app]
                                            [--full] [--json out.json]

每轮：结束 toskr → open 应用 → 从诊断日志读里程碑
（读密钥 / 启动 v… pid=… / frontend.mounted / 数据水合完成）→ 静置 settle 秒 →
用 footprint 量 toskr 主进程与归属它的 WebKit 子进程（GPU/Networking/WebContent），
并按诊断日志里的「label=… webcontent_pid=…」把 WebContent 归到窗口。

--full：在最后一轮的进程上继续跑场景（会接管键鼠约 2 分钟，只发 Toskr 自己的快捷键）：
  空闲 60s 的 CPU% 与唤醒 → ⌘⇧C 开面板 → 面板内滚动 → 关面板 → ⌃⇧Q 截图 + Esc ×10 → 静置 30s
输入驱动 script/perf/drive.swift 首次运行时编译到 /tmp/toskr-drive。
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.expanduser("~/Library/Application Support/com.toskr.app/toskr-diag.log")
DRIVE = "/tmp/toskr-drive"
MILESTONES = {
    "key": re.compile(r"^(\d+) 读取数据加密密钥"),
    "boot": re.compile(r"^(\d+) 启动 v(\S+) pid=(\d+)"),
    "mounted": re.compile(r"^(\d+) frontend\.mounted"),
    "hydrated": re.compile(r"^(\d+) 数据水合完成(.*)"),
}
WINDOW_PID = re.compile(r"^\d+ (?:frontend\.mounted|webview\.pid) label=(\S+) webcontent_pid=(-?\d+)")

_libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
_libsystem = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
_responsible = _libsystem.responsibility_get_pid_responsible_for_pid
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


def wakeups(pid):
    """rusage_info_v0 的 pkg_idle_wkups + interrupt_wkups（偏移 32/40）。"""
    buf = ctypes.create_string_buffer(96)
    if _libproc.proc_pid_rusage(pid, 0, buf) != 0:
        return None
    return int.from_bytes(buf.raw[32:40], "little") + int.from_bytes(buf.raw[40:48], "little")


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def cpu_seconds(pid):
    """ps 的累计 CPU 时间（[[h:]m:]s.cc）。"""
    raw = sh("ps", "-o", "time=", "-p", str(pid)).strip()
    if not raw:
        return None
    total = 0.0
    for part in raw.split(":"):
        total = total * 60 + float(part)
    return total


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


def footprint_categories(pid, top=6):
    """footprint 分类表里 dirty 最大的几类（MALLOC_*、IOSurface、WebKit JS 等）。"""
    rows = []
    for line in sh("footprint", "-f", "bytes", "-p", str(pid)).splitlines():
        m = re.match(r"^\s*(\d+) B\s+(\d+) B\s+(\d+) B\s+(\d+)\s+(.+?)\s*$", line)
        if m and m.group(5) != "TOTAL":
            rows.append((round(int(m.group(1)) / 2**20, 1), m.group(5)))
    return sorted(rows, reverse=True)[:top]


def read_log_from(offset):
    if os.path.getsize(LOG) < offset:  # 日志被截断/轮转
        offset = 0
    with open(LOG, "rb") as f:
        f.seek(offset)
        raw = f.read()
    # 只解析完整行：半行的「pid=113」会被正则截成错误 pid
    return raw[: raw.rfind(b"\n") + 1].decode("utf-8", "replace")


def window_map(text):
    """pid → 窗口 label（同一 pid 多次出现取最后一次）。"""
    out = {}
    for line in text.splitlines():
        m = WINDOW_PID.match(line)
        if m and int(m.group(2)) > 0:
            out[int(m.group(2))] = m.group(1)
    return out


def wait_gone(timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        if not sh("pgrep", "-x", "toskr").strip():
            return True
        time.sleep(0.2)
    return False


def snapshot(pid, labels):
    helpers = []
    for p in sorted(webkit_pids(pid)):
        name = proc_name(p).replace("com.apple.WebKit.", "")
        label = labels.get(p) or (name if name != "WebContent" else "未映射")
        helpers.append({"pid": p, "name": name, "label": label, "mb": footprint_mb(p)})
    return {"main_mb": footprint_mb(pid), "helpers": helpers}


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
        for line in read_log_from(offset).splitlines():
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
    labels = window_map(read_log_from(offset))
    snap = snapshot(pid, labels)
    return {
        "version": got["boot"].group(2),
        "pid": pid,
        "log_offset": offset,
        "open_to_exec_ms": t_exec - t_open if t_exec else None,
        "exec_to_key_ms": ts["key"] - t_exec if t_exec and "key" in ts else None,
        "key_to_boot_ms": ts["boot"] - ts["key"] if "key" in ts else None,
        "open_to_boot_ms": ts["boot"] - t_open,
        "boot_to_mounted_ms": ts["mounted"] - ts["boot"] if "mounted" in ts else None,
        "mounted_to_hydrated_ms": ts["hydrated"] - ts["mounted"] if {"mounted", "hydrated"} <= ts.keys() else None,
        "open_to_hydrated_ms": ts["hydrated"] - t_open if "hydrated" in ts else None,
        "hydrated_detail": got["hydrated"].group(2).strip() if "hydrated" in got else None,
        **snap,
    }


def med(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def helper_sum(r, name=None):
    return sum(h["mb"] or 0 for h in r["helpers"] if name is None or h["name"] == name)


def by_label(snap):
    out = {"主进程": snap["main_mb"]}
    for h in snap["helpers"]:
        out[h["label"]] = round(out.get(h["label"], 0) + (h["mb"] or 0), 1)
    out["合计"] = round((snap["main_mb"] or 0) + helper_sum(snap), 1)
    return out


# ---------- --full 场景 ----------

def drive(*args):
    if not os.path.exists(DRIVE):
        src = os.path.join(ROOT, "script", "perf", "drive.swift")
        subprocess.run(["swiftc", "-O", src, "-o", DRIVE], check=True)
    return subprocess.run([DRIVE, *args], capture_output=True, text=True)


def idle(pid, labels, secs):
    procs = {"主进程": [pid]}
    for p in webkit_pids(pid):
        procs.setdefault(labels.get(p) or proc_name(p).replace("com.apple.WebKit.", ""), []).append(p)
    before = {p: (cpu_seconds(p), wakeups(p)) for ps in procs.values() for p in ps}
    time.sleep(secs)
    out = {}
    for label, ps in procs.items():
        cpu = wk = 0.0
        for p in ps:
            c0, w0 = before[p]
            c1, w1 = cpu_seconds(p), wakeups(p)
            if None not in (c0, c1):
                cpu += c1 - c0
            if None not in (w0, w1):
                wk += w1 - w0
        out[label] = {"cpu_pct": round(cpu / secs * 100, 2), "wakeups_per_s": round(wk / secs, 1)}
    return out


def full_scenario(run):
    pid, offset = run["pid"], run["log_offset"]
    stages = []

    def record(name):
        labels = window_map(read_log_from(offset))
        stages.append({"stage": name, **snapshot(pid, labels)})
        return labels

    labels = record("启动静置")
    cats = {"主进程": footprint_categories(pid)}
    main_wc = next((p for p, l in labels.items() if l == "main"), None)
    if main_wc:
        cats["main WebContent"] = footprint_categories(main_wc)
    idle_closed = idle(pid, labels, 60)

    drive("key", "cmd+shift+c")
    time.sleep(3)
    record("面板打开")
    idle_open = idle(pid, labels, 20)
    b = drive("bounds", str(pid)).stdout.split()
    if len(b) == 4 and int(b[2]) >= 200:
        x, y = int(b[0]) + int(b[2]) // 2, int(b[1]) + int(b[3]) // 2
        drive("scroll", str(x), str(y), "60", "-5")
        drive("scroll", str(x), str(y), "60", "5")
        time.sleep(3)
        record("面板滚动后")
    else:
        stages.append({"stage": "面板滚动后", "skipped": f"未找到面板窗口 bounds={b}"})
    drive("key", "cmd+shift+c")
    time.sleep(5)
    record("面板关闭")

    for i in range(10):
        drive("key", "ctrl+shift+q")
        time.sleep(1.8)
        drive("key", "esc")
        time.sleep(1.2)
        if i in (0, 9):
            record(f"截图×{i + 1}")
    time.sleep(30)
    record("截图后静置30s")
    return {"stages": stages, "categories": cats, "idle_panel_closed": idle_closed, "idle_panel_open": idle_open}


def print_full(full):
    stages = [s for s in full["stages"] if "helpers" in s]
    rows = [by_label(s) for s in stages]
    keys = []
    for r in rows:
        keys += [k for k in r if k not in keys]
    keys = [k for k in keys if k != "合计"] + ["合计"]
    print("\n内存（MB）按窗口 × 阶段")
    print("  " + "窗口".ljust(16) + "".join(s["stage"][:10].rjust(12) for s in stages))
    for k in keys:
        print("  " + k.ljust(16) + "".join(str(r.get(k, "-")).rjust(12) for r in rows))
    for s in full["stages"]:
        if "skipped" in s:
            print(f"  ⚠ {s['stage']}：{s['skipped']}")
    for title, data in (("空闲 60s（面板关）", full["idle_panel_closed"]), ("空闲 20s（面板开）", full["idle_panel_open"])):
        print(f"\n{title}  CPU% / 每秒唤醒")
        for label, v in sorted(data.items(), key=lambda kv: -kv[1]["cpu_pct"]):
            print(f"  {label:<16} {v['cpu_pct']:>6}%  {v['wakeups_per_s']:>7}/s")
    print("\nfootprint 分类 top（MB）")
    for who, rows_ in full["categories"].items():
        print(f"  {who}: " + "，".join(f"{n} {mb}" for mb, n in rows_))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--settle", type=float, default=15)
    ap.add_argument("--app", default="/Applications/Toskr.app")
    ap.add_argument("--full", action="store_true", help="最后一轮后继续跑交互场景（接管键鼠约 2 分钟）")
    ap.add_argument("--json", help="把逐轮原始数据写到该文件")
    a = ap.parse_args()

    runs = []
    for i in range(a.runs):
        r = one_run(a.app, a.settle)
        runs.append(r)
        print(
            f"#{i + 1} v{r['version']} open→exec {r['open_to_exec_ms']}ms | exec→读密钥 {r['exec_to_key_ms']}ms | "
            f"读密钥→启动 {r['key_to_boot_ms']}ms | 启动→挂载 {r['boot_to_mounted_ms']}ms | "
            f"挂载→水合 {r['mounted_to_hydrated_ms']}ms | 总 {r['open_to_hydrated_ms']}ms ({r['hydrated_detail']})"
        )
        print("   内存 " + " | ".join(f"{k} {v}" for k, v in by_label(r).items()))

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

    full = None
    if a.full:
        full = full_scenario(runs[-1])
        print_full(full)
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"runs": runs, "full": full}, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
