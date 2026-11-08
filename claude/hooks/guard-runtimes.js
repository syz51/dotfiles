// Claude Code PreToolUse hook for the Bash tool. Enforces the runtime rule in
// ~/.claude/CLAUDE.md: Python runs through `uv run` and JavaScript through `bun` or
// `bunx`, so a command that starts python (ipython, pypy), pip, pytest, node or another
// JavaScript package manager (npm, npx, pnpm, pnpx, yarn, corepack, Vite+'s vp) is
// blocked, here or over `ssh`, and so is `bunx` or `bun x` running such a tool. The
// `codex` CLI is blocked the same way: the user has only a Claude plan, so no session may
// start Codex or its models. BUN_OPTIONS=--bun
// (set in ~/.zshenv) makes bun run and bunx use bun for tools whose shebang names node.
// `uv run python`, `uv pip`, `bun run` and words that only mention a runtime (`grep
// python`, `command -v node`, `ls ~/.codex`) still run. Exit 2 blocks the command and shows stderr to
// Claude; a crash is a non-blocking hook error, so the guard fails open. shell.js follows
// the shell syntax around a command (wrappers, `sh -c`, `find -exec`, `ssh`) but cannot see
// into script files, package scripts or expanded variables.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { visitCommands } from "./shell.js";

// Case-insensitive: the default macOS volume runs PYTHON3 as python3.
const PYTHON = /^(?:python|pip|pypy|ipython)(?:\d+(?:\.\d+)*)?$|^(?:pytest|py\.test)$/i;
// node and every JavaScript package manager but bun, including Vite+.
const JS_TOOL = /^(?:node|nodejs|npm|npx|pnpm|pnpx|yarn|yarnpkg|corepack|vp|vpx|vite-plus)$/i;
// The Codex CLI, by its name or, through bunx, its npm package.
const CODEX = /^(?:@openai\/)?codex$/i;
// A cheap prefilter: commands that never name a runtime, even split by quotes or
// backslashes ("no"de, n\ode), are not parsed.
const MENTION = /python|pip|pypy|py\.?test|node|np[mx]|pnp|yarn|corepack|vp|vite-plus|codex/i;
// Options of bun and `bun x` that take the next word as their value.
const BUN_VALUE_OPTIONS = new Set(["--cwd", "--env-file", "--registry", "--ca", "--cafile", "--minimum-release-age",
  "-c", "--config", "-r", "--preload", "--import", "--require", "--port", "--conditions", "-e", "--eval", "-p", "--print"]);
const BUNX_VALUE_OPTIONS = new Set(["--cwd", "--env-file", "--registry", "--ca", "--cafile", "--minimum-release-age"]);

/** The tools `bunx` or `bun x` runs: the binary and any `-p`/`--package` package, without versions. */
function bunxTools(words) {
  const name = basename(words[0]).toLowerCase();
  let i = 1;
  if (name === "bun") {
    while (i < words.length && words[i].startsWith("-")) i += BUN_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
    if (words[i]?.toLowerCase() !== "x") return [];
    i++;
  } else if (name !== "bunx") return [];
  const tools = [];
  for (; i < words.length; i++) {
    const word = words[i];
    if (word === "-p" || word === "--package") tools.push(words[++i]);
    else if (word.startsWith("--package=")) tools.push(word.slice("--package=".length));
    else if (BUNX_VALUE_OPTIONS.has(word)) i++;
    else if (!word.startsWith("-")) {
      tools.push(word);
      break;
    }
  }
  return tools.filter(Boolean).map((tool) => tool.replace(/(?<=.)@.*$/, ""));
}

// Both return the tool `words` must not start, as { tool, viaBunx }, or undefined. The
// scoring's package-runner detector reuses blockedRuntime for the uv and bun rule, so the
// Codex check stays separate.
const find = (words, pattern) => {
  const name = basename(words[0]);
  if (pattern(name)) return { tool: name, viaBunx: false };
  const tool = bunxTools(words).find(pattern);
  return tool ? { tool, viaBunx: true } : undefined;
};
export const blockedRuntime = (words) => find(words, (tool) => PYTHON.test(tool) || JS_TOOL.test(tool));
export const codexLaunch = (words) => find(words, (tool) => CODEX.test(tool));

/** Why the command `words` must not run, or undefined when it may. */
export function runtimeViolation(words) {
  const blocked = blockedRuntime(words) ?? codexLaunch(words);
  if (!blocked) return undefined;
  const { tool, viaBunx } = blocked;
  const command = `\`${words.join(" ")}\``;
  if (PYTHON.test(tool)) {
    return `${command} runs ${tool} directly. Run Python through uv instead: \`uv run python …\`, `
      + "`uv run --with pytest pytest …` or `uv pip …`.";
  }
  const runs = `${command} runs ${tool}${viaBunx ? " through bunx" : ""}.`;
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
