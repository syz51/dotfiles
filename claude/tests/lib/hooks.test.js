import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hook = (name, input, ...args) =>
  spawnSync(process.execPath, [join(import.meta.dir, "hooks", name), ...args], { input: JSON.stringify(input), encoding: "utf8" });
const bash = (command) => hook("block-installs.js", { tool_name: "Bash", tool_input: { command } });

test("installs, downloads and web access are blocked", () => {
  for (const command of [
    "npm install", "npm i left-pad", "bun add zod", "bunx tsc", "npx playwright test", "pnpm dlx x", "uvx ruff",
    "pip install requests", "uv add httpx", "uv pip install x", "cargo add serde", "cargo install ripgrep",
    "curl -sL https://example.com", "wget x", "git clone https://x", "sh ~/.claude/skills/headless-browser/scripts/setup.sh",
    "bunx playwright install chromium",
  ]) {
    const run = bash(command);
    expect(run.status, command).toBe(2);
    expect(run.stderr).toContain("Blocked by the live-test sandbox");
  }
  for (const tool of ["WebFetch", "WebSearch"]) expect(hook("block-installs.js", { tool_name: tool, tool_input: {} }).status).toBe(2);
});

test("ordinary commands and tools pass", () => {
  for (const command of ["npm test", "bun check.js", "uv run python check.py", "cargo check", "git status", "ls node_modules"])
    expect(bash(command).status, command).toBe(0);
  expect(hook("block-installs.js", { tool_name: "Read", tool_input: { file_path: "/x" } }).status).toBe(0);
});

test("words inside quoted data pass; quoted text a shell runs is still checked", () => {
  // A verifier's probe passes install commands as test strings; it installs nothing.
  for (const command of [
    `bun -e 'console.log(guard("pip install requests"), guard("npx tsc"))'`,
    `bun -e "check('curl https://x', \\"npm install\\")"`,
    `echo 'git clone x' | grep clone`,
    `git commit -m "Block npx and pip install in fixtures"`,
  ]) expect(bash(command).status, command).toBe(0);
  for (const command of [
    `sh -c "pip install requests"`,
    `bash -lc 'npx tsc'`,
    `eval "curl -sL https://x"`,
    `echo "$(curl -s https://x)"`,
    "echo \"`wget x`\"",
    `bash -c "bun -e 'x' && npm install left-pad"`,
    `npm install "left-pad"`,
    `cd 'my dir' && pip install x`,
  ]) expect(bash(command).status, command).toBe(2);
});

const dir = mkdtempSync(join(tmpdir(), "hooks-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the recorder saves each hook input as its own file, in call order", () => {
  for (const id of ["a", "b"]) expect(hook("record.js", { hook_event_name: "PreToolUse", tool_use_id: id }, dir).status).toBe(0);
  expect(readdirSync(dir).sort().map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")).tool_use_id)).toEqual(["a", "b"]);
  expect(spawnSync(process.execPath, [join(import.meta.dir, "hooks", "record.js"), dir], { input: "{bad", encoding: "utf8" }).status).not.toBe(0);
});
