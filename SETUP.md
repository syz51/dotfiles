# Setup

These dotfiles target macOS and zsh. The terminal scripts expect their directories
at `~/.config`, even when copied from a checkout elsewhere. Install only the
applications you intend to use.

## Install selected configuration

Back up each existing application directory before replacing it. Keep the backup
outside this checkout and check that your chosen backup destination does not
already exist. Copy or symlink individual directories into `~/.config`; do not
replace an existing `~/.config` wholesale. Review scripts before running them.
There is no repository-wide installer or complete dependency manifest.

| Component | Prerequisites |
| --- | --- |
| Terminal | Ghostty, zsh, Git, Go for building the TUIOS fork, and Python for the launcher. The configured `drag-handle` setting requires a Ghostty development build. |
| Dock machine label | uv at `~/.local/bin/uv` and an installed Python 3.11 or newer usable by uv offline. |
| Explore | The TUIOS fork, Neovim with RPC and `-l` support, Television, fd, and zoxide. See [Explore installation](explore/README.md#install). |
| Neovim | Git and network access for lazy.nvim/plugin bootstrap; additional language tools for enabled integrations. The TeX workflow uses Tectonic and Skim on macOS. |
| mpv | mpv; the uosc and thumbfast scripts and their bundled assets are included. |
| Agent tools | Claude Code, and Codex only if you use its example configuration. Review settings, permissions, and hooks before enabling them; the tracked hooks invoke `~/.atuin/bin/atuin` and `~/.bun/bin/bun`. |
| Tests | Bun, uv, and Python 3.11 or newer. Explore integration tests also need their documented command-line dependencies. |

## Keep both Macs in sync

Use `main` from `git@github.com:syz51/dotfiles.git` on both Macs. Before editing,
check for local changes, then update a clean checkout:

```sh
cd ~/.config
git status --short --branch
git pull --ff-only origin main
```

Commit shared changes and push them with `git push origin main` before switching
Macs. If both Macs have new commits, commit any unfinished work, fetch with
`git fetch origin`, then combine the histories with `git merge origin/main`.
Resolve any conflicts and run the verification checks below before pushing.
The other Mac can then update with the fast-forward command above.

Keep credentials and machine-specific settings in ignored local files, including
`ghostty/config.local` and `codex/config.toml`; Git does not synchronize them.
Installed applications and the separately built TUIOS fork also need to be
installed or updated on each Mac using the instructions below.

## Terminal and dock

The Ghostty launcher uses `/opt/homebrew/bin/python3` when available, otherwise
`/usr/bin/python3`. It runs `~/.local/bin/tuios`, which the fork installer links
to this repository's `tuios/bin/tuios` wrapper.

The dock invokes **exactly** `~/.local/bin/uv` with `--offline`; merely having a
Homebrew uv on `PATH` does not satisfy that command. Install uv and a compatible
Python before starting TUIOS. For example, with Homebrew uv already installed:

```sh
mkdir -p "$HOME/.local/bin"
if [ ! -e "$HOME/.local/bin/uv" ] && [ ! -L "$HOME/.local/bin/uv" ]; then
  ln -s "$(command -v uv)" "$HOME/.local/bin/uv"
fi
"$HOME/.local/bin/uv" python install 3.11
"$HOME/.local/bin/uv" run --offline --no-project --python 3.11 python --version
```

If the path already exists, inspect it rather than replacing it. The Python
installation step needs network access. A missing compatible interpreter cannot
be downloaded by the dock's offline command.

The TUIOS installer builds the
[`feat/divider-inset` branch of syz51/tuios](https://github.com/syz51/tuios/tree/feat/divider-inset)
in `${XDG_DATA_HOME:-$HOME/.local/share}/tuios-fork` and installs it at
`~/.local/opt/tuios-fork/tuios`. It moves an existing checkout from
`${XDG_CACHE_HOME:-$HOME/.cache}/tuios-fork` to the new location automatically.
Updates preserve local commits and require a clean checkout; divergent fork
history needs an explicit merge in that checkout before rerunning the installer.
It installs Go through Homebrew if Go is missing. To install or update:

```sh
GOMAXPROCS=4 GOFLAGS=-p=4 ~/.config/tuios/install-fork.sh
```

Before installing, move any existing regular file at `~/.local/bin/tuios` to a
unique backup location yourself: the installer otherwise uses `tuios.bak`, which
can replace an older backup.

Add this at the end of `~/.zshrc` for Ghostty shell integration inside TUIOS:

```zsh
PROMPT_EOL_MARK=''

if [[ -n ${TUIOS_SESSION:-} ]]; then
  _tuios_zsh_integration="${GHOSTTY_RESOURCES_DIR:-/Applications/Ghostty.app/Contents/Resources/ghostty}/shell-integration/zsh/ghostty-integration"
  [[ -r $_tuios_zsh_integration ]] && source "$_tuios_zsh_integration"
  unset _tuios_zsh_integration
fi
```

For Explore's shell handoff, also add this once to `~/.zshrc`:

```zsh
[[ -r "$HOME/.config/explore/explore.zsh" ]] && source "$HOME/.config/explore/explore.zsh"
```

Follow the [Explore installation and checks](explore/README.md#install) for the
picker dependencies and optional patched Television build. The tracked TUIOS
configuration already includes its keybinding; avoid adding duplicate entries.

The running daemon keeps its current build until restarted. Save pane work, then
run:

```sh
~/.local/bin/tuios restart-server
```

The command shows what it will stop and asks before restarting. A restart ends
the programs running in its panes and recreates the pane shells.

Ghostty launches TUIOS automatically. The launcher reuses the most recently active
detached session, creates one when all existing sessions are attached, and
attempts to restore saved sessions when the daemon is stopped. A file lock
serializes session selection and attachment across simultaneous launches.

Ghostty and TUIOS use Catppuccin Frappe. TUIOS starts tiled in terminal mode, with
the dock at the bottom and sidebar hidden. The leader key is `Ctrl+Space`;
follow it with `s` for the session switcher, uppercase `S` for scrollback, or
`f` for Explore.

Ghostty loads optional machine settings from `ghostty/config.local`, which Git
ignores. For example, put `font-size = 17.0` there to override the shared size.

## Shell startup

For the existing shell configuration on this Mac, review and apply the targeted
startup changes with:

```sh
uv run --no-project ~/.config/shell/apply-startup-fixes.py
uv run --no-project ~/.config/shell/apply-startup-fixes.py --apply
```

The installer checks the expected configuration and shell syntax before writing,
keeps private backups beside `~/.zshrc` and `~/.bashrc`, and leaves an already
updated configuration alone. Restore those backups to undo the changes.

Zsh initializes completions once, after adding `~/.zsh/functions`. Generated uv
and uvx completions are cached in
`${XDG_CACHE_HOME:-$HOME/.cache}/shell-completions` and refreshed when the resolved
executable or its metadata changes. An unusable cache falls back to live
generation. fnm keeps its directory-change hook, with zsh selected explicitly;
bash loads Atuin's PATH setup before its initialization. Open a new shell after
applying.

## Neovim and optional tools

Neovim bootstraps lazy.nvim and installs configured plugins on first launch,
requiring Git and network access. Inspect `nvim/lazyvim.json` and
`nvim/lua/plugins/` for language integrations. For TeX, install Tectonic and Skim;
the macOS annotation protection also uses the system `osascript` and PDFKit.

`codex/config.example.toml` is a reference configuration. Review and adapt it
before creating a local `codex/config.toml`, which is intentionally ignored.
Codex expects its configuration under `~/.codex`; review your existing files
before linking that location to `~/.config/codex`. Claude Code likewise needs
its files at the location expected by your installation (normally `~/.claude`).
Do not replace an existing tool home without backing up its local data.

The skills named in `claude/CLAUDE.md` are maintained separately from dotfiles.
Install the needed skills and their references from
[syz51/skills](https://github.com/syz51/skills#install-skills), for example with
`bunx skills add syz51/skills`, selecting the agents you use. Claude Code
discovers personal skills under `~/.claude/skills`; see
[Extend Claude with skills](https://code.claude.com/docs/en/skills).

On the two managed Macs, preserve the existing source checkout at
`~/.local/share/codex-skills/repository` and discovery links through
`~/.local/share/codex-skills/current/skills/<skill>`. Update the managed source
rather than editing installed releases. Dotfiles alone does not install skills,
configure feedback capture, or create the daily maintenance and audit jobs;
those are configured separately through the managed skills workflow. Keep
machine-specific links, credentials and job state outside this repository.

To use the shared Git ignore file, configure its location explicitly:

```sh
git config --global core.excludesFile "$HOME/.config/git/ignore"
```

## Factory

`claude/factory/` measures and improves this Claude Code setup. It reads the session
transcripts under `~/.claude/projects` and keeps its reports, scores, benchmark results
and proposal records in `${XDG_DATA_HOME:-~/.local/share}/claude-factory/`, never in this
repository. Commands that call a model state a budget and stay within it.

```sh
bun ~/.claude/factory/cli.js metrics            # last 7 days vs the week before
bun ~/.claude/factory/cli.js audit --with-tests # security posture of this setup
bun ~/.claude/factory/cli.js score --dry-run    # sessions the judge would score
bun ~/.claude/factory/cli.js propose --list     # repeated failures that qualify
bun ~/.claude/factory/cli.js bench list         # benchmark cases
bun ~/.claude/factory/cli.js weekly run --no-pr # the whole loop once, no PRs
```

`weekly install` loads a LaunchAgent that runs the loop on Mondays at 13:30: metrics,
audit, scoring (judge budget $3) and proposals. Proposals open draft PRs on this
repository only for the deterministic detector dimensions, and their bodies hold session
ids, not transcript text, because the repository is public. `weekly status` shows the
last run; `weekly uninstall` removes the job. The living task list is
[`claude/factory/PLAN.md`](claude/factory/PLAN.md).

### Billing: API first, subscription as fallback

Unattended print-mode runs (`claude -p`) go through `~/.claude/bin/claude-api`: the
factory by default (`CLAUDE_FACTORY_BIN` overrides) and the live suites
(`CLAUDE_LIVE_BIN` overrides). It bills the Anthropic API while the account has credit
and falls back to the claude.ai subscription otherwise. The planner,
`claude/bin/api-first.js`, documents the details; in short:

- The key file is `API_FIRST_KEY_FILE`, default
  `~/.local/share/codex-skills/anthropic-api-key` (mode 600, shared with the codex-skills
  pipeline). Claude Code gets it through an `apiKeyHelper` merged into the run's last
  `--settings`, so it is not in the environment, where an `env` dump would expose it by
  accident. It is not hidden from the agent: a session running as you can read the file.
- A one-token Haiku request checks for credit that Claude Code can spend: it carries
  Claude Code's beta, because credit that plain API calls can use may still be refused to
  Claude Code. The answer is cached per key and kind of check in
  `~/.local/state/claude-api/` (10 minutes while the API works, 30 once credit is out or
  the key is refused, 1 when the check is inconclusive). Without a key file or credit, runs
  use the subscription and say so on stderr. Every decision goes to `decisions.jsonl` there,
  and the weekly summary counts them.
- Runs that are not print mode, or that set `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or
  `ANTHROPIC_BASE_URL` themselves, pass through untouched. The script replaces itself with
  the real claude, so killing the process a caller started kills claude.
- For scripts that call `claude` by name, put `~/.claude/bin/api-first` first on `PATH` for
  that run only, never in a login profile. A nesting limit stops a loop.

## T3 Code subagent cleanup

T3 Code settles only the thread you settle, not its subagent children, so they stay
unsettled until something settles each one. `t3code/settle_children.py` lists the subagent
threads that a cascade would settle: idle children whose parent or root is settled or
archived, with no active run on themselves, their parent or their root, no unfinished
spawning run, no pending request and no explicit unsettle. It opens the T3 state
database read-only; settling goes through T3's own `t3_thread_organize` tool.

A T3 scheduled task in the `.config` project runs every 6 hours with this prompt:

```text
Run the routine in ~/.config/t3code/settle-children.prompt.md exactly as written.
```

Each run plans, settles, verifies and then settles its own thread when nothing failed.
`~/.local/state/t3-settle-children/settle.jsonl` gets one line per plan and verify,
with the thread ids. Edit the prompt file to change the routine. Change the interval,
pause or delete the task in T3's scheduled tasks, or ask an agent to call
`schedule_task` with `enabled: false` or `delete_scheduled_task`. Run the finder by
hand to see what the next run would settle:

```sh
uv run --no-project --python 3.11 python -B ~/.config/t3code/settle_children.py
```

## Verification

From the repository root, run the focused local suites:

```sh
bun test nvim/tests/bun-outdated.test.js claude/hooks claude/tests claude/factory
uv run --no-project --python 3.11 python -B -m unittest discover -s tuios/tests -v
uv run --no-project --python 3.11 python -B ghostty/test-tuios-launcher.py -v
uv run --no-project python -B shell/test-startup-fixes.py -v
uv run --no-project --python 3.11 python -B -m unittest discover -s t3code/tests -v
```

The `claude/tests` suites check the Claude Code configuration. These run offline and
in CI:

- `config.test.js`: agent frontmatter against the delegation policy, files and agents
  that `claude/CLAUDE.md` references, hook scripts in `claude/settings.json`, the rules
  the live suites test, and the root `CLAUDE.md`.
- `lib/*.test.js`: the live harness's helpers on small synthetic traces: stream-json
  evidence, Bash check attribution, guidance reads, filesystem snapshots, the process
  runner, two-message conversations, session cleanup, reports and language detection.
- `harness.test.js`: live scenarios run against a fake `claude` in a synthetic home.
  Failed, malformed, incomplete and timed-out sessions fail but still clean up. A
  check that tampers with the fixture when re-run fails, and so do a single-track task
  handed to a subagent and a forbidden guidance read in a subagent. Configuration drift fails
  too, as does a claimed but unsaved artifact or an unwritable report. So do a review
  the main session runs itself and a follow-up answered only after the background review.

The live suites run real `claude -p` sessions against the installed `~/.claude`, using
account quota. Each runs in a fresh fixture folder under one temporary root, blocks
package installs and web access, and removes its folders and session entries
afterwards. Every session passes an explicit `--model` and `--effort`. Behavioral
scenarios use `claude-opus-5-5` at the effort `claude/settings.json` configures for it
(`high`), because skill and tool choices at lower effort don't reflect real sessions;
override with `CLAUDE_LIVE_MODEL` and `CLAUDE_LIVE_EFFORT`. Configuration checks use
`claude-haiku-5-5`. Each suite prints its sessions' cost and its total. A full run
costs about $5.80 and takes about 10 minutes:

```sh
RUN_CLAUDE_LIVE=1 bun test claude/tests
```

- `live.test.js`: a session in `nvim/` loads the global and repository instructions
  and lists the agents and skills. Explorer, worker and solver run on their configured
  model and effort (worker checks run the main session at `xhigh`, above the worker),
  the worker edits only its authorized files, a worker isolated in a worktree starts
  from the local `HEAD` and receives the main checkout's uncommitted input while the
  checkout stays untouched, and two explorers run in parallel in the shared checkout.
  Two parallel tracks go to one worker each, in its own worktree: each worker finds its
  module's bug, fixes it, updates and runs the module's check, and gets the code only
  the conversation held. The main session neither investigates nor edits a module
  before its track returns, then brings both back, removes the worktrees and their
  branches, and runs the checks itself. Each check prints its own directory when it
  passes, so the session's output shows that the copy in the checkout, not a
  worktree's, passed. A high-impact commit's review runs `/code-review xhigh`, pinned to
  the commit's SHA, in one background agent on the session's model in a worktree. A
  follow-up sent as soon as the first turn ends is answered while the review runs, and
  the review still finishes, reaches the reply and leaves the checkout, remote and
  worktrees as they were. The guard hook blocks a force push to `main`.
- `live-dispatch.test.js`: the Skills section's routing. TypeScript, Rust, Tauri,
  TSX, Vue, chart, built-page, skill-search and article tasks load their skills in
  order, and an Effect review reads only its routed reference. A README fix in a
  TypeScript and Rust repository loads no skill, and the article run saves its draft.
- `live-policy.test.js`: Python checks run through `uv run`, and JavaScript uses
  `bun` unless the project's lockfile names another tool. Fixes are re-checked
  independently, reviews stay read-only, and these single-track tasks, one of them a
  rename across several files whose check proves from its own output that it passed
  in the fixture, spawn no subagent. A Japanese draft is followed by its Chinese meaning, while JSON-only and Chinese-only
  replies stay as asked.

`claude/factory` tests run offline against synthetic transcripts and fake `claude`,
`gh` and `launchctl` programs. Its live sandbox check runs real Haiku sessions (about
$0.01) and verifies that the strict profile blocks writes outside the working folder and
unlisted hosts:

```sh
RUN_CLAUDE_LIVE=1 bun test claude/factory/audit
```

Set `CLAUDE_LIVE_REPORT_DIR` to a folder inside `$TMPDIR` to keep a JSON report and
the raw stream of each scenario; the report lists each tool call with the directory it
started in, which the stream lacks. Delete the folder when done: it holds transcripts.

With Explore's dependencies installed, its additional integration suite is:

```sh
uv run --no-project --python 3.11 python -B -m unittest discover -s explore/tests -v
```

These tests do not prove a fresh-machine installation or the live terminal flow.
Follow [Explore's end-to-end instructions](explore/README.md#tests) with a private
daemon and scratch directories when checking the complete picker workflow.
