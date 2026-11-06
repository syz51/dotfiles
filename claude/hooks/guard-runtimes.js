// Claude Code PreToolUse hook for the Bash tool. Enforces the runtime rule in
// ~/.claude/CLAUDE.md: Python runs through `uv run` and JavaScript through `bun` or
// `bunx`, so a command that starts python (ipython, pypy), pip, pytest or node directly
// is blocked, here or over `ssh`.
// `uv run python`, `uv pip`, `npm test` and words that only mention a runtime (`grep
// python`, `command -v node`) still run. Exit 2 blocks the command and shows stderr to
// Claude; a crash is a non-blocking hook error, so the guard fails open. shell.js follows
// the shell syntax around a command (wrappers, `sh -c`, `find -exec`, `ssh`) but cannot see
// into script files, package scripts or expanded variables.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { visitCommands } from "./shell.js";

// Case-insensitive: the default macOS volume runs PYTHON3 as python3.
const PYTHON = /^(?:python|pip|pypy|ipython)(?:\d+(?:\.\d+)*)?$|^(?:pytest|py\.test)$/i;
const NODE = /^(?:node|nodejs)$/i;
// A cheap prefilter: commands that never name a runtime, even split by quotes or
// backslashes ("no"de, n\ode), are not parsed.
const MENTION = /python|pip|pypy|py\.?test|node/i;

/** Why the command `words` must not run, or undefined when it may. */
export function runtimeViolation(words) {
  const name = basename(words[0]);
  if (PYTHON.test(name)) {
    return `\`${words.join(" ")}\` runs ${name} directly. Run Python through uv instead: \`uv run python …\`, `
      + "`uv run --with pytest pytest …` or `uv pip …`.";
  }
  if (NODE.test(name)) {
    return `\`${words.join(" ")}\` runs ${name}. Use \`bun\` or \`bunx\` instead; use npm, npx, pnpm or yarn `
      + "only where the project's lockfile selects them.";
  }
  return undefined;
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
