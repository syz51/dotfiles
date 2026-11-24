# Daily Dependabot PR check and merge across syz51 repos

Check open Dependabot pull requests across all non-archived `syz51` repositories, merge
clean green minor/patch/grouped updates, update behind branches, and inspect major bumps
or failing checks to file board proposals when code changes are needed. Follow these
steps exactly. Start no subagents.

1. Plan. Run:

   ```sh
   uv run --no-project --python 3.13 python -B ~/.config/t3code/dependabot_sweep.py \
     --log ~/.local/state/t3-dependabot-sweep/sweep.jsonl --phase plan --json
   ```

   If the command fails completely with no JSON output, stop and report the error. If it
   returns JSON with `errors`, note the errors and still process the listed PRs. If
   `activePrCount` is `0`, skip to step 6.

2. Check existing boards once by running `board boards`. Keep the map of repository names
   to board slugs so you know which repos have a work board.

3. Merge `ready_to_merge` PRs (one `gh pr merge` per shell command — never chain two
   merges or combine `update-branch` and `merge` in one shell command):
   - First, if the repo has a work board, search it (`board ls --board <slug> --search "#<number>"`).
     If an open board task already owns this PR with extra manual verification beyond CI
     (such as a smoke test), leave the PR for that task and record the task id.
   - Otherwise, merge pinned to the inspected `headRefOid` using the PR's `mergeMethod`
     (preferring `--squash`; never `--admin`):

     ```sh
     gh pr merge <number> -R <repo> --<mergeMethod> --match-head-commit <headRefOid>
     ```

   - If a repo has multiple `ready_to_merge` PRs, re-check the next PR's `mergeable` and
     `mergeStateStatus` after the first merge; if it became `BEHIND`, `DIRTY`, or
     `CONFLICTING`, handle it under step 4 instead.
   - If the repo is `syz51/codex-commit` and the merged PR updated `Cargo.lock` for the
     published crate (not xtask-only), check `board ls --board codex-commit --search "#<number>"`
     and file a `Proposal:` task for the `CHANGELOG.md` `## Unreleased` entry before the
     22:00 JST daily release.

4. Update `update_branch` and `conflicting` PRs:
   - For `update_branch` (`BEHIND` with green checks and not a major bump): run
     `gh pr update-branch <number> -R <repo>` (fall back to commenting `@dependabot rebase`
     if GitHub refuses the branch update). In a **separate** shell command afterward, ONLY
     when `allowAutoMerge` is `true`, `requiresStatusChecks` is `true`, and
     `autoMergeEnabled` is `false` (and no open board task requires extra manual
     verification), enable auto-merge:

     ```sh
     gh pr merge <number> -R <repo> --auto --<mergeMethod>
     ```

     When `requiresStatusChecks` is `false`, do not pass `--auto`; leave the updated PR
     for the next run once its checks pass.
   - For `conflicting`: if `alreadyRebased` is `false`, comment `@dependabot rebase` once
     (`gh pr comment <number> -R <repo> --body "@dependabot rebase"`). If `alreadyRebased`
     is `true`, treat it as needing manual resolution under step 5.

5. Inspect `failing_checks`, `major_bump`, `no_ci`, `blocked`, `needs_review`, and
   persistent `conflicting` PRs (never auto-merge these):
   - For `failing_checks`, inspect the failed run log tail:
     `gh run view <run_id> -R <repo> --log-failed | tail -n 60`.
   - For `major_bump`, check the PR body/release notes and CI status to identify breaking
     changes or required migrations.
   - Do not edit repository files or push code fixes from this routine.
   - If the repo has a work board:
     - Search first: `board ls --board <slug> --search "#<number>"` (and by package name if
       needed).
     - If an open task already covers this PR, add a note only if the PR state or failure
       changed meaningfully; never duplicate it.
     - Otherwise, file a proposal with `board add --board <slug> --auto false --priority p3`
       and a `Proposal:` body giving the problem, evidence (PR number, head SHA, failed
       check or breaking change), recommended change, and size (`S`/`M`/`L`).
   - If the repo has no work board, record the PR, state, and failure/major-bump summary in
     your report.
   - Leave `pending_checks` and `skip_draft` untouched and list them briefly.

6. Verify. Run:

   ```sh
   uv run --no-project --python 3.13 python -B ~/.config/t3code/dependabot_sweep.py \
     --log ~/.local/state/t3-dependabot-sweep/sweep.jsonl --phase verify
   ```

7. Report concisely (at most 12 lines): counts merged, updated/auto-merge enabled, filed on
   boards (with task ids), already tracked (with task ids), pending/skipped, and any
   errors or unboarded repos needing attention.

8. Settle. If step 1 and step 6 succeeded with no errors and no unboarded repo requires
   user action (PRs waiting on CI after `update-branch`/`@dependabot rebase` or tracked by
   a board task do not block settling), call `t3_thread_organize` with `action: "settle"`
   and no `threadId`.
