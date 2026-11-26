import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openItems, openItemsSection, turnUsedTools, unfiledItems } from "./open-items.js";

const config = JSON.parse(readFileSync(join(import.meta.dir, "open-items.json"), "utf8"));
const HOOK = join(import.meta.dir, "open-items.js");
const SLUGS = ["dotfiles", "agent-board"];
const check = (reply) => unfiledItems(openItems(reply, config), SLUGS);

const CLAUDE_TOOL_TURN = [
  JSON.stringify({ type: "user", message: { role: "user", content: "Fix the bug" } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }] } }),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
].join("\n") + "\n";

const CLAUDE_TEXT_ONLY_AFTER_TOOLS = [
  CLAUDE_TOOL_TURN.trimEnd(),
  JSON.stringify({ type: "user", message: { role: "user", content: "What does that flag mean?" } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "It enables strict mode." }] } }),
].join("\n") + "\n";

const AGY_TOOL_TURN = [
  JSON.stringify({ type: "USER_INPUT", source: "USER_EXPLICIT", content: "Fix the bug" }),
  JSON.stringify({ type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "bun test" } }] }),
  JSON.stringify({ type: "GENERIC", content: "ok" }),
  JSON.stringify({ type: "PLANNER_RESPONSE", content: "Done." }),
].join("\n") + "\n";

const AGY_TEXT_ONLY_AFTER_TOOLS = [
  AGY_TOOL_TURN.trimEnd(),
  JSON.stringify({ type: "USER_INPUT", source: "USER_EXPLICIT", content: "What does that flag mean?" }),
  JSON.stringify({ type: "PLANNER_RESPONSE", content: "It enables strict mode." }),
].join("\n") + "\n";

const UNFILED_REPLY = [
  "## Result",
  "Found 70 machines.",
  "",
  "Open items:",
  "- Board server alert logic not read in full.",
  "- The live suite on the Pro was not run.",
].join("\n");

test("entries under Open items without an id or exemption are reported", () => {
  expect(check(UNFILED_REPLY)).toHaveLength(2);
  expect(check("Done.\n\nOpen items: follow up on deploy.")).toEqual(["follow up on deploy."]);
  expect(check("Done.\n\n**Open items:** follow up on deploy.")).toEqual(["follow up on deploy."]);
  expect(check("Done.\n\n## Open items\n\nThe helper has no tests.")).toEqual(["The helper has no tests."]);
});

test("a task of a known board, an ask or an explicit exempt phrase passes an entry", () => {
  const reply = [
    "Open items:",
    "- The races are code readings (dotfiles-426).",
    "- The client half is agent-board-477.",
    "- The merge waits on your answer to ask #31.",
    "- The Pro was asleep. No action: the hourly job retries.",
    "- The old path needs no work, it is gone.",
    "- Nothing else.",
  ].join("\n");
  expect(check(reply)).toEqual([]);
  expect(openItemsSection(reply, config)).toMatchObject({ present: true, empty: false });
});

test("inline Open items forms pass with ids, none or no action", () => {
  for (const line of [
    "Open items: none",
    "Open items: none.",
    "**Open items:** none.",
    "**Open items**: none",
    "**Open items: none**",
    "Open items: dotfiles-426",
    "Open items: dotfiles-426, agent-board-477",
    "Open items: ask #31",
    "Open items: no action: all checks passed.",
    "## Open items: none",
    "## Open items (no action: everything merged)",
  ]) {
    const reply = `Done.\n\n${line}`;
    const section = openItemsSection(reply, config);
    expect(section.present, line).toBe(true);
    expect(section.empty, line).toBe(false);
    expect(unfiledItems(section.items, SLUGS), line).toEqual([]);
  }
});

test("words that only look like ids or exemptions do not pass an entry", () => {
  const reply = [
    "Open items:",
    "- the utf-8 path",
    "- sha-256 sums and claude-opus-5-5",
    "- ask 3 reviewers",
    "- Nothing was verified on Linux.",
    "- None of the live suites ran.",
  ].join("\n");
  expect(check(reply)).toHaveLength(5);
  // An empty board slug list must never treat hyphenated tokens like utf-8 as a task id.
  expect(unfiledItems(["the utf-8 path"], [])).toEqual(["the utf-8 path"]);
});

test("heading scan and lead-label paths are dropped (board-feedback-848, 868, 967 / dotfiles-786)", () => {
  // board-feedback-848: fact lists under Follow-ups, Limits, and bold **Limits:** pass.
  const feedback848 = [
    "## Follow-ups",
    "- Merge: you delegated it; I merged PR 12.",
    "",
    "## Limits",
    "- The hook runs only on the Air.",
    "",
    "**Limits:**",
    "- Trade-off of uncached reads.",
    "",
    "Open items: none.",
  ].join("\n");
  expect(openItemsSection(feedback848, config)).toEqual({ present: true, empty: false, items: [] });

  // board-feedback-868: Unknown, not tested list and plain description of child's next step pass.
  const feedback868 = [
    "## Unknown, not tested",
    "- Live deploy on the Pro.",
    "- The child will merge its PR next.",
    "",
    "Open items: none.",
  ].join("\n");
  expect(openItemsSection(feedback868, config)).toEqual({ present: true, empty: false, items: [] });

  // board-feedback-967 / dotfiles-786: bold "did not" lead label and bold "Not run:" label under (no action) pass.
  const feedback967 = [
    "## Root cause (no action)",
    "",
    "5. **The global instructions did not say** that an agent's cut is not your decision.",
    "",
    "**Not run:**",
    "- the live suite on the Pro",
    "",
    "**Not verified:** the live suite on the Pro.",
    "",
    "Open items: none.",
  ].join("\n");
  expect(openItemsSection(feedback967, config)).toEqual({ present: true, empty: false, items: [] });
});

test("closing lines after an Open items list or entry are not read as entries", () => {
  for (const closing of [
    "I settled this thread.",
    "The thread is settled.",
    "This thread is settled.",
    "No repository file changed and no check ran in this turn.",
  ]) {
    // After a bullet list with a blank line
    for (const header of ["## Open items", "**Open items:**", "**Open items**", "Open items:"]) {
      const withBlank = `${header}\n- Recheck after deploy: dotfiles-1.\n\n${closing}`;
      expect(openItems(withBlank, config), `${header} blank ${closing}`).toEqual(["Recheck after deploy: dotfiles-1."]);
      expect(check(withBlank), `${header} blank ${closing}`).toEqual([]);

      // Without a blank line directly after the bullet
      const adjacent = `${header}\n- Recheck after deploy: dotfiles-1.\n${closing}`;
      expect(openItems(adjacent, config), `${header} adj ${closing}`).toEqual(["Recheck after deploy: dotfiles-1."]);
      expect(check(adjacent), `${header} adj ${closing}`).toEqual([]);
    }

    // After an inline Open items: none.
    expect(check(`Done.\n\nOpen items: none.\n${closing}`), `inline adj ${closing}`).toEqual([]);
    expect(check(`Done.\n\nOpen items: none.\n\n${closing}`), `inline blank ${closing}`).toEqual([]);

    // After a plain paragraph directly under ## Open items
    expect(check(`## Open items\n\nNone.\n\n${closing}`), `para exempt ${closing}`).toEqual([]);
    expect(check(`## Open items\n\nThe helper has no tests.\n\n${closing}`), `para unfiled ${closing}`).toEqual(["The helper has no tests."]);
  }

  // Any plain paragraph after a bullet list and blank line closes the Open items section.
  const trailingNote = "Open items:\n- Recheck after deploy: dotfiles-1.\n\nAll local tests passed.";
  expect(openItems(trailingNote, config)).toEqual(["Recheck after deploy: dotfiles-1."]);
  expect(check(trailingNote)).toEqual([]);
});

test("intro lines, nested bullets, wrapped lines and section boundaries work inside Open items", () => {
  const nested = "Open items:\nTwo limits remain:\n- A (dotfiles-1)\n  - detail of A\n- B (dotfiles-2)";
  expect(check(nested)).toEqual([]);

  const inlineIntro = "Open items: two follow-ups:\n- A (dotfiles-1)\n- B (dotfiles-2)";
  expect(check(inlineIntro)).toEqual([]);

  const wrapped = "## Open items\n- The lock steal is reproduced and\n  filed as dotfiles-342.\n- The helper has no tests.";
  expect(check(wrapped)).toEqual(["The helper has no tests."]);

  const inlineWrapped = "Open items: The lock steal is reproduced and\n  filed as dotfiles-342.";
  expect(check(inlineWrapped)).toEqual([]);

  const nextHeading = "Open items:\n- A (dotfiles-1)\n## Changes\n- Edited the hook.";
  expect(check(nextHeading)).toEqual([]);
});

test("code fences, blockquotes, tables, topic headings and bullets do not count as an Open items label", () => {
  const reply = [
    "## Open items hook",
    "- Open items: updated parser",
    "| col | val |",
    "| --- | --- |",
    "> Open items: none",
    "```markdown",
    "Open items: none",
    "```",
  ].join("\n");
  expect(openItemsSection(reply, config)).toEqual({ present: false, empty: false, items: [] });
});

test("an empty Open items label is reported as empty", () => {
  expect(openItemsSection("Done.\n\nOpen items:", config)).toEqual({ present: true, empty: true, items: [] });
  expect(openItemsSection("Done.\n\nOpen items:\n\nI settled this thread.", config)).toEqual({ present: true, empty: true, items: [] });
});

test("turnUsedTools detects tool use in the latest turn for Claude Code and Antigravity transcripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-items-tr-"));
  try {
    const write = (name, text) => {
      const p = join(dir, name);
      writeFileSync(p, text);
      return p;
    };
    expect(turnUsedTools(write("claude-tools.jsonl", CLAUDE_TOOL_TURN))).toBe(true);
    expect(turnUsedTools(write("claude-text.jsonl", CLAUDE_TEXT_ONLY_AFTER_TOOLS))).toBe(false);
    expect(turnUsedTools(write("agy-tools.jsonl", AGY_TOOL_TURN))).toBe(true);
    expect(turnUsedTools(write("agy-text.jsonl", AGY_TEXT_ONLY_AFTER_TOOLS))).toBe(false);

    // Mid-turn system reminders (Claude) and SYSTEM_MESSAGE (Antigravity) do not mask earlier tool calls.
    const claudeInjected = [
      CLAUDE_TOOL_TURN.trimEnd(),
      JSON.stringify({ type: "user", message: { role: "user", content: "<system-reminder>keep going</system-reminder>" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
    ].join("\n") + "\n";
    expect(turnUsedTools(write("claude-injected.jsonl", claudeInjected))).toBe(true);

    const agySystem = [
      AGY_TOOL_TURN.trimEnd(),
      JSON.stringify({ type: "SYSTEM_MESSAGE", source: "SYSTEM", content: "reminder" }),
      JSON.stringify({ type: "PLANNER_RESPONSE", content: "Done." }),
    ].join("\n") + "\n";
    expect(turnUsedTools(write("agy-system.jsonl", agySystem))).toBe(true);

    expect(turnUsedTools(join(dir, "missing.jsonl"))).toBe(false);
    expect(turnUsedTools("")).toBe(false);
    expect(turnUsedTools(undefined)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const STATUS = '{"board":{"slug":"dotfiles"}}';
const BOARDS = '[{"slug":"dotfiles"},{"slug":"agent-board"}]';

function run(input, { status = STATUS, boards = BOARDS, exit = 0, enabled = true, bin, env = {}, policy, transcript } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "open-items-"));
  try {
    const board = bin ?? join(dir, "board");
    writeFileSync(join(dir, "board"),
      `#!/bin/sh\nif [ "$1" = boards ]; then cat <<'JSON'\n${boards}\nJSON\nelse cat <<'JSON'\n${status}\nJSON\nfi\nexit ${exit}\n`);
    chmodSync(join(dir, "board"), 0o755);
    const file = join(dir, "open-items.json");
    writeFileSync(file, JSON.stringify({ ...config, enabled }));
    let transcript_path = input.transcript_path;
    if (transcript !== undefined) {
      transcript_path = join(dir, "transcript.jsonl");
      writeFileSync(transcript_path, transcript);
    }
    const result = Bun.spawnSync([process.execPath, HOOK], {
      stdin: Buffer.from(JSON.stringify({ cwd: dir, ...input, ...(transcript_path ? { transcript_path } : {}) })),
      env: { ...process.env, AGENT_BOARD_HOOKS: "", BOARD_BIN: board, OPEN_ITEMS: policy ?? file, ...env },
    });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the hook blocks once for a tool-using reply without an Open items label", () => {
  const claudeBlock = run({ last_assistant_message: "All tests passed." }, { transcript: CLAUDE_TOOL_TURN });
  expect(claudeBlock.code).toBe(2);
  expect(claudeBlock.stderr).toContain("Open items:");
  expect(claudeBlock.stderr).toContain("Then give the reply again.");

  const agyBlock = run({ last_assistant_message: "All tests passed." }, { transcript: AGY_TOOL_TURN });
  expect(agyBlock.code).toBe(2);
  expect(agyBlock.stderr).toContain("Open items:");

  // Empty Open items label also blocks.
  const emptyBlock = run({ last_assistant_message: "All tests passed.\n\nOpen items:" }, { transcript: CLAUDE_TOOL_TURN });
  expect(emptyBlock.code).toBe(2);
  expect(emptyBlock.stderr).toContain("empty `Open items:` label");
});

test("the hook passes a non-tool-using reply without an Open items label", () => {
  expect(run({ last_assistant_message: "It enables strict mode." }, { transcript: CLAUDE_TEXT_ONLY_AFTER_TOOLS }).code).toBe(0);
  expect(run({ last_assistant_message: "It enables strict mode." }, { transcript: AGY_TEXT_ONLY_AFTER_TOOLS }).code).toBe(0);
});

test("the hook blocks once for an Open items entry with no id and no exemption", () => {
  const { code, stderr } = run({ last_assistant_message: UNFILED_REPLY }, { transcript: CLAUDE_TOOL_TURN });
  expect(code).toBe(2);
  expect(stderr).toContain("The live suite on the Pro was not run.");
  expect(stderr).toContain("ask #<n>");
  expect(stderr).toContain("Then give the reply again.");
});

test("the hook passes a stop that continues from a Stop hook, or with board hooks off", () => {
  expect(run({ last_assistant_message: "All tests passed.", stop_hook_active: true }, { transcript: CLAUDE_TOOL_TURN }).code).toBe(0);
  expect(run({ last_assistant_message: UNFILED_REPLY, stop_hook_active: true }, { transcript: CLAUDE_TOOL_TURN }).code).toBe(0);
  expect(run({ last_assistant_message: "All tests passed." }, { transcript: CLAUDE_TOOL_TURN, env: { AGENT_BOARD_HOOKS: "off" } }).code).toBe(0);
  expect(run({ last_assistant_message: UNFILED_REPLY }, { env: { AGENT_BOARD_HOOKS: "off" } }).code).toBe(0);
});

test("the hook fails open without a board, a binary or a JSON answer, and when off or without a reply", () => {
  for (const opts of [
    { status: '{"boards":[]}' },
    { exit: 1 },
    { status: "not json" },
    { bin: "/nonexistent/board" },
    { enabled: false },
  ]) {
    expect(run({ last_assistant_message: "All tests passed." }, { transcript: CLAUDE_TOOL_TURN, ...opts }).code).toBe(0);
    expect(run({ last_assistant_message: UNFILED_REPLY }, opts).code).toBe(0);
  }
  expect(run({ last_assistant_message: UNFILED_REPLY }, { boards: "not json" })).toEqual({ code: 0, stderr: "" });
  expect(run({}, { transcript: CLAUDE_TOOL_TURN }).code).toBe(0);
});

test("an unreadable config is a hook error, never a block", () => {
  expect(run({ last_assistant_message: UNFILED_REPLY }, { policy: "/nonexistent/open-items.json" }).code).toBe(1);
});

test("the hook passes a tool-using reply whose Open items label is complete", () => {
  expect(run({ last_assistant_message: "Done.\n\nOpen items: none." }, { transcript: CLAUDE_TOOL_TURN }).code).toBe(0);
  expect(run({ last_assistant_message: "Done.\n\nOpen items: no action: all checks passed." }, { transcript: CLAUDE_TOOL_TURN }).code).toBe(0);
  expect(run({ last_assistant_message: "Done.\n\nOpen items:\n- The races are code readings (dotfiles-426).\n\nI settled this thread." }, { transcript: CLAUDE_TOOL_TURN }).code).toBe(0);
});
