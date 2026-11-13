# State machine audit: raw explorer records (work in progress)

Checkpoint of board task dotfiles-546. These files are the unedited output of the audit's explorer tracks, with scratch and home paths replaced.
They are not the final document. The final `claude/docs/state-machines.md` replaces this folder before the pull request.

- `e*_machines.md`, `e*_probes.md`, `e*_notes-*.md`: round 1, one prefix per track (hooks, tooling, factory A, factory B, scripts, agent-skills jobs, agent-skills Rust and scripts).
- `r*_machines-2.md`, `r*_probes-2.md`, `e5-scripts_r2_*`: round 2, which corrects round 1 where both name a machine.
- `before-*.txt`: wall-time measurements of hooks and shell startup, taken before any fix.
- Evidence paths that start with `<scratch>` name probe logs that are not in the repository.
