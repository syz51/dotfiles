# Implicit state machines: claude/hooks, codex/, claude/marketplace/lean-prompt

Scope: hook scripts in `claude/hooks/`, their wiring in `claude/settings.json`, `codex/hooks.json` and `codex/trust-hooks.js`, and `claude/marketplace/lean-prompt/`.

Run notes:
- Checkout read at commit 3525a13, clean.
- Probes ran on a scratch copy of the checkout, with fake binaries and a fake HOME.
- Reruns: `sh e1-hooks/probes/rerun.sh fast` (exit 2 only for `board-stop-failure`, expected) and `sh e1-hooks/probes/rerun.sh slow` (all exit 0).
- Outputs: `e1-hooks/probes/out/rerun/`.
- Probe commands are in `e1-hooks/probes.md`.
- Verdicts marked `unverified` were not run this session.

### Shell command parser

- Where: `claude/hooks/shell.js` (and `claude/hooks/shell.test.js`); used by the Bash guards.
- States: depth 0 to 8, plain word, quoted word, `$'...'` word, command name built by `$(...)`, unwrapped wrapper command, too deep.
- Transitions:
  - script -> words: split a command into words, applying quotes. Enforced at `claude/hooks/shell.js:153`.
  - words -> wrapped command: a listed wrapper (xargs, xcrun) gives its command. Enforced at `claude/hooks/shell.js:48-66`.
  - command -> nested command: depth goes up by one per nested script. Enforced at `claude/hooks/shell.js:530`.
  - depth above 8 -> too deep: returns `tooDeep`, and each guard decides. Enforced at `claude/hooks/shell.js:673-674`.
- Gaps:
  - G1 `$'...'` quoting ends a word early, so a force push after it is not seen. Verdict: confirmed. Evidence: `rerun.sh fast`, guards: row `308 quote: echo $'a\'b'; git push --force origin main` exit 0; control `308 control` exit 2 (out/rerun/guards.txt:8-9). Task: dotfiles-308.
  - G2 Wrappers setsid, ionice and flock are not listed, so a force push behind them is allowed. Verdict: confirmed. Evidence: guards rows `424 setsid`, `424 ionice`, `424 flock`, all exit 0 (out/rerun/guards.txt:5-7). Task: dotfiles-424.
  - G3 A command name built by `$(...)` is not resolved, so a force push behind it is allowed. Verdict: confirmed. Evidence: guards row `C3 control` with command `$(echo g)it push --force origin main`, exit 0 (out/rerun/guards.txt:3); the same form in guard-main-checkout is exit 0 (inproc). Task: new (dotfiles-305 was not read; the parent should check it).
  - G4 Too-deep scripts return `tooDeep`; callers differ (see guard-git-push, guard-runtimes, guard-main-checkout). Verdict: by design. Evidence: `claude/hooks/shell.test.js:251-256` (prior record pin); `bun test claude/hooks` exit 0, 1366 pass, 0 fail (out/rerun/hooks-suite.txt). Task: none.
- Tests: `claude/hooks/shell.test.js`, `claude/hooks/guard-git-push.test.js`, `claude/hooks/guard-runtimes.test.js`, `claude/hooks/guard-main-checkout.test.js`.

### freshen-base lock (withLock)

- Where: `claude/hooks/freshen-base.js:15-18, 60-88`; used by `claude/hooks/stale-base.js:11`.
- States: free, held, aged (lock older than 120 s), waiting, busy (wait over 30 s), stolen.
- Transitions:
  - free -> held: `mkdir` of `freshen-base.lock` in the git common dir succeeds. Enforced at `claude/hooks/freshen-base.js:67`.
  - held -> waiting: another run holds it; retry every 100 ms. Enforced at `claude/hooks/freshen-base.js:81`.
  - waiting -> busy: wait passes 30 s and the lock is younger than 120 s; returns `BUSY`. Enforced at `claude/hooks/freshen-base.js:80`.
  - held -> aged and removed: lock mtime older than 120 s; removed, then retried. Enforced at `claude/hooks/freshen-base.js:79`.
  - held -> free: work ends; `finally` removes the lock by path. Enforced at `claude/hooks/freshen-base.js:86`.
- Gaps:
  - G1 The `finally` removes the lock by path, so a late holder deletes a newer holder's lock. Verdict: confirmed. Evidence: `bun p-lock.js` (rerun `f3`, exit 0): holder `out` at 6143 ms while the thief's lock exists (out/rerun/f3.txt:6); late holder `in` at 6252 ms while the thief is in until 8216 ms (f3.txt:8, :11). Task: dotfiles-342 (umbrella dotfiles-425).
  - G2 A lock older than 120 s is taken over while its holder still works. Verdict: confirmed. Evidence: same run: lock aged to 200 s at 3144 ms (f3.txt:4); thief `in` at 3213 ms while the holder works (f3.txt:5). Task: dotfiles-342.
  - G3 The stolen-lock and busy states have no test. Verdict: confirmed. Evidence: `grep -c` of `LOCK_STALE|120_000|steal|stale lock|aged|utimes` in `claude/hooks/freshen-base.test.js` finds no line. Task: dotfiles-342.
- Tests: `claude/hooks/freshen-base.test.js:192` (parallel calls take turns). No steal or busy test.

### freshen-base fast-forward

- Where: `claude/hooks/freshen-base.js:91-127`; tests in `claude/hooks/freshen-base.test.js`.
- States: fetched, dirty (tracked changes), clean, merged, merge failed, merge timed out.
- Transitions:
  - fetched -> dirty or clean: `git status --porcelain --untracked-files=no` output decides. Enforced at `claude/hooks/freshen-base.js:117`.
  - dirty -> skipped: note says tracked changes are kept. Enforced at `claude/hooks/freshen-base.js:117`.
  - clean -> merged: `git merge --ff-only` succeeds. Enforced at `claude/hooks/freshen-base.js:121`.
  - clean -> merge failed: merge fails or hits the 10 s default timeout. Enforced at `claude/hooks/freshen-base.js:121`.
- Gaps:
  - G1 A failed status check reads as clean, so main fast-forwards over a dirty checkout. Verdict: confirmed. Evidence: `FAIL_STATUS=1 bun p-freshen.js F2-status-fails dirty` (rerun `f2-fails`, exit 0): note "Fast-forwarded main by 1 commit(s)", status `M a.txt` kept. Control without the fault (`f2-control`, exit 0) refuses. Task: dotfiles-439.
  - G2 The merge has the 10 s default git timeout, so a slow fast-forward is killed and the note gives no reason. Verdict: confirmed. Evidence: `SLOW_MERGE=30 bun p-freshen.js F1-merge-slow` (`f1-slow`, exit 0): killed at 10.6 s, note "failed (no output)". The comment at `claude/hooks/freshen-base.js:120` says "No timeout". Task: dotfiles-545 item 3 if it covers the merge comment; else new.
  - G3 The run has no total budget. Verdict: confirmed. Evidence: `SLOW_CALL=7 bun p-freshen.js F4-slow-calls` (`f4`, exit 0): 107.2 s. The hook timeout is 90 s (`claude/settings.json:65-66`). Task: new (size S).
  - G4 No test covers a status failure or a merge timeout. Verdict: confirmed. Evidence: grep for `FAIL_STATUS`, `status.*fail` and `fail.*status` in `claude/hooks/freshen-base.test.js` finds no line. Task: dotfiles-439 (status); dotfiles-545 (merge timeout).
- Tests: `claude/hooks/freshen-base.test.js:76-192` (fast-forward, dirty tree at :108, fetch failure at :128).

### stale-base lock and note

- Where: `claude/hooks/stale-base.js:20-62` (note at :60); imports `BUSY` and `withLock` from `claude/hooks/freshen-base.js` at :11.
- States: fetched, fetch failed or timed out, lock busy, no note.
- Transitions:
  - lock held -> fetched: fetch ok; note has no suffix. Enforced at `claude/hooks/stale-base.js:60`.
  - lock held -> fetch failed: fetch fails or times out; suffix added. Enforced at `claude/hooks/stale-base.js:60`.
  - lock busy (`BUSY`) -> note with the failed-fetch suffix. Enforced at `claude/hooks/stale-base.js:60`.
- Gaps:
  - G1 A skipped fetch (lock busy) gets the "fetch failed" suffix. Verdict: confirmed. Evidence: `rerun.sh fast`, `stale-busy` (`bun p-stale.js busy`, exit 0): 0 fetch lines and the suffix "as last fetched". `stale-free` (exit 0): 1 fetch line and no suffix. Task: dotfiles-439.
  - G2 No test covers the busy branch. Verdict: confirmed. Evidence: `grep -ci busy claude/hooks/stale-base.test.js` prints 0. Task: dotfiles-439.
- Tests: `claude/hooks/stale-base.test.js:54-71`. No busy test.

### auto-merge and the --auto rule in guard-pr-merge

- Where: `claude/hooks/auto-merge.js:88-126`; `claude/hooks/guard-pr-merge.js:394-398`; tests `claude/hooks/auto-merge.test.js` and `claude/hooks/guard-pr-merge.test.js`.
- States: draft, mergeable now, waiting on required checks, reviews-only base, BEHIND or DIRTY, auto-merge armed.
- Transitions:
  - draft -> skipped: no auto-merge is armed. Enforced at `claude/hooks/auto-merge.js:107`.
  - reviews only -> skipped. Enforced at `claude/hooks/auto-merge.js:112-114`.
  - mergeable now -> skipped: merge directly. Enforced at `claude/hooks/auto-merge.js:118`.
  - waiting on required checks -> armed: `enablePullRequestAutoMerge`. Enforced at `claude/hooks/auto-merge.js:119-126`.
  - `--auto` with checks pending on a reviews-only base -> refused. Enforced at `claude/hooks/guard-pr-merge.js:394`.
  - `--auto` with BEHIND or DIRTY -> no verdict from the guard. Enforced at `claude/hooks/guard-pr-merge.js:398`.
- Gaps:
  - G1 The guard refuses `--auto` on a reviews-only base with checks running, but auto-merge arms the same PR. Verdict: confirmed. Evidence: `bun p-433.js` (rerun `433`, exit 0): guard "blocked ... checks are still running" for BLOCKED and UNSTABLE; auto-merge "auto-merge is on (squash)" for BLOCKED non-draft (out/rerun/433.txt). Task: dotfiles-433.
  - G2 No test covers `--auto` on a DIRTY PR. Verdict: confirmed. Evidence: `grep -c DIRTY claude/hooks/guard-pr-merge.test.js` = 1; with `--auto` on the same line = 0. Task: dotfiles-433.
  - G3 auto-merge arms non-draft PRs whose base requires checks. Verdict: confirmed (arming, from the 433 run). Evidence: 433 row "auto BLOCKED, non-draft ... auto-merge is on". Task: dotfiles-434.
  - G4 The ui-climb path (its SKILL.md:227 and step 4) is not run. Verdict: unverified. Tried: not run in this pass; the skill is outside this repository. Task: dotfiles-434.
  - G5 `--auto` with BEHIND or DIRTY gets no verdict. Verdict: by design. Evidence: comment at `claude/hooks/guard-pr-merge.js:398`; test `claude/hooks/guard-pr-merge.test.js:77` ("then wait for its checks to pass"); `bun test claude/hooks/guard-pr-merge.test.js` exit 0, 292 pass. Task: none.
- Tests: `claude/hooks/auto-merge.test.js` (11 test rows); `claude/hooks/guard-pr-merge.test.js:77-91`.

### guard-pr-merge check states

- Where: `claude/hooks/guard-pr-merge.js:177` (classifyChecks), `:188-190` (status decides), `:413` (pending message); tests `claude/hooks/guard-pr-merge.test.js:82-91, :261`.
- States: no runs, all passed, a run in progress, a run failed, several runs with one name.
- Transitions:
  - all runs passed -> allowed. Enforced at `claude/hooks/guard-pr-merge.js:188-190`.
  - any run IN_PROGRESS -> blocked "checks are still running". Enforced at `claude/hooks/guard-pr-merge.js:188-190`, message at `:413`.
  - any failing conclusion (FAILURE, CANCELLED, TIMED_OUT) -> blocked. Enforced at `claude/hooks/guard-pr-merge.js:177`.
  - runs with the same name -> every run counts. Pinned at `claude/hooks/guard-pr-merge.test.js:261`.
- Gaps:
  - G1 A run with status IN_PROGRESS blocks even when its conclusion is SUCCESS. Verdict: confirmed (for the rule as coded). Evidence: `bun p-pr.js` (rerun `pr`, exit 0): "blocked 360: CI / Changes IN_PROGRESS with conclusion SUCCESS" (out/rerun/pr.txt). Open question: GitHub may never send this pair; not checked. Task: dotfiles-360.
  - G2 A later SUCCESS run does not clear an earlier CANCELLED run with the same name. Verdict: by design. Evidence: test `claude/hooks/guard-pr-merge.test.js:261` ("every run with the same name counts, in either order"); pr.txt row "blocked 396: same job CANCELLED in run 1, SUCCESS in later run 2"; whole file exit 0, 292 pass. Task: dotfiles-396 (the pinned rule is what that task would change).
- Tests: `claude/hooks/guard-pr-merge.test.js:82-91, :261`.

### guard-main-checkout branch changes and git queries

- Where: `claude/hooks/guard-main-checkout.js:142-164` (changesBranch), `:307` (findMainCheckoutViolation), `:335-339` (runGit, 2000 ms timeout), `:342-345` (temp roots).
- States: main checkout or other; branch change listed or not; git query ok or failed; path in temp root or not.
- Transitions:
  - listed branch-changing command on main -> blocked. Enforced at `claude/hooks/guard-main-checkout.js:142-164`, `:307`.
  - unlisted ref command (`symbolic-ref`, `update-ref`, `branch -m`) -> allowed. Enforced at `claude/hooks/guard-main-checkout.js:142-164`.
  - git query error or 2 s timeout -> undefined -> allowed. Enforced at `claude/hooks/guard-main-checkout.js:335-339`.
  - cwd under temp root (TMPDIR or `/tmp/claude-<uid>`) -> exempt. Enforced at `claude/hooks/guard-main-checkout.js:342-345`.
- Gaps:
  - G1 `symbolic-ref`, `update-ref` and `branch -m` are not in the branch-change list, so they pass. Verdict: confirmed. Evidence: `bun guard-main-checkout-inproc.js` (rerun `inproc`, exit 0): "allowed 431: git symbolic-ref HEAD refs/heads/feature", "allowed 431: git update-ref refs/heads/main HEAD~1", "allowed 431: git branch -m feature other". Control "blocked control: git switch feature". No test row uses these commands (the three matches in the test file are fixture setup at lines 27, 442-443). Task: dotfiles-431.
  - G2 A git query that takes over 2 s returns undefined, so the command is allowed. Verdict: confirmed. Evidence: `SLOW_CALL=3 bun p-main.js` (rerun `main-slow`, exit 0): "allowed in 2.01 s". Control (`main-control`, exit 0): "blocked in 0.08 s". No test covers a timeout (grep for `timeout|slow` = 0). Task: dotfiles-431.
  - G3 `$(echo g)it switch feature` and `G=git; $G switch feature` are allowed. Verdict: confirmed. Evidence: inproc rows "allowed C4: $(echo g)it switch feature" and "allowed C4: G=git; $G switch feature", exit 0. Same cause as the shell parser G3 above. Task: new (see shell parser G3).
  - G4 Checkouts under the temp root are exempt. Verdict: by design. Evidence: code comment `claude/hooks/guard-main-checkout.js:342-345`. The earlier process-level probes passed for this reason, so the probes run in-process. Task: none.
  - G5 A command nested deeper than the parser follows is allowed. Verdict: by design. Evidence: `claude/hooks/guard-main-checkout.test.js:283` (comment: "nested past what the parser follows: the guard fails open"); `bun test` on that file exit 0, 273 pass. Task: none.
- Tests: `claude/hooks/guard-main-checkout.test.js:215, :283, :289`. No timeout test.

### guard-git-push prefilter and config read

- Where: `claude/hooks/guard-git-push.js:43-45` (PUSH_CONFIG), `:152-156` (config read), `:153-154` (rewrite flags), `:265-269` (prefilter), `:274` (block exit).
- States: no push word (prefilter allows), config readable, config read failed, rewrite flags (force, lease, remove), mirror set.
- Transitions:
  - no push word -> allowed. Enforced at `claude/hooks/guard-git-push.js:265-269`.
  - config read fails -> plain push allowed; rewrite still checked. Enforced at `claude/hooks/guard-git-push.js:152-156`.
  - rewrite check looks for force, lease and remove only. Enforced at `claude/hooks/guard-git-push.js:153-154`.
- Gaps:
  - G1 With the config read failed, a push is allowed when `remote.<name>.mirror=true`. Verdict: confirmed. Evidence: `SLOW_CONFIG=5` guards row `432 timeout: git push, git config read stopped after 2 s` exit 0; control `control: git push, config readable` exit 2 (out/rerun/guards.txt:32-33). Task: dotfiles-432.
  - G2 A plain push goes ahead when the config read fails. Verdict: by design. Evidence: `claude/hooks/guard-git-push.test.js:209` ("a git query that fails blocks only history rewrites"); `bun test` on that file exit 0, 1 pass. Task: none; the mirror case stays G1.
  - G3 `$(...)` command name is allowed (same cause as the shell parser G3). Verdict: confirmed. Evidence: guards row `C3 control`, exit 0 (out/rerun/guards.txt:3). Task: new (see shell parser G3).
  - G4 A too-deep script passes the guard. Verdict: refuted. Evidence: `claude/hooks/guard-git-push.test.js:259` ("a script nested too deeply to check is blocked"); `bun test` on that file exit 0, 1 pass.
- Tests: `claude/hooks/guard-git-push.test.js:209, :259, :402`.

### guard-runtimes depth and command words

- Where: `claude/hooks/guard-runtimes.js:16-20` (header), `:137` (depth limit), `:235` (findRuntimeViolation), `:246` (block exit).
- States: command words, depth 0 to 7, too deep (skipped), variable or substitution (not followed), `xargs` replace string.
- Transitions:
  - command word is a runtime -> blocked, exit 2. Enforced at `claude/hooks/guard-runtimes.js:235`, `:246`.
  - depth 8 or more -> skipped, allowed. Enforced at `claude/hooks/guard-runtimes.js:137`.
  - `xargs -I{}` or `-J %` replace string -> no substitution in the command word. Wrapper unwrapping at `claude/hooks/shell.js:48-66`; no code applies the replace string.
- Gaps:
  - G1 `xargs -I{}` and `-J %` hide the runtime name in the replace string. Verdict: confirmed. Evidence: `rerun.sh fast`, `xargs2`: `echo python3 | xargs -I{} {} -c 'print(1)'` exit 0; `echo python3 | xargs -J % % -c 'print(1)'` exit 0 (out/rerun/xargs2.txt:6-7). Control `python3 -c` exit 2 (xargs2.txt:4). The same xargs forms are blocked by guard-git-push and guard-main-checkout (out/rerun/xargs.txt, main-xargs.txt). Task: dotfiles-414.
  - G2 Variables and command substitutions in the command word are not followed. Verdict: by design. Evidence: header `claude/hooks/guard-runtimes.js:16-20`; guards rows `C6 variable: X=python; $X -c 'print(1)'` and `C6 substitution: $(printf pyt)hon -c 'print(1)'`, exit 0 (out/rerun/guards.txt:20-21). Task: none.
  - G3 Scripts nested 8 or more levels are skipped, not blocked. Verdict: by design. Evidence: `claude/hooks/guard-runtimes.test.js:283` ("scripts nested too deeply to follow are skipped, not blocked"); `bun test` on that file exit 0, 1 pass. Task: none.
  - G4 A git timeout makes the guard fail closed. Verdict: unverified. Tried: prior record says refuted; not rerun this session. Task: none.
- Changed since 2026-11-12: commit 8d59233 changed one message line in `claude/hooks/guard-runtimes.js` and its test. No logic change in that diff.
- Tests: `claude/hooks/guard-runtimes.test.js:283`.

### open-items once-only and unfiledItems

- Where: `claude/hooks/open-items.js:59-86` (openItems), `:89-92` (unfiledItems), `:95-101` (board query, fails open), `:110` (active check), `:125` (block exit); test `claude/hooks/open-items.test.js:9, :118-126`.
- States: disabled, active, once only (stop_hook_active), items unfiled (block), no unfiled items (pass).
- Transitions:
  - disabled or `stop_hook_active` -> pass, exit 0. Enforced at `claude/hooks/open-items.js:110`.
  - active and unfiled items -> block, exit 2. Enforced at `claude/hooks/open-items.js:125`.
  - item names a board slug with `-<digits>` -> counts as filed. Enforced at `claude/hooks/open-items.js:90-91`.
  - board query fails or returns bad JSON -> undefined (fails open). Enforced at `claude/hooks/open-items.js:97`, `:101`.
- Gaps:
  - G1 With an empty slug list, the task pattern `\b(?:)-\d+\b` matches any word-hyphen-digit text, so "UTF-8" counts as a filed task. Verdict: confirmed. Evidence: `unfiledItems(["Not verified: UTF-8 handling"], [])` returns `[]`; with slug `dotfiles` the same item is returned (open.txt). End-to-end: no slug and the UTF-8 item, exit 0 (E2); slug `dotfiles` and the same item, exit 2 (E3, open.txt:7). Task: new (size S).
  - G2 A once-only pass when `stop_hook_active` is set. Verdict: by design. Evidence: `claude/hooks/open-items.test.js:118-126`; `bun test` on that file exit 0, 1 pass. Task: none.
- Changed since 2026-11-12: commits 65c7870 and f12d784 changed `open-items.js`, its test and `open-items.json`.
- Tests: `claude/hooks/open-items.test.js:9, :118-126`. No test uses an empty slug list (not checked).

### board-hook.sh exit mapping

- Where: `claude/hooks/board-hook.sh:8` (disabled), `:13-22` (mapping), `:23` (exec); wired in `claude/settings.json` and `codex/hooks.json`.
- States: board disabled, board enabled, exit 2 mapped to 1, exit passed through.
- Transitions:
  - board disabled -> exit 0. Enforced at `claude/hooks/board-hook.sh:8`.
  - `pre-tool-use` or `post-tool-use-failure`: exit 2 -> 1. Enforced at `claude/hooks/board-hook.sh:13-22`.
  - any other event: board exit code passes through unchanged. Enforced at `claude/hooks/board-hook.sh:23`.
- Gaps:
  - G1 Seven of nine board events pass exit 2 through unchanged. Verdict: confirmed (mapping). Evidence: `sh p-board.sh` (rerun `board`): `pre-tool-use exit=1`, `post-tool-use-failure exit=1`; `post-tool-use`, `session-start`, `user-prompt-submit`, `stop`, `pre-compact`, `session-end` each `exit=2` (out/rerun/board.txt). `board-stop-failure` exit 2 (rerun.sh fast). Impact is latent: the real board exits 0 on these events (prior record; not rerun). Task: dotfiles-435.
  - G2 No test pins the exit mapping. Verdict: confirmed. Evidence: the board behaviour tests in `claude/tests/config.test.js:530-560` expect status 0 only; no assertion of 1 or 2. Task: dotfiles-435.
- Tests: `claude/tests/config.test.js:462-500` (wiring) and `:530-560` (behaviour, status 0 only).

### worktree-rule

- Where: `claude/hooks/worktree-rule.js:13` (marker), `:19` (lastIndexOf).
- States: inside a worktree (silent), outside (rule shown).
- Transitions:
  - path contains `/.claude/worktrees/` -> silent. Enforced at `claude/hooks/worktree-rule.js:19`.
  - otherwise -> rule shown. Enforced at `claude/hooks/worktree-rule.js:19`.
- Gaps: None found.
- Tests: `claude/hooks/worktree-rule.test.js:77-78` (OPENCODE_SESSION_ID does not silence the hook); hooks suite exit 0.

### guard-asks

- Where: `claude/hooks/guard-asks.js:7-8` (header), `:35` (help text), `:45` (block exit); test `claude/hooks/guard-asks.test.js:89`.
- States: policy readable (decide), policy unreadable (allow).
- Transitions:
  - unreadable policy -> allow (fail open). Documented at `claude/hooks/guard-asks.js:7-8`.
  - ask refused -> block with help text, exit 2. Enforced at `claude/hooks/guard-asks.js:35`, `:45`.
- Gaps:
  - G1 An unreadable policy file lets the ask through. Verdict: by design. Evidence: header `claude/hooks/guard-asks.js:7-8`; test `claude/hooks/guard-asks.test.js:89`; `bun test` on that file exit 0, 1 pass. Task: none.
- Tests: `claude/hooks/guard-asks.test.js:89`.

### lean-prompt isDeferred

- Where: `claude/marketplace/lean-prompt/hooks/register.ts:6-10`; `claude/marketplace/lean-prompt/hooks/register.test.ts:13-23`; `hooks.json` (one module); `plugin.json` (name lean-prompt).
- States: Artifact tool deferred (`isDeferred` true, description kept); other tools untouched.
- Transitions:
  - `tool.describe` for Artifact -> `isDeferred` true. Enforced at `claude/marketplace/lean-prompt/hooks/register.ts:6-10`.
- Gaps:
  - G1 The host is not run, so no check shows Claude Code hides the deferred tool. Verdict: unverified. Tried: the marketplace suite (exit 0, 151 pass) uses a fake `on`. Task: new (size S, if wanted).
- Tests: `claude/marketplace/lean-prompt/hooks/register.test.ts:13-23` (fake `on`).

### codex trust-hooks

- Where: `codex/trust-hooks.js:9-11` (header), `:22-24` (reviewedHooks), `:27-31` (hooksToTrust), `:105` (matches), `:122` (approve), `:126-135` (config/batchWrite), `:138` (exit status), `:139-141` (finally closes server).
- States: working copy matches origin/main or not; hook untrusted, modified or trusted; approval written or not; server open or closed.
- Transitions:
  - working copy differs from origin/main -> nothing approved. Enforced at `codex/trust-hooks.js:105`, `:122`.
  - `--trust` with a match and pending hooks -> `config/batchWrite` approves them. Enforced at `codex/trust-hooks.js:126-135`.
  - pending hooks or problems -> exit 1. Enforced at `codex/trust-hooks.js:138`.
  - any path -> server closed. Enforced at `codex/trust-hooks.js:139-141`.
- Gaps:
  - G1 `batchWrite` sends `expectedVersion: null`, so a concurrent config write is not detected. Verdict: unverified. Tried: none; a live Codex app-server is needed, and the codex CLI must not start. Task: new (if the parent wants it).
  - G2 A stale origin/main leaves hooks unapproved until the change merges. Verdict: by design. Evidence: header `codex/trust-hooks.js:9-11`; `bun test claude/tests/codex-trust-hooks.test.js` exit 0, 6 pass. Task: none.
- Tests: `claude/tests/codex-trust-hooks.test.js` (6 pass).

### Exit-code and timeout contract per hook

- Where: `claude/settings.json:36` (guard-pr-merge 45 s), `:56` (guard-asks 10 s), `:65-66` (freshen-base 90 s), `:82` (auto-merge 60 s); block exits at `claude/hooks/guard-pr-merge.js:623`, `guard-git-push.js:274`, `guard-main-checkout.js:355`, `guard-runtimes.js:246`, `guard-asks.js:45`, `open-items.js:125`.
- States: allow (exit 0), non-blocking error (exit 1), block (exit 2), timed out (not tested).
- Transitions:
  - block condition -> exit 2. Enforced at the block exits above.
  - guard-pr-merge error (malformed input, crash) -> exit 2. Enforced at `claude/hooks/guard-pr-merge.js:617-620`.
  - other guard error (malformed input, uncaught) -> exit 1, command runs. Uncaught; no catch in those guards.
  - Edit or Write tool call -> no PreToolUse hook. Matchers at `claude/settings.json:15`, `:41`, `:51`, `:61` cover Bash, `mcp__board__ask_user`, and EnterWorktree, Agent and Task only.
- Gaps:
  - G1 The same malformed input gets exit 2 from guard-pr-merge and exit 1 from the other guards. Verdict: confirmed. Evidence: `rerun.sh`/guards probe, section "malformed stdin" (out/rerun/guards.txt:40-46): guard-pr-merge exit 2 ("the guard failed (JSON Parse error ...)"); guard-git-push, guard-main-checkout, guard-runtimes, guard-asks, open-items exit 1. Task: dotfiles-545.
  - G2 No PreToolUse hook covers Edit or Write. Verdict: confirmed. Evidence: `grep -n '"matcher"' claude/settings.json` shows PreToolUse matchers at :15, :41, :51, :61 only. Task: dotfiles-545 (item 2).
  - G3 A hook can run past its timeout: freshen-base ran 107.2 s against 90 s. Verdict: confirmed (run time only; the kill was not observed). Evidence: see freshen-base G3. Task: new (size S).
- Tests: per-hook exit codes are pinned in each hook's test (for example `claude/hooks/guard-pr-merge.test.js:794`, `claude/hooks/guard-git-push.test.js:402`). No test compares hooks.

### Claude and Codex wiring parity

- Where: `codex/hooks.json:13, :17` (Bash guards); `claude/settings.json` (Bash guards and `mcp__board__ask_user` guard); `SETUP.md:282-283`.
- States: guard wired on Claude only, on both, or on Codex only.
- Transitions:
  - guard added to one host -> the other host is not changed. Enforced by no check.
- Gaps:
  - G1 SETUP.md says Codex runs "the same guards". Codex wires 2 Bash guards; Claude wires 4 Bash guards plus guard-asks. Verdict: confirmed. Evidence: `bun p-c7.js codex/hooks.json claude/settings.json` (rerun `c7`, exit 0): codex lines guard-git-push.js and guard-runtimes.js (out/rerun/c7.txt:2-3); claude lines guard-git-push.js, guard-runtimes.js, guard-main-checkout.js, guard-pr-merge.js (c7.txt:6-9) and guard-asks.js on `mcp__board__ask_user` (c7.txt:10). Task: new (size S, doc fix).
  - G2 `codex/config.example.toml:1` sets `model = "gpt-5.4"`. Verdict: confirmed (text only). Evidence: `grep -n model codex/config.example.toml` prints line 1. This is a setup finding, not a state gap. Task: parent decides.
- Changed since 2026-11-12: commit 8d59233 changed `codex/hooks.json`.
- Tests: none. No test compares the two hook files.
