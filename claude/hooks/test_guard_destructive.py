import os
import shlex
import tempfile
import unittest
from unittest.mock import patch

from guard_destructive import command_reason

ASK = [
    "rm -rf build",
    "rm -r -f build",
    "rm -fR build",
    "/bin/rm --recursive build",
    "cd /tmp && rm -rf x",
    "true; rm -rf x",
    "ls\nrm -rf x",
    "FOO=1 rm -rf x",
    "env -i rm -rf x",
    "find . -name '*.log' -delete",
    "find . -type d -exec rm -rf {} +",
    "xargs rm -rf < list",
    "sudo ls",
    "git push --force",
    "git push origin main --force",
    "git push -fu origin main",
    "git push --force-with-lease=main:abc123",
    "git push origin +main",
    "git push origin --delete old",
    "git push origin :old",
    "git -C repo reset --hard HEAD~1",
    "git reset --hard",
    "git clean -fdx",
    "git checkout -- src/app.ts",
    "git checkout .",
    "git restore src/app.ts",
    "git restore --staged --worktree src/app.ts",
    "git branch -D feature",
    "git branch --delete --force feature",
    "git stash drop",
    "git stash clear",
    "gh repo delete owner/repo --yes",
    "gh release delete v1",
    "gh api -X DELETE repos/o/r/git/refs/heads/x",
    "bash -c 'rm -rf x'",
    "sh -lc \"git reset --hard\"",
    "eval rm -rf x",
    "dd if=/dev/zero of=/dev/disk4",
    "diskutil eraseDisk APFS X disk4",
    "cat <<'EOF'\ndon't\nEOF\nrm -rf x",
    "rm -rf /tmp",
    "rm -rf /tmp/",
    "rm -rf /private/tmp",
    "rm -rf /tmp/../Users/x",
    "rm -rf /tmp/x ~/y",
    "rm -rf /tmp/*",
    "rm -rf /tmpfoo/x",
    "rm -rf $HOME/tmp/x",
    "rm -rf /tmp/x; rm -rf ~/y",
    "sudo rm -rf /tmp/x",
    "rm -rf",
    "rm -rf --",
    "rm -rf -- /tmp/x -outside",
    "rm -rf /tmp/a?",
    "rm -rf /tmp/[ab]",
    "rm -rf /tmp/{a,b}",
    "rm -rf '/tmp/`pwd`'",
    "rm -rf /tmp/$OTHER",
    "bash -c 'rm -rf ~/x'",
    "rm -rf /tmp/safe ';' /Users/example/important",
    "rm -rf /tmp/safe '' /Users/example/important",
    'rm -rf /tmp/safe ""',
    '''sh -c "rm -rf /tmp/safe '' /Users/example/important"''',
    "rm -rf -- /tmp/safe ';' /Users/example/important",
    r"rm -rf /tmp/safe \; /Users/example/important",
    '''sh -c "rm -rf /tmp/safe ';' /Users/example/important"''',
    "printf '%s\\n' /Users/example/important | xargs rm -rf /tmp/safe",
    "git checkout -- \"foo\\\n';'\"",
]

ALLOW = [
    "rm file.txt",
    "rm -f file.txt",
    "ls -la",
    "git status",
    "git push",
    "git push -u origin feature",
    "git push origin feature-fix",
    "git commit -m 'git reset --hard was not run; rm -rf mentioned'",
    "git clean -n",
    "git checkout main",
    "git checkout -b feature",
    "git restore --staged src/app.ts",
    "git branch -d merged",
    "git stash list",
    "gh pr view 1",
    "find . -name '*.py'",
    "echo rm -rf x",
    "grep -r pattern .",
    "cmd 2>&1 | tail",
    "cat <<'EOF'\ndon't worry\nEOF",
    "bash -c 'echo hi'",
    "rm -rf /tmp/tyd-shot",
    "rm -rf /tmp/a /tmp/b",
    "rm -r /private/tmp/x",
    "rm -rf -- /tmp/x",
    "rm --recursive /tmp/x",
    "rm -fR /tmp/x",
    "bash -c 'rm -rf /tmp/x'",
    "echo ';'; rm -rf /tmp/x",
]

TMPDIR_ASK = [
    "rm -rf $TMPDIR",
    "rm -rf ${TMPDIR}",
    'rm -rf "$TMPDIR"/../x',
    "rm -rf $TMPDIR_OTHER/x",
    "rm -rf ${TMPDIR}/$OTHER",
    "rm -rf '$TMPDIR/x'",
    r"rm -rf \$TMPDIR/x",
    r'rm -rf "\$TMPDIR/x"',
    "rm -rf '${TMPDIR}/x'",
    """env TMPDIR=/Users/example sh -c 'rm -rf "$TMPDIR/x"'""",
    """TMPDIR=/Users/example sh -c 'rm -rf "$TMPDIR/x"'""",
    """env -i sh -c 'rm -rf "$TMPDIR/x"'""",
    'TMPDIR=/Users/example; rm -rf "$TMPDIR/x"',
    'export TMPDIR=/Users/example; rm -rf "$TMPDIR/x"',
    'unset TMPDIR; rm -rf "$TMPDIR/x"',
]

TMPDIR_ALLOW = [
    'rm -rf "$TMPDIR/headless-browser"',
    "rm -rf ${TMPDIR}/x",
    'rm -rf /tmp/a && rm -rf "$TMPDIR/b"',
    '''echo '$TMPDIR/x'; rm -rf "$TMPDIR/x"''',
]


class GuardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix="guard-destructive-test-")
        cls.addClassCleanup(cls.scratch.cleanup)
        cls.tmpdir = os.path.join(cls.scratch.name, "tmp")
        os.mkdir(cls.tmpdir)

    def test_asks(self):
        for command in ASK:
            with self.subTest(command=command):
                self.assertIsNotNone(command_reason(command))

    def test_allows(self):
        for command in ALLOW:
            with self.subTest(command=command):
                self.assertIsNone(command_reason(command))

    def test_preflight_failure_preserves_rules(self):
        with patch("guard_destructive.scratch_unsafe_segments", side_effect=ValueError):
            self.assertEqual(command_reason("git checkout -- file"), "git checkout that discards changes")
            self.assertEqual(command_reason("rm -rf /tmp/x"), "recursive rm")
            self.assertIsNone(command_reason("git status"))

    def test_tmpdir(self):
        with patch.dict(os.environ, {"TMPDIR": self.tmpdir}):
            for command in TMPDIR_ASK:
                with self.subTest(command=command):
                    self.assertEqual(command_reason(command), "recursive rm")
            for command in TMPDIR_ALLOW:
                with self.subTest(command=command):
                    self.assertIsNone(command_reason(command))

    def test_tmpdir_unavailable(self):
        for tmpdir in (None, ""):
            with self.subTest(tmpdir=tmpdir), patch.dict(os.environ):
                if tmpdir is None:
                    os.environ.pop("TMPDIR", None)
                else:
                    os.environ["TMPDIR"] = tmpdir
                for command in ('rm -rf $TMPDIR/x', 'rm -rf ${TMPDIR}/x'):
                    self.assertEqual(command_reason(command), "recursive rm")

    def test_tmpdir_root_inside_tmp(self):
        with patch.dict(os.environ, {"TMPDIR": "/tmp/guard-scratch-root"}):
            for command in ("rm -rf $TMPDIR", "rm -rf ${TMPDIR}/", "rm -rf /tmp/guard-scratch-root"):
                with self.subTest(command=command):
                    self.assertEqual(command_reason(command), "recursive rm")
            self.assertEqual(command_reason('rm -rf "$TMPDIR/../x"'), "recursive rm")

    def test_symlink_outside_scratch(self):
        link = os.path.join(self.tmpdir, "outside")
        os.symlink(os.path.dirname(os.path.realpath(__file__)), link)
        with patch.dict(os.environ, {"TMPDIR": self.tmpdir}):
            for path in (link, link + "/child"):
                with self.subTest(path=path):
                    self.assertEqual(command_reason("rm -rf " + shlex.quote(path)), "recursive rm")


if __name__ == "__main__":
    unittest.main()
