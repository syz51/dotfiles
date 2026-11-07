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

export const INTERRUPT = "[Request interrupted by user";

export const textOf = (content) => typeof content === "string"
  ? content
  : Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n") : "";

// Tool output kept per call: the start and the end, where errors and PR URLs appear.
export const OUTPUT_EXCERPT = 2000;
export const excerpt = (text) => text.length <= OUTPUT_EXCERPT
  ? text
  : `${text.slice(0, OUTPUT_EXCERPT / 2)}\n[... ${text.length - OUTPUT_EXCERPT} characters omitted ...]\n${text.slice(-OUTPUT_EXCERPT / 2)}`;

// Wrappers Claude Code puts around local command output and injected context.
const INJECTED = /^\s*<(?:local-command-stdout|local-command-stderr|system-reminder|bash-stdout|bash-stderr)>/;

// Notices T3 Code sends as ordinary prompts in the person's name, and slash commands.
const HOST_PROMPT = [
  // A slash command, whichever of its tags comes first.
  /^\s*<command-(?:name|message)>/,
  /^Update on pull request #\d+ \(https:\/\/github\.com\//,
  /^Pull request #\d+ \(https:\/\/github\.com\/[^)]+\) was (?:closed|merged)/,
  /^Delegated task node:delegated-task:/,
  /^Continue where you left off\./,
  /^Context handoff \(full_thread_summary\):/,
];
export const isHostPrompt = (text) => HOST_PROMPT.some((pattern) => pattern.test(text));

// The brief an orchestrating agent starts a delegated T3 Code thread with.
const AGENT_BRIEF = [/^Act as the [\w -]+ sub-?agent\b/i, /^Delegated task\b/];
export const isAgentBrief = (text) => AGENT_BRIEF.some((pattern) => pattern.test(text));

// A user prompt record's text, unless it is meta, a compact summary, a sidechain, a
// prompt the host injected (promptSource "system"), only tool results, or an interrupt.
export function promptText(record) {
  if (record.type !== "user" || record.isMeta || record.isCompactSummary || record.isSidechain) return null;
  if (record.promptSource === "system" || record.isVisibleInTranscriptOnly) return null;
  const content = record.message?.content;
  if (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) return null;
  const text = textOf(content);
  if (!text.trim() || text.startsWith(INTERRUPT) || INJECTED.test(text)) return null;
  return text;
}

const asPrompt = (record, text) => ({ at: record.timestamp ?? null, text, source: record.promptSource ?? record.entrypoint ?? null });

// Usage and calls of a stream of records. Claude Code writes one assistant record per
// content block, each repeating the message's usage, so usage counts once per message id.
function summarize(records) {
  const messages = new Map();
  const results = new Map();
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
  for (const call of toolCalls) {
    const result = results.get(call.id);
    call.ok = result ? !result.isError : null;
    call.output = result ? excerpt(result.output) : "";
  }
  const requests = [...messages.values()].map(({ model, usage, effort }) => ({ model, effort, usage: normalizeUsage(usage) }));
  return { ...priceRequests(requests), toolCalls, apiErrors, interrupts, compactions, assistantMessages: messages.size };
}

// Messages per model and effort, usage per model and estimated cost of API requests
// ([{ model, effort, usage }] with normalized usage), priced one by one.
export function priceRequests(requests) {
  const models = {};
  const efforts = {};
  const usage = {};
  const costByModel = {};
  let estimated = 0;
  let unpriced = false;
  for (const { model, effort, usage: normalized } of requests) {
    models[model] = (models[model] ?? 0) + 1;
    if (effort) efforts[effort] = (efforts[effort] ?? 0) + 1;
    addUsage(usage[model] ??= emptyUsage(), normalized);
    const cost = requestCost(model, normalized);
    if (cost === null) unpriced = true;
    else {
      estimated += cost;
      costByModel[model] = (costByModel[model] ?? 0) + cost;
    }
  }
  return { models, efforts, usage, costByModel, estimatedCostUSD: estimated, unpriced };
}

// The earliest and latest of records' timestamps, without spreading them into arguments
// (a long rollout has more records than a call takes).
export function timestamps(records) {
  let first = Infinity;
  let last = -Infinity;
  for (const record of records) {
    const time = Date.parse(record.timestamp);
    if (time < first) first = time;
    if (time > last) last = time;
  }
  return Number.isFinite(first)
    ? { startedAt: new Date(first).toISOString(), endedAt: new Date(last).toISOString() }
    : { startedAt: null, endedAt: null };
}

export function mostCommon(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// The key with the highest count ({ key: count }), the first on a tie; null when empty.
export const topKey = (counts) => Object.entries(counts).reduce((best, entry) => (best && best[1] >= entry[1] ? best : entry), null)?.[0] ?? null;

// A tool call that runs the /code-review skill.
export const isCodeReview = (call) => call.name === "Skill" && call.input?.skill === "code-review";

function parseSubagents(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().map((name) => {
    const id = basename(name, ".jsonl");
    const metaFile = join(dir, `${id}.meta.json`);
    let meta = {};
    let metaUnreadable = false;
    if (existsSync(metaFile))
      try {
        meta = JSON.parse(readFileSync(metaFile, "utf8"));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        metaUnreadable = true;
      }
    const { records, malformed } = readRecords(join(dir, name));
    const summary = summarize(records);
    return {
      id,
      agentType: meta.agentType ?? null,
      description: meta.description ?? null,
      toolUseId: meta.toolUseId ?? null,
      // The agent that started this one, such as the agent whose skill ran forked; its id
      // without the file's "agent-" prefix.
      parentAgentId: meta.parentAgentId ?? null,
      // The /code-review runs this agent started: the Skill call's arguments.
      codeReviews: summary.toolCalls.filter(isCodeReview).map((call) => ({ at: call.at, args: String(call.input.args ?? "") })),
      model: topKey(summary.models),
      effort: topKey(summary.efforts),
      usage: summary.usage,
      costUSD: summary.estimatedCostUSD,
      assistantMessages: summary.assistantMessages,
      toolCalls: summary.toolCalls.length,
      toolErrors: summary.toolCalls.filter((call) => call.ok === false).length,
      unpriced: summary.unpriced,
      malformedLines: malformed + (metaUnreadable ? 1 : 0),
    };
  });
}

// Temporary folders: the system's and macOS's.
export const TEMP_DIRS = [tmpdir(), "/private/tmp", "/tmp", "/private/var/folders", "/var/folders"];

// Sessions that automation runs rather than a person: codex-skills maintenance and
// investigation copies, and fixtures in temporary folders.
export function isAutomation(cwd, { temp = TEMP_DIRS } = {}) {
  if (!cwd) return false;
  if (/\/codex-skills\/(?:investigations|review|maintenance)/.test(cwd)) return true;
  return temp.some((prefix) => cwd === prefix || cwd.startsWith(`${prefix}/`));
}

export function parseSession(file, { project = basename(join(file, "..")) } = {}) {
  const { records: all, malformed } = readRecords(file);
  const id = all.find((record) => record.sessionId)?.sessionId ?? basename(file, ".jsonl");
  // A forked session starts with a copy of its parent's history, each copied record
  // marked forkedFrom; only the fork's own records count, or the parent counts twice.
  const forkedFrom = all.find((record) => record.forkedFrom)?.forkedFrom?.sessionId ?? null;
  const records = all.filter((record) => !record.forkedFrom);
  const main = summarize(records);
  const texts = records.map((record) => [record, promptText(record)]).filter(([, text]) => text);
  const prompts = texts.filter(([, text]) => !isHostPrompt(text)).map(([record, text]) => asPrompt(record, text));
  const inheritedPrompts = all.filter((record) => record.forkedFrom)
    .map((record) => [record, promptText({ ...record, forkedFrom: undefined })])
    .filter(([, text]) => text && !isHostPrompt(text))
    .map(([record, text]) => asPrompt(record, text));
  const subagents = parseSubagents(join(file.slice(0, -".jsonl".length), "subagents"));
  const cwd = all.find((record) => record.cwd)?.cwd ?? null;
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
    harness: "claude",
    project,
    cwd,
    file,
    entrypoint: mostCommon(all.map((record) => record.entrypoint)),
    title: customTitle ?? aiTitle ?? null,
    ...timestamps(records),
    models: main.models,
    efforts: main.efforts,
    // The person's prompts, without host notices; origin is "agent" when the session
    // started from a delegation brief, "person" otherwise, null without prompts.
    prompts,
    hostPrompts: texts.length - prompts.length,
    origin: prompts.length ? (isAgentBrief(prompts[0].text) ? "agent" : "person") : null,
    forkedFrom,
    // A fork's prompts copied from its parent: what was asked before the fork.
    inheritedPrompts,
    assistantMessages: main.assistantMessages,
    toolCalls: main.toolCalls,
    usage: main.usage,
    // The main session's estimated cost per model, priced request by request.
    costByModel: main.costByModel,
    // Claude Code's cost-state total when current; otherwise estimate the main session
    // and its subagents from usage.
    costUSD: hasCostState ? costState.totalCostUSD : estimated,
    costSource: hasCostState ? "cost-state" : "estimated",
    estimatedCostUSD: estimated,
    unpriced: main.unpriced || subagents.some((agent) => agent.unpriced),
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
