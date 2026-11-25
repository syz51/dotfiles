"""Checks that kache/config.toml parses cleanly and pins the safety settings
documented in SETUP.md."""

import json
import os
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path

CONFIG = Path(__file__).resolve().parents[1] / "config.toml"


class KacheConfigTest(unittest.TestCase):
    def test_settings(self):
        config = tomllib.loads(CONFIG.read_text())
        self.assertEqual(
            config,
            {
                "cache": {
                    "explain_miss": True,
                    "blaze": False,
                    "seed_new_targets": False,
                    "auto_share_target_files": False,
                }
            },
        )

    @unittest.skipUnless(shutil.which("kache"), "kache is not installed")
    def test_kache_cli_validates_config_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {
                key: os.environ[key]
                for key in ("PATH", "HOME", "TMPDIR")
                if key in os.environ
            }
            env["KACHE_CONFIG"] = str(CONFIG)
            env["KACHE_DIR"] = str(Path(tmp) / "cache")

            # `kache doctor --json` deserializes KACHE_CONFIG and fails the
            # "Config file" check on syntax or schema/type errors.
            doctor = subprocess.run(
                ["kache", "doctor", "--json"],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            payload = json.loads(doctor.stdout)
            config_checks = [
                check for check in payload["checks"] if check["label"] == "Config file"
            ]
            self.assertEqual(len(config_checks), 1, doctor.stdout)
            self.assertTrue(config_checks[0]["pass"], config_checks[0])

            # `kache config set` rejects unknown keys and wrong value types.
            temp_config = Path(tmp) / "config.toml"
            set_env = dict(env, KACHE_CONFIG=str(temp_config))
            parsed = tomllib.loads(CONFIG.read_text())
            for section, values in parsed.items():
                for key, value in values.items():
                    rendered = str(value).lower() if isinstance(value, bool) else str(value)
                    res = subprocess.run(
                        ["kache", "config", "set", f"{section}.{key}", rendered],
                        env=set_env,
                        capture_output=True,
                        text=True,
                        timeout=30,
                    )
                    self.assertEqual(res.returncode, 0, res.stderr)


if __name__ == "__main__":
    unittest.main()
