import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "dependabot_sweep.py"
spec = importlib.util.spec_from_file_location("dependabot_sweep", SCRIPT)
ds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ds)


def make_repo(
    name: str,
    *,
    archived: bool = False,
    squash: bool = True,
    merge: bool = False,
    rebase: bool = False,
    auto_merge: bool = True,
) -> dict:
    return {
        "full_name": name,
        "archived": archived,
        "default_branch": "main",
        "allow_squash_merge": squash,
        "allow_merge_commit": merge,
        "allow_rebase_merge": rebase,
        "allow_auto_merge": auto_merge,
    }


def make_pr(
    number: int = 1,
    *,
    title: str = "Bump foo from 1.2.3 to 1.3.0",
    body: str = "",
    head: str = "abc1234567890",
    draft: bool = False,
    mergeable: str = "MERGEABLE",
    merge_state: str = "CLEAN",
    review_decision: str = "",
    auto_merge: dict | None = None,
    checks: list[dict] | None = None,
    files: list[str] | None = None,
    labels: list[str] | None = None,
    comments: list[dict] | None = None,
    commits: list[dict] | None = None,
) -> dict:
    return {
        "number": number,
        "title": title,
        "url": f"https://github.com/syz51/demo/pull/{number}",
        "headRefOid": head,
        "baseRefName": "main",
        "isDraft": draft,
        "mergeable": mergeable,
        "mergeStateStatus": merge_state,
        "reviewDecision": review_decision,
        "autoMergeRequest": auto_merge,
        "statusCheckRollup": checks if checks is not None else [{"name": "ci", "status": "COMPLETED", "conclusion": "SUCCESS"}],
        "body": body,
        "files": [{"path": p} for p in (files or ["package.json"])],
        "labels": [{"name": l} for l in (labels or ["dependencies"])],
        "comments": comments or [],
        "commits": commits or [{"committedDate": "2026-11-20T00:00:00Z"}],
    }


class VersionDetectionTests(unittest.TestCase):
    def test_parse_version_variants(self):
        self.assertEqual(ds.parse_version("1.99.1-slim-bookworm"), (1, 99, 1))
        self.assertEqual(ds.parse_version("1.2.1+spec-1.1.0"), (1, 2, 1))
        self.assertEqual(ds.parse_version("v6"), (6, 0, 0))
        self.assertEqual(ds.parse_version("^2.0"), (2, 0, 0))
        self.assertEqual(ds.parse_version(">=1.4.2"), (1, 4, 2))
        self.assertIsNone(ds.parse_version("latest"))

    def test_single_major_bump_from_title(self):
        majors = ds.detect_major_bumps(
            "build(deps-dev): bump typescript from 6.0.3 to 7.0.2 in /web",
            "",
            ["web/package.json"],
            ["dependencies", "javascript"],
        )
        self.assertEqual(majors, ["typescript: 6.0.3 -> 7.0.2"])

    def test_requirement_and_range_prefix_major_bump(self):
        majors = ds.detect_major_bumps(
            "Bump reqwest requirement from 0.12 to 0.13",
            "Updates the requirements on reqwest to permit the latest version.",
            ["Cargo.toml"],
            ["dependencies", "rust"],
        )
        self.assertEqual(majors, ["reqwest: 0.12 -> 0.13"])

        js_majors = ds.detect_major_bumps(
            "Bump foo requirement from ^1.0 to ^2.0",
            "",
            ["package.json"],
            ["dependencies"],
        )
        self.assertEqual(js_majors, ["foo: ^1.0 -> ^2.0"])

    def test_minor_and_patch_not_major(self):
        majors = ds.detect_major_bumps(
            "build(deps): bump rust from 1.99.1-slim-bookworm to 1.100.0-slim-bookworm",
            "",
            ["Dockerfile"],
            ["dependencies", "docker"],
        )
        self.assertEqual(majors, [])

    def test_grouped_body_table_and_updates_line_detect_major(self):
        body = (
            "Bumps the web group:\n\n"
            "| Package | From | To |\n"
            "| --- | --- | --- |\n"
            "| [react](https://example.com) | `19.2.0` | `19.3.1` |\n"
            "| [vite](https://example.com) | `6.4.0` | `7.0.0` |\n"
            "\nUpdates `eslint` from 9.1.0 to 10.0.0\n"
        )
        majors = ds.detect_major_bumps(
            "build(deps): bump the web group across 1 directory with 3 updates",
            body,
            ["web/package.json"],
            ["dependencies"],
        )
        self.assertEqual(majors, ["eslint: 9.1.0 -> 10.0.0", "vite: 6.4.0 -> 7.0.0"])

    def test_cargo_zero_x_minor_is_major_but_patch_is_not(self):
        body = (
            "Updates `signal-hook` from 0.4.5 to 0.4.6\n"
            "Updates `reqwest` from 0.12.9 to 0.13.0\n"
        )
        majors = ds.detect_major_bumps(
            "Bump the rust-dependencies group across 1 directory with 2 updates",
            body,
            ["Cargo.lock"],
            ["dependencies", "rust"],
        )
        self.assertEqual(majors, ["reqwest: 0.12.9 -> 0.13.0"])


class ClassificationTests(unittest.TestCase):
    def test_ready_to_merge_clean_with_benign_neutral_skipped_and_stale(self):
        repo = make_repo("syz51/demo")
        pr = make_pr(
            checks=[
                {"name": "rust", "status": "COMPLETED", "conclusion": "SUCCESS"},
                {"name": "CodeQL", "status": "COMPLETED", "conclusion": "NEUTRAL"},
                {"name": "image", "status": "COMPLETED", "conclusion": "SKIPPED"},
                {"name": "old-job", "status": "COMPLETED", "conclusion": "STALE"},
            ]
        )
        result = ds.classify_pr(pr, repo, requires_status_checks=True)
        self.assertEqual(result["action"], "ready_to_merge")
        self.assertEqual(result["mergeMethod"], "squash")
        self.assertTrue(result["requiresStatusChecks"])

    def test_rerun_success_supersedes_older_failure(self):
        repo = make_repo("syz51/demo")
        pr = make_pr(
            checks=[
                {
                    "workflowName": "CI",
                    "name": "test",
                    "status": "COMPLETED",
                    "conclusion": "FAILURE",
                    "completedAt": "2026-11-20T00:01:00Z",
                },
                {
                    "workflowName": "CI",
                    "name": "test",
                    "status": "COMPLETED",
                    "conclusion": "SUCCESS",
                    "completedAt": "2026-11-20T00:05:00Z",
                },
            ]
        )
        result = ds.classify_pr(pr, repo)
        self.assertEqual(result["action"], "ready_to_merge")
        self.assertEqual(result["checks"]["passedCount"], 1)
        self.assertEqual(result["checks"]["failed"], [])

    def test_queued_rerun_supersedes_older_passing_run(self):
        repo = make_repo("syz51/demo")
        completed = {
            "workflowName": "CI",
            "name": "test",
            "status": "COMPLETED",
            "conclusion": "SUCCESS",
            "startedAt": "2026-11-20T00:01:00Z",
            "completedAt": "2026-11-20T00:05:00Z",
        }
        for queued in (
            {
                "workflowName": "CI",
                "name": "test",
                "status": "QUEUED",
                "conclusion": "",
                "startedAt": None,
                "completedAt": None,
            },
            {
                "workflowName": "CI",
                "name": "test",
                "status": "QUEUED",
                "conclusion": "",
                "startedAt": "0001-01-01T00:00:00Z",
                "completedAt": "0001-01-01T00:00:00Z",
            },
            {
                "workflowName": "CI",
                "name": "test",
                "status": "IN_PROGRESS",
                "conclusion": "",
                "startedAt": "2026-11-20T00:04:00Z",
                "completedAt": "0001-01-01T00:00:00Z",
            },
        ):
            for order in ([completed, queued], [queued, completed]):
                with self.subTest(queued=queued, reversed=order[0] is queued):
                    result = ds.classify_pr(make_pr(checks=order), repo)
                    self.assertEqual(result["action"], "pending_checks")
                    self.assertEqual(result["checks"]["state"], "pending")
                    self.assertEqual(result["checks"]["pending"], ["test"])
                    self.assertEqual(result["checks"]["passedCount"], 0)
                    self.assertEqual(result["checks"]["failed"], [])

    def test_queued_rerun_supersedes_older_failing_run(self):
        repo = make_repo("syz51/demo")
        failed = {
            "workflowName": "CI",
            "name": "test",
            "status": "COMPLETED",
            "conclusion": "FAILURE",
            "startedAt": "2026-11-20T00:01:00Z",
            "completedAt": "2026-11-20T00:05:00Z",
        }
        for queued in (
            {
                "workflowName": "CI",
                "name": "test",
                "status": "QUEUED",
                "conclusion": "",
                "startedAt": None,
                "completedAt": None,
            },
            {
                "workflowName": "CI",
                "name": "test",
                "status": "QUEUED",
                "conclusion": "",
                "startedAt": "0001-01-01T00:00:00Z",
                "completedAt": "0001-01-01T00:00:00Z",
            },
            {
                "workflowName": "CI",
                "name": "test",
                "status": "IN_PROGRESS",
                "conclusion": "",
                "startedAt": "2026-11-20T00:06:00Z",
                "completedAt": "0001-01-01T00:00:00Z",
            },
        ):
            for order in ([failed, queued], [queued, failed]):
                with self.subTest(queued=queued, reversed=order[0] is queued):
                    result = ds.classify_pr(make_pr(checks=order), repo)
                    self.assertEqual(result["action"], "pending_checks")
                    self.assertEqual(result["checks"]["state"], "pending")
                    self.assertEqual(result["checks"]["pending"], ["test"])
                    self.assertEqual(result["checks"]["failed"], [])

    def test_completed_run_with_zero_completed_at_falls_back_to_started_at(self):
        repo = make_repo("syz51/demo")
        pr = make_pr(
            checks=[
                {
                    "workflowName": "CI",
                    "name": "test",
                    "status": "COMPLETED",
                    "conclusion": "FAILURE",
                    "startedAt": "2026-11-20T00:01:00Z",
                    "completedAt": "2026-11-20T00:02:00Z",
                },
                {
                    "workflowName": "CI",
                    "name": "test",
                    "status": "COMPLETED",
                    "conclusion": "SUCCESS",
                    "startedAt": "2026-11-20T00:05:00Z",
                    "completedAt": "0001-01-01T00:00:00Z",
                },
            ]
        )
        result = ds.classify_pr(pr, repo)
        self.assertEqual(result["action"], "ready_to_merge")
        self.assertEqual(result["checks"]["passedCount"], 1)
        self.assertEqual(result["checks"]["failed"], [])

    def test_update_branch_when_behind_and_green(self):
        repo = make_repo("syz51/demo")
        pr = make_pr(merge_state="BEHIND")
        result = ds.classify_pr(pr, repo)
        self.assertEqual(result["action"], "update_branch")

    def test_changes_requested_takes_precedence_over_behind(self):
        repo = make_repo("syz51/demo")
        pr = make_pr(merge_state="BEHIND", review_decision="CHANGES_REQUESTED")
        result = ds.classify_pr(pr, repo)
        self.assertEqual(result["action"], "blocked")

    def test_conflicting_with_no_ci_is_conflicting_not_no_ci(self):
        repo = make_repo("syz51/demo")
        pr = make_pr(checks=[], mergeable="CONFLICTING", merge_state="DIRTY")
        result = ds.classify_pr(pr, repo)
        self.assertEqual(result["action"], "conflicting")

    def test_failing_checks_takes_precedence_over_major_and_behind(self):
        repo = make_repo("syz51/demo")
        pr = make_pr(
            title="Bump typescript from 6.0.3 to 7.0.2",
            merge_state="BEHIND",
            checks=[
                {"name": "rust", "status": "COMPLETED", "conclusion": "SUCCESS"},
                {"name": "web", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://example.com/runs/42"},
            ],
        )
        result = ds.classify_pr(pr, repo)
        self.assertEqual(result["action"], "failing_checks")
        self.assertEqual(result["majorBumps"], ["typescript: 6.0.3 -> 7.0.2"])
        self.assertEqual(result["checks"]["failed"][0]["name"], "web")

    def test_green_major_bump_is_not_ready_to_merge(self):
        repo = make_repo("syz51/demo")
        pr = make_pr(title="Bump actions/checkout from 6.0.2 to 7.0.0")
        result = ds.classify_pr(pr, repo)
        self.assertEqual(result["action"], "major_bump")

    def test_no_ci_is_not_auto_merged(self):
        repo = make_repo("syz51/demo")
        pr = make_pr(checks=[])
        result = ds.classify_pr(pr, repo)
        self.assertEqual(result["action"], "no_ci")

    def test_pending_checks_detected(self):
        repo = make_repo("syz51/demo")
        pr = make_pr(checks=[{"name": "ci", "status": "IN_PROGRESS", "conclusion": ""}])
        result = ds.classify_pr(pr, repo)
        self.assertEqual(result["action"], "pending_checks")

    def test_conflicting_and_recent_rebase_ignores_bots_and_inline_prose(self):
        repo = make_repo("syz51/demo")
        # Bot comment or inline prose must not count as a rebase command.
        prose_pr = make_pr(
            mergeable="CONFLICTING",
            merge_state="DIRTY",
            comments=[
                {"author": {"login": "dependabot[bot]"}, "body": "@dependabot rebase", "createdAt": "2026-11-21T00:00:00Z"},
                {"author": {"login": "syz51"}, "body": "You can comment `@dependabot rebase` later.", "createdAt": "2026-11-21T01:00:00Z"},
            ],
            commits=[{"committedDate": "2026-11-20T00:00:00Z"}],
        )
        self.assertFalse(ds.classify_pr(prose_pr, repo)["alreadyRebased"])

        cmd_pr = make_pr(
            mergeable="CONFLICTING",
            merge_state="DIRTY",
            comments=[
                {"author": {"login": "syz51"}, "body": "@dependabot rebase\n", "createdAt": "2026-11-21T00:00:00Z"},
            ],
            commits=[{"committedDate": "2026-11-20T00:00:00Z"}],
        )
        result = ds.classify_pr(cmd_pr, repo)
        self.assertEqual(result["action"], "conflicting")
        self.assertTrue(result["alreadyRebased"])

    def test_blocked_and_draft(self):
        repo = make_repo("syz51/demo", squash=False, merge=True)
        blocked = ds.classify_pr(make_pr(merge_state="BLOCKED"), repo)
        self.assertEqual(blocked["action"], "blocked")
        self.assertEqual(blocked["mergeMethod"], "merge")
        draft = ds.classify_pr(make_pr(draft=True), repo)
        self.assertEqual(draft["action"], "skip_draft")


class PlanAndCliTests(unittest.TestCase):
    def test_build_plan_skips_archived_checks_rules_and_logs(self):
        calls: list[list[str]] = []

        def fake_runner(cmd: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
            calls.append(cmd)
            if cmd[:3] == ["gh", "search", "prs"]:
                self.assertIn("--archived=false", cmd)
                payload = [
                    {"repository": {"nameWithOwner": "syz51/old"}, "number": 1, "title": "Bump a from 1.0.0 to 1.0.1", "url": "u1", "isDraft": False},
                    {"repository": {"nameWithOwner": "syz51/active"}, "number": 19, "title": "Bump b from 3.3.0 to 3.4.0", "url": "u2", "isDraft": False},
                ]
            elif cmd == ["gh", "api", "repos/syz51/old"]:
                payload = make_repo("syz51/old", archived=True)
            elif cmd == ["gh", "api", "repos/syz51/active"]:
                payload = make_repo("syz51/active", archived=False)
            elif cmd[:4] == ["gh", "pr", "view", "19"]:
                payload = make_pr(19, title="Bump b from 3.3.0 to 3.4.0")
            elif cmd == ["gh", "api", "repos/syz51/active/rules/branches/main"]:
                payload = [
                    {
                        "type": "required_status_checks",
                        "parameters": {"required_status_checks": [{"context": "ci"}]},
                    }
                ]
            else:
                raise AssertionError(f"Unexpected command: {cmd}")
            return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(payload), stderr="")

        plan = ds.build_plan("syz51", runner=fake_runner, retry_delay=0)
        self.assertEqual(plan["activePrCount"], 1)
        self.assertEqual(plan["archivedSkippedCount"], 1)
        self.assertEqual(plan["archivedRepos"], {"syz51/old": 1})
        self.assertEqual(plan["counts"], {"ready_to_merge": 1})
        self.assertTrue(plan["prs"][0]["requiresStatusChecks"])
        self.assertEqual(plan["errors"], [])
        self.assertFalse(any("syz51/old" in cmd and "view" in cmd for cmd in calls))

        with tempfile.TemporaryDirectory() as tmp:
            log_file = Path(tmp) / "sweep.jsonl"
            ds.append_log(log_file, "plan", plan)
            lines = log_file.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 1)
            entry = json.loads(lines[0])
            self.assertEqual(entry["phase"], "plan")
            self.assertEqual(entry["activePrCount"], 1)
            self.assertEqual(entry["archivedSkippedCount"], 1)

    def test_search_limit_truncation_records_error(self):
        def fake_runner(cmd: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
            if cmd[:3] == ["gh", "search", "prs"]:
                payload = [
                    {"repository": {"nameWithOwner": "syz51/old"}, "number": i, "title": "t", "url": "u", "isDraft": False}
                    for i in range(ds.SEARCH_LIMIT)
                ]
                return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(payload), stderr="")
            if cmd == ["gh", "api", "repos/syz51/old"]:
                return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(make_repo("syz51/old", archived=True)), stderr="")
            raise AssertionError(f"Unexpected command: {cmd}")

        plan = ds.build_plan("syz51", runner=fake_runner, retry_delay=0)
        self.assertTrue(any("truncated" in err["error"] for err in plan["errors"]))

    def test_transient_graphql_error_retries_once(self):
        attempts = {"count": 0}

        def flaky_runner(cmd: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
            attempts["count"] += 1
            if attempts["count"] == 1:
                return subprocess.CompletedProcess(
                    cmd, 1, stdout="", stderr="GraphQL: Something went wrong while executing your query"
                )
            return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps({"ok": True}), stderr="")

        data = ds.run_gh_json(["pr", "view", "1"], runner=flaky_runner, retry_delay=0)
        self.assertEqual(data, {"ok": True})
        self.assertEqual(attempts["count"], 2)

    def test_prompt_references_script_and_log_path(self):
        prompt = (SCRIPT.parent / "dependabot-sweep.prompt.md").read_text(encoding="utf-8")
        self.assertIn("~/.config/t3code/dependabot_sweep.py", prompt)
        self.assertIn("--log ~/.local/state/t3-dependabot-sweep/sweep.jsonl", prompt)
        self.assertIn("--match-head-commit", prompt)
        self.assertIn("requiresStatusChecks", prompt)
        self.assertIn("needs_review", prompt)
        self.assertIn("t3_thread_organize", prompt)


if __name__ == "__main__":
    unittest.main()
