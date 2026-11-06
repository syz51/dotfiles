# Agent work board: plan and task list

Record of designing, then building, a shared work board for coding agents: problem,
requirements, decisions and log. Open tasks live on the `agent-board` and `dotfiles` boards
(**Next actions**); add newly found tasks there, and findings and decisions here.

Started 2026-11-06 from a T3 Code thread that is dedicated to this task. Part of the factory
effort (`../PLAN.md`, area 6).

The code and its design now live in the open-source repository
[syz51/agent-board](https://github.com/syz51/agent-board) (`docs/DESIGN.md`, `docs/API.md`).
`DESIGN.md` here is the original research record. This file tracks the whole effort,
including the parts that stay in this repository: deployment, global agent rules, hooks
and the factory migration.

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
- [x] User review of the design; decisions recorded below.
- [x] Text format and framing research (component 11, raised by the user; delegated thread):
  `DESIGN.md` section 11 has the formats per place, the trust rule (peer free text only in
  tool results), writing conventions and the compact formats considered (TOON, BAML, MCP
  structured content and others).

### Build, deploy and adopt

Open work moved onto the boards on 2026-11-07: `board ls --board agent-board` for the
server, client and deployment; `board ls --board dotfiles` for the hooks, live suites and
factory items. Claim a task there before working on it. Done so far:

- [x] Repository, MIT licence, CI, the protocol crate, `docs/API.md` and `docs/DESIGN.md`.
- [x] Server, `board` binary (CLI, MCP, hooks, `board watch`, coordinator) and web view,
  integrated and reviewed on `build/v0`, merged to `main` (agent-board #1); `main`
  requires the `rust`, `web` and `docker` checks.
- [x] The server container behind `tailscale serve` on the Dokploy VPS, bound to loopback.
- [x] Device tokens, `board watch` under launchd, the MCP server for Claude Code and
  Codex, and approved Codex hooks (`codex/trust-hooks.js`) on both Macs.
- [x] Hooks in `claude/settings.json` and `codex/hooks.json`, through
  `claude/hooks/board-hook.sh`, which does nothing without `~/.cargo/bin/board` or with
  `AGENT_BOARD_HOOKS=off` (set for test, benchmark and factory sessions by `childEnv`).
- [x] Work board rule in `claude/CLAUDE.md` and `codex/AGENTS.md`.
- [x] Feedback loop: `board feedback` and `GET /v1/stats` feed the factory's weekly run
  through its board step (`claude/factory/board/cli.js`) and the proposal step; see
  `SETUP.md`, Factory. The defaults change only through it.
- [x] The factory's open items (`../PLAN.md`) moved onto the `dotfiles` board as its
  first real use.

### Upstream

- [x] T3 Code: one Ideas discussion for `t3 thread watch`, offering a PR
  ([#31947](https://github.com/pingdotgg/t3code/discussions/31947)). Feature work there
  needs maintainer approval first; send the PR only if it is approved.

## Decisions

- 2026-11-06: Design work lives in `claude/factory/board/`. Board data lives outside the
  repository.
- 2026-11-06 (user): build our own, open source as syz51/agent-board under MIT. Rust for
  the server and the `board` binary (measured start-up: 2.1 ms and 0.4 MB, against 6.3 ms
  and 89 MB for a compiled Bun binary), TypeScript for the web view.
- 2026-11-06 (user): host it as a container on the existing Dokploy VPS, reachable over
  Tailscale only; per-device tokens; fail-fast writes and stale reads when offline.
- 2026-11-06 (user): backups to a new Tencent COS bucket with its own scoped key.
- 2026-11-06 (user): decisions and actions for the user arrive through a Telegram bot and
  the web view; otherwise agents work unattended.
- 2026-11-06 (user): autopilot runs one coordinator thread per project. It works the ready
  queue one task at a time and delegates parts to child threads; no fixed concurrency cap;
  it pauses on usage limits.
- 2026-11-06 (user): defaults (stale owner 24 h, lease 45 min, one task in `doing` per
  agent, evidence required for done, 30-day decay) and the agent rules evolve through
  feedback, like skill feedback and the factory review.
- 2026-11-06 (user): hooks run in every session globally. The format benchmark uses Claude
  Code on the subscription only.

## Open questions

- None blocking. Steps that need the user are asks on the `agent-board` board: the
  Telegram bot token, and a new API key for the cloud operator account so the backup
  principal can be created (backups run as local snapshots until then).

## Next actions

`board snapshot`, then the boards: `board ls --board agent-board` and
`board ls --board dotfiles`.

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
- 2026-11-06: The user accepted the design with the decisions above. Built the repository,
  protocol crate and API contract, then started three build tracks. Tailscale was already
  on this Mac as the app (the CLI is not on `PATH`); installed it on the VPS.
- 2026-11-07: Merged to `main` in agent-board and deployed; both Macs log in, watch and
  run the hooks and MCP server. Open tasks for this effort and the factory now live on the
  `agent-board` and `dotfiles` boards; this file keeps the problem, design and log.
