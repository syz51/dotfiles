// PreToolUse hook for live tests: keeps fixture tasks self-contained by blocking
// package installs, downloads and web access. Exit 2 blocks the call and shows stderr
// to the model.
const DOWNLOAD = new RegExp([
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci|update|upgrade|x|dlx)\b`,
  String.raw`\b(?:npx|bunx|uvx|pipx)\b`,
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

const input = JSON.parse(await Bun.stdin.text());
const reason = ["WebFetch", "WebSearch"].includes(input.tool_name)
  ? "web access"
  : input.tool_name === "Bash" && DOWNLOAD.test(input.tool_input?.command ?? "") ? "a package install or download" : null;
if (reason) {
  console.error(`Blocked by the live-test sandbox: ${reason} is not available in this offline fixture. Work with what is installed.`);
  process.exit(2);
}
