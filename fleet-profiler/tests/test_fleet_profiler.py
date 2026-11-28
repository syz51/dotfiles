import datetime as dt
import json
import plistlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import fleet_profiler as fp  # noqa: E402


BOARD_DDL = """
CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    board TEXT,
    kind TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'managed',
    device TEXT NOT NULL,
    runner TEXT NOT NULL,
    agent_id TEXT,
    state TEXT NOT NULL,
    title TEXT,
    outcome_json TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    updated_at INTEGER NOT NULL
);
CREATE TABLE run_outcomes (
    run_id TEXT PRIMARY KEY,
    board TEXT,
    task_id TEXT,
    device TEXT,
    kind TEXT NOT NULL,
    terminal_state TEXT NOT NULL,
    running_secs INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cached_tokens INTEGER,
    reasoning_tokens INTEGER,
    recorded_at INTEGER NOT NULL
);
CREATE TABLE usage_buckets (
    provider TEXT NOT NULL,
    account TEXT NOT NULL,
    five_hour_pct REAL,
    five_hour_resets_at INTEGER,
    seven_day_pct REAL,
    seven_day_resets_at INTEGER,
    read_at INTEGER,
    device TEXT,
    reserve_pct REAL,
    anchor_day_start INTEGER,
    anchor_pct REAL,
    PRIMARY KEY (provider, account)
);
CREATE TABLE usage_bucket_samples (
    provider TEXT NOT NULL,
    account TEXT NOT NULL,
    at INTEGER NOT NULL,
    seven_day_pct REAL NOT NULL,
    PRIMARY KEY (provider, account, at)
);
CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    board TEXT,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    task TEXT,
    payload TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE scheduler_holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    board TEXT,
    task_id TEXT,
    device TEXT,
    reason TEXT NOT NULL,
    detail TEXT
);
CREATE TABLE scheduled_jobs (
    job_key TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    source TEXT NOT NULL,
    job_id TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'monitoring',
    enabled INTEGER NOT NULL DEFAULT 1,
    schedule_human TEXT NOT NULL DEFAULT 'daily',
    schedule_raw TEXT NOT NULL DEFAULT 'daily',
    state TEXT NOT NULL,
    last_exit_code INTEGER,
    last_error TEXT,
    reported_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
"""

T3_DDL = """
CREATE TABLE auth_sessions (
    session_id TEXT PRIMARY KEY,
    issued_at TEXT NOT NULL
);
CREATE TABLE orchestration_v2_projection_threads (
    thread_id TEXT PRIMARY KEY,
    title TEXT
);
"""


def _cp(stdout: str = "", stderr: str = "", rc: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["fake"], returncode=rc, stdout=stdout, stderr=stderr)


class TestFleetProfiler(unittest.TestCase):
    def test_board_db_sql_real_ddl_null_and_coalesced_edge_cases(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "board.db"
            con = sqlite3.connect(db)
            con.executescript(BOARD_DDL)
            now_ms = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)

            # 15 NULL-task interactive runs (must NOT trigger per-task storm!)
            for i in range(15):
                con.execute(
                    "INSERT INTO runs VALUES (?, NULL, 'board-a', 'interactive', 'interactive', 'mac-1', 't3', NULL, 'waiting_external', 'chat', NULL, ?, NULL, NULL, ?)",
                    (f"run-int-{i}", now_ms - 1000, now_ms),
                )

            # 10 succeeded LLM runs, 5 with NULL tokens (50% blind spot -> RED)
            for i in range(10):
                rid = f"run-w-{i}"
                con.execute(
                    "INSERT INTO runs VALUES (?, ?, 'board-a', 'worker', 'managed', 'mac-1', 't3', NULL, 'succeeded', 'work task', NULL, ?, ?, ?, ?)",
                    (rid, f"board-a-{i}", now_ms - 5000, now_ms - 4000, now_ms - 1000, now_ms),
                )
                tok = None if i < 5 else 2_000_000
                cach = None if i < 5 else 1_800_000
                con.execute(
                    "INSERT INTO run_outcomes VALUES (?, 'board-a', ?, 'mac-1', 'worker', 'succeeded', 120, ?, 10000, ?, 5000, ?)",
                    (rid, f"board-a-{i}", tok, cach, now_ms),
                )

            # 1 after-merge LLM run + 1 regular review whose title merely contains 'after-merge' (must NOT be counted as after-merge)
            con.execute(
                "INSERT INTO runs VALUES ('run-am-1', 'board-a-99', 'board-a', 'review', 'managed', 'mac-1', 't3', NULL, 'succeeded', 'after-merge board-a-99 deploy', NULL, ?, ?, ?, ?)",
                (now_ms - 4000, now_ms - 3000, now_ms - 1000, now_ms),
            )
            con.execute(
                "INSERT INTO run_outcomes VALUES ('run-am-1', 'board-a', 'board-a-99', 'mac-1', 'review', 'succeeded', 300, 4000000, 15000, 3500000, 8000, ?)",
                (now_ms,),
            )
            con.execute(
                "INSERT INTO runs VALUES ('run-rev-false', 'board-a-98', 'board-a', 'review', 'managed', 'mac-1', 't3', NULL, 'succeeded', 'review board-a-98 fix after-merge wording', NULL, ?, ?, ?, ?)",
                (now_ms - 4000, now_ms - 3000, now_ms - 1000, now_ms),
            )
            con.execute(
                "INSERT INTO run_outcomes VALUES ('run-rev-false', 'board-a', 'board-a-98', 'mac-1', 'review', 'succeeded', 100, 500000, 5000, 400000, 1000, ?)",
                (now_ms,),
            )

            # Coalesced merge run with poll_count = 15 (YELLOW)
            con.execute(
                "INSERT INTO runs VALUES ('run-m-1', 'board-a-50', 'board-a', 'merge', 'managed', 'mac-1', 'deterministic', NULL, 'waiting_external', 'merge board-a-50', '{\"status\":\"deferred\",\"poll_count\":15}', ?, ?, NULL, ?)",
                (now_ms - 3000, now_ms - 2500, now_ms),
            )

            # Scheduled jobs: 1 ok (exit 0), 1 ok (exit NULL), 1 failing (exit 1), 1 overdue (exit 0), 1 disabled failing
            con.execute("INSERT INTO scheduled_jobs VALUES ('h:l:ok0', 'mac-1', 'launchd', 'ok0', 'ok-job', 'monitoring', 1, 'daily', 'daily', 'ok', 0, NULL, ?, ?)", (now_ms, now_ms))
            con.execute("INSERT INTO scheduled_jobs VALUES ('h:l:okn', 'mac-1', 'launchd', 'okn', 'ok-null', 'monitoring', 1, 'daily', 'daily', 'ok', NULL, NULL, ?, ?)", (now_ms, now_ms))
            con.execute("INSERT INTO scheduled_jobs VALUES ('h:l:bad', 'mac-2', 'launchd', 'bad', 'disk-daily', 'monitoring', 1, 'daily', 'daily', 'failing', 1, 'uv timed out', ?, ?)", (now_ms, now_ms))
            con.execute("INSERT INTO scheduled_jobs VALUES ('h:s:ovd', 'vps-1', 'systemd', 'ovd', 'backup-timer', 'backup', 1, 'daily', 'daily', 'overdue', 0, NULL, ?, ?)", (now_ms, now_ms))
            con.execute("INSERT INTO scheduled_jobs VALUES ('h:l:dis', 'mac-1', 'launchd', 'dis', 'disabled-job', 'monitoring', 0, 'daily', 'daily', 'failing', 1, 'ignored', ?, ?)", (now_ms, now_ms))

            con.commit()
            con.close()

            cfg = fp.ProfilerConfig(local_name="mac-1", board_db_path=str(db))
            res = fp.probe_board_db(cfg, fp.default_runner)
            self.assertEqual(res["status"], "ok")
            data = res["data"]

            rs = data["runs_summary"]
            self.assertEqual(rs["llm_zero_tok"], 5)
            self.assertEqual(rs["llm_settled_for_tok"], 12)
            self.assertEqual(rs["max_merge_poll_count"], 15)

            # Only the prefix 'after-merge%' run is counted (not 'review ... after-merge ...')
            self.assertEqual(data["after_merge_llm"]["runs"], 1)
            self.assertEqual(data["after_merge_llm"]["tokens_in"], 4_000_000)

            # NULL task_id runs excluded from top_task_runs
            for item in data["top_task_runs"]:
                self.assertIsNotNone(item["task_id"])
                self.assertEqual(item["count"], 1)

            # Failing + overdue enabled jobs both caught; disabled and ok jobs excluded
            fj = {j["name"]: j for j in data["failing_jobs"]}
            self.assertEqual(set(fj.keys()), {"disk-daily", "backup-timer"})

            anoms, derived = fp.evaluate_anomalies(res, [], fp.DEFAULT_THRESHOLDS, now_ms)
            codes = {(a.severity, a.code) for a in anoms}
            self.assertIn(("YELLOW", "merge_poll_high"), codes)
            self.assertIn(("YELLOW", "after_merge_llm_waste"), codes)
            self.assertIn(("YELLOW", "token_telemetry_gap"), codes)
            self.assertIn(("RED", "scheduled_job_unhealthy"), codes)
            self.assertIn(("YELLOW", "scheduled_job_unhealthy"), codes)
            self.assertNotIn(("RED", "task_run_storm"), codes)
            self.assertAlmostEqual(derived["zero_token_gap_pct"], 41.7, places=1)

    def test_pace_day_and_compute_pace_exact_match_and_stale_anchor_guard(self) -> None:
        # Mirror live antigravity reading: 7d resets in ~5.38 days -> ceil = 6 days
        read_at = 1795816349612
        reset_at = 1796281416000
        start_ms, days = fp.pace_day(read_at, reset_at)
        self.assertEqual(days, 6)
        bucket = {
            "provider": "antigravity",
            "account": "default",
            "seven_day_pct": 47.46,
            "seven_day_resets_at": reset_at,
            "read_at": read_at,
            "reserve_pct": 5.0,
            "anchor_day_start": start_ms,
            "anchor_pct": 26.53,
        }
        pace = fp.compute_pace_line(bucket, now_ms=read_at + 60_000)
        assert pace is not None
        self.assertFalse(pace["stale"])
        self.assertEqual(pace["days_left"], 6)
        # 26.53 + (100 - 5 - 26.53) / 6 = 37.94
        self.assertAlmostEqual(pace["line_pct"], 37.94, places=2)
        self.assertAlmostEqual(pace["overshoot_pct"], 9.52, places=2)

        # Mismatched anchor_day_start falls back to seven_day_pct as anchor (no bogus overshoot)
        mismatched = dict(bucket, anchor_day_start=start_ms - fp.DAY_MS, anchor_pct=2.0)
        pace2 = fp.compute_pace_line(mismatched, now_ms=read_at + 60_000)
        assert pace2 is not None
        self.assertEqual(pace2["anchor_pct"], 47.46)
        self.assertLess(pace2["overshoot_pct"], 0.0)

        # Stale reading (>24h old) is marked stale
        stale = fp.compute_pace_line(bucket, now_ms=read_at + 30 * 3_600_000)
        assert stale is not None
        self.assertTrue(stale["stale"])

    def test_trace_metrics_numeric_sort_and_no_double_counting(self) -> None:
        # .10 is oldest (mtime=1000), .1 is newest rotated (mtime=1900), active (mtime=2000, size=2 MiB)
        # Span = 2000 - 1000 = 1000s; bytes written AFTER oldest (.10) = active (2M) + .1..9 (9 * 10M) = 92 MiB
        # Rate = 92 MiB / (1000/3600 hr) = 331.2 MiB/hr (does NOT double-count .10's 10 MiB!)
        mb = 1_048_576
        meta = [("server.trace.ndjson", 2 * mb, 2000.0)]
        for i in range(1, 11):
            meta.append((f"server.trace.ndjson.{i}", 10 * mb, 2000.0 - i * 100.0))
        sample = [
            json.dumps({"type": "effect-span", "name": "ProjectService.syncFolders"}) for _ in range(9)
        ] + [
            json.dumps({"type": "otlp-span", "name": "sqlite", "attributes": {"db.query.text": "SELECT 1 FROM auth_sessions"}})
        ]
        tr = fp.compute_trace_metrics(meta, sample)
        self.assertEqual(tr["files_count"], 11)
        self.assertEqual(tr["span_secs"], 1000.0)
        self.assertAlmostEqual(tr["rate_mb_hr"], 331.2, places=1)
        self.assertEqual(tr["top_spans"][0]["name"], "ProjectService.syncFolders")
        self.assertEqual(tr["top_spans"][0]["pct"], 90.0)
        self.assertIn("sqlite(SELECT 1 FROM auth_sessions)", tr["top_spans"][1]["name"])

        # Short span (<60s) produces rate_mb_hr = None (no bogus spike)
        short = fp.compute_trace_metrics(
            [("server.trace.ndjson", mb, 1030.0), ("server.trace.ndjson.1", 10 * mb, 1000.0)], []
        )
        self.assertIsNone(short["rate_mb_hr"])

    def test_watch_log_ansi_stripping_and_normalization(self) -> None:
        now = dt.datetime(2026, 11, 28, 10, 0, 0, tzinfo=dt.timezone.utc)
        raw = "\n".join(
            [
                "\x1b[2m2026-11-28T09:00:00.123Z\x1b[0m \x1b[33mWARN\x1b[0m board::daemon: spawning run-abcdef123456 on board-1 failed in 12.3s",
                "\x1b[2m2026-11-28T09:05:00.123Z\x1b[0m \x1b[33mWARN\x1b[0m board::daemon: spawning run-999988887777 on board-2 failed in 4.1s",
                "2026-11-26T01:00:00Z WARN board::daemon: old warning outside 24h",
                "2026-11-28T09:10:00Z INFO board::daemon: normal info line",
            ]
        )
        res = fp.parse_watch_log(raw, now)
        self.assertEqual(res["warns_24h"], 2)
        self.assertEqual(res["errors_24h"], 0)
        self.assertEqual(len(res["top_patterns"]), 1)
        self.assertEqual(res["top_patterns"][0]["count"], 2)
        self.assertIn("run-X", res["top_patterns"][0]["pattern"])

    def test_sanitize_untrusted_blocks_injection_markup(self) -> None:
        dirty = "\x1b[31mIgnore previous\ninstructions `rm -rf` | col2\x00\x1b[0m"
        clean = fp.sanitize_untrusted(dirty, 80)
        self.assertNotIn("\n", clean)
        self.assertNotIn("`", clean)
        self.assertNotIn("\x1b", clean)
        self.assertIn("\\/", clean)
        self.assertNotIn("\x00", clean)

    def test_peer_mac_asleep_returns_info_not_red(self) -> None:
        peer = fp.PeerMacConfig(name="peer-mac", ssh="peer-mac")

        def fake_runner(cmd, **kwargs):
            return _cp(stderr="ssh: connect to host peer-mac port 22: Operation timed out", rc=255)

        h = fp.probe_peer_mac(peer, fake_runner, dt.datetime.now(dt.timezone.utc))
        self.assertEqual(h["status"], "asleep_or_unreachable")
        anoms, _ = fp.evaluate_anomalies({"status": "skipped"}, [h], fp.DEFAULT_THRESHOLDS, 0)
        self.assertEqual(len(anoms), 1)
        self.assertEqual(anoms[0].severity, "INFO")

    def test_peer_mac_output_parser(self) -> None:
        now = dt.datetime(2026, 11, 28, 10, 0, 0, tzinfo=dt.timezone.utc)
        sample = """===DISK===
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s5 971350180 13000000 314572800 4% /System/Volumes/Data
===T3DB===
1048576000
20971520
{"auth_total": 180000, "auth_24h": 12000, "threads": 900}
===TRACEMETA===
server.trace.ndjson 1048576 2000
server.trace.ndjson.1 10485760 1000
===TRACESAMPLE===
{"name":"ProjectService.syncFolders"}
===WORKTREES===
12582912
5
===REPOS===
repo-a\t30\t2
repo-b\t70\t25
===DIRTY===
repo-a\t M config.toml;
===WATCHLOG===
2026-11-28T09:00:00Z WARN board::daemon: test warning
"""
        parsed = fp.parse_peer_mac_output("peer-mac", sample, now)
        self.assertEqual(parsed["status"], "ok")
        self.assertAlmostEqual(parsed["disk_avail_gib"], 300.0, places=1)
        self.assertAlmostEqual(parsed["t3_db_mb"], 1000.0, places=1)
        self.assertEqual(parsed["auth_sessions_total"], 180000)
        self.assertEqual(parsed["worktrees_gib"], 12.0)
        self.assertEqual(parsed["worktrees_count"], 5)
        self.assertEqual(parsed["watch_log"]["warns_24h"], 1)
        self.assertEqual(len(parsed["repos"]), 2)
        self.assertEqual(parsed["repos"][0]["dirty_tracked"], ["M config.toml"])

    def test_run_profile_local_end_to_end_and_history_pruning(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            t3_dir = root / "t3"
            (t3_dir / "userdata" / "logs").mkdir(parents=True)
            (t3_dir / "worktrees" / "proj" / "wt1").mkdir(parents=True)
            t3_db = t3_dir / "userdata" / "statev2.sqlite"
            con = sqlite3.connect(t3_db)
            con.executescript(T3_DDL)
            now_dt = dt.datetime(2026, 11, 28, 10, 0, 0, tzinfo=dt.timezone.utc)
            con.execute("INSERT INTO auth_sessions VALUES ('s1', '2026-11-28T09:00:00Z')")
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES ('t1', 'hello')")
            con.commit()
            con.close()

            state_dir = root / "state"
            state_dir.mkdir()
            old_ts = (now_dt - dt.timedelta(days=120)).timestamp()
            (state_dir / "history.jsonl").write_text(
                json.dumps({"ts_unix": old_ts, "overall_status": "GREEN"}) + "\n",
                encoding="utf-8",
            )

            cfg = fp.ProfilerConfig(
                local_name="test-mac",
                local_t3_dir=str(t3_dir),
                local_board_home=str(root / "board"),
                local_repos_dir=str(root / "repos"),
                local_extra_repos=[],
                local_clean_checkouts=[],
            )

            def fake_runner(cmd, **kwargs):
                if cmd[0] == "du":
                    return _cp("1024\t/tmp\n")
                if cmd[0] == "df":
                    return _cp("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3 100 10 52428800 50% /\n")
                return _cp()

            rc, rep = fp.run_profile(cfg, state_dir, fake_runner, local_only=True, now_utc=now_dt)
            self.assertEqual(rc, 0)
            assert rep is not None
            self.assertEqual(rep["overall_status"], "GREEN")
            self.assertTrue((state_dir / "latest.json").exists())
            self.assertTrue((state_dir / "latest.md").exists())
            self.assertTrue((state_dir / "run.lock").exists())

            # Old >90d history entry pruned, new entry kept
            hist_lines = (state_dir / "history.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(hist_lines), 1)
            self.assertEqual(json.loads(hist_lines[0])["overall_status"], "GREEN")

    def test_launch_agent_plist_shape(self) -> None:
        agent = fp.launch_agent(
            "/usr/local/bin/uv",
            Path("/tmp/fleet_profiler.py"),
            Path("/tmp/state"),
            hour=9,
            minute=15,
            config_path=Path("/tmp/fleet.toml"),
        )
        raw = plistlib.dumps(agent)
        parsed = plistlib.loads(raw)
        self.assertEqual(parsed["Label"], fp.LABEL)
        self.assertEqual(parsed["ProcessType"], "Standard")
        self.assertEqual(parsed["RunAtLoad"], False)
        self.assertEqual(parsed["StartCalendarInterval"], {"Hour": 9, "Minute": 15})
        self.assertIn("--no-cache", parsed["ProgramArguments"])
        self.assertIn("--config", parsed["ProgramArguments"])
        self.assertIn("PATH", parsed["EnvironmentVariables"])


if __name__ == "__main__":
    unittest.main()
