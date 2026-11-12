import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unfiledItems } from "./open-items.js";

const config = JSON.parse(readFileSync(join(import.meta.dir, "open-items.json"), "utf8"));
const HOOK = join(import.meta.dir, "open-items.js");

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
  expect(unfiledItems(LIMITS, config)).toHaveLength(2);
});

test("a task id, an ask or an exempt phrase passes an item", () => {
  const reply = [
    "## Limits",
    "- The races are code readings (dotfiles-426).",
    "- The merge waits on your answer to ask #31.",
    "- The Pro was asleep. No action: the hourly job retries.",
    "- Nothing else.",
  ].join("\n");
  expect(unfiledItems(reply, config)).toEqual([]);
});

test("a version-like word is not a task id", () => {
  expect(unfiledItems("## Follow-ups\n- Rerun with claude-opus-5-5.", config)).toHaveLength(1);
});

test("a lead label marks its own item outside an open section", () => {
  const reply = "## Result\nAll suites pass.\n\n**Not verified:** the live suite on the Pro.";
  expect(unfiledItems(reply, config)).toEqual(["**Not verified:** the live suite on the Pro."]);
});

test("a label that introduces a list is not an item, and its list is not checked", () => {
  const reply = "## Result\n**Not run:**\n- nothing was skipped";
  expect(unfiledItems(reply, config)).toEqual([]);
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
  expect(unfiledItems(reply, config)).toEqual([]);
});

test("a wrapped list item is one item and its id on the second line counts", () => {
  const reply = "## Open items\n- The lock steal is reproduced and\n  filed as dotfiles-342.\n- The helper has no tests.";
  expect(unfiledItems(reply, config)).toEqual(["The helper has no tests."]);
});

function run(input, { board = '{"board":{"slug":"x"}}', enabled = true, exit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "open-items-"));
  try {
    const bin = join(dir, "board");
    writeFileSync(bin, `#!/bin/sh\ncat <<'JSON'\n${board}\nJSON\nexit ${exit}\n`);
    chmodSync(bin, 0o755);
    const policy = join(dir, "open-items.json");
    writeFileSync(policy, JSON.stringify({ ...config, enabled }));
    const result = Bun.spawnSync([process.execPath, HOOK], {
      stdin: Buffer.from(JSON.stringify({ cwd: dir, ...input })),
      env: { ...process.env, BOARD_BIN: bin, OPEN_ITEMS: policy },
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
  expect(stderr).toContain("name the id");
});

test("the hook passes a stop that continues from a Stop hook", () => {
  expect(run({ last_assistant_message: LIMITS, stop_hook_active: true }).code).toBe(0);
});

test("the hook passes without a board, when the board fails, when off, and without a reply", () => {
  expect(run({ last_assistant_message: LIMITS }, { board: '{"boards":[]}' }).code).toBe(0);
  expect(run({ last_assistant_message: LIMITS }, { exit: 1 }).code).toBe(0);
  expect(run({ last_assistant_message: LIMITS }, { enabled: false }).code).toBe(0);
  expect(run({}).code).toBe(0);
});

test("the hook passes a reply whose open items all name a task", () => {
  expect(run({ last_assistant_message: "## Limits\n- The races are code readings (dotfiles-426)." }).code).toBe(0);
});
