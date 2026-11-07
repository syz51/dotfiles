import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTasks, report, run, summaryLines } from "./cli.js";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const ago = (hours) => new Date(NOW - hours * 3_600_000).toISOString();
const SETUPS = [{ id: "board", title: "Work board" }, { id: "hooks", title: "Hooks" }, { id: "factory", title: "Factory" }];

// A feedback item: a task on the feedback board with its record.
const item = (id, { about = "board", source = "agent", reports = 1, created = 24, reported = created, status, resolution, recurs } = {}) => ({
  id, title: `item ${id}`, status: status ?? (resolution ? "done" : "open"), created_at: ago(created),
  feedback: { about, source, signature: `sig-${id}`, reports, reporters: ["claude:a"], last_reported_at: ago(reported), ...(resolution && { resolution }), ...(recurs && { recurs }) },
});
const resolved = (kind, hours, task) => ({ kind, at: ago(hours), by: "t3:triage", ...(task && { task }), ...(kind === "declined" && { reason: "by design" }) });

const TASKS = [
  item("f1", { reports: 3, created: 2 }),
  item("f2", { source: "capture", created: 0.2 }),
  item("f3", { created: 96, resolution: resolved("routed", 96, "agent-board-12") }),
  item("f4", { about: "factory", created: 72, resolution: resolved("routed", 72, "dotfiles-9") }),
  item("f5", { about: "factory", source: "signal", created: 24, recurs: "f0" }),
  item("f6", { about: "hooks", reports: 4, created: 120, reported: 24, resolution: resolved("declined", 72) }),
  item("f7", { about: "hooks", created: 100, reported: 100, resolution: resolved("declined", 72) }),
  item("f8", { about: "nope:thing", created: 24 }),
  item("f9", { created: 960, resolution: resolved("routed", 959, "dotfiles-2") }),
  item("f10", { created: 24, resolution: resolved("duplicate", 23, "f1") }),
  { id: "board-feedback-1", title: "From before records", status: "open", created_at: ago(500) },
];
const OWNERS = { "agent-board-12": { status: "doing", updated_at: ago(5) }, "dotfiles-9": { status: "done", updated_at: ago(24) }, "dotfiles-2": { status: "done", updated_at: ago(720) } };

describe("report", () => {
  const owners = new Map(Object.entries(OWNERS).map(([id, task]) => [id, { status: task.status, updatedAt: task.updated_at }]));
  const result = report(TASKS, owners, { days: 7, now: NOW, setups: SETUPS });
  const of = (id) => result.setups.find((setup) => setup.id === id);

  test("counts per setup what came in, what waits and what got fixed", () => {
    // Registry order, then setups it does not name.
    expect(result.setups.map((setup) => setup.id)).toEqual(["board", "hooks", "factory", "nope:thing"]);
    // f1, f2, f3 and f10 are active this week; f9 is old and its owner finished long ago.
    expect(of("board")).toMatchObject({ title: "Work board", items: 4, reports: 6, sources: { agent: 3, capture: 1, signal: 0 }, fixed: 0, recurrences: 0, declinedWithReports: [] });
    // f2 is minutes old, so triage has not missed it yet.
    expect(of("board").untriaged).toEqual([{ id: "f1", ageHours: 2 }]);
    expect(of("board").routedOpen).toEqual([{ id: "f3", task: "agent-board-12", status: "doing", ageDays: 4 }]);
    expect(of("factory")).toMatchObject({ items: 2, fixed: 1, recurrences: 1, sources: { agent: 1, capture: 0, signal: 1 } });
    // f6 was reported again after it was declined; f7 was not.
    expect(of("hooks").declinedWithReports).toEqual([{ id: "f6", reports: 4 }]);
    expect(of("nope:thing").title).toBeNull();
    expect(of("factory").untriaged).toEqual([{ id: "f5", ageHours: 24 }]);
    expect(result.totals).toEqual({ items: 9, reports: 14, untriaged: 3, routedOpen: 1, fixed: 1, recurrences: 1, declinedWithReports: 1 });
    expect(result.legacy).toBe(1);
  });

  test("untriaged and routed-open items count at any age; a shorter window drops old activity", () => {
    const day = report(TASKS, owners, { days: 1, now: NOW, setups: SETUPS });
    const board = day.setups.find((setup) => setup.id === "board");
    expect(board.items).toBe(3);
    expect(board.routedOpen).toHaveLength(1);
    // f4's owner finished exactly a day ago, still inside the window.
    expect(day.setups.find((setup) => setup.id === "factory").fixed).toBe(1);
  });

  test("summary lines name each setup with its title and the ids that wait", () => {
    const lines = summaryLines({ ...result, errors: ["board show dotfiles-1 exited 1: no such task"] });
    expect(lines[0]).toBe("Feedback in the last 7 days: 9 items, 14 reports; untriaged 3; routed and open 1; fixed 1; recurrences 1; declined but reported again 1");
    expect(lines).toContain("- board (Work board): 4 items, 6 reports (agent 3, capture 1, signal 0); untriaged 1: f1 2 h; routed and open 1: agent-board-12 doing 4 d");
    expect(lines).toContain("- hooks (Hooks): 2 items, 5 reports (agent 2, capture 0, signal 0); declined but reported again 1: f6");
    expect(lines).toContain("- factory (Factory): 2 items, 2 reports (agent 1, capture 0, signal 1); untriaged 1: f5 24 h; fixed 1; recurrences 1");
    expect(lines).toContain("- nope:thing (not in setups.toml): 1 items, 1 reports (agent 1, capture 0, signal 0); untriaged 1: f8 24 h");
    expect(lines).toContain("Tasks without a feedback record (filed before the server kept them): 1");
    expect(lines.at(-1)).toBe("Failed: board show dotfiles-1 exited 1: no such task");
  });

  test("checkTasks accepts tasks with and without a record and refuses unreadable ones", () => {
    expect(checkTasks(TASKS)).toBe(TASKS);
    expect(() => checkTasks({})).toThrow("expected a list of tasks");
    expect(() => checkTasks([{ id: "x", status: "open" }])).toThrow("id, title and status");
    expect(() => checkTasks([{ ...TASKS[0], feedback: { ...TASKS[0].feedback, reports: "3" } }])).toThrow("f1 has an unreadable feedback record");
    expect(() => checkTasks([{ ...TASKS[0], feedback: { ...TASKS[0].feedback, resolution: { kind: "routed" } } }])).toThrow("unreadable feedback record");
  });
});

describe("evolve command", () => {
  let scratch;
  let output;
  const saved = {};
  const setEnv = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (!(name in saved)) saved[name] = process.env[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const calls = () => (existsSync(join(scratch, "board.jsonl")) ? readFileSync(join(scratch, "board.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "claude-factory-evolve-test-"));
    // A fake `board`: ls prints FAKE_BOARD_LS; show prints the owner from FAKE_BOARD_OWNERS
    // and fails for an id it lacks.
    const board = join(scratch, "board");
    writeFileSync(board, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_BOARD_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "ls") console.log(process.env.FAKE_BOARD_LS);
else if (args[0] === "show") {
  const task = JSON.parse(process.env.FAKE_BOARD_OWNERS)[args[1]];
  if (!task) { console.error("error: no such task " + args[1]); process.exit(1); }
  console.log(JSON.stringify({ task: { id: args[1], ...task }, notes: [], evidence: [], blocks: [], children: [], history: [] }));
} else process.exit(2);
`);
    chmodSync(board, 0o755);
    setEnv({ CLAUDE_FACTORY_BOARD: board, FAKE_BOARD_LOG: join(scratch, "board.jsonl"), FAKE_BOARD_LS: JSON.stringify(TASKS), FAKE_BOARD_OWNERS: JSON.stringify(OWNERS) });
    output = [];
    spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
    spyOn(console, "error").mockImplementation((line) => output.push(String(line)));
  });
  afterEach(() => {
    console.log.mockRestore();
    console.error.mockRestore();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      delete saved[name];
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  test("reads the feedback board and each routed owner once, and prints the report", async () => {
    expect(await run(["--days", "7"])).toBe(0);
    const [list, ...shows] = calls();
    expect(list).toEqual(["ls", "--board", "board-feedback", "--json", "--limit", "1000"]);
    // Duplicates and declined items have no owner to look up.
    expect(shows.map((args) => args[1]).sort()).toEqual(["agent-board-12", "dotfiles-2", "dotfiles-9"]);
    expect(shows.every((args) => args[0] === "show" && args[2] === "--json")).toBe(true);
    const text = output.join("\n");
    expect(text).toMatch(/^Feedback in the last 7 days: \d+ items/);
    // Titles come from the repository's setups.toml.
    expect(text).toContain("- board (Work board (agent-board)): ");
    expect(text).toContain("routed and open 1: agent-board-12 doing");
    expect(text).toContain("- factory (Factory: ");
  });

  test("--json prints the report; a failed owner lookup is reported, exits 1 and costs only that owner", async () => {
    setEnv({ FAKE_BOARD_OWNERS: JSON.stringify({ "agent-board-12": OWNERS["agent-board-12"] }) });
    expect(await run(["--json"])).toBe(1);
    const result = JSON.parse(output[0]);
    expect(result.days).toBe(7);
    // Lookups run together, so errors arrive in any order.
    expect([...result.errors].sort()).toEqual([expect.stringContaining("board show dotfiles-2 --json exited 1: error: no such task dotfiles-2"), expect.stringContaining("board show dotfiles-9")]);
    expect(result.totals.routedOpen).toBe(1);
    expect(result.totals.fixed).toBe(0);
  });

  test("an unreadable list fails the report; bad options exit 2", async () => {
    setEnv({ FAKE_BOARD_LS: "not json" });
    expect(await run([])).toBe(1);
    expect(output.join("\n")).toContain("Failed: board ls --board board-feedback --json --limit 1000: unreadable output");
    output.length = 0;
    setEnv({ FAKE_BOARD_LS: JSON.stringify([{ ...TASKS[0], feedback: { about: "board" } }]) });
    expect(await run(["--json"])).toBe(1);
    expect(JSON.parse(output[0])).toMatchObject({ totals: null, setups: null, errors: ["board ls: f1 has an unreadable feedback record"] });
    expect(await run(["--days", "0"])).toBe(2);
    expect(await run(["--bogus"])).toBe(2);
    output.length = 0;
    expect(await run(["--help"])).toBe(0);
    expect(output[0]).toContain("Usage: bun ~/.claude/factory/cli.js evolve");
  });

  test("a full page is reported, since items may be missing from it", async () => {
    setEnv({ FAKE_BOARD_LS: JSON.stringify(Array.from({ length: 1000 }, (_, i) => item(`g${i}`, { status: "done" }))) });
    expect(await run(["--json"])).toBe(1);
    expect(JSON.parse(output[0]).errors).toEqual([expect.stringContaining("1000 tasks on board-feedback, the most one call returns")]);
  });
});
