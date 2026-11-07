// Claude Code PreToolUse hook for the Bash tool. Enforces the force-push rule in
// ~/.claude/CLAUDE.md: never force-push or delete a default branch, and force-push
// other branches only with an explicit expected-SHA --force-with-lease.
// Exit 2 blocks the command and shows stderr to Claude. A crash is a non-blocking
// hook error, so the guard fails open; a git query that fails unexpectedly blocks
// only pushes that rewrite or delete history. shell.js follows the shell syntax around
// the push: quotes, substitutions, heredocs, `cd`, `sh -c`, wrappers and `ssh`. A push
// whose refspec, remote or option name the shell fills in from a variable or substitution
// is blocked, and a push without refspecs is checked against remote.<name>.push.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { changeDirectory, visitCommands } from "./shell.js";

const DEFAULT_BRANCHES = ["main", "master"];
const TOO_DEEP = "it nests shell commands too deeply to check.";
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
// `git push -h`; git accepts any unambiguous prefix of these.
const PUSH_OPTIONS = ["--all", "--atomic", "--branches", "--delete", "--dry-run", "--exec", "--follow-tags", "--force",
  "--force-if-includes", "--force-with-lease", "--ipv4", "--ipv6", "--mirror", "--porcelain", "--progress", "--prune",
  "--push-option", "--quiet", "--receive-pack", "--recurse-submodules", "--repo", "--set-upstream", "--signed",
  "--tags", "--thin", "--verbose", "--verify", "--no-verify", "--no-all", "--no-atomic", "--no-branches", "--no-delete",
  "--no-dry-run", "--no-exec", "--no-follow-tags", "--no-force", "--no-force-if-includes", "--no-force-with-lease",
  "--no-mirror", "--no-porcelain", "--no-progress", "--no-prune", "--no-push-option", "--no-quiet", "--no-receive-pack",
  "--no-recurse-submodules", "--no-repo", "--no-set-upstream", "--no-signed", "--no-tags", "--no-thin", "--no-verbose"];
const PUSH_VALUE_OPTIONS = new Set(["--repo", "--receive-pack", "--exec", "--push-option"]);
const REWRITING_OPTIONS = ["--force", "--force-with-lease", "--mirror", "--delete"];

function longOption(name) {
  if (PUSH_OPTIONS.includes(name)) return name;
  const matches = PUSH_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length === 1) return matches[0];
  // Git rejects an ambiguous abbreviation, but a prefix of a rewriting option is never read as harmless.
  return matches.find((option) => REWRITING_OPTIONS.includes(option)) ?? name;
}

/** Whether the shell expands `word` (a variable or command substitution), so its value is unknown here. */
const expands = (word) => /[$`]/.test(word);

function parsePush(args) {
  const push = { force: false, leases: [], mirror: false, all: false, remove: false, dryRun: false, positionals: [], unresolved: undefined };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      push.positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      // An option's value may come from a variable, as in --force-with-lease=main:$SHA; its name may not.
      if (expands(equals === -1 ? arg : arg.slice(0, equals))) push.unresolved ??= arg;
      const name = longOption(equals === -1 ? arg : arg.slice(0, equals));
      const value = equals === -1 ? undefined : arg.slice(equals + 1);
      if (name === "--force") push.force = true;
      else if (name === "--no-force") push.force = false;
      else if (name === "--force-with-lease") push.leases.push(value);
      else if (name === "--no-force-with-lease") push.leases = [];
      else if (name === "--mirror") push.mirror = true;
      else if (name === "--no-mirror") push.mirror = false;
      else if (name === "--all" || name === "--branches") push.all = true;
      else if (name === "--no-all" || name === "--no-branches") push.all = false;
      else if (name === "--delete") push.remove = true;
      else if (name === "--no-delete") push.remove = false;
      else if (name === "--dry-run") push.dryRun = true;
      else if (name === "--no-dry-run") push.dryRun = false;
      else if (PUSH_VALUE_OPTIONS.has(name) && value === undefined) i += 1;
    } else if (arg.startsWith("-") && arg.length > 1) {
      if (expands(arg)) push.unresolved ??= arg;
      for (let k = 1; k < arg.length; k += 1) {
        if (arg[k] === "f") push.force = true;
        else if (arg[k] === "d") push.remove = true;
        else if (arg[k] === "n") push.dryRun = true;
        else if (arg[k] === "o") {
          if (k === arg.length - 1) i += 1; // -o <option>
          break;
        }
      }
    } else {
      push.positionals.push(arg);
    }
  }
  push.unresolved ??= push.positionals.find(expands);
  return push;
}

/** The branch a refspec destination names: { all }, { name }, { other } for tags and other refs, or { unknown }. */
function branchOf(target, current, pushTarget) {
  if (target.includes("*")) return { all: true };
  if (target === "@{push}") return pushTarget();
  if (target === "HEAD" || target === "@") return current();
  if (target.startsWith("refs/heads/")) return { name: target.slice("refs/heads/".length) };
  return target.startsWith("refs/") ? { other: true } : { name: target };
}

/**
 * The push refspecs configured for the remote a refspec-less `git push [remote]` uses
 * (remote.<name>.push), which git pushes instead of the current branch; [] when there are none.
 */
function configuredRefspecs(remote, query) {
  const lines = query(["config", "--get-regexp", "^(remote\\..+\\.push|remote\\.pushdefault|branch\\..+\\.(pushremote|remote))$"]);
  const config = (lines ?? "").split("\n").map((line) => {
    const space = line.indexOf(" ");
    return space === -1 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)];
  });
  const values = (key) => config.filter(([name]) => name === key).map(([, value]) => value);
  if (!config.some(([name]) => /^remote\..+\.push$/.test(name))) return [];
  let name = remote;
  if (name === undefined) {
    // git push picks branch.<current>.pushRemote, remote.pushDefault, branch.<current>.remote, then origin.
    const branch = query(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const forBranch = (key) => (branch === undefined ? undefined : values(`branch.${branch}.${key}`).at(-1));
    name = forBranch("pushremote") ?? values("remote.pushdefault").at(-1) ?? forBranch("remote") ?? "origin";
  }
  return values(`remote.${name}.push`);
}

function judge(push, dir, git) {
  if (push.unresolved !== undefined) {
    return `the shell fills in \`${push.unresolved}\`, so the guard cannot see what it pushes. Write the remote, refspecs and options out literally.`;
  }
  const [remote, ...refspecs] = push.positionals;
  const query = (args) => (dir === undefined ? undefined : git(dir, args));
  let specs = refspecs;
  if (!push.mirror && !push.all && refspecs.length === 0) {
    try {
      specs = configuredRefspecs(remote, query);
    } catch (error) {
      // A plain push may go ahead, as when any other query fails; only a rewrite is blocked.
      if (push.force || push.leases.length > 0 || push.remove) return `git could not read the configured push refspecs (${error.message}).`;
      return undefined;
    }
  }
  const updates = [];
  if (push.mirror || push.all) {
    updates.push({ target: "*", plus: false, remove: false });
  } else if (specs.length === 0) {
    updates.push({ target: "@{push}", plus: false, remove: push.remove });
  } else {
    for (const spec of specs) {
      const plus = spec.startsWith("+");
      const body = plus ? spec.slice(1) : spec;
      const colon = body.indexOf(":");
      // A bare `:` pushes every branch that exists on both sides.
      if (body === ":") updates.push({ target: "*", plus, remove: false });
      else updates.push({ target: push.remove || colon === -1 ? body : body.slice(colon + 1), plus, remove: push.remove || colon === 0 });
    }
  }
  const forced = push.force || push.mirror || updates.some((update) => update.plus);
  const rewriting = forced || push.leases.length > 0;
  const risky = updates.filter((update) => rewriting || update.remove);
  if (risky.length === 0) return undefined;

  let defaults;
  let branches;
  try {
    const remoteName = remote !== undefined && /^[\w.-]+$/.test(remote) ? remote : "origin";
    defaults = new Set(DEFAULT_BRANCHES);
    const remoteHead = query(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remoteName}/HEAD`]);
    if (remoteHead?.startsWith(`${remoteName}/`)) defaults.add(remoteHead.slice(remoteName.length + 1));
    const current = () => {
      const name = query(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      return name === undefined ? { unknown: true } : { name };
    };
    const pushTarget = () => {
      const target = query(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"]);
      return target?.includes("/") ? { name: target.slice(target.indexOf("/") + 1) } : current();
    };
    branches = risky.map((update) => ({ ...update, branch: branchOf(update.target, current, pushTarget) }));
  } catch (error) {
    return `git could not confirm which branch it changes (${error.message}).`;
  }

  const hit = branches.find(({ branch }) => branch.all || defaults.has(branch.name));
  if (hit) {
    const what = hit.branch.all ? "every branch, including the default branch" : `${hit.branch.name}, a default branch`;
    return `it ${hit.remove && !rewriting ? "deletes" : "force-pushes"} ${what}. Never force-push or delete a default branch.`;
  }
  if (branches.some(({ branch }) => branch.unknown)) {
    return "it rewrites or deletes a branch that could not be determined. Name the branch in the refspec.";
  }
  if (forced) {
    return "it is a plain force push. Rewrite pushed history only when the user authorizes it, then use --force-with-lease=<branch>:<expected-sha>.";
  }
  if (push.leases.some((lease) => !lease?.includes(":"))) {
    return "--force-with-lease needs an explicit expected SHA: use --force-with-lease=<branch>:<expected-sha>.";
  }
  return undefined;
}

function gitPush(words, dir, git) {
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    if (words[i] === "-C" && i + 1 < words.length) dir = changeDirectory(dir, words[i + 1]);
    i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  if (words[i] !== "push") return undefined;
  const push = parsePush(words.slice(i + 1));
  if (push.dryRun) return undefined;
  const reason = judge(push, dir, git);
  return reason && `\`${words.join(" ")}\`: ${reason}`;
}

/**
 * Returns why `command` must not run, or undefined when it may. `git(dir, args)` returns trimmed
 * stdout, undefined when git reports that the ref, upstream, or branch does not exist, and throws
 * when git could not answer. A script nested too deeply to check is blocked.
 */
export function findViolation(command, cwd, git) {
  return visitCommands(command, cwd, (words, dir) => (basename(words[0]) === "git" ? gitPush(words, dir, git) : undefined), TOO_DEEP);
}

function runGit(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`git was stopped by ${result.signal}`);
  if (result.status !== 0) return undefined; // the ref, upstream, or branch does not exist
  return result.stdout.trim() || undefined;
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const command = input?.tool_input?.command;
  if (typeof command === "string" && /\bgit\b/.test(command) && /\bpush\b/.test(command)) {
    const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
    const violation = findViolation(command, cwd, runGit);
    if (violation) {
      process.stderr.write(`Blocked by the guard-git-push hook: ${violation}\n`);
      process.exit(2);
    }
  }
}
