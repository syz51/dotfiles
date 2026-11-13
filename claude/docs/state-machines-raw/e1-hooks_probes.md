# Probes for the confirmed gaps (dotfiles-546, e1-hooks)

Placeholders:
- `$E1`: the e1-hooks scratch folder.
- `$WT`: the checkout root that was read (commit 3525a13).

## Setup (once)

```sh
mkdir -p "$E1/repo" && git -C "$WT" archive HEAD | tar -x -C "$E1/repo"
sh "$E1/probes/rerun.sh" fast    # prints "<name> exit=<n>" per probe
sh "$E1/probes/rerun.sh" slow    # several minutes; freshen, lock and hooks suite
```

Expected: `fast` prints `board-stop-failure exit=2` (expected) and `exit=0` for the others. `slow` prints `exit=0` for all rows.
Outputs go to `$E1/probes/out/rerun/`. The fake `git`, `gh` and `board` binaries live in the probe files; no real remote or board is used.
`timeout` is not installed on the test Mac. The probes do not need it.

Rows below cite `out/rerun/<name>.txt:<line>`. Line numbers are from the rerun of this session.

Verdict key: "existing" means an open task holds the gap. Add the note to that task. "new" means a proposed task with the fields below.

---

## B1. Ref commands skip the main-checkout guard (existing: dotfiles-431)

Commands:

```sh
cd "$E1/probes" && bun guard-main-checkout-inproc.js > "$E1/probes/out/rerun/inproc.txt" 2>&1; echo "exit=$?"
grep -E '^(blocked|allowed) ' "$E1/probes/out/rerun/inproc.txt" | cut -c1-90
```

Expected:
- `exit=0`
- `blocked  control: git switch feature`
- `allowed  431: git symbolic-ref HEAD refs/heads/feature`
- `allowed  431: git update-ref refs/heads/main HEAD~1`
- `allowed  431: git branch -m feature other`

Note for dotfiles-431: `symbolic-ref`, `update-ref` and `branch -m` are not in the branch-change list (`claude/hooks/guard-main-checkout.js:142-164`). No test row uses them (`grep -n 'symbolic-ref\|update-ref\|branch -m' "$WT/claude/hooks/guard-main-checkout.test.js"` shows only fixture lines 27, 442-443).

## B2. A slow git query lets a branch change through (existing: dotfiles-431)

Commands:

```sh
cd "$E1/probes" && bun p-main.js > out/rerun/main-control.txt 2>&1; echo "control exit=$?"
cd "$E1/probes" && SLOW_CALL=3 bun p-main.js > out/rerun/main-slow.txt 2>&1; echo "slow exit=$?"
grep -h ' in ' "$E1/probes/out/rerun/main-control.txt" "$E1/probes/out/rerun/main-slow.txt"
```

Expected:
- `control exit=0` and `slow exit=0`
- `SLOW_CALL=unset: blocked in 0.08 s` (timing varies, under 1 s)
- `SLOW_CALL=3: allowed in 2.01 s`

Note for dotfiles-431: `runGit` uses a 2000 ms `spawnSync` timeout and returns undefined on error (`claude/hooks/guard-main-checkout.js:335-339`). The command is then allowed. No test covers a timeout (`grep -ci 'timeout\|slow' "$WT/claude/hooks/guard-main-checkout.test.js"` prints 0).

## B3. A command name built by `$(...)` is not resolved (new, proposed below)

Commands:

```sh
sh "$E1/probes/rerun.sh" fast >/dev/null 2>&1
sed -n '3,4p' "$E1/probes/out/rerun/guards.txt" | cut -c1-110
grep -E '^(blocked|allowed) .*(C4)' "$E1/probes/out/rerun/inproc.txt" | cut -c1-90
```

Expected:
- guards line 3: `0    C3 control: git push --force origin main via a substitution in the command name` (the command is `$(echo g)it push --force origin main`; the label is wrong).
- guards line 4: `2    C3 variable command name: G=git; $G push --force origin main` (blocked; the contrast case).
- inproc: `allowed  C4: $(echo g)it switch feature` and `allowed  C4: G=git; $G switch feature`.

Proposed task (new):
- Title: Refuse command names that a `$(...)` substitution builds.
- Problem: the Bash guards cannot see a command name built by `$(...)`, so a force push or branch change behind it is allowed.
- Evidence: B3 rows above (guards and inproc, exit 0). The same cause in `shell.js` (`claude/hooks/shell.js:153`).
- Change: treat a substituted command name as unknown and refuse it in each guard, with test rows in `shell.test.js` and the three guard tests.
- Size: M (shared parser and three guards). dotfiles-305 was not read; the parent should check it first.

## B4. `$'...'` quoting hides a force push (existing: dotfiles-308)

Commands:

```sh
sh "$E1/probes/rerun.sh" fast >/dev/null 2>&1
sed -n '8,9p' "$E1/probes/out/rerun/guards.txt" | cut -c1-110
```

Expected: `2    308 control: echo 'a'; git push --force origin main` (blocked) and `0    308 quote: echo $'a\'b'; git push --force origin main` (allowed).

Note for dotfiles-308: the ANSI-C quote ends the word early, so the push after it is not seen. Control shows the same push blocked without the quote.

## B5. setsid, ionice and flock wrappers hide a force push (existing: dotfiles-424)

Commands: as B4 (`sed -n '5,7p' "$E1/probes/out/rerun/guards.txt" | cut -c1-110`).

Expected: `0    424 setsid`, `0    424 ionice`, `0    424 flock`, each with a force push. All exit 0.

Note for dotfiles-424: the wrapper table (`claude/hooks/shell.js:48-66`) lists xargs and xcrun, not setsid, ionice or flock.

## B6. xargs replace string hides a runtime (existing: dotfiles-414)

Commands:

```sh
sh "$E1/probes/rerun.sh" fast >/dev/null 2>&1
grep -n 'python3' "$E1/probes/out/rerun/xargs2.txt" | cut -c1-100
```

Expected:
- `4:exit 2  control: python3 -c`
- `6:exit 0  xargs -I{} runs the replaced word`
- `7:exit 0  xargs -J runs the replaced word`

Note for dotfiles-414: the same xargs forms are blocked by guard-git-push and guard-main-checkout (`out/rerun/xargs.txt`, `main-xargs.txt`). Only guard-runtimes misses them.

## B7. Mirror config under a slow config read is allowed (existing: dotfiles-432)

Commands: `sed -n '32,33p' "$E1/probes/out/rerun/guards.txt" | cut -c1-120`

Expected:
- `2    control: git push, config readable`
- `0    432 timeout: git push, git config read stopped after 2 s (SLOW_CONFIG=5)`

Note for dotfiles-432: `PUSH_CONFIG` read failure (`claude/hooks/guard-git-push.js:152-156`) allows the push. The rewrite check (`:153-154`) does not look at `mirror`.

## B8. An in-progress run with conclusion SUCCESS blocks (existing: dotfiles-360)

Commands:

```sh
cd "$E1/probes" && bun p-pr.js > out/rerun/pr.txt 2>&1; echo "exit=$?"
grep -n '^allowed\|^blocked' "$E1/probes/out/rerun/pr.txt" | cut -c1-110 | head -n 4
```

Expected: `exit=0`; `allowed  control A: all runs pass, CLEAN, pinned merge`; `blocked  360: CI / Changes IN_PROGRESS with conclusion SUCCESS` with message "checks are still running".

Note for dotfiles-360: the guard checks status before conclusion (`claude/hooks/guard-pr-merge.js:188-190`). Open question: GitHub may never send IN_PROGRESS with a SUCCESS conclusion. This was not checked.

## B9. `--auto` refused where auto-merge arms the PR (existing: dotfiles-433; 434 covered in its note)

Commands:

```sh
cd "$E1/probes" && bun p-433.js > out/rerun/433.txt 2>&1; echo "exit=$?"
grep -n '^guard\|^auto' "$E1/probes/out/rerun/433.txt" | cut -c1-120 | head -n 6
```

Expected: `exit=0`; `guard  BLOCKED, CI IN_PROGRESS, reviews-only: blocked: ... checks are still running`; `auto   BLOCKED, non-draft: ... auto-merge is on (squash)`.

Note for dotfiles-433: the guard and auto-merge disagree on reviews-only bases (`claude/hooks/auto-merge.js:88-97` counts reviews; `guard-pr-merge` counts checks).
Note for dotfiles-434: the same non-draft PR with checks running is armed by auto-merge (row `auto   BLOCKED, non-draft`). The ui-climb path was not run.

## B10. No test for `--auto` on a DIRTY PR (existing: dotfiles-433)

Commands:

```sh
grep -c 'DIRTY' "$WT/claude/hooks/guard-pr-merge.test.js"
grep 'DIRTY' "$WT/claude/hooks/guard-pr-merge.test.js" | grep -c -- '--auto'
```

Expected: `1` and `0`. (`grep -c` exits 1 when the count is 0; that is the expected result here.)

## B11. A failed status check fast-forwards a dirty checkout (existing: dotfiles-439)

Commands:

```sh
cd "$E1/probes" && bun p-freshen.js F2-control dirty > out/rerun/f2-control.txt 2>&1; echo "control exit=$?"
cd "$E1/probes" && FAIL_STATUS=1 bun p-freshen.js F2-status-fails dirty > out/rerun/f2-fails.txt 2>&1; echo "fault exit=$?"
grep -h 'note:\|status:' "$E1/probes/out/rerun/f2-control.txt" "$E1/probes/out/rerun/f2-fails.txt" | cut -c1-120
```

Expected:
- `control exit=0` and `fault exit=0`.
- Control note: "...it has tracked changes, so it was not fast-forwarded"; status `"M a.txt"`.
- Fault note: "Fast-forwarded main by 1 commit(s) to origin/main"; status `"M a.txt"` (kept).

Note for dotfiles-439: `claude/hooks/freshen-base.js:117` reads only `.out`; a failed `git status` reads as clean.

## B12. A slow fast-forward is killed with no reason (new or dotfiles-545 item 3)

Commands:

```sh
cd "$E1/probes" && SLOW_MERGE=30 bun p-freshen.js F1-merge-slow > out/rerun/f1-slow.txt 2>&1; echo "exit=$?"
grep -h 'F1-\|note:' "$E1/probes/out/rerun/f1-slow.txt" | cut -c1-120
grep -n 'No timeout' "$WT/claude/hooks/freshen-base.js"
```

Expected: `exit=0`; `F1-merge-slow: 10.6 s` (timing varies, about 10 s); note "Fast-forwarding main to origin/main failed (no output)". The grep prints line 120 with "No timeout".

Proposed task (new, if dotfiles-545 item 3 does not cover it):
- Title: freshen-base: give the merge a reason when it times out.
- Problem: the merge uses the 10 s default git timeout. The note hides the reason, and the comment at `freshen-base.js:120` says "No timeout".
- Evidence: B12 rows.
- Change: pass a timeout or no timeout explicitly, fix the comment, and report a timeout as a timeout.
- Size: S.

## B13. freshen-base total time passes the 90 s hook timeout (new)

Commands:

```sh
cd "$E1/probes" && SLOW_CALL=7 bun p-freshen.js F4-slow-calls > out/rerun/f4.txt 2>&1; echo "exit=$?"
grep -h 'F4-' "$E1/probes/out/rerun/f4.txt"
awk 'NR>=63 && NR<=67' "$WT/claude/settings.json"
```

Expected: `exit=0`; `F4-slow-calls: 107.2 s`; the settings block at lines 63-67 shows the freshen-base timeout of 90 s (`claude/settings.json:65-66`).

Proposed task (new):
- Title: freshen-base: one total time budget under the hook timeout.
- Problem: the fetch, status, merge and lock wait add up. The probe took 107.2 s against a 90 s hook timeout. The probe did not observe the kill.
- Evidence: B13 rows.
- Change: one deadline shared by all steps; stop with a note before the hook timeout.
- Size: S.

## B14. Lock steal and late release overlap (existing: dotfiles-342; umbrella dotfiles-425)

Commands:

```sh
cd "$E1/probes" && bun p-lock.js > out/rerun/f3.txt 2>&1; echo "exit=$?"
grep -n 'aged\|holder\|thief\|late' "$E1/probes/out/rerun/f3.txt" | cut -c1-120
```

Expected: `exit=0`. Lines (numbering from the rerun):
- line 4: `lock aged to 200 s while holder works` at 3144 ms.
- line 5: `thief` `in` at 3213 ms, while the holder is still working.
- line 6: `holder` `out` at 6143 ms, with the thief's lock still present.
- line 8: `late` `in` at 6252 ms, while the thief is in.
- line 11: `thief` `out` at 8216 ms.

Note for dotfiles-342: `withLock` removes the lock by path in `finally` (`claude/hooks/freshen-base.js:86`) and steals a lock older than 120 s (`:79`). Both allow overlap.

## B15. freshen-base has no steal, busy or status-failure test (existing: dotfiles-342, 439, 545)

Commands:

```sh
grep -c 'LOCK_STALE\|120_000\|steal\|stale lock\|aged\|utimes' "$WT/claude/hooks/freshen-base.test.js"
grep -c 'FAIL_STATUS\|status.*fail\|fail.*status' "$WT/claude/hooks/freshen-base.test.js"
```

Expected: `0` and `0` (grep exits 1 on zero matches; that is the expected result).

## B16. stale-base reports a busy lock as a failed fetch (existing: dotfiles-439)

Commands:

```sh
cd "$E1/probes" && PROBE_LOG="$E1/probes/out/busy.log" bun p-stale.js busy > out/rerun/stale-busy.txt 2>&1; echo "busy exit=$?"
cd "$E1/probes" && PROBE_LOG="$E1/probes/out/free.log" bun p-stale.js > out/rerun/stale-free.txt 2>&1; echo "free exit=$?"
echo "busy fetch lines: $(grep -c fetch "$E1/probes/out/busy.log")"
echo "free fetch lines: $(grep -c fetch "$E1/probes/out/free.log")"
grep -h "as last fetched" "$E1/probes/out/rerun/stale-busy.txt" | cut -c1-60
```

Expected: both exits 0; busy fetch lines `0`; free fetch lines `1`; the busy note contains "(as last fetched: this session's fetch failed or timed out)". The free note has no suffix.

Note for dotfiles-439: the suffix is added when `fetched === BUSY` (`claude/hooks/stale-base.js:60`).

## B17. No test covers the stale-base busy branch (existing: dotfiles-439)

Commands: `grep -ci busy "$WT/claude/hooks/stale-base.test.js"`

Expected: `0` (exit 1 on zero matches).

## B18. Board exit codes pass through on seven events (existing: dotfiles-435)

Commands:

```sh
sh "$E1/probes/rerun.sh" fast >/dev/null 2>&1
grep -o 'fake board exits 2: [a-z-]* exit=[0-9]*' "$E1/probes/out/rerun/board.txt"
```

Expected: `pre-tool-use exit=1`, `post-tool-use-failure exit=1`, and `exit=2` for `post-tool-use`, `session-start`, `user-prompt-submit`, `stop`, `pre-compact`, `session-end`. The `board-stop-failure` run prints `exit=2` in the `rerun.sh fast` output line.

Note for dotfiles-435: the mapping is in `claude/hooks/board-hook.sh:13-22`. The real board exits 0 on these events (prior record, not rerun), so the impact is latent.

## B19. No test pins the board exit mapping (existing: dotfiles-435)

Commands:

```sh
awk 'NR>=462 && NR<=560' "$WT/claude/tests/config.test.js" | grep -c 'toBe([12])'
```

Expected: `0`. The behaviour tests at `config.test.js:530-560` expect status 0 only.

## B20. Empty board slug list counts "UTF-8" as a filed task (new)

Commands:

```sh
cd "$E1/probes" && bun p-open.js > out/rerun/open.txt 2>&1; echo "exit=$?"
cut -c1-100 "$E1/probes/out/rerun/open.txt"
```

Expected:
- `exit=0`
- `unfiledItems(["Not verified: UTF-8 handling"], []) => []`
- `unfiledItems(["Not verified: UTF-8 handling"], ["dotfiles"]) => ["Not verified: UTF-8 handling"]`
- the end-to-end rows: E1 control exit 2; E2 (no slug, UTF-8 item) exit 0; E3 (slug `dotfiles`, same item) exit 2.

Proposed task (new):
- Title: open-items: an empty slug list must not count word-digit text as a task id.
- Problem: with no slugs, the pattern `\b(?:)-\d+\b` (`claude/hooks/open-items.js:90`) matches "UTF-8". The item counts as filed, and the Stop check passes.
- Evidence: B20 rows.
- Change: skip the task-id check when there are no slugs, or require a real slug. Add a test with an empty slug list.
- Size: S.

## B21. Malformed stdin: guard-pr-merge blocks, the other guards let the command run (existing: dotfiles-545)

Commands:

```sh
sh "$E1/probes/rerun.sh" fast >/dev/null 2>&1
sed -n '40,46p' "$E1/probes/out/rerun/guards.txt" | cut -c1-100
```

Expected: line 41-46 first column: `1` for guard-git-push, guard-main-checkout, guard-runtimes, guard-asks, open-items; `2` for guard-pr-merge (its catch at `claude/hooks/guard-pr-merge.js:617-620` blocks).

Note for dotfiles-545: the same malformed input gets two different outcomes. The guard-pr-merge comment explains why it blocks.

## B22. No PreToolUse hook covers Edit or Write (existing: dotfiles-545 item 2)

Commands:

```sh
grep -n '"matcher"' "$WT/claude/settings.json" | head -n 12 | cut -c1-90
grep -n '"matcher".*\(Edit\|Write\)' "$WT/claude/settings.json"; echo "edit-write matchers: $?"
```

Expected: PreToolUse matchers at lines 15, 41, 51 and 61 only (Bash, `mcp__board__ask_user`, `EnterWorktree|Agent|Task`). The second command prints nothing and then `edit-write matchers: 1`.

## B23. SETUP.md says Codex runs "the same guards" (new)

Commands:

```sh
cd "$E1/probes" && bun p-c7.js "$WT/codex/hooks.json" "$WT/claude/settings.json" > out/rerun/c7.txt 2>&1; echo "exit=$?"
cut -c1-100 "$E1/probes/out/rerun/c7.txt" | grep 'guard'
grep -n 'the same guards' "$WT/SETUP.md"
```

Expected: `exit=0`. Codex guard lines: guard-git-push.js and guard-runtimes.js. Claude guard lines: those two plus guard-main-checkout.js and guard-pr-merge.js, and guard-asks.js on `mcp__board__ask_user`. SETUP.md prints line 282 or 283 with "the same guards".

Proposed task (new):
- Title: SETUP.md: Codex wires two guards, not the same four.
- Problem: the sentence says Codex runs the same guards. Codex wires guard-git-push and guard-runtimes only.
- Evidence: B23 rows.
- Change: correct the sentence, or wire the two other guards for Codex (a separate decision).
- Size: S.

## B24. config.example.toml sets a gpt model (setup finding; parent decides)

Commands: `grep -n '^model' "$WT/codex/config.example.toml"`

Expected: `1:model = "gpt-5.4"`. This is a setup finding, not a state gap. The owner's policy forbids gpt models. Do not start codex to test it.

---

## Unverified (no probe block)

- Trust-hooks batchWrite without an expected version (`codex/trust-hooks.js:126-135`): needs a live Codex app-server.
- lean-prompt isDeferred on the real host (`claude/marketplace/lean-prompt/hooks/register.ts:6-10`): needs a real host run.
- ui-climb auto-merge path (SKILL.md:227): outside this repository.
- guard-runtimes git timeout (prior record only).

## Cleanup

The scratch folder stays in place for the parent. The probes start no background process. `out/busy.log` and `out/free.log` are probe logs in the scratch folder.
