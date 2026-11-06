# Settle idle subagent threads and prune merged T3 branches

T3 Code does not settle a thread's subagent children when the thread is settled, and
its storage cleanup removes a merged thread's worktree but keeps the branch. This
routine settles idle children and deletes those merged branches. Follow these steps
exactly. Start no subagents, and do not read or quote any thread's contents.

1. Plan. Run:

   ```sh
   uv run --no-project --python 3.11 python -B ~/.config/t3code/settle_children.py \
     --log ~/.local/state/t3-settle-children/settle.jsonl --phase plan
   ```

   It prints the thread ids to settle, one per line, and logs them. If the command
   fails, settle nothing: record its error and go to step 4.
2. Settle. For each printed id, call `t3_thread_organize` once with
   `action: "settle"` and that id verbatim as `threadId`, in parallel batches of up to
   30. Never archive, delete or unsettle a thread, and never settle an id the plan did
   not print. T3 refuses to settle a thread that became active; record such refusals
   and other errors without retrying.
3. Verify. Run the same command with `--phase verify` in place of `--phase plan`.
4. Prune. Run:

   ```sh
   uv run --no-project --python 3.11 python -B ~/.config/t3code/prune_branches.py \
     --log ~/.local/state/t3-settle-children/prune.jsonl
   ```

   It deletes merged local branches of T3 threads whose worktrees are gone and prints
   each as `<repository> <branch>`. A repository it could not prune makes it exit 1
   with a `failed:` line on stderr; the others are still pruned. Delete no branch or
   worktree yourself.
5. Report in at most five lines: ids planned, settled, refused or failed with the
   reasons, ids still listed after verify, branches pruned and any prune failures.
6. If nothing failed, the prune succeeded and verify listed only refused ids or none,
   settle this thread by calling `t3_thread_organize` with `action: "settle"` and no
   `threadId`.
