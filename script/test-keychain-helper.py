#!/usr/bin/env python3
"""复跑 helper 协议与钥匙串语义测试；全部钥匙串调用均由 mock 替代。"""
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    if sys.platform != "darwin":
        raise SystemExit("钥匙串辅助程序测试需要 macOS SDK")
    with tempfile.TemporaryDirectory(prefix="toskr-keychain-unit-") as temporary:
        binary = Path(temporary) / "unit-tests"
        subprocess.run([
            "/usr/bin/xcrun", "clang", "-fobjc-arc", "-Wall", "-Wextra", "-Werror",
            "-Wno-deprecated-declarations", "-mmacosx-version-min=13.0",
            "-framework", "Foundation", "-framework", "Security", "-lbsm",
            str(ROOT / "src-tauri/keychain-helper/tests/unit.m"), "-o", str(binary),
        ], check=True)
        subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    main()
