# Settle idle subagent threads of settled threads

T3 Code does not settle a thread's subagent children when the thread is settled. This
routine does it for children that are idle. Follow these steps exactly. Start no
subagents, and do not read or quote any thread's contents.

1. Plan. Run:

   ```sh
   uv run --no-project --python 3.11 python -B ~/.config/t3code/settle_children.py \
     --log ~/.local/state/t3-settle-children/settle.jsonl --phase plan
   ```

   It prints the thread ids to settle, one per line, and logs them. If the command
   fails, settle nothing: reply with its error and stop, leaving this thread unsettled.
2. Settle. For each printed id, call `t3_thread_organize` once with
   `action: "settle"` and that id verbatim as `threadId`, in parallel batches of up to
   30. Never archive, delete or unsettle a thread, and never settle an id the plan did
   not print. T3 refuses to settle a thread that became active; record such refusals
   and other errors without retrying.
3. Verify. Run the same command with `--phase verify` in place of `--phase plan`.
4. Report in at most four lines: ids planned, settled, refused or failed with the
   reasons, and ids still listed after verify.
5. If nothing failed and verify listed only refused ids or none, settle this thread by
   calling `t3_thread_organize` with `action: "settle"` and no `threadId`.
