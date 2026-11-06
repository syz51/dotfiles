#!/usr/bin/env python3
"""Delete merged local branches of T3 Code threads whose worktrees are gone.

T3 Code's storage cleanup removes a thread's worktree once its pull request is merged
or the thread has been settled for a while, but keeps the thread's local branch. This
script deletes those branches once they are merged. It deletes with `git branch -D`,
which also removes their reflogs and `branch.<name>.*` configuration, and reads the
T3 state database read-only.

A branch is deleted when all of these hold:
- it is the branch of a T3 thread that has a worktree, in a project of that repository;
- it is not the remote's default branch, no worktree has it checked out, and no
  thread on it still has its worktree folder, unless another branch now has that
  folder checked out;
- no thread on that branch has a queued, preparing, starting, running or waiting run,
  or a pending request;
- it is merged: its tip is reachable from `refs/remotes/origin/HEAD` as of the last
  fetch, or, when origin is on github.com, `gh` finds a merged pull request from it
  into the default branch whose head is its tip or a known descendant of it, which
  covers squash and rebase merges.

These conditions are checked again from fresh state just before deleting, after any
pull request lookups, and git itself refuses to delete a branch that a worktree has
checked out, is rebasing or is bisecting. Project folders that are missing or not in
a repository, and repositories without `origin/HEAD`, are skipped. An error fails
only its repository. The first failed pull request lookup stops lookups for the rest
of the call, and the branches that needed one stay. Each call prints the deleted
branches as `<repository> <branch>`, one per line, with `--log` appends one JSON line
describing the call, and exits 1 when anything failed.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DB = Path.home() / ".t3" / "userdata" / "statev2.sqlite"

ACTIVE_RUN_STATUSES = ("queued", "preparing", "starting", "running", "waiting")

LOOKUP_TIMEOUT_SECONDS = 60

THREADS_SQL = f"""
select
  project.workspace_root,
  json_extract(thread.payload_json, '$.branch') as branch,
  max(
    exists (
      select 1 from orchestration_v2_projection_runs as run
      where run.thread_id = thread.thread_id
        and run.status in ({", ".join(f"'{status}'" for status in ACTIVE_RUN_STATUSES)})
    )
    or exists (
      select 1 from orchestration_v2_projection_runtime_requests as request
      where request.thread_id = thread.thread_id and request.status = 'pending'
    )
  ) as active,
  json_group_array(json_extract(thread.payload_json, '$.worktreePath')) as worktrees
from orchestration_v2_projection_threads as thread
join projection_projects as project on project.project_id = thread.project_id
where project.deleted_at is null
  and json_extract(thread.payload_json, '$.worktreePath') is not null
  and json_extract(thread.payload_json, '$.branch') is not null
group by project.workspace_root, branch
order by project.workspace_root, branch
"""

GITHUB_URL = re.compile(r"^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+?)(?:\.git)?/?$")

# A branch's use by T3 threads: whether any is active, and their worktree folders.
Usage = tuple[bool, list[str]]
NOT_USED: Usage = (False, [])


def read_repositories(db_path: Path, skipped: list | None = None) -> dict[str, tuple[Path, dict[str, Usage]]]:
    """Map each repository's common git directory to a project folder in it and the
    branches its worktree threads use. Projects in one repository, such as a subfolder
    project, share its branches. Folders that are not in a repository go to skipped."""
    if not db_path.is_file():
        raise FileNotFoundError(f"T3 state database not found: {db_path}")
    connection = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        rows = connection.execute(THREADS_SQL).fetchall()
    finally:
        connection.close()
    common_dirs: dict[str, str | None] = {}
    repos: dict[str, tuple[Path, dict[str, Usage]]] = {}
    for root, branch, active, worktrees in rows:
        if root not in common_dirs:
            common_dirs[root] = common_dir(Path(root), skipped)
        common = common_dirs[root]
        if common is None:
            continue
        branches = repos.setdefault(common, (Path(root), {}))[1]
        was_active, paths = branches.get(branch, NOT_USED)
        branches[branch] = (was_active or bool(active), paths + json.loads(worktrees))
    return repos


def common_dir(folder: Path, skipped: list | None) -> str | None:
    reason = None
    if not folder.is_dir():
        reason = "folder is missing"
    else:
        found = git(folder, "rev-parse", "--path-format=absolute", "--git-common-dir", check=False)
        if found.returncode == 0:
            return found.stdout.strip()
        reason = (found.stderr.strip().splitlines() or ["not a git repository"])[-1]
    if skipped is not None:
        skipped.append({"project": str(folder), "reason": reason})
    return None


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=check)


def branch_tip(repo: Path, branch: str) -> str | None:
    result = git(repo, "rev-parse", "-q", "--verify", f"refs/heads/{branch}^{{commit}}", check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def is_ancestor(repo: Path, commit: str, descendant: str) -> bool:
    found = git(repo, "merge-base", "--is-ancestor", commit, descendant, check=False)
    if found.returncode not in (0, 1):
        raise subprocess.CalledProcessError(found.returncode, found.args, found.stdout, found.stderr)
    return found.returncode == 0


def worktree_branches(repo: Path) -> dict[str, str | None]:
    """Each worktree's resolved folder and its checked-out branch, None when detached."""
    worktrees: dict[str, str | None] = {}
    folder = None
    for line in git(repo, "worktree", "list", "--porcelain").stdout.splitlines():
        if line.startswith("worktree "):
            folder = str(Path(line.removeprefix("worktree ")).resolve())
            worktrees[folder] = None
        elif line.startswith("branch refs/heads/") and folder is not None:
            worktrees[folder] = line.removeprefix("branch refs/heads/")
    return worktrees


def blocking_reason(branch: str, usage: Usage, default_branch: str, worktrees: dict[str, str | None]) -> str | None:
    """Why the branch must stay regardless of whether it is merged, or None."""
    active, paths = usage
    if branch == default_branch:
        return "default branch"
    if branch in worktrees.values():
        return "checked out"
    for path in paths:
        folder = Path(path)
        # A folder another branch now has checked out no longer belongs to this branch.
        if folder.exists() and worktrees.get(str(folder.resolve()), branch) in (None, branch):
            return "worktree still exists"
    if active:
        return "thread is active"
    return None


def github_repository(repo: Path) -> str | None:
    """`owner/name` of origin when it is on github.com, after `insteadOf` rewriting."""
    url = git(repo, "remote", "get-url", "origin", check=False).stdout.strip()
    match = GITHUB_URL.match(url)
    return match[1] if match else None


def merged_pull_request(repo: Path, github: str, branch: str, tip: str, base: str) -> int | None:
    """A merged pull request from branch into base whose head is tip, or a commit this
    repository knows that descends from tip, such as after GitHub's Update branch."""
    found = subprocess.run(
        ["gh", "pr", "list", "--repo", f"github.com/{github}", "--head", branch, "--base", base,
         "--state", "merged", "--json", "number,headRefOid", "--limit", "100"],
        capture_output=True, text=True, check=True, timeout=LOOKUP_TIMEOUT_SECONDS,
    )
    pulls = json.loads(found.stdout)
    for pull in pulls:
        if pull["headRefOid"] == tip:
            return pull["number"]
    for pull in pulls:
        known = git(repo, "cat-file", "-e", f"{pull['headRefOid']}^{{commit}}", check=False).returncode == 0
        if known and is_ancestor(repo, tip, pull["headRefOid"]):
            return pull["number"]
    return None


def describe(label: str, error: Exception) -> str:
    if isinstance(error, subprocess.CalledProcessError):
        detail = (error.stderr or error.stdout or "").strip().splitlines()
        return f"{label}: {detail[-1] if detail else f'exit {error.returncode}'}"
    if isinstance(error, subprocess.TimeoutExpired):
        return f"{label}: timed out after {error.timeout:g}s"
    return f"{label}: {error}"


def prune(db_path: Path, dry_run: bool = False) -> dict:
    result: dict = {"dryRun": dry_run, "deleted": [], "kept": [], "skipped": [], "failed": []}
    lookups = {"available": True}
    candidates: dict[str, list[dict]] = {}
    repos = read_repositories(db_path, result["skipped"])
    for common, (repo, branches) in repos.items():
        try:
            candidates[common] = find_candidates(repo, branches, lookups, result)
        except (subprocess.CalledProcessError, OSError) as error:
            result["failed"].append({"project": str(repo), "error": describe("git", error)})
    if dry_run:
        for entries in candidates.values():
            result["deleted"] += [{k: v for k, v in entry.items() if k != "defaultBranch"} for entry in entries]
        return result

    # Lookups can take a while, so recheck what may have changed from fresh state.
    fresh = read_repositories(db_path)
    for common, entries in candidates.items():
        if not entries:
            continue
        repo = repos[common][0]
        try:
            worktrees = worktree_branches(repo)
            for entry in entries:
                default_branch = entry.pop("defaultBranch")
                usage = fresh.get(common, (repo, {}))[1].get(entry["branch"], NOT_USED)
                reason = blocking_reason(entry["branch"], usage, default_branch, worktrees)
                if reason is None:
                    reason = delete_branch(repo, entry["branch"], entry["sha"])
                if reason is None:
                    result["deleted"].append(entry)
                else:
                    result["kept"].append({**entry, "reason": reason})
        except (subprocess.CalledProcessError, OSError) as error:
            result["failed"].append({"project": str(repo), "error": describe("git", error)})
    return result


def find_candidates(repo: Path, branches: dict[str, Usage], lookups: dict, result: dict) -> list[dict]:
    """The repository's merged branches that nothing holds, with the default branch name."""
    default_ref = git(repo, "symbolic-ref", "-q", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    if not default_ref:
        result["skipped"].append({"project": str(repo), "reason": "origin/HEAD is not set"})
        return []
    default_branch = default_ref.removeprefix("refs/remotes/origin/")
    github = github_repository(repo)
    worktrees = worktree_branches(repo)
    candidates = []
    for branch, usage in sorted(branches.items()):
        tip = branch_tip(repo, branch)
        if tip is None:
            continue
        entry = {"repository": str(repo), "branch": branch, "sha": tip}
        reason = blocking_reason(branch, usage, default_branch, worktrees)
        if reason is None and not is_ancestor(repo, tip, default_ref):
            reason = "not merged"
            if github is not None and not lookups["available"]:
                reason = "pull request lookup unavailable"
            elif github is not None:
                try:
                    number = merged_pull_request(repo, github, branch, tip, default_branch)
                except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
                    lookups["available"] = False
                    result["failed"].append({"project": str(repo), "branch": branch, "error": describe("gh pr list", error)})
                    reason = "pull request lookup unavailable"
                else:
                    if number is not None:
                        reason = None
                        entry["pullRequest"] = number
        if reason is None:
            candidates.append({**entry, "defaultBranch": default_branch})
        else:
            result["kept"].append({**entry, "reason": reason})
    return candidates


def delete_branch(repo: Path, branch: str, tip: str) -> str | None:
    """Delete the branch if it still points at tip. Otherwise return why it stays."""
    if branch_tip(repo, branch) != tip:
        return "moved since check"
    deleted = git(repo, "branch", "-D", branch, check=False)
    if deleted.returncode == 0:
        return None
    if "used by worktree" in deleted.stderr:
        return "in use by a worktree"
    raise subprocess.CalledProcessError(deleted.returncode, deleted.args, deleted.stdout, deleted.stderr)


def append_log(log_path: Path, result: dict) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    record = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **result}
    with log_path.open("a", encoding="utf-8") as log:
        log.write(json.dumps(record) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="T3 state database")
    parser.add_argument("--log", type=Path, help="append a JSON line per call to this file")
    parser.add_argument("--dry-run", action="store_true", help="list the branches without deleting them")
    args = parser.parse_args(argv)

    result = prune(args.db, dry_run=args.dry_run)
    if args.log is not None:
        append_log(args.log, result)
    for entry in result["deleted"]:
        print(entry["repository"], entry["branch"])
    for failure in result["failed"]:
        where = " ".join(filter(None, (failure["project"], failure.get("branch"))))
        print(f"failed: {where}: {failure['error']}", file=sys.stderr)
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
