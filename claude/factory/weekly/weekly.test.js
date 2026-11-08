import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { billingSummary, failed, internal, LABEL, needsAttention, plist, run, runWeekly, stepEnv, steps } from "./cli.js";

let scratch;
const saved = {};
const setEnv = (values) => {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in saved)) saved[name] = process.env[name];
    process.env[name] = value;
  }
};

// A fake factory CLI: logs its argv, prints canned output per command, and exits with
// FAKE_EXIT_<command> when set.
function fakeCli() {
  const path = join(scratch, "fake-cli.js");
  writeFileSync(path, `
const fs = require("fs");
const [command] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (command === "metrics") console.log(JSON.stringify({ current: { sessions: 4, origin: { agent: { sessions: 1 } }, cost: { totalUSD: 12.5 },
  prs: { merged: 2, costPerMergedUSD: 3, spendPerMergedUSD: 6.25 }, corrections: { rate: 0.1 }, toolErrors: { main: { rate: 0.02 } }, apiErrors: { 429: 3 } } }));
if (command === "audit") console.log(JSON.stringify({ findings: [
  { id: "a", severity: "high", title: "Unsandboxed review", accepted: false },
  { id: "b", severity: "low", title: "Low thing", accepted: true },
  { id: "c", severity: "info", title: "Info", accepted: false } ] }));
if (command === "score") console.log("scored 2 sessions, $0.30");
if (command === "board") console.log(JSON.stringify({ collectedAt: "2026-11-09T13:30:00.000Z", days: 7, errors: process.env.FAKE_EXIT_board ? ["board stats exited 2: unrecognized subcommand"] : [],
  stats: { days: 7, tasks_created: 9, tasks_done: 5, claims_refused: 1, tasks_taken_stale: 0, lease_conflicts: 2, asks_created: 3, asks_answered: 2, ask_answer_minutes_median: 41.5, doing_minutes_median: null, done_without_check_evidence: 1 },
  feedback: [{ id: "board-feedback-4", title: "Leases expire mid-review", body: "x", status: "open" }] }));
if (command === "evolve") console.log(JSON.stringify({ collectedAt: "2026-11-09T13:30:00.000Z", days: 7, legacy: 2, errors: [],
  totals: { items: 3, reports: 5, untriaged: 1, routedOpen: 1, fixed: 1, recurrences: 1, declinedWithReports: 0 },
  setups: [{ id: "board", title: "Work board (agent-board)", items: 3, reports: 5, sources: { agent: 2, capture: 1, signal: 0 },
    untriaged: [{ id: "board-feedback-9", ageHours: 3 }], routedOpen: [{ id: "board-feedback-7", task: "agent-board-12", status: "doing", ageDays: 4 }],
    fixed: 1, recurrences: 1, declinedWithReports: [] }] }));
if (command === "review") console.log(JSON.stringify({ days: 7, costUSD: 3.5, repos: [
  { board: "dotfiles", repo: "github.com/o/dotfiles", base: "a".repeat(40), head: "b".repeat(40), commits: 12, recipe: "high effort → 8 inline angles", reviewCostUSD: 2.5, verifyCostUSD: 1, error: null,
    confirmed: [{ title: "Fix the lock race", location: "lib/lock.js:9", task: "dotfiles-9" }], rejected: [{ summary: "Unused import", location: "a.js:1", reason: "Used on line 40." }] },
  { board: "agent-board", repo: "github.com/o/agent-board", base: "c".repeat(40), head: "c".repeat(40), commits: 0, recipe: null, reviewCostUSD: 0, verifyCostUSD: 0, error: null, confirmed: [], rejected: [] } ] }));
if (command === "propose") console.log("Nothing qualifies.");
process.exit(Number(process.env["FAKE_EXIT_" + command] ?? 0));
`);
  return path;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claude-factory-weekly-"));
  setEnv({ CLAUDE_FACTORY_STATE: join(scratch, "state"), CLAUDE_FACTORY_WEEKLY_CLI: fakeCli(), FAKE_LOG: join(scratch, "log.jsonl"), API_FIRST_STATE: join(scratch, "api-state") });
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  rmSync(scratch, { recursive: true, force: true });
});

const calls = () => readFileSync(join(scratch, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

describe("steps", () => {
  test("proposals are limited to detector dimensions; --no-pr makes them a dry run", () => {
    const propose = steps().find(([name]) => name === "propose")[1];
    expect(propose.filter((arg, i) => propose[i - 1] === "--dimension").sort()).toEqual(["ai-attribution", "force-push", "package-runner", "review-skipped", "shell-file-edit", "ultra-effort"]);
    expect(propose).not.toContain("--dry-run");
    expect(steps({ pr: false }).find(([name]) => name === "propose")[1]).toContain("--dry-run");
    // The board step writes the snapshot that the proposals read.
    const all = steps({ boardSnapshot: "/s/board.json" });
    expect(all.map(([name]) => name)).toEqual(["metrics", "audit", "score", "board", "evolve", "review", "propose"]);
    expect(all[3][1]).toEqual(["board", "--days", "7", "--json", "--out", "/s/board.json"]);
    expect(all[4][1]).toEqual(["evolve", "--days", "7", "--json"]);
    // The review of main files its confirmed findings, except in a dry run.
    expect(all[5][1]).toEqual(["review", "--json"]);
    expect(steps({ pr: false })[5][1]).toEqual(["review", "--json", "--dry-run"]);
    expect(all[6][1].slice(-2)).toEqual(["--board-snapshot", "/s/board.json"]);
    expect(steps({ scoreUsd: "1", sample: "2" }).find(([name]) => name === "score")[1]).toEqual(["score", "--sample", "2", "--max-total-usd", "1"]);
  });

  test("audit exit 1 needs attention rather than failing; other nonzero exits and crashes fail", () => {
    expect(failed({ name: "audit", code: 1 })).toBe(false);
    expect(needsAttention({ name: "audit", code: 1 })).toBe(true);
    expect(needsAttention({ name: "audit", code: 0 })).toBe(false);
    expect(needsAttention({ name: "audit", code: 1, error: "unreadable output" })).toBe(false);
    expect(failed({ name: "audit", code: 2 })).toBe(true);
    expect(failed({ name: "score", code: 1 })).toBe(true);
    expect(failed({ name: "metrics", code: 0, error: "unreadable output" })).toBe(true);
    expect(failed({ name: "metrics", code: null })).toBe(true);
  });
});

describe("runWeekly", () => {
  test("runs every step in order and writes a summary with the highlights", async () => {
    expect(await runWeekly({ pr: false })).toBe(0);
    expect(calls().map(([command]) => command)).toEqual(["metrics", "audit", "score", "board", "evolve", "review", "propose"]);
    expect(calls()[5]).toEqual(["review", "--json", "--dry-run"]);
    expect(calls()[6]).toContain("--dry-run");
    const last = JSON.parse(readFileSync(join(scratch, "state", "weekly-last.json"), "utf8"));
    const summary = readFileSync(last.summary, "utf8");
    expect(summary).toContain("Sessions: 4 (1 launched by an agent); cost $12.50");
    expect(summary).toContain("Merged PRs: 2; cost per merged PR $3.00 (its sessions), $6.25 (all spend)");
    expect(summary).toContain("429s 3");
    expect(summary).toContain("Unaccepted findings: 1 high, 0 medium, 0 low");
    expect(summary).toContain("- Unsandboxed review");
    expect(summary).toContain("## audit: ok (exit 0");
    expect(summary).toContain("scored 2 sessions");
    expect(summary).toContain("## board: ok (exit 0");
    expect(summary).toContain("- Tasks: 9 created, 5 done (1 without check evidence); median n/a in doing");
    expect(summary).toContain("- Claims refused 1; tasks taken from stale owners 0; lease conflicts 2");
    expect(summary).toContain("- Asks: 2 of 3 answered; median answer 42 min");
    // Agent-written titles appear quoted.
    expect(summary).toContain('- Open feedback tasks: 1\n- board-feedback-4: "Leases expire mid-review"');
    // The feedback loop per setup, after the board review.
    expect(summary).toContain("## evolve: ok (exit 0");
    expect(summary).toContain("- Feedback in the last 7 days: 3 items, 5 reports; untriaged 1; routed and open 1; fixed 1; recurrences 1; declined but reported again 0\n"
      + "- board (Work board (agent-board)): 3 items, 5 reports (agent 2, capture 1, signal 0); untriaged 1: board-feedback-9 3 h; routed and open 1: agent-board-12 doing 4 d; fixed 1; recurrences 1\n"
      + "- Tasks without a feedback record (filed before the server kept them): 2");
    expect(summary.indexOf("## board:")).toBeLessThan(summary.indexOf("## evolve:"));
    // The review of main: per repository its range, cost, filed proposals and rejected findings with reasons.
    expect(summary).toContain("## review: ok (exit 0");
    expect(summary).toContain("- github.com/o/dotfiles (aaaaaaaa..bbbbbbbb, 12 commits, $3.50, high effort): 1 confirmed, 1 rejected\n"
      + "- Filed dotfiles-9: Fix the lock race (lib/lock.js:9)\n"
      + "- Rejected: Unused import (a.js:1). Used on line 40.\n"
      + "- github.com/o/agent-board: no commits on main in 7 days\n"
      + "- Total cost $3.50");
    expect(existsSync(join(scratch, "state", "weekly.lock"))).toBe(false);
  });

  test("the summary reports the week's billing, or why it could not", async () => {
    const decisions = join(scratch, "api-state", "decisions.jsonl");
    mkdirSync(join(scratch, "api-state"), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(decisions, [
      { at: now, mode: "api", reason: "ok" },
      { at: now, mode: "refused", reason: "exhausted: a Claude Code run was refused (billing_error): low" },
      { at: now, mode: "subscription", reason: "exhausted: HTTP 400: credit" },
      { at: now, mode: "passthrough", reason: "caller set ANTHROPIC_API_KEY" },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await runWeekly({ pr: false });
    let summary = readFileSync(JSON.parse(readFileSync(join(scratch, "state", "weekly-last.json"), "utf8")).summary, "utf8");
    expect(summary).toContain("## Billing (last 7 days)");
    expect(summary).toContain("1 started on the API, 1 on the subscription");
    expect(summary).toContain(`- Refusals of API runs recorded: 1; the latest ${now}: exhausted: a Claude Code run was refused (billing_error): low.`);
    expect(summary).toContain("exhausted: HTTP 400: credit. Top up API credit that Claude Code can spend to move back.");
    // Credit would not help a refusal for another reason.
    writeFileSync(decisions, `${JSON.stringify({ at: now, mode: "subscription", reason: "refused: HTTP 400: This organization has been disabled." })}\n`);
    await runWeekly({ pr: false });
    summary = readFileSync(JSON.parse(readFileSync(join(scratch, "state", "weekly-last.json"), "utf8")).summary, "utf8");
    expect(summary).toContain("refused: HTTP 400: This organization has been disabled.\n");
    expect(summary).not.toContain("Top up");
    // A refused key needs replacing; an entry without a reason still renders.
    writeFileSync(decisions, [
      { at: now, mode: "refused" },
      { at: now, mode: "subscription", reason: "invalid: HTTP 401: invalid x-api-key." },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await runWeekly({ pr: false });
    summary = readFileSync(JSON.parse(readFileSync(join(scratch, "state", "weekly-last.json"), "utf8")).summary, "utf8");
    expect(summary).toContain(`the latest ${now}: no reason.`);
    expect(summary).toContain("invalid: HTTP 401: invalid x-api-key. Replace the API key to move back.");
    writeFileSync(decisions, `${JSON.stringify({ at: now, mode: "subscription" })}\n`);
    await runWeekly({ pr: false });
    summary = readFileSync(JSON.parse(readFileSync(join(scratch, "state", "weekly-last.json"), "utf8")).summary, "utf8");
    expect(summary).toContain(`- Latest fallback ${now}: no reason.\n`);
    writeFileSync(decisions, '{"at":"x","mode":"api"}\n{damaged\n');
    expect(await runWeekly({ pr: false })).toBe(0);
    summary = readFileSync(JSON.parse(readFileSync(join(scratch, "state", "weekly-last.json"), "utf8")).summary, "utf8");
    expect(summary).toMatch(/- Unavailable: .*decisions\.jsonl:2: malformed/);
  });

  test("unaccepted audit findings mark the run as needing attention", async () => {
    setEnv({ FAKE_EXIT_audit: "1" });
    expect(await runWeekly({ pr: false })).toBe(1);
    const last = JSON.parse(readFileSync(join(scratch, "state", "weekly-last.json"), "utf8"));
    expect(readFileSync(last.summary, "utf8")).toContain("## audit: ATTENTION (exit 1");
  });

  test("a failing step is reported, the rest still run, and the run exits 1", async () => {
    setEnv({ FAKE_EXIT_score: "4" });
    expect(await runWeekly({ pr: false })).toBe(1);
    expect(calls().map(([command]) => command)).toEqual(["metrics", "audit", "score", "board", "evolve", "review", "propose"]);
    const last = JSON.parse(readFileSync(join(scratch, "state", "weekly-last.json"), "utf8"));
    expect(readFileSync(last.summary, "utf8")).toContain("## score: FAILED (exit 4");
  });

  test("a failing board command fails the board step in the report, and the proposals still run", async () => {
    setEnv({ FAKE_EXIT_board: "1" });
    expect(await runWeekly({ pr: false })).toBe(1);
    expect(calls().map(([command]) => command)).toEqual(["metrics", "audit", "score", "board", "evolve", "review", "propose"]);
    const last = JSON.parse(readFileSync(join(scratch, "state", "weekly-last.json"), "utf8"));
    const summary = readFileSync(last.summary, "utf8");
    expect(summary).toContain("## board: FAILED (exit 1");
    expect(summary).toContain("- Failed: board stats exited 2: unrecognized subcommand");
    expect(last.steps.find((step) => step.name === "board").highlights).toContain("Open feedback tasks: 1");
  });

  test("steps keep the factory's settings and CLAUDE_CONFIG_DIR, not a parent session's variables, and stay off the work board", () => {
    const env = stepEnv({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_FACTORY_GH: "/gh", CLAUDE_FACTORY_BIN: "/claude", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" });
    expect(env).toEqual({ PATH: "/bin", AGENT_BOARD_HOOKS: "off", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_FACTORY_GH: "/gh", CLAUDE_FACTORY_BIN: "/claude" });
  });

  test("the lock is taken atomically: a second taker fails while the first holds it", () => {
    const lock = join(scratch, "state", "race.lock");
    expect(internal.acquireLock(lock)).toBe(true);
    expect(internal.acquireLock(lock)).toBe(false);
    // A lock held by a process we may not signal (pid 1) counts as held.
    writeFileSync(lock, "1");
    expect(internal.acquireLock(lock)).toBe(false);
  });

  test("a live lock blocks a second run; a stale one is taken over", async () => {
    const lock = join(scratch, "state", "weekly.lock");
    expect(internal.acquireLock(lock)).toBe(true);
    expect(await runWeekly({ pr: false })).toBe(3);
    writeFileSync(lock, "999999999");
    expect(await runWeekly({ pr: false })).toBe(0);
  });
});

describe("billing", () => {
  test("counts the week's API and subscription calls and refused runs, and names the latest of each", () => {
    const path = join(scratch, "decisions.jsonl");
    expect(billingSummary(path, 0)).toBeNull();
    const at = (day) => `2026-11-0${day}T10:00:00.000Z`;
    writeFileSync(path, [
      { at: at(1), mode: "subscription", reason: "too old" },
      { at: at(3), mode: "api", reason: "ok" },
      { at: at(4), mode: "subscription", reason: "exhausted: HTTP 400" },
      { at: at(5), mode: "api", reason: "ok" },
      { at: at(6), mode: "refused", reason: "exhausted: a run was refused" },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const summary = billingSummary(path, Date.parse(at(2)));
    expect([summary.api, summary.subscription, summary.lastFallback.reason]).toEqual([2, 1, "exhausted: HTTP 400"]);
    expect([summary.refused, summary.lastRefusal.reason]).toEqual([1, "exhausted: a run was refused"]);
  });
});

describe("LaunchAgent", () => {
  test("the plist runs weekly run --notify on Mondays at 13:30 with escaped values", () => {
    const text = plist({ bun: "/b/bun", cli: "/c/cli.js", path: "/x:/y", home: "/h&o", logs: "/logs" });
    expect(text).toContain(`<string>${LABEL}</string>`);
    for (const value of ["/b/bun", "/c/cli.js", "weekly", "run", "--notify", "/x:/y", "/h&amp;o", "/logs/weekly-launchd.log"]) expect(text).toContain(`<string>${value}</string>`);
    expect(text).toMatch(/<key>Weekday<\/key>\s*<integer>1<\/integer>\s*<key>Hour<\/key>\s*<integer>13<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/);
  });

  test("install writes and loads the plist; uninstall unloads and removes it", async () => {
    const agents = join(scratch, "agents");
    const log = join(scratch, "launchctl.log");
    const launchctl = join(scratch, "launchctl");
    writeFileSync(launchctl, `#!/bin/sh\necho "$@" >> "${log}"\n[ "$1" = bootout ] && exit 3\nexit 0\n`);
    chmodSync(launchctl, 0o755);
    // The tools a run needs, as stand-ins, so the test does not depend on this machine.
    const tools = join(scratch, "tools");
    mkdirSync(tools);
    for (const tool of ["claude", "git", "gh", "uv"]) {
      writeFileSync(join(tools, tool), "#!/bin/sh\n");
      chmodSync(join(tools, tool), 0o755);
    }
    setEnv({ CLAUDE_FACTORY_LAUNCH_AGENTS: agents, CLAUDE_FACTORY_LAUNCHCTL: launchctl, PATH: `${tools}:/usr/bin:/bin` });
    // Without cargo, which only tests agent-board proposals, the run is still scheduled.
    expect(await run(["install"])).toBe(0);
    const file = join(agents, `${LABEL}.plist`);
    expect(readFileSync(file, "utf8")).toContain("<string>weekly</string>");
    // With it, its folder is on the job's PATH.
    const cargo = join(scratch, "cargo-bin");
    mkdirSync(cargo);
    writeFileSync(join(cargo, "cargo"), "#!/bin/sh\n");
    chmodSync(join(cargo, "cargo"), 0o755);
    setEnv({ PATH: `${tools}:${cargo}:/usr/bin:/bin` });
    expect(await run(["install"])).toBe(0);
    expect(readFileSync(file, "utf8")).toMatch(new RegExp(`<string>[^<]*${cargo}[^<]*</string>`));
    expect(readFileSync(log, "utf8")).toMatch(new RegExp(`bootout gui/\\d+/${LABEL}\\nbootstrap gui/\\d+ ${file.replace(/[.]/g, "\\.")}`));
    expect(await run(["uninstall"])).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  test("usage errors exit 2", async () => {
    expect(await run([])).toBe(2);
    expect(await run(["nope"])).toBe(2);
    expect(await run(["run", "--sample", "0"])).toBe(2);
    expect(await run(["run", "--bogus"])).toBe(2);
  });
});
