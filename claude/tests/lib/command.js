// What a Bash command runs, read with a small literal grammar, not a shell interpreter:
// a command it cannot read is treated as possibly running anything. It reads plain
// words, quotes without expansion, `&&` lists, a trailing `2>&1`, `>` and `>>` to a
// literal file (marking the list `redirected`), and one `sh -c`/`bash -lc` wrapper.
// Live scenarios prove that a check passed from the check's own output (mainBashPrinted
// in stream.js), not from this grammar.
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
