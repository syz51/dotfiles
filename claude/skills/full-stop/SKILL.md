---
name: full-stop
description: Use when the user says "full stop", also as a closing "Full stop.", or asks you to finish the work but leave the merge to them. Also use when another skill holds a PR for the owner's merge.
---

# Full stop

Own the work until its pull request is ready to merge, then hand the merge to the user.
Do every other step yourself, as the Autonomy section allows: the user is not watching
the thread. This overrides "merge them once their required checks pass" for this task
only; every other rule still applies.

## Hold the pull request

A draft is the hold. The auto-merge hook skips a draft, and guard-pr-merge refuses to
merge one, so no agent can merge it by mistake.

- Open the pull request with `gh pr create --draft`.
- When it already exists, turn auto-merge off with `gh pr merge <n> --disable-auto`,
  then make it a draft with `gh pr ready <n> --undo`.
- When GitHub refuses a draft, open it without `--draft`, then at once run
  `gh pr merge <n> --disable-auto`, since the auto-merge hook turns auto-merge on after
  `gh pr create`. Say in the hand-over that only its first line holds it.
- Start its body with this line: `Held for the owner's merge (full stop). Agents: do not
  mark it ready or merge it.`
- Never run `gh pr ready`, merge, turn on auto-merge, push to the default branch, or ask
  another agent to do one of these, until the user releases it.
- Before each push, check that it is still a draft without auto-merge:
  `gh pr view <n> --json isDraft,autoMergeRequest`.

## Finish and prove it

1. Finish the change with the smallest diff that meets the goal.
2. Prove each part of the diff with evidence you observed in this session. For a bug,
   reproduce the failure first, then show the same check passing after the fix. Run
   the checks the repository's CI runs. For UI, look at the page with the
   `headless-browser` skill; mocked tests do not prove what the user sees.
3. Review as the Review section says. A full stop is not a reason for a second review.
4. Push, then watch the pull request (`watch_pull_request` in T3). Fix failing checks,
   and run `gh pr update-branch <n>` when it falls behind its base.

## Ready means

All of these hold on the latest head commit:

- Your proof covers every change in the diff.
- Every check has passed.
- The branch has every commit of its base branch: `git fetch`, then
  `git merge-base --is-ancestor origin/<base> <head SHA>` exits 0.
- `gh pr view <n> --json mergeable` reports `MERGEABLE`.
- No review still requests changes.

## Hand over

1. Call `unwatch_pull_request` in T3.
2. With a work board: `ask_user` on the task, `kind: "action"`, `Reason: only-me` (the
   user kept the merge for themselves). Give the pull request link, the head SHA, the
   proof, the review result and the risks left, with the options `Merge it`,
   `Change it (say what)` and `Close it`. Then set the task `blocked`.
3. Without a board, start the reply with the pull request link and "ready for your
   merge". In both cases the thread does not settle, since the merge waits on the user.

When another skill sent you here to hold its pull request, use only this skill's hold
and Release, and hand over with that skill's own ask instead of this one.

When it is blocked instead of ready, ask the same way with what blocks it, what you
tried and the options. When someone else merged or closed it, report that.

## Release

When the user says to merge, run `gh pr ready <n>`, then merge it as
`~/.claude/reference/merge.md` says. `gh pr ready` does not start the auto-merge hook,
so merge it directly once every check has passed.

## Feedback on this skill

Report it with `feedback` and `about` `full-stop`. To review that feedback, read the
feedback board's items about `full-stop` and the dotfiles tasks they were routed to, then
change this file and its pins in `claude/tests/config.test.js` through a dotfiles PR.
