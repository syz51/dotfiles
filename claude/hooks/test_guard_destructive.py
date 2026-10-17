import unittest

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
]


class GuardTest(unittest.TestCase):
    def test_asks(self):
        for command in ASK:
            with self.subTest(command=command):
                self.assertIsNotNone(command_reason(command))

    def test_allows(self):
        for command in ALLOW:
            with self.subTest(command=command):
                self.assertIsNone(command_reason(command))


if __name__ == "__main__":
    unittest.main()
