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


class SweepTest(unittest.TestCase):
    """Files made now count as idle two days ahead; a recent change is an mtime set
    after the 24-hour cutoff."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name).resolve()
        self.claude_tmp = root / "claude-501"
        self.projects = root / "projects"
        self.now = datetime.now(timezone.utc) + timedelta(days=2)
        self.project = "-Users-me-repo"

    def tearDown(self):
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

    def sweep(self, runner=None, dry_run=False):
        return alert.sweep_sessions(
            self.claude_tmp, self.projects, runner or FakeRunner(), self.now, dry_run
        )

    def test_idle_session_is_removed_with_its_size(self):
        folder = self.session(size=100_000)
        swept = self.sweep()
        self.assertEqual([item.path for item in swept], [str(folder)])
        self.assertGreaterEqual(swept[0].bytes, 100_000)
        self.assertIsNone(swept[0].error)
        self.assertFalse(folder.exists())
        self.assertTrue((self.projects / self.project / f"{SESSION}.jsonl").exists())

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

    def test_unreadable_process_list_removes_nothing(self):
        folder = self.session()
        self.assertEqual(self.sweep(FakeRunner(ps_code=1, ps="")), [])
        self.assertEqual(self.sweep(FakeRunner(lsof="")), [])
        self.assertTrue(folder.exists())

    def test_only_session_folders_are_candidates(self):
        self.session()
        project = self.claude_tmp / self.project
        (project / "not-a-session").mkdir()
        (self.claude_tmp / "cache-break-state-x.json").write_text("{}")
        (self.claude_tmp / "uv-1.lock").touch()
        target = Path(self.tmp.name) / "keep"
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

    def test_missing_temp_folder_is_nothing_to_do(self):
        runner = FakeRunner()
        self.assertEqual(self.sweep(runner), [])
        self.assertEqual(runner.calls, [])

    def config(self, state_dir):
        return replace(CONFIG, state_dir=state_dir, claude_tmp=self.claude_tmp, claude_projects=self.projects)

    def test_low_space_check_sweeps_then_alerts_with_what_it_freed(self):
        folder = self.session(size=20_000_000)
        state_dir = Path(self.tmp.name) / "state"
        runner = FakeRunner()
        with contextlib.redirect_stdout(io.StringIO()):
            code = alert.run_check(self.config(state_dir), runner, 25.0, self.now)
        self.assertEqual(code, 0)
        self.assertFalse(folder.exists())
        self.assertEqual(runner.kinds(), ["ps", "lsof", "start", "notify"])
        self.assertIn("removed 1 idle Claude Code session scratch folder (0.0 GB)", runner.calls[2][1])
        events = [json.loads(line) for line in (state_dir / "events.jsonl").read_text().splitlines()]
        self.assertEqual([event["event"] for event in events], ["swept", "escalated"])
        self.assertEqual(events[0]["removed"], [str(folder)])
        self.assertLess(events[1]["free_gb"], 25.0)

    def test_ok_space_or_no_sweep_leaves_sessions(self):
        folder = self.session()
        state_dir = Path(self.tmp.name) / "state"
        runner = FakeRunner()
        alert.run_check(self.config(state_dir), runner, 50.0, self.now)
        with contextlib.redirect_stdout(io.StringIO()):
            alert.run_check(replace(self.config(state_dir), claude_tmp=None), runner, 25.0, self.now)
        self.assertTrue(folder.exists())
        self.assertNotIn("ps", runner.kinds())


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

    def test_sweep_command_dry_run_and_no_sweep(self):
        claude_tmp = self.root / "claude-tmp"
        folder = claude_tmp / "-p" / SESSION
        folder.mkdir(parents=True)
        later = datetime.now(timezone.utc) + timedelta(days=2)
        os.utime(folder, (later.timestamp() - 3 * 86400,) * 2)
        base = ["sweep", "--claude-tmp", str(claude_tmp), "--claude-projects", str(self.root / "projects")]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(alert.main(base + ["--dry-run"]), 0)
        self.assertEqual(json.loads(out.getvalue())["dry_run"], True)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(alert.main(base + ["--no-sweep"]), 0)
        self.assertTrue(folder.exists())

    def test_critical_must_be_below_low(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            alert.main(["check", "--low-gb", "20", "--critical-gb", "30"])


if __name__ == "__main__":
    unittest.main()
