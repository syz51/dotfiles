---
name: ui-climb
description: Hill-climb a web UI's design to a pass bar with the factory's `ui` command, a Claude judge council that scores screenshots blind against main and reference products. Covers the climb configuration, calibration, rounds that fix the judges' findings, `score:` notes, the report, the PR and the owner's merge decision. Use when a task asks to climb, score or redesign a web UI's look against a bar, or names a `ui-climb.json`.
---

# UI climb

A climb improves a web UI in rounds. Each round the factory's `ui` command checks the
committed candidate with deterministic gates, then a council of Claude judges scores
screenshots of it beside main and reference products, unlabeled and shuffled, against
a fixed rubric. You fix what they report, commit and run the next round, until a round
passes, the climb plateaus or the budget is spent. The owner decides whether the result
merges.

```sh
UI="bun ~/.claude/factory/cli.js ui"   # every subcommand takes --config PATH (default ui-climb.json)
$UI capture     # screenshots of the working tree, main and the references, page checks; no judges
$UI calibrate   # can the judges tell main from a degraded control, and how noisy are they
$UI round       # gates, then judges, on HEAD; exit 0 pass, 1 fail, 2 error, 3 budget spent
$UI status      # rounds, spending, plateau
$UI report      # one HTML file: scores per round, main beside the latest round, issues
```

Load `frontend-ui` before changing the UI, and `headless-browser` if you need to look at
a state the configuration does not capture.

## 1. Configure

Write `ui-climb.json` in the project (commit it with the first round). Paths in it are
relative to its folder. Start from:

```json
{
  "version": 1,
  "name": "my-app-web",
  "product": "What the product is, who uses it and for what, in two or three sentences.",
  "taste": ["Preferences of the owner that judges should weigh, if any."],
  "root": ".",
  "setup": [["bun", "install", "--frozen-lockfile"]],
  "checks": [["bun", "run", "typecheck"], ["bun", "test"], ["bun", "run", "build"]],
  "serve": { "command": ["bun", "dev/server.ts", "--port", "{port}"], "ready": "/healthz" },
  "screens": [
    { "id": "home", "title": "Home", "path": "/", "views": ["desktop-light", "desktop-dark", "phone-light"] },
    { "id": "empty", "title": "Empty state", "path": "/lists/empty", "views": ["desktop-light"] },
    { "id": "menu", "title": "Menu open", "path": "/", "views": ["desktop-light"], "steps": [{ "click": "button[aria-label=Menu]" }] },
    { "id": "error", "title": "Server down", "path": "/", "views": ["desktop-light"], "before": ["/__dev/outage?on=1"], "after": ["/__dev/outage?on=0"] }
  ],
  "references": [
    { "id": "peer", "title": "A product people admire for this kind of screen", "url": "https://example.com/public-page", "views": ["desktop-light"], "steps": [{ "wait": 1500 }] }
  ],
  "judges": [
    { "model": "claude-opus-5-5", "effort": "medium", "samples": 2 },
    { "model": "claude-opus-5-5", "effort": "high", "samples": 2 }
  ],
  "pass": { "min": 8, "gain": 0.5 },
  "budgetUsd": { "call": 3, "round": 15, "run": 120 },
  "baseline": "origin/main"
}
```

- Screens run on fixtures, never live data, so every version shows the same content.
  Cover the main screens, the narrow layout, both themes if the product has them, and the
  empty, error and loading states. `before`/`after` are GET paths called around a shot,
  for switches like a simulated outage. `steps` are `click`, `hover`, `fill`
  (`SELECTOR=TEXT`), `press`, `scroll`, `wait` and `waitFor`.
- References are public pages of products of the same kind (or `files` of PNGs with a
  `view`), so judges score on a shared scale; check that each renders logged out with
  `capture`. `pass.references` (optional) also requires every category to beat the best
  reference by that margin; leave it out unless the owner asks for it.
- Judges run in order and a round stops at the first that fails, so put the cheapest
  first. Until a round has heard from every judge, rounds run them all, so you learn
  whether they agree.
  Views are `<viewport>-<light|dark>`; viewports default to `desktop` 1280×800 and
  `phone` 390×844.
- The run is tied to the configuration, what the judges are asked (the factory's rubric
  and prompts) and the owner's declined patterns in `~/.claude/frontend-avoid.md`.
  Changing any of them needs `--new-run`, which captures main and calibrates again;
  scores across runs do not compare. When a round refuses because the factory changed
  under the run, start a new run and say why in a note.

Run `$UI capture` and read the PNGs it lists. Every screen must show what its title says,
in the right theme and width. Fix the configuration until it does.

## 2. Calibrate

`$UI calibrate` (3 calls per judge by default) must exit 0. It fails a judge that does
not score a deliberately degraded copy of main at least a point lower overall and lower in
most categories, or whose scores vary by more than a point between calls. Then that
judge cannot steer the climb: use a stronger model or effort, or better screens, and
calibrate again. Rounds refuse to run without a passing calibration.

Calibration also prints a **bar reach** warning when a judge almost never gives the bar:
the bar is above the best reference by more than twice its noise, or under 5% of its scores of
main and the references reach it. Then put the warning in a note and ask the owner
(`ask_user`) before round 1: go on as is, add a reference they rate at the bar, put a
judge that uses the top of the scale first, or lower the bar.

## 3. Climb

Repeat:

1. Commit the change. A round judges HEAD, extracted and set up fresh; uncommitted changes
   are refused.
2. `$UI round`. Read the whole output: gate failures, the per-judge table, the category
   table, the top issues, and the last line, which starts `score:`.
3. Record the round on the task: `task_note` with the `score:` line as printed, then
   update your handoff.
4. Stop when the round passes, when the run's budget is spent (exit 3), after 10
   rounds, or on a plateau: `$UI status` reports one when, over two judged rounds,
   neither the lowest category nor (while it is under its bar) the gain over main moved
   beyond the judges' noise. On a plateau with the bar more than 0.5 away and over half
   the budget left, status says so: first make one structural round aimed at the lowest
   category (a new type scale, layout system or component set, not more local fixes),
   judge it with `$UI round --structural` and note what it changes, and stop when status
   says that round did not move it either. Status says so for every structural round
   since a metric last moved; a structural round that moved one earns a new one at the
   next plateau. Say why you stopped in the last note, with the calibration's bar-reach
   warning when status repeats it.
5. Otherwise fix what the round reported: failed gates first, then the issues marked
   `[under bar]` (in categories under the bar, furthest first), then the rest. When a
   category under the bar has few issues, the round prints what the judges said of the
   design; work from that. Fix causes, not screenshots: shared tokens, components and
   layout rules, so a change helps every screen. Look at the screenshots of the round
   (the output names the folder) before and after a change.

Rules:

- Never change the configuration, rubric, fixtures, reference list, judges or bar to
  pass, and never special-case the screenshot environment (user agent, viewport sizes,
  reduced motion) in the product. Those climbs are rejected.
- The gates hold the line on regressions: the project's checks pass, no shot logs more
  errors than on main, and contrast, accessible names, tap targets, alt text and
  sideways scrolling are no worse than main's. Keep them that way.
- Keep the product's behavior and copy unless the judges' issue is about them, and keep
  each round's change reviewable.
- Act first on issues reported more than once (`×2` or more) or of high severity. Do not
  undo an earlier round's fix for an issue reported once: leave it, and record the
  conflict with both round numbers in a `note:` and in the PR's Left open.
- Report what in the process costs you a round, such as judges reversing a fix, an issue
  no change can satisfy, a bar that looks out of reach or a gate that misfires, with
  `board feedback --about ui-climb`, citing the round files and fields. Then carry on.

## 4. Hand over

1. Unless the last round already ran every judge, run `$UI round --all-judges` on the
   commit you hand over, so the owner sees every judge's score. Record its `score:` line.
2. `$UI report --out <file>` writes one self-contained HTML file. Publish it as a private
   Artifact when that tool is available, otherwise attach its path.
3. Push the branch and open a PR with the climb's commits. Its body has the last `score:`
   line, the rounds table from `$UI status`, what changed and why, the conflicts left
   open, and the report link.
4. `ask_user` on the task: the result in one line with each judge's lowest score, the PR
   and the report, with the options Merge, Keep climbing (with notes), Discard. Set the
   task `blocked` until the answer. A design change merges only on the owner's word.

## Costs and failures

- Each judge call carries every screenshot of main, the candidate and the references;
  `budgetUsd.call` caps one call, `round` a round and `run` everything in the run,
  calibration included. `$UI status` shows what is spent.
- Exit 2 means the command could not run (configuration, git, the app did not start, a
  baseline or reference shot failed): its message says what to do. The app's output
  is in `server.log` beside the round's screenshots. A judge that could not finish its
  calls also exits 2; the round is recorded as an error with its cost, and you run it
  again (its `score:` line still goes in a note).
- `--uncalibrated` runs a trial round that never passes; never hand one over.
- State lives in `${XDG_DATA_HOME:-~/.local/share}/claude-factory/ui/<name>/runs/<id>/`:
  screenshots per version, `rounds/round-N.json` with every judge's scores and issues,
  `calibration.json` and the spending ledger.
