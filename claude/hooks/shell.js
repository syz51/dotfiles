// Shell parsing shared by the Bash PreToolUse guards. It follows quotes, substitutions,
// heredocs, here-strings, redirections, `cd`, `sh -c`, `eval`, wrappers such as `sudo`
// and `env`, `find -exec`, scripts piped into a shell, and commands run over `ssh`. It
// cannot see through aliases, script files, package scripts, expanded variables or the
// output of a command substitution, which stays in its word unexpanded.
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const MAX_DEPTH = 8;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SHELL_VALUE_OPTIONS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const SHELL_KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"]);
/** git's global options that take the next word as their value, for the guards that read git commands. */
export const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
/**
 * Whether the shell fills in part of `word` from a variable, a command substitution or a brace
 * expansion, so its value is unknown to a guard. parseScript drops quoting, so a quoted `$` counts too.
 */
export const expands = (word) => /[$`]|\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(word);
/**
 * gh's first `count` subcommand words in `words` (a gh command), skipping options: `path`, the
 * index after them (`next`), the last -R/--repo value given before them (`repo`), and the first
 * other option before them (`other`). gh reads such an option wherever it appears, and may take
 * the next word as its value, so a guard cannot trust `path` when `other` is set.
 */
export function ghSubcommands(words, count) {
  const path = [];
  let repo;
  let other;
  let i = 1;
  while (i < words.length && path.length < count) {
    const word = words[i];
    if (word === "-R" || word === "--repo") {
      repo = words[i + 1];
      i += 2;
    } else if (/^(?:-R.|--repo=)/.test(word)) {
      repo = word.replace(/^(?:-R=?|--repo=)/, "");
      i += 1;
    } else {
      if (word.startsWith("-")) other ??= word;
      else path.push(word);
      i += 1;
    }
  }
  return { path, next: i, repo, other };
}
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
  // zsh precommand modifiers
  nocorrect: [],
  noglob: [],
  nohup: [],
  stdbuf: ["-i", "-o", "-e"],
  sshpass: ["-p", "-f", "-d", "-P"],
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "--chdir"],
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
// ssh -o option whose value is the command to run on the remote host.
const SSH_REMOTE_COMMAND = /^\s*RemoteCommand\s*(?:=\s*|\s+)(.+)$/is;
// ssh options that keep it from reading standard input.
const SSH_NO_STDIN = new Set(["-n", "-f", "-N"]);
// find actions that run a command up to `;` or `+`.
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Index of the quote closing a string opened at `start`, past backslash escapes when `escapes`; source.length when unclosed. */
function closeQuote(source, start, quote, escapes) {
  let i = start + 1;
  while (i < source.length && source[i] !== quote) i += escapes && source[i] === "\\" ? 2 : 1;
  return Math.min(i, source.length);
}

/** Whether the reserved word `name` starts at `i`: at a word boundary and followed by one. */
const reserved = (source, i, name) => source.startsWith(name, i)
  && (i === 0 || /[\s;&|(]/.test(source[i - 1]))
  && (i + name.length === source.length || /[\s;&|)]/.test(source[i + name.length]));

/**
 * The command substitution `$(…)` or `` `…` `` starting at `start`: its script (`body`) and the
 * index just past it (`end`). Inside `case … esac`, a pattern's `)` does not close it.
 */
function substitution(source, start) {
  if (source[start] === "`") {
    const close = closeQuote(source, start, "`", true);
    return { body: source.slice(start + 1, close), end: close + 1 };
  }
  let depth = 1;
  let cases = 0;
  let i = start + 2;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") i += 2;
    else if (c === "'" || c === '"') i = closeQuote(source, i, c, c === '"') + 1;
    else if (reserved(source, i, "case")) {
      cases += 1;
      i += 4;
    } else if (reserved(source, i, "esac")) {
      cases = Math.max(0, cases - 1);
      i += 4;
    } else if (c === "(") {
      depth += 1;
      i += 1;
    } else if (c === ")" && depth === 1 && cases > 0) {
      i += 1; // a case pattern
    } else if (c === ")" && (depth -= 1) === 0) {
      return { body: source.slice(start + 2, i), end: i + 1 };
    } else i += 1;
  }
  return { body: source.slice(start + 2), end: source.length };
}

/** The `$(…)` and `` `…` `` substitutions in text the shell expands outside quotes, such as a heredoc body: { start, end, body } each. */
function substitutionsIn(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if ((text[i] === "$" && text[i + 1] === "(") || text[i] === "`") {
      const { body, end } = substitution(text, i);
      found.push({ start: i, end, body });
      i = end;
    } else i += 1;
  }
  return found;
}

/**
 * Splits shell source into simple commands. Each command has its argv, the heredoc bodies and
 * here-strings it reads (`inputs`), the scripts of the command substitutions in its words
 * (`substitutions`), which run first, the operator that ended it (`next`, "|" within a
 * pipeline), and how many `(` open just before it (`opens`) and `)` close just after it
 * (`closes`); the operator after a `)` ends the command that `)` closed. A substitution stays
 * in its word unexpanded, as in `$(cat ref)`.
 */
export function parseScript(source) {
  const commands = [];
  const fresh = () => ({ argv: [], inputs: [], substitutions: [], opens: 0, closes: 0 });
  let current = fresh();
  let word;
  let destination = "argv"; // where the next word goes: argv, drop (a redirection target), or input
  let heredocs = [];
  // Open `case` statements and `(` subshells, innermost last, so the `)` that ends a case
  // pattern is not read as the end of a subshell. `pattern` is the argv index where the
  // current command's pattern starts while one is expected, after `in` or `;;`.
  const nesting = [];
  let pattern;
  const firstWord = (argv) => argv.find((arg) => !SHELL_KEYWORDS.has(arg));
  // Whether a case pattern is being read; a pending `esac` word ends the case instead.
  const inPattern = () => nesting.at(-1) === "case" && pattern !== undefined
    && !(word === "esac" && destination === "argv" && firstWord(current.argv) === undefined);

  const endWord = () => {
    if (word === undefined) return;
    if (destination === "argv") {
      current.argv.push(word);
      const first = firstWord(current.argv);
      if (word === "in" && first === "case" && current.argv.length === current.argv.indexOf("case") + 3) {
        nesting.push("case");
        pattern = current.argv.length;
      } else if (word === "esac" && first === "esac" && nesting.at(-1) === "case") {
        nesting.pop();
        pattern = undefined;
      }
    } else if (destination === "input") current.inputs.push(word);
    destination = "argv";
    word = undefined;
  };
  const endCommand = (next) => {
    endWord();
    destination = "argv";
    if (pattern !== undefined) pattern = 0; // the pattern continues in the next command
    if (current.argv.length > 0 || current.inputs.length > 0) {
      commands.push({ ...current, next });
      current = fresh();
    } else if (commands.at(-1)?.next === ")") {
      // Words after `)`, such as a redirection target, belong to the subshell it closed.
      commands.at(-1).substitutions.push(...current.substitutions);
      current.substitutions = [];
      commands.at(-1).next = next;
    } else if (current.substitutions.length > 0) {
      commands.push({ ...current, next });
      current = fresh();
    }
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "\n") {
      endCommand("\n");
      i += 1;
      for (const { delimiter, stripTabs, inputs, substitutions } of heredocs) {
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
        // The shell expands substitutions in a heredoc whose delimiter is unquoted.
        substitutions?.push(...substitutionsIn(lines.join("\n")).map(({ body }) => body));
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
        } else if ((source[j] === "$" && source[j + 1] === "(") || source[j] === "`") {
          const { body, end } = substitution(source, j);
          current.substitutions.push(body);
          text += source.slice(j, end);
          j = end;
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
    } else if ((c === "$" && source[i + 1] === "(") || c === "`") {
      const { body, end } = substitution(source, i);
      current.substitutions.push(body);
      word = (word ?? "") + source.slice(i, end);
      i = end;
    } else if (c === "|" && inPattern()) {
      endWord(); // separates alternatives in a case pattern
      i += 1;
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
    } else if (c === "(" && nesting.at(-1) === "case" && word === undefined && current.argv.length === pattern) {
      i += 1; // the optional `(` before a case pattern
    } else if (c === "(") {
      endCommand(c);
      current.opens += 1;
      nesting.push(c);
      i += 1;
    } else if (c === ")" && inPattern()) {
      // The end of a case pattern: drop the pattern's words, and run what follows as a command.
      endWord();
      current.argv.length = Math.min(current.argv.length, pattern);
      endCommand(";");
      pattern = undefined;
      i += 1;
    } else if (c === ")") {
      endCommand(c);
      if (nesting.at(-1) === "(") nesting.pop();
      if (current.opens > 0) current.opens -= 1; // an empty `()`, as in a function definition
      else if (commands.length > 0) Object.assign(commands.at(-1), { closes: commands.at(-1).closes + 1, next: ")" });
      i += 1;
    } else if (c === ";" && nesting.at(-1) === "case" && ";&|".includes(source[i + 1] ?? "")) {
      endCommand(";"); // `;;`, `;&`, or zsh's `;|` ends a case item; a pattern comes next
      pattern = 0;
      i += 2;
    } else if (c === ";") {
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
        let quoted = false;
        while (i < source.length && !/[\s;&|()<>]/.test(source[i])) {
          if ("'\"\\".includes(source[i])) quoted = true;
          else delimiter += source[i];
          i += 1;
        }
        heredocs.push({ delimiter, stripTabs, inputs: current.inputs, substitutions: quoted ? undefined : current.substitutions });
      } else {
        destination = operator === "<<<" ? "input" : "drop";
      }
    } else {
      word = (word ?? "") + c;
      i += 1;
    }
  }
  endCommand(undefined);
  return { commands };
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
 * command of it is a shell reading standard input, unless `-n`, `-f` or `-N` keeps ssh from
 * reading it. `-o RemoteCommand=…` runs its command there too. `-o ProxyCommand=…` and similar
 * options run their command here, in `dir`.
 */
function sshProgram(argv, i, dir) {
  const takesValue = (option) => /^-[A-Za-z]$/.test(option) && SSH_VALUE_LETTERS.includes(option[1]);
  const before = skipOptions(argv, i + 1, takesValue);
  const hasHost = before.next < argv.length;
  const after = hasHost && argv[before.next - 1] !== "--" ? skipOptions(argv, before.next + 1, takesValue) : { next: before.next + 1, options: [] };
  const options = [...before.options, ...after.options];
  const settings = options.filter(([option, value]) => option === "-o" && value !== undefined).map(([, value]) => value);
  const commandsOf = (pattern) => settings.map((value) => pattern.exec(value)?.[1])
    .filter((command) => command !== undefined && command.trim().toLowerCase() !== "none");
  const local = commandsOf(SSH_LOCAL_COMMAND).map((command) => [command, dir]);
  const words = argv.slice(after.next).join(" ");
  const nested = [...commandsOf(SSH_REMOTE_COMMAND), ...(words === "" ? [] : [words])];
  const stdin = hasHost && !options.some(([option]) => SSH_NO_STDIN.has(option));
  const reads = () => stdin && (nested.length === 0 || nested.some((remote) => parseScript(remote).commands.some((command) => {
    const inner = program(command.argv, undefined);
    return readsStdin(inner.words) || inner.reads?.() === true;
  })));
  return { words: [], nested, local, dir: undefined, remote: true, reads };
}

/**
 * Skips assignments, shell keywords, and wrappers, collecting command strings that wrappers run.
 * On another host (`remote`), a wrapper's directory change leaves the directory unknown.
 */
function program(argv, dir, remote = false) {
  const chdir = (path) => (remote ? undefined : changeDirectory(dir, path));
  const nested = [];
  let appended = false; // xargs adds words read from standard input
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
      // A wrapper's `env -S` script runs here with ssh's words, and so with the words xargs adds.
      return { ...remote, local: [...nested.map((script) => [script, dir, appended]), ...remote.local], appended };
    }
    if (name === "watch") {
      // watch runs its remaining words through `sh -c`.
      i += 1;
      while (i < argv.length && argv[i].startsWith("-")) i += ["-n", "--interval", "-q", "--equexit"].includes(argv[i]) ? 2 : 1;
      nested.push(argv.slice(i).join(" "));
      return { words: [], nested, dir, appended };
    }
    if (name === "command") {
      // `command -v NAME` and `command -V NAME` look a command up without running it.
      let j = i + 1;
      while (j < argv.length && /^-[A-Za-z]+$/.test(argv[j]) && !/[vV]/.test(argv[j])) j += 1;
      if (/^-[A-Za-z]*[vV]/.test(argv[j] ?? "")) return { words: [], nested, dir, appended };
    }
    if (!Object.hasOwn(WRAPPERS, name)) break;
    const values = WRAPPERS[name];
    const { next, options } = skipOptions(argv, i + 1, (option) => values.includes(option));
    i = next;
    if (name === "env") {
      for (const [option, value] of options) {
        if (option === "-S" || option === "--split-string") nested.push(value ?? "");
        else if (option === "-C" || option === "--chdir") dir = chdir(value);
      }
    }
    if (name === "sudo") {
      for (const [option, value] of options) if (option === "-D" || option === "--chdir") dir = chdir(value);
    }
    if (name === "timeout") i += 1; // the duration
    if (name === "xargs") appended = true;
  }
  return { words: argv.slice(i), nested, dir, appended };
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

/**
 * What `echo` or `printf` prints, roughly, when its output is piped into a shell. A substitution
 * in its words prints what its own echo and printf commands print; printf prints its arguments
 * after its format, without the format's directives.
 */
function printed(words, depth = 0) {
  const name = basename(words[0]);
  if ((name !== "echo" && name !== "printf") || depth > MAX_DEPTH) return undefined;
  let args = words.slice(1).map((word) => {
    let text = "";
    let last = 0;
    for (const { start, end, body } of substitutionsIn(word)) {
      const inner = parseScript(body).commands.map(({ argv }) => {
        const { words: run } = program(argv, undefined);
        return run.length > 0 ? printed(run, depth + 1) : undefined;
      });
      text += word.slice(last, start) + inner.filter((line) => line !== undefined).join("\n");
      last = end;
    }
    return text + word.slice(last);
  });
  if (name === "echo") while (/^-[neE]+$/.test(args[0] ?? "")) args = args.slice(1);
  if (name === "printf" && args.length > 1 && args[0].includes("%")) {
    args = [...args.slice(1), args[0].replace(/%[-#0 +']*\d*(?:\.\d+)?[a-zA-Z%]/g, "")];
  }
  return args.join(" ").replaceAll("\\n", "\n");
}

function inspect(source, state, visit, depth, tooDeep) {
  if (depth > MAX_DEPTH) return tooDeep;
  // Whether this script runs on another host, over ssh.
  const here = state.remote === true;
  // Whether xargs adds words to the command that runs this script, such as `xargs ssh host
  // 'gh pr merge 12'`. They join the script's text, which the shell parses again, so the guard
  // cannot tell which command gets them and treats every command in it as getting more words.
  const added = state.appended === true;
  const { commands } = parseScript(source);
  // Text printed inside each open `{ …; }` group or `( … )` subshell, so a group piped into a
  // shell feeds it everything its commands print.
  const groups = [];
  // The directory before each open `( … )` subshell: a `cd` inside one ends with it.
  const subshells = [];
  const leave = (count) => {
    for (let k = 0; k < count && subshells.length > 0; k += 1) state.dir = subshells.pop();
  };
  // The directory before each open `{ …; }` group: zsh runs a group that a `|` or `&` follows
  // in a subshell, so a `cd` inside it ends with it.
  const braces = [];
  let pipeline = [];
  for (const command of commands) {
    for (let k = 0; k < command.opens; k += 1) subshells.push(state.dir);
    for (const word of command.argv) {
      if (!SHELL_KEYWORDS.has(word)) break;
      if (word === "{") braces.push(state.dir);
    }
    if (command.argv[0] === "}" && braces.length > 0) {
      const before = braces.pop();
      if (["|", "|&", "&"].includes(command.next)) state.dir = before;
    }
    const run = program(command.argv, state.dir, here);
    for (let k = 0; k < command.opens + (command.argv[0] === "{" ? 1 : 0); k += 1) groups.push([]);
    const text = run.words.length > 0 ? printed(run.words) : undefined;
    run.printed = text === undefined ? [] : [text];
    groups.at(-1)?.push(...run.printed);
    for (let k = 0; k < command.closes + (command.argv[0] === "}" ? 1 : 0) && groups.length > 0; k += 1) {
      run.printed = groups.pop();
      groups.at(-1)?.push(...run.printed);
    }
    // `before` is the shell's directory when this part starts, where its substitutions run.
    pipeline.push({ command, run, before: state.dir });
    if (command.next === "|" || command.next === "|&") {
      leave(command.closes);
      continue;
    }
    // A shell reading standard input runs the heredocs, here-strings and printed text piped to it.
    const fed = pipeline.length > 1 || pipeline[0].command.inputs.length > 0;
    const reader = fed ? pipeline.findIndex(({ run: { words, reads } }) => reads?.() === true || readsStdin(words)) : -1;
    // A background job and every part of a pipeline but the last run in a subshell, so a `cd`
    // there moves nothing after it. zsh, the shell Claude Code runs commands in, runs the last
    // part in the current shell, so a `cd` there moves later commands; bash would not.
    const background = pipeline.at(-1).command.next === "&";
    for (const [index, { command: { inputs, substitutions }, run: { words, nested, local, dir, remote, printed: text, appended }, before }] of pipeline.entries()) {
      const name = words.length > 0 ? basename(words[0]) : "";
      // Its substitutions, which the shell running it expands first, scripts this command runs
      // itself, and scripts the reading shell runs in its directory. An ssh command's scripts
      // run on the remote host; its local options' commands run here. The words xargs adds to
      // ssh, watch or `env -S` join the script they run.
      const scripts = [...substitutions.map((script) => [script, before, here]),
        ...nested.map((script) => [script, dir, here || Boolean(remote), appended]),
        ...(local ?? []).map(([script, where, adds]) => [script, where, here, adds])];
      if (SHELLS.has(name)) scripts.push(...shellScripts(words).map((script) => [script, dir, here]));
      if (name === "eval") scripts.push([words.slice(1).join(" "), dir, here]);
      if (name === "find") scripts.push(...findScripts(words, dir).map(([script, where]) => [script, where, here]));
      if (reader !== -1) {
        const piped = index < reader ? [...inputs, ...text] : inputs;
        scripts.push(...piped.map((script) => [script, pipeline[reader].run.dir, here || Boolean(pipeline[reader].run.remote)]));
      }
      for (const [script, where, onRemote, adds] of scripts) {
        const violation = script === undefined ? undefined
          : inspect(script, { dir: where, remote: onRemote, appended: added || adds === true }, visit, depth + 1, tooDeep);
        if (violation) return violation;
      }
      if (name === "cd" || name === "pushd" || name === "popd") {
        if (background || index < pipeline.length - 1) continue;
        // A directory on another host is unknown here, whatever path it names.
        if (name === "popd" || here) state.dir = undefined;
        else state.dir = changeDirectory(before, words.slice(1).find((arg) => !/^-[LPe@]+$/.test(arg)));
      } else if (words.length > 0) {
        const violation = visit(words, dir, { appended: added || appended, remote: here });
        if (violation) return violation;
      }
    }
    leave(pipeline.at(-1).command.closes);
    pipeline = [];
  }
  return undefined;
}

/**
 * Calls `visit(words, dir, { appended, remote })` for every command `source` would run, after
 * wrappers, through shells, substitutions, `eval`, `find -exec` and `ssh`; `dir` is its directory
 * when known, and always undefined for a command on another host, `appended` says that xargs adds arguments the guard cannot see, and `remote` says
 * that it runs on another host over `ssh`.
 * Returns the first reason `visit` gives for blocking one, or undefined. A script nested
 * more than eight levels deep returns `tooDeep`, which is undefined unless given.
 */
export function visitCommands(source, cwd, visit, tooDeep) {
  return inspect(source, { dir: cwd }, visit, 0, tooDeep);
}
