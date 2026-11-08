// A judge for the ui tests, run by lib/testing/fake-claude.js in script mode. It sees what
// a real judge sees: the content blocks on stdin and the system prompt file. It tells the
// designs apart the only honest way a fake can, by matching each image's bytes against
// the run's captured versions (the newest run under FAKE_UI_RUNS), and scores them from
// FAKE_UI_SCORES ({ baseline, control, candidate, references }, with models: { model:
// scores } for one judge's own, or broken: true for output that never fits). It appends to FAKE_UI_LEAKS any word in the prompts that would tell a
// judge which version is which, and to FAKE_UI_CALLS the version behind each design number.
import { createHash } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LEAKS = /\b(baseline|candidate|control|round|main|origin|target|threshold|climb|bar|newer version|improved)\b/i;
const CATEGORIES = ["hierarchy", "layout", "typography", "color", "components", "consistency", "responsive", "polish"];
const hash = (data) => createHash("sha256").update(data).digest("hex");

function versionsByHash() {
  const runs = process.env.FAKE_UI_RUNS;
  const run = join(runs, readdirSync(runs).sort().at(-1), "versions");
  const map = new Map();
  // The baseline first, so a candidate identical to main counts as main.
  const names = readdirSync(run).sort((a, b) => (a === "baseline" ? -1 : b === "baseline" ? 1 : a.localeCompare(b)));
  for (const name of names)
    for (const file of readdirSync(join(run, name)).filter((item) => item.endsWith(".png"))) {
      const key = hash(readFileSync(join(run, name, file)).toString("base64"));
      if (!map.has(key)) map.set(key, name === "references" ? "references" : /^(round|preview)-/.test(name) ? "candidate" : name);
    }
  return map;
}

export default async function ({ stdin, emit, option }) {
  const env = process.env;
  const system = readFileSync(option("--system-prompt-file"), "utf8");
  const { message } = JSON.parse(stdin.trim());
  const texts = [system, ...message.content.filter((block) => block.type === "text").map((block) => block.text)];
  for (const text of texts) {
    const found = text.match(LEAKS);
    if (found && env.FAKE_UI_LEAKS) appendFileSync(env.FAKE_UI_LEAKS, `${found[0]} in: ${text.slice(0, 200)}\n`);
  }
  const known = versionsByHash();
  const designs = new Map();
  let current = null;
  for (const block of message.content) {
    if (block.type === "text") {
      const caption = block.text.match(/^Design (\d+) · .* · \[([^\]]+)\] · (\w+),/);
      if (caption) current = { design: Number(caption[1]), shot: caption[2], phone: caption[3] === "phone" };
    } else if (block.type === "image" && current) {
      const entry = designs.get(current.design) ?? { shots: [], versions: new Set(), phone: false };
      entry.shots.push(current.shot);
      entry.versions.add(known.get(hash(block.source.data)) ?? "unknown");
      entry.phone ||= current.phone;
      designs.set(current.design, entry);
    }
  }
  // models: { "<model>": { candidate: 9 } } overrides the scores for one judge model.
  const { models = {}, ...shared } = JSON.parse(env.FAKE_UI_SCORES);
  const scores = { ...shared, ...models[option("--model")] };
  const output = { designs: [], issues: [], strengths: [] };
  // A judge that answers about a design it was not shown, so its output never fits.
  if (scores.broken) output.designs.push({ design: 99, scores: {}, summary: "" });
  const order = {};
  for (const [design, entry] of designs) {
    // A version some of whose shots match main and some a candidate is the candidate.
    const versions = [...entry.versions];
    const version = versions.includes("candidate") ? "candidate" : versions[0];
    order[design] = version;
    const score = scores[version] ?? 5;
    output.designs.push({ design, scores: Object.fromEntries(CATEGORIES.map((id) => [id, id === "responsive" && !entry.phone ? null : score])), summary: `${version} summary` });
    output.issues.push({ design, screen: entry.shots[0], category: "color", severity: "high", problem: `<b>low contrast</b> in ${entry.shots[0]}`, fix: "darken the <i>muted</i> text" });
    output.strengths.push({ design, text: "clear layout" });
  }
  if (env.FAKE_UI_CALLS) appendFileSync(env.FAKE_UI_CALLS, `${JSON.stringify({ model: option("--model"), order })}\n`);
  emit({ type: "system", subtype: "init", model: option("--model"), tools: ["StructuredOutput"], mcp_servers: [] });
  emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: Number(env.FAKE_CLAUDE_COST ?? 0.01), num_turns: 1, result: "", structured_output: output });
}
