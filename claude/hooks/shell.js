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
const COMPOUND_OPEN = { while: "done", until: "done", for: "done", select: "done", repeat: "done", if: "fi", case: "esac" };
const COMPOUND_CLOSE = new Set(Object.values(COMPOUND_OPEN));
const STDIN_PATHS = new Set(["/dev/stdin", "/dev/fd/0", "-"]);
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
  xargs: ["-a", "-d", "-E", "-I", "-J", "-L", "-n", "-P", "-R", "-S", "-s", "--arg-file", "--delimiter", "--eof",
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
// What a word that holds xargs' replace string (`-I {}`) reads as: the input fills it in, so
// `expands` reports it as unknown.
const FILLED = "${xargs}";
// find actions that run a command up to `;` or `+`.
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

const ANSI_C_ESCAPES = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** Index of the quote closing a string opened at `start`, past backslash escapes when `escapes`; source.length when unclosed. */
function closeQuote(source, start, quote, escapes) {
  let i = start + 1;
  while (i < source.length && source[i] !== quote) i += escapes && source[i] === "\\" ? 2 : 1;
  return Math.min(i, source.length);
}

/**
 * The ANSI-C `$'…'` string starting at `start`: its text and the index just past the closing
 * quote (or source.length when unclosed). Decodes single-character escapes (`\'`, `\\`, `\n`, …)
 * so scripts passed to `sh -c` or `eval` keep their real quotes, and prefixes `$` when any other
 * escape (such as `\x6d` or `\u…`) remains so `expands()` still treats the word as shell-filled.
 */
function ansiCQuote(source, start) {
  let j = start + 2;
  let text = "";
  let unknown = false;
  while (j < source.length && source[j] !== "'") {
    if (source[j] === "\\" && j + 1 < source.length) {
      const next = source[j + 1];
      if (Object.hasOwn(ANSI_C_ESCAPES, next)) text += ANSI_C_ESCAPES[next];
      else {
        unknown = true;
        text += `\\${next}`;
      }
      j += 2;
    } else {
      text += source[j];
      j += 1;
    }
  }
  return { text: unknown ? `$${text}` : text, end: j < source.length ? j + 1 : source.length };
}

/**
 * The double-quoted `"…"` string starting at `start`: its text (with double-quote escapes
 * removed and substitutions or parameter expansions kept raw) and the index just past the
 * closing quote (or source.length when unclosed). When `substitutions` is given, any command
 * substitution inside the string (including inside nested `${…}`) is appended to it.
 */
function doubleQuote(source, start, substitutions) {
  let j = start + 1;
  let text = "";
  while (j < source.length && source[j] !== '"') {
    if (source[j] === "\\" && j + 1 < source.length && '"\\$`\n'.includes(source[j + 1])) {
      if (source[j + 1] !== "\n") text += source[j + 1];
      j += 2;
    } else if (source[j] === "$" && source[j + 1] === "{") {
      const { end } = parameterExpansion(source, j, true, substitutions);
      text += source.slice(j, end);
      j = end;
    } else if ((source[j] === "$" && source[j + 1] === "(") || source[j] === "`") {
      const { body, end } = substitution(source, j);
      substitutions?.push(body);
      text += source.slice(j, end);
      j = end;
    } else {
      text += source[j];
      j += 1;
    }
  }
  return { text, end: j < source.length ? j + 1 : source.length };
}

/**
 * The parameter expansion `${…}` starting at `start`: the index just past its matching `}`
 * (or source.length when unclosed). Tracks nested `${…}`, quotes, escapes, and command
 * substitutions so `(` and `)` inside `${…}` stay plain characters. Inside double quotes
 * (`doubleQuoted`), single quotes are literal as in POSIX and zsh, while nested double quotes
 * still quote `}`.
 */
function parameterExpansion(source, start, doubleQuoted, substitutions) {
  let j = start + 2;
  while (j < source.length) {
    const c = source[j];
    if (c === "}") return { end: j + 1 };
    if (c === "\\") j += 2;
    else if (c === "$" && source[j + 1] === "{") j = parameterExpansion(source, j, doubleQuoted, substitutions).end;
    else if ((c === "$" && source[j + 1] === "(") || c === "`") {
      const { body, end } = substitution(source, j);
      substitutions?.push(body);
      j = end;
    } else if (c === '"') j = doubleQuote(source, j, substitutions).end;
    else if (!doubleQuoted && c === "$" && source[j + 1] === "'") j = closeQuote(source, j + 1, "'", true) + 1;
    else if (!doubleQuoted && c === "'") j = closeQuote(source, j, "'", false) + 1;
    else j += 1;
  }
  return { end: source.length };
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
    return { body: source.slice(start + 1, close), end: close < source.length ? close + 1 : source.length };
  }
  let depth = 1;
  let cases = 0;
  let i = start + 2;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") i += 2;
    else if (c === "$" && source[i + 1] === "'") i = closeQuote(source, i + 1, "'", true) + 1;
    else if (c === "$" && source[i + 1] === "{") i = parameterExpansion(source, i, false).end;
    else if (c === "'") i = closeQuote(source, i, "'", false) + 1;
    else if (c === '"') i = doubleQuote(source, i).end;
    else if (c === "`") i = closeQuote(source, i, "`", true) + 1;
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
      if (word === "{" && first === "function") {
        // `function NAME … { …; }` defines a function, and zsh's `function { …; }` runs one
        // at once. Drop the keyword and names so the body reads as a `{ …; }` group, checked
        // like the body of `NAME() { …; }`.
        current.argv.splice(current.argv.indexOf("function"), Infinity, "{");
      } else if (word === "in" && first === "case" && current.argv.length === current.argv.indexOf("case") + 3) {
        nesting.push("case");
        pattern = current.argv.length;
      } else if (word === "esac" && first === "esac" && nesting.at(-1) === "case") {
        nesting.pop();
        pattern = undefined;
      }
    } else if (destination === "input") current.inputs.push(word);
    else if (destination === "stdin") {
      const inline = processSubScript(word);
      if (inline !== undefined) current.inputs.push(inline);
    }
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
    } else if (next !== "\n" && next !== "(" && next !== ")") {
      delete current.funcBody;
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
      const { text, end } = doubleQuote(source, i, current.substitutions);
      word = (word ?? "") + text;
      i = end;
    } else if (c === "\\") {
      if (source[i + 1] !== "\n") word = (word ?? "") + (source[i + 1] ?? "");
      i += 2;
    } else if (c === "$" && source[i + 1] === "'") {
      const { text, end } = ansiCQuote(source, i);
      word = (word ?? "") + text;
      i = end;
    } else if (c === "$" && source[i + 1] === "{") {
      const { end } = parameterExpansion(source, i, false, current.substitutions);
      word = (word ?? "") + source.slice(i, end);
      i = end;
    } else if (((c === "$" || (word === undefined && (c === "<" || c === "="))) && source[i + 1] === "(") || c === "`") {
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
      if (current.opens > 0) {
        current.opens -= 1; // an empty `()`, as in a function definition
        if (commands.at(-1)?.next === "(" && !/=$/.test(commands.at(-1).argv.at(-1) ?? "")) current.funcBody = true;
      } else if (commands.length > 0) {
        const prev = commands.at(-1);
        // Record the operator that preceded each `)` so analyzeCommands knows which
        // command or closed group was followed by `&`, `|`, or `|&`.
        (prev.closeOps ??= []).push(prev.next);
        Object.assign(prev, { closes: prev.closes + 1, next: ")" });
      }
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
        destination = operator === "<<<" ? "input" : operator === "<" ? "stdin" : "drop";
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
 * Reads git's global options in `words` (a git command), from `words[1]` to the subcommand.
 * Returns the directory after each `-C`, starting from `dir`; the `-c` and `--config-env`
 * settings in order, each { option, setting, key, value }, where `key` is lower case and a
 * --config-env value names a variable; whether --git-dir or --work-tree names another
 * repository (`otherRepo`); and the subcommand's index (`index`, at or past the end when none).
 */
export function gitGlobalOptions(words, dir) {
  const settings = [];
  let otherRepo = false;
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    const word = words[i];
    if (word === "-C" && i + 1 < words.length) dir = changeDirectory(dir, words[i + 1]);
    if (/^--(?:git-dir|work-tree)(?:=|$)/.test(word)) otherRepo = true;
    const setting = word === "-c" || word === "--config-env" ? words[i + 1] : /^--config-env=(.*)$/s.exec(word)?.[1];
    if (setting !== undefined) {
      const equals = setting.indexOf("=");
      settings.push({
        option: word === "-c" ? "-c" : "--config-env",
        setting,
        key: (equals === -1 ? setting : setting.slice(0, equals)).toLowerCase(),
        value: equals === -1 ? undefined : setting.slice(equals + 1),
      });
    }
    i += GIT_VALUE_OPTIONS.has(word) ? 2 : 1;
  }
  return { dir, settings, otherRepo, index: i };
}

// Built-in git commands, which git runs even when an alias has the same name.
const GIT_BUILTINS = new Set(["add", "bisect", "branch", "checkout", "cherry-pick", "commit", "config", "diff", "fetch", "log",
  "merge", "pull", "push", "rebase", "reset", "restore", "revert", "show", "stash", "status", "switch", "tag", "worktree"]);

/**
 * What git subcommand `name` runs when the `settings` of gitGlobalOptions define it as an alias.
 * Returns { words } with the words that replace `name`, following aliases of aliases;
 * { unknown } with the setting the guard cannot read: a variable's value, a shell (`!`) alias,
 * quoting, options, a variable in the shell, or a loop; or undefined for no such alias.
 */
export function gitAlias(settings, name) {
  let words;
  const seen = new Set();
  while (name !== undefined && !GIT_BUILTINS.has(name)) {
    const key = `alias.${name.toLowerCase()}`;
    const alias = settings.findLast((setting) => setting.key === key);
    if (alias === undefined) break;
    const expansion = alias.value?.trim().split(/\s+/) ?? [];
    if (alias.option !== "-c" || seen.has(key) || expansion[0] === "" || expansion[0] === undefined
      || /^[!-]/.test(expansion[0]) || /["'\\]/.test(alias.value) || expands(alias.value)) {
      return { unknown: alias.setting };
    }
    seen.add(key);
    words = [...expansion, ...(words ?? [name]).slice(1)];
    name = expansion[0];
  }
  return words && { words };
}

/**
 * Skips getopt-style options from `argv[start]`. A short option group ends at its first letter
 * that takes a value, which is the rest of the word or else the next word; `--long=value`
 * carries its value; `--` ends the options. Returns the index of the first operand and each
 * option with its value and, for an option that takes one, the index of the word after it.
 */
function skipOptions(argv, start, takesValue) {
  const options = [];
  let i = start;
  while (i < argv.length && argv[i].startsWith("-")) {
    const word = argv[i];
    i += 1;
    if (word === "--") break;
    const equals = word.indexOf("=");
    if (word.startsWith("--") && equals !== -1) options.push([word.slice(0, equals), word.slice(equals + 1), i]);
    else if (takesValue(word)) options.push([word, argv[i++], i]);
    else if (word.startsWith("--")) options.push([word, undefined]);
    else {
      for (let k = 1; k < word.length; k += 1) {
        const option = `-${word[k]}`;
        if (!takesValue(option)) {
          options.push([option, undefined]);
          continue;
        }
        options.push([option, k + 1 < word.length ? word.slice(k + 1) : argv[i++], i]);
        break;
      }
    }
  }
  return { next: i, options };
}

/**
 * The words of an `env -S` string, as GNU and BSD env split it: blanks separate words, single
 * quotes keep their text, and backslash escapes work outside single quotes. `\c` ends the
 * string and a word that starts with `#` starts a comment. Variables stay unexpanded, so
 * `expands` reports them as unknown.
 */
function splitString(value) {
  const words = [];
  let word;
  let quote;
  const ESCAPES = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", _: " " };
  for (let k = 0; k < value.length; k += 1) {
    const char = value[k];
    if (quote === undefined && /\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (quote === undefined && char === "#" && word === undefined) {
      break;
    } else if (char === quote) {
      quote = undefined;
    } else if (quote === undefined && (char === "'" || char === '"')) {
      quote = char;
      word ??= "";
    } else if (char === "\\" && k + 1 < value.length && (quote !== "'" || "\\'".includes(value[k + 1]))) {
      const next = value[++k];
      if (next === "c" && quote === undefined) break;
      if (next === "_" && quote === undefined) {
        if (word !== undefined) words.push(word);
        word = undefined;
      } else word = (word ?? "") + (ESCAPES[next] ?? next);
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** Known candidate directories for a state: `dirs` when uncertain, `[dir]` when known, `[]` when unknown. */
const candidatesOf = (dir, dirs) => (dirs !== undefined ? dirs : dir !== undefined ? [dir] : []);

/** Deduplicated known directories from `lists`. */
const mergeCandidates = (...lists) => [...new Set(lists.flat().filter((path) => path !== undefined))];

/** Moves `(dir, dirs)` by `path`, keeping candidate dirs when uncertain, or clears both on a remote host. */
function moveDir(dir, dirs, path, remote) {
  if (remote) return { dir: undefined, dirs: undefined };
  if (dirs === undefined) return { dir: changeDirectory(dir, path), dirs: undefined };
  if (path === undefined || path === "~" || path.startsWith("~/") || path.startsWith("/")) {
    return { dir: changeDirectory(undefined, path), dirs: undefined };
  }
  if (path === "-" || /[$`*?[]/.test(path)) return { dir: undefined, dirs: undefined };
  return { dir: undefined, dirs: mergeCandidates(dirs.map((base) => changeDirectory(base, path))) };
}

/** The file or substitution operand of `source` or `.`, or undefined for any other command. */
function sourceTarget(words) {
  if (words[0] !== "source" && words[0] !== ".") return undefined;
  return words[1] === "--" ? words[2] : words[1];
}

/** Whether a shell or `source /dev/stdin` invocation reads its commands from standard input. */
function readsStdin(words) {
  if (words.length === 0) return false;
  const target = sourceTarget(words);
  if (target !== undefined) return STDIN_PATHS.has(target);
  if (!SHELLS.has(basename(words[0]))) return false;
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
function sshProgram(argv, i, dir, dirs) {
  const takesValue = (option) => /^-[A-Za-z]$/.test(option) && SSH_VALUE_LETTERS.includes(option[1]);
  const before = skipOptions(argv, i + 1, takesValue);
  const hasHost = before.next < argv.length;
  const after = hasHost && argv[before.next - 1] !== "--" ? skipOptions(argv, before.next + 1, takesValue) : { next: before.next + 1, options: [] };
  const options = [...before.options, ...after.options];
  const settings = options.filter(([option, value]) => option === "-o" && value !== undefined).map(([, value]) => value);
  const commandsOf = (pattern) => settings.map((value) => pattern.exec(value)?.[1])
    .filter((command) => command !== undefined && command.trim().toLowerCase() !== "none");
  const local = commandsOf(SSH_LOCAL_COMMAND).map((command) => ({ script: command, dir, dirs }));
  const words = argv.slice(after.next).join(" ");
  const nested = [...commandsOf(SSH_REMOTE_COMMAND), ...(words === "" ? [] : [words])];
  const stdin = hasHost && !options.some(([option]) => SSH_NO_STDIN.has(option));
  const reads = () => stdin && (nested.length === 0 || nested.some((remote) => parseScript(remote).commands.some((command) => {
    const inner = program(command.argv, undefined);
    return readsStdin(inner.words) || inner.reads?.() === true;
  })));
  return { words: [], nested, local, dir: undefined, dirs: undefined, remote: true, reads, reparses: true };
}

/**
 * Skips assignments, shell keywords, and wrappers, collecting command strings that wrappers run.
 * On another host (`remote`), a wrapper's directory change leaves the directory unknown.
 */
function program(argv, dir, remote = false, dirs = undefined) {
  const chdir = (path) => { ({ dir, dirs } = moveDir(dir, dirs, path, remote)); };
  let appended = false; // xargs adds words read from standard input
  // Whether a skipped word runs the words after it as a command: a wrapper, an assignment, or
  // a second xargs. The first xargs alone runs echo.
  let runner = false;
  let replace; // xargs' -I or -J string, which each input line replaces
  let filled = false; // the input fills in an `env -S` string, so it may supply any words
  let envDir; // the directory state an env started in while it parses its `env -S` words again
  let i = 0;
  while (i < argv.length) {
    const name = basename(argv[i]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]) || SHELL_KEYWORDS.has(argv[i])) {
      if (!SHELL_KEYWORDS.has(argv[i])) runner = true;
      i += 1;
      continue;
    }
    if (name === "coproc") {
      // `coproc NAME { …; }` names the coprocess; `coproc command …` runs the command.
      i += argv[i + 2] === "{" ? 2 : 1;
      continue;
    }
    if (name === "ssh") {
      const remote = sshProgram(argv, i, dir, dirs);
      return { ...remote, appended };
    }
    if (name === "watch") {
      // watch runs its remaining words through `sh -c`.
      i += 1;
      while (i < argv.length && argv[i].startsWith("-")) i += ["-n", "--interval", "-q", "--equexit"].includes(argv[i]) ? 2 : 1;
      return { words: [], nested: [argv.slice(i).join(" ")], dir, dirs, appended, reparses: true };
    }
    if (name === "command") {
      // `command -v NAME` and `command -V NAME` look a command up without running it.
      let j = i + 1;
      while (j < argv.length && /^-[A-Za-z]+$/.test(argv[j]) && !/[vV]/.test(argv[j])) j += 1;
      if (/^-[A-Za-z]*[vV]/.test(argv[j] ?? "")) return { words: [], nested: [], dir, dirs, appended };
    }
    if (!Object.hasOwn(WRAPPERS, name)) break;
    runner = name !== "xargs" || appended;
    const values = WRAPPERS[name];
    const start = i;
    const { next, options } = skipOptions(argv, i + 1, (option) => values.includes(option));
    i = next;
    if (name === "env") {
      // env puts the words of an `env -S` string where the option was and parses them again,
      // so they come before the words after it, which reach the command as its arguments.
      // env changes directory once, to its last -C, from the directory it started in.
      const base = envDir ?? { dir, dirs };
      const split = options.find(([option]) => option === "-S" || option === "--split-string");
      for (const [option, value] of options) {
        if (option === "-C" || option === "--chdir") ({ dir, dirs } = moveDir(base.dir, base.dirs, value, remote));
        if (option === split?.[0]) break;
      }
      if (split !== undefined) {
        const [, value = "", end] = split;
        if (replace !== undefined && value.includes(replace)) filled = true;
        argv = [argv[start], ...splitString(value), ...argv.slice(end)];
        envDir = base;
        i = 0;
        continue;
      }
      envDir = undefined;
    }
    if (name === "sudo") {
      for (const [option, value] of options) if (option === "-D" || option === "--chdir") chdir(value);
    }
    if (name === "timeout") i += 1; // the duration
    if (name === "xargs") {
      appended = true;
      for (const [option, value] of options) {
        if (option === "-I" || option === "-J" || option === "--replace") replace = value || "{}";
        else if (option === "-i") replace = "{}";
      }
    }
  }
  // `bare`: wrappers or assignments with no command after them, so the command is the words
  // xargs adds, if any.
  const bare = i === argv.length && runner;
  const fill = (word) => (replace === undefined ? word : word.replaceAll(replace, FILLED));
  const words = argv.slice(i).map(fill);
  // `fills`: the input fills in the command's name or an `env -S` string.
  const fills = filled || (words[0] ?? "").includes(FILLED);
  return { words, nested: [], dir, dirs, appended, bare, fills };
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
function findScripts(words, dir, dirs) {
  const scripts = [];
  for (let i = 1; i < words.length; i += 1) {
    if (!FIND_EXEC.has(words[i])) continue;
    let j = i + 1;
    while (j < words.length && words[j] !== ";" && words[j] !== "+") j += 1;
    const perMatch = words[i].endsWith("dir");
    scripts.push({ script: quote(words.slice(i + 1, j)), dir: perMatch ? undefined : dir, dirs: perMatch ? undefined : dirs });
    i = j;
  }
  return scripts;
}

/** Text printed by a `<(…)` or `=(…)` process substitution passed to `source`, `.` or `< <(…)`. */
function processSubScript(word, depth = 0) {
  if (depth > MAX_DEPTH || !/^[<=]\(.*\)$/s.test(word)) return undefined;
  const parts = [];
  for (const { argv, inputs } of parseScript(word.slice(2, -1)).commands) {
    parts.push(...inputs);
    const { words } = program(argv, undefined);
    const text = words.length > 0 ? printed(words, depth + 1) : undefined;
    if (text !== undefined) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
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

/**
 * Computes per-command execution-context metadata for `commands` from `parseScript`:
 * - `grouped`: inside `( … )`, `{ …; }`, a compound command (`if`/`for`/`while`/`until`/`case`/`select`/`repeat`), or a function body.
 * - `piped`: part of a `|` or `|&` pipeline, or enclosed by a piped group or script.
 * - `background`: backgrounded via `&` (including an `&&`/`||` list ending in `&`), `coproc`, or enclosed by a backgrounded group or script.
 */
function analyzeCommands(commands, inheritedPiped, inheritedBg) {
  const n = commands.length;
  const grouped = new Array(n).fill(false);
  const pipedDepth = new Array(n).fill(inheritedPiped ? -1 : Infinity);
  const bgDepth = new Array(n).fill(inheritedBg ? -1 : Infinity);
  const bg = new Array(n).fill(Boolean(inheritedBg));
  const depthBefore = new Array(n).fill(0);
  const spans = [];
  const subStack = [];
  const braceStack = [];
  const compoundStack = [];
  const groupDepth = () => subStack.length + braceStack.length + compoundStack.length;
  const isPipe = (op) => op === "|" || op === "|&";
  const recordOp = (idx, op, depth) => {
    if (op === "&") {
      bg[idx] = true;
      bgDepth[idx] = Math.min(bgDepth[idx], depth);
    } else if (isPipe(op)) {
      pipedDepth[idx] = Math.min(pipedDepth[idx], depth);
    }
  };

  let pendingCoprocSubshell = false;
  for (let i = 0; i < n; i += 1) {
    const command = commands[i];
    if (command.funcBody) grouped[i] = true;
    depthBefore[i] = groupDepth();
    const coprocSub = pendingCoprocSubshell;
    pendingCoprocSubshell = false;
    for (let k = 0; k < command.opens; k += 1) {
      subStack.push({ start: i, outerDepth: groupDepth(), coproc: coprocSub && k === 0 });
    }
    let coprocHere = false;
    let coprocPos = -1;
    let j = 0;
    while (j < command.argv.length) {
      const word = command.argv[j];
      if (basename(word) === "coproc") {
        coprocHere = true;
        coprocPos = j;
        bg[i] = true;
        const next2 = command.argv[j + 2];
        j += next2 === "{" || Object.hasOwn(COMPOUND_OPEN, next2) ? 2 : 1;
        continue;
      }
      if (word === "{") {
        braceStack.push({ start: i, outerDepth: groupDepth(), subshellDepth: subStack.length, coproc: coprocHere });
        coprocHere = false;
      } else if (Object.hasOwn(COMPOUND_OPEN, word)) {
        compoundStack.push({ start: i, close: COMPOUND_OPEN[word], outerDepth: groupDepth(), subshellDepth: subStack.length, coproc: coprocHere });
        coprocHere = false;
      }
      if (word !== "time" && !SHELL_KEYWORDS.has(word)) break;
      j += 1;
    }
    if (coprocHere && command.next === "(" && command.argv.length - coprocPos <= 2) {
      pendingCoprocSubshell = true;
    }
    if (command.argv[0] === "}" && braceStack.length > 0 && braceStack.at(-1).subshellDepth === subStack.length) {
      const open = braceStack.pop();
      spans.push({ start: open.start, end: i, outerDepth: open.outerDepth, coproc: open.coproc });
    } else if (command.argv.length === 1 && COMPOUND_CLOSE.has(command.argv[0])
      && compoundStack.at(-1)?.close === command.argv[0] && compoundStack.at(-1).subshellDepth === subStack.length) {
      const open = compoundStack.pop();
      spans.push({ start: open.start, end: i, outerDepth: open.outerDepth, coproc: open.coproc });
    }
    const selfOp = command.closes > 0 ? command.closeOps[0] : command.next;
    recordOp(i, selfOp, groupDepth());
    for (let k = 0; k < command.closes && subStack.length > 0; k += 1) {
      const open = subStack.pop();
      spans.push({ start: open.start, end: i, outerDepth: open.outerDepth, coproc: open.coproc });
      while (braceStack.length > 0 && braceStack.at(-1).subshellDepth > subStack.length) {
        const b = braceStack.pop();
        spans.push({ start: b.start, end: i, outerDepth: b.outerDepth, coproc: b.coproc });
      }
      while (compoundStack.length > 0 && compoundStack.at(-1).subshellDepth > subStack.length) {
        const c = compoundStack.pop();
        spans.push({ start: c.start, end: i, outerDepth: c.outerDepth, coproc: c.coproc });
      }
      const closeOp = k + 1 < command.closes ? command.closeOps[k + 1] : command.next;
      recordOp(i, closeOp, groupDepth());
    }
    recordOp(i, command.next, groupDepth());
    if (isPipe(command.next) && i + 1 < n) {
      pipedDepth[i + 1] = Math.min(pipedDepth[i + 1], groupDepth());
    }
  }
  // Unclosed groups (e.g. zsh short `for x in a b; cmd`) cover through the end of the script.
  for (const open of [...subStack, ...braceStack, ...compoundStack]) {
    spans.push({ start: open.start, end: n - 1, outerDepth: open.outerDepth, coproc: open.coproc });
  }
  for (const { start, end } of spans) {
    for (let k = start; k <= end; k += 1) grouped[k] = true;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const { start, end, outerDepth, coproc } of spans) {
      const spanPiped = Math.min(pipedDepth[start], pipedDepth[end]);
      const spanBg = Math.min(bgDepth[start], bgDepth[end]);
      for (let k = start; k <= end; k += 1) {
        if (spanPiped <= outerDepth && spanPiped < pipedDepth[k]) {
          pipedDepth[k] = spanPiped;
          changed = true;
        }
        if (spanBg <= outerDepth && spanBg < bgDepth[k]) {
          bgDepth[k] = spanBg;
          bg[k] = true;
          changed = true;
        }
        if (coproc && !bg[k]) {
          bg[k] = true;
          changed = true;
        }
      }
    }
    for (let i = n - 2; i >= 0; i -= 1) {
      if (["&&", "||", "|", "|&"].includes(commands[i].next)) {
        const listDepth = depthBefore[i + 1];
        if (bgDepth[i + 1] <= listDepth && bgDepth[i + 1] < bgDepth[i]) {
          bgDepth[i] = bgDepth[i + 1];
          bg[i] = true;
          changed = true;
        }
      }
    }
  }
  return commands.map((_, i) => ({ grouped: grouped[i], piped: pipedDepth[i] < Infinity, background: bg[i] }));
}

function inspect(source, state, visit, depth, tooDeep) {
  if (depth > MAX_DEPTH) return tooDeep;
  state.cdCount ??= 0;
  state.cdTargets ??= [];
  // Whether this script runs on another host, over ssh.
  const here = state.remote === true;
  // Whether xargs adds words to the command that runs this script, such as `xargs ssh host
  // 'gh pr merge 12'`. They join the script's text, which the shell parses again, so the guard
  // cannot tell which command gets them and treats every command in it as getting more words.
  const added = state.appended === true;
  const { commands } = parseScript(source);
  const cmdMeta = analyzeCommands(commands, state.piped, state.background);
  const snapshot = () => ({
    dir: state.dir,
    dirs: state.dirs ? [...state.dirs] : undefined,
    cdCount: state.cdCount,
    cdLen: state.cdTargets.length,
  });
  const restore = (snap) => {
    state.dir = snap.dir;
    state.dirs = snap.dirs ? [...snap.dirs] : undefined;
    state.cdCount = snap.cdCount;
    state.cdTargets.length = snap.cdLen;
  };
  const markUncertain = (beforeSnap, targets) => {
    state.dir = undefined;
    state.dirs = mergeCandidates(candidatesOf(beforeSnap.dir, beforeSnap.dirs), targets);
  };
  // Text printed inside each open `{ …; }` group or `( … )` subshell, so a group piped into a
  // shell feeds it everything its commands print.
  const groups = [];
  // The directory state before each open `( … )` subshell: a `cd` inside one ends with it.
  const subshells = [];
  // The directory state before each open `{ …; }` group: zsh runs a group that a `|` or `&`
  // follows in a subshell, so a `cd` inside it ends with it.
  const braces = [];
  // Open compound commands (`while`, `until`, `for`, `if`, `case`): when a `|` or `&` follows
  // the closing keyword and a `cd` ran inside, the directory becomes uncertain with both the
  // pre-compound directory and the `cd` targets as candidates.
  const compounds = [];
  const leave = (count) => {
    for (let k = 0; k < count && subshells.length > 0; k += 1) {
      restore(subshells.pop());
      while (braces.length > 0 && braces.at(-1).subshellDepth > subshells.length) braces.pop();
      while (compounds.length > 0 && compounds.at(-1).subshellDepth > subshells.length) compounds.pop();
    }
  };
  let pipeline = [];
  for (let idx = 0; idx < commands.length; idx += 1) {
    const command = commands[idx];
    const meta = cmdMeta[idx];
    for (let k = 0; k < command.opens; k += 1) subshells.push(snapshot());
    for (const word of command.argv) {
      if (word === "{") braces.push({ ...snapshot(), subshellDepth: subshells.length });
      else if (Object.hasOwn(COMPOUND_OPEN, word)) {
        compounds.push({ close: COMPOUND_OPEN[word], before: snapshot(), subshellDepth: subshells.length });
      }
      if (word !== "time" && !SHELL_KEYWORDS.has(word)) break;
    }
    if (command.argv[0] === "}" && braces.length > 0 && braces.at(-1).subshellDepth === subshells.length) {
      const before = braces.pop();
      if (["|", "|&", "&"].includes(command.next)) restore(before);
    } else if (command.argv.length === 1 && COMPOUND_CLOSE.has(command.argv[0])
      && compounds.at(-1)?.close === command.argv[0] && compounds.at(-1).subshellDepth === subshells.length) {
      const entry = compounds.pop();
      if (!here && ["|", "|&", "&"].includes(command.next) && state.cdCount > entry.before.cdCount) {
        markUncertain(entry.before, [...state.cdTargets.slice(entry.before.cdLen), ...candidatesOf(state.dir, state.dirs)]);
      }
    }
    const run = program(command.argv, state.dir, here, state.dirs);
    for (let k = 0; k < command.opens + (command.argv[0] === "{" ? 1 : 0); k += 1) groups.push([]);
    const text = run.words.length > 0 ? printed(run.words) : undefined;
    run.printed = text === undefined ? [] : [text];
    groups.at(-1)?.push(...run.printed);
    for (let k = 0; k < command.closes + (command.argv[0] === "}" ? 1 : 0) && groups.length > 0; k += 1) {
      run.printed = groups.pop();
      groups.at(-1)?.push(...run.printed);
    }
    // `before` and `beforeDirs` hold the shell's directory state when this part starts, where its substitutions run.
    pipeline.push({ command, meta, run, before: state.dir, beforeDirs: state.dirs ? [...state.dirs] : undefined });
    if (command.next === "|" || command.next === "|&") {
      leave(command.closes);
      continue;
    }
    // A shell or `source /dev/stdin` reading standard input runs the heredocs, here-strings and printed text piped to it.
    const fed = pipeline.length > 1 || pipeline[0].command.inputs.length > 0;
    const reader = fed ? pipeline.findIndex(({ run: { words, reads } }) => reads?.() === true || readsStdin(words)) : -1;
    // A background job and every part of a pipeline but the last run in a subshell, so a `cd`
    // there moves nothing after it. zsh, the shell Claude Code runs commands in, runs the last
    // part in the current shell, so a `cd` there moves later commands; bash would not.
    const background = pipeline.at(-1).command.next === "&";
    const readerInShell = reader !== -1 && !background && reader === pipeline.length - 1 && !here
      && sourceTarget(pipeline[reader].run.words) !== undefined;
    for (const [index, { command: { argv, inputs, substitutions }, meta: { grouped, piped, background: inBackground }, run: { words, nested, local, dir, dirs, remote, printed: text, appended, reparses, bare, fills }, before, beforeDirs }] of pipeline.entries()) {
      const name = words.length > 0 ? basename(words[0]) : "";
      const lastInShell = !background && index === pipeline.length - 1 && !here;
      const topLevel = depth === 0 && !grouped && !piped && !inBackground;
      // Its substitutions, which the shell running it expands first, scripts this command runs
      // itself, and scripts the reading shell runs in its directory. An ssh command's scripts
      // run on the remote host; its local options' commands run here. The words xargs adds to
      // ssh or watch join the script they run.
      const scripts = [
        ...substitutions.map((script) => ({ script, dir: before, dirs: beforeDirs, remote: here })),
        ...nested.map((script) => ({ script, dir, dirs, remote: here || Boolean(remote), appended })),
        ...(local ?? []).map((entry) => ({ ...entry, remote: here })),
      ];
      if (SHELLS.has(name)) scripts.push(...shellScripts(words).map((script) => ({ script, dir, dirs, remote: here })));
      if (name === "eval") {
        const evalWords = words[1] === "--" || words[1] === "-" ? words.slice(2) : words.slice(1);
        scripts.push({ script: evalWords.join(" "), dir, dirs, remote: here, sameShell: lastInShell });
      }
      const sourced = sourceTarget(words);
      if (sourced !== undefined) {
        const inline = processSubScript(sourced);
        if (inline !== undefined) scripts.push({ script: inline, dir, dirs, remote: here, sameShell: lastInShell });
      }
      if (name === "find") scripts.push(...findScripts(words, dir, dirs).map((entry) => ({ ...entry, remote: here })));
      if (reader !== -1) {
        const pipedScripts = index < reader ? [...inputs, ...text] : inputs;
        const targetRun = pipeline[reader].run;
        scripts.push(...pipedScripts.map((script) => ({
          script,
          dir: targetRun.dir,
          dirs: targetRun.dirs,
          remote: here || Boolean(targetRun.remote),
          sameShell: readerInShell,
        })));
      }
      for (const { script, dir: where, dirs: whereDirs, remote: onRemote, appended: adds, sameShell } of scripts) {
        if (script === undefined) continue;
        const child = {
          dir: where,
          dirs: whereDirs ? [...whereDirs] : undefined,
          remote: onRemote,
          appended: added || adds === true,
          piped,
          background: inBackground,
          cdCount: 0,
          cdTargets: [],
        };
        const violation = inspect(script, child, visit, depth + 1, tooDeep);
        if (violation) return violation;
        if (sameShell && child.cdCount > 0) {
          const prev = snapshot();
          state.cdCount += child.cdCount;
          state.cdTargets.push(...child.cdTargets);
          markUncertain(prev, [...child.cdTargets, ...candidatesOf(child.dir, child.dirs)]);
        }
      }
      // Words xargs adds that make a command the guard cannot see: ssh and watch parse them
      // again as a script, wrappers with no command run them as one, a shell's `-c` without its
      // script and eval run them as a script, find runs an `-exec` they add, and with `-I` the
      // input can be the command's name or part of a script. Options xargs adds to ssh, such
      // as ProxyCommand, run here, so the opaque command is not remote.
      const opaque = (added || appended) && (reparses === true || bare === true || fills === true || name === "find" || name === "eval"
        || (SHELLS.has(name) && shellScripts(words).some((script) => script === undefined || script.includes(FILLED))));
      if (opaque) {
        const opaqueDir = dir !== undefined || dirs !== undefined ? dir : before;
        const opaqueDirs = dir !== undefined || dirs !== undefined ? dirs : beforeDirs;
        const violation = visit(argv, opaqueDir, { appended: true, opaque: true, remote: here, topLevel, piped, background: inBackground, ...(opaqueDirs !== undefined && { dirs: opaqueDirs }) });
        if (violation) return violation;
      }
      if (name === "cd" || name === "pushd" || name === "popd") {
        if (background || index < pipeline.length - 1) continue;
        // A directory on another host is unknown here, whatever path it names.
        if (here) {
          state.dir = undefined;
          state.dirs = undefined;
        } else {
          state.cdCount += 1;
          if (name === "popd") {
            state.dir = undefined;
            state.dirs = undefined;
          } else {
            const arg = words.slice(1).find((word) => !/^-[LPe@]+$/.test(word));
            ({ dir: state.dir, dirs: state.dirs } = moveDir(before, beforeDirs, arg, false));
            state.cdTargets.push(...candidatesOf(state.dir, state.dirs));
          }
        }
      } else if (words.length > 0) {
        const violation = visit(words, dir, { appended: added || appended, opaque: false, remote: here, topLevel, piped, background: inBackground, ...(dirs !== undefined && { dirs }) });
        if (violation) return violation;
      }
    }
    leave(pipeline.at(-1).command.closes);
    pipeline = [];
  }
  return undefined;
}

/**
 * Calls `visit(words, dir, { appended, opaque, remote, topLevel, piped, background, dirs })` for every command `source` would run,
 * after wrappers, through shells, substitutions, `eval`, `source`, `find -exec` and `ssh`; `dir` is its
 * directory when known, and always undefined for a command on another host or when a `cd` inside `eval`,
 * `source` or a non-last piped compound command leaves the directory uncertain (in which case `dirs` lists
 * the known candidate directories), `appended` says that xargs adds arguments the guard cannot see, and
 * `remote` says that it runs on another host over `ssh`. `topLevel` says that the command runs directly
 * in the top-level sequential list (not nested inside a loop, function body, group, subshell, pipeline,
 * background job, or inner script); `piped` and `background` say whether the command (or an enclosing
 * group or script) is in a pipeline or backgrounded. `opaque` says that the words xargs adds may run
 * a command the guard cannot see at all, as in `xargs sudo`, `xargs ssh host true`, `xargs bash -c` or
 * `xargs find`; then `words` are the xargs command's own words, and the command they name is visited too.
 * A word that holds xargs' `-I` replace string holds `${xargs}` in its place, which `expands` reports.
 * Returns the first reason `visit` gives for blocking one, or undefined. A script nested
 * more than eight levels deep returns `tooDeep`, which is undefined unless given.
 */
export function visitCommands(source, cwd, visit, tooDeep) {
  return inspect(source, { dir: cwd }, visit, 0, tooDeep);
}
