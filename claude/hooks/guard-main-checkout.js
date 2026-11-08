// Claude Code PreToolUse hook for the Bash tool. Enforces the Workflow rule in
// ~/.claude/CLAUDE.md: a repository's main checkout is shared by every thread that starts
// in it, so a session moves into its own worktree before it changes branches there. In a
// main checkout (its git dir is the common git dir) it blocks commands that switch, move or
// reset the checked-out branch or set work aside: git switch, checkout of a branch, a
// discarding checkout -f, reset to another commit or with --hard/--keep/--merge/--soft,
// merge, rebase, pull, stash, bisect and gh pr checkout. Their read-only, continue and abort
// forms, file restores, fast-forward-only merges and pulls (see fastForwardOnly), a switch to
// the default branch with no tracked changes, every command in a linked worktree and every
// repository in a temporary directory still run. When the user asked for the change in that
// checkout, the agent runs that one git command with `-c claude.mainCheckout=allow`, which
// the guard lets through; the block message says so, so agents never hand the command back
// to the user. The user can allow every such command for one repository with
// `git config claude.mainCheckout allow`, which the guard refuses to let a session run.
// This is a guardrail against mistakes, not a security
// boundary: it cannot see aliases, scripts or direct edits of .git/config. Exit 2 blocks
// the command and shows stderr to Claude. The guard fails open: on a crash, on a script
// nested too deeply, and when it cannot tell the repository.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { changeDirectory, GIT_VALUE_OPTIONS, visitCommands } from "./shell.js";

const OVERRIDE_KEY = "claude.maincheckout"; // git config keys ignore case
// `git -c claude.mainCheckout=allow <command>`: the user asked for this one change here.
const USER_ASKED = `${OVERRIDE_KEY}=allow`;
// Forms that finish, end or inspect an operation in progress rather than start one.
const SAFE_FORMS = {
  merge: ["--abort", "--quit", "--continue"],
  rebase: ["--abort", "--quit", "--continue", "--skip", "--edit-todo", "--show-current-patch"],
};
const SAFE_SUBCOMMANDS = {
  stash: ["list", "show"],
  bisect: ["log", "view", "visualize", "reset", "terms", "help"],
};
const MOVING_RESETS = ["--hard", "--keep", "--merge", "--soft"];
const FF_MODES = ["--ff", "--no-ff", "--ff-only"];
// Options that leave a --ff-only merge or pull a fast-forward: output, and turning rebase,
// autostash and the editor off.
const FAST_FORWARD_OPTIONS = new Set([...FF_MODES, "-q", "--quiet", "-v", "--verbose", "--stat", "-n", "--no-stat",
  "--progress", "--no-progress", "--no-edit", "--no-autostash", "--no-rebase", "--rebase=false"]);
const HINTS = {
  checkout: " To restore files, use `git restore <path>` or `git checkout -- <path>`."
    + " A switch to the default branch may run here when no tracked file has changes.",
  switch: " A switch to the default branch may run here when no tracked file has changes.",
  reset: " To unstage files, use `git restore --staged <path>` or `git reset -- <path>`.",
  merge: " A fast-forward, `git merge --ff-only <commit>`, may run here.",
  pull: " A fast-forward, `git pull --ff-only`, may run here.",
};
const CONFIG_WRITES = ["set", "unset", "rename-section", "remove-section", "edit", "--unset", "--unset-all", "--add",
  "--replace-all", "--rename-section", "--remove-section", "--edit", "-e"];

/** Whether `arg` is long option `name`, git's unambiguous-prefix spelling of it, or either with `=value`. */
const isLong = (arg, name) => {
  const option = arg.split("=")[0];
  return option.length > 3 && name.startsWith(option);
};
// A short-option word such as -fq or -bfeature: its letters, or "" for any other word.
const shortLetters = (arg) => (/^-[a-zA-Z]/.test(arg) ? arg.slice(1) : "");

/** Whether `git checkout args` switches or detaches the branch, or discards every change. */
function checkoutChanges(args) {
  const dash = args.indexOf("--");
  const options = dash < 0 ? args : args.slice(0, dash);
  let force = false;
  let positional = 0;
  for (let i = 0; i < options.length; i++) {
    const arg = options[i];
    if (arg === "-") return true; // the previous branch
    if (arg.startsWith("--")) {
      if (isLong(arg, "--orphan") || isLong(arg, "--detach")) return true;
      if (isLong(arg, "--patch") || isLong(arg, "--pathspec-from-file")) return false;
      if (isLong(arg, "--force")) force = true;
      if (isLong(arg, "--conflict") && !arg.includes("=")) i++;
    } else if (shortLetters(arg)) {
      // -b and -B take the branch name as the rest of the word or the next word.
      const letters = shortLetters(arg);
      if (/[bB]/.test(letters)) return true;
      if (letters.includes("p")) return false;
      if (letters.includes("f")) force = true;
    } else {
      positional++;
    }
  }
  // `[<tree-ish>] -- <paths>` and `<tree-ish> <paths>` restore files; one bare word may be a branch.
  if (dash >= 0 && dash < args.length - 1) return false;
  return positional === 1 || (positional === 0 && force);
}

/**
 * Whether `git merge` or `git pull` with `args` only fast-forwards. It is an allowlist: the
 * last of --ff, --no-ff and --ff-only is --ff-only, every option is in FAST_FORWARD_OPTIONS
 * (spelled out, as abbreviations and values are not followed), and no refspec forces (`+a`)
 * or names a destination (`a:b`), which pull's fetch would force-update. Anything else, such
 * as a strategy (`-s ours` merges even with --ff-only), --autostash or --squash, is an
 * ordinary merge or pull.
 */
function fastForwardOnly(args) {
  let mode;
  let afterDash = false;
  for (const arg of args) {
    if (!afterDash && arg === "--") afterDash = true;
    else if (afterDash || !arg.startsWith("-") || arg === "-") {
      if (arg.startsWith("+") || arg.includes(":")) return false;
    } else if (/^-[a-zA-Z]{2,}$/.test(arg)) {
      if (![...arg.slice(1)].every((letter) => FAST_FORWARD_OPTIONS.has(`-${letter}`))) return false;
    } else if (!FAST_FORWARD_OPTIONS.has(arg)) {
      return false;
    } else if (FF_MODES.includes(arg)) {
      mode = arg;
    }
  }
  return mode === "--ff-only";
}

/** Whether `git reset args` moves the branch or discards changes; resetting paths in the index does neither. */
function resetChanges(args) {
  const dash = args.indexOf("--");
  const options = dash < 0 ? args : args.slice(0, dash);
  if (options.some((arg) => MOVING_RESETS.some((name) => isLong(arg, name)))) return true;
  if (dash >= 0 && dash < args.length - 1) return false;
  if (options.some((arg) => isLong(arg, "--patch") || isLong(arg, "--pathspec-from-file") || shortLetters(arg).includes("p"))) return false;
  const positional = options.filter((arg) => !arg.startsWith("-"));
  return positional.length === 1 && !["HEAD", "@"].includes(positional[0]);
}

/** Whether git `subcommand` with `args` switches, moves or resets the branch, or sets work aside. */
export function changesBranch(subcommand, args) {
  switch (subcommand) {
    case "switch":
      return true;
    // A fast-forward only moves the branch ahead along its own history, so it may run.
    case "pull":
      return !fastForwardOnly(args);
    case "merge":
      return !fastForwardOnly(args) && !args.some((arg) => SAFE_FORMS.merge.some((name) => isLong(arg, name)));
    case "rebase":
      return !args.some((arg) => SAFE_FORMS.rebase.some((name) => isLong(arg, name)));
    case "stash":
    case "bisect":
      // `git stash -- <paths>` is a push.
      return !SAFE_SUBCOMMANDS[subcommand].includes(args[0] ?? "");
    case "reset":
      return resetChanges(args);
    case "checkout":
      return checkoutChanges(args);
    default:
      return false;
  }
}

/** Whether `git config args` writes the override key. */
function setsOverride(args) {
  const at = args.findIndex((arg) => arg.toLowerCase() === OVERRIDE_KEY);
  if (at < 0) return false;
  return args.some((arg) => CONFIG_WRITES.includes(arg)) || args.slice(at + 1).some((arg) => !arg.startsWith("-"));
}

/**
 * Why a command that changes the branch of `dir` must not run there, or undefined. `git(dir, args)`
 * returns trimmed stdout, or undefined when git fails (not a repository, no such config).
 */
function mainCheckoutReason(dir, git, tempRoots, hint) {
  const lines = git(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"])?.split("\n");
  if (lines?.length !== 3 || resolve(lines[0]) !== resolve(lines[1])) return undefined;
  const top = resolve(lines[2]);
  // A repository in a temporary directory is a session's own scratch copy, not a shared checkout.
  if (tempRoots.some((root) => top === root || top.startsWith(root + sep))) return undefined;
  if (git(dir, ["config", "--get", OVERRIDE_KEY])?.toLowerCase() === "allow") return undefined;
  return `it changes the branch of ${top}, a main checkout other threads share. `
    + `Move into your own worktree first (EnterWorktree in Claude Code, a worktree thread in T3) and run it there.${hint} `
    + "If the user asked for this change in this checkout, run it yourself as `git -c claude.mainCheckout=allow <subcommand> ...` "
    + "(for `gh pr checkout`, fetch the pull request's branch and switch to it that way); never ask the user to run it. "
    + "Do not run it from a script to get past this guard.";
}

/**
 * Whether `git switch` or `git checkout` with `args` moves `dir` back to its default branch
 * (origin/HEAD's name) while no tracked file has changes, so it loses nothing.
 */
function switchesToCleanDefault(subcommand, args, dir, git) {
  if (!["switch", "checkout"].includes(subcommand)) return false;
  const words = args.filter((arg) => arg !== "-q" && arg !== "--quiet");
  if (words.length !== 1 || words[0].startsWith("-")) return false;
  const remoteHead = git(dir, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  if (remoteHead !== `origin/${words[0]}`) return false;
  // Porcelain v2 with --branch always prints `# branch.*` headers, so empty output is a failure.
  const status = git(dir, ["status", "--porcelain=v2", "--branch", "--untracked-files=no"]);
  return status !== undefined && status.split("\n").every((line) => line.startsWith("#"));
}

function gitCommand(words, dir, git, tempRoots) {
  let i = 1;
  let unknownRepo = false;
  let configured = false;
  let userAsked = false;
  while (i < words.length && words[i].startsWith("-")) {
    if (words[i] === "-C" && i + 1 < words.length) dir = changeDirectory(dir, words[i + 1]);
    if (/^--(?:git-dir|work-tree)(?:=|$)/.test(words[i])) unknownRepo = true;
    // `-c merge.autostash=true` and the like can turn a fast-forward into something else.
    if (words[i] === "-c" || /^--config-env(?:=|$)/.test(words[i])) configured = true;
    if (words[i] === "-c" && words[i + 1]?.toLowerCase() === USER_ASKED) userAsked = true;
    i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  const [subcommand, ...args] = words.slice(i);
  if (subcommand === "config" && setsOverride(args))
    return "claude.mainCheckout is the user's switch for the guard-main-checkout hook. Only the user sets it.";
  if (userAsked) return undefined;
  const configuredFastForward = configured && ["merge", "pull"].includes(subcommand) && fastForwardOnly(args);
  if (!(changesBranch(subcommand, args) || configuredFastForward) || unknownRepo || dir === undefined) return undefined;
  const reason = mainCheckoutReason(dir, git, tempRoots, HINTS[subcommand] ?? "");
  return reason && !switchesToCleanDefault(subcommand, args, dir, git) ? reason : undefined;
}

/**
 * Returns why `command` run from `cwd` must not run, or undefined when it may. Repositories under
 * `tempRoots` (absolute, resolved paths) are never treated as shared.
 */
export function findMainCheckoutViolation(command, cwd, git, tempRoots = []) {
  return visitCommands(command, cwd, (words, dir) => {
    // macOS volumes ignore case, so GIT and Git run git too.
    const name = basename(words[0]).toLowerCase();
    let reason;
    if (name === "git") reason = gitCommand(words, dir, git, tempRoots);
    else if (name === "gh" && words[1] === "pr" && ["checkout", "co"].includes(words[2]) && dir !== undefined)
      reason = mainCheckoutReason(dir, git, tempRoots, "");
    return reason && `\`${words.join(" ")}\`: ${reason}`;
  });
}

function runGit(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
  if (result.error || result.signal || result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

// The system temporary directory and Claude Code's per-user scratch folder under /tmp.
function tempRoots() {
  const roots = [tmpdir(), join("/tmp", `claude-${userInfo().uid}`)];
  return roots.filter((root) => existsSync(root)).map((root) => realpathSync(root));
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const command = input?.tool_input?.command;
  // A cheap prefilter on the text with quotes and backslashes removed, so g"i"t is seen.
  if (typeof command === "string" && /\b(?:git|gh)\b/i.test(command.replace(/["'\\]/g, ""))) {
    const violation = findMainCheckoutViolation(command, typeof input.cwd === "string" ? input.cwd : process.cwd(), runGit, tempRoots());
    if (violation) {
      process.stderr.write(`Blocked by the guard-main-checkout hook: ${violation}\n`);
      process.exit(2);
    }
  }
}
