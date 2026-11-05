# Factory plan and task list

Living work file for building measurement and improvement tooling around this Claude Code
setup, modeled on the "software factory" talk (Zach Lloyd, Warp, X video
2111165023238160603). Read this first after a restart or compaction, then continue from
**Next actions**. Update task status, findings and the log as work proceeds; add newly found
tasks under the right area instead of keeping them in conversation only.

Started 2026-11-05 on `sunmacbook-air` (this Mac is also the codex-skills maintainer).

**This repository is public.** Keep server addresses, logins, private repository
contents, transcript text and personal data out of every tracked file, this one included.
Evidence that quotes transcripts stays in the state folder.

## Goal

Cover the four gaps found when comparing this setup with the talk, each with working tools,
tests and at least one real end-to-end run:

1. **Outcome metrics**: cost, effort and quality per session and per PR, trended over time.
2. **Improvement loop for the agent configuration** (`claude/CLAUDE.md`, `claude/agents/`):
   score real sessions against the rules, then propose reviewed PRs that fix repeated failures.
3. **Evidence-based model and effort choices**: a benchmark of real tasks across model and
   effort configurations, producing a cost-vs-correctness comparison.
4. **Security**: sandbox the unattended agent, scan for secrets where nothing scans today, and
   audit the interactive posture.

Out of scope for now (user decision): moving work off the laptops. See **Deferred: daily
review on sai** for the feasibility notes the user asked about.

## Evidence this plan rests on (checked 2026-11-05)

- `~/.claude` links to `~/.config/claude` (this repo). The live harness is in
  `claude/tests/lib/` (`stream.js`, `process.js`, `live.js`, `command.js`).
- Transcripts: `~/.claude/projects/<project>/<session>.jsonl` plus
  `<session>/subagents/agent-*.jsonl` and `agent-*.meta.json` (`agentType`,
  `pickedEffortModel`). Claude Code prunes them after 30 days.
- Useful record types: `assistant` (with `message.usage`, `message.model`, `effort`),
  `user` (`promptSource` is `sdk` for T3 Code prompts and `system` for injected ones;
  `isMeta`, `isCompactSummary`), **`cost-state`** (Claude Code's own `totalCostUSD`,
  durations, lines added/removed and per-model `modelUsage`; the last one in a file is
  current), **`pr-link`** (`prUrl`, `prNumber`, `prRepository`), `ai-title`, `custom-title`,
  `tools-used`, `system` (`compact_boundary`). Entrypoints are mostly `t3-code` and `sdk-ts`.
- About 80 sessions and 25M output tokens in the last 30 days; main sessions are almost all
  Opus 5.5; subagents sent about 7,300 Opus and 700 Haiku messages.
- Pricing (from the bundled claude-api skill's table, cached 2026-10-06; Pricing page in its
  live sources): Opus 5.5 $4/$20 per MTok, cache read $0.20; Sonnet 5.5 $2/$10, cache read
  $0.20; Haiku 5.5 $0.10/$0.50 (up to 100K-token prompts; $0.50/$2.50 above); cache writes
  1.25x input (5 minutes) and 2x (1 hour). Only a fallback: prefer `cost-state`.
- codex-skills (`~/.local/share/codex-skills/repository`, private `syz51/codex-skills`):
  hourly capture and source checks on both Macs, daily maintainer on this Mac via launchd.
  Its security posture is covered by the local `audit` (details stay in the state folder:
  `notes/codex-skills-private.md`).
- Global settings: `permissions.defaultMode: bypassPermissions`, `sandbox.enabled: false`,
  `skipDangerousModePermissionPrompt: true`. CLI 2.1.318 supports `--settings`,
  `--max-budget-usd`, `--agent`, `--json-schema`, `--tools`, `--setting-sources`,
  `--strict-mcp-config`, `--no-session-persistence`, and sandbox settings including
  `sandbox.failIfUnavailable`, `sandbox.network.allowedDomains`/`strictAllowlist`,
  `sandbox.filesystem.allowWrite`/`denyRead`, `allowUnsandboxedCommands`.

## Coordination with other work

- Another thread changed codex-skills on 2026-11-05; its work has merged to codex-skills
  `main`, so codex-skills changes can branch from there.
- `nvim/lazy-lock.json` has an unrelated uncommitted change. Leave it alone.

## Decisions

- Code lives in `claude/factory/` (served as `~/.claude/factory/`), JavaScript run with Bun to
  match `claude/tests`. One entry point: `bun ~/.claude/factory/cli.js <command>`; each
  command lives in its own folder (`metrics/`, `scoring/`, `bench/`, `audit/`) and exports
  `run(argv)`, so tracks never edit the same file.
- Shared modules in `claude/factory/lib/` (written first, before parallel work):
  - `transcripts.js`: discover and parse sessions into normalized `Session` objects.
  - `pricing.js`: fallback cost from usage when `cost-state` is missing.
  - `claude.js`: run `claude -p` in restricted judge mode (no tools, no settings, JSON
    schema) or task mode; parse stream-json; reuse `claude/tests/lib/stream.js` and
    `process.js`.
  - `state.js`: state folder `${XDG_DATA_HOME:-~/.local/share}/claude-factory/` for reports,
    scores, bench results and proposal records. Never inside the repo.
- Model calls the tools make are bounded by `--max-budget-usd` and run with
  `--no-session-persistence`, so they never become transcripts that get scored or captured.
- Default LLM judge: `claude-sonnet-5-5` at `medium` effort, configurable per run. Judging
  sends unredacted transcript digests to the model, same as codex-skills capture.
- Proposals never edit settings, permissions or hooks. Allowed paths: `claude/CLAUDE.md`,
  `claude/agents/*.md`, `claude/tests/**`. The proposer has no Bash; the tool runs the tests
  and opens a **draft** PR on `syz51/dotfiles`; the user reviews and merges.
- Interactive sandboxing stays off unless the user opts in. The tools provide a tested
  sandbox profile and an audit; the unattended maintainer gets the sandbox.
- Scheduling: a weekly launchd job on this Mac runs metrics, scoring and proposals, after the
  tools pass a real end-to-end run.

## Shared interfaces

`Session` (from `lib/transcripts.js`):

```
{ id, project, cwd, file, entrypoint, title, startedAt, endedAt, models: {model: count},
  prompts: [{ at, text, source }],      // human-sent prompts only
  assistantMessages, efforts: {effort: count},
  toolCalls: [{ id, name, input, ok, output, at }],  // output: 2,000-char start+end excerpt
  usage: { [model]: { input, output, cacheRead, cacheWrite5m, cacheWrite1h } },
  costUSD, costSource: "cost-state" | "estimated", estimatedCostUSD, unpriced,
  linesAdded, linesRemoved, compactions, interrupts, apiErrors: {status: count},
  subagents: [{ id, agentType, description, toolUseId, model, effort, usage, costUSD,
                toolCalls, toolErrors, malformedLines }],
  prLinks: [{ url, number, repository, at }], automation, malformedLines }
```

`lib/claude.js`: `judge({ prompt, schema, model, effort, budgetUsd })` returns
`{ output, costUSD, events }`; `runTask({ prompt, cwd, model, effort, agent, settings,
budgetUsd, timeoutMs })` returns `{ events, costUSD, ok, finalText }`. A `CLAUDE_FACTORY_BIN`
override points both at a fake CLI in tests.

## Tasks

Status: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked (say why), `[-]` deferred.

### 0. Foundation (main session, before parallel work)

- [x] Allow `claude/factory/` in `.gitignore`; add this plan; memory pointer.
- [x] `cli.js` dispatcher, `lib/transcripts.js`, `lib/pricing.js`, `lib/claude.js`,
  `lib/state.js`, with tests on synthetic transcripts (no real data in fixtures). Test
  helpers for every track: `lib/testing/fake-claude.js` (modes in its header) and
  `lib/testing/transcripts.js` (`Transcript` builder, `writeProjects`).
  `claude/tests/lib/process.js` `runProcess` gained an `input` option (stdin).
- [x] Commit and push on branch `factory`, so worktrees start from it.

### 1. Outcome metrics (`metrics/`)

- [x] `metrics` command (merged from its track): window and previous-window comparison,
  per project; cost, prompts, merged PRs with cost per PR (two views: its sessions, and
  all spend over merged PRs), heuristic correction rate (sessions a person ran only),
  interrupts, tool error rates, API errors, compactions, subagent share and model mix,
  costliest sessions, PR table; reports and `metrics-history.jsonl` in the state folder.
- [x] PR linkage from `pr-link` records and `gh pr create` output; `gh` cache (merged and
  closed permanently, open for 1 hour); revert detection; gh failures become notes.
- [x] Shared lib fixes from the track's findings: forked sessions count only their own
  records (`forkedFrom`; fixed a ~$49 double count), host notices (T3 PR updates,
  delegated-task results, handoffs, slash commands, resume nudges) are not prompts,
  `origin` marks agent-launched threads (54 of 73 sessions this week, $309), subagent
  message counts.
- [x] Tests (synthetic transcripts, fake gh); real 7- and 30-day runs.
- [ ] Scan `git push` output too (today only `/pull/new/<branch>` links, rightly ignored).
- [ ] Spot-check the correction heuristic against the scoring judge; tighten the
  "still running/using" patterns (false positive: "for everything still running codex").
- [ ] Codex sessions: T3 Code's scanner covers `~/.codex/sessions` (2,126 rollout files)
  as well as Claude; the factory sees only Claude, so most subagent work run on GPT
  models is invisible. Add a Codex rollout parser to `lib/` (tokens, model, prompts, tool
  calls) and include it in metrics. Note any T3 thread-to-PR mapping found on the way.
- [ ] Pricing source: T3 Code prices with LiteLLM's public table (cached in
  `~/.t3/userdata/usage-model-rates.json`, 4,526 models including GPT). Use the public
  LiteLLM JSON (cached in the state folder) for models missing from `lib/pricing.js`.
  Discrepancy to resolve: LiteLLM has Sonnet 5.5 cache reads at $0.10/MTok, while the
  claude-api skill's table says $0.20. Check the Anthropic pricing page.
- [ ] Do not build on T3 Code's private files (`usage-scan-cache-v*.json` went from v7 to
  v11 in two weeks; `statev2.sqlite`). An optional read-only reconciliation against
  T3's totals may skip unknown versions.

### 2. Scoring and proposals (`scoring/`)

- [x] `rubric.json` (version 2): detectors package-runner, ai-attribution, force-push,
  ultra-effort (quote-aware command splitting); judge dimensions followed-instructions,
  verified-before-done, unnecessary-confirmation, scope-creep, redundant-tests,
  delegation-fit, concise-reporting, user-corrections (with cause).
- [x] `score`: eligibility (not automation, ended 30+ minutes ago, unscored for this
  rubric and transcript hash), priority by corrections, interrupts, errors, cost;
  bounded digest; judge with schema validation (invalid answers recorded as errors);
  per-call and total budget caps; `scores.jsonl`; detector-only records for unsampled
  sessions.
- [x] `propose`: groups failures over a window, threshold of distinct sessions, dedupes
  against `proposals.jsonl`, runs the proposer in a fresh clone with only the five file
  tools (fails closed otherwise), enforces the path allowlist, runs the offline suites,
  then pushes a branch and opens a draft PR. Because this repository is public, the PR
  body lists session ids, judge model and test results only; quoted evidence stays in
  `proposals/*.evidence.md` in the state folder. `--list` and `--dry-run`.
- [x] Correction heuristic unified (`metrics/corrections.js`), now with Chinese and a
  narrow "actually, use X" pattern.
- [x] Real run (about $2.27): 6 sessions judged twice (rubric v1, then v2 after fixing
  four issues it showed); detectors over 72 sessions. package-runner fails in 46
  sessions: agents routinely run bare `python3 - <<'EOF'`, often to edit files instead of
  using Edit. Judge labels and quotes check out against transcripts, but borderline
  verdicts flip at medium effort; a high-effort rescore was right.
- [x] `propose --dry-run` on package-runner: proposer tightened the uv rule in
  `claude/CLAUDE.md` and updated `claude/tests/config.test.js`; tests passed in the clone.
  Patch in the state folder (`proposals/package-runner-*.patch`). A reviewer may prefer a
  rule steering file edits to the Edit tool, since that is the main source.
- [ ] Judge reliability: calibrate with a bench case; require high effort or two agreeing
  runs before a failure counts toward a proposal.
- [ ] Record the `claude/CLAUDE.md` revision at scoring time (sessions are judged against
  today's rules).
- [ ] New detector: file edits through shell scripts ("Prefer dedicated tools").
- [ ] `runTask` option for `--strict-mcp-config`, for the proposer.
- [x] Rubric v3 (2026-11-05): detector changes since v2 are scored afresh; v2 records no
  longer count toward proposals.
- [x] `bench` command (merged): `list`, `run` (model x effort x trials, budgeted
  parallel scheduler, fresh fixture per run, agent override file plus `--agent`, installs
  and web blocked, overlay re-applied before the oracle so tests cannot be edited to
  pass, infrastructure failures marked and left out of reports), `report` (pass rate,
  median cost and duration, Pareto front, recommendation or "not enough trials" under 3),
  `add-from-commit` (checks the oracle fails on the parent and passes on the commit).
- [x] Seed cases: `explorer-push-guard` (pinned ac55bf1), `worker-tuios-installer-updates`
  (d0d89c0), `worker-guard-temp-deletes` (daa04fd).
- [x] First real run, 1 trial each, all passed: explorer haiku $0.005 / sonnet $0.057 /
  opus $0.114 (all 5 turns, about 11 s); worker tuios sonnet-high $0.136 (33 s) vs
  opus-high $0.349 (58 s). Total $1.45. Requested models confirmed from the stream.
- CLI facts learned (2.1.318): `--model` overrides an agent file's model; a project
  `.claude/agents/<name>.md` beats the user's; an agent file's `effort` is ignored when
  the agent runs as the main session (effort comes from `--effort`, else `modelSettings`,
  else medium); effort is not in stream-json, only in saved transcripts.
- [ ] Real recommendations: 3+ trials per configuration on all cases (budget about $10).
- [ ] Harder explorer cases (this one does not separate models), plus `solver` and `main`
  cases, and the judge-calibration case for area 2.
- [ ] Verify effort: let `runTask` opt into keeping the transcript to read `effort`, then
  delete it.
- [ ] Decide whether subagent roles should be benchmarked as spawned subagents of a main
  session (where frontmatter effort applies) instead of through `--agent`.
- [ ] Small lib cleanups: `runTask` returns partial events on timeout instead of throwing;
  export Claude Code's temp folder path from `claude/tests/lib/cleanup.js` (used by
  `live.js` and `bench/runner.js`).
- Note: bench sessions load user settings, so the atuin hooks record their commands in
  shell history, as with the live suites.

### 4. Security (`audit/` here; codex-skills changes after coordination)

- [x] `audit` command (merged): permission mode, sandbox, dangerous-prompt skip, hooks
  present (and passing with `--with-tests`), MCP servers by name and type only (never
  values from `~/.claude.json`), plugins, agents' tool limits, the codex-skills review's
  flags. Baseline in the state folder; `--fail-on` exits 1 on unaccepted findings, and an
  accepted finding fails again if its severity rises.
- [x] Sandbox verified live on this Mac (4 Haiku runs, $0.005): with
  `audit/sandbox-unattended.json` a Bash write inside the folder works, a write to `$HOME`
  fails ("operation not permitted"), curl to an unlisted host is refused by the proxy,
  `github.com` allowlisted returns 200, and `blockWritesOutsideWorkingDirectories` stops
  the Write tool outside the folder. `strictAllowlist` from `--settings` is what blocks
  unlisted hosts in bypass mode. Not verifiable here: `failIfUnavailable`. Quirk:
  macOS-sandboxed curl cannot verify example.com's chain (exit 60).
- [x] `lib/claude.js` `runTask` gained `addDirs` (`--add-dir`), since a profile's
  `allowWrite` covers Bash only.
- Real audit (2026-11-05), 2 high, 1 medium, 3 low:
  - high: the codex-skills daily review's permissions (details in the local notes);
  - high: interactive `defaultMode: bypassPermissions` with the sandbox off;
  - medium: `sandbox.enabled` false;
  - low: explorer is "read-only" by instruction but has Bash; dangerous-prompt skip on;
    Write/Edit unconfined (`blockWritesOutsideWorkingDirectories` unset).
- [x] User decision (2026-11-05): current findings accepted into the real baseline
  (`audit --update-baseline`); `audit --fail-on medium` now exits 0, so the weekly run
  flags only regressions.
- [-] User decision (2026-11-05): no sandbox work for now, interactive or for the
  codex-skills daily review. The profiles in `audit/` stay, verified, for later.
- [x] Secret scan (2026-11-05): pinned gitleaks 8.30.1 over all branches of codex-skills
  (13 findings) and public `syz51/skills` (27). All false positives: SHA-256 hashes keyed
  by file path in `sources.json` and `.public-export.json`, and the jwt.io sample token in
  VueUse's `useJwt` reference. No credentials in roughly 440 feedback notes.
- [x] codex-skills CI: syz51/codex-skills#2 (`secret-scan-ci`) adds a pinned gitleaks
  workflow over all branches with a narrow `.gitleaks.toml`; locally clean over 333 commits
  and still catches a planted key. CI passes on ebe2453 (first run failed on an
  unauthenticated extra fetch, removed). Merge is the user's call.
- [ ] Public `syz51/skills`: it is generated by the exporter, so add scanning through the
  exporter (the restored `scan()` from the other thread) or a workflow the exporter keeps;
  its `.public-export.json` hashes need the same allowlist. Decide after the other thread
  lands.
- [-] (Deferred by the user, 2026-11-05.) Run the codex-skills daily review under
  `audit/maintainer-sandbox.json`. The draft's scope, probes and open questions are in the
  state folder's `notes/codex-skills-private.md`.

### 5. Integration (main session)

- [x] Merge the track branches (all four merged). Then: update `SETUP.md` (Verification:
  `bun test claude/factory`, live `RUN_CLAUDE_LIVE=1 bun test claude/factory/audit`;
  Factory section), the README table, and CI (`bun test claude/factory`).
- [x] `/code-review` at xhigh on `origin/main...factory` (2026-11-05): 15 findings, all
  real, all fixed (4aaf164, afb3e02, and the merged scoring fixes ed06dd7, 300bf73,
  b232395). Highlights: bench case pinned to a commit on main (CI would have failed);
  `propose` may change only `claude/CLAUDE.md` and `claude/agents/*.md` (no model-written
  code ever runs), detects every written file including ignored ones, denies Read on
  credential paths, records failures after a push as `error` with unique branch names,
  keeps the proposer's reply out of the public PR body and refuses a push whose diff
  repeats 40+ characters of private evidence; judge failures no longer stop scoring;
  runProcess kills descendants in nested process groups; detectors fixed (package-runner,
  ultra-effort, force-push with HEAD); the judge sees a fork's task. A real Haiku
  proposer session changed only the target file, so the stricter change check does not
  reject genuine proposals.
- [x] Verification: all offline suites (448 pass) and the three Python suites; live
  suites 161 of 162 on the first run. The failure, "Python checks run through uv run",
  passed 3 of 3 reruns: intermittent model behavior (bare `python3`), the same pattern
  the package-runner detector found in 46 sessions.
- [x] Weekly job: `weekly run|install|uninstall|status`; LaunchAgent
  `com.syz51.claude-factory.weekly`, Mondays 13:30, installed on this Mac 2026-11-05.
  It runs `~/.claude/factory/cli.js` from the current checkout, so it needs this branch
  (or main after the merge) checked out.
- [x] First real run (launchd, 18:43): metrics ok, audit needs attention (no baseline),
  scoring hung 45 minutes and was killed, proposals failed. Causes, both fixed in
  8f7ffd4: (1) under launchd, opening files in a session folder under `~/Documents` waits
  on macOS's privacy check; such reads now go through `lib/probe.js` with a 5 s deadline;
  (2) branch `factory/proposal-...` cannot coexist with branch `factory`; now
  `factory-proposal/...`.
- [x] Second real run (launchd, 19:31-19:34): every step ran. Scoring finished in 2 minutes
  (the deadline fix works under launchd); proposals opened draft syz51/dotfiles#16
  ("Require uv run for all Python and bun outside matching lockfiles", 48 sessions,
  $0.23, tests passing). Its PR body holds session ids only; the diff is one rule line.
  Note: a few of the 48 sessions carried v2 detector records from before the
  package-runner fix (for example a `pip` inside a grep pattern); rubric v3 rescores them.
- [x] Clean up temporary files, worktrees, fixture sessions.
- [x] Second `/code-review` at xhigh on PR #17 (user asked): 15 findings, all real, all
  fixed (2e5e782 and the merged scoring fixes): a failed proposer run never pushes and
  only a budget overrun blocks its retry; the proposer cannot read transcripts or factory
  state; rubric v3; `command -v` is a lookup; `--mirror`/forced `--all` pushes flagged; the
  judge sees host notices and slash commands; repeated judge errors stop being retried;
  `--session` judges every named session; weekly keeps config overrides and locks
  atomically; runProcess kills once and tolerates EPERM; model mix priced per request;
  bench timeout cost via the shared partial-stream reader; private codex-skills details
  moved to the state folder's notes.
- [ ] Merge #17, switch `~/.config` to main, then live-test and merge #16.
- [ ] Inherited host prompts of a forked session are not shown to the judge (the lib
  filters them); add if forks of slash-command sessions turn out to matter.

## Deferred: daily review on sai

The user asked whether the daily codex-skills review could run on `sai` (the user's
Dokploy VPS). Feasible, with this split:

- **Stays on each Mac**: hourly capture, source checks and corrections (they need the local
  transcripts), upload to the host inbox branch, and deployment of skill releases.
- **Moves to sai**: daily collect from both inbox branches, review, investigations, publish
  to `main`, prompt review, and the public export.
- **Needed on sai**: Claude Code with a long-lived token (`claude setup-token`), a deploy
  key with write access to codex-skills, uv, Python 3.12, Rust for the exporter checks; a
  systemd timer instead of launchd; an alert channel instead of macOS notifications; the
  health monitor reading status over SSH or from the repo.
- **Loses**: investigations that snapshot registered local projects on the Macs (they would
  need clones from GitHub or would stay blocked).
- **Risk**: sai runs production apps. Run the review as a dedicated non-root user, in a
  container, with the Claude Code sandbox on (bubblewrap on Linux), never as root.

## Next actions

1. Foundation (area 0), commit, push.
2. Launch tracks 1-3 and the dotfiles part of track 4 in parallel worktrees.
3. Meanwhile in the main session: the secret scan and sandbox verification.

## Log

- 2026-11-05: Plan written. Facts above checked on this Mac.
- 2026-11-05: Foundation done. On real data: 80 sessions in 30 days, 78 with `cost-state`,
  about $719 API-equivalent in total, 377 human prompts, 6 sessions with `pr-link`.
  `cost-state` includes subagents and agrees with the usage estimate within about 2%
  (pricing table confirmed), but it is a snapshot that goes stale while a session continues
  (this session: $1.19 recorded vs $4.65 estimated), so a clearly larger estimate wins.
  Correction: assistant records repeat per content block (19,188 records for 8,396
  messages), so the earlier "25M output tokens" was double-counted; the parser dedupes by
  message id.
- 2026-11-05: Metrics merged. 7-day real run: 73 sessions ($654 API-equivalent; 54
  agent-launched costing $309), 3 merged PRs at $48 per PR from their sessions and $218
  per PR counting all spend, correction rate 5.5% (heuristic), 18 rate-limit (429)
  errors, subagents 26% of cost. secret scan clean; codex-skills#2 opened.
- 2026-11-05: Code review found 15 real issues; most fixed (see Integration). The
  scoring worker hit the account's 5-hour usage limit mid-task and was resumed at 18:30.
  Lesson: parallel Opus workers plus the hourly capture job share one account quota.
- 2026-11-05: First launchd run exposed the macOS privacy wait and the branch-name clash;
  both fixed. codex-skills#2 CI green. The other thread merged to codex-skills main.
- 2026-11-05: User decisions: audit baseline accepted; sandbox work deferred; the earlier
  address exposure needs no further action. Reviewing and merging the open PRs.
