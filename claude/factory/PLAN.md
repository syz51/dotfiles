# Factory plan and record

Record of building measurement and improvement tooling around this Claude Code setup,
modeled on the "software factory" talk (Zach Lloyd, Warp, X video 2111165023238160603):
goal, evidence, decisions and log. Open tasks live on the `dotfiles` work board
(**Next actions**); add newly found tasks there, and findings and decisions here.

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
- Pricing (Anthropic's pricing page, https://platform.claude.com/docs/en/about-claude/pricing,
  checked 2026-11-07): Opus 5.5 $4/$20 per MTok, cache read $0.20; Sonnet 5.5 $2/$10, cache
  read $0.10 (0.05x input, footnote 2; the claude-api skill's cached $0.20 is stale); Haiku
  5.5 $0.10/$0.50 (up to 100K-token prompts; $0.50/$2.50 above); cache writes 1.25x input
  (5 minutes) and 2x (1 hour). Only a fallback: prefer `cost-state`. Models missing from
  the table (Codex's GPT models) take LiteLLM's public price list.
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
  - `pricing.js`: fallback cost from usage when `cost-state` is missing; `litellm.js`
    prices models missing from its table from LiteLLM's list, cached in the state folder.
  - `claude.js`: run `claude -p` in restricted judge mode (no tools, no settings, JSON
    schema) or task mode; parse stream-json; reuse `claude/tests/lib/stream.js` and
    `process.js`.
  - `state.js`: state folder `${XDG_DATA_HOME:-~/.local/share}/claude-factory/` for reports,
    scores, bench results and proposal records. Never inside the repo.
- Model calls the tools make are bounded by `--max-budget-usd` and run with
  `--no-session-persistence`, so they never become transcripts that get scored or captured.
  The exception is bench runs, which save the transcript to read its effort and delete it
  when the run ends.
- Default LLM judge: `claude-opus-5-5` at `medium` effort, configurable per run (Sonnet
  until 2026-11-08, when the user allowed only Opus or Haiku). Judging
  sends unredacted transcript digests to the model, same as codex-skills capture.
- Proposals never edit settings, permissions or hooks. Allowed paths: `claude/CLAUDE.md`,
  `codex/AGENTS.md` (its Work board section mirrors the global one), `claude/agents/*.md`. The proposer has no Bash; the tool runs the tests
  and opens a **draft** PR on `syz51/dotfiles`; the user reviews and merges.
- Interactive sandboxing stays off unless the user opts in. The tools provide a tested
  sandbox profile and an audit; the unattended maintainer gets the sandbox.
- Scheduling: a weekly launchd job on this Mac runs metrics, scoring and proposals, after the
  tools pass a real end-to-end run.

## Shared interfaces

`Session` (from `lib/transcripts.js`, and from `lib/codex.js` for Codex rollouts, whose subagent
threads become `subagents` of their root thread and whose cost is the usage estimate):

```
{ id, harness: "claude" | "codex", project, cwd, file, entrypoint, title, startedAt, endedAt,
  models: {model: count},
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

`lib/claude.js`: `judge({ prompt, system, schema, model, effort, budgetUsd })` returns
`{ output, costUSD, events }`; `system`, the part shared by every call of a run, goes to
the cached system prompt (it replaces Claude Code's default one), `prompt` (per call) to
stdin; a call the API refused before it did anything runs once more; `runTask({ prompt, cwd, model, effort, agent, settings,
budgetUsd, timeoutMs, strictMcp, readEffort })` returns `{ events, costUSD, ok, finalText }`,
plus `efforts: {effort: count}` (or null) with `readEffort`. A `CLAUDE_FACTORY_BIN`
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
- [x] Codex sessions (`lib/codex.js`, board task dotfiles-5): threads under
  `$CODEX_HOME/sessions` (a long thread spans several segment files) with tokens, models,
  efforts, prompts, tool calls, interrupts, compactions, turn errors and PRs (`gh pr create`
  output, T3 Code's link tool); subagent threads skip the parent history they copy and count
  with their root session, which spans them in time. Report: per-harness sessions, cost and
  tokens, a Tokens column in the model mix, cost quantiles and cost per merged PR over
  sessions with a known cost, a Codex column in the history.
- [x] Pricing fallback (board task dotfiles-6): models missing from `lib/pricing.js` take
  LiteLLM's `model_prices_and_context_window.json`, cached as `litellm-prices.json` in the
  state folder and refreshed by `metrics` when over a week old (skipped with `--no-gh`; a
  failed fetch keeps the old copy and adds a note). Cache prices LiteLLM lacks fall back to
  input; its lowest "above N k tokens" tier is the long-prompt price. The report notes
  which models it priced. Not done: reconciling estimates against T3 Code's totals.
- [x] Pushed branches (board task dotfiles-3): read from git push output in any tool call
  (the `To <remote>` ref lines and GitHub's `pull/new/<branch>` hint), counted once per
  branch in the headline and the PR section; PR links a server prints on push (`remote:`
  lines) link the PR. GitHub prints none for an existing PR, and `-q` pushes print nothing.
  7-day real run: 62 branches (61 new) from 39 sessions.
- [x] Correction heuristic vs the scoring judge (board task dotfiles-4, 2026-11-07): 203
  follow-up prompts of 16 judged sessions, compared prompt by prompt with the judge's
  `corrections`. After tightening "still running/using" (it, this or that in a statement,
  not a description of other things still running or a question): agreement 87%,
  precision 0.44, recall 0.29; leaving out changed-requirements entries, 91%, 0.38 and
  0.40. Some heuristic-only hits are "I meant X" corrections the judge left out; most
  misses are quiet ones (a short "fix it properly", a complaint without a correction
  word) or follow a quoted line without a `>` marker. The rate stays labelled a heuristic.

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
- [x] Rubric v3 (2026-11-05): detector changes since v2 are scored afresh; v2 records no
  longer count toward proposals.
- [x] Rubric v5 (2026-11-07, board task dotfiles-9): `shell-file-edit` detector for the
  "Prefer dedicated tools" rule: `sed -i`, `perl -pi` or `ruby -i`, echo, printf or
  heredocs written into files, and inline scripts that write files (named when a literal
  says which); scratch folders (followed through `cd`, subshells and literal variables)
  and devices do not count, na when a session edited no files. `shellCommands` now parses
  redirects, pipes, heredoc bodies, comments and subshells, which the settings check of
  ultra-effort shares. Over 7 days of real sessions it fails 99 of the 115 that edited
  files (inline Python replace scripts are most hits, then `sed -i`/`perl -pi`).
- [x] Rubric v6 (2026-11-07, board task dotfiles-36): agents file found work as board tasks,
  so `scope-creep` passes filing as well as reporting unrelated issues, and
  `unnecessary-confirmation` no longer counts filing on the repository's board as an
  external write that needs approval.
- [x] Rubric v7 (2026-11-07, board task dotfiles-51): `untracked-work` judge dimension for
  the Work board rule that nothing still to do stays only in chat, a file or a handoff:
  fails remaining or next steps named without a task or ask id, work written into plan
  or ledger files, and `task_done` with a failing acceptance check; na without a board.
- [x] Rubric v8 (2026-11-08, board task dotfiles-102): `review-skipped` detector for the
  Review rule. `scoring/high-impact.toml` lists high-impact path globs: a default list
  (CI workflows, hooks and guards, settings, installers and deployment, Terraform, Vault,
  migrations, auth) minus docs and tests, plus each board repository's own paths. A
  session fails when it pushed or merged an edit on its repository's list with no
  /code-review started since the first such edit. Files map to repositories through the
  board client's `[projects]` checkouts and their Claude Code and T3 worktrees, with
  symbolic links resolved and git-ignored files skipped; a push settles its own
  repository's edits. Over 30 days to 2026-11-08 it fails 39 of 298 sessions (88 pushes;
  14 pass, 245 na); agent-board has the most flagged files, then dotfiles, email-agent
  and vps. Deletes, moves and patches are not seen. The Review rule now says a listed
  path is always high-impact.
- [x] Instructions revision (board task dotfiles-8): sessions are judged against today's
  rules, so each judged record keeps `instructions`: `global` with the sha256 of
  `claude/CLAUDE.md` as judged, the last commit that changed it and whether the checkout
  differs from it (null outside git), and `project` with the sha256 of each project
  CLAUDE.md the judge saw. Detector-only records do not read instructions.
- [x] Proposers without MCP (board task dotfiles-10): `runTask({ strictMcp })` passes
  `--strict-mcp-config` with no `--mcp-config`, and both proposers (`propose` and the
  board's) use it. Before, the user's MCP servers loaded (`--tools` limits built-in tools
  only), so the tool check rejected every real proposer run after spending its budget.
  Checked live: without the flag the init event lists the board server and 13 MCP tools;
  with it, none.
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
- Note: bench sessions load user settings, so the atuin hooks record their commands in
  shell history, as with the live suites.
- [x] Effort check (board task dotfiles-12): `runTask({ readEffort })` drops
  `--no-session-persistence`, gives each try its own `--session-id`, counts the main
  thread's messages per `effort` in that transcript, then deletes the transcript, its
  subagent folder and the project folder if nothing else is in it, also when the session
  fails or times out. Each bench record keeps `effortObserved`; another effort, or none
  recorded, marks the run infra, as the wrong model does.
- [x] Decision, subagent roles (board task dotfiles-13): keep running a role as the main
  session with `--agent`, not as a subagent a main session spawns. Evidence, a live
  experiment (Claude Code 2.1.319, Haiku, explorer role, same task both ways, about $0.03
  in all), read from the requests each session saved:
  - Both ways the agent body is the system prompt, the global CLAUDE.md is in context, and
    the override's model applies. A spawned subagent takes the override's effort (`low`
    while its main ran `medium`); `--agent` needs `--effort`, now checked per run.
  - What `--agent` changes: the system prompt lacks the notes Claude Code adds for
    subagents (absolute paths, final-message format, no report files; 663 vs 1,524
    characters), and the session gets the main-only tools ScheduleWakeup and Workflow.
    Bench settings now deny those two for subagent roles; a live check confirmed the deny
    removes them from the session. Deferred tool lists were not compared.
  - What spawning would cost: a main session's 8K-character system prompt and turns
    (1.2 to 2 times the cost of the `--agent` runs here) mixed into the role's cost, a brief
    the main model rewrites, so the case prompt is no longer fixed, and one more model and
    effort to choose. In print mode the default background spawn let the main session end
    before the subagent answered ("still running"); only an explicit foreground spawn
    returned the answer.
  - So `--agent` measures the role itself at the configuration under test, with a fixed
    prompt and cost that belongs to it. Whether a main session delegates well is a separate
    question for main-role cases.
- [x] Lib cleanups (board task dotfiles-14): `runTask` no longer throws when a session runs
  past its deadline; it returns the events streamed so far with `timedOut: true` and `ok:
  false` (and still reads and deletes a kept transcript). The bench records it as a timed-out
  model failure with the models seen so far; a proposer records `proposer-failed` with no
  result subtype, which is retried next run, as the `error` it used to record was.
  `claudeTempDir()` in `claude/tests/lib/cleanup.js` is now the one definition of Claude
  Code's temporary folder, used by the live suites, the bench and the board bench.
- [x] Flaky live checks (board task dotfiles-16): the live guard scenario asked for
  `git push --force origin main`, which the session's own CLAUDE.md forbids, so the model
  sometimes declined and the scenario measured its willingness, not the hook. It now asks
  for a user-authorized, expected-SHA leased push to `release`, which CLAUDE.md allows; the
  remote's HEAD names `release`, so only the hook, through `origin/HEAD`, knows it is a
  default branch and blocks it. The live sandbox check keeps a failed case's report and full
  stream in `failureDirectory()` (`CLAUDE_LIVE_REPORT_DIR`, else
  `$TMPDIR/claude-live-failures`), since its scratch folders are removed and failures are rare.
- [x] Harder cases (board task dotfiles-18), each with an oracle that fails on the parent
  commit:
  - `explorer-board-hooks-off` (pinned 46ceea2), five questions across five files on how
    test sessions stay off the work board. Its `reference/answer.md` passes the oracle;
    `reference/parent-answer.md`, true at the parent, fails it, as does an empty answer. A
    test holds every case with reference answers to this.
  - `solver-guard-quoting-wrappers` (0583e84) and `solver-shell-getopt-wrappers` (dca5aa4):
    the Bash guards' shell parsing.
  - `main-review-fixes-three-modules` (2e5e782): three test files in different modules,
    each failing on its own at the parent.
  - The prompts name only the failing tests, not the commit's description of the fix.
  - These are the first overlays holding bun tests. The root `bunfig.toml` keeps `bun test`
    from discovering them in this checkout, where their imports do not resolve. bun reads
    it only from the working directory, so run the suites from the repository root, as
    SETUP and CI do.
  - First live run (2026-11-07, Claude Code 2.1.319, medium effort, 1 trial, $1.90 in all):
    every run passed.
    - The explorer cost $0.004 on Haiku, $0.07 on Sonnet and $0.12 on Opus.
    - Main: Haiku $0.02, 108 s; Opus $0.38, 105 s.
    - The quoting solver: Haiku $0.01, 136 s; Opus $0.31, 171 s.
    - The getopt solver: Haiku $0.20, 442 s; Opus $0.77, 264 s.
  - So Haiku 5.5 does not fail these. The cases separate models on cost and time; pass
    rates need more trials (dotfiles-11).
- [x] Three trials per configuration (board task dotfiles-11, 2026-11-07, Claude Code
  2.1.319, $7.64 in 47 new runs). With the earlier runs, 62 runs over the 7 cases: every run
  passed, with no infrastructure failures. Each configuration has 3 or 4 trials. Medians:

  | Role (effort) | Haiku | Sonnet | Opus |
  |---|---|---|---|
  | explorer, 2 cases (medium) | $0.007, 19 s | $0.10, 21 s | $0.20, 28 s |
  | main, 1 case (medium) | $0.02, 108 s | $0.16, 92 s | $0.38, 115 s |
  | solver, 2 cases (medium) | $0.17, 498 s | $0.43, 217 s | $1.04, 461 s |
  | worker, 2 cases (high) | $0.06, 327 s | $0.50, 246 s | tuios only: $0.24, 58 s |

  - The report's Pareto front (pass rate against cost) is Haiku alone in every case and
    role, so it recommends Haiku throughout. Sonnet was the fastest on the solver cases,
    but the front leaves out duration.
  - No agent file changes on this evidence. Every case passes on every model, so these
    cases cannot show what the cheaper models lose. The agent files' efforts were not run
    either: explorer and solver at xhigh, worker on Opus for the temp-deletes case. Board
    task dotfiles-26 adds cases where models differ and runs the configured efforts first.
  - Judge calibration stays with dotfiles-7: the bench runs agent roles, while the judge
    runs in scoring with its own system prompt, so its calibration set belongs there.
- Report style (`bench style`, dotfiles-88): 8 report cases from real sessions, sanitized,
  each with notes and 7–11 facts. Opus at high effort writes the report without tools;
  Sonnet judges which facts it kept. The candidate gets the rule in a project `CLAUDE.md`.
  The rule is adopted when it loses at most 1 in 20 more facts than the control and its
  sentences are shorter.
  - Result (5 trials, 80 runs, $2.99, batch 20261107T084130430Z-3c7c3241): control kept
    343/350 facts (2.0% loss), 12.4 words per sentence, 2.2% of sentences over 25 words.
    The candidate kept 347/350 (0.9% loss), 8.3 words per sentence, none over 25.
  - Adopted in `claude/CLAUDE.md` Workflow. `codex/AGENTS.md` is unchanged: Codex needs
    its own bench run.

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
- [x] Final verification (2026-11-05, with #16's rule applied): offline 476 pass; Python
  suites pass; three full live runs each had one different model-driven failure:
  (1) "Python checks run through uv run" was a harness false negative (the agent ran
  `uv run check.py; echo "exit=$?"`), fixed in d584eb5; (2) the unattended sandbox check
  failed once in nine runs, cause not reproduced (it logs every Bash call; keep the output
  of the next failure); (3) "the guard hook blocks a force push to main" failed because
  Haiku did not run the command (an existing test; the hook never ran). The last full run
  passed every Claude configuration suite, including the policy suite under #16.
- [x] codex-skills#2 merged (squash, e2222419).
- [x] Merged #17 (7ada7e7) and #16 (d267080) on 2026-11-05; `~/.config` is on main, so the
  weekly LaunchAgent runs the merged code.
- [x] Inherited host prompts of forks (board task dotfiles-17): no change. A fork's digest
  shows the parent's prompts but not its host notices, so a fork of a session whose task
  came by slash command would reach the judge without it. On 2026-11-07, over 30 days: 1
  of 193 Claude Code sessions was a fork; the only slash command it inherited was
  `/compact`, which carries no task, and its inherited prompts were present. The 2 Codex
  forks of 203 sessions (`history_mode: paginated`) copy no parent history, so they have no
  inherited prompts and no double count. Scoring judges Claude Code sessions only, so they
  never reach the judge. If Codex is ever scored, read the parent's prompts from its
  rollout up to `forked_from_ordinal_exclusive`.

### 6. Agent work board (`board/`)

A shared, durable task board that every agent thread on every device reads and writes, so
threads keep their working state across compaction and restarts and see each other's
progress without reading transcripts. Its record is `board/PLAN.md`; its tasks are on the
`agent-board` and `dotfiles` boards.

- [x] Design every component: `board/DESIGN.md`, accepted by the user on 2026-11-06.
- [x] Built (github.com/syz51/agent-board) and deployed; this plan's open items moved onto
  the `dotfiles` work board on 2026-11-07.

### 7. UI design climbs (`ui/`)

Hill-climb a web UI's design with Claude judges (the "frontend factory" idea from Theo's
"Agents Sucked At UI (Until Today)", built with Claude models only; task `dotfiles-31`).
The `ui-climb` skill (`claude/skills/ui-climb/`) is the procedure an agent follows; the
first climb is agent-board's web view (`agent-board-21`).

- Judges score screenshots, never code, against a fixed rubric (`ui/rubric.json`, eight
  categories with anchors). Each call holds main, the candidate and public reference
  products, labeled "Design N" in an order shuffled per call; prompts never say which is
  which or that a climb runs. Overall scores are computed, not asked for.
- Calibration before any round: a degraded control (main plus injected CSS) must score a
  point lower and lower in most categories, and repeated calls must agree within a point.
  The measured noise raises the gain a round needs (twice the overall σ). Scores are
  comparative, so in a climb the noise is also at least the spread of main's score over
  the run's rounds. Calibration warns when a judge almost never gives the bar.
- Deterministic gates first, at no model cost: the project's checks, no new page errors,
  console errors or failed requests per shot, and contrast, accessible names, tap targets,
  alt text and sideways scrolling no worse than main's (`ui/checks.js`, run in the page).
- Rounds judge a commit, extracted with `git archive` and set up fresh, against the
  run's fixed main commit. Judges run cheapest first and stop at the first failure,
  except until a round has heard from every judge, and in the hand-over round.
  Issues in categories under the bar are listed first. Budgets per call, round and run; a
  run is tied to its configuration, what the judges are asked (rubric and prompts, hashed)
  and `~/.claude/frontend-avoid.md`.
- Board integration: one `score:` note per round; stop on pass, budget or plateau (two
  judged rounds in which neither the lowest category nor a gain still under its bar moved
  beyond the noise), after one structural round and one round that fixes its issues when
  the bar is far and budget is left; friction goes to `board feedback --about ui-climb`;
  the owner decides the merge through an ask.
- Issue ledger (`ui/ledger.js`): issues match across rounds by screen and category. A
  round marks an issue still reported as unfixed since its first round, and one reported
  again after a round resolved it as returning. Each round fixes every issue or says in a
  note why it keeps one. The fixes that resolved an issue go into the judges' system prompt
  as design decisions already made, without words that tell a climb runs. When judges
  alternate on one element, the climber keeps the best-scoring version and records the
  conflict, whatever the report counts.

### 8. Code review (from Anthropic's post, `dotfiles-99`)

Source: "How the Claude Code team does code review" (claude.dev, 2026-10-15) and the Code
Review docs on code.claude.com, read 2026-11-07.

- The post's practices:
  - Parallel finders, then a verifier vote on each finding, with cleanup and style
    findings dropped after A/B tests.
  - Labels Important, Nit and Pre-existing.
  - Known bugs from past incidents as a daily eval set, and comments sorted by the author's
    response (fixed, wrong, intentional, didn't matter).
  - Revert and incident rates as the guardrail.
  - A cap of 3 rounds, diff-only re-review, no repeated findings, and fixing each bug class.
  - Risk tiers set from the change, not the author.
  - Results: one-round passes rose from 65% to 78%, and mean reviews to pass fell from
    2.08 to 1.32.
- Local `/code-review` reads `CLAUDE.md` but not `REVIEW.md`. Its arguments are the only
  per-review channel.
- Claude Code 2.1.319 picks a recipe per model and level. For Opus 5.x:
  - medium and high: one careful diff pass.
  - xhigh: 10 inline angles, dedup without verification, a sweep, at most 15 findings.
  - max: parallel finders with a one-vote verify. It needs the Agent tool, and without
    it max falls back to a single inline pass.
- Measured over 30 days to 2026-11-07:
  - 88 background reviews ran in 37 of 272 sessions, all xhigh on Opus 5.5.
  - Inner review agents cost $416.49 (median $2.33). With wrappers, reviews took 11.7%
    of $3,763.
  - The median review returned 15 findings, the cap. 3 of 151 returned none. These counts
    are estimates parsed from free-text replies. A sample of about 12 triage replies
    accepted 12-15 of 15 findings. dotfiles-100 checks both against recorded outcomes.
  - No review recorded its outcomes as typed data.
  - Sessions with many reviews reviewed distinct commits, not one change in a loop.
- Decision (user, 2026-11-07, ask #37): a circuit breaker. Agents keep merging, and PRs to
  high-impact paths wait for the user while the revert rate of reviewed PRs is above a
  limit. The limit, window, reset rule and paths stay in one config file the user can
  change at any time.
- Tasks, all p1 and accepted: dotfiles-100 (outcome records), 101 (level bench), 102
  (path tiers and skipped-review detector), 103 (review briefs), 104 (weekly review of
  main), 105 (fixes for recurring finding classes) and 107 (the breaker). The board holds
  their current state. Their instruction changes go to `claude/CLAUDE.md`, and
  `codex/AGENTS.md` follows only what dotfiles-109 keeps of Codex.

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

Open work is tracked on the `dotfiles` work board (`board ls --board dotfiles`), not in this
file: each former `[ ]` item is a task there, with its acceptance checks. Tasks marked `auto`
are worked by the board's coordinator; the rest wait for a decision (budget or
coordination). This file keeps the goal, evidence, decisions and log.

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
- 2026-11-05: #17 and #16 merged; codex-skills#2 merged earlier. Build complete.
- 2026-11-05: API-first billing. `claude/bin/claude-api` bills unattended print-mode runs
  (factory, live suites, research scripts through `claude/bin/api-first`) to the API while
  credit lasts, else the subscription; the key reaches Claude Code through an
  `apiKeyHelper`, not the environment (an env key showed up in the agent's Bash; the key
  file itself stays readable by a session running as the user). `/code-review` at xhigh
  found 15 issues, all fixed: the wrapper now `exec`s claude (a killed wrapper had left
  claude running), uses `API_FIRST_*` variables (callers strip `CLAUDE_*`), caches per key,
  handles `--`, treats spend limits as exhausted and leaves a caller's own auth alone. The codex-skills pipeline is handled in the "Review Agent
  Instructions" thread (its own API path since a98a27c; fallback proposal awaiting the
  user). The masters project's AGENTS.md now routes experiment billing through the wrapper.
- 2026-11-06: Every API-mode run failed with "Credit balance is too low" while the credit
  check passed. Cause: the API refuses requests carrying Claude Code's
  `claude-code-20250219` beta for this account's credit, while the same key and body
  without it succeed; the check never sent it. The check now sends the beta, so such runs
  fall back to the subscription, and results cached by the old check are ignored. The
  judge now puts its shared instructions and rubric in `--append-system-prompt-file`, inside
  Claude Code's cached prefix (second call of a run: 8.2k cached tokens read instead of
  3.7k).
- 2026-11-06: Review follow-ups. By 07:27 real Claude Code runs on the key were served
  again (Haiku and Opus, with the user's settings and judge-shaped), while any raw request
  carrying Claude Code's beta or its Agent SDK identity line was still refused for credit:
  the beta check said "exhausted" for a key Claude Code could use, so no check request can
  stand in for a run. The check is a plain Messages request again (cached entries of the
  beta check are ignored), and API runs report back through `StopFailure`/`Stop` hooks
  that only save their input (Claude Code kills `StopFailure` hooks when it exits: a
  2-second hook was cut off), folded in by the next plan; a refused run moves later runs
  to the subscription, repeated refusals back off from 30 minutes to 8 hours, runs refused
  together count once, and the weekly summary counts them. Any other definite 4xx of the check is
  `refused` (subscription) instead of falling through to the API. Judge and task calls,
  and live sessions, refused before doing anything run once more, on the subscription
  (`API_FIRST_SUBSCRIPTION=1`), since the refused run's hook may not have reported. A lock
  keeps plans running together from overwriting each other's state. The judge's instructions
  now replace the default system prompt (`--system-prompt-file`): appending had turned its
  identity into "You are Claude Code" and carried 9k characters of coding-session
  guidance (second call: 6.5k cached tokens read, valid judgement). Rubric v4 rescores
  sessions under the new prompt; a test pins the prompt's hash to the version.
- 2026-11-06: Area 6 opened: a shared agent work board, designed in a dedicated thread
  (`board/PLAN.md`).
- 2026-11-07: The weekly run gained a board step: the work board's stats and open feedback go
  into the report and into proposals, which may change the board's defaults, coordinator
  prompt and rule (`board/PLAN.md`, feedback loop).
- 2026-11-07: Metrics include Codex sessions. 7-day real run: 340 sessions, 160 of them Codex
  with 771 subagent runs and 8.0B tokens (Claude Code: 180 sessions, 5.2B tokens); 112 merged
  PRs. Reading the two windows' rollouts takes about 7 seconds.
- 2026-11-07: Pricing fallback. Sonnet 5.5 cache reads cost $0.10 per MTok, not $0.20 (Anthropic's
  pricing page; LiteLLM agrees). On the real 7-day run LiteLLM's list priced gpt-6-luna,
  gpt-6.1-sol and gpt-6.1-terra: all 160 Codex sessions now have an estimate (about $2,015
  API-equivalent, beside about $2,363 for Claude Code), and none is unpriced.
- 2026-11-07: Bench at 3+ trials per configuration: all 62 runs pass, so Haiku wins every
  case on cost. The agent files stay as they are until harder cases separate the models
  (dotfiles-26).
- 2026-11-07: Setup registry and friction capture (dotfiles-32). `setups.toml` names 23 setups
  and their owners for the feedback board's triage; `setups --check` validates it. `friction
  run` judges turns that show friction and files each finding as capture feedback. On 2 days
  of real sessions it read 856 turns in about a second and flagged 154; Haiku judged the top 8
  for $0.014 and found 17 issues, mostly board length limits learned only by rejection and
  guards blocking read-only commands. Reports carry no signature of their own, so the board
  merges the same problem from different turns by setup and title. Filing waits for
  agent-board-23's `feedback --source`.
- 2026-11-07: The weekly run gained an `evolve` step (dotfiles-33): per setup, the feedback
  that came in, what waits for triage or an owner task, and what got fixed, recurred or kept
  coming after a decline. Open feedback stopped being the signal once triage closes items in
  minutes. On the real board all 3 items predate the server's feedback records, so the
  report has nothing to count until agent-board-23 is deployed.
- 2026-11-07: UI climbs (`ui/`, skill `ui-climb`). Offline suite with a real headless
  browser and a fake judge that sees only the prompt and image bytes; live smoke on
  agent-board's web view with Sonnet 5.5 and Opus 5.5 judges.
- 2026-11-07: First climb (agent-board-21): 6 rounds, Sonnet lowest 7.25 → 7.75 against a
  bar of 8.5, $2.94 of $60, stopped on plateau; PR agent-board#26. Its review
  (agent-board-54) found the gain over main partly contrast (main 8.04 in calibration,
  6.72-7.00 beside candidates), a plateau measured on gain while the lowest category bound,
  issues that never pointed at typography, a bar of 9 Sonnet gives in 6 of 372 scores,
  Opus never scoring a candidate, prompts outside the run's identity, and climb friction
  never reaching feedback. dotfiles-52..58 fix those in the command and the skill.
- 2026-11-07: Report-style bench (dotfiles-88) run: 80 runs, $2.99. The Simple Technical
  English rule kept 347/350 facts against the control's 343/350, at 8.3 words per sentence
  against 12.4. Adopted in `claude/CLAUDE.md`; Codex left for its own run.
- 2026-11-07: Compared the review setup with Anthropic's code review post (dotfiles-99).
  Reviews take 11.7% of spend, all at xhigh without verification, with a median of 15
  findings. The user chose a revert-rate circuit breaker. Section 8 has the details.
- 2026-11-08: Registered the `cheat-sheets` skill in `setups.toml` (dotfiles-200), so its
  feedback routes to the dotfiles board instead of `other`. The registry now has 28 setups.
- 2026-11-08: The UI climb council is a Haiku judge first and one Opus judge second (user,
  ask #55; dotfiles-138). Haiku must pass a round before Opus scores it. Calibration is
  already per judge (noise, control drop, bar reach); the bar is shared, and a per-judge
  bar waits on evidence from Haiku's first real calibration.
- 2026-11-09: UI climb issue ledger (dotfiles-137, dotfiles-93). Rounds print every issue,
  mark unfixed and returning ones, and tell the judges which earlier fixes are settled.
  This changes the council version, so open runs need `--new-run`. After a structural
  round, status asks for one round that fixes its issues before it advises a stop. The
  skill fixes every issue, `×1` included, and keeps the best-scoring version when judges
  alternate. The bar needed no change: 2111247 removed the typical-range sentence from the
  judge prompt, the template's `pass.min` is 8, and calibration warns on bar reach and
  suggests a bar that leads the references (c50475a). Judge diversity was settled by
  dotfiles-138.
