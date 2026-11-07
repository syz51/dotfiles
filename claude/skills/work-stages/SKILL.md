---
name: work-stages
description: Shape any non-trivial work, whether investigation, research, design, planning, implementation or verification, into stages with clear exit evidence, board records and agent roles. Also use to review feedback to improve this skill.
---

# Work stages

Use the stages the work needs, in order. A small fix may go straight to build. Return to
an earlier stage when evidence contradicts it, recording why in a `decision` note. Each
stage ends with evidence another agent can pick up: on the board when the repository has
one, otherwise in the reply.

| Stage | Goal | Done when | Board | When it splits |
| --- | --- | --- | --- | --- |
| Explore | What exists: code, data, prior work, constraints | Facts listed with `file:line` or source; unconfirmed ones named | `finding` notes | `explorer` per independent area |
| Research | Open questions answered from sources or experiments | Each answered with sources or a reproducible check, or marked open | `finding` notes; open questions as tasks or asks | `explorer` per question; `solver` for hard analysis |
| Design | An approach within the constraints | Choice, rejected alternatives with reasons, and shared interfaces written; user-owned decisions asked | `decision` notes; asks | `solver` for a hard trade-off |
| Plan | Tasks others can run | Each has an imperative title, a standalone body and observable acceptance checks; dependencies as blockers; parallel tracks named | `task_add` with acceptance, blockers, parent | none |
| Build | The change | Acceptance checks pass; tests cover new behavior | claim, lease, handoff | `worker` per independent track |
| Verify | It works where it is used | Closest user-facing check run; review findings handled | `task_done` evidence | review agent per the Review section |

The last column names an agent only for a stage that splits into independent parallel
tracks. One track stays with one agent through every stage it needs: an explorer's
findings are not handed to a worker, and a single track is not delegated to wait on.
Codex and runtimes without these agents do the stage themselves.

## Across stages

- Keep the handoff current.
- Read-only work, such as a review or an investigation, and delegated children put their findings, decisions and open questions in their report; the parent records them on the board.
- Report friction with `feedback` and continue. Its `activity` is the stage in lowercase (`explore`, `research`, `design`, `plan` or `build`), `review` for Verify, or `operate` when running a service.
- The rules in `CLAUDE.md` or `AGENTS.md` (delegation, work board, review, safeguards) take precedence over this skill.

## Feedback on this skill

Report it with `feedback` and `about` `work-stages`. To review that feedback, read the
feedback board's items about `work-stages` and the dotfiles tasks they were routed to, then
change this file and its pins in `claude/tests/config.test.js` through a dotfiles PR.
