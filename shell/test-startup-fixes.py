"""Shell init cache, completion, PATH and installer boundary checks, using synthetic inputs."""
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
EXPLORE = ROOT.parent / 'explore' / 'explore.zsh'
# The layout the first installer targeted: compinit twice and live uv completions.
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
eval "$(atuin init zsh)"
'''
ZSHRC_INSTALLED = '''export KEEP_ME=unchanged
fpath=(~/.zsh/functions $fpath)
source $ZSH/oh-my-zsh.sh

# fnm
  eval "`fnm env --shell zsh --use-on-cd --version-file-strategy=recursive`"
source "$HOME/.config/shell/completions.zsh"

source "$HOME/.config/shell/interactive.zsh"
'''
BASHRC = '# preserve me\neval "$(atuin init bash)"\n'
# A layout without uv completions, with fnm's shell already named and Atuin's
# PATH set up only after bash initializes it.
PLAIN_ZSHRC = '''plugins=(git)

source $ZSH/oh-my-zsh.sh

if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --use-on-cd --version-file-strategy=recursive --shell zsh)"
fi

. "$HOME/.atuin/bin/env"

eval "$(atuin init zsh)"
'''
PLAIN_ZSHRC_INSTALLED = PLAIN_ZSHRC.replace(
    'source $ZSH/oh-my-zsh.sh\n',
    'source $ZSH/oh-my-zsh.sh\nsource "$HOME/.config/shell/completions.zsh"\n',
).replace('eval "$(atuin init zsh)"\n', 'source "$HOME/.config/shell/interactive.zsh"\n')
PLAIN_BASHRC = 'eval "$(atuin init bash)"\n\n. "$HOME/.atuin/bin/env"\n'


class ScratchTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix='shell-startup-test-')
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.env = dict(os.environ, TMPDIR=str(self.root),
                        PYTHONDONTWRITEBYTECODE='1')


class FixtureTest(ScratchTest):
    """Fake generators in a private PATH; each call is counted in <command>.calls."""

    def setUp(self):
        super().setUp()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.cache = self.root / 'cache' / 'shell-cache'
        self.mode = self.root / 'mode'
        self.mode.write_text('good')
        for name in list(self.env):
            if name.startswith(('ATUIN_', '_ZO_')):
                del self.env[name]
        self.env.update(PATH=f'{self.bin}:/usr/bin:/bin',
                        XDG_CACHE_HOME=str(self.cache.parent),
                        XDG_CONFIG_HOME=str(self.root / 'config'),
                        SHELL_TEST_ROOT=str(self.root))

    def script(self, filename, command, body):
        path = self.bin / filename
        path.write_text(f'''#!/bin/sh
printf 'call\\n' >> "$SHELL_TEST_ROOT/{command}.calls"
mode=$(cat "$SHELL_TEST_ROOT/mode")
if [ "$mode" = fail ]; then echo 'fixture failure' >&2; exit 7; fi
if [ "$mode" = syntax ]; then echo 'if then'; exit 0; fi
{body}
''')
        path.chmod(0o755)
        return path

    def calls(self, command):
        path = self.root / f'{command}.calls'
        return path.read_text().count('call\n') if path.exists() else 0

    def zsh(self, script, *args, interactive=False, **env):
        flags = '-fic' if interactive else '-fc'
        result = subprocess.run(['/bin/zsh', flags, script, 'test', *map(str, args)],
                                env=dict(self.env, **env), capture_output=True,
                                text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result


class CompletionTests(FixtureTest):
    def setUp(self):
        super().setUp()
        self.generator('uv-one', 'uv', 'one')
        self.generator('uvx', 'uvx', 'one')
        (self.bin / 'uv').symlink_to('uv-one')

    def generator(self, filename, command, version):
        # Generated like clap's zsh scripts: autoloaded, the file defines the
        # function and runs it; sourced, it registers itself with compdef.
        return self.script(filename, command, f'''cat <<'EOF'
#compdef {command}
_{command}() {{ print -r -- "completed:{command}:{version}"; }}
if [ "$funcstack[1]" = "_{command}" ]; then
  _{command} "$@"
else
  compdef _{command} {command}
fi
EOF''')

    def source(self, version='one', **env):
        script = '''typeset -gA _comps
compdef() { _comps[$2]=$1; }
source "$1"
print -r -- "uv:${_comps[uv]} uvx:${_comps[uvx]}"
print -r -- "deferred:${${functions[_uv]}[(w)1,(w)3]}"
_uv; _uvx
'''
        result = self.zsh(script, ROOT / 'completions.zsh', **env)
        self.assertIn('uv:_uv uvx:_uvx', result.stdout)
        self.assertIn(f'completed:uv:{version}\ncompleted:uvx:one', result.stdout)
        return result

    def test_completions_are_autoloaded_not_parsed_at_startup(self):
        result = self.source()
        self.assertIn('deferred:builtin autoload -X', result.stdout)
        self.assertEqual(result.stderr, '')

    def test_cache_hit_and_executable_identity_invalidation(self):
        self.source()
        self.source()
        self.assertEqual((self.calls('uv'), self.calls('uvx')), (1, 1))
        self.assertEqual(stat.S_IMODE(self.cache.stat().st_mode), 0o700)
        old_inode = (self.cache / '_uv').stat().st_ino
        replacement = self.generator('uv-two', 'uv', 'two')
        os.utime(replacement, (1, 1))
        (self.bin / 'uv').unlink()
        (self.bin / 'uv').symlink_to('uv-two')
        self.source('two')
        self.assertEqual((self.calls('uv'), self.calls('uvx')), (2, 1))
        self.assertNotEqual((self.cache / '_uv').stat().st_ino, old_inode)
        self.generator('uv-two', 'uv', 'longer_version')
        self.source('longer_version')
        self.assertEqual((self.calls('uv'), self.calls('uvx')), (3, 1))
        self.assertEqual({p.name for p in self.cache.iterdir()}, {'_uv', '_uvx'})
        for path in self.cache.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_failed_generation_preserves_previous_completions(self):
        self.source()
        previous = (self.cache / '_uv').read_bytes()
        for mode, diagnostic in [('fail', 'generation failed'),
                                 ('syntax', 'invalid syntax')]:
            with self.subTest(mode=mode):
                self.mode.write_text(mode)
                with (self.bin / 'uv-one').open('a') as stream:
                    stream.write(f'# invalidate {mode}\n')
                result = self.source()
                self.assertIn(diagnostic, result.stderr)
                self.assertEqual((self.cache / '_uv').read_bytes(), previous)
                self.assertEqual({p.name for p in self.cache.iterdir()}, {'_uv', '_uvx'})

    def test_insecure_cache_falls_back_without_loading_symlinks(self):
        self.source()
        self.cache.chmod(0o755)
        self.assertIn('insecure cache directory', self.source().stderr)
        self.assertEqual((self.calls('uv'), self.calls('uvx')), (2, 2))
        self.cache.chmod(0o700)
        path = self.cache / '_uv'
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

    def test_missing_tools_get_no_completions_and_no_diagnostics(self):
        (self.bin / 'uv').unlink()
        (self.bin / 'uvx').unlink()
        script = 'compdef() { print -r -- "compdef:$*"; }; source "$1"'
        result = self.zsh(script, ROOT / 'completions.zsh')
        self.assertEqual((result.stdout, result.stderr), ('', ''))
        self.assertFalse(self.cache.exists())

    def test_unusable_cache_path_falls_back(self):
        unusable = self.root / 'not-a-directory'
        unusable.touch()
        result = self.source(XDG_CACHE_HOME=str(unusable))
        self.assertIn('cache unavailable', result.stderr)


class InitCacheTests(FixtureTest):
    """_shell_cache keys and the top-level semantics of sourcing its output."""

    def setUp(self):
        super().setUp()
        # The output records the setting it saw when generated, like atuin and zoxide.
        self.script('tool', 'tool', '''printf 'typeset TOOL_SEEN=%s\\n' "${TOOL_SETTING-unset}:$*"
echo 'setopt interactive_comments' ''')
        self.depfile = self.root / 'tool.toml'

    def load(self, *args, **env):
        script = '''source "$1"; shift
if _shell_cache -f "$1" -e 'TOOL_*' -x TOOL_RUNTIME tool-init.zsh -- tool "${@:2}"; then
  source "$REPLY"
else
  eval "$REPLY"
fi
print -r -- "seen:$TOOL_SEEN comments:$options[interactivecomments]"
'''
        return self.zsh(script, ROOT / 'cache.zsh', self.depfile, *args, **env).stdout

    def test_output_runs_at_top_level(self):
        # typeset without -g and setopt would be undone if run inside a function.
        self.assertIn('seen:unset:init comments:on', self.load('init'))
        self.assertIn('seen:unset:init comments:on', self.load('init'))
        self.assertEqual(self.calls('tool'), 1)

    def test_arguments_files_and_exported_settings_invalidate(self):
        self.load('init')
        self.assertIn('seen:unset:other', self.load('other'))
        self.assertEqual(self.calls('tool'), 2)
        self.depfile.write_text('a = 1\n')
        self.load('other')
        self.assertEqual(self.calls('tool'), 3)
        self.depfile.write_text('a = 22\n')
        self.load('other')
        self.assertEqual(self.calls('tool'), 4)
        self.assertIn('seen:x:other', self.load('other', TOOL_SETTING='x'))
        self.assertIn('seen:y:other', self.load('other', TOOL_SETTING='y'))
        self.assertEqual(self.calls('tool'), 6)
        # Excluded and unexported names never force regeneration.
        self.load('other', TOOL_SETTING='y', TOOL_RUNTIME='1')
        self.load('other', TOOL_SETTING='y', TOOL_RUNTIME='2')
        script = '''source "$1"; TOOL_LOCAL=unexported
_shell_cache -e 'TOOL_*' -f "$2" tool-init.zsh -- tool other; print -r -- "rc:$?"
'''
        self.zsh(script, ROOT / 'cache.zsh', self.depfile, TOOL_SETTING='y')
        self.assertEqual(self.calls('tool'), 6)

    def test_stat_command_is_not_shadowed(self):
        script = '''source "$1"; _shell_cache -f "$2" tool-init.zsh -- tool init >/dev/null
print -r -- "${(k)builtins[(I)(z|)stat]}"; whence -w stat'''
        result = self.zsh(script, ROOT / 'cache.zsh', self.depfile)
        self.assertEqual(result.stdout, 'zstat\nstat: command\n')

    def test_empty_or_truncated_cache_is_regenerated(self):
        self.load('init')
        cache_file = self.cache / 'tool-init.zsh'
        for content in ['', '# shell-cache tool-init.zsh truncated']:
            with self.subTest(content=content):
                cache_file.write_text(content)
                calls = self.calls('tool')
                result = self.zsh('''source "$1"
_shell_cache -f "$2" -e 'TOOL_*' -x TOOL_RUNTIME tool-init.zsh -- tool init; print -r -- "rc:$?"''',
                                  ROOT / 'cache.zsh', self.depfile)
                self.assertEqual((result.stdout, result.stderr), ('rc:0\n', ''))
                self.assertEqual(self.calls('tool'), calls + 1)
                self.assertIn('seen:unset:init comments:on', self.load('init'))
                self.assertEqual(self.calls('tool'), calls + 1)

    def test_missing_command_reports_without_output(self):
        script = 'source "$1"; _shell_cache missing -- no-such-tool init; print -r -- "rc:$? reply:[$REPLY]"'
        result = self.zsh(script, ROOT / 'cache.zsh')
        self.assertIn('rc:1 reply:[]', result.stdout)
        self.assertIn('no-such-tool is unavailable', result.stderr)


class InteractiveTests(FixtureTest):
    def setUp(self):
        super().setUp()
        self.home = self.root / 'home'
        self.home.mkdir()
        self.env['HOME'] = str(self.home)
        self.script('atuin', 'atuin', '''printf 'typeset ATUIN_FAKE=%s\\n' "${ATUIN_NOBIND-bound}"
echo 'setopt interactive_comments' ''')

    def load(self, **env):
        script = '''source "$1"
print -r -- "atuin:$ATUIN_FAKE comments:$options[interactivecomments]"
print -r -- "path:$PATH"
print -r -- "fpath:${(j.:.)fpath}"
'''
        return self.zsh(script, ROOT / 'interactive.zsh', **env).stdout

    def test_atuin_init_is_cached_per_setting(self):
        self.assertIn('atuin:bound comments:on', self.load())
        self.load(ATUIN_SESSION='a', ATUIN_SHLVL='2', ATUIN_HISTORY_ID='h')
        self.assertEqual(self.calls('atuin'), 1)
        self.assertIn('atuin:true', self.load(ATUIN_NOBIND='true'))
        self.assertEqual(self.calls('atuin'), 2)

    def test_every_atuin_config_location_invalidates(self):
        custom = self.root / 'custom'
        for label, config, env in [
            ('default home', self.home / '.atuin' / 'config.toml', {}),
            ('ATUIN_HOME', self.root / 'atuin-home' / 'config.toml',
             {'ATUIN_HOME': str(self.root / 'atuin-home')}),
            ('XDG', self.root / 'config' / 'atuin' / 'config.toml', {}),
            ('ATUIN_CONFIG_DIR', custom / 'config.toml', {'ATUIN_CONFIG_DIR': str(custom)}),
        ]:
            with self.subTest(label):
                self.load(**env)
                calls = self.calls('atuin')
                config.parent.mkdir(parents=True, exist_ok=True)
                config.write_text('[tmux]\nenabled = true\n')
                self.load(**env)
                self.load(**env)
                self.assertEqual(self.calls('atuin'), calls + 1)

    def test_atuin_dotfiles_generate_init_live(self):
        config = self.home / '.atuin' / 'config.toml'
        config.parent.mkdir(parents=True)
        for label, text, env, live in [
            ('section', '[dotfiles]\nenabled = true\n', {}, True),
            ('indented, later table', 'a = 1\n  [dotfiles]\n  enabled=true\n[ui]\n', {}, True),
            ('dotted key', 'dotfiles.enabled = true\n', {}, True),
            ('inline table', 'dotfiles = { enabled = true }\n', {}, True),
            ('environment', '', {'ATUIN_DOTFILES__ENABLED': 'true'}, True),
            ('commented out', '[dotfiles]\n# enabled = true\n', {}, False),
            ('disabled', '[dotfiles]\nenabled = false\n[tmux]\nenabled = true\n', {}, False),
        ]:
            with self.subTest(label):
                config.write_text(text)
                calls = self.calls('atuin')
                for _ in range(2):
                    self.assertIn('atuin:bound comments:on', self.load(**env))
                self.assertEqual(self.calls('atuin') - calls, 2 if live else 1)

    def test_duplicate_path_entries_keep_first_occurrence(self):
        path = f'{self.bin}:/usr/bin:{self.bin}:/bin:/usr/bin'
        output = self.load(PATH=path, FPATH='/b:/a:/b')
        self.assertIn(f'path:{self.bin}:/usr/bin:/bin\n', output)
        self.assertIn('fpath:/b:/a\n', output)


class ExploreZoxideTests(FixtureTest):
    def setUp(self):
        super().setUp()
        self.script('zoxide', 'zoxide', '''printf 'typeset ZOXIDE_FAKE=%s\\n' "${_ZO_ECHO-0}"''')

    def load(self, explore=EXPLORE, **env):
        script = 'source "$1"; print -r -- "zoxide:$ZOXIDE_FAKE"'
        return self.zsh(script, explore, interactive=True, **env).stdout

    def test_zoxide_init_uses_dotfiles_cache(self):
        self.assertIn('zoxide:0', self.load())
        self.assertIn('zoxide:0', self.load())
        self.assertEqual(self.calls('zoxide'), 1)
        self.assertIn('zoxide:1', self.load(_ZO_ECHO='1'))
        self.assertEqual(self.calls('zoxide'), 2)

    def test_standalone_explore_initializes_zoxide_directly(self):
        standalone = self.root / 'standalone' / 'explore'
        standalone.mkdir(parents=True)
        shutil.copy(EXPLORE, standalone / 'explore.zsh')
        self.assertIn('zoxide:0', self.load(standalone / 'explore.zsh'))
        self.assertIn('zoxide:0', self.load(standalone / 'explore.zsh'))
        self.assertEqual(self.calls('zoxide'), 2)
        self.assertFalse(self.cache.exists())


class InstallerTests(ScratchTest):
    def setUp(self):
        super().setUp()
        self.zsh = self.root / '.zshrc'
        self.bash = self.root / '.bashrc'
        self.write(ZSHRC, BASHRC)
        self.zsh.chmod(0o640)
        self.bash.chmod(0o600)

    def write(self, zshrc, bashrc):
        self.zsh.write_text(zshrc)
        self.bash.write_text(bashrc)

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
        self.assertEqual(self.zsh.read_text(), ZSHRC_INSTALLED)
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

    def test_earlier_install_gets_only_the_interactive_setup(self):
        self.write(ZSHRC_INSTALLED.replace(
            'source "$HOME/.config/shell/interactive.zsh"\n', 'eval "$(atuin init zsh)"\n'),
            '# preserve me\nsource "$HOME/.atuin/bin/env"\neval "$(atuin init bash)"\n')
        bash = self.bash.read_bytes()
        self.install('--apply')
        self.assertEqual(self.zsh.read_text(), ZSHRC_INSTALLED)
        self.assertEqual(self.bash.read_bytes(), bash)
        self.assertEqual(len(list(self.root.glob('*.startup-backup-*'))), 1)

    def test_layout_without_uv_completions_or_atuin_path(self):
        self.write(PLAIN_ZSHRC, PLAIN_BASHRC)
        self.install('--apply')
        self.assertEqual(self.zsh.read_text(), PLAIN_ZSHRC_INSTALLED)
        self.assertEqual(self.bash.read_text(), 'source "$HOME/.atuin/bin/env"\n' + PLAIN_BASHRC)
        installed = self.snapshot()
        self.assertIn('already installed', self.install('--apply').stdout)
        self.assertEqual(self.snapshot(), installed)

    def test_commented_lines_are_ignored(self):
        comments = '# source $ZSH/oh-my-zsh.sh\n# fnm env --use-on-cd sets PATH\n'
        self.write(comments + PLAIN_ZSHRC, PLAIN_BASHRC)
        self.install('--apply')
        self.assertEqual(self.zsh.read_text(), comments + PLAIN_ZSHRC_INSTALLED)

    def assert_refused_without_changes(self, diagnostic):
        original = self.snapshot()
        result = self.install('--apply', succeeds=False)
        self.assertIn(diagnostic, result.stderr)
        self.assertEqual(self.snapshot(), original)

    def test_drift_refuses_all_writes(self):
        self.bash.write_text(BASHRC + BASHRC)
        self.assert_refused_without_changes('drift')

    def test_zsh_drift_refuses_all_writes(self):
        for label, zshrc in [
            ('repeated Atuin', PLAIN_ZSHRC + 'eval "$(atuin init zsh)"\n'),
            ('no Atuin', PLAIN_ZSHRC.replace('eval "$(atuin init zsh)"\n', '')),
            ('mixed uv', PLAIN_ZSHRC_INSTALLED + 'eval "$(uv generate-shell-completion zsh)"\n'),
            ('no Oh My Zsh', PLAIN_ZSHRC.replace('source $ZSH/oh-my-zsh.sh\n', '')),
            ('unknown fnm', PLAIN_ZSHRC.replace(' --version-file-strategy=recursive --shell zsh', '')),
            ('later compinit', PLAIN_ZSHRC + 'autoload -Uz compinit && compinit\n'),
            ('installed, later compinit', PLAIN_ZSHRC_INSTALLED + 'compinit -C\n'),
            ('quoted Oh My Zsh only', '# source $ZSH/oh-my-zsh.sh\n' + PLAIN_ZSHRC.replace(
                'source $ZSH/oh-my-zsh.sh\n', 'source "$ZSH/oh-my-zsh.sh"\n')),
        ]:
            with self.subTest(label):
                self.write(zshrc, PLAIN_BASHRC)
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
