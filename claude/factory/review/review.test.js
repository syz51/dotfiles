import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.js";
import { readJsonl } from "../lib/state.js";
import { AGENT, CONFIG_FILE, loadConfig, prepare, proposalBody, remoteUrl, reviewRepo, summaryLines, verifyPrompt, verifySchema } from "./cli.js";

const FAKE = join(import.meta.dir, "..", "lib", "testing", "fake-claude.js");
const SCRIPT = join(import.meta.dir, "testing", "fake-session.js");
const DAY = 86_400_000;
// The command reads the clock, so the remotes' commits are dated from it.
const NOW = Date.now();
let scratch;
let remotes;
let commits;
const saved = {};
const setEnv = (values) => {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

// A repository under remotes with main commits at the given ages in days: [sha, ...].
function makeRemote(name, ages) {
  const dir = join(remotes, name);
  mkdirSync(dir, { recursive: true });
  const git = (args, date) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    return run.stdout.toString().trim();
  };
  git(["init", "-q", "-b", "main"]);
  return ages.map((age, i) => {
    const date = new Date(NOW - age * DAY).toISOString();
    writeFileSync(join(dir, "a.js"), `export const a = ${i};\n`);
    git(["add", "."], date);
    git(["commit", "-q", "-m", `c${i}`], date);
    return git(["rev-parse", "HEAD"], date);
  });
}

// A fake board CLI: logs its argv to FAKE_BOARD_LOG and answers boards, ls and add.
function fakeBoard() {
  const path = join(scratch, "fake-board.js");
  writeFileSync(path, `#!/usr/bin/env bun
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_BOARD_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "boards") console.log(JSON.stringify([
  { slug: "dotfiles", repos: ["github.com/o/dotfiles"] }, { slug: "agent-board", repos: ["github.com/o/agent-board"] }, { slug: "empty", repos: [] }]));
if (args[0] === "ls") console.log(JSON.stringify([{ id: "dotfiles-1", title: "Existing task", status: "open" }, { id: "dotfiles-2", title: "Finished task", status: "done" }]));
if (args[0] === "add") {
  if (process.env.FAKE_BOARD_ADD_FAIL === "1") { console.error("board unreachable"); process.exit(1); }
  const count = fs.readFileSync(process.env.FAKE_BOARD_LOG, "utf8").trim().split("\\n").filter((line) => line.startsWith('["add"')).length;
  console.log(JSON.stringify({ id: "dotfiles-" + (500 + count), title: args[1] }));
}
`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "claude-factory-review-main-test-")));
  remotes = join(scratch, "remotes");
  commits = makeRemote("dotfiles", [10, 3, 1]);
  setEnv({
    CLAUDE_FACTORY_BIN: FAKE, CLAUDE_FACTORY_STATE: join(scratch, "state"), FAKE_CLAUDE_MODE: "script", FAKE_CLAUDE_SCRIPT: SCRIPT,
    CLAUDE_FACTORY_BOARD: fakeBoard(), FAKE_BOARD_LOG: join(scratch, "board.jsonl"), CLAUDE_FACTORY_REVIEW_REMOTE: remotes,
    FAKE_REVIEW_LOG: join(scratch, "sessions.jsonl"), FAKE_REVIEW_TEXT: "Findings:\n- lock race REAL\n- naming",
    FAKE_REVIEW_FAIL: undefined, FAKE_REVIEW_NO_SKILL: undefined, FAKE_VERIFY_NONE: undefined, FAKE_BOARD_ADD_FAIL: undefined,
  });
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  rmSync(scratch, { recursive: true, force: true });
});

const config = () => loadConfig();
const sessions = () => readJsonl(join(scratch, "sessions.jsonl"));
const boardCalls = () => readJsonl(join(scratch, "board.jsonl"));
const target = { board: "dotfiles", repo: "github.com/o/dotfiles" };

describe("config", () => {
  test("the shipped config reviews dotfiles and agent-board at high within a per-repository cap", () => {
    const shipped = loadConfig(CONFIG_FILE);
    expect(shipped.boards).toEqual(["dotfiles", "agent-board"]);
    expect([shipped.days, shipped.branch, shipped.level]).toEqual([7, "main", "high"]);
    expect(shipped.reviewBudgetUsd + shipped.verifyBudgetUsd).toBeLessThanOrEqual(10);
  });

  test("a bad config names every problem", () => {
    const file = join(scratch, "bad.json");
    writeFileSync(file, JSON.stringify({ boards: [], days: 0, branch: "main", model: "opus", level: "ultra", verifyModel: "claude-opus-5-5", verifyEffort: "high", reviewBudgetUsd: 0, verifyBudgetUsd: 1 }));
    expect(() => loadConfig(file)).toThrow(/boards must be.*days must be.*model must be.*level must be.*reviewBudgetUsd must be/);
  });

  test("repositories clone from GitHub over SSH, or from the test folder", () => {
    expect(remoteUrl("github.com/o/n", {})).toBe("git@github.com:o/n.git");
    expect(remoteUrl("github.com/o/n", { CLAUDE_FACTORY_REVIEW_REMOTE: "/r" })).toBe("/r/n");
    expect(() => remoteUrl("gitlab.com/o/n", {})).toThrow("only github.com");
  });
});

describe("prepare", () => {
  test("clones the branch's head with no remote; base is the last commit before the window", async () => {
    const dir = join(scratch, "clone");
    expect(await prepare(join(remotes, "dotfiles"), dir, { branch: "main", days: 7, now: NOW })).toEqual({ base: commits[0], head: commits[2], commits: 2 });
    const git = (args) => Bun.spawnSync(["git", ...args], { cwd: dir }).stdout.toString().trim();
    expect(git(["rev-parse", "HEAD"])).toBe(commits[2]);
    expect(git(["remote"])).toBe("");
  });

  test("base is null when the branch has no commit that old", async () => {
    const result = await prepare(join(remotes, "dotfiles"), join(scratch, "clone"), { branch: "main", days: 30, now: NOW });
    expect(result).toEqual({ base: null, head: commits[2], commits: null });
  });
});

describe("reviewRepo", () => {
  test("reviews the window, verifies against main and files the confirmed findings as proposals", async () => {
    const record = await reviewRepo(target, config(), { now: NOW });
    expect(record.error).toBeNull();
    expect([record.base, record.head, record.commits]).toEqual([commits[0], commits[2], 2]);
    expect([record.reviewCostUSD, record.verifyCostUSD, record.recipe]).toEqual([0.7, 0.4, "high effort → test recipe"]);
    const [review, verify] = sessions();
    // The review session runs the skill on the window in a clone with no remote.
    expect(review.kind).toBe("review");
    expect(review.stdin).toContain(`code-review skill with args "high ${commits[0]}...${commits[2]}"`);
    expect([review.head, review.remotes]).toEqual([commits[2], ""]);
    expect(review.args.slice(review.args.indexOf("--model"), review.args.indexOf("--model") + 4)).toEqual(["--model", "claude-opus-5-5", "--effort", "high"]);
    expect(review.args[review.args.indexOf("--max-budget-usd") + 1]).toBe("5");
    // The verify session reads the code at main with read-only tools and sees the open tasks.
    expect(verify.kind).toBe("verify");
    expect(verify.head).toBe(commits[2]);
    expect(verify.args[verify.args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Bash");
    expect(JSON.parse(verify.args[verify.args.indexOf("--json-schema") + 1])).toEqual(verifySchema);
    expect(verify.stdin).toContain("- lock race REAL\n- naming");
    expect(verify.stdin).toContain("- Existing task");
    expect(verify.stdin).not.toContain("Finished task");
    // One proposal for the confirmed finding; the rejected one is kept with its reason.
    const adds = boardCalls().filter(([command]) => command === "add");
    expect(adds.length).toBe(1);
    const [, title, ...rest] = adds[0];
    expect(title).toBe("Fix lock race REAL");
    const option = (name) => rest[rest.indexOf(name) + 1];
    expect([option("--board"), option("--auto"), option("--agent"), option("--priority")]).toEqual(["dotfiles", "false", AGENT, "p2"]);
    expect(option("--body")).toMatch(/^Proposal: lock race REAL\n\nEvidence: the weekly review \(\/code-review high\) of github.com\/o\/dotfiles main [0-9a-f]{8}\.\.[0-9a-f]{8} reported it at a\.js:1\. A verify pass on [0-9a-f]{8} confirmed it: reason 1\n\nChange: Change it\.\n\nSize: S\n\nFound by the factory's weekly review of main on \d{4}-\d{2}-\d{2}\.$/);
    expect(record.confirmed.map((finding) => [finding.title, finding.task])).toEqual([["Fix lock race REAL", "dotfiles-501"]]);
    expect(record.rejected.map((finding) => [finding.summary, finding.reason])).toEqual([["naming", "reason 2"]]);
  });

  test("a dry run verifies but files nothing", async () => {
    const record = await reviewRepo(target, config(), { now: NOW, file: false });
    expect(record.confirmed.map((finding) => finding.task)).toEqual([null]);
    expect(boardCalls().filter(([command]) => command === "add")).toEqual([]);
  });

  test("a window with no commits runs no session", async () => {
    makeRemote("quiet", [20, 10]);
    const record = await reviewRepo({ board: "dotfiles", repo: "github.com/o/quiet" }, config(), { now: NOW });
    expect([record.commits, record.error, record.reviewCostUSD]).toEqual([0, null, 0]);
    expect(existsSync(join(scratch, "sessions.jsonl"))).toBe(false);
  });

  test("a repository younger than the window is an error, not a review of all history", async () => {
    makeRemote("young", [2, 1]);
    const record = await reviewRepo({ board: "dotfiles", repo: "github.com/o/young" }, config(), { now: NOW });
    expect(record.error).toBe("main has no commit older than 7 days");
    expect(existsSync(join(scratch, "sessions.jsonl"))).toBe(false);
  });

  test("failures end the repository with the reason and what it spent", async () => {
    setEnv({ FAKE_REVIEW_FAIL: "1" });
    let record = await reviewRepo(target, config(), { now: NOW });
    expect(record.error).toBe("review session ended without a result (error_max_budget_usd, is_error)");
    expect([record.reviewCostUSD, record.verifyCostUSD]).toEqual([0.3, 0]);

    setEnv({ FAKE_REVIEW_FAIL: undefined, FAKE_REVIEW_NO_SKILL: "1" });
    record = await reviewRepo(target, config(), { now: NOW });
    expect(record.error).toBe("the review session did not call the code-review skill");

    setEnv({ FAKE_REVIEW_NO_SKILL: undefined, FAKE_VERIFY_NONE: "1" });
    record = await reviewRepo(target, config(), { now: NOW });
    expect(record.error).toBe("verify session ended without findings (no structured output)");
    expect(record.verifyCostUSD).toBe(0.4);

    setEnv({ FAKE_VERIFY_NONE: undefined, FAKE_BOARD_ADD_FAIL: "1" });
    record = await reviewRepo(target, config(), { now: NOW });
    expect(record.error).toMatch(/^board add on dotfiles exited 1: board unreachable/);
    expect(record.rejected.length).toBe(1);
  });
});

describe("prompts and report", () => {
  test("the verify prompt cuts a long review and says when there are no open tasks", () => {
    const text = verifyPrompt({ base: "a", head: "b", output: "x".repeat(70_000), titles: [] });
    expect(text).toContain("[review output cut at 60000 characters]");
    expect(text).toContain("Open tasks on this repository's board:\n(none)");
  });

  test("the proposal body starts with Proposal: and cites the range", () => {
    const body = proposalBody({ summary: "s", location: "f:1", reason: "r", change: "c", size: "M" }, { repo: "github.com/o/n", base: "1".repeat(40), head: "2".repeat(40), level: "high", date: "2026-11-09" });
    expect(body.startsWith("Proposal: s\n\nEvidence:")).toBe(true);
    expect(body).toContain("main 11111111..22222222 reported it at f:1");
  });

  test("summary lines name a failed repository with its range and cost", () => {
    const lines = summaryLines({ days: 7, costUSD: 0.3, repos: [{ repo: "github.com/o/n", base: "1".repeat(40), head: "2".repeat(40), commits: 3, reviewCostUSD: 0.3, verifyCostUSD: 0, error: "timed out", confirmed: [], rejected: [] }] });
    expect(lines).toEqual(["github.com/o/n: FAILED (11111111..22222222, 3 commits, $0.30): timed out", "Total cost $0.30"]);
  });
});

describe("the review command", () => {
  async function capture(fn) {
    const out = [];
    const original = console.log;
    console.log = (text) => out.push(text);
    try {
      return { code: await fn(), out: out.join("\n") };
    } finally {
      console.log = original;
    }
  }

  test("reviews each configured board's repositories and keeps the result in the state folder", async () => {
    makeRemote("agent-board", [9, 2]);
    const { code, out } = await capture(() => main(["review", "--json", "--dry-run"]));
    expect(code).toBe(0);
    const result = JSON.parse(out);
    expect(result.repos.map((repo) => [repo.repo, repo.commits, repo.confirmed.length, repo.rejected.length])).toEqual([["github.com/o/dotfiles", 2, 1, 1], ["github.com/o/agent-board", 1, 1, 1]]);
    expect(result.costUSD).toBeCloseTo(2.2);
    expect(boardCalls().filter(([command]) => command === "add")).toEqual([]);
    const kept = JSON.parse(readFileSync(join(scratch, "state", "review", `main-${result.startedAt.slice(0, 10)}.json`), "utf8"));
    expect(kept.repos.length).toBe(2);
  });

  test("--board limits the run; a board outside the config is refused; a failed repository exits 1", async () => {
    const errors = [];
    const original = console.error;
    console.error = (text) => errors.push(text);
    try {
      expect(await main(["review", "--board", "empty"])).toBe(2);
      expect(errors.join("\n")).toContain("Not in the config's boards: empty");
    } finally {
      console.error = original;
    }
    setEnv({ FAKE_REVIEW_FAIL: "1" });
    const { code, out } = await capture(() => main(["review", "--board", "dotfiles"]));
    expect(code).toBe(1);
    expect(out).toContain("github.com/o/dotfiles: FAILED");
    expect(out).not.toContain("agent-board");
  });
});
