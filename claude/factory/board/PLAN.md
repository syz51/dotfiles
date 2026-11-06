# Agent work board: plan and task list

Living work file for designing, then building, a shared work board for coding agents. Read
this first after a restart or compaction, then continue from **Next actions**. Update task
status, findings and the log as work proceeds; add newly found tasks here instead of keeping
them in conversation only.

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

### Build (in syz51/agent-board)

- [x] Repository, MIT licence, CI, the protocol crate, `docs/API.md` and `docs/DESIGN.md`.
- [~] Three parallel tracks on the branch `build/v0`: the server crate (storage, rules,
  API, snapshots, Telegram), the `board` binary (CLI, MCP, hooks, `board watch`,
  installers, coordinator prompt) and the web view. The first run stopped on the usage
  limit; resumed.
- [ ] Integrate: wire `board serve` and `board admin` to the server crate; container
  image; workspace checks; PR; `/code-review xhigh`.
- [ ] Verify against the running server: Claude Code passes `CLAUDE_CODE_SESSION_ID` to
  stdio MCP children; T3 child thread ids in hooks; the hook budget on a cold start.

### Deploy (private; values stay out of this repository)

- [x] Tailscale on the Dokploy VPS, with Serve (HTTPS) enabled for the tailnet.
- [x] The server container on the host network, bound to loopback, reachable only through
  `tailscale serve`; built from the reviewed `build/v0`.
- [~] Device tokens and `board watch` under launchd: done on this Mac; the other Mac
  needs the user (its SSH host key is not known here).
- [ ] A `--user` token, for answering asks from the CLI.
- [!] Telegram bot: needs the user to create it with BotFather.
- [!] Backups: needs a new Tencent COS bucket with its own scoped key from the user. Then
  restic every 15 minutes from the host, encrypted; a restore drill.

### Adopt (this repository)

- [x] Hooks in `claude/settings.json` and `codex/hooks.json`, through
  `claude/hooks/board-hook.sh`, which does nothing without `~/.cargo/bin/board` or with
  `AGENT_BOARD_HOOKS=off` (set for test and benchmark sessions by `childEnv`).
- [~] MCP server: registered for Claude Code on this Mac; Codex's block goes into
  `~/.codex/config.toml` per Mac (`SETUP.md`, Work board).
- [x] Work board rule in `claude/CLAUDE.md` and `codex/AGENTS.md`.
- [~] Tests: offline checks in `config.test.js`, including runs of the hook script. The
  live suites run against the installed `~/.claude`, so they run after this branch is
  merged and installed.
- [ ] Session identity: a nested `claude -p` or `codex exec` inherits `T3CODE_THREAD_ID` and
  reports as its parent thread unless it sets `AGENT_BOARD_HOOKS=off`. The board should
  tell such sessions apart on its own (agent-board design work).
- [ ] Living plans such as this one move onto boards (with the factory migration below).
- [x] Feedback loop: `board feedback` and `GET /v1/stats` feed the weekly review the way
  skill feedback does; the defaults below change only through it. The factory's weekly
  run has a board step (`claude/factory/board/cli.js`) whose snapshot the proposal step
  reads (`claude/factory/board/proposal.js`); see `SETUP.md`, Factory. It needs
  `board stats` in the installed CLI, and fails the step in the report until then.
- [ ] Migrate the factory's open items (`../PLAN.md`) onto a board as the first real use.
- [ ] Format benchmark (`DESIGN.md` section 11): three formats × three framings, Claude
  Code only, run on the subscription (not the API), at least 20 runs per cell.

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

- None blocking. The user provides the Telegram bot and the COS bucket key when ready.

## Next actions

Integrate the three build tracks when they report, then deploy behind Tailscale once the
user approves the device login.

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
