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
| `ghostty/`               | Ghostty settings, themes, and a TUIOS session launcher with tests.               |
| `tuios/`                 | TUIOS appearance, dock, sidebar, startup settings, and themes.                   |
| `explore/`               | Television popup explorer with shell and Neovim handoff, actions, and tests.     |
| `nvim/`                  | LazyVim-based Neovim configuration, language tooling, custom scripts, and tests. |
| `mpv/`                   | Playback settings, uosc controls, thumbfast thumbnails, and bundled assets.      |
| `codex/`                 | Agent instructions, example configuration, hooks, and keybindings.               |
| `claude/`                | Claude Code instructions, settings, and a headless-browser skill.                |
| `git/ignore`             | Shared Git ignore patterns.                                                      |
| `AGENTS.md`, `CLAUDE.md` | Repository instructions for coding agents.                                       |

Original contributions are [MIT licensed](LICENSE). Bundled and adapted code
retains its upstream terms; see [third-party notices](THIRD_PARTY_NOTICES.md).
