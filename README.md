# Dotfiles

Personal configuration for a macOS development environment, stored in `~/.config`.
The repository tracks selected application settings and scripts; local credentials,
runtime data, and machine overrides stay outside the tracked configuration.

See [SETUP.md](SETUP.md) for prerequisites, installation, shell integration,
terminal behavior, and verification commands. Adopt only the components you need;
there is no repository-wide installer.

## Contents

| Path                     | Purpose                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| `shell/`                 | Zsh startup installer, cached init scripts and completions, with tests.          |
| `ghostty/`               | Ghostty settings, themes, and a TUIOS session launcher with tests.               |
| `tuios/`                 | TUIOS appearance, dock, sidebar, startup settings, and themes.                   |
| `explore/`               | Television popup explorer with shell and Neovim handoff, actions, and tests.     |
| `nvim/`                  | LazyVim-based Neovim configuration, language tooling, custom scripts, and tests. |
| `mpv/`                   | Playback settings, uosc controls, thumbfast thumbnails, and bundled assets.      |
| `codex/`                 | Example Codex configuration, hooks, and keybindings.                             |
| `claude/`                | Claude Code instructions, subagents, settings, Bash guards, and six skills.      |
| `claude/factory/`        | Metrics, scoring, proposals, benchmarks, audit and friction capture for the setup. |
| `t3code/`                | A T3 Code routine that settles idle subagent threads and prunes finished branches. |
| `disk-alert/`            | A LaunchAgent that alerts through T3 Code and macOS when free disk space runs low. |
| `config-sync/`           | A LaunchAgent that fast-forwards each Mac's checkout to main and reports blockers. |
| `git/`                   | Shared Git ignore patterns, and settings that `~/.gitconfig` includes.           |
| `setups.toml`            | Every setup on both Macs, with its owner, for routing agents' friction reports.  |
| `CLAUDE.md`              | Repository instructions for Claude Code.                                         |

Original contributions are [MIT licensed](LICENSE). Bundled and adapted code
retains its upstream terms; see [third-party notices](THIRD_PARTY_NOTICES.md).
