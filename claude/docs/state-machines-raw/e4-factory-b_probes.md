# Probes for the confirmed gaps (dotfiles-546)

Each block reruns one probe. The expected output comes from the rerun logs. Pids and ports vary.

## Setup

    SCRATCH=${SCRATCH:?set SCRATCH to the scratch folder}
    mkdir -p "$SCRATCH/home" "$SCRATCH/tmp"

P19 and P20 read `$SCRATCH/work/p19/common.json`. Its one-line content:

    {"version":1,"name":"demo","product":"A task tracker.","serve":{"command":["bun","server.ts","--port","{port}"],"ready":"/healthz"},"screens":[{"id":"home","title":"Home","path":"/","views":["desktop-light"]}],"judges":[{"model":"claude-haiku-5-5"}],"budgetUsd":{"call":0.5,"round":3,"run":1}}

The probes run from `$SCRATCH/probes/` against `$SCRATCH/clone` (HEAD 3525a13, clean). They use the fake browser `$SCRATCH/fakes/browse.js` (P3, P4), the fake gh `$SCRATCH/fakes/gh-fail.sh` (P17), the fake Claude binary through CLAUDE_FACTORY_BIN (P14), and the fake board bench Claude through BOARD_BENCH_CLAUDE (P15). No probe calls a live model or a network service.

Run any block with:

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/<name>.js"

Each block exited 0 in its rerun. P14 and P15 reset their own work folders at start. P16 leaves a `sleep 60` orphan; see P16.

## P1. A lock held by a reused pid blocks the run (holder dotfiles-442)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p1-lock-reused-pid.js"

Expected:

    A stale lock names live unrelated pid <pid>
    A result: Error: run p1-run is in use by process <pid>; wait for it to finish
    A lock file still present: true
    B stale lock names exited pid <pid>
    B result: lock taken, release is function
    B lock file after release: false

Task: holder dotfiles-442 (open, p3). Add this block as a note. No new task.

## P2. stop() after the leader exits leaves its TERM-ignoring child alive (new)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p2-serve-stop.js"

Expected:

    exit-first: ready at http://<loopback>:<port>
    exit-first: child pid <pid> alive before stop: true
    exit-first: stop() returned after 0 ms
    exit-first: child pid <pid> alive after stop: true
    alive: ready at http://<loopback>:<port>
    alive: child pid <pid> alive before stop: true
    alive: stop() returned after about 3100 ms
    alive: child pid <pid> alive after stop: false

The leader in exit-first mode exits 1 s after start. Its child is a `sh` loop that traps TERM, in the leader's process group. The probe SIGKILLs the surviving child at its end (`p2-serve-stop.js:29`).

Proposed task (new):

- Title: Escalate to SIGKILL after a dev server's leader exits.
- Problem: `serve().stop()` skips the wait and the SIGKILL once the leader has exited (`ui/capture.js:144-150`). A child that ignores TERM survives.
- Evidence: the exit-first lines above. The leader-alive case works.
- Change: after the leader exits, poll the group with `process.kill(-leader, 0)` up to the 3 s deadline. Then send SIGKILL to the group. Test with a TERM-ignoring child.
- Size: S.

## P3 and P4. One failed GET aborts the batch; an old file counts as captured (new)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p3-capture-batch.js"

Expected:

    failing: threw Error: GET /missing for third failed: 404
    failing: browse calls: <origin>/ok | <origin>/ok
    failing: files on disk: ["first.png","second.png"]
    control: returned 3 records
    control: browse calls: <origin>/ok | <origin>/ok | <origin>/ok
    control: files on disk: ["first.png","fourth.png","second.png"]
    P4: error=null file=$SCRATCH/work/p3/stale/stale.png content=old

The P4 case writes `stale.png` with the text "old" first, then sets `P4_NOWRITE=1` (`p3-capture-batch.js:36-37`). The browser then writes nothing.

Proposed task, P3 (new):

- Title: Record a failed before-GET as that shot's error.
- Problem: `captureShots` throws on a failed GET (`ui/capture.js:205`). The shots after it are not captured. `referenceVersions` only retries shot errors (`ui/run.js:163-197`).
- Evidence: the failing case. The third shot throws before its browse. The control captured every shot.
- Change: record the failed GET as that shot's error, as `:211` does for a browse failure.
- Size: S.

Proposed task, P4 (new, latent):

- Title: Clear a shot's old file before it is captured.
- Problem: `captureShots` treats an existing file as a capture when the browser writes nothing (`ui/capture.js:211`). `referenceVersions` does not clear the folder (`ui/run.js:163-197`). Baseline and control clear it (`ui/run.js:135`). The candidate clears it too (`ui/run.js:220`).
- Evidence: the P4 line.
- Change: delete the shot's file before the browser runs, as `candidateShots` does.
- Size: S.

## P5, P6, P7, P8. Ledger and round record (one run)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p5-p8-ledger.js"

Expected:

    P5 round 2 dirty=true: state=resolved resolvedIn=2 since=1 settled=[{"screen":"home","fix":"Add a header"}]
    P5 round 2 dirty=false: state=resolved resolvedIn=2 since=1 settled=[{"screen":"home","fix":"Add a header"}]
    P6 round 1 group: fixes=["Fix A","Fix B"] problems=2
    P6 round 2 (no report, new commit): state=resolved resolvedIn=2 since=1 settled=[{"screen":"home","fix":"Fix A"}]
    P7 entries with round-1.json: 1; without: 1; round-1 record has issues: false
    P7 round 2 issue since: with round-1.json=1; without=2
    P8 rounds.jsonl lines: 2; next round number: 3; round-3.json exists: true
    P8 killed attempt still on disk: false

### P5. A dirty round resolves an issue like a clean round (new)

Proposed task:

- Title: Do not resolve an issue from a dirty round.
- Problem: `--allow-dirty` (`ui/cli.js:356-357`) lets a round judge uncommitted code. The round records `dirty` (`ui/cli.js:384`). The ledger does not read the flag (`ui/ledger.js`, no `dirty` use), so a dirty round resolves an issue like a clean one.
- Evidence: the two P5 lines. They match for dirty=true and dirty=false.
- Change: a resolution from a dirty round does not count. Test in `ui/ui.test.js`.
- Size: S.

### P6. A second fix in one group is never settled (holder dotfiles-331)

Task: holder dotfiles-331 (open, p3, blocked on dotfiles-332). The decision note (2026-11-09) says revisit "only if a recorded climb shows two problems merged". This probe is a probe, not a recorded climb. Add this block as a note with that caveat. No new task.

### P7. A missing round file moves an issue's first round (new, low, narrowed)

Narrowed: the entry count stays the same. Full loss of a missing round's issues was not probed.

Proposed task:

- Title: Keep a round's issues when its record file is missing.
- Problem: `fullRounds` falls back to the rounds.jsonl summary, which holds no issues (`ui/run.js:105`). The ledger then dates an issue from the next round.
- Evidence: the P7 lines. The since value moves from 1 to 2.
- Change: write the issues into rounds.jsonl too, or fail loudly on a missing round file. Test in `ui/ui.test.js`.
- Size: S.

### P8. A killed round reuses its number (holder dotfiles-443 item 4)

Task: holder dotfiles-443, item 4 (write a started line before judging). Add this block as a note. No new task.

## P11. An audit baseline entry without severity accepts a high finding (holder dotfiles-443 item 5)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p11-audit-baseline.js"

Expected:

    P11 no severity: exit 0
    P11 severity info: exit 1
    P11 no entry: exit 1

Mechanism: `audit/cli.js:95` falls back to "high" when the entry has no severity. Task: holder dotfiles-443 item 5. Add this block as a note. No new task.

## P12 and P13. Style rule decisions (one run)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p12-p13-style.js"

Expected:

    P12 one trial each: adopt=true extraLoss=-0.1 control.runs=1 candidate.runs=1 minTrials=1
    P13 pooled in aggregate: adopt=false extraLoss=0.15 control.runs=2 candidate.runs=2 minTrials=2
    P13 haiku only: adopt=true extraLoss=-0.1 control.runs=1 candidate.runs=1 minTrials=1
    P13 opus only: adopt=false extraLoss=0.4 control.runs=1 candidate.runs=1 minTrials=1
    P13 report command exit 0: adopt=false candidate.runs=2

### P12. One run per variant adopts a style rule (new)

Proposed task:

- Title: Require a trial floor before a style rule is adopted.
- Problem: `bench/style/style.js:181` computes `minTrials`. The decision at `:203` does not use it.
- Evidence: the P12 line.
- Change: return "not enough trials" below the floor, as `bench/report.js:36-41` does.
- Size: S.
- Correction: the earlier "by design" label on `bench/style/style.test.js:175` is withdrawn. That test is a positive case with two runs per variant.

### P13. Pooled models decide the style rule (new)

Proposed task:

- Title: Decide a style rule per model, not over pooled models.
- Problem: `bench/style/cli.js:112` (`reportCommand`) pools all records, so the decision flips with the model mix.
- Evidence: the P13 lines. Haiku alone adopts. Opus alone and pooled do not.
- Change: report one decision per model and effort, or refuse a decision when the groups disagree.
- Size: S.

## P14. A bench rerun repeats finished trials (holder dotfiles-443 item 3)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p14-bench-rerun.js"

Expected:

    P14 invocation 1: exit 0; sessions so far 2; results so far 2
    P14 invocation 2: exit 0; sessions so far 4; results so far 4

The first run's log also says "Spent $0.20 on 2 runs". The rerun log does not repeat that line.

Task: holder dotfiles-443 item 3 (add resume, size M). dotfiles-425 lists the same weak point. Add this block as a note. No new task.

## P15. Two models in one board series get the same run id (new)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p15-board-runid.js"

Expected:

    P15 claude-haiku-5-5: exit 0
    P15 claude-opus-5-5: exit 0
    P15 file bench/board-formats/results.jsonl: t-1/claude-haiku-5-5, t-1/claude-opus-5-5

Proposed task:

- Title: Give board bench runs ids unique across models.
- Problem: `bench/board/cli.js:96` counts earlier runs for the same series, model and effort. The sequence at `:100` restarts per model, so both models get run id `t-1` (`:106`).
- Evidence: the P15 lines.
- Change: count the sequence per series, or include the model in the id. Test with two models in one series.
- Size: S.

## P16 and P16b. Leftover clean kills a live run's process and folder (new)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p16-bench-clean.js"

Expected:

    P16 active run pid <pid> alive before clean: true
    P16 after clean: process exited, signal SIGKILL; root exists: false

Orphan check, run after the probe:

    ps -o pid,ppid,command -ax | grep "sleep 60" | grep -v grep

The `sleep 60` child has ppid 1. It survives the clean, because its command line does not name the folder. Each run of P16 leaves one. Kill it by pid only: `kill <pid>`. Do not kill by pattern.

Proposed task:

- Title: Stop board-bench cleanup from killing a live run.
- Problem: `bench/board/run.js:149-154` runs `pkill -KILL -f` on the folder path. It does not check the status, then removes the folder. A live run's process was killed. Its child without the path survived.
- Evidence: the P16 lines and the orphan check.
- Change: skip a folder held by a live lock, as `ui/run.js:69-95` does. Check the pkill status. Stop by process group, not by argv.
- Size: S.

### P16b. Control: pkill -f matches a child that names the folder

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p16b-pkill-match.js"

Expected:

    P16b pgrep exit 0; lists child pid <pid>: true
    P16b pkill exit 0
    P16b after pkill: exited; signal SIGKILL

This control shows that matching is by argv only.

## P17. A failed refresh drops a stale OPEN PR (new)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p17-metrics-cache.js"

Expected:

    P17 stale OPEN (2 h old): returned 0 PR(s); gh calls 1; notes 1; cache still holds k1 true
    P17 stale OPEN (2 h old) note: gh pr view https://example.invalid/pull/1 failed (exit 1: fake gh: network down); its state is unknown.
    P17 fresh OPEN (10 min old): returned 1 PR(s); gh calls 0; notes 0; cache still holds k1 true

Proposed task:

- Title: Keep a PR's last known state when its refresh fails.
- Problem: `metrics/github.js:34-36` uses the cache only when the entry is fresh or not OPEN. When gh fails (`:45`), the PR is left out. The cache still holds its last state, and the note says the state is unknown.
- Evidence: the P17 lines.
- Change: return the cached state, flagged as stale, when gh fails. Show the flag in the report.
- Size: S.

## P19 and P20. Config identity and budget (one run)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p19-p20-config.js"

Expected:

    P19 round 3 above run 1: loaded without error
    P20 same settings, keys reversed: hash a=2f16bc0d7f49e213 b=e34eff6af04f00da equal=false

### P19. A round budget above the run budget loads (new, low)

Proposed task:

- Title: Reject a round budget above the run budget.
- Problem: `ui/config.js:230` checks each call against the round budget only. A round budget above the run budget loads.
- Evidence: the P19 line.
- Change: check round <= run in the same validation. Test near `ui/ui.test.js:97`.
- Size: S.

### P20. Key order changes the config hash and so the run identity (new)

Proposed task:

- Title: Hash the config in a fixed key order.
- Problem: `ui/config.js:249` hashes `JSON.stringify(raw)`, which keeps the file's key order. The comment at `:247` says formatting does not count. The run identity uses this hash (`ui/run.js:18-20`). A reordered file then refuses the old run (`ui/run.js:39-40`).
- Evidence: the P20 line.
- Change: hash a sorted-key JSON. Test that reordered keys give the same hash.
- Size: S.
- Related, not the same: dotfiles-441 covers the scoring rubric version pins. It does not cover this hash.

## P21. A judge issue naming an unshown design is dropped silently (new, low)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p21-issue-design.js"

Expected:

    P21 issue with unknown design 7: no error; issues kept=1 strengths kept=0
    P21 control scored unknown design threw Error: scored Design 7, which was not shown

Proposed task:

- Title: Make an unshown design in a judge issue an error, as scores are.
- Problem: `ui/council.js:230-231` drops issues and strengths that name a design not shown, with no error. Scores for such a design throw (`:201`).
- Evidence: the P21 lines.
- Change: throw, or record a note, for an unknown design in issues. Test near `ui/ui.test.js:387-393`. `ui/ui.test.js:1027` pins the scored error.
- Size: S.

## P22. Refuted control (no task)

    env HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" bun "$SCRATCH/probes/p22-wilson.js"

Expected:

    P22 wilson(0, 0) = null
    P22 wilson(3, 0) = null
    P22 wilson(5, 3) = {"k":5,"n":3,"rate":1.6666666666666667,"low":null,"high":null}
    P22 wilson(0, 4) = {"k":0,"n":4,"rate":0,"low":0,"high":0.4898908403969213}
    P22 wilson(4, 4) = {"k":4,"n":4,"rate":1,"low":0.5101091596030786,"high":0.9999999999999999}

Verdict: refuted for the report path. `wilson()` returns null bounds for k > n when called directly. `rate()` (`bench/board/report.js:20-23`) counts k over the same filtered set as n, so the report cannot pass k > n.

## Not probed

- P9: per-run budget is by design (`claude/skills/ui-climb/SKILL.md:236`). A cap across runs is an open question for the owner (design or cost).
- P18: no probe or text for P18 exists in this record. The parent must name it.
- Unverified (reading only): `ui/checks.js:71-73`; `ui/capture.js:88-97`; `bench/board/cli.js:127-142`; `ui/run.js:76`; `bench/board/cli.js:114`; `ui/run.js:46-47`; `ui/cli.js:33-50` and `:44` (documentation, low, not run).
