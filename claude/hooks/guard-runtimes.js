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
// still run. Exit 2 blocks the command and shows stderr to Claude; a crash is a
// non-blocking hook error, so the guard fails open. shell.js follows the shell syntax
// around a command (wrappers, `sh -c`, `find -exec`, `ssh`) but cannot see into script
// files, package scripts or expanded variables.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { visitCommands } from "./shell.js";

// Case-insensitive: the default macOS volume runs PYTHON3 as python3.
const PYTHON = /^(?:python|pip|pypy|ipython)(?:\d+(?:\.\d+)*)?$|^(?:pytest|py\.test)$/i;
// node and every JavaScript package manager but bun. Vite+ is a launcher, handled below.
const JS_TOOL = /^(?:node|nodejs|npm|npx|pnpm|pnpx|yarn|yarnpkg|corepack)$/i;
// The Codex CLI, by its name or, through bunx, its npm package.
const CODEX = /^(?:@openai\/)?codex$/i;
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

/** The package words[i..] names after the options of bunx or vpx, and the `-p`/`--package` packages. */
function packageRun(via, words, i, valueOptions) {
  const packages = [];
  let shell = false;
  for (; i < words.length; i++) {
    const word = words[i];
    if (word === "-p" || word === "--package") packages.push(words[++i]);
    else if (word.startsWith("--package=")) packages.push(word.slice("--package=".length));
    else if (via === "vpx" && (word === "-c" || word === "--shell-mode")) shell = true;
    else if (valueOptions.has(word)) i++;
    else if (!word.startsWith("-")) break;
  }
  const rest = words.slice(i);
  const run = { via, packages: packages.filter(Boolean).map(withoutVersion), isPackage: true };
  if (shell) return { ...run, script: rest.join(" ") };
  if (via === "vpx" && rest[0] && SCRIPT_FILE.test(rest[0])) return { ...run, words: ["node", ...rest], isPackage: false };
  return { ...run, words: rest.length ? [withoutVersion(rest[0]), ...rest.slice(1)] : [] };
}

/**
 * What the launcher `words` hands on, or undefined when `words` is no launcher: the
 * program it runs as `words` (a package name when isPackage), extra `packages`, a shell
 * `script`, or the Vite+ command that runs the project's `packageManager`.
 */
function handOff(words) {
  const name = basename(words[0]).toLowerCase();
  if (name === "bunx") return packageRun("bunx", words, 1, BUNX_VALUE_OPTIONS);
  if (name === "vpx") return packageRun("vpx", words, 1, VPX_VALUE_OPTIONS);
  let i = 1;
  if (name === "bun") {
    while (i < words.length && words[i].startsWith("-")) i += BUN_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
    return words[i]?.toLowerCase() === "x" ? packageRun("bunx", words, i + 1, BUNX_VALUE_OPTIONS) : undefined;
  }
  if (!VITE_PLUS.test(name)) return undefined;
  while (i < words.length && words[i].startsWith("-")) i++;
  const command = words[i]?.toLowerCase();
  const none = { packages: [], isPackage: false };
  if (command === "exec") return { ...none, via: "vp exec", words: skipOptions(words.slice(i + 1)) };
  if (command === "env" && words[i + 1]?.toLowerCase() === "exec") return { ...none, via: "vp env exec", words: skipOptions(words.slice(i + 2)) };
  if (command === "node") return { ...none, via: "vp", words: words.slice(i) };
  if (VP_PACKAGE_MANAGER.has(command)) {
    const target = command === "dlx" ? packageRun("vp dlx", words, i + 1, new Set()) : { ...none, words: [] };
    return { ...target, packageManager: `vp ${command}` };
  }
  return undefined;
}

// Both return the tool `words` must not start, as { tool, via }, or undefined; via names
// the launcher that starts it. The scoring's package-runner detector reuses
// blockedRuntime for the uv and bun rule, so the Codex check stays separate, and only
// blockedRuntime counts a Vite+ command that runs the project's package manager.
function find(words, pattern, packageManagers) {
  let via;
  let isPackage = false;
  for (let depth = 0; words.length > 0 && depth < 8; depth++) {
    const name = isPackage ? words[0] : basename(words[0]);
    if (pattern(name)) return { tool: name, via };
    const next = handOff(words);
    if (!next) return undefined;
    if (packageManagers && next.packageManager) return { tool: next.packageManager, via };
    via = next.via;
    const tool = next.packages.find(pattern);
    if (tool) return { tool, via };
    if (next.script !== undefined) {
      const inner = visitCommands(next.script, "/", (command) => find(command, pattern, packageManagers));
      return inner && { tool: inner.tool, via: inner.via ?? via };
    }
    ({ words, isPackage } = next);
  }
  return undefined;
}
export const blockedRuntime = (words) => find(words, (tool) => PYTHON.test(tool) || JS_TOOL.test(tool), true);
export const codexLaunch = (words) => find(words, (tool) => CODEX.test(tool), false);

/** Why the command `words` must not run, or undefined when it may. */
export function runtimeViolation(words) {
  const blocked = blockedRuntime(words) ?? codexLaunch(words);
  if (!blocked) return undefined;
  const { tool, via } = blocked;
  const command = `\`${words.join(" ")}\``;
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
  if (/^node(?:js)?$/i.test(tool)) return `${runs} Run JavaScript with \`bun <file>\` or \`bunx <tool>\` instead.`;
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
