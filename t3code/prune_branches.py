#!/usr/bin/env python3
"""Delete merged local branches of T3 Code threads whose worktrees are gone.

T3 Code's storage cleanup (`storageCleanup.worktreeOnMerge`) removes a thread's
worktree once its pull request is merged, but keeps the thread's local branch. This
script deletes those branches. It reads the T3 state database read-only and changes
only branch refs and their `branch.<name>.*` configuration.

A branch is deleted when all of these hold:
- it is the branch of a T3 thread that has a worktree, in a project of that repository;
- it is not the remote's default branch, and no worktree has it checked out;
- no thread on that branch has a queued, preparing, starting, running or waiting run;
- its tip is reachable from `refs/remotes/origin/HEAD`, so its commits are all on the
  default branch.

Deletion compares and swaps the ref, so a branch that moved after the check stays.
Repositories without `origin/HEAD`, and project folders that are missing or not in a
repository, are skipped. Each call prints the deleted branches as `<repository>
<branch>`, one per line, and with `--log` appends one JSON line describing the call.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DB = Path.home() / ".t3" / "userdata" / "statev2.sqlite"

ACTIVE_RUN_STATUSES = ("queued", "preparing", "starting", "running", "waiting")

THREADS_SQL = f"""
select
  project.workspace_root,
  json_extract(thread.payload_json, '$.branch') as branch,
  exists (
    select 1 from orchestration_v2_projection_runs as run
    where run.thread_id = thread.thread_id
      and run.status in ({", ".join(f"'{status}'" for status in ACTIVE_RUN_STATUSES)})
  ) as active
from orchestration_v2_projection_threads as thread
join projection_projects as project on project.project_id = thread.project_id
where project.deleted_at is null
  and json_extract(thread.payload_json, '$.worktreePath') is not null
  and json_extract(thread.payload_json, '$.branch') is not null
order by project.workspace_root, branch
"""


def read_threads(db_path: Path) -> dict[str, dict[str, bool]]:
    """Map each project folder to its worktree threads' branches and whether any is active."""
    if not db_path.is_file():
        raise FileNotFoundError(f"T3 state database not found: {db_path}")
    connection = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        projects: dict[str, dict[str, bool]] = {}
        for root, branch, active in connection.execute(THREADS_SQL):
            branches = projects.setdefault(root, {})
            branches[branch] = branches.get(branch, False) or bool(active)
        return projects
    finally:
        connection.close()


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=check)


def output(repo: Path, *args: str) -> str | None:
    """A git query's trimmed output, or None when it exits nonzero."""
    result = git(repo, *args, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def prune(db_path: Path, dry_run: bool = False) -> dict:
    deleted: list[dict[str, str]] = []
    kept: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []
    # Projects in one repository, such as a subfolder project, share its branches.
    repos: dict[str, tuple[Path, dict[str, bool]]] = {}
    for root, branches in read_threads(db_path).items():
        folder = Path(root)
        common = output(folder, "rev-parse", "--path-format=absolute", "--git-common-dir") if folder.is_dir() else None
        if common is None:
            skipped.append({"project": root, "reason": "not a git repository"})
            continue
        repo, merged = repos.setdefault(common, (folder, {}))
        for branch, active in branches.items():
            merged[branch] = merged.get(branch, False) or active

    for repo, branches in repos.values():
        default_ref = output(repo, "symbolic-ref", "-q", "refs/remotes/origin/HEAD")
        if default_ref is None:
            skipped.append({"project": str(repo), "reason": "origin/HEAD is not set"})
            continue
        default_branch = default_ref.removeprefix("refs/remotes/origin/")
        checked_out = {
            line.removeprefix("branch refs/heads/")
            for line in git(repo, "worktree", "list", "--porcelain").stdout.splitlines()
            if line.startswith("branch refs/heads/")
        }
        for branch, active in sorted(branches.items()):
            tip = output(repo, "rev-parse", "-q", "--verify", f"refs/heads/{branch}^{{commit}}")
            if tip is None:
                continue
            entry = {"repository": str(repo), "branch": branch, "sha": tip}
            reason = (
                "default branch" if branch == default_branch
                else "checked out" if branch in checked_out
                else "thread is active" if active
                else None
            )
            if reason is None and git(repo, "merge-base", "--is-ancestor", tip, default_ref, check=False).returncode != 0:
                reason = "not merged"
            if reason is not None:
                kept.append({**entry, "reason": reason})
                continue
            if not dry_run and not delete_branch(repo, branch, tip):
                kept.append({**entry, "reason": "moved since check"})
                continue
            deleted.append(entry)
    return {"dryRun": dry_run, "deleted": deleted, "kept": kept, "skipped": skipped}


def delete_branch(repo: Path, branch: str, tip: str) -> bool:
    """Delete the branch if it still points at tip. False when it moved meanwhile."""
    result = git(repo, "update-ref", "-d", f"refs/heads/{branch}", tip, check=False)
    if result.returncode != 0:
        if output(repo, "rev-parse", "-q", "--verify", f"refs/heads/{branch}") != tip:
            return False
        raise subprocess.CalledProcessError(result.returncode, result.args, result.stdout, result.stderr)
    names = git(repo, "config", "--local", "--name-only", "--list").stdout.splitlines()
    if any(name.startswith(f"branch.{branch}.") for name in names):
        git(repo, "config", "--local", "--remove-section", f"branch.{branch}")
    return True


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
    return 0


if __name__ == "__main__":
    sys.exit(main())
