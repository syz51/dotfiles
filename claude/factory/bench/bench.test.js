import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectName } from "../../tests/lib/cleanup.js";
import { main } from "../cli.js";
import { readJsonl } from "../lib/state.js";
import { addFromCommit, defaultPrompt } from "./add.js";
import { agentOverride, loadCase, loadCases, materialize, writeAgentOverride } from "./cases.js";
import { matrix } from "./cli.js";
import { aggregate, markdown, median, paretoFront, recommend } from "./report.js";
import { AGENTS_DIR, observedModels, runMatrix, runOne, runOracle } from "./runner.js";

const FAKE = join(import.meta.dir, "..", "lib", "testing", "fake-claude.js");
const SESSION = join(import.meta.dir, "testing", "fake-session.js");
let scratch;
let casesDir;
const saved = {};
const setEnv = (values) => {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "claude-factory-bench-")));
  casesDir = join(scratch, "cases");
  setEnv({
    CLAUDE_FACTORY_BIN: FAKE, CLAUDE_FACTORY_STATE: join(scratch, "state"), FAKE_CLAUDE_MODE: "script",
    FAKE_CLAUDE_SCRIPT: SESSION, FAKE_BENCH_LOG: join(scratch, "sessions.jsonl"),
    FAKE_BENCH_SLEEP: undefined, FAKE_BENCH_WRITE: undefined, FAKE_BENCH_TEXT: undefined, FAKE_BENCH_RAN: undefined,
    FAKE_BENCH_SUBTYPE: undefined, FAKE_BENCH_IS_ERROR: undefined, FAKE_BENCH_API_ERROR: undefined, FAKE_BENCH_COST: undefined,
    FAKE_CLAUDE_EFFORT: undefined,
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

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const caseValue = (overrides = {}) => ({
  id: "sample", title: "Sample", role: "main", prompt: "Do the task.",
  fixture: { type: "files", dir: "fixture" }, oracle: { command: "true", timeoutMs: 10_000 },
  budgetUsd: 1, timeoutMs: 20_000, ...overrides,
});

// Writes cases/<id>/case.json with extra files in the case folder; returns its path.
function writeCase(value, files = { "fixture/README.md": "fixture\n" }, dir = casesDir) {
  const caseDir = join(dir, typeof value === "string" ? "bad" : value.id);
  mkdirSync(caseDir, { recursive: true });
  writeFiles(caseDir, files);
  writeFileSync(join(caseDir, "case.json"), typeof value === "string" ? value : JSON.stringify(value));
  return join(caseDir, "case.json");
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function gitIn(dir, ...args) {
  const run = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=Bench test", "-c", "user.email=bench@localhost",
    "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}
function repoWith(...commits) {
  const repo = join(scratch, "repo");
  mkdirSync(repo, { recursive: true });
  gitIn(repo, "init", "-q", "-b", "main");
  const shas = commits.map(([files, message]) => {
    writeFiles(repo, files);
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-qm", message);
    return gitIn(repo, "rev-parse", "HEAD");
  });
  return { repo, shas };
}

const sessions = () => readJsonl(join(scratch, "sessions.jsonl"));
const results = () => readJsonl(join(scratch, "state", "bench", "results.jsonl"));
const runOptions = (overrides = {}) => ({ model: "claude-sonnet-5-5", effort: "high", trial: 1, runId: "r1", batch: "b1", ...overrides });

async function capture(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => out.push(args.join(" "));
  console.error = (...args) => err.push(args.join(" "));
  try {
    const code = await fn();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("cases", () => {
  test("validation reports every problem with the file path", () => {
    const file = writeCase(caseValue({ role: "boss", prompt: "", budgetUsd: 0, extra: 1, oracle: { command: "true" } }));
    let message = "";
    try {
      loadCase(file);
    } catch (error) {
      message = error.message;
    }
    expect(message.startsWith(`${file}: `)).toBe(true);
    for (const part of ["unknown key \"extra\"", "role must be one of", "prompt must be", "budgetUsd must be", "oracle must be"])
      expect(message).toContain(part);
  });

  test("validation rejects bad JSON, a mismatched id, missing folders and unknown commits", () => {
    const bad = writeCase("{nope", {}, join(scratch, "bad"));
    expect(() => loadCase(bad)).toThrow(bad);
    const renamed = join(scratch, "renamed");
    mkdirSync(join(renamed, "folder"), { recursive: true });
    writeFileSync(join(renamed, "folder", "case.json"), JSON.stringify(caseValue()));
    expect(() => loadCase(join(renamed, "folder", "case.json"))).toThrow("must match its folder name");
    expect(() => loadCase(writeCase(caseValue(), {}))).toThrow("fixture.dir \"fixture\" must be a folder");
    expect(() => loadCase(writeCase(caseValue({ id: "ov", fixture: { type: "files", dir: "fixture", overlay: "missing" } }))))
      .toThrow("fixture.overlay");
    const { repo } = repoWith([{ "a.txt": "a" }, "one"]);
    const missing = writeCase(caseValue({ id: "gone", fixture: { type: "git", repo, commit: "0123456789abcdef0123456789abcdef01234567" } }), {});
    expect(() => loadCase(missing)).toThrow(`${missing}: fixture repository`);
    expect(() => loadCase(writeCase(caseValue({ id: "kind", fixture: { type: "zip" } }), {}))).toThrow("fixture.type");
  });

  test("loadCases lists valid cases sorted by id", () => {
    writeCase(caseValue({ id: "b-case" }));
    writeCase(caseValue({ id: "a-case" }));
    expect(loadCases(casesDir).map((benchCase) => benchCase.id)).toEqual(["a-case", "b-case"]);
    expect(loadCases(join(scratch, "none"))).toEqual([]);
  });

  test("the seed cases load, with every role covered", () => {
    const cases = loadCases();
    const count = (role) => cases.filter((benchCase) => benchCase.role === role).length;
    expect(count("explorer")).toBeGreaterThanOrEqual(2);
    expect(count("worker")).toBeGreaterThanOrEqual(2);
    expect(count("solver")).toBeGreaterThanOrEqual(1);
    expect(count("main")).toBeGreaterThanOrEqual(1);
  });

  // An overlay's tests import code that exists only in the case's fixture, so the root
  // bunfig.toml keeps `bun test` from discovering them in this checkout.
  test("the root bunfig ignores every bun test file in a case overlay", () => {
    const root = join(import.meta.dir, "..", "..", "..");
    const patterns = [...readFileSync(join(root, "bunfig.toml"), "utf8").matchAll(/"([^"]+)"/g)].map((match) => new Bun.Glob(match[1]));
    const overlayTests = [...new Bun.Glob("claude/factory/bench/cases/*/overlay/**/*.test.{js,ts}").scanSync(root)];
    expect(overlayTests.length).toBeGreaterThan(0);
    for (const path of overlayTests) expect(patterns.some((glob) => glob.match(path)), path).toBe(true);
  });

  test("files fixtures copy the folder, and the overlay replaces and adds files", () => {
    const benchCase = loadCase(writeCase(caseValue({ fixture: { type: "files", dir: "fixture", overlay: "overlay" } }), {
      "fixture/src/app.txt": "app", "fixture/test.txt": "old test", "overlay/test.txt": "new test", "overlay/more/extra.txt": "extra",
    }));
    const dest = join(scratch, "work");
    materialize(benchCase, dest);
    expect(readFileSync(join(dest, "src", "app.txt"), "utf8")).toBe("app");
    expect(readFileSync(join(dest, "test.txt"), "utf8")).toBe("new test");
    expect(readFileSync(join(dest, "more", "extra.txt"), "utf8")).toBe("extra");
  });

  test("git fixtures extract the commit with its overlay and leave the repository alone", () => {
    const { repo, shas } = repoWith([{ "lib.txt": "v1", "test.txt": "t1" }, "one"], [{ "lib.txt": "v2" }, "two"]);
    writeFileSync(join(repo, "lib.txt"), "uncommitted");
    const before = gitIn(repo, "status", "--porcelain");
    const benchCase = loadCase(writeCase(caseValue({ fixture: { type: "git", repo, commit: shas[0], overlay: "overlay" } }), { "overlay/test.txt": "t2" }));
    const dest = join(scratch, "work");
    materialize(benchCase, dest);
    expect(readFileSync(join(dest, "lib.txt"), "utf8")).toBe("v1");
    expect(readFileSync(join(dest, "test.txt"), "utf8")).toBe("t2");
    expect(existsSync(join(dest, ".git"))).toBe(false);
    expect(gitIn(repo, "status", "--porcelain")).toBe(before);
    expect(gitIn(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(readdirSync(scratch).filter((name) => name.endsWith(".tar"))).toEqual([]);
  });

  test('repo "." is the repository containing the case', () => {
    const { repo, shas } = repoWith([{ "a.txt": "a" }, "one"]);
    const benchCase = loadCase(writeCase(caseValue({ fixture: { type: "git", repo: ".", commit: shas[0] } }), {}, join(repo, "cases")));
    expect(benchCase.fixture.repoPath).toBe(repo);
  });

  test("the agent override sets model and effort and keeps the rest", () => {
    const text = "---\nname: worker\ndescription: \"Works.\"\nmodel: opus\neffort: high\ndisallowedTools: Agent\n---\n\nBody line.\n";
    const result = agentOverride(text, { model: "claude-haiku-5-5", effort: "low" });
    expect(result).toBe("---\nname: worker\ndescription: \"Works.\"\ndisallowedTools: Agent\nmodel: claude-haiku-5-5\neffort: low\n---\n\nBody line.\n");
    expect(agentOverride("---\nname: x\n---\nBody\n", { model: "m", effort: "e" })).toBe("---\nname: x\nmodel: m\neffort: e\n---\nBody\n");
    expect(() => agentOverride("no frontmatter", { model: "m", effort: "e" })).toThrow("frontmatter");
    for (const role of ["explorer", "worker", "solver"]) {
      const path = writeAgentOverride(join(scratch, role), role, { model: "claude-sonnet-5-5", effort: "medium" }, AGENTS_DIR);
      const written = readFileSync(path, "utf8");
      expect(path).toBe(join(scratch, role, ".claude", "agents", `${role}.md`));
      expect(written).toContain(`name: ${role}`);
      expect(written.match(/^model: .*$/gm)).toEqual(["model: claude-sonnet-5-5"]);
      expect(written.match(/^effort: .*$/gm)).toEqual(["effort: medium"]);
    }
  });
});

describe("oracle", () => {
  test("passes on exit 0, fails otherwise, and times out", async () => {
    const answer = join(scratch, "answer.txt");
    writeFileSync(answer, "");
    expect((await runOracle({ command: "echo fine", timeoutMs: 5000 }, scratch, answer)).exit).toBe(0);
    const failed = await runOracle({ command: "echo broken >&2; exit 3", timeoutMs: 5000 }, scratch, answer);
    expect(failed).toMatchObject({ exit: 3, timedOut: false });
    expect(failed.output).toContain("broken");
    const slow = await runOracle({ command: "echo started; sleep 5", timeoutMs: 200 }, scratch, answer);
    expect(slow).toMatchObject({ exit: null, timedOut: true });
    expect(slow.output).toContain("timed out after 200 ms");
  });

  // A case that judges the final answer may keep reference/answer.md, right at its pinned
  // commit, and reference/parent-answer.md, right at the commit before it: the oracle must
  // pass the first and fail the second, so it checks what the pinned commit changed.
  test("answer oracles pass their reference answer and fail the parent's and an empty one", async () => {
    const referenced = loadCases().filter((benchCase) => existsSync(join(benchCase.dir, "reference", "answer.md")));
    expect(referenced.map((benchCase) => benchCase.id)).toContain("explorer-board-hooks-off");
    const empty = join(scratch, "empty.md");
    writeFileSync(empty, "");
    for (const benchCase of referenced) {
      const check = (file) => runOracle(benchCase.oracle, scratch, file).then((run) => run.exit);
      expect(await check(join(benchCase.dir, "reference", "answer.md")), benchCase.id).toBe(0);
      expect(await check(empty), benchCase.id).not.toBe(0);
      const parent = join(benchCase.dir, "reference", "parent-answer.md");
      if (existsSync(parent)) expect(await check(parent), benchCase.id).not.toBe(0);
    }
  });

  test("restores the overlay before running, so edited tests do not count", async () => {
    writeFiles(join(scratch, "overlay"), { "test.sh": "exit 1\n" });
    writeFiles(join(scratch, "work"), { "test.sh": "exit 0\n" });
    const result = await runOracle({ command: "sh test.sh", timeoutMs: 5000 }, join(scratch, "work"), "/dev/null", { overlayPath: join(scratch, "overlay") });
    expect(result.exit).toBe(1);
  });
});

describe("runs", () => {
  test("a subagent role runs with the override agent, settings, model and effort", async () => {
    setEnv({ FAKE_BENCH_WRITE: "out.txt=solved", FAKE_BENCH_COST: "0.25" });
    const benchCase = loadCase(writeCase(caseValue({ role: "worker", budgetUsd: 1.5, oracle: { command: "grep -q solved out.txt", timeoutMs: 5000 } })));
    const record = await runOne(benchCase, runOptions({ cliVersion: "9.9.9" }));
    const [session] = sessions();
    const option = (name) => session.args[session.args.indexOf(name) + 1];
    expect(option("--agent")).toBe("worker");
    expect(option("--model")).toBe("claude-sonnet-5-5");
    expect(option("--effort")).toBe("high");
    expect(option("--max-budget-usd")).toBe("1.5");
    // The session is saved, so its effort can be read, and its transcript deleted after.
    expect(session.args).not.toContain("--no-session-persistence");
    expect(option("--session-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(readdirSync(join(homedir(), ".claude", "projects")).filter((name) => name.startsWith(projectName(dirname(session.cwd))))).toEqual([]);
    expect(session.agentFile).toContain("model: claude-sonnet-5-5\neffort: high\n");
    expect(session.agentFile).toContain("name: worker");
    // As a spawned subagent would, the role runs without the main session's own tools.
    expect(session.settings.permissions.deny).toEqual(["WebFetch", "WebSearch", "ScheduleWakeup", "Workflow"]);
    expect(session.settings.hooks.PreToolUse[0].hooks[0].command).toContain("tests/lib/hooks/block-installs.js");
    expect(session.env).toMatchObject({ UV_OFFLINE: "1", TMPDIR: dirname(session.cwd), CLAUDE_CODE_TMPDIR: dirname(session.cwd) });
    expect(existsSync(session.cwd)).toBe(false);
    expect(record).toMatchObject({
      runId: "r1", batch: "b1", caseId: "sample", role: "worker", model: "claude-sonnet-5-5", modelObserved: "claude-sonnet-5-5",
      effort: "high", effortObserved: "high", trial: 1, pass: true, oracleExit: 0, costUSD: 0.25, turns: 3, error: null, infra: false, cliVersion: "9.9.9",
    });
    expect(record.durationMs).toBeGreaterThan(0);
    expect(Date.parse(record.at)).not.toBeNaN();
  });

  test("the main role runs without an agent", async () => {
    const record = await runOne(loadCase(writeCase(caseValue())), runOptions());
    expect(sessions()[0].args).not.toContain("--agent");
    expect(sessions()[0].agentFile).toBeNull();
    expect(sessions()[0].settings.permissions.deny).toEqual(["WebFetch", "WebSearch"]);
    expect(record.pass).toBe(true);
  });

  test("the oracle reads the final answer from FINAL_ANSWER_FILE outside the workspace", async () => {
    setEnv({ FAKE_BENCH_TEXT: "The hook is in hooks/guard.js" });
    const command = 'case "$FINAL_ANSWER_FILE" in "$PWD"/*) exit 9;; esac; grep -q "hooks/guard.js" "$FINAL_ANSWER_FILE"';
    const benchCase = loadCase(writeCase(caseValue({ role: "explorer", oracle: { command, timeoutMs: 5000 } })));
    expect(await runOne(benchCase, runOptions())).toMatchObject({ pass: true, oracleExit: 0 });
    setEnv({ FAKE_BENCH_TEXT: "No idea" });
    expect(await runOne(benchCase, runOptions())).toMatchObject({ pass: false, oracleExit: 1, error: null, infra: false });
  });

  test("an oracle timeout fails the run", async () => {
    const benchCase = loadCase(writeCase(caseValue({ oracle: { command: "sleep 5", timeoutMs: 200 } })));
    const record = await runOne(benchCase, runOptions());
    expect(record).toMatchObject({ pass: false, oracleExit: null, infra: false });
    expect(record.oracleOutput).toContain("timed out");
  });

  test("a session that ends in error fails even when the oracle passes", async () => {
    setEnv({ FAKE_BENCH_SUBTYPE: "error_max_budget_usd" });
    const record = await runOne(loadCase(writeCase(caseValue())), runOptions());
    expect(record).toMatchObject({ pass: false, oracleExit: 0, infra: false, error: "session ended with error_max_budget_usd" });
  });

  test("a session timeout is a model failure with unknown cost", async () => {
    setEnv({ FAKE_BENCH_SLEEP: "3000" });
    const record = await runOne(loadCase(writeCase(caseValue({ timeoutMs: 300 }))), runOptions());
    expect(record).toMatchObject({ pass: false, infra: false, costUSD: null, error: "session timed out after 300 ms" });
  });

  test("the wrong model, API errors and a broken CLI are infrastructure failures", async () => {
    const benchCase = loadCase(writeCase(caseValue()));
    setEnv({ FAKE_BENCH_RAN: "claude-haiku-5-5" });
    const wrong = await runOne(benchCase, runOptions());
    expect(wrong).toMatchObject({ pass: false, infra: true, modelObserved: "claude-haiku-5-5" });
    expect(wrong.error).toContain("requested claude-sonnet-5-5 but the session ran claude-haiku-5-5");
    setEnv({ FAKE_BENCH_RAN: undefined, FAKE_BENCH_SUBTYPE: "error_during_execution", FAKE_BENCH_API_ERROR: "401" });
    expect(await runOne(benchCase, runOptions())).toMatchObject({ pass: false, infra: true, error: "session ended with error_during_execution (HTTP 401)" });
    setEnv({ FAKE_BENCH_SUBTYPE: undefined, FAKE_BENCH_API_ERROR: undefined, FAKE_BENCH_IS_ERROR: "1", FAKE_BENCH_TEXT: "Not logged in" });
    expect(await runOne(benchCase, runOptions())).toMatchObject({ pass: false, infra: true, error: "session ended with an error result: Not logged in" });
    setEnv({ FAKE_CLAUDE_MODE: "exit" });
    expect(await runOne(benchCase, runOptions())).toMatchObject({ pass: false, infra: true });
  });

  test("a session at another effort, or one whose effort is unrecorded, is an infrastructure failure", async () => {
    const benchCase = loadCase(writeCase(caseValue()));
    setEnv({ FAKE_CLAUDE_EFFORT: "low" });
    expect(await runOne(benchCase, runOptions())).toMatchObject({
      pass: false, infra: true, effort: "high", effortObserved: "low", error: "requested effort high but the session ran low",
    });
    // A transcript without effort leaves the requested effort unverified.
    setEnv({ FAKE_CLAUDE_EFFORT: "" });
    const unrecorded = await runOne(benchCase, runOptions());
    expect(unrecorded).toMatchObject({ pass: false, infra: true, effortObserved: null });
    expect(unrecorded.error).toContain("recorded no effort");
    // The wrong model is reported over the wrong effort.
    setEnv({ FAKE_CLAUDE_EFFORT: "low", FAKE_BENCH_RAN: "claude-haiku-5-5" });
    expect((await runOne(benchCase, runOptions())).error).toContain("requested claude-sonnet-5-5 but the session ran claude-haiku-5-5");
  });

  test("a dated ID of the requested model is the requested model", async () => {
    setEnv({ FAKE_BENCH_RAN: "claude-sonnet-5-5-20261001" });
    expect(await runOne(loadCase(writeCase(caseValue())), runOptions())).toMatchObject({ pass: true, infra: false, modelObserved: "claude-sonnet-5-5-20261001" });
  });

  test("observedModels counts only the main thread", () => {
    expect(observedModels([
      { type: "assistant", message: { model: "a" } },
      { type: "assistant", parent_tool_use_id: "x", message: { model: "b" } },
      { type: "assistant", message: { model: "a" } },
    ])).toEqual(["a"]);
  });
});

describe("matrix", () => {
  const jobs = (count, budgetUsd = 1) => Array.from({ length: count }, (_, index) => ({ index, budgetUsd }));

  test("stops starting runs when spent plus the next budget would pass the limit", async () => {
    const started = [];
    const outcome = await runMatrix(jobs(6), {
      maxTotalUsd: 2.5,
      execute: async (job) => {
        started.push(job.index);
        return { costUSD: 0.4 };
      },
    });
    // Spent before each start: 0, 0.4, 0.8, 1.2; then 1.6 + 1 > 2.5.
    expect(started).toEqual([0, 1, 2, 3]);
    expect(outcome).toMatchObject({ skipped: 2 });
    expect(outcome.spent).toBeCloseTo(1.6);
  });

  test("counts running budgets and unknown costs in full", async () => {
    let active = 0;
    let peak = 0;
    const outcome = await runMatrix(jobs(4), {
      parallel: 4, maxTotalUsd: 2,
      execute: async () => {
        peak = Math.max(peak, ++active);
        await Bun.sleep(20);
        active--;
        return { costUSD: null };
      },
    });
    expect(peak).toBe(2);
    expect(outcome).toMatchObject({ skipped: 2, spent: 2 });
  });

  test("never runs more than parallel at once", async () => {
    let active = 0;
    let peak = 0;
    const outcome = await runMatrix(jobs(7, 0.1), {
      parallel: 3,
      execute: async () => {
        peak = Math.max(peak, ++active);
        await Bun.sleep(15);
        active--;
        return { costUSD: 0.01 };
      },
    });
    expect(peak).toBe(3);
    expect(outcome.records).toHaveLength(7);
  });

  test("an execute error stops new starts and is rethrown after running jobs finish", async () => {
    const finished = [];
    await expect(runMatrix(jobs(5, 0.1), {
      parallel: 2,
      execute: async (job) => {
        if (job.index === 0) throw new Error("fixture broke");
        await Bun.sleep(20);
        finished.push(job.index);
        return { costUSD: 0 };
      },
    })).rejects.toThrow("fixture broke");
    expect(finished).toEqual([1]);
  });

  test("puts trials outermost", () => {
    const order = matrix([{ id: "a", budgetUsd: 1 }, { id: "b", budgetUsd: 1 }], ["m1", "m2"], ["e"], 2)
      .map((job) => `${job.trial}${job.benchCase.id}${job.model}`);
    expect(order).toEqual(["1am1", "1am2", "1bm1", "1bm2", "2am1", "2am2", "2bm1", "2bm2"]);
  });
});

describe("bench run command", () => {
  test("runs the matrix in parallel and appends one record per run", async () => {
    setEnv({ FAKE_BENCH_SLEEP: "300", FAKE_BENCH_COST: "0.1" });
    writeCase(caseValue({ id: "one", role: "explorer" }));
    writeCase(caseValue({ id: "two" }));
    const { code, out } = await capture(() => main(["bench", "run", "--cases", casesDir, "--case", "one",
      "--models", "claude-haiku-5-5,claude-opus-5-5", "--efforts", "medium", "--trials", "2", "--parallel", "2"]));
    expect(code).toBe(0);
    expect(out).toContain("9.9.9 (Claude Code)");
    const records = results();
    expect(records).toHaveLength(4);
    expect(new Set(records.map((record) => record.runId)).size).toBe(4);
    expect(records.every((record) => record.caseId === "one" && record.cliVersion === "9.9.9 (Claude Code)" && record.pass)).toBe(true);
    expect(records.map((record) => `${record.model} ${record.trial}`).sort())
      .toEqual(["claude-haiku-5-5 1", "claude-haiku-5-5 2", "claude-opus-5-5 1", "claude-opus-5-5 2"]);
    const spans = sessions().map((session) => [session.started, session.ended]);
    const overlap = (time) => spans.filter(([from, to]) => from <= time && time < to).length;
    const peak = Math.max(...spans.map(([from]) => overlap(from)));
    expect(peak).toBe(2);
  });

  test("stops at the total budget", async () => {
    setEnv({ FAKE_BENCH_COST: "0.5" });
    writeCase(caseValue({ budgetUsd: 1 }));
    const { code, out } = await capture(() => main(["bench", "run", "--cases", casesDir, "--models", "claude-haiku-5-5",
      "--efforts", "low,medium,high", "--max-total-usd", "1.9"]));
    // Spent before each start: 0, 0.5; then 1.0 + 1 > 1.9.
    expect(code).toBe(0);
    expect(results()).toHaveLength(2);
    expect(out).toContain("1 runs not started");
  });

  test("dry run prints the matrix and worst case without running", async () => {
    writeCase(caseValue({ budgetUsd: 0.75 }));
    const { code, out } = await capture(() => main(["bench", "run", "--cases", casesDir, "--dry-run", "--max-total-usd", "2"]));
    expect(code).toBe(0);
    expect(out).toContain("| sample | main | claude-opus-5-5 | high | 1 | $0.75 |");
    expect(out).toContain("6 runs, worst case $4.50 (limit $2.00; at least the first 2 runs fit)");
    expect(existsSync(join(scratch, "sessions.jsonl"))).toBe(false);
  });

  test("an infrastructure failure exits 1; bad options exit 2", async () => {
    setEnv({ FAKE_BENCH_RAN: "claude-haiku-5-5" });
    writeCase(caseValue());
    const failed = await capture(() => main(["bench", "run", "--cases", casesDir, "--models", "claude-opus-5-5", "--efforts", "high"]));
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("INFRA");
    for (const args of [["--efforts", "ultra"], ["--models", "sonnet"], ["--trials", "0"], ["--case", "missing"], ["--bogus"]])
      expect((await capture(() => main(["bench", "run", "--cases", casesDir, ...args]))).code).toBe(2);
  });

  test("list shows the cases", async () => {
    writeCase(caseValue());
    const { code, out } = await capture(() => main(["bench", "list", "--cases", casesDir]));
    expect(code).toBe(0);
    expect(out).toContain("sample");
    expect(out).toContain("Sample");
  });
});

describe("report", () => {
  const record = (model, effort, pass, costUSD, extra = {}) => ({ caseId: "c1", role: "worker", model, effort, pass, costUSD, durationMs: 1000, ...extra });
  const trials = (model, effort, passes, costs, extra) => costs.map((cost, index) => record(model, effort, index < passes, cost, extra));

  test("aggregates pass rate, medians and runs per configuration and leaves out infrastructure failures", () => {
    const records = [
      ...trials("haiku", "medium", 1, [0.1, 0.3, 0.2]),
      record("haiku", "medium", false, 0, { infra: true }),
      record("opus", "high", true, 2, { durationMs: 4000 }),
      record("opus", "high", true, 1, { durationMs: 2000 }),
      record("other", "high", true, 1, { caseId: "c2", role: "explorer" }),
    ];
    const report = aggregate(records, { role: "worker" });
    expect(report).toMatchObject({ runs: 6, infraFailures: 1 });
    const [configs] = report.roles.map((role) => role.cases[0].configs);
    expect(configs[0]).toMatchObject({ model: "haiku", runs: 3, passes: 1, medianCostUSD: 0.2, medianDurationMs: 1000 });
    expect(configs[0].passRate).toBeCloseTo(1 / 3);
    expect(configs[1]).toMatchObject({ model: "opus", runs: 2, passRate: 1, medianCostUSD: 1.5, medianDurationMs: 3000 });
    expect(aggregate(records, { caseIds: ["c2"] }).roles.map((role) => role.role)).toEqual(["explorer"]);
  });

  test("the Pareto front keeps configurations nothing beats on both cost and pass rate", () => {
    const configs = [
      { model: "cheap", passRate: 0.5, medianCostUSD: 0.1 },
      { model: "mid", passRate: 0.9, medianCostUSD: 0.5 },
      { model: "worse", passRate: 0.8, medianCostUSD: 0.6 },
      { model: "tied", passRate: 0.5, medianCostUSD: 0.2 },
      { model: "best", passRate: 1, medianCostUSD: 2 },
      { model: "unpriced", passRate: 1, medianCostUSD: null },
    ];
    expect(paretoFront(configs).map((config) => config.model)).toEqual(["cheap", "mid", "best"]);
  });

  test("recommends the cheapest configuration within the margin of the best", () => {
    const configs = [
      { model: "haiku", effort: "medium", runs: 3, passRate: 2 / 3, medianCostUSD: 0.1 },
      { model: "sonnet", effort: "medium", runs: 3, passRate: 0.9, medianCostUSD: 0.5 },
      { model: "opus", effort: "high", runs: 3, passRate: 1, medianCostUSD: 2 },
    ];
    expect(recommend(configs, 0.1)).toMatchObject({ status: "ok", model: "sonnet", bestPassRate: 1 });
    expect(recommend(configs, 0.4)).toMatchObject({ status: "ok", model: "haiku" });
    expect(recommend(configs, 0)).toMatchObject({ status: "ok", model: "opus" });
    expect(recommend([...configs, { model: "new", effort: "low", runs: 2, passRate: 1, medianCostUSD: 0.01 }], 0.1))
      .toEqual({ status: "not enough trials", need: 3, short: ["new low"] });
    expect(recommend([], 0.1)).toEqual({ status: "no runs" });
  });

  test("combines a role's cases for configurations that ran all of them", () => {
    const records = [
      ...trials("haiku", "medium", 3, [0.1, 0.1, 0.1]), ...trials("haiku", "medium", 0, [0.2, 0.2, 0.2], { caseId: "c2" }),
      ...trials("opus", "high", 3, [1, 1, 1]), ...trials("opus", "high", 3, [2, 2, 2], { caseId: "c2" }),
      ...trials("sonnet", "high", 3, [0.5, 0.5, 0.5]),
    ];
    const [role] = aggregate(records, { margin: 0.1 }).roles;
    expect(role.overall.map((config) => [config.model, config.passRate, config.medianCostUSD])).toEqual([["haiku", 0.5, 0.30000000000000004], ["opus", 1, 3]]);
    expect(role.recommendation).toMatchObject({ status: "ok", model: "opus" });
    expect(role.cases[0].recommendation).toMatchObject({ status: "ok", model: "haiku" });
    expect(markdown(aggregate(records))).toContain("### All worker cases");
  });

  test("bench report writes Markdown and JSON to the state folder; too few trials say so", async () => {
    mkdirSync(join(scratch, "state", "bench"), { recursive: true });
    writeFileSync(join(scratch, "state", "bench", "results.jsonl"),
      `${[record("haiku", "medium", true, 0.1), record("opus", "high", true, 1)].map((r) => JSON.stringify(r)).join("\n")}\n`);
    const { code, out } = await capture(() => main(["bench", "report"]));
    expect(code).toBe(0);
    expect(out).toContain("| haiku medium | 100% | $0.100 | 1.0s | 1 | yes |");
    expect(out).toContain("Recommendation: not enough trials (need 3 per configuration");
    expect(readFileSync(join(scratch, "state", "bench", "report.md"), "utf8")).toBe(`${out}\n`);
    const json = await capture(() => main(["bench", "report", "--json", "--margin", "0.2"]));
    expect(JSON.parse(json.out)).toMatchObject({ margin: 0.2, runs: 2 });
    expect(JSON.parse(readFileSync(join(scratch, "state", "bench", "report.json"), "utf8")).runs).toBe(2);
  });

  test("median handles even and odd counts and missing values", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, null, 2, 3])).toBe(2.5);
    expect(median([null])).toBeNull();
  });
});

describe("add-from-commit", () => {
  const BROKEN = { "lib.sh": "echo 1\n", "test.sh": "[ \"$(sh lib.sh)\" = 1 ]\n" };
  const FIXED = { "lib.sh": "echo 2\n", "test.sh": "[ \"$(sh lib.sh)\" = 2 ]\n" };

  test("creates a case whose fixture is the parent and whose overlay is the commit's tests", async () => {
    const { repo, shas } = repoWith([BROKEN, "start"], [FIXED, "Return two\n\nCallers expect 2."]);
    const { benchCase } = await addFromCommit({ repo, sha: shas[1], tests: ["test.sh"], oracle: "sh test.sh", id: "two", casesDir });
    expect(benchCase).toMatchObject({ id: "two", role: "worker", title: "Return two", budgetUsd: 3 });
    expect(benchCase.fixture).toMatchObject({ type: "git", repo: realpathSync(repo), commit: shas[0], overlay: "overlay" });
    expect(benchCase.prompt).toBe(defaultPrompt("Return two", "Callers expect 2.\n", ["test.sh"]));
    expect(benchCase.prompt).toStartWith("Make the failing tests pass: Return two\n\nCallers expect 2.\n\nThe tests are test.sh.");
    expect(readFileSync(join(casesDir, "two", "overlay", "test.sh"), "utf8")).toBe(FIXED["test.sh"]);
    const dest = join(scratch, "check");
    materialize(benchCase, dest);
    expect(readFileSync(join(dest, "lib.sh"), "utf8")).toBe("echo 1\n");
    expect(await capture(() => main(["bench", "add-from-commit", "--cases", casesDir, "--repo", repo, "--sha", shas[1],
      "--tests", "test.sh", "--oracle", "sh test.sh", "--id", "two"]))).toMatchObject({ code: 1 });
  });

  test('stores repo "." when the repository holds the cases folder', async () => {
    const { repo, shas } = repoWith([BROKEN, "start"], [FIXED, "fix"]);
    const { benchCase } = await addFromCommit({ repo, sha: shas[1], tests: ["test.sh"], oracle: "sh test.sh", id: "dot", casesDir: join(repo, "cases"), prompt: "Fix it." });
    expect(benchCase.fixture.repo).toBe(".");
    expect(benchCase.prompt).toBe("Fix it.");
  });

  test("refuses a case whose oracle does not flip", async () => {
    const { repo, shas } = repoWith([FIXED, "start"], [{ "README.md": "docs\n" }, "Docs only"], [{ "lib.sh": "echo 3\n" }, "Break it"]);
    await expect(addFromCommit({ repo, sha: shas[1], tests: ["test.sh"], oracle: "sh test.sh", id: "passes-on-parent", casesDir }))
      .rejects.toThrow("it passes on the parent");
    await expect(addFromCommit({ repo, sha: shas[2], tests: ["test.sh"], oracle: "sh test.sh", id: "fails-on-commit", casesDir }))
      .rejects.toThrow("it fails on");
    const cli = await capture(() => main(["bench", "add-from-commit", "--cases", casesDir, "--repo", repo, "--sha", shas[1],
      "--tests", "test.sh", "--oracle", "sh test.sh", "--id", "cli"]));
    expect(cli.code).toBe(1);
    expect(cli.err).toContain("Refusing to create cli");
    expect(existsSync(casesDir) ? readdirSync(casesDir) : []).toEqual([]);
    await expect(addFromCommit({ repo, sha: shas[1], tests: ["missing.sh"], oracle: "true", id: "missing", casesDir })).rejects.toThrow("does not exist");
    await expect(addFromCommit({ repo, sha: shas[1], tests: ["../x"], oracle: "true", id: "outside", casesDir })).rejects.toThrow("relative");
  });
});
