# Round 2 probes (dotfiles-546)

Each fenced `bash` block runs in the scratch copy of commit 3525a13 (`$R2/repo`). Nothing here calls a model, a paid API, or the real screen.
Run every block at once: extract the fenced blocks to a script, then run it with `R2` set.

```
R2=<r2-tooling scratch folder> bash <script>
```

Set the folder first. The next block reads it:

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
export R2 TMPDIR="$R2/tmp"
mkdir -p "$TMPDIR" "$R2/probes/rerun"
cd "$R2/repo" || exit 1
```

## P7 full-stop: gh pr ready required and forbidden

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
grep -n -F 'gh pr ready' "$R2/repo/claude/skills/full-stop/SKILL.md"; echo "exit=$?"
```

Expected: lines 20, 26, 71 and 72 print, then `exit=0`.

Proposed task: "Make one rule for gh pr ready in full-stop" (size S).
- Problem: the skill both requires `gh pr ready` (lines 20, 71-72) and forbids it (line 26).
- Change: keep one rule in `claude/skills/full-stop/SKILL.md`, and pin it in `claude/tests/config.test.js`.

## P8 blocked timing: three documents, three times

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
grep -n -E 'blocked|accepted' "$R2/repo/claude/CLAUDE.md" "$R2/repo/claude/skills/full-stop/SKILL.md" "$R2/repo/claude/skills/ui-climb/SKILL.md"; echo "exit=$?"
```

Expected: `claude/CLAUDE.md:71` (accepted), `full-stop/SKILL.md:59` and `:66`, and `ui-climb/SKILL.md:229` appear among the matches, then `exit=0`.

Proposed task: "Set one rule for when a task becomes blocked" (size S).
- Problem: CLAUDE.md:71 blocks on accept, full-stop:59 and :66 block right after the ask, ui-climb:229 blocks until the answer.
- Change: state one time in one place, and pin the other documents to it.

## P9 review effort pointer names a skill with no effort

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
grep -c -i effort "$R2/repo/claude/skills/diff-review/SKILL.md"; echo "exit=$?"
sed -n 5p "$R2/repo/claude/agents/reviewer.md"
sed -n 86p "$R2/repo/claude/CLAUDE.md" | cut -c1-200
```

Expected: `0` and `exit=1`; then `effort: high`; then the CLAUDE.md:86 text that names `diff-review`.

Proposed task: "Point the review effort in CLAUDE.md at reviewer.md" (size S).
- Problem: CLAUDE.md:86 says the effort is in the `diff-review` skill. That skill has no effort text. The value is in `claude/agents/reviewer.md:5`.
- Change: name `claude/agents/reviewer.md` in CLAUDE.md:86, and pin it in `claude/tests/config.test.js:1039`.

## Experiment exit 3 on the no-usage preflight

The probe copies its test into the scratch copy, runs it, and removes the copy. It uses a local `Bun.serve` upstream and a fake claude that curls it. It makes no model call.

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
mkdir -p "$TMPDIR"
cp "$R2/probes/probe-exit3.test.js" "$R2/repo/claude/tests/probe-exit3.test.js"
(cd "$R2/repo" && env -u RUN_CLAUDE_LIVE bun test claude/tests/probe-exit3.test.js > "$R2/probes/rerun/ex3.out" 2>&1); echo "exit=$?"
rm -f "$R2/repo/claude/tests/probe-exit3.test.js"
grep -h "PROBE" "$R2/probes/rerun/ex3.out" | cut -c1-200
```

Expected: `exit=0`, one `PROBE code=3 OVER_CAP=3 lines=["claude-experiment preflight: no Messages usage seen"]` line, and 1 pass.

Proposed task: "Give the claude-experiment no-usage preflight its own exit code and a test" (size S).
- Problem: `claude/bin/experiment.js:308-309` returns `OVER_CAP` (exit 3) for a missing usage report. The exit text at lines 66-74 lists exit 3 for over-cap only.
- Change: give this branch its own exit code, document it, and add a test. Fix the round 1 citation: `claude/tests/claude-experiment.test.js:232` is an over-cap case.

## Computer-use README default: no file means auto, not dialog

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
mkdir -p "$R2/probes/policy-none"
bun "$R2/probes/probe-policy.js" "$R2/probes/policy-none"; echo "exit=$?"
sed -n 27,28p "$R2/repo/claude/marketplace/computer-use/README.md" | cut -c1-200
```

Expected: JSON with `"approval":"auto"`, then `exit=0`, then README lines 27-28, which say `dialog`.

Proposed task: "Correct the computer-use README's no-file default to auto" (size S).
- Problem: README:27-28 says the server uses `dialog` with no file. `readPolicy` reads the bundled `policy.json` and returns `auto`.
- Change: correct the README. dotfiles-284 (done) updated SETUP.md, not this README.

## ui-climb exit-4 re-run wait has no time limit

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
sed -n '238,247p' "$R2/repo/claude/skills/ui-climb/SKILL.md" | grep -c -i -E 'minute|second|hour|until'; echo "exit=$?"
```

Expected: `0` and `exit=1`. No duration or count word appears in the wait text.

Proposed task: "Bound the ui-climb exit-4 re-run wait in SKILL.md" (size S).
- Problem: SKILL.md:238-247 waits for a re-run with no count or duration. The factory retry is bounded (`claude/factory/ui/run.js:158-185`).
- Change: give the agent's wait a count and a limit, and pin it in `claude/tests/config.test.js:1217-1273`.

## xargs hides the runtime name: guard-runtimes allows python3

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
(cd "$R2/repo" && bun claude/hooks/guard-runtimes.js < "$R2/probes/xargs-input.json" > "$R2/probes/rerun/xargs.out" 2>&1); echo "xargs exit=$?"
(cd "$R2/repo" && bun claude/hooks/guard-runtimes.js < "$R2/probes/python-control-input.json" > "$R2/probes/rerun/control.out" 2>&1); echo "control exit=$?"
```

Expected: `xargs exit=0` with an empty `xargs.out`. `control exit=2` with the python block message in `control.out`.

Proposed task: "Handle xargs replace strings in guard-runtimes" (size S).
- Problem: `echo python3 | xargs -I{} {} -c ...` runs python3, and the guard only reads the command words.
- Change: resolve `xargs -I` replace strings before the runtime check, and add a test in `claude/hooks/guard-runtimes.test.js`.

## guard-runtimes on a git timeout: block names the node rule

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
sh "$R2/probes/guard-runtimes-git-timeout.sh" "$R2/repo" "$R2/probes" > "$R2/probes/rerun/gittimeout.out" 2>&1; echo "script exit=$?"
cut -c1-120 "$R2/probes/rerun/gittimeout.out"
```

Expected: `[fast git exit=0]`, then the slow run prints "Blocked by the guard-runtimes hook: `node server.js` runs node...", then `[slow git exit=2]`.

Proposed task: "Name the git timeout in guard-runtimes' node-checkout reason and test it" (size S).
- Problem: `claude/hooks/guard-runtimes.js:174` treats a git timeout as "not a checkout", so the block shows only the node reason. The fail-open claim is refuted: the slow run blocks.
- Change: name the git timeout in the block reason, and add a test with a slow fake git.

## runProcess settles at stdout close, after a timeout

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
G_P1_PIDFILE="$R2/probes/g-p1.pid" bun "$R2/probes/g-p1-probe.js" > "$R2/probes/rerun/gp1.out" 2>&1; echo "exit=$?"
cut -c1-160 "$R2/probes/rerun/gp1.out" | head -3
kill -0 "$(cat "$R2/probes/g-p1.pid")" 2>/dev/null; echo "grandchild alive exit=$?"
```

Expected: `exit=0`, a `REJECTED after N ms: Process timeout after 2000 ms: sh` line with N near 12000, and `grandchild alive exit=1` (dead). The 2000 ms timeout takes about 12 s to reject.

Proposed task: "Settle runProcess at the timeout, not at stdout close" (size M).
- Problem: `claude/tests/lib/process.js:218` settles on `close`. A reparented grandchild holding stdout delays the rejection.
- Change: settle on timeout after the kill, and add a test in `claude/tests/lib/process.test.js` with a grandchild that holds stdout. Related, not holding: dotfiles-286 (open).

## guidanceTargets loops on a symlink cycle

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
G_G1_PATH="$R2/probes/g-g1/chain-ok" bun "$R2/probes/g-g1-probe.js" > "$R2/probes/rerun/gg1-ok.out" 2>&1; echo "chain exit=$?"
cut -c1-120 "$R2/probes/rerun/gg1-ok.out"
G_G1_PATH="$R2/probes/g-g1/loop-a" perl -e 'alarm 5; exec @ARGV' bun "$R2/probes/g-g1-probe.js" > "$R2/probes/rerun/gg1-loop.out" 2>&1; echo "loop exit=$?"
```

Expected: `chain exit=0` with `RETURNED spellings= 2`. `loop exit=142` (SIGALRM after 5 s) with no `RETURNED` line.

Proposed task: "Stop guidanceTargets on a symlink cycle" (size S). Severity low: the helper runs only in live test fixtures.
- Problem: `claude/tests/lib/guidance.js:22-25` follows symlinks with no cycle guard.
- Change: stop on a seen path and throw a named error. Add a test with a two-link cycle.

## trust-hooks approves a hook changed during the check

The fake app-server changes the hooks file between the check and the write. The real Codex app-server is not started.

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
for mode in clean race; do
  mkdir -p "$R2/probes/g-t/run-$mode"
  G_T_DIR="$R2/probes/g-t/run-$mode" G_T_MODE="$mode" bun "$R2/probes/g-t/g-t-probe.js" > "$R2/probes/rerun/g-t-$mode.out" 2>&1; echo "$mode exit=$?"
  cut -c1-260 "$R2/probes/rerun/g-t-$mode.out" | head -3
done
```

Expected: `clean exit=0` with `sha256:ok` and `fileMatchesReviewedAtEnd` true. `race exit=0` with `sha256:evil`, `fileMatchesReviewedAtEnd` false, and the log line "approved 1 hooks".

Proposed task: "Re-check the hooks file at approval time in trust-hooks" (size M).
- Problem: `codex/trust-hooks.js:105` compares the file, then the approve step at 121-134 writes the hashes listed earlier. A change in between is approved.
- Change: compare the file again just before `config/batchWrite`, and add a test with a changing fake app-server. Related, not holding: dotfiles-464 and dotfiles-91 (done).

## codex/config.example.toml names a GPT model

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
grep -n '^model' "$R2/repo/codex/config.example.toml"; echo "exit=$?"
```

Expected: `1:model = "gpt-5.4"` and `exit=0`.

Proposed task: "Remove the GPT model from codex/config.example.toml" (size S).
- Problem: the example file sets a `gpt-*` model. The models scan in `claude/tests/config.test.js:1416-1440` covers `claude/` only, so the test passes.
- Change: remove the model line or name a Claude model, and widen the scan or add a test for `codex/`. Related, not holding: dotfiles-195 (open, p3) and dotfiles-191 (done).

## liveSuite teardown keeps the transcript of a timed-out outside session (G-L1)

Held by dotfiles-544. This block is new evidence for that task. The fake claude (`probes/l-fake-claude`) makes no model call. Its teardown leaves the transcript only in the fake HOME. The control uses `L_MODE=complete`.

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
rm -rf "$R2/probes/l-home"; mkdir -p "$R2/probes/l-home" "$R2/probes/l-outside"
HOME="$R2/probes/l-home" LIB="$R2/repo/claude/tests/lib/live.js" L_CWD="$R2/probes/l-outside" L_MODE=timeout CLAUDE_LIVE_BIN="$R2/probes/l-fake-claude" bun "$R2/probes/g-l-probe.js" > "$R2/probes/rerun/gl1.out" 2>&1; echo "timeout exit=$?"
cut -c1-300 "$R2/probes/rerun/gl1.out"
rm -rf "$R2/probes/l-home"; mkdir -p "$R2/probes/l-home"
HOME="$R2/probes/l-home" LIB="$R2/repo/claude/tests/lib/live.js" L_CWD="$R2/probes/l-outside" L_MODE=complete CLAUDE_LIVE_BIN="$R2/probes/l-fake-claude" bun "$R2/probes/g-l-probe.js" > "$R2/probes/rerun/gl1-control.out" 2>&1; echo "control exit=$?"
cut -c1-300 "$R2/probes/rerun/gl1-control.out"
```

Expected: `timeout exit=0` with `"sessionError":"Process timeout after 1000 ms..."`, `"teardownError":"none"`, and `"transcriptRemains":true`. `control exit=0` with `"transcriptRemains":false`.

Held by dotfiles-544. Add a note with this block as evidence. No new task.

## liveSuite teardown skips removal when stopLeftovers throws (G-L2)

Held by dotfiles-544. The fault is injected in the scratch copy only, at `probes/l2copy/claude/tests/lib/live.js:316`. The repository is not changed.

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
rm -rf "$R2/probes/l-home"; mkdir -p "$R2/probes/l-home" "$R2/probes/l-outside"
HOME="$R2/probes/l-home" LIB="$R2/probes/l2copy/claude/tests/lib/live.js" L_CWD="$R2/probes/l-outside" L_MODE=complete G_L2_FAULT=1 CLAUDE_LIVE_BIN="$R2/probes/l-fake-claude" bun "$R2/probes/g-l-probe.js" > "$R2/probes/rerun/gl2.out" 2>&1; echo "fault exit=$?"
cut -c1-300 "$R2/probes/rerun/gl2.out"
```

Expected: `fault exit=0` with `"teardownError":"injected stopLeftovers failure"` and `"transcriptRemains":true`.

Held by dotfiles-544 (acceptance: creators keep no transcript or remove it, with a test). Add a note. A real `stopLeftovers` failure was not produced.

## block-installs hook: malformed stdin exits 1, not 2 (G-B1)

Held by dotfiles-545. 545 names `guard-runtimes.js`. Its acceptance asks each guard to have this test. Add a note there.

```bash
R2="${R2:?set R2 to the r2-tooling scratch folder}"
cd "$R2/repo" || exit 1
printf 'not json' | bun claude/tests/lib/hooks/block-installs.js > /dev/null 2> "$R2/probes/rerun/bi-malformed.err"; echo "malformed exit=$?"
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"npm install left-pad"}}' | bun claude/tests/lib/hooks/block-installs.js > /dev/null 2>&1; echo "install exit=$?"
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | bun claude/tests/lib/hooks/block-installs.js > /dev/null 2>&1; echo "ls exit=$?"
```

Expected: `malformed exit=1` with a stack trace at line 51 in `bi-malformed.err`. `install exit=2`. `ls exit=0`.

## Not rerun here

- helper.swift stop before the button-up event (held by dotfiles-436). The fake-sink run is in `$R2/probes/helper-fake` (run.err: `POST 5`, `POST 1`, `stopped by the user`, `run exit=4`; no `POST 2`). The fake copy was changed (no Accessibility check, `post()` replaced). Do not run `helper.swift` against the real screen. Add the evidence as a note on dotfiles-436.
- auto-merge window (dotfiles-434): by design. Recommend closing 434 after the parent checks the 2026-11-12 note on it. Run: `sh "$R2/probes/auto-merge-window.sh" "$R2/repo" "$R2/probes"`, then `env -u RUN_CLAUDE_LIVE bun test claude/hooks/auto-merge.test.js` (exit 0, 41 pass).
- lean-prompt host effect: unverified here. A live session would call a model. Board task dotfiles-260 (done) records the fresh-session check.
- Codex hook list: `codex/hooks.json` registers 2 guard hooks; `claude/settings.json` registers 10. Intent is unknown. Owner question only.
