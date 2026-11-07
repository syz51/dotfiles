// The report-style benchmark: does a plain-English rule for final reports keep their
// facts? Each case is a finished task's working notes plus a fact list written before any
// output was read. A run asks a tool-less session in the user's configuration for the
// final report, under the control (no rule) or the candidate (the rule in a project
// CLAUDE.md, where an instruction line is loaded the same way as from the user's). A
// blind judge then marks each fact kept or lost, and the report's sentences are measured.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCallError, judge, runTask } from "../../lib/claude.js";

export const CASES_FILE = join(import.meta.dir, "cases.json");
export const VARIANTS = ["control", "candidate"];
// The candidate rule from dotfiles-88; it deliberately does not name ASD-STE100, which
// lost about half the facts in the small study the task cites.
export const RULE = "Write reports in Simple Technical English: one fact or instruction per sentence, sentences under 20 words for steps and 25 for descriptions, active voice, one word for one meaning, a vertical list for complex text. Keep every fact, number and caveat.";
// A loss of at most 1 fact in 20 more than the control.
export const MAX_EXTRA_LOSS = 1 / 20;

const ID = /^[a-z0-9][a-z0-9-]*$/;
const strings = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim() !== "");

// Cases from cases.json, validated: id, title, task, notes and facts.
export function loadCases(file = CASES_FILE) {
  const cases = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(cases) || !cases.length) throw new Error(`${file}: expected a non-empty array of cases`);
  const seen = new Set();
  for (const [index, value] of cases.entries()) {
    const where = `${file}: case ${index + 1}`;
    if (!ID.test(value?.id ?? "")) throw new Error(`${where}: id must be lowercase letters, digits and dashes`);
    if (seen.has(value.id)) throw new Error(`${where}: duplicate id ${value.id}`);
    seen.add(value.id);
    for (const key of ["title", "task"]) if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`${where}: ${key} must be a non-empty string`);
    for (const key of ["notes", "facts"]) if (!strings(value[key])) throw new Error(`${where}: ${key} must be a non-empty list of strings`);
  }
  return cases;
}

export const reportPrompt = (benchCase) => [
  `You have finished this task: ${benchCase.task}`,
  "",
  "Your working notes:",
  ...benchCase.notes.map((note) => `- ${note}`),
  "",
  "Write your final report to the user now. It is the last message of the task; nothing else needs doing.",
].join("\n");

// Sentences and words of a report's prose: code blocks, table rows, headings and lines
// that are wholly bold (headings in effect) are left out; each remaining line ends a
// sentence, and so does ., ! or ? before a space and a capital, digit or opening mark.
// Fragments under 3 words, such as "capture: ok", are labels rather than sentences. List
// markers and emphasis do not count as words.
export const MIN_SENTENCE_WORDS = 3;
export function sentenceStats(text) {
  const sentences = [];
  for (const line of text.replace(/```[\s\S]*?```/g, "\n").split("\n")) {
    const prose = line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "");
    if (!prose || prose.startsWith("|") || prose.startsWith("#") || /^\*\*[^*]+\*\*:?$/.test(prose)) continue;
    for (const sentence of prose.split(/(?<=[.!?])\s+(?=[A-Z0-9`*"'(\[])/)) {
      const words = sentence.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
      if (words.length >= MIN_SENTENCE_WORDS) sentences.push(words.length);
    }
  }
  const words = sentences.reduce((sum, count) => sum + count, 0);
  return {
    sentences: sentences.length,
    words,
    meanWords: sentences.length ? words / sentences.length : 0,
    over25: sentences.filter((count) => count > 25).length,
    chars: text.length,
  };
}

export const JUDGE_SYSTEM = [
  "You check whether a report keeps the facts of a fixed list.",
  "A fact is kept when the report states it, in any wording, with every number, name, qualifier and caveat the fact includes.",
  "A fact is lost when the report leaves it out, or states it with a missing or changed number, name, qualifier or caveat.",
  "Judge each fact on its own. Do not reward style, length or extra content.",
].join(" ");

export const judgeSchema = (count) => ({
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array", minItems: count, maxItems: count,
      items: {
        type: "object", additionalProperties: false, required: ["index", "kept", "evidence"],
        properties: { index: { type: "integer", minimum: 1, maximum: count }, kept: { type: "boolean" }, evidence: { type: "string" } },
      },
    },
  },
});

export const judgePrompt = (report, facts) => [
  "Facts:",
  ...facts.map((fact, index) => `${index + 1}. ${fact}`),
  "",
  "Report:",
  "<report>",
  report,
  "</report>",
  "",
  "For each fact, by its number, say whether the report keeps it, quoting the report's words as evidence or saying what is missing.",
].join("\n");

// Kept flags in fact order; an answer that skips or repeats a fact is rejected.
export function keptFacts(output, count) {
  const kept = new Array(count).fill(null);
  for (const item of output?.facts ?? []) {
    if (!Number.isInteger(item?.index) || item.index < 1 || item.index > count || kept[item.index - 1] !== null || typeof item.kept !== "boolean")
      throw new Error("Judge answer does not mark each fact exactly once");
    kept[item.index - 1] = item.kept;
  }
  if (kept.includes(null)) throw new Error("Judge answer does not mark each fact exactly once");
  return kept;
}

// One report run and its judgement. Infrastructure failures (a failed session or judge
// call) are marked infra and left out of reports.
export async function runOne(benchCase, { variant, model, effort, judgeModel, trial, batch, budgetUsd, judgeBudgetUsd }) {
  const record = {
    batch, caseId: benchCase.id, variant, model, effort, judgeModel, trial, at: new Date().toISOString(),
    facts: benchCase.facts.length, kept: null, lost: [], stats: null, report: null,
    reportCostUSD: 0, judgeCostUSD: 0, costUSD: 0, error: null, infra: false,
  };
  // costUSD is the run's total, which the matrix's spending limit counts.
  const done = (fields = {}) => {
    const value = { ...record, ...fields };
    return { ...value, costUSD: value.reportCostUSD + value.judgeCostUSD };
  };
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "claude-factory-style-")));
  try {
    if (variant === "candidate") writeFileSync(join(cwd, "CLAUDE.md"), `# Reports\n\n- ${RULE}\n`);
    let task;
    try {
      // No tools: the report is written from the notes alone. No MCP servers, which would
      // add tools that --tools does not limit.
      task = await runTask({ prompt: reportPrompt(benchCase), cwd, model, effort, tools: [], strictMcp: true, budgetUsd, timeoutMs: 300_000, env: { TMPDIR: cwd, CLAUDE_CODE_TMPDIR: cwd } });
    } catch (error) {
      if (!(error instanceof ClaudeCallError)) throw error;
      return done({ reportCostUSD: error.costUSD ?? budgetUsd, error: `report session: ${error.message}`, infra: true });
    }
    record.reportCostUSD = task.costUSD;
    if (!task.ok || !task.finalText.trim()) return done({ error: `report session ended without a report${task.timedOut ? " (timed out)" : ""}`, infra: true });
    record.report = task.finalText;
    record.stats = sentenceStats(task.finalText);
    try {
      const verdict = await judge({ prompt: judgePrompt(task.finalText, benchCase.facts), system: JUDGE_SYSTEM, schema: judgeSchema(benchCase.facts.length), model: judgeModel, effort: "medium", budgetUsd: judgeBudgetUsd });
      record.judgeCostUSD = verdict.costUSD;
      const kept = keptFacts(verdict.output, benchCase.facts.length);
      record.kept = kept.filter(Boolean).length;
      record.lost = kept.flatMap((flag, index) => (flag ? [] : [index + 1]));
    } catch (error) {
      if (!(error instanceof ClaudeCallError) && !/^Judge answer/.test(error.message)) throw error;
      return done({ judgeCostUSD: record.judgeCostUSD || (error.costUSD ?? judgeBudgetUsd), error: `judge: ${error.message}`, infra: true });
    }
    return done();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Per-variant totals over the usable records, and the decision: adopt when the
// candidate's loss rate is at most the control's plus 1 in 20, and its sentences are
// shorter on average. Trials counts complete runs per case.
export function aggregate(records) {
  const usable = records.filter((record) => !record.infra && record.kept !== null);
  const variants = {};
  for (const variant of VARIANTS) {
    const runs = usable.filter((record) => record.variant === variant);
    const facts = runs.reduce((sum, record) => sum + record.facts, 0);
    const kept = runs.reduce((sum, record) => sum + record.kept, 0);
    const sentences = runs.reduce((sum, record) => sum + record.stats.sentences, 0);
    const words = runs.reduce((sum, record) => sum + record.stats.words, 0);
    const perCase = {};
    for (const record of runs) (perCase[record.caseId] ??= []).push(record);
    variants[variant] = {
      runs: runs.length,
      minTrials: Object.keys(perCase).length ? Math.min(...Object.values(perCase).map((list) => list.length)) : 0,
      facts, kept, lossRate: facts ? (facts - kept) / facts : null,
      meanWords: sentences ? words / sentences : null,
      over25Share: sentences ? runs.reduce((sum, record) => sum + record.stats.over25, 0) / sentences : null,
      meanChars: runs.length ? runs.reduce((sum, record) => sum + record.stats.chars, 0) / runs.length : null,
      costUSD: runs.reduce((sum, record) => sum + record.costUSD, 0),
      perCase: Object.fromEntries(Object.entries(perCase).map(([id, list]) => [id, {
        runs: list.length, kept: list.reduce((sum, record) => sum + record.kept, 0), facts: list.reduce((sum, record) => sum + record.facts, 0),
        meanWords: (() => {
          const s = list.reduce((sum, record) => sum + record.stats.sentences, 0);
          return s ? list.reduce((sum, record) => sum + record.stats.words, 0) / s : null;
        })(),
      }])),
    };
  }
  const { control, candidate } = variants;
  const measured = control.runs && candidate.runs;
  const extraLoss = measured ? candidate.lossRate - control.lossRate : null;
  const keepsFacts = measured ? extraLoss <= MAX_EXTRA_LOSS + 1e-9 : null;
  const shorter = measured ? candidate.meanWords < control.meanWords : null;
  return {
    variants, extraLoss, keepsFacts, shorter,
    adopt: measured ? keepsFacts && shorter : null,
    infra: records.length - usable.length,
  };
}

const percent = (value) => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
const fixed = (value, digits = 1) => (value === null ? "-" : value.toFixed(digits));

export function markdown(summary) {
  const lines = [
    "| Variant | Runs | Min trials per case | Facts kept | Loss rate | Mean words per sentence | Sentences over 25 words | Mean characters | Cost |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [name, v] of Object.entries(summary.variants))
    lines.push(`| ${name} | ${v.runs} | ${v.minTrials} | ${v.kept}/${v.facts} | ${percent(v.lossRate)} | ${fixed(v.meanWords)} | ${percent(v.over25Share)} | ${fixed(v.meanChars, 0)} | $${v.costUSD.toFixed(2)} |`);
  lines.push("", "| Case | Control kept | Candidate kept | Control words per sentence | Candidate words per sentence |", "|---|---|---|---|---|");
  const ids = [...new Set(Object.values(summary.variants).flatMap((v) => Object.keys(v.perCase)))].sort();
  for (const id of ids) {
    const c = summary.variants.control.perCase[id];
    const d = summary.variants.candidate.perCase[id];
    lines.push(`| ${id} | ${c ? `${c.kept}/${c.facts}` : "-"} | ${d ? `${d.kept}/${d.facts}` : "-"} | ${fixed(c?.meanWords ?? null)} | ${fixed(d?.meanWords ?? null)} |`);
  }
  lines.push("");
  if (summary.adopt === null) lines.push("Not measured: a variant has no usable runs.");
  else lines.push(
    `Extra loss versus control: ${percent(summary.extraLoss)} (limit ${percent(MAX_EXTRA_LOSS)}); ${summary.keepsFacts ? "keeps" : "loses"} facts; sentences ${summary.shorter ? "shorter" : "not shorter"}.`,
    `Decision: ${summary.adopt ? "adopt" : "do not adopt"} the rule.`,
  );
  if (summary.infra) lines.push(`${summary.infra} infrastructure failures left out.`);
  return lines.join("\n");
}
