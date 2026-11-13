# Round 2 machines (dotfiles-546): Claude tooling, tests and instructions

Repository: scratch copy of commit 3525a13. Paths are relative to the repository root.
Each entry below replaces the round 1 entry with the same heading, or is new.
Round 1 entries that still hold are not repeated (for example "No-session-env").
Probe blocks named P-... are in probes-2.md.

Machine count: 16 (6 new, 10 corrected).

### Full-stop hold and release

- Where: `claude/skills/full-stop/SKILL.md` (lines 20, 26, 59, 66, 71-72), `claude/hooks/auto-merge.js`, `claude/tests/config.test.js` (full-stop pins at lines 830-866)
- States: draft (held), ready, auto-merge armed, auto-merge off, merged on the owner's word
- Transitions:
  - ready -> draft: the refused-draft fallback runs `gh pr ready <n> --undo`. Enforced by text at `claude/skills/full-stop/SKILL.md:20`.
  - draft -> ready: the owner's merge word runs `gh pr ready <n>`. Enforced by text at `claude/skills/full-stop/SKILL.md:71-72`.
  - PR created as a draft -> hook skips it. Enforced at `claude/hooks/auto-merge.js` (draft check). Run output: "skipped, it is a draft".
  - PR created, not a draft, checks pending -> auto-merge armed. Enforced at `claude/hooks/auto-merge.js`. Run output: "auto-merge is on (merge commit)", "graphql calls: 1".
  - PR created, not a draft, can merge now -> hook skips it. Run output: "skipped, it can merge now".
- Gaps:
  - G1 (P7) `full-stop` line 26 forbids `gh pr ready`, while lines 20 and 71-72 require it. Verdict: confirmed. Evidence: `grep -n -F 'gh pr ready' claude/skills/full-stop/SKILL.md; echo exit=$?` prints lines 20, 26, 71 and 72, then `exit=0`. Task: new (size S). Board search for "gh pr ready" finds only done tasks 250 and 350.
  - G2 (round 1 window) Auto-merge arms on a non-draft PR before the owner's word, until the agent's next step. Verdict: by design. Evidence: `claude/hooks/auto-merge.test.js:43-50` and `:89` pin arming on `gh pr create` output; `env -u RUN_CLAUDE_LIVE bun test claude/hooks/auto-merge.test.js` exits 0, 41 pass, 0 fail. Task: note on dotfiles-434 (open). Its 2026-11-12 note says both acceptance checks hold on main. Recommend closing 434 after the parent checks that note.
- Tests: `claude/hooks/auto-merge.test.js` (41 pass); `claude/tests/config.test.js:830-866` (full-stop text pins).

### Blocked state (task and ask)

- Where: `claude/CLAUDE.md:71`; `claude/skills/full-stop/SKILL.md:59` and `:66`; `claude/skills/ui-climb/SKILL.md:229`
- States: task open, ask sent, ask accepted, task blocked, ask answered
- Transitions:
  - ask sent -> task blocked when the ask is accepted. Stated at `claude/CLAUDE.md:71`.
  - ask sent -> task blocked right after the ask. Stated at `claude/skills/full-stop/SKILL.md:59` and `:66`.
  - ask sent -> task blocked until the answer. Stated at `claude/skills/ui-climb/SKILL.md:229`.
- Gaps:
  - G1 (P8) Three documents give three different times for a task to become `blocked`. Verdict: confirmed. Evidence: `grep -n -E 'blocked|accepted' claude/CLAUDE.md claude/skills/full-stop/SKILL.md claude/skills/ui-climb/SKILL.md; echo exit=$?` prints lines 71 (CLAUDE.md), 59 and 66 (full-stop), and 229 (ui-climb), then `exit=0`. Task: new (size S). Board search for "blocked task" finds only done tasks.
- Tests: none compare the three texts.

### Review effort pointer

- Where: `claude/CLAUDE.md:86`; `claude/skills/diff-review/SKILL.md`; `claude/agents/reviewer.md:5`; `claude/tests/config.test.js:87` and `:1039`
- States: effort set on the reviewer agent; effort named in the skill the rule points to
- Transitions:
  - CLAUDE.md:86 names the `diff-review` skill for the review effort -> the skill has no effort text. Not enforced. The effort is set at `claude/agents/reviewer.md:5` (`effort: high`).
- Gaps:
  - G1 (P9) The pointer at `claude/CLAUDE.md:86` names a skill that sets no effort. Verdict: confirmed. Evidence: `grep -c -i effort claude/skills/diff-review/SKILL.md; echo exit=$?` prints `0` and `exit=1`; `sed -n 5p claude/agents/reviewer.md` prints `effort: high`. Task: new (size S). Board search for "review effort" finds no open task.
- Tests: `claude/tests/config.test.js:1039` pins the pointer text. `:87` lists the reviewer's expected `effort: "high"`.

### claude-experiment preflight and cap

- Where: `claude/bin/experiment.js` (`OVER_CAP` line 43; exit text lines 66-74; no-usage report and return lines 308-309; cap return line 314); `claude/tests/claude-experiment.test.js:230` and `:232` (over-cap cases)
- States: preflight, no Messages usage seen, prompt over cap, within cap
- Transitions:
  - preflight -> no Messages usage seen: report, then return `OVER_CAP` (exit 3). Enforced at `claude/bin/experiment.js:308-309`.
  - preflight -> prompt tokens over cap: return exit 3. Enforced at `claude/bin/experiment.js:314`.
  - preflight -> within cap: the run goes on. Enforced in `claude/bin/experiment.js` (preflight, then run).
- Gaps:
  - G1 The no-usage branch returns exit 3, the same code as the over-cap branch. The exit text at lines 66-74 does not list it. Verdict: confirmed. Evidence: P-EX3 in probes-2.md. A local `Bun.serve` on 127.0.0.1 returns no usage; `env -u RUN_CLAUDE_LIVE bun test claude/tests/probe-exit3.test.js` (copied into the scratch copy) prints `PROBE code=3 OVER_CAP=3 lines=["claude-experiment preflight: no Messages usage seen"]`, 1 pass, exit 0. No model is called. Round 1 cited `claude-experiment.test.js:232` for this branch. That line is an over-cap case, so the citation is corrected. Task: new (size S). Board search for "claude-experiment exit" finds no open task on exit codes; 544 covers transcripts only.
- Tests: `claude/tests/claude-experiment.test.js` (4 skip, 0 fail with `RUN_CLAUDE_LIVE` unset, exit 0). No offline test reaches lines 308-309.

### Computer-use policy and Stop

- Where: `claude/marketplace/computer-use/server/desktop.js` (`policyPaths` 200, `readPolicy` 208-229, `STOP_SIGNALS` 233, `panelExit` 240-242, `userStop` 437-442, `noticeStop` 447-449); `claude/marketplace/computer-use/policy.json`; `claude/marketplace/computer-use/README.md` (22, 27-28, 47-53)
- States: approval auto, approval dialog, user Stop recorded, user Stop not recorded
- Transitions:
  - no state file -> bundled `policy.json` read -> approval auto. Enforced at `desktop.js:200` and `:208-229`.
  - state file says dialog -> approval dialog. Enforced at `desktop.js:208-229`; `claude/marketplace/computer-use/server/desktop.test.js:843`.
  - panel exit 0, or a signal in `STOP_SIGNALS` -> user Stop. Enforced at `desktop.js:233` and `:240-242`.
  - user Stop -> `user-stopped` file written. Enforced at `desktop.js:437-442`.
- Gaps:
  - G1 (round 1 said refuted; withdrawn) `README.md:27-28` says that with no file at all the server uses `dialog`. The code reads the bundled `policy.json` and uses `auto`. Verdict: confirmed (a document defect). Evidence: P-README in probes-2.md prints `"approval":"auto"`, exit 0. `desktop.test.js:837` pins the bundled read as auto. Task: new (size S). Board: 284 (done) changed SETUP.md, not this README.
  - G2 (round 1) README lines 47-53 say a panel kill counts as a Stop and a crash does not. Verdict: by design. Evidence: `desktop.js:233` and `:240-242` match the README. `bun probes/panel-exit.js` (scratch) prints `user Stop` for exit 0 and for SIGTERM, SIGKILL, SIGINT, SIGHUP and SIGQUIT; SIGSEGV, SIGABRT, exit 1 and exit 3 are failures. Caveat: an OS-sent SIGKILL reads as a user Stop. The real panel was not run (it needs the real screen). Task: none.
- Tests: `claude/marketplace/computer-use/server/desktop.test.js:100-101` (stop panel cases); `:837-848` (readPolicy cases).

### Computer-use input gesture (helper)

- Where: `claude/marketplace/computer-use/server/helper.swift` (`post` 223-231; drag button down 264; drag button up 271; `drag` command 392-395); `claude/marketplace/computer-use/server/desktop.js` (stop file path)
- States: gesture running (button down), gesture ended (button up posted), stop requested, stopped (exit 4)
- Transitions:
  - each event -> stop file present: exit 4 before the event is posted. Enforced at `helper.swift:223-231`.
  - drag: button down (264) -> moves -> button up (271). A stop between the two exits with the button still down. Enforced by `post()` at `helper.swift:223-231`; nothing releases the button on exit.
- Gaps:
  - G1 (round 1 gap, confirmed with a fake sink) A stop during a drag exits 4 after button-down and before button-up. The button stays down. Verdict: confirmed (fake sink; the real screen was not used). Evidence: `swiftc -typecheck claude/marketplace/computer-use/server/helper.swift; echo exit=$?` prints `exit=0` (`probes/helper-typecheck.out`). Fake sink, scratch copy only, with `post()` replaced by a stderr log and a stop-file write (P-HELPER, not rerun): prints `POST 5`, `POST 1`, `stopped by the user`, exit 4. No `POST 2` (button up) appears. Task: dotfiles-436 (open). Its body says the helper checks the stop file "before every event including the up event". The fake run is new evidence.
- Tests: none. `desktop.test.js` has no case for the helper's stop path.

### ui-climb climb, exit codes and wait

- Where: `claude/skills/ui-climb/SKILL.md` (exit codes line 19; PR step 223-225; ask 227-231; exit-4 wait 238-247); `claude/factory/ui/run.js:158-185` (reference capture retries); `claude/factory/ui/ui.test.js:1374-1414` (exit 4 pin at 1409); `claude/tests/config.test.js:865` (pins "held as a draft") and `:1217-1273` (ui-climb text pins)
- States: round running, pass (0), fail (1), error (2), budget spent (3), provisional pass (4), waiting for a re-run, asked
- Transitions:
  - reference capture fails -> retried up to `config.referenceCapture.tries`, with a doubling wait. Enforced at `claude/factory/ui/run.js:158-185`.
  - exit 4 -> the agent waits, then reruns the round on the same commit. Stated at `claude/skills/ui-climb/SKILL.md:241` and `:247`. No count or duration is given.
  - reference still missing -> ask the owner. Stated at `claude/skills/ui-climb/SKILL.md:227-231`.
  - PR opened and held as a draft. Stated at `claude/skills/ui-climb/SKILL.md:223-225`.
- Gaps:
  - G1 (round 1) Step 4 opens a non-draft PR, so auto-merge could arm before the owner answers. Verdict: refuted. Evidence: `SKILL.md:223-225` says "held as a draft as the `full-stop` skill says"; `claude/tests/config.test.js:865` pins that text. Task: none.
  - G2 (round 1) Ask option labels can exceed the 60-character `ask_user` limit. Verdict: refuted in round 1; not re-run here. Task: none.
  - G3 (round 1 wait with no time limit) The exit-4 re-run wait has no bound in the skill text. Verdict: confirmed (text). Evidence: P-UI in probes-2.md prints `0` for duration words in lines 238-247 (exit 1). The factory's own retry is bounded (`run.js:158-185`); the agent's wait is not. Task: new (size S). Board: 93 and 138 are done; neither covers the wait.
  - G4 Exit 4 means a provisional pass with a reference missing. Verdict: by design. Evidence: `claude/factory/ui/ui.test.js:1409` pins exit 4; `env -u RUN_CLAUDE_LIVE TMPDIR=<scratch>/tmp bun test claude/factory/ui/ui.test.js -t "a reference that does not capture is named"` exits 0, 1 pass (the scratch copy links `node_modules` from the headless-browser skill). Task: none.
- Tests: `claude/factory/ui/ui.test.js:1374-1414`; `claude/tests/config.test.js:1217-1273`.

### guard-runtimes depth and command words

- Where: `claude/hooks/guard-runtimes.js` (header 13-20; depth limit 137; `git remote -v` with a 2000 ms timeout 174; `findRuntimeViolation` 235; block exit 246); `claude/hooks/shell.js` (line 2 and `WRAPPERS` at line 48)
- States: runtime command word (blocked); nesting too deep (skipped); variable or substitution (not followed); node checkout check passed; node checkout check timed out (blocked, with the node reason)
- Transitions:
  - runtime command word -> blocked, exit 2. Enforced at `claude/hooks/guard-runtimes.js:235` and `:246`.
  - nesting depth 8 or more -> skipped, allowed. Enforced at `claude/hooks/guard-runtimes.js:137`.
  - `git remote -v` times out (status null) -> result false -> blocked with the node reason. Enforced at `claude/hooks/guard-runtimes.js:174`.
- Gaps:
  - G1 (round 1) `xargs -I{}` hides the runtime name in its replace string, so the guard allows the command. Verdict: confirmed. Evidence: P-XARGS in probes-2.md. `bun claude/hooks/guard-runtimes.js` on `echo python3 | xargs -I{} {} -c 'print(1)'` prints nothing and exits 0. The plain `python3 -c 'print(1)'` input exits 2. Task: new (size S). Board search for "xargs" finds only done tasks 237 and 336.
  - G2 (round 1) Variables and command substitutions are not followed. Verdict: by design. Evidence: header `claude/hooks/guard-runtimes.js:16-20`; `env -u RUN_CLAUDE_LIVE bun test claude/hooks/guard-runtimes.test.js` exits 0, 381 pass, 0 fail. Task: none.
  - G3 (round 1) Scripts nested 8 or more levels are skipped, not blocked. Verdict: by design. Evidence: `claude/hooks/guard-runtimes.test.js:283` (test "scripts nested too deeply to follow are skipped, not blocked"); the same run exits 0. Open question: dotfiles-425 lists a "tooDeep" allow as fail open for a guard. Its text names guard-main-checkout, which dotfiles-431 covers. The owner may decide whether 425 also applies here. Task: none.
  - G4 (round 1, unverified) A slow `git remote -v` makes the guard fail open. Verdict: refuted (fail-open). Evidence: P-GITTO in probes-2.md. A 3 s fake git prints `[slow git exit=2]` with a block; a fast git prints `[fast git exit=0]`. The guard fails closed. Task: none (refuted).
  - G5 (new) On a git timeout the block names the node rule, so the reason gives no sign that the git check failed. Verdict: confirmed. Evidence: P-GITTO prints "Blocked by the guard-runtimes hook: `node server.js` runs node..." on the timed-out run, exit 2. Task: new (size S). Related, not holding: dotfiles-431 covers guard-main-checkout's git timeout; dotfiles-425 is context only.
- Tests: `claude/hooks/guard-runtimes.test.js` (381 pass). No git-timeout case. The test "fails open on malformed input" at line 558 pins a non-blocking exit (see dotfiles-545).

### lean-prompt isDeferred

- Where: `claude/marketplace/lean-prompt/hooks/register.ts:6-10`; `claude/marketplace/lean-prompt/hooks/register.test.ts:13-23` (fake host `on`); `claude/marketplace/lean-prompt/hooks/hooks.json`
- States: Artifact tool deferred (`isDeferred` true, description kept); other tools unchanged
- Transitions:
  - `tool.describe` for Artifact -> `isDeferred` true. Enforced at `claude/marketplace/lean-prompt/hooks/register.ts:6-10`.
- Gaps:
  - G1 The host effect (Artifact hidden from the first request, and reachable by ToolSearch) is not checked by any offline test. Verdict: unverified in this audit. Evidence: `env -u RUN_CLAUDE_LIVE bun test claude/marketplace/lean-prompt/hooks/register.test.ts` exits 0, 2 pass; the fake host shows registration only. Board record: dotfiles-260 (done) reports a fresh session after merge with a fixed prompt of 30,038 tokens (was 43,955), and ToolSearch returning Artifact. I did not re-run it (a live session is forbidden here). Task: none open. An optional recurring check is a size S question for the owner, because live runs cost money.
- Tests: `register.test.ts` (2 pass).

### codex trust-hooks

- Where: `codex/trust-hooks.js` (header 4-10; `reviewedHooks` 22; `hooksToTrust` 27; hooks file compared with the reviewed copy 105; approve set 121-122; `config/batchWrite` 126-134 with `expectedVersion: null`; exit status comment 94; server closed in `finally` 139-140)
- States: hooks file matches the reviewed copy, or not; hook pending, trusted, or changed; approval written, or not; server open, or closed
- Transitions:
  - file matches the reviewed copy (105) -> pending hooks join the approve set (121-122).
  - approve set -> `config/batchWrite` approves them (126-134), with the hashes read from `hooks/list`.
  - a write to the hooks file during `hooks/list` -> the write still approves the changed hash. Not enforced.
  - any exit -> server closed. Enforced at `codex/trust-hooks.js:139-140`.
- Gaps:
  - G1 (round 1) `batchWrite` sends `expectedVersion: null`, so a concurrent config write is not detected. Verdict: by design. Evidence: `claude/tests/codex-trust-hooks.test.js:98` pins it; `env -u RUN_CLAUDE_LIVE bun test claude/tests/codex-trust-hooks.test.js` exits 0, 6 pass. Task: none.
  - G2 (round 1) A stale origin/main leaves hooks unapproved until the change merges. Verdict: by design. Evidence: header `codex/trust-hooks.js:4-10`; the same run, 6 pass. Task: none.
  - G3 (G-T1, new) The hooks file is compared at line 105, then hooks are listed and approved. A change during that window is approved with the new hash. Verdict: confirmed (fake app-server). Evidence: P-GT1 in probes-2.md. Race mode prints `"status":0`, an approved hash `sha256:evil`, `fileMatchesReviewedAtEnd` false, and the log line "approved 1 hooks". Clean mode approves `sha256:ok` with `fileMatchesReviewedAtEnd` true. The real Codex app-server was not started (the audit forbids starting codex). Task: new (size M). Related, not holding: 464 and 91 (done) cover approval by hand.
- Tests: `claude/tests/codex-trust-hooks.test.js` (6 pass). No test covers a change between the check and the write.

### Codex example config model

- Where: `codex/config.example.toml:1`; `codex/AGENTS.md:6`; `claude/tests/config.test.js:936-939` (AGENTS.md pin) and `:1416-1440` (models scan, `claude/` folders only)
- States: example model is a Claude model; example model is a GPT model
- Transitions:
  - example file copied unchanged -> the active Codex config holds the GPT model. Not enforced.
- Gaps:
  - G1 `codex/config.example.toml:1` sets `model = "gpt-5.4"`, which breaks the Claude-only rule. Verdict: confirmed. Evidence: P-CFG in probes-2.md: `grep -n '^model' codex/config.example.toml` prints `1:model = "gpt-5.4"`. `env -u RUN_CLAUDE_LIVE bun test claude/tests/config.test.js` exits 0, 134 pass, with the GPT line present, because the models scan covers `claude/` only. Task: new (size S). Related, not holding: dotfiles-195 (open, p3: gpt-* models in T3 delegate calls); dotfiles-191 (done: Codex-only files decision).
  - G2 `codex/AGENTS.md:6` tells the agent to stop and ask instead of running Codex. Verdict: by design. Evidence: `claude/tests/config.test.js:936-939` pins it; the same run exits 0. Task: none.
- Tests: `claude/tests/config.test.js` (134 pass).

### Live suite session and teardown

- Where: `claude/tests/lib/live.js` (`noteOutside` 217-218; `noteRefused` 220-222; refused branches and catch 243-250; `noteOutside` after the output check 254; teardown 311-324, with `stopLeftovers` at 316 and `removeSessionArtifacts` at 317); `claude/tests/lib/cleanup.js:9` (`projectName`) and `:23` (`removeSessionArtifacts`)
- States: session with cwd outside the suite root; recorded in `outside[]`; session failed (timeout or error); teardown run; leftovers stopped; transcript removed
- Transitions:
  - session returns output -> recorded. Enforced at `claude/tests/lib/live.js:254`.
  - session refused -> recorded. Enforced at `claude/tests/lib/live.js:222`, from the branches at 243-245.
  - session throws (timeout or error) -> not recorded. Not enforced: the catch at 243-250 does not call `noteOutside`.
  - teardown -> `stopLeftovers` (316), then `removeSessionArtifacts` (317). Enforced at `claude/tests/lib/live.js:311-324`.
  - `stopLeftovers` throws -> `removeSessionArtifacts` is skipped. Not enforced.
- Gaps:
  - G-L1 A session with cwd outside the root that times out is not recorded, so its transcript stays after teardown. Verdict: confirmed. Evidence: P-GL1 in probes-2.md. The output has `"sessionError":"Process timeout after 1000 ms..."`, `"teardownError":"none"`, `"transcriptRemains":true`, exit 0. The control with `L_MODE=complete` prints `"transcriptRemains":false`. Task: dotfiles-544 (open; its acceptance: "Creators in this repository keep no transcript or remove it, with a test"). New evidence: this probe.
  - G-L2 If `stopLeftovers` throws, teardown skips artifact removal, so transcripts stay. Verdict: confirmed with an injected fault (scratch copy only). Evidence: P-GL2 in probes-2.md prints `"teardownError":"injected stopLeftovers failure"`, `"transcriptRemains":true`, exit 0. Without the fault `transcriptRemains` is false. Limit: a real `stopLeftovers` failure was not produced. Task: dotfiles-544 (same acceptance).
- Tests: `claude/tests/harness.test.js:181-187` runs the live-policy failure modes and checks cleanup, with cwd inside the root only. It runs `live*.test.js` as child processes (see Feedback), so it was not run here.

### runProcess timeout settle

- Where: `claude/tests/lib/process.js` (`stopLeftovers` 96-115; `runProcess` 135-227; kill helpers 161-168; timer 171-173; `child.on("close")` 218)
- States: running, timeout fired, descendants and group killed, settled (resolved or rejected)
- Transitions:
  - timeout fires -> SIGKILL to tracked descendants (161-163) and to the process group (166). Enforced at `claude/tests/lib/process.js:161-173`.
  - child exits -> settle on `close` (218). Enforced at `claude/tests/lib/process.js:218`. `close` waits until stdout closes, so a reparented grandchild that holds stdout delays the settle.
- Gaps:
  - G-P1 A grandchild that calls `setsid`, is reparented, and holds stdout open delays the rejection until it exits. Verdict: confirmed. Evidence: P-GP1 in probes-2.md prints `REJECTED after 12024 ms: Process timeout after 2000 ms: sh` (12029 and 12030 ms in earlier runs), exit 0. A `kill -0` on the grandchild pid afterwards fails, so it is dead. Task: new (size M). Related, not holding: dotfiles-286 (open) records process.test.js failing under load; it does not name this gap.
- Tests: none for a grandchild that holds stdout. `claude/tests/lib/process.test.js:102-131` covers a descendant that stays under the intermediate process.

### Guidance symlink chain

- Where: `claude/tests/lib/guidance.js` (`canonical` 14; `guidanceTargets` 19-31, symlink chain loop 22-25; `scoreGuidance` 101); used by `claude/tests/live-dispatch.test.js:9` and `:111-112`
- States: path is a file; path is a symlink; chain resolves to a file; chain forms a cycle
- Transitions:
  - symlink -> resolve its target and repeat while the target is a symlink. Enforced at `claude/tests/lib/guidance.js:22-25`. No cycle guard.
- Gaps:
  - G-G1 A symlink cycle makes `guidanceTargets` loop without end. Verdict: confirmed. Evidence: P-GG1 in probes-2.md. A chain of one link prints `RETURNED spellings= 2`, exit 0. The `loop-a` to `loop-b` cycle never returns and exits 142 under `perl -e 'alarm 5; exec @ARGV'`. Severity low: the code is in a live test helper. Task: new (size S). No board match.
- Tests: none for a cycle.

### block-installs hook input

- Where: `claude/tests/lib/hooks/block-installs.js` (header 1-2; download pattern 4; `JSON.parse` of stdin 51; Bash download check 54; exit 2 at 57); used by `claude/tests/lib/live.js:191` and `claude/factory/bench/runner.js:15`; `claude/tests/lib/hooks.test.js:9-28` (valid inputs only)
- States: input parsed; input malformed or empty (uncaught); install or download blocked; other call allowed
- Transitions:
  - malformed or empty stdin -> uncaught error at 51 -> exit 1, a non-blocking hook error, so the call runs. Not enforced.
  - install or download command -> exit 2, blocked. Enforced at lines 54-57.
  - other call -> exit 0. Falls through with no exit call.
- Gaps:
  - G-B1 Malformed stdin exits 1, so the call proceeds, while the header (lines 1-2) says exit 2 blocks. Verdict: confirmed. Evidence: P-BI in probes-2.md. `printf 'not json' | bun claude/tests/lib/hooks/block-installs.js` exits 1 with a stack trace at line 51. Empty stdin exits 1. `npm install left-pad` exits 2. `ls` exits 0. Task: dotfiles-545 (open). Its acceptance asks each guard to have a malformed-stdin test with the same result. 545 names `guard-runtimes.js` and not this hook. Severity lower: the hook runs only in live fixtures and the bench runner.
- Tests: `claude/tests/lib/hooks.test.js:9-28` (valid inputs only). No malformed-input case found.

### Codex hook registration (new)

- Where: `codex/hooks.json` (registers `guard-git-push.js` and `guard-runtimes.js` on the Bash matcher, lines 3-19); `claude/settings.json` (registers 10 hook scripts, including `guard-main-checkout.js`, `guard-pr-merge.js`, `guard-asks.js`, `worktree-rule.js`)
- States: hook listed for Codex, hook not listed for Codex
- Transitions:
  - hook added to `claude/settings.json` -> not added to `codex/hooks.json`. Not enforced: no test compares the two lists.
- Gaps:
  - G1 The Codex file omits four guard hooks that the Claude settings register. Verdict: unverified. Evidence: `grep -o 'hooks/[a-z-]*\.js' repo/claude/settings.json | sort -u` lists 10 names; the same command on `repo/codex/hooks.json` lists 2 (both exit 0). `grep -rn -i` for `codex.*hooks`, `guard-pr-merge` in `codex/`, `claude/tests/` and `SETUP.md` shows only `codex/trust-hooks.js` and its test in the first 12 hits. A run cannot show whether the subset is intended, so the owner decides. Task: new (owner question; not filed by me).
- Tests: none compare the two lists.
