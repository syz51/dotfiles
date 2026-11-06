import contextlib
import importlib.util
import io
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "prune_branches.py"
spec = importlib.util.spec_from_file_location("prune_branches", SCRIPT)
prune_branches = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prune_branches)

SCHEMA = """
create table projection_projects (
  project_id text primary key, workspace_root text not null, deleted_at text
);
create table orchestration_v2_projection_threads (
  thread_id text primary key, project_id text not null, payload_json text not null
);
create table orchestration_v2_projection_runs (
  run_id text primary key, thread_id text not null, status text not null
);
create table orchestration_v2_projection_runtime_requests (
  runtime_request_id text primary key, thread_id text not null, status text not null
);
"""


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout.strip()


class Fixture:
    """A repository with a bare origin, and a T3 state database describing its threads."""

    def __init__(self, root: Path):
        self.root = root
        self.db_path = root / "state.sqlite"
        self.db = sqlite3.connect(self.db_path)
        self.db.executescript(SCHEMA)
        self.counter = 0
        self.repo = self.make_repo("repo")

    def make_repo(self, name):
        origin = self.root / f"{name}-origin.git"
        repo = self.root / name
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
        subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
        git(repo, "commit", "-q", "--allow-empty", "-m", "base")
        git(repo, "remote", "add", "origin", str(origin))
        git(repo, "push", "-q", "origin", "main")
        git(repo, "remote", "set-head", "origin", "main")
        return repo

    def branch(self, name, merged=True, repo=None):
        """A branch with one commit of its own, merged into the pushed main or not."""
        repo = repo or self.repo
        git(repo, "branch", name, "main")
        self.counter += 1
        tree = git(repo, "rev-parse", f"{name}^{{tree}}")
        commit = git(repo, "commit-tree", tree, "-p", name, "-m", f"work {self.counter}")
        git(repo, "update-ref", f"refs/heads/{name}", commit)
        if merged:
            merge = git(repo, "commit-tree", tree, "-p", "main", "-p", commit, "-m", f"merge {name}")
            git(repo, "update-ref", "refs/heads/main", merge)
            git(repo, "reset", "-q", "--hard", "main")
            git(repo, "push", "-q", "origin", "main")
        return git(repo, "rev-parse", name)

    def project(self, project_id, root, deleted=False):
        self.db.execute(
            "insert into projection_projects values (?, ?, ?)",
            (project_id, str(root), "2026-01-03T00:00:00Z" if deleted else None),
        )

    def thread(self, project_id, branch, worktree=True, run=None, request=None):
        self.counter += 1
        thread_id = f"thread-{self.counter}"
        payload = {
            "branch": branch,
            "worktreePath": str(self.root / "worktrees" / thread_id) if worktree else None,
        }
        self.db.execute(
            "insert into orchestration_v2_projection_threads values (?, ?, ?)",
            (thread_id, project_id, json.dumps(payload)),
        )
        if run is not None:
            self.db.execute(
                "insert into orchestration_v2_projection_runs values (?, ?, ?)",
                (f"run-{self.counter}", thread_id, run),
            )
        if request is not None:
            self.db.execute(
                "insert into orchestration_v2_projection_runtime_requests values (?, ?, ?)",
                (f"request-{self.counter}", thread_id, request),
            )
        return thread_id

    def prune(self, **kwargs):
        self.db.commit()
        return prune_branches.prune(self.db_path, **kwargs)


def has_branch(repo, name):
    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "-q", "--verify", f"refs/heads/{name}"], capture_output=True
    ).returncode == 0


class PruneTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name).resolve()
        config = root / "gitconfig"
        config.write_text("[user]\n\tname = Test\n\temail = test@example.com\n[advice]\n\tdetachedHead = false\n")
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        # An inherited GIT_DIR or GIT_WORK_TREE, as in a git hook, would aim git at another repository.
        for name in [name for name in os.environ if name.startswith("GIT_")]:
            del os.environ[name]
        os.environ.update({"GIT_CONFIG_GLOBAL": str(config), "GIT_CONFIG_NOSYSTEM": "1"})
        self.fx = Fixture(root)
        self.addCleanup(self.fx.db.close)
        self.fx.project("p", self.fx.repo)

    def test_deletes_a_merged_branch_and_its_configuration(self):
        tip = self.fx.branch("t3/done")
        git(self.fx.repo, "push", "-q", "-u", "origin", "t3/done")
        git(self.fx.repo, "config", "branch.main.description", "kept")
        self.fx.thread("p", "t3/done")
        result = self.fx.prune()
        self.assertEqual(result["deleted"], [{"repository": str(self.fx.repo), "branch": "t3/done", "sha": tip}])
        self.assertFalse(has_branch(self.fx.repo, "t3/done"))
        names = git(self.fx.repo, "config", "--local", "--name-only", "--list").splitlines()
        self.assertFalse([name for name in names if name.startswith("branch.t3/done.")])
        self.assertIn("branch.main.description", names)

    def test_keeps_unmerged_checked_out_and_active_branches(self):
        self.fx.branch("t3/open", merged=False)
        self.fx.branch("t3/in-worktree")
        git(self.fx.repo, "worktree", "add", "-q", str(self.fx.root / "wt"), "t3/in-worktree")
        for name in ("t3/open", "t3/in-worktree"):
            self.fx.thread("p", name)
        for status in prune_branches.ACTIVE_RUN_STATUSES:
            self.fx.branch(f"t3/{status}")
            self.fx.thread("p", f"t3/{status}", run="completed")
            self.fx.thread("p", f"t3/{status}", run=status)
        self.fx.branch("t3/asking")
        self.fx.thread("p", "t3/asking", request="resolved")
        self.fx.thread("p", "t3/asking", request="pending")
        result = self.fx.prune()
        self.assertEqual(result["deleted"], [])
        reasons = {entry["branch"]: entry["reason"] for entry in result["kept"]}
        self.assertEqual(reasons, {
            "t3/open": "not merged",
            "t3/in-worktree": "checked out",
            "t3/asking": "thread is active",
            **{f"t3/{status}": "thread is active" for status in prune_branches.ACTIVE_RUN_STATUSES},
        })
        for name in reasons:
            self.assertTrue(has_branch(self.fx.repo, name))

    def test_keeps_the_default_branch_even_when_nothing_has_it_checked_out(self):
        git(self.fx.repo, "switch", "-q", "--detach")
        self.fx.thread("p", "main")
        result = self.fx.prune()
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [("main", "default branch")])
        self.assertTrue(has_branch(self.fx.repo, "main"))

    def test_ignores_branches_no_worktree_thread_uses(self):
        self.fx.branch("mine")
        self.fx.branch("t3/local-thread")
        self.fx.thread("p", "t3/local-thread", worktree=False)
        self.fx.project("gone", self.fx.repo / "sub", deleted=True)
        self.fx.branch("t3/deleted-project")
        self.fx.thread("gone", "t3/deleted-project")
        self.fx.thread("p", "t3/never-created")
        result = self.fx.prune()
        self.assertEqual((result["deleted"], result["kept"]), ([], []))
        for name in ("mine", "t3/local-thread", "t3/deleted-project"):
            self.assertTrue(has_branch(self.fx.repo, name))

    def test_projects_in_one_repository_are_pruned_once(self):
        (self.fx.repo / "sub").mkdir()
        self.fx.project("sub", self.fx.repo / "sub")
        self.fx.branch("t3/shared")
        self.fx.branch("t3/sub-only")
        self.fx.thread("p", "t3/shared")
        self.fx.thread("sub", "t3/shared", run="running")
        self.fx.thread("sub", "t3/sub-only")
        result = self.fx.prune()
        self.assertEqual([e["branch"] for e in result["deleted"]], ["t3/sub-only"])
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [("t3/shared", "thread is active")])

    def test_skips_missing_folders_plain_folders_and_repositories_without_origin_head(self):
        plain = self.fx.root / "plain"
        plain.mkdir()
        other = self.fx.make_repo("other")
        git(other, "remote", "set-head", "origin", "-d")
        self.fx.branch("t3/other", repo=other)
        for project_id, root in (("missing", self.fx.root / "missing"), ("plain", plain), ("other", other)):
            self.fx.project(project_id, root)
            self.fx.thread(project_id, "t3/other")
        result = self.fx.prune()
        skipped = [(entry["project"], entry["reason"]) for entry in result["skipped"]]
        self.assertEqual(skipped[0], (str(self.fx.root / "missing"), "folder is missing"))
        self.assertEqual(skipped[1][0], str(plain))
        self.assertIn("not a git repository", skipped[1][1])
        self.assertEqual(skipped[2], (str(other), "origin/HEAD is not set"))
        self.assertEqual((len(skipped), result["failed"]), (3, []))
        self.assertTrue(has_branch(other, "t3/other"))

    def test_dry_run_lists_without_deleting(self):
        self.fx.branch("t3/done")
        self.fx.thread("p", "t3/done")
        result = self.fx.prune(dry_run=True)
        self.assertEqual([e["branch"] for e in result["deleted"]], ["t3/done"])
        self.assertTrue(has_branch(self.fx.repo, "t3/done"))

    def test_a_branch_that_moved_since_the_check_stays(self):
        stale = self.fx.branch("t3/moving")
        git(self.fx.repo, "update-ref", "refs/heads/t3/moving", "main")
        self.assertEqual(prune_branches.delete_branch(self.fx.repo, "t3/moving", stale), "moved since check")
        self.assertTrue(has_branch(self.fx.repo, "t3/moving"))

    def test_configuration_of_a_longer_branch_name_stays(self):
        for name in ("t3/fix", "t3/fix.v2", "t3/z"):
            self.fx.branch(name, merged=name != "t3/fix.v2")
            git(self.fx.repo, "config", f"branch.{name}.remote", "origin")
            self.fx.thread("p", name)
        result = self.fx.prune()
        self.assertEqual([e["branch"] for e in result["deleted"]], ["t3/fix", "t3/z"])
        names = git(self.fx.repo, "config", "--local", "--name-only", "--list").splitlines()
        self.assertEqual([n for n in names if n.startswith("branch.t3/")], ["branch.t3/fix.v2.remote"])

    def test_a_branch_a_worktree_is_rebasing_stays(self):
        self.fx.branch("t3/rebasing")
        worktree = self.fx.root / "wt"
        git(self.fx.repo, "worktree", "add", "-q", str(worktree), "t3/rebasing")
        with mock.patch.dict(os.environ, {"GIT_SEQUENCE_EDITOR": "sed -i.bak s/^pick/edit/"}):
            git(worktree, "rebase", "-q", "-i", "HEAD~1")
        self.assertIn("rebase in progress", git(worktree, "status"))
        self.fx.thread("p", "t3/rebasing")
        result = self.fx.prune()
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [("t3/rebasing", "in use by a worktree")])
        self.assertTrue(has_branch(self.fx.repo, "t3/rebasing"))

    def test_a_symbolic_branch_is_deleted_without_its_target(self):
        self.fx.branch("side")
        git(self.fx.repo, "symbolic-ref", "refs/heads/t3/alias", "refs/heads/side")
        self.fx.thread("p", "t3/alias")
        result = self.fx.prune()
        self.assertEqual([e["branch"] for e in result["deleted"]], ["t3/alias"])
        self.assertFalse(has_branch(self.fx.repo, "t3/alias"))
        self.assertTrue(has_branch(self.fx.repo, "side"))

    def test_a_git_error_fails_its_repository_and_is_logged_with_the_others(self):
        other = self.fx.make_repo("other")
        git(other, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone")
        self.fx.branch("t3/other", repo=other)
        self.fx.project("other", other)
        self.fx.thread("other", "t3/other")
        self.fx.branch("t3/done")
        self.fx.thread("p", "t3/done")
        self.fx.db.commit()
        log = self.fx.root / "prune.jsonl"
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(prune_branches.main(["--db", str(self.fx.db_path), "--log", str(log)]), 1)
        self.assertEqual(stdout.getvalue(), f"{self.fx.repo} t3/done\n")
        self.assertIn(f"failed: {other}: merge-base", stderr.getvalue())
        (record,) = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual([e["branch"] for e in record["deleted"]], ["t3/done"])
        self.assertEqual([f["project"] for f in record["failed"]], [str(other)])
        self.assertTrue(has_branch(other, "t3/other"))

    def test_main_prints_deleted_branches_and_logs_the_call(self):
        self.fx.branch("t3/done")
        self.fx.branch("t3/open", merged=False)
        self.fx.thread("p", "t3/done")
        self.fx.thread("p", "t3/open")
        self.fx.db.commit()
        log = self.fx.root / "state" / "prune.jsonl"
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.assertEqual(prune_branches.main(["--db", str(self.fx.db_path), "--log", str(log)]), 0)
        self.assertEqual(stdout.getvalue(), f"{self.fx.repo} t3/done\n")
        (record,) = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual([e["branch"] for e in record["deleted"]], ["t3/done"])
        self.assertEqual([e["branch"] for e in record["kept"]], ["t3/open"])
        self.assertFalse(record["dryRun"])
        self.assertIn("at", record)

    def test_missing_database_raises(self):
        with self.assertRaises(FileNotFoundError):
            prune_branches.prune(self.fx.root / "missing.sqlite")

    def test_opens_database_read_only(self):
        self.fx.branch("t3/done")
        self.fx.thread("p", "t3/done")
        self.fx.db.commit()
        before = self.fx.db_path.read_bytes()
        self.fx.prune()
        self.assertEqual(self.fx.db_path.read_bytes(), before)


class RoutinePromptTest(unittest.TestCase):
    def test_prompt_prunes_with_this_script_and_a_log_after_verifying(self):
        prompt = (SCRIPT.parent / "settle-children.prompt.md").read_text()
        command = f"~/.config/{SCRIPT.parent.name}/{SCRIPT.name}"
        self.assertIn(command, prompt)
        self.assertIn("--log ~/.local/state/t3-settle-children/prune.jsonl", prompt)
        self.assertNotIn("--dry-run", prompt)
        self.assertLess(prompt.index("--phase verify"), prompt.index(command))


if __name__ == "__main__":
    unittest.main()
