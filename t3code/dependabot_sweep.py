#!/usr/bin/env python3
"""Plan and verify Dependabot PR actions across all non-archived repos of a GitHub owner.

This script inspects open pull requests authored by `app/dependabot` via the `gh` CLI,
skips archived repositories, parses version bumps (including major bumps inside grouped
PRs, `requirement` bumps, and Cargo `0.x` minor bumps), deduplicates re-run check runs,
checks base-branch required status checks, and classifies each PR into one deterministic
action bucket:

- `ready_to_merge`: green checks, mergeable, clean, not a major bump, not blocked
- `update_branch`: green checks, not a major bump, branch is BEHIND base
- `conflicting`: merge conflict (CONFLICTING / DIRTY)
- `failing_checks`: one or more checks failed
- `major_bump`: contains a major version bump (or Cargo 0.x minor bump)
- `pending_checks`: checks are still running or queued
- `no_ci`: no CI checks reported on the PR
- `blocked`: review required, changes requested, or branch protection blocked
- `skip_draft`: PR is marked as draft
- `needs_review`: mergeability unknown or other state needing inspection

It never mutates GitHub state; the scheduled T3 routine in `dependabot-sweep.prompt.md`
executes merges, branch updates, and board proposals using this plan.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

DEFAULT_OWNER = "syz51"
DEFAULT_TIMEOUT = 60
DEFAULT_RETRY_DELAY = 2.0
SEARCH_LIMIT = 100

FAILED_CONCLUSIONS = frozenset(
    {
        "FAILURE",
        "ERROR",
        "TIMED_OUT",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
        "CANCELLED",
    }
)
PENDING_STATES = frozenset(
    {
        "PENDING",
        "EXPECTED",
        "QUEUED",
        "IN_PROGRESS",
        "WAITING",
        "REQUESTED",
    }
)
BENIGN_CONCLUSIONS = frozenset({"NEUTRAL", "SKIPPED", "STALE"})

VERSION_TOKEN = r"(?:[~^>=<]+)?v?\d+(?:\.\d+)*(?:[+-][0-9A-Za-z._-]+)?"
TITLE_BUMP_RE = re.compile(
    rf"\bbump\s+(?P<pkg>[^\s]+)(?:\s+requirement)?\s+from\s+(?P<old>{VERSION_TOKEN})\s+to\s+(?P<new>{VERSION_TOKEN})",
    re.IGNORECASE,
)
BODY_UPDATES_RE = re.compile(
    rf"^\s*Updates\s+`(?P<pkg>[^`]+)`\s+from\s+`?(?P<old>{VERSION_TOKEN})`?\s+to\s+`?(?P<new>{VERSION_TOKEN})`?",
    re.IGNORECASE | re.MULTILINE,
)
TABLE_ROW_RE = re.compile(
    rf"^\|\s*(?:\[(?P<link_pkg>[^\]]+)\]\([^)]+\)|`?(?P<plain_pkg>[^|`]+?)`?)\s*\|\s*`?(?P<old>{VERSION_TOKEN})`?\s*\|\s*`?(?P<new>{VERSION_TOKEN})`?\s*\|",
    re.MULTILINE,
)
REBASE_COMMAND_LINE_RE = re.compile(r"^\s*@dependabot\s+rebase\s*$", re.IGNORECASE | re.MULTILINE)

TRANSIENT_GH_PATTERNS = (
    "something went wrong while executing your query",
    "502 bad gateway",
    "503 service unavailable",
    "504 gateway timeout",
    "http 500",
    "http 502",
    "http 503",
    "http 504",
    "eof",
    "connection reset",
)

Runner = Callable[[list[str], int], subprocess.CompletedProcess[str]]


def default_runner(cmd: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def is_transient_gh_error(detail: str) -> bool:
    lowered = detail.lower()
    return any(pattern in lowered for pattern in TRANSIENT_GH_PATTERNS)


def run_gh_json(
    args: list[str],
    *,
    runner: Runner = default_runner,
    timeout: int = DEFAULT_TIMEOUT,
    retry_delay: float = DEFAULT_RETRY_DELAY,
) -> Any:
    cmd = ["gh", *args]
    last_detail = ""
    for attempt in range(2):
        proc = runner(cmd, timeout)
        if proc.returncode == 0:
            text = proc.stdout.strip()
            if not text:
                return None
            try:
                return json.loads(text)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"`{' '.join(cmd)}` returned invalid JSON: {exc}") from exc
        last_detail = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
        if attempt == 0 and is_transient_gh_error(last_detail):
            if retry_delay > 0:
                time.sleep(retry_delay)
            continue
        break
    raise RuntimeError(f"`{' '.join(cmd)}` failed: {last_detail}")


def parse_version(raw: str) -> tuple[int, int, int] | None:
    cleaned = raw.strip().lstrip("~^>=< ").lstrip("vV")
    # Strip build metadata and prerelease/tag suffixes (e.g. +spec-1.1.0, -slim-bookworm).
    cleaned = re.split(r"[+-]", cleaned, maxsplit=1)[0]
    parts = cleaned.split(".")
    if not parts or not all(part.isdigit() for part in parts):
        return None
    nums = [int(part) for part in parts[:3]]
    while len(nums) < 3:
        nums.append(0)
    return (nums[0], nums[1], nums[2])


def is_cargo_pr(files: list[str], labels: list[str]) -> bool:
    if any(label.lower() in {"rust", "cargo"} for label in labels):
        return True
    return any(Path(path).name in {"Cargo.toml", "Cargo.lock"} for path in files)


def is_major_bump(old_raw: str, new_raw: str, *, cargo: bool = False) -> bool:
    old = parse_version(old_raw)
    new = parse_version(new_raw)
    if old is None or new is None:
        return False
    if new[0] > old[0]:
        return True
    if cargo and old[0] == 0 and new[0] == 0 and new[1] > old[1]:
        return True
    return False


def extract_version_bumps(title: str, body: str) -> list[tuple[str, str, str]]:
    bumps: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    def add(pkg: str, old: str, new: str) -> None:
        item = (pkg.strip(), old.strip(), new.strip())
        if item not in seen:
            seen.add(item)
            bumps.append(item)

    for match in TITLE_BUMP_RE.finditer(title or ""):
        add(match.group("pkg"), match.group("old"), match.group("new"))
    for match in BODY_UPDATES_RE.finditer(body or ""):
        add(match.group("pkg"), match.group("old"), match.group("new"))
    for match in TABLE_ROW_RE.finditer(body or ""):
        pkg = match.group("link_pkg") or match.group("plain_pkg") or ""
        if pkg.strip().lower() in {"package", "dependency", "---"}:
            continue
        add(pkg, match.group("old"), match.group("new"))
    return bumps


def detect_major_bumps(
    title: str,
    body: str,
    files: list[str],
    labels: list[str],
) -> list[str]:
    cargo = is_cargo_pr(files, labels)
    majors: list[str] = []
    for pkg, old, new in extract_version_bumps(title, body):
        if is_major_bump(old, new, cargo=cargo):
            majors.append(f"{pkg}: {old} -> {new}")
    return majors


def _dedupe_check_runs(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the newest entry per check identity so re-run attempts supersede old failures."""
    latest: dict[tuple[str, str], tuple[str, int, dict[str, Any]]] = {}
    for index, item in enumerate(items):
        name = str(item.get("name") or item.get("context") or f"unknown-{index}")
        workflow = str(item.get("workflowName") or "")
        key = (workflow, name)
        timestamp = str(item.get("completedAt") or item.get("startedAt") or "")
        prev = latest.get(key)
        if prev is None or (timestamp, index) >= (prev[0], prev[1]):
            latest[key] = (timestamp, index, item)
    return [entry[2] for entry in sorted(latest.values(), key=lambda pair: pair[1])]


def classify_checks(rollup: list[dict[str, Any]] | None) -> dict[str, Any]:
    items = _dedupe_check_runs(rollup or [])
    passed: list[str] = []
    failed: list[dict[str, str]] = []
    pending: list[str] = []
    neutral: list[str] = []

    for item in items:
        name = str(item.get("name") or item.get("context") or "unknown")
        status = str(item.get("status") or "").upper()
        conclusion = str(item.get("conclusion") or "").upper()
        state = str(item.get("state") or "").upper()
        url = str(item.get("detailsUrl") or item.get("targetUrl") or "")

        if status and status != "COMPLETED":
            pending.append(name)
            continue

        verdict = conclusion or state
        if verdict in FAILED_CONCLUSIONS:
            failed.append({"name": name, "verdict": verdict, "url": url})
        elif verdict in PENDING_STATES or not verdict:
            pending.append(name)
        elif verdict == "SUCCESS":
            passed.append(name)
        elif verdict in BENIGN_CONCLUSIONS:
            neutral.append(name)
        else:
            pending.append(name)

    if failed:
        summary_state = "failed"
    elif pending:
        summary_state = "pending"
    elif passed:
        summary_state = "passed"
    else:
        summary_state = "none"

    return {
        "state": summary_state,
        "total": len(items),
        "passedCount": len(passed),
        "failed": failed,
        "pending": pending,
        "neutralCount": len(neutral),
    }


def choose_merge_method(repo_meta: dict[str, Any]) -> str | None:
    if repo_meta.get("allow_squash_merge"):
        return "squash"
    if repo_meta.get("allow_merge_commit"):
        return "merge"
    if repo_meta.get("allow_rebase_merge"):
        return "rebase"
    return None


def _is_bot_author(comment: dict[str, Any]) -> bool:
    author = comment.get("author") or {}
    login = str(author.get("login") or "").lower()
    if not login:
        return False
    return login.endswith("[bot]") or login in {"dependabot", "app/dependabot"}


def has_recent_rebase_comment(pr: dict[str, Any]) -> bool:
    comments = pr.get("comments") or []
    if not comments:
        return False
    commits = pr.get("commits") or []
    latest_commit_at = ""
    for commit in commits:
        ts = str(commit.get("committedDate") or "")
        if ts > latest_commit_at:
            latest_commit_at = ts

    for comment in comments:
        if _is_bot_author(comment):
            continue
        body = str(comment.get("body") or "")
        created_at = str(comment.get("createdAt") or "")
        if REBASE_COMMAND_LINE_RE.search(body):
            if not latest_commit_at or created_at >= latest_commit_at:
                return True
    return False


def fetch_requires_status_checks(
    repo: str,
    branch: str,
    *,
    runner: Runner = default_runner,
    timeout: int = DEFAULT_TIMEOUT,
    retry_delay: float = DEFAULT_RETRY_DELAY,
) -> bool:
    encoded_branch = quote(branch, safe="")
    try:
        rules = run_gh_json(
            ["api", f"repos/{repo}/rules/branches/{encoded_branch}"],
            runner=runner,
            timeout=timeout,
            retry_delay=retry_delay,
        )
        if isinstance(rules, list):
            for rule in rules:
                if not isinstance(rule, dict):
                    continue
                if rule.get("type") == "required_status_checks":
                    params = rule.get("parameters") or {}
                    if params.get("required_status_checks"):
                        return True
    except RuntimeError:
        pass

    try:
        protection = run_gh_json(
            ["api", f"repos/{repo}/branches/{encoded_branch}/protection/required_status_checks"],
            runner=runner,
            timeout=timeout,
            retry_delay=retry_delay,
        )
        if isinstance(protection, dict):
            if protection.get("contexts") or protection.get("checks"):
                return True
    except RuntimeError:
        pass

    return False


def classify_pr(
    pr: dict[str, Any],
    repo_meta: dict[str, Any],
    *,
    requires_status_checks: bool = False,
) -> dict[str, Any]:
    files = [str(f.get("path") or "") for f in (pr.get("files") or []) if f.get("path")]
    labels = [str(l.get("name") or "") for l in (pr.get("labels") or []) if l.get("name")]
    title = str(pr.get("title") or "")
    body = str(pr.get("body") or "")
    checks = classify_checks(pr.get("statusCheckRollup"))
    major_bumps = detect_major_bumps(title, body, files, labels)

    mergeable = str(pr.get("mergeable") or "UNKNOWN").upper()
    merge_state = str(pr.get("mergeStateStatus") or "UNKNOWN").upper()
    review_decision = str(pr.get("reviewDecision") or "").upper()
    is_draft = bool(pr.get("isDraft"))
    auto_merge_enabled = pr.get("autoMergeRequest") is not None

    if is_draft:
        action = "skip_draft"
        reason = "PR is a draft"
    elif checks["state"] == "failed":
        action = "failing_checks"
        failed_names = ", ".join(item["name"] for item in checks["failed"])
        reason = f"failing checks: {failed_names}"
    elif major_bumps:
        action = "major_bump"
        reason = f"major version bump: {', '.join(major_bumps)}"
    elif review_decision in {"CHANGES_REQUESTED", "REVIEW_REQUIRED"}:
        action = "blocked"
        reason = f"blocked by reviewDecision={review_decision}"
    elif mergeable == "CONFLICTING" or merge_state == "DIRTY":
        action = "conflicting"
        reason = "merge conflict with base branch"
    elif checks["state"] == "pending":
        action = "pending_checks"
        reason = f"checks still running: {', '.join(checks['pending'])}"
    elif checks["state"] == "none":
        action = "no_ci"
        reason = "no passing CI checks reported on PR"
    elif merge_state == "BEHIND":
        action = "update_branch"
        reason = "checks passed but branch is BEHIND base"
    elif merge_state == "BLOCKED":
        action = "blocked"
        reason = f"blocked (mergeStateStatus={merge_state}, reviewDecision={review_decision or 'NONE'})"
    elif checks["state"] == "passed" and mergeable == "MERGEABLE" and merge_state in {"CLEAN", "HAS_HOOKS"}:
        action = "ready_to_merge"
        reason = f"all {checks['passedCount']} checks passed and PR is {merge_state}"
    else:
        action = "needs_review"
        reason = f"unhandled state (mergeable={mergeable}, mergeStateStatus={merge_state})"

    return {
        "repo": str(repo_meta.get("full_name") or ""),
        "number": int(pr["number"]),
        "title": title,
        "url": str(pr.get("url") or ""),
        "headRefOid": str(pr.get("headRefOid") or ""),
        "baseRefName": str(pr.get("baseRefName") or repo_meta.get("default_branch") or "main"),
        "action": action,
        "reason": reason,
        "mergeMethod": choose_merge_method(repo_meta),
        "allowAutoMerge": bool(repo_meta.get("allow_auto_merge")),
        "requiresStatusChecks": requires_status_checks,
        "autoMergeEnabled": auto_merge_enabled,
        "mergeable": mergeable,
        "mergeStateStatus": merge_state,
        "reviewDecision": review_decision,
        "majorBumps": major_bumps,
        "checks": checks,
        "files": files,
        "alreadyRebased": has_recent_rebase_comment(pr),
    }


def fetch_pr_details(
    repo: str,
    number: int,
    *,
    runner: Runner = default_runner,
    timeout: int = DEFAULT_TIMEOUT,
    retry_delay: float = DEFAULT_RETRY_DELAY,
) -> dict[str, Any]:
    fields = (
        "number,title,url,headRefOid,baseRefName,isDraft,mergeable,mergeStateStatus,"
        "reviewDecision,autoMergeRequest,statusCheckRollup,body,files,labels,comments,commits"
    )
    args = ["pr", "view", str(number), "-R", repo, "--json", fields]
    data = run_gh_json(args, runner=runner, timeout=timeout, retry_delay=retry_delay)
    if not isinstance(data, dict):
        raise RuntimeError(f"Unexpected gh pr view payload for {repo}#{number}")

    if (
        retry_delay > 0
        and str(data.get("mergeable") or "").upper() == "UNKNOWN"
        and not data.get("isDraft")
    ):
        time.sleep(retry_delay)
        refreshed = run_gh_json(args, runner=runner, timeout=timeout, retry_delay=retry_delay)
        if isinstance(refreshed, dict):
            data = refreshed
    return data


def build_plan(
    owner: str,
    *,
    runner: Runner = default_runner,
    timeout: int = DEFAULT_TIMEOUT,
    retry_delay: float = DEFAULT_RETRY_DELAY,
) -> dict[str, Any]:
    search_args = [
        "search",
        "prs",
        "--state",
        "open",
        "--author",
        "app/dependabot",
        "--owner",
        owner,
        "--archived=false",
        "--limit",
        str(SEARCH_LIMIT),
        "--json",
        "repository,number,title,url,isDraft",
    ]
    raw_prs = run_gh_json(search_args, runner=runner, timeout=timeout, retry_delay=retry_delay)
    if raw_prs is None:
        raw_prs = []
    if not isinstance(raw_prs, list):
        raise RuntimeError("Unexpected gh search prs response")

    repo_cache: dict[str, dict[str, Any]] = {}
    branch_checks_cache: dict[tuple[str, str], bool] = {}
    archived_repos: dict[str, int] = Counter()
    items: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    if len(raw_prs) >= SEARCH_LIMIT:
        errors.append(
            {
                "target": f"owner:{owner}",
                "error": f"gh search prs returned {len(raw_prs)} results (limit {SEARCH_LIMIT}); results may be truncated",
            }
        )

    for entry in raw_prs:
        repo_info = entry.get("repository") or {}
        repo = str(repo_info.get("nameWithOwner") or "")
        number = int(entry["number"])
        if not repo:
            errors.append({"target": f"#{number}", "error": "missing repository.nameWithOwner"})
            continue

        if repo not in repo_cache:
            try:
                meta = run_gh_json(
                    ["api", f"repos/{repo}"],
                    runner=runner,
                    timeout=timeout,
                    retry_delay=retry_delay,
                )
                if not isinstance(meta, dict):
                    raise RuntimeError("unexpected repo metadata")
                repo_cache[repo] = meta
            except Exception as exc:
                errors.append({"target": repo, "error": str(exc)})
                repo_cache[repo] = {"_error": True}
                continue

        meta = repo_cache[repo]
        if meta.get("_error"):
            continue
        if meta.get("archived"):
            archived_repos[repo] += 1
            continue

        try:
            detail = fetch_pr_details(
                repo,
                number,
                runner=runner,
                timeout=timeout,
                retry_delay=retry_delay,
            )
            base_branch = str(detail.get("baseRefName") or meta.get("default_branch") or "main")
            branch_key = (repo, base_branch)
            if branch_key not in branch_checks_cache:
                branch_checks_cache[branch_key] = fetch_requires_status_checks(
                    repo,
                    base_branch,
                    runner=runner,
                    timeout=timeout,
                    retry_delay=retry_delay,
                )
            items.append(
                classify_pr(
                    detail,
                    meta,
                    requires_status_checks=branch_checks_cache[branch_key],
                )
            )
        except Exception as exc:
            errors.append({"target": f"{repo}#{number}", "error": str(exc)})

    items.sort(key=lambda item: (item["repo"], item["number"]))
    counts = dict(sorted(Counter(item["action"] for item in items).items()))

    return {
        "owner": owner,
        "activePrCount": len(items),
        "archivedSkippedCount": sum(archived_repos.values()),
        "archivedRepos": dict(sorted(archived_repos.items())),
        "counts": counts,
        "prs": items,
        "errors": errors,
    }


def append_log(log_path: Path, phase: str, plan: dict[str, Any]) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "phase": phase,
        "owner": plan["owner"],
        "activePrCount": plan["activePrCount"],
        "archivedSkippedCount": plan["archivedSkippedCount"],
        "counts": plan["counts"],
        "prs": [
            {
                "repo": item["repo"],
                "number": item["number"],
                "action": item["action"],
                "headRefOid": item["headRefOid"],
                "majorBumps": item["majorBumps"],
                "failedChecks": [c["name"] for c in item["checks"]["failed"]],
            }
            for item in plan["prs"]
        ],
        "errors": plan["errors"],
    }
    with log_path.open("a", encoding="utf-8") as log:
        log.write(json.dumps(record) + "\n")


def format_text(plan: dict[str, Any]) -> str:
    lines = [
        f"Dependabot sweep ({plan['owner']}): {plan['activePrCount']} active PR(s), "
        f"{plan['archivedSkippedCount']} archived PR(s) skipped"
    ]
    if plan["counts"]:
        summary = ", ".join(f"{action}={count}" for action, count in plan["counts"].items())
        lines.append(f"Counts: {summary}")
    for item in plan["prs"]:
        sha = item["headRefOid"][:10] if item["headRefOid"] else "unknown"
        lines.append(
            f"- [{item['action']}] {item['repo']}#{item['number']} ({sha}): "
            f"{item['title']} -- {item['reason']}"
        )
    for err in plan["errors"]:
        lines.append(f"error: {err['target']}: {err['error']}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--owner", default=DEFAULT_OWNER, help="GitHub owner to sweep")
    parser.add_argument("--phase", default="plan", help="label for log entries (plan or verify)")
    parser.add_argument("--log", type=Path, help="append a JSON line per call to this file")
    parser.add_argument("--json", action="store_true", dest="as_json", help="print full JSON plan")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="per-gh-call timeout in seconds")
    parser.add_argument(
        "--retry-delay",
        type=float,
        default=DEFAULT_RETRY_DELAY,
        help="seconds to wait before re-querying UNKNOWN mergeability or transient errors (0 to disable)",
    )
    args = parser.parse_args(argv)

    try:
        plan = build_plan(
            args.owner,
            timeout=args.timeout,
            retry_delay=args.retry_delay,
        )
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.log is not None:
        append_log(args.log, args.phase, plan)

    if args.as_json:
        print(json.dumps(plan, indent=2))
    else:
        print(format_text(plan))

    return 1 if plan["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
