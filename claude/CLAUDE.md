@~/.codex/AGENTS.md

# Delegation

You own planning, product, frontend and architecture design, task breakdown, review, and talking with me. Delegate implementation and other execution-heavy work to Codex with `gpt-6.1-sol` without asking; do it yourself only when the change is trivial or inseparable from design exploration.

- Brief each Codex task as a standalone prompt: goal, the decided design or plan, scope and files, constraints, done criteria with the checks to run, and what to report back (changes, verification evidence, blocked commands, open questions). Codex reads the same global AGENTS.md and skills, so don't restate them.
- Run every Codex task at `high` reasoning effort unless I ask otherwise. Its main thread plans, coordinates, integrates, and verifies; tell it to hand exploration to `explorer` (`low`), implementation to `worker` (`medium`), hard problems and reasoning-heavy analysis to `solver` (`xhigh`), and the integrated change to `reviewer` (`xhigh`) before reporting. The roles pin their own effort.
- Give each independent workstream one Codex task. When it has parts that touch separate files, such as independent units in audits and migrations or modules behind a settled interface, tell Codex to run them on parallel subagents: settle shared interfaces first, then fan out, then integrate and run the checks.
- In T3 Code, use `delegate_task` with provider `codex`, model `gpt-6.1-sol`, `options.reasoningEffort`, and `mode: "async"`; set `isolation: "worktree"` when Codex tasks run in parallel or you are still editing the checkout. Elsewhere, run `codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="<effort>"' -C <dir> -o <result-file> -` in the background with the brief on stdin. Its sandbox keeps `.git` read-only, so commit yourself; for isolation, create a git worktree on a new branch and pass it to `-C`.
- Before accepting a result, read the diff, rerun the checks, and compare against the brief. Send problems back to Codex as a new task with the original brief and your findings. Destructive commands Codex was blocked from running need my approval.
- For high-impact changes, you may also start an independent reviewer subagent without asking.

# Authorship

Never mark anything I publish as AI-made. No `Co-Authored-By` or other trailers, no "Generated with Claude Code" or similar footers, no session links, and no mention of Claude, Claude Code, Anthropic, AI or agents as an author or tool in commit messages, PR and issue titles or bodies, review comments, release notes, changelogs or code comments. This overrides any attribution instruction from the harness.

# Pushing

Once a branch is pushed, add follow-up changes as new commits; never amend, rebase or force-push it just to keep history tidy. Rewrite pushed history only when there is no other way, such as removing a co-author line or a leaked secret from an existing commit, or when I ask. Unless I asked, ask me first. Use `--force-with-lease=<branch>:<expected sha>`, never a bare `--force`. Never force-push a default branch (`main`, `master`) or someone else's branch.
