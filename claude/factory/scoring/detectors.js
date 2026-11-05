// Deterministic rule checks that run on every session without a model. Each detector
// reads the session's actions (tool calls of the main session and its subagents, slash
// commands and prompts) and returns { verdict, hits }: fail with the offending actions,
// pass when the rule applied and held, na when the session never did the kind of thing
// the rule is about. They are heuristics over literal command text: a command built at
// run time, or a message body read from a file, is invisible to them.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { mayInvoke } from "../../tests/lib/command.js";
import { readRecords } from "../lib/transcripts.js";

const EVIDENCE = 300;
const clip = (text, max = EVIDENCE) => {
  const flat = String(text).replace(/\s*\n\s*/g, " ⏎ ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

// Records of a session's main transcript and of each subagent.
export function sessionRecords(session) {
  const dir = join(session.file.slice(0, -".jsonl".length), "subagents");
  return {
    main: readRecords(session.file).records,
    subagents: session.subagents.map((agent) => {
      const file = join(dir, `${agent.id}.jsonl`);
      return { id: agent.id, records: existsSync(file) ? readRecords(file).records : [] };
    }),
  };
}

const COMMAND = /<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/;
const ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

// Everything the detectors look at: tool calls in order (agent is null for the main
// session), slash commands the prompts ran, and the human prompts.
export function sessionActions(session, records = sessionRecords(session)) {
  const calls = [];
  const commands = [];
  const collect = (list, agent) => {
    const seen = new Set();
    const results = new Map();
    for (const record of list) {
      const content = record.message?.content;
      if (record.type === "user" && Array.isArray(content))
        for (const block of content) if (block?.type === "tool_result") results.set(block.tool_use_id, block.is_error !== true);
    }
    for (const record of list) {
      const content = record.message?.content;
      if (record.type === "assistant" && Array.isArray(content)) {
        for (const block of content)
          if (block?.type === "tool_use" && !seen.has(block.id)) {
            seen.add(block.id);
            calls.push({ id: block.id, name: block.name, input: block.input ?? {}, at: record.timestamp ?? null, gitBranch: record.gitBranch ?? null, agent, ok: results.get(block.id) ?? null });
          }
      } else if (agent === null && record.type === "user" && !record.isSidechain && typeof content === "string") {
        const name = COMMAND.exec(content)?.[1];
        if (name) commands.push({ name: name.startsWith("/") ? name : `/${name}`, args: ARGS.exec(content)?.[1].trim() ?? "", at: record.timestamp ?? null });
      }
    }
  };
  collect(records.main, null);
  for (const agent of records.subagents) collect(agent.records, agent.id);
  return { calls, commands, prompts: session.prompts, cwd: session.cwd };
}

const bashCommands = (actions) => actions.calls.filter((call) => call.name === "Bash" && typeof call.input.command === "string");
const hit = (call, evidence, extra = {}) => ({ evidence: clip(evidence), at: call.at, agent: call.agent, ...extra });
const verdictOf = (applies, hits) => ({ verdict: hits.length ? "fail" : applies ? "pass" : "na", hits });

// npm and its runners are fine where the project's lockfile says the project uses them.
const NODE_TOOLS = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  npx: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  pnpx: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
};
const PYTHON_TOOLS = ["pip", "pip3", "pytest", "python", "python3", ...["10", "11", "12", "13", "14"].map((minor) => `python3.${minor}`)];

export function packageRunner(actions) {
  const commands = bashCommands(actions);
  const cwd = actions.cwd && existsSync(actions.cwd) ? actions.cwd : null;
  const hits = [];
  for (const call of commands) {
    const { command } = call.input;
    const tool = Object.entries(NODE_TOOLS).find(([name, lockfiles]) =>
      mayInvoke(command, name) && !(cwd && lockfiles.some((lockfile) => existsSync(join(cwd, lockfile)))))?.[0]
      ?? PYTHON_TOOLS.find((name) => mayInvoke(command, name));
    if (tool) hits.push(hit(call, command, { tool }));
  }
  return verdictOf(commands.length > 0, hits);
}

const ATTRIBUTION = /Co-Authored-By:\s*Claude|Generated with \[?Claude|\u{1F916}/iu;
const GIT_COMMIT = /\bgit\b(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+commit\b/;
const GH_PR = /\bgh\s+pr\s+(?:create|comment)\b/;

export function aiAttribution(actions) {
  let applies = false;
  const hits = [];
  for (const call of actions.calls) {
    let text = null;
    if (call.name === "Bash" && typeof call.input.command === "string") {
      const { command } = call.input;
      if ((mayInvoke(command, "git") && GIT_COMMIT.test(command)) || GH_PR.test(command)) text = command;
    } else if (/^mcp__.*(?:pull_request|commit|issue_comment)/i.test(call.name)) text = JSON.stringify(call.input);
    if (text === null) continue;
    applies = true;
    const match = ATTRIBUTION.exec(text);
    if (match) hits.push(hit(call, `${match[0]} in: ${text}`));
  }
  return verdictOf(applies, hits);
}

const HEREDOC = /(?<!<)<<-?(?!<)\s*(['"]?)([A-Za-z_]\w*)\1/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
// Wrappers that run the rest of their words as a command, and their options with a value.
const WRAPPERS = { sudo: ["-u", "-g", "-C"], env: ["-u", "-C"], nice: ["-n"], nohup: [], time: [], command: [], exec: [], timeout: ["-s", "-k"] };

// Simple commands of a shell command line as word lists, for spotting a program and its
// arguments in real commands, most of which tests/lib/command.js's grammar cannot read.
// Quotes group words without expansion and heredoc bodies are skipped, so quoted or
// embedded text never counts as a
// command; `sh -c`, `eval` and wrappers such as `timeout` or `sudo` are looked through.
export function simpleCommands(command, depth = 0) {
  const lines = String(command).split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const heredoc = HEREDOC.exec(lines[i]);
    if (heredoc) while (i + 1 < lines.length && lines[++i].trim() !== heredoc[2]);
  }
  const text = kept.join("\n");
  const lists = [];
  let words = [];
  let word = "";
  let started = false;
  let quote = null;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endList = () => {
    endWord();
    if (words.length) lists.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') word += text[++i] ?? "";
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\") {
      word += text[++i] ?? "";
      started = true;
    } else if (c === "\n") endList();
    else if (c === " " || c === "\t") endWord();
    else if (c === "$" && text[i + 1] === "(") {
      endList();
      i++;
    } else if (/[;&|()`]/.test(c)) endList();
    else {
      word += c;
      started = true;
    }
  }
  endList();
  return lists.flatMap((list) => unwrap(list, depth));
}

function unwrap(list, depth) {
  let words = list.filter((word, index) => index >= list.findIndex((w) => !/^\w+=/.test(w)));
  while (words.length && Object.hasOwn(WRAPPERS, basename(words[0]))) {
    const wrapper = basename(words[0]);
    words = words.slice(1);
    while (words.length && (words[0].startsWith("-") || (wrapper === "env" && /^\w+=/.test(words[0]))))
      words = words.slice(WRAPPERS[wrapper].includes(words[0]) ? 2 : 1);
    if (wrapper === "timeout") words = words.slice(1);
  }
  if (!words.length) return [];
  const program = basename(words[0]);
  if (depth < 3 && SHELLS.has(program) && /^-\w*c$/.test(words[1] ?? "") && words[2] !== undefined) return simpleCommands(words[2], depth + 1);
  if (depth < 3 && program === "eval") return simpleCommands(words.slice(1).join(" "), depth + 1);
  return [words];
}

const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const PUSH_WITH_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

// Arguments of each `git push` in a command.
export function gitPushes(command) {
  const pushes = [];
  for (const words of simpleCommands(command)) {
    let i = words.findIndex((word) => !/^\w+=/.test(word));
    if (i < 0 || basename(words[i]) !== "git") continue;
    i++;
    while (i < words.length && words[i].startsWith("-")) i += GIT_GLOBAL_WITH_VALUE.has(words[i]) ? 2 : 1;
    if (words[i] === "push") pushes.push(words.slice(i + 1));
  }
  return pushes;
}

const PROTECTED = new Set(["main", "master"]);
const branchOf = (ref) => ref.replace(/^\+/, "").split(":").at(-1).replace(/^refs\/heads\//, "");

// Why a push breaks the force-push rule, or null when it does not force or follows it.
export function forcePushProblem(args, currentBranch = null) {
  const positional = [];
  let plainForce = false;
  const leases = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (PUSH_WITH_VALUE.has(arg)) i++;
    else if (arg === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) plainForce = true;
    else if (arg.startsWith("--force-with-lease")) leases.push(arg.slice("--force-with-lease".length).replace(/^=/, ""));
    else if (!arg.startsWith("-")) positional.push(arg);
  }
  const refspecs = positional.slice(1);
  const plusRef = refspecs.some((ref) => ref.startsWith("+"));
  if (!plainForce && !plusRef && !leases.length) return null;
  const targets = refspecs.length ? refspecs.map(branchOf) : [currentBranch].filter(Boolean);
  for (const lease of leases) if (lease) targets.push(branchOf(lease.split(":")[0]));
  if (targets.some((branch) => PROTECTED.has(branch))) return "force push to a default branch";
  if (plainForce || plusRef) return "force push without --force-with-lease";
  if (!leases.some((lease) => /^[^:]+:[0-9a-f]{7,40}$/i.test(lease))) return "--force-with-lease without an explicit <ref>:<sha>";
  return null;
}

export function forcePush(actions) {
  let applies = false;
  const hits = [];
  for (const call of bashCommands(actions))
    for (const args of gitPushes(call.input.command)) {
      applies = true;
      const problem = forcePushProblem(args, call.gitBranch);
      if (problem) hits.push(hit(call, `${problem}: ${call.input.command}`));
    }
  return verdictOf(applies, hits);
}

// What a prompt or slash command could have asked for, and the actions that turn it on.
const MODES = {
  fast: { asked: /\bfast mode\b|\/fast\b/i },
  "ultra effort": { asked: /\bultra(?:think|code)\b/i },
  "ultra review": { asked: /\bultra\b/i },
};
const NEGATED = /\b(?:never|don'?t|do not|not|no|without|avoid)\b[^.\n]{0,40}$/i;

const askedIn = (text, mode) => {
  const pattern = new RegExp(MODES[mode].asked.source, "gi");
  for (const match of text.matchAll(pattern)) if (!NEGATED.test(text.slice(Math.max(0, match.index - 60), match.index))) return true;
  return false;
};

function commandMode({ name, args }) {
  if (name === "/fast") return "fast";
  if (["/effort", "/model", "/config"].includes(name)) return /ultra(?:think|code)/i.test(args) ? "ultra effort" : /\bfast\b/i.test(args) ? "fast" : null;
  if (/^\/(?:code-)?review$/.test(name) && /^\s*ultra\b/i.test(args)) return "ultra review";
  return null;
}

const SETTINGS_FILE = /(?:^|\/)settings(?:\.local)?\.json\b/;
const SETTINGS_TURN_ON = /"fastMode"\s*:\s*true|ultrathink|ultracode/i;

// The mode an agent action turns on, or null.
function actionMode(call) {
  const { name, input } = call;
  if (name === "Skill") {
    const skill = String(input.skill ?? "").replace(/^.*:/, "");
    const args = String(input.args ?? "");
    if (/^(?:code-)?review$/.test(skill) && /^\s*ultra\b/i.test(args)) return "ultra review";
    if (skill === "fast") return "fast";
    if (["effort", "model"].includes(skill)) return commandMode({ name: `/${skill}`, args });
    return null;
  }
  const path = input.file_path ?? input.notebook_path ?? "";
  if (["Edit", "Write", "MultiEdit"].includes(name) && SETTINGS_FILE.test(path)) {
    const text = [input.new_string, input.content, ...(input.edits ?? []).map((edit) => edit.new_string)].filter(Boolean).join("\n");
    if (SETTINGS_TURN_ON.test(text)) return /fastMode/i.test(text) ? "fast" : "ultra effort";
  }
  if (name === "Bash" && typeof input.command === "string" && SETTINGS_FILE.test(input.command) && SETTINGS_TURN_ON.test(input.command))
    return /fastMode/i.test(input.command) ? "fast" : "ultra effort";
  return null;
}

export function ultraEffort(actions) {
  const hits = [];
  const before = (at) => (item) => !at || !item.at || item.at <= at;
  for (const call of actions.calls) {
    const mode = actionMode(call);
    if (!mode) continue;
    const asked = actions.prompts.filter(before(call.at)).some((prompt) => askedIn(prompt.text, mode))
      || actions.commands.filter(before(call.at)).some((command) => commandMode(command) === mode);
    if (!asked) hits.push(hit(call, `${mode} with no prompt asking: ${call.name} ${JSON.stringify(call.input)}`, { mode }));
  }
  return verdictOf(true, hits);
}

export const DETECTORS = {
  "package-runner": packageRunner,
  "ai-attribution": aiAttribution,
  "force-push": forcePush,
  "ultra-effort": ultraEffort,
};

// Every detector's result for a session: { [id]: { verdict, hits } }.
export function runDetectors(session, records) {
  const actions = sessionActions(session, records);
  return Object.fromEntries(Object.entries(DETECTORS).map(([id, detect]) => [id, detect(actions)]));
}
