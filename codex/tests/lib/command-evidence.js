import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

// This is a small evidence grammar, not a general-purpose shell interpreter.
// A zero exit status for an all-&& list proves every synchronous component
// succeeded. Other operators cannot establish that fact and remain unverified.
const shells = new Set([
  "sh",
  "bash",
  "zsh",
  "/bin/sh",
  "/bin/bash",
  "/bin/zsh",
]);

function literalLists(source) {
  if (typeof source !== "string" || /[\0\r\n]/.test(source)) return null;
  const lists = [];
  let words = [],
    word = "",
    started = false,
    quote = null;
  const finishWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
      else {
        // Double-quoted expansion and escapes are not literal shell data.
        if (quote === '"' && /[$`\\]/.test(c)) return null;
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/[ \t]/.test(c)) finishWord();
    else if (c === "&" && source[i + 1] === "&") {
      finishWord();
      if (!words.length) return null;
      lists.push(words);
      words = [];
      i++;
    } else {
      // Reject every other operator, substitution, comment and shell expansion.
      if (/[;|&<>#$`\\(){}\[\]*?~]/.test(c)) return null;
      started = true;
      word += c;
    }
  }
  if (quote) return null;
  finishWord();
  if (!words.length) return null;
  lists.push(words);
  return lists;
}

export function commandLists(command) {
  const lists = literalLists(command);
  if (!lists) return null;
  if (lists.length === 1 && shells.has(lists[0][0])) {
    const words = lists[0];
    if (words.length !== 3 || !["-c", "-lc"].includes(words[1])) return null;
    const inner = literalLists(words[2]);
    // One standard wrapper is sufficient for CLI events. Nested wrappers do
    // not gain trust merely because their outer executable is a known shell.
    return inner?.some((part) => shells.has(part[0])) ? null : inner;
  }
  return lists;
}

export function commandWords(command) {
  const lists = commandLists(command);
  return lists?.length === 1 ? lists[0] : null;
}

function checkInvocation(source, contract) {
  const words = [...source];
  if (contract.tool === "uv")
    while (
      [
        "UV_OFFLINE=1",
        "UV_NO_CACHE=1",
        "UV_PYTHON_DOWNLOADS=never",
        "PYTHONDONTWRITEBYTECODE=1",
      ].includes(words[0])
    )
      words.shift();
  if (contract.tool === "bun")
    return (
      JSON.stringify(words) === JSON.stringify(["bun", contract.script]) ||
      JSON.stringify(words) === JSON.stringify(["bun", "run", contract.script])
    );
  if (contract.tool === "npm")
    return (
      JSON.stringify(words) === JSON.stringify(["npm", "test"]) ||
      JSON.stringify(words) === JSON.stringify(["npm", "run", "test"])
    );
  if (contract.tool !== "uv" || words[0] !== "uv" || words[1] !== "run")
    return false;
  const args = words.slice(2);
  while (
    [
      "--no-project",
      "--no-config",
      "--offline",
      "--no-cache",
      "--no-python-downloads",
      "--no-managed-python",
    ].includes(args[0])
  )
    args.shift();
  if (["python", "python3"].includes(args[0])) {
    args.shift();
    if (args[0] === "-B") args.shift();
  }
  return (
    args.length === 1 &&
    [contract.script, "./" + contract.script].includes(args[0])
  );
}

const operand = (s) => typeof s === "string" && !!s && !s.startsWith("-");
function utility(name) {
  for (const root of ["", "/bin/", "/usr/bin/"])
    for (const program of ["pwd", "ls", "cat", "sed", "rg"])
      if (name === root + program) return program;
  return null;
}
function inspection(words) {
  const program = utility(words[0]);
  const args = words.slice(1);
  if (program === "pwd") return args.length === 0;
  if (program === "cat") return args.length > 0 && args.every(operand);
  if (program === "sed")
    return (
      args.length === 3 &&
      args[0] === "-n" &&
      /^(?:[1-9]\d*|\$)(?:,(?:[1-9]\d*|\$))?p$/.test(args[1]) &&
      operand(args[2])
    );
  if (program === "ls") {
    let options = true;
    return args.every((arg) => {
      if (options && arg === "--") {
        options = false;
        return true;
      }
      if (
        options &&
        ["-l", "-a", "-la", "-al", "-1", "-la1", "-al1"].includes(arg)
      )
        return true;
      if (!operand(arg)) return false;
      options = false;
      return true;
    });
  }
  // No --pre, alternate config, file-list or command-executing options.
  if (program === "rg")
    return (
      (args[0] === "--files" && args.slice(1).every(operand)) ||
      (["-n", "-l"].includes(args[0]) &&
        args.length >= 3 &&
        args.slice(1).every(operand))
    );
  return false;
}

export function checkCommand(command, contract) {
  return checkLists(commandLists(command), contract);
}

function checkLists(lists, contract) {
  if (!lists) return false;
  let checks = 0;
  for (const words of lists) {
    if (checkInvocation(words, contract)) checks++;
    else if (!inspection(words)) return false;
  }
  return checks > 0;
}

function commandArgv(argv, contract) {
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    argv.some((word) => typeof word !== "string" || /[\0\r\n]/.test(word))
  )
    return false;
  if (shells.has(argv[0])) {
    if (argv.length !== 3 || !["-c", "-lc"].includes(argv[1])) return false;
    const lists = literalLists(argv[2]);
    if (lists?.some((words) => shells.has(words[0]))) return false;
    return checkLists(lists, contract);
  }
  // Direct argv is already tokenized by the runtime, not shell source. In
  // particular, a leading NAME=value is an executable here, not an assignment.
  return argv[0] === contract.tool && checkInvocation(argv, contract);
}

function sameSourceCwd(value, expected) {
  if (
    typeof value !== "string" ||
    !value.startsWith("file:///") ||
    typeof expected !== "string" ||
    !expected ||
    expected.includes("\0") ||
    !isAbsolute(expected) ||
    resolve(expected) !== expected
  )
    return false;
  try {
    // URL() normalizes dot segments before exposing pathname. Reject ambiguous
    // raw/decoded paths first: symlink/../ has filesystem semantics that differ
    // from lexical URL normalization.
    const rawPath = value.slice("file://".length).split(/[?#]/, 1)[0];
    const decodedPath = decodeURIComponent(rawPath);
    if (
      /[\\\x00-\x1f\x7f]/.test(decodedPath) ||
      decodedPath.includes("//") ||
      decodedPath.split("/").some((part) => part === "." || part === "..")
    )
      return false;
    const url = new URL(value);
    return (
      url.protocol === "file:" &&
      url.hostname === "" &&
      url.search === "" &&
      url.hash === "" &&
      fileURLToPath(url) === expected
    );
  } catch {
    return false;
  }
}

// Consume only trusted runtime records from the owned source transcript. CLI
// display events omit cwd; they cannot prove which project's check executed.
// The caller must also establish currentTurnCompleted and immutable fixtures.
// This keeps the existing trust in configured host PATH/system executables; it
// does not attest to a malicious runtime, transient edits or shadowed binaries.
export function successfulSourceCommand(
  records,
  contract,
  expectedCanonicalCwd,
) {
  if (!Array.isArray(records)) return false;
  const meta = records[0];
  const thread = meta?.type === "session_meta" ? meta.payload?.id : null;
  if (typeof thread !== "string" || !thread.trim()) return false;
  const contextIndex = records.findLastIndex((r) => r?.type === "turn_context");
  const startIndex = records.findLastIndex(
    (r) => r?.type === "event_msg" && r.payload?.type === "task_started",
  );
  const turn = records[contextIndex]?.payload?.turn_id;
  if (
    typeof turn !== "string" ||
    !turn.trim() ||
    records[startIndex]?.payload?.turn_id !== turn
  )
    return false;
  const from = Math.max(contextIndex, startIndex) + 1;
  const completedIndex = records.findIndex(
    (r, index) =>
      index >= from &&
      r?.type === "event_msg" &&
      r.payload?.type === "task_complete" &&
      r.payload.turn_id === turn,
  );
  const current = records
    .slice(from, completedIndex < 0 ? records.length : completedIndex)
    .filter(
      (r) =>
        r?.type === "event_msg" &&
        r.payload?.type === "item_completed" &&
        r.payload.thread_id === thread &&
        r.payload.turn_id === turn &&
        r.payload.item?.type === "CommandExecution",
    );
  const counts = new Map();
  for (const { payload } of current)
    counts.set(payload.item.id, (counts.get(payload.item.id) ?? 0) + 1);
  return current.some(
    ({ payload: { item } }) =>
      typeof item.id === "string" &&
      item.id.trim() &&
      counts.get(item.id) === 1 &&
      item.status === "completed" &&
      item.exit_code === 0 &&
      typeof item.aggregated_output === "string" &&
      item.aggregated_output.split(/\r?\n/).includes("fixture-check:ok") &&
      sameSourceCwd(item.cwd, expectedCanonicalCwd) &&
      commandArgv(item.command, contract),
  );
}

export function successfulCommand(events, contract) {
  return events.some((e) => {
    const item = e.item;
    return (
      e.type === "item.completed" &&
      item?.type === "command_execution" &&
      item.exit_code === 0 &&
      typeof item.aggregated_output === "string" &&
      item.aggregated_output.split(/\r?\n/).includes("fixture-check:ok") &&
      checkCommand(item.command, contract)
    );
  });
}
