// The scoring rubric (rubric.json): detector and judge dimensions, each tied to the
// `## Heading` of claude/CLAUDE.md it tests, the judge's JSON schema and the validation
// of its answers. Bump rubric.json's version whenever a dimension's meaning or the judge's
// prompt changes (score.js judgeParts, or how judge() passes it), so sessions get scored
// again: proposals count only records of the current version, and judgements from another
// prompt are not comparable.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
export const GLOBAL_INSTRUCTIONS = join(REPO_ROOT, "claude", "CLAUDE.md");
// Rules that few turns need, which the global instructions point at and sessions read on need.
export const REFERENCE_DIR = join(REPO_ROOT, "claude", "reference");

export const RUBRIC = JSON.parse(readFileSync(join(import.meta.dir, "rubric.json"), "utf8"));

export const detectorDimensions = (rubric = RUBRIC) => rubric.dimensions.filter((dimension) => dimension.kind === "detector");
export const judgeDimensions = (rubric = RUBRIC) => rubric.dimensions.filter((dimension) => dimension.kind === "judge");

// Text of one `## Heading` section of a CLAUDE.md, or null when it has none.
export function section(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## ${escaped}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(text)?.[1].trim() ?? null;
}

// The structured output the judge must return.
export function judgeSchema(rubric = RUBRIC) {
  const dimensions = judgeDimensions(rubric);
  const verdict = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "evidence"],
    properties: {
      verdict: { type: "string", enum: rubric.verdicts },
      evidence: { type: "string", description: "Event labels such as [P2] or [T14] and a short quote; why this verdict." },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["dimensions", "corrections", "summary"],
    properties: {
      summary: { type: "string", description: "Two sentences: what the session was about and how the agent did." },
      dimensions: {
        type: "object",
        additionalProperties: false,
        required: dimensions.map((dimension) => dimension.id),
        properties: Object.fromEntries(dimensions.map((dimension) => [dimension.id, verdict])),
      },
      corrections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["prompt", "quote", "cause", "explanation"],
          properties: {
            prompt: { type: "string", description: "Label of the correcting prompt, such as P3." },
            quote: { type: "string" },
            cause: { type: "string", enum: rubric.correctionCauses },
            explanation: { type: "string", description: "What the agent got wrong, and the rule involved if any." },
          },
        },
      },
    },
  };
}

const isText = (value) => typeof value === "string";

// The judge's answer checked against the rubric: { ok: true, value } or { ok: false, error }.
// The CLI enforces the schema too, but its output is still external data.
export function validateJudgement(output, rubric = RUBRIC) {
  const fail = (error) => ({ ok: false, error });
  if (!output || typeof output !== "object" || Array.isArray(output)) return fail("answer is not an object");
  const { dimensions, corrections, summary } = output;
  if (!dimensions || typeof dimensions !== "object") return fail("dimensions missing");
  if (!Array.isArray(corrections)) return fail("corrections missing");
  const value = { summary: isText(summary) ? summary : "", dimensions: {}, corrections: [] };
  for (const { id } of judgeDimensions(rubric)) {
    const answer = dimensions[id];
    if (!answer || typeof answer !== "object") return fail(`dimension ${id} missing`);
    if (!rubric.verdicts.includes(answer.verdict)) return fail(`dimension ${id} has verdict ${JSON.stringify(answer.verdict)}`);
    if (!isText(answer.evidence) || (answer.verdict === "fail" && !answer.evidence.trim())) return fail(`dimension ${id} has no evidence`);
    value.dimensions[id] = { verdict: answer.verdict, evidence: answer.evidence };
  }
  const unknown = Object.keys(dimensions).filter((id) => !(id in value.dimensions));
  if (unknown.length) return fail(`unknown dimensions ${unknown.join(", ")}`);
  for (const [index, correction] of corrections.entries()) {
    if (!correction || !rubric.correctionCauses.includes(correction.cause)) return fail(`correction ${index + 1} has cause ${JSON.stringify(correction?.cause)}`);
    value.corrections.push({
      prompt: isText(correction.prompt) ? correction.prompt : "",
      quote: isText(correction.quote) ? correction.quote : "",
      cause: correction.cause,
      explanation: isText(correction.explanation) ? correction.explanation : "",
    });
  }
  const userCorrections = value.dimensions["user-corrections"];
  if (userCorrections?.verdict === "fail" && !value.corrections.some((correction) => correction.cause !== "changed-requirements"))
    return fail("user-corrections fails without a correction other than changed-requirements");
  return { ok: true, value };
}
