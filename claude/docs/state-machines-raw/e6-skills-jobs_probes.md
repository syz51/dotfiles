# Probes for confirmed gaps (agent-skills job and sync side)

Checkout HEAD 7e772d6. Probes run only on a scratch copy, with fake `git` and `launchctl` stubs.
Set `S` to the scratch folder, then run each block. Expected output is from the run on 2026-11-14.

## Setup

```sh
S=<scratch folder>
mkdir -p "$S" && rsync -a --exclude .git --exclude feedback --exclude public/files --exclude target <checkout>/ "$S/copy/"
sh "$S/probes/run_all.sh"   # set S as above; prints one "name exit=N" line per probe
```

`run_all.sh` prints `exit=0` for `u1` because the wrapper's last command is `echo`. Read the `exit=1` line at the end of `u1.log` instead.

## J2 update_checkout labels a failed rev-list as merge_failed (confirmed)

- Command: `uv run --no-project python -B "$S/probes/j2_update_checkout.py" "$S/copy/scripts" "$S/work/j2" "$S/bin"`
- Exit: 0
- Expected output:
  - `control (real git) state = updated`
  - `faulty (rev-list fails, no merge attempted) state = merge_failed`
- Evidence: `scripts/jobs.py:109-110` runs `rev-list` in the `try`; `:116` catches `CalledProcessError`; `:120` and `:122` return `merge_failed`.
- Proposed task: `jobs: report an unreadable checkout as its own state, not merge_failed`. Size S. Split read errors from merge errors so the CHECKOUT_BLOCKED alert names the real cause.

## C1 corrupt capture-state.json is reported as invalid model JSON (confirmed)

- Command: `uv run --no-project python -B "$S/probes/c1_corrupt_capture_state.py" "$S/copy/scripts" "$S/work/c1"`
- Exit: 0
- Expected output: `exception = JSONDecodeError | failure_reason label = invalid model JSON`
- Evidence: `scripts/capture.py:1724` loads the state with `json.loads`; `:1681-1682` maps every `json.JSONDecodeError` to `invalid model JSON`.
- Proposed task: `capture: name an unreadable capture-state.json instead of invalid model JSON`. Size S. Add a state-file failure class and a repair or quarantine step. The label persistence across runs comes from reading only; no multi-run probe was run.

## E2 public_export_job leaves daily-status success null on an uncaught exception (confirmed, legacy path)

- Command: `uv run --no-project python -B "$S/probes/e2_export_job_status.py" "$S/copy/scripts" "$S/work/e2"`
- Exit: 0
- Expected output: `raised KeyError`, then a status file with `"success": null` and no `finished_at`.
- Evidence: `scripts/public_export_job.py:30` writes `success: None`; `:34` catches only five exception types, so `KeyError` escapes. No test in `tests/test_public_export_job.py` covers it (the failure test uses `ExportError`).
- Proposed task: `public export job: record failure for any exception, not only five types`. Size S. Severity low; this is the legacy Python path. Check whether `src/daily.rs` has the same gap (not read).

## U1 upstream.py stops with a traceback on a top-level JSON list (confirmed)

- Command: `sh "$S/probes/u1_upstream_list.sh" "$S/work/u1" "$S/copy/scripts"`
- Exit: 1 (`exit=1` at the end of the output; the wrapper's exit is 0)
- Expected output: traceback ending `AttributeError: 'list' object has no attribute 'get'` at `scripts/upstream.py` line 57. No JSON report.
- Evidence: `scripts/upstream.py:57` calls `.get` on the parsed value; `:58` catches `ValueError` only.
- Proposed task: `upstream: report a non-object sources.json as a source error`. Size S.

## U2 any git failure on a source path is reported as removed (confirmed)

- Command: `uv run --no-project python -B "$S/probes/u2_u3_upstream_check.py" "$S/copy/scripts" "$S/work/u2u3"`
- Exit: 0
- Expected output: `control missing path status = removed`; `U2 injected failure, folder exists upstream: status = removed`; `control no injected failure: status = changed`.
- Evidence: `scripts/upstream.py:146-148` returns `removed` for every `UpstreamError` from `rev-parse HEAD:<path>`. The injected error was `Git command timed out`. `tests/test_upstream.py:144-151` pins `removed` only for a missing path.
- Proposed task: `upstream: only a missing path is removed; git errors stay errors`. Size S. Check the path with `ls-tree` or `cat-file` and re-raise other errors.

## U3 local edits are capped at 400 without a flag (confirmed)

- Command: as U2 (same probe file).
- Expected output: `U3 status = changed | local-only files on disk = 401 | listed = 400 | localEdits keys = ['localOnly', 'modified', 'upstreamOnly']`.
- Evidence: `scripts/upstream.py:136-138` slices each list to `MAX_FILES` (400, line 26) with no count or truncated flag. No test covers the cap (`tests/test_upstream.py` uses fewer than 70 files).
- Proposed task: `upstream: report the true count and a truncated flag for localEdits`. Size S.

## CL1 structured_run loses the reason when the answer is missing (confirmed)

- Command: `uv run --no-project python -B "$S/probes/cl1_api_categories.py" "$S/copy/scripts"`
- Exit: 0
- Expected output: `CL1 structured_run -> phase = completed | output = None | error text = ''` and `CL1 failure_class of that text = CLI or output`.
- Evidence: `scripts/claude_cli.py:141` sets `completed`; `:147-148` keep output only for a dict, with no `else`, so no error is added. `tests/test_claude_cli.py:72-96` covers validated output and error results, not this case.
- Proposed task: `claude cli: a successful run without structured output reports an error`. Size S.

## A1 claude_api maps pause_turn to output limit (confirmed, low)

- Same command as CL1.
- Expected output: `A1 claude_api.call -> ... 'stop_reason': 'pause_turn' ... 'category': 'output limit'`.
- Evidence: `scripts/claude_api.py:158-160` maps every stop reason except `end_turn` and `refusal` to `output limit`.
- Proposed task: `claude api: map pause_turn and stop_sequence to their own categories`. Size S. Low; the call fails closed either way.

## E1 a kill between unload and load leaves the LaunchAgent unloaded (confirmed)

- Command: `uv run --no-project python -B "$S/probes/e1_activate_crash_child.py" "$S/copy/scripts" "$S/work/e1"` with `$S/work/e1/launchctl` set to a copy of `probes/e1_launchctl.sh` and `LAUNCH_LOG` set to a file in that folder. `run_all.sh` does this.
- Exit: 137 (the fake `bootout` sends SIGKILL to the calling Python process)
- Expected output: `plist-sha-before 2950c0898850`. The launchctl log shows `print gui/<uid>/com.example.probe` and `bootout gui/<uid>/com.example.probe`, and no `bootstrap`. The plist hash after the run stays `2950c0898850`.
- Evidence: `scripts/exporter_activate.py:225` calls `agent.unload()`; `:231` calls `agent.load()`. Between them, a kill skips the `except OSError` restore at `:229-230`. No test in `tests/test_exporter_activate.py` kills the process; the restore tests use `OSError` and a failed bootstrap.
- Proposed task: `exporter activation: restore or retry the LaunchAgent when the process dies mid-switch`. Size M. Options: load first with a rollback record on disk, or add a boot-time check that re-bootstraps a missing agent.
