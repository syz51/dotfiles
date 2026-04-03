---
name: codex-doctor
description: Use this skill to diagnose local Codex configuration issues, skill discovery problems, stale backups, duplicated skill roots, and legacy drift between ~/.codex, ~/.agents, and the checked-in ~/.config/codex backup. It reports issues first and only applies fixes after confirmation.
argument-hint: "[--fix]"
---

# Codex Doctor

Use this skill to audit the local Codex setup before changing it.

## What To Check

1. Core config health
   - `~/.codex/config.toml`
   - `~/.codex/AGENTS.md`
   - current trust and feature flags
2. Skill discovery roots
   - `~/.codex/skills`
   - `~/.agents/skills`
   - duplicate or overlapping skill names
3. Backup drift
   - compare live files in `~/.codex` with checked-in copies under `~/.config/codex`
4. Local custom skill health
   - missing `SKILL.md`
   - malformed frontmatter
   - dead references to scripts or files
5. Legacy or confusing state
   - stale disabled skill entries
   - outdated references to moved files
   - conflicting instructions between global AGENTS copies

## Workflow

1. Inspect first, do not mutate.
2. Report findings by severity:
   - critical
   - warning
   - note
3. Include exact paths and the smallest useful fix.
4. If `--fix` is requested or the user confirms, apply only the reversible fixes that were explicitly listed.

## Good Fixes

- create missing directories
- sync stale backup copies after confirmation
- remove broken skill entries from config
- repair malformed frontmatter
- update dead local references

## Do Not Auto-Fix

- destructive cleanup of user files
- deleting custom skills without confirmation
- changing trust levels without confirmation
- enabling or disabling a skill unless the user asked

## Report Format

- summary
- findings by severity
- exact paths
- recommended fixes
- optional fix plan if mutation is requested
