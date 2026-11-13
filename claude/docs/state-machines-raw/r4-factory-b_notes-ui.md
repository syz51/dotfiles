# Working notes, ui area (round 2). Not a deliverable.
Read in full: ui/run.js, ui/capture.js, ui/cli.js (0-688 in 3 ranges), ui/config.js, ui/council.js (0-455 in 2 ranges), ui/ledger.js, ui/gates.js, ui/checks.js, ui/report.js, ui/testing/fake-judge.js, ui/rubric.json.
Tests read in ranges: ui/ui.test.js 1-47, 155-245.
Temp creators: capture.js:70 claude-factory-ui- (dispose at run.js:146, :212; catch at capture.js:83). ui.test.js:912 claude-factory-ui-repo-.
Gaps to probe: U1 run.js:76 unlock; U2 run.js:46-47 openRun; U4 capture.js:88-97 freePort (plan: foreign Bun.serve binds port while app sleeps 1.5 s; serve() returns foreign origin); P9 cross-run (two fresh runs each spend budgetUsd.run); P5 dirty (already confirmed in round 1).
Reading observations:
- cli.js:33-50 USAGE: --samples text says "at least 2" but cli.js:265 enforces 2..5 (max omitted).
- cli.js parseArgs strict, OPTIONS shared by all subcommands: flags like --structural accepted by calibrate/status silently.
- checks.js:71-73 unknown count (text over background-image) never in checkTotals (checks.js:147-159) or gates.
- report.js:146 uses rounds.find (first passing) vs cli.js:583 list.some; both exclude dirty.
- cli.js:482 stage error -> exit 2, same as usage/setup errors (USAGE:54).
- championResult council.js:364-368 with lead null (round judges champion's own commit) and pass -> "replaced": champion round number moves to the same sha. Low; probe or by reading.
- P18: not in round-1 record (only a line saying none exists). Gap to choose by me.
