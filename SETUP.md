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
| Agent tools | Claude Code, and Codex only if you use its example configuration. Review settings, permissions, and hooks before enabling them; the tracked hooks invoke `~/.atuin/bin/atuin`, `~/.bun/bin/bun` and, through `claude/hooks/board-hook.sh` and `claude/hooks/open-items.js` when installed, `~/.cargo/bin/board` (see [Work board](#work-board)). |
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
changes and no commits of its own; it never stashes, resets or merges. One exception:
a Claude Code plugin install, update or enable rewrites `claude/settings.json` in its own
key order and layout. When that unstaged rewrite on `main` is the only tracked change and
its parsed JSON still equals `HEAD`'s, config-sync writes the committed text back; any
other change stays. Otherwise it leaves the checkout as it is and files one Feedback
report about `config-sync` per distinct set of problems: off `main`, tracked changes,
diverged, a fast-forward that failed (an untracked file in the way, say), a failed
restore, a fetch failing for over 24 hours, or an instruction link (`~/.claude`, Codex's
`AGENTS.md`) that is a copy or missing. It uses plain `board feedback` where the
installed CLI lacks `--about`, and a macOS notification when the board is unreachable.
A live suite run fails when `~/.claude` changes under it. So each live suite holds a lock
from setup to teardown, renewed before each session:
`~/.local/state/config-sync/locks/live-suite-<pid>-<suite>.lock`, holding its PID. While a
lock's process is alive, a check skips everything: the pull, the `settings.json` restore
(which rewrites a file the run guards) and the link checks. It looks again after the
fetch, which can take minutes. It logs the skip, and the next check after the run does
all of them. A lock that cannot be read, with text that is not a PID, a dead PID, or an
age over 3 hours (a reused PID) is stale, and the check removes it, so a killed run does
not stop pulls.
State is in `~/.local/state/config-sync/state.json`, each pull, restore, report or skip
adds a line to `events.jsonl` there, and launchd writes to `launchd.log`.
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

JavaScript runs on bun only, so `bun run` and `bunx` must not start Node for a tool
whose shebang names `node`. A global bunfig `[run] bun = true` does not cover that, so
add this to `~/.zshenv` on each Mac:

```sh
export BUN_OPTIONS=--bun
```

One exception: `node` may run in a checkout of a repository that
`claude/hooks/node-repos.json` lists, such as T3 Code, whose server needs Node.js. There,
`BUN_OPTIONS=--bun` still makes `bun run` start bun for a script that calls `node`, so run
its scripts with `node` directly or with `BUN_OPTIONS= bun run <script>`.

`~/.zshenv` on each Mac also puts `$HOME/.bun/bin` on `PATH`, so non-interactive shells,
such as `ssh` commands, find `bun` and `bunx`.

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

Agents run on Claude models only: `claude/CLAUDE.md` forbids the `codex` CLI, `gpt-*`
models and the Codex delegate provider. opencode is the exception: by the user's choice, it
runs GPT models (see "opencode" below). As a backstop, guard-runtimes blocks a Bash command
named `codex`, also through `bunx @openai/codex`; it does not see other launchers or the T3
delegate tools. Tools that read past Codex sessions under `~/.codex` still read them. The `codex/`
files below stay until their removal is decided.

`codex/config.example.toml` is a reference configuration. Review and adapt it
before creating a local `codex/config.toml`, which is intentionally ignored.
Codex expects its configuration under `~/.codex`; review your existing files
before linking that location to `~/.config/codex`. Claude Code likewise needs
its files at the location expected by your installation (normally `~/.claude`).
Link the whole `claude/hooks` directory, not single scripts: the Bash guards import
`claude/hooks/shell.js`, and a guard that cannot load it fails open.
`codex/hooks.json` runs the same guards on Codex shell calls, which Codex names `Bash` in
hook input; they need `~/.claude/hooks` on the Mac that runs Codex. The guards see
only Bash tool calls, so `claude/settings.json` sets `disableSkillShellExecution`: a
`` !`command` `` line in a user, project or plugin skill or custom slash command is
replaced with a placeholder instead of running unchecked before the model reads it.
guard-git-push blocks a push whose subcommand, refspec, remote or option name comes from
a variable, command substitution or brace expansion, and one that sets push
configuration with `git -c` or an earlier `git config`. It checks a push without
refspecs against the push remote's `remote.<name>.push` and `remote.<name>.mirror`. It
blocks a push that `xargs` adds words to, such as `echo --force | xargs git push origin main`,
here and over `ssh`, and every command whose words `xargs` supplies (see below). It
follows an alias that `-c` sets on the git command, as in `git -c alias.p=push p`, and
blocks one it cannot read, such as a `--config-env` or `!` alias. It cannot see aliases in
config files or `GIT_CONFIG_*` variables.
`shell.js` reports a command as opaque when the words `xargs` adds can run a command the
guards cannot see: `xargs ssh` and `xargs watch`, which parse them again as a script,
wrappers with no command such as `xargs sudo`, `xargs env` and `xargs nice`, a second
`xargs`, a shell's `-c` with no script, `eval`, and `xargs find`, whose added words can
hold an `-exec`. With `xargs -I {}`, a word that holds `{}` reads as `${xargs}`, which the
guards treat as filled in by the shell, and a command whose name or script holds it is
opaque. guard-git-push and guard-pr-merge refuse an opaque command; guard-main-checkout
refuses one in a main checkout, unless it runs inside a remote script. Forms such as
`git ls-files | xargs grep foo` and `ls | xargs -n1 basename` are not opaque.
guard-pr-merge (Claude Code only) enforces the merge rule in `claude/CLAUDE.md`'s Autonomy
section. Before a `gh pr merge` runs, it reads the pull request with `gh pr view` and refuses
`--admin`, a draft, a branch that is `BEHIND` or `DIRTY`, and a pending or failed check on the
head commit. A merge that it checks like a direct merge must also pin that head with
`--match-head-commit <SHA>`, the `headRefOid` read in the same query as the checks, so
GitHub refuses the merge if a commit was pushed after the check. The guard refuses a merge
without the pin, and refuses a pin that is not the head for every merge. The refusal names
the SHA and the command to rerun, with the pull request's URL in place of its selector. Its
refusal of a `BEHIND` branch names `gh pr update-branch` with the pull
request's URL. Where the base branch requires checks, it also says to rerun the merge with
`--auto` in a separate command, so GitHub merges once they pass instead of the agent
re-waiting each time the branch falls behind. A check run is pending until its status is
`COMPLETED`; it fails with any
conclusion but `SUCCESS`, `NEUTRAL` or `SKIPPED`. Runs of different workflow runs all count,
also one with the name of a later run; within one Actions workflow run, which a re-run
reuses, only the latest attempt of each job counts. GitHub records each Actions job it never
started for billing as a failed check run with no steps and one failure-level annotation on
`.github`. GitHub may add notice-level annotations on `.github`, such as the `ubuntu-latest`
migration notice. Such a job passes when its annotations number at most 10 and are all
these, and a non-Actions check named `<context>: <job name>`, such as `ci/circleci: build`,
succeeded. A failed job with steps fails, even with that annotation,
because a job's own output can write it. So does a skipped job whose name a skipped job of
another workflow shares. One GraphQL call reads the steps and annotations, only when every failed
check is a failed Actions job. It adds about 0.75 seconds and costs about 12 GraphQL rate-limit
points. It filters by github.com's Actions app, so on another host such jobs stay failed. Once no
check is pending or failed, the guard expects a check from the CI that runs on every pull
request. One GraphQL call reads each file in `.github/workflows` at the head commit and on
the base branch, and whether `.circleci/config.yml` exists at the head commit; `Bun.YAML`
parses the workflows. A workflow is expected when its `on:` has `pull_request`, at the head
commit, or `pull_request_target`, on the base branch that GitHub runs it from, with no
`paths`, `paths-ignore`, `branches`, `branches-ignore` or `types` filter, in string, list or
map form. The guard refuses, naming each one, until the rollup has a check run with the
workflow's `name:`, or its path where it has none. Workflows that share a name need a
workflow run each. Only when one is missing does a REST call list the repository's
workflows, and one that Actions lists as disabled is not expected. With
`.circleci/config.yml`, it refuses until a `ci/circleci` status context, or a check run
that links to circleci.com, appears; a configured repository that CircleCI does not build
stays refused. So a head
commit without checks passes where no workflow runs on pull requests, such as
dispatch-, push-, schedule- or tag-only workflows, and a fast third-party status no longer
lets a merge pass before the Actions runs appear. A workflow with a filtered pull request
trigger is not expected, so its check can still arrive after the merge. A workflow file that
does not parse, or a query that fails, refuses the merge. The call adds about 1 second, 0.7 to 1.4 seconds, on
syz51/vps, with 25 workflows. A job queued forever on a runner label with no runner stays
pending, so it still blocks the merge. `--auto` on a non-draft passes when the base branch requires status
checks through protection or a ruleset and gh enables auto-merge, so GitHub waits for the
required checks. When the pull request is `CLEAN`, `HAS_HOOKS` or `UNSTABLE`, gh merges at
once, so the guard checks it as a direct merge. It also refuses `gh api` calls to
`pulls/<n>/merge` and the `mergePullRequest` and `enablePullRequestAutoMerge` mutations. It
refuses any merge argument or subcommand that the shell fills in, any gh command that `xargs`
adds arguments to, such as `echo 'merge 12' | xargs gh pr`, unless its visible subcommand is
read-only, as in `xargs gh pr view`, any opaque command, options other than `-R` before the subcommand, `GH_HOST` set in the command,
`GH_REPO` set without `-R`, `GIT_DIR` and `GIT_WORK_TREE`, and a glob that can name gh or
fill in its subcommand or selector. It runs once before the whole command, so it refuses a
merge in a command that also runs another merge, or a git or gh command that is not
read-only, such as `git push`, `git switch`, `gh pr checkout` or `gh pr update-branch`: merge
in a separate call once the head's checks pass.
It fails closed: a gh error, a call past its 8-second limit, an unknown option or a
crash blocks the merge. The queries add about 0.7 seconds to each merge, about 1.5 with the
GraphQL call, and its
`settings.json` timeout of 45 seconds covers the 35 seconds it allows for them. It cannot
see gh aliases, scripts, an endpoint held wholly in a variable, a query read from a file,
or curl.
`claude/hooks/auto-merge.js` (Claude Code only, a PostToolUse hook on Bash) turns on
auto-merge after a Bash call that ran `gh pr create` succeeds. For each pull request URL
the call printed on a line of its own, it turns on auto-merge when the
repository's owner is in its `OWNERS` list (`syz51`), the repository allows auto-merge,
the pull request is open, not a draft and has no auto-merge request, and the base branch
requires status checks or approving reviews through branch protection or a ruleset. It
asks for the first merge method the repository allows, in its `METHODS` order: merge
commit, squash, rebase. It never merges at once. It calls the `enablePullRequestAutoMerge`
mutation through `gh api graphql`, which GitHub refuses for a pull request that can merge
now, rather than `gh pr merge --auto`, which merges such a pull request directly. Right
after `gh pr create`, GitHub often still reports the state as `UNKNOWN`, so a check of the
state alone would not stop that. It skips a pull request that is `CLEAN`, `HAS_HOOKS` or
`UNSTABLE`, or that GitHub refuses as such, and leaves it to an agent and guard-pr-merge. It
runs gh with the user's login, so the merge pushes as the user and starts push workflows.
Its gh call is not a tool call, so guard-pr-merge, a PreToolUse hook, never sees it; it
would refuse the mutation from a Bash call. It never blocks: it reports each pull request, and any gh failure, to the session
as additional context and exits 0. Each gh call gets 10 seconds, and all of them 45, within
its 60-second `settings.json` timeout. The user chose this hook over a GitHub workflow
(dotfiles-350), so a pull request opened on the web gets no auto-merge.
guard-main-checkout (Claude Code only) blocks commands that switch, move or reset a main
checkout's branch or set its work aside: git `switch`, `checkout` of a branch,
`checkout -f`, `reset` to another commit or with `--hard`, `--keep`, `--merge` or
`--soft`, `merge`, `rebase`, `pull`, `stash`, `bisect`, `gh pr checkout` and `gh pr merge`. Their
continue, abort, list and show forms, file restores (`git checkout -- <path>`,
`git reset -- <path>`), fast-forwards, a clean switch back to the default branch and
every command in a linked worktree still run. A fast-forward is a `merge` or `pull` whose
last of `--ff`, `--no-ff` and `--ff-only` is `--ff-only`, with only output options,
`--no-edit`, `--no-autostash`, `--no-rebase` or `--rebase=false` beside it, spelled out,
no refspec that forces (`+a`) or names a destination (`a:b`), and no global `-c`. Any
other option, such as `-s ours` or `--autostash`, makes it an ordinary merge or pull. A
switch back is `git switch <name>` or `git checkout <name>` (with `-q` at most) where
`origin/HEAD` names that branch and no tracked file has changes. Neither loses work, so
agents may update a shared checkout without asking the user again. A main checkout
is one whose git directory is the common git directory. Repositories in the temporary
directory or Claude Code's `/tmp/claude-<uid>` scratch folder are a session's own and
are not guarded. When the user asked for such a change in that checkout, the agent
runs that one git command as `git -c claude.mainCheckout=allow <subcommand> ...`,
which the guard lets through; the block message tells agents so, and never to hand the
command back to the user. Even then the guard refuses what could lose another thread's work:
`reset --hard`, `checkout -f` and `switch -f` or `--discard-changes` while tracked files have
changes, and `stash drop` or `stash clear`. For `gh pr checkout` the message gives the same
route through `git fetch` and `git switch`. To allow every such command in one repository, run
`git config claude.mainCheckout allow` yourself; the guard refuses a `git config`
command that sets that key. It is a guardrail against mistakes, not a security
boundary: it follows an alias that `-c` sets on the git command and, in a main checkout,
blocks one it cannot read, but it does not see aliases in config files, scripts or direct
edits of `.git/config`. In a main
checkout it also refuses a git command that `xargs` adds words to when those words could
change the branch, as `echo feature | xargs git checkout` can, but not file restores after
`--`, aborts, continues and stash or bisect reads. Anywhere, it refuses a bare `git` that
`xargs` supplies the subcommand to, since the added words can hold `-C <path>`, and
`git config` with added words unless it only reads. It also refuses `gh` when `xargs` supplies its subcommand, and an
opaque command, in a main checkout. It fails
open when it cannot tell the repository, such as with `--git-dir` or a directory held
in a variable, and for scripts nested too deeply to parse.
guard-asks (Claude Code only) checks each board `ask_user` call against
`claude/hooks/ask-policy.json`, the reasons the Autonomy section of `claude/CLAUDE.md` lets
agents notify the user for: `design`, `cost`, `irreversible`, `outside`, `only-me`,
`security` and `intent`. An ask
must name one as `Reason: <name>`, and an `action` ask, which hands the user a step, must
name `only-me`. Otherwise the hook refuses the ask and lists what the agent should do
instead. Edit the JSON file to change the reasons. The `board ask` CLI is not checked.
open-items (Claude Code only) runs at `Stop` and reads the reply. In a repository with a
work board, it blocks the stop once when an item under an open-item heading, such as
"Limits", "Not verified" or "Next steps", names no task or ask and no reason why it needs no
work. This is the Work board rule of `claude/CLAUDE.md` that each open item of a reply names
the task or ask that holds it. The board's own Stop reminder fires only after `task_done` or
a release. The hook is a reminder: the next stop passes. Edit
`claude/hooks/open-items.json` to change the heading and exempt patterns, or set `enabled`
to `false` to turn it off.
`claude/settings.json` cuts worktrees from the local HEAD (`worktree.baseRef` `head`) so
they keep unpushed commits. Before EnterWorktree or an Agent call with worktree
isolation, `claude/hooks/freshen-base.js` fetches the checkout's default branch and
fast-forwards it when it is checked out, has no tracked changes and is strictly behind
its remote, so the worktree does not start on stale code. It leaves any other branch
alone, tells Claude when it fast-forwarded or why it did not (including a failed fetch),
and never blocks the call. Its fetch never prompts for credentials, and parallel calls
take turns on a lock in the repository's git folder, so one fetches for all of them.
Worktrees cut without a tool call, such as T3's `delegate_task` worktrees and
`claude --worktree` sessions, get a check at session start instead.
`claude/hooks/stale-base.js` acts in a clean linked worktree whose HEAD has no commits of
its own. It fetches origin's default branch with a 4-second limit, sharing
`freshen-base.js`'s lock. It warns Claude to fast-forward when HEAD is behind that branch.
It never changes the worktree. It stays quiet in a main checkout, with tracked changes,
on a branch with its own commits or another upstream, and when HEAD is current. When the
fetch fails, it compares with the last fetched branch and says so. It adds about 1 to 2
seconds to the start of such a session, and about 0.2 seconds offline. Claude Code reads
hooks when a session starts, so a session that started before config-sync installed a
hook never runs it.
In a worktree-isolated session, Claude Code refuses each Bash command that it cannot
verify stays in the worktree. This guard runs inside Bash execution, after every hook,
and no setting turns it off. `claude/hooks/worktree-rule.js` tells the session which
forms the guard refuses, as measured on Claude Code 2.1.319, so agents write around them.
It speaks after a successful EnterWorktree, for the worktree that was entered. It also
speaks when a subagent starts, and at session start or after compaction, when the working
folder is under `.claude/worktrees/`. T3 worktree threads live elsewhere and run without
the guard. opencode has no such guard, so the hook stays quiet when opencode's
`claude-hooks` plugin runs it. Re-measure the forms when a Claude Code update changes the
guard's messages.
`claude/settings.json` sets `autoCompactWindow`, the context window that Claude Code
compacts against. It compacts about 33K below the window, so near 967K for Opus 5.5's 1M
window, and long threads re-read most of that context on every call. The value applies to
every session, subagents included, on both Macs. It was 300000, which compacts near 267K,
from 2026-11-06. From 2026-11-08 it is 200000, which compacts near 167K, as a trial. At
300000, on the Air from 2026-11-06 to part of 2026-11-08, a main-thread call read 150K
cached tokens on average, 26% of calls carried more than 200K of context, and all calls
read 1.85B, 4.03B and 4.69B cached tokens a day. Compare at least three full days at
200000 with that baseline. A lower window lowers reads per call by construction, so judge
it by total cache-read tokens per day and per board task done, and watch compactions per
session. Then set the chosen value, update this paragraph and the test and its comment in
`claude/tests/config.test.js`.
Do not replace an existing tool home without backing up its local data.

Every request of every session and subagent carries `claude/CLAUDE.md`, so it holds only
what most turns need. Procedures that few turns need are in `claude/reference/`, each
behind one pointer line in the section it belongs to: `storage.md`, `review-findings.md`,
`merge.md` and `t3-delegation.md`. A session reads one through
`~/.claude/reference/<name>.md` when its pointer applies. Each file keeps its
rules word for word and states that they have the instructions' force. To move another
rule, move its lines unchanged, leave a pointer that names when to read the file, and
change the pins in `claude/tests/config.test.js`, which also holds the size budget of
`claude/CLAUDE.md`. `codex/AGENTS.md` reads no reference files and keeps its rules in
place. The factory reads the instructions too: the judge in
`claude/factory/scoring/score.js` gets the reference files appended, the proposer in
`claude/factory/scoring/propose.js` may edit them, and
`claude/factory/board/proposal.js` requires the Work board section to be identical in
both files, so no Work board rule moves. The four agents in `claude/agents/` deny the tools no subagent uses
(`ReportFindings`, `ListAgents`, the claude.ai connectors, and computer use for the two
read-only agents), which shortens each subagent request.

Four skills live here: `headless-browser`; `cheat-sheets`; `diff-review`, the recipe of
the `reviewer` agent that the Review section of `claude/CLAUDE.md` starts; and
`work-stages`, which the
Workflow sections of `claude/CLAUDE.md` and `codex/AGENTS.md` point non-trivial work at,
for Claude Code and Codex alike. Claude Code finds them through `~/.claude/skills` when
`~/.claude` links to `~/.config/claude`; otherwise link each skill into `~/.claude/skills`.
`cheat-sheets` finds and downloads sheets from cheat-sheets.org into
`~/.cache/cheat-sheets`. That site states no license, so never commit a downloaded sheet
or a copy of its page; its test uses a synthetic page. Link `work-stages`
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

## opencode

opencode 2 reads its global configuration from `~/.config/opencode`, so the tracked files
in `opencode/` apply without a link. They give opencode the Claude Code setup:

- `opencode.json` loads `~/.claude/CLAUDE.md` as instructions, uses GPT-6.1 Sol at
  `xhigh` by default, allows
  every tool as Claude Code's `bypassPermissions` does, and runs two MCP servers: the board
  and computer use (`desktop`). opencode 2 does not read `CLAUDE.md` files by itself.
- `AGENTS.md` maps Claude Code's tool names and Claude-only steps to opencode's, and
  tells the model that the Claude-only rule means the configured GPT models here.
- `agents/` holds `explorer`, `worker`, `solver` and `reviewer`. They keep the Claude
  agents' descriptions and prompts. Each Opus agent runs GPT-6.1 Sol at `xhigh`, the Haiku
  explorer runs GPT-6 Luna at `max`, and the reviewer runs GPT-6.1 Sol at `medium`.
  `claude/tests/opencode.test.js` keeps them in step.
- `plugins/claude-hooks` runs the hooks in `~/.claude/settings.json`: the Bash guards,
  `guard-asks`, `freshen-base`, `stale-base`, atuin and the board hooks. A `PreToolUse`
  refusal refuses the opencode tool call. Hook commands, board MCP calls and shell commands
  act as `opencode:<root opencode session id>` (`OPENCODE_SESSION_ID`), so subagents share
  their parent's board identity. The board hooks run with `BOARD_HOOK_RUNTIME=opencode`, so
  the board registers runtime `opencode`, which its weekly usage hold skips: that hold
  measures the Claude account and applies only to Claude Code. The plugin also adds the project's Claude Code memory index to the context at
  session start.

opencode keeps `service.json` (the background service's password) and `cli.json` in the
same directory; both stay ignored. Models come from the OpenCode Console (Zen), which
bills per token. Skills load from `~/.claude/skills` without configuration.

To try a change before it reaches `~/.config/opencode`, copy `opencode/` to a scratch
directory and run `OPENCODE_CONFIG_DIR=<dir> opencode run --standalone ...`. Without
`--standalone`, commands talk to the running background service and its configuration
(`opencode service --help`); run `opencode reload` after a change reaches
`~/.config/opencode`.

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
bun ~/.claude/factory/cli.js review --dry-run   # review last week of main, file nothing (bills)
bun ~/.claude/factory/cli.js bench list         # benchmark cases
bun ~/.claude/factory/cli.js bench board report # agent-board text format benchmark
bun ~/.claude/factory/cli.js bench review report # /code-review level benchmark
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

The metrics report has a Code reviews section. Each run of the `reviewer` agent that a
session started counts as one review, at the effort the agent ran at. So does each
`/code-review` Skill call, at the first level its arguments name. Neither counts when
refused or interrupted.
Its cost is the agent that ran it plus every agent below it, except agents that ran
reviews of their own. For a review a session's main thread ran, the cost is the forked
review agent that started after the call. The outcomes come from the `ReportFindings`
calls that the Review rule in `claude/CLAUDE.md` asks for. Calls between one review and
the next merge into one record, and a repeated finding counts once. The section shows
findings per recorded review, the fixed, no-change-needed and skipped shares, and the
share of correctness, security and reliability findings. A PR counts as reviewed when a
session that linked it ran a review. The section compares the revert rate of reviewed
and unreviewed merged PRs.

[`claude/factory/scoring/high-impact.toml`](claude/factory/scoring/high-impact.toml)
lists the high-impact paths of each repository with a work board. A default list covers
CI workflows, hooks and guards, settings, installers and deployment, Terraform, Vault,
migrations and auth, minus docs and tests. Each repository can add its own paths. The
Review rule treats a change to a listed path as high-impact. The `review-skipped`
detector fails a session that pushed or merged such a change with no review, a
`reviewer` agent run or a `/code-review`, started since the first edit. It finds each
edited file's repository through the board client's `[projects]` checkouts and their worktrees, after resolving symbolic links such
as `~/.claude`, and skips files git ignores. A push settles only the edits of the
repository its folder belongs to. List changes apply to sessions scored afterwards; bump
the rubric version to rescore past ones.

### Setup registry and friction capture

[`setups.toml`](setups.toml) lists every setup on both Macs, from the board, instructions,
agents, hooks, settings, skills, storage and T3 Code to each tool configured here, a
project's own setup and `other`. Each entry gives the `id` agents name with
`board feedback --about <id>`, what it covers, its owner (repository, board and optional
parent task), its channel (`skill-notes` for codex-skills skills, which record their own
feedback), how a change is made and how to verify it. The feedback board's triage routes
reports with it. `setups --check` validates the schema and ids and checks that the
repository paths in `covers` exist; add an entry when you add a component. A setup whose
code is in another repository names that repository's board: `t3` is the T3 Code fork, on
the `t3code` board, and `t3-scripts` is the routines in `t3code/` here.

Most friction never gets reported, so `friction run` looks for it. It reads the main
sessions of Claude Code and Codex turns that ended since its last run (at most 48 hours
back), skipping automation, the factory's own runs and turns that ran the `feedback` tool
or `board feedback`. A turn has ended at the next prompt, when Claude Code's Stop hooks let
it end or Codex marks it complete; one with no such mark counts as ended after 6 hours
without activity, and until then holds the cursor. Turns with board or other failed calls
(a search that found nothing does not count), hook blocks, retries of the same program, or
phrases such as "workaround", "not relevant" or "不得不" in the agent's own text score
points. A turn whose only friction is board errors the server counts itself scores
nothing: answers with a server error code (`invalid: …`) and text the CLI refused before
sending (`(not sent)`), which the board turns into `signal` items. Refusals no server saw,
such as a runtime's schema check, still count. Up to 8 of those scoring at least 4 go to a restricted judge (Haiku by default,
$0.05 per call, $0.30 per run). Each finding is filed once as the `claude:factory-friction`
agent with `board feedback --source capture --about <id> --activity <stage>`, in a few
factual lines quoting at most one error line and naming the session, turn and project
folder. The board merges reports with the same signature, by default the setup and title,
so the same friction seen in many turns is one item. Titles differ between turns, so the
judge also sees the items already filed: those capture reported to in the last 7 days and
the board's unresolved `board-feedback` items, newest 200 first, by setup. It names the
item a finding repeats. Capture then files the report with that item's `--signature`, so
the board adds it to the item while it is live (unresolved, declined, or routed to open
work), or files a new item that recurs it. A finding whose item was fixed, or whose work
was done, after its turn ended is skipped as a `skipped` record: the fix, such as a raised
limit, came later. Records stay in `friction.jsonl` and the cursor in
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
fixes: items whose owner task was done in the window, and items triage resolved as `fixed`
(it fixed the cause directly) in the window. It also lists items still waiting at any
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
  the weekly summary counts them. Each API run also logs its caller and, once a later run
  folds its `SessionEnd` report, its cost from the transcript. Runs with
  `--no-session-persistence` keep no transcript, so their cost is unknown, unless the
  caller logs the stream's result cost by session, as the factory does. `bun
  ~/.claude/bin/api-first.js spend` sums them by caller and day, and counts each run once.
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
`codex/hooks.json` changes. Only a person runs it: it starts `codex app-server`, and
agents may not start the Codex CLI.

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
for any other script that starts `claude -p` from inside a thread:
such a session inherits the thread's identity and would otherwise report as that
thread.

## Computer use

Claude Code's built-in computer use runs only in interactive sessions, so it is off here.
T3 Code drives Claude Code through the Agent SDK. The `computer-use` plugin in
`claude/marketplace` gives those sessions screenshots, mouse and keyboard instead. Its MCP
server is named `desktop`, because Claude Code reserves the name `computer-use`.

`claude/settings.json` declares the `dotfiles` marketplace (`.claude-plugin/marketplace.json`
on GitHub) and enables the plugin, so there is nothing to install. Claude Code clones the
marketplace and installs enabled plugins it lists at session start, also in T3 sessions.
The plugins have no fixed version, so Claude Code keys them by commit. GitHub
marketplaces do not auto-update by default, so the entry sets `"autoUpdate": true`: once
per session, after a random delay of up to 10 minutes, Claude Code refreshes the clone
and updates installed plugins to the new commit. A plugin newly enabled on `main` installs
at the first session start after that refresh. To get a change at once, run
`claude plugin marketplace update dotfiles` and `claude plugin update <name>@dotfiles`.
A plugin install, update or enable can rewrite `claude/settings.json` in Claude Code's
own layout; config-sync restores the committed text when only the layout changed.

On first use the server compiles `server/helper.swift` with `xcrun swiftc` into
`~/.local/state/desktop-mcp`, again after the source changes. The one-time macOS grants
and how to check them are in
[claude/marketplace/computer-use/README.md](claude/marketplace/computer-use/README.md).

The server keeps these safeguards:

- The model calls `request_access` with app names. An approval policy decides how they
  are approved:
  - `auto`, the default, approves them at once, with no dialog.
  - `dialog` shows an Allow/Deny dialog for each request. It denies after 120 seconds.
  - To switch to the dialog, write `{"approval": "dialog"}` to
    `~/.local/state/desktop-mcp/policy.json`. Delete that file to go back to `auto`. The
    file lives outside the repository, so a branch switch or a commit does not change it.
    The server reads it at each `request_access`, also in running sessions.
  - Terminals, agent apps, editors with a terminal, script tools and system apps such as
    System Settings always get the dialog. `DIALOG_APPS` in `server/desktop.js` lists them.
  - After you press Stop, every session gets the dialog, also after a server restart. The
    policy applies again once you allow apps in a dialog.
  - `approvals.log` in the state folder records each approval and its mode.

  The plugin README gives the details.
- Each click, drag, scroll or pointer move checks the app under the pointer. Keys and
  typing check the app with keyboard focus (Accessibility). An app that is not approved
  is refused.
- The app under the pointer is the topmost visible app window's. Invisible (alpha 0)
  windows and Window Server surfaces other than the menu bar are passed over. The helper
  knows the Window Server by its executable path, not by its name. A visible window of
  any other process that is not an app (no running application) is refused, naming its
  owner and pid, past the Dock's layer too. Its owner name, which the process chooses,
  never goes to the approval check. Of app windows, only the Dock's full-display layer (bundle
  id `com.apple.dock` at the Dock window level) is passed over, and only when the
  Accessibility hit-test reaches another app through it. The window below must then
  belong to that app, or the click is refused. The Dock's tiles, its menus, Mission
  Control, a failed hit-test and a visible screenshot overlay (screencaptureui) all
  count, so a click there is refused unless that app is approved.
- When the Accessibility focused-app query fails (seen with Helium), keys and typing
  check the frontmost app instead, with the same approval and sensitive-app checks.
- Finance, medical and health apps (by App Store category) are always refused. So are
  apps whose name or bundle id names a bank, health, government, password manager or
  authenticator.
- One session holds `~/.local/state/desktop-mcp/session.json` at a time. Another
  session's `request_access` is refused until the first releases or exits. Each action
  checks that its session still holds the lock.
- A panel at the bottom right of the main display shows while a session holds access.
  Its Stop button or the Esc key ends the session and drops every approval. The panel
  writes a stop file that the helper checks before each event, so Stop also cuts off an
  action in progress and the actions already queued.

Screenshots fit 1568 px on the long edge and about 1.15 megapixels. The model gives
coordinates in the pixels of the latest screenshot of a display; the server maps them to
display points, so Retina scaling and displays left of or above the main one work.

## T3 Code thread cleanup

A thread that finishes its work settles itself after a final check, as the Workflow
section of `claude/CLAUDE.md` says. Board coordinator threads and Agent-tool subagents are
exempt, and T3 unsettles a thread when new activity arrives. A self-settle starts the
child cascade below and the 7-day settled-worktree cleanup.

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

## Rust build size

Every agent worktree of a Rust repository builds its own `target/` folder. A test build
of agent-board takes about 3 GB with Cargo's defaults and grows with each edit.
`cargo/config.toml` holds user-wide Cargo settings that shrink dev and test builds.
Link it on each Mac:

```sh
mkdir -p ~/.cargo
ln -s ~/.config/cargo/config.toml ~/.cargo/config.toml
```

If `~/.cargo/config.toml` already exists, move its settings into `cargo/config.toml`
first. The settings are:

- `profile.dev.debug = "line-tables-only"`: panics and backtraces keep files and line
  numbers, but a debugger cannot show variables. For a debugging session with full
  debug information, dependencies included, run
  `cargo build --config profile.dev.debug=true --config 'profile.dev.package."*".debug=true'`.
  `CARGO_PROFILE_DEV_DEBUG=true` alone covers only the workspace's own crates, since no
  variable can name the `"*"` package.
- `profile.dev.package."*".debug = false`: dependencies keep no debug information.

They override the same settings in a project's `Cargo.toml`. A project's own
`.cargo/config.toml` and `CARGO_PROFILE_*` variables override them again. Release
builds keep each project's settings.

Measured on agent-board's `cargo test --workspace --no-run` (CPU seconds, on a busy
machine):

| Settings | Size, then after two edits | Full build | Rebuild after an edit |
| --- | --- | --- | --- |
| Cargo defaults | 2.8 GB, 3.2 GB | 316 s | 13.5 s |
| These settings | 2.0 GB, 2.3 GB | 266 s | 14 s |
| These settings without incremental compilation | 1.3 GB, 1.3 GB | 241 s | 54 s |

Incremental compilation stays on. Turning it off saves another 1 GB a worktree but
makes each edit-and-test loop about four times slower. The disk space alert's sweep
instead empties `target/` folders that agents have left idle (see
[Disk space alert](#disk-space-alert)).

One shared `CARGO_TARGET_DIR` for all worktrees would not help. Cargo locks the
whole build folder for each build, so parallel agents would wait on each other. The
worktrees of a repository would also overwrite each other's builds. Cargo's
fine-grained build locking and shared build cache were still unstable in Cargo 1.99.

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

A check logs and sends its alert, critical included, before any sweep starts, so a
slow sweep never delays it. While space is low, the check then removes the scratch
folders of idle Claude Code sessions, `/private/tmp/claude-<uid>/<project>/<session id>`, where Rust `target/`
folders and other build output pile up. A folder qualifies only when nothing in it, in
its transcript or in its subagent transcripts has changed for 24 hours, Claude Code's
registry of running sessions (`~/.claude/sessions`) does not list it, and no running
process names the session or works inside the folder. Anything that cannot be read
keeps the folder, and a sweep that fails does not stop the rest of the run.

The same sweep then empties idle Rust build output in agent worktrees: the cargo
`target/` folders in T3 worktrees (`~/.t3/worktrees/<project>/<name>`, up to six
folders deep, outside hidden folders and `node_modules`) and in the Claude Code
worktrees (`<repo>/.claude/worktrees/<name>`) of the repositories those belong to.
For each folder marked by cargo's `CACHEDIR.TAG`, the sweep first takes every cargo
build lock in it without waiting, and skips the folder when a build holds one. While
it holds the locks, the folder qualifies only when nothing in it has changed for
6 hours (1 hour while space is critical) and no running process names it or works
inside it. The sweep then removes everything in the folder except the tag, the lock
files and the folders that hold them. A build that starts meanwhile waits on those
same locks, then starts afresh in a folder still tagged. The worktree's sources are
never touched; its next build is a full one. `--worktrees` points the sweep at
another folder.

The sweep renames each folder it removes into `~/.local/state/disk-space-alert/trash/`,
so it leaves its place at once, and then deletes it there. If the trash folder cannot
be made or a rename fails, the folder is deleted in place. A sweep stops after
`--sweep-minutes` (5 by default), so the run ends and launchd can start the next
check. Every later check first finishes what the trash still holds, even while space
is ok.

After the sweep, a separate notification says what was removed, and `events.jsonl`
gets a `swept` line listing the folders, plus a `sweep_stopped` line when the time
limit cut it short. `sweep --dry-run` lists what would go now, whatever the free space, `sweep` removes
it and logs it (exiting 1 when either part of the sweep failed), and `--no-sweep` turns the sweep off for a run. A simulated reading
(`check --free-gb`) never sweeps.

Install it on each Mac from the main checkout, which the plist points to, and send a
test alert through both channels:

```sh
uv run --no-project --python 3.11 python -B ~/.config/disk-alert/disk_space_alert.py install
uv run --no-project --python 3.11 python -B ~/.config/disk-alert/disk_space_alert.py test
uv run --no-project --python 3.11 python -B ~/.config/disk-alert/disk_space_alert.py status
```

`install --dry-run` prints the plist without loading it, and `uninstall` unloads and
removes it. To change a threshold, run `install` again with `--low-gb` or
`--critical-gb`; `--sweep-minutes` works the same way. The LaunchAgent runs with
`ProcessType` Standard rather than Background, so macOS does not throttle the sweep.
A one-off run with
`check --free-gb 15 --state-dir <scratch folder>` simulates a reading without touching
the real state.

## Verification

From the repository root, run the focused local suites. The first line installs Playwright
and headless Chromium for the `claude/factory/ui` end-to-end tests. Without it, those tests
skip with a warning. It only downloads what is missing, and git ignores what it installs.

```sh
sh claude/skills/headless-browser/scripts/setup.sh
bun test nvim/tests/bun-outdated.test.js nvim/tests/protect-skim-notes.test.js claude/hooks claude/tests claude/factory claude/marketplace
uv run --no-project --python 3.11 python -B -m unittest discover -s tuios/tests -v
uv run --no-project --python 3.11 python -B ghostty/test-tuios-launcher.py -v
uv run --no-project python -B shell/test-startup-fixes.py -v
uv run --no-project --python 3.11 python -B -m unittest discover -s t3code/tests -v
uv run --no-project --python 3.11 python -B -m unittest discover -s disk-alert/tests -v
uv run --no-project --python 3.11 python -B -m unittest discover -s cargo/tests -v
uv run --no-project --python 3.11 python -B -m unittest discover -s config-sync/tests -v
```

The `claude/tests` suites check the Claude Code configuration. These run offline and
in CI:

- `config.test.js`: agent frontmatter against the delegation policy, files and agents
  that `claude/CLAUDE.md` references, the rules in `claude/reference/` and their
  pointers, hook scripts in `claude/settings.json`, the rules
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
  background task that writes to the suite root after its session ends leaves no root
  behind. One still running after the wait is killed and fails the suite. A
  check that tampers with the fixture when re-run fails, and so do a single-track task
  handed to a subagent and a forbidden guidance read in a subagent. Configuration drift fails
  too. Under `~/.codex/skill-feedback`, records that other sessions append to a skill's
  `notes/` or `verifications/` pass, but an edited, removed or other added file fails.
  A codex-skills release that moves `current` passes when every skill link text is
  unchanged, also through `~/.agents/skills`. A retargeted link or an edit to the old
  release fails. A claimed but unsaved artifact or an unwritable report fails too. So do a review
  the session runs itself, in another agent type, in a worktree, not pinned to the commit
  or through `/code-review`, a follow-up answered only after the review, and a review
  whose outcomes are never recorded. Outcomes recorded before the review
  ends, a real finding recorded as no change needed, and a finding without a category
  also fail. When `~/.claude` links to another checkout, the three location checks
  are skipped with one notice and the other tests still run; from the linked checkout
  they run without it. Each suite holds its own config-sync lock during its session,
  renews it when held again, and removes only its own at teardown, also after a failed
  session.
- `cheatsheets.test.js`: the `cheat-sheets` skill's script against a synthetic page
  and a local server. It checks sections, aliases, item ids, formats, years, ranking,
  the 7-day index cache, the saved-then-online download order and the PDF text copy.
  The PDF check is skipped when `pdftotext` is missing.

The live suites run real `claude -p` sessions against the installed `~/.claude`, using
account quota. Each runs in a fresh fixture folder under one temporary root, blocks
package installs and web access, and removes its folders and session entries
afterwards. Each suite, including the factory's sandbox suite, holds a config-sync lock
until teardown ends, so config-sync does not fast-forward the installed checkout under
the run. A session's background task can outlive it and write to the root, its
`TMPDIR`. So teardown first waits up to 60 seconds (`CLAUDE_LIVE_SETTLE_MS`) for every
process the sessions started to exit. Processes still running then are killed with
their whole process groups, and teardown scans and kills again until none is left. Only
then does it remove the root, and the suite fails with the root's path. Every session passes an explicit `--model` and `--effort`. Behavioral
scenarios use `claude-opus-5-5` at the effort `claude/settings.json` configures for it
(`high`), because skill and tool choices at lower effort don't reflect real sessions;
override with `CLAUDE_LIVE_MODEL` and `CLAUDE_LIVE_EFFORT`. Configuration checks use
`claude-haiku-5-5`. Each suite prints its sessions' cost and its total. A full run
costs about $5.80 and takes about 10 minutes, so run it once before merge:

```sh
RUN_CLAUDE_LIVE=1 bun test claude/tests
```

The sessions always load the installed `~/.claude`, which links to the installed
checkout's `claude/` folder, not the checkout the tests run from. The test code, its
fixtures and its assertions come from the checkout the tests run from.

- From the installed checkout, the live suites test its configuration. Run the full
  set there, after merge and config-sync, to live-test a change to `claude/CLAUDE.md`,
  agents, skills, hooks or settings.
- From a worktree, the suite prints one notice before any session. The notice names
  the installed checkout and says that config changes are live-tested only after merge
  and config-sync. The three location checks in `live.test.js` (`~/.claude` resolves
  to this checkout, and both checks of a session in `nvim/`) are skipped.
- A worktree run is still useful for a change to the suites' own code, such as
  `claude/tests/lib/live.js`, a scenario or its fixtures: run the scenarios that
  change touches against the installed configuration.

While a change is in progress, run only the suite files and scenarios it affects. `-t`
matches a scenario's name:

```sh
RUN_CLAUDE_LIVE=1 bun test claude/tests/live-policy.test.js -t "Python checks run through uv run"
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
  worktree's, passed. The session hands a high-impact commit's review to one
  `reviewer` agent in the background, in the same checkout, with the commit's SHA in its
  prompt and no `/code-review` call. It answers a follow-up question while the review
  runs. The review reaches the reply and leaves the checkout, remote and worktrees as
  they were. After the review, the session records each finding once
  through `ReportFindings`, with a category and an outcome. The real owner-check
  finding is `skipped`, because the checkout stays read-only. The guard hooks block a user-authorized leased force push to the branch the
  remote's HEAD names as its default and a bare
  `python3`, while `uv run python` still runs. A session in a linked worktree cut from a
  stale local main, with origin two commits ahead, gets the `stale-base.js` warning at
  start. Its commit then sits on origin's tip.
- `live-dispatch.test.js`: the Skills section's routing. TypeScript, Rust, Tauri,
  TSX, Vue, chart, built-page, skill-search and article tasks load their skills in
  order, and an Effect review reads only its routed reference. A README fix in a
  TypeScript and Rust repository loads no skill, and the article run saves its draft.
- `live-policy.test.js`: Python checks run through `uv run`, and JavaScript uses
  `bun`, also in a project whose lockfile names another tool. Fixes are re-checked
  independently, reviews stay read-only, and these single-track tasks, one of them a
  rename across several files whose check proves from its own output that it passed
  in the fixture, spawn no subagent. A request to consult Codex runs no `codex`
  command, not even the fixture's stand-in, and the reply says so. No scenario leaves a process running in its
  fixture, and a server the check needs, which detaches itself, is stopped by the time
  the session answers. A Japanese draft is followed by its Chinese meaning, while JSON-only and Chinese-only
  replies stay as asked.
- `live-checkout.test.js`: the main-checkout rule, on a throwaway repository whose
  session `TMPDIR` is a sibling folder, because the guard exempts repositories under
  `TMPDIR`. Asked to commit a fix on a new branch, the session moves to a worktree and
  never adds `-c claude.mainCheckout=allow`. Asked to switch that checkout to a branch,
  it runs the switch with the option itself and does not ask.

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
