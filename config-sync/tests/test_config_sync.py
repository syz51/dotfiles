import contextlib
import importlib.util
import io
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "config_sync.py"
spec = importlib.util.spec_from_file_location("config_sync", SCRIPT)
sync = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = sync
spec.loader.exec_module(sync)

NOW = datetime(2026, 11, 7, 12, 0, tzinfo=timezone.utc)
GIT_ENV = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"]


def git(cwd, *args):
    result = subprocess.run(["git", *GIT_ENV, *args], cwd=cwd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {result.stderr}")
    return result.stdout.strip()


class Runner:
    """Runs git for real and records board and osascript calls, failing the ones asked to fail."""

    def __init__(self, fail=()):
        self.calls = []
        self.fail = set(fail)

    def __call__(self, args):
        if args[0] == "git":
            return sync.run_command(args)
        self.calls.append(args)
        kind = ("full" if "--about" in args else "plain") if args[0] == "board" else args[0]
        return subprocess.CompletedProcess(args, 1 if kind in self.fail else 0, "", "")

    def reports(self):
        return [call for call in self.calls if call[0] in ("board", "/usr/bin/osascript")]


class Sandbox(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.origin = root / "origin.git"
        self.upstream = root / "upstream"
        self.repo = root / "home" / ".config"
        self.state = root / "state"
        git(root, "init", "--bare", str(self.origin))
        git(root, "clone", str(self.origin), str(self.upstream))
        (self.upstream / "claude").mkdir()
        (self.upstream / "claude" / "CLAUDE.md").write_text("rules\n")
        (self.upstream / "codex").mkdir()
        (self.upstream / "codex" / "AGENTS.md").write_text("rules\n")
        git(self.upstream, "add", ".")
        git(self.upstream, "commit", "-m", "first")
        git(self.upstream, "push", "origin", "HEAD:main")
        git(root, "clone", str(self.origin), str(self.repo))
        # The installed links, pointing at the checkout as on a set-up Mac.
        self.home = root / "home"
        (self.home / ".claude").symlink_to(self.repo / "claude")
        (self.home / ".codex").mkdir()
        (self.home / ".codex" / "AGENTS.md").symlink_to(self.repo / "codex" / "AGENTS.md")
        patcher = mock.patch.object(sync, "links", lambda repo: [
            (self.home / ".claude", repo / "claude"),
            (self.home / ".codex" / "AGENTS.md", repo / "codex" / "AGENTS.md"),
        ])
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.temp.cleanup)

    def advance(self, name="next"):
        (self.upstream / f"{name}.txt").write_text(name)
        git(self.upstream, "add", ".")
        git(self.upstream, "commit", "-m", name)
        git(self.upstream, "push", "origin", "HEAD:main")
        return git(self.upstream, "rev-parse", "HEAD")

    def check(self, runner, now=NOW, board="board"):
        """Runs a check; what it printed is in self.stdout and self.stderr."""
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(self.stdout), contextlib.redirect_stderr(self.stderr):
            return sync.check(self.repo, self.state, runner, board, now, "mac")

    def head(self):
        return git(self.repo, "rev-parse", "HEAD")

    def state_json(self):
        return json.loads((self.state / "state.json").read_text())


class PullTests(Sandbox):
    def test_a_clean_checkout_fast_forwards_without_reporting(self):
        target = self.advance()
        runner = Runner()
        self.assertEqual(self.check(runner), 0)
        self.assertEqual(self.head(), target)
        self.assertEqual(runner.reports(), [])
        event = json.loads((self.state / "events.jsonl").read_text())
        self.assertEqual(event["pulled"][1], target)

    def test_an_up_to_date_checkout_logs_no_event(self):
        self.check(Runner())
        self.assertFalse((self.state / "events.jsonl").exists())
        self.assertEqual(self.state_json()["head"], self.head())

    def test_untracked_files_do_not_block_the_pull(self):
        (self.repo / "scratch.txt").write_text("mine")
        target = self.advance()
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.head(), target)
        self.assertEqual((self.repo / "scratch.txt").read_text(), "mine")
        self.assertEqual(runner.reports(), [])


class BlockedTests(Sandbox):
    def assert_reported_untouched(self, runner, before, kind):
        self.assertEqual(self.head(), before)
        reports = runner.reports()
        self.assertEqual(len(reports), 1)
        call = reports[0]
        self.assertEqual(call[:9], ["board", "--agent", "claude:config-sync", "feedback", "--about", "config-sync", "--activity", "operate", "--signature"])
        self.assertEqual(call[9:11], [f"config-sync:{kind}", "--"])
        self.assertIn(f"- {kind}:", call[11])
        self.assertTrue(call[11].startswith("config-sync on mac: "))

    def test_tracked_changes_are_reported_and_kept(self):
        before = self.head()
        self.advance()
        (self.repo / "claude" / "CLAUDE.md").write_text("hand-copied\n")
        runner = Runner()
        self.check(runner)
        self.assert_reported_untouched(runner, before, "dirty")
        self.assertEqual((self.repo / "claude" / "CLAUDE.md").read_text(), "hand-copied\n")
        self.assertIn("claude/CLAUDE.md", runner.reports()[0][11])

    def test_another_branch_is_reported_and_kept(self):
        git(self.repo, "checkout", "-q", "-b", "work")
        before = self.head()
        self.advance()
        runner = Runner()
        self.check(runner)
        self.assert_reported_untouched(runner, before, "off-main")
        self.assertEqual(git(self.repo, "branch", "--show-current"), "work")

    def test_local_commits_are_reported_as_diverged(self):
        (self.repo / "local.txt").write_text("local")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "local")
        before = self.head()
        self.advance()
        runner = Runner()
        self.check(runner)
        self.assert_reported_untouched(runner, before, "diverged")
        self.assertIn("1 local commit(s)", runner.reports()[0][11])

    def test_an_untracked_file_in_the_way_is_reported_as_a_failed_pull(self):
        before = self.head()
        self.advance("clash")
        (self.repo / "clash.txt").write_text("mine")
        runner = Runner()
        self.check(runner)
        self.assert_reported_untouched(runner, before, "pull-failed")
        self.assertEqual((self.repo / "clash.txt").read_text(), "mine")

    def test_a_linked_folder_above_the_file_counts_as_linked(self):
        # As on a Mac where ~/.codex itself links to ~/.config/codex.
        codex = self.home / ".codex"
        (codex / "AGENTS.md").unlink()
        codex.rmdir()
        codex.symlink_to(self.repo / "codex")
        runner = Runner()
        self.check(runner)
        self.assertEqual(runner.reports(), [])

    def test_a_copied_instruction_file_is_reported_after_pulling(self):
        link = self.home / ".codex" / "AGENTS.md"
        link.unlink()
        link.write_text("old copy\n")
        target = self.advance()
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.head(), target)
        text = runner.reports()[0][11]
        self.assertIn("- link: ", text)
        self.assertIn("AGENTS.md is a copy, not a link to ", text)


class ReformatTests(Sandbox):
    """A Claude Code plugin install rewrites claude/settings.json in its own layout (dotfiles-281)."""

    COMMITTED = '{\n  "a": 1,\n  "f": 1e3,\n  "market": {"source": {"sparsePaths": [".x", "y"]}, "autoUpdate": true},\n  "enabledPlugins": {"p@dotfiles": true}\n}\n'

    def setUp(self):
        super().setUp()
        (self.upstream / "claude" / "settings.json").write_text(self.COMMITTED)
        (self.upstream / "other.json").write_text(self.COMMITTED)
        git(self.upstream, "add", ".")
        git(self.upstream, "commit", "-m", "settings")
        git(self.upstream, "push", "origin", "HEAD:main")
        git(self.repo, "pull", "-q", "--ff-only")
        self.settings = self.repo / "claude" / "settings.json"

    def rewrite(self, path=None, **changes):
        # As the plugin installer writes it: keys moved, arrays expanded, two-space indent,
        # and numbers as JavaScript prints them (1e3 as 1000).
        data = dict(reversed(list(json.loads(self.COMMITTED).items())))
        data.update(changes)
        (path or self.settings).write_text(json.dumps(data, indent=2).replace("1000.0", "1000"))

    def events(self):
        return [json.loads(line) for line in (self.state / "events.jsonl").read_text().splitlines()]

    def test_a_reformatted_settings_file_gets_its_committed_text_and_pulls(self):
        self.rewrite()
        target = self.advance()
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.settings.read_text(), self.COMMITTED)
        self.assertEqual(self.head(), target)
        self.assertEqual(runner.reports(), [])
        event = json.loads((self.state / "events.jsonl").read_text())
        self.assertEqual(event["restored"], ["claude/settings.json"])

    def test_a_reformat_is_restored_and_logged_with_nothing_to_pull(self):
        self.rewrite()
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.settings.read_text(), self.COMMITTED)
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")
        self.assertEqual(runner.reports(), [])
        self.assertEqual([event.get("restored") for event in self.events()], [["claude/settings.json"]])

    def test_a_restore_with_another_problem_says_what_it_changed(self):
        local = self.repo / "local.txt"
        local.write_text("local")
        git(self.repo, "add", "local.txt")
        git(self.repo, "commit", "-q", "-m", "local")
        self.rewrite()
        self.advance()
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.settings.read_text(), self.COMMITTED)
        text = runner.reports()[0][11]
        self.assertIn("- diverged:", text)
        self.assertIn("Only the committed text of claude/settings.json (same JSON) was restored;", text)
        self.assertNotIn("Nothing was changed", text)

    def assert_kept_and_reported(self, text, *paths):
        before = self.head()
        self.advance()
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.settings.read_text(), text)
        self.assertEqual(self.head(), before)
        for path in ("claude/settings.json", *paths):
            self.assertIn(path, runner.reports()[0][11])
        self.assertFalse(any("restored" in event for event in self.events()))
        return runner.reports()[0][11]

    def test_a_reformat_next_to_another_change_is_kept_and_reported(self):
        self.rewrite()
        (self.repo / "claude" / "CLAUDE.md").write_text("edit\n")
        self.assert_kept_and_reported(self.settings.read_text(), "claude/CLAUDE.md")

    def test_other_json_files_are_not_restored(self):
        # Key order can matter elsewhere (package.json "exports"), so only the settings file is restored.
        self.rewrite(self.repo / "other.json")
        before = self.head()
        self.advance()
        runner = Runner()
        self.check(runner)
        self.assertNotEqual((self.repo / "other.json").read_text(), self.COMMITTED)
        self.assertEqual(self.head(), before)
        self.assertIn("other.json", runner.reports()[0][11])

    def test_a_write_during_the_restore_is_kept(self):
        # A session writes a real change after config-sync read the reformatted file.
        self.rewrite()
        changed = self.settings.read_text().replace('"p@dotfiles": true', '"p@dotfiles": false')
        real_read = Path.read_text
        reads = []

        def read_text(path, *args, **kwargs):
            if path == self.settings:
                reads.append(path)
                if len(reads) == 2:
                    path.write_text(changed)
            return real_read(path, *args, **kwargs)

        with mock.patch.object(Path, "read_text", read_text):
            self.assert_kept_and_reported(changed)
        self.assertEqual(sorted(p.name for p in self.settings.parent.iterdir()), ["CLAUDE.md", "settings.json"])

    def test_a_failed_restore_is_reported(self):
        self.rewrite()
        text = self.settings.read_text()
        folder = self.settings.parent
        folder.chmod(0o555)
        self.addCleanup(folder.chmod, 0o755)
        report = self.assert_kept_and_reported(text)
        self.assertIn("- restore-failed: could not restore the committed text of claude/settings.json: ", report)

    def test_numbers_compare_by_value(self):
        self.rewrite()
        self.assertIn('"f": 1000,', self.settings.read_text())
        self.check(Runner())
        self.assertEqual(self.settings.read_text(), self.COMMITTED)

    def test_a_changed_value_is_kept_and_reported(self):
        # An install that enables a plugin main does not enable is a real change.
        self.rewrite(enabledPlugins={"p@dotfiles": True, "other@dotfiles": True})
        self.assert_kept_and_reported(self.settings.read_text())

    def test_a_value_of_another_json_type_counts_as_a_change(self):
        self.rewrite(a=True)
        self.assert_kept_and_reported(self.settings.read_text())

    def test_unparsable_json_is_kept_and_reported(self):
        self.settings.write_text(self.COMMITTED + "}")
        self.assert_kept_and_reported(self.COMMITTED + "}")

    def test_a_staged_reformat_is_kept_and_reported(self):
        self.rewrite()
        git(self.repo, "add", "claude/settings.json")
        self.assert_kept_and_reported(self.settings.read_text())

    def test_a_reformat_off_main_is_left_alone(self):
        git(self.repo, "checkout", "-q", "-b", "work")
        self.rewrite()
        text = self.settings.read_text()
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.settings.read_text(), text)
        self.assertIn("- off-main:", runner.reports()[0][11])


class ReportTests(Sandbox):
    def make_dirty(self):
        (self.repo / "claude" / "CLAUDE.md").write_text("edit\n")

    def test_the_same_problems_are_reported_once(self):
        self.make_dirty()
        runner = Runner()
        self.check(runner)
        self.check(runner, NOW + timedelta(hours=1))
        self.assertEqual(len(runner.reports()), 1)

    def test_a_changed_problem_reports_again_and_a_fixed_one_resets(self):
        self.make_dirty()
        runner = Runner()
        self.check(runner)
        (self.repo / "codex" / "AGENTS.md").write_text("edit\n")
        self.check(runner)
        self.assertEqual(len(runner.reports()), 2)
        git(self.repo, "checkout", "--", ".")
        self.check(runner)
        self.assertEqual(self.state_json()["reported"], [])
        self.make_dirty()
        self.check(runner)
        self.assertEqual(len(runner.reports()), 3)

    def test_an_older_board_cli_gets_the_plain_command(self):
        self.make_dirty()
        runner = Runner(fail={"full"})
        self.check(runner)
        plain = runner.reports()[1]
        self.assertEqual(plain[:5], ["board", "--agent", "claude:config-sync", "feedback", "--"])
        self.assertTrue(plain[5].startswith("[config-sync] config-sync on mac: "))
        self.assertEqual(json.loads((self.state / "events.jsonl").read_text())["reported"], "feedback-plain")

    def test_an_unreachable_board_falls_back_to_a_notification(self):
        self.make_dirty()
        runner = Runner(fail={"full", "plain"})
        self.check(runner)
        self.assertEqual(runner.reports()[-1][0], "/usr/bin/osascript")
        self.assertEqual(json.loads((self.state / "events.jsonl").read_text())["reported"], "notification")

    def test_no_board_cli_notifies(self):
        self.make_dirty()
        runner = Runner()
        self.check(runner, board=None)
        self.assertEqual([call[0] for call in runner.reports()], ["/usr/bin/osascript"])


class FetchTests(Sandbox):
    def break_remote(self):
        git(self.repo, "remote", "set-url", "origin", str(Path(self.temp.name) / "gone.git"))

    def test_a_failing_fetch_reports_only_after_a_day(self):
        self.break_remote()
        runner = Runner()
        self.check(runner)
        self.check(runner, NOW + timedelta(hours=23))
        self.assertEqual(runner.reports(), [])
        self.assertEqual(self.state_json()["fetch_failing_since"], NOW.isoformat())
        self.check(runner, NOW + timedelta(hours=24))
        self.assertEqual(len(runner.reports()), 1)
        self.assertIn("fetch-failed", runner.reports()[0][9])

    def test_a_working_fetch_clears_the_failure(self):
        url = git(self.repo, "remote", "get-url", "origin")
        self.break_remote()
        self.check(Runner())
        git(self.repo, "remote", "set-url", "origin", url)
        self.check(Runner(), NOW + timedelta(hours=30))
        self.assertIsNone(self.state_json()["fetch_failing_since"])


class LockTests(Sandbox):
    """A live suite run holds a lock in state/locks; config-sync leaves ~/.claude alone meanwhile."""

    def lock(self, text, name="live-suite-1.lock", age=timedelta(minutes=1)):
        path = self.state / "locks" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        stamp = (NOW - age).timestamp()
        os.utime(path, (stamp, stamp))
        return path

    def dead_pid(self):
        child = subprocess.Popen(["true"])
        child.wait()
        return child.pid

    def test_a_held_lock_skips_the_pull_and_logs_why(self):
        before = self.head()
        self.advance()
        self.lock(f"{os.getpid()}\n")
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.head(), before)
        self.assertIn(f"skipped: a live suite run holds live-suite-1.lock (pid {os.getpid()})", self.stdout.getvalue())
        event = json.loads((self.state / "events.jsonl").read_text())
        self.assertEqual(event["locks"], [f"live-suite-1.lock (pid {os.getpid()})"])
        self.assertNotIn("pulled", event)
        self.assertEqual(self.state_json()["last_check"], NOW.isoformat())

    def test_a_lock_taken_during_the_fetch_skips_the_rest(self):
        before = self.head()
        self.advance()
        test = self

        class LockingRunner(Runner):
            def __call__(self, args):
                result = super().__call__(args)
                if "fetch" in args:
                    test.lock(f"{os.getpid()}\n")
                return result

        self.check(LockingRunner())
        self.assertEqual(self.head(), before)
        self.assertIn("skipped: a live suite run holds", self.stdout.getvalue())
        self.assertIsNone(self.state_json()["head"])

    def test_a_held_lock_leaves_a_reformat_and_reported_problems_alone(self):
        settings = self.repo / "claude" / "settings.json"
        (self.upstream / "claude" / "settings.json").write_text('{"a": 1, "b": 2}\n')
        git(self.upstream, "add", ".")
        git(self.upstream, "commit", "-m", "settings")
        git(self.upstream, "push", "origin", "HEAD:main")
        self.check(Runner())
        (self.home / ".codex" / "AGENTS.md").unlink()
        (self.home / ".codex" / "AGENTS.md").write_text("copy\n")
        self.check(Runner())
        reported = self.state_json()["reported"]
        settings.write_text('{"b": 2,\n  "a": 1}\n')
        lock = self.lock(f"{os.getpid()}\n")
        runner = Runner()
        self.check(runner)
        self.assertEqual(settings.read_text(), '{"b": 2,\n  "a": 1}\n')
        self.assertEqual(runner.calls, [])
        self.assertEqual(self.state_json()["reported"], reported)
        # Released: the next check restores the reformat and does not file the same problems again.
        lock.unlink()
        self.check(runner)
        self.assertEqual(settings.read_text(), '{"a": 1, "b": 2}\n')
        self.assertEqual(runner.calls, [])
        self.assertEqual(self.state_json()["reported"], reported)

    def test_a_released_lock_pulls_again(self):
        lock = self.lock(f"{os.getpid()}\n")
        target = self.advance()
        self.check(Runner())
        lock.unlink()
        self.check(Runner())
        self.assertEqual(self.head(), target)

    def test_a_lock_folder_entry_that_cannot_be_read_is_stale(self):
        (self.state / "locks" / "folder.lock").mkdir(parents=True)
        target = self.advance()
        self.check(Runner())
        self.assertEqual(self.head(), target)
        self.assertIn("could not remove the stale lock", self.stderr.getvalue())

    def test_stale_locks_do_not_stop_the_pull_and_are_removed(self):
        for name, text, age in [
            ("dead", f"{self.dead_pid()}\n", timedelta(minutes=1)),
            ("unparsable", "not a pid\n", timedelta(minutes=1)),
            ("empty", "", timedelta(minutes=1)),
            ("group", "0\n", timedelta(minutes=1)),
            ("negative", "-1\n", timedelta(minutes=1)),
            ("huge", f"{2**64}\n", timedelta(minutes=1)),
            ("old", f"{os.getpid()}\n", sync.MAX_HOLD),
        ]:
            with self.subTest(name):
                lock = self.lock(text, f"{name}.lock", age)
                target = self.advance(name)
                self.check(Runner())
                self.assertEqual(self.head(), target)
                self.assertFalse(lock.exists())

    def test_other_files_in_the_locks_folder_are_not_locks(self):
        self.lock(f"{os.getpid()}\n", ".live-suite-1.tmp")
        target = self.advance()
        self.check(Runner())
        self.assertEqual(self.head(), target)

    def test_no_locks_folder_pulls(self):
        target = self.advance()
        self.check(Runner())
        self.assertFalse((self.state / "locks").exists())
        self.assertEqual(self.head(), target)


class InstallTests(unittest.TestCase):
    def test_the_agent_runs_check_every_half_hour_with_the_board_on_path(self):
        agent = sync.launch_agent("/bin/uv", Path("/repo/config-sync/config_sync.py"), Path("/state"))
        self.assertEqual(agent["Label"], "com.syz51.config-sync")
        self.assertEqual(agent["ProgramArguments"][-2:], ["/repo/config-sync/config_sync.py", "check"])
        self.assertLessEqual(agent["StartInterval"], 3600)
        self.assertTrue(agent["RunAtLoad"])
        self.assertIn(str(Path.home() / ".cargo" / "bin"), agent["EnvironmentVariables"]["PATH"].split(":"))
        plistlib.dumps(agent)

    def test_install_dry_run_prints_the_plist(self):
        out = io.StringIO()
        with mock.patch.object(sync.shutil, "which", return_value="/bin/uv"), contextlib.redirect_stdout(out):
            self.assertEqual(sync.main(["install", "--dry-run"], run=Runner()), 0)
        self.assertEqual(plistlib.loads(out.getvalue().encode())["Label"], "com.syz51.config-sync")

    def test_the_default_links_cover_claude_and_codex(self):
        with mock.patch.dict(sync.os.environ, {"CODEX_HOME": "/codex"}):
            pairs = sync.links(Path("/r"))
        self.assertEqual(pairs, [(Path.home() / ".claude", Path("/r/claude")), (Path("/codex/AGENTS.md"), Path("/r/codex/AGENTS.md"))])


if __name__ == "__main__":
    unittest.main()
