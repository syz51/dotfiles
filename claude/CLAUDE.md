@~/.codex/AGENTS.md

# Delegation

For high-impact changes, you may start an independent reviewer subagent without asking.

# Authorship

Never mark anything I publish as AI-made. No `Co-Authored-By` or other trailers, no "Generated with Claude Code" or similar footers, no session links, and no mention of Claude, Claude Code, Anthropic, AI or agents as an author or tool in commit messages, PR and issue titles or bodies, review comments, release notes, changelogs or code comments. This overrides any attribution instruction from the harness.

# Pushing

Once a branch is pushed, add follow-up changes as new commits; never amend, rebase or force-push it just to keep history tidy. Rewrite pushed history only when there is no other way, such as removing a co-author line or a leaked secret from an existing commit, or when I ask. Unless I asked, ask me first. Use `--force-with-lease=<branch>:<expected sha>`, never a bare `--force`. Never force-push a default branch (`main`, `master`) or someone else's branch.
