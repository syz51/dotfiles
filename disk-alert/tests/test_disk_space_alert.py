import contextlib
import importlib.util
import io
import json
import os
import plistlib
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "disk_space_alert.py"
spec = importlib.util.spec_from_file_location("disk_space_alert", SCRIPT)
alert = importlib.util.module_from_spec(spec)
# dataclasses resolve string annotations through sys.modules.
sys.modules[spec.name] = alert
spec.loader.exec_module(alert)
# No test may reach the real Claude Code folders: the defaults point at an empty folder.
SANDBOX = tempfile.TemporaryDirectory()
alert.DEFAULT_CLAUDE_TMP = Path(SANDBOX.name) / "claude-tmp"
alert.DEFAULT_CLAUDE_PROJECTS = Path(SANDBOX.name) / "projects"
alert.DEFAULT_CLAUDE_SESSIONS = Path(SANDBOX.name) / "sessions"
alert.DEFAULT_WORKTREES = Path(SANDBOX.name) / "worktrees"

NOW = datetime(2026, 11, 7, 12, 0, tzinfo=timezone.utc)
THREAD = "mcp:11111111-2222-3333-4444-555555555555"


class FakeRunner:
    """Records commands and answers t3 and osascript calls."""

    def __init__(self, start_code=0, send_code=0, notify_code=0, start_stdout=None,
                 ps="/sbin/launchd\n", lsof="p1\nn/\n", ps_code=0):
        self.calls = []
        self.start_code = start_code
        self.send_code = send_code
        self.notify_code = notify_code
        self.start_stdout = start_stdout or json.dumps({"threadId": THREAD})
        self.ps, self.lsof, self.ps_code = ps, lsof, ps_code

    def __call__(self, args, input_text):
        self.calls.append((list(args), input_text))
        if args[0] == "ps":
            return subprocess.CompletedProcess(args, self.ps_code, self.ps, "")
        if args[0] == "lsof":
            return subprocess.CompletedProcess(args, 1, self.lsof, "lsof: WARNING")
        if args[1:3] == ["thread", "start"]:
            out = self.start_stdout if self.start_code == 0 else ""
            return subprocess.CompletedProcess(args, self.start_code, out, "server unreachable")
        if args[1:3] == ["thread", "send"]:
            return subprocess.CompletedProcess(args, self.send_code, "{}", "Thread was not found.")
        return subprocess.CompletedProcess(args, self.notify_code, "", "notification refused")

    def kinds(self):
        kinds = []
        for args, _ in self.calls:
            if args[0] in ("ps", "lsof"):
                kinds.append(args[0])
            elif args[1:3] == ["thread", "start"]:
                kinds.append("start")
            elif args[1:3] == ["thread", "send"]:
                kinds.append("send")
            else:
                kinds.append("notify")
        return kinds


CONFIG = alert.Config(t3="t3", osascript="osascript", t3_project="/scratch")


class ClassifyTest(unittest.TestCase):
    def test_thresholds_from_ok(self):
        self.assertEqual(alert.classify(30.0, "ok", 30, 20), "ok")
        self.assertEqual(alert.classify(29.9, "ok", 30, 20), "low")
        self.assertEqual(alert.classify(20.0, "ok", 30, 20), "low")
        self.assertEqual(alert.classify(19.9, "ok", 30, 20), "critical")

    def test_low_eases_only_past_margin(self):
        self.assertEqual(alert.classify(31.9, "low", 30, 20), "low")
        self.assertEqual(alert.classify(32.0, "low", 30, 20), "ok")

    def test_critical_eases_only_past_margin(self):
        self.assertEqual(alert.classify(21.9, "critical", 30, 20), "critical")
        self.assertEqual(alert.classify(22.0, "critical", 30, 20), "low")
        self.assertEqual(alert.classify(31.0, "critical", 30, 20), "low")
        self.assertEqual(alert.classify(40.0, "critical", 30, 20), "ok")


class PlanTest(unittest.TestCase):
    def test_no_event_while_ok(self):
        self.assertIsNone(alert.plan(alert.State(), "ok", NOW))

    def test_worse_level_escalates(self):
        self.assertEqual(alert.plan(alert.State(), "low", NOW), "escalated")
        recent = alert.State(level="low", last_alert_at=NOW.isoformat())
        self.assertEqual(alert.plan(recent, "critical", NOW), "escalated")

    def test_same_level_reminds_after_a_day(self):
        recent = alert.State(level="low", last_alert_at=(NOW - timedelta(hours=23)).isoformat())
        self.assertIsNone(alert.plan(recent, "low", NOW))
        old = alert.State(level="low", last_alert_at=(NOW - timedelta(hours=24)).isoformat())
        self.assertEqual(alert.plan(old, "low", NOW), "reminder")

    def test_easing_from_critical_to_low_is_quiet(self):
        recent = alert.State(level="critical", last_alert_at=NOW.isoformat())
        self.assertIsNone(alert.plan(recent, "low", NOW))

    def test_pending_delivery_retries(self):
        pending = alert.State(level="low", last_alert_at=NOW.isoformat(), pending=True)
        self.assertEqual(alert.plan(pending, "low", NOW), "retry")

    def test_back_to_ok_recovers(self):
        self.assertEqual(alert.plan(alert.State(level="low"), "ok", NOW), "recovered")


class CheckTest(unittest.TestCase):
    def test_first_alert_starts_thread_and_notifies(self):
        run = FakeRunner()
        state, record = alert.check(25.0, alert.State(), NOW, CONFIG, run)
        self.assertEqual(run.kinds(), ["start", "notify"])
        start_args, message = run.calls[0]
        self.assertEqual(
            start_args,
            ["t3", "thread", "start", "--json", "--title", "Low disk space: 25.0 GB free", "/scratch", "-"],
        )
        self.assertIn("25.0 GB", message)
        self.assertIn("Do not delete, move or change anything", message)
        self.assertIn("Details in T3 Code.", run.calls[1][0][-1])
        self.assertEqual(state, alert.State("low", THREAD, NOW.isoformat(timespec="seconds"), False))
        self.assertEqual(record["event"], "escalated")
        self.assertIsNone(record["t3_error"])

    def test_later_alert_goes_to_same_thread(self):
        run = FakeRunner()
        previous = alert.State("low", THREAD, (NOW - timedelta(hours=1)).isoformat(), False)
        state, record = alert.check(15.0, previous, NOW, CONFIG, run)
        self.assertEqual(run.kinds(), ["send", "notify"])
        self.assertEqual(run.calls[0][0], ["t3", "thread", "send", "--json", THREAD, "-"])
        self.assertIn("15.0 GB", run.calls[0][1])
        self.assertIn("critical", run.calls[1][0][-2].lower())
        self.assertEqual(state.level, "critical")
        self.assertEqual(state.thread_id, THREAD)

    def test_missing_thread_falls_back_to_new_thread(self):
        run = FakeRunner(send_code=1)
        previous = alert.State("low", "mcp:gone", (NOW - timedelta(days=2)).isoformat(), False)
        state, record = alert.check(25.0, previous, NOW, CONFIG, run)
        self.assertEqual(run.kinds(), ["send", "start", "notify"])
        self.assertEqual(state.thread_id, THREAD)
        self.assertFalse(state.pending)
        self.assertEqual(record["event"], "reminder")

    def test_unreachable_t3_marks_pending_and_says_so(self):
        run = FakeRunner(start_code=1)
        state, record = alert.check(25.0, alert.State(), NOW, CONFIG, run)
        self.assertTrue(state.pending)
        self.assertIsNone(state.thread_id)
        self.assertIn("start exit 1", record["t3_error"])
        self.assertIn("could not be reached; retrying", run.calls[-1][0][-1])
        self.assertEqual(state.last_alert_at, NOW.isoformat(timespec="seconds"))

    def test_failed_send_and_start_keeps_thread_and_retries(self):
        run = FakeRunner(send_code=1, start_code=1)
        previous = alert.State("low", THREAD, (NOW - timedelta(days=2)).isoformat(), False)
        state, record = alert.check(25.0, previous, NOW, CONFIG, run)
        self.assertTrue(state.pending)
        self.assertEqual(state.thread_id, THREAD)
        self.assertIn("send exit 1", record["t3_error"])
        self.assertIn("start exit 1", record["t3_error"])

    def test_retry_delivers_without_notifying_again(self):
        run = FakeRunner()
        pending = alert.State("low", None, NOW.isoformat(), True)
        state, record = alert.check(25.0, pending, NOW + timedelta(minutes=10), CONFIG, run)
        self.assertEqual(run.kinds(), ["start"])
        self.assertFalse(state.pending)
        self.assertEqual(state.thread_id, THREAD)
        self.assertEqual(state.last_alert_at, NOW.isoformat())

    def test_failed_retry_stays_pending_quietly(self):
        run = FakeRunner(start_code=1)
        pending = alert.State("low", None, NOW.isoformat(), True)
        state, _ = alert.check(25.0, pending, NOW + timedelta(minutes=10), CONFIG, run)
        self.assertEqual(run.kinds(), ["start"])
        self.assertTrue(state.pending)

    def test_start_without_thread_id_is_not_retried(self):
        run = FakeRunner(start_stdout="not json")
        state, record = alert.check(25.0, alert.State(), NOW, CONFIG, run)
        self.assertFalse(state.pending)
        self.assertIsNone(state.thread_id)
        self.assertIn("no thread id, not retrying", record["t3_error"])
        self.assertIn("may not have received it", run.calls[-1][0][-1])
        later, _ = alert.check(25.0, state, NOW + timedelta(minutes=10), CONFIG, run)
        self.assertEqual(run.kinds(), ["start", "notify"])
        self.assertFalse(later.pending)

    def test_start_timeout_is_not_retried(self):
        run = FakeRunner(start_code=alert.TIMEOUT_EXIT)
        state, record = alert.check(25.0, alert.State(), NOW, CONFIG, run)
        self.assertFalse(state.pending)
        self.assertIn("not retrying in case it went through", record["t3_error"])

    def test_thread_id_is_read_from_last_json_line(self):
        stdout = 'warning: update available\n{"threadId": "mcp:abc", "runId": "r"}\n'
        self.assertEqual(alert.started_thread_id(stdout), "mcp:abc")
        self.assertIsNone(alert.started_thread_id('["mcp:abc"]\n{"threadId": 5}\n'))

    def test_recovery_notifies_once_and_resets(self):
        run = FakeRunner()
        previous = alert.State("critical", THREAD, NOW.isoformat(), False)
        state, record = alert.check(40.0, previous, NOW, CONFIG, run)
        self.assertEqual(run.kinds(), ["notify"])
        self.assertEqual(run.calls[0][0][-2], "Disk space recovered")
        self.assertEqual(state, alert.State())
        self.assertEqual(record["event"], "recovered")

    def test_quiet_check_only_updates_level(self):
        run = FakeRunner()
        previous = alert.State("critical", THREAD, NOW.isoformat(), False)
        state, record = alert.check(25.0, previous, NOW, CONFIG, run)
        self.assertEqual(run.calls, [])
        self.assertIsNone(record)
        self.assertEqual(state, alert.State("low", THREAD, NOW.isoformat(), False))

    def test_channels_can_be_disabled(self):
        run = FakeRunner()
        config = alert.Config(t3=None, osascript=None)
        state, record = alert.check(15.0, alert.State(), NOW, config, run)
        self.assertEqual(run.calls, [])
        self.assertFalse(state.pending)
        self.assertEqual(state.level, "critical")

    def test_notification_failure_is_recorded(self):
        run = FakeRunner(notify_code=1)
        _, record = alert.check(25.0, alert.State(), NOW, CONFIG, run)
        self.assertIn("osascript exit 1", record["notify_error"])


SESSION = "0a9024fd-a30a-4bb8-8c37-bbfa4baf0b29"
OTHER = "4225d866-30e2-494e-a22c-4a2fb40e92ac"


def dead_pid():
    """A pid that just exited and was reaped."""
    child = subprocess.Popen(["true"])
    child.wait()
    return child.pid


class SweepTest(unittest.TestCase):
    """Files made now count as idle two days ahead; a recent change is an mtime set
    after the 24-hour cutoff."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.claude_tmp = self.root / "claude-501"
        self.projects = self.root / "projects"
        self.registry = self.root / "sessions"
        self.registry.mkdir()
        self.now = datetime.now(timezone.utc) + timedelta(days=2)
        self.project = "-Users-me-repo"
        self.config = replace(
            CONFIG,
            state_dir=self.root / "state",
            claude_tmp=self.claude_tmp,
            claude_projects=self.projects,
            claude_sessions=self.registry,
        )

    def tearDown(self):
        for folder, dirs, _ in os.walk(self.root):
            for name in dirs:
                path = os.path.join(folder, name)
                if not os.path.islink(path):
                    os.chmod(path, 0o700)
        self.tmp.cleanup()

    def session(self, session_id=SESSION, size=4096):
        folder = self.claude_tmp / self.project / session_id
        (folder / "scratchpad" / "target").mkdir(parents=True)
        (folder / "scratchpad" / "target" / "lib.rlib").write_bytes(b"x" * size)
        (folder / "tasks").mkdir()
        transcripts = self.projects / self.project
        transcripts.mkdir(parents=True, exist_ok=True)
        (transcripts / f"{session_id}.jsonl").write_text("{}\n")
        return folder

    def touch_recent(self, path):
        recent = (self.now - timedelta(hours=1)).timestamp()
        os.utime(path, (recent, recent), follow_symlinks=False)

    def sweep(self, runner=None, dry_run=False, clock=None):
        options = {"clock": clock} if clock else {}
        return alert.sweep_sessions(self.config, runner or FakeRunner(), self.now, dry_run, **options)

    def test_idle_session_is_removed_with_its_size(self):
        folder = self.session(size=100_000)
        swept = self.sweep()
        self.assertEqual([item.path for item in swept], [str(folder)])
        self.assertGreaterEqual(swept[0].bytes, 100_000)
        self.assertIsNone(swept[0].error)
        self.assertFalse(folder.exists())
        self.assertTrue((self.projects / self.project / f"{SESSION}.jsonl").exists())

    def test_hard_links_count_once(self):
        folder = self.session(size=1_000_000)
        os.link(folder / "scratchpad" / "target" / "lib.rlib", folder / "scratchpad" / "copy.rlib")
        (size,) = [item.bytes for item in self.sweep(dry_run=True)]
        self.assertLess(size, 1_500_000)

    def test_recent_file_in_the_folder_keeps_it(self):
        folder = self.session()
        self.touch_recent(folder / "scratchpad" / "target" / "lib.rlib")
        self.assertEqual(self.sweep(), [])
        self.assertTrue(folder.exists())

    def test_recent_transcript_or_subagent_transcript_keeps_it(self):
        folder = self.session()
        self.touch_recent(self.projects / self.project / f"{SESSION}.jsonl")
        self.assertEqual(self.sweep(), [])
        other = self.session(OTHER)
        subagents = self.projects / self.project / OTHER / "subagents"
        subagents.mkdir(parents=True)
        (subagents / "agent-a1.jsonl").write_text("{}\n")
        self.touch_recent(subagents / "agent-a1.jsonl")
        self.assertEqual(self.sweep(), [])
        self.assertTrue(folder.exists() and other.exists())

    def test_running_processes_keep_their_sessions(self):
        named = self.session()
        inside = self.session(OTHER)
        runner = FakeRunner(
            ps=f"/bin/zsh\ncat {named}/scratchpad/login.fifo\n",
            lsof=f"p10\nfcwd\nn/\np11\nfcwd\nn{inside}/scratchpad/target\n",
        )
        self.assertEqual(self.sweep(runner), [])
        self.assertTrue(named.exists() and inside.exists())

    def test_registered_running_session_is_kept_and_a_dead_one_is_not(self):
        live = self.session()
        gone = self.session(OTHER)
        (self.registry / f"{os.getpid()}.json").write_text(json.dumps({"pid": os.getpid(), "sessionId": SESSION}))
        (self.registry / f"{dead_pid()}.json").write_text(json.dumps({"sessionId": OTHER}))
        self.assertEqual([item.path for item in self.sweep()], [str(gone)])
        self.assertTrue(live.exists())

    def test_unreadable_registry_entry_of_a_running_process_removes_nothing(self):
        folder = self.session()
        (self.registry / f"{os.getpid()}.json").write_text("{not json")
        self.assertEqual(self.sweep(), [])
        self.assertTrue(folder.exists())

    def test_unreadable_process_list_removes_nothing(self):
        folder = self.session()
        self.assertEqual(self.sweep(FakeRunner(ps_code=1, ps="")), [])
        self.assertEqual(self.sweep(FakeRunner(lsof="")), [])
        self.assertTrue(folder.exists())

    def test_unreadable_folder_inside_a_session_keeps_it(self):
        folder = self.session()
        locked = folder / "scratchpad" / "locked"
        locked.mkdir()
        (locked / "file").write_text("x")
        locked.chmod(0o600)
        self.assertEqual(self.sweep(), [])
        self.assertTrue(folder.exists())

    def test_read_only_folders_are_removed(self):
        folder = self.session()
        cache = folder / "scratchpad" / "go" / "pkg" / "mod" / "example.com@v1"
        cache.mkdir(parents=True)
        (cache / "go.mod").write_text("module example.com\n")
        for path in (cache, cache.parent, cache.parent.parent):
            path.chmod(0o555)
        (swept,) = self.sweep()
        self.assertIsNone(swept.error)
        self.assertFalse(folder.exists())

    def test_session_resumed_during_a_long_sweep_is_kept(self):
        first = self.session()
        second = self.session(OTHER)
        runner = FakeRunner()
        times = iter([0.0, 10.0, 10.0])

        def clock():
            # The registry gains the second session once the first snapshot is old.
            value = next(times)
            if value:
                (self.registry / f"{os.getpid()}.json").write_text(json.dumps({"sessionId": OTHER}))
            return value

        self.assertEqual([item.path for item in self.sweep(runner, clock=clock)], [str(first)])
        self.assertTrue(second.exists())
        self.assertEqual(runner.kinds(), ["ps", "lsof", "ps", "lsof"])

    def test_only_session_folders_are_candidates(self):
        self.session()
        project = self.claude_tmp / self.project
        (project / "not-a-session").mkdir()
        (self.claude_tmp / "cache-break-state-x.json").write_text("{}")
        (self.claude_tmp / "uv-1.lock").touch()
        target = self.root / "keep"
        (target / "data").mkdir(parents=True)
        (project / OTHER).symlink_to(target, target_is_directory=True)
        (self.claude_tmp / "-linked-project").symlink_to(project, target_is_directory=True)
        self.assertEqual(len(self.sweep()), 1)
        self.assertTrue((project / "not-a-session").exists())
        self.assertTrue((self.claude_tmp / "cache-break-state-x.json").exists())
        self.assertTrue((target / "data").exists())

    def test_dry_run_lists_without_removing(self):
        folder = self.session()
        swept = self.sweep(dry_run=True)
        self.assertEqual([item.path for item in swept], [str(folder)])
        self.assertTrue(folder.exists())

    def test_nothing_idle_reads_no_process_list(self):
        runner = FakeRunner()
        self.assertEqual(self.sweep(runner), [])
        folder = self.session()
        self.touch_recent(folder / "tasks")
        self.assertEqual(self.sweep(runner), [])
        self.assertEqual(runner.calls, [])

    def readings(self, *values):
        values = iter(values)
        return lambda: next(values)

    def events(self):
        path = self.config.state_dir / "events.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()]

    def test_low_space_check_sweeps_then_alerts_with_what_it_freed(self):
        folder = self.session(size=20_000_000)
        runner = FakeRunner()
        with contextlib.redirect_stdout(io.StringIO()):
            code = alert.run_check(self.config, runner, self.readings(25.0, 26.5), self.now)
        self.assertEqual(code, 0)
        self.assertFalse(folder.exists())
        self.assertEqual(runner.kinds(), ["ps", "lsof", "start", "notify"])
        self.assertIn("removed 1 idle Claude Code session scratch folder (about 20 MB)", runner.calls[2][1])
        events = self.events()
        self.assertEqual([event["event"] for event in events], ["swept", "escalated"])
        self.assertEqual(events[0]["removed"], [str(folder)])
        self.assertEqual(events[1]["free_gb"], 26.5)

    def test_sweep_that_restores_space_still_notifies(self):
        self.session()
        runner = FakeRunner()
        with contextlib.redirect_stdout(io.StringIO()):
            code = alert.run_check(self.config, runner, self.readings(29.0, 35.0), self.now)
        self.assertEqual(code, 0)
        self.assertEqual(runner.kinds(), ["ps", "lsof", "notify"])
        self.assertIn("idle build output removed", runner.calls[2][0][-2])
        self.assertEqual([event["event"] for event in self.events()], ["swept"])

    def test_failed_sweep_still_alerts(self):
        self.session()
        runner = FakeRunner()
        with mock.patch.object(alert, "sweep_sessions", side_effect=PermissionError("denied")), \
                contextlib.redirect_stdout(io.StringIO()):
            code = alert.run_check(self.config, runner, self.readings(25.0), self.now)
        self.assertEqual(code, 1)
        self.assertEqual(runner.kinds(), ["start", "notify"])
        self.assertEqual([event["event"] for event in self.events()], ["sweep_failed", "escalated"])

    def test_ok_space_or_no_sweep_leaves_sessions(self):
        folder = self.session()
        runner = FakeRunner()
        alert.run_check(self.config, runner, self.readings(50.0), self.now)
        with contextlib.redirect_stdout(io.StringIO()):
            alert.run_check(replace(self.config, claude_tmp=None), runner, self.readings(25.0), self.now)
        self.assertTrue(folder.exists())
        self.assertNotIn("ps", runner.kinds())

    def test_config_defaults_follow_the_module_defaults(self):
        config = alert.Config()
        self.assertEqual(config.claude_projects, alert.DEFAULT_CLAUDE_PROJECTS)
        self.assertEqual(config.claude_sessions, alert.DEFAULT_CLAUDE_SESSIONS)
        self.assertTrue(str(config.claude_projects).startswith(SANDBOX.name))
        self.assertIsNone(config.worktrees)

    def test_sizes_read_in_megabytes_below_a_gigabyte(self):
        self.assertEqual(alert.format_size(20_000_000), "20 MB")
        self.assertEqual(alert.format_size(2_500_000_000), "2.5 GB")


class TargetSweepTest(unittest.TestCase):
    """Cargo target folders in T3 worktrees and in the Claude Code worktrees of their
    repositories. Files made now count as idle two days ahead."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.worktrees = self.root / "t3-worktrees"
        self.repo = self.root / "repo"
        (self.repo / ".git" / "worktrees").mkdir(parents=True)
        self.registry = self.root / "sessions"
        self.registry.mkdir()
        self.now = datetime.now(timezone.utc) + timedelta(days=2)
        self.config = replace(
            CONFIG, state_dir=self.root / "state", claude_sessions=self.registry, worktrees=self.worktrees
        )

    def tearDown(self):
        self.tmp.cleanup()

    def worktree(self, path, name):
        """A linked worktree of self.repo at path, with a source file."""
        (path / "src").mkdir(parents=True)
        (path / "src" / "lib.rs").write_text("pub fn f() {}\n")
        (path / "Cargo.toml").write_text("[package]\nname = 'x'\n")
        (path / ".git").write_text(f"gitdir: {self.repo}/.git/worktrees/{name}\n")
        return path

    def t3_worktree(self, name="t3-1", project="repo"):
        return self.worktree(self.worktrees / project / name, name)

    def target(self, folder, size=4096, tag=alert.CARGO_TAG + b"\n# cargo\n"):
        (folder / "debug" / "deps").mkdir(parents=True)
        (folder / "debug" / "deps" / "libx.rlib").write_bytes(b"x" * size)
        for name in alert.CARGO_LOCKS:
            (folder / "debug" / name).touch()
        if tag is not None:
            (folder / "CACHEDIR.TAG").write_bytes(tag)
        return folder

    def set_mtime(self, path, hours_ago):
        when = (self.now - timedelta(hours=hours_ago)).timestamp()
        os.utime(path, (when, when))

    def sweep(self, runner=None, level="low", dry_run=False):
        return alert.sweep_targets(self.config, runner or FakeRunner(), self.now, level, dry_run)

    def test_idle_targets_in_t3_and_claude_worktrees_are_removed(self):
        tree = self.t3_worktree()
        top = self.target(tree / "target", size=100_000)
        nested = self.target(tree / "services" / "api" / "target")
        claude = self.worktree(self.repo / ".claude" / "worktrees" / "wt-a", "wt-a")
        claude_target = self.target(claude / "target")
        swept = self.sweep()
        self.assertEqual(
            sorted(item.path for item in swept), sorted(map(str, (top, nested, claude_target)))
        )
        self.assertTrue(all(item.kind == "target" and item.error is None for item in swept))
        self.assertGreaterEqual(max(item.bytes for item in swept), 100_000)
        for folder in (top, nested, claude_target):
            self.assertFalse(folder.exists())
        self.assertTrue((tree / "src" / "lib.rs").exists() and (claude / "Cargo.toml").exists())

    def test_only_cargo_tagged_target_folders_are_candidates(self):
        tree = self.t3_worktree()
        untagged = self.target(tree / "target", tag=None)
        other_tag = self.target(tree / "a" / "target", tag=b"Signature: 0000\n")
        named_build = self.target(tree / "build")
        hidden = self.target(tree / ".cache" / "target")
        modules = self.target(tree / "node_modules" / "pkg" / "target")
        real = self.target(self.root / "elsewhere" / "target")
        (tree / "b").mkdir()
        (tree / "b" / "target").symlink_to(real, target_is_directory=True)
        self.assertEqual(self.sweep(), [])
        for folder in (untagged, other_tag, named_build, hidden, modules, real):
            self.assertTrue(folder.exists())

    def test_recent_change_keeps_it_for_the_level_idle_time(self):
        target = self.target(self.t3_worktree() / "target")
        self.set_mtime(target / "debug" / "deps" / "libx.rlib", hours_ago=3)
        self.assertEqual(self.sweep(level="low"), [])
        self.assertTrue(target.exists())
        self.assertEqual([item.path for item in self.sweep(level="critical")], [str(target)])
        self.assertFalse(target.exists())

    def test_held_build_lock_keeps_it(self):
        target = self.target(self.t3_worktree() / "target")
        descriptor = os.open(target / "debug" / ".cargo-build-lock", os.O_RDONLY)
        try:
            alert.fcntl.flock(descriptor, alert.fcntl.LOCK_EX | alert.fcntl.LOCK_NB)
            self.assertEqual(self.sweep(), [])
            self.assertTrue(target.exists())
        finally:
            os.close(descriptor)
        self.assertEqual([item.path for item in self.sweep()], [str(target)])

    def test_locks_are_released_when_a_later_one_is_held(self):
        target = self.target(self.t3_worktree() / "target")
        triple = target / "aarch64-apple-darwin" / "debug"
        triple.mkdir(parents=True)
        (triple / ".cargo-lock").touch()
        descriptor = os.open(triple / ".cargo-lock", os.O_RDONLY)
        try:
            alert.fcntl.flock(descriptor, alert.fcntl.LOCK_EX | alert.fcntl.LOCK_NB)
            self.assertIsNone(alert.take_build_locks(target))
            # The locks taken before the held one were released.
            again = alert.take_build_locks(target / "debug")
            self.assertEqual(len(again), len(alert.CARGO_LOCKS))
            alert.release(again)
        finally:
            os.close(descriptor)

    def test_running_processes_keep_their_targets(self):
        named = self.target(self.t3_worktree("t3-1") / "target")
        inside = self.target(self.t3_worktree("t3-2") / "target")
        beside = self.target(self.t3_worktree("t3-3") / "target")
        runner = FakeRunner(
            ps=f"/bin/zsh\n{named}/debug/deps/daemon-1234 --serve\n",
            lsof=f"p10\nfcwd\nn{inside}/debug\np11\nfcwd\nn{beside.parent}\n",
        )
        self.assertEqual([item.path for item in self.sweep(runner)], [str(beside)])
        self.assertTrue(named.exists() and inside.exists())

    def test_unreadable_process_list_removes_nothing(self):
        target = self.target(self.t3_worktree() / "target")
        self.assertEqual(self.sweep(FakeRunner(ps_code=1, ps="")), [])
        self.assertTrue(target.exists())

    def test_dry_run_lists_without_removing(self):
        target = self.target(self.t3_worktree() / "target")
        (swept,) = self.sweep(dry_run=True)
        self.assertEqual((swept.path, swept.kind), (str(target), "target"))
        self.assertTrue(target.exists())

    def test_nothing_to_sweep_reads_no_process_list(self):
        runner = FakeRunner()
        self.assertEqual(self.sweep(runner), [])
        self.assertEqual(alert.sweep_targets(replace(self.config, worktrees=None), runner, self.now), [])
        target = self.target(self.t3_worktree() / "target")
        self.set_mtime(target / "debug" / "deps" / "libx.rlib", hours_ago=0.5)
        self.assertEqual(self.sweep(runner, level="critical"), [])
        self.assertEqual(runner.calls, [])

    def test_main_checkout_reads_only_linked_worktree_git_files(self):
        tree = self.t3_worktree()
        self.assertEqual(alert.main_checkout(tree), self.repo)
        (tree / ".git").write_text("gitdir: /somewhere/else\n")
        self.assertIsNone(alert.main_checkout(tree))
        (tree / ".git").unlink()
        (tree / ".git").mkdir()
        self.assertIsNone(alert.main_checkout(tree))

    def test_low_space_check_sweeps_targets_and_says_so(self):
        target = self.target(self.t3_worktree() / "target", size=3_000_000)
        runner = FakeRunner()
        values = iter((25.0, 27.0))
        with contextlib.redirect_stdout(io.StringIO()):
            code = alert.run_check(self.config, runner, lambda: next(values), self.now)
        self.assertEqual(code, 0)
        self.assertFalse(target.exists())
        self.assertIn("removed 1 idle Rust target folder in agent worktrees (about 3 MB)", runner.calls[2][1])

    def test_note_names_both_kinds(self):
        swept = [
            alert.Swept("/a", 1_000_000_000),
            alert.Swept("/b", 2_000_000_000, kind="target"),
            alert.Swept("/c", 500_000_000, kind="target"),
            alert.Swept("/d", 9_000_000_000, "Permission denied", "target"),
        ]
        self.assertEqual(
            alert.sweep_note(swept),
            "The monitor removed 1 idle Claude Code session scratch folder and 2 idle Rust "
            "target folders in agent worktrees (about 3.5 GB).",
        )


class StateFileTest(unittest.TestCase):
    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "state.json"
            state = alert.State("low", THREAD, NOW.isoformat(), True)
            alert.save_state(path, state)
            self.assertEqual(alert.load_state(path), state)

    def test_missing_file_is_fresh_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(alert.load_state(Path(tmp) / "state.json"), alert.State())

    def test_corrupt_or_invalid_file_is_fresh_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            for content in ("{not json", "[]", '{"level": "full"}', '{"last_alert_at": "soon"}'):
                path.write_text(content)
                with contextlib.redirect_stderr(io.StringIO()) as err:
                    self.assertEqual(alert.load_state(path), alert.State())
                self.assertIn("Ignoring", err.getvalue())


class MeasureTest(unittest.TestCase):
    def test_free_space_matches_statvfs(self):
        stats = os.statvfs("/")
        self.assertAlmostEqual(alert.free_gb("/"), stats.f_bavail * stats.f_frsize / 1e9, delta=1.0)
        self.assertGreater(alert.free_gb("/"), 0)


class LaunchAgentTest(unittest.TestCase):
    def test_plist_runs_check_every_ten_minutes(self):
        agent = alert.launch_agent(
            "/bin/uv", Path("/repo/disk-alert/disk_space_alert.py"), Path("/state"), 30.0, 20.0
        )
        decoded = plistlib.loads(plistlib.dumps(agent))
        self.assertEqual(decoded["Label"], "com.syz51.disk-space-alert")
        self.assertEqual(
            decoded["ProgramArguments"],
            ["/bin/uv", "run", "--no-project", "--python", "3.11", "python", "-B",
             "/repo/disk-alert/disk_space_alert.py", "check", "--low-gb", "30",
             "--critical-gb", "20"],
        )
        self.assertEqual(decoded["StartInterval"], 600)
        self.assertTrue(decoded["RunAtLoad"])
        self.assertEqual(decoded["StandardErrorPath"], "/state/launchd.log")

    def test_install_dry_run_prints_plist_without_loading(self):
        run = FakeRunner()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = alert.main(["install", "--dry-run", "--low-gb", "50", "--critical-gb", "25"], run=run)
        self.assertEqual(code, 0)
        self.assertEqual(run.calls, [])
        decoded = plistlib.loads(out.getvalue().encode())
        self.assertEqual(
            decoded["ProgramArguments"][-6:],
            [str(SCRIPT), "check", "--low-gb", "50", "--critical-gb", "25"],
        )

    def test_install_rejects_inverted_thresholds(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            alert.main(["install", "--dry-run", "--low-gb", "20", "--critical-gb", "25"])


class CommandLineTest(unittest.TestCase):
    """Runs the real command runner against fake t3 and osascript programs."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.log = self.root / "calls.log"
        self.t3 = self.fake_program(
            "t3",
            f"""
            printf '%s\\n' "$*" >> '{self.log}'
            cat >> '{self.log}'
            printf '\\n' >> '{self.log}'
            [ -f '{self.root}/t3-down' ] && {{ echo 'connection refused' >&2; exit 1; }}
            echo '{{"threadId":"{THREAD}"}}'
            """,
        )
        self.osascript = self.fake_program(
            "osascript", f"""printf 'notify %s\\n' "$*" >> '{self.log}'"""
        )
        self.state_dir = self.root / "state"

    def tearDown(self):
        self.tmp.cleanup()

    def fake_program(self, name, body):
        path = self.root / name
        path.write_text("#!/bin/sh\n" + textwrap.dedent(body))
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        return str(path)

    def check(self, free):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = alert.main(
                ["check", "--free-gb", str(free), "--state-dir", str(self.state_dir),
                 "--t3", self.t3, "--t3-project", "/scratch", "--osascript", self.osascript]
            )
        return code, out.getvalue()

    def test_episode_end_to_end(self):
        self.assertEqual(self.check(50), (0, ""))
        self.assertFalse(self.log.exists())

        code, out = self.check(25)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["event"], "escalated")
        log = self.log.read_text()
        self.assertIn("thread start --json --title Low disk space: 25.0 GB free /scratch -", log)
        self.assertIn("read-only check", log)
        self.assertIn("notify -e on run argv", log)

        self.assertEqual(self.check(24), (0, ""))

        code, out = self.check(15)
        self.assertEqual(json.loads(out)["event"], "escalated")
        self.assertIn(f"thread send --json {THREAD} -", self.log.read_text())

        code, out = self.check(45)
        self.assertEqual(json.loads(out)["event"], "recovered")
        state = json.loads((self.state_dir / "state.json").read_text())
        self.assertEqual(state["level"], "ok")
        self.assertIsNone(state["thread_id"])
        events = (self.state_dir / "events.jsonl").read_text().splitlines()
        self.assertEqual([json.loads(e)["event"] for e in events], ["escalated", "escalated", "recovered"])

    def test_t3_outage_is_retried(self):
        (self.root / "t3-down").touch()
        code, out = self.check(25)
        self.assertEqual(code, 1)
        self.assertIn("connection refused", json.loads(out)["t3_error"])
        self.assertIn("retrying", self.log.read_text())

        (self.root / "t3-down").unlink()
        code, out = self.check(25)
        self.assertEqual(code, 0)
        record = json.loads(out)
        self.assertEqual(record["event"], "retry")
        self.assertEqual(record["thread_id"], THREAD)
        self.assertEqual(self.log.read_text().count("notify "), 1)

    def test_missing_t3_program_is_reported(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = alert.main(
                ["check", "--free-gb", "25", "--state-dir", str(self.state_dir),
                 "--t3", str(self.root / "absent"), "--osascript", self.osascript]
            )
        self.assertEqual(code, 1)
        self.assertIn("start exit 127", json.loads(out.getvalue())["t3_error"])

    def idle_session(self):
        claude_tmp = self.root / "claude-tmp"
        folder = claude_tmp / "-p" / SESSION
        folder.mkdir(parents=True)
        return claude_tmp, folder

    def idle_target(self):
        """A cargo target folder in a T3 worktree under root/worktrees."""
        target = self.root / "worktrees" / "repo" / "t3-1" / "target"
        (target / "debug").mkdir(parents=True)
        (target / "debug" / "libx.rlib").write_bytes(b"x" * 4096)
        (target / "CACHEDIR.TAG").write_bytes(alert.CARGO_TAG + b"\n")
        return target

    def sweep_args(self, claude_tmp):
        return ["--claude-tmp", str(claude_tmp), "--claude-projects", str(self.root / "projects"),
                "--claude-sessions", str(self.root / "sessions"), "--worktrees", str(self.root / "worktrees")]

    def test_sweep_command_lists_removes_and_logs(self):
        claude_tmp, folder = self.idle_session()
        target = self.idle_target()
        later = datetime.now(timezone.utc) + timedelta(days=2)
        base = ["sweep", "--state-dir", str(self.state_dir), *self.sweep_args(claude_tmp)]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(alert.main(base + ["--dry-run"], now=later), 0)
        listed = json.loads(out.getvalue())
        self.assertTrue(listed["dry_run"])
        self.assertEqual([item["path"] for item in listed["sessions"]], [str(folder)])
        self.assertEqual([item["path"] for item in listed["targets"]], [str(target)])
        self.assertTrue(folder.exists() and target.exists())
        self.assertFalse((self.state_dir / "events.jsonl").exists())

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(alert.main(base + ["--no-sweep"], now=later), 0)
        self.assertTrue(folder.exists() and target.exists())

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(alert.main(base, now=later), 0)
        self.assertFalse(folder.exists() or target.exists())
        (event,) = [json.loads(line) for line in (self.state_dir / "events.jsonl").read_text().splitlines()]
        self.assertEqual((event["event"], event["removed"]), ("swept", [str(folder), str(target)]))

    def test_simulated_reading_never_sweeps(self):
        claude_tmp, folder = self.idle_session()
        target = self.idle_target()
        later = datetime.now(timezone.utc) + timedelta(days=2)
        with contextlib.redirect_stdout(io.StringIO()):
            alert.main(
                ["check", "--free-gb", "15", "--state-dir", str(self.state_dir), "--t3", self.t3,
                 "--osascript", self.osascript, *self.sweep_args(claude_tmp)],
                now=later,
            )
        self.assertTrue(folder.exists() and target.exists())

    def test_critical_must_be_below_low(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            alert.main(["check", "--low-gb", "20", "--critical-gb", "30"])


if __name__ == "__main__":
    unittest.main()
