import contextlib
import importlib.util
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "settle_children.py"
spec = importlib.util.spec_from_file_location("settle_children", SCRIPT)
settle_children = importlib.util.module_from_spec(spec)
spec.loader.exec_module(settle_children)

SCHEMA = """
create table orchestration_v2_projection_threads (
  thread_id text primary key, title text, archived_at text, deleted_at text,
  payload_json text not null
);
create table orchestration_v2_projection_runs (
  run_id text primary key, thread_id text not null, status text not null
);
create table orchestration_v2_projection_subagents (
  subagent_id text primary key, thread_id text not null, run_id text,
  child_thread_id text, status text not null
);
create table orchestration_v2_projection_runtime_requests (
  runtime_request_id text primary key, thread_id text not null, status text not null
);
"""


class Fixture:
    def __init__(self, path: Path):
        self.path = path
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)
        self.counter = 0

    def thread(
        self,
        thread_id,
        parent=None,
        root=None,
        settled=False,
        override=None,
        archived=False,
        deleted=False,
        relationship=None,
    ):
        self.counter += 1
        lineage = None
        if parent is not None:
            lineage = {
                "parentThreadId": parent,
                "rootThreadId": root or parent,
                "relationshipToParent": relationship or "subagent",
            }
        payload = {
            "createdAt": f"2026-01-01T00:00:{self.counter:02d}Z",
            "settledAt": "2026-01-02T00:00:00Z" if settled else None,
            "settledOverride": override if override else ("settled" if settled else None),
            "lineage": lineage,
        }
        self.db.execute(
            "insert into orchestration_v2_projection_threads values (?, ?, ?, ?, ?)",
            (
                thread_id,
                thread_id,
                "2026-01-03T00:00:00Z" if archived else None,
                "2026-01-03T00:00:00Z" if deleted else None,
                json.dumps(payload),
            ),
        )

    def run(self, run_id, thread_id, status):
        self.db.execute(
            "insert into orchestration_v2_projection_runs values (?, ?, ?)",
            (run_id, thread_id, status),
        )

    def subagent(self, child, parent, run_id, status):
        self.counter += 1
        self.db.execute(
            "insert into orchestration_v2_projection_subagents values (?, ?, ?, ?, ?)",
            (f"subagent-{self.counter}", parent, run_id, child, status),
        )

    def request(self, thread_id, status):
        self.counter += 1
        self.db.execute(
            "insert into orchestration_v2_projection_runtime_requests values (?, ?, ?)",
            (f"request-{self.counter}", thread_id, status),
        )

    def candidates(self):
        self.db.commit()
        return settle_children.find_candidates(self.path)


class FindCandidatesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fx = Fixture(Path(self.tmp.name) / "state.sqlite")
        self.addCleanup(self.fx.db.close)
        self.fx.thread("settled-root", settled=True)
        self.fx.run("root-run", "settled-root", "completed")
        self.fx.thread("open-root")
        self.fx.run("open-root-run", "open-root", "completed")

    def child(self, thread_id, parent="settled-root", status="completed", **kwargs):
        self.fx.thread(thread_id, parent=parent, **kwargs)
        self.fx.subagent(thread_id, parent, "root-run" if parent == "settled-root" else "open-root-run", status)

    def test_lists_idle_child_of_settled_parent(self):
        self.child("idle-child")
        self.assertEqual(self.fx.candidates(), ["idle-child"])

    def test_lists_child_of_archived_parent(self):
        self.fx.thread("archived-root", archived=True)
        self.fx.thread("child", parent="archived-root")
        self.assertEqual(self.fx.candidates(), ["child"])

    def test_skips_child_of_unsettled_parent(self):
        self.child("child", parent="open-root")
        self.assertEqual(self.fx.candidates(), [])

    def test_lists_grandchild_when_root_settled(self):
        self.child("middle", settled=True)
        self.fx.thread("grandchild", parent="middle", root="settled-root")
        self.assertEqual(self.fx.candidates(), ["grandchild"])

    def test_lists_grandchild_when_root_settled_but_parent_open(self):
        self.child("middle")
        self.fx.thread("grandchild", parent="middle", root="settled-root")
        self.assertEqual(self.fx.candidates(), ["middle", "grandchild"])

    def test_skips_child_with_active_run(self):
        for status in settle_children.ACTIVE_RUN_STATUSES:
            with self.subTest(status=status):
                thread_id = f"child-{status}"
                self.child(thread_id)
                self.fx.run(f"run-{status}", thread_id, status)
                self.assertNotIn(thread_id, self.fx.candidates())

    def test_lists_child_with_finished_runs(self):
        self.child("child")
        self.fx.run("child-run-1", "child", "completed")
        self.fx.run("child-run-2", "child", "failed")
        self.assertEqual(self.fx.candidates(), ["child"])

    def test_skips_children_of_parent_or_root_with_active_run(self):
        self.child("child")
        self.child("middle", settled=True)
        self.fx.thread("grandchild", parent="middle", root="settled-root")
        self.fx.run("middle-run", "middle", "waiting")
        self.assertEqual(self.fx.candidates(), ["child"])
        self.fx.run("root-run-2", "settled-root", "running")
        self.assertEqual(self.fx.candidates(), [])

    def test_skips_child_with_unfinished_subagent_record(self):
        self.child("child", status="running")
        self.assertEqual(self.fx.candidates(), [])

    def test_skips_child_whose_spawning_run_is_active(self):
        self.fx.thread("child", parent="settled-root")
        self.fx.run("other-root-run", "settled-root", "completed")
        self.fx.run("spawning-run", "spawner", "running")
        self.fx.subagent("child", "settled-root", "spawning-run", "completed")
        self.assertEqual(self.fx.candidates(), [])

    def test_skips_child_with_pending_request(self):
        self.child("child")
        self.fx.request("child", "resolved")
        self.assertEqual(self.fx.candidates(), ["child"])
        self.fx.request("child", "pending")
        self.assertEqual(self.fx.candidates(), [])

    def test_skips_settled_archived_deleted_and_overridden_children(self):
        self.child("settled", settled=True)
        self.child("archived", archived=True)
        self.child("deleted", deleted=True)
        self.child("kept-open", override="active")
        self.assertEqual(self.fx.candidates(), [])

    def test_skips_forks_and_top_level_threads(self):
        self.fx.thread("fork", parent="settled-root", relationship="fork")
        self.assertEqual(self.fx.candidates(), [])

    def test_missing_database_raises(self):
        with self.assertRaises(FileNotFoundError):
            settle_children.find_candidates(Path(self.tmp.name) / "missing.sqlite")

    def test_unexpected_schema_raises(self):
        self.fx.db.execute("drop table orchestration_v2_projection_runtime_requests")
        with self.assertRaises(sqlite3.OperationalError):
            self.fx.candidates()

    def test_opens_database_read_only(self):
        self.child("child")
        self.fx.db.commit()
        before = self.fx.path.read_bytes()
        settle_children.find_candidates(self.fx.path)
        self.assertEqual(self.fx.path.read_bytes(), before)


class MainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fx = Fixture(Path(self.tmp.name) / "state.sqlite")
        self.addCleanup(self.fx.db.close)
        self.fx.thread("root", settled=True)
        self.fx.thread("a", parent="root")
        self.fx.thread("b", parent="root")
        self.fx.db.commit()
        self.log = Path(self.tmp.name) / "logs" / "settle.jsonl"

    def run_main(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = settle_children.main(["--db", str(self.fx.path), *args])
        self.assertEqual(code, 0)
        return out.getvalue().splitlines()

    def test_prints_ids_without_logging_by_default(self):
        self.assertEqual(self.run_main(), ["a", "b"])
        self.assertFalse(self.log.exists())

    def test_appends_one_log_line_per_call(self):
        self.run_main("--log", str(self.log))
        self.fx.db.execute(
            "update orchestration_v2_projection_threads set payload_json ="
            " json_set(payload_json, '$.settledAt', 'now') where thread_id = 'a'"
        )
        self.fx.db.commit()
        self.assertEqual(self.run_main("--log", str(self.log), "--phase", "verify"), ["b"])
        records = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual([r["phase"] for r in records], ["plan", "verify"])
        self.assertEqual([r["count"] for r in records], [2, 1])
        self.assertEqual(records[1]["threadIds"], ["b"])
        self.assertTrue(all(r["at"].endswith("+00:00") for r in records))


class RoutinePromptTest(unittest.TestCase):
    def test_prompt_runs_this_script_with_both_phases_and_a_log(self):
        prompt = (SCRIPT.parent / "settle-children.prompt.md").read_text()
        self.assertIn(f"~/.config/{SCRIPT.parent.name}/{SCRIPT.name}", prompt)
        self.assertIn("--log ~/.local/state/t3-settle-children/settle.jsonl", prompt)
        for phase in ("plan", "verify"):
            self.assertIn(f"--phase {phase}", prompt)
        self.assertIn('action: "settle"', prompt)


if __name__ == "__main__":
    unittest.main()
