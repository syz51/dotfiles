import contextlib
import importlib.util
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
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
  thread_id text primary key, project_id text not null, payload_json text not null,
  archived_at text, deleted_at text
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

    def thread(self, project_id, branch, worktree=True, run=None, request=None, archived=False, deleted=False):
        self.counter += 1
        thread_id = f"thread-{self.counter}"
        payload = {
            "branch": branch,
            "worktreePath": (str(worktree) if isinstance(worktree, Path) else str(self.root / "worktrees" / thread_id))
            if worktree else None,
        }
        self.db.execute(
            "insert into orchestration_v2_projection_threads values (?, ?, ?, ?, ?)",
            (thread_id, project_id, json.dumps(payload),
             "2026-01-04T00:00:00Z" if archived else None, "2026-01-05T00:00:00Z" if deleted else None),
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


# A fake gh answers the prune script's GraphQL query: merged pull requests from one
# JSON file per head branch in FAKE_GH_DIR, and live branches from FAKE_GH_ORIGIN.
FAKE_GH = r"""
import json, os, re, subprocess, sys, time
from pathlib import Path

args = sys.argv[1:]
log_path = Path(os.environ["FAKE_GH_LOG"])
earlier = len(log_path.read_text().splitlines()) if log_path.exists() else 0
with log_path.open("a") as log:
    log.write(json.dumps(args) + "\n")
if os.environ.get("FAKE_GH_FAIL") or earlier >= int(os.environ.get("FAKE_GH_FAIL_FROM", "1000")):
    sys.exit(print("gh: Bad credentials (HTTP 401)", file=sys.stderr) or 1)
time.sleep(float(os.environ.get("FAKE_GH_SLEEP", "0")))
if os.environ.get("FAKE_GH_GARBLE"):
    sys.exit(print("<html>") or 0)
assert args[:4] == ["api", "graphql", "--hostname", "github.com"], args
assert args[4::2] == ["-f"] * len(args[4::2]), args
fields = dict(arg.split("=", 1) for arg in args[5::2])
query = fields["query"]
# Like GitHub, refuse a declared variable the query does not use, or one not passed.
declared = re.findall(r"\$(\w+): String!", query)
unused = [v for v in declared if query.count(f"${v}") < 2 or v not in fields]
if unused or sorted(declared) != sorted(k for k in fields if k != "query"):
    sys.exit(print(f"gh: Variable ${unused} is declared but not used", file=sys.stderr) or 1)
repository = {}
for key, value in fields.items():
    index = key[1:]
    if key[0] == "h" and index.isdigit() and f"p{index}: pullRequests(headRefName: ${key}," in query:
        found = Path(os.environ["FAKE_GH_DIR"], value.replace("/", "_") + ".json")
        repository[f"p{index}"] = {"nodes": json.loads(found.read_text()) if found.exists() else []}
    if key[0] == "r" and index.isdigit() and f"{key}: ref(qualifiedName: ${key})" in query:
        found = subprocess.run(["git", "-C", os.environ["FAKE_GH_ORIGIN"], "rev-parse", "-q", "--verify", value],
                               capture_output=True, text=True)
        name = value.removeprefix("refs/heads/") + ("-2" if os.environ.get("FAKE_GH_SHAPE") == "other-ref" else "")
        repository[key] = ({"prefix": "refs/heads/", "name": name, "target": {"oid": found.stdout.strip()}}
                           if found.returncode == 0 else None)
shape = os.environ.get("FAKE_GH_SHAPE")
print(json.dumps({"data": {"repository": None if shape == "no-repository" else {} if shape == "empty" else repository}}))
"""

# A fake ssh resolves the host aliases of `ssh -G` from FAKE_SSH_HOSTS, `alias=host` words.
FAKE_SSH = """#!/bin/sh
[ "$1" = -G ] || exit 255
for pair in $FAKE_SSH_HOSTS; do
  if [ "${pair%%=*}" = "$2" ]; then echo "user git"; echo "hostname ${pair#*=}"; exit 0; fi
done
echo "hostname $2"
"""


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
        # A fake gh answers pull request lookups from one JSON file per head branch.
        bin_dir = root / "bin"
        bin_dir.mkdir()
        (root / "fake_gh.py").write_text(FAKE_GH)
        # The fake runs on this test's own interpreter.
        gh = f'#!/bin/sh\nexec "{sys.executable}" -B "{root / "fake_gh.py"}" "$@"\n'
        for name, script in (("gh", gh), ("ssh", FAKE_SSH)):
            (bin_dir / name).write_text(script)
            (bin_dir / name).chmod(0o755)
        self.pulls = root / "pulls"
        self.pulls.mkdir()
        self.gh_log = root / "gh.log"
        os.environ.update({
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "FAKE_GH_DIR": str(self.pulls),
            "FAKE_GH_LOG": str(self.gh_log),
            "FAKE_GH_ORIGIN": git(self.fx.repo, "remote", "get-url", "origin"),
        })

    def on_github(self):
        """Point origin's fetch URL at GitHub while pushes still reach the local origin."""
        origin = git(self.fx.repo, "remote", "get-url", "origin")
        git(self.fx.repo, "config", "remote.origin.pushurl", origin)
        git(self.fx.repo, "config", "remote.origin.url", "git@github.com:acme/repo.git")

    def pull(self, branch, *pulls):
        (self.pulls / f"{branch.replace('/', '_')}.json").write_text(json.dumps(list(pulls)))

    def gh_calls(self):
        return [json.loads(line) for line in self.gh_log.read_text().splitlines()] if self.gh_log.exists() else []

    def gh_queries(self):
        """Each GitHub query's variables, without the query text."""
        return [{k: v for k, v in (arg.split("=", 1) for arg in call[5::2]) if k != "query"} for call in self.gh_calls()]

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
            "t3/open": "not merged or pushed",
            "t3/in-worktree": "checked out",
            "t3/asking": "thread is active",
            **{f"t3/{status}": "thread is active" for status in prune_branches.ACTIVE_RUN_STATUSES},
        })
        for name in reasons:
            self.assertTrue(has_branch(self.fx.repo, name))

    def test_keeps_a_branch_whose_thread_still_has_its_worktree_folder(self):
        self.fx.branch("t3/detached")
        worktree = self.fx.root / "wt"
        git(self.fx.repo, "worktree", "add", "-q", "--detach", str(worktree), "t3/detached")
        self.fx.thread("p", "t3/detached", worktree=worktree)
        self.fx.thread("p", "t3/detached")
        result = self.fx.prune()
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [("t3/detached", "worktree still exists")])
        self.assertTrue(has_branch(self.fx.repo, "t3/detached"))

    def test_a_worktree_folder_another_branch_now_uses_does_not_hold_the_branch(self):
        self.fx.branch("t3/old")
        self.fx.branch("t3/new", merged=False)
        worktree = self.fx.root / "wt"
        git(self.fx.repo, "worktree", "add", "-q", str(worktree), "t3/new")
        self.fx.thread("p", "t3/old", worktree=worktree)
        self.fx.thread("p", "t3/new", worktree=worktree)
        result = self.fx.prune()
        self.assertEqual([e["branch"] for e in result["deleted"]], ["t3/old"])
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [("t3/new", "checked out")])

    def test_a_subfolder_project_thread_with_its_worktree_folder_holds_the_branch(self):
        (self.fx.repo / "sub").mkdir()
        self.fx.project("sub", self.fx.repo / "sub")
        self.fx.branch("t3/shared")
        stray = self.fx.root / "stray"
        stray.mkdir()
        self.fx.thread("p", "t3/shared")
        self.fx.thread("sub", "t3/shared", worktree=stray)
        result = self.fx.prune()
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [("t3/shared", "worktree still exists")])

    def test_an_unreadable_worktree_folder_fails_only_its_repository(self):
        locked = self.fx.root / "locked"
        (locked / "wt").mkdir(parents=True)
        locked.chmod(0)
        self.addCleanup(locked.chmod, 0o755)
        self.fx.branch("t3/locked")
        self.fx.thread("p", "t3/locked", worktree=locked / "wt")
        other = self.fx.make_repo("other")
        self.fx.branch("t3/other", repo=other)
        self.fx.project("other", other)
        self.fx.thread("other", "t3/other")
        result = self.fx.prune()
        self.assertEqual([f["project"] for f in result["failed"]], [str(self.fx.repo)])
        self.assertIn("Permission denied", result["failed"][0]["error"])
        self.assertEqual([e["branch"] for e in result["deleted"]], ["t3/other"])
        self.assertTrue(has_branch(self.fx.repo, "t3/locked"))

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
        self.assertIn(f"failed: {other}: git: fatal: Not a valid object name refs/remotes/origin/gone", stderr.getvalue())
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

    def test_a_squash_merged_branch_is_deleted_when_the_pull_request_head_is_its_tip(self):
        self.on_github()
        tip = self.fx.branch("t3/squashed", merged=False)
        self.fx.branch("t3/merged")
        self.pull("t3/squashed", {"number": 6, "headRefOid": "0" * 40}, {"number": 7, "headRefOid": tip})
        self.fx.thread("p", "t3/squashed")
        self.fx.thread("p", "t3/merged")
        result = self.fx.prune()
        self.assertEqual(
            [(e["branch"], e.get("pullRequest")) for e in result["deleted"]],
            [("t3/merged", None), ("t3/squashed", 7)],
        )
        self.assertFalse(has_branch(self.fx.repo, "t3/squashed"))
        # Only the branch ancestry did not cover is looked up, in origin's repository.
        self.assertEqual(self.gh_queries(), [{"owner": "acme", "name": "repo", "base": "main", "h0": "t3/squashed"}])

    def test_a_branch_with_commits_after_its_merged_pull_request_stays(self):
        self.on_github()
        self.fx.branch("t3/continued", merged=False)
        self.pull("t3/continued", {"number": 7, "headRefOid": "0" * 40})
        self.fx.thread("p", "t3/continued")
        result = self.fx.prune()
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [("t3/continued", "not merged or pushed")])
        self.assertTrue(has_branch(self.fx.repo, "t3/continued"))

    def test_a_failed_lookup_is_reported_once_for_its_repository(self):
        self.on_github()
        self.fx.branch("t3/unknown", merged=False)
        self.fx.branch("t3/unknown-2", merged=False)
        self.fx.branch("t3/merged")
        self.fx.thread("p", "t3/unknown")
        self.fx.thread("p", "t3/unknown-2")
        self.fx.thread("p", "t3/merged")
        self.fx.db.commit()
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {"FAKE_GH_FAIL": "1"}), contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(stderr):
            self.assertEqual(prune_branches.main(["--db", str(self.fx.db_path)]), 1)
        self.assertEqual(
            stderr.getvalue(),
            f"failed: {self.fx.repo}: gh api graphql: gh: Bad credentials (HTTP 401)\n",
        )
        self.assertFalse(has_branch(self.fx.repo, "t3/merged"))
        self.assertTrue(has_branch(self.fx.repo, "t3/unknown"))
        self.assertTrue(has_branch(self.fx.repo, "t3/unknown-2"))
        self.assertEqual(len(self.gh_calls()), 1)

    def lookup_failure(self, **env):
        self.on_github()
        self.fx.branch("t3/a", merged=False)
        self.fx.branch("t3/b", merged=False)
        self.fx.thread("p", "t3/a")
        self.fx.thread("p", "t3/b")
        with mock.patch.dict(os.environ, env):
            result = self.fx.prune()
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [
            ("t3/a", "remote lookup unavailable"),
            ("t3/b", "remote lookup unavailable"),
        ])
        (failure,) = result["failed"]
        self.assertEqual(set(failure), {"project", "error"})
        return failure["error"]

    def test_a_missing_gh_is_named_in_the_failure(self):
        only_git = self.fx.root / "only-git"
        only_git.mkdir()
        (only_git / "git").symlink_to(shutil.which("git"))
        error = self.lookup_failure(PATH=str(only_git))
        self.assertEqual(error, "gh api graphql: [Errno 2] No such file or directory: 'gh'")

    def test_a_lookup_that_hangs_times_out(self):
        with mock.patch.object(prune_branches, "LOOKUP_TIMEOUT_SECONDS", 0.5):
            error = self.lookup_failure(FAKE_GH_SLEEP="5")
        self.assertEqual(error, "gh api graphql: timed out after 0.5s")

    def test_unreadable_lookup_output_fails_the_lookup(self):
        self.assertIn("gh api graphql: Expecting value", self.lookup_failure(FAKE_GH_GARBLE="1"))

    def test_a_pull_request_whose_head_moved_past_the_tip_counts(self):
        self.on_github()
        tip = self.fx.branch("t3/updated", merged=False)
        tree = git(self.fx.repo, "rev-parse", "t3/updated^{tree}")
        later = git(self.fx.repo, "commit-tree", tree, "-p", tip, "-m", "update branch")
        stranger = git(self.fx.repo, "commit-tree", tree, "-p", "main", "-m", "unrelated")
        self.pull("t3/updated", {"number": 5, "headRefOid": stranger}, {"number": 8, "headRefOid": later},
                  {"number": 9, "headRefOid": "f" * 40})
        self.fx.thread("p", "t3/updated")
        result = self.fx.prune()
        self.assertEqual([(e["branch"], e["pullRequest"]) for e in result["deleted"]], [("t3/updated", 8)])

    def test_dry_run_reports_pull_request_merges_without_deleting(self):
        self.on_github()
        tip = self.fx.branch("t3/squashed", merged=False)
        self.pull("t3/squashed", {"number": 7, "headRefOid": tip})
        self.fx.thread("p", "t3/squashed")
        result = self.fx.prune(dry_run=True)
        self.assertEqual(result["deleted"], [
            {"repository": str(self.fx.repo), "branch": "t3/squashed", "sha": tip, "pullRequest": 7},
        ])
        self.assertTrue(has_branch(self.fx.repo, "t3/squashed"))

    def test_conditions_are_checked_again_after_lookups(self):
        self.on_github()
        tip = self.fx.branch("t3/resumed", merged=False)
        self.fx.thread("p", "t3/resumed")

        def resume_during_lookup(*args):
            self.fx.thread("p", "t3/resumed", run="running")
            self.fx.db.commit()
            return {"t3/resumed": [(7, tip)]}, {}

        with mock.patch.object(prune_branches, "github_lookup", side_effect=resume_during_lookup):
            result = self.fx.prune()
        self.assertEqual(result["kept"], [
            {"repository": str(self.fx.repo), "branch": "t3/resumed", "sha": tip, "pullRequest": 7, "reason": "thread is active"},
        ])
        self.assertTrue(has_branch(self.fx.repo, "t3/resumed"))

    def test_insteadof_origins_are_recognised(self):
        git(self.fx.repo, "config", "url.git@github.com:.insteadOf", "gh:")
        git(self.fx.repo, "config", "remote.origin.url", "gh:acme/repo")
        self.assertEqual(prune_branches.github_repository(self.fx.repo), "acme/repo")

    def test_origins_off_github_are_not_looked_up(self):
        self.fx.branch("t3/open", merged=False)
        self.fx.thread("p", "t3/open")
        self.assertEqual([e["reason"] for e in self.fx.prune()["kept"]], ["not merged or pushed"])
        self.assertEqual(self.gh_calls(), [])

    def test_github_repository_reads_origin_urls(self):
        for url, expected in (
            ("https://github.com/acme/repo.git", "acme/repo"),
            ("https://github.com/acme/repo", "acme/repo"),
            ("git@github.com:acme/repo.git", "acme/repo"),
            ("ssh://git@github.com/acme/re.po.git", "acme/re.po"),
            ("https://user@github.com:443/acme/repo", "acme/repo"),
            ("https://gitlab.com/acme/repo.git", None),
            ("https://github.com/acme/repo/extra", None),
            ("git@github-work:acme/repo.git", "acme/repo"),
            ("github-work:acme/repo", "acme/repo"),
            ("ssh://git@github-work:2222/acme/repo.git", "acme/repo"),
            ("git+ssh://GitHub-Work/acme/repo", "acme/repo"),
            ("git@github-443:acme/repo.git", "acme/repo"),
            ("git@gitlab-work:acme/repo.git", None),
            ("-oProxyCommand=x:acme/repo", None),
            ("git@example.com:acme/repo.git", None),
            ("https://github-work/acme/repo.git", None),
            ("/srv/git/acme/repo.git", None),
            ("file:///srv/acme/repo.git", None),
        ):
            with self.subTest(url=url), mock.patch.dict(os.environ, {
                "FAKE_SSH_HOSTS": "github-work=github.com GitHub-Work=GitHub.com github-443=ssh.github.com gitlab-work=gitlab.com",
            }):
                git(self.fx.repo, "config", "remote.origin.url", url)
                self.assertEqual(prune_branches.github_repository(self.fx.repo), expected)

    def test_an_ssh_alias_resolves_through_the_ssh_command_git_uses(self):
        git(self.fx.repo, "config", "remote.origin.url", "git@github-work:acme/repo.git")
        self.assertIsNone(prune_branches.github_repository(self.fx.repo))
        work_ssh = self.fx.root / "bin" / "work-ssh"
        work_ssh.write_text('#!/bin/sh\n[ "$1 $2 $3 $4" = "-F work.conf -G github-work" ] && echo "hostname github.com"\n')
        work_ssh.chmod(0o755)
        git(self.fx.repo, "config", "core.sshCommand", "work-ssh -F work.conf")
        self.assertEqual(prune_branches.github_repository(self.fx.repo), "acme/repo")
        git(self.fx.repo, "config", "--unset", "core.sshCommand")
        with mock.patch.dict(os.environ, {"GIT_SSH_COMMAND": "work-ssh -F work.conf"}):
            self.assertEqual(prune_branches.github_repository(self.fx.repo), "acme/repo")

    def test_an_ssh_alias_without_a_usable_ssh_fails_its_lookups(self):
        git(self.fx.repo, "config", "remote.origin.url", "git@github-work:acme/repo.git")
        only_git = self.fx.root / "only-git"
        only_git.mkdir()
        (only_git / "git").symlink_to(shutil.which("git"))
        with mock.patch.dict(os.environ, {"PATH": str(only_git)}), self.assertRaises(FileNotFoundError):
            prune_branches.github_repository(self.fx.repo)
        (self.fx.root / "bin" / "ssh").write_text("#!/bin/sh\necho 'hostname github.com'\nexit 255\n")
        self.fx.branch("t3/open", merged=False)
        self.fx.thread("p", "t3/open")
        tip = self.fx.branch("t3/abandoned", merged=False)
        self.fx.thread("p", "t3/abandoned", archived=True)
        result = self.fx.prune()
        self.assertEqual(result["failed"], [{"project": str(self.fx.repo), "error": "ssh -G: hostname github.com"}])
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [("t3/open", "remote lookup unavailable")])
        self.assertEqual([e["archivedAs"] for e in result["deleted"]], [f"refs/t3-archive/t3/abandoned@{tip[:12]}"])
        self.assertEqual(self.gh_calls(), [])

    def test_a_github_alias_origin_gets_pull_request_lookups(self):
        self.on_github()
        git(self.fx.repo, "config", "remote.origin.url", "git@github-work:acme/repo.git")
        tip = self.fx.branch("t3/squashed", merged=False)
        self.pull("t3/squashed", {"number": 7, "headRefOid": tip})
        self.fx.thread("p", "t3/squashed")
        with mock.patch.dict(os.environ, {"FAKE_SSH_HOSTS": "github-work=github.com"}):
            result = self.fx.prune()
        self.assertEqual([(e["branch"], e["pullRequest"]) for e in result["deleted"]], [("t3/squashed", 7)])

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

    def test_a_pushed_branch_is_deleted_when_origin_holds_its_tip(self):
        tip = self.fx.branch("t3/pushed", merged=False)
        git(self.fx.repo, "push", "-q", "-u", "origin", "t3/pushed")
        self.fx.thread("p", "t3/pushed")
        result = self.fx.prune()
        archive = f"refs/t3-archive/t3/pushed@{tip[:12]}"
        self.assertEqual(result["deleted"], [{
            "repository": str(self.fx.repo), "branch": "t3/pushed", "sha": tip,
            "pushedTo": "origin/t3/pushed", "archivedAs": archive,
        }])
        self.assertFalse(has_branch(self.fx.repo, "t3/pushed"))
        self.assertEqual(git(self.fx.repo, "rev-parse", "origin/t3/pushed"), tip)
        # The archive keeps the work even once origin's branch is deleted and pruned.
        git(self.fx.repo, "push", "-q", "origin", "--delete", "t3/pushed")
        self.assertEqual(git(self.fx.repo, "rev-parse", archive), tip)

    def test_a_pushed_branch_on_github_is_checked_live(self):
        self.on_github()
        self.fx.branch("t3/pushed", merged=False)
        self.fx.branch("t3/gone", merged=False)
        for name in ("t3/pushed", "t3/gone"):
            git(self.fx.repo, "push", "-q", "origin", name)
            self.fx.thread("p", name)
        self.fx.branch("t3/local", merged=False)
        self.fx.thread("p", "t3/local")
        # GitHub deleted t3/gone after the last fetch, so only t3/pushed is still there.
        git(self.fx.repo, "push", "-q", "origin", "--delete", "t3/gone")
        git(self.fx.repo, "update-ref", "refs/remotes/origin/t3/gone", "t3/gone")
        result = self.fx.prune()
        self.assertEqual([(e["branch"], e["pushedTo"]) for e in result["deleted"]], [("t3/pushed", "origin/t3/pushed")])
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]],
                         [("t3/gone", "not merged or pushed"), ("t3/local", "not merged or pushed")])
        self.assertEqual(result["failed"], [])
        # One query covers every branch: pull requests for all, live branches only for
        # those the last fetch saw holding the tip.
        self.assertEqual(self.gh_queries(), [{
            "owner": "acme", "name": "repo", "base": "main",
            "h0": "t3/gone", "r0": "refs/heads/t3/gone", "h1": "t3/local",
            "h2": "t3/pushed", "r2": "refs/heads/t3/pushed",
        }])

    def test_a_pushed_branch_with_later_local_commits_stays(self):
        self.fx.branch("t3/ahead", merged=False)
        git(self.fx.repo, "push", "-q", "origin", "t3/ahead")
        tree = git(self.fx.repo, "rev-parse", "t3/ahead^{tree}")
        later = git(self.fx.repo, "commit-tree", tree, "-p", "t3/ahead", "-m", "local only")
        git(self.fx.repo, "update-ref", "refs/heads/t3/ahead", later)
        self.fx.thread("p", "t3/ahead")
        result = self.fx.prune()
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [("t3/ahead", "not merged or pushed")])
        self.assertTrue(has_branch(self.fx.repo, "t3/ahead"))

    def test_a_branch_origin_deleted_or_moved_since_the_last_fetch_stays(self):
        origin = git(self.fx.repo, "remote", "get-url", "origin")
        for name in ("t3/deleted", "t3/moved"):
            self.fx.branch(name, merged=False)
            git(self.fx.repo, "push", "-q", "origin", name)
            self.fx.thread("p", name)
        git(origin, "update-ref", "-d", "refs/heads/t3/deleted")
        git(origin, "update-ref", "refs/heads/t3/moved", "main")
        result = self.fx.prune()
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [
            ("t3/deleted", "not merged or pushed"), ("t3/moved", "not merged or pushed"),
        ])
        self.assertEqual(result["failed"], [])

    def test_a_failed_ls_remote_stops_lookups_only_in_its_repository(self):
        self.fx.branch("t3/a", merged=False)
        self.fx.branch("t3/b", merged=False)
        for name in ("t3/a", "t3/b"):
            git(self.fx.repo, "push", "-q", "origin", name)
            self.fx.thread("p", name)
        self.fx.branch("t3/new", merged=False)
        self.fx.thread("p", "t3/new")
        git(self.fx.repo, "config", "remote.origin.url", str(self.fx.root / "missing.git"))
        other = self.fx.make_repo("other")
        self.fx.branch("t3/other", merged=False, repo=other)
        git(other, "push", "-q", "origin", "t3/other")
        self.fx.project("other", other)
        self.fx.thread("other", "t3/other")
        result = self.fx.prune()
        (failure,) = result["failed"]
        self.assertEqual(failure["project"], str(self.fx.repo))
        self.assertTrue(failure["error"].startswith("git ls-remote: "), failure["error"])
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [
            ("t3/a", "remote lookup unavailable"), ("t3/b", "remote lookup unavailable"),
            ("t3/new", "not merged or pushed"),
        ])
        self.assertEqual([e["branch"] for e in result["deleted"]], ["t3/other"])

    def test_an_abandoned_unpushed_branch_is_archived_then_deleted(self):
        tip = self.fx.branch("t3/abandoned", merged=False)
        self.fx.branch("t3/deleted-thread", merged=False)
        self.fx.thread("p", "t3/abandoned", archived=True)
        self.fx.thread("p", "t3/abandoned", deleted=True)
        self.fx.thread("p", "t3/deleted-thread", deleted=True)
        self.fx.db.commit()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.assertEqual(prune_branches.main(["--db", str(self.fx.db_path)]), 0)
        archive = f"refs/t3-archive/t3/abandoned@{tip[:12]}"
        self.assertIn(f"{self.fx.repo} t3/abandoned archived as {archive}\n", stdout.getvalue())
        self.assertFalse(has_branch(self.fx.repo, "t3/abandoned"))
        self.assertFalse(has_branch(self.fx.repo, "t3/deleted-thread"))
        self.assertEqual(git(self.fx.repo, "rev-parse", archive), tip)
        self.assertNotIn("t3-archive", git(self.fx.repo, "branch", "--all"))
        git(self.fx.repo, "branch", "t3/abandoned", archive)
        self.assertEqual(git(self.fx.repo, "rev-parse", "t3/abandoned"), tip)

    def test_a_branch_some_live_thread_still_uses_is_not_archived(self):
        self.fx.branch("t3/shared", merged=False)
        (self.fx.repo / "sub").mkdir()
        self.fx.project("sub", self.fx.repo / "sub")
        self.fx.thread("p", "t3/shared", archived=True)
        self.fx.thread("sub", "t3/shared")
        result = self.fx.prune()
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [("t3/shared", "not merged or pushed")])
        self.assertEqual(git(self.fx.repo, "for-each-ref", "refs/t3-archive/"), "")

    def test_an_abandoned_branch_is_archived_even_when_lookups_fail(self):
        self.on_github()
        tip = self.fx.branch("t3/abandoned", merged=False)
        self.fx.thread("p", "t3/abandoned", archived=True)
        with mock.patch.dict(os.environ, {"FAKE_GH_FAIL": "1"}):
            result = self.fx.prune()
        self.assertEqual([e["archivedAs"] for e in result["deleted"]], [f"refs/t3-archive/t3/abandoned@{tip[:12]}"])
        self.assertEqual(len(result["failed"]), 1)

    def test_dry_run_names_the_archive_without_creating_it(self):
        tip = self.fx.branch("t3/abandoned", merged=False)
        self.fx.thread("p", "t3/abandoned", archived=True)
        result = self.fx.prune(dry_run=True)
        self.assertEqual(result["deleted"], [{
            "repository": str(self.fx.repo), "branch": "t3/abandoned", "sha": tip,
            "abandoned": True, "archivedAs": f"refs/t3-archive/t3/abandoned@{tip[:12]}",
        }])
        self.fx.db.commit()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            prune_branches.main(["--db", str(self.fx.db_path), "--dry-run"])
        self.assertEqual(stdout.getvalue(),
                         f"{self.fx.repo} t3/abandoned to be archived as refs/t3-archive/t3/abandoned@{tip[:12]}\n")
        self.assertTrue(has_branch(self.fx.repo, "t3/abandoned"))
        self.assertEqual(git(self.fx.repo, "for-each-ref", "refs/t3-archive/"), "")

    def test_a_thread_restored_during_lookups_keeps_its_branch_unarchived(self):
        self.on_github()
        tip = self.fx.branch("t3/restored", merged=False)
        thread_id = self.fx.thread("p", "t3/restored", archived=True)

        def restore_during_lookup(*args):
            self.fx.db.execute("update orchestration_v2_projection_threads set archived_at = null where thread_id = ?",
                               (thread_id,))
            self.fx.db.commit()
            return {}, {}

        with mock.patch.object(prune_branches, "github_lookup", side_effect=restore_during_lookup):
            result = self.fx.prune()
        self.assertEqual(result["kept"], [
            {"repository": str(self.fx.repo), "branch": "t3/restored", "sha": tip, "reason": "thread was restored"},
        ])
        self.assertTrue(has_branch(self.fx.repo, "t3/restored"))
        self.assertEqual(git(self.fx.repo, "for-each-ref", "refs/t3-archive/"), "")

    def test_a_refused_deletion_removes_the_archive_it_created(self):
        tip = self.fx.branch("t3/busy", merged=False)
        git(self.fx.repo, "worktree", "add", "-q", str(self.fx.root / "wt"), "t3/busy")
        archive = f"refs/t3-archive/t3/busy@{tip[:12]}"
        self.assertEqual(prune_branches.delete_branch(self.fx.repo, "t3/busy", tip, archive), "in use by a worktree")
        self.assertEqual(git(self.fx.repo, "for-each-ref", "refs/t3-archive/"), "")
        # An archive an earlier call made stays, and is reused.
        git(self.fx.repo, "update-ref", archive, tip)
        self.assertEqual(prune_branches.delete_branch(self.fx.repo, "t3/busy", tip, archive), "in use by a worktree")
        self.assertEqual(git(self.fx.repo, "rev-parse", archive), tip)
        git(self.fx.repo, "worktree", "remove", str(self.fx.root / "wt"))
        self.assertIsNone(prune_branches.delete_branch(self.fx.repo, "t3/busy", tip, archive))
        self.assertFalse(has_branch(self.fx.repo, "t3/busy"))

    def test_a_live_thread_without_a_worktree_keeps_an_archived_threads_branch(self):
        self.fx.branch("t3/shared", merged=False)
        self.fx.thread("p", "t3/shared", archived=True)
        self.fx.thread("p", "t3/shared", worktree=False)
        result = self.fx.prune()
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [("t3/shared", "not merged or pushed")])
        self.assertTrue(has_branch(self.fx.repo, "t3/shared"))

    def test_a_branch_gone_from_fresh_state_stays(self):
        self.on_github()
        self.fx.branch("t3/gone", merged=False)
        self.fx.thread("p", "t3/gone", archived=True)

        def delete_project_during_lookup(*args):
            self.fx.db.execute("update projection_projects set deleted_at = 'now'")
            self.fx.db.commit()
            return {}, {}

        with mock.patch.object(prune_branches, "github_lookup", side_effect=delete_project_during_lookup):
            result = self.fx.prune()
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]],
                         [("t3/gone", "no longer used by a worktree thread")])
        self.assertTrue(has_branch(self.fx.repo, "t3/gone"))
        self.assertEqual(git(self.fx.repo, "for-each-ref", "refs/t3-archive/"), "")

    def pushed_on_github(self, name):
        self.on_github()
        self.fx.branch(name, merged=False)
        git(self.fx.repo, "push", "-q", "origin", name)
        self.fx.thread("p", name)

    def test_unexpected_github_answers_fail_the_lookup_without_crashing(self):
        self.pushed_on_github("t3/pushed")
        for shape, error in (("empty", "gh api graphql: 'p0'"),
                             ("no-repository", "gh api graphql: GitHub has no repository acme/repo")):
            with self.subTest(shape=shape), mock.patch.dict(os.environ, {"FAKE_GH_SHAPE": shape}):
                result = self.fx.prune()
                self.assertEqual([f["error"] for f in result["failed"]], [error])
                self.assertEqual([e["reason"] for e in result["kept"]], ["remote lookup unavailable"])
        self.pull("t3/pushed", {"number": 7})
        self.assertEqual([f["error"] for f in self.fx.prune()["failed"]], ["gh api graphql: 'headRefOid'"])

    def test_github_lookups_are_batched(self):
        self.on_github()
        tips = {}
        for name in ("t3/a", "t3/b", "t3/c"):
            tips[name] = self.fx.branch(name, merged=False)
            self.fx.thread("p", name)
        self.pull("t3/c", {"number": 9, "headRefOid": tips["t3/c"]})
        with mock.patch.object(prune_branches, "GITHUB_BATCH", 2):
            result = self.fx.prune()
        self.assertEqual([[v for k, v in q.items() if k.startswith("h")] for q in self.gh_queries()],
                         [["t3/a", "t3/b"], ["t3/c"]])
        self.assertEqual([(e["branch"], e["pullRequest"]) for e in result["deleted"]], [("t3/c", 9)])

    def test_one_ls_remote_checks_every_pushed_branch_of_a_repository(self):
        names = ("t3/a", "t3/b", "t3/c")
        for name in names:
            self.fx.branch(name, merged=False)
            git(self.fx.repo, "push", "-q", "origin", name)
            self.fx.thread("p", name)
        # A longer branch whose name ends like a checked one does not count for it.
        git(self.fx.repo, "push", "-q", "origin", "--delete", "t3/c")
        git(self.fx.repo, "update-ref", "refs/remotes/origin/t3/c", "t3/c")
        git(self.fx.repo, "push", "-q", "origin", "t3/c:refs/heads/x/refs/heads/t3/c")
        self.fx.branch("t3/unpushed", merged=False)
        self.fx.thread("p", "t3/unpushed")
        with mock.patch.object(prune_branches, "git", wraps=prune_branches.git) as spy:
            result = self.fx.prune()
        calls = [call.args[1:] for call in spy.call_args_list if call.args[1] == "ls-remote"]
        self.assertEqual(calls, [("ls-remote", "--heads", "origin", "refs/heads/t3/a", "refs/heads/t3/b", "refs/heads/t3/c")])
        self.assertEqual([e["branch"] for e in result["deleted"]], ["t3/a", "t3/b"])
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]],
                         [("t3/c", "not merged or pushed"), ("t3/unpushed", "not merged or pushed")])

    def test_no_remote_call_without_branches_to_check(self):
        self.fx.branch("t3/unpushed", merged=False)
        self.fx.thread("p", "t3/unpushed")
        self.fx.branch("t3/merged")
        self.fx.thread("p", "t3/merged")
        with mock.patch.object(prune_branches, "git", wraps=prune_branches.git) as spy:
            self.fx.prune()
        self.assertNotIn("ls-remote", [call.args[1] for call in spy.call_args_list])
        # On GitHub an unpushed branch may still be squash-merged, so it is looked up,
        # but a repository whose branches are all merged by ancestry makes no call.
        self.on_github()
        self.fx.prune()
        self.assertEqual(len(self.gh_calls()), 1)
        git(self.fx.repo, "branch", "-D", "t3/unpushed")
        self.fx.branch("t3/merged-2")
        self.fx.thread("p", "t3/merged-2")
        self.fx.prune()
        self.assertEqual(len(self.gh_calls()), 1)

    def test_a_local_git_error_fails_the_repository_not_its_lookups(self):
        self.fx.branch("t3/pushed", merged=False)
        git(self.fx.repo, "push", "-q", "origin", "t3/pushed")
        self.fx.thread("p", "t3/pushed")
        error = subprocess.CalledProcessError(128, ["git"], "", "fatal: bad object")
        with mock.patch.object(prune_branches, "contains", side_effect=error):
            result = self.fx.prune()
        self.assertEqual(result["failed"], [{"project": str(self.fx.repo), "error": "git: fatal: bad object"}])

    def test_the_github_query_asks_for_the_newest_pull_requests_and_exact_branches(self):
        self.pushed_on_github("t3/pushed")
        self.fx.prune()
        (call,) = self.gh_calls()
        query = dict(arg.split("=", 1) for arg in call[5::2])["query"]
        self.assertEqual(query, "\n".join([
            "query($owner: String!, $name: String!, $base: String!, $h0: String!, $r0: String!) {",
            "  repository(owner: $owner, name: $name) {",
            "    p0: pullRequests(headRefName: $h0, baseRefName: $base, states: MERGED, first: 100, "
            "orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number headRefOid } }",
            "    r0: ref(qualifiedName: $r0) { prefix name target { oid } }",
            "  }",
            "}",
        ]))

    def test_a_branch_github_names_differently_fails_the_lookup(self):
        self.pushed_on_github("t3/pushed")
        with mock.patch.dict(os.environ, {"FAKE_GH_SHAPE": "other-ref"}):
            result = self.fx.prune()
        self.assertEqual([f["error"] for f in result["failed"]], [
            "gh api graphql: GitHub answered for refs/heads/t3/pushed-2 instead of refs/heads/t3/pushed",
        ])
        self.assertTrue(has_branch(self.fx.repo, "t3/pushed"))

    def test_a_similarly_named_branch_on_github_does_not_count(self):
        self.pushed_on_github("t3/pushed")
        git(self.fx.repo, "push", "-q", "origin", "t3/pushed:refs/heads/t3/pushed-2")
        git(self.fx.repo, "push", "-q", "origin", "--delete", "t3/pushed")
        git(self.fx.repo, "update-ref", "refs/remotes/origin/t3/pushed", "t3/pushed")
        result = self.fx.prune()
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [("t3/pushed", "not merged or pushed")])
        self.assertEqual(result["failed"], [])

    def test_a_failed_batch_keeps_earlier_batches_and_stops_later_ones(self):
        self.on_github()
        tips = {}
        for name in ("t3/a", "t3/b", "t3/c", "t3/d", "t3/e"):
            tips[name] = self.fx.branch(name, merged=False)
            self.fx.thread("p", name)
        self.pull("t3/a", {"number": 1, "headRefOid": tips["t3/a"]})
        self.pull("t3/e", {"number": 5, "headRefOid": tips["t3/e"]})
        with mock.patch.object(prune_branches, "GITHUB_BATCH", 2), mock.patch.dict(os.environ, {"FAKE_GH_FAIL_FROM": "1"}):
            result = self.fx.prune()
        self.assertEqual(len(self.gh_calls()), 2)
        self.assertEqual([(e["branch"], e["pullRequest"]) for e in result["deleted"]], [("t3/a", 1)])
        self.assertEqual([(e["branch"], e["reason"]) for e in result["kept"]], [
            ("t3/b", "not merged or pushed"), ("t3/c", "remote lookup unavailable"),
            ("t3/d", "remote lookup unavailable"), ("t3/e", "remote lookup unavailable"),
        ])
        self.assertEqual([f["error"] for f in result["failed"]], ["gh api graphql: gh: Bad credentials (HTTP 401)"])


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
