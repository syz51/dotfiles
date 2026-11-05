# Factory plan and task list

Living work file for building measurement and improvement tooling around this Claude Code
setup, modeled on the "software factory" talk (Zach Lloyd, Warp, X video
2111165023238160603). Read this first after a restart or compaction, then continue from
**Next actions**. Update task status, findings and the log as work proceeds; add newly found
tasks under the right area instead of keeping them in conversation only.

Started 2026-11-05 on `sunmacbook-air` (this Mac is also the codex-skills maintainer).

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
  The daily review runs `claude --print --permission-mode bypassPermissions` with full tools
  and the user's configuration; no sandbox. No secret scanning in that repo's CI (it has no
  `.github/`). The public export lost its content scanner in 1e3a944.
- Global settings: `permissions.defaultMode: bypassPermissions`, `sandbox.enabled: false`,
  `skipDangerousModePermissionPrompt: true`. CLI 2.1.318 supports `--settings`,
  `--max-budget-usd`, `--agent`, `--json-schema`, `--tools`, `--setting-sources`,
  `--strict-mcp-config`, `--no-session-persistence`, and sandbox settings including
  `sandbox.failIfUnavailable`, `sandbox.network.allowedDomains`/`strictAllowlist`,
  `sandbox.filesystem.allowWrite`/`denyRead`, `allowUnsandboxedCommands`.

## Coordination with other work

- Thread "Fix restored privacy guards in codex-skills" is editing codex-skills on branch
  `restore-redaction-scanner` (transcript redaction, public-export `scan()`), then releasing
  to both Macs. A queued follow-up there fixes the hourly sync failures (429 rate limits on
  capture, a `SyntaxWarning`) and may measure Sonnet for extraction. **Do not edit
  codex-skills `scripts/claude_cli.py`, `capture.py`, `jobs.py` or `src/export.rs` until that
  thread has merged and deployed**; then branch from the new `main`.
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

Status: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked (say why).

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
- [ ] Correction signal: heuristic for follow-up prompts that correct the agent (marked as
  heuristic in the report); the judge refines it in area 2.
- [ ] Output: Markdown report and JSON in the state folder, plus one line per run in
  `metrics-history.jsonl` for trends. `--json` for scripts.
- [ ] Tests with synthetic sessions and a fake `gh`.
- [ ] Real run on this Mac; record headline numbers in the log below.

### 2. Scoring and proposals (`scoring/`)

- [ ] `rubric.json`: dimensions defined in code, each mapped to the `claude/CLAUDE.md`
  section it tests. Deterministic detectors (every session, free): package runner rule
  (reuse `claude/tests/lib/command.js`), AI attribution in commits or PRs, fast mode or
  ultra effort used, force pushes. Judge dimensions (sampled): followed instructions,
  verified before claiming done, unnecessary confirmation, scope creep, redundant tests,
  delegation fit, user had to correct the agent (with cause), concise reporting.
- [ ] `score` command: sample N unscored completed sessions (prefer ones with corrections,
  interrupts or errors), build a bounded digest, call the judge with a JSON schema, store
  results keyed by session ID and transcript hash in `scores.jsonl`. Skip automation
  sessions (codex-skills maintenance and investigation worktrees, live-test fixtures).
- [ ] `propose` command: group failures by dimension over a window; at or above the threshold
  (default 3 distinct sessions) and not already proposed, run a proposer session in a fresh
  clone with only Read/Edit/Write/Glob/Grep, check the diff stays in the allowed paths, run
  the offline suites, then push a branch and open a draft PR with the evidence. `--dry-run`
  stops before pushing.
- [ ] Tests: detectors, digest bounds, sampling and dedupe, judge schema handling with a
  fake CLI, the proposal path-allowlist check, and the PR step with a fake `gh`.
- [ ] Real run: score a sample of recent sessions; run `propose` (dry run first, then real if
  a dimension qualifies).

### 3. Benchmarks (`bench/`)

- [ ] Case format `bench/cases/<id>/case.json`: role (`main`, `explorer`, `worker`,
  `solver`), prompt, fixture (`files` folder or `git` repository plus commit), oracle
  command (gets `FINAL_ANSWER_FILE`), budget, turn and time limits.
- [ ] `bench run`: matrix of model x effort x trials; each run in a fresh temporary copy;
  for a subagent role, write an override `.claude/agents/<role>.md` in the fixture and run
  with `--agent <role>`; block installs and web access like the live suites; record pass,
  cost, duration and turns.
- [ ] `bench add-from-commit <repo> <sha> --tests <paths>`: turn a real commit with tests
  into a case (fixture = parent commit plus the commit's tests; oracle = those tests).
- [ ] `bench report`: per role, pass rate and median cost per configuration, the
  cost-vs-correctness Pareto front, and a recommendation (cheapest configuration within a
  set margin of the best pass rate).
- [ ] Seed cases from this repo's history (at least one each for explorer and worker) and
  a judge-calibration case for area 2's judge model.
- [ ] Tests with a fake CLI; one small real matrix run, with results in the log.

### 4. Security (`audit/` here; codex-skills changes after coordination)

- [ ] `audit` command: report the interactive posture (permission mode, sandbox, dangerous
  prompt skip, hooks present and passing their tests, MCP servers and plugins enabled,
  agents' tool restrictions) with a severity per item. Exit nonzero on regressions from a
  recorded baseline.
- [ ] Verify Claude Code's sandbox on this Mac with cheap live runs: writes outside the
  working folder and non-allowlisted network are blocked; `failIfUnavailable` works. Keep
  the profile in `audit/sandbox-profile.json` with a live test.
- [x] Secret scan (2026-11-05): pinned gitleaks 8.30.1 over all branches of codex-skills
  (13 findings) and public `syz51/skills` (27). All false positives: SHA-256 hashes keyed
  by file path in `sources.json` and `.public-export.json`, and the jwt.io sample token in
  VueUse's `useJwt` reference. No credentials in roughly 440 feedback notes.
- [~] codex-skills CI: syz51/codex-skills#2 (`secret-scan-ci`) adds a pinned gitleaks
  workflow over all branches with a narrow `.gitleaks.toml`; locally clean over 333 commits
  and still catches a planted key. Check that its CI run passes; merge is the user's call.
- [ ] Public `syz51/skills`: it is generated by the exporter, so add scanning through the
  exporter (the restored `scan()` from the other thread) or a workflow the exporter keeps;
  its `.public-export.json` hashes need the same allowlist. Decide after the other thread
  lands.
- [!] codex-skills daily review in the sandbox: pass the sandbox profile through
  `--settings`, limit writes to the review checkout and state folders, network to GitHub and
  docs.rs. Blocked on the other thread merging (it edits `claude_cli.py` and `jobs.py`).
- [ ] Decision for the user: opt-in interactive sandbox profile.

### 5. Integration (main session)

- [ ] Merge the track branches; update `SETUP.md` (Verification, Factory section), the
  README table, and CI (`bun test claude/factory`).
- [ ] Run every suite in SETUP.md's Verification section, plus the live suites (Claude Code
  behavior is involved).
- [ ] `/code-review` at xhigh on the final diff; fix real defects; rerun affected checks.
- [ ] Weekly launchd job on this Mac (install script, plist, uninstall command); first run.
- [ ] Clean up temporary files, worktrees, fixture sessions.

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
