"""Shell completion cache and installer boundary checks, using synthetic inputs."""
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
ZSHRC = '''export KEEP_ME=unchanged
source $ZSH/oh-my-zsh.sh

autoload -Uz compinit

# fnm
  eval "`fnm env --use-on-cd --version-file-strategy=recursive`"
eval "$(uv generate-shell-completion zsh)"
eval "$(uvx --generate-shell-completion zsh)"

fpath=(~/.zsh/functions $fpath)
autoload -Uz compinit
compinit
'''
BASHRC = '# preserve me\neval "$(atuin init bash)"\n'


class ScratchTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix='shell-startup-test-')
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.env = dict(os.environ, TMPDIR=str(self.root),
                        PYTHONDONTWRITEBYTECODE='1')


class CompletionTests(ScratchTest):
    def setUp(self):
        super().setUp()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.cache = self.root / 'cache' / 'shell-completions'
        self.mode = self.root / 'mode'
        self.mode.write_text('good')
        self.env.update(PATH=f'{self.bin}:/usr/bin:/bin',
                        XDG_CACHE_HOME=str(self.cache.parent),
                        SHELL_TEST_ROOT=str(self.root))
        self.generator('uv-one', 'uv', 'one')
        self.generator('uvx', 'uvx', 'one')
        (self.bin / 'uv').symlink_to('uv-one')

    def generator(self, filename, command, version):
        path = self.bin / filename
        path.write_text(f'''#!/bin/sh
printf 'call\\n' >> "$SHELL_TEST_ROOT/{command}.calls"
mode=$(cat "$SHELL_TEST_ROOT/mode")
if [ "$mode" = fail ]; then echo 'fixture failure' >&2; exit 7; fi
if [ "$mode" = syntax ]; then echo 'if then'; exit 0; fi
printf '%s\\n' 'function _fixture_{command}_{version}() {{ :; }}' 'compdef _fixture_{command}_{version} {command}'
''')
        path.chmod(0o755)
        return path

    def calls(self, command):
        return (self.root / f'{command}.calls').read_text().count('call\n')

    def source(self, version='one', **env):
        script = '''typeset -gA _comps
compdef() { _comps[$2]=$1; }
source "$1"
print -r -- "uv:${_comps[uv]} uvx:${_comps[uvx]}"
'''
        result = subprocess.run(['/bin/zsh', '-fc', script, 'test',
                                 str(ROOT / 'completions.zsh')],
                                env=dict(self.env, **env), capture_output=True,
                                text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'uv:_fixture_uv_{version} uvx:_fixture_uvx_one',
                      result.stdout)
        return result

    def test_cache_hit_and_executable_identity_invalidation(self):
        self.source()
        self.source()
        self.assertEqual((self.calls('uv'), self.calls('uvx')), (1, 1))
        self.assertEqual(stat.S_IMODE(self.cache.stat().st_mode), 0o700)
        old_inode = (self.cache / 'uv.zsh').stat().st_ino
        replacement = self.generator('uv-two', 'uv', 'two')
        os.utime(replacement, (1, 1))
        (self.bin / 'uv').unlink()
        (self.bin / 'uv').symlink_to('uv-two')
        self.source('two')
        self.assertEqual((self.calls('uv'), self.calls('uvx')), (2, 1))
        self.assertNotEqual((self.cache / 'uv.zsh').stat().st_ino, old_inode)
        self.generator('uv-two', 'uv', 'longer_version')
        self.source('longer_version')
        self.assertEqual((self.calls('uv'), self.calls('uvx')), (3, 1))
        self.assertEqual({p.name for p in self.cache.iterdir()},
                         {'uv.zsh', 'uvx.zsh'})
        for path in self.cache.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_failed_generation_preserves_previous_completions(self):
        self.source()
        previous = (self.cache / 'uv.zsh').read_bytes()
        for mode, diagnostic in [('fail', 'generation failed'),
                                 ('syntax', 'invalid syntax')]:
            with self.subTest(mode=mode):
                self.mode.write_text(mode)
                with (self.bin / 'uv-one').open('a') as stream:
                    stream.write(f'# invalidate {mode}\n')
                result = self.source()
                self.assertIn(diagnostic, result.stderr)
                self.assertEqual((self.cache / 'uv.zsh').read_bytes(), previous)
                self.assertEqual({p.name for p in self.cache.iterdir()},
                                 {'uv.zsh', 'uvx.zsh'})

    def test_insecure_cache_falls_back_without_sourcing_symlinks(self):
        self.source()
        self.cache.chmod(0o755)
        self.assertIn('insecure cache directory', self.source().stderr)
        self.assertEqual((self.calls('uv'), self.calls('uvx')), (2, 2))
        self.cache.chmod(0o700)
        path = self.cache / 'uv.zsh'
        path.chmod(0o644)
        self.assertIn('insecure cache file', self.source().stderr)
        path.unlink()
        hostile = self.root / 'hostile.zsh'
        hostile.write_text('print UNEXPECTED_SOURCE\n')
        hostile.chmod(0o600)
        path.symlink_to(hostile)
        result = self.source()
        self.assertIn('insecure cache file', result.stderr)
        self.assertNotIn('UNEXPECTED_SOURCE', result.stdout)

    def test_unusable_cache_path_falls_back(self):
        unusable = self.root / 'not-a-directory'
        unusable.touch()
        result = self.source(XDG_CACHE_HOME=str(unusable))
        self.assertIn('cache unavailable', result.stderr)


class InstallerTests(ScratchTest):
    def setUp(self):
        super().setUp()
        self.zsh = self.root / '.zshrc'
        self.bash = self.root / '.bashrc'
        self.zsh.write_text(ZSHRC)
        self.bash.write_text(BASHRC)
        self.zsh.chmod(0o640)
        self.bash.chmod(0o600)

    def install(self, *args, succeeds=True):
        result = subprocess.run([sys.executable,
                                 str(ROOT / 'apply-startup-fixes.py'),
                                 '--target-dir', str(self.root), *args],
                                env=self.env, capture_output=True, text=True,
                                timeout=10)
        self.assertEqual(result.returncode == 0, succeeds, result.stderr)
        return result

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.root.iterdir()
                if p.is_file()}

    def test_dry_run_apply_backups_and_idempotence(self):
        original = self.snapshot()
        self.assertIn('Dry run', self.install().stdout)
        self.assertEqual(self.snapshot(), original)
        self.install('--apply')
        self.assertNotIn('compinit', self.zsh.read_text())
        self.assertIn('export KEEP_ME=unchanged', self.zsh.read_text())
        self.assertIn('--shell zsh --use-on-cd', self.zsh.read_text())
        self.assertEqual(self.bash.read_text(),
                         '# preserve me\nsource "$HOME/.atuin/bin/env"\n'
                         'eval "$(atuin init bash)"\n')
        self.assertEqual(stat.S_IMODE(self.zsh.stat().st_mode), 0o640)
        self.assertEqual(stat.S_IMODE(self.bash.stat().st_mode), 0o600)
        backups = list(self.root.glob('*.startup-backup-*'))
        self.assertEqual(len(backups), 2)
        for backup in backups:
            self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
            name = backup.name.split('.startup-backup-')[0]
            self.assertEqual(backup.read_bytes(), original[name])
        installed = self.snapshot()
        self.assertIn('already installed', self.install('--apply').stdout)
        self.assertEqual(self.snapshot(), installed)

    def assert_refused_without_changes(self, diagnostic):
        original = self.snapshot()
        result = self.install('--apply', succeeds=False)
        self.assertIn(diagnostic, result.stderr)
        self.assertEqual(self.snapshot(), original)

    def test_drift_refuses_all_writes(self):
        self.bash.write_text(BASHRC + BASHRC)
        self.assert_refused_without_changes('drift')

    def test_syntax_error_refuses_all_writes(self):
        self.zsh.write_text(ZSHRC + '\nif then\n')
        self.assert_refused_without_changes('Syntax validation')

    def test_symlink_target_refuses_all_writes(self):
        actual = self.root / 'real-bash'
        self.bash.rename(actual)
        self.bash.symlink_to(actual.name)
        self.assert_refused_without_changes('non-regular or symlink')
        self.assertEqual(len(list(self.root.iterdir())), 3)


if __name__ == '__main__':
    unittest.main()
