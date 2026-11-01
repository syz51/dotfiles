"""Installer updates must preserve local upstream merges and dirty sources."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BRANCH = 'feat/divider-inset'


class InstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix='tuios-installer-')

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def setUp(self):
        self.root = Path(self.scratch.name) / self._testMethodName
        self.root.mkdir()
        self.env = dict(os.environ, HOME=str(self.root / 'home'),
                        XDG_CONFIG_HOME=str(self.root / 'config'),
                        XDG_DATA_HOME=str(self.root / 'data'),
                        XDG_CACHE_HOME=str(self.root / 'cache'),
                        GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')
        self.remote = self.root / 'remote.git'
        self.seed = self.root / 'seed'
        self.source = self.root / 'data/tuios-fork'
        self.legacy = self.root / 'cache/tuios-fork'
        self.git(self.root, 'init', '--bare', f'--initial-branch={BRANCH}', str(self.remote))
        self.git(self.root, 'init', f'--initial-branch={BRANCH}', str(self.seed))
        self.base = self.commit(self.seed, 'base')
        self.git(self.seed, 'remote', 'add', 'origin', str(self.remote))
        self.git(self.seed, 'push', 'origin', BRANCH)
        self.legacy.parent.mkdir()
        self.git(self.root, 'clone', str(self.remote), str(self.legacy))

        wrapper = self.root / 'config/tuios/bin/tuios'
        wrapper.parent.mkdir(parents=True)
        shutil.copy2(ROOT / 'bin/tuios', wrapper)
        fakebin = self.root / 'fakebin'
        fakebin.mkdir()
        go = fakebin / 'go'
        go.write_text('''#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then output=$2; shift; fi
  shift
done
printf '#!/bin/sh\necho %s\n' "$(git rev-parse HEAD)" > "$output"
chmod +x "$output"
''')
        go.chmod(0o755)
        self.env['PATH'] = str(fakebin) + os.pathsep + self.env['PATH']

    def git(self, cwd, *args):
        result = subprocess.run(['git', '-C', str(cwd), *args], env=self.env,
                                capture_output=True, text=True, check=True)
        return result.stdout.strip()

    def commit(self, repo, name):
        (repo / name).write_text(name)
        self.git(repo, 'add', name)
        self.git(repo, '-c', 'user.name=Installer test', '-c',
                 'user.email=installer-test@localhost', '-c', 'commit.gpgsign=false',
                 'commit', '-m', name)
        return self.git(repo, 'rev-parse', 'HEAD')

    def install(self):
        return subprocess.run(['/bin/sh', str(ROOT / 'install-fork.sh')],
                              env=self.env, capture_output=True, text=True)

    def test_local_update_survives_migration_and_repeat_install(self):
        local = self.commit(self.legacy, 'local-upstream-merge')
        self.git(self.legacy, 'checkout', '--detach', local)
        for _ in range(2):
            result = self.install()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.git(self.source, 'rev-parse', 'HEAD'), local)
            self.assertIn(local, result.stdout)
        self.assertFalse(self.legacy.exists())

    def test_remote_fast_forward_is_installed(self):
        remote = self.commit(self.seed, 'remote-update')
        self.git(self.seed, 'push', 'origin', BRANCH)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(self.source, 'rev-parse', 'HEAD'), remote)
        self.assertIn(remote, result.stdout)

    def test_divergence_keeps_local_commit_and_installed_binary(self):
        local = self.commit(self.legacy, 'local-update')
        self.commit(self.seed, 'remote-update')
        self.git(self.seed, 'push', 'origin', BRANCH)
        binary = self.root / 'home/.local/opt/tuios-fork/tuios'
        binary.parent.mkdir(parents=True)
        binary.write_text('previous binary')
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git(self.source, 'rev-parse', 'HEAD'), local)
        self.assertEqual(binary.read_text(), 'previous binary')

    def test_uncommitted_changes_are_preserved(self):
        (self.legacy / 'base').write_text('uncommitted work')
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('uncommitted changes', result.stderr)
        self.assertEqual((self.source / 'base').read_text(), 'uncommitted work')
        self.assertEqual(self.git(self.source, 'rev-parse', 'HEAD'), self.base)


if __name__ == '__main__':
    unittest.main()
