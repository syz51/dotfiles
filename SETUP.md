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

## Verification

From the repository root, run the focused local suites:

```sh
bun test nvim/tests/bun-outdated.test.js claude/hooks claude/tests
uv run --no-project --python 3.11 python -B -m unittest discover -s tuios/tests -v
uv run --no-project --python 3.11 python -B -m unittest discover -s ghostty -p 'test-*.py' -v
uv run --no-project python -B shell/test-startup-fixes.py -v
```

The `claude/tests` suites check the Claude Code configuration. These run offline and
in CI:

- `config.test.js`: agent frontmatter against the delegation policy, files and agents
  that `claude/CLAUDE.md` references, hook scripts in `claude/settings.json`, the rules
  the live suites test, and the root `CLAUDE.md`.
- `lib/*.test.js`: the live harness's helpers on small synthetic traces: stream-json
  evidence, Bash check attribution, guidance reads, filesystem snapshots, the process
  runner, session cleanup, reports and language detection.
- `harness.test.js`: live scenarios run against a fake `claude` in a synthetic home.
  Failed, malformed, incomplete and timed-out sessions fail but still clean up. A
  check that tampers with the fixture when re-run fails, and so does a forbidden
  guidance read in a subagent. Configuration drift fails too, as does a claimed but
  unsaved artifact or an unwritable report.

The live suites run real `claude -p` sessions against the installed `~/.claude`, using
account quota. Each runs in a fresh fixture folder under one temporary root, blocks
package installs and web access, and removes its folders and session entries
afterwards. Every session passes an explicit `--model` and `--effort`. Behavioral
scenarios use `claude-opus-5-5` at the effort `claude/settings.json` configures for it
(`high`), because skill and tool choices at lower effort don't reflect real sessions;
override with `CLAUDE_LIVE_MODEL` and `CLAUDE_LIVE_EFFORT`. Configuration checks use
`claude-haiku-5-5`. Each suite prints its sessions' cost and its total. A full run
costs about $3 to $4 and takes about 5 minutes:

```sh
RUN_CLAUDE_LIVE=1 bun test claude/tests
```

- `live.test.js`: a session in `nvim/` loads the global and repository instructions
  and lists the agents and skills. Explorer, worker and solver run on their configured
  model and effort, the worker edits only its authorized files, a worker isolated in a
  worktree receives the main checkout's uncommitted input, and two explorers run in
  parallel. The guard hook blocks a force push to `main`.
- `live-dispatch.test.js`: the Skills section's routing. TypeScript, Rust, Tauri,
  TSX, Vue, chart, built-page, skill-search and article tasks load their skills in
  order, and an Effect review reads only its routed reference. A README fix in a
  TypeScript and Rust repository loads no skill, and the article run saves its draft.
- `live-policy.test.js`: Python checks run through `uv run`, and JavaScript uses
  `bun` unless the project's lockfile names another tool. Fixes are re-checked
  independently, reviews stay read-only, and these small tasks spawn no subagent. A Japanese draft is followed by its
  Chinese meaning, while JSON-only and Chinese-only replies stay as asked.

Set `CLAUDE_LIVE_REPORT_DIR` to a folder inside `$TMPDIR` to keep a JSON report and
the raw stream of each scenario; delete it when done.

With Explore's dependencies installed, its additional integration suite is:

```sh
uv run --no-project --python 3.11 python -B -m unittest discover -s explore/tests -v
```

These tests do not prove a fresh-machine installation or the live terminal flow.
Follow [Explore's end-to-end instructions](explore/README.md#tests) with a private
daemon and scratch directories when checking the complete picker workflow.
