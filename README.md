# Dotfiles

Personal configuration for a macOS development environment, stored in `~/.config`.
This repository tracks selected settings and scripts; many local application
directories, credentials, and runtime files are excluded by `.gitignore`.

## Contents

| Path                     | Purpose                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| `ghostty/`               | Ghostty settings, themes, and a TUIOS session launcher with tests.               |
| `tuios/`                 | TUIOS appearance, dock, sidebar, startup settings, and themes.                   |
| `explore/`               | Television popup explorer with shell and Neovim handoff, actions, and tests.     |
| `nvim/`                  | LazyVim-based Neovim configuration, language tooling, custom scripts, and tests. |
| `mpv/`                   | Playback settings, uosc controls, thumbfast thumbnails, and bundled assets.      |
| `codex/`                 | Agent instructions, example configuration, hooks, and keybindings.               |
| `claude/`                | Claude Code instructions, settings, and a headless-browser skill.                |
| `git/ignore`             | Shared Git ignore patterns.                                                      |
| `t3/`                    | T3 Code desktop host startup and remote connection instructions.                 |
| `AGENTS.md`, `CLAUDE.md` | Repository instructions for coding agents.                                       |

## Setup

Back up existing configuration before copying files into `~/.config`. Install
the applications you intend to use, then copy or symlink their directories from
this checkout. There is no repository-wide installer or complete dependency manifest.

The terminal setup assumes macOS, zsh, and this checkout at `~/.config`; paths
resolve from `$HOME`, so it works under any account. The Ghostty launcher runs
with Homebrew's `python3` when installed, otherwise the system `python3`.
`ghostty/tuios-launcher.py` runs `~/.local/bin/tuios`, which the fork installer
links to this repository's `tuios/bin/tuios` wrapper. The installer builds the
[`feat/divider-inset` branch of syz51/tuios](https://github.com/syz51/tuios/tree/feat/divider-inset)
in `~/.cache/tuios-fork` and installs it at `~/.local/opt/tuios-fork/tuios`.
To install or update:

```sh
GOMAXPROCS=4 GOFLAGS=-p=4 ~/.config/tuios/install-fork.sh
```

Add this at the end of `~/.zshrc` for Ghostty shell integration inside TUIOS:

```zsh
PROMPT_EOL_MARK=''

if [[ -n ${TUIOS_SESSION:-} ]]; then
  _tuios_zsh_integration="${GHOSTTY_RESOURCES_DIR:-/Applications/Ghostty.app/Contents/Resources/ghostty}/shell-integration/zsh/ghostty-integration"
  [[ -r $_tuios_zsh_integration ]] && source "$_tuios_zsh_integration"
  unset _tuios_zsh_integration
fi
```

The running daemon keeps its current build until restarted. Save pane work, then
run:

```sh
~/.local/bin/tuios restart-server
```

The command shows what it will stop and asks before restarting. A restart ends
the programs running in its panes and recreates the pane shells.

Neovim bootstraps lazy.nvim and installs the configured plugins on first launch,
which requires Git and network access. Language-specific features may require
additional tools; inspect `nvim/lazyvim.json` and `nvim/lua/plugins/` for the
enabled integrations.

`codex/config.example.toml` is a reference configuration. Review and adapt it
before creating a local `codex/config.toml`, which is intentionally ignored.
Review agent settings and hooks before enabling them on a new machine.

To use the shared Git ignore file, configure its location explicitly:

```sh
git config --global core.excludesFile "$HOME/.config/git/ignore"
```

## Terminal workflow

Ghostty launches TUIOS automatically. The launcher reuses the most recently active
detached session, creates a session when all existing sessions are attached, and
attempts to restore saved sessions when the daemon is stopped. A file lock
serializes session selection and attachment across simultaneous launches.

Ghostty and TUIOS use Catppuccin Frappe. TUIOS starts tiled in terminal mode, with
the dock at the bottom and the sidebar hidden. The leader key is `Ctrl+Space`;
follow it with `s` for the session switcher or uppercase `S` for scrollback.

Ghostty loads optional machine settings from `ghostty/config.local`, which Git
ignores. For example, set `font-size = 17.0` there to override the shared font size
on a smaller display.
