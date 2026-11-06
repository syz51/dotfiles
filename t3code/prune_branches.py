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
   origin is on github.com, GitHub has a merged pull request from it into the default
   branch whose head is its tip or a known descendant of it, which covers squash and
   rebase merges.
2. Pushed: origin's branch of the same name, both as last fetched and as read live,
   is its tip or a known descendant of it. A resumed thread gets its worktree back
   from that branch.
3. Abandoned: every T3 thread on it, with a worktree or not, is archived or deleted.
A pushed or abandoned branch's tip is first saved as
`refs/t3-archive/<branch>@<12 hex digits of the tip>`, which `git branch` does not
list, so `git branch <name> <that ref>` restores it even if origin's branch is gone.
A branch none of these covers holds the only copy of a resumable thread's work and
stays.

Origin counts as github.com after `insteadOf` rewriting and, for SSH URLs, when the
SSH command git uses resolves the host to github.com or ssh.github.com through
`ssh -G`, so host aliases work. All T3 and local conditions are checked again from
fresh state just before deleting, and git itself refuses to delete a branch that a
worktree has checked out, is rebasing or is bisecting. Project folders that are
missing or not in a repository, and repositories without `origin/HEAD`, are skipped.
Remote lookups are batched per repository: on github.com, one GraphQL query through
`gh` per 50 branches for their merged pull requests and live branches, and elsewhere
one `git ls-remote` for the branches to check. A repository with nothing to look up
makes no remote call. An error fails only its repository. Each call prints the deleted branches as
`<repository> <branch>`, followed by `archived as <ref>` for archived ones, one per
line, with `--log` appends one JSON line describing the call, and exits 1 when
anything failed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple

DEFAULT_DB = Path.home() / ".t3" / "userdata" / "statev2.sqlite"

ACTIVE_RUN_STATUSES = ("queued", "preparing", "starting", "running", "waiting")

LOOKUP_TIMEOUT_SECONDS = 60

# Branches per GitHub query, each asking for up to 100 pull requests, well inside
# GitHub's limit of 500,000 nodes per query.
GITHUB_BATCH = 50

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
  json_group_array(json_extract(thread.payload_json, '$.worktreePath'))
    filter (where json_extract(thread.payload_json, '$.worktreePath') is not null) as worktrees,
  min(thread.archived_at is not null or thread.deleted_at is not null) as abandoned
from orchestration_v2_projection_threads as thread
join projection_projects as project on project.project_id = thread.project_id
where project.deleted_at is null
  and json_extract(thread.payload_json, '$.branch') is not null
group by project.workspace_root, branch
order by project.workspace_root, branch
"""

# `user@host:owner/name` and `scheme://[user@]host[:port]/owner/name` remote URLs.
SCP_URL = re.compile(r"^(?:[^@/:]+@)?(?P<host>[^/:]+):(?!/)(?P<path>.+)$")
SCHEME_URL = re.compile(r"^(?P<scheme>ssh|git\+ssh|ssh\+git|https)://(?:[^@/]+@)?(?P<host>[^/:]+)(?::\d+)?/(?P<path>.+)$")
REPOSITORY_PATH = re.compile(r"^([^/]+/[^/]+?)(?:\.git)?/?$")

# What a failed or garbled remote lookup raises, JSON errors being ValueErrors.
LOOKUP_ERRORS = (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError)

GITHUB_SSH_HOSTS = ("github.com", "ssh.github.com")


class Usage(NamedTuple):
    """How a repository's T3 threads use one branch."""

    active: bool
    worktrees: list[str]
    abandoned: bool


def read_repositories(db_path: Path, skipped: list | None = None) -> dict[str, tuple[Path, dict[str, Usage]]]:
    """Map each repository's common git directory to a project folder in it and the
    branches its worktree threads use, with how all its threads use them. Projects in
    one repository, such as a subfolder project, share its branches. Folders of
    projects with worktree threads that are not in a repository go to skipped."""
    if not db_path.is_file():
        raise FileNotFoundError(f"T3 state database not found: {db_path}")
    connection = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        rows = connection.execute(THREADS_SQL).fetchall()
    finally:
        connection.close()
    with_worktrees = {root for root, _, _, worktrees, _ in rows if json.loads(worktrees)}
    common_dirs: dict[str, str | None] = {}
    repos: dict[str, tuple[Path, dict[str, Usage]]] = {}
    for root, branch, active, worktrees, abandoned in sorted(rows, key=lambda row: row[0] not in with_worktrees):
        if root not in common_dirs:
            common_dirs[root] = common_dir(Path(root), skipped if root in with_worktrees else None)
        common = common_dirs[root]
        if common is None:
            continue
        branches = repos.setdefault(common, (Path(root), {}))[1]
        known = branches.get(branch, Usage(False, [], True))
        branches[branch] = Usage(
            known.active or bool(active), known.worktrees + json.loads(worktrees), known.abandoned and bool(abandoned)
        )
    for common, (root, branches) in list(repos.items()):
        used = {branch: usage for branch, usage in branches.items() if usage.worktrees}
        if used:
            repos[common] = (root, used)
        else:
            del repos[common]
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
        # A remote that asks for credentials, a passphrase or a host key confirmation
        # fails instead of waiting: no terminal prompts, no controlling terminal for ssh
        # to open, and no askpass program.
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "SSH_ASKPASS_REQUIRE": "never"},
        start_new_session=True,
    )


def ref_tip(repo: Path, ref: str) -> str | None:
    result = git(repo, "rev-parse", "-q", "--verify", f"{ref}^{{commit}}", check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def branch_tip(repo: Path, branch: str) -> str | None:
    return ref_tip(repo, f"refs/heads/{branch}")


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
        if folder_exists(folder) and worktrees.get(str(folder.resolve()), branch) in (None, branch):
            return "worktree still exists"
    if usage.active:
        return "thread is active"
    return None


def folder_exists(folder: Path) -> bool:
    """Whether the folder exists, raising when that cannot be told, unlike
    `Path.exists` on Python 3.14 and later."""
    try:
        folder.stat()
    except (FileNotFoundError, NotADirectoryError):
        return False
    return True


def ssh_hostname(repo: Path, host: str) -> str:
    """The host name an SSH host alias resolves to, without connecting, through the
    SSH command git would use."""
    command = os.environ.get("GIT_SSH_COMMAND") or git(repo, "config", "--get", "core.sshCommand", check=False).stdout.strip()
    program = shlex.split(command) if command else [os.environ.get("GIT_SSH") or "ssh"]
    found = subprocess.run(
        [*program, "-G", host], capture_output=True, text=True, check=True, timeout=LOOKUP_TIMEOUT_SECONDS,
        stdin=subprocess.DEVNULL,
    )
    for line in found.stdout.splitlines():
        key, _, value = line.partition(" ")
        if key == "hostname":
            return value.strip()
    return host


def github_repository(repo: Path) -> str | None:
    """`owner/name` of origin when it is on github.com, after `insteadOf` rewriting and
    SSH host alias resolution, which raises when ssh fails."""
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
    # Git refuses a host that ssh would read as an option.
    if path is None or host.startswith("-"):
        return None
    if host != "github.com" and not (ssh and ssh_hostname(repo, host).lower() in GITHUB_SSH_HOSTS):
        return None
    return path[1]


GITHUB_QUERY = """query($owner: String!, $name: String!, $base: String!{variables}) {{
  repository(owner: $owner, name: $name) {{{fields}
  }}
}}"""


def github_lookup(
    github: str, base: str, branches: list[str], refs: set[str],
) -> tuple[dict[str, list[tuple[int, str]]], dict[str, str | None]]:
    """For each of branches, the number and head commit of each merged pull request
    from it into base, and for each of those in refs, the commit origin's branch of
    that name points at now, or None. One GraphQL query per GITHUB_BATCH branches."""
    owner, name = github.split("/")
    pulls: dict[str, list[tuple[int, str]]] = {}
    heads: dict[str, str | None] = {}
    for start in range(0, len(branches), GITHUB_BATCH):
        batch = branches[start:start + GITHUB_BATCH]
        variables, fields, args = [], [], ["-f", f"owner={owner}", "-f", f"name={name}", "-f", f"base={base}"]
        for i, branch in enumerate(batch):
            variables.append(f", $h{i}: String!")
            fields.append(f"\n    p{i}: pullRequests(headRefName: $h{i}, baseRefName: $base, states: MERGED, first: 100)"
                          " { nodes { number headRefOid } }")
            args += ["-f", f"h{i}={branch}"]
            if branch in refs:
                variables.append(f", $r{i}: String!")
                fields.append(f"\n    r{i}: ref(qualifiedName: $r{i}) {{ target {{ oid }} }}")
                args += ["-f", f"r{i}=refs/heads/{branch}"]
        query = GITHUB_QUERY.format(variables="".join(variables), fields="".join(fields))
        found = subprocess.run(
            ["gh", "api", "graphql", "--hostname", "github.com", "-f", f"query={query}", *args],
            capture_output=True, text=True, check=True, timeout=LOOKUP_TIMEOUT_SECONDS, stdin=subprocess.DEVNULL,
        )
        repository = json.loads(found.stdout)["data"]["repository"]
        if repository is None:
            raise ValueError(f"GitHub has no repository {github}")
        for i, branch in enumerate(batch):
            pulls[branch] = [(int(pull["number"]), str(pull["headRefOid"])) for pull in repository[f"p{i}"]["nodes"]]
            if branch in refs:
                ref = repository[f"r{i}"]
                heads[branch] = None if ref is None else str(ref["target"]["oid"])
    return pulls, heads


def remote_heads(repo: Path, branches: set[str]) -> dict[str, str | None]:
    """The commit each of origin's branches of these names points at now, or None,
    from one `git ls-remote`, whose patterns protocol v2 sends to the server."""
    found = git(repo, "ls-remote", "origin", *(f"refs/heads/{branch}" for branch in sorted(branches)),
                timeout=LOOKUP_TIMEOUT_SECONDS)
    listed = {}
    for line in found.stdout.splitlines():
        sha, _, ref = line.partition("\t")
        listed[ref] = sha
    # Patterns match the end of a ref name, so keep exact names only.
    return {branch: listed.get(f"refs/heads/{branch}") for branch in branches}


def describe(label: str, error: Exception) -> str:
    if isinstance(error, subprocess.CalledProcessError):
        detail = (error.stderr or error.stdout or "").strip().splitlines()
        return f"{label}: {detail[-1] if detail else f'exit {error.returncode}'}"
    if isinstance(error, subprocess.TimeoutExpired):
        return f"{label}: timed out after {error.timeout:g}s"
    return f"{label}: {error}"


def prune(db_path: Path, dry_run: bool = False) -> dict:
    result: dict = {"dryRun": dry_run, "deleted": [], "kept": [], "skipped": [], "failed": []}
    candidates: dict[str, list[dict]] = {}
    repos = read_repositories(db_path, result["skipped"])
    for common, (repo, branches) in repos.items():
        try:
            candidates[common] = find_candidates(repo, branches, result)
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
                usage = fresh.get(common, (repo, {}))[1].get(entry["branch"])
                if usage is None:
                    reason = "no longer used by a worktree thread"
                else:
                    reason = blocking_reason(entry["branch"], usage, default_branch, worktrees)
                if reason is None and entry.get("abandoned") and not usage.abandoned:
                    reason = "thread was restored"
                if reason is None:
                    reason = delete_branch(repo, entry["branch"], entry["sha"], entry.get("archivedAs"))
                if reason is None:
                    result["deleted"].append(entry)
                else:
                    kept = {k: v for k, v in entry.items() if k not in ("archivedAs", "abandoned")}
                    result["kept"].append({**kept, "reason": reason})
        except (subprocess.CalledProcessError, OSError) as error:
            result["failed"].append({"project": str(repo), "error": describe("git", error)})
    return result


def find_candidates(repo: Path, branches: dict[str, Usage], result: dict) -> list[dict]:
    """The repository's branches that nothing holds and whose commits are kept
    elsewhere, each with how and the default branch name."""
    default_ref = git(repo, "symbolic-ref", "-q", "refs/remotes/origin/HEAD", check=False).stdout.strip()
    if not default_ref:
        result["skipped"].append({"project": str(repo), "reason": "origin/HEAD is not set"})
        return []
    default_branch = default_ref.removeprefix("refs/remotes/origin/")
    available = True
    try:
        github = github_repository(repo)
    except LOOKUP_ERRORS as error:
        # Which remote this is stays unknown, so it gets no remote lookups.
        github, available = None, False
        result["failed"].append({"project": str(repo), "error": describe("ssh -G", error)})
    worktrees = worktree_branches(repo)
    decided: list[tuple[dict, str | None]] = []
    unmerged: list[tuple[dict, Usage]] = []
    for branch, usage in sorted(branches.items()):
        tip = branch_tip(repo, branch)
        if tip is None:
            continue
        entry = {"repository": str(repo), "branch": branch, "sha": tip}
        reason = blocking_reason(branch, usage, default_branch, worktrees)
        if reason is None and not is_ancestor(repo, tip, default_ref):
            unmerged.append((entry, usage))
        else:
            decided.append((entry, reason))

    # Origin's branch can only hold the work when the last fetch saw it hold it.
    fetched = {
        entry["branch"] for entry, _ in unmerged
        if contains(repo, ref_tip(repo, f"refs/remotes/origin/{entry['branch']}"), entry["sha"])
    }
    pulls: dict[str, list[tuple[int, str]]] = {}
    heads: dict[str, str | None] = {}
    if available and unmerged and (github or fetched):
        try:
            if github:
                pulls, heads = github_lookup(github, default_branch, [entry["branch"] for entry, _ in unmerged], fetched)
            else:
                heads = remote_heads(repo, fetched)
        except LOOKUP_ERRORS as error:
            available = False
            result["failed"].append({"project": str(repo), "error": describe("gh api graphql" if github else "git ls-remote", error)})
    for entry, usage in unmerged:
        decided.append((entry, keep_elsewhere(repo, entry, usage, pulls, heads, available)))

    candidates = []
    for entry, reason in sorted(decided, key=lambda decision: decision[0]["branch"]):
        if reason is None:
            candidates.append({**entry, "defaultBranch": default_branch})
        else:
            result["kept"].append({**entry, "reason": reason})
    return candidates


def keep_elsewhere(
    repo: Path, entry: dict, usage: Usage, pulls: dict[str, list[tuple[int, str]]],
    heads: dict[str, str | None], available: bool,
) -> str | None:
    """Record in entry where a branch the default branch lacks keeps its commits, or
    return why it stays: a merged pull request, or an archive ref and either origin's
    branch or every thread on it being archived or deleted."""
    branch, tip = entry["branch"], entry["sha"]
    for number, head in sorted(pulls.get(branch, []), key=lambda pull: pull[1] != tip):
        if contains(repo, head, tip):
            entry["pullRequest"] = number
            return None
    archive = f"{ARCHIVE_PREFIX}{branch}@{tip[:12]}"
    if contains(repo, heads.get(branch), tip):
        entry.update(pushedTo=f"origin/{branch}", archivedAs=archive)
        return None
    if usage.abandoned:
        entry.update(abandoned=True, archivedAs=archive)
        return None
    return "not merged or pushed" if available else "remote lookup unavailable"


def delete_branch(repo: Path, branch: str, tip: str, archive: str | None = None) -> str | None:
    """Delete the branch if it still points at tip, after saving tip as archive when
    given. Otherwise return why it stays."""
    if branch_tip(repo, branch) != tip:
        return "moved since check"
    created = False
    if archive is not None:
        if ref_tip(repo, archive) != tip:
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
        archived = ""
        if "archivedAs" in entry:
            archived = f" {'to be archived' if args.dry_run else 'archived'} as {entry['archivedAs']}"
        print(f"{entry['repository']} {entry['branch']}{archived}")
    for failure in result["failed"]:
        where = " ".join(filter(None, (failure["project"], failure.get("branch"))))
        print(f"failed: {where}: {failure['error']}", file=sys.stderr)
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
