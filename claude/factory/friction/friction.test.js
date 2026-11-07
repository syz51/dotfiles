import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rolloutThreads } from "../lib/codex.js";
import { readJson, readJsonl } from "../lib/state.js";
import { Rollout, writeRollouts } from "../lib/testing/codex.js";
import { Transcript, writeProjects } from "../lib/testing/transcripts.js";
import { checkFindings, feedbackText, judgeSchema, LABEL, plist, run } from "./cli.js";
import { claudeTurns, codexTurns, digest, filedFeedback, signals } from "./turns.js";

const FAKE_CLAUDE = join(import.meta.dir, "..", "lib", "testing", "fake-claude.js");
const NOW = Date.parse("2026-11-01T12:00:00Z");
const PROJECT = "/Users/test/project";

let scratch;
const saved = {};
const setEnv = (values) => {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};
const script = (path, text) => {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
};
const log = (name) => (existsSync(join(scratch, name)) ? readJsonl(join(scratch, name)) : []);

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claude-factory-friction-"));
  // A fake `board`: its `feedback --help` lists the capture flags, or not when FAKE_BOARD_OLD
  // is set. Other calls are logged and `feedback --json` answers as agent-board does, or
  // fails when FAKE_BOARD_FAIL is set.
  const board = script(join(scratch, "board"), `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: board feedback [OPTIONS] <TEXT>\\n      --agent <AGENT>\\n" + (process.env.FAKE_BOARD_OLD ? "" : "      --about <ABOUT>\\n      --source <SOURCE>\\n      --signature <SIGNATURE>\\n") + "      --json");
  process.exit(0);
}
appendFileSync(process.env.FAKE_BOARD_LOG, JSON.stringify(args) + "\\n");
if (process.env.FAKE_BOARD_FAIL) { console.error("error: server unreachable"); process.exit(1); }
const count = readFileSync(process.env.FAKE_BOARD_LOG, "utf8").trim().split("\\n").length;
console.log(JSON.stringify({ task: "board-feedback-" + count, duplicate: false, reports: 1 }));
`);
  setEnv({
    CLAUDE_FACTORY_STATE: join(scratch, "state"), CLAUDE_FACTORY_BIN: FAKE_CLAUDE, CLAUDE_FACTORY_BOARD: board,
    FAKE_CLAUDE_LOG: join(scratch, "claude.jsonl"), FAKE_BOARD_LOG: join(scratch, "board.jsonl"), FAKE_CLAUDE_MODE: "structured",
    FAKE_CLAUDE_COST: "0.01", FAKE_BOARD_FAIL: undefined, FAKE_BOARD_OLD: undefined,
    FAKE_CLAUDE_OUTPUT: JSON.stringify({ findings: [{ about: "board", activity: "build", title: "Claims are refused for a task the agent owns", detail: "The agent retried the claim twice.", error: "claim refused: owned by\nanother agent" }] }),
  });
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
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

// A turn with two refused board claims and a workaround, then a quiet one.
const frictionSession = (options = {}) => new Transcript({ cwd: PROJECT, ...options })
  .prompt("Claim the task and start")
  .tool("mcp__board__task_claim", { id: "x-1" }, "claim refused: owned by another agent", { isError: true })
  .tool("mcp__board__task_claim", { id: "x-1" }, "claim refused: owned by another agent", { isError: true })
  .text("I had to work around the board by releasing the task first.")
  .prompt("Thanks")
  .text("Done.");

// Writes the fixture: a session with friction, one whose friction turn already filed
// feedback, an automation session, and a Codex thread with one completed failing turn and
// one still running.
function fixture() {
  const person = frictionSession();
  const reportedFirst = new Transcript({ cwd: PROJECT })
    .prompt("Claim it")
    .tool("mcp__board__task_claim", { id: "x-2" }, "claim refused", { isError: true })
    .tool("mcp__board__task_claim", { id: "x-2" }, "claim refused", { isError: true })
    .tool("Bash", { command: "board feedback --about board 'claims refused'" }, "filed");
  const automation = frictionSession({ cwd: join(tmpdir(), "bench-fixture") });
  const claudeRoot = writeProjects([{ transcript: person }, { transcript: reportedFirst }, { transcript: automation, project: "-tmp-bench" }], join(scratch, "projects"));
  const codex = new Rollout({ cwd: "/Users/test/codex" });
  codex.prompt("Run the board checks")
    .exec("await exec('board ls --board x')", "Script failed: board: connection refused")
    .exec("await exec('board ls --board x')", "Script failed: board: connection refused")
    .complete()
    .prompt("Again")
    .exec("await exec('board ls')", "Script failed: board: connection refused")
    .exec("await exec('board ls')", "Script failed: board: connection refused");
  const codexRoot = writeRollouts([codex], join(scratch, "codex"));
  return { person, reportedFirst, codex, claudeRoot, codexRoot };
}

const context = (roots, now = NOW) => ({ now, claudeRoot: roots.claudeRoot, codexRoot: roots.codexRoot });
const feedbackCalls = () => log("board.jsonl").filter((args) => args[0] === "feedback");

describe("turns", () => {
  test("Claude turns split at prompts, with calls, results, text and hook blocks in order", () => {
    const transcript = frictionSession();
    transcript.records.push(transcript.base({ type: "attachment", attachment: { type: "hook_blocking_error", hookName: "Stop", blockingError: { blockingError: "board: handoff is stale" } } }));
    const root = writeProjects([{ transcript }], join(scratch, "p"));
    const { sessionId, cwd, turns } = claudeTurns(join(root, "-Users-test-project", `${transcript.sessionId}.jsonl`));
    expect([sessionId, cwd, turns.length]).toEqual([transcript.sessionId, PROJECT, 2]);
    expect(turns[0].calls.map((call) => [call.name, call.ok])).toEqual([["mcp__board__task_claim", false], ["mcp__board__task_claim", false]]);
    expect(turns[1].hooks).toEqual([{ event: "Stop", blocking: true, message: "board: handoff is stale" }]);
    expect(signals(turns[0])).toEqual({ toolErrors: 2, boardErrors: 2, hookBlocks: 0, retries: 1, phrases: 2, score: 6 + 2 + 2 + 2 });
    expect(signals(turns[1]).score).toBe(2);
  });

  test("Codex turns run from task_started to task_complete; a running one is not complete; subagents are skipped", () => {
    const { codex } = fixture();
    const thread = rolloutThreads(join(scratch, "codex"))[0];
    const { sessionId, turns } = codexTurns(thread);
    expect(sessionId).toBe(codex.id);
    expect(turns.map((turn) => [turn.index, turn.complete, turn.prompt, turn.calls.length])).toEqual([[1, true, "Run the board checks", 2], [2, false, "Again", 2]]);
    expect(signals(turns[0])).toMatchObject({ toolErrors: 2, boardErrors: 2, retries: 1 });
    const child = new Rollout({ parent: codex, cwd: "/Users/test/codex" });
    child.prompt("sub").complete();
    const childRoot = writeRollouts([child], join(scratch, "codex-child"));
    expect(codexTurns(rolloutThreads(childRoot)[0])).toBeNull();
  });

  test("a turn that called the feedback tool or ran board feedback has filed feedback", () => {
    expect(filedFeedback({ calls: [{ name: "mcp__board__feedback", input: {} }] })).toBe(true);
    expect(filedFeedback({ calls: [{ name: "board.feedback", input: {} }] })).toBe(true);
    expect(filedFeedback({ calls: [{ name: "Bash", input: { command: "~/.cargo/bin/board feedback --about hooks 'x'" } }] })).toBe(true);
    expect(filedFeedback({ calls: [{ name: "Bash", input: { command: "board ls" } }, { name: "mcp__board__task_note", input: { text: "feedback" } }] })).toBe(false);
  });

  test("Chinese friction phrases count", () => {
    expect(signals({ prompt: "这个提示太吵了，不相关", texts: ["只好绕过它"], calls: [], hooks: [] }).phrases).toBe(2);
  });

  test("a long turn's digest keeps the failures and their neighbours and marks what it left out", () => {
    const calls = Array.from({ length: 200 }, (_, index) => ({ name: "Read", input: { file_path: `/repo/file-${index}.js` }, ok: true, output: "" }));
    calls[150] = { name: "Bash", input: { command: "board claim x-1" }, ok: false, output: "claim refused" };
    const turn = { prompt: "Work", texts: [], calls, hooks: [], events: calls.map((call) => ({ call })) };
    const text = digest(turn, { maxChars: 2000 });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain("[Tool 151 Bash FAILED]");
    expect(text).toContain("output: claim refused");
    expect(text).toContain("[Tool 150 Read ok]");
    expect(text).toContain("[... 149 events omitted ...]");
    expect(digest(turn).length).toBeLessThanOrEqual(12_000);
  });
});

describe("friction run", () => {
  test("files each finding once with the capture flags, skipping automation and turns that filed feedback", async () => {
    const roots = fixture();
    expect(await run(["run"], context(roots))).toBe(0);
    const judged = log("claude.jsonl");
    // The person's friction turn and the completed Codex turn; not the quiet turn, the
    // turn that filed feedback, the automation session or the running Codex turn.
    expect(judged).toHaveLength(2);
    for (const call of judged) {
      expect(call.args).toEqual(expect.arrayContaining(["--model", "claude-haiku-5-5", "--max-budget-usd", "0.05", "--tools", "", "--no-session-persistence"]));
      expect(call.system).toContain("`storage`: Shared storage");
      expect(call.system).not.toContain(roots.person.sessionId);
    }
    expect(judged.map((call) => call.stdin.includes("Claim the task and start") || call.stdin.includes("Run the board checks"))).toEqual([true, true]);
    expect(judged.some((call) => call.stdin.includes("Claim it"))).toBe(false);
    const filed = feedbackCalls();
    expect(filed).toHaveLength(2);
    const signatures = filed.map((args) => args[args.indexOf("--signature") + 1]).sort();
    expect(signatures).toEqual([`capture:${roots.codex.id}:1:1`, `capture:${roots.person.sessionId}:1:1`].sort());
    const claude = filed.find((args) => args.includes(`capture:${roots.person.sessionId}:1:1`));
    expect(claude.slice(0, 8)).toEqual(["feedback", "--source", "capture", "--about", "board", "--activity", "build", "--signature"]);
    expect(claude.slice(9, 11)).toEqual(["--json", "--"]);
    expect(claude[11]).toBe(`Claims are refused for a task the agent owns\n\nThe agent retried the claim twice.\n\nError: claim refused: owned by another agent\n\nCaptured from Claude Code session ${roots.person.sessionId}, turn 1.`);

    // A second run files nothing again and judges nothing again.
    expect(await run(["run"], context(roots, NOW + 60_000))).toBe(0);
    expect([log("claude.jsonl").length, feedbackCalls().length]).toEqual([2, 2]);
    // Nor does a run whose window covers the turns again.
    rmSync(join(scratch, "state", "friction-state.json"));
    expect(await run(["run"], context(roots, NOW + 120_000))).toBe(0);
    expect([log("claude.jsonl").length, feedbackCalls().length]).toEqual([2, 2]);
    expect(readJsonl(join(scratch, "state", "friction.jsonl")).filter((record) => record.kind === "filed")).toHaveLength(2);
  });

  test("a failed filing is retried next run without judging the turn again", async () => {
    const roots = fixture();
    setEnv({ FAKE_BOARD_FAIL: "1" });
    expect(await run(["run"], context(roots))).toBe(1);
    expect([log("claude.jsonl").length, feedbackCalls().length]).toEqual([2, 2]);
    setEnv({ FAKE_BOARD_FAIL: undefined });
    expect(await run(["run"], context(roots, NOW + 60_000))).toBe(0);
    expect([log("claude.jsonl").length, feedbackCalls().length]).toEqual([2, 4]);
    expect(await run(["run"], context(roots, NOW + 120_000))).toBe(0);
    expect(feedbackCalls()).toHaveLength(4);
  });

  test("the run budget stops judging, and the next run picks up the turns left over", async () => {
    const roots = fixture();
    setEnv({ FAKE_CLAUDE_COST: "0.04" });
    expect(await run(["run", "--max-total-usd", "0.06"], context(roots))).toBe(0);
    expect(log("claude.jsonl")).toHaveLength(1);
    const state = readJson(join(scratch, "state", "friction-state.json"));
    expect(Date.parse(state.cursor)).toBeLessThan(NOW - 15 * 60_000);
    expect(state.lastRun).toMatchObject({ judged: 1, filed: 1, errors: 0, costUSD: 0.04 });
    expect(await run(["run", "--max-total-usd", "0.06"], context(roots, NOW + 60_000))).toBe(0);
    expect([log("claude.jsonl").length, feedbackCalls().length]).toEqual([2, 2]);
  });

  test("turns still within the quiet period wait; a turn with no setup friction files nothing", async () => {
    const roots = fixture();
    // At this time the turns ended under 15 minutes ago.
    expect(await run(["run"], context(roots, Date.parse("2026-11-01T10:05:00Z")))).toBe(0);
    expect(log("claude.jsonl")).toHaveLength(0);
    setEnv({ FAKE_CLAUDE_OUTPUT: JSON.stringify({ findings: [] }) });
    expect(await run(["run"], context(roots))).toBe(0);
    expect([log("claude.jsonl").length, feedbackCalls().length]).toEqual([2, 0]);
    expect(console.log.mock.calls.flat().join("\n")).toContain("The judge found no setup friction");
  });

  test("an invalid judge answer is an error for that turn; a turn failing twice is left alone", async () => {
    const roots = fixture();
    setEnv({ FAKE_CLAUDE_OUTPUT: JSON.stringify({ findings: [{ about: "nope", activity: "build", title: "t", detail: "", error: "" }] }) });
    expect(await run(["run"], context(roots))).toBe(1);
    expect(await run(["run"], context(roots, NOW + 60_000))).toBe(1);
    expect(await run(["run"], context(roots, NOW + 120_000))).toBe(0);
    expect(log("claude.jsonl")).toHaveLength(4);
    expect(feedbackCalls()).toHaveLength(0);
  });

  test("with a board CLI that cannot file capture reports, nothing is judged until it can", async () => {
    const roots = fixture();
    setEnv({ FAKE_BOARD_OLD: "1" });
    expect(await run(["run"], context(roots))).toBe(0);
    expect([log("claude.jsonl").length, feedbackCalls().length]).toEqual([0, 0]);
    expect(console.log.mock.calls.flat().join("\n")).toContain("cannot file capture reports yet");
    const state = readJson(join(scratch, "state", "friction-state.json"));
    expect([state.cursor, state.lastRun.judged]).toEqual([undefined, 0]);
    expect(await run(["status"])).toBe(0);
    expect(console.log.mock.calls.flat().join("\n")).toContain("nothing judged");
    setEnv({ FAKE_BOARD_OLD: undefined });
    expect(await run(["run"], context(roots, NOW + 60_000))).toBe(0);
    expect([log("claude.jsonl").length, feedbackCalls().length]).toEqual([2, 2]);
  });

  test("--dry-run calls and writes nothing", async () => {
    const roots = fixture();
    expect(await run(["run", "--dry-run"], context(roots))).toBe(0);
    expect([log("claude.jsonl").length, feedbackCalls().length, existsSync(join(scratch, "state", "friction-state.json"))]).toEqual([0, 0, false]);
    expect(console.log.mock.calls.flat().join("\n")).toContain(`claude ${roots.person.sessionId} turn 1: score 12`);
  });
});

describe("judge answer", () => {
  test("findings are checked against the setups and cut to their limits", () => {
    const ids = new Set(["board", "other"]);
    const [finding] = checkFindings({ findings: [{ about: "board", activity: "operate", title: `${"t".repeat(100)}\nsecond`, detail: "d".repeat(500), error: "line one\nline two" }] }, ids);
    expect(finding.title).toHaveLength(72);
    expect(finding.detail).toHaveLength(400);
    expect(finding.error).toBe("line one line two");
    expect(() => checkFindings({ findings: [{ about: "board", activity: "napping", title: "t" }] }, ids)).toThrow("unknown activity");
    expect(() => checkFindings({}, ids)).toThrow("no findings list");
    expect(feedbackText({ title: "T", detail: "", error: "" }, { harness: "codex", sessionId: "s", turn: 3 })).toBe("T\n\nCaptured from Codex session s, turn 3.");
    expect(judgeSchema([{ id: "board" }]).properties.findings.items.properties.about.enum).toEqual(["board"]);
  });
});

describe("LaunchAgent", () => {
  test("the plist runs friction run every hour", () => {
    const text = plist({ bun: "/b/bun", cli: "/c/cli.js", path: "/x:/y", home: "/h", logs: "/logs" });
    expect(text).toContain(`<string>${LABEL}</string>`);
    for (const value of ["/b/bun", "/c/cli.js", "friction", "run", "/x:/y", "/logs/friction-launchd.log"]) expect(text).toContain(`<string>${value}</string>`);
    expect(text).toMatch(/<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
  });

  test("install loads it, status reports it, uninstall removes it", async () => {
    const agents = join(scratch, "agents");
    const launchctl = script(join(scratch, "launchctl"), `#!/bin/sh\necho "$@" >> "${join(scratch, "launchctl.log")}"\n[ "$1" = bootout ] && exit 3\nexit 0\n`);
    const tools = join(scratch, "tools");
    mkdirSync(tools);
    script(join(tools, "claude"), "#!/bin/sh\n");
    setEnv({ CLAUDE_FACTORY_LAUNCH_AGENTS: agents, CLAUDE_FACTORY_LAUNCHCTL: launchctl, PATH: `${tools}:/usr/bin:/bin` });
    expect(await run(["install"])).toBe(0);
    const file = join(agents, `${LABEL}.plist`);
    expect(readFileSync(file, "utf8")).toContain(`<string>${tools}:`);
    expect(await run(["status"])).toBe(0);
    expect(console.log.mock.calls.flat().join("\n")).toContain(`LaunchAgent: ${file}; loaded`);
    expect(readFileSync(join(scratch, "launchctl.log"), "utf8")).toMatch(new RegExp(`bootout gui/\\d+/${LABEL}\\nbootstrap gui/\\d+ .*\\nprint gui/\\d+/${LABEL}`));
    expect(await run(["uninstall"])).toBe(0);
    expect(existsSync(file)).toBe(false);
    setEnv({ PATH: "/usr/bin:/bin" });
    await expect(run(["install"])).rejects.toThrow("claude is not on PATH");
  });

  test("usage errors exit 2", async () => {
    expect(await run([])).toBe(2);
    expect(await run(["nope"])).toBe(2);
    expect(await run(["run", "--max-turns", "-1"])).toBe(2);
    expect(await run(["run", "--bogus"])).toBe(2);
  });
});
