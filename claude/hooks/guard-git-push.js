// Claude Code PreToolUse hook for the Bash tool. Enforces the force-push rule in
// ~/.claude/CLAUDE.md: never force-push or delete a default branch, and force-push
// other branches only with an explicit expected-SHA --force-with-lease.
// Exit 2 blocks the command and shows stderr to Claude. A crash is a non-blocking
// hook error, so the guard fails open; a git query that fails unexpectedly blocks
// only pushes that rewrite or delete history. It follows shell syntax (quotes,
// substitutions, heredocs, redirections, `cd`, `sh -c`, wrappers) but cannot see
// through git aliases, script files, or expanded variables.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const DEFAULT_BRANCHES = ["main", "master"];
const MAX_DEPTH = 8;
const TOO_DEEP = "it nests shell commands too deeply to check.";
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_VALUE_OPTIONS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const SHELL_KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"]);
// Commands that run another command, with their options that take a separate value.
const WRAPPERS = {
  arch: ["-e", "-arch"],
  builtin: [],
  caffeinate: ["-t", "-w"],
  command: [],
  doas: ["-u", "-C"],
  env: ["-u", "-P", "--unset"],
  exec: ["-a"],
  nice: ["-n"],
  nohup: [],
  stdbuf: ["-i", "-o", "-e"],
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"],
  time: ["-f", "-o"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  xargs: ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--replace",
    "--max-lines", "--max-args", "--max-procs", "--max-chars"],
  xcrun: ["--sdk", "--toolchain"],
};
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

/** Index just past the `)` closing a `$(` whose body starts at `start`. */
function closeSubstitution(source, start) {
  let depth = 1;
  let i = start;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") i += 2;
    else if (c === "'") i = source.indexOf("'", i + 1) === -1 ? source.length : source.indexOf("'", i + 1) + 1;
    else {
      if (c === "(") depth += 1;
      else if (c === ")" && (depth -= 1) === 0) return i + 1;
      i += 1;
    }
  }
  return source.length;
}

/**
 * Splits shell source into simple commands. Each command has its argv, the heredoc bodies and
 * here-strings it reads (`inputs`), and the operator that ended it (`next`, "|" within a pipeline).
 * `substitutions` holds command substitutions found inside double quotes, which run as well.
 */
export function parseScript(source) {
  const commands = [];
  const substitutions = [];
  let current = { argv: [], inputs: [] };
  let word;
  let destination = "argv"; // where the next word goes: argv, drop (a redirection target), or input
  let heredocs = [];

  const endWord = () => {
    if (word === undefined) return;
    if (destination === "argv") current.argv.push(word);
    else if (destination === "input") current.inputs.push(word);
    destination = "argv";
    word = undefined;
  };
  const endCommand = (next) => {
    endWord();
    destination = "argv";
    if (current.argv.length > 0 || current.inputs.length > 0) commands.push({ ...current, next });
    current = { argv: [], inputs: [] };
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "\n") {
      endCommand("\n");
      i += 1;
      for (const { delimiter, stripTabs, inputs } of heredocs) {
        const lines = [];
        while (i < source.length) {
          const newline = source.indexOf("\n", i);
          const stop = newline === -1 ? source.length : newline;
          const line = source.slice(i, stop);
          i = stop + 1;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
          lines.push(line);
        }
        inputs.push(lines.join("\n"));
      }
      heredocs = [];
    } else if (c === " " || c === "\t") {
      endWord();
      i += 1;
    } else if (c === "#" && word === undefined) {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (c === "'") {
      const close = source.indexOf("'", i + 1);
      const stop = close === -1 ? source.length : close;
      word = (word ?? "") + source.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\" && j + 1 < source.length && '"\\$`\n'.includes(source[j + 1])) {
          if (source[j + 1] !== "\n") text += source[j + 1];
          j += 2;
        } else if (source[j] === "$" && source[j + 1] === "(") {
          const end = closeSubstitution(source, j + 2);
          substitutions.push(source.slice(j + 2, end - 1));
          text += source.slice(j, end);
          j = end;
        } else if (source[j] === "`") {
          const close = source.indexOf("`", j + 1);
          const end = close === -1 ? source.length : close;
          substitutions.push(source.slice(j + 1, end));
          text += source.slice(j, end + 1);
          j = end + 1;
        } else {
          text += source[j];
          j += 1;
        }
      }
      word = (word ?? "") + text;
      i = j + 1;
    } else if (c === "\\") {
      if (source[i + 1] !== "\n") word = (word ?? "") + (source[i + 1] ?? "");
      i += 2;
    } else if (c === "$" && source[i + 1] === "(") {
      endCommand("$(");
      i += 2;
    } else if (c === "|") {
      const operator = source[i + 1] === "|" || source[i + 1] === "&" ? c + source[i + 1] : c;
      endCommand(operator);
      i += operator.length;
    } else if (c === "&" && source[i + 1] === ">") {
      endWord(); // &> redirects both streams; the > is handled next
      i += 1;
    } else if (c === "&") {
      const operator = source[i + 1] === "&" ? "&&" : "&";
      endCommand(operator);
      i += operator.length;
    } else if ("`;()".includes(c)) {
      endCommand(c);
      i += 1;
    } else if (c === "<" || c === ">") {
      if (word !== undefined && /^\d+$/.test(word)) word = undefined; // descriptor number, as in 2>
      else endWord();
      let operator = c;
      i += 1;
      while (i < source.length && "<>|".includes(source[i])) operator += source[i++];
      if (source[i] === "&") {
        // >&2 and <&0 duplicate a descriptor and take no file word.
        i += 1;
        while (i < source.length && /[\d-]/.test(source[i])) i += 1;
      } else if (operator === "<<") {
        const stripTabs = source[i] === "-";
        if (stripTabs) i += 1;
        while (source[i] === " " || source[i] === "\t") i += 1;
        let delimiter = "";
        while (i < source.length && !/[\s;&|()<>]/.test(source[i])) {
          if (!"'\"\\".includes(source[i])) delimiter += source[i];
          i += 1;
        }
        heredocs.push({ delimiter, stripTabs, inputs: current.inputs });
      } else {
        destination = operator === "<<<" ? "input" : "drop";
      }
    } else {
      word = (word ?? "") + c;
      i += 1;
    }
  }
  endCommand(undefined);
  return { commands, substitutions };
}

function changeDirectory(dir, path) {
  if (path === undefined || path === "~") return homedir();
  if (path === "-" || /[$`*?[]/.test(path)) return undefined; // the previous directory, variables, and globs are unknown here
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (path.startsWith("/")) return resolve(path);
  return dir === undefined ? undefined : resolve(dir, path);
}

/** Skips assignments, shell keywords, and wrappers, collecting command strings that wrappers run. */
function program(argv, dir) {
  const nested = [];
  let i = 0;
  while (i < argv.length) {
    const name = basename(argv[i]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]) || SHELL_KEYWORDS.has(argv[i])) {
      i += 1;
      continue;
    }
    if (name === "watch") {
      // watch runs its remaining words through `sh -c`.
      i += 1;
      while (i < argv.length && argv[i].startsWith("-")) i += ["-n", "--interval", "-q", "--equexit"].includes(argv[i]) ? 2 : 1;
      nested.push(argv.slice(i).join(" "));
      return { words: [], nested, dir };
    }
    if (name === "command") {
      // `command -v NAME` and `command -V NAME` look a command up without running it.
      let j = i + 1;
      while (j < argv.length && /^-[A-Za-z]+$/.test(argv[j]) && !/[vV]/.test(argv[j])) j += 1;
      if (/^-[A-Za-z]*[vV]/.test(argv[j] ?? "")) return { words: [], nested, dir };
    }
    if (!Object.hasOwn(WRAPPERS, name)) break;
    i += 1;
    while (i < argv.length && argv[i].startsWith("-")) {
      const option = argv[i];
      if (name === "env" && (option === "-S" || option === "--split-string")) {
        nested.push(argv[i + 1] ?? "");
        i += 2;
      } else if (name === "env" && (option.startsWith("--split-string=") || /^-S./.test(option))) {
        nested.push(option.startsWith("-S") ? option.slice(2) : option.slice("--split-string=".length));
        i += 1;
      } else if (name === "env" && (option === "-C" || option === "--chdir")) {
        dir = changeDirectory(dir, argv[i + 1]);
        i += 2;
      } else {
        i += WRAPPERS[name].includes(option) ? 2 : 1;
      }
    }
    if (name === "timeout") i += 1; // the duration
  }
  return { words: argv.slice(i), nested, dir };
}

/** The script of `sh -c <script>`, skipping shell options that take a value. */
function shellScript(words) {
  for (let i = 1; i < words.length; i += 1) {
    if (SHELL_VALUE_OPTIONS.has(words[i])) i += 1;
    else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[i])) return words[i + 1];
    else if (!/^[-+]/.test(words[i])) return undefined;
  }
  return undefined;
}

/** Whether a shell invocation reads its commands from standard input (no -c and no script file). */
function readsStdin(words) {
  if (words.length === 0 || !SHELLS.has(basename(words[0]))) return false;
  for (let i = 1; i < words.length; i += 1) {
    if (words[i] === "-" || /^-[A-Za-z]*s[A-Za-z]*$/.test(words[i])) return true;
    if (SHELL_VALUE_OPTIONS.has(words[i])) i += 1;
    else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[i]) || !/^[-+]/.test(words[i])) return false;
  }
  return true;
}

function longOption(name) {
  if (PUSH_OPTIONS.includes(name)) return name;
  const matches = PUSH_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length === 1) return matches[0];
  // Git rejects an ambiguous abbreviation, but a prefix of a rewriting option is never read as harmless.
  return matches.find((option) => REWRITING_OPTIONS.includes(option)) ?? name;
}

function parsePush(args) {
  const push = { force: false, leases: [], mirror: false, all: false, remove: false, dryRun: false, positionals: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      push.positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
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

function judge(push, dir, git) {
  const [remote, ...refspecs] = push.positionals;
  const updates = [];
  if (push.mirror || push.all) {
    updates.push({ target: "*", plus: false, remove: false });
  } else if (refspecs.length === 0) {
    updates.push({ target: "@{push}", plus: false, remove: push.remove });
  } else {
    for (const spec of refspecs) {
      const plus = spec.startsWith("+");
      const body = plus ? spec.slice(1) : spec;
      const colon = body.indexOf(":");
      updates.push({ target: push.remove || colon === -1 ? body : body.slice(colon + 1), plus, remove: push.remove || colon === 0 });
    }
  }
  const forced = push.force || push.mirror || updates.some((update) => update.plus);
  const rewriting = forced || push.leases.length > 0;
  const risky = updates.filter((update) => rewriting || update.remove);
  if (risky.length === 0) return undefined;

  let defaults;
  let branches;
  try {
    const query = (args) => (dir === undefined ? undefined : git(dir, args));
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

function inspect(source, state, visit, depth, tooDeep) {
  if (depth > MAX_DEPTH) return tooDeep;
  const { commands, substitutions } = parseScript(source);
  for (const inner of substitutions) {
    const violation = inspect(inner, { dir: state.dir }, visit, depth + 1, tooDeep);
    if (violation) return violation;
  }
  let pipeline = [];
  for (const command of commands) {
    pipeline.push(command);
    if (command.next === "|" || command.next === "|&") continue;
    const programs = pipeline.map((each) => program(each.argv, state.dir));
    const feedsShell = programs.some(({ words }) => readsStdin(words));
    for (const [index, { words, nested, dir }] of programs.entries()) {
      const name = words.length > 0 ? basename(words[0]) : "";
      const scripts = [...nested, ...(feedsShell ? pipeline[index].inputs : [])];
      if (SHELLS.has(name)) scripts.push(shellScript(words));
      if (name === "eval") scripts.push(words.slice(1).join(" "));
      for (const script of scripts) {
        const violation = script === undefined ? undefined : inspect(script, { dir }, visit, depth + 1, tooDeep);
        if (violation) return violation;
      }
      if (name === "cd" || name === "pushd") state.dir = changeDirectory(state.dir, words.slice(1).find((arg) => !/^-[LPe@]+$/.test(arg)));
      else if (name === "popd") state.dir = undefined;
      else if (words.length > 0) {
        const violation = visit(words, dir);
        if (violation) return violation;
      }
    }
    pipeline = [];
  }
  return undefined;
}

/**
 * Returns why `command` must not run, or undefined when it may. `git(dir, args)` returns trimmed
 * stdout, undefined when git reports that the ref, upstream, or branch does not exist, and throws
 * when git could not answer.
 */
export function findViolation(command, cwd, git) {
  return inspect(command, { dir: cwd }, (words, dir) => (basename(words[0]) === "git" ? gitPush(words, dir, git) : undefined), 0, TOO_DEEP);
}

/**
 * Calls `visit(words, dir)` for every command `source` would run, after wrappers, through
 * shells, substitutions and `eval`; `dir` is its directory when known. Returns the first
 * reason `visit` gives for blocking one, or undefined. Scripts nested too deeply to follow
 * are skipped, not blocked.
 */
export function visitCommands(source, cwd, visit) {
  return inspect(source, { dir: cwd }, visit, 0, undefined);
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
