import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../cli.js";
import { readJsonl } from "../../lib/state.js";
import { matrix } from "./cli.js";
import { CASES_FILE, aggregate, checkout, judgePrompt, judgeSchema, loadCases, markdown, parseConfigs, recipeOf, reviewPrompt, reviewSession, runOne, verdicts } from "./review.js";

const FAKE = join(import.meta.dir, "..", "..", "lib", "testing", "fake-claude.js");
const SCRIPT = join(import.meta.dir, "testing", "fake-review.js");
let scratch;
let repo;
let base;
let head;
const saved = {};
const setEnv = (values) => {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};
const git = (args, cwd = repo) => {
  const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
};

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "claude-factory-review-test-")));
  repo = join(scratch, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.js"), "export const a = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);
  base = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "a.js"), "export const a = 2;\nexport const b = a / 0;\n");
  git(["commit", "-q", "-am", "head"]);
  head = git(["rev-parse", "HEAD"]);
  git(["remote", "add", "origin", "https://example.invalid/repo.git"]);
  setEnv({
    CLAUDE_FACTORY_BIN: FAKE, CLAUDE_FACTORY_STATE: join(scratch, "state"), FAKE_CLAUDE_MODE: "script", FAKE_CLAUDE_SCRIPT: SCRIPT,
    FAKE_REVIEW_LOG: join(scratch, "sessions.jsonl"), FAKE_REVIEW_TEXT: "Findings:\n- divides by zero MATCH\n- naming",
    FAKE_REVIEW_RAN: undefined, FAKE_REVIEW_FAIL: undefined, FAKE_REVIEW_JUDGE_BAD: undefined, FAKE_CLAUDE_EFFORT: undefined,
    FAKE_REVIEW_LEVEL: undefined, FAKE_REVIEW_NO_SKILL: undefined,
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

async function capture(fn) {
  const out = [];
  const err = [];
  const { log, error } = console;
  console.log = (...args) => out.push(args.join(" "));
  console.error = (...args) => err.push(args.join(" "));
  try {
    const code = await fn();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    Object.assign(console, { log, error });
  }
}

const bugCase = () => ({ id: "divide", kind: "bug", base, head, answers: [{ file: "a.js", line: 2 }], bug: "b divides by zero, so it is Infinity." });
const cleanCase = () => ({ id: "tidy", kind: "clean", base, head });
const options = { model: "claude-opus-5-5", level: "xhigh", trial: 1, batch: "b", judgeModel: "claude-opus-5-5" };
const record = (fields) => ({ model: "claude-opus-5-5", level: "xhigh", trial: 1, infra: false, reviewCostUSD: 1, durationMs: 120_000, recipe: "r", ...fields });

describe("cases", () => {
  test("the shipped cases are valid: at least 8 bug and 8 clean cases", () => {
    const cases = loadCases(CASES_FILE);
    expect(cases.filter((c) => c.kind === "bug").length).toBeGreaterThanOrEqual(8);
    expect(cases.filter((c) => c.kind === "clean").length).toBeGreaterThanOrEqual(8);
  });

  test("loadCases refuses bad ids, kinds, SHAs and bug cases without an answer", () => {
    const file = join(scratch, "cases.json");
    const check = (cases) => {
      writeFileSync(file, JSON.stringify(cases));
      return () => loadCases(file);
    };
    expect(check([bugCase(), cleanCase()])().map((c) => c.id)).toEqual(["divide", "tidy"]);
    expect(check([cleanCase(), cleanCase()])).toThrow("id must be unique");
    expect(check([{ ...cleanCase(), kind: "other" }])).toThrow("kind must be bug or clean");
    expect(check([{ ...cleanCase(), head: "abc" }])).toThrow("full commit SHAs");
    expect(check([{ ...bugCase(), answers: [] }])).toThrow("needs answers");
    expect(check([{ ...bugCase(), bug: " " }])).toThrow("needs bug");
    expect(check([])).toThrow("non-empty list");
  });

  test("parseConfigs reads model and level pairs", () => {
    expect(parseConfigs("claude-opus-5-5:high, claude-haiku-5-5:xhigh")).toEqual([{ model: "claude-opus-5-5", level: "high" }, { model: "claude-haiku-5-5", level: "xhigh" }]);
    expect(() => parseConfigs("opus:high")).toThrow("expected a full model ID");
    expect(() => parseConfigs("claude-opus-5-5:ultra")).toThrow("expected a full model ID");
  });
});

describe("review", () => {
  test("checkout gives a detached head with no remote", async () => {
    const dir = join(scratch, "copy");
    await checkout(bugCase(), dir, repo);
    expect(git(["rev-parse", "HEAD"], dir)).toBe(head);
    expect(git(["remote"], dir)).toBe("");
    expect(git(["diff", "--stat", `${base}...${head}`], dir)).toContain("a.js");
  });

  test("the prompt, output, recipe and judge prompt", () => {
    expect(reviewPrompt(bugCase(), "max")).toContain(`the code-review skill with args "max ${base}...${head}"`);
    const assistant = (model, parent, content) => ({ type: "assistant", parent_tool_use_id: parent, message: { model, content } });
    const events = [
      assistant("claude-opus-5-5", null, [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "code-review", args: "xhigh a...b" } }]),
      { type: "user", parent_tool_use_id: "s1", message: { content: [{ type: "text", text: "`xhigh effort → 10 inline angles → sweep`" }] } },
      assistant("claude-opus-5-5", "s1", [{ type: "tool_use", id: "r1", name: "ReportFindings", input: { findings: [] } }]),
      assistant("claude-opus-5-5", "s1", [{ type: "text", text: "fork turn" }]),
      // A finder subagent of the fork and a Claude Code relay message count toward no model.
      assistant("claude-haiku-5-5", "agent-1", [{ type: "tool_use", id: "r2", name: "ReportFindings", input: { findings: ["not this"] } }]),
      { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "s1", content: [{ type: "text", text: 'Skill "code-review" completed (forked execution).\n\nResult:\n text ' }] }] } },
      assistant("<synthetic>", null, [{ type: "text", text: "(none)" }]),
      assistant("claude-opus-5-5", null, [{ type: "text", text: "done" }]),
    ];
    expect(recipeOf(events)).toBe("xhigh effort → 10 inline angles → sweep");
    expect(recipeOf([])).toBeNull();
    expect(reviewSession(events)).toEqual({ id: "s1", models: ["claude-opus-5-5"], output: 'text\n\nReportFindings: {"findings":[]}' });
    expect(reviewSession(events.filter((event) => event.parent_tool_use_id !== null || event.message.model !== "claude-opus-5-5"))).toBeNull();
    const plugin = [assistant("m", null, [{ type: "tool_use", id: "s2", name: "Skill", input: { skill: "review:code-review" } }]), { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "s2", content: "plain" }] } }];
    expect(reviewSession(plugin)).toEqual({ id: "s2", models: ["m"], output: "plain" });
    expect(judgePrompt(bugCase(), "out", "")).toContain("At: a.js:2");
    expect(judgePrompt(cleanCase(), "out", "x".repeat(70_000))).toContain("[diff cut at 60000 characters]");
    expect(judgeSchema("bug").properties.findings.items.properties.verdict.enum).toEqual(["matches", "other"]);
    expect(judgeSchema("clean").properties.findings.items.properties.verdict.enum).toEqual(["harmful", "unfounded", "valid"]);
  });

  test("verdicts counts each kind", () => {
    const found = (...list) => ({ findings: list.map((verdict) => ({ verdict })) });
    expect(verdicts(found("other", "matches"), "bug")).toEqual({ findings: 2, matched: true, harmful: null, unfounded: null, valid: null });
    expect(verdicts(found("harmful", "unfounded", "valid", "valid"), "clean")).toEqual({ findings: 4, matched: null, harmful: 1, unfounded: 1, valid: 2 });
    expect(() => verdicts({}, "bug")).toThrow("Judge answer");
  });

  test("runOne reviews the case's head, judges the findings and adds the costs", async () => {
    const result = await runOne(bugCase(), { ...options, repo });
    expect(result).toMatchObject({ caseId: "divide", kind: "bug", findings: 2, matched: true, recipe: "xhigh effort → test recipe", infra: false, error: null, effortObserved: "xhigh", modelObserved: "claude-opus-5-5" });
    expect(result.costUSD).toBeCloseTo(0.72);
    const [session] = readJsonl(process.env.FAKE_REVIEW_LOG);
    expect(session.stdin).toBe(reviewPrompt(bugCase(), "xhigh"));
    expect(session.head).toBe(head);
    expect(session.remotes).toBe("");
    expect(session.args).toContain("--settings");
    expect(existsSync(session.cwd)).toBe(false);

    setEnv({ FAKE_REVIEW_TEXT: "- MATCH breaks it\n- fine" });
    expect(await runOne(cleanCase(), { ...options, repo })).toMatchObject({ findings: 2, harmful: 1, valid: 1, unfounded: 0, matched: null });
  });

  test("runOne marks failed sessions, wrong configurations and bad judge answers as infra", async () => {
    setEnv({ FAKE_REVIEW_FAIL: "1" });
    expect(await runOne(bugCase(), { ...options, repo })).toMatchObject({ infra: true, findings: null, reviewCostUSD: 0.3 });
    setEnv({ FAKE_REVIEW_FAIL: undefined, FAKE_REVIEW_RAN: "claude-haiku-5-5" });
    expect((await runOne(bugCase(), { ...options, repo })).error).toContain("requested claude-opus-5-5 but the session ran claude-haiku-5-5");
    setEnv({ FAKE_REVIEW_RAN: undefined, FAKE_CLAUDE_EFFORT: "high" });
    expect((await runOne(bugCase(), { ...options, repo })).error).toContain("requested effort xhigh");
    setEnv({ FAKE_CLAUDE_EFFORT: undefined, FAKE_REVIEW_NO_SKILL: "1" });
    expect(await runOne(bugCase(), { ...options, repo })).toMatchObject({ infra: true, error: "the session did not call the code-review skill" });
    setEnv({ FAKE_REVIEW_NO_SKILL: undefined, FAKE_REVIEW_LEVEL: "high" });
    expect((await runOne(bugCase(), { ...options, repo })).error).toBe("requested level xhigh but the skill ran high effort → test recipe");
    setEnv({ FAKE_REVIEW_LEVEL: undefined, FAKE_REVIEW_JUDGE_BAD: "1" });
    const bad = await runOne(bugCase(), { ...options, repo });
    expect(bad).toMatchObject({ infra: true, findings: null });
    expect(bad.error).toContain("judge:");
  });
});

describe("report", () => {
  test("aggregate gives recall, findings, harmful rates, cost and time per configuration", () => {
    const summary = aggregate([
      record({ caseId: "b1", kind: "bug", findings: 3, matched: true }),
      record({ caseId: "b1", kind: "bug", findings: 1, matched: false, trial: 2 }),
      record({ caseId: "c1", kind: "clean", findings: 2, harmful: 1, unfounded: 1, valid: 0, reviewCostUSD: 3 }),
      record({ caseId: "c1", kind: "clean", findings: 0, harmful: 0, unfounded: 0, valid: 0, trial: 2, reviewCostUSD: 3 }),
      record({ caseId: "b1", kind: "bug", findings: 5, matched: true, level: "max" }),
      record({ caseId: "b1", kind: "bug", infra: true, findings: null }),
    ]);
    expect(summary.infra).toBe(1);
    expect(summary.configs["claude-opus-5-5 xhigh"]).toMatchObject({
      runs: 4, bugRuns: 2, cleanRuns: 2, minTrials: 2, recall: 0.5, findingsPerReview: 1.5,
      harmfulPerClean: 0.5, unfoundedPerClean: 0.5, cleanWithHarmful: 0.5, meanCostUSD: 2, meanMinutes: 2, recipes: ["r"],
    });
    expect(summary.configs["claude-opus-5-5 max"]).toMatchObject({ runs: 1, recall: 1, harmfulPerClean: null });
    const text = markdown(summary);
    expect(text).toContain("| claude-opus-5-5 xhigh | 4 | 2 | 50% | 1.5 | 0.50 | 50% | 0.50 | $2.00 | 2.0 |");
    expect(text).toContain("| b1 | found 1/1 | found 1/2 |");
    expect(text).toContain("| c1 | - | harmful 1 in 2 |");
    expect(text).toContain("1 infrastructure failures left out.");
    expect(markdown(aggregate([]))).toBe("Not measured: no usable runs.");
  });
});

describe("cli", () => {
  test("the matrix puts trials outermost and every configuration per case", () => {
    const jobs = matrix([bugCase(), cleanCase()], parseConfigs("claude-opus-5-5:high,claude-opus-5-5:max"), 2);
    expect(jobs.map((job) => `${job.trial}${job.benchCase.id}${job.level}`)).toEqual([
      "1dividehigh", "1dividemax", "1tidyhigh", "1tidymax", "2dividehigh", "2dividemax", "2tidyhigh", "2tidymax",
    ]);
    expect(jobs[1].budgetUsd).toBe(15.5);
  });

  test("run writes results and a report; report reads them back by batch", async () => {
    const file = join(scratch, "cases.json");
    writeFileSync(file, JSON.stringify([bugCase(), cleanCase()]));
    const ran = await capture(() => main(["bench", "review", "run", "--cases", file, "--repo", repo, "--configs", "claude-opus-5-5:high", "--trials", "1"]));
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("divide claude-opus-5-5 high trial 1: found the bug, 2 findings");
    expect(ran.out).toContain("tidy claude-opus-5-5 high trial 1: 1 harmful of 2 findings");
    const results = readJsonl(join(scratch, "state", "bench", "review", "results.jsonl"));
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.cliVersion === "9.9.9 (Claude Code)")).toBe(true);
    const reported = await capture(() => main(["bench", "review", "report", "--batch", results[0].batch]));
    expect(reported.out).toContain("| claude-opus-5-5 high | 2 | 1 | 100% |");
    expect(existsSync(join(scratch, "state", "bench", "review", "report.md"))).toBe(true);
  });

  test("run refuses bad configurations and cases; dry-run prints the worst case", async () => {
    expect((await capture(() => main(["bench", "review", "run", "--configs", "opus:high"]))).code).toBe(2);
    expect((await capture(() => main(["bench", "review", "run", "--case", "missing"]))).code).toBe(2);
    expect((await capture(() => main(["bench", "review", "run", "--judge-model", "opus"]))).code).toBe(2);
    const dry = await capture(() => main(["bench", "review", "run", "--dry-run", "--trials", "3"]));
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`${loadCases(CASES_FILE).length * 4 * 3} runs, worst case`);
    expect(existsSync(process.env.FAKE_REVIEW_LOG)).toBe(false);
  });
});
