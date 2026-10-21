---
name: headless-browser
description: Screenshot and check web pages in a local headless Chromium. Use it to see a page you built or changed, a dev server, a static HTML file or a public URL; to click, type or press keys first and capture each state; or to collect console errors, page exceptions and failed requests. Use it when the in-app preview cannot take screenshots or is unavailable, or when you need repeatable captures from a script.
---

# Headless browser

`scripts/browse.ts` opens a page in headless Chromium, runs steps in the order
given, saves PNG screenshots and prints one JSON report. Read each PNG with the
Read tool to see it.

## Run

```sh
B=~/.claude/skills/headless-browser/scripts/browse.ts
bun $B localhost:5173
bun $B localhost:5173/settings --width 390 --height 844 --full
bun $B https://example.com --scheme dark --element 'main'
bun $B localhost:4173/1 --click '#scene-1' --wait 200 --shot --press ArrowRight --shot
bun $B localhost:3000 --fill 'input[name=q]=tuios' --press Enter --wait-for '.results' --full
bun $B localhost:3000 --eval 'document.querySelectorAll("img:not([alt])").length'
bun $B file:///abs/path/page.html --strict
```

`bun $B --help` lists every option. Steps are `--click`, `--hover`,
`--fill SEL=TEXT`, `--press`, `--scroll`, `--wait MS`, `--wait-for SEL`,
`--goto`, `--eval JS`, `--shot`, `--full` and `--element SEL`. Each screenshot
step takes an optional output path. Without a screenshot step, one viewport
shot is taken at the end.

The report has `url`, `title`, `status`, `screenshots`, `evals`, `pageErrors`,
`consoleErrors`, `consoleWarnings`, `failedRequests` and `error`. Check the
error fields even when the screenshot looks right. The exit code is 1 when a
navigation or step failed, or with `--strict` when the page threw or logged an
error. It is 3 when Playwright is not installed.

## Setup

When the script exits 3, or after Playwright's browser cache was cleared, run
`sh ~/.claude/skills/headless-browser/scripts/setup.sh`. It installs the pinned
package from `bun.lock` and the matching `chromium-headless-shell` into
Playwright's cache (`~/Library/Caches/ms-playwright`), and is safe to repeat.
Do not delete that cache or the skill's `node_modules` during task cleanup:
they are this tool's installation, not task files.

## Habits

- Take a screenshot after a click or key press only once the change has
  settled: add `--wait 150` to `--wait 300` after the step when the page
  animates, or `--wait-for` when it loads something.
- Capture the target element with `--element` when the surrounding page is
  noise. Use `--full` for long pages, and `--width 390` for phone layouts.
- Fixed and sticky elements such as headers and floating buttons appear in
  element and full-page shots at their current viewport position.
- Use `--scheme dark` and `--scheme light` to check both themes, and
  `--reduced-motion` for motion-sensitive pages.
- Screenshots default to `$TMPDIR/headless-browser/`. Delete the ones you made
  when the task is done (`rm -rf "$TMPDIR/headless-browser"`), unless the user
  wants to keep them. Save shots meant for the user elsewhere with an explicit
  path.
- Pages served by a dev server need it running first. Start it in the
  background, and stop it afterwards if you started it.
