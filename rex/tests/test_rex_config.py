#!/usr/bin/env python3
"""Offline tests for the tracked Rex configuration and theme."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
REX_DIR = REPO_ROOT / "rex"
INIT_LUA = REX_DIR / "init.lua"
THEME_FILE = REX_DIR / "themes" / "Catppuccin Frappe"
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
APP_BUNDLE_REX = Path(
    "/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex"
)


def find_rex_binary() -> str | None:
    if found := shutil.which("rex"):
        return found
    if APP_BUNDLE_REX.is_file() and os.access(APP_BUNDLE_REX, os.X_OK):
        return str(APP_BUNDLE_REX)
    return None


class RexConfigTest(unittest.TestCase):
    def test_theme_file_has_full_ghostty_palette(self) -> None:
        self.assertTrue(THEME_FILE.is_file(), f"Missing theme file: {THEME_FILE}")
        palette: dict[int, str] = {}
        fields: dict[str, str] = {}
        for raw_line in THEME_FILE.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            key, sep, value = line.partition("=")
            self.assertEqual(sep, "=", f"Malformed theme line: {raw_line!r}")
            key = key.strip()
            value = value.strip()
            if key == "palette":
                idx_str, psep, color = value.partition("=")
                self.assertEqual(psep, "=", f"Malformed palette entry: {raw_line!r}")
                idx = int(idx_str)
                self.assertRegex(color, HEX_COLOR_RE)
                palette[idx] = color
            else:
                self.assertRegex(value, HEX_COLOR_RE, f"Invalid color for {key}: {value!r}")
                fields[key] = value

        self.assertEqual(set(palette), set(range(16)))
        for required in (
            "background",
            "foreground",
            "cursor-color",
            "cursor-text",
            "selection-background",
            "selection-foreground",
        ):
            self.assertIn(required, fields)

    def test_gitignore_excludes_local_and_generated_rex_files(self) -> None:
        for rel in ("rex/local.lua", "rex/ssh_config", "rex/terminfo-hosts"):
            result = subprocess.run(
                ["git", "-C", str(REPO_ROOT), "check-ignore", "-q", rel],
                check=False,
            )
            self.assertEqual(result.returncode, 0, f"{rel} should be gitignored")

    def test_init_lua_passes_rex_config_check_with_and_without_local(self) -> None:
        rex_bin = find_rex_binary()
        if rex_bin is None:
            self.skipTest("rex CLI not installed")

        with tempfile.TemporaryDirectory() as tmp:
            cfg_dir = Path(tmp) / "rex"
            cfg_dir.mkdir()
            init_copy = cfg_dir / "init.lua"
            shutil.copy2(INIT_LUA, init_copy)

            # Without local.lua: clean check, no warnings or errors.
            res = subprocess.run(
                [rex_bin, "config", "check", str(init_copy)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            self.assertNotIn("warning", res.stdout.lower() + res.stderr.lower())
            self.assertNotIn("error", res.stdout.lower() + res.stderr.lower())

            # With valid local.lua defining a host: clean check.
            local_lua = cfg_dir / "local.lua"
            local_lua.write_text(
                'rex.host{ label = "example-host", endpoint = "ssh://example-host" }\n',
                encoding="utf-8",
            )
            res = subprocess.run(
                [rex_bin, "config", "check", str(init_copy)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            self.assertNotIn("warning", res.stdout.lower() + res.stderr.lower())

            # With broken local.lua: surfaces the error instead of swallowing it.
            local_lua.write_text("this is not valid lua ???\n", encoding="utf-8")
            res = subprocess.run(
                [rex_bin, "config", "check", str(init_copy)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(res.returncode, 0, "Syntax error in local.lua must fail config check")

            # Missing nested require inside local.lua must also surface.
            local_lua.write_text('require("nonexistent_helper")\n', encoding="utf-8")
            res = subprocess.run(
                [rex_bin, "config", "check", str(init_copy)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(res.returncode, 0, "Missing nested require in local.lua must fail config check")


if __name__ == "__main__":
    unittest.main()
