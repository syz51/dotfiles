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
alert.DEFAULT_T3_DB = Path(SANDBOX.name) / "statev2.sqlite"
alert.DEFAULT_BUN_CACHE = Path(SANDBOX.name) / "bun-cache"
alert.DEFAULT_PLAYWRIGHT_CACHE = Path(SANDBOX.name) / "ms-playwright"

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

    def test_low_space_check_alerts_then_sweeps_and_says_what_it_freed(self):
        folder = self.session(size=20_000_000)
        runner = FakeRunner()
        with contextlib.redirect_stdout(io.StringIO()):
            code = alert.run_check(self.config, runner, self.readings(25.0), self.now)
        self.assertEqual(code, 0)
        self.assertFalse(folder.exists())
        self.assertEqual(runner.kinds(), ["start", "notify", "ps", "lsof", "notify"])
        self.assertEqual(runner.calls[4][0][-2], "Disk space: idle build output removed")
        self.assertIn("removed 1 idle Claude Code session scratch folder (about 20 MB)", runner.calls[4][0][-1])
        events = self.events()
        self.assertEqual([event["event"] for event in events], ["escalated", "swept"])
        self.assertEqual(events[0]["free_gb"], 25.0)
        self.assertEqual(events[1]["removed"], [str(folder)])
        self.assertEqual(list((self.config.state_dir / "trash").iterdir()), [])

    def test_critical_alert_is_logged_and_sent_before_any_sweep_starts(self):
        self.session()
        runner = FakeRunner()
        seen = []

        def sweep(config, *args, **kwargs):
            # What the sweep finds when it starts: the alert already sent and logged.
            seen.append((runner.kinds(), [event["event"] for event in self.events()],
                         json.loads((config.state_dir / "state.json").read_text())["level"]))
            return [], [], None

        with mock.patch.object(alert, "sweep", side_effect=sweep), contextlib.redirect_stdout(io.StringIO()):
            alert.run_check(self.config, runner, self.readings(5.0), self.now)
        self.assertEqual(seen, [(["start", "notify"], ["escalated"], "critical")])
        self.assertIn("Critical disk space", runner.calls[1][0][-2])

    def test_sweep_stops_at_its_time_limit_and_the_run_ends(self):
        first = self.session()
        second = self.session(OTHER)
        runner = FakeRunner()
        # Each read of the clock moves it on a minute; the limit is 3 minutes.
        ticks = iter(range(0, 6000, 60))
        config = replace(self.config, sweep_minutes=3)
        with contextlib.redirect_stdout(io.StringIO()):
            code = alert.run_check(config, runner, self.readings(25.0), self.now, clock=lambda: next(ticks))
        self.assertEqual(code, 0)
        events = self.events()
        self.assertEqual([event["event"] for event in events], ["escalated", "swept", "sweep_stopped"])
        self.assertEqual(events[2]["limit_minutes"], 3)
        # The first session left its place at once; the second was never touched.
        self.assertEqual(events[1]["removed"], [str(first)])
        self.assertFalse(first.exists())
        self.assertTrue(second.exists())
        # What the stopped deletion left waits in the trash, and the next sweep removes it.
        trash = self.config.state_dir / "trash"
        self.assertEqual(len(list(trash.iterdir())), 1)
        alert.sweep(self.config, runner, self.now, "low")
        self.assertEqual(list(trash.iterdir()), [])
        self.assertFalse(second.exists())

    def test_folder_that_cannot_move_to_the_trash_is_removed_in_place(self):
        folder = self.session()
        (self.config.state_dir).mkdir(parents=True)
        (self.config.state_dir / "trash").write_text("not a folder")
        (swept,) = self.sweep()
        self.assertIsNone(swept.error)
        self.assertFalse(folder.exists())

    def test_failed_sweep_still_alerts(self):
        self.session()
        runner = FakeRunner()
        with mock.patch.object(alert, "sweep_sessions", side_effect=PermissionError("denied")), \
                contextlib.redirect_stdout(io.StringIO()):
            code = alert.run_check(self.config, runner, self.readings(25.0), self.now)
        self.assertEqual(code, 1)
        self.assertEqual(runner.kinds(), ["start", "notify"])
        self.assertEqual([event["event"] for event in self.events()], ["escalated", "sweep_failed"])

    def test_ok_space_or_no_sweep_leaves_sessions(self):
        folder = self.session()
        runner = FakeRunner()
        alert.run_check(self.config, runner, self.readings(50.0), self.now)
        with contextlib.redirect_stdout(io.StringIO()):
            alert.run_check(replace(self.config, claude_tmp=None), runner, self.readings(25.0), self.now)
        self.assertTrue(folder.exists())
        self.assertNotIn("ps", runner.kinds())

    def test_ok_space_still_finishes_the_trash(self):
        folder = self.session()
        bin_ = self.config.state_dir / "trash" / "left"
        (bin_ / "deps").mkdir(parents=True)
        (bin_ / "deps" / "libx.rlib").write_bytes(b"x")
        runner = FakeRunner()
        alert.run_check(self.config, runner, self.readings(50.0), self.now)
        self.assertFalse(bin_.exists())
        self.assertTrue(folder.exists())
        self.assertEqual(runner.calls, [])

    def test_trash_entry_that_fails_keeps_neither_the_others_nor_quiet(self):
        trash = self.config.state_dir / "trash"
        for name in ("a", "b"):
            (trash / name).mkdir(parents=True)
        real = alert.remove_tree

        def remove(path, limit):
            if path.name == "a":
                raise PermissionError("denied")
            real(path, limit)

        with mock.patch.object(alert, "remove_tree", side_effect=remove), self.assertRaises(PermissionError):
            alert.empty_trash(trash, alert.Limit())
        self.assertEqual([entry.name for entry in trash.iterdir()], ["a"])

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

    def built(self, target):
        return (target / "debug" / "deps" / "libx.rlib").exists()

    def assert_emptied(self, target):
        """Only the tag, the lock files and the folders holding them are left."""
        left = sorted(str(path.relative_to(target)) for path in target.rglob("*"))
        self.assertEqual(left, ["CACHEDIR.TAG", "debug", *sorted(f"debug/{name}" for name in alert.CARGO_LOCKS)])

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
            self.assert_emptied(folder)
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
        self.assertTrue(self.built(target))
        self.assertEqual([item.path for item in self.sweep(level="critical")], [str(target)])
        self.assert_emptied(target)

    def test_held_build_lock_keeps_it(self):
        target = self.target(self.t3_worktree() / "target")
        descriptor = os.open(target / "debug" / ".cargo-build-lock", os.O_RDONLY)
        try:
            alert.fcntl.flock(descriptor, alert.fcntl.LOCK_EX | alert.fcntl.LOCK_NB)
            self.assertEqual(self.sweep(), [])
            self.assertTrue(self.built(target))
        finally:
            os.close(descriptor)
        self.assertEqual([item.path for item in self.sweep()], [str(target)])

    def test_locks_are_released_when_a_later_one_is_held(self):
        target = self.target(self.t3_worktree() / "target")
        locks = alert.build_lock_files(target)
        # The files sort by name, so .cargo-lock is taken last.
        self.assertEqual(locks[-1], target / "debug" / ".cargo-lock")
        descriptor = os.open(locks[-1], os.O_RDONLY)
        try:
            alert.fcntl.flock(descriptor, alert.fcntl.LOCK_EX | alert.fcntl.LOCK_NB)
            self.assertIsNone(alert.take_build_locks(locks))
            # The locks taken before the held one were released.
            again = alert.take_build_locks(locks[:-1])
            self.assertEqual(len(again), len(alert.CARGO_LOCKS) - 1)
            alert.release(again)
        finally:
            os.close(descriptor)

    def test_locks_tag_and_profile_folders_outlive_the_sweep(self):
        target = self.target(self.t3_worktree() / "target")
        triple = target / "aarch64-apple-darwin" / "release"
        (triple / "build").mkdir(parents=True)
        (triple / "build" / "out.o").write_bytes(b"x" * 4096)
        (triple / ".cargo-lock").touch()
        (target / "doc").mkdir()
        (target / ".rustc_info.json").write_text("{}")
        locks = alert.build_lock_files(target)
        self.assertEqual(len(locks), len(alert.CARGO_LOCKS) + 1)
        inodes = {lock: lock.stat().st_ino for lock in locks}
        tag = (target / "CACHEDIR.TAG").read_bytes()
        self.assertEqual([item.path for item in self.sweep()], [str(target)])
        # A build waiting on these locks gets the same files, in a folder still tagged.
        self.assertEqual({lock: lock.stat().st_ino for lock in locks}, inodes)
        self.assertEqual((target / "CACHEDIR.TAG").read_bytes(), tag)
        self.assertEqual(sorted(path.name for path in triple.iterdir()), [".cargo-lock"])
        self.assertFalse((target / "doc").exists() or (target / ".rustc_info.json").exists())
        self.assertFalse((target / "debug" / "deps").exists())

    def test_emptied_target_is_not_swept_again(self):
        target = self.target(self.t3_worktree() / "target")
        self.assertEqual(len(self.sweep()), 1)
        runner = FakeRunner()
        self.assertEqual(self.sweep(runner), [])
        self.assertEqual(runner.calls, [])
        self.assert_emptied(target)

    def test_unreadable_registry_does_not_stop_the_target_sweep(self):
        (self.registry / f"{os.getpid()}.json").write_text("not json")
        target = self.target(self.t3_worktree() / "target")
        self.assertEqual([item.path for item in self.sweep()], [str(target)])

    def test_failing_session_sweep_keeps_the_target_sweep(self):
        target = self.target(self.t3_worktree() / "target")
        with mock.patch.object(alert, "sweep_sessions", side_effect=PermissionError("denied")):
            swept, failures, stopped = alert.sweep(self.config, FakeRunner(), self.now)
        self.assertIsNone(stopped)
        self.assertEqual([item.path for item in swept], [str(target)])
        self.assertEqual([(failure["sweep"], failure["error"]) for failure in failures], [("sessions", "denied")])
        self.assert_emptied(target)

    def test_target_sweep_stopped_mid_deletion_empties_the_folder_and_frees_its_locks(self):
        first = self.target(self.t3_worktree("t3-1") / "target")
        second = self.target(self.t3_worktree("t3-2") / "target")
        ticks = iter(range(100))
        limit = alert.Limit(3, lambda: next(ticks))
        swept = alert.sweep_targets(self.config, FakeRunner(), self.now, limit=limit)
        self.assertTrue(limit.reached)
        self.assertEqual([(item.path, item.error) for item in swept], [(str(first), None)])
        self.assert_emptied(first)
        self.assertTrue((second / "debug" / "deps" / "libx.rlib").exists())
        self.assertEqual(len(list((self.config.state_dir / "trash").iterdir())), 1)
        held = alert.take_build_locks(alert.build_lock_files(first))
        self.assertIsNotNone(held)
        alert.release(held)

    def test_running_processes_keep_their_targets(self):
        named = self.target(self.t3_worktree("t3-1") / "target")
        inside = self.target(self.t3_worktree("t3-2") / "target")
        beside = self.target(self.t3_worktree("t3-3") / "target")
        runner = FakeRunner(
            ps=f"/bin/zsh\n{named}/debug/deps/daemon-1234 --serve\n",
            lsof=f"p10\nfcwd\nn{inside}/debug\np11\nfcwd\nn{beside.parent}\n",
        )
        self.assertEqual([item.path for item in self.sweep(runner)], [str(beside)])
        self.assertTrue(self.built(named) and self.built(inside))

    def test_unreadable_process_list_removes_nothing(self):
        target = self.target(self.t3_worktree() / "target")
        self.assertEqual(self.sweep(FakeRunner(ps_code=1, ps="")), [])
        self.assertTrue(self.built(target))

    def test_dry_run_lists_without_removing(self):
        target = self.target(self.t3_worktree() / "target")
        (swept,) = self.sweep(dry_run=True)
        self.assertEqual((swept.path, swept.kind), (str(target), "target"))
        self.assertTrue(self.built(target))

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
        (tree / ".git").write_text(f"gitdir: {os.path.relpath(self.repo, tree)}/.git/worktrees/t3-1\n")
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
        self.assert_emptied(target)
        self.assertIn("removed 1 idle Rust target folder in agent worktrees (about 3 MB)", runner.calls[-1][0][-1])

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
             "--critical-gb", "20", "--sweep-minutes", "5"],
        )
        self.assertEqual(decoded["StartInterval"], 600)
        # Background would let macOS throttle the sweep's disk I/O and CPU.
        self.assertEqual(decoded["ProcessType"], "Standard")
        self.assertTrue(decoded["RunAtLoad"])
        self.assertEqual(decoded["StandardErrorPath"], "/state/launchd.log")

    def test_install_dry_run_prints_plist_without_loading(self):
        run = FakeRunner()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = alert.main(
                ["install", "--dry-run", "--low-gb", "50", "--critical-gb", "25", "--sweep-minutes", "2.5"], run=run
            )
        self.assertEqual(code, 0)
        self.assertEqual(run.calls, [])
        decoded = plistlib.loads(out.getvalue().encode())
        self.assertEqual(
            decoded["ProgramArguments"][-8:],
            [str(SCRIPT), "check", "--low-gb", "50", "--critical-gb", "25", "--sweep-minutes", "2.5"],
        )

    def test_sweep_minutes_must_be_above_zero(self):
        for value in ("0", "-1", "nan"):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                alert.main(["check", "--sweep-minutes", value, "--free-gb", "50"])

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
        self.assertTrue(folder.exists() and (target / "debug").exists())
        self.assertEqual(listed["failures"], [])
        self.assertFalse((self.state_dir / "events.jsonl").exists())

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(alert.main(base + ["--no-sweep"], now=later), 0)
        self.assertTrue(folder.exists() and (target / "debug").exists())

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(alert.main(base, now=later), 0)
        self.assertFalse(folder.exists())
        self.assertEqual([path.name for path in target.iterdir()], ["CACHEDIR.TAG"])
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
        self.assertTrue(folder.exists() and (target / "debug").exists())

    def test_failed_sweep_command_logs_it_and_fails(self):
        claude_tmp, _folder = self.idle_session()
        target = self.idle_target()
        later = datetime.now(timezone.utc) + timedelta(days=2)
        out = io.StringIO()
        with mock.patch.object(alert, "sweep_sessions", side_effect=PermissionError("denied")), \
                contextlib.redirect_stdout(out):
            code = alert.main(["sweep", "--state-dir", str(self.state_dir), *self.sweep_args(claude_tmp)], now=later)
        self.assertEqual(code, 1)
        printed = json.loads(out.getvalue())
        self.assertEqual([item["path"] for item in printed["targets"]], [str(target)])
        self.assertEqual([failure["sweep"] for failure in printed["failures"]], ["sessions"])
        events = [json.loads(line) for line in (self.state_dir / "events.jsonl").read_text().splitlines()]
        self.assertEqual([event["event"] for event in events], ["sweep_failed", "swept"])

    def test_critical_must_be_below_low(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            alert.main(["check", "--low-gb", "20", "--critical-gb", "30"])


def init_t3_db(db_path: Path, threads=(), runs=(), requests=()):
    import sqlite3
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE orchestration_v2_projection_threads (
                thread_id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE orchestration_v2_projection_runs (
                run_id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                status TEXT NOT NULL
            );
            CREATE TABLE orchestration_v2_projection_runtime_requests (
                request_id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                status TEXT NOT NULL
            );
            """
        )
        for tid, wt, updated_at in threads:
            conn.execute(
                "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)",
                (tid, json.dumps({"worktreePath": str(wt)}), updated_at),
            )
        for rid, tid, status in runs:
            conn.execute("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?)", (rid, tid, status))
        for qid, tid, status in requests:
            conn.execute(
                "INSERT INTO orchestration_v2_projection_runtime_requests VALUES (?, ?, ?)",
                (qid, tid, status),
            )
        conn.commit()
    finally:
        conn.close()


class DailyWorktreeSweepTest(unittest.TestCase):
    """Real git repository + linked worktrees + read-only T3 SQLite DB."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.origin = self.root / "origin.git"
        self.repo = self.root / "repo"
        self.worktrees = self.root / "worktrees"
        self.db_path = self.root / "statev2.sqlite"
        self.now = datetime.now(timezone.utc) + timedelta(days=5)
        self.old_iso = (self.now - timedelta(days=3)).isoformat()
        self.recent_iso = (self.now - timedelta(hours=2)).isoformat()
        self.git_env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@example.com",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_COMMITTER_EMAIL": "test@example.com",
            "GIT_AUTHOR_DATE": "2026-11-01T00:00:00Z",
            "GIT_COMMITTER_DATE": "2026-11-01T00:00:00Z",
        }
        self._git(self.root, "init", "--bare", "-b", "main", str(self.origin))
        self._git(self.root, "clone", str(self.origin), str(self.repo))
        (self.repo / "README.md").write_text("hello\n")
        (self.repo / ".gitignore").write_text(".env\n.env.*\n!.env.example\ntarget/\n")
        (self.repo / ".env.example").write_text("KEY=value\n")
        self._git(self.repo, "add", ".")
        self._git(self.repo, "commit", "-m", "initial")
        self._git(self.repo, "push", "-u", "origin", "main")
        self._git(self.repo, "remote", "set-head", "origin", "main")
        init_t3_db(self.db_path)
        self.config = replace(
            CONFIG,
            state_dir=self.root / "state",
            worktrees=self.worktrees,
            t3_db=self.db_path,
            search_path="",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def _git(self, cwd: Path, *args: str):
        return subprocess.run(
            ["git", "-C", str(cwd), *args],
            env=self.git_env,
            capture_output=True,
            text=True,
            check=True,
        )

    def add_worktree(self, name: str, ref: str = "HEAD", detach: bool = True, branch: str | None = None) -> Path:
        path = self.worktrees / "repo" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if branch is not None:
            self._git(self.repo, "worktree", "add", "-b", branch, str(path), ref)
        elif detach:
            self._git(self.repo, "worktree", "add", "--detach", str(path), ref)
        else:
            self._git(self.repo, "worktree", "add", str(path), ref)
        return path

    def make_runner(self, ps="/sbin/launchd\n", lsof="p1\nn/\n"):
        def run(args, input_text):
            if args[0] == "ps":
                return subprocess.CompletedProcess(args, 0, ps, "")
            if args[0] == "lsof":
                return subprocess.CompletedProcess(args, 1, lsof, "")
            return alert.run_command(args, input_text)
        return run

    def test_clean_idle_merged_worktree_is_removed_and_dry_run_preserves_it(self):
        tree = self.add_worktree("wt-merged")
        dry = alert.sweep_merged_worktrees(self.config, self.make_runner(), self.now, dry_run=True)
        self.assertEqual([item.path for item in dry], [str(tree)])
        self.assertTrue(tree.exists())

        swept = alert.sweep_merged_worktrees(self.config, self.make_runner(), self.now, dry_run=False)
        self.assertEqual([(item.path, item.kind, item.error) for item in swept], [(str(tree), "worktree", None)])
        self.assertFalse(tree.exists())

    def test_dirty_unmerged_or_secret_env_worktrees_are_kept(self):
        dirty = self.add_worktree("wt-dirty")
        (dirty / "README.md").write_text("changed\n")

        untracked = self.add_worktree("wt-untracked")
        (untracked / "notes.txt").write_text("keep\n")

        unmerged = self.add_worktree("wt-unmerged", branch="feat/unmerged")
        (unmerged / "new.txt").write_text("commit\n")
        self._git(unmerged, "add", "new.txt")
        self._git(unmerged, "commit", "-m", "ahead")

        secret_env = self.add_worktree("wt-secret")
        (secret_env / ".env").write_text("SECRET=real\n")

        nested_secret = self.add_worktree("wt-nested-secret")
        (nested_secret / "apps" / "web").mkdir(parents=True)
        (nested_secret / "apps" / "web" / ".env.local").write_text("TOKEN=secret\n")

        copy_env = self.add_worktree("wt-example-env")
        (copy_env / ".env").write_text("KEY=value\n")

        swept = alert.sweep_merged_worktrees(self.config, self.make_runner(), self.now, dry_run=False)
        self.assertEqual([item.path for item in swept], [str(copy_env)])
        self.assertTrue(
            dirty.exists() and untracked.exists() and unmerged.exists()
            and secret_env.exists() and nested_secret.exists()
        )
        self.assertFalse(copy_env.exists())

    def test_recent_locked_or_open_handle_worktrees_are_kept(self):
        recent = self.add_worktree("wt-recent-mtime")
        recent_ts = (self.now - timedelta(hours=12)).timestamp()
        os.utime(recent / "README.md", (recent_ts, recent_ts))
        os.utime(recent, (recent_ts, recent_ts))

        locked = self.add_worktree("wt-locked")
        self._git(self.repo, "worktree", "lock", str(locked))

        open_fd = self.add_worktree("wt-open-fd")
        runner = self.make_runner(lsof=f"p77\nf4\nn{open_fd}/README.md\n")

        swept = alert.sweep_merged_worktrees(self.config, runner, self.now, dry_run=False)
        self.assertEqual(swept, [])
        self.assertTrue(recent.exists() and locked.exists() and open_fd.exists())

    def test_daily_no_sweep_still_prunes_worktrees_and_no_worktree_prune_still_sweeps_targets(self):
        tree = self.add_worktree("wt-flags")
        target = tree / "target"
        (target / "debug").mkdir(parents=True)
        (target / "debug" / "libx.rlib").write_bytes(b"x" * 4096)
        (target / "CACHEDIR.TAG").write_bytes(alert.CARGO_TAG + b"\n")
        base_args = [
            "daily", "--dry-run", "--state-dir", str(self.root / "state"),
            "--worktrees", str(self.worktrees), "--t3-db", str(self.db_path),
            "--claude-tmp", str(self.root / "no-tmp"),
            "--bun-cache", str(self.root / "no-bun"),
            "--playwright-cache", str(self.root / "no-pw"),
            "--no-notify",
        ]
        out_no_sweep = io.StringIO()
        with contextlib.redirect_stdout(out_no_sweep):
            self.assertEqual(alert.main(base_args + ["--no-sweep"], run=self.make_runner(), now=self.now), 0)
        parsed = json.loads(out_no_sweep.getvalue())
        self.assertEqual(parsed["targets"], [])
        self.assertEqual([item["path"] for item in parsed["worktrees"]], [str(tree)])

        out_no_wt = io.StringIO()
        with contextlib.redirect_stdout(out_no_wt):
            self.assertEqual(alert.main(base_args + ["--no-worktree-prune"], run=self.make_runner(), now=self.now), 0)
        parsed_wt = json.loads(out_no_wt.getvalue())
        self.assertEqual(parsed_wt["worktrees"], [])
        self.assertEqual([item["path"] for item in parsed_wt["targets"]], [str(target)])

    def test_active_pending_or_recent_t3_thread_holds_worktree(self):
        active_wt = self.add_worktree("wt-active")
        pending_wt = self.add_worktree("wt-pending")
        recent_wt = self.add_worktree("wt-recent")
        old_wt = self.add_worktree("wt-old")
        self.db_path.unlink()
        init_t3_db(
            self.db_path,
            threads=[
                ("t1", active_wt, self.old_iso),
                ("t2", pending_wt, self.old_iso),
                ("t3", recent_wt, self.recent_iso),
                ("t4", old_wt, self.old_iso),
            ],
            runs=[("r1", "t1", "running"), ("r4", "t4", "completed")],
            requests=[("q2", "t2", "pending")],
        )
        swept = alert.sweep_merged_worktrees(self.config, self.make_runner(), self.now, dry_run=False)
        self.assertEqual([item.path for item in swept], [str(old_wt)])
        self.assertTrue(active_wt.exists() and pending_wt.exists() and recent_wt.exists())

    def test_upstream_fork_branch_counts_as_base_ref(self):
        self._git(self.repo, "checkout", "-b", "fork")
        (self.repo / "fork.txt").write_text("fork\n")
        self._git(self.repo, "add", "fork.txt")
        self._git(self.repo, "commit", "-m", "fork commit")
        self._git(self.repo, "push", "-u", "origin", "fork")
        tree = self.add_worktree("wt-fork", ref="origin/fork")
        swept = alert.sweep_merged_worktrees(self.config, self.make_runner(), self.now, dry_run=False)
        self.assertEqual([item.path for item in swept], [str(tree)])
        self.assertFalse(tree.exists())

    def test_unreadable_t3_db_fails_closed(self):
        tree = self.add_worktree("wt-db-err")
        self.db_path.unlink()
        with self.assertRaises(OSError):
            alert.sweep_merged_worktrees(self.config, self.make_runner(), self.now, dry_run=False)
        self.assertTrue(tree.exists())

    def test_running_process_keeps_merged_worktree(self):
        tree = self.add_worktree("wt-busy")
        runner = self.make_runner(lsof=f"p42\nfcwd\nn{tree}\n")
        self.assertEqual(alert.sweep_merged_worktrees(self.config, runner, self.now, dry_run=False), [])
        self.assertTrue(tree.exists())


class DailyCacheAndLaunchAgentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.now = datetime.now(timezone.utc) + timedelta(days=3)
        self.playwright = self.root / "ms-playwright"
        self.bun_cache = self.root / "bun-cache"
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.config = replace(
            CONFIG,
            state_dir=self.root / "state",
            playwright_cache=self.playwright,
            bun_cache=self.bun_cache,
            bun_cache_max_gb=0.0001,  # 100 KB for fast tests
            search_path=str(self.bin_dir),
        )

    def tearDown(self):
        self.tmp.cleanup()

    def make_tool(self, name: str):
        path = self.bin_dir / name
        path.write_text("#!/bin/sh\nexit 0\n")
        path.chmod(0o755)
        return path

    def test_playwright_keeps_newest_and_drops_older_idle_revisions(self):
        old_shell = self.playwright / "chromium_headless_shell-1248"
        new_shell = self.playwright / "chromium_headless_shell-1255"
        only_chrome = self.playwright / "chromium-1255"
        for d in (old_shell, new_shell, only_chrome):
            d.mkdir(parents=True)
            (d / "bin").write_bytes(b"x" * 8192)
        # Self-invocation mentioning --playwright-cache must not falsely block cleanup.
        runner = FakeRunner(ps="/bin/uv run disk_space_alert.py daily --playwright-cache /tmp/ms-playwright\n")
        swept = alert.sweep_playwright_cache(self.config, runner, self.now, dry_run=False)
        self.assertEqual([(item.path, item.kind) for item in swept], [(str(old_shell), "playwright")])
        self.assertFalse(old_shell.exists())
        self.assertTrue(new_shell.exists() and only_chrome.exists())

    def test_playwright_keeps_recent_older_revision(self):
        old_shell = self.playwright / "chromium_headless_shell-1248"
        new_shell = self.playwright / "chromium_headless_shell-1255"
        for d in (old_shell, new_shell):
            d.mkdir(parents=True)
            (d / "bin").write_bytes(b"x" * 4096)
        recent_ts = (self.now - timedelta(hours=2)).timestamp()
        os.utime(old_shell / "bin", (recent_ts, recent_ts))
        self.assertEqual(alert.sweep_playwright_cache(self.config, FakeRunner(), self.now, dry_run=False), [])
        self.assertTrue(old_shell.exists())

    def test_playwright_skips_when_headless_shell_is_running(self):
        old_shell = self.playwright / "chromium_headless_shell-1248"
        new_shell = self.playwright / "chromium_headless_shell-1255"
        for d in (old_shell, new_shell):
            d.mkdir(parents=True)
            (d / "bin").write_bytes(b"x" * 4096)
        runner = FakeRunner(ps="/usr/bin/chrome-headless-shell --remote-debugging-port=9222\n")
        self.assertEqual(alert.sweep_playwright_cache(self.config, runner, self.now, dry_run=False), [])
        self.assertTrue(old_shell.exists())

    def test_tool_caches_respect_caps_and_running_processes(self):
        uv = self.make_tool("uv")
        brew = self.make_tool("brew")
        bun = self.make_tool("bun")
        self.bun_cache.mkdir()
        (self.bun_cache / "pkg.tgz").write_bytes(b"x" * 200_000)

        # Postgres under /opt/homebrew/opt/... and `bun server.ts` must NOT block brew/bun cleanup.
        recorded = []

        def ok_runner(args, input_text):
            recorded.append(list(args))
            if args[0] == "ps":
                return subprocess.CompletedProcess(
                    args, 0, "/opt/homebrew/opt/postgresql@17/bin/postgres\nbun server.ts --port 59807\n", ""
                )
            if args[0] == "lsof":
                return subprocess.CompletedProcess(args, 1, "p1\nn/\n", "")
            return subprocess.CompletedProcess(args, 0, "", "")

        results = alert.sweep_tool_caches(self.config, ok_runner, dry_run=False)
        self.assertTrue(all(r["ran"] and r["error"] is None for r in results))
        self.assertIn([str(uv), "cache", "prune"], recorded)
        self.assertIn([str(brew), "cleanup", "--prune=14", "-s"], recorded)
        self.assertIn([str(bun), "pm", "cache", "rm"], recorded)

        # Running brew + bun install/bunx/flagged bun must skip both.
        for bun_cmd in ("bun install", "bunx vitest", "bun --cwd app install", "bun x prettier"):
            def busy_runner(args, input_text, cmd=bun_cmd):
                if args[0] == "ps":
                    return subprocess.CompletedProcess(args, 0, f"/opt/homebrew/bin/brew upgrade\n{cmd}\n", "")
                if args[0] == "lsof":
                    return subprocess.CompletedProcess(args, 1, "p1\nn/\n", "")
                return subprocess.CompletedProcess(args, 0, "", "")

            busy = {r["tool"]: r for r in alert.sweep_tool_caches(self.config, busy_runner, dry_run=False)}
            self.assertEqual(busy["brew"].get("skipped"), "brew_running")
            self.assertEqual(busy["bun"].get("skipped"), "bun_install_running", bun_cmd)

        # Fresh snapshot is taken after brew cleanup: a bun install that starts during brew blocks bun.
        phase = {"brew_done": False}

        def mid_run_runner(args, input_text):
            if args[0] == "ps":
                text = "bun install\n" if phase["brew_done"] else "/sbin/launchd\n"
                return subprocess.CompletedProcess(args, 0, text, "")
            if args[0] == "lsof":
                return subprocess.CompletedProcess(args, 1, "p1\nn/\n", "")
            if args[0] == str(brew):
                phase["brew_done"] = True
            return subprocess.CompletedProcess(args, 0, "", "")

        mid = {r["tool"]: r for r in alert.sweep_tool_caches(self.config, mid_run_runner, dry_run=False)}
        self.assertTrue(mid["brew"]["ran"])
        self.assertEqual(mid["bun"].get("skipped"), "bun_install_running")

        # Below cap skips bun without calling it.
        small = replace(self.config, bun_cache_max_gb=10.0)
        small_res = {r["tool"]: r for r in alert.sweep_tool_caches(small, ok_runner, dry_run=False)}
        self.assertEqual(small_res["bun"].get("skipped"), "below_cap")

    def test_daily_launch_agent_and_install_cleanup_on_bootstrap_failure(self):
        agent = alert.daily_launch_agent(
            "/bin/uv", Path("/repo/disk-alert/disk_space_alert.py"), Path("/state"),
            hour=4, minute=30, sweep_minutes=10.0, bun_cache_max_gb=1.0, brew_prune_days=14,
        )
        decoded = plistlib.loads(plistlib.dumps(agent))
        self.assertEqual(decoded["Label"], "com.syz51.disk-space-daily")
        self.assertEqual(decoded["StartCalendarInterval"], {"Hour": 4, "Minute": 30})
        self.assertFalse(decoded["RunAtLoad"])
        self.assertEqual(decoded["ProcessType"], "Standard")
        self.assertEqual(
            decoded["ProgramArguments"][:6],
            ["/bin/uv", "run", "--no-cache", "--no-project", "--python", "3.11"],
        )
        self.assertEqual(
            decoded["ProgramArguments"][-8:],
            ["/repo/disk-alert/disk_space_alert.py", "daily", "--sweep-minutes", "10",
             "--bun-cache-max-gb", "1", "--brew-prune-days", "14"],
        )

        # Failed bootstrap must remove the plist rather than leaving a broken file on disk.
        target = self.root / "LaunchAgents" / "com.syz51.disk-space-daily.plist"

        def fail_bootstrap(args, _input):
            code = 1 if args[:2] == ["launchctl", "bootstrap"] else 0
            return subprocess.CompletedProcess(args, code, "", "bootstrap error")

        with mock.patch.object(alert, "LAUNCH_AGENTS", target.parent), \
                mock.patch.object(alert, "DEFAULT_STATE_DIR", self.root / "state"), \
                contextlib.redirect_stderr(io.StringIO()):
            rc = alert.install_plist(fail_bootstrap, alert.DAILY_LABEL, target, agent, dry_run=False)
        self.assertEqual(rc, 1)
        self.assertFalse(target.exists())

    def test_sweep_lock_skips_overlapping_daily_run(self):
        self.config.state_dir.mkdir(parents=True)
        lock_fd = os.open(self.config.state_dir / "sweep.lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            alert.fcntl.flock(lock_fd, alert.fcntl.LOCK_EX | alert.fcntl.LOCK_NB)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = alert.run_daily(self.config, FakeRunner(), self.now, dry_run=False)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.getvalue())["event"], "daily_skipped")
        finally:
            alert.fcntl.flock(lock_fd, alert.fcntl.LOCK_UN)
            os.close(lock_fd)

    def test_daily_cli_validation_and_quiet_success(self):
        for bad in (["install-daily", "--hour", "24"], ["install-daily", "--minute", "60"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                alert.main(bad)
        runner = FakeRunner()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = alert.run_daily(replace(self.config, search_path=""), runner, self.now, dry_run=False)
        self.assertEqual(code, 0)
        # Quiet on success: no notification sent.
        self.assertNotIn("notify", runner.kinds())
        events = [json.loads(line) for line in (self.config.state_dir / "events.jsonl").read_text().splitlines()]
        self.assertEqual(events[-1]["event"], "daily")

    def test_daily_notifies_on_failure_and_respects_time_limit(self):
        # Missing t3_db with worktrees causes worktree step failure -> exits 1 and notifies.
        (self.root / "wts").mkdir()
        failing = replace(
            self.config, worktrees=self.root / "wts", t3_db=self.root / "missing.sqlite", search_path=""
        )
        runner = FakeRunner()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = alert.run_daily(failing, runner, self.now, dry_run=False)
        self.assertEqual(code, 1)
        self.assertIn("notify", runner.kinds())
        self.assertEqual(json.loads(out.getvalue())["failures"][0]["step"], "worktrees")

        # Expired time limit stops cleanly and records stopped=True.
        ticks = iter([0.0, 10_000.0, 10_000.0, 10_000.0, 10_000.0])
        out2 = io.StringIO()
        with contextlib.redirect_stdout(out2):
            code2 = alert.run_daily(
                replace(self.config, sweep_minutes=1.0, search_path=""),
                FakeRunner(), self.now, dry_run=True, clock=lambda: next(ticks),
            )
        self.assertEqual(code2, 0)
        self.assertTrue(json.loads(out2.getvalue())["stopped"])

    def test_uv_cache_prune_uses_longer_timeout_and_treats_timeout_as_warning(self):
        uv = self.make_tool("uv")
        seen_timeouts = []

        def timeout_runner(args, input_text, timeout=None):
            if args == [str(uv), "cache", "prune"]:
                seen_timeouts.append(timeout)
                return subprocess.CompletedProcess(
                    args, alert.TIMEOUT_EXIT, "", f"timed out after {timeout} seconds"
                )
            if args == [str(uv), "cache", "dir"]:
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[0] == "ps":
                return subprocess.CompletedProcess(args, 0, "/sbin/launchd\n", "")
            if args[0] == "lsof":
                return subprocess.CompletedProcess(args, 1, "p1\nn/\n", "")
            return subprocess.CompletedProcess(args, 0, "", "")

        # Direct sweep_tool_caches uses UV_PRUNE_TIMEOUT_SECONDS when no finite deadline is set.
        caches = alert.sweep_tool_caches(self.config, timeout_runner, dry_run=False)
        self.assertEqual(seen_timeouts, [alert.UV_PRUNE_TIMEOUT_SECONDS])
        self.assertEqual(len(caches), 1)
        self.assertTrue(caches[0]["ran"])
        self.assertIsNone(caches[0]["error"])
        self.assertIn(f"timed out after {alert.UV_PRUNE_TIMEOUT_SECONDS} seconds", caches[0]["warning"])

        # run_daily treats a uv cache prune timeout as a warning: exits 0 and does not notify.
        notified = []

        def daily_timeout_runner(args, input_text, timeout=None):
            if args[0] == self.config.osascript:
                notified.append(args)
            return timeout_runner(args, input_text, timeout=timeout)

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = alert.run_daily(
                replace(self.config, sweep_minutes=2.0),
                daily_timeout_runner,
                self.now,
                dry_run=False,
            )
        self.assertEqual(code, 0)
        self.assertEqual(notified, [])
        # Timeout was bounded by remaining sweep budget (~120s <= 300s).
        self.assertLessEqual(seen_timeouts[-1], 120)
        self.assertGreater(seen_timeouts[-1], 0)
        summary = json.loads(out.getvalue())
        self.assertIn("uv", summary["warnings"])
        events = [json.loads(line) for line in (self.config.state_dir / "events.jsonl").read_text().splitlines()]
        self.assertEqual(events[-1]["errors"], {})
        self.assertIn("uv", events[-1]["warnings"])

    def test_uv_cache_prune_non_timeout_error_still_fails_daily(self):
        uv = self.make_tool("uv")
        notified = []

        def fail_runner(args, input_text, timeout=None):
            if args == [str(uv), "cache", "prune"]:
                return subprocess.CompletedProcess(args, 1, "", "permission denied")
            if args == [str(uv), "cache", "dir"]:
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[0] == self.config.osascript:
                notified.append(args)
            return subprocess.CompletedProcess(args, 0, "", "")

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = alert.run_daily(self.config, fail_runner, self.now, dry_run=False)
        self.assertEqual(code, 1)
        self.assertEqual(len(notified), 1)
        summary = json.loads(out.getvalue())
        self.assertEqual(summary["warnings"], {})
        self.assertEqual(summary["caches"][0]["error"], "permission denied")

    def test_uv_cache_in_use_skips_prune_when_lock_is_held(self):
        uv = self.make_tool("uv")
        uv_cache = self.root / "uv-cache"
        uv_cache.mkdir()
        lock_file = uv_cache / ".lock"
        lock_file.touch()

        recorded = []

        def runner(args, input_text):
            recorded.append(list(args))
            if args == [str(uv), "cache", "dir"]:
                return subprocess.CompletedProcess(args, 0, f"{uv_cache}\n", "")
            return subprocess.CompletedProcess(args, 0, "", "")

        # Hold a shared lock on .lock (just like an outer `uv run` without --no-cache).
        lock_fd = os.open(lock_file, os.O_RDWR)
        try:
            alert.fcntl.flock(lock_fd, alert.fcntl.LOCK_SH | alert.fcntl.LOCK_NB)
            res = alert.sweep_tool_caches(self.config, runner, dry_run=False)
            self.assertEqual(res[0]["skipped"], "uv_cache_in_use")
            self.assertFalse(res[0]["ran"])
            self.assertIsNone(res[0]["error"])
            self.assertNotIn([str(uv), "cache", "prune"], recorded)
        finally:
            alert.fcntl.flock(lock_fd, alert.fcntl.LOCK_UN)
            os.close(lock_fd)

        # Once unlocked, uv cache prune runs normally.
        res2 = alert.sweep_tool_caches(self.config, runner, dry_run=False)
        self.assertTrue(res2[0]["ran"])
        self.assertIsNone(res2[0]["error"])
        self.assertIn([str(uv), "cache", "prune"], recorded)

    def test_run_command_respects_custom_timeout(self):
        with mock.patch.object(alert.subprocess, "run", side_effect=subprocess.TimeoutExpired(["uv"], 300)):
            res = alert.run_command(["uv", "cache", "prune"], timeout=300)
        self.assertEqual(res.returncode, alert.TIMEOUT_EXIT)
        self.assertEqual(res.stderr, "timed out after 300 seconds")

    def test_sweep_lock_writes_pid_and_truncates_on_release(self):
        with alert.sweep_lock(self.config.state_dir) as acquired:
            self.assertTrue(acquired)
            owner = alert.read_sweep_lock_owner(self.config.state_dir)
            self.assertIsNotNone(owner)
            self.assertEqual(owner["pid"], os.getpid())
            self.assertIn("started_at", owner)
        self.assertIsNone(alert.read_sweep_lock_owner(self.config.state_dir))

    def test_sweep_lock_recovers_stale_dead_pid_when_unlocked_and_when_flock_blocked(self):
        self.config.state_dir.mkdir(parents=True)
        lock_path = self.config.state_dir / "sweep.lock"
        stale_pid = dead_pid()

        # Case 1: crashed holder left dead PID in unlocked sweep.lock.
        lock_path.write_text(json.dumps({"pid": stale_pid, "started_at": "2026-11-01T00:00:00+00:00"}) + "\n")
        with alert.sweep_lock(self.config.state_dir) as acquired:
            self.assertTrue(acquired)
            self.assertEqual(alert.read_sweep_lock_owner(self.config.state_dir)["pid"], os.getpid())

        # Case 2: dead PID in sweep.lock while flock is still held (e.g. leaked FD in orphaned child).
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            alert.fcntl.flock(lock_fd, alert.fcntl.LOCK_EX | alert.fcntl.LOCK_NB)
            os.ftruncate(lock_fd, 0)
            os.lseek(lock_fd, 0, os.SEEK_SET)
            os.write(lock_fd, (json.dumps({"pid": stale_pid}) + "\n").encode())
            stale_ino = os.fstat(lock_fd).st_ino

            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = alert.run_daily(
                    replace(self.config, search_path=""), FakeRunner(), self.now, dry_run=False
                )
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.getvalue())["event"], "daily")
            # A fresh inode replaced the stale locked file.
            self.assertNotEqual(lock_path.stat().st_ino, stale_ino)
        finally:
            alert.fcntl.flock(lock_fd, alert.fcntl.LOCK_UN)
            os.close(lock_fd)

        # Case 3: plain integer dead PID text in locked sweep.lock also recovers.
        lock_fd2 = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            alert.fcntl.flock(lock_fd2, alert.fcntl.LOCK_EX | alert.fcntl.LOCK_NB)
            os.ftruncate(lock_fd2, 0)
            os.lseek(lock_fd2, 0, os.SEEK_SET)
            os.write(lock_fd2, f"{stale_pid}\n".encode())
            with alert.sweep_lock(self.config.state_dir) as acquired:
                self.assertTrue(acquired)
                self.assertEqual(alert.read_sweep_lock_owner(self.config.state_dir)["pid"], os.getpid())
        finally:
            alert.fcntl.flock(lock_fd2, alert.fcntl.LOCK_UN)
            os.close(lock_fd2)

    def test_sweep_lock_does_not_break_live_pid_and_logs_holder_pid(self):
        self.config.state_dir.mkdir(parents=True)
        lock_path = self.config.state_dir / "sweep.lock"
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            alert.fcntl.flock(lock_fd, alert.fcntl.LOCK_EX | alert.fcntl.LOCK_NB)
            os.ftruncate(lock_fd, 0)
            os.lseek(lock_fd, 0, os.SEEK_SET)
            os.write(lock_fd, (json.dumps({"pid": os.getpid()}) + "\n").encode())
            live_ino = os.fstat(lock_fd).st_ino

            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = alert.run_daily(
                    replace(self.config, search_path=""), FakeRunner(), self.now, dry_run=False
                )
            self.assertEqual(code, 0)
            record = json.loads(out.getvalue())
            self.assertEqual(record["event"], "daily_skipped")
            self.assertEqual(record["holder_pid"], os.getpid())
            # Inode was NOT unlinked or replaced.
            self.assertEqual(lock_path.stat().st_ino, live_ino)
        finally:
            alert.fcntl.flock(lock_fd, alert.fcntl.LOCK_UN)
            os.close(lock_fd)


if __name__ == "__main__":
    unittest.main()
