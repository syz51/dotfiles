// PreToolUse hook for live tests: keeps fixture tasks self-contained by blocking
// package installs, downloads and web access. Exit 2 blocks the call and shows stderr
// to the model.
const DOWNLOAD = new RegExp([
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci|update|upgrade|x|dlx)\b`,
  String.raw`\b(?:vp|vite-plus)\s+(?:i|install|add|update|up|dlx|upgrade)\b`,
  String.raw`\b(?:npx|bunx|vpx|uvx|pipx)\b`,
  String.raw`\bpip3?\s+install\b`,
  String.raw`\buv\s+(?:add|pip|sync|lock|tool|python\s+install)\b`,
  String.raw`\bcargo\s+(?:install|add|update|fetch|generate-lockfile)\b`,
  String.raw`\brustup\b`,
  String.raw`\bbrew\s+(?:install|upgrade|update)\b`,
  String.raw`\b(?:curl|wget)\b`,
  String.raw`\bgit\s+(?:clone|fetch|pull)\b`,
  String.raw`\bplaywright\s+install\b`,
  String.raw`\bsetup\.sh\b`,
].join("|"));

// A quote that opens the script a shell runs: the argument of sh -c (or bash, zsh, dash)
// or of eval.
const SCRIPT_ARGUMENT = /(?:\b(?:ba|z|da)?sh(?:\s+-[a-zA-Z]+)*\s+-[a-zA-Z]*c|\beval)\s+$/;

// The command with the contents of quoted strings blanked, so data such as a test string
// in `bun -e "..."` does not match. A string the shell runs (a script argument, or a
// double-quoted string with a command substitution) keeps its text, checked the same way.
// This is a fixture sandbox, not a security boundary: a program that starts an install
// itself is not caught.
function commandText(command) {
  let out = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\") {
      out += command.slice(i, i + 2);
      i++;
      continue;
    }
    if (char !== "'" && char !== '"') {
      out += char;
      continue;
    }
    let end = i + 1;
    while (end < command.length && command[end] !== char) end += char === '"' && command[end] === "\\" ? 2 : 1;
    const body = command.slice(i + 1, end);
    const runs = SCRIPT_ARGUMENT.test(out) || (char === '"' && /\$\(|`/.test(body));
    out += runs ? ` ${commandText(body)} ` : `${char}${char}`;
    i = end;
  }
  return out;
}

const input = JSON.parse(await Bun.stdin.text());
const reason = ["WebFetch", "WebSearch"].includes(input.tool_name)
  ? "web access"
  : input.tool_name === "Bash" && DOWNLOAD.test(commandText(input.tool_input?.command ?? "")) ? "a package install or download" : null;
if (reason) {
  console.error(`Blocked by the live-test sandbox: ${reason} is not available in this offline fixture. Work with what is installed.`);
  process.exit(2);
}
