#!/usr/bin/env python3
"""Delete merged local branches of T3 Code threads whose worktrees are gone.

T3 Code's storage cleanup removes a thread's worktree once its pull request is merged
or the thread has been settled for a while, but keeps the thread's local branch. This
script deletes those branches once they are merged with `git branch -D`, which also removes their reflogs
and `branch.<name>.*` configuration. It reads the T3 state database read-only.

A branch is deleted when all of these hold:
- it is the branch of a T3 thread that has a worktree, in a project of that repository;
- it is not the remote's default branch, no worktree has it checked out, and no
  thread on it still has its worktree folder;
- no thread on that branch has a queued, preparing, starting, running or waiting run,
  or a pending request;
- it is merged: its tip is reachable from `refs/remotes/origin/HEAD` as of the last
  fetch, or, when origin is on GitHub, a merged pull request from it into the default
  branch has exactly its tip as head, which covers squash and rebase merges.

The tip is checked again just before deletion, and git itself refuses to delete a
branch that a worktree has checked out, is rebasing or is bisecting; such branches
stay. Project folders that are missing or not in a repository, and repositories
without `origin/HEAD`, are skipped. A git error fails only its repository, and a
failed pull request lookup only its branch. Each call
prints the deleted branches as `<repository> <branch>`, one per line, with `--log`
appends one JSON line describing the call, and exits 1 when anything failed.
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
from typing import NamedTuple

DEFAULT_DB = Path.home() / ".t3" / "userdata" / "statev2.sqlite"

ACTIVE_RUN_STATUSES = ("queued", "preparing", "starting", "running", "waiting")

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


class Usage(NamedTuple):
    """How a repository's T3 threads use one branch."""

    active: bool
    worktrees: tuple[str, ...]

    def merge(self, other: "Usage") -> "Usage":
        return Usage(self.active or other.active, self.worktrees + other.worktrees)


def read_threads(db_path: Path) -> dict[str, dict[str, Usage]]:
    """Map each project folder to the branches of its worktree threads."""
    if not db_path.is_file():
        raise FileNotFoundError(f"T3 state database not found: {db_path}")
    connection = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        projects: dict[str, dict[str, Usage]] = {}
        for root, branch, active, worktrees in connection.execute(THREADS_SQL):
            projects.setdefault(root, {})[branch] = Usage(bool(active), tuple(json.loads(worktrees)))
        return projects
    finally:
        connection.close()


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=check)


def branch_tip(repo: Path, branch: str) -> str | None:
    result = git(repo, "rev-parse", "-q", "--verify", f"refs/heads/{branch}^{{commit}}", check=False)
    return result.stdout.strip() if result.returncode == 0 else None


GITHUB_URL = re.compile(r"^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+?)(?:\.git)?/?$")


def github_repository(repo: Path) -> str | None:
    """`owner/name` of origin when it is on GitHub, from its configured URL."""
    url = git(repo, "config", "--get", "remote.origin.url", check=False).stdout.strip()
    match = GITHUB_URL.match(url)
    return match[1] if match else None


def merged_pull_request(github: str, branch: str, tip: str, base: str) -> int | None:
    """The number of a merged pull request from branch into base whose head is tip."""
    found = subprocess.run(
        ["gh", "pr", "list", "--repo", github, "--head", branch, "--base", base, "--state", "merged",
         "--json", "number,headRefOid", "--limit", "100"],
        capture_output=True, text=True, check=True,
    )
    return next((pr["number"] for pr in json.loads(found.stdout) if pr["headRefOid"] == tip), None)


def command_error(error: subprocess.CalledProcessError) -> str:
    detail = (error.stderr or error.stdout or "").strip().splitlines()
    command = error.cmd[3:] if error.cmd[0] == "git" else error.cmd[:3]
    return f"{' '.join(command)}: {detail[-1] if detail else f'exit {error.returncode}'}"


def prune(db_path: Path, dry_run: bool = False) -> dict:
    result: dict = {"dryRun": dry_run, "deleted": [], "kept": [], "skipped": [], "failed": []}
    # Projects in one repository, such as a subfolder project, share its branches.
    repos: dict[str, tuple[Path, dict[str, Usage]]] = {}
    for root, branches in read_threads(db_path).items():
        folder = Path(root)
        if not folder.is_dir():
            result["skipped"].append({"project": root, "reason": "folder is missing"})
            continue
        common = git(folder, "rev-parse", "--path-format=absolute", "--git-common-dir", check=False)
        if common.returncode != 0:
            lines = common.stderr.strip().splitlines()
            result["skipped"].append({"project": root, "reason": lines[-1] if lines else "not a git repository"})
            continue
        repo, merged = repos.setdefault(common.stdout.strip(), (folder, {}))
        for branch, usage in branches.items():
            merged[branch] = merged[branch].merge(usage) if branch in merged else usage

    for repo, branches in repos.values():
        try:
            prune_repository(repo, branches, dry_run, result)
        except subprocess.CalledProcessError as error:
            result["failed"].append({"project": str(repo), "error": command_error(error)})
    return result


def prune_repository(repo: Path, branches: dict[str, Usage], dry_run: bool, result: dict) -> None:
    default_ref = git(repo, "symbolic-ref", "-q", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    if not default_ref:
        result["skipped"].append({"project": str(repo), "reason": "origin/HEAD is not set"})
        return
    default_branch = default_ref.removeprefix("refs/remotes/origin/")
    github = github_repository(repo)
    checked_out = {
        line.removeprefix("branch refs/heads/")
        for line in git(repo, "worktree", "list", "--porcelain").stdout.splitlines()
        if line.startswith("branch refs/heads/")
    }
    for branch, usage in sorted(branches.items()):
        tip = branch_tip(repo, branch)
        if tip is None:
            continue
        entry = {"repository": str(repo), "branch": branch, "sha": tip}
        reason = (
            "default branch" if branch == default_branch
            else "checked out" if branch in checked_out
            else "worktree still exists" if any(Path(path).exists() for path in usage.worktrees)
            else "thread is active" if usage.active
            else None
        )
        if reason is None:
            ancestor = git(repo, "merge-base", "--is-ancestor", tip, default_ref, check=False)
            if ancestor.returncode not in (0, 1):
                raise subprocess.CalledProcessError(ancestor.returncode, ancestor.args, ancestor.stdout, ancestor.stderr)
            if ancestor.returncode == 1:
                reason = "not merged"
        if reason == "not merged" and github is not None:
            try:
                number = merged_pull_request(github, branch, tip, default_branch)
            except (OSError, subprocess.CalledProcessError, ValueError, KeyError, TypeError) as error:
                cause = command_error(error) if isinstance(error, subprocess.CalledProcessError) else repr(error)
                result["failed"].append({"project": str(repo), "branch": branch, "error": cause})
                continue
            if number is not None:
                reason = None
                entry["pullRequest"] = number
        if reason is None and not dry_run:
            reason = delete_branch(repo, branch, tip)
        if reason is not None:
            result["kept"].append({**entry, "reason": reason})
        else:
            result["deleted"].append(entry)


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
