#!/usr/bin/env python3
"""在 UUID 隔离项目上验证 helper 跨版本复用；禁止授权 UI，不读取产品密钥。"""
import hashlib
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "src-tauri/keychain-helper"
IDENTITY = "6E960D8B61E1FC9C534E41CB812803D07E85E87B"
CLIENT_ID = "com.toskr.keychain-test-client"


def run(*arguments):
    return subprocess.run(arguments, check=True, capture_output=True, text=True, timeout=30)


def compile_binary(source, binary, *extra):
    run("/usr/bin/xcrun", "clang", "-fobjc-arc", "-Wall", "-Wextra", "-Werror",
        "-Wno-deprecated-declarations", "-mmacosx-version-min=13.0",
        "-framework", "Foundation", "-framework", "Security", "-lbsm",
        *extra, str(source), "-o", str(binary))


def sign(binary, identifier, hardened=True):
    run("/usr/bin/codesign", "--force", "--sign", IDENTITY, "--identifier", identifier,
        "--timestamp=none", "--options", "runtime" if hardened else "0", str(binary))


def code_hash(binary):
    info = run("/usr/bin/codesign", "-d", "--verbose=4", str(binary)).stderr
    return re.search(r"^CDHash=([a-f0-9]{40})$", info, re.M).group(1)


def cleanup(services, binary):
    failures = []
    for service, account in services:
        try:
            result = subprocess.run([str(binary), service, account],
                capture_output=True, text=True, timeout=10)
            failed = result.returncode != 0
        except subprocess.TimeoutExpired:
            failed = True
        if failed:
            failures.append(service)
    if failures:
        raise RuntimeError("临时钥匙串项目清理失败：" + ", ".join(failures))


def main():
    if sys.platform != "darwin":
        raise SystemExit("原生钥匙串集成测试需要 macOS")
    suffix = uuid.uuid4().hex
    services = [
        (f"com.toskr.test.helper.{suffix}.data", "data-encryption-key-v1"),
        (f"com.toskr.test.helper.{suffix}.ai", "openai-compatible"),
    ]
    with tempfile.TemporaryDirectory(prefix="toskr-keychain-native-") as temporary:
        directory = Path(temporary)
        cleaner = directory / "cleanup"
        compile_binary(DIRECTORY / "tests/native-cleanup.m", cleaner)
        try:
            source = (DIRECTORY / "main.m").read_text()
            for original, replacement in zip(("com.toskr.app.data", "com.toskr.app.ai"), services):
                if source.count(f'@"{original}"') != 1:
                    raise RuntimeError("固定服务名源码变化，拒绝运行可能访问产品密钥的 fixture")
                source = source.replace(f'@"{original}"', f'@"{replacement[0]}"')
            config = (DIRECTORY / "config.h").read_text()
            if config.count("com.toskr.app") != 1:
                raise RuntimeError("调用者要求源码变化，fixture 需要复核")
            (directory / "main.m").write_text(source)
            (directory / "config.h").write_text(config.replace("com.toskr.app", CLIENT_ID))
            helper = directory / "helper"
            compile_binary(directory / "main.m", helper)
            sign(helper, "com.toskr.keychain-test-helper")
            fixed_hash = hashlib.sha256(helper.read_bytes()).hexdigest()

            clients = []
            for revision in (1, 2):
                client = directory / f"client-v{revision}"
                compile_binary(DIRECTORY / "tests/native-client.m", client, f"-DTEST_REVISION={revision}")
                sign(client, CLIENT_ID)
                clients.append(client)
            if code_hash(clients[0]) == code_hash(clients[1]):
                raise RuntimeError("两个测试客户端的 cdhash 必须不同")
            run(str(clients[0]), str(helper), "store")
            run(str(clients[0]), str(helper), "load")
            run(str(clients[1]), str(helper), "load")
            print("✓ 同证书、同 identifier、不同 cdhash 的两个客户端复用固定 helper 读写通过")

            for label, identifier, hardened, signed in (
                ("wrong-id", "com.toskr.keychain-test-wrong", True, True),
                ("no-runtime", CLIENT_ID, False, True),
                ("adhoc", CLIENT_ID, False, False),
            ):
                client = directory / label
                shutil.copyfile(clients[0], client)
                client.chmod(0o755)
                if signed:
                    sign(client, identifier, hardened)
                else:
                    run("/usr/bin/codesign", "--force", "--sign", "-", "--identifier", identifier, str(client))
                run(str(client), str(helper), "expect-denied")
                print(f"✓ 拒绝未获授权调用者：{label}")
            if hashlib.sha256(helper.read_bytes()).hexdigest() != fixed_hash:
                raise RuntimeError("测试期间 helper 发生变化")
        finally:
            cleanup(services, cleaner)
    print("✓ UUID 临时钥匙串项目已删除；产品密钥及固定产物未修改")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        # fixture 仅返回状态；不打印协议帧或值。
        raise SystemExit(f"原生 fixture 失败（退出码 {error.returncode}）：{error.stderr.strip()}")
