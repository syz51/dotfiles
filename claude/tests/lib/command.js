// Which project check a Bash command ran, and in which directory. This is a small
// literal grammar, not a shell interpreter: a command it cannot read proves nothing.
// It reads plain words, quotes without expansion, `&&` lists, a trailing `2>&1`, `>` and
// `>>` to a literal file, and one `sh -c`/`bash -lc` wrapper. A zero exit of an all-`&&`
// list proves each part succeeded; `||`, pipes, substitutions and other redirections
// could mask a failure. An output redirection cannot change a part's exit status, but it
// marks the part `redirected`, and a redirected check proves nothing because its output
// must show the success marker.
// A script of `;`- or newline-separated segments exits with its last segment, so a
// zero exit proves the parts of that segment and nothing about the earlier ones.
import { isAbsolute, resolve } from "node:path";

const SHELLS = new Set(["sh", "bash", "zsh", "/bin/sh", "/bin/bash", "/bin/zsh"]);

function literalLists(source) {
  if (typeof source !== "string" || /[\0\r\n]/.test(source)) return null;
  const lists = [];
  let words = [];
  let word = "";
  let started = false;
  let quote = null;
  let target = false; // the next word is an output redirection's file
  let redirected = false;
  const finishWord = () => {
    if (started) {
      if (target) target = false;
      else words.push(word);
    }
    word = "";
    started = false;
  };
  const finishList = () => {
    finishWord();
    if (target) return false;
    if (words.at(-1) === "2>&1") words.pop();
    if (!words.length) return false;
    if (redirected) words.redirected = true;
    lists.push(words);
    words = [];
    redirected = false;
    return true;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && /[$`\\]/.test(c)) return null;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === " " || c === "\t") finishWord();
    else if (c === "&" && source[i + 1] === "&") {
      if (!finishList()) return null;
      i++;
    } else if (c === "2" && !started && source.startsWith("2>&1", i) && /^(?:\s|&&|$)/.test(source.slice(i + 4))) {
      words.push("2>&1");
      i += 3;
    } else if (c === ">" && !target) {
      finishWord();
      if (source[i + 1] === ">") i++;
      if (source[i + 1] === "&" || source[i + 1] === "|") return null;
      target = true;
      redirected = true;
    } else if (/[;|&<>#$`\\(){}[\]*?~!]/.test(c)) return null;
    else {
      started = true;
      word += c;
    }
  }
  if (quote || !finishList()) return null;
  // `2>&1` is accepted only as the last word of a list.
  return lists.some((list) => list.includes("2>&1")) ? null : lists;
}

// The command as lists of literal words, or null when the grammar cannot read it.
export function commandLists(command) {
  const lists = literalLists(command);
  if (!lists) return null;
  if (lists.length === 1 && SHELLS.has(lists[0][0])) {
    const [, flag, inner, ...rest] = lists[0];
    if (rest.length || !["-c", "-lc"].includes(flag)) return null;
    const innerLists = literalLists(inner);
    return innerLists?.some((words) => SHELLS.has(words[0])) ? null : innerLists;
  }
  return lists;
}

// Environment assignments that only keep uv offline and quiet.
const UV_ENV = new Set(["UV_OFFLINE=1", "UV_NO_CACHE=1", "UV_PYTHON_DOWNLOADS=never", "PYTHONDONTWRITEBYTECODE=1"]);
const UV_FLAGS = new Set(["--no-project", "--no-config", "--offline", "--no-cache", "--no-python-downloads", "--no-managed-python", "--quiet", "-q"]);

// Whether words run the contract's check: uv runs a Python script, bun runs a script,
// npm runs the package's test script.
export function checkInvocation(source, { tool, script }) {
  const words = [...source];
  if (tool === "uv") while (UV_ENV.has(words[0])) words.shift();
  const same = (expected) => JSON.stringify(words) === JSON.stringify(expected);
  const scripts = [script, `./${script}`];
  if (tool === "bun") return scripts.some((path) => same(["bun", path]) || same(["bun", "run", path]));
  if (tool === "npm") return same(["npm", "test"]) || same(["npm", "t"]) || same(["npm", "run", "test"]);
  if (tool !== "uv" || words[0] !== "uv" || words[1] !== "run") return false;
  const args = words.slice(2);
  while (UV_FLAGS.has(args[0])) args.shift();
  if (["python", "python3"].includes(args[0])) {
    args.shift();
    if (args[0] === "-B") args.shift();
  }
  return args.length === 1 && scripts.includes(args[0]);
}

const operand = (word) => !!word && !word.startsWith("-");

// Builtins that move the shell or change what a later word runs. A part or segment using
// one, a function definition or a bare assignment (such as PATH=...) proves nothing.
const STATEFUL = new Set(["pushd", "popd", "source", ".", "eval", "exec", "alias", "unalias", "function", "hash",
  "export", "unset", "set", "shopt", "builtin", "command", "enable", "declare", "typeset", "trap", "cd"]);
const statefulText = (text) => {
  const bare = text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " ");
  return /\(\s*\)|(?:^|[\s;&|(])[A-Za-z_]\w*=/.test(bare)
    || bare.split(/[\s;&|()]+/).some((word) => STATEFUL.has(word));
};

// The command as top-level segments split at `;` and newlines, each { text, lists }
// where lists is null when the grammar cannot read the segment. Heredoc bodies stay with
// their line. Null when the command has an unterminated quote or heredoc.
function segments(command) {
  if (typeof command !== "string" || command.includes("\0")) return null;
  const lines = command.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while (/&&\s*$/.test(line) && i + 1 < lines.length) line += ` ${lines[++i]}`;
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(line);
    if (heredoc) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== heredoc[2]) j++;
      if (j === lines.length) return null;
      out.push({ text: line, lists: null });
      i = j;
      continue;
    }
    let quote = null;
    let current = "";
    for (const c of line) {
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === "'" || c === '"') quote = c;
      else if (c === ";") {
        out.push({ text: current, lists: null });
        current = "";
        continue;
      }
      current += c;
    }
    if (quote) return null;
    out.push({ text: current, lists: null });
  }
  return out.filter((segment) => segment.text.trim()).map((segment) => ({ ...segment, lists: commandLists(segment.text) }));
}

// Whether the command ran the contract's check in the fixture directory. cwd is the
// directory the session reported for this call (from a PreToolUse hook), never a guess;
// a literal `cd` moves it, and a `cd` in an earlier segment, which may have failed,
// leaves either directory possible.
export function checkRun(command, contract, { cwd, fixture }) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return false;
  let parts = segments(command);
  // One standard wrapper around a whole script.
  const outer = parts?.length === 1 ? literalLists(parts[0].text) : null;
  if (outer?.length === 1 && SHELLS.has(outer[0][0]) && outer[0].length === 3 && ["-c", "-lc"].includes(outer[0][1])) {
    parts = segments(outer[0][2]);
  }
  if (!parts?.length) return false;
  const last = parts.at(-1);
  if (!last.lists) return false;
  let possible = new Set([cwd]);
  for (const segment of parts.slice(0, -1)) {
    if (!segment.lists) {
      if (statefulText(segment.text)) return false;
      continue;
    }
    for (const words of segment.lists) {
      if (words[0] === "cd") {
        if (words.length !== 2 || !operand(words[1])) return false;
        possible = new Set([...possible, ...[...possible].map((dir) => resolve(dir, words[1]))]);
      } else if (STATEFUL.has(words[0]) || /^\w+=/.test(words[0]) && words.every((word) => /^\w+=/.test(word))) return false;
    }
  }
  let checks = 0;
  for (const words of last.lists) {
    if (words[0] === "cd") {
      if (words.length !== 2 || !operand(words[1])) return false;
      possible = new Set([...possible].map((dir) => resolve(dir, words[1])));
    } else if (!words.redirected && checkInvocation(words, contract)) {
      if (possible.size !== 1 || !possible.has(fixture)) return false;
      checks++;
    } else if (STATEFUL.has(words[0]) || words.every((word) => /^\w+=/.test(word))) return false;
  }
  return checks > 0;
}

// Whether one Bash call ran the check in the fixture, exited zero and printed the
// fixture's success marker. runs: [{ command, cwd, ok, output }].
export const successfulCheck = (runs, contract, fixture) => runs.some((run) =>
  run.ok && run.output.split(/\r?\n/).includes("fixture-check:ok") && checkRun(run.command, contract, { cwd: run.cwd, fixture }));

// Whether a command may have run the tool (or its x-runner, such as bunx). For a command
// the grammar cannot read, any word in command position counts: at the start, after a
// shell operator or opening an `sh -c` string, after environment assignments.
export function mayInvoke(command, tool) {
  const lists = commandLists(command);
  const name = tool.replace(/[.+]/g, "\\$&");
  if (!lists) return new RegExp(`(?:^|[;&|(\`]|-c\\s+['"])\\s*(?:\\w+=\\S*\\s+)*(?:\\S*/)?${name}x?(?=$|[\\s'";&|)])`).test(command);
  return lists.some((words) => {
    const program = words.find((word) => !/^\w+=/.test(word));
    return [tool, `${tool}x`].includes(program?.replace(/^.*\//, ""));
  });
}
