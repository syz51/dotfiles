// Shell parsing shared by the Bash PreToolUse guards. It follows quotes, substitutions,
// heredocs, here-strings, redirections, `cd`, `sh -c`, `eval`, wrappers such as `sudo`
// and `env`, `find -exec`, scripts piped into a shell, and commands run over `ssh`. It
// cannot see through aliases, script files, package scripts or expanded variables.
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const MAX_DEPTH = 8;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SHELL_VALUE_OPTIONS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const SHELL_KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"]);
// Commands that run another command, with their options that take a value.
const WRAPPERS = {
  arch: ["-e", "-arch"],
  builtin: [],
  caffeinate: ["-t", "-w"],
  command: [],
  doas: ["-u", "-C"],
  env: ["-u", "-P", "-S", "-C", "--unset", "--split-string", "--chdir"],
  exec: ["-a"],
  nice: ["-n"],
  nohup: [],
  stdbuf: ["-i", "-o", "-e"],
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"],
  time: ["-f", "-o"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  xargs: ["-a", "-d", "-E", "-I", "-J", "-L", "-n", "-P", "-R", "-S", "-s", "--arg-file", "--delimiter", "--eof", "--replace",
    "--max-lines", "--max-args", "--max-procs", "--max-chars"],
  xcrun: ["--sdk", "--toolchain"],
};
// ssh options that take a value (`man ssh`).
const SSH_VALUE_LETTERS = "BbcDEeFIiJLlmOoPpQRSWw";
// ssh -o options whose value is a command run locally through the user's shell.
const SSH_LOCAL_COMMAND = /^\s*(?:ProxyCommand|LocalCommand|KnownHostsCommand)\s*(?:=\s*|\s+)(.+)$/is;
// find actions that run a command up to `;` or `+`.
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

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
 * here-strings it reads (`inputs`), the operator that ended it (`next`, "|" within a pipeline),
 * and how many `(` or `$(` open just before it (`opens`) and `)` close just after it (`closes`);
 * the operator after a `)` ends the command that `)` closed. `substitutions` holds command
 * substitutions found inside double quotes, which run as well.
 */
export function parseScript(source) {
  const commands = [];
  const substitutions = [];
  const fresh = () => ({ argv: [], inputs: [], opens: 0, closes: 0 });
  let current = fresh();
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
    if (current.argv.length > 0 || current.inputs.length > 0) {
      commands.push({ ...current, next });
      current = fresh();
    } else if (commands.at(-1)?.next === ")") {
      commands.at(-1).next = next;
    }
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
      current.opens += 1;
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
    } else if (c === "(") {
      endCommand(c);
      current.opens += 1;
      i += 1;
    } else if (c === ")") {
      endCommand(c);
      if (current.opens > 0) current.opens -= 1; // an empty `()`, as in a function definition
      else if (commands.length > 0) Object.assign(commands.at(-1), { closes: commands.at(-1).closes + 1, next: ")" });
      i += 1;
    } else if (c === "`" || c === ";") {
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

/** Shell source that runs exactly `words`, each single-quoted. */
function quote(words) {
  return words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

export function changeDirectory(dir, path) {
  if (path === undefined || path === "~") return homedir();
  if (path === "-" || /[$`*?[]/.test(path)) return undefined; // the previous directory, variables, and globs are unknown here
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (path.startsWith("/")) return resolve(path);
  return dir === undefined ? undefined : resolve(dir, path);
}

/**
 * Skips getopt-style options from `argv[start]`. A short option group ends at its first letter
 * that takes a value, which is the rest of the word or else the next word; `--long=value`
 * carries its value; `--` ends the options. Returns the index of the first operand and each
 * option with its value.
 */
function skipOptions(argv, start, takesValue) {
  const options = [];
  let i = start;
  while (i < argv.length && argv[i].startsWith("-")) {
    const word = argv[i];
    i += 1;
    if (word === "--") break;
    const equals = word.indexOf("=");
    if (word.startsWith("--") && equals !== -1) options.push([word.slice(0, equals), word.slice(equals + 1)]);
    else if (takesValue(word)) options.push([word, argv[i++]]);
    else if (word.startsWith("--")) options.push([word, undefined]);
    else {
      for (let k = 1; k < word.length; k += 1) {
        const option = `-${word[k]}`;
        if (!takesValue(option)) {
          options.push([option, undefined]);
          continue;
        }
        options.push([option, k + 1 < word.length ? word.slice(k + 1) : argv[i++]]);
        break;
      }
    }
  }
  return { next: i, options };
}

/** Whether a shell invocation reads its commands from standard input (no -c and no script file). */
function readsStdin(words) {
  if (words.length === 0 || !SHELLS.has(basename(words[0]))) return false;
  const fish = basename(words[0]) === "fish";
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    if (word === "-" || /^-[A-Za-z]*s[A-Za-z]*$/.test(word)) return true;
    if (fish && /^--command(?:=|$)/.test(word)) return false;
    if (SHELL_VALUE_OPTIONS.has(word) || (fish && (word === "-C" || word === "--init-command"))) i += 1;
    else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word) || !/^[-+]/.test(word)) return false;
  }
  return true;
}

/**
 * `ssh [options] host [options] [command…]`: OpenSSH parses options again after the host
 * unless `--` came before it. The remote shell runs the command words joined by spaces, in an
 * unknown directory, and reads its script from standard input when there is no command or a
 * command of it is a shell reading standard input. `-o ProxyCommand=…` and similar options
 * run their command here, in `dir`.
 */
function sshProgram(argv, i, dir) {
  const takesValue = (option) => /^-[A-Za-z]$/.test(option) && SSH_VALUE_LETTERS.includes(option[1]);
  const before = skipOptions(argv, i + 1, takesValue);
  const hasHost = before.next < argv.length;
  const after = hasHost && argv[before.next - 1] !== "--" ? skipOptions(argv, before.next + 1, takesValue) : { next: before.next + 1, options: [] };
  const local = [...before.options, ...after.options]
    .filter(([option, value]) => option === "-o" && value !== undefined)
    .map(([, value]) => SSH_LOCAL_COMMAND.exec(value)?.[1])
    .filter((command) => command !== undefined && command.trim().toLowerCase() !== "none")
    .map((command) => [command, dir]);
  const remote = argv.slice(after.next).join(" ");
  if (remote === "") return { words: [], nested: [], local, dir: undefined, reads: () => hasHost };
  const reads = () => parseScript(remote).commands.some((command) => {
    const inner = program(command.argv, undefined);
    return readsStdin(inner.words) || inner.reads?.() === true;
  });
  return { words: [], nested: [remote], local, dir: undefined, reads };
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
    if (name === "coproc") {
      // `coproc NAME { …; }` names the coprocess; `coproc command …` runs the command.
      i += argv[i + 2] === "{" ? 2 : 1;
      continue;
    }
    if (name === "ssh") {
      const remote = sshProgram(argv, i, dir);
      return { ...remote, local: [...nested.map((script) => [script, dir]), ...remote.local] };
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
    const values = WRAPPERS[name];
    const { next, options } = skipOptions(argv, i + 1, (option) => values.includes(option));
    i = next;
    if (name === "env") {
      for (const [option, value] of options) {
        if (option === "-S" || option === "--split-string") nested.push(value ?? "");
        else if (option === "-C" || option === "--chdir") dir = changeDirectory(dir, value);
      }
    }
    if (name === "timeout") i += 1; // the duration
  }
  return { words: argv.slice(i), nested, dir };
}

/** The scripts of `sh -c <script>` and fish's `--command` and `--init-command`, skipping options that take a value. */
function shellScripts(words) {
  const fish = basename(words[0]) === "fish";
  const scripts = [];
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    const long = fish ? /^--(?:command|init-command)(?:=(.*))?$/s.exec(word) : null;
    if (long) scripts.push(long[1] ?? words[++i]);
    else if (fish && word === "-C") scripts.push(words[++i]);
    else if (SHELL_VALUE_OPTIONS.has(word)) i += 1;
    else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) return [...scripts, words[i + 1]];
    else if (!/^[-+]/.test(word)) break;
  }
  return scripts;
}

/** The commands `find … -exec command … ;` runs, with their directory: `-execdir` and `-okdir` run in each match's own. */
function findScripts(words, dir) {
  const scripts = [];
  for (let i = 1; i < words.length; i += 1) {
    if (!FIND_EXEC.has(words[i])) continue;
    let j = i + 1;
    while (j < words.length && words[j] !== ";" && words[j] !== "+") j += 1;
    scripts.push([quote(words.slice(i + 1, j)), words[i].endsWith("dir") ? undefined : dir]);
    i = j;
  }
  return scripts;
}

/** What `echo` or `printf` prints, roughly, when its output is piped into a shell. */
function printed(words) {
  const name = basename(words[0]);
  if (name !== "echo" && name !== "printf") return undefined;
  let args = words.slice(1);
  if (name === "echo") while (/^-[neE]+$/.test(args[0] ?? "")) args = args.slice(1);
  return args.join(" ").replaceAll("\\n", "\n");
}

function inspect(source, state, visit, depth, tooDeep) {
  if (depth > MAX_DEPTH) return tooDeep;
  const { commands, substitutions } = parseScript(source);
  for (const inner of substitutions) {
    const violation = inspect(inner, { dir: state.dir }, visit, depth + 1, tooDeep);
    if (violation) return violation;
  }
  // Text printed inside each open `{ …; }` group or `( … )` subshell, so a group piped into a
  // shell feeds it everything its commands print.
  const groups = [];
  let pipeline = [];
  for (const command of commands) {
    const run = program(command.argv, state.dir);
    for (let k = 0; k < command.opens + (command.argv[0] === "{" ? 1 : 0); k += 1) groups.push([]);
    const text = run.words.length > 0 ? printed(run.words) : undefined;
    run.printed = text === undefined ? [] : [text];
    groups.at(-1)?.push(...run.printed);
    for (let k = 0; k < command.closes + (command.argv[0] === "}" ? 1 : 0) && groups.length > 0; k += 1) {
      run.printed = groups.pop();
      groups.at(-1)?.push(...run.printed);
    }
    pipeline.push({ command, run });
    if (command.next === "|" || command.next === "|&") continue;
    // A shell reading standard input runs the heredocs, here-strings and printed text piped to it.
    const fed = pipeline.length > 1 || pipeline[0].command.inputs.length > 0;
    const reader = fed ? pipeline.findIndex(({ run: { words, reads } }) => reads?.() === true || readsStdin(words)) : -1;
    for (const [index, { command: { inputs }, run: { words, nested, local, dir, printed: text } }] of pipeline.entries()) {
      const name = words.length > 0 ? basename(words[0]) : "";
      // Scripts this command runs itself, and scripts the reading shell runs in its directory.
      const scripts = [...nested.map((script) => [script, dir]), ...(local ?? [])];
      if (SHELLS.has(name)) scripts.push(...shellScripts(words).map((script) => [script, dir]));
      if (name === "eval") scripts.push([words.slice(1).join(" "), dir]);
      if (name === "find") scripts.push(...findScripts(words, dir));
      if (reader !== -1) {
        const piped = index < reader ? [...inputs, ...text] : inputs;
        scripts.push(...piped.map((script) => [script, pipeline[reader].run.dir]));
      }
      for (const [script, where] of scripts) {
        const violation = script === undefined ? undefined : inspect(script, { dir: where }, visit, depth + 1, tooDeep);
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
 * Calls `visit(words, dir)` for every command `source` would run, after wrappers, through
 * shells, substitutions, `eval`, `find -exec` and `ssh`; `dir` is its directory when known.
 * Returns the first reason `visit` gives for blocking one, or undefined. A script nested
 * more than eight levels deep returns `tooDeep`, which is undefined unless given.
 */
export function visitCommands(source, cwd, visit, tooDeep) {
  return inspect(source, { dir: cwd }, visit, 0, tooDeep);
}
