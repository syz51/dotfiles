# Probes for confirmed gaps (dotfiles-546)

Date: 2026-11-14. Each block reruns on the same day. Expected lines came from that rerun.

## Setup

Set `S` to the scratch folder `e3-factory-a` once. It holds `repo/` (git-archive copy), `c5repo/` (one changed line) and `probes/`.

```
S=<path to the e3-factory-a scratch folder>
```

- `"$S/probes/run-probe.sh" <test-file> <out-file> [-t name]` runs one probe file in `$S/repo` with fake binaries first on `PATH`, a fake HOME and no stdin. The wrapper always exits 0. Its first stdout line is `exit=N`, the bun status. Keep stdout, or read the `exit=` line.
- The wrapper has a fixed scratch path on its `E=` line. Edit that line if the folder moves.
- Probe files exist only in the scratch copy. They are not in the real checkout.
- Each block lists the lines to expect. Set `S` first, then run the command.

## 1. J-torn: torn last line stops friction (machine: friction record file, G1)

```
"$S/probes/run-probe.sh" claude/factory/friction/probe-torn.test.js "$S/probes/logs/torn.out"
grep PROBE "$S/probes/logs/torn.out" | cut -c1-220
```

Expected:
- `exit=0`
- `PROBE J-torn threw, message tail: ...friction.jsonl:2: malformed JSON line`
- `1 pass`, `0 fail`

Proposed task:
- Title: Tolerate a torn last line in friction.jsonl
- Size: S
- Problem: One partial last line stops every friction run, dry runs too.
- Evidence: the output above; `claude/factory/lib/state.js:32`.
- Change: When reading JSON Lines, skip an unparsable final line and log its line number. Keep earlier lines strict.

## 2. J-refused: refused spend missing from the error (machine: judge call spend, G1)

```
"$S/probes/run-probe.sh" claude/factory/lib/probe-refused.test.js "$S/probes/logs/refused.out"
grep PROBE "$S/probes/logs/refused.out" | cut -c1-220
```

Expected:
- `exit=0`
- `PROBE J-refused control costUSD = 0.04`
- `PROBE J-refused calls = 2 error.costUSD = 0.02 error.events types = system,result`
- `2 pass`, `0 fail`

Proposed task:
- Title: Keep refused-attempt spend in ClaudeCallError.costUSD
- Size: S
- Problem: A failed final attempt after a refusal reports only its own cost. Friction then records 0.02, not 0.04.
- Evidence: the output above; `claude/factory/lib/claude.js:106`; `claude/factory/friction/cli.js:453`.
- Change: Add the cost of earlier refused attempts to the error. Pin it with a test.

## 3. FR-crash: a crash after board filing files again (machine: friction filing record, G1)

```
"$S/probes/run-probe.sh" claude/factory/friction/probe-fr-crash.test.js "$S/probes/logs/frcrash.out"
grep "PROBE FR-crash" "$S/probes/logs/frcrash.out" | cut -c1-220
```

Expected:
- `exit=0`
- `PROBE FR-crash first run exitCode= null signal= SIGKILL`
- `PROBE FR-crash board calls after first run= 2`
- `PROBE FR-crash friction.jsonl kinds after first run= judged`
- `PROBE FR-crash second run exitCode= 0`
- `PROBE FR-crash filings after rerun= 2`
- `PROBE FR-crash friction.jsonl kinds after rerun= judged,filed`
- `1 pass`, `0 fail`

Proposed task:
- Title: Make friction filing and its record atomic
- Size: M
- Problem: A kill after the board accepts a finding leaves no record. The rerun files it again.
- Evidence: the output above; `claude/factory/friction/cli.js:308`, `:428`.
- Change: Record the filing intent before the board call, with a key the board can dedupe. Mark the record filed after the call. A rerun must not file twice.

## 4. L1: stale lock takeover is not atomic (machine: pid lock file, G1)

```
"$S/probes/run-probe.sh" claude/factory/lib/probe-lock.test.js "$S/probes/logs/lock.out"
grep "PROBE L1" "$S/probes/logs/lock.out" | cut -c1-220
```

Expected:
- `exit=1` (the one-winner check fails)
- Three round lines: `PROBE L1 round N: winners(true)=... losers(false)=46 crashed=0 ...`
- `PROBE L1 winners per round = 4,2,2` (counts vary per run)
- `0 pass`, `1 fail`
- Earlier runs gave `3,2,1`, `3,4,7` and `1,3,3`. Any round with more than one winner is the defect.

Proposed task:
- Title: Make stale lock takeover atomic
- Size: S
- Problem: Several processes remove one stale lock and each create one. Each gets a lock.
- Evidence: the output above; `claude/factory/lib/state.js:57`, `:72`. Related: dotfiles-342 (freshen-base takeover).
- Change: Take over with a rename or a second check of the pid under one lock. Pin with a test that counts winners.

## 5. L442: a lock naming pid 1 is never taken (machine: pid lock file, G2; dotfiles-442, new evidence)

```
"$S/probes/run-probe.sh" claude/factory/lib/probe-pid1.test.js "$S/probes/logs/pid1.out"
grep "L442" "$S/probes/logs/pid1.out" | cut -c1-220
```

Expected:
- `exit=0`
- `L442 pid-1 lock results [false,false,false] file "1"`
- `L442 dead-pid control true file "<pid>"`
- `1 pass`, `0 fail`

Evidence to add to dotfiles-442: The pid-1 check returns false on EPERM at `claude/factory/lib/state.js:68`. A dead pid is taken over at the same call site. Keep dotfiles-442's change: check more than the pid.

## 6. L-boot: failed bootstrap keeps the plist (machine: LaunchAgent install and uninstall, G1)

```
"$S/probes/run-probe.sh" claude/factory/lib/probe-launchd.test.js "$S/probes/logs/launchd.out"
grep PROBE "$S/probes/logs/launchd.out" | cut -c1-220
```

Expected:
- `exit=0`
- `PROBE L-boot install code = 1 plist on disk = true`
- `PROBE L-boot status = LaunchAgent: ... not loaded`
- `PROBE U-boot uninstall result = undefined plist on disk after = false` (not filed; see Not filed)
- `2 pass`, `0 fail`

Proposed task:
- Title: Remove the plist when a LaunchAgent bootstrap fails
- Size: S
- Problem: A failed bootstrap returns code 1 and leaves the plist. Status then says "not loaded".
- Evidence: the output above; `claude/factory/lib/launchd.js:79-81`.
- Change: On bootstrap failure, delete the plist written in this call. Return the code. Pin with a test.

## 7. TR1: symlinks and dangling subagent links (machine: transcript session listing, G1 and G2)

```
"$S/probes/run-probe.sh" claude/factory/lib/probe-transcripts.test.js "$S/probes/logs/transcripts.out"
grep PROBE "$S/probes/logs/transcripts.out" | cut -c1-220
```

Expected:
- `exit=0`
- `PROBE TR1 control sessions = 1`
- `PROBE TR1a sessions = 1`
- `PROBE TR1c sessions = 1 (a real file and a symlink to one would make 2 if symlinks were read)`
- `PROBE TR1b sessions = 0`
- `4 pass`, `0 fail`

Proposed task:
- Title: Read symlinked transcripts and stop dropping sessions for dangling subagent links
- Size: S
- Problem: A valid symlink to a transcript is not read. One dangling subagent link drops the whole session.
- Evidence: the output above; `claude/factory/lib/transcripts.js:18-23`, `:188`, `:317`. Related: dotfiles-345, dotfiles-544 (different causes, not re-checked).
- Change: Follow a symlink to a real file. Skip a dangling subagent with a logged reason, not the session.

## 8. DG1: final message label and cut (machine: digest builder, G1)

```
"$S/probes/run-probe.sh" claude/factory/scoring/probe-digest.test.js "$S/probes/logs/digest.out"
grep "PROBE DG1" "$S/probes/logs/digest.out" | cut -c1-220
```

Expected:
- `exit=0`
- `PROBE DG1 label: [A1] ASSISTANT: (final message, shown in full below)`
- `PROBE DG1 digest length = 15528 final block has START-MARK = true has END-MARK = true`
- `PROBE DG1 elision marker = […5020 chars…] final F count = 14965`
- `1 pass`, `0 fail`

Proposed task:
- Title: Fix the final-message label or lift the 15,000-character final cut
- Size: S
- Problem: The label says the final message is shown in full. The probe's 20,020-character message is cut at about 15,000.
- Evidence: the output above; `claude/factory/scoring/digest.js:124`, `:212`.
- Change: Either label a cut message as cut, or raise the cut. Pin the chosen rule with a test at 20,000 characters.

## 9. B1: failed board read looks like an empty board (machine: board snapshot, G1)

```
"$S/probes/run-probe.sh" claude/factory/board/probe-b1.test.js "$S/probes/logs/b1.out"
grep "PROBE B1" "$S/probes/logs/b1.out" | cut -c1-220
```

Expected:
- `exit=0`
- `PROBE B1 failed: {"group":null,"note":"0 open feedback tasks (0 new); signals: none  nothing to propose"}`
- `PROBE B1 empty:  {"group":null,"note":"0 open feedback tasks (0 new); signals: none  nothing to propose"}`
- `PROBE B1 same result = true error text in result = false`
- `1 pass`, `0 fail`

Proposed task:
- Title: Treat a failed board read as unknown, not empty
- Size: S
- Problem: A failed read gives the same note as an empty board. The error text is lost.
- Evidence: the output above; `claude/factory/board/cli.js:65-73`, `claude/factory/board/proposal.js:75`.
- Change: Keep the snapshot error in the proposal note. Do not say "nothing to propose" after a failed read.

## 10. S1: concurrent score runs judge one session twice (machine: score record identity, G1)

```
"$S/probes/run-probe.sh" claude/factory/scoring/probe-score.test.js "$S/probes/logs/score.out"
grep "PROBE S1" "$S/probes/logs/score.out" | cut -c1-220
```

Expected:
- `exit=0`
- `PROBE S1 concurrent child outputs: ["PROBE S1 child code 0","PROBE S1 child code 0"]`
- `PROBE S1 concurrent scores.jsonl lines = 2 judge calls logged = 2`
- `PROBE S1 control scores.jsonl lines = 1 judge calls logged = 1`
- `2 pass`, `0 fail`

Proposed task:
- Title: Lock score runs per session before judging
- Size: S
- Problem: Two runs that start together both judge the same session and both append a record.
- Evidence: the output above; `claude/factory/scoring/score.js:271`, `:387`, `:401`.
- Change: Claim each session under a lock before the judge call. Re-read the records after the claim.

## 11. C1 and P2: duplicate PR and orphan branch (machine: proposal publish and retry, G1 and G2)

```
"$S/probes/run-probe.sh" claude/factory/scoring/probe-propose.test.js "$S/probes/logs/propose.out"
grep "PROBE C1\|PROBE P2" "$S/probes/logs/propose.out" | cut -c1-220
```

Expected:
- `exit=0`
- `PROBE C1 first run exit=1 status=error pushed=true branch=factory-proposal/... prUrl=null`
- `PROBE C1 gh calls after first run=1 remote branches=1`
- `PROBE C1 second run exit=0 status=proposed ... prUrl=https://github.com/o/r/pull/42`
- `PROBE C1 gh creates total=2`
- `PROBE P2 child exitCode=null signal=SIGKILL proposals.jsonl records=0 gh creates=1`
- `PROBE P2 remote factory-proposal branches after kill=1`
- `PROBE P2 rerun exit=0 records=1 last status=proposed gh creates=2`
- `7 pass`, `0 fail` (the `PROBE GITSTATE` lines in this file are unrelated)

Proposed tasks:
- C1 Title: Find an open PR for the branch before a retry opens a second PR. Size: S. Problem: gh creates the PR, then exits 1. The retry opens another. Evidence: the output above; `claude/factory/scoring/propose.js:366-371`. Change: Look up an open PR for the branch before `gh pr create`. Keep the PR URL on error when pushed is true.
- P2 Title: Record the proposal before gh creates the PR. Size: M. Problem: A kill after gh creates the PR leaves no record and an orphan branch. Evidence: the output above; `claude/factory/scoring/propose.js:287`. Change: Write a pending record with the branch before gh. On rerun, find the open PR or remove the orphan branch.

## 12. D1 and D3: review-skipped detector (machine: review-skipped detector, G1 and G2)

```
"$S/probes/run-probe.sh" claude/factory/scoring/probe-d.test.js "$S/probes/logs/d.out"
grep -E "^D1|^D3" "$S/probes/logs/d.out" | cut -c1-220
```

Expected:
- `exit=0`
- `D1a unmapped cwd {"verdict":"na","hits":[]}`
- `D1b no cwd {"verdict":"fail","hits":[["o/a:src/x.js"]]}`
- `D1c known cwd {"verdict":"fail","hits":[["o/a:src/x.js"]]}`
- `D1d {"verdict":"fail","hits":[["o/a:src/x.js"]]}`
- `D3 t3Checkout two repos null`
- `D3 t3Checkout two same repo "github.com/o/tool"`
- `D3a two repos, push from checkout A {"verdict":"na","hits":[]}`
- `D3b two same repo, push from checkout A {"verdict":"fail","hits":[["o/tool:src/lib.rs"]]}`
- `D3c one root only, push from checkout A {"verdict":"fail","hits":[["o/tool:src/lib.rs"]]}`
- `5 pass`, `0 fail`

Proposed tasks:
- D1 Title: Settle pending edits on a push from an unknown folder. Size: S. Problem: A push from an unmapped folder gives `na` with an unreviewed edit. The comment at `claude/factory/scoring/detectors.js:715` says every repository settles then. Evidence: the output above; `:736`, `:771`. Change: Follow the comment, or correct the comment and the rule.
- D3 Title: Keep the edit when same-named T3 checkouts map to different repos. Size: S. Problem: The edit is dropped and the verdict is `na`. Evidence: the output above; `claude/factory/scoring/review-scope.js:124-126`, `claude/factory/scoring/detectors.js:747`. Change: Report the edit as unresolved, not `na`.

## 13. RV1: one board add failure drops later findings (machine: review record and board add, G1)

```
"$S/probes/run-probe.sh" claude/factory/review/probe-add.test.js "$S/probes/logs/add.out" -t "failures end the repository with the reason and what it spent"
grep "RV1" "$S/probes/logs/add.out" | cut -c1-220
```

Expected:
- `exit=0`
- `RV1 add-fail {"confirmed":[],"rejected":1,"error":"board add on dotfiles exited 1: board unreachable"}`
- `1 pass`, `0 fail`
- The probe file is a copy of `claude/factory/review/review.test.js`. Its fixture marks two findings REAL.

Proposed task:
- Title: Keep confirmed findings when one board add fails
- Size: S
- Problem: One failed add throws out of the loop. Two confirmed findings are recorded as none. The error names only the first failure.
- Evidence: the output above; `claude/factory/review/cli.js:217-227`.
- Change: Catch each add failure per finding. Keep the rest. Record every error.

## 14. C5: digest size is not pinned by tests (machine: rubric gate G1 and digest G2; dotfiles-441, new evidence)

Check the changed line, then run the four scoring files in both copies:

```
S=<path to the e3-factory-a scratch folder>
BUN=$(command -v bun)
grep -n "OUTPUT_CHARS = " "$S/c5repo/claude/factory/scoring/digest.js" "$S/repo/claude/factory/scoring/digest.js"
for copy in repo c5repo; do
  (cd "$S/$copy" && env -i HOME="$S/probes/home" TMPDIR="$S/probes/tmp" PATH="$S/probes/bin:/opt/homebrew/bin:/usr/bin:/bin:$(dirname "$BUN")" "$BUN" test --timeout 60000 claude/factory/scoring/detectors.test.js claude/factory/scoring/digest.test.js claude/factory/scoring/propose.test.js claude/factory/scoring/score.test.js > "$S/probes/logs/c5-rerun-$copy.out" 2>&1 < /dev/null); echo "$copy exit=$?"
  grep -E "^ [0-9]+ (pass|fail)$|^Ran " "$S/probes/logs/c5-rerun-$copy.out"
done
```

Expected:
- `repo/claude/factory/scoring/digest.js:15:const OUTPUT_CHARS = 300;`
- `c5repo/claude/factory/scoring/digest.js:15:const OUTPUT_CHARS = 100;`
- `repo exit=0` and `c5repo exit=0`
- For both copies: `270 pass`, `0 fail`, `Ran 270 tests across 4 files.`

Proposed task: dotfiles-441 (add this evidence). Size: S. A digest output size change passes every scoring test. Change: pin the digest output size and the detector set to the rubric version, with a test that fails when they change.

Note: Earlier runs in this span gave 26 fail in both copies, with the same failure set. This rerun did not reproduce them. The cause is not found.

## Not filed (probe output exists, verdict unverified or not run)

- U-boot (machine: LaunchAgent install and uninstall, G2): uninstall removes the plist after a failed bootout. Filing waits on intent. Probe line: `PROBE U-boot uninstall result = undefined plist on disk after = false`.
- Pid lock empty file (machine: pid lock file, G3): not run.
- Same-day overwrite (machines: review record G2, weekly G1): not run.
