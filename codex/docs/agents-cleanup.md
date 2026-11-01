# Global instructions cleanup and verification

## Scope and decisions

This checklist is the reference for the authorized 2026-10-31 cleanup of
`codex/AGENTS.md`. Preserve existing user preferences, role configurations,
unrelated changes, and protected Claude configuration. Reviews remain read-only
unless fixes are explicitly authorized, as they are for this task.

Baseline: 828 words, 5,973 bytes; delegation accounts for 321 words (39%). The
baseline already contains the mandatory TypeScript skill read and Effect
preference. This cleanup must preserve their behavior.

## Recommendations and acceptance checklist

- [x] R1: Move runtime-specific delegation commands and argument schemas to an
  on-demand reference. Preserve role instructions/models/effort, the general-task
  `gpt-6.1-sol`/`high` fallback, sandbox constraints, and runtime tool precedence.
- [x] R2: State parent ownership once. Preserve automatic role-based delegation,
  independent parallel work, standalone briefs, scoped edits, uncommitted input
  transfer, parent verification, and independent review.
- [x] R3: Route TypeScript by the registered skill name. Retain implementation,
  review, debugging, migration, and tooling/configuration scope; require
  `frontend-ui` before `typescript` when both apply. Unrelated prose/Lua/HTML-only
  tasks must not acquire a TypeScript requirement merely from repository context.
- [x] R4: Record frontend patterns only when explicitly rejected as defaults.
  Keep project-specific feedback local and retain the personal preference file.
- [x] R5: Remove the duplicated global Effect sentence, relying on the mandatory
  TypeScript read and the managed skill's established Effect adoption policy.
  Check both an Effect task and a presentation-only or unrelated control.
- [x] R6: Consolidate authorization wording while preserving explicit gates for
  unauthorized destructive/production/external actions, read-only reviews, and
  previously granted authorization.
- [x] R7: Require one task scratch directory and cleanup before finishing, without
  prescribing deletion timing. Preserve the prohibition on repeated reinstalls
  and the broader dotfiles cleanup rule.
- [x] R8: Clarify Chinese glosses: append the Chinese meaning to drafted or
  translated non-Chinese replies when the output format permits; do not duplicate
  Chinese-only replies or break a strict requested format.
- [x] R9: Remove generic padding and repeated ownership/communication language.
  Preserve uv/Bun with project contracts, boundary validation, justified
  abstraction, narrow recovery, meaningful tests, visual checks, progress,
  evidence, attribution restrictions, secrets/history safeguards, and Fast/Ultra
  prohibition.

## Test strategy

Use complementary checks rather than treating instruction text as an executable
specification. Offline tests should cover structure, links and runtime-role
contracts, test-fixture/scorer negatives, process errors/timeouts, isolated
filesystem checks, and cleanup. Existing CI remains credential-free; live tests
must be opt-in and use real local Codex with the installed global instructions.

Live coverage should include real investigation and authorized delegated edits,
role/model/effort evidence, TypeScript reads and frontend ordering, positive and
unrelated-task controls, project runtime preference, actual focused behavior
checks, translation/gloss and strict-output behavior, read-only and authorization
boundaries, and preservation of unrelated files. Use genuine tool events,
fixture results and owned transcripts; final claims alone do not establish reads,
delegation, or checks. Unsupported evidence is unverified, not a pass.

Retain only synthetic fixtures and sanitized summaries. Put raw traces, local
logs/state, temporary projects and test outputs under one task scratch root;
remove only test-owned transcripts and scratch. Never retain private home/config
contents in this repository. Record exact instruction hashes, CLI version,
commands, counts, observed failures/corrections and limitations below.

Finite runs cannot prove every possible prompt, model, tool transport, or runtime.
Distinguish offline regressions, live instruction-loading evidence, reviewed
behavior and untested boundaries. Changes to instructions or scorers require
rerunning affected cases; independent review findings must be fixed and checked
again before completion.

## Results and review

Completed locally on 2026-11-01 Asia/Tokyo. Changes remain uncommitted; no dotfiles
push, production action, dependency installation, or other-machine deployment was
performed. The installed `~/.codex/AGENTS.md` symlink resolves to this checkout.

### Final inputs

- Global instructions: **664 words / 4,861 bytes**, down from 828 / 5,973 (about
  20% fewer words). SHA-256
  `364eca7e513d785d0c9d6e9af6b59f63e572c680650954bb7901c23cfdb6224a`.
- On-demand delegation guide: SHA-256
  `d762abef8f63ebbc365922451e0edbd9503add0fc3e0afa83c709e43510070fe`.
- Dispatch wrapper: SHA-256
  `968241a1805d1f586bef391917968bd8c55e1341890e5771e77365f86e91ca02`.
- Final check-evidence helper: SHA-256
  `cfa0311f8c2925b1be7777e9e75bed487a4948171f82fa6aa21db11d3570dc93`.
- Real runs used installed Codex CLI 0.165.0, configured `gpt-6.1-sol`/`xhigh`
  parent settings and the normal service tier. Configured child roles retained
  their models and effort. Neither Fast nor Ultra was enabled.
- The external skill engine was reused without source changes. Its recorded
  `activation_trace.py` SHA-256 was
  `fb4c5482c9b4da691119d0614db6f5fff3beab980313989ed4088c005db3aa57`.
  Per-run snapshots and hashes bound scoring to actual installed skill bytes.

### Offline verification

Final integrated command:

```sh
RUN_CODEX_RUNTIME_INTEGRATION=1 bun test nvim/tests/bun-outdated.test.js codex/tests
```

Result: **54 passed, 15 intentional live skips, zero failures; 253 assertions**.
The role-path integration check ran on this Mac. Default portable CI skips that
machine-specific check too; live cases remain opt-in. The CI command now includes
all Codex tests, and SETUP links the reproducible testing guide. Hosted CI was not
triggered because no push was requested.

Also passed:

- 28 TUIOS Python tests with Python 3.13.
- 9 Ghostty launcher Python tests with Python 3.13.
- All 14 JavaScript test/helper files with `bun fmt --check`.
- Local documentation links and `git diff --check`.
- Coverage collection: evidence, filesystem, process and report helpers have
  substantial in-process coverage. Session-cleanup functions run mainly in the
  actual fake-CLI subprocess regressions and are not counted as covered by the
  parent process. These metrics do not establish instruction compliance.

### Real local execution: 52 CLI scenarios including retakes

These are observations, not 52 successful independent trials. The full matrix
was not universally green. Ordinary, controlled-format, and corrected-input
runs remain distinct; earlier failures were not rewritten as passes.

| Stage | CLI scenarios | Observed result |
| --- | ---: | --- |
| Initial ordinary installed-skill matrix | 10 | 5 passed; 3 unverified reader forms; TSX ordering and Vue reference gaps |
| Ordinary composition recheck | 2 | Vue passed all required reads; TSX read frontend first but mixed output was unverified |
| Initial policy matrix | 7 | 6 passed; Python verification failed without retained command diagnostics |
| Python diagnostic follow-ups | 2 | One correct uv run was unverified by the initial flag parser; one used system Python contrary to preference |
| Controlled skill attribution | 4 | TS scope, TSX order and Lua negative passed; Effect reads observed but memory grep left absence unverified |
| Initial native delegation matrix | 8 | Document/archive exploration, worker edits, overlapping explorers and reviewer passed; two small investigations skipped delegation; fallback model/effort correct but guide proof unverified |
| Updated ordinary policy matrix | 7 | 5 passed; correct uv invocation unverified; Japanese reply omitted Chinese meaning |
| Updated native investigation/fallback rechecks | 3 | All passed; fallback guide read and sol/high child both observed |
| Controlled Effect adoption | 1 | Passed complete TypeScript and Effect reference reads and frontend exclusion; final answer recommended Effect for the new backend |
| Final translation/Python acceptance | 4 | Japanese gloss, strict JSON and Chinese-only passed; correct uv invocation initially unverified due a benign flag |
| Last ordinary Python diagnostic | 1 | Correct uv execution and check marker observed; compound check/inspection command unverified |
| Controlled standalone Python verification | 1 | Passed real uv check, exact loaded global instructions, authorized-file guards and independent parent-side behavioral check |
| Latest-child-turn completion recheck | 1 | Ordinary native exploration passed the start-bound completion gate; matched turn hashes retained in sanitized metadata |
| Context-bound completion recheck | 1 | Ordinary native exploration passed with the latest context, start and completion bound to one ID; context/start hashes match in sanitized metadata |

The policy/delegation suites observed complete global instruction text in source
input records, rather than accepting final claims. Native proofs include parent
spawn calls, linked child execution, actual model/effort contexts, and positive
child-turn time overlap for parallelism. Earlier native results were scored by
the former any-completion gate; they are not retroactively described as passing
the final latest-turn gate. Two additional ordinary native rechecks passed the
progressively tighter start-bound and context/start-bound gates for every matched
child, recording the current context/start hashes. Final failure-order refinement
was verified by focused state-sequence regressions, not another model run. Skill dispatch used the real installed
user configuration and immutable pre-run target snapshots, not candidate dispatch
injected by the runner.

Intermediate global hashes were `3b8c9aac...` (initial), `05e3bc06...` (frontend
and fallback routing), and `b9e06465...` (uv execution and restored investigation
scope). Only translation wording changed between b9e06465 and the final input;
affected gloss/strict-format/Chinese-only cases were rerun successfully. The final
Python acceptance used the final full hash above. Earlier unrelated passing
cases were not repeatedly rerun for that translation-only change.

### Defects found and closed

Independent review and real runs led to these fixes:

1. Make the fallback reference reachable for native unmatched/general tasks.
2. Clarify complete frontend-first reads for TSX/Vue and follow relevant reference
   routing. Preserve skill-name dispatch and the TypeScript repository exclusion.
3. Preserve automatic investigation delegation; narrow the direct-work exception
   to trivial edits, avoiding the accidental broader trivial-work exception.
4. Specify `uv run` for Python execution/checks. Correct uv calls with benign
   flags/environment controls have focused positive regressions; arbitrary
   overrides, printed commands, failures and compound checks remain unverified.
5. Require the Chinese meaning unless an explicit output-only/structured format
   excludes it. A language request alone is not that exception. The later
   Japanese, JSON and Chinese-only real cases passed; this finite result does not
   prove that wording alone caused the improvement.
6. Recover cleanup ownership independently of successful stdout, and use valid
   first metadata for cleanup even when later owned JSONL is truncated. Never use
   partial cleanup metadata as completed execution proof.
7. Reject same-byte symlinks, type/mode changes and unauthorized inventory/content
   changes. A null-prototype inventory also catches `__proto__` filenames.
8. Fingerprint the engine and instructions before importing/loading code, verify
   after loading and after evaluation, and fail on drift without reverting updates.
9. Ensure report setup/write failures cannot prevent fixture/transcript cleanup;
   success status follows every assertion. Keep bounded diagnostics only in caller
   scratch. Preserve UTF-8 and kill/reap timed-out process groups and descendants.

Actual fake-CLI subprocess regressions cover failures, malformed/incomplete
output, timeouts, truncated owned transcripts, invalid report targets, report IO
failures and same-byte symlink substitutions. Other regressions reject fabricated
read/check/delegation summaries, unlinked or unfinished children, nonoverlapping
execution, unsafe report paths, missing engines, and import/load/global drift.

### Independent review and limits

Independent review passes inspected instruction preservation and the harness.
They reproduced failure transcript leakage, symlink false passes, load-time
fingerprint drift, and finally a historical-completion false pass. The last could
accept an unfinished child when an earlier parent/child turn was complete. It is
fixed by binding the latest model/effort context ID to the latest started child
turn ID and a matching completion after both. Current abort/failure events are
rejected even before or between these markers; unscoped failures are associated
only after the current phase begins. Every matched child is checked. Regressions cover inherited parent history, prior
child history, wrong/missing IDs, misplaced completion and current aborts. A
real ordinary native scenario subsequently passed the stricter gate. The
fake-CLI symlink fixture now has realistic matching start/complete IDs so its
regression still reaches the filesystem assertion.

Earlier independent runs passed the integrated 51-test version. The final
parent integrated run passed 54 tests after the completion regressions. A final
independent evidence/documentation recheck is recorded below.
No universal activation/compliance claim is made. Ordinary unsupported reader or
command forms remain unverified. Controlled attribution requests constrain syntax
and source scope without naming the selected skill/tool; they do not replace the
ordinary observations. Actual production/destructive actions, secret handling in
live accounts, pushed-history rewrites, every browser/chart path, T3 cross-provider
fallbacks, other machines and arbitrary interpreters were not exercised. Role
configuration, retained safeguards and permissions were checked statically where
live execution would be inappropriate.

A metadata-only cleanup audit found zero remaining task-owned transcripts in the
real session store and no generated test artifacts under codex/. The single task
scratch root was removed after the final read-only review; no raw diagnostics
were retained in this repository. No unrelated sessions, Claude files, role files, or
tracked runtime configuration were changed; Git alone cannot compare ignored
local configuration to a baseline.

### Closure

Final independent read-only review found no further blocking findings within the
documented bounded contract. It independently ran the final integrated suite:
54 passed, 15 intentional live skips, zero failures, 253 assertions (2.51s).
It rechecked all completion false-pass reproductions and both valid marker
orders, the latest real native metadata and the results-document distinctions.
It confirmed the final global and evidence-helper hashes above without drift.

After every model and test process completed, the parent repeated the
metadata-only session audit: zero task-owned transcripts and no unreadable
metadata. It removed the single task scratch root, including raw traces,
SQLite/log state, fixtures, reports and coverage artifacts. A separate read-only
audit had also confirmed no generated Codex artifacts, no Claude edits, and no
tracked role/config edits. Final formatting, local links and diff checks pass.
The changes remain local and uncommitted.
