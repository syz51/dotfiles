// The judge council: Claude models score screenshots of several designs against the rubric.
// Judges see designs only as "Design N", in an order shuffled per call, so they cannot tell
// which version is the main branch, which is the candidate, or that a climb is running. The
// prompts never name the round, target or pass bar. A call holds every version at once, so
// scores are comparative, and reference products anchor the scale. Overall scores are the
// mean of the categories, computed here, not asked of the judge.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { judge as callJudge } from "../lib/claude.js";
import { IMAGE_TYPES } from "./config.js";

const RUBRIC_TEXT = readFileSync(join(import.meta.dir, "rubric.json"), "utf8");
export const RUBRIC = JSON.parse(RUBRIC_TEXT);
export const AVOID_FILE = () => process.env.CLAUDE_FACTORY_AVOID || join(homedir(), ".claude", "frontend-avoid.md");
const SEVERITY = { high: 3, medium: 2, low: 1 };
// The API's limits on a request: 32 MB in all, with headroom here for the prompts and the
// JSON around the images, and 5 MB per base64 image.
export const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Used when a judge has no calibration yet; flagged wherever it is used.
export const DEFAULT_NOISE = { sigmaCategory: 0.5, sigmaOverall: 0.25, calibrated: false };

export const judgeKey = (judge) => `${judge.model}@${judge.effort}`;

// The patterns the owner declined as defaults: the list items under "## Patterns".
export function avoidList(file = AVOID_FILE()) {
  if (!existsSync(file)) return [];
  const [, section = ""] = readFileSync(file, "utf8").split(/^## Patterns\s*$/m);
  return section.split(/^## /m)[0].split("\n").map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim()).filter(Boolean);
}

// A deterministic shuffle: mulberry32 seeded from a string.
export function shuffle(items, seed) {
  let state = [...seed].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function systemPrompt(config, avoid = avoidList()) {
  const lines = [
    "You are a senior product designer reviewing screenshots of web interfaces. Score each design you are shown against the rubric below, and name the problems a strong designer would fix first.",
    "",
    "Scale (use half points between the anchors when they fit better):",
    ...RUBRIC.scale.map(([score, meaning]) => `- ${score}: ${meaning}`),
    "",
    "Categories:",
    ...RUBRIC.categories.map((category) => `- ${category.id} (${category.name}): ${category.description}${category.needsNarrow ? " Score it only for a design that includes phone-width screenshots; otherwise give null." : ""}`),
    "",
    "How to judge:",
    "- Use the whole scale. Most real products are a 6 to 8; reserve 9 and 10 for work you would hold up as an example.",
    "- Judge the visual and interaction design, not the content or data on screen, and not the features a product has.",
    "- Score each design on its own merits. Do not assume any design is newer or older, finished or unfinished, or related to any other.",
    "- Every issue names one screen, using the identifier in brackets from that screenshot's caption, and a concrete fix a developer could apply.",
    "- Keep issues specific and visible in the screenshots; do not guess at what is not shown.",
  ];
  const taste = [...config.taste, ...avoid];
  if (taste.length) lines.push("", "The product owner's preferences, which count toward the scores of the product's designs:", ...taste.map((item) => `- ${item}`));
  lines.push("", `The product: ${config.product}`);
  return lines.join("\n");
}

export function outputSchema() {
  const scores = Object.fromEntries(RUBRIC.categories.map((category) => [category.id, { type: ["number", "null"], minimum: 1, maximum: 10 }]));
  return {
    type: "object",
    additionalProperties: false,
    required: ["designs", "issues", "strengths"],
    properties: {
      designs: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["design", "scores", "summary"],
          properties: {
            design: { type: "integer", minimum: 1 },
            scores: { type: "object", additionalProperties: false, required: Object.keys(scores), properties: scores },
            summary: { type: "string" },
          },
        },
      },
      issues: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["design", "screen", "category", "severity", "problem", "fix"],
          properties: {
            design: { type: "integer", minimum: 1 },
            screen: { type: "string" },
            category: { type: "string", enum: RUBRIC.categories.map((category) => category.id) },
            severity: { type: "string", enum: Object.keys(SEVERITY) },
            problem: { type: "string" },
            fix: { type: "string" },
          },
        },
      },
      strengths: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["design", "text"], properties: { design: { type: "integer", minimum: 1 }, text: { type: "string" } } },
      },
    },
  };
}

const describeView = (shot) => `${shot.view.startsWith("phone") || shot.narrow ? "phone" : shot.view.split("-")[0]}, ${shot.scheme}, ${shot.width}×${shot.height}`;
// What a judge sees as a shot's identifier: the screen for the product, the view for a reference.
const shotLabel = (shot) => (shot.screen ? `${shot.screen}.${shot.view}` : shot.view);

// Every screenshot of versions as an image source, read and encoded once: Map<file, source>.
export function encodeImages(versions) {
  const images = new Map();
  for (const version of versions)
    for (const shot of version.shots)
      if (!images.has(shot.file))
        images.set(shot.file, {
          type: "base64",
          media_type: IMAGE_TYPES[extname(shot.file).toLowerCase()] ?? "image/png",
          data: readFileSync(shot.file).toString("base64"),
        });
  return images;
}

// The content blocks of one call. versions: [{ key, kind: "product" | "reference", title,
// shots: [{ id, file, screen?, title, view, scheme, width, height, narrow }] }], already
// in the order they are labeled; images from encodeImages. Returns { content, labels:
// Map<design number, key> }.
export function buildContent(versions, images = encodeImages(versions)) {
  const product = versions.flatMap((version, index) => (version.kind === "product" ? [index + 1] : []));
  const others = versions.flatMap((version, index) => (version.kind === "reference" ? [index + 1] : []));
  const intro = [
    `You will see ${versions.length} designs, numbered 1 to ${versions.length}.`,
    `${product.length > 1 ? `Designs ${product.join(", ")} are versions` : `Design ${product[0]} is a version`} of the product under review.`,
    others.length ? `${others.length > 1 ? `Designs ${others.join(", ")} are other products` : `Design ${others[0]} is another product`}, shown so your scores use the same scale across products; score ${others.length > 1 ? "them" : "it"} too.` : "",
    "Each screenshot's caption gives its design number, the screen, its identifier in brackets, and the viewport.",
    `Score every design exactly once, in "designs". List up to 8 issues per design, most important first, in "issues", and up to 3 strengths per design in "strengths".`,
  ].filter(Boolean).join(" ");
  const content = [{ type: "text", text: intro }];
  const labels = new Map();
  versions.forEach((version, index) => {
    const number = index + 1;
    labels.set(number, version.key);
    content.push({ type: "text", text: `Design ${number}${version.kind === "reference" ? ` (${version.title})` : ""}: ${version.shots.length} screenshot${version.shots.length > 1 ? "s" : ""}.` });
    for (const shot of version.shots) {
      content.push({ type: "text", text: `Design ${number} · ${shot.title} · [${shotLabel(shot)}] · ${describeView(shot)}` });
      content.push({ type: "image", source: images.get(shot.file) });
    }
  });
  content.push({ type: "text", text: `Now score the ${versions.length} designs.` });
  return { content, labels };
}

// What the judges are asked, as a short hash: the rubric's text, the system prompt, the
// output schema and the framing of a call. A run is tied to it, so a change to how the
// judges are asked starts a new run instead of mixing two ways of judging in one.
export function councilVersion() {
  const shot = { id: "s", file: "s", screen: "s", title: "S", view: "desktop-light", scheme: "light", width: 1, height: 1 };
  const versions = [{ key: "a", kind: "product", shots: [shot] }, { key: "b", kind: "product", shots: [shot] }, { key: "r", kind: "reference", title: "R", shots: [shot] }];
  const framing = buildContent(versions, new Map()).content.filter((block) => block.type === "text").map((block) => block.text);
  return createHash("sha256").update(JSON.stringify([RUBRIC_TEXT, systemPrompt({ taste: [], product: "" }, []), outputSchema(), framing])).digest("hex").slice(0, 12);
}

export class JudgeOutputError extends Error {}
// A judge that could not produce a usable answer; its calls' cost is already spent.
export class JudgeFailedError extends Error {}

// Checks a call's output against the designs it was shown and maps it back to versions.
// Returns { scores: { key: { category: number|null } }, overall: { key: number }, issues, strengths, summaries }.
export function readOutput(output, labels, versions) {
  const byKey = new Map(versions.map((version) => [version.key, version]));
  const seen = new Set();
  const scores = {};
  const summaries = {};
  for (const entry of output.designs ?? []) {
    const key = labels.get(entry.design);
    if (!key) throw new JudgeOutputError(`scored Design ${entry.design}, which was not shown`);
    if (seen.has(entry.design)) throw new JudgeOutputError(`scored Design ${entry.design} twice`);
    seen.add(entry.design);
    const version = byKey.get(key);
    const narrow = version.shots.some((shot) => shot.narrow);
    scores[key] = {};
    for (const category of RUBRIC.categories) {
      const value = entry.scores?.[category.id];
      const optional = category.needsNarrow && (!narrow || version.kind === "reference");
      if (value === null || value === undefined) {
        if (!optional) throw new JudgeOutputError(`gave Design ${entry.design} no ${category.id} score`);
        scores[key][category.id] = null;
      } else if (typeof value !== "number" || value < 1 || value > 10) {
        throw new JudgeOutputError(`gave Design ${entry.design} a ${category.id} score of ${value}, outside 1 to 10`);
      } else {
        // A reference's phone score is not comparable unless every reference shows phones.
        scores[key][category.id] = category.needsNarrow && !narrow ? null : value;
      }
    }
    summaries[key] = String(entry.summary ?? "");
  }
  if (seen.size !== labels.size) throw new JudgeOutputError(`scored ${seen.size} of ${labels.size} designs`);
  const overall = Object.fromEntries(Object.entries(scores).map(([key, values]) => [key, mean(Object.values(values).filter((value) => value !== null))]));
  const known = (design) => labels.get(design);
  const issues = (output.issues ?? []).filter((issue) => known(issue.design)).map((issue) => ({ ...issue, version: known(issue.design) }));
  const strengths = (output.strengths ?? []).filter((item) => known(item.design)).map((item) => ({ ...item, version: known(item.design) }));
  return { scores, overall, issues, strengths, summaries };
}

export const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
export const variance = (values) => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
};

// One judge's samples combined: the mean score per version and category, and overall.
export function combine(samples) {
  const keys = Object.keys(samples[0].scores);
  const scores = {};
  const overall = {};
  for (const key of keys) {
    scores[key] = {};
    for (const category of RUBRIC.categories) {
      const values = samples.map((sample) => sample.scores[key][category.id]).filter((value) => value !== null);
      scores[key][category.id] = values.length ? mean(values) : null;
    }
    overall[key] = mean(samples.map((sample) => sample.overall[key]));
  }
  return { scores, overall };
}

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// Checks that a call carrying images fits the API's request limits, before any is made.
export function checkRequestSize(images) {
  let total = 0;
  for (const [file, source] of images) {
    if (source.data.length > MAX_IMAGE_BYTES)
      throw new JudgeFailedError(`${file} is ${megabytes(source.data.length)} encoded, over the API's ${megabytes(MAX_IMAGE_BYTES)} limit per image: use a smaller viewport or reference image`);
    total += source.data.length;
  }
  if (total > MAX_REQUEST_BYTES)
    throw new JudgeFailedError(`a judge call would carry ${megabytes(total)} of screenshots, over the ${megabytes(MAX_REQUEST_BYTES)} that fits one request: capture fewer screens, views or references`);
}

// Runs one judge: samples calls in parallel, each with its own order of the designs. A
// call that fails or whose output does not fit is retried once, when room() (the money
// left for this judge) covers the retry beside the calls still running. budgetUsd caps
// each call; spend(usd) reports each call's cost.
export async function runJudge({ judge, versions, config, seed, budgetUsd, spend, room = () => Infinity, call = callJudge, avoid }) {
  const system = systemPrompt(config, avoid);
  const schema = outputSchema();
  const images = encodeImages(versions);
  checkRequestSize(images);
  let running = 0;
  const sample = async (index) => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && room() < (running + 1) * budgetUsd)
        throw new JudgeFailedError(`${judgeKey(judge)} sample ${index + 1} failed, and the budget has no room to retry it: ${lastError.message}`);
      const ordered = shuffle(versions, `${seed}:${judgeKey(judge)}:${index}:${attempt}`);
      const { content, labels } = buildContent(ordered, images);
      let result;
      running += 1;
      try {
        result = await call({ content, system, schema, model: judge.model, effort: judge.effort, budgetUsd, timeoutMs: 900_000 });
      } catch (error) {
        running -= 1;
        spend(error.costUSD ?? budgetUsd);
        lastError = error;
        continue;
      }
      running -= 1;
      spend(result.costUSD);
      try {
        return { ...readOutput(result.output, labels, versions), costUSD: result.costUSD, order: ordered.map((version) => version.key) };
      } catch (error) {
        if (!(error instanceof JudgeOutputError)) throw error;
        lastError = error;
      }
    }
    throw new JudgeFailedError(`${judgeKey(judge)} sample ${index + 1} failed twice: ${lastError.message}`);
  };
  // Every call finishes, and records its cost, before a failure is reported.
  const settled = await Promise.allSettled(Array.from({ length: judge.samples }, (_, index) => sample(index)));
  const failed = settled.find((item) => item.status === "rejected");
  if (failed) throw failed.reason;
  const samples = settled.map((item) => item.value);
  return { judge: judgeKey(judge), samples, ...combine(samples) };
}

// A judge's verdict on candidate against baseline and references.
export function verdict({ result, pass, noise, candidate = "candidate", baseline = "baseline", references = [] }) {
  const scores = result.scores[candidate];
  const values = Object.entries(scores).filter(([, value]) => value !== null);
  const [lowestCategory, lowest] = values.reduce((low, entry) => (entry[1] < low[1] ? entry : low));
  const gain = result.overall[candidate] - result.overall[baseline];
  const gainBar = Math.max(pass.gain, 2 * noise.sigmaOverall);
  const reasons = [];
  if (lowest < pass.min) reasons.push(`${lowestCategory} ${lowest.toFixed(2)} is under the bar ${pass.min}`);
  if (gain < gainBar) reasons.push(`gain over main ${signed(gain)} is under ${gainBar.toFixed(2)}`);
  let referenceMargin = null;
  if (references.length) {
    // The smallest lead, over all categories a reference was scored in, over the best reference.
    referenceMargin = Math.min(...values.flatMap(([category, value]) => {
      const best = Math.max(...references.map((key) => result.scores[key]?.[category]).filter((score) => typeof score === "number"));
      return Number.isFinite(best) ? [value - best] : [];
    }));
    if (pass.references !== null && referenceMargin < pass.references)
      reasons.push(`lead over the best reference ${signed(referenceMargin)} is under ${signed(pass.references)}`);
  }
  const baselineLowest = Math.min(...Object.values(result.scores[baseline]).filter((value) => value !== null));
  return { judge: result.judge, pass: reasons.length === 0, lowest, lowestCategory, gain, gainBar, referenceMargin, overall: result.overall[candidate], baselineLowest, reasons };
}

export const signed = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
export const fixed = (value) => (typeof value === "number" ? value.toFixed(2) : "–");
export const money = (value) => `$${(value ?? 0).toFixed(2)}`;

// The candidate's issues over every judge and sample, grouped by screen and category. Those
// in a category under the bar come first, the furthest under first (deficits: { category:
// points under the bar }); then the most weighty: severity counts 3, 2, 1, and repeats
// across calls add up.
export function topIssues(results, key = "candidate", limit = 20, deficits = {}) {
  const groups = new Map();
  for (const result of results)
    for (const sample of result.samples)
      for (const issue of sample.issues) {
        if (issue.version !== key) continue;
        const id = `${issue.screen}|${issue.category}`;
        const group = groups.get(id) ?? { screen: issue.screen, category: issue.category, underBar: (deficits[issue.category] ?? 0) > 0, weight: 0, count: 0, severity: "low", problems: [], fixes: [] };
        group.weight += SEVERITY[issue.severity] ?? 1;
        group.count++;
        if ((SEVERITY[issue.severity] ?? 1) > SEVERITY[group.severity]) group.severity = issue.severity;
        if (group.problems.length < 3) group.problems.push(issue.problem);
        if (group.fixes.length < 3) group.fixes.push(issue.fix);
        groups.set(id, group);
      }
  const deficit = (group) => deficits[group.category] ?? 0;
  return [...groups.values()].sort((a, b) => Math.max(deficit(b), 0) - Math.max(deficit(a), 0) || b.weight - a.weight || b.count - a.count).slice(0, limit);
}

// Calibration for one judge from its samples of baseline and control: the noise between
// repeated calls, and whether a deliberately degraded control scores clearly lower.
export function calibrationOf(result, { baseline = "baseline", control = "control" } = {}) {
  const categories = RUBRIC.categories.map((category) => category.id).filter((id) => result.samples.every((sample) => sample.scores[baseline][id] !== null));
  const sigmaCategory = Math.sqrt(mean(categories.map((id) => variance(result.samples.map((sample) => sample.scores[baseline][id])))));
  const sigmaOverall = Math.sqrt(variance(result.samples.map((sample) => sample.overall[baseline])));
  const drop = result.overall[baseline] - result.overall[control];
  const lower = categories.filter((id) => result.scores[control][id] < result.scores[baseline][id]).length / categories.length;
  const reasons = [];
  if (drop < 1) reasons.push(`the degraded control scored only ${drop.toFixed(2)} below main overall (needs 1.00)`);
  if (lower < 0.75) reasons.push(`the control scored lower in ${Math.round(lower * 100)}% of categories (needs 75%)`);
  if (sigmaCategory > 1) reasons.push(`category scores vary by ${sigmaCategory.toFixed(2)} between calls (needs at most 1.00)`);
  return { judge: result.judge, pass: reasons.length === 0, sigmaCategory, sigmaOverall, drop, lowerShare: lower, baseline: result.overall[baseline], control: result.overall[control], reasons, calibrated: true };
}

// Whether a judge ever gives the bar: the best reference's score per category, and the share
// of its scores of main and the references (not the control) at or above min. Warns when the
// bar is above the best reference by more than twice the judge's category noise, or when
// fewer than 5% of its scores reach it: a climb would then spend rounds against a score the
// judge almost never gives.
export function barReach(result, { min, references, sigmaCategory }) {
  const keys = ["baseline", ...references];
  const all = result.samples.flatMap((sample) => keys.flatMap((key) => Object.values(sample.scores[key] ?? {}))).filter((value) => typeof value === "number");
  const share = all.length ? all.filter((value) => value >= min).length / all.length : 0;
  const bestReference = {};
  for (const category of RUBRIC.categories) {
    const scores = references.map((key) => result.scores[key]?.[category.id]).filter((value) => typeof value === "number");
    if (scores.length) bestReference[category.id] = Math.max(...scores);
  }
  const beyond = Object.keys(bestReference).filter((id) => min > bestReference[id] + 2 * sigmaCategory);
  const warnings = [];
  if (beyond.length) warnings.push(`the bar ${min} is above the best reference in ${beyond.map((id) => `${id} (${bestReference[id].toFixed(2)})`).join(", ")}`);
  if (share < 0.05) warnings.push(`${Math.round(share * 100)}% of its scores of main and the references reach ${min}`);
  return { min, share, bestReference, beyond, warnings };
}
