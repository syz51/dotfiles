# Agent work board: plan and task list

Living work file for designing, then building, a shared work board for coding agents. Read
this first after a restart or compaction, then continue from **Next actions**. Update task
status, findings and the log as work proceeds; add newly found tasks here instead of keeping
them in conversation only.

Started 2026-11-06 from a T3 Code thread that is dedicated to this task. Part of the factory
effort (`../PLAN.md`, area 6).

**This repository is public.** The design and code can live here; board data never does.
Keep server addresses, logins, tokens, task contents and transcript text out of every
tracked file, this one included.

## Problem

Threads (Claude Code and Codex agents, inside T3 Code or standalone) that work on related
things cannot see each other's state. Today:

- A thread learns another's progress only by reading its transcript (`t3_thread_read`) or
  being sent a message (`t3_thread_send`). A parent hears about its own children only.
- Each long effort keeps its own markdown task file (for example `../PLAN.md`, 27 KB). It
  survives restarts, but status is buried in prose, it has no owners or claims, two writers
  collide, and every worktree holds its own stale copy.
- Nothing tells a thread that a new peer started in the same checkout, that a peer is
  editing files it changed, or that work it waits on finished.

## Requirements

1. **Durable working state per thread** that survives compaction, stop and restart; loading
   it is a thread's first step on resume.
2. **On-demand visibility**: any thread, or the user, can ask where an effort or a thread
   stands without reading transcripts.
3. **Awareness without asking**: a short snapshot (my tasks, the board summary) at turn
   start; alerts mid-turn only for events that affect the thread.
4. **A light agile backlog**: agents append tasks as they find them; statuses, owners,
   dependencies, done-with-evidence. No sprints, estimates or ceremonies.
5. **Claims**: a thread claims a task (and the files or area it touches) before starting;
   one claim wins.
6. **Every device**: every agent on any machine of the development setup reads and writes
   the same board. Two Macs today, more later.
7. **Vendor-neutral**: works for Claude Code, Codex and T3 Code threads, and standalone. We
   may build our own rather than depend on one runtime's feature.
8. **Private**: board contents come from conversations and stay off the public internet and
   out of this repository.
9. **Low operations** for one person: little to run, back up and upgrade.
10. **Opt-in per effort**: one-off threads skip it; threads join a board by its id.

## Components to design

Each needs a decision, the technology chosen, the alternatives considered and why.

1. **Data model**: tasks, efforts, threads, claims, notes, events; statuses and transitions.
2. **Storage and server**: where the data lives, how claims stay atomic, change feed.
3. **Network and auth**: how every device reaches it privately; agent and device identity.
4. **Agent interface**: MCP tools and a CLI, with the same operations.
5. **Runtime integration**: snapshot injection, identity, and automatic status updates for
   Claude Code, Codex and T3 Code (hooks, MCP, wrappers).
6. **Alerts**: which events reach which running thread, and how.
7. **Human view**: how the user sees the board (CLI, TUI or web).
8. **Agent rules**: the instructions in `CLAUDE.md` / `AGENTS.md` that make agents use it.
9. **Migration**: moving the factory's open items onto the board as the first real test.
10. **Testing and operations**: tests, deployment, backups, upgrades, monitoring.

## Tasks

Status: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked (say why), `[-]` deferred.

### Design (this thread)

- [x] Write down the problem, requirements and components (this file).
- [~] Research, in three parallel tracks: existing agent task tools; storage, sync and
  networking across devices; integration points in Claude Code, Codex and T3 Code.
- [ ] Design each component above in `DESIGN.md`, with technology choices and sources.
- [ ] User review of the design; record decisions below.

### Build (after the design is accepted)

- [ ] Break the accepted design into build tasks here.

## Decisions

- 2026-11-06: Design work lives in `claude/factory/board/`. Board data lives outside the
  repository.

## Open questions

- Is the VPS acceptable as the host, given it runs production apps, or should the board use
  a managed service or a separate small host?
- Do Macs need to write while offline, or is failing fast acceptable?

## Next actions

Wait for the three research tracks, then write `DESIGN.md` component by component.

## Log

- 2026-11-06: Plan written. Facts checked on this Mac: Claude Code 2.1.318 ships a task
  list shareable through `CLAUDE_CODE_TASK_LIST_ID` (not exposed to T3 sessions); Codex CLI
  0.166.0 installed; Tailscale not installed.
