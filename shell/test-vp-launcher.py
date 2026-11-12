"""The vp launcher runs the nearest project's own Vite+ CLI, using fake projects."""
from pathlib import Path
import subprocess
import tempfile
import unittest

LAUNCHER = Path(__file__).resolve().parent / 'bin' / 'vp'


def fake_vp(project: Path, name: str) -> None:
    bin_dir = project / 'node_modules' / '.bin'
    bin_dir.mkdir(parents=True)
    script = bin_dir / 'vp'
    script.write_text(f'#!/bin/sh\necho "{name} $*"\nexit 3\n')
    script.chmod(0o755)


def run(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([str(LAUNCHER), *args], cwd=cwd, capture_output=True, text=True)


class VpLauncherTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(subprocess.run, ['rm', '-rf', str(self.root)])

    def test_runs_the_nearest_project_vp_with_its_arguments_and_exit_code(self) -> None:
        fake_vp(self.root, 'outer')
        inner = self.root / 'apps' / 'inner'
        fake_vp(inner, 'inner')
        nested = inner / 'src' / 'deep'
        nested.mkdir(parents=True)
        result = run(nested, 'run', 'check:changed', 'a b')
        self.assertEqual((result.returncode, result.stdout), (3, 'inner run check:changed a b\n'))
        self.assertEqual(run(self.root / 'apps').stdout, 'outer \n')

    def test_skips_a_vp_that_is_not_executable(self) -> None:
        fake_vp(self.root, 'outer')
        inner = self.root / 'inner'
        fake_vp(inner, 'inner')
        (inner / 'node_modules' / '.bin' / 'vp').chmod(0o644)
        self.assertEqual(run(inner).stdout, 'outer \n')

    def test_fails_with_an_install_hint_outside_a_project(self) -> None:
        result = run(self.root, '--version')
        self.assertEqual(result.returncode, 127)
        self.assertEqual(result.stdout, '')
        self.assertIn('run bun install', result.stderr)


if __name__ == '__main__':
    unittest.main()
