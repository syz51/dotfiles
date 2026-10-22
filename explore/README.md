# Explore

`Ctrl+Space`, then `f`, opens a Television file picker in a TUIOS popup.
It uses its own channel, palette, configuration, and temporary data; ordinary
`tv` keeps its existing configuration.

At a zsh prompt, the selection becomes a quoted command in that shell's history:
files run `nvim -- …`, a folder runs `cd -- …`, and Ctrl-O on a folder runs
`cd -- … && nvim`. An unfinished command line returns at the next prompt.
In an existing Neovim, files open through RPC and folders change its cwd.
Modified buffers remain available; destructive `bufhidden` settings cause a
split to keep the original buffer displayed. In another program, a new pane
opens Neovim in the file's folder, or a shell in the selected folder. Ctrl-O on
a folder opens Neovim there.

| Key | Action |
| --- | --- |
| Enter | Pick the highlighted item or marked files |
| Ctrl-O | Pick; open a folder in Neovim from a shell or another program |
| Right / Left | Enter a folder / go to its parent inside the popup |
| Tab | Mark an item and advance |
| Ctrl-X | Copy paths, rename, move, or trash; applies to marks or the highlighted item |
| Esc | Cancel; Esc in the action menu returns to the explorer |

Rename, move, and `/usr/bin/trash` require typing `yes`. Existing destinations
are preserved. Copy paths writes absolute paths, one per line, to `pbcopy`.
Several marked files open together; a folder must be selected alone.
Mark order is unspecified by Television.

Rows stream as they are found: up to six zoxide places only in the starting
folder, then its sorted folders and files (including hidden entries), then up
to 20,000 descendants from `fd`, at most 12 levels deep. `.git`, `Library`, and `node_modules` are
excluded; ignore files do not hide descendants. Previews cap file input at
32 KiB / 120 lines, escape terminal controls, and suppress binary content.
`bat` is optional.

## Install

Requires macOS, zsh, Neovim with RPC and `-l` support, and TUIOS with
`popup --capture-stdout`, command keys, and `send-keys --literal`. The screen
behind the popup dims only with the TUIOS fork; install it with
`../tuios/install-fork.sh`.
Validated with Television 0.15.9 and Neovim 0.12.6.

```sh
brew install television fd zoxide
```

Place this folder at `~/.config/explore`, then add this line once at the end
of `~/.zshrc`:

```zsh
[[ -r "$HOME/.config/explore/explore.zsh" ]] && source "$HOME/.config/explore/explore.zsh"
```

The file initializes zoxide when installed and adds one private ZLE binding.
It preserves the prompt and existing history bindings. Start a fresh shell,
or source that line in an existing shell.

Add the unbinding to the **existing** prefix table in `tuios/config.toml`,
then add the command entry:

```toml
[keybindings.prefix_mode]
prefix_file_search = []

[[keybindings.command]]
key = "prefix+f"
type = "shell"
command = '"$HOME/.config/explore/bin/explore-key"'
description = "Explore"
```

Run `tuios keybinds doctor` and `tuios keybinds explain f --json`.
The latter must show `command:explore`, `press: "ctrl+space f"`, and
`shadowed: false`. Healthy custom commands are absent from doctor's problem list.
TUIOS watches its configuration. `appearance.popup_dim = 30` supplies the backdrop.

## Transport and safety

`bin/explore-key` matches `TUIOS_ACTIVE_PANE_ID` against `list-windows` and
checks the terminal's kernel foreground process group. It hands off to ZLE
only when that pane's own zsh has a ready marker. `send-keys --literal`
delivers the private bytes `ESC [ 9 9 ~`; ZLE interprets them as one widget.
Hooks remove the marker before executing a command. Other programs never
receive a shell command. The popup's reserved name is `explore`.

For Neovim, socket discovery verifies the server's PID through RPC and accepts
its foreground client or a unique descendant server. It rechecks the foreground
client and ancestry before editing. Paths are JSON data, then passed through
`fnameescape`/structured Neovim commands, independently of input mode.
An unavailable or changed editor uses a new pane.

The picker protocol is **raw NUL-separated fields**:

```text
EXPLORE1 NUL (open|nvim) NUL absolute-path NUL [absolute-path NUL ...]
```

Cancellation emits no bytes and returns 130. Filenames may contain spaces,
tabs, quotes, shell metacharacters, leading dashes, and Unicode; newline names
are excluded. Callers never evaluate the protocol as code. Television sees
opaque generation/row IDs in OSC-8 metadata and sanitized labels. Only those
IDs enter shell action templates; a private append-only manifest resolves paths.
Each path is recorded before its row appears, so previews and picks work
during scans.
Actions write an atomic result file. The outer launcher emits the protocol
after the execute/relaunch chain ends, preserving popup capture across navigation.
Each invocation removes its own temporary session and Television data.

The `terminal` palette uses ANSI names and no overall background. Television
0.15.9 requires a highlighted-row background; this uses ANSI `bright-black`. Its external
actions require a matching row: if a query has zero matches, clear it with
Ctrl-U before Left or Ctrl-X. An empty folder provides a self row so Left works.

## Tests

From the repository root, run:

```sh
uv run --no-project python -B -m unittest discover -s explore/tests -v
```

The tests use isolated fixtures, zoxide/XDG data, real zsh argument parsing,
headless Neovim RPC, and a real Neovim TUI in a controlled PTY. They do not
contact a TUIOS daemon. Streaming coverage gates a scan and resolves the rows
already shown; header coverage checks home abbreviation and terminal escaping.

For an end-to-end check, use a uniquely named TUIOS daemon (`--server NAME`)
with private `XDG_RUNTIME_DIR`, XDG data/state/config directories, `ZDOTDIR`,
and `_ZO_DATA_DIR` under one scratch directory. Keep the runtime path short
enough for macOS Unix sockets. Copy the TUIOS configuration; have the scratch
`.zshrc` source this checkout's `explore.zsh`. Attach a client in a sized PTY
(for example 160×48), send Ctrl-Space then `f` through that client, and inspect
the popup with `capture-pane`. In a tree with thousands of files, verify early
rows and a `~/…/` header, then pick an early row and check shell cwd/history.
If driving the prefix through `send-keys`, run that call asynchronously while
driving the popup: the command key waits for the picker to exit. Stop only the
named daemon and remove its saved state, PTY processes, and scratch data.
