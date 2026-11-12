// Deterministic rule checks that run on every session without a model. Each detector
// reads the session's actions (tool calls of the main session and its subagents, slash
// commands and prompts) and returns { verdict, hits }: fail with the offending actions,
// pass when the rule applied and held, na when the session never did the kind of thing
// the rule is about. They are heuristics over literal command text: a command built at
// run time, or a message body read from a file, is invisible to them.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { blockedRuntime, nodeCheckout } from "../../hooks/guard-runtimes.js";
import { visitCommands } from "../../hooks/shell.js";
import { mayInvoke } from "../../tests/lib/command.js";
import { isCodeReview, isReviewerRun, readRecords, TEMP_DIRS } from "../lib/transcripts.js";
import { boardCheckouts, gitCheckout, gitIgnored, loadReviewScope, locate, realFile, reviewMatcher, t3Checkout, t3Projects } from "./review-scope.js";

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
// session), slash commands the prompts ran, and the human prompts. A fork's copies of
// its parent's tool calls (marked forkedFrom) count for the parent only; its inherited
// prompts (session.inheritedPrompts, filtered like its own) and commands still count as
// what was asked.
export function sessionActions(session, records = sessionRecords(session)) {
  const calls = [];
  const commands = [];
  const collect = (list, agent) => {
    const seen = new Set();
    const results = new Map();
    // Whether the guard-runtimes hook refused the call, from its message in the result.
    const runtimeBlocked = new Set();
    for (const record of list) {
      const content = record.message?.content;
      if (record.type === "user" && Array.isArray(content))
        for (const block of content) {
          if (block?.type !== "tool_result") continue;
          results.set(block.tool_use_id, block.is_error !== true);
          const text = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part) => part?.text ?? "").join("\n") : "";
          if (text.includes(RUNTIME_BLOCK)) runtimeBlocked.add(block.tool_use_id);
        }
    }
    for (const record of list) {
      const content = record.message?.content;
      if (record.type === "assistant" && Array.isArray(content)) {
        if (record.forkedFrom) continue;
        for (const block of content)
          if (block?.type === "tool_use" && !seen.has(block.id)) {
            seen.add(block.id);
            calls.push({ id: block.id, name: block.name, input: block.input ?? {}, at: record.timestamp ?? null, gitBranch: record.gitBranch ?? null, cwd: record.cwd ?? null, agent, ok: results.get(block.id) ?? null, runtimeBlocked: runtimeBlocked.has(block.id) });
          }
      } else if (agent === null && record.type === "user" && !record.isSidechain && typeof content === "string") {
        const name = COMMAND.exec(content)?.[1];
        if (name) commands.push({ name: name.startsWith("/") ? name : `/${name}`, args: ARGS.exec(content)?.[1].trim() ?? "", at: record.timestamp ?? null });
      }
    }
  };
  collect(records.main, null);
  for (const agent of records.subagents) collect(agent.records, agent.id);
  return { calls, commands, prompts: [...session.inheritedPrompts, ...session.prompts], cwd: session.cwd };
}

const bashCommands = (actions) => actions.calls.filter((call) => call.name === "Bash" && typeof call.input.command === "string");
const hit = (call, evidence, extra = {}) => ({ evidence: clip(evidence), at: call.at, agent: call.agent, ...extra });
const verdictOf = (applies, hits) => ({ verdict: hits.length ? "fail" : applies ? "pass" : "na", hits });

const RUNTIME_BLOCK = "Blocked by the guard-runtimes hook";

// Bash ran a runtime the guard-runtimes hook blocks: Python outside `uv run`, node outside a
// checkout of a repository the hook's node-repos.json lists, or a JavaScript package manager
// other than bun, whatever lockfile the project has. The hook's own matcher and shell walker
// decide, from each call's directory, so scoring and enforcement agree. Where that directory
// is gone, as a T3 worktree is after its merge, or is on another device, the hook's own
// verdict in the result decides whether node was allowed.
export function packageRunner(actions) {
  const commands = bashCommands(actions);
  const hits = [];
  for (const call of commands) {
    const { command } = call.input;
    const allowsNode = (dir) => dir !== undefined && (existsSync(dir) ? nodeCheckout(dir) : call.ok !== null && !call.runtimeBlocked);
    // As in the hook, a command over ssh gets no node exception, even where `bun --cwd` names a local checkout.
    const tool = visitCommands(command, call.cwd ?? actions.cwd ?? "/", (words, dir, { remote }) => (remote
      ? blockedRuntime(words, undefined, () => false)
      : blockedRuntime(words, dir, allowsNode))?.tool);
    if (tool) hits.push(hit(call, `${tool}: ${command}`, { tool }));
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
const WRAPPERS = {
  sudo: ["-u", "-g", "-C"], env: ["-u", "-C"], nice: ["-n"], nohup: [], time: [], command: [], exec: [], timeout: ["-s", "-k"],
  xargs: ["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"],
};
// Shell keywords that can stand before the command of a list.
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);

// Simple commands of a shell command line as word lists, for spotting a program and its
// arguments in real commands, most of which tests/lib/command.js's grammar cannot read.
// See shellCommands.
export const simpleCommands = (command) => shellCommands(command).map((entry) => entry.words);

const fresh = () => ({ words: [], redirects: [], stdin: [], word: "", started: false, quoted: false, pending: null });

// Simple commands of a shell command line: { words, redirects, stdin, from, level }.
// Quotes group words without expansion, so quoted or embedded text never counts as a
// command or an operator, and comments are dropped. Redirects come out of the words:
// redirects lists the files written to (`> f`, `>> f`, `2> f`, `&> f`, `>| f`; not `>&2`),
// stdin the heredoc bodies and here-strings fed to the command, from the command whose
// output is piped into it, and level how many subshells or command substitutions enclose
// it; a command substitution stands as `$(…)` in its word. Shell keywords such as `if`
// or `do`, environment assignments, wrappers such as `timeout` or `sudo`, `sh -c` and
// `eval` are looked through, so words[0] is the program a command runs. A lookup such as
// `command -v x` runs nothing, so its first word stays `command`.
export function shellCommands(command, depth = 0) {
  const lines = String(command).split("\n");
  const kept = [];
  const bodies = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const heredoc = HEREDOC.exec(lines[i]);
    if (!heredoc) continue;
    const body = [];
    while (i + 1 < lines.length && lines[++i].trim() !== heredoc[2]) body.push(lines[i]);
    bodies.push(body.join("\n"));
  }
  const text = kept.join("\n");
  const lists = [];
  // Open subshells and command substitutions; a substitution keeps the command it is in.
  const frames = [];
  let s = fresh();
  let piped = false;
  let quote = null;
  const endWord = () => {
    if (s.started) {
      if (s.pending === ">") s.redirects.push(s.word);
      else if (s.pending === "<<<") s.stdin.push(s.word);
      else if (s.pending === "<<") s.stdin.push(bodies.shift() ?? "");
      else if (s.pending !== "<") s.words.push(s.word);
      s.pending = null;
    }
    Object.assign(s, { word: "", started: false, quoted: false });
  };
  const endList = (pipe = false) => {
    endWord();
    if (s.words.length || s.redirects.length || s.stdin.length)
      lists.push({ words: s.words, redirects: s.redirects, stdin: s.stdin, level: frames.length, from: piped ? lists.at(-1) ?? null : null });
    piped = pipe;
    Object.assign(s, { words: [], redirects: [], stdin: [], pending: null });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') s.word += text[++i] ?? "";
      else s.word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      s.started = s.quoted = true;
    } else if (c === "\\") {
      s.word += text[++i] ?? "";
      s.started = s.quoted = true;
    } else if (c === "#" && !s.started) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === "\n" || c === ";" || c === "`") endList();
    else if (c === " " || c === "\t") endWord();
    else if (c === "$" && next === "(") {
      frames.push({ outer: s, piped });
      s = fresh();
      piped = false;
      i++;
    } else if (c === "(") {
      endList();
      frames.push({ outer: null });
    } else if (c === ")") {
      endList();
      const frame = frames.pop();
      if (frame?.outer) {
        s = frame.outer;
        s.word += "$(…)";
        s.started = true;
        piped = frame.piped;
      }
    } else if (c === "|") {
      if (next === "|") {
        endList();
        i++;
      } else {
        if (next === "&") i++;
        endList(true);
      }
    } else if (c === "&" && next === ">") {
      endWord();
      i += text[i + 2] === ">" ? 2 : 1;
      s.pending = ">";
    } else if (c === "&") {
      endList();
      if (next === "&") i++;
    } else if (c === ">") {
      // A number right before `>` names the file descriptor, not a word.
      if (/^\d+$/.test(s.word) && !s.quoted) Object.assign(s, { word: "", started: false });
      else endWord();
      if (text[i + 1] === ">" || text[i + 1] === "|") i++;
      if (text[i + 1] === "&") {
        i++;
        // `>&2` duplicates a descriptor; `>&file` writes a file like `&>`.
        if (/[\d-]/.test(text[i + 1] ?? "")) {
          while (/[\d-]/.test(text[i + 1] ?? "")) i++;
          continue;
        }
      }
      s.pending = ">";
    } else if (c === "<") {
      endWord();
      // `<(…)`: the parenthesis opens a subshell.
      if (next === "(") continue;
      if (next === "<" && text[i + 2] === "<") {
        i += 2;
        s.pending = "<<<";
      } else if (next === "<") {
        i += text[i + 2] === "-" ? 2 : 1;
        s.pending = "<<";
      } else s.pending = "<";
    } else {
      s.word += c;
      s.started = true;
    }
  }
  while (frames.length) {
    endList();
    const frame = frames.pop();
    if (frame.outer) s = frame.outer;
  }
  endList();
  return lists.flatMap((list) => (list.out = unwrap(list, depth)));
}

// The commands a list runs, with its wrappers and keywords stripped.
function unwrap(list, depth) {
  let { words } = list;
  for (;;) {
    while (words.length && (KEYWORDS.has(words[0]) || /^\w+=/.test(words[0]))) words = words.slice(1);
    if (!words.length || !Object.hasOwn(WRAPPERS, basename(words[0]))) break;
    const wrapper = basename(words[0]);
    // `command -v` and `-V` look a program up and run nothing, like `type` or `which`.
    if (wrapper === "command" && words.slice(1).some((word) => /^-[a-zA-Z]*[vV]/.test(word))) break;
    words = words.slice(1);
    while (words.length && (words[0].startsWith("-") || (wrapper === "env" && /^\w+=/.test(words[0]))))
      words = words.slice(WRAPPERS[wrapper].includes(words[0]) ? 2 : 1);
    if (wrapper === "timeout") words = words.slice(1);
  }
  if (!words.length) return [];
  const program = basename(words[0]);
  const inner = (code) => shellCommands(code, depth + 1).map((entry) => ({ ...entry, level: entry.level + list.level }));
  if (depth < 3 && SHELLS.has(program) && /^-\w*c$/.test(words[1] ?? "") && words[2] !== undefined) return inner(words[2]);
  if (depth < 3 && program === "eval") return inner(words.slice(1).join(" "));
  return [{ words, redirects: list.redirects, stdin: list.stdin, level: list.level, from: list.from?.out?.at(-1) ?? null }];
}

const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const PUSH_WITH_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

// Each push and merge in a command, in order: { kind: "push", args, dir } for a
// `git push` (dir: its last -C, or null) and { kind: "merge" } for `gh pr merge`.
// moved: whether a cd or pushd came before it; last: whether it is the final command.
function pushCommands(command) {
  const all = simpleCommands(command);
  const found = [];
  let moved = false;
  all.forEach((words, index) => {
    let i = words.findIndex((word) => !/^\w+=/.test(word));
    if (i < 0) return;
    const program = basename(words[i]);
    const at = { moved, last: index === all.length - 1 };
    if (program === "cd" || program === "pushd") moved = true;
    else if (program === "gh" && words[i + 1] === "pr" && words[i + 2] === "merge") found.push({ kind: "merge", ...at });
    if (program !== "git") return;
    let dir = null;
    for (i++; i < words.length && words[i].startsWith("-"); i += GIT_GLOBAL_WITH_VALUE.has(words[i]) ? 2 : 1) if (words[i] === "-C") dir = words[i + 1] ?? null;
    if (words[i] === "push") found.push({ kind: "push", args: words.slice(i + 1), dir, ...at });
  });
  return found;
}

// Arguments of each `git push` in a command.
export const gitPushes = (command) => pushCommands(command).filter((found) => found.kind === "push").map((found) => found.args);

const PROTECTED = new Set(["main", "master"]);

// Why a push breaks the force-push rule, or null when it does not force or follows it.
// currentBranch is the branch the session was on: what HEAD and a push without a
// refspec name.
export function forcePushProblem(args, currentBranch = null) {
  const branchOf = (ref) => {
    const branch = ref.replace(/^\+/, "").split(":").at(-1).replace(/^refs\/heads\//, "");
    return branch === "HEAD" ? currentBranch : branch;
  };
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
  // --mirror force-updates every remote ref, and a forced --all every branch: main too.
  if (args.includes("--mirror")) return "mirror push, which force-updates every remote ref";
  if (!plainForce && !plusRef && !leases.length) return null;
  if (args.includes("--all") || args.includes("--branches")) return "force push of all branches, a default branch included";
  const targets = refspecs.length ? refspecs.map(branchOf) : [currentBranch];
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

const SETTINGS_FILE = /(?:^|[/\s"'`=(])settings(?:\.local)?\.json\b/;
const isSettingsPath = (word) => /(?:^|\/)settings(?:\.local)?\.json$/.test(word);

// Modes a settings text turns on: fastMode set to true, or a value of ultrathink or
// ultracode (`"effortLevel": "ultrathink"`, jq's `.effortLevel = "ultrathink"`). A
// comparison (`==`) or a mere mention turns nothing on. bareValue also counts an edit
// whose whole new text is such a value.
const FAST_ON = /["']?\bfastMode["']?\s*[:=]\s*true\b/i;
const ULTRA_VALUE = /(?:^|[^=!<>])[:=]\s*\\?["']ultra(?:think|code)\\?["']/i;
const ULTRA_ONLY = /^\s*["']ultra(?:think|code)["']\s*,?\s*$/i;
function modesTurnedOn(text, { bareValue = false } = {}) {
  const modes = [];
  if (FAST_ON.test(text)) modes.push("fast");
  if (ULTRA_VALUE.test(text) || (bareValue && ULTRA_ONLY.test(text))) modes.push("ultra effort");
  return modes;
}

const SCRIPT_RUNNERS = /^(?:python[\d.]*|bun|node|deno|uv|ruby)$/;
// Code that writes a file: Python's open(…, "w"), Path.write_text and Path.open("w"),
// Node's writeFile, Bun.write, Deno's write functions and Ruby's File.write.
const FILE_WRITE = /\bopen\((?:[^()]|\([^()]*\))*,\s*(?:mode\s*=\s*)?["'][wax][bt+]*["']|\.open\(\s*["'][wax][bt+]*["']|\.write_(?:text|bytes)\(|\b(?:writeFile|appendFile|writeTextFile)(?:Sync)?\(|\bBun\.write\(|\bFile\.write\(|\bDeno\.write/;

// Files a `sed`, `perl` or `ruby` command edits in place (empty when xargs supplies
// them), or null when it edits nothing in place. sed's -e and -f, and perl's and ruby's
// -e, take the next word as the script; otherwise the first operand is the script. A
// switch cluster such as `-pi.bak` ends at -i, whose rest is the backup suffix; BSD sed's
// `-i ''` and `-i .bak` take the suffix as the next word.
function inPlaceFiles(words) {
  const program = basename(words[0]);
  if (!["sed", "perl", "ruby"].includes(program)) return null;
  const args = words.slice(1);
  let inPlace = false;
  let script = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--in-place" || arg.startsWith("--in-place=")) inPlace = true;
    else if (["--expression", "--file"].includes(arg)) {
      script = true;
      i++;
    } else if (arg.startsWith("--")) script ||= /^--(?:expression|file)=/.test(arg);
    // perl and ruby: -M, -m and -I name a module or folder, attached or as the next word.
    else if (program !== "sed" && /^-[MmI]/.test(arg)) i += arg.length === 2 ? 1 : 0;
    else if (/^-[\w.]/.test(arg)) {
      const flags = arg.slice(1);
      const at = flags.search(program === "sed" ? /[iI]/ : /i/);
      if (at >= 0) {
        inPlace = true;
        if (program === "sed" && at === flags.length - 1 && (args[i + 1] === "" || args[i + 1]?.startsWith("."))) i++;
      }
      if ((program === "sed" ? /[ef]$/ : /[eE]$/).test(at >= 0 ? flags.slice(0, at) : flags)) {
        script = true;
        i++;
      }
    } else if (!script) script = true;
    else files.push(arg);
  }
  return inPlace ? files : null;
}

// Whether a shell command writes a settings file: a redirect to it, `tee`, an in-place
// `sed -i` or `perl -pi`, `mv` or `cp` onto it, or a script that names it and writes.
function writesSettings(command) {
  const commands = shellCommands(command);
  for (const { words, redirects } of commands) {
    const program = basename(words[0]);
    if (redirects.some(isSettingsPath)) return true;
    if (program === "tee" && words.slice(1).some(isSettingsPath)) return true;
    if (inPlaceFiles(words)?.some(isSettingsPath)) return true;
    if (["mv", "cp"].includes(program) && isSettingsPath(words.at(-1))) return true;
  }
  return commands.some(({ words }) => SCRIPT_RUNNERS.test(basename(words[0]))) && SETTINGS_FILE.test(command) && FILE_WRITE.test(command);
}

// The modes an agent action turns on.
function actionModes(call) {
  const { name, input } = call;
  if (name === "Skill") {
    const skill = String(input.skill ?? "").replace(/^.*:/, "");
    const args = String(input.args ?? "");
    if (/^(?:code-)?review$/.test(skill) && /^\s*ultra\b/i.test(args)) return ["ultra review"];
    if (skill === "fast") return ["fast"];
    if (["effort", "model"].includes(skill)) return [commandMode({ name: `/${skill}`, args })].filter(Boolean);
    return [];
  }
  const path = input.file_path ?? input.notebook_path ?? "";
  if (["Edit", "Write", "MultiEdit"].includes(name) && SETTINGS_FILE.test(path)) {
    const texts = [input.new_string, input.content, ...(input.edits ?? []).map((edit) => edit.new_string)].filter((text) => typeof text === "string");
    return [...new Set(texts.flatMap((text) => modesTurnedOn(text, { bareValue: true })))];
  }
  if (name === "Bash" && typeof input.command === "string" && writesSettings(input.command)) return modesTurnedOn(input.command);
  return [];
}

export function ultraEffort(actions) {
  const hits = [];
  const before = (at) => (item) => !at || !item.at || item.at <= at;
  for (const call of actions.calls)
    for (const mode of actionModes(call)) {
      const asked = actions.prompts.filter(before(call.at)).some((prompt) => askedIn(prompt.text, mode))
        || actions.commands.filter(before(call.at)).some((command) => commandMode(command) === mode);
      if (!asked) hits.push(hit(call, `${mode} with no prompt asking: ${call.name} ${JSON.stringify(call.input)}`, { mode }));
    }
  return verdictOf(true, hits);
}

// Where a shell write may go without being a file edit: devices and temporary folders.
const SCRATCH_DIRS = [...TEMP_DIRS, "/var/tmp", "/private/var/tmp", "/dev", "$TMPDIR", "${TMPDIR}"];
const isScratch = (path) => SCRATCH_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
const ASSIGNMENT = /(?:^|[\s;&|(])([A-Za-z_]\w*)=("[^"$`]*"|'[^']*'|[^\s;&|()$`'"]+)/g;
const VARIABLE = /\$\{?([A-Za-z_]\w*)\}?/g;

// The inline code a command runs, or null: `python3 - <<EOF`, `python3 -c '…'`, code
// piped in, `bun -e '…'`, `deno eval '…'`, also through `uv run` (`uv run -` too).
function inlineCode({ words, stdin }) {
  if (basename(words[0]) === "uv") {
    if (words[1] !== "run") return null;
    const python = words.findIndex((word, i) => i > 1 && /^python[\d.]*$/.test(word));
    if (python < 0) return words.includes("-") ? stdin.join("\n") : null;
    words = words.slice(python);
  }
  const runner = basename(words[0]);
  if (runner === "deno") return words[1] === "eval" ? words[2] ?? null : null;
  if (!/^(?:python[\d.]*|bun|node|ruby)$/.test(runner)) return null;
  for (let i = 1; i < words.length; i++) {
    if (/^-[a-zA-Z]*[ce]$|^--eval$/.test(words[i])) return words[i + 1] ?? null;
    if (words[i] === "-") return stdin.join("\n");
    if (!words[i].startsWith("-")) return null;
  }
  return stdin.length ? stdin.join("\n") : null;
}

// What inline code writes: files named by a literal or by a name assigned a literal
// (`p = Path("a.md")`, `const f = "a.json"`), and whether some write's file is unknown.
const TARGET = String.raw`(?:["'](?<literal>[^"'\n]+)["']|(?<name>\w+))`;
const WRITE_TARGETS = [
  String.raw`\bopen\(\s*${TARGET}\s*,\s*(?:mode\s*=\s*)?["'][wax]`,
  String.raw`\bopen\(\s*(?:pathlib\.)?Path\(\s*${TARGET}\s*\)\s*,\s*(?:mode\s*=\s*)?["'][wax]`,
  String.raw`\b(?:pathlib\.)?Path\(\s*${TARGET}\s*\)\s*\.(?:write_text|write_bytes|open\(\s*["'][wax])`,
  String.raw`\b(?<name>\w+)\.(?:write_text|write_bytes|open\(\s*["'][wax])`,
  String.raw`\b(?:writeFile|appendFile|writeTextFile|Bun\.write|File\.write)(?:Sync)?\(\s*${TARGET}`,
].map((source) => new RegExp(source, "g"));
const NAMED_LITERAL = /\b(\w+)\s*=\s*(?:(?:pathlib\.)?Path\(\s*)?["']([^"'\n]+)["']/g;

function scriptWrites(code) {
  const names = new Map([...code.matchAll(NAMED_LITERAL)].map((match) => [match[1], match[2]]));
  const files = [];
  let unknown = false;
  for (const pattern of WRITE_TARGETS)
    for (const { groups } of code.matchAll(pattern)) {
      const file = groups.literal ?? names.get(groups.name);
      if (file === undefined) unknown = true;
      else files.push(file);
    }
  return { files, unknown: unknown || !files.length };
}

// Edits one Bash command makes the way the Edit or Write tool would: { how, file }, file
// null when unknown. Counted: in place with `sed -i`, `perl -pi` or `ruby -i`; text the
// agent wrote (echo, printf, a heredoc or here-string) redirected, or piped through `tee`,
// into a file; inline code that writes files. Output of other programs redirected into a
// file (`git diff > x.patch`, `cargo build | tee log`) is not an edit.
// Scratch files do not count, nor relative ones after a `cd` into scratch or to a folder
// built at run time; a `cd` in a subshell ends with it. Variables set by literal
// assignments in the command are followed; a file still built from another variable or
// a command substitution is unknown and does not count. An inline write whose file is
// unknown counts unless the script runs in scratch or every path it names is scratch.
export function shellEdits(command) {
  const variables = new Map([...String(command).matchAll(ASSIGNMENT)].map((match) => [match[1], match[2].replace(/^(["'])(.*)\1$/, "$2")]));
  const expand = (word) => word.replace(VARIABLE, (text, name) => (name === "HOME" ? "~" : variables.get(name) ?? text));
  // Where relative paths lead: "work" (a real folder), "scratch" or "unknown".
  let cwd = "work";
  const outer = [];
  const fileOf = (target) => {
    const path = expand(target);
    if (!path || isScratch(path) || /[$`]/.test(path)) return null;
    return /^[/~]/.test(path) || cwd === "work" ? path : null;
  };
  const edits = [];
  const add = (how, targets) => {
    for (const file of targets.map(fileOf)) if (file) edits.push({ how, file });
  };
  const authored = (entry) => entry && (["echo", "printf"].includes(basename(entry.words[0])) || (basename(entry.words[0]) === "cat" && entry.stdin.length > 0));
  for (const entry of shellCommands(command)) {
    while (outer.length > entry.level) cwd = outer.pop();
    while (outer.length < entry.level) outer.push(cwd);
    const { words, redirects } = entry;
    const program = basename(words[0]);
    const args = words.slice(1);
    const inPlace = inPlaceFiles(words);
    if (program === "cd") {
      const path = expand(args.find((arg) => !arg.startsWith("-")) ?? "~");
      if (isScratch(path)) cwd = "scratch";
      else if (/[$`]/.test(path)) cwd = "unknown";
      else if (/^[/~]/.test(path)) cwd = "work";
    } else if (inPlace) {
      if (inPlace.length) add(`${program} in place`, inPlace);
      else if (cwd === "work") edits.push({ how: `${program} in place`, file: null });
    } else if (authored(entry)) add(`${program} into a file`, redirects);
    else if (program === "tee" && (entry.stdin.length || authored(entry.from))) add("tee into a file", args.filter((arg) => !arg.startsWith("-")));
    else {
      const code = inlineCode(entry);
      if (code === null || !FILE_WRITE.test(code)) continue;
      const { files, unknown } = scriptWrites(code);
      const before = edits.length;
      add("inline script writing", files);
      // Paths the code names: literals with a slash, or given to Path, open or glob.
      const paths = [...code.matchAll(/(\b(?:Path|open|glob)\(\s*)?["']([^"'\s]+)["']/g)].filter(([, call, text]) => call || text.includes("/")).map((match) => match[2]);
      if (unknown && edits.length === before && cwd === "work" && !(paths.length && paths.every(isScratch))) edits.push({ how: "inline script writing files", file: null });
    }
  }
  return [...new Map(edits.map((edit) => [`${edit.how}\0${edit.file}`, edit])).values()];
}

// The paths a patch changes: both sides of each `diff --git`, `---` and `+++` line.
function patchPaths(patch) {
  const paths = [];
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (header) paths.push(header[1], header[2]);
    const side = /^(?:---|\+\+\+) [ab]\/(\S+)/.exec(line);
    if (side) paths.push(side[1]);
  }
  return paths;
}

// Files one Bash command deletes, moves, copies over or patches, as written (relative
// paths are from the folder the command runs in, or its last `git -C`): `rm`, `mv`,
// `cp`, `git rm`, `git mv`, `git checkout … -- <path>` and `git apply` of a patch given
// on stdin (a heredoc, a here-string or text piped in). A move or copy into a folder
// also names the file it makes there. Patch files on disk are not read, and scratch
// paths and paths built at run time do not count.
export function shellChanges(command) {
  const files = [];
  const add = (paths, dir = null) => {
    for (const path of paths)
      if (path && !isScratch(path) && !/[$`]/.test(path)) files.push(dir && !/^[/~]/.test(path) ? join(dir, path) : path);
  };
  const positional = (args) => {
    const end = args.indexOf("--");
    return [...(end < 0 ? args : args.slice(0, end)).filter((arg) => !arg.startsWith("-")), ...(end < 0 ? [] : args.slice(end + 1))];
  };
  // A move or copy: the target, and for each source the file it makes inside a target folder.
  const moves = (paths, dir, sources = true) => {
    if (paths.length < 2) return;
    const target = paths.at(-1);
    add(sources ? paths : [target], dir);
    add(paths.slice(0, -1).map((source) => join(target, basename(source))), dir);
  };
  for (const entry of shellCommands(command)) {
    const { words } = entry;
    const program = basename(words[0]);
    if (program === "rm") add(positional(words.slice(1)));
    else if (program === "mv") moves(positional(words.slice(1)), null);
    else if (program === "cp") moves(positional(words.slice(1)), null, false);
    if (program !== "git") continue;
    let i = 1;
    let dir = null;
    for (; i < words.length && words[i].startsWith("-"); i += GIT_GLOBAL_WITH_VALUE.has(words[i]) ? 2 : 1) if (words[i] === "-C") dir = join(dir ?? "", words[i + 1] ?? "");
    const [sub, ...args] = words.slice(i);
    if (sub === "rm") add(positional(args), dir);
    else if (sub === "mv") moves(positional(args), dir);
    else if (sub === "checkout" && args.includes("--")) add(args.slice(args.indexOf("--") + 1), dir);
    // `--check`, `--stat` and the like only report, unless `--apply` comes with them.
    else if (sub === "apply" && (args.includes("--apply") || !args.some((arg) => ["--check", "--stat", "--numstat", "--summary"].includes(arg)))) {
      const stdin = entry.stdin.length ? entry.stdin : entry.from?.stdin ?? [];
      add(patchPaths(stdin.join("\n")), dir);
    }
  }
  return [...new Set(files)];
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function shellFileEdit(actions) {
  const hits = [];
  for (const call of bashCommands(actions)) {
    const edits = shellEdits(call.input.command);
    if (edits.length) hits.push(hit(call, `${edits.map(({ how, file }) => (file ? `${how} ${file}` : how)).join(", ")}: ${call.input.command}`, { files: edits.map((edit) => edit.file).filter(Boolean) }));
  }
  // The rule applies to sessions that edited files at all.
  return verdictOf(actions.calls.some((call) => EDIT_TOOLS.has(call.name)), hits);
}

// This device's trivial-file list, board checkouts, other git checkouts, T3 Code project
// roots and git ignore rules, read once per process.
let reviewContext = null;
const defaultReviewContext = () => (reviewContext ??= { matcher: reviewMatcher(loadReviewScope()), checkouts: boardCheckouts(), git: gitCheckout, projects: t3Projects(), ignored: gitIgnored });

// A push that sends commits: not a dry run, a branch delete or a tags-only push.
function sendsCommits(args) {
  if (args.some((arg) => ["--dry-run", "-n", "--delete", "-d"].includes(arg))) return false;
  const positional = args.filter((arg, i) => !arg.startsWith("-") && !PUSH_WITH_VALUE.has(args[i - 1]));
  const refspecs = positional.slice(1);
  if (refspecs.length && refspecs.every((ref) => ref.startsWith(":"))) return false;
  return !(args.includes("--tags") && !refspecs.length);
}

// An absolute path from a path a command names: ~ is the home folder, and a relative
// path is taken from the call's folder unless the command changed folder first.
function absolute(path, cwd, moved) {
  if (typeof path !== "string" || !path) return null;
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path.startsWith("/")) return path;
  return cwd && !moved ? join(cwd, path) : null;
}

const REVIEW_SKILL = /^(?:[\w.-]+:)?code-review$/;
const REVIEW_COMMAND = /^\/(?:[\w.-]+:)?(?:code-)?review$/;
const isReview = (call) => isReviewerRun(call) || isCodeReview(call) || (call.name === "Skill" && REVIEW_SKILL.test(String(call.input.skill)) && call.ok !== false);

// Pushes and merges of changes with no review, which is a `reviewer` agent run or a
// /code-review: a session edited a file in any repository that is not on the trivial
// list (review-scope.toml), then pushed or merged with no review started since the
// first such edit. Files map to repositories through the board's checkouts, then
// through git for other checkouts on this device, then, for a removed T3 Code worktree,
// through T3's project list. Edits after the review, such as
// fixes for its findings, need no second one, and neither do later fixes to files a
// reviewed push sent. A push settles the edits of the repository its folder belongs to,
// or every repository's when the folder is unknown; a review counts for every
// repository. Edits by subagents count, through Bash too, including the deletes, moves,
// copies and patches shellChanges finds; files git ignores do not. Writes through MCP
// tools and pushes other than `git push` and `gh pr merge` are not seen. na when the
// session pushed no edit that needs a review.
export function reviewSkipped(actions, context) {
  const events = [];
  for (const call of actions.calls) {
    if (call.name !== "Bash" || typeof call.input.command !== "string") continue;
    for (const found of pushCommands(call.input.command)) {
      // A failed command's last part may be the push that failed.
      if (found.kind === "push" && !sendsCommits(found.args)) continue;
      if (call.ok === false && found.last) continue;
      const dir = found.kind === "push" && found.dir ? absolute(found.dir, call.cwd, found.moved) : found.moved ? null : call.cwd;
      events.push({ kind: "push", at: call.at, call, dir });
    }
  }
  if (!events.length) return verdictOf(false, []);

  const { matcher, checkouts, git = () => null, projects = [], ignored } = context ?? defaultReviewContext();
  const where = (file) => locate(file, checkouts) ?? git(file) ?? t3Checkout(file, projects, git);
  const repoOf = (dir) => where(realFile(join(dir, "_")))?.repo ?? "";
  for (const event of events) event.repo = event.dir ? repoOf(event.dir) : null;
  for (const call of actions.calls) {
    let files = [];
    if (EDIT_TOOLS.has(call.name)) {
      if (call.ok !== false) files = [call.input.file_path ?? call.input.notebook_path];
    } else if (call.name === "Bash" && typeof call.input.command === "string") {
      // A failed command may still have made its edits before the part that failed.
      const moved = simpleCommands(call.input.command).some((words) => ["cd", "pushd"].includes(basename(words[0] ?? "")));
      files = [...shellEdits(call.input.command).map((edit) => edit.file), ...shellChanges(call.input.command)].map((file) => absolute(file, call.cwd, moved));
    }
    const located = files.filter(Boolean).map((file) => where(realFile(file))).filter((file) => file && matcher(file) && !ignored(file));
    if (located.length) events.push({ kind: "edit", at: call.at, located });
    if (isReview(call)) events.push({ kind: "review", at: call.at });
  }
  for (const command of actions.commands) if (REVIEW_COMMAND.test(command.name)) events.push({ kind: "review", at: command.at });
  const order = { edit: 0, review: 1, push: 2 };
  events.sort((a, b) => {
    const [x, y] = [a.at ?? "", b.at ?? ""];
    return x < y ? -1 : x > y ? 1 : order[a.kind] - order[b.kind];
  });

  const hits = [];
  const pending = new Map();
  const covered = new Set();
  let reviewed = false;
  let applies = false;
  for (const event of events) {
    if (event.kind === "edit") {
      for (const file of event.located) {
        const key = `${file.repo}\0${file.path}`;
        if (!covered.has(key)) pending.set(key, file);
      }
    } else if (event.kind === "review") reviewed ||= pending.size > 0;
    else {
      const settled = [...pending].filter(([, file]) => event.repo === null || file.repo === event.repo);
      if (!settled.length) continue;
      applies = true;
      if (reviewed) for (const [key] of settled) covered.add(key);
      else {
        const files = [...new Set(settled.map(([, { repo, path }]) => `${repo.replace(/^github\.com\//, "")}:${path}`))];
        hits.push(hit(event.call, `pushed ${files.join(", ")} with no review: ${event.call.input.command}`, { files }));
      }
      for (const [key] of settled) pending.delete(key);
      reviewed &&= pending.size > 0;
    }
  }
  return verdictOf(applies, hits);
}

export const DETECTORS = {
  "package-runner": packageRunner,
  "ai-attribution": aiAttribution,
  "force-push": forcePush,
  "ultra-effort": ultraEffort,
  "shell-file-edit": shellFileEdit,
  "review-skipped": (actions) => reviewSkipped(actions),
};

// Every detector's result for a session: { [id]: { verdict, hits } }.
export function runDetectors(session, records) {
  const actions = sessionActions(session, records);
  return Object.fromEntries(Object.entries(DETECTORS).map(([id, detect]) => [id, detect(actions)]));
}
