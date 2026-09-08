#!/usr/bin/env python3
"""Pin the signed helper across ordinary releases. `build` is an explicit helper upgrade."""
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "src-tauri/keychain-helper"
BINARY = DIRECTORY / "artifacts/toskr-keychain-helper"
MANIFEST = DIRECTORY / "manifest.json"
SOURCES = [DIRECTORY / "main.m", DIRECTORY / "config.h"]
IDENTITY = "6E960D8B61E1FC9C534E41CB812803D07E85E87B"
IDENTIFIER = "com.toskr.keychain-helper"


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def code_hashes(path):
    result = {}
    for arch in ("arm64", "x86_64"):
        info = run("/usr/bin/codesign", "-d", "--arch", arch, "--verbose=4", str(path)).stderr
        result[arch] = re.search(r"^CDHash=([a-f0-9]{40})$", info, re.M).group(1)
        if f"Identifier={IDENTIFIER}\n" not in info or "runtime" not in info:
            raise RuntimeError("辅助程序签名标识或 hardened runtime 配置错误")
    return result


def check(app):
    manifest = json.loads(MANIFEST.read_text())
    for source in SOURCES:
        if manifest["sources"][source.name] != digest(source):
            raise RuntimeError("辅助程序源码已变化；须单独审查升级并显式构建，不能随普通版本重编译")
    if manifest["sha256"] != digest(BINARY) or manifest["cdhash"] != code_hashes(BINARY):
        raise RuntimeError("固定辅助程序产物与清单不一致")
    requirement = f'identifier "{IDENTIFIER}" and certificate leaf = H"{IDENTITY.lower()}"'
    run("/usr/bin/codesign", "--verify", "--strict", "--all-architectures", "-R", "=" + requirement, str(BINARY))
    if app:
        bundled = Path(app) / "Contents/Helpers/toskr-keychain-helper"
        if digest(bundled) != manifest["sha256"]:
            raise RuntimeError("包内辅助程序被改变；已阻止交付，避免升级后重复授权")
    print("✓ 内置密钥辅助程序签名、源码与固定产物一致" + ("，包内字节一致" if app else ""))


def build():
    BINARY.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="toskr-keychain-build-") as temporary:
        binary = Path(temporary) / BINARY.name
        run("/usr/bin/xcrun", "clang", "-fobjc-arc", "-Os", "-Wall", "-Wextra", "-Werror",
            "-Wno-deprecated-declarations", "-mmacosx-version-min=13.0",
            "-arch", "arm64", "-arch", "x86_64", "-framework", "Foundation",
            "-framework", "Security", "-lbsm", str(DIRECTORY / "main.m"), "-o", str(binary))
        run("/usr/bin/codesign", "--force", "--sign", IDENTITY, "--identifier", IDENTIFIER,
            "--options", "runtime", "--timestamp=none", str(binary))
        hashes = code_hashes(binary)
        BINARY.write_bytes(binary.read_bytes())
        BINARY.chmod(0o755)
    MANIFEST.write_text(json.dumps({
        "protocol": 1,
        "identifier": IDENTIFIER,
        "certificateSha1": IDENTITY.lower(),
        "sha256": digest(BINARY),
        "cdhash": hashes,
        "sources": {source.name: digest(source) for source in SOURCES},
    }, indent=2) + "\n")
    check(None)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "build"))
    parser.add_argument("--app", help="另核对完整 .app 内的固定副本")
    args = parser.parse_args()
    if args.command == "build":
        build()
    else:
        check(args.app)
