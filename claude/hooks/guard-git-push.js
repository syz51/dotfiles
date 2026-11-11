// Claude Code PreToolUse hook for the Bash tool. Enforces the force-push rule in
// ~/.claude/CLAUDE.md: never force-push or delete a default branch, and force-push
// other branches only with an explicit expected-SHA --force-with-lease.
// Exit 2 blocks the command and shows stderr to Claude. A crash is a non-blocking
// hook error, so the guard fails open; a git query that fails unexpectedly blocks
// only pushes that rewrite or delete history. shell.js follows the shell syntax around
// the push: quotes, substitutions, heredocs, `cd`, `sh -c`, wrappers and `ssh`. A push
// whose subcommand, refspec, remote or option name the shell fills in is blocked, as is one
// given push configuration by `-c` or an earlier `git config`; a push without refspecs is
// checked against its remote's push and mirror configuration. A push over `ssh` runs in a
// repository on another host, so the guard reads no local configuration or branch for it
// and judges its refspecs alone. Aliases and GIT_CONFIG_*
// variables are not seen.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { changeDirectory, expands, GIT_VALUE_OPTIONS, visitCommands } from "./shell.js";

const DEFAULT_BRANCHES = ["main", "master"];
const TOO_DEEP = "it nests shell commands too deeply to check.";
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

// Configuration that decides what a push without refspecs sends, and to which remote.
const PUSH_CONFIG = "^(remote\\..+\\.(push|mirror)|remote\\.pushdefault|branch\\..+\\.(pushremote|remote))$";
const isPushConfig = (key) => new RegExp(PUSH_CONFIG, "i").test(key);
const isTrue = (value) => /^(?:true|yes|on|1|)$/i.test(value);

function parsePush(args) {
  const push = { force: false, leases: [], mirror: false, all: false, tags: false, remove: false, dryRun: false, repo: undefined, positionals: [], unresolved: undefined };
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
      else if (name === "--tags") push.tags = true;
      else if (name === "--no-tags") push.tags = false;
      else if (name === "--repo") {
        // --repo names the remote, as the first positional does.
        push.repo = value ?? args[++i];
        if (push.repo !== undefined && expands(push.repo)) push.unresolved ??= arg;
      } else if (PUSH_VALUE_OPTIONS.has(name) && value === undefined) i += 1;
    } else if (arg.startsWith("-") && arg.length > 1) {
      // Letters up to -o, whose value is the rest of the word, are options.
      if (expands(arg.slice(0, arg.indexOf("o") === -1 ? arg.length : arg.indexOf("o") + 1))) push.unresolved ??= arg;
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
  if (target.startsWith("refs/") && !target.startsWith("refs/heads/")) return { other: true };
  if (target.includes("*")) return { all: true };
  if (target === "@{push}") return pushTarget();
  if (target === "HEAD" || target === "@") return current();
  return { name: target.startsWith("refs/heads/") ? target.slice("refs/heads/".length) : target };
}

/**
 * What a `git push [remote]` without refspecs uses from the configuration: the remote it pushes
 * to (`remote`), that remote's push refspecs (`specs`, which git pushes instead of the current
 * branch) and whether it mirrors (`mirror`).
 */
function pushConfig(remote, query, branch) {
  const lines = query(["config", "--get-regexp", PUSH_CONFIG]);
  const config = (lines ?? "").split("\n").map((line) => {
    const space = line.indexOf(" ");
    return space === -1 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)];
  });
  const value = (key) => config.findLast(([name]) => name === key)?.[1];
  let name = remote;
  if (name === undefined && lines !== undefined) {
    // git push picks branch.<current>.pushRemote, remote.pushDefault, branch.<current>.remote, then origin.
    const forBranch = (key) => (branch() === undefined ? undefined : value(`branch.${branch()}.${key}`));
    name = forBranch("pushremote") ?? value("remote.pushdefault") ?? forBranch("remote");
  }
  name ??= "origin";
  const mirror = value(`remote.${name}.mirror`);
  return { remote: name, specs: config.filter(([key]) => key === `remote.${name}.push`).map(([, spec]) => spec), mirror: mirror !== undefined && isTrue(mirror) };
}

function judge(push, dir, git, configChanged) {
  if (push.unresolved !== undefined) {
    return `the shell fills in \`${push.unresolved}\`, so the guard cannot see what it pushes. Write the remote, refspecs and options out literally.`;
  }
  let [remote, ...refspecs] = push.positionals;
  remote ??= push.repo;
  const query = (args) => (dir === undefined ? undefined : git(dir, args));
  let head;
  const branch = () => (head ??= { name: query(["symbolic-ref", "--quiet", "--short", "HEAD"]) }).name;
  let specs = refspecs;
  let mirror = push.mirror;
  if (push.tags && refspecs.length === 0) {
    specs = ["refs/tags/*"]; // --tags is a refspec, so git reads no push configuration
  } else if (!push.mirror && !push.all && refspecs.length === 0) {
    if (configChanged) return "an earlier command changes the push configuration, which the guard reads before anything runs. Push with an explicit refspec.";
    try {
      const config = pushConfig(remote, query, branch);
      ({ remote, specs } = config);
      mirror = config.mirror;
    } catch (error) {
      // A plain push may go ahead, as when any other query fails; only a rewrite is blocked.
      if (push.force || push.leases.length > 0 || push.remove) return `git could not read the push configuration (${error.message}).`;
      return undefined;
    }
  }
  const updates = [];
  if (mirror || push.all) {
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
  const forced = push.force || mirror || updates.some((update) => update.plus);
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
    const current = () => (branch() === undefined ? { unknown: true } : { name: branch() });
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

/** `state.configChanged` records a `git config` earlier in the same command that sets push configuration. */
function gitPush(words, dir, git, state, remote) {
  let i = 1;
  let pushConfigOption;
  while (i < words.length && words[i].startsWith("-")) {
    // A repository on another host is unknown here, whatever path -C names.
    if (words[i] === "-C" && i + 1 < words.length && !remote) dir = changeDirectory(dir, words[i + 1]);
    // `-c key=value` and `--config-env key=VAR` set configuration for this one command.
    const setting = words[i] === "-c" || words[i] === "--config-env" ? words[i + 1] : /^--config-env=(.*)$/s.exec(words[i])?.[1];
    if (setting !== undefined && (expands(setting) || isPushConfig(setting.split("=")[0]))) pushConfigOption ??= setting;
    i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  if (words[i] === "config" && words.slice(i + 1).some(isPushConfig)) state.configChanged = true;
  const fail = (reason) => `\`${words.join(" ")}\`: ${reason}`;
  if (words[i] !== undefined && expands(words[i])) return fail(`the shell fills in the git subcommand \`${words[i]}\`, so the guard cannot see whether it pushes.`);
  if (words[i] !== "push") return undefined;
  if (pushConfigOption !== undefined) return fail(`\`${pushConfigOption}\` sets push configuration the guard does not read. Push with an explicit refspec and no -c.`);
  const push = parsePush(words.slice(i + 1));
  // A word the shell fills in could turn the dry run off, as --no-dry-run does.
  if (push.dryRun && push.unresolved === undefined) return undefined;
  const reason = judge(push, dir, git, state.configChanged);
  return reason && fail(reason);
}

/**
 * Returns why `command` must not run, or undefined when it may. `git(dir, args)` returns trimmed
 * stdout, undefined when git reports that the ref, upstream, or branch does not exist, and throws
 * when git could not answer. A script nested too deeply to check is blocked. A command whose name
 * the shell fills in, as in `$GIT push`, is checked as git when a later word is `push`.
 */
export function findViolation(command, cwd, git) {
  const state = { configChanged: false };
  return visitCommands(command, cwd, (words, dir, { remote }) => (basename(words[0]) === "git" || (expands(words[0]) && words.includes("push"))
    ? gitPush(words, dir, git, state, remote)
    : undefined), TOO_DEEP);
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
