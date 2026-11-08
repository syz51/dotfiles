// Claude Code PreToolUse hook for the Bash tool. Enforces the Workflow rule in
// ~/.claude/CLAUDE.md: a repository's main checkout is shared by every thread that starts
// in it, so a session moves into its own worktree before it changes branches there. In a
// main checkout (its git dir is the common git dir) it blocks git commands that switch or
// move the checked-out branch or set work aside: switch, checkout of a branch, reset
// --hard/--keep/--merge/--soft, merge, rebase, pull and stash. Their read-only and abort
// forms, and every command in a linked worktree, still run. The user can allow them for one
// repository with `git config claude.mainCheckout allow`, which this guard never lets a
// session set, or run the command themselves. Exit 2 blocks the command and shows stderr to
// Claude; a crash is a non-blocking hook error, so the guard fails open.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { changeDirectory, visitCommands } from "./shell.js";

const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
const OVERRIDE_KEY = "claude.mainCheckout";
const TOO_DEEP = "it nests shell commands too deeply to check.";
// Forms that end or inspect an operation rather than start one.
const SAFE_FORMS = {
  merge: ["--abort", "--quit"],
  rebase: ["--abort", "--quit", "--show-current-patch"],
  stash: ["list", "show"],
};
const MOVING_RESETS = ["--hard", "--keep", "--merge", "--soft"];
// git checkout options that take a value as the next word.
const CHECKOUT_VALUE_OPTIONS = new Set(["-b", "-B", "--orphan", "--conflict", "--pathspec-from-file"]);

/** Whether `args` (after the subcommand) make the subcommand move the branch or set work aside. */
export function changesBranch(subcommand, args) {
  const first = args.find((arg) => arg !== "--") ?? "";
  switch (subcommand) {
    case "switch":
    case "pull":
      return true;
    case "merge":
    case "rebase":
      return !args.some((arg) => SAFE_FORMS[subcommand].includes(arg));
    case "stash":
      return !SAFE_FORMS.stash.includes(first);
    case "reset":
      return args.some((arg) => MOVING_RESETS.includes(arg));
    case "checkout": {
      // `git checkout [<tree-ish>] -- <paths>` and `-p` restore files; anything else names a branch or commit.
      if (args.includes("--") || args.some((arg) => arg === "-p" || arg === "--patch" || arg.startsWith("--pathspec-from-file"))) return false;
      if (args.some((arg) => ["-b", "-B", "--orphan", "--detach"].includes(arg))) return true;
      for (let i = 0; i < args.length; i++) {
        if (CHECKOUT_VALUE_OPTIONS.has(args[i])) i++;
        else if (args[i] === "-" || !args[i].startsWith("-")) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/**
 * Why `git` command `words` run in `dir` must not run, or undefined. `git(dir, args)` returns
 * trimmed stdout, or undefined when git fails (not a repository, no such config).
 */
function gitCommand(words, dir, git) {
  let i = 1;
  let unknownRepo = false;
  while (i < words.length && words[i].startsWith("-")) {
    if (words[i] === "-C" && i + 1 < words.length) dir = changeDirectory(dir, words[i + 1]);
    if (/^--(?:git-dir|work-tree)(?:=|$)/.test(words[i])) unknownRepo = true;
    i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  const [subcommand, ...args] = words.slice(i);
  const fail = (reason) => `\`${words.join(" ")}\`: ${reason}`;
  // Config keys ignore case; a read (get, list, --get-all, ...) of the key is fine.
  if (subcommand === "config" && args.some((arg) => arg.toLowerCase().startsWith(OVERRIDE_KEY.toLowerCase()))
    && !args.some((arg) => /^(?:--get|--list|get$|list$)/.test(arg)))
    return fail(`${OVERRIDE_KEY} is the user's switch for this guard. Only the user sets it.`);
  if (!changesBranch(subcommand, args) || unknownRepo || dir === undefined) return undefined;
  const dirs = git(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])?.split("\n");
  if (dirs?.length !== 2 || resolve(dirs[0]) !== resolve(dirs[1])) return undefined;
  if (git(dir, ["config", "--get", OVERRIDE_KEY])?.toLowerCase() === "allow") return undefined;
  const restore = subcommand === "checkout" ? " To restore files, use `git restore <path>` or `git checkout -- <path>`." : "";
  return fail(`it changes the branch of ${git(dir, ["rev-parse", "--show-toplevel"]) ?? dir}, a main checkout other threads share. `
    + "Move into your own worktree first (EnterWorktree in Claude Code, a worktree thread in T3) and run it there."
    + `${restore} If the user asked for it here, they can run it themselves or allow it for this repository with \`git config ${OVERRIDE_KEY} allow\`.`);
}

/** Returns why `command` run from `cwd` must not run, or undefined when it may. */
export function findMainCheckoutViolation(command, cwd, git) {
  return visitCommands(command, cwd, (words, dir) => (basename(words[0]) === "git" ? gitCommand(words, dir, git) : undefined), TOO_DEEP);
}

function runGit(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
  if (result.error || result.signal || result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const command = input?.tool_input?.command;
  // A cheap prefilter on the text with quotes and backslashes removed, so g"i"t is seen.
  if (typeof command === "string" && /\bgit\b/.test(command.replace(/["'\\]/g, ""))) {
    const violation = findMainCheckoutViolation(command, typeof input.cwd === "string" ? input.cwd : process.cwd(), runGit);
    if (violation) {
      process.stderr.write(`Blocked by the guard-main-checkout hook: ${violation}\n`);
      process.exit(2);
    }
  }
}
