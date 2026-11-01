# Global instruction testing

The maintained instructions are `codex/AGENTS.md`; this Mac loads them through
`~/.codex/AGENTS.md`. The [cleanup checklist](agents-cleanup.md) preserves the
historical 52 scenarios. The [ordinary-run investigation](verification-investigation.md)
is its successor: acceptance matrix, evidence gaps, fixes and current results.
Read those records before treating an earlier result as current evidence.

## Offline and local integration

From the dotfiles root:

```sh
bun test nvim/tests/bun-outdated.test.js codex/tests
RUN_CODEX_RUNTIME_INTEGRATION=1 bun test codex/tests
bun test --coverage-reporter=text codex/tests
```

The second command additionally checks this machine's installed role symlink;
use it only when the installation points to this checkout. Neither command opts
into model calls. CI runs the portable command with live cases skipped.

The suites cover role contracts, false-positive evidence, incomplete/malformed
turns, instruction-input versus assistant claims, linked delegation metadata,
compound checks and reads, runtime command/cwd binding, read-start ordering,
filesystem preservation, subprocess bounds/timeouts, input drift and cleanup.
Inspect test names and current code for exact cases; a coverage category does not
prove arbitrary shell syntax or every possible agent behavior.

## Real local Codex runs

These use the authenticated local CLI and account quota. They inherit the
configured model/effort and normal service tier. They do not enable Fast or
Ultra. Inspect the synthetic prompts before running. Use one scratch root for
all child fixtures, raw traces, state and reports:

```sh
task_scratch=$(mktemp -d "${TMPDIR%/}/agents-verification.XXXXXX")
TMPDIR="$task_scratch" RUN_CODEX_POLICY_LIVE=1 \
  CODEX_EVAL_REPORT_DIR="$task_scratch/policy-report" \
  bun test codex/tests/policy.test.js
TMPDIR="$task_scratch" RUN_CODEX_EXPLORER_LIVE=1 \
  RUN_CODEX_DELEGATION_CONTRACT_LIVE=1 \
  CODEX_EVAL_ORDINARY_GUIDANCE=1 \
  CODEX_EVAL_REPORT_DIR="$task_scratch/delegation-report" \
  bun test codex/tests/explorer.test.js
TMPDIR="$task_scratch" uv run --no-project python \
  codex/scripts/check_skill_dispatch.py --ordinary-verification \
  run --suite typescript \
  --output-dir "$task_scratch/dispatch" --jobs 2
```

Use `plan --suite typescript` instead of `run` to inspect dispatch cases without
a model call. The wrapper requires the separately maintained `codex-skills`
checkout at `~/.local/share/codex-skills/repository`, or `--engine-root PATH`.
It reuses that repository's conservative skill-read scorer and records its
hashes; its parser's own regressions remain there. The opt-in ordinary adapter
and source-evidence helper have local regressions. No source is downloaded,
vendored, or executed from saved traces. The Effect case requires the installed
TypeScript entrypoint and Effect reference.

Policy scenarios exercise actual Python/Bun fixes, project-declared npm tooling,
read-only review, boundary validation/error propagation, simulated release
safeguards, visual/chart guidance routing, a Japanese reply with a Chinese gloss,
a strict JSON exception and a Chinese-only reply. Parent-side behavioral checks
independently execute the changed fixture. Delegation scenarios inspect parent
and child records for actual role/model/effort evidence and verify investigation
or authorized edits. Separate contract probes test overlapping explorer execution,
an independent reviewer, and the configured general-purpose fallback with
guide-read proof. The live skill matrix checks TypeScript scope, frontend
composition/order, configuration/public-type references, Effect guidance, and
unrelated controls.

The final ordinary acceptance commands add no reader or check syntax constraint.
`CODEX_EVAL_ORDINARY_GUIDANCE=1` removes an older controlled read-attribution
instruction from the general-fallback probe. It does not select the role or
guidance to load. The installed-skill cases retain their explicit read-only,
direct-work safety contract; they test skill selection within that scope, not
automatic delegation.

## Evidence and attribution

OpenAI documents `codex exec --json` as the machine-readable event stream and
`--ephemeral` as skipping persisted session files. Ordinary verification uses
non-ephemeral sessions so it can inspect actual source inputs as well as CLI
events. Logs and SQLite state remain under the task scratch root.
[Official non-interactive documentation](https://developers.openai.com/codex/noninteractive).

Each ordinary run must contain the exact global instruction text in an input
message. The latest source context, task start and successful completion must
identify the same turn; inherited completion or assistant claims do not qualify.
Before/after hashes reject changed instructions, skill bytes and evaluation
helpers. `source_evidence.py` binds a CLI command to its runtime directory only
when current root-thread/turn records uniquely agree on argument vector, output,
exit code and terminal status. It decodes local file URLs; it never guesses cwd
from the fixture, a final answer or a printed path.

The ordinary adapter supports a defined set of literal readers and synchronous
all-`&&` lists. Exact combined output must match immutable snapshots before it
can attribute subordinate reads and their order. Attribution records preserve
the original event, component, output range and hashes; these are deductions
from one command, not newly observed independent executions. Partial reads must
cover the required bytes, and separate read starts must establish that later
guidance was not opened before earlier guidance completed. Unfinished relevant
reads and overlapping/ambiguous ordering cannot pass.

Unquoted `~/` reads use the trusted launch HOME only; quoted tildes, other users
and arbitrary environment overrides do not acquire that expansion. Installed
skill preservation includes lexical link targets and resolved release identity,
and filesystem guards retain special permission bits as well as ordinary modes.

Whole-run absence assertions include every owned descendant source, not just
the parent's displayed trace. Child runtime commands have an explicitly derived
view with source-record provenance. Opaque calls, orphan outputs, malformed or
unfinished child evidence require independent raw review. Full forbidden policy
in source instructions also prevents absence proof. Cross-agent ordering is
unverified by this adapter; do not substitute parent-only ordering.

One conservative source-record classifier applies before, inside and after the
current phase. Unknown formats, repeated contexts/starts, earlier own turns and
ambiguous ownership require review; empty or whitespace IDs never prove inherited
ownership. Only a metadata-declared parent can establish inherited tool history.

Project-check evidence requires the expected real uv/Bun/npm invocation,
successful runtime status, correct fixture cwd and the existing check output.
A zero-exit all-`&&` list can prove each supported synchronous component succeeded.
Pipelines, failure-masking `;`/`||`, substitutions, arbitrary environment overrides,
custom wrappers, comments and printed markers do not acquire check proof.
Parent-side checks establish outcome separately; they do not establish that the
agent chose the required tool. Typed fixture inventories, directories, modes,
links and protected bytes are checked again after parent-side execution.

Retain the strict score and ordinary attribution separately. A failed reader
cannot establish positive loading. Unsupported or partial relevant reads can
prevent claims of absence and ordering even when the surrounding command fails.
Inspect each actual inconclusive sample against the raw source, output and
snapshots while they still exist. Independent review can resolve a bounded
sample with an explicit rationale; otherwise it remains inconclusive. Never
turn an unknown into an observed behavioral failure or a pass automatically.

For diagnostics only, `--bounded-reads` constrains read syntax/source scope and
`CODEX_EVAL_BOUNDED_COMMANDS=1` requests standalone checks. These runs must be
labeled controlled and cannot replace ordinary acceptance observations. The
ordinary and bounded-reader dispatch modes are mutually exclusive.

Codex 0.165 cannot spawn children in ephemeral sessions. The source-bound suites
therefore collect only newly-created transcripts with the exact unique fixture
cwd and proven parent lineage. Cleanup follows linked descendants transitively;
malformed tails can establish cleanup ownership from valid metadata but never
completed execution. Unexpected delegation fails the direct-work skill case.
Unknown, unrelated and preexisting sessions are preserved.

Coverage output is process-local. Cleanup functions exercised by the fake-CLI
subprocess regressions can show low coverage in the parent process. Use those
actual failure-path regressions alongside the coverage report; neither metric
establishes model compliance.

After all processes and child agents finish, independently review raw traces,
source inputs, snapshot guards and outcomes. Record sanitized counts, input
hashes, failures/retakes and limitations in the investigation, then audit owned
session cleanup and remove the single scratch directory. Do not commit raw
transcripts, private instructions, account state or local logs. Never remove
unrelated sessions or reset a dirty checkout as part of cleanup.

## Limits

The [finite acceptance matrix](verification-investigation.md#finite-acceptance-matrix)
combines deterministic process/artifact checks and qualitative review, following
OpenAI's [skill-evaluation guidance](https://developers.openai.com/blog/eval-skills).
Finite runs establish observations for those inputs and that CLI. Arbitrary
shell programs can compute paths, hide reads and fabricate visible text; static
parsing cannot generally recover their behavior. OS file-open tracing does not
prove complete content reached the model. Future prompts and stochastic model
behavior also prevent a universal compliance guarantee.

Real production/destructive actions, real credential handling, pushed-history
rewrites, chart rendering/browser behavior, worktree transfer, other providers
and machines, hostile runtimes, and arbitrary interpreters remain outside this
acceptance contract. Safeguard cases are harmless simulations; project/runtime
overrides and strict output formats are separate controls. Changes to
instructions, fixtures or scorers require rerunning affected checks.
