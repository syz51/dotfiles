# Implicit state machines: Claude tooling and agent instructions

Scope: `claude/bin`, `claude/tests`, `claude/marketplace/computer-use`, and the prose in `claude/CLAUDE.md`, `claude/agents`, `claude/reference`, `claude/skills` and `claude/hooks/ask-policy.json`. Hooks and the factory are out of scope, except where a probe calls a hook function. Scratch copy: HEAD 3525a13. Machines: 12. Probes are in `probes.md`. `<scratch>` means the e2-tooling scratch folder.

### API key state and lock (api-first)

- Where: `claude/bin/api-first.js`, `claude/bin/claude-api`, `claude/bin/api-first/claude`
- States: unchecked, ok, invalid, exhausted, refused, unknown, locked, stale lock
- Transitions:
  - unchecked -> ok, invalid, exhausted, refused or unknown: credit check result is stored. Enforced at `claude/bin/api-first.js:348` (check runs outside the lock) and `:349` (result stored under the lock).
  - free -> locked -> free: lock file held for one decision. Enforced at `claude/bin/api-first.js:186-206` (release at `:204`).
  - locked -> stale -> taken over: a lock older than 2000 ms is removed with no compare. Enforced at `claude/bin/api-first.js:196`.
  - check result by status: 200 -> ok; 401/403 -> invalid; 400/402 with credit wording -> exhausted; other 4xx except 404/408/409/429 -> refused; else unknown. Enforced at `claude/bin/api-first.js:138-167`.
- Gaps:
  - G1 Two runs can check the same key at the same time, so two credit checks run. Verdict: confirmed. Evidence: `bun probe-dup.js` exit 0 prints `{"case":"concurrent","checks":2,...}` and `{"case":"sequential","checks":1,...}` (`logs/probe-dup.txt`). Task: dotfiles-425 (api-first item, "key check runs outside the lock"); new evidence.
  - G2 A stale-lock takeover can delete a lock that another run has just created. Verdict: confirmed under an injected pause; the real window is small. Evidence: `logs/lock-injected-A.txt` (in 1794596706889, out 1794596708400); `logs/lock-injected-B.txt` (in 1794596707349, before A's out); control `logs/lock-control.txt` has no overlap. Task: new (same pattern as dotfiles-342, which is the freshen-base lock, a different file).
  - G3 A 429 response never starts a backoff. Verdict: by design. Evidence: 429 is excluded from refused at `claude/bin/api-first.js:165`, so it maps to unknown; `env -u RUN_CLAUDE_LIVE HOME=<scratch>/home bun test claude/tests/claude-api.test.js` exit 0, 47 tests pass (test at `claude/tests/claude-api.test.js:110`). Task: none.
  - G4 A refused key stays out for up to 8 h. Verdict: by design. Evidence: `claude/bin/api-first.js:58` (MAX_BACKOFF_MS); test at `claude/tests/claude-api.test.js:224`; same run, exit 0. Task: none.
  - G5 A run that uses its own apiKeyHelper reports no cost. Verdict: by design. Evidence: `claude/tests/claude-api.test.js:84` and `:93` pin the merged settings with no hooks; `claude/bin/api-first.js:125`; same run, exit 0. Task: none. Its cost is unknown, so see the spend ledger below.
- Tests: `claude/tests/claude-api.test.js` (47 pass, exit 0).

### Spend ledger (decisions.jsonl)

- Where: `claude/bin/api-first.js` (decision log at `:76`, spend total at `:458-473`, summary line at `:492`, command at `:495-525`)
- States: run logged, cost known, cost unknown (not reported yet), cost untracked, logged before costs were recorded
- Transitions:
  - run starts in api mode -> logged. Enforced at `claude/bin/api-first.js:523-542` (main).
  - unknown -> known: the Stop, StopFailure or SessionEnd hook reports cost. Enforced at `claude/bin/api-first.js:222-229`.
  - unknown with no cost -> counted as unreported. Enforced at `claude/bin/api-first.js:473`.
- Gaps:
  - G1 A run with no cost is shown only in the all-time total. `--days 30` drops it, and the command still exits 0. Verdict: confirmed. Evidence: `API_FIRST_STATE=<scratch>/probes/spend-aging HOME=<scratch>/home bun claude/bin/api-first.js spend` exit 0, row `probe 1 1 $0.0000` and "not reported yet" (`logs/spend-aging-all.txt`); `... spend --days 30` exit 0 with empty tables (`logs/spend-aging-30.txt`). Task: new.
- Tests: `claude/tests/claude-api.test.js:503-562` pin the all-time totals, including `unreported: 1`. No test uses `--days`.

### claude-experiment preflight and cap

- Where: `claude/bin/experiment.js` (`OVER_CAP` at `:43`, preflight report and return at `:308-309`), `claude/bin/claude-experiment`
- States: preflight with no usage seen, preflight with usage within cap, preflight over cap, run passed, run failed
- Transitions:
  - no usage seen -> exit 3 (OVER_CAP). Enforced at `claude/bin/experiment.js:308-309`.
  - usage over cap -> exit 3. Enforced by the same return code.
  - usage within cap -> run. Enforced in `claude/bin/experiment.js` (preflight, then run).
- Gaps:
  - G1 "No usage seen" and "over cap" both exit 3, so a caller that reads only the exit code cannot tell them apart. Verdict: by design. Evidence: `claude/tests/claude-experiment.test.js:232` expects OVER_CAP for no usage; `env -u RUN_CLAUDE_LIVE HOME=<scratch>/home bun test claude/tests/claude-experiment.test.js` exit 0, 29 pass. Probe: no-usage run prints "no Messages usage seen" and `EXIT_CODE 3`; usage run exits 0 (`logs/probe-preflight-nousage.txt`, `logs/probe-preflight-usage.txt`). Task: none; open question for the owner (distinct exit code or keep).
- Tests: `claude/tests/claude-experiment.test.js` (29 pass, exit 0).

### Computer-use session lock and approval log

- Where: `claude/marketplace/computer-use/server/desktop.js` (`holdLock` at `:390-413`, rename at `:406`, lost-lock error at `:461`, `logApproval` at `:514`, approve path at `:573-596`); state files `session.json` and `approvals.log` in the state folder
- States: free, held by a session (pid), stale (holder dead), taken over, lost by a session
- Transitions:
  - free -> held: `holdLock` at `claude/marketplace/computer-use/server/desktop.js:390-413`.
  - held by a dead pid -> taken over: rename to an aside name at `desktop.js:406`.
  - held by another pid -> lost: a later call fails with "lost the session lock" at `desktop.js:461`.
  - approval logged, then the lock is taken again: `desktop.js:586` (log) then `:596` (holdLock).
- Gaps:
  - G1 During a stale-lock takeover, two sessions both get "Approved", and one of them then loses the session lock. Verdict: confirmed (fake helper, injected pause). Evidence: `logs/desk-injected-100.txt` ("pid 100 request_access: Approved", then "pid 100 open_app ERROR: This session lost the session lock"); `logs/desk-injected-200.txt` ("pid 200 request_access: Approved"); `session.json` ends `{"pid":200}`. Control `logs/desk-control-100.txt`: pid 100 is refused with "Another session (pid 200) is controlling this computer". Real window: the `ps` call inside `holdsLock`, tens of milliseconds (estimate, not measured). Task: dotfiles-436 item 3.
  - G2 An approval is logged by a session that then loses the lock. Verdict: confirmed. Evidence: `probes/desk-injected/approvals.log` has 2 lines (19:05:14.127Z and 19:05:14.337Z); `probes/desk-control/approvals.log` has 1 line. Task: dotfiles-436 item 2.
- Tests: `claude/marketplace/computer-use/server/desktop.test.js` (149 pass, exit 0). It covers takeover of a dead holder (about line 505). No test covers two sessions that take over the same stale lock at once, or an approval after a lost lock.

### Computer-use policy and Stop

- Where: `claude/marketplace/computer-use/server/desktop.js` (`policyPaths` at `:200`, `readPolicy` at `:208-229`, `userStop` at `:437-442`, `noticeStop` at `:447-449`); `claude/marketplace/computer-use/policy.json`; `claude/marketplace/computer-use/README.md`
- States: approval auto, approval dialog, user-stopped set, user-stopped unset
- Transitions:
  - no user policy file -> bundled `policy.json` (auto). Enforced at `claude/marketplace/computer-use/server/desktop.js:200`.
  - Stop -> `user-stopped` written, session ends, dialog until the user allows apps. Enforced at `desktop.js:437-442`; the README says so at lines 49-52.
  - policy read at each `request_access`. Enforced at `desktop.js:778`.
- Gaps:
  - G1 The README says that with no file at all, the server uses dialog. Verdict: refuted. Evidence: `bun probe-policy.js <scratch>/probes/policy-default/state` exit 0 prints `"approval":"auto"` (`logs/probe-policy-default.txt`), because the bundled policy is always in the list. README lines 27-28 say dialog. Task: new (README fix).
  - G2 The README says killing the panel counts as a Stop (lines 47-48), and a crash does not (lines 52-53). The line between them is not defined. Verdict: unverified; the panel is a helper process that the brief forbids running. Task: new (README wording).
- Tests: `claude/marketplace/computer-use/server/desktop.test.js:837-849` (readPolicy cases; file exit 0).

### Computer-use input gesture (helper)

- Where: `claude/marketplace/computer-use/server/helper.swift` (`post` at `:223-232`, `click` at `:242-259`, `drag` at `:261-272`, `typeText` at `:274-294`, `pressKey` at `:296-298`, overlay stop at `:349-352`)
- States: idle, button or key down posted, dragging, up posted, stopped (exit 4), overlay stopped (exit 0, stop file written)
- Transitions:
  - any event, stop file present -> exit 4. Enforced at `helper.swift:223-227` (`post` checks before each event).
  - down -> up: click at `:251-257`, drag at `:264-271`, key at `:297`. The stop check runs before the up event, so a stop between them skips the up event.
  - overlay Stop button or Esc -> stop file written, exit 0. Enforced at `helper.swift:349-352`.
- Gaps:
  - G1 A Stop between a button or key down and its up leaves the button or key held. Verdict: unverified. Evidence: reading only (`helper.swift:223-227`, `:264-271`); the brief forbids running `helper.swift`, and the `desktop.js` kill path (about line 780) was not probed. Task: dotfiles-436 item 1.
  - G2 The helper has no test. Verdict: confirmed by search: no `*.test.*` file names `helper.swift`; `desktop.test.js` uses a fake helper. Evidence: `grep -rl helper.swift claude/tests claude/marketplace --include=*.test.js` finds no test file. Task: dotfiles-439 (the computer-use helper as a whole, listed there).
- Tests: none for `helper.swift`.

### Ask gate (ask-policy)

- Where: `claude/hooks/ask-policy.json` (`only-me` definition at line 7, `action_reasons` at line 11); `claude/hooks/guard-asks.js:33-34` (hook, out of scope; called by the probe); `claude/hooks/guard-asks.test.js`; `claude/tests/config.test.js:405-406, 854-858`
- States: ask kind decision, ask kind action, reason label present, reason label absent, allowed, blocked
- Transitions:
  - action with a reason in `action_reasons` -> allowed. Enforced at `claude/hooks/guard-asks.js:33-34`.
  - action with another reason, or with no reason -> blocked. Enforced at `claude/hooks/guard-asks.js:33-34`.
  - decision with any reason -> allowed. Enforced by the label check.
- Gaps:
  - G1 The gate checks only the label. An action ask labelled `only-me` passes for a merge decision, although `ask-policy.json:7` defines only-me as "a step that needs the user in person". Verdict: by design (pinned), but the policy text and the full-stop use disagree. Evidence: `bun probe-ask.js` prints "full-stop hand-over (merge decision, only-me): ALLOWED" and "action ask with cost reason: BLOCKED" (`logs/probe-ask.txt`); `claude/tests/config.test.js:854-858` pins `kind: "action"` with `Reason: only-me` for the full-stop hand-over; `claude/hooks/guard-asks.test.js:17-18` pins only-me as the action reason. Task: new (owner decision: is a merge an only-me step?).
  - Related, not re-verified: dotfiles-545 holds guard-asks.js fail-open on malformed stdin (line 40).
- Tests: `claude/hooks/guard-asks.test.js`, `claude/tests/config.test.js`.

### Full-stop hold and release

- Where: `claude/skills/full-stop/SKILL.md` (hold at `:13-29`, draft and `gh pr ready` at `:18-28`, blocked at `:59-66`, release at `:71-74`)
- States: working, draft (hold), ready, merged, blocked
- Transitions:
  - working -> draft: `gh pr create --draft` (`SKILL.md:18`); if GitHub refuses, a non-draft PR is made and turned to draft at once (`:21-22`).
  - draft -> ready -> merged: the user says merge; the skill runs `gh pr ready <n>`, then merges (`:71-72`).
  - working -> blocked: the skill asks with what blocks it (`:59`, `:66`).
- Gaps:
  - G1 The skill both forbids and requires `gh pr ready`. Verdict: confirmed by text (the grep shows the three statements). Evidence: `grep -n 'gh pr ready' claude/skills/full-stop/SKILL.md` exit 0: line 20 (`gh pr ready <n> --undo`), line 26 ("Never run `gh pr ready`, merge, ..."), lines 71-72 (release runs `gh pr ready <n>`). Task: new.
  - G2 Between the ready step and the merge, auto-merge could arm on a non-draft PR. Verdict: unverified; `auto-merge.js` is out of scope and was not run. Related: `auto-merge.js:107` skips drafts; `claude/tests/config.test.js:842-847` pins the draft hold. Task: new.
- Tests: `claude/tests/config.test.js:832-858`.

### ui-climb climb, exit codes and wait

- Where: `claude/skills/ui-climb/SKILL.md` (exit codes at `:19`, PR step at `:223-225`, ask at `:227-231`, exit-4 wait at `:240-247`)
- States: round, pass (0), fail (1), error (2), budget spent (3), provisional pass (4), waiting on a reference, asked
- Transitions:
  - exit 4 -> wait -> ask the owner (`Reason: design`) when the reference stays down. Enforced by the skill text at `:240-247`.
  - PR opened held as a draft, then the owner's answer. Enforced by the skill text at `:223-229`.
- Gaps:
  - G1 Step 4 opens a non-draft PR, so auto-merge can arm before the owner answers. Verdict: refuted. Evidence: `claude/skills/ui-climb/SKILL.md:223-224` says the PR is "held as a draft as the `full-stop` skill says"; `claude/tests/config.test.js:842-847` pins the draft. Task: dotfiles-434 item 1 refuted.
  - G2 The first ask options are longer than `ask_user`'s 60 characters. Verdict: refuted. Evidence: option labels at `SKILL.md:139-150` have 33, 11, 33, 46 and 13 characters. The `ask_user` schema sets `maxLength` 60 per option (ToolSearch, `select:mcp__board__ask_user`). The "about 165 characters" figure counts the label plus the description, and the description is in the question body. Task: dotfiles-434 item 2 refuted.
  - G3 The exit-4 wait has no time limit. Verdict: unverified; `SKILL.md:240-247` gives no time, and the `ui` command is in the factory (out of scope). Task: new.
- Tests: none for the ui-climb skill text; `claude/tests/config.test.js` covers the full-stop text.

### Blocked state (task and ask)

- Where: `claude/CLAUDE.md:71`, `claude/skills/full-stop/SKILL.md:59`, `claude/skills/ui-climb/SKILL.md:229`; the board CLI (`board claim` resumes a blocked task)
- States: task open, doing, blocked; ask open, answered, withdrawn
- Transitions: ask accepted -> task blocked (`CLAUDE.md:71`); ask sent -> task blocked (`full-stop SKILL.md:59`); until the answer -> blocked (`ui-climb SKILL.md:229`).
- Gaps:
  - G1 The three documents set different times to mark a task `blocked`. Verdict: confirmed by text (`grep -n blocked` exit 0 shows all three lines). Task: new.
- Tests: none.

### Review effort pointer

- Where: `claude/CLAUDE.md:86`, `claude/agents/reviewer.md:5`, `claude/skills/diff-review/SKILL.md`
- States: none (configuration)
- Transitions: none
- Gaps:
  - G1 `CLAUDE.md:86` says the review runs "at `high` effort as its `diff-review` skill says". The skill has no effort text (`grep -c -i effort` prints 0, exit 1). The effort is set in `reviewer.md:5` (`effort: high`). Verdict: confirmed by text. Task: new (low impact).
- Tests: none.

### No-session-env

- Where: `claude/bin/no-session-env` (21 lines), `claude/bin/session-env.js` (12 lines)
- States: session variables present, removed; bun missing (fail closed)
- Transitions:
  - environment -> list of session names. Enforced at `claude/bin/session-env.js:6-8`.
  - list -> unset and exec. Enforced at `claude/bin/no-session-env:15-21`.
  - bun missing -> failure, no command run. Enforced at `claude/bin/no-session-env:13` (fallback path) and pinned by `claude/tests/no-session-env.test.js:87-91`.
- Gaps:
  - None found. The fail-closed case is pinned by `claude/tests/no-session-env.test.js:87-91`. Run: `env -u RUN_CLAUDE_LIVE HOME=<scratch>/home bun test claude/tests/no-session-env.test.js`, exit 0, 9 pass.
- Tests: `claude/tests/no-session-env.test.js`.
