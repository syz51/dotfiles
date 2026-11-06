#!/usr/bin/env python3
"""Delete local branches of T3 Code threads whose worktrees are gone, losing no work.

T3 Code's storage cleanup removes a thread's worktree once its pull request is merged
or the thread has been settled for a while, but keeps the thread's local branch. This
script deletes those branches once their commits are kept somewhere else. It deletes
with `git branch -D`, which also removes their reflogs and `branch.<name>.*`
configuration, and reads the T3 state database read-only.

A branch is held, and stays, when any of these is true:
- no T3 thread with a worktree uses it, in a project of that repository;
- it is the remote's default branch, or a worktree has it checked out;
- a thread on it still has its worktree folder, unless another branch now has that
  folder checked out;
- a thread on it has a queued, preparing, starting, running or waiting run, or a
  pending request.

Otherwise it is deleted when its commits are kept elsewhere, checked in this order:
1. Merged: `refs/remotes/origin/HEAD` contains its tip as of the last fetch, or, when
   origin is on github.com, `gh` finds a merged pull request from it into the default
   branch whose head is its tip or a known descendant of it, which covers squash and
   rebase merges.
2. Pushed: origin's branch of the same name, both as last fetched and as read live
   through `gh` on GitHub or `git ls-remote` elsewhere, is its tip or a known
   descendant of it. A resumed thread gets its worktree back from that branch.
3. Abandoned: every thread on it is archived or deleted in T3. The tip is first saved
   as `refs/t3-archive/<branch>@<12 hex digits of the tip>`, which `git branch` does
   not list, so `git branch <name> <that ref>` restores it.
A branch none of these covers holds the only copy of a resumable thread's work and
stays.

Origin counts as github.com after `insteadOf` rewriting and, for SSH URLs, after
resolving the host through `ssh -G`, so host aliases work. All conditions are checked
again from fresh state just before deleting, and git itself refuses to delete a branch
that a worktree has checked out, is rebasing or is bisecting. Project folders that are
missing or not in a repository, and repositories without `origin/HEAD`, are skipped.
An error fails only its repository. The first failed `gh` lookup stops `gh` lookups
for the rest of the call, and the first failed `git ls-remote` stops them for its
repository. Each call prints the deleted branches as
`<repository> <branch>`, followed by `archived as <ref>` for archived ones, one per
line, with `--log` appends one JSON line describing the call, and exits 1 when
anything failed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple
from urllib.parse import quote

DEFAULT_DB = Path.home() / ".t3" / "userdata" / "statev2.sqlite"

ACTIVE_RUN_STATUSES = ("queued", "preparing", "starting", "running", "waiting")

LOOKUP_TIMEOUT_SECONDS = 60

ARCHIVE_PREFIX = "refs/t3-archive/"

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
  json_group_array(json_extract(thread.payload_json, '$.worktreePath')) as worktrees,
  min(thread.archived_at is not null or thread.deleted_at is not null) as abandoned
from orchestration_v2_projection_threads as thread
join projection_projects as project on project.project_id = thread.project_id
where project.deleted_at is null
  and json_extract(thread.payload_json, '$.worktreePath') is not null
  and json_extract(thread.payload_json, '$.branch') is not null
group by project.workspace_root, branch
order by project.workspace_root, branch
"""

# `user@host:owner/name` and `scheme://[user@]host[:port]/owner/name` remote URLs.
SCP_URL = re.compile(r"^(?:[^@/:]+@)?(?P<host>[^/:]+):(?!/)(?P<path>.+)$")
SCHEME_URL = re.compile(r"^(?P<scheme>ssh|git\+ssh|ssh\+git|https)://(?:[^@/]+@)?(?P<host>[^/:]+)(?::\d+)?/(?P<path>.+)$")
REPOSITORY_PATH = re.compile(r"^([^/]+/[^/]+?)(?:\.git)?/?$")

NETWORK_ERRORS = (OSError, subprocess.SubprocessError, json.JSONDecodeError)


class Usage(NamedTuple):
    """How a repository's T3 threads use one branch."""

    active: bool
    worktrees: list[str]
    abandoned: bool


NOT_USED = Usage(False, [], True)


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
    for root, branch, active, worktrees, abandoned in rows:
        if root not in common_dirs:
            common_dirs[root] = common_dir(Path(root), skipped)
        common = common_dirs[root]
        if common is None:
            continue
        branches = repos.setdefault(common, (Path(root), {}))[1]
        known = branches.get(branch, NOT_USED)
        branches[branch] = Usage(
            known.active or bool(active), known.worktrees + json.loads(worktrees), known.abandoned and bool(abandoned)
        )
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


def git(repo: Path, *args: str, check: bool = True, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=check, timeout=timeout, stdin=subprocess.DEVNULL,
        # A remote that asks for credentials fails instead of waiting for an answer.
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )


def branch_tip(repo: Path, branch: str) -> str | None:
    result = git(repo, "rev-parse", "-q", "--verify", f"refs/heads/{branch}^{{commit}}", check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def is_ancestor(repo: Path, commit: str, descendant: str) -> bool:
    found = git(repo, "merge-base", "--is-ancestor", commit, descendant, check=False)
    if found.returncode not in (0, 1):
        raise subprocess.CalledProcessError(found.returncode, found.args, found.stdout, found.stderr)
    return found.returncode == 0


def contains(repo: Path, commit: str | None, tip: str) -> bool:
    """Whether commit is tip or a commit this repository knows that descends from it."""
    if commit is None:
        return False
    if commit == tip:
        return True
    known = git(repo, "cat-file", "-e", f"{commit}^{{commit}}", check=False).returncode == 0
    return known and is_ancestor(repo, tip, commit)


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
    """Why the branch must stay whatever happened to its commits, or None."""
    if branch == default_branch:
        return "default branch"
    if branch in worktrees.values():
        return "checked out"
    for path in usage.worktrees:
        folder = Path(path)
        # A folder another branch now has checked out no longer belongs to this branch.
        if folder.exists() and worktrees.get(str(folder.resolve()), branch) in (None, branch):
            return "worktree still exists"
    if usage.active:
        return "thread is active"
    return None


def ssh_hostname(host: str) -> str | None:
    """The host name an SSH host alias resolves to, without connecting."""
    try:
        found = subprocess.run(
            ["ssh", "-G", host], capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for line in found.stdout.splitlines() if found.returncode == 0 else []:
        key, _, value = line.partition(" ")
        if key == "hostname":
            return value.strip()
    return None


def github_repository(repo: Path) -> str | None:
    """`owner/name` of origin when it is on github.com, after `insteadOf` rewriting and
    SSH host alias resolution."""
    url = git(repo, "remote", "get-url", "origin", check=False).stdout.strip()
    match = SCHEME_URL.match(url)
    ssh = match is not None and match["scheme"] != "https"
    if match is None:
        match = SCP_URL.match(url)
        ssh = True
    if match is None:
        return None
    path = REPOSITORY_PATH.match(match["path"])
    host = match["host"].lower()
    if path is None:
        return None
    if host != "github.com" and not (ssh and (ssh_hostname(host) or "").lower() == "github.com"):
        return None
    return path[1]


def merged_pull_request(repo: Path, github: str, branch: str, tip: str, base: str) -> int | None:
    """A merged pull request from branch into base whose head contains tip."""
    found = subprocess.run(
        ["gh", "pr", "list", "--repo", f"github.com/{github}", "--head", branch, "--base", base,
         "--state", "merged", "--json", "number,headRefOid", "--limit", "100"],
        capture_output=True, text=True, check=True, timeout=LOOKUP_TIMEOUT_SECONDS, stdin=subprocess.DEVNULL,
    )
    pulls = json.loads(found.stdout)
    for pull in sorted(pulls, key=lambda pull: pull["headRefOid"] != tip):
        if contains(repo, pull["headRefOid"], tip):
            return pull["number"]
    return None


def remote_branch(repo: Path, github: str | None, branch: str) -> str | None:
    """The commit origin's branch of this name points at now, or None without one."""
    if github is not None:
        found = subprocess.run(
            ["gh", "api", f"repos/{github}/git/ref/heads/{quote(branch, safe='/')}", "--hostname", "github.com"],
            capture_output=True, text=True, timeout=LOOKUP_TIMEOUT_SECONDS, stdin=subprocess.DEVNULL,
        )
        if found.returncode != 0 and "HTTP 404" in found.stderr:
            return None
        if found.returncode != 0:
            raise subprocess.CalledProcessError(found.returncode, found.args, found.stdout, found.stderr)
        ref = json.loads(found.stdout)
        # GitHub lists refs under a prefix instead when no ref has exactly this name.
        if not isinstance(ref, dict) or ref.get("ref") != f"refs/heads/{branch}":
            return None
        return ref["object"]["sha"]
    found = git(repo, "ls-remote", "--exit-code", "origin", f"refs/heads/{branch}", check=False, timeout=LOOKUP_TIMEOUT_SECONDS)
    if found.returncode == 2:
        return None
    if found.returncode != 0:
        raise subprocess.CalledProcessError(found.returncode, found.args, found.stdout, found.stderr)
    return found.stdout.split()[0]


def describe(label: str, error: Exception) -> str:
    if isinstance(error, subprocess.CalledProcessError):
        detail = (error.stderr or error.stdout or "").strip().splitlines()
        return f"{label}: {detail[-1] if detail else f'exit {error.returncode}'}"
    if isinstance(error, subprocess.TimeoutExpired):
        return f"{label}: timed out after {error.timeout:g}s"
    return f"{label}: {error}"


def prune(db_path: Path, dry_run: bool = False) -> dict:
    result: dict = {"dryRun": dry_run, "deleted": [], "kept": [], "skipped": [], "failed": []}
    lookups: dict[str, bool] = {}
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
                if reason is None and "archivedAs" in entry and not usage.abandoned:
                    reason = "thread was restored"
                if reason is None:
                    reason = delete_branch(repo, entry["branch"], entry["sha"], entry.get("archivedAs"))
                if reason is None:
                    result["deleted"].append(entry)
                else:
                    result["kept"].append({**{k: v for k, v in entry.items() if k != "archivedAs"}, "reason": reason})
        except (subprocess.CalledProcessError, OSError) as error:
            result["failed"].append({"project": str(repo), "error": describe("git", error)})
    return result


def find_candidates(repo: Path, branches: dict[str, Usage], lookups: dict, result: dict) -> list[dict]:
    """The repository's branches that nothing holds and whose commits are kept
    elsewhere, each with how and the default branch name."""
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
            reason = keep_elsewhere(repo, github, branch, tip, default_branch, usage, entry, lookups, result)
        if reason is None:
            candidates.append({**entry, "defaultBranch": default_branch})
        else:
            result["kept"].append({**entry, "reason": reason})
    return candidates


def keep_elsewhere(
    repo: Path, github: str | None, branch: str, tip: str, default_branch: str, usage: Usage,
    entry: dict, lookups: dict[str, bool], result: dict,
) -> str | None:
    """Record in entry where a branch the default branch lacks keeps its commits, or
    return why it stays: a merged pull request, origin's branch, or an archive ref."""
    lookup = "gh" if github else str(repo)
    if lookups.get(lookup, True):
        step = "gh pr list"
        try:
            number = merged_pull_request(repo, github, branch, tip, default_branch) if github else None
            if number is not None:
                entry["pullRequest"] = number
                return None
            fetched = git(repo, "rev-parse", "-q", "--verify", f"refs/remotes/origin/{branch}^{{commit}}", check=False)
            if contains(repo, fetched.stdout.strip() or None, tip):
                step = "gh api" if github else "git ls-remote"
                if contains(repo, remote_branch(repo, github, branch), tip):
                    entry["pushedTo"] = f"origin/{branch}"
                    return None
        except NETWORK_ERRORS as error:
            lookups[lookup] = False
            result["failed"].append({"project": str(repo), "branch": branch, "error": describe(step, error)})
    if usage.abandoned:
        entry["archivedAs"] = f"{ARCHIVE_PREFIX}{branch}@{tip[:12]}"
        return None
    return "not merged or pushed" if lookups.get(lookup, True) else "remote lookup unavailable"


def delete_branch(repo: Path, branch: str, tip: str, archive: str | None = None) -> str | None:
    """Delete the branch if it still points at tip, after saving tip as archive when
    given. Otherwise return why it stays."""
    if branch_tip(repo, branch) != tip:
        return "moved since check"
    created = False
    if archive is not None:
        existing = git(repo, "rev-parse", "-q", "--verify", archive, check=False).stdout.strip()
        if existing != tip:
            # An empty old value makes the update fail rather than replace another commit.
            git(repo, "update-ref", "-m", f"t3 prune: archive {branch}", archive, tip, "")
            created = True
    deleted = git(repo, "branch", "-D", branch, check=False)
    if deleted.returncode == 0:
        return None
    if created:
        git(repo, "update-ref", "-d", archive, tip)
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
        archived = f" archived as {entry['archivedAs']}" if "archivedAs" in entry else ""
        print(f"{entry['repository']} {entry['branch']}{archived}")
    for failure in result["failed"]:
        where = " ".join(filter(None, (failure["project"], failure.get("branch"))))
        print(f"failed: {where}: {failure['error']}", file=sys.stderr)
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
