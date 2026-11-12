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
$UI round       # gates, then judges, on HEAD; exit 0 pass, 1 fail, 2 error, 3 budget spent, 4 provisional pass
$UI status      # rounds, spending, the champion, plateau
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
    { "model": "claude-haiku-5-5", "effort": "high", "samples": 2 },
    { "model": "claude-opus-5-5", "effort": "high", "samples": 2 }
  ],
  "pass": { "min": 8, "gain": 0.5, "references": 0.25 },
  "budgetUsd": { "call": 3, "round": 15, "run": 120 },
  "baseline": "origin/main"
}
```

- Screens run on fixtures, never live data, so every version shows the same content.
  Cover the main screens, the narrow layout, both themes if the product has them, and the
  empty, error and loading states. `before`/`after` are GET paths called around a shot,
  for switches like a simulated outage. `steps` are `click`, `hover`, `fill`
  (`SELECTOR=TEXT`), `press`, `scroll`, `wait` and `waitFor`.
- References set the bar, so choose 2-3 products the owner admires (the `taste` may name
  them) that show the same screen types as `screens`, so judges score on a shared scale.
  Use a public page that renders logged out (check it with `capture`). When the product
  shows those screens only after a login, use `files`: PNGs of its screens, each with a
  `view`. Calibration drops the weak ones (below).
- The bar is to lead the references: `pass.references` requires every category to beat
  the best reference by that margin, and `pass.min` is a floor at about the best
  reference's level. The template's values are placeholders: the run's first calibration
  derives both from the bar judge's scores (below). An absolute bar (no `pass.references`)
  is the exception: use it only when the owner asks for one. Judges in a comparison
  rarely give 9 or more, so an absolute bar that high is seldom reached.
- A reference page that fails to capture is tried again: `referenceCapture.tries` times
  in all (default 3), waiting `referenceCapture.delayMs` (default 30000), then twice as
  long before each later try. One still missing is left out: the command goes on with the
  references that captured, names the missing one in its output, the round's `score:` line
  (`missing reference: <id>`) and the report, and tries it again next command. A round
  that every judge passes without every reference is a **provisional pass** (exit 4), not
  a pass on the bar. `"pass": { "allReferences": false }` lets such a round pass; set it
  only on the owner's word.
- The council is a Haiku judge first and one Opus judge second, as in the template. Use
  only Opus, Haiku or Fable 5.2 models. Haiku is the regression pre-check and Opus is the bar
  judge. Haiku runs first, cheaply, and only checks that the candidate does not score
  under main by more than `pass.regression` (default 2) times Haiku's noise; a round it
  fails stops before Opus. Opus alone applies `pass.min`, `pass.gain` and
  `pass.references`. In general every judge before the last is a pre-check and the last
  applies the bar. Until a round has heard from every judge, rounds run them all, so you
  learn whether they agree.
- The run keeps a **champion**, its best commit so far; main is the first. The bar judge
  scores the champion beside the candidate in the same call. A candidate more than
  `pass.champion` (default 1) times the bar judge's noise over the champion replaces it,
  and so does a pass that is not rejected. One that far under it is **rejected**. One in
  between is held: keep it and go on, and the champion stays. Trials and dirty rounds never
  replace it. Change `pass.champion` only on the owner's word, with `--new-run`.
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

Each judge is calibrated on its own, Haiku too: its noise sets its pre-check floor
(`pass.regression` times it, or main's spread over the run's rounds when larger). Only
the bar judge, Opus, gets a bar reach check, since Haiku never applies the bar.

On the climb's first calibration, read the bar judge's row of the table first. A reference
whose score in its References column is more than a point under its Main column is far
below main, as far as the degraded control must be, and sets no target: remove it, add a
better one if fewer than 2 remain, and calibrate again with `--new-run` before you take
the derived bar.

Every calibration with references prints a **derived bar**: a `pass` block that leads the
best reference in every category (`pass.references`, at least 0.25 or the bar judge's
category noise, rounded up to 0.05) with `pass.min` at about the best reference's level
(their mean, rounded down to 0.25), both from the calibration's own scores. On the
climb's first calibration, put the derived `pass` in the configuration and calibrate again
with `--new-run`, unless the owner asked for the bar the configuration has. Put the
derived bar in a note. After that, keep the bar: a later derived bar differs only by noise.

Calibration also prints a **bar reach** warning when the bar judge almost never gives the bar:
the bar is above the best reference by more than twice its noise, or under 5% of its scores of
main and the references reach it. Then put the warning and the derived bar in a note and ask the
owner (`ask_user`, `Reason: design`) before round 1. Explain the options in the question, and
give them in this order, with these labels, since `ask_user` takes at most 60 characters each:

1. `Use the derived bar (recommended)`: judges give it, and it is the real goal of
   beating products of the same kind. Start it with `--new-run`.
2. `Go on as is`
3. `Add a reference I rate at the bar`
4. `Use a bar judge that uses the top of the scale`
5. `Lower the bar`

## 3. Climb

Repeat:

1. Commit the change. A round judges HEAD, extracted and set up fresh; uncommitted changes
   are refused.
2. `$UI round`. Read the whole output: gate failures, the per-judge table, the category
   table, every issue with its ledger marks, and the last line, which starts `score:`.
3. Record the round on the task: `task_note` with the `score:` line as printed, then
   update your handoff.
4. When the round says `REJECTED`, it scored under the champion by more than the noise.
   Run the command it prints: it brings back the champion's design, keeps the
   configuration and commits. Then try a different fix for its issues, not the same one.
5. Stop when the round passes, when the run's budget is spent (exit 3), after 10
   rounds, or on a plateau: `$UI status` reports one when, over two judged rounds,
   neither the lowest category nor (while it is under its bar) the gain over main moved
   beyond the judges' noise. On a plateau with the bar more than 0.5 away and over half
   the budget left, status says so: first make one structural round aimed at the lowest
   category (a new type scale, layout system or component set, not more local fixes),
   judge it with `$UI round --structural` and note what it changes. Then fix the issues
   that round reported in one more round on a new commit, and stop when status says the
   two did not move it either; status never says to stop right after the structural round
   itself, nor after a re-run of its commit. Status
   says so for every structural round since a metric last moved; a structural round that
   moved one earns a new one at the next plateau. Say why you stopped in the last note,
   with the calibration's bar-reach warning when status repeats it.
6. Otherwise fix every issue the round reported, `×1` included: failed gates first, then
   the issues marked `[under bar]` (in categories under the bar, furthest first), then
   the rest. Keep an issue only when its fix would undo an earlier round's fix (see the
   rules below) or contradict another issue, and say in the round's `note:` which issues
   you kept and why. When a category under the bar has few issues, the round prints what
   the judges said of the design; work from that. Fix causes, not screenshots: shared
   tokens, components and layout rules, so a change helps every screen. Look at the
   screenshots of the round (the output names the folder) before and after a change.

The round keeps a ledger of issues across the run, matched by screen and category.
`[unfixed since round N]` means the judges still report an issue that earlier rounds did
not fix: try a different fix, not the same one again. `[returns after round N]` means an
issue came back after round N's fix resolved it; it keeps that mark while it stays. An
issue counts as resolved only when a round on a new commit no longer reports it. The fixes that resolved an issue go to
the judges as decisions already made, so they stop asking to undo them. The ledger sends
the fix the issue asked for, so apply that fix; when yours differs, say how in the note.

Rules:

- Never change the configuration, rubric, fixtures, reference list, judges or bar to
  pass, and never special-case the screenshot environment (user agent, viewport sizes,
  reduced motion) in the product. Those climbs are rejected.
- The gates hold the line on regressions: the project's checks pass, no shot logs more
  errors than on main, and contrast, accessible names, tap targets, alt text and
  sideways scrolling are no worse than main's. Keep them that way.
- Keep the product's behavior and copy unless the judges' issue is about them, and keep
  each round's change reviewable.
- When the judges alternate on one element across rounds (an issue returns after an
  earlier round's fix, or asks to undo it), keep that element as it was in the
  best-scoring of those rounds, whatever the report counts. Record the conflict with
  both round numbers in a `note:` and in the PR's Left open.
- Report what in the process costs you a round, such as judges reversing a fix, an issue
  no change can satisfy, a bar that looks out of reach or a gate that misfires, with
  `board feedback --about ui-climb`, citing the round files and fields. Then carry on.

## 4. Hand over

Hand over the champion, never a later round that scored lower.

1. `$UI status` names the champion. When it is main, no round beat main: say so in the
   last note and open no PR. When HEAD's design differs from the champion's, run the
   command status prints, which brings the champion's design back and commits it.
2. Unless the last round already ran every judge on that design, run
   `$UI round --all-judges` on the commit you hand over, so the owner sees every judge's
   score. Record its `score:` line.
3. `$UI report --out <file>` writes one self-contained HTML file. Publish it as a private
   Artifact: load that tool with ToolSearch `select:Artifact`. Attach the file's path only
   when ToolSearch cannot load it.
4. Push the branch and open a PR with the climb's commits, held as a draft as the
   `full-stop` skill says, so nothing merges it before the owner answers. Its body names the champion
   round and has the last `score:` line, the rounds table from `$UI status`, what changed and why, the conflicts left
   open, and the report link.
5. `ask_user` on the task (`Reason: design`): the result in one line with each judge's lowest score, the PR
   and the report, with the options Merge, Keep climbing (with notes), Discard. Set the
   task `blocked` until the answer. A design change merges only on the owner's word; on
   Merge, release the PR as the `full-stop` skill says.

## Costs and failures

- Each judge call carries every screenshot of main, the candidate and the references;
  `budgetUsd.call` caps one call, `round` a round and `run` everything in the run,
  calibration included. `$UI status` shows what is spent.
- Exit 2 means the command could not run (configuration, git, the app did not start, a
  main or control shot failed, or no reference captured): its message says what to do.
- Exit 4, a provisional pass, means every judge passed but a reference did not capture.
  Record the `score:` line, wait, and run `$UI round` again on the same commit. When the
  reference stays down, ask the owner (`ask_user`, `Reason: design`) whether to replace
  it or accept a pass without it (`pass.allReferences` false, with `--new-run`). Never
  hand a provisional pass over as a pass. The app's output
  is in `server.log` beside the round's screenshots. A judge that could not finish its
  calls also exits 2; the round is recorded as an error with its cost, and you run it
  again (its `score:` line still goes in a note).
- `--uncalibrated` runs a trial round that never passes; never hand one over.
- State lives in `${XDG_DATA_HOME:-~/.local/share}/claude-factory/ui/<name>/runs/<id>/`:
  screenshots per version, `rounds/round-N.json` with every judge's scores and issues,
  the champion it was judged against and whether it replaced it
  (the ledger reads them) and the fixes the judges were told are settled,
  `calibration.json` and the spending ledger.

## Feedback on this skill

Report it with `feedback` and `about` `ui-climb`. To review that feedback, read the
feedback board's items about `ui-climb` and the dotfiles tasks they were routed to, then
change this file and its pins in `claude/tests/config.test.js` through a dotfiles PR.
