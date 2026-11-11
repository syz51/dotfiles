# Merging pull requests

These rules are part of the global instructions (`~/.claude/CLAUDE.md`, Autonomy section) and have the same force. That section gives the authorization to merge; read these before a `gh pr merge`.

- The guard-pr-merge hook refuses a `gh pr merge` with `--admin`, on a draft, or before every check on the head commit has passed, except `--auto` where GitHub waits for the base branch's required checks. An Actions job that GitHub never started for billing counts as passed when a non-Actions check named `<context>: <job name>` passed.
- When a pull request is BEHIND a base branch that requires checks, run `gh pr update-branch`, then, as a separate command, `gh pr merge --auto` with a merge-method flag, and watch the pull request instead of waiting for each run by hand; update the branch again whenever it falls behind. Auto-merge can lag a minute or two after the checks pass; if the pull request then still sits at CLEAN, merge it directly.
