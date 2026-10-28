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
| Agent tools | The relevant Codex or Claude Code installation. Review settings, permissions, and hooks before enabling them; the tracked hooks invoke `~/.atuin/bin/atuin`. |
| Tests | Bun, uv, and Python 3.11 or newer. Explore integration tests also need their documented command-line dependencies. |

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
in `~/.cache/tuios-fork` and installs it at `~/.local/opt/tuios-fork/tuios`.
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

To use the shared Git ignore file, configure its location explicitly:

```sh
git config --global core.excludesFile "$HOME/.config/git/ignore"
```

## Verification

From the repository root, run the focused local suites:

```sh
bun test nvim/tests/bun-outdated.test.js codex/tests/explorer.test.js
uv run --no-project --python 3.11 python -B -m unittest discover -s tuios/tests -v
uv run --no-project --python 3.11 python -B -m unittest discover -s ghostty -p 'test-*.py' -v
```

The machine-specific runtime-path check is skipped by default. Enable it with
`RUN_CODEX_RUNTIME_INTEGRATION=1` only when `~/.codex/agents/explorer.toml`
resolves to this checkout's role file. Live-agent cases are also skipped unless
explicitly enabled; inspect the suite before opting in.

With Explore's dependencies installed, its additional integration suite is:

```sh
uv run --no-project --python 3.11 python -B -m unittest discover -s explore/tests -v
```

These tests do not prove a fresh-machine installation or the live terminal flow.
Follow [Explore's end-to-end instructions](explore/README.md#tests) with a private
daemon and scratch directories when checking the complete picker workflow.
