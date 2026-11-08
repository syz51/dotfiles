"""Builds a tiny workspace with only cargo/config.toml as the user-wide Cargo config and
checks the flags Cargo passes to rustc: line tables for workspace members, no debug
info for dependencies, and the incremental setting. Skips when cargo is not installed."""

import os
import re
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path

CONFIG = Path(__file__).resolve().parents[1] / "config.toml"


class ConfigFileTest(unittest.TestCase):
    def test_settings(self):
        config = tomllib.loads(CONFIG.read_text())
        self.assertEqual(
            config,
            {
                "profile": {
                    "dev": {
                        "debug": "line-tables-only",
                        "package": {"*": {"debug": False}},
                    }
                }
            },
        )


@unittest.skipUnless(shutil.which("cargo"), "cargo is not installed")
class CargoBuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home = root / "cargo-home"
        self.home.mkdir()
        shutil.copy(CONFIG, self.home / "config.toml")
        self.app = root / "app"
        (self.app / "src").mkdir(parents=True)
        (self.app / "Cargo.toml").write_text(
            '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n'
            '[dependencies]\ndep = { path = "../dep" }\n\n[workspace]\n'
        )
        (self.app / "src" / "main.rs").write_text("fn main() { dep::f(); }\n")
        dep = root / "dep"
        (dep / "src").mkdir(parents=True)
        (dep / "Cargo.toml").write_text('[package]\nname = "dep"\nversion = "0.1.0"\nedition = "2021"\n')
        (dep / "src" / "lib.rs").write_text("pub fn f() {}\n")

    def tearDown(self):
        self.tmp.cleanup()

    def rustc_lines(self, *args, env=None):
        """The rustc command line cargo ran for each crate, keyed by crate name. The
        environment is built from scratch, so no CARGO_* or RUSTFLAGS setting of the
        caller's changes the flags."""
        environment = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR") if key in os.environ}
        # rustup's proxies find their toolchains through RUSTUP_HOME, which defaults to a
        # folder beside the real CARGO_HOME.
        environment["RUSTUP_HOME"] = os.environ.get("RUSTUP_HOME", str(Path.home() / ".rustup"))
        environment.update(CARGO_HOME=str(self.home), CARGO_TARGET_DIR=str(self.app / "target"))
        environment.update(env or {})
        result = subprocess.run(
            ["cargo", "build", "-v", "--offline", *args],
            cwd=self.app, env=environment, capture_output=True, text=True, timeout=300,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = {}
        for line in result.stderr.splitlines():
            match = re.search(r"Running `.*?rustc --crate-name (\w+) ", line)
            if match:
                lines[match.group(1)] = line
        self.assertEqual(set(lines), {"app", "dep"}, result.stderr)
        return lines

    def test_members_get_line_tables_and_dependencies_none(self):
        lines = self.rustc_lines()
        self.assertIn("-C debuginfo=line-tables-only", lines["app"])
        self.assertNotIn("-C debuginfo=", lines["dep"])
        # Incremental compilation stays on for workspace members, as Cargo's default.
        self.assertIn("-C incremental=", lines["app"])

    def test_an_environment_override_still_wins_for_members(self):
        lines = self.rustc_lines(env={"CARGO_PROFILE_DEV_DEBUG": "true"})
        self.assertIn("-C debuginfo=2", lines["app"])
        self.assertNotIn("-C debuginfo=", lines["dep"])

    def test_the_documented_debugging_override_covers_dependencies(self):
        lines = self.rustc_lines(
            "--config", "profile.dev.debug=true", "--config", 'profile.dev.package."*".debug=true'
        )
        self.assertIn("-C debuginfo=2", lines["app"])
        self.assertIn("-C debuginfo=2", lines["dep"])

    def test_release_builds_are_unchanged(self):
        lines = self.rustc_lines("--release")
        self.assertNotIn("-C debuginfo=", lines["app"])
        self.assertNotIn("-C incremental=", lines["app"])


if __name__ == "__main__":
    unittest.main()
