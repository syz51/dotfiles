# Delegation, PR Merging, Diff Review & T3 Settle Reference

These rules are part of the global instructions (`~/.gemini/config/GEMINI.md`, Workflow, Autonomy, Delegation, and Review sections) and have the same force. Read this file before spawning subagents/delegates, running a restricted-session diff review, merging a PR (`gh pr merge`), or settling a T3 thread.

## Antigravity Orchestration & Subagents

- Use Antigravity's native orchestration stack and T3 Code threads:
  - `invoke_subagent` (`TypeName: "research"`): parallel read-only exploration (no shell/network; use `self` when read-only shell commands such as `git` are needed).
  - `invoke_subagent` (`TypeName: "self"`, `Workspace: "inherit"` for read-only tracks or `"share"`/`"branch"` for edits): in-process background tracks (uses no extra T3 turn slot). In `full-access` T3 threads (`--dangerously-skip-permissions`), `self` runs `run_command` and out-of-workspace `read_file` cleanly; in restricted sessions without skip-permissions, fall back to `delegate_task` or `~/.local/bin/agy-run` if `run_command` hits a permission timeout.
  - `define_subagent`: custom scoped roles when needed on the fly.
  - `run_workflow` (read the `run-workflow` skill first): code-orchestrated Python fan-out/fan-in or staged pipelines across many files, modules, or review angles.
  - `/swarm` (`swarm` tool): only when the user explicitly invokes `/swarm`.
  - T3 `delegate_task` / `t3_thread_launch`: separate full T3 threads with their own git worktrees, independent PR lifecycles, or cross-repository work.
- Split work by context and ownership, not by phase handoffs (do not pass one small area's research from one agent to another to edit). Keep subagent prompts lean: pass paths, commit ranges, or skill paths instead of pasting large files, diffs, or skill text the child can read or `git diff` directly, and kill finished subagents (`manage_subagents`) once integrated. Give each editing track its own isolated workspace/worktree, transfer any required uncommitted inputs explicitly, integrate its changes and clean up afterward, and never let two tracks (or you and a track) modify the same files simultaneously. To continue a branch that another worktree already has checked out, work on a local branch started from `origin/<branch>` and push to `<branch>`; brief children the same way. Keep cross-track planning, judgment, verification, and subagent board-filing yourself.

## T3 Delegation Rules

- Always pass a `t3_thread_launch` brief in `message`; T3 silently drops a `prompt` key and starts no run (if `runId` comes back null, send the brief with `t3_thread_send`).
- Omit `target.projectId` on local `delegate_task` calls (T3 rejects another project's id). To dispatch a board task whose code lives in another repository, call `t3_thread_launch` with that project's `projectId` and `workspaceStrategy: {type: "worktree", baseRef: "origin/<default branch>", startFromOrigin: true}` so it opens its own PR there. Dispatching a board task counts as standing authorization; found work in another repo still becomes a proposal.

## Diff Review Execution (Interactive Sessions)

- Daemon-dispatched managed workers are exempt from spawning an internal `diff-review` subagent because their PR always receives an independent managed `Review` judge (one independent LLM code review per PR instead of two).
- In interactive / human-driven sessions, commit the final diff, then launch one background read-only subagent to review `origin/<base>...<SHA>` using the `diff-review` skill (`~/.gemini/config/skills/diff-review/SKILL.md`; lines, removed behavior, callers/callees, security/data, rules, tests/docs, cleanup; returning typed JSON).
- In `full-access` T3 threads (`--dangerously-skip-permissions`), launch `invoke_subagent` (`TypeName: "self"`, `Workspace: "inherit"`, strictly read-only) and have it read `~/.gemini/config/skills/diff-review/SKILL.md` and run `git -C <worktree> diff origin/<base>...<SHA>` itself — do not duplicate the diff or skill text into the parent prompt or write temp diff files.
- In restricted sessions without skip-permissions, inline the `diff-review` instructions and stage the diff in a temporary file inside the active workspace (cleaned up afterward) for a `read_file`-only `research` subagent, or use `delegate_task` / `~/.local/bin/agy-run`.
- While it runs, continue unblocked work that leaves that diff alone or answer messages, but do not push or report done until its findings are handled. Cancel and restart it only if the diff changes mid-review.
- Verify each finding against the code before deciding: fix every real defect within what the change is meant to do and rerun the affected checks (never run a second review after fixes); file real out-of-scope defects on the board (or report where there is no board) instead of fixing them; report rejected false positives with reasons in your reply.

## Merging Pull Requests

- The `guard-pr-merge` hook refuses `gh pr merge` with `--admin`, on a draft, or before every check on the head commit has passed (except `--auto` where the base branch requires checks). It also waits for each always-on `pull_request`/`pull_request_target` workflow and CircleCI (where `.circleci/config.yml` exists unless every workflow is statically gated off by default), passing only when no CI is configured.
- Pin every direct merge to the checked head commit: `gh pr merge <number> --match-head-commit <SHA>` (GitHub rejects if a newer commit was pushed). An `--auto` merge where the base branch requires checks needs no pin.
- Before acting on a PR watch notice, compare its commit with `gh pr view <number> --json headRefOid,state` (notices can be for an old head or an already-merged PR).
- When a PR is `BEHIND` a base branch that requires checks, run `gh pr update-branch`, then as a separate command `gh pr merge --auto` with a merge-method flag, and watch with `watch_pull_request`. Auto-merge can lag a minute or two after checks pass; if the PR still sits `CLEAN`, merge directly.
- After `gh pr create`, the `auto-merge` hook enables auto-merge on eligible `syz51` repositories (non-draft PRs whose base branch requires checks or reviews). It skips PRs that can merge immediately — merge those yourself once checks pass — and reports any failure so you can enable auto-merge yourself.

## Settling a T3 Thread

- Before finishing a T3 thread, review the session and file anything unreported (each item once, naming each id in your reply or stating none; `invoke_subagent` subagents report to their parent instead):
  - Setup friction (tools, hooks, instructions, or workarounds): `feedback` tool or `board feedback`.
  - Missing setup/workflow tools or guards: search the board first, add a note if covered, else file a `Proposal:` (out-of-scope code bugs follow the Work board `Proposal:` rules).
- Settle the thread as a separate final step *after* `task_done` and other board calls have returned and been handled (never in the same tool batch). Call `t3_thread_organize` with `action: "settle"` (no `threadId`) only when nothing remains to do, track, or file, every open item in your reply names its task or ask id, and nothing waits on the thread (no running job, open PR to merge or fix, owned task in `doing`, unanswered question/ask, or report item needing user action). Mention that you settled it. If more work turns up, call `action: "unsettle"`. A brief or routine with its own settle rule overrides this. Board coordinators and `invoke_subagent` subagents never settle themselves; `delegate_task` and `t3_thread_launch` threads do.
