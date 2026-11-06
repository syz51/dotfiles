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
11. **Text format and framing**: the shape, wording and trust framing of everything the board
    sends to agents, and the style of what agents write into it.

## Tasks

Status: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked (say why), `[-]` deferred.

### Design (this thread)

- [x] Write down the problem, requirements and components (this file).
- [x] Research, in three parallel tracks: existing agent task tools; storage, sync and
  networking across devices; integration points in Claude Code, Codex and T3 Code.
- [x] Design each component above in `DESIGN.md`, with technology choices and sources.
- [ ] User review of the design; record decisions below (`DESIGN.md`, "Decisions for the
  user").
- [x] Text format and framing research (component 11, raised by the user; delegated thread):
  `DESIGN.md` section 11 has the formats per place, the trust rule (peer free text only in
  tool results), writing conventions and the compact formats considered (TOON, BAML, MCP
  structured content and others).

### Build (after the design is accepted; phases from `DESIGN.md`)

- [ ] Spike: server with tasks, claims and events; CLI; concurrency test; deployed on the
  chosen host behind Tailscale; used from both Macs.
- [ ] Verify in the spike: Claude Code passes `CLAUDE_CODE_SESSION_ID` to stdio MCP
  children; what Codex `PreCompact` output does; T3 state database field names; Litestream
  0.5 encryption; how Codex shows MCP `structuredContent`.
- [ ] Format benchmark (`DESIGN.md` section 11): three formats × three framings on Claude
  Code and Codex, at least 20 runs per cell, with the factory's bench; uses live model
  calls, so confirm the budget with the user first.
- [ ] First version: MCP proxy, hooks for Claude Code and Codex, handoffs, agent rules,
  backups, factory migration.
- [ ] Phase 2: path leases and overlap alerts, web view, `board watch`, restore drills.

## Decisions

- 2026-11-06: Design work lives in `claude/factory/board/`. Board data lives outside the
  repository.
- 2026-11-06 (proposed, awaiting the user): build our own thin board; SQLite owned by one
  Bun/TypeScript server; Tailscale plus per-device tokens; a local `board` binary as CLI,
  stdio MCP server and hook handler; fail-fast writes offline.

## Open questions

- Host: a small dedicated VM (recommended) or a container on the Dokploy VPS?
- Backup bucket: which S3-compatible service?
- Is the Tailscale Personal plan's non-commercial term acceptable?

## Next actions

Wait for the user's review of `DESIGN.md` and the open questions, then start the spike.

## Log

- 2026-11-06: Plan written. Facts checked on this Mac: Claude Code 2.1.318 ships a task
  list shareable through `CLAUDE_CODE_TASK_LIST_ID` (not exposed to T3 sessions); Codex CLI
  0.166.0 installed; Tailscale not installed.
- 2026-11-06: Research done (three tracks) and `DESIGN.md` drafted. Checked here: T3 exports
  `T3CODE_THREAD_ID` to the agent and ships `t3 thread list/start/send/show`; Codex forwards
  only listed `env_vars` to MCP servers. No existing tool fits whole (beads is closest; no
  expiring claims or alerts).
- 2026-11-06: Format research done. Checked here: Claude Code 2.1.318 wraps hook text as
  "<Hook> hook additional context" inside a system reminder, a more trusted channel than
  tool results, so peer-written free text goes only in tool results.
