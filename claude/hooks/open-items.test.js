import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openItems, unfiledItems } from "./open-items.js";

const config = JSON.parse(readFileSync(join(import.meta.dir, "open-items.json"), "utf8"));
const HOOK = join(import.meta.dir, "open-items.js");
const SLUGS = ["dotfiles", "agent-board"];
const check = (reply) => unfiledItems(openItems(reply, config), SLUGS);

// The reply that started this hook: unfinished parts under "Limits", none on the board.
const LIMITS = [
  "## Result",
  "Found 70 machines.",
  "",
  "## Limits",
  "**Board server, not read in full:** `snapshot.rs` alert logic and the migration bodies.",
  "**Not run:** the reported races are code readings.",
].join("\n");

test("items under an open heading without an id are reported", () => {
  expect(check(LIMITS)).toHaveLength(2);
});

test("a task of a known board, an ask or an explicit exempt phrase passes an item", () => {
  const reply = [
    "## Limits",
    "- The races are code readings (dotfiles-426).",
    "- The client half is agent-board-477.",
    "- The merge waits on your answer to ask #31.",
    "- The Pro was asleep. No action: the hourly job retries.",
    "- The old path needs no work, it is gone.",
    "- Nothing else.",
  ].join("\n");
  expect(check(reply)).toEqual([]);
});

test("words that only look like ids or exemptions do not pass an item", () => {
  const reply = [
    "## Not verified",
    "- the utf-8 path",
    "- sha-256 sums and claude-opus-5-5",
    "- ask 3 reviewers",
    "- Nothing was verified on Linux.",
    "- None of the live suites ran.",
  ].join("\n");
  expect(check(reply)).toHaveLength(5);
});

test("a lead label marks its own item outside an open section", () => {
  const reply = "## Result\nAll suites pass.\n\n**Not verified:** the live suite on the Pro.";
  expect(check(reply)).toEqual(["**Not verified:** the live suite on the Pro."]);
});

test("a label alone on its line opens its list, with the colon inside or outside the bold", () => {
  expect(check("## Result\n**Not run:**\n- the live suite")).toEqual(["the live suite"]);
  expect(check("## Result\n**Not run**:\n- the live suite")).toEqual(["the live suite"]);
});

test("a plain label inside an open section keeps it open, and a new section closes it", () => {
  const reply = "## Limits\n**Board server:**\n- check_handover\n## Changes\n- Edited the hook.";
  expect(check(reply)).toEqual(["check_handover"]);
});

test("intro lines and nested bullets of a filed item are not reported", () => {
  const reply = "## Limits\nTwo limits remain:\n- A (dotfiles-1)\n  - detail of A\n- B (dotfiles-2)";
  expect(check(reply)).toEqual([]);
});

test("a section marked no action in its heading or intro is skipped", () => {
  expect(check("## Limitations (no action)\n- It has no async API.")).toEqual([]);
  expect(check("## Caveats\nThese describe the library. No action: nothing to file.\n- It has no async API.")).toEqual([]);
});

test("other sections, tables and code are ignored", () => {
  const reply = [
    "## Rate limits",
    "- The API allows 50 requests a minute.",
    "## Next steps",
    "| step | owner |",
    "```",
    "- not an item",
    "```",
    "## Changes",
    "- Edited the hook.",
  ].join("\n");
  expect(check(reply)).toEqual([]);
});

test("a wrapped list item is one item and its id on the second line counts", () => {
  const reply = "## Open items\n- The lock steal is reproduced and\n  filed as dotfiles-342.\n- The helper has no tests.";
  expect(check(reply)).toEqual(["The helper has no tests."]);
});

const STATUS = '{"board":{"slug":"dotfiles"}}';
const BOARDS = '[{"slug":"dotfiles"},{"slug":"agent-board"}]';

function run(input, { status = STATUS, boards = BOARDS, exit = 0, enabled = true, bin, env = {}, policy } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "open-items-"));
  try {
    const board = bin ?? join(dir, "board");
    writeFileSync(join(dir, "board"),
      `#!/bin/sh\nif [ "$1" = boards ]; then cat <<'JSON'\n${boards}\nJSON\nelse cat <<'JSON'\n${status}\nJSON\nfi\nexit ${exit}\n`);
    chmodSync(join(dir, "board"), 0o755);
    const file = join(dir, "open-items.json");
    writeFileSync(file, JSON.stringify({ ...config, enabled }));
    const result = Bun.spawnSync([process.execPath, HOOK], {
      stdin: Buffer.from(JSON.stringify({ cwd: dir, ...input })),
      env: { ...process.env, AGENT_BOARD_HOOKS: "", BOARD_BIN: board, OPEN_ITEMS: policy ?? file, ...env },
    });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the hook blocks the stop once and names the items", () => {
  const { code, stderr } = run({ last_assistant_message: LIMITS });
  expect(code).toBe(2);
  expect(stderr).toContain("**Not run:** the reported races");
  expect(stderr).toContain("ask #<n>");
});

test("the hook passes a stop that continues from a Stop hook, or with board hooks off", () => {
  expect(run({ last_assistant_message: LIMITS, stop_hook_active: true }).code).toBe(0);
  expect(run({ last_assistant_message: LIMITS }, { env: { AGENT_BOARD_HOOKS: "off" } }).code).toBe(0);
});

test("the hook fails open without a board, a binary or a JSON answer, and when off or without a reply", () => {
  expect(run({ last_assistant_message: LIMITS }, { status: '{"boards":[]}' }).code).toBe(0);
  expect(run({ last_assistant_message: LIMITS }, { exit: 1 })).toEqual({ code: 0, stderr: "" });
  expect(run({ last_assistant_message: LIMITS }, { status: "not json" })).toEqual({ code: 0, stderr: "" });
  expect(run({ last_assistant_message: LIMITS }, { boards: "not json" })).toEqual({ code: 0, stderr: "" });
  expect(run({ last_assistant_message: LIMITS }, { bin: "/nonexistent/board" })).toEqual({ code: 0, stderr: "" });
  expect(run({ last_assistant_message: LIMITS }, { enabled: false }).code).toBe(0);
  expect(run({}).code).toBe(0);
});

test("an unreadable config is a hook error, never a block", () => {
  expect(run({ last_assistant_message: LIMITS }, { policy: "/nonexistent/open-items.json" }).code).toBe(1);
});

test("the hook passes a reply whose open items all name a task", () => {
  expect(run({ last_assistant_message: "## Limits\n- The races are code readings (dotfiles-426)." }).code).toBe(0);
});
