import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../cli.js";
import { readJsonl } from "../../lib/state.js";
import { matrix } from "./cli.js";
import { CASES_FILE, RULE, aggregate, judgePrompt, judgeSchema, keptFacts, loadCases, markdown, reportPrompt, runOne, sentenceStats } from "./style.js";

const FAKE = join(import.meta.dir, "..", "..", "lib", "testing", "fake-claude.js");
const SCRIPT = join(import.meta.dir, "testing", "fake-style.js");
let scratch;
const saved = {};
const setEnv = (values) => {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "claude-factory-style-test-")));
  setEnv({
    CLAUDE_FACTORY_BIN: FAKE, CLAUDE_FACTORY_STATE: join(scratch, "state"), FAKE_CLAUDE_MODE: "script", FAKE_CLAUDE_SCRIPT: SCRIPT,
    FAKE_STYLE_LOG: join(scratch, "sessions.jsonl"),     FAKE_STYLE_TEXT: "The job failed because the evidence stage retried four new notes. The deploy worked.",
    FAKE_STYLE_RULE_TEXT: "The job failed. The deploy worked. LOSE marker here.",
    FAKE_STYLE_LOST: undefined, FAKE_STYLE_FAIL: undefined, FAKE_STYLE_JUDGE_BAD: undefined,
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

const CASE = { id: "one", title: "One", task: "Do one thing.", notes: ["did it", "checked it"], facts: ["It was done.", "It was checked.", "Nothing is left."] };
const options = { model: "claude-opus-5-5", effort: "high", judgeModel: "claude-haiku-5-5", trial: 1, batch: "b", budgetUsd: 1, judgeBudgetUsd: 0.5 };
const record = (variant, caseId, kept, facts, sentences, words, extra = {}) =>
  ({ variant, caseId, kept, facts, stats: { sentences, words, over25: 0, chars: 100 }, costUSD: 0.1, infra: false, ...extra });

describe("cases", () => {
  test("the shipped cases are valid and each keeps 6 to 12 facts", () => {
    const cases = loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(cases.length).toBeLessThanOrEqual(10);
    for (const benchCase of cases) {
      expect(benchCase.facts.length).toBeGreaterThanOrEqual(6);
      expect(benchCase.facts.length).toBeLessThanOrEqual(12);
    }
  });

  test("validation names the file and the problem", () => {
    const file = join(scratch, "cases.json");
    writeFileSync(file, JSON.stringify([CASE, { ...CASE }]));
    expect(() => loadCases(file)).toThrow(`${file}: case 2: duplicate id one`);
    writeFileSync(file, JSON.stringify([{ ...CASE, facts: [] }]));
    expect(() => loadCases(file)).toThrow("facts must be a non-empty list of strings");
    writeFileSync(file, JSON.stringify([{ ...CASE, id: "Bad Id" }]));
    expect(() => loadCases(file)).toThrow("id must be lowercase");
  });

  test("the report prompt holds the task and every note, and never the facts", () => {
    const prompt = reportPrompt(CASE);
    expect(prompt).toContain("Do one thing.");
    for (const note of CASE.notes) expect(prompt).toContain(`- ${note}`);
    for (const fact of CASE.facts) expect(prompt).not.toContain(fact);
  });
});

describe("sentence meter", () => {
  test("counts prose sentences and leaves out code, tables, headings, bold labels and short fragments", () => {
    const text = [
      "# Heading words that are not prose",
      "**08:00 run of the job:**",
      "The deploy worked end to end. The evidence stage failed because it retried four notes.",
      "",
      "| Stage | Result |",
      "|---|---|",
      "- capture: ok",
      "- The next hourly run should pick the notes up",
      "1. Check the 09:00 run.",
      "```",
      "a code line with many words that must not count at all here",
      "```",
    ].join("\n");
    const stats = sentenceStats(text);
    expect(stats.sentences).toBe(4);
    expect(stats.words).toBe(6 + 9 + 9 + 4);
    expect(stats.meanWords).toBeCloseTo(28 / 4);
    expect(stats.chars).toBe(text.length);
  });

  test("counts sentences over 25 words", () => {
    const long = `${Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ")}.`;
    expect(sentenceStats(`${long} Short one here.`).over25).toBe(1);
  });
});

describe("judge", () => {
  test("the schema asks for exactly one verdict per fact and the prompt numbers the facts", () => {
    const schema = judgeSchema(3);
    expect(schema.properties.facts.minItems).toBe(3);
    expect(schema.properties.facts.maxItems).toBe(3);
    const prompt = judgePrompt("the report", CASE.facts);
    expect(prompt).toContain("2. It was checked.");
    expect(prompt).toContain("<report>\nthe report\n</report>");
  });

  test("an answer must mark each fact exactly once", () => {
    expect(keptFacts({ facts: [{ index: 2, kept: false }, { index: 1, kept: true }] }, 2)).toEqual([true, false]);
    expect(() => keptFacts({ facts: [{ index: 1, kept: true }, { index: 1, kept: false }] }, 2)).toThrow("exactly once");
    expect(() => keptFacts({ facts: [{ index: 1, kept: true }] }, 2)).toThrow("exactly once");
    expect(() => keptFacts({ facts: [{ index: 3, kept: true }, { index: 1, kept: true }] }, 2)).toThrow("exactly once");
  });
});

describe("runOne", () => {
  test("the candidate gets the rule in a project CLAUDE.md and the control none, with no tools or MCP servers", async () => {
    const control = await runOne(CASE, { ...options, variant: "control" });
    const candidate = await runOne(CASE, { ...options, variant: "candidate" });
    const [first, second] = readJsonl(process.env.FAKE_STYLE_LOG);
    expect(first.claudeMd).toBeNull();
    expect(second.claudeMd).toContain(RULE);
    for (const call of [first, second]) {
      expect(call.args).toContain("--strict-mcp-config");
      expect(call.args[call.args.indexOf("--tools") + 1]).toBe("");
      expect(call.args[call.args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
      expect(call.args[call.args.indexOf("--effort") + 1]).toBe("high");
      expect(call.stdin).toBe(reportPrompt(CASE));
      expect(existsSync(call.cwd)).toBe(false);
    }
    expect(control).toMatchObject({ variant: "control", kept: 3, lost: [], infra: false, reportCostUSD: 0.05, judgeCostUSD: 0.01 });
    expect(control.costUSD).toBeCloseTo(0.06);
    expect(control.stats.sentences).toBe(2);
  });

  test("the judge's lost facts are recorded by number", async () => {
    setEnv({ FAKE_STYLE_LOST: "2,3" });
    const result = await runOne(CASE, { ...options, variant: "candidate" });
    expect(result).toMatchObject({ kept: 1, lost: [2, 3], facts: 3, infra: false });
  });

  test("a failed report session or a bad judge answer is infra, with its cost", async () => {
    setEnv({ FAKE_STYLE_FAIL: "1" });
    const failed = await runOne(CASE, { ...options, variant: "control" });
    expect(failed).toMatchObject({ infra: true, kept: null, reportCostUSD: 0.02 });
    expect(failed.error).toContain("without a report");
    setEnv({ FAKE_STYLE_FAIL: undefined, FAKE_STYLE_JUDGE_BAD: "1" });
    const bad = await runOne(CASE, { ...options, variant: "control" });
    expect(bad).toMatchObject({ infra: true, kept: null });
    expect(bad.error).toContain("judge: Judge answer");
    expect(bad.costUSD).toBeCloseTo(0.06);
  });
});

describe("aggregate", () => {
  test("adopts when the candidate loses at most 1 fact in 20 more and writes shorter sentences", () => {
    const summary = aggregate([
      record("control", "a", 20, 20, 10, 200), record("candidate", "a", 19, 20, 10, 120),
      record("control", "a", 20, 20, 10, 200), record("candidate", "a", 20, 20, 10, 120),
      record("control", "b", 0, 0, 0, 0, { infra: true, kept: null }),
    ]);
    expect(summary.variants.control).toMatchObject({ runs: 2, minTrials: 2, facts: 40, kept: 40, lossRate: 0, meanWords: 20 });
    expect(summary.variants.candidate).toMatchObject({ kept: 39, meanWords: 12 });
    expect(summary.extraLoss).toBeCloseTo(1 / 40);
    expect(summary).toMatchObject({ keepsFacts: true, shorter: true, adopt: true, infra: 1 });
    expect(markdown(summary)).toContain("Decision: adopt the rule.");
  });

  test("rejects a rule that loses more than 1 fact in 20, or does not shorten sentences", () => {
    const losing = aggregate([record("control", "a", 20, 20, 10, 200), record("candidate", "a", 18, 20, 10, 100)]);
    expect(losing).toMatchObject({ keepsFacts: false, adopt: false });
    expect(markdown(losing)).toContain("Decision: do not adopt the rule.");
    const longer = aggregate([record("control", "a", 20, 20, 10, 100), record("candidate", "a", 20, 20, 10, 120)]);
    expect(longer).toMatchObject({ keepsFacts: true, shorter: false, adopt: false });
  });

  test("a variant without usable runs leaves the decision open", () => {
    const summary = aggregate([record("control", "a", 20, 20, 10, 100)]);
    expect(summary.adopt).toBeNull();
    expect(markdown(summary)).toContain("Not measured");
  });
});

describe("cli", () => {
  test("the matrix puts trials outermost and both variants per case", () => {
    const jobs = matrix([CASE, { ...CASE, id: "two" }], ["control", "candidate"], 2);
    expect(jobs.map((job) => `${job.trial}${job.benchCase.id}${job.variant}`)).toEqual([
      "1onecontrol", "1onecandidate", "1twocontrol", "1twocandidate", "2onecontrol", "2onecandidate", "2twocontrol", "2twocandidate",
    ]);
    expect(jobs[0].budgetUsd).toBe(1.5);
  });

  test("run writes results and a decision; report reads them back by batch", async () => {
    const file = join(scratch, "cases.json");
    writeFileSync(file, JSON.stringify([CASE]));
    const ran = await capture(() => main(["bench", "style", "run", "--cases", file, "--trials", "2", "--parallel", "2"]));
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("Decision: adopt the rule.");
    const results = readJsonl(join(scratch, "state", "bench", "style", "results.jsonl"));
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.cliVersion === "9.9.9 (Claude Code)")).toBe(true);
    const reported = await capture(() => main(["bench", "style", "report", "--batch", results[0].batch]));
    expect(reported.code).toBe(0);
    expect(reported.out).toContain("| control | 2 | 2 | 6/6 |");
    expect(existsSync(join(scratch, "state", "bench", "style", "report.md"))).toBe(true);
    const none = await capture(() => main(["bench", "style", "report", "--batch", "missing"]));
    expect(none.out).toContain("Not measured");
  });

  test("run refuses unknown variants, cases and model IDs; dry-run prints the worst case", async () => {
    expect((await capture(() => main(["bench", "style", "run", "--variants", "other"]))).code).toBe(2);
    expect((await capture(() => main(["bench", "style", "run", "--case", "missing"]))).code).toBe(2);
    expect((await capture(() => main(["bench", "style", "run", "--model", "opus"]))).code).toBe(2);
    const dry = await capture(() => main(["bench", "style", "run", "--dry-run", "--trials", "3"]));
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`${loadCases(CASES_FILE).length * 2 * 3} runs, worst case`);
    expect(readJsonl(process.env.FAKE_STYLE_LOG)).toHaveLength(0);
  });
});
