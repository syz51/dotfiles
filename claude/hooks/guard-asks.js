// PreToolUse hook for board asks (MCP `ask_user` and CLI `board ask`). Enforces the Autonomy rule in
// ~/.claude/CLAUDE.md and ~/.gemini/config/GEMINI.md: agents notify the user only for a reason that
// ask-policy.json lists (design, cost, irreversible, outside, only-me, security, intent), and do
// every other step themselves. An ask must name its reason as `Reason: <name>`; an `action` ask,
// which hands the user a step, must name one of the policy's action_reasons. Otherwise the hook
// blocks the ask (exit 2) and its stderr tells the agent what to do instead. The user tunes the
// reasons in ask-policy.json. The guard fails open: on a crash or an unreadable policy the ask goes
// through, with the error shown as a non-blocking hook error.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { visitCommands } from "./shell.js";

// `Reason: cost`, `**Reason:** cost`, `reason: "only me"`, `Reason: <design>`: the label, then
// up to two words, with markup and quotes around them ignored.
const REASON = /\breason\W{0,4}?[:：][\s*_`"'<(]*([\p{L}\p{N}_-]+(?:[ _-][\p{L}\p{N}_-]+)?)/giu;
const key = (name) => name.toLowerCase().replace(/[\s_]+/g, "-").replace(/^-+|-+$/g, "");

// `board` global options before the subcommand that take a value argument (`board --help`).
const BOARD_GLOBAL_VALUE_OPTIONS = new Set(["--agent", "--board"]);
// `board ask` options that take a value argument (`board ask --help`, plus `--question`).
const BOARD_ASK_VALUE_OPTIONS = new Set([
  "--agent",
  "--board",
  "--task",
  "--kind",
  "--option",
  "--question",
  "--set-parallel-tasks",
  "--set-usage-stop-at",
  "--set-temporary",
]);

export function loadAskPolicy(policyPath = process.env.ASK_POLICY ?? join(import.meta.dir, "ask-policy.json")) {
  return JSON.parse(readFileSync(policyPath, "utf8"));
}

/**
 * Parses a shell command's argv for a `board ask` invocation.
 * Returns `{ question, kind }` when `words` invokes `board ask`, or `undefined` otherwise
 * (non-`board` commands, other subcommands like `board asks` or `board help ask`, or help/version flags).
 */
export function parseBoardAskCommand(words) {
  if (!Array.isArray(words) || words.length === 0) return undefined;
  if (basename(words[0]).toLowerCase() !== "board") return undefined;

  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    const word = words[i];
    if (word === "-h" || word === "--help" || word === "-V" || word === "--version" || word === "--") {
      return undefined;
    }
    if (word.includes("=")) {
      i += 1;
    } else if (BOARD_GLOBAL_VALUE_OPTIONS.has(word)) {
      i += 2;
    } else {
      i += 1;
    }
  }

  if (words[i] !== "ask") return undefined;

  let kind = "decision";
  let questionFlag;
  const positionals = [];
  let afterDoubleDash = false;

  for (let j = i + 1; j < words.length; j += 1) {
    const word = words[j];
    if (!afterDoubleDash && word === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && word.startsWith("-") && word !== "-") {
      if (word === "-h" || word === "--help" || word === "-V" || word === "--version") return undefined;
      if (word === "--action") {
        kind = "action";
        continue;
      }
      const eq = word.indexOf("=");
      const opt = eq === -1 ? word : word.slice(0, eq);
      const inlineVal = eq === -1 ? undefined : word.slice(eq + 1);
      if (BOARD_ASK_VALUE_OPTIONS.has(opt)) {
        const val = inlineVal !== undefined ? inlineVal : words[++j];
        if (opt === "--kind" && typeof val === "string") kind = val.toLowerCase();
        else if (opt === "--question" && typeof val === "string") questionFlag = val;
      }
      continue;
    }
    positionals.push(word);
  }

  const question = questionFlag !== undefined ? questionFlag : positionals.join(" ");
  return { question, kind };
}

/**
 * Why a shell command running `board ask` must not reach the user under `policy`, or undefined.
 */
export function findBoardAskViolation(command, cwd, policy) {
  if (typeof command !== "string") return undefined;
  const unquoted = command.replace(/\\\r?\n/g, "").replace(/["'\\]/g, "");
  if (!/\bboard\b/i.test(unquoted) || !/\bask\b/i.test(unquoted)) return undefined;
  let loaded = policy;
  return visitCommands(command, cwd, (words) => {
    const parsed = parseBoardAskCommand(words);
    if (!parsed) return undefined;
    loaded ??= loadAskPolicy();
    return askViolation(parsed, loaded);
  });
}

/** Why `input` (the ask_user tool input) must not reach the user under `policy`, or undefined. */
export function askViolation(input, policy) {
  const names = Object.keys(policy.reasons);
  const byKey = new Map(names.map((name) => [key(name), name]));
  const question = typeof input?.question === "string" ? input.question : "";
  const cited = [...question.matchAll(REASON)].map((match) => match[1]);
  // A two-word capture such as "only me" or "cost because" matches when it, or its first word, is listed.
  const found = cited.map((words) => byKey.get(key(words)) ?? byKey.get(key(words.split(/[ _]/)[0]))).filter(Boolean);
  const listed = names.map((name) => `- ${name}: ${policy.reasons[name]}`).join("\n");
  const never = policy.never.map((line) => `- ${line}`).join("\n");
  const help = `The user is notified only for these reasons (~/.claude/hooks/ask-policy.json):\n${listed}\n`
    + `These are never reasons to ask; do the step yourself:\n${never}`;
  if (cited.length === 0)
    return `the ask names no reason. If it fits one, add \`Reason: <name>\` to its "why it waits on you" line and ask again.\n${help}`;
  if (found.length === 0)
    return `\`Reason: ${cited[0]}\` is not a listed reason.\n${help}`;
  if (input.kind === "action" && !found.some((name) => policy.action_reasons.includes(name)))
    return `an action ask hands the user a step, which only \`Reason: ${policy.action_reasons.join("` or `")}\` allows. `
      + `Do the step yourself, or ask for the decision (kind decision) and then act on the answer.\n${help}`;
  return undefined;
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const policy = loadAskPolicy();
  const violation = input?.tool_name === "Bash"
    ? findBoardAskViolation(input?.tool_input?.command, typeof input.cwd === "string" ? input.cwd : process.cwd(), policy)
    : askViolation(input?.tool_input, policy);
  if (violation) {
    process.stderr.write(`Blocked by the guard-asks hook: ${violation}\n`);
    process.exit(2);
  }
}
