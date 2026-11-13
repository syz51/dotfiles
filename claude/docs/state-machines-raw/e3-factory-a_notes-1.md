# Working notes (not the deliverable)
## Read in full so far
- cli.js (41), lib/state.js (75), lib/proposal.js (178), tests/lib/process.js runProcess only (timeout rejects, :135-223)
## state.js
- acquireLock 53-75: wx create; EEXIST -> Number(read); empty/NaN -> pid 0 -> falsy -> rmSync (:62-72). dotfiles-158 race. Empty file taken at once.
- kill(pid,0) success -> false (:65-66) no age limit (dotfiles-442). EPERM -> false (:68) pid 1 forever.
- writeJsonAtomic 38-43: tmp `${path}.${pid}.tmp`, no fsync; crash leaves tmp file (minor).
- readJsonl 26-35: malformed line throws whole file (by design? check test).
## proposal.js
- publish 121-129: commit, push HEAD:refs/heads/branch (no force), onPushed, then gh pr create; pr.code!=0 throws "after pushing". Timeout -> runProcess rejects (no branch context) -> error after push.
- retryable 150-152: dry-run, error, proposer-failed (not error_max_budget_usd) retry.
- git helper 51-55 timeout 300s rejects regardless of allowFailure.
- toolRejection 166-172 fail-closed on tools/mcp.
- cloneRepository 156-162 clone to tmpdir each attempt, checkout -B branch origin/main.
## launchd.js (read in full)
- installAgent 73-85: bootout (ignored result, :77), writeFileSync plist (:78), bootstrap (:79); bootstrap fail -> return 1 with job unloaded and new plist on disk (state: installed, not loaded). Check tests.
- uninstallAgent 87-90: bootout result ignored; rmSync plist even if bootout failed (job stays loaded, plist gone).
- agentStatus 93-96: print exit code only.
- toolPath 59-70 required tool missing throws; optional skipped.
## probe.js (read in full)
- readFilesWithDeadline 21-29: spawnSync child, timeout -> null for whole call; {error} per file; ENOENT/ENOTDIR -> null.
## pricing.js (read in full)
- PRICES_AS_OF 2026-11-07 (:12) but comment :6 says Fable 5.2 checked 2026-11-12; fable-5-1 row still present (:16, dotfiles-334).
- requestCost 53-63: unknown model -> null (unpriced). Dated model ids (e.g. suffix) not in table -> LiteLLM -> likely null (verify).
- Haiku long tier uses prompt incl cache (:56-57).
## litellm.js (read in full)
- cache(): module singleton (:14-20) keyed by path; never reloads within process.
- refreshLitellm 27-45: failed fetch keeps old copy, no attempt timestamp -> every run refetches when stale (30 s timeout). Who calls? check metrics.
- fromLitellm 54-76 fine; litellmPrice 79-84 caches null.
## transcripts.js (read in full)
- sessionFiles 15-27: statSync at :23 outside any try; race with deletion -> ENOENT escapes (loadSessions catch at :323-327 only wraps parseSession). Deterministic symlink does NOT reach this (isFile false). Mock probe needed.
- readRecords 31-45: malformed lines counted, not thrown (contrast state.readJsonl throws).
- parseSubagents 188-228: readRecords(:202) on a dangling symlink named agent-x.jsonl -> ENOENT -> parseSession throws -> loadSessions :326 returns [] silently -> whole session dropped with no count. DETERMINISTIC PROBE candidate.
- loadSessions 317-331: only ENOENT swallowed; no record of the drop.
- parseSession 243-312: hasCostState 271: estimate <= cost*1.1+0.05 else estimate used. Unpriced models silently excluded from estimate (costUSD lower) and cost-state may win; unpriced flag separate (:301).
- summarize 94-129: usage per message id, last wins (:109).
- isAutomation 237-241 regex + temp prefixes.
- costState = records.findLast (:259) — snapshot.
## claude.js (read in full)
- judge 65-113: retryRefused (API -> subscription) wraps attempt. spentUSD (refused cost) only added on success path (:97,:106). Error throws at :101,:103,:107-108 are outside retryRefused: refused cost lost; caller's ClaudeCallError.costUSD = final events only (:42). Probe via fake claude.
- judge: no retry of timeout; per-attempt timeout is what's left (stream.js:56).
- runTask 137-214: transcripts in projects folder during run (readEffort) removed in finally (:181-197); concurrent friction/score may read in-flight transcript (check cwd automation skip). efforts read only from last (:183-184).
- runTask :171 string-matches runProcess message /^Process timeout/ (coupling).
- :195 rmdirSync ENOTEMPTY ignored.
## tests/lib/stream.js (helpers used)
- refusedBeforeWork 37-43; retryRefused 51-61 sets error.refused on second-attempt error; completed 66-70 (zero results -> false).
## codex.js (read in full)
- rolloutThreads 23-45: statSync (:36) no try (race). Threads keyed by id; segments; mtime = max.
- firstLine 48-65; threadMeta 67-74 swallow all errors -> null (:71-72) (silent).
- readThread 84-119: whole file readFileSync; malformed counted; missing meta counted malformed (:118). BULKY skip after meta.
- parseThread 180-257: responses keyed by response_id last-wins (:211); tool output unresolved -> ok null (:237).
- loadCodexSessions 347-381: frontier logic (roots from mtime window, earliest root startedMs :360); subagent without root -> own session re-parsed inherited (:373). Math.min of empty -> Infinity handled.
- threadTitles 260-274 swallows bad lines (:269-271).
- asSession costUSD always estimate; unpriced flag (:330).
## lib/lib.test.js (read in full, 658 lines)
- pins readJsonl damage throw ":2: malformed" (state.test, line ~ 'JSON Lines and atomic JSON'). No test that a torn tail is recoverable (append after torn line merges into malformed line).
- LiteLLM: "read once per state folder" pinned (~line 150).
- loadSessions removed-after-listing test (~line 543-565) uses spyOn(transcripts, 'sessionFiles') and spyOn readRecords: VERIFY the spy actually intercepts internal calls (mutation probe).
- judge refused test (~line 437-447): success path only; refused cost on error path untested (FAKE_CLAUDE_REFUSALS 2 -> 'HTTP 400' test does not assert costUSD).
- runTask timedOut test (~line 606-625) pins timedOut/efforts.
- pricing tests pin Fable 5.2 'checked' date; Haiku long tier; unknown-model null (~line 62).
- codex.test.js (read in full): first test pins costUSD 0 + unpriced true for gpt-a with no LiteLLM cache (~line 60-ish).
- probe.test.js (read in full): FIFO deadline and EACCES tests.
## lib/testing/* (read in full): fake-claude.js modes; "refused" with FAKE_CLAUDE_REFUSALS=2 -> both refused -> judge throws HTTP 400 with costUSD = second attempt only (probe candidate: expect 0.04 total, get 0.02).
## weekly/cli.js (read in full, 274 lines)
- steps 43-57: 7 steps sequential; board writes snapshot (:49); propose reads it (:55); propose takes --dry-run when !pr.
- runStep 85-101: child process; code, stderr; highlights errors -> step.error (:91-95) -> FAILED.
- needsAttention 105: audit exit 1 only. failed 106: error, null code, nonzero except attention. stepStatus 107.
- runWeekly 165-193: lock weekly.lock (:166-170) returns 3; finally rmSync (:191). No overall deadline. Report path weekly-<date>.md overwritten on same-day rerun (:181-182). weekly-last.json written only at end (:183).
- A crash mid-run: lock stays (pid check), no summary for the run; status (:219-227) shows previous last run with no crash marker. Probe candidate.
- exit 1 for both ATTENTION and FAILED (:189) -> conflated exit code.
- billing: readJsonl throws -> billingError caught (:176-180) OK.
- status: JSON.parse(weekly-last.json) (:223).
- install 201-211: toolPath required claude git gh uv; optional cargo.
- run 229-271 parseArgs; --score-usd/--sample validated (:253-257).
- text steps (score, propose) status = exit code only (:96).
## weekly.test.js (read in full)
- pins audit exit1 ATTENTION, score exit 4 FAILED, board fail still runs propose (:~190).
- pins pid 1 counts as held (EPERM) -> by design test for pid 1 (the 'lock is taken atomically' test).
- pins stale pid 999999999 taken over; live lock returns 3.
- install test: bootout exit 3 ignored; bootstrap success only. NO test of bootstrap failure (installed-not-loaded state).
- billing malformed decisions -> 'Unavailable' pinned.
## friction/cli.js (read in full, 533 lines)
- cursor: from=max(cursor|now-since, oldest) :358; resumeAt=min(to,holdAt-1) :434; skipped candidates pull resumeAt back :436-438 (budget check is budgetUsd not actual spend, :436); final cursor write :471.
- readJsonl(recordsFile()) at :359 is OUTSIDE try; torn/malformed friction.jsonl line throws before dry-run check (dry-run also reads) -> every hourly run fails. Probe needed (machine: friction records).
- per-run cap only: maxTotalUsd 0.30 per run (:59, :436); no cross-run cap; hourly LaunchAgent (plist :486 everySeconds 3600) -> up to 24 runs/day. Task: open per-run cap task (check id).
- unresolvedItems board ls --limit 1000 :152, throw on bad shape :156; failure caught :400-405 -> errors++ and matching only capture's own items.
- file(): match -> itemState -> skipped if closed after turn end (:295); file-error after 3 tries (MAX_FILE_ERRORS :30, :371).
- judge fail: costUSD = error.costUSD ?? budgetUsd (:453) conservative.
- error records: judge error twice -> turn never retried (no retry-errors flag in friction). :363, :445.
- boardFilesCapture gate :380-387 returns 0 with note, cursor not moved.
- status :489-494.
## friction/turns.js (read in full, 244)
- Claude turn complete flag: set true on next prompt :51; stop_hook_summary sets complete = !preventedContinuation :60; user/assistant record resets false :61. Stale rule in cli.js :93.
- Codex: complete only set true on task_complete/turn_aborted :111-112; never reset to false (asymmetry vs Claude :61). minor.
- filedFeedback :162 skips turn forever (cli :97), ok !== false so ok null counts as filed.
- signals :195-210; digest :216-244.
## friction.test.js (read in full, 631)
- pins: per-run budget only (:366-376, max-total 0.06 with cost 0.04 -> 1 judged, next run picks rest). no cross-run cap test.
- pins failed filing retry 3 tries (:311-325); pins cursor hold (:333-351); stale 6h (:353-364).
- pins board ls statuses blocked,doing,open,review (:475). pins lock? no lock test in friction.test.js.
- NO test for malformed friction.jsonl (readJsonl throw) -> state with no test.
- NO test for crash between board filing and recording (filed record append) -> probe candidate: fake board kills parent (process.ppid) after logging.
- install test: bootout exit 3 tolerated (:605); no bootstrap failure test.
- board ls limit 1000 not pinned.
- probe idea: friction torn tail: run --dry-run should throw (readJsonl at :359 before dry-run check :373).
## evolve/cli.js (read in full, 210) + evolve.test.js (read in full, 190)
- derived feedback-item state (no storage): untriaged (no resolution, open, >1h :111), routed-open (owner not CLOSED :116), fixed (resolution fixed in window, or routed owner done in window :101,:117), declined-but-reported (:107).
- list limit 1000 :149; full page -> error :154; pinned evolve.test.js:185-189 => by design for evolve.
- owners(): 8 workers, failures -> errors, owner dropped from routedOpen silently (:115) but error reported; pinned :159-168.
- GAP candidate E-dropped: routed item whose owner task is 'dropped' is neither routedOpen nor fixed (:113-117: CLOSED set includes dropped, only done counts) -> disappears from report; no test (evolve.test.js has no dropped owner case). probe via report().
- untriaged item counts at any age (:111) fine.
- evolve has no paging (open task?).
## setups/cli.js (read in full, 138) + setups.test.js (read in full, 150)
- registry validity: problems() :40-74 (schema), loadSetups :86-91 throws; run --check :122-128. Runtime callers: friction :353 (paths false, inside try -> error propagates, lock released), evolve :143 (catches, titles only).
- REQUIRED ids :25; uncovered() coverage test setups.test.js:62-69 uses git ls-files -> FAILS in a git-archive copy (no .git). Note for test run: need git init in scratch copy or record as unverified.
- owner.board not checked against existing boards (by design, no test).
- no state machine beyond valid/invalid; minor.
## review/cli.js (read in full, 291), config.json (read), review.test.js (read in full, 262), testing/fake-session.js (read in full, 39)
- per-repo states: prepared (:92-100) -> skipped no base (:181) | empty commits 0 (:182) | review ok (:195-199) | verify ok (:211-213) | filing per confirmed (:215-224) | error (:226-227). Terminal per run; next run re-reviews window.
- GAP R1: board add throw on finding k ends repo (:222 inside try :176-227); findings after k never attempted and never recorded (confirmed/rejected only hold attempted) -> lost. Test pins only the error + rejected length (review.test.js:196-199), not the lost findings. Probe: fake session 3 REAL lines (FAKE_REVIEW_TEXT) + board add fails on 2nd add.
- GAP R2: result file keyed by day, overwritten on same-day rerun (:288 writeJsonAtomic main-DATE.json). Probe: run twice same day.
- GAP R3: no idempotency key on board add (:222); dedupe only via verify prompt's open titles (:139, :148 TITLES=200 slice after filter). Probe: fake board ls does not list filed title; second run files same title again. (Real board would list them, so verdict: confirmed that code has no key; behaviour depends on LLM.)
- GAP R4: result JSON written only at end (:288); crash after filings loses record of them (state lost on crash). unverified or probe with fake board that kills parent.
- openTitles :145-149 uses ls --limit 1000 then slice 200 after filter; order is board's ls order (check board/cli.js).
- per-repo cap only: review.test.js:92-97 pins "within a per-repository cap" => by design for no run-level cap (budgets 5+2 per repo, :9-10 config).
- review.test.js pins: prepare, skip young repo, zero commits, failures, dry run, --board refuse (:251).
- weekly review verify prompt says "Do not edit any file" (:135) — instruction-only, tools Bash allowed in VERIFY_TOOLS (:25). Not a state gap.
- lib/state.js: statePath and writeJsonAtomic mkdir parents (state.js:13-17, :38-43) so no ENOENT.
## board/cli.js (read in full, 129)
- call() timeout 60 s :37; errors :41-45.
- checkFeedback :55-62: throws at LIST_LIMIT (:59) — comment :58 "no promised order: a full page may hide open ones" => review openTitles (review/cli.js:148) comment "newest first" is NOT backed by board order. GAP R5 (order assumption): probe with fake ls of 300 open tasks.
- collect uses allSettled :66-73; snapshot written even on error (:124), exit 1 :128.
- run deletes old snapshot before collect (:122) then writes (:124): window with no snapshot file.
- friction unresolvedItems (cli.js:152) has no full-page check (contrast board :59, evolve :154).
## board/proposal.js (read in full, 318)
- readSnapshot :38-52 (null allowed). boardCandidate :72-86: feedback null -> open=[] (:75) -> note "0 open feedback tasks" when ls FAILED (snapshot.errors not checked here). CHECK caller (scoring/propose.js) for errors handling. GAP B1 candidate.
- seen set = feedback ids in recent non-retryable proposals within 30 days (:73-74); FEEDBACK_ITEMS 25 oldest first (:84).
- attemptBoard statuses: rejected-tools (:256-257 via toolRejection), rejected-paths (:260 .git touched; :280), proposer-failed (:270-272), no-change (:277), leak-suspected (:285), tests-failed (:300), dry-run (:301), partly-proposed (:308-311 comment says by design: not retried), proposed (:314). Thrown error when first publish fails (:310 `throw error`) -> caller must handle (check scoring/propose.js).
- record.costUSD = budgetUsd before runTask (:240) conservative; overwritten by resultEvent cost (:254).
- publish orphan: push then gh pr create fail -> publish throws (proposal.js:127-129) -> if no prUrls, attemptBoard throws (:310) -> record.pushed true but record returned? (check caller).
- BOARD record evidence file written before attempt (:234) and appended (:276).
## board.test.js (read in full, 471)
- pins: stats-failure snapshot keeps feedback (:128-136); malformed stats/ls (:139-144); feedback record variants (:148-166); full page error (:168-173); signals (:180-185); candidate rules RECENT 30d (:187-208); prompt data quoting (:210-220); runSuite can't start (:222-226); defaultsOnly (:228-242); propose full flow both repos (:297-351); single-repo (:353-361); base w/o server (:363-374); rejected-paths table (:376-392); leak (:394-400); tests-failed + not retried + dry-run (:402-420); partly-proposed not retried (:422-433); damaged snapshot (:435-446); board shares budget (:448-454); no snapshot / nothing new (:456-470).
- NOT pinned: snapshot.feedback === null (ls failed) -> boardCandidate treats as [] (proposal.js:75) : no test. Candidate B1 (verify via probe).
- NOT pinned: first repo publish failure (gh pr create fails after push on first PR) -> throw at proposal.js:310 -> orphan branch (proposal.js:121-129). Candidate (i). Check scoring/propose.js handling and lib tests.
- board.test.js:194 'nothing to propose' only when feedback []. 
- board/cli.js snapshot errors do not reach boardCandidate (check propose).

## Context 2 notes (after compaction)
- board/DESIGN.md read in full (564 lines): superseded research record; says defaults stale 24h, lease 45 min, decay 30 days (:81-99). Not a machine source beyond these.
- board/PLAN.md read in full (167 lines): decisions :132-134 (defaults evolve via feedback), open questions none blocking :138-142.
- board/cli.js:65 snapshot has errors[]; :72-73 feedback null on failed ls; :94 summaryLines shows errors.
- board/proposal.js:72-86 boardCandidate ignores snapshot.errors; :75 open = feedback ?? [] -> failed ls reads as "0 open feedback tasks (0 new)". Candidate B1 (failed ls = empty). Check task dotfiles-440 / board LIST_LIMIT.
- scoring/propose.js:320-334 board snapshot: readSnapshot throws -> failed++ (:327-329), boardCandidate on snapshot only.
- scoring/propose.js:362-372 run loop: attempt throws -> record status error, branch kept only if started.pushed (:369). Retry uses new stamp branch (lib/proposal.js:95, propose.js:213) so a pushed branch with no PR is orphaned on origin. Candidate P1 (orphan branch). Probe: local bare origin + fake gh failing.
- lib/proposal.js:121-129 publish: push, onPushed, gh pr create; throw on gh fail (:127).
- board/proposal.js:303-312 multi-repo publish: first repo failure throws (:310) -> error; later failure -> partly-proposed (waits, not retried; RETRYABLE excludes it lib/proposal.js:150).
- lib/proposal.js:150-152 RETRYABLE = dry-run, error, proposer-failed (not budget).
- scoring/propose.js READ IN FULL (384). Key: :91-95 alreadyProposed uses .find (first match, oldest) not latest; :226-292 attempt; :236 costUSD = budget until stream says; :251; :256 gitState check; :273 no-change; :276 rejected-paths; :280 leak; :284 tests-failed; :285 dry-run; :287 publish; :369 error record; :373 failed count; :336-340 list.
- propose retries: retryable = dry-run, error, proposer-failed(not budget) (lib/proposal.js:150-152). Not retried: no-change, rejected-*, leak-suspected, tests-failed, proposed, partly-proposed.
- scoring/score.js READ IN FULL (422). Key: :271 readJsonl(file) outside try (torn line = score run fails); :80 no endedAt -> "active" forever; :85 MAX_JUDGE_ERRORS keyed by sha; :287 ineligible; :355-360 budget gate; :373-384 judge try; :382 cost = error.costUSD ?? budget; :387 appendJsonl after judge (crash after spend = unrecorded spend, no lock); :393-403 detectors-only pass; :408 counts via slice(existing.length).
- NO lock in score.js or propose.js (acquireLock only friction/cli.js:347 and weekly/cli.js:167). Weekly runs score as step (weekly/cli.js:48), manual score can overlap. Candidate S1: two concurrent score runs judge same session twice (two writers).
- weekly steps: metrics, audit, score (--max-total-usd 4), board, evolve, review, propose (weekly/cli.js:45-56).
- Prior verdicts map to my area: C1 (propose retry dup PR on gh timeout, untested; lib/proposal.js:126 timeout 120s), C2 (RECENT_DAYS duplicated propose.js:45 / board/proposal.js:32), C4a/c/d/e (friction), C5 (score digest), C6 (review titles 200), C11 (evolve updated_at), C12 (setups), C13 (lock pid reuse). M-P (ui, bench, metrics, audit) are outside my half; say so.
- score.test.js READ IN FULL (502). Pins: :73-79 prompt hash per rubric; :108-116 ineligible; :182-218 sample/skip; :220-239 vanished after listing (spy on loadSessions: mutation check needed); :260-280 vanished after hash (removeOnRead); :282-294 other errors fatal; :296-319 invalid/failed -> error record, retry; :321-342 two errors skip until --retry-errors; :344-359 --session budget; :361-384 rubric bump; :386-412 cost counted at budget (ENOENT, malformed) -- refused-cost path NOT pinned; :414-434 fork and host notices; :436-454 shared system; :456-466 budget stop; :468-474 dry run; :476-494 --session prefix. NOT pinned: torn scores.jsonl, crash between judge and append, concurrent runs, endedAt missing.
- propose.test.js READ IN FULL (440). Pins: :142-147 allowedPath; :149-155 readDenies; :157-166 leak 40 chars; :168-179 failureGroups; :181-193 alreadyProposed; :195-202 budget-exhausted blocks; :206-254 happy path, second run blocked; :256-265 rejected-tools; :267-281 rejected-paths table; :283-296 tests-failed; :298-308 leak-suspected; :310-326 gh fails after push -> error, branch kept, retry on new branch (pins orphan branch); :328-336 proposer exit -> error cost 3; :338-356 proposer-failed patch; :358-371 dry-run; :373-378 no-change; :380-393 budget stop; :395-403 never-attempted first; :405-411 no cost -> budget; :413-417 budget > max; :419-426 failed counts; :428-439 threshold/list. NOT pinned: gh creates PR then fails (duplicate PR, prior C1); crash between publish and appendJsonl (propose.js:287 vs :371); concurrent runs; torn proposals.jsonl; board step in propose (board tests cover).
- Candidate P2: propose crash after gh pr create succeeds, before appendJsonl (propose.js:287-288 vs :371): ledger misses the PR; next run re-proposes same sessions. Probe: fake gh that SIGKILLs process.ppid after creating a PR state file.
- scoring/rubric.js READ IN FULL (101). rubric.json READ IN FULL (106): version 14 (:2); 6 detectors (package-runner, ai-attribution, force-push, ultra-effort, shell-file-edit, review-skipped), 9 judge dimensions. Bump is manual: header comment rubric.js:3-6. Test pins judge prompt hash only for current version (score.test.js:73-79), so detector behaviour changes need no bump (prior C5 candidate, re-probe with OUTPUT_CHARS or detector change).
- scoring/detectors.js READ IN FULL (799). State machine: review-skipped (:720-784): pending Map per repo, covered Set (:760, :767, :774), reviewed flag (:761, :769, :780). Global reviewed flag: a review covers every repo (comment :716). Covered files never expire (comment :714-715 says later fixes need no review).
- CANDIDATE D1 (review-skipped): repoOf returns "" for a known folder not in checkouts (:736 `?? ""`); event.repo "" (not null) so the push settles nothing (:771 filter file.repo === "" never matches) and detector returns na (:772-773). Comment :714 says unknown folder settles every repository. Mismatch. Probe: call reviewSkipped(actions, context) with injected context (its signature accepts context, :720, :734), edit in repo X known, push from folder not known.
- CANDIDATE D2: :753-756 sort by at string; events without timestamp (at null -> "") sort first. Unverified.
- Heuristic parsers (shellCommands :155-277, shellEdits :563-608, shellChanges :628-666) are documented as heuristics (detectors.js:1-6, :139-141).
## Context 3 notes
- scoring/detectors.test.js READ IN FULL (757). review-skipped pins: :515-521 fail + files; :523-536 review passes, reviewer agent counts, explorer not; :538-541 review before edit or refused does not count; :543-549 each push settles earlier edits only; :551-559 repo-scoped settle, unknown folder settles all (:556), "cd sub && git push" with cwd (:557 fail), elsewhere folder na (:558); :561-567 non-push commands ignored; :569-581 worktrees, subagents, sed, cd /tmp; :583-599 deletes/moves/patch counted; :601-609 na cases incl ignored file (:608); :611-617 every repo covered by review-scope; :621-651 papers real git; :656-701 T3 worktree; :703-706 repoName; :708-718 locate; :720-738 symlink + gitIgnored; :740-756 boardCheckouts, loadReviewScope errors.
- Not pinned: a push from a known folder that is not in checkouts (D1, :556-558 covers unknown folder /elsewhere only; :736 path not covered). No test pins repoOf "" case.
- Not pinned: event without timestamp order (D2).
- scoring/digest.js READ IN FULL (242). Labels: :124 final assistant event text says "(final message, shown in full below)" but :212 caps final block at maxChars/4 via ends() (:212). Mismatch: final >15000 chars at default is elided with a marker while the label says full. Candidate DG1 (label vs final block). Test pins only a 5.6k-char final (digest.test.js:43-44).
- digest :241 fallback `full.slice(0, maxChars - 40)` drops the final block (end of text) when the 8-attempt loop fails (:230-240). Reachability at default maxChars unclear (fixed parts about 25k < 60k). Unverified; try probe with small maxChars and large header.
- digest.test.js READ IN FULL (183). Pins: :18-45 metadata/labels; :49-64 hook context; :66-86 host notices order; :88-101 host bound; :103-114 bounds; :116-136 long session (partial marker, 406 events); :138-158 fork; :160-173 long fork; :175-183 prompts beyond half.
- scoring/review-scope.js READ IN FULL (154). Notes: locate :49-56 picks FIRST checkout with matching folder name for T3 worktrees (:54, no uniqueness check); t3Checkout :126-133 refuses ambiguous matches. Candidate D3 (two board checkouts with same folder name: locate and t3Checkout disagree). Probe needed.
- gitCheckout :84-101 caches per folder (module Map, OK for short-lived process). gitIgnored :138-147 throws on git error code other than 0/1.
- review-scope.toml READ IN FULL (39). Comment :9-10 says changes apply to sessions scored afterwards; rubric bump needed for past sessions. Detector results are stored in scores.jsonl, so a toml change does not rescore without bump (matches C5).
- cli.js READ IN FULL (41). Dispatch only. COMMANDS :4-17 names metrics, bench, audit, ui (second half). No state.
- lib/state.js READ IN FULL (75). acquireLock :53-75: TOCTOU takeover candidate L1: two processes read the same stale pid, A takes it, B's rmSync (:72) deletes A's live lock, B takes it too. Probe: 50 concurrent processes on one stale lock, count true results (expect 1).
- writeJsonAtomic :40 tmp name `${path}.${pid}.tmp` never cleaned if crash between write and rename (:41-42). Minor.
- readJsonl :26-35 torn last line throws for whole file (J-torn).
- lib/probe.js READ IN FULL (29). readFilesWithDeadline :21-29: any signal (:25 `run.signal`) reads as deadline null; reader truncates at maxChars silently (:11, no marker). Check callers.
- lib/claude.js READ IN FULL (214). judge :65-113: retryRefused (:81) reruns a refused call on subscription; refused spend added only on success (:97, :106). Failed paths throw ClaudeCallError with costUSD from resultEvent only (:42), so refused spend is dropped at :91, :101, :103, :107-108. runTask :199-213 includes refused cost (:208) even on failure. Inconsistent: candidate J-refused (judge drops refused spend on failure; caller score.js:382 then records budget or the partial cost). Probe: FAKE_CLAUDE_REFUSALS plus a failing judge. Check fake-claude.js support.
- runTask timeout :169-176 returns timedOut; other errors rethrow. :181-197 transcript cleanup in finally, nested try so cleanup runs even if transcriptEfforts throws.
- judge :66 mkdtemp, :110-112 rm in finally. judge cwd/system file ok.
- lib/proposal.js READ IN FULL (178). publish :121-129: push :123, onPushed :124, gh pr create :126 with runProcess timeout 120000; runProcess THROWS on timeout (claude.js:171 pattern /^Process timeout/), so the "pr create failed" message (:127) is only for non-zero exit; a timeout throws a raw "Process timeout" error without the branch name. Caller keeps the branch because pushed was set (propose.js:369). C1 path: gh creates PR then times out -> status error -> retry on new branch -> second PR. Probe needed.
- stamp :95 is per second; branch collision only if two runs attempt in the same second (S1 related). Low likelihood.
- RETRYABLE :150-152 confirmed.
- toolRejection :166-172 fails closed when no init event.
- lib/launchd.js READ IN FULL (96). installAgent :73-85: bootout (:77) before writeFileSync (:78) and bootstrap (:79). If bootstrap fails (:80-82) the old job is already unloaded and the new plist is on disk; returns 1, no rollback. Candidate L-boot. Probe: fake launchctl (CLAUDE_FACTORY_LAUNCHCTL) exit 1 on bootstrap; check job gone (fake log). Check friction.test.js:603-620 and whether any test covers bootstrap failure.
- uninstallAgent :87-90: bootout result ignored (any failure), plist removed anyway. Candidate U-boot. Probe: fake launchctl bootout exit 5 → no error, plist removed while job still loaded.
- agentStatus :93-96 uses print exit code only.
- lib/litellm.js READ IN FULL (84). States: missing, fresh (<7d), stale. Failed fetch keeps old copy, adds note, returns false (:36-38); 30 s AbortSignal (:32). Each run re-tries fetch while stale (no failed-fetch state). Module cache `loaded` :14-20. Entries with no input/output price return null (:57). Probe with injected fetch (refreshLitellm has fetch param).
- lib/pricing.js READ IN FULL (63). PRICES_AS_OF (:12) is never read by code (grep: only comment :3); Fable 5.2 check date in comment :6 (2026-11-12) differs from the constant. Price table has no age check (by design per comment?). requestCost :53-63 returns null for unknown model; caller transcripts.js:144 must handle null (read transcripts.js to verify). Dated model ids miss the table (:25, :54 exact match) and fall to LiteLLM.
- tests/lib/stream.js (outside area, read for helpers): retryRefused :51-61 sets error.refused only when the SECOND attempt throws; judge's post-check throws (claude.js:107-108) after retryRefused returned, so judge never attaches refused spend to the error.
- lib/testing/fake-claude.js READ IN FULL (114). Modes: structured, tool, mcp, error (:79-82, 429, cost 0), refused (:83-88, cost FAKE_CLAUDE_COST, exits 1, switches after FAKE_CLAUDE_REFUSALS calls to FAKE_CLAUDE_THEN). 
- CONFIRMATION PLAN J-refused: FAKE_CLAUDE_MODE=refused FAKE_CLAUDE_REFUSALS=1 FAKE_CLAUDE_THEN=error FAKE_CLAUDE_COST=0.02 via a sh wrapper for CLAUDE_FACTORY_BIN. Expected per correct accounting: 0.02 spent. Predicted code result: judge throws ClaudeCallError with costUSD 0 (claude.js:42 from second result only; :106 total computed but not attached). score.js:382 then records 0 (?? keeps 0).
- lib/transcripts.js 1-170 read (of 331). sessionFiles :15-27: statSync :23 unguarded (race: file removed between readdir and stat throws, whole listing fails); dirent isFile() skips symlinks (:21) so dangling top-level link is skipped. readRecords :31-45 tolerates torn lines and returns malformed count; digest.js:200 ignores the count (silent). priceRequests :133-152: unpriced model adds nothing to estimatedCostUSD, sets unpriced flag (:145). Check callers use unpriced (second half of area, record only).
- lib/transcripts.js READ IN FULL (331). parseSubagents :188-228: readdirSync returns symlink names; readRecords on a dangling symlink throws ENOENT (:202). loadSessions :323-327 catches ENOENT and drops the WHOLE session silently (no count). Candidate TR1 (silent session drop). Probe: session dir with dangling agent-x.jsonl symlink; expect loadSessions returns 0 sessions and no error. Also sessions with malformed subagent lines are counted (malformedLines :225) but not in the drop path.
- parseSession :271 cost-state preference: stale snapshot used when estimate <= 1.1*state+0.05 (:271); unpriced models lower the estimate (:145) so state wins even when actual spend is higher. Candidate TR2 (unverified): unpriced model in a session with a cost-state makes costUSD = stale state. Check if unpriced flag reaches score.js (score record). 
- isAutomation :237-241 regex on codex-skills path names, documented.
- loadSessions :317-331: since/until filter uses mtime then endedAt.
- friction/cli.js 1-330 read (of 533). completedTurns :86-117 (window (from,to], hold :93-95, skips :97-99, automation :106/:113). recordState :121-133. filedItems :137-147. unresolvedItems :151-160: four `board ls` calls with --limit 1000 and no full-page check (:152; candidate C4c). matchItems :164-167 slice 200. checkFindings :233-243 slice(0,3). file :288-311: board feedback call :303 then appendJsonl :308 (crash window; no idempotency key on the board call; board merges by signature so a repeat adds a report). Candidate FR-crash.
- itemState :268-283 follows duplicate/routed links up to LINK_DEPTH 8 (:280); declined is live (:279).
- boardFilesCapture :259-262 checks `--source` in help text (feature gate).
- friction/cli.js READ IN FULL (533). runFriction :345-482. Lock :346-350, released in finally :480 (SIGKILL leaves stale lock; takeover by pid, C13).
  - readJsonl(recordsFile()) :359 runs BEFORE the dry-run return (:373), so a torn friction.jsonl fails `run` AND `run --dry-run` (J-torn). Error propagates (no catch), exit 1 by uncaught throw. Probe: append partial line; expect throw with path:line.
  - Cursor: from :358, to :356, resumeAt :434 (min(to, holdAt-1)), held/left turns :437, :445; state write :471 only at end, so a crash keeps old cursor (safe; judged turns skip via known.judged :363).
  - Crash window: judged record appended :467, filings :469; board call then append at file() :303/:308 (FR-crash). Pending retry for judged-not-filed :369-371.
  - Judge budget: :436 gate uses budgetUsd not actual; :453 `error.costUSD ?? budgetUsd`. Inside try at :448-457 also covers local digest(entry.turn) at :450 (local bug counted as judge error and full budget spend). Candidate FR-digest (low).
  - Boundary: judge succeeds, appendJsonl at :467 dies → re-judged next run (double spend). Crash window (low).
  - boardFilesCapture false :380-387: cursor kept; turns older than --max-age-hours (48) are never judged (clamped by oldest :357-358). Note in lastRun only. Candidate FR-age: by design per comment :381-382 and option doc :53; check friction.test.js.
  - Give-up after MAX_FILE_ERRORS=3 :371 no marker record (silent abandonment, only per-run console). By design per comment :29; test friction.test.js:295-325.
  - install :513-521 / uninstall :523-527 (prints Removed even if bootout failed; relates to launchd U-boot).
  - plist :485-487 everySeconds 3600.
- friction/turns.js READ IN FULL (244). claudeTurns :42-89: turn opens at each prompt (:49-54), complete set true on next prompt (:51), stop_hook_summary sets complete (:60), any later assistant/user record reopens (:61). Turn index = prompt order (key stability relies on append-only transcripts).
- codexTurns :95-147: turn from task_started (:104) to task_complete/turn_aborted (:111-112). CANDIDATE CX-steer: :138-143 `if (prompt && !turn.prompt) ... else if (payload.role === "assistant")`: a SECOND user message inside one Codex turn is dropped silently (not in digest). Probe needs a rollout fixture (lib/testing/codex.js). Unverified so far.
- filedFeedback :162, signals :195-210, digest :216-244 (three-stage shrink; final :241 cut with marker "rest of the turn omitted").
- Codex helpers used: contentText, FAILED_OUTPUT, promptText, readThread, rolloutThreads from lib/codex.js (need full read of codex.js).
- lib/codex.js READ IN FULL (381). rolloutThreads :23-45 (statSync :36 unguarded like TR race). readThread :84-119 (bulky lines skipped :96-99; malformed counted; meta missing counts +1 :118). promptText :139-145. prLinksOf :156-177 (PR_FOLLOW_CALLS 4 :153). parseThread :180-257. asSession :296-340 (costSource estimated; no cost-state). loadCodexSessions :347-381: subagent whose root is missing becomes own session (:373); children of loaded roots joined (:370); earliest-root bound (:360-365). threadTitles :260-274 silently skips bad lines (:269-271, documented as optional).
- Codex record reading: `parseThread` user message handling only via promptText (:231-232) for response_item; event_msg user messages not considered (check).
## lib/lib.test.js READ IN FULL (658)
- pins: pricing table :46-63 (Fable 5.2 table, checked 2026-11-12 comment :58); LiteLLM fallback :81-134 (refresh week-old :118, notes on failed fetch :122-127, offline :132-133 keeps unpriced).
- state :143-157 readJsonl ":2: malformed" pinned (:151).
- transcripts :161-205 counts; :207-218 per-request haiku tier; :220-232 estimated cost; :254-268 inherited prompt filters; :270-282 unpriced subagent bad meta; :284-306 host notices; :322-334 stale cost-state yields (:322).
- :336-349 readRecords malformed count; :351-373 loadSessions skips ENOENT (pinned) and other errors fatal (:368).
- claude runner :391-472. JUDGE TIMEOUT pins costUSD null (:444) while runTask timeout pins costUSD 0 (:630). Two treatments of a timed-out spend => candidate information-loss gap (by design pinned, but inconsistent).
- :455 refused+retry judge cost 0.04 pinned; :459 two refusals reject HTTP 400 but NO cost asserted => J-refused probe target (judge refused-twice cost lost; lib/claude.js:97-108).
- :573-601 refused try transcripts deleted; :590 crashed session transcript removed (rejects exit 3).
- :603-612 readEffort null when no transcript. :614-637 timedOut keeps streamed events, costUSD 0.
- :639-642 exit 5 fails.
- :652-657 cli usage exit codes.
## READ IN FULL: lib/codex.test.js (180), lib/testing/codex.js (139), lib/probe.test.js (31), lib/testing/transcripts.js (118)
- codex.test.js pins: rolloutThreads segments :27-38; usage :40-43; session fields :45-84 (costSource estimated, unpriced true :68); segments count together :86-94; subagents with root :96-114 (token copy not double counted :110-111); whole-session windows :116-133; ORPHAN subagent becomes agent-launched session :135-141 (by design, pinned); unreadable session_meta, thread id from file name :143-152 (malformedLines 2); PR detection window :154-167 (4 calls); windows/titles/automation/unreadable lines :169-179.
- probe.test.js :14-22 readFilesWithDeadline maxChars 5 truncates "hello world" to "hello" (silent truncation pinned); :24-30 FIFO deadline returns null for whole read.
- testing/transcripts.js: writeProjects, Transcript builder; no state logic.
## READ IN FULL: friction/friction.test.js (631)
- :89-97 frictionSession; :99-121 fixture; :259-293 filing once, second run files nothing (:286-292), cursor reset still no re-file (:289-292).
- :295-309 failed filing retried without re-judge (:298-306); :311-325 three tries then give up: 6 feedback calls, 6 file-error records (:318); max-age (:323, 49h) => 8 calls.
- :333-351 turn held until ended (cursor < last record :343). :353-364 never-ended turn judged at 7h (:362) (check code: stale threshold).
- :366-376 run budget: judged 1, costUSD 0.04 in lastRun (:373); next run picks up.
- :378-387 quiet period (15 min) and no-friction turn files nothing.
- :389-397 invalid judge answer error twice then skipped (log length 4, :395) — "a turn failing twice is left alone".
- :399-412 board without --source: nothing judged, cursor undefined (:406), exit 0 (:402) — wait state (BY DESIGN pinned).
- :414-419 --dry-run writes nothing (:417).
- :421-440 server-coded errors not judged (matches board/cli.js semantics).
- :465-489 match to live item; :491-502 filed-in-run offered; :504-546 closed-after-turn skip, settled (:539-541); :548-557 board ls fail => matches only own, exit 1 (:553).
- :559-571 known items cap 200 (:569).
- :574-593 checkFindings limits (title 72, detail 400); :583-585 feedback text.
- :595-601 plist hourly (StartInterval 3600). :603-620 install: fake launchctl bootout exits 3 and test still expects install exit 0 (:610) => L-boot/U-boot context; :616 uninstall exit 0 with bootout failure? (the fake exits 3 only for bootout, uninstall expects 0 at :616) => uninstall ignoring bootout pinned.
- :622-630 usage exits 2.
## READ IN FULL: evolve/evolve.test.js (190)
- :38-76 report counts, untriaged any age >1h (cli.js:29), routed-open; :89-95 checkTasks refuses unreadable.
- :144-157 run reads one list, owners once each; :159-168 failed owner lookup => exit 1, others counted; :170-183 unreadable list exit 1 with totals null (:177).
- :185-189 full page of 1000 => error reported, exit 1, but no paging (cli.js:149, LIST_LIMIT 1000 :25). Pinned as "reported" only; items beyond 1000 never read (no paging). Candidate: evolve cannot see items past the first page (brief names "evolve paging").
- evolve/cli.js:138-157 collect: setups failure only costs titles (:145); list failure returns result with errors (:152).
## READ IN FULL: review/cli.js (291)
- :23-27 timeouts 40/20 min, OUTPUT_CHARS 60000 (marker :132), TITLES 200 (:27, slice :148), openTitles ls limit 1000 then filter, slice 200 (:146-148).
- :162-166 sessionError. :171-232 reviewRepo: skip no base (:181), commits 0 (:182), runTask review (:187), ClaudeCallError => error.costUSD ?? budget (:193), no result (:197), no skill call (:199), openTitles (:200), verify (:203), ClaudeCallError (:209), filing loop (:215-224) with call add per finding (:222), a failing add ends repo with error but earlier filings kept in record.confirmed (:223/:226-227).
- :229-230 finally removes session artifacts and root.
- :288 writeJsonAtomic(statePath("review", `main-${date}.json`)) — per DAY file; a second run on the same day overwrites the first run's record (filed list). Candidate state gap.
- :284-285 repos reviewed sequentially; boardRepos throws out of run (:71-75) with no per-board catch.
- :290 exit 1 if any repo error.
- claude.js:36-42 ClaudeCallError.costUSD = resultEvent(events) total_cost_usd ?? null; claude.js:91 judge did-not-finish costUSD null; :108 judge failure costUSD = resultEvent(events) (final attempt only, excludes refused try).
- review/cli.js:193,209 use budget as cost when error.costUSD null (estimate).
## READ IN FULL: review/review.test.js (262), review/cli.js earlier
- pins: shipped config cap <=10 (:96); bad config names problems (:102); remoteUrl (:106-108).
- prepare (:113-124): base null when no old commit (:123).
- reviewRepo success (:128-158): filed one, rejected kept (:157); dry run files nothing (:160-164); no commits => no session (:166-171); young repo skipped (:173-179).
- failures (:181-200): review budget-fail keeps spend 0.3 (:185); no skill (:189); verify no output keeps 0.4 (:194); board add fails => error, rejected 1 (:198-199). NOT asserted: confirmed-but-not-filed finding is dropped from record.confirmed (review/cli.js:222-223 push after call) => CANDIDATE info-loss gap (finding text absent from saved JSON and summary when add fails). Probe: FAKE_BOARD_ADD_FAIL=1.
- :234-244 main run keeps result under state/review/main-DATE.json; :246-261 --board filter, FAILED => exit 1.
- no test for same-day second run overwriting main-DATE.json.
## READ IN FULL: review/testing/fake-session.js (39), setups/cli.js (138), setups/setups.test.js (150)
- setups/cli.js: problems :40-74 (schema, ids, paths only with paths=true :60); readRegistry :77-83 (TOML parse error names path); loadSetups :86-91 throws with all problems; run :93-138 list mode prints even when problems exist (:136 says run --check); --check exit 1 (:123-126).
- setups.test.js: real registry valid (:44-60); tracked dirs coverage (:62-69) uses git ls-files => FAILS in git-archive scratch copy (no .git) — expected; coverage helper (:71-82); --check problems list (:84-122); paths in covers (:124-138) pins evolve/run path-less check (:131-132); owners (:140-149).
- No state machine beyond valid/invalid registry. Gap candidate: setups list mode with invalid registry prints setups anyway (cli.js:131-136) — by design? Not pinned. Low priority.
## READ weekly/cli.js (274) IN FULL
- steps :43-57 sequential; TIMEOUTS propose/review 150 min (:25-26), STEP_TIMEOUT 45 min (:19).
- runStep :85-101 catches runProcess throw (timeout) => error step; non-json => output tail; json parse error => step.error (:91-95).
- needsAttention :105 audit exit 1 w/o error = ATTENTION; failed :106.
- billingSummary :112-118 strict readJsonl; runWeekly :176-180 wraps in try, billingError (good).
- runWeekly :165-193: lock statePath("weekly.lock") acquireLock (:167), exit 3 if busy; finally rmSync (:191).
- :181-182 report file weekly-DATE.md written with writeFileSync (NOT temp+rename) — torn-report candidate (minor); same-day rerun overwrites report (:181).
- :183 weekly-last.json atomic; status :223 JSON.parse unguarded (no try) — corrupt file crashes status; atomic write makes this unlikely (minor).
- :186 prints path, :188 notify; return 1 if failures or attention (:189). Attention counted as nonzero exit.
- install :201-211 toolPath required claude git gh uv (:203), installAgent code; uninstall :213-217 ignores uninstallAgent result, always prints Removed, returns 0 (candidate with U-boot).
- status :219-227 agentStatus + last run.
- run :229-271 score-usd/sample validation :253-257.
## READ IN FULL: weekly/weekly.test.js (284)
- :65-80 steps shape; :82-91 needsAttention/failed table.
- :95-129 full run summary; :131-170 billing summary variants; :166-169 damaged decisions.jsonl => billing unavailable, exit 0 (pinned, by design "optional").
- :172-177 audit exit 1 => ATTENTION, exit 1. :179-185 failed score, rest still runs. :187-196 failed board step.
- :198-201 stepEnv keeps CLAUDE_FACTORY_* and CLAUDE_CONFIG_DIR only.
- :203-210 acquireLock: second taker false; pid 1 (EPERM) held (:207-209). :212-218 live lock => exit 3 (:215); stale 999999999 => taken (:217).
- :221-236 billingSummary counts.
- :240-245 plist. :247-276 install/uninstall with fake launchctl whose bootout exits 3: install returns 0 (:262, :271) and uninstall returns 0 (:274) => bootout failure ignored, pinned.
- :278-282 usage exits 2.
- NO test: weekly-DATE.md same-day overwrite; non-atomic report write (:182); crash mid-run leaves weekly.lock (test :212 uses synthetic lock only).
## READ IN FULL: PLAN.md (726) lines 1-726
- :309-313 runTask deadline returns timedOut true (dotfiles-14); proposer records proposer-failed, retried next run.
- :442-447 launchd hang: session-folder reads under ~/Documents go through lib/probe.js 5 s deadline (fix 8f7ffd4).
- :448-451 second run: proposals opened draft PR; branch factory-proposal/... (not factory/...).
- :464-471 final verification: 3 live-run flakes (harness false negatives), not in scope.
- :567-571 circuit breaker decision (dotfiles-107), config holds path list. Not in claude/factory checks (grep later).
- :652-656 API-first refused runs: backoff 30 min to 8 h, subscription fallback (bin/claude-api, outside my area; lib/claude.js calls it).
- :661 rubric v4 hash pinned by test.
- :684 friction filing waits for board feedback --source (friction.test.js:399-412).
- :688 evolve: all 3 items predate feedback records.
- :724-726 full-stop skill; registry has 32 setups.
- :603-726 log: 2026-11-07 weekly evolve step, 2026-11-11 t3 setup split (dotfiles-389).
- Dated-model pricing note at :670 (Sonnet cache reads 0.10). Pricing as of 2026-11-07.
