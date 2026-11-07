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
| Agent tools | Claude Code, and Codex only if you use its example configuration. Review settings, permissions, and hooks before enabling them; the tracked hooks invoke `~/.atuin/bin/atuin`, `~/.bun/bin/bun` and, through `claude/hooks/board-hook.sh` when installed, `~/.cargo/bin/board` (see [Work board](#work-board)). |
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

The `com.syz51.config-sync` LaunchAgent does that update every 30 minutes on each Mac,
so a merge reaches both within the hour. `config-sync/config_sync.py check` fetches
`origin/main` and fast-forwards the checkout only when it is on `main` with no tracked
changes and no commits of its own; it never stashes, resets or merges. Otherwise it
leaves the checkout as it is and files one Feedback report about `config-sync` per
distinct set of problems: off `main`, tracked changes, diverged, a fast-forward that
failed (an untracked file in the way, say), a fetch failing for over 24 hours, or an
instruction link (`~/.claude`, Codex's `AGENTS.md`) that is a copy or missing. It uses
plain `board feedback` where the installed CLI lacks `--about`, and a macOS notification
when the board is unreachable. State is in `~/.local/state/config-sync/state.json`, each
pull or report adds a line to `events.jsonl` there, and launchd writes to `launchd.log`.
Install it on each Mac and check it:

```sh
uv run --no-project --python 3.11 python -B ~/.config/config-sync/config_sync.py install
uv run --no-project --python 3.11 python -B ~/.config/config-sync/config_sync.py status
```

`install --dry-run` prints the plist, and `uninstall` unloads and removes it.

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

Review and apply the targeted startup changes to `~/.zshrc` and `~/.bashrc` with:

```sh
uv run --no-project ~/.config/shell/apply-startup-fixes.py
uv run --no-project ~/.config/shell/apply-startup-fixes.py --apply
```

The installer checks the expected configuration and shell syntax before writing,
keeps private backups beside `~/.zshrc` and `~/.bashrc`, and leaves an already
updated configuration alone. Restore those backups to undo the changes. Each step
recognizes its own earlier result, so the installer works on both Macs' layouts:

- `eval "$(atuin init zsh)"` becomes `source "$HOME/.config/shell/interactive.zsh"`,
  which drops repeated `PATH` and `fpath` entries (the first one wins, as in command
  lookup) and loads Atuin's init script from a cache. In Claude Code's Bash tool
  (`CLAUDECODE` set) it also turns off `nomatch`, so an unmatched glob such as
  `--include=*.md` reaches the command as written, as in bash, instead of failing
  the whole command line.
- The uv and uvx completions load through `shell/completions.zsh`, right after Oh My
  Zsh runs `compinit`, for whichever of the two is on `PATH` there. Zsh initializes
  completions once, after adding `~/.zsh/functions` where that directory was set up;
  the installer refuses a configuration that runs `compinit` again elsewhere, which
  would drop those completions.
- fnm keeps its directory-change hook, with zsh selected explicitly; bash loads
  Atuin's PATH setup before its initialization.

`shell/cache.zsh` keeps the output of these static init commands in
`${XDG_CACHE_HOME:-$HOME/.cache}/shell-cache`, private to you, and regenerates an
entry when the resolved executable, its arguments, a configuration file it reads
or a setting it bakes in changes: Atuin's `config.toml` (in `$ATUIN_CONFIG_DIR`,
`${ATUIN_HOME:-~/.atuin}` or `~/.config/atuin`) and `ATUIN_*` variables, and zoxide's
`_ZO_*` variables, for the zoxide init in `explore/explore.zsh`. With Atuin's
`[dotfiles]` enabled, its init also prints synced aliases, so it runs live. The
cached output is sourced at the top level, exactly as `eval` ran it. An unusable
cache falls back to live generation; an empty or truncated entry is regenerated. The uv and uvx completions are autoloaded
from that cache, so zsh reads their large definitions on the first completion
instead of at every startup. Open a new shell after applying.

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
Link the whole `claude/hooks` directory, not single scripts: the Bash guards import
`claude/hooks/shell.js`, and a guard that cannot load it fails open. The guards see
only Bash tool calls, so `claude/settings.json` sets `disableSkillShellExecution`: a
`` !`command` `` line in a user, project or plugin skill or custom slash command is
replaced with a placeholder instead of running unchecked before the model reads it.
guard-git-push blocks a push whose subcommand, refspec, remote or option name comes from
a variable, command substitution or brace expansion, and one that sets push
configuration with `git -c` or an earlier `git config`. It checks a push without
refspecs against the push remote's `remote.<name>.push` and `remote.<name>.mirror`. It
cannot see git aliases or `GIT_CONFIG_*` variables.
`claude/settings.json` cuts worktrees from the local HEAD (`worktree.baseRef` `head`) so
they keep unpushed commits. Before EnterWorktree or an Agent call with worktree
isolation, `claude/hooks/freshen-base.js` fetches the checkout's default branch and
fast-forwards it when it is checked out, has no tracked changes and is strictly behind
its remote, so the worktree does not start on stale code. It leaves any other branch
alone, tells Claude when it fast-forwarded or why it did not (including a failed fetch),
and never blocks the call. Its fetch never prompts for credentials, and parallel calls
take turns on a lock in the repository's git folder, so one fetches for all of them.
Do not replace an existing tool home without backing up its local data.

Two skills live here: `headless-browser`, and `work-stages`, which the Workflow sections
of `claude/CLAUDE.md` and `codex/AGENTS.md` point non-trivial work at, for Claude Code and
Codex alike. Claude Code finds both through `~/.claude/skills` when `~/.claude` links to
`~/.config/claude`; otherwise link each skill into `~/.claude/skills`. Link `work-stages`
for Codex too, after checking that nothing is at the target:

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s ~/.config/claude/skills/work-stages "${CODEX_HOME:-$HOME/.codex}/skills/work-stages"
```

The other skills named in `claude/CLAUDE.md` are maintained separately from dotfiles.
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

Git reads `git/ignore` from `~/.config/git` on its own. Include the shared settings
in `git/shared.gitconfig` from `~/.gitconfig`, which keeps identity and credentials:

```sh
git config --global --get-all include.path | grep -qxF '~/.config/git/shared.gitconfig' ||
  git config --global --add include.path '~/.config/git/shared.gitconfig'
```

The file is deliberately not `git/config`, which Git would read as global
configuration and, without a `~/.gitconfig`, write `git config --global` changes
into. It turns on Git's untracked cache, which leaves `git status` output unchanged
and makes it, and the prompt's dirty check, faster in large repositories. To name
the ignore file explicitly anyway:

```sh
git config --global core.excludesFile "$HOME/.config/git/ignore"
```

## Factory

`claude/factory/` measures and improves this Claude Code setup. It reads the session
transcripts under `~/.claude/projects`, and for metrics also the Codex rollouts under
`${CODEX_HOME:-~/.codex}/sessions`, and keeps its reports, scores, benchmark results
and proposal records in `${XDG_DATA_HOME:-~/.local/share}/claude-factory/`, never in this
repository. Commands that call a model state a budget and stay within it.

```sh
bun ~/.claude/factory/cli.js metrics            # last 7 days vs the week before
bun ~/.claude/factory/cli.js audit --with-tests # security posture of this setup
bun ~/.claude/factory/cli.js score --dry-run    # sessions the judge would score
bun ~/.claude/factory/cli.js propose --list     # repeated failures that qualify
bun ~/.claude/factory/cli.js board              # the work board's week: stats, open feedback
bun ~/.claude/factory/cli.js evolve             # the feedback loop per setup this week
bun ~/.claude/factory/cli.js bench list         # benchmark cases
bun ~/.claude/factory/cli.js bench board report # agent-board text format benchmark
bun ~/.claude/factory/cli.js setups --check     # the setup registry agents report about
bun ~/.claude/factory/cli.js friction run --dry-run # turns the friction capture would judge
bun ~/.claude/factory/cli.js weekly run --no-pr # the whole loop once, no PRs
bun ~/.claude/factory/cli.js ui round           # judge a UI design round (ui-climb skill)
```

`ui` hill-climbs a web UI's design: it captures configured screens of the committed
candidate, main and public reference products with the headless-browser skill (run its
`setup.sh` first), gates them on the project's checks and page checks, and has Claude
judges score the screenshots blind against a rubric. The `ui-climb` skill describes the
configuration and the procedure; every judge call is bounded by the configuration's
per-call, per-round and per-run budgets.

### Setup registry and friction capture

[`setups.toml`](setups.toml) lists every setup on both Macs, from the board, instructions,
agents, hooks, settings, skills, storage and T3 Code to each tool configured here, a
project's own setup and `other`. Each entry gives the `id` agents name with
`board feedback --about <id>`, what it covers, its owner (repository, board and optional
parent task), its channel (`skill-notes` for codex-skills skills, which record their own
feedback), how a change is made and how to verify it. The feedback board's triage routes
reports with it. `setups --check` validates the schema and ids and checks that the
repository paths in `covers` exist; add an entry when you add a component.

Most friction never gets reported, so `friction run` looks for it. It reads the main
sessions of Claude Code and Codex turns that ended since its last run (at most 48 hours
back), skipping automation, the factory's own runs and turns that ran the `feedback` tool
or `board feedback`. A turn has ended at the next prompt, when Claude Code's Stop hooks let
it end or Codex marks it complete; one with no such mark counts as ended after 6 hours
without activity, and until then holds the cursor. Turns with board or other failed calls
(a search that found nothing does not count), hook blocks, retries of the same program, or
phrases such as "workaround", "not relevant" or "不得不" in the agent's own text score
points; up to 8 of those scoring at least 4 go to a restricted judge (Haiku by default,
$0.05 per call, $0.30 per run). Each finding is filed once as the `claude:factory-friction`
agent with `board feedback --source capture --about <id> --activity <stage>`, in a few
factual lines quoting at most one error line and naming the session, turn and project
folder. The board merges reports with the same setup and title, so the same friction seen
in many turns is one item. Records stay in `friction.jsonl` and the cursor in
`friction-state.json` in the state folder; a filing that fails is retried next run without
judging again, up to three times. `friction install` loads a LaunchAgent that runs it every
hour; `friction status` shows it and the last run. It needs the `board` CLI with
`feedback --source` (agent-board-23). Install it on each Mac: a run reads only that Mac's
transcripts and keeps its own cursor, so no turn is judged twice.

`weekly install` loads a LaunchAgent that runs the loop on Mondays at 13:30: metrics,
audit, scoring (judge budget $3), the work board, the feedback loop and proposals ($3 per proposer session;
no session starts once the next one could take the run past $10, though a session can end
slightly over its own budget). Proposals open draft PRs on this
repository only for the deterministic detector dimensions, and their bodies hold session
ids, not transcript text, because the repository is public.

The board step runs `~/.cargo/bin/board stats --days 7 --json` and `board ls --board
board-feedback --json` (the tasks agents file with `board feedback`) and writes them to
`board-snapshot.json` in the state folder; the report shows the stats and the open
feedback, and a failing `board` call fails the step.

Triage resolves feedback within minutes and closes it, so the `evolve` step reports the
loop itself, per setup with its title from `setups.toml`. It reads every item's `feedback`
record from `board ls --board board-feedback --json`, and each routed item's owner task
with `board show <id> --json`. For items active in the last 7 days it counts items,
reports, sources (agent, capture, signal), recurrences, declined items reported again, and
items whose owner task was done in the window. It also lists items still waiting at any
age: untriaged ones older than an hour, and routed ones whose owner task is still open,
with their age. Tasks filed before the server kept feedback records are only counted. A
failed `board` call fails the step and leaves out only what it would have read.

Proposals read the board snapshot: feedback
no proposal used in the last 30 days, or stats past a threshold (once in 30 days), start
one proposer session with clones of this repository and agent-board, which sees only that
feedback. It may change only the "Work board" section of
`claude/CLAUDE.md` and `codex/AGENTS.md` (identically), agent-board's coordinator prompt
and docs, and the values of the server defaults in `impl Default for Settings`. The tool
tests each changed repository (`cargo test --workspace --locked` for agent-board, its
build folder kept under `cargo-target/` in the state folder) and opens a draft PR on each,
against `main`. A change
that breaks a test pinning a default stays a local patch for a person to finish, as with
rule text. If the second PR fails after the first opened, the record says
`partly-proposed` and is not retried. Feedback
is agent-written and private: the proposer gets it as quoted data, and PR bodies list
feedback task ids and counts, never its text. Reinstall the job after installing `cargo`
so its folder is on the job's `PATH`. `weekly status` shows the
last run; `weekly uninstall` removes the job. Open factory tasks are on the `dotfiles`
work board (`board ls --board dotfiles`);
[`claude/factory/PLAN.md`](claude/factory/PLAN.md) keeps the goal, evidence and log.

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
- A plain one-token Haiku request checks the key and its credit. The answer is cached per
  key and kind of check in `~/.local/state/claude-api/` (10 minutes while the API works,
  30 once credit is out, the key is refused or the request is refused any other way, 1
  when the check is inconclusive). Without a key file or credit, runs use the
  subscription and say so on stderr. Every decision goes to `decisions.jsonl` there, and
  the weekly summary counts them.
- The check cannot foresee every refusal: the API can refuse Claude Code's own requests
  for credit while plain ones are served, and refuses requests that only look like Claude
  Code's even while Claude Code is served, so no check request can stand in for a run. So
  API runs report back: `StopFailure` and `Stop` hooks merged into the same settings save
  their input under `reports/` there (with `sh` and `cat`, since Claude Code kills
  `StopFailure` hooks when it exits), and the next run's plan folds them in. A run the API
  refuses for credit or the key moves later runs to the subscription for 30 minutes,
  doubling with each further refusal while the check keeps passing, up to 8 hours; runs
  refused together count once, a run that goes through clears the count, and plans
  running together take turns with the state. The factory and the live suites run a call
  the API refused for credit or the key before it did anything once more, with
  `API_FIRST_SUBSCRIPTION=1` so it goes to the subscription even when the refused run's
  hook was cut off before it reported.
- Runs that are not print mode, or that set `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or
  `ANTHROPIC_BASE_URL` themselves, pass through untouched. The script replaces itself with
  the real claude, so killing the process a caller started kills claude.
- For scripts that call `claude` by name, put `~/.claude/bin/api-first` first on `PATH` for
  that run only, never in a login profile. A nesting limit stops a loop.

## Work board

[agent-board](https://github.com/syz51/agent-board) is the shared work board that the
"Work board" rule in `claude/CLAUDE.md` and `codex/AGENTS.md` refers to. One server runs on
a host in the tailnet
([deployment](https://github.com/syz51/agent-board/blob/main/docs/DEPLOY.md)); each Mac
runs the `board` binary. The hooks in `claude/settings.json` and `codex/hooks.json` run
`claude/hooks/board-hook.sh` from `~/.claude/hooks`, which the linked `claude/hooks` directory
provides. It runs `~/.cargo/bin/board` and does nothing until that is installed. The board
records the files a Bash call changed by the time it returns (not what a background command
writes later) with agent-board#8 or later; reinstall with the first command below. An older
`board` rejects that call's `pre-tool-use` event, which the script reports as a failed hook
rather than the exit code that would block the call. On each Mac, with a device token created
on the server host:

```sh
cargo install --git https://github.com/syz51/agent-board --locked board  # Rust 1.99 or newer
# Reads the token until end of input: pipe it from a file or paste it and press Ctrl-D.
board login --server https://<board-host>.<tailnet>.ts.net --device <this-mac>
claude mcp add --scope user board -- "$HOME/.cargo/bin/board" mcp
board install launchd --write
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/dev.agent-board.watch.plist
```

For Codex, add the `[mcp_servers.board]` block that `board install codex` prints to
`~/.codex/config.toml`, and link `codex/AGENTS.md` to `~/.codex/AGENTS.md` so Codex gets the
rule. Codex runs a new or changed hook only after it is approved: run
`bun ~/.config/codex/trust-hooks.js --trust` to approve the hooks this repository tracks
(it lists them first without `--trust`). It approves hooks from `$CODEX_HOME/hooks.json`
only while that file matches `codex/hooks.json` on `origin/main`, so pull first, and exits
1 when hooks stay unapproved or Codex reports problems loading them. Run it again after
`codex/hooks.json` changes.

Over SSH or from launchd the login Keychain is locked, so `board login` there stores the
token in `~/.local/share/agent-board/token` (mode 0600) instead.

Agents' asks reach you on Telegram, and you can answer them from a shell with a user token
kept in its own `BOARD_HOME`, so it does not replace the device's token. Create it on the
server (`board admin device <mac>-user --user`, which prints the token once) and pipe it
straight into the login, then answer with the same `BOARD_HOME`:

```sh
mkdir -m 700 -p ~/.local/share/agent-board-user
BOARD_HOME=~/.local/share/agent-board-user board login --server <url> --device <mac>-user
BOARD_HOME=~/.local/share/agent-board-user board answer <ask id> <option>
```

To host autopilot coordinators on a Mac, map each board repository to its local T3 Code
project folder in `~/.local/share/agent-board/config.toml` and list the Mac among the
board's home devices (`board board update <slug> --home-device <first> --home-device <second>`
replaces the list, in order of preference):

```toml
[projects]
"github.com/<owner>/<repo>" = "/path/to/the/t3/project"
```

The server URL and device name stay in `~/.local/share/agent-board/config.toml` and the
token in the macOS Keychain or, where `board login` fell back to it, the token file beside
it, outside this repository. When a hook finds the server
unreachable it waits at most about 1.5 seconds, and the Mac's hooks then use their cache
without trying the server for a minute.

Sessions started with `AGENT_BOARD_HOOKS=off` stay off the board. The test and
benchmark runners set it through `childEnv` in `claude/tests/lib/process.js`. Set it
for any other script that starts `claude -p` or `codex exec` from inside a thread:
such a session inherits the thread's identity and would otherwise report as that
thread.

## T3 Code thread cleanup

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

T3 Code's own storage cleanup removes worktrees, with `"storageCleanup":
{"worktreeOnMerge": true, "worktreeSettledAfterDays": 7}` in
`~/.t3/userdata/settings.json` (Settings > Storage > Delete merged worktrees and
Delete settled worktrees). Its hourly sweep removes a linked worktree under
`~/.t3/worktrees` once its thread's pull request is merged, or once the thread, or
the parent a subagent thread belongs to, has been settled for 7 days. It keeps
worktrees with uncommitted or untracked changes, an open terminal or a running
thread, and keeps the branch. Ignored files, such as build output, go with the
worktree. A resumed thread gets its worktree back from its local branch, or, once
that is pruned, from `origin/<branch>` or a fresh branch off the default branch.
`t3code/prune_branches.py` deletes those branches once their commits are kept
elsewhere: local branches of T3 worktree threads that no worktree has checked out,
rebases or bisects, whose threads are idle, and whose worktree folders are gone or
now hold another branch. It deletes such a branch when:

- it is merged: `origin/HEAD` contains its tip as of the last fetch, which T3's sweep
  refreshes, or, for a github.com origin, GitHub has a merged pull request from it
  into the default branch whose head is its tip or a commit known to descend from
  it, which covers squash and rebase merges;
- it is pushed: `origin/<branch>`, both as last fetched and as read live, is its
  tip or a known descendant, so a resumed thread gets the work back;
- it is abandoned: every thread on it, with a worktree or not, is archived or
  deleted.

Before deleting a pushed or abandoned branch it saves the tip as
`refs/t3-archive/<branch>@<12 hex digits>`, which `git branch` does not list and which
keeps the work after origin's branch is gone. List those refs with
`git for-each-ref refs/t3-archive/`, restore one with
`git branch <branch> refs/t3-archive/<branch>@<digits>`, and drop one with
`git update-ref -d <ref>`. Other branches stay, such as an unpushed branch of a
thread that can still be resumed. An origin counts as github.com after `insteadOf`
rewriting and, for SSH URLs, when `ssh -G` through the SSH command git uses resolves
a host alias such as `github-work` to github.com or ssh.github.com. The T3 and local
conditions are checked again just before deleting. It never deletes the default
branch or a branch no T3 worktree thread uses, and skips repositories without
`origin/HEAD`. Remote lookups are batched per repository. On github.com, one
GraphQL query through `gh` per 50 branches the default branch lacks has aliased
fields for each branch's newest 100 merged pull requests and its live branch; a
failed query stops that repository's later ones but keeps what earlier ones found.
Elsewhere, one `git ls-remote --heads`, which asks the server for branches only,
checks the branches the last fetch saw on origin. A repository whose branches are all
merged by ancestry makes no call, nor does one off GitHub whose other branches were
never fetched from origin. Lookups never prompt and time out after 60 seconds. It
exits 1 when a repository or a remote lookup fails, still pruning the rest.

Each run plans, settles, verifies, prunes and then settles its own thread when nothing
failed. `~/.local/state/t3-settle-children/settle.jsonl` gets one line per plan and
verify, with the thread ids, and `prune.jsonl` one line per prune, with the deleted
and kept branches, the skipped projects, and the failed repositories and lookups. A settle failure still
lets the prune run. Edit the prompt file to change the routine. Change the interval,
pause or delete the task in T3's scheduled tasks, or ask an agent to call
`schedule_task` with `enabled: false` or `delete_scheduled_task`. Run the scripts by
hand to see what the next run would settle and prune:

```sh
uv run --no-project --python 3.11 python -B ~/.config/t3code/settle_children.py
uv run --no-project --python 3.11 python -B ~/.config/t3code/prune_branches.py --dry-run
```

## Disk space alert

`disk-alert/disk_space_alert.py` warns when the Data volume runs low on free space.
The `com.syz51.disk-space-alert` LaunchAgent runs its `check` every 10 minutes. Below
30 GB free (10^9 bytes, as `statvfs` reports space available to you) the level is
low, and below 20 GB it is critical. Falling to a worse level alerts at once, and
staying low or critical alerts again every 24 hours. A level eases only once free
space is 2 GB above its threshold, so a reading that hovers near one does not flap.

An alert posts a macOS notification and messages T3 Code. The first alert of an
episode starts a thread in T3's "No project" (`~/.t3/scratch`), asking for a
read-only summary of where the space went and what could be cleaned, without
deleting anything. Later alerts in the episode go to that thread, or start a new
one if it is gone. When T3 Code is not running, each check retries the message
without repeating the notification. A start that timed out or printed no thread id
is not retried, since it may have gone through. Getting back above 32 GB posts one "recovered"
notification and ends the episode. The state is in
`~/.local/state/disk-space-alert/state.json`, each alert adds a line to
`events.jsonl` there, and launchd writes errors to `launchd.log`.

While space is low, each check first removes the scratch folders of idle Claude Code
sessions, `/private/tmp/claude-<uid>/<project>/<session id>`, where Rust `target/`
folders and other build output pile up. A folder qualifies only when nothing in it, in
its transcript or in its subagent transcripts has changed for 24 hours, Claude Code's
registry of running sessions (`~/.claude/sessions`) does not list it, and no running
process names the session or works inside the folder. Anything that cannot be read
keeps the folder, and a sweep that fails still lets the alert go out. The alert says
what was freed, or a notification does when the sweep alone brings space back, and
`events.jsonl` gets a `swept` line listing the folders. `sweep --dry-run` lists
what would go now, whatever the free space, `sweep` removes it and logs it, and
`--no-sweep` turns the sweep off for a run. A simulated reading (`check --free-gb`)
never sweeps.

Install it on each Mac from the main checkout, which the plist points to, and send a
test alert through both channels:

```sh
uv run --no-project --python 3.11 python -B ~/.config/disk-alert/disk_space_alert.py install
uv run --no-project --python 3.11 python -B ~/.config/disk-alert/disk_space_alert.py test
uv run --no-project --python 3.11 python -B ~/.config/disk-alert/disk_space_alert.py status
```

`install --dry-run` prints the plist without loading it, and `uninstall` unloads and
removes it. To change a threshold, run `install` again with `--low-gb` or
`--critical-gb`, which it writes into the plist. A one-off run with
`check --free-gb 15 --state-dir <scratch folder>` simulates a reading without touching
the real state.

## Verification

From the repository root, run the focused local suites:

```sh
bun test nvim/tests/bun-outdated.test.js nvim/tests/protect-skim-notes.test.js claude/hooks claude/tests claude/factory
uv run --no-project --python 3.11 python -B -m unittest discover -s tuios/tests -v
uv run --no-project --python 3.11 python -B ghostty/test-tuios-launcher.py -v
uv run --no-project python -B shell/test-startup-fixes.py -v
uv run --no-project --python 3.11 python -B -m unittest discover -s t3code/tests -v
uv run --no-project --python 3.11 python -B -m unittest discover -s disk-alert/tests -v
uv run --no-project --python 3.11 python -B -m unittest discover -s config-sync/tests -v
```

The `claude/tests` suites check the Claude Code configuration. These run offline and
in CI:

- `config.test.js`: agent frontmatter against the delegation policy, files and agents
  that `claude/CLAUDE.md` references, hook scripts in `claude/settings.json`, the rules
  the live suites test, and the root `CLAUDE.md`. It also checks `claude/frontend-avoid.md`,
  which the installed `frontend-ui` skill tells sessions to read rather than
  `claude/CLAUDE.md`: its rule and the one-line Patterns section that skill feedback
  proposals append to. It also pins the Feedback rule and the `work-stages` skill in
  both instruction files, and that the setups they name are registered.
- `lib/*.test.js`: the live harness's helpers on small synthetic traces: stream-json
  evidence, Bash check attribution, guidance reads, filesystem snapshots, the process
  runner and leftover processes, two-message conversations, session cleanup, reports and language detection.
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
  worktrees as they were. The guard hooks block a user-authorized leased force push to the branch the
  remote's HEAD names as its default and a bare
  `python3`, while `uv run python` still runs.
- `live-dispatch.test.js`: the Skills section's routing. TypeScript, Rust, Tauri,
  TSX, Vue, chart, built-page, skill-search and article tasks load their skills in
  order, and an Effect review reads only its routed reference. A README fix in a
  TypeScript and Rust repository loads no skill, and the article run saves its draft.
- `live-policy.test.js`: Python checks run through `uv run`, and JavaScript uses
  `bun` unless the project's lockfile names another tool. Fixes are re-checked
  independently, reviews stay read-only, and these single-track tasks, one of them a
  rename across several files whose check proves from its own output that it passed
  in the fixture, spawn no subagent. No scenario leaves a process running in its
  fixture, and a server the check needs, which detaches itself, is stopped by the time
  the session answers. A Japanese draft is followed by its Chinese meaning, while JSON-only and Chinese-only
  replies stay as asked.

`claude/factory` tests run offline against synthetic transcripts and fake `claude`,
`gh`, `launchctl`, `board` and `cargo` programs. Its live sandbox check runs real Haiku sessions (about
$0.01) and verifies that the strict profile blocks writes outside the working folder and
unlisted hosts:

```sh
RUN_CLAUDE_LIVE=1 bun test claude/factory/audit
```

Set `CLAUDE_LIVE_REPORT_DIR` to a folder inside `$TMPDIR` to keep a JSON report and
the raw stream of each scenario; the report lists each tool call with the directory it
started in, which the stream lacks. The live sandbox check writes a failed case's report
and stream there too, or, without the variable, to `$TMPDIR/claude-live-failures`, and
prints the path. Delete these folders when done: they hold transcripts.

With Explore's dependencies installed, its additional integration suite is:

```sh
uv run --no-project --python 3.11 python -B -m unittest discover -s explore/tests -v
```

These tests do not prove a fresh-machine installation or the live terminal flow.
Follow [Explore's end-to-end instructions](explore/README.md#tests) with a private
daemon and scratch directories when checking the complete picker workflow.
