// Claude Code session transcripts as normalized Session objects. A session is
// <projects>/<project>/<session>.jsonl plus its subagents in
// <projects>/<project>/<session>/subagents/agent-*.jsonl with agent-*.meta.json.
// Transcripts are external data: unreadable lines are counted, never trusted.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { addUsage, emptyUsage, normalizeUsage, requestCost } from "./pricing.js";

export function projectsRoot(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

// Main-session transcript files, newest first: [{ file, project, mtimeMs }].
export function sessionFiles(root = projectsRoot()) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const entry of readdirSync(join(root, project.name), { withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const file = join(root, project.name, entry.name);
        files.push({ file, project: project.name, mtimeMs: statSync(file).mtimeMs });
      }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Parsed records of a JSON Lines transcript and the number of lines that did not parse
// (a session still being written can end in a partial line).
export function readRecords(file) {
  const records = [];
  let malformed = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object") records.push(record);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

const INTERRUPT = "[Request interrupted by user";

const textOf = (content) => typeof content === "string"
  ? content
  : Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n") : "";

// Tool output kept per call: the start and the end, where errors and PR URLs appear.
export const OUTPUT_EXCERPT = 2000;
const excerpt = (text) => text.length <= OUTPUT_EXCERPT
  ? text
  : `${text.slice(0, OUTPUT_EXCERPT / 2)}\n[... ${text.length - OUTPUT_EXCERPT} characters omitted ...]\n${text.slice(-OUTPUT_EXCERPT / 2)}`;

// Wrappers Claude Code puts around local command output and injected context.
const INJECTED = /^\s*<(?:local-command-stdout|local-command-stderr|system-reminder|command-message|bash-stdout|bash-stderr)>/;

// A prompt the person sent: not meta, not a compact summary, not a sidechain, not
// injected by the host (promptSource "system"), and not only tool results.
function humanPrompt(record) {
  if (record.type !== "user" || record.isMeta || record.isCompactSummary || record.isSidechain) return null;
  if (record.promptSource === "system" || record.isVisibleInTranscriptOnly) return null;
  const content = record.message?.content;
  if (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) return null;
  const text = textOf(content);
  if (!text.trim() || text.startsWith(INTERRUPT) || INJECTED.test(text)) return null;
  return { at: record.timestamp ?? null, text, source: record.promptSource ?? record.entrypoint ?? null };
}

// Usage and calls of a stream of records. Claude Code writes one assistant record per
// content block, each repeating the message's usage, so usage counts once per message id.
function summarize(records) {
  const messages = new Map();
  const results = new Map();
  const models = {};
  const toolCalls = [];
  const apiErrors = {};
  let interrupts = 0;
  let compactions = 0;
  for (const record of records) {
    if (record.type === "assistant") {
      const message = record.message ?? {};
      if (record.isApiErrorMessage || record.apiErrorStatus) {
        const status = String(record.apiErrorStatus ?? record.error ?? "unknown");
        apiErrors[status] = (apiErrors[status] ?? 0) + 1;
      }
      const id = message.id ?? record.requestId ?? record.uuid;
      if (message.model && message.model !== "<synthetic>" && message.usage && id) messages.set(id, { model: message.model, usage: message.usage, effort: record.effort ?? null });
      for (const block of Array.isArray(message.content) ? message.content : [])
        if (block?.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {}, at: record.timestamp ?? null });
    } else if (record.type === "user") {
      const content = record.message?.content;
      if (Array.isArray(content))
        for (const block of content) {
          if (block?.type === "tool_result") results.set(block.tool_use_id, { isError: block.is_error === true, output: textOf(block.content) });
          if (block?.type === "text" && block.text?.startsWith(INTERRUPT)) interrupts++;
        }
      else if (typeof content === "string" && content.startsWith(INTERRUPT)) interrupts++;
    } else if (record.type === "system" && record.subtype === "compact_boundary") compactions++;
  }
  const usage = {};
  let estimated = 0;
  let unpriced = false;
  const efforts = {};
  for (const { model, usage: raw, effort } of messages.values()) {
    models[model] = (models[model] ?? 0) + 1;
    if (effort) efforts[effort] = (efforts[effort] ?? 0) + 1;
    const normalized = normalizeUsage(raw);
    addUsage(usage[model] ??= emptyUsage(), normalized);
    const cost = requestCost(model, normalized);
    if (cost === null) unpriced = true;
    else estimated += cost;
  }
  for (const call of toolCalls) {
    const result = results.get(call.id);
    call.ok = result ? !result.isError : null;
    call.output = result ? excerpt(result.output) : "";
  }
  return { models, efforts, usage, estimatedCostUSD: estimated, unpriced, toolCalls, apiErrors, interrupts, compactions, assistantMessages: messages.size };
}

function timestamps(records) {
  const times = records.map((record) => Date.parse(record.timestamp)).filter(Number.isFinite);
  return times.length
    ? { startedAt: new Date(Math.min(...times)).toISOString(), endedAt: new Date(Math.max(...times)).toISOString() }
    : { startedAt: null, endedAt: null };
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function parseSubagents(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().map((name) => {
    const id = basename(name, ".jsonl");
    const metaFile = join(dir, `${id}.meta.json`);
    let meta = {};
    if (existsSync(metaFile))
      try {
        meta = JSON.parse(readFileSync(metaFile, "utf8"));
      } catch {
        meta = {};
      }
    const { records, malformed } = readRecords(join(dir, name));
    const summary = summarize(records);
    return {
      id,
      agentType: meta.agentType ?? null,
      description: meta.description ?? null,
      toolUseId: meta.toolUseId ?? null,
      model: mostCommon(Object.entries(summary.models).flatMap(([model, count]) => Array(count).fill(model))),
      effort: mostCommon(Object.entries(summary.efforts).flatMap(([effort, count]) => Array(count).fill(effort))),
      usage: summary.usage,
      costUSD: summary.estimatedCostUSD,
      toolCalls: summary.toolCalls.length,
      toolErrors: summary.toolCalls.filter((call) => call.ok === false).length,
      malformedLines: malformed,
    };
  });
}

// Sessions that automation runs rather than a person: codex-skills maintenance and
// investigation copies, and fixtures in temporary folders.
export function isAutomation(cwd, { temp = [tmpdir(), "/private/tmp", "/tmp", "/private/var/folders", "/var/folders"] } = {}) {
  if (!cwd) return false;
  if (/\/codex-skills\/(?:investigations|review|maintenance)/.test(cwd)) return true;
  return temp.some((prefix) => cwd === prefix || cwd.startsWith(`${prefix}/`));
}

export function parseSession(file, { project = basename(join(file, "..")) } = {}) {
  const { records, malformed } = readRecords(file);
  const id = records.find((record) => record.sessionId)?.sessionId ?? basename(file, ".jsonl");
  const main = summarize(records);
  const subagents = parseSubagents(join(file.slice(0, -".jsonl".length), "subagents"));
  const cwd = records.find((record) => record.cwd)?.cwd ?? null;
  const costState = records.findLast((record) => record.type === "cost-state");
  const customTitle = records.findLast((record) => record.type === "custom-title")?.customTitle;
  const aiTitle = records.findLast((record) => record.type === "ai-title")?.aiTitle;
  const prLinks = new Map();
  for (const record of records)
    if (record.type === "pr-link" && record.prUrl)
      prLinks.set(record.prUrl, { url: record.prUrl, number: record.prNumber ?? null, repository: record.prRepository ?? null, at: record.timestamp ?? null });
  const subagentCost = subagents.reduce((sum, agent) => sum + agent.costUSD, 0);
  const estimated = main.estimatedCostUSD + subagentCost;
  // cost-state includes subagents and matches the estimate within a few percent, but it
  // is a snapshot: a session that went on afterwards has a stale one, so a clearly
  // larger estimate wins.
  const hasCostState = typeof costState?.totalCostUSD === "number" && estimated <= costState.totalCostUSD * 1.1 + 0.05;
  return {
    id,
    project,
    cwd,
    file,
    entrypoint: mostCommon(records.map((record) => record.entrypoint)),
    title: customTitle ?? aiTitle ?? null,
    ...timestamps(records),
    models: main.models,
    efforts: main.efforts,
    prompts: records.map(humanPrompt).filter(Boolean),
    assistantMessages: main.assistantMessages,
    toolCalls: main.toolCalls,
    usage: main.usage,
    // Claude Code's cost-state total when current; otherwise estimate the main session
    // and its subagents from usage.
    costUSD: hasCostState ? costState.totalCostUSD : estimated,
    costSource: hasCostState ? "cost-state" : "estimated",
    estimatedCostUSD: estimated,
    unpriced: main.unpriced,
    linesAdded: costState?.totalLinesAdded ?? null,
    linesRemoved: costState?.totalLinesRemoved ?? null,
    compactions: main.compactions,
    interrupts: main.interrupts,
    apiErrors: main.apiErrors,
    subagents,
    prLinks: [...prLinks.values()],
    automation: isAutomation(cwd),
    malformedLines: malformed,
  };
}

// Sessions whose transcript changed at or after since (a Date or ms), newest first.
export function loadSessions({ root = projectsRoot(), since = 0, until = Infinity } = {}) {
  const from = +since;
  const to = +until;
  return sessionFiles(root)
    .filter(({ mtimeMs }) => mtimeMs >= from)
    .map(({ file, project }) => parseSession(file, { project }))
    .filter((session) => !session.endedAt || (Date.parse(session.endedAt) >= from && Date.parse(session.startedAt) <= to));
}
