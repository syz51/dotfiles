// Claude Code PreToolUse hook for the Bash tool. Enforces the runtime rule in
// ~/.claude/CLAUDE.md: Python runs through `uv run` and JavaScript through `bun`, `bunx`
// or Vite+ (`vp`), so a command that starts python (ipython, pypy), pip, pytest, node or
// another JavaScript package manager (npm, npx, pnpm, pnpx, yarn, corepack) is blocked,
// here or over `ssh`. So is a launcher that starts such a tool: `bunx`, `bun x`, `vpx`,
// `vp exec` or `vp env exec` running it, `vp node` and `vpx <script file>`, which run
// Node.js, and `vp dlx` and Vite+'s package-management commands, which run the project's
// package manager (pnpm when no lockfile names one). The `codex` CLI is blocked the same
// way: the user has only a Claude plan, so no session may start Codex or its models.
// BUN_OPTIONS=--bun (set in ~/.zshenv) makes bun run and bunx use bun for tools whose
// shebang names node. `uv run python`, `uv pip`, `bun run`, `vp check`, `vp test` and
// words that only mention a runtime (`grep python`, `command -v node`, `ls ~/.codex`)
// still run, and so does a bare version probe: argv of exactly `python3 --version` or `-V`
// (also pypy, a path such as /usr/bin/python3, and node with `-v`), here or over ssh,
// which runs no user code. A probe with any other word, or through a launcher, is blocked.
// Exit 2 blocks the command and shows stderr to Claude; a crash is a
// non-blocking hook error, so the guard fails open. shell.js follows the shell syntax
// around a command (wrappers, `sh -c`, `find -exec`, `ssh`) but cannot see into script
// files, package scripts or expanded variables. A Python block over ssh names what works on
// a remote host instead: `jq` for JSON, or `uv run --no-project python` where uv is there.
// One exception: node, also through these launchers, may run in a checkout of a repository
// that node-repos.json lists, such as T3 Code, whose server needs Node.js. A checkout is a
// git repository whose origin or upstream remote is such a repository, decided from each
// command's directory as shell.js follows it through `cd` and wrappers, and as `bun --cwd`
// and `bunx --cwd` move it. A command whose directory is unknown gets no exception, and
// neither does one over ssh, whatever directory it names, and node may not start a banned package manager's script there.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { changeDirectory, visitCommands } from "./shell.js";

// Case-insensitive: the default macOS volume runs PYTHON3 as python3.
const PYTHON = /^(?:python|pip|pypy|ipython)(?:\d+(?:\.\d+)*)?$|^(?:pytest|py\.test)$/i;
// node and every JavaScript package manager but bun. Vite+ is a launcher, handled below.
const JS_TOOL = /^(?:node|nodejs|npm|npx|pnpm|pnpx|yarn|yarnpkg|corepack)$/i;
const NODE = /^node(?:js)?$/i;
// A banned package manager's script that node would run, as in `node $(which pnpm) i` or
// `node node_modules/pnpm/bin/pnpm.cjs i`: its name as a whole word or path part.
const PACKAGE_MANAGER_SCRIPT = /(?:^|[/(`\s])(?:npm|npx|pnpm|pnpx|yarn|yarnpkg|corepack)(?=$|[/.)`\s])/i;
// A GitHub remote URL as owner and name: https, ssh (also with a port or through
// ssh.github.com), git, git+ssh or scp form, with or without .git.
const GITHUB_REMOTE = /^(?:(?:https?|ssh|git|git\+ssh):\/\/)?(?:[^@/\s]+@)?(?:ssh\.)?github\.com(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
// The Codex CLI, by its name or, through bunx, its npm package.
const CODEX = /^(?:@openai\/)?codex$/i;
// A bare version probe: an interpreter and its version flag, nothing else.
const PROBE_INTERPRETER = /^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/i;
const versionProbe = (words) => words.length === 2 && (
  (PROBE_INTERPRETER.test(basename(words[0])) && (words[1] === "--version" || words[1] === "-V"))
  || (NODE.test(basename(words[0])) && ["--version", "-V", "-v"].includes(words[1])));
// A cheap prefilter: commands that never name a runtime or a launcher, even split by
// quotes or backslashes ("no"de, n\ode), are not parsed.
const MENTION = /python|pip|pypy|py\.?test|node|np[mx]|pnp|yarn|corepack|vp|vite-plus|codex/i;
// Options of bun and `bun x` that take the next word as their value.
const BUN_VALUE_OPTIONS = new Set(["--cwd", "--env-file", "--registry", "--ca", "--cafile", "--minimum-release-age",
  "-c", "--config", "-r", "--preload", "--import", "--require", "--port", "--conditions", "-e", "--eval", "-p", "--print"]);
const BUNX_VALUE_OPTIONS = new Set(["--cwd", "--env-file", "--registry", "--ca", "--cafile", "--minimum-release-age"]);
// Vite+ (https://viteplus.dev/guide/): its commands that hand work to the project's
// package manager, with common aliases, and the vpx options that take a value.
const VITE_PLUS = /^(?:vp|vite-plus)$/i;
const VP_PACKAGE_MANAGER = new Set(["install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "dedupe",
  "outdated", "list", "ls", "why", "info", "link", "unlink", "rebuild", "pm", "dlx"]);
const VPX_VALUE_OPTIONS = new Set(["--tsconfig", "--include", "--exclude", "--kill-signal", "--kill-timeout"]);
// vpx runs a file with these extensions on Node.js instead of a package binary.
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;

const withoutVersion = (tool) => tool.replace(/(?<=.)@.*$/, "");
const skipOptions = (words) => {
  const start = words.findIndex((word) => !word.startsWith("-"));
  return start < 0 ? [] : words.slice(start);
};

/**
 * The package words[i..] names after the options of bunx or vpx, the `-p`/`--package`
 * packages, and the `--cwd` directories it moves to.
 */
function packageRun(via, words, i, valueOptions, cwds = []) {
  const packages = [];
  let shell = false;
  for (; i < words.length; i++) {
    const word = words[i];
    if (word === "-p" || word === "--package") packages.push(words[++i]);
    else if (word === "--cwd" && valueOptions.has(word)) cwds.push(words[++i]);
    else if (word.startsWith("--cwd=") && valueOptions.has("--cwd")) cwds.push(word.slice("--cwd=".length));
    else if (word.startsWith("--package=")) packages.push(word.slice("--package=".length));
    else if (via === "vpx" && (word === "-c" || word === "--shell-mode")) shell = true;
    else if (valueOptions.has(word)) i++;
    else if (!word.startsWith("-")) break;
  }
  const rest = words.slice(i);
  const run = { via, packages: packages.filter(Boolean).map(withoutVersion), isPackage: true, cwds: cwds.filter((cwd) => cwd !== undefined) };
  if (shell) return { ...run, script: rest.join(" ") };
  if (via === "vpx" && rest[0] && SCRIPT_FILE.test(rest[0])) return { ...run, words: ["node", ...rest], isPackage: false };
  return { ...run, words: rest.length ? [withoutVersion(rest[0]), ...rest.slice(1)] : [] };
}

/**
 * What the launcher `words` hands on, or undefined when `words` is no launcher: the
 * program it runs as `words` (a package name when isPackage), extra `packages`, a shell
 * `script`, or the Vite+ command that runs the project's `packageManager`, and the `cwds`
 * it moves to first.
 */
function handOff(words) {
  const name = basename(words[0]).toLowerCase();
  if (name === "bunx") return packageRun("bunx", words, 1, BUNX_VALUE_OPTIONS);
  if (name === "vpx") return packageRun("vpx", words, 1, VPX_VALUE_OPTIONS);
  let i = 1;
  if (name === "bun") {
    const cwds = [];
    while (i < words.length && words[i].startsWith("-")) {
      if (words[i] === "--cwd") cwds.push(words[i + 1]);
      else if (words[i].startsWith("--cwd=")) cwds.push(words[i].slice("--cwd=".length));
      i += BUN_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
    }
    return words[i]?.toLowerCase() === "x" ? packageRun("bunx", words, i + 1, BUNX_VALUE_OPTIONS, cwds) : undefined;
  }
  if (!VITE_PLUS.test(name)) return undefined;
  while (i < words.length && words[i].startsWith("-")) i++;
  const command = words[i]?.toLowerCase();
  const none = { packages: [], isPackage: false, cwds: [] };
  if (command === "exec") return { ...none, via: "vp exec", words: skipOptions(words.slice(i + 1)) };
  if (command === "env" && words[i + 1]?.toLowerCase() === "exec") return { ...none, via: "vp env exec", words: skipOptions(words.slice(i + 2)) };
  if (command === "node") return { ...none, via: "vp", words: words.slice(i) };
  if (VP_PACKAGE_MANAGER.has(command)) {
    const target = command === "dlx" ? packageRun("vp dlx", words, i + 1, new Set()) : { ...none, words: [] };
    return { ...target, packageManager: `vp ${command}` };
  }
  return undefined;
}

// Both return the tool `words`, run in `dir`, must not start, as { tool, via, remote }, or
// undefined; via names the launcher that starts it, remote says a launcher's shell script runs it over ssh, and `pattern(tool, dir, words)` says
// whether a tool is banned there (words is undefined for a `-p` package). The scoring's package-runner detector reuses blockedRuntime for
// the uv and bun rule, so the Codex check stays separate, and only blockedRuntime counts a Vite+ command that runs the project's package manager.
function find(words, dir, pattern, packageManagers) {
  let via;
  let isPackage = false;
  for (let depth = 0; words.length > 0 && depth < 8; depth++) {
    const name = isPackage ? words[0] : basename(words[0]);
    if (pattern(name, dir, words)) return { tool: name, via };
    const next = handOff(words);
    if (!next) return undefined;
    if (packageManagers && next.packageManager) return { tool: next.packageManager, via };
    via = next.via;
    for (const cwd of next.cwds) dir = changeDirectory(dir, cwd);
    const tool = next.packages.find((name) => pattern(name, dir, undefined));
    if (tool) return { tool, via };
    if (next.script !== undefined) {
      const inner = visitCommands(next.script, dir, (command, where, { remote }) => {
        const found = find(command, where, pattern, packageManagers);
        return found && { ...found, remote: found.remote || remote };
      });
      return inner && { tool: inner.tool, via: inner.via ?? via, remote: inner.remote };
    }
    ({ words, isPackage } = next);
  }
  return undefined;
}

// git without the GIT_* variables of the hook's environment, which would override `-C`.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
let nodeRepos;
const checkouts = new Map();
/**
 * Whether node may run in `dir`: in a git checkout whose origin or upstream remote is a
 * repository node-repos.json lists. A directory the command has yet to create counts as
 * its nearest existing parent.
 */
export function nodeCheckout(dir) {
  if (dir === undefined) return false;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  if (!checkouts.has(dir)) {
    nodeRepos ??= new Set(JSON.parse(readFileSync(join(import.meta.dir, "node-repos.json"), "utf8")).repos.map((repo) => repo.toLowerCase()));
    // `git remote -v` prints each remote's URLs after url.<base>.insteadOf rewriting.
    const result = spawnSync("git", ["-C", dir, "remote", "-v"], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    checkouts.set(dir, result.status === 0 && result.stdout.split("\n").some((line) => {
      const [remote, url = ""] = line.split(/\s+/);
      const match = (remote === "origin" || remote === "upstream") && GITHUB_REMOTE.exec(url);
      return Boolean(match) && nodeRepos.has(`github.com/${match[1]}/${match[2]}`.toLowerCase());
    }));
  }
  return checkouts.get(dir);
}

/**
 * The banned runtime `words` starts in the directory `dir`. node is not banned where
 * `allowsNode(dir)`, unless it runs a banned package manager's script.
 */
export const blockedRuntime = (words, dir, allowsNode = nodeCheckout) => find(words, dir, (tool, where, run) => PYTHON.test(tool)
  || (JS_TOOL.test(tool) && !(NODE.test(tool) && !run?.slice(1).some((word) => PACKAGE_MANAGER_SCRIPT.test(word)) && allowsNode(where))), true);
export const codexLaunch = (words) => find(words, undefined, (tool) => CODEX.test(tool), false);

/**
 * Why the command `words`, run in the directory `dir`, here or on another host when `remote`,
 * must not run, or undefined when it may.
 */
export function runtimeViolation(words, dir, { remote = false } = {}) {
  if (versionProbe(words)) return undefined;
  // node-repos.json names local checkouts, so a command on another host, even one that
  // `bun --cwd` moves to a path that exists here, gets no exception.
  const blocked = (remote ? blockedRuntime(words, undefined, () => false) : blockedRuntime(words, dir)) ?? codexLaunch(words);
  if (!blocked) return undefined;
  const { tool, via } = blocked;
  const command = `\`${words.join(" ")}\``;
  if (PYTHON.test(tool) && (remote || blocked.remote)) {
    return `${command} runs ${tool}${via ? ` through ${via}` : ""} on the remote host over ssh. Python runs through uv there too. `
      + "Read JSON there with `jq` instead, or run `uv run --no-project python …`, `uv pip …` or "
      + "`uv run --no-project --with pytest pytest …` where uv is on that host.";
  }
  if (PYTHON.test(tool)) {
    return `${command} runs ${tool}${via ? ` through ${via}` : " directly"}. Run Python through uv instead: \`uv run python …\`, `
      + "`uv run --with pytest pytest …` or `uv pip …`.";
  }
  if (VITE_PLUS.test(tool.split(" ")[0])) {
    return `${command} runs the project's package manager through \`${tool}\`, which is pnpm when no lockfile names one. `
      + "Use bun instead (`bun install`, `bun add <package>`, `bun pm …`, `bunx <tool>`); `vp check`, `vp test` and `vp run` may run.";
  }
  const runs = `${command} runs ${tool}${via ? ` through ${via}` : ""}.`;
  if (CODEX.test(tool)) {
    return `${runs} The user has only a Claude plan, so never start the Codex CLI or a gpt-* model. Do the work `
      + "with Claude instead; in a Codex session, stop and ask the user to continue it in Claude.";
  }
  if (JS_TOOL.test(tool) && (remote || blocked.remote)) {
    return `${command} runs ${tool}${via ? ` through ${via}` : ""} on the remote host over ssh. JavaScript runs through bun there too: `
      + "`bun <file>`, `bunx <tool>`, `bun install` or `bun run <script>` where bun is on that host. "
      + "The node-repos.json exception covers only checkouts on this machine.";
  }
  if (NODE.test(tool)) {
    return `${runs} Run JavaScript with \`bun <file>\` or \`bunx <tool>\` instead. node runs only in a checkout of a repository `
      + "that ~/.claude/hooks/node-repos.json lists, such as T3 Code, and never to start npm, npx, pnpm, yarn or corepack.";
  }
  return `${runs} Use \`bun\` or \`bunx\` instead (\`bun install\`, \`bun run <script>\`, \`bunx <tool>\`), even where a `
    + "project's lockfile selects another package manager.";
}

export function findRuntimeViolation(command, cwd) {
  return MENTION.test(command.replace(/["'\\]/g, "")) ? visitCommands(command, cwd, runtimeViolation) : undefined;
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const command = input?.tool_input?.command;
  if (typeof command === "string") {
    const violation = findRuntimeViolation(command, typeof input.cwd === "string" ? input.cwd : process.cwd());
    if (violation) {
      process.stderr.write(`Blocked by the guard-runtimes hook: ${violation}\n`);
      process.exit(2);
    }
  }
}
