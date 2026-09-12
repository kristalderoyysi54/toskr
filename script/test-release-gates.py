"""隔离执行真实发布脚本，证明门禁失败不会触发版本写入或发布。"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class ReleaseGatesTest(unittest.TestCase):
    def run_release(self, fail="", dirty="", changed="", build_changed=""):
        with tempfile.TemporaryDirectory(prefix="toskr-release-test-") as directory:
            root = Path(directory)
            (root / "script").mkdir()
            (root / "src-tauri/src").mkdir(parents=True)
            (root / ".tauri").mkdir()
            (root / ".tauri/toskr-updater.key").write_text("synthetic")
            shutil.copy(Path(__file__).with_name("release.sh"), root / "script/release.sh")
            binary = root / "bin"
            binary.mkdir()
            mock = '''#!/bin/bash
name=${0##*/}
echo "$name $*" >> "$CALLS"
case "$name" in
  git)
    case "$1" in
      rev-parse) echo fixture-commit ;;
      diff)
        if [[ "$2" == --binary ]]; then
          if [[ -f "$AFTER_BUILD" ]]; then echo source-changed; else echo version-only; fi
        fi ;;
      status)
        if [[ -n "$DIRTY" ]] || { [[ -n "$CHANGED" ]] && [[ -f "$AFTER_TESTS" ]]; }; then
          echo " M src/example.ts"
        fi ;;
    esac ;;
  pnpm|cargo)
    [[ "$name $*" != "$FAIL" ]] || exit 42
    if [[ "$name $*" == "pnpm tauri build" ]]; then
      bundle=src-tauri/target/release/bundle
      mkdir -p "$bundle/macos" "$bundle/dmg"
      touch "$bundle/macos/Toskr.app.tar.gz" "$bundle/dmg/Toskr_1.2.3_test.dmg"
      echo synthetic-signature > "$bundle/macos/Toskr.app.tar.gz.sig"
      touch "$AFTER_BUILD"
    fi
    if [[ "$name $*" == "pnpm check:tokens" ]]; then
      [[ "$STRICT" == 1 ]] || exit 43
      touch "$AFTER_TESTS"
    fi ;;
  python3|hdiutil)
    [[ -n "$BUILD_CHANGED" ]] || exit 79 ;;
  *) exit 79 ;;
esac
'''
            for name in ("git", "pnpm", "cargo", "python3", "gh", "hdiutil"):
                path = binary / name
                path.write_text(mock)
                path.chmod(0o755)
            env = dict(os.environ, HOME=str(root), PATH=f"{binary}:/usr/bin:/bin",
                       CALLS=str(root / "calls"), AFTER_TESTS=str(root / "tested"),
                       AFTER_BUILD=str(root / "built"), BUILD_CHANGED=build_changed,
                       FAIL=fail, DIRTY=dirty, CHANGED=changed)
            result = subprocess.run(["/bin/bash", str(root / "script/release.sh"), "1.2.3"],
                                    env=env, capture_output=True, text=True)
            return result.returncode, (root / "calls").read_text().splitlines()

    def test_each_gate_stops_before_version_write(self):
        for gate in ("pnpm typecheck", "pnpm lint", "pnpm test", "cargo test", "pnpm check:tokens"):
            with self.subTest(gate=gate):
                code, calls = self.run_release(fail=gate)
                self.assertEqual(code, 42)
                self.assertEqual(calls[-1], gate)
                self.assertFalse(any(call.startswith(("python3 ", "gh ", "git push")) for call in calls))

    def test_clean_success_reaches_version_write_only_after_all_gates(self):
        code, calls = self.run_release()
        self.assertEqual(code, 79)  # 版本写入由替身拦截，绝不构建或发布。
        self.assertEqual(calls[-1], "python3 - 1.2.3")
        self.assertEqual([call for call in calls if call.startswith(("pnpm ", "cargo "))],
                         ["pnpm typecheck", "pnpm lint", "pnpm test", "cargo test", "pnpm check:tokens"])

    def test_dirty_checkout_stops_before_tests(self):
        code, calls = self.run_release(dirty="yes")
        self.assertEqual(code, 1)
        self.assertFalse(any(call.startswith("pnpm ") for call in calls))

    def test_source_change_during_tests_stops_before_version_write(self):
        code, calls = self.run_release(changed="yes")
        self.assertEqual(code, 1)
        self.assertFalse(any(call.startswith("python3 ") for call in calls))

    def test_source_change_during_build_stops_before_publish(self):
        code, calls = self.run_release(build_changed="yes")
        self.assertEqual(code, 1)
        self.assertIn("pnpm tauri build", calls)
        self.assertFalse(any(call.startswith(("git add", "git commit", "git push", "gh ")) for call in calls))


if __name__ == "__main__":
    unittest.main()
