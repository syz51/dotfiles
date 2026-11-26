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

    def check(self, runner, now=NOW, board="board", repos_file=None):
        """Runs a check; what it printed is in self.stdout and self.stderr."""
        self.stdout, self.stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(self.stdout), contextlib.redirect_stderr(self.stderr):
            return sync.check(self.repo, self.state, runner, board, now, "mac", repos_file=repos_file)

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

    def links(self, *, lexists, which, gemini=False):
        def fake_lexists(path):
            if path == Path.home() / ".gemini" / "config":
                return gemini
            return lexists
        with mock.patch.dict(sync.os.environ, {"CODEX_HOME": "/codex"}), \
                mock.patch.object(sync.os.path, "lexists", side_effect=fake_lexists) as exists, \
                mock.patch.object(sync.shutil, "which", return_value=which):
            pairs = sync.links(Path("/r"))
        exists.assert_any_call(Path.home() / ".claude")
        return pairs

    def test_the_default_links_cover_claude_and_codex(self):
        with mock.patch.dict(sync.os.environ, {"CODEX_HOME": "/codex"}), \
                mock.patch.object(sync.os.path, "lexists", return_value=False), \
                mock.patch.object(sync.shutil, "which", return_value="/bin/claude") as which:
            pairs = sync.links(Path("/r"))
        which.assert_called_once_with("claude", path=sync.SEARCH_PATH)
        self.assertEqual(pairs, [(Path.home() / ".claude", Path("/r/claude")), (Path("/codex/AGENTS.md"), Path("/r/codex/AGENTS.md"))])

    def test_a_mac_without_claude_code_needs_no_claude_link(self):
        # The Pro runs no Claude model, so a missing ~/.claude there is not a problem to report.
        self.assertEqual(self.links(lexists=False, which=None), [(Path("/codex/AGENTS.md"), Path("/r/codex/AGENTS.md"))])

    def test_an_existing_claude_home_is_checked_without_the_command(self):
        # A moved or updating install must not hide a ~/.claude that became a copy.
        self.assertEqual(self.links(lexists=True, which=None)[0], (Path.home() / ".claude", Path("/r/claude")))

    def test_an_existing_gemini_config_checks_gemini_links(self):
        pairs = self.links(lexists=False, which=None, gemini=True)
        self.assertEqual(pairs, [
            (Path.home() / ".gemini/config/GEMINI.md", Path("/r/gemini/GEMINI.md")),
            (Path.home() / ".gemini/config/SKILLS_CATALOG.md", Path("/r/gemini/SKILLS_CATALOG.md")),
            (Path.home() / ".gemini/config/hooks.json", Path("/r/gemini/hooks.json")),
            (Path.home() / ".gemini/config/mcp_config.json", Path("/r/gemini/mcp_config.json")),
            (Path.home() / ".gemini/config/skills/cheat-sheets", Path("/r/claude/skills/cheat-sheets")),
            (Path.home() / ".gemini/config/skills/diff-review", Path("/r/claude/skills/diff-review")),
            (Path.home() / ".gemini/config/skills/full-stop", Path("/r/claude/skills/full-stop")),
            (Path.home() / ".gemini/config/skills/headless-browser", Path("/r/claude/skills/headless-browser")),
            (Path.home() / ".gemini/config/skills/ui-climb", Path("/r/claude/skills/ui-climb")),
            (Path.home() / ".gemini/config/skills/work-stages", Path("/r/claude/skills/work-stages")),
            (Path.home() / ".local/bin/gnotebook", Path("/r/gemini/bin/gnotebook")),
            (Path.home() / ".local/bin/gnotebook-monitor", Path("/r/gemini/bin/gnotebook-monitor")),
            (Path("/codex/AGENTS.md"), Path("/r/codex/AGENTS.md")),
        ])


class ExtraReposTests(Sandbox):
    """Host-local extra main checkouts listed in repos.txt (dotfiles-458)."""

    def make_extra(self, name, branch="main"):
        root = Path(self.temp.name) / "extras" / name
        origin = root / "origin.git"
        upstream = root / "upstream"
        checkout = root / name
        root.mkdir(parents=True)
        git(root, "init", "--bare", "-b", branch, str(origin))
        git(root, "clone", str(origin), str(upstream))
        (upstream / "README.md").write_text(f"{name}\n")
        git(upstream, "add", ".")
        git(upstream, "commit", "-m", "first")
        git(upstream, "push", "origin", f"HEAD:{branch}")
        git(root, "clone", str(origin), str(checkout))
        return {"name": name, "branch": branch, "origin": origin, "upstream": upstream, "checkout": checkout}

    def advance_extra(self, extra, filename="next"):
        (extra["upstream"] / f"{filename}.txt").write_text(filename)
        git(extra["upstream"], "add", ".")
        git(extra["upstream"], "commit", "-m", filename)
        git(extra["upstream"], "push", "origin", f"HEAD:{extra['branch']}")
        return git(extra["upstream"], "rev-parse", "HEAD")

    def extra_head(self, extra):
        return git(extra["checkout"], "rev-parse", "HEAD")

    def write_repos(self, *lines, path=None):
        target = path or (self.state / "repos.txt")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("\n".join(str(line) for line in lines) + "\n")
        return target

    def events(self):
        path = self.state / "events.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_missing_repos_file_means_no_extra_checkouts(self):
        target = self.advance()
        runner = Runner()
        self.assertEqual(self.check(runner), 0)
        self.assertEqual(self.head(), target)
        self.assertEqual(runner.reports(), [])
        self.assertEqual(self.state_json()["repos"], {})

    def test_clean_extra_checkout_fast_forwards_and_logs_event(self):
        papers = self.make_extra("papers")
        self.write_repos(papers["checkout"])
        target = self.advance_extra(papers)
        runner = Runner()
        self.assertEqual(self.check(runner), 0)
        self.assertEqual(self.extra_head(papers), target)
        self.assertEqual(runner.reports(), [])
        self.assertIn("pulled ", self.stdout.getvalue())
        events = self.events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["repo"], sync.short(papers["checkout"]))
        self.assertEqual(events[0]["pulled"][1], target)
        self.assertEqual(self.state_json()["repos"][sync.short(papers["checkout"])]["head"], target)

    def test_untracked_file_in_extra_checkout_does_not_block_fast_forward(self):
        rf = self.make_extra("research-factory")
        self.write_repos(rf["checkout"])
        (rf["checkout"] / ".research").mkdir()
        (rf["checkout"] / ".research" / "scratch.txt").write_text("local")
        target = self.advance_extra(rf)
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.extra_head(rf), target)
        self.assertEqual((rf["checkout"] / ".research" / "scratch.txt").read_text(), "local")
        self.assertEqual(runner.reports(), [])

    def test_clashing_untracked_file_in_extra_checkout_reports_pull_failed(self):
        rf = self.make_extra("research-factory")
        self.write_repos(rf["checkout"])
        before = self.extra_head(rf)
        self.advance_extra(rf, "clash")
        (rf["checkout"] / "clash.txt").write_text("mine")
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.extra_head(rf), before)
        self.assertEqual((rf["checkout"] / "clash.txt").read_text(), "mine")
        reports = runner.reports()
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0][9], "config-sync:research-factory:pull-failed")
        self.assertIn("- pull-failed:", reports[0][11])

    def test_dirty_extra_checkout_is_left_unchanged_and_reported_without_settings_restore(self):
        # Extra repos never run ~/.config's claude/settings.json reformat restore.
        extra = self.make_extra("guwen")
        (extra["upstream"] / "claude").mkdir()
        (extra["upstream"] / "claude" / "settings.json").write_text('{"a": 1, "b": 2}\n')
        git(extra["upstream"], "add", ".")
        git(extra["upstream"], "commit", "-m", "settings")
        git(extra["upstream"], "push", "origin", "HEAD:main")
        git(extra["checkout"], "pull", "-q", "--ff-only")
        self.write_repos(extra["checkout"])
        primary_target = self.advance()
        before = self.extra_head(extra)
        self.advance_extra(extra)
        (extra["checkout"] / "claude" / "settings.json").write_text('{"b": 2,\n  "a": 1}\n')
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.head(), primary_target)
        self.assertEqual(self.extra_head(extra), before)
        self.assertEqual((extra["checkout"] / "claude" / "settings.json").read_text(), '{"b": 2,\n  "a": 1}\n')
        reports = runner.reports()
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0][9], "config-sync:guwen:dirty")
        self.assertIn("- dirty:", reports[0][11])
        self.assertIn("claude/settings.json", reports[0][11])
        self.assertIn("Nothing was changed;", reports[0][11])

    def test_staged_change_in_extra_checkout_is_reported_as_dirty(self):
        extra = self.make_extra("prov")
        self.write_repos(extra["checkout"])
        before = self.extra_head(extra)
        self.advance_extra(extra)
        (extra["checkout"] / "README.md").write_text("staged\n")
        git(extra["checkout"], "add", "README.md")
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.extra_head(extra), before)
        reports = runner.reports()
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0][9], "config-sync:prov:dirty")

    def test_local_commits_and_diverged_extra_checkout_are_reported_and_kept(self):
        ahead_only = self.make_extra("claimcheck")
        diverged = self.make_extra("ireval")
        self.write_repos(ahead_only["checkout"], diverged["checkout"])
        for extra in (ahead_only, diverged):
            (extra["checkout"] / "local.txt").write_text("local")
            git(extra["checkout"], "add", ".")
            git(extra["checkout"], "commit", "-q", "-m", "local")
        before_ahead = self.extra_head(ahead_only)
        before_diverged = self.extra_head(diverged)
        self.advance_extra(diverged)
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.extra_head(ahead_only), before_ahead)
        self.assertEqual(self.extra_head(diverged), before_diverged)
        reports = runner.reports()
        self.assertEqual(len(reports), 2)
        self.assertEqual(reports[0][9], "config-sync:claimcheck:diverged")
        self.assertIn("1 local commit(s) are not on origin/main", reports[0][11])
        self.assertEqual(reports[1][9], "config-sync:ireval:diverged")
        self.assertIn("1 local commit(s) are not on origin/main", reports[1][11])

    def test_off_branch_and_non_main_default_branch_extra_checkouts(self):
        on_main = self.make_extra("papers", branch="main")
        on_fork = self.make_extra("t3code", branch="fork")
        detached = self.make_extra("agentprof", branch="main")
        self.write_repos(on_main["checkout"], on_fork["checkout"], detached["checkout"])
        # Clean t3code on its default branch (`fork`) fast-forwards.
        fork_target = self.advance_extra(on_fork)
        git(on_main["checkout"], "checkout", "-q", "-b", "feature")
        git(detached["checkout"], "checkout", "-q", "--detach", "HEAD")
        before_main = self.extra_head(on_main)
        before_detached = self.extra_head(detached)
        self.advance_extra(on_main)
        self.advance_extra(detached)
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.extra_head(on_fork), fork_target)
        self.assertEqual(self.extra_head(on_main), before_main)
        self.assertEqual(self.extra_head(detached), before_detached)
        reports = runner.reports()
        self.assertEqual(len(reports), 2)
        self.assertEqual(reports[0][9], "config-sync:papers:off-main")
        self.assertIn("on feature, not main", reports[0][11])
        self.assertEqual(reports[1][9], "config-sync:agentprof:off-main")
        self.assertIn("on a detached HEAD, not main", reports[1][11])
        # Moving t3code off its `fork` default branch reports `off-branch`.
        git(on_fork["checkout"], "checkout", "-q", "-b", "main")
        before_fork = self.extra_head(on_fork)
        self.advance_extra(on_fork, "later")
        runner2 = Runner()
        self.check(runner2)
        self.assertEqual(self.extra_head(on_fork), before_fork)
        self.assertEqual(len(runner2.reports()), 1)
        self.assertEqual(runner2.reports()[0][9], "config-sync:t3code:off-branch")
        self.assertIn("on main, not fork", runner2.reports()[0][11])

    def test_extra_checkout_without_origin_head_resolves_default_branch_via_ls_remote(self):
        extra = self.make_extra("t3code", branch="fork")
        git(extra["checkout"], "remote", "set-head", "origin", "-d")
        self.write_repos(extra["checkout"])
        target = self.advance_extra(extra)
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.extra_head(extra), target)
        self.assertEqual(runner.reports(), [])

    def test_repos_file_ignores_comments_blanks_duplicates_and_primary(self):
        extra = self.make_extra("guwen")
        self.write_repos(
            "# Host-local checkouts",
            "",
            self.repo,
            f"  {extra['checkout']}  ",
            f"{extra['checkout']}/",
            "# end",
        )
        target = self.advance_extra(extra)
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.extra_head(extra), target)
        self.assertEqual(list(self.state_json()["repos"].keys()), [sync.short(extra["checkout"])])

    def test_missing_and_non_repo_entries_report_without_blocking_valid_repos(self):
        valid = self.make_extra("papers")
        missing = Path(self.temp.name) / "gone-repo"
        non_repo = Path(self.temp.name) / "plain-dir"
        non_repo.mkdir()
        self.write_repos(missing, non_repo, valid["checkout"])
        target = self.advance_extra(valid)
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.extra_head(valid), target)
        sigs = [call[9] for call in runner.reports()]
        self.assertEqual(sigs, ["config-sync:gone-repo:missing", "config-sync:plain-dir:not-a-repo"])
        # Repeat check deduplicates; removing from repos.txt prunes state.
        self.check(runner, NOW + timedelta(hours=1))
        self.assertEqual(len(runner.reports()), 2)
        self.write_repos(valid["checkout"])
        self.check(runner, NOW + timedelta(hours=2))
        self.assertEqual(list(self.state_json()["repos"].keys()), [sync.short(valid["checkout"])])

    def test_extra_repo_fetch_failure_respects_grace_period_independently(self):
        extra = self.make_extra("papers")
        url = git(extra["checkout"], "remote", "get-url", "origin")
        git(extra["checkout"], "remote", "set-url", "origin", str(Path(self.temp.name) / "broken.git"))
        self.write_repos(extra["checkout"])
        runner = Runner()
        self.check(runner)
        self.check(runner, NOW + timedelta(hours=23))
        self.assertEqual(runner.reports(), [])
        self.assertIsNone(self.state_json()["fetch_failing_since"])
        self.assertEqual(self.state_json()["repos"][sync.short(extra["checkout"])]["fetch_failing_since"], NOW.isoformat())
        self.check(runner, NOW + timedelta(hours=24))
        self.assertEqual(len(runner.reports()), 1)
        self.assertEqual(runner.reports()[0][9], "config-sync:papers:fetch-failed")
        # Recovery clears fetch_failing_since and reported state.
        git(extra["checkout"], "remote", "set-url", "origin", url)
        self.check(runner, NOW + timedelta(hours=25))
        entry = self.state_json()["repos"][sync.short(extra["checkout"])]
        self.assertIsNone(entry["fetch_failing_since"])
        self.assertEqual(entry["reported"], [])

    def test_extra_repo_dedup_reset_and_cli_repos_file_flag(self):
        extra = self.make_extra("guwen")
        custom = Path(self.temp.name) / "custom-repos.txt"
        self.write_repos(extra["checkout"], path=custom)
        (extra["checkout"] / "README.md").write_text("dirty\n")
        runner = Runner()
        self.check(runner, repos_file=custom)
        self.check(runner, NOW + timedelta(hours=1), repos_file=custom)
        self.assertEqual(len(runner.reports()), 1)
        git(extra["checkout"], "checkout", "--", ".")
        target = self.advance_extra(extra)
        self.check(runner, NOW + timedelta(hours=2), repos_file=custom)
        self.assertEqual(self.extra_head(extra), target)
        self.assertEqual(self.state_json()["repos"][sync.short(extra["checkout"])]["reported"], [])
        # Status prints repos_file and extra_repos.
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(sync.main(["status", "--state-dir", str(self.state), "--repos-file", str(custom)], run=runner), 0)
        status = json.loads(out.getvalue())
        self.assertEqual(status["extra_repos"], [sync.short(extra["checkout"])])

    def test_unreadable_repos_file_reports_without_stopping_primary(self):
        extra = self.make_extra("papers")
        self.write_repos(extra["checkout"])
        self.check(Runner())
        (self.state / "repos.txt").unlink()
        (self.state / "repos.txt").mkdir()
        target = self.advance()
        runner = Runner()
        self.check(runner)
        self.assertEqual(self.head(), target)
        self.assertEqual(len(runner.reports()), 1)
        self.assertEqual(runner.reports()[0][9], "config-sync:repos-file")
        # Previous extra repo state is preserved across transient read errors.
        self.assertIn(sync.short(extra["checkout"]), self.state_json()["repos"])


if __name__ == "__main__":
    unittest.main()
