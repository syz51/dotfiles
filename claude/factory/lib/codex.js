// Codex rollouts as normalized Session objects, the same shape lib/transcripts.js gives
// Claude Code sessions, with harness "codex". A rollout is
// <sessions>/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl; its first record is
// session_meta. A subagent thread has its own rollout whose session_meta names the root
// thread (session_id); it starts with a copy of the parent's history, the records before
// subagent_history_start_ordinal, which belong to the parent and are skipped here.
// Only Codex's own files are read, never T3 Code's caches. Rollouts are external data:
// unreadable lines are counted, never trusted.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addUsage, emptyUsage, requestCost } from "./pricing.js";
import { isAgentBrief, isAutomation, isHostPrompt, mostCommon, OUTPUT_EXCERPT } from "./transcripts.js";

export const codexHome = (env = process.env) => env.CODEX_HOME || join(homedir(), ".codex");
export const codexSessionsRoot = (env = process.env) => join(codexHome(env), "sessions");

const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

// Rollout files, newest first: [{ file, id, mtimeMs }], id from the file name.
export function rolloutFiles(root = codexSessionsRoot()) {
  if (!existsSync(root)) return [];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && ROLLOUT.test(entry.name)) files.push({ file: path, id: ROLLOUT.exec(entry.name)[1], mtimeMs: statSync(path).mtimeMs });
    }
  };
  walk(root);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Compaction snapshots and world state make up about a quarter of a rollout's bytes and
// carry nothing these metrics use, so their lines keep only their header fields.
const BULKY = /^\{"timestamp":"([^"]*)","ordinal":(\d+),"type":"(compacted|world_state)"/;

function readRollout(file) {
  const records = [];
  let malformed = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const bulky = BULKY.exec(line);
    if (bulky) {
      records.push({ timestamp: bulky[1], ordinal: Number(bulky[2]), type: bulky[3], payload: {} });
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

const contentText = (content) => typeof content === "string"
  ? content
  : Array.isArray(content) ? content.map((block) => (typeof block?.text === "string" ? block.text : "")).filter(Boolean).join("\n") : "";

const excerpt = (text) => text.length <= OUTPUT_EXCERPT
  ? text
  : `${text.slice(0, OUTPUT_EXCERPT / 2)}\n[... ${text.length - OUTPUT_EXCERPT} characters omitted ...]\n${text.slice(-OUTPUT_EXCERPT / 2)}`;

// Tool outputs that mean the call itself failed: a script that threw, a call the harness
// dropped, or a collaboration tool that refused. A command that exits non-zero inside a
// script that completed does not count, as Codex reports it inside the output.
const FAILED_OUTPUT = /^(?:Script failed\b|aborted before dispatch|collab (?:tool|spawn) failed\b)/;

// OpenAI usage counts cached and cache-written tokens inside input_tokens.
export function normalizeCodexUsage(usage = {}) {
  const cacheRead = usage.cached_input_tokens ?? 0;
  const cacheWrite = usage.cache_write_input_tokens ?? 0;
  return { input: Math.max(0, (usage.input_tokens ?? 0) - cacheRead - cacheWrite), output: usage.output_tokens ?? 0, cacheRead, cacheWrite5m: cacheWrite, cacheWrite1h: 0 };
}

// A person's prompt: a user message holding typed text, not injected AGENTS.md or
// environment context. Rollouts without content kinds fall back to the text's shape.
function promptText(payload) {
  if (payload?.type !== "message" || payload.role !== "user") return null;
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (Array.isArray(kinds) ? !kinds.includes("user.text") : /^\s*(?:<|# AGENTS\.md)/.test(contentText(payload.content))) return null;
  const text = contentText(payload.content);
  return text.trim() ? text : null;
}

// One rollout file as a thread: its metadata and the summary of its own records.
export function parseRollout(file) {
  const { records, malformed } = readRollout(file);
  const meta = records.find((record) => record.type === "session_meta")?.payload ?? {};
  const start = meta.subagent_history_start_ordinal ?? 0;
  const isOwn = (record) => (record.ordinal ?? Infinity) >= start && record.metadata?.inherited_user_message !== true;
  const own = records.filter(isOwn);
  const inherited = records.filter((record) => !isOwn(record));
  const spawn = meta.source?.subagent?.thread_spawn ?? null;

  const responses = new Map();
  const calls = [];
  const outputs = new Map();
  const texts = [];
  const apiErrors = {};
  let model = null;
  let effort = null;
  let interrupts = 0;
  let compactions = 0;
  for (const record of own) {
    const payload = record.payload ?? {};
    if (record.type === "turn_context") {
      model = payload.model ?? model;
      effort = payload.effort ?? payload.collaboration_mode?.settings?.reasoning_effort ?? effort;
    } else if (record.type === "event_msg" && payload.type === "thread_settings_applied") {
      model = payload.thread_settings?.model ?? model;
      effort = payload.thread_settings?.reasoning_effort ?? effort;
    } else if (record.type === "token_usage_record" && payload.usage && (!payload.thread_id || payload.thread_id === meta.id)) {
      responses.set(payload.response_id ?? `ordinal-${record.ordinal}`, { model: model ?? "unknown", effort, usage: payload.usage });
    } else if (record.type === "event_msg" && payload.type === "turn_aborted") {
      if (payload.reason === "interrupted") interrupts++;
    } else if (record.type === "event_msg" && payload.type === "task_complete" && payload.error) {
      const status = String(payload.error.codex_error_info ?? "unknown");
      apiErrors[status] = (apiErrors[status] ?? 0) + 1;
    } else if (record.type === "compacted") compactions++;
    else if (record.type === "response_item") {
      if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        let input;
        if (payload.type === "custom_tool_call") input = { input: payload.input ?? "" };
        else
          try {
            input = JSON.parse(payload.arguments ?? "{}");
          } catch {
            input = { arguments: payload.arguments };
          }
        calls.push({ id: payload.call_id, name: payload.namespace ? `${payload.namespace}.${payload.name}` : payload.name, input, at: record.timestamp ?? null });
      } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") outputs.set(payload.call_id, contentText(payload.output));
      else {
        const text = promptText(payload);
        if (text) texts.push({ at: record.timestamp ?? null, text, source: "codex" });
      }
    }
  }

  const models = {};
  const efforts = {};
  const usage = {};
  const costByModel = {};
  let estimated = 0;
  let unpriced = false;
  for (const response of responses.values()) {
    models[response.model] = (models[response.model] ?? 0) + 1;
    if (response.effort) efforts[response.effort] = (efforts[response.effort] ?? 0) + 1;
    const normalized = normalizeCodexUsage(response.usage);
    addUsage(usage[response.model] ??= emptyUsage(), normalized);
    const cost = requestCost(response.model, normalized);
    if (cost === null) unpriced = true;
    else {
      estimated += cost;
      costByModel[response.model] = (costByModel[response.model] ?? 0) + cost;
    }
  }
  const toolCalls = calls.map((call) => {
    const output = outputs.get(call.id);
    return { ...call, ok: output === undefined ? null : !FAILED_OUTPUT.test(output), output: output === undefined ? "" : excerpt(output) };
  });
  const times = own.map((record) => Date.parse(record.timestamp)).filter(Number.isFinite);
  return {
    id: meta.id ?? null,
    rootId: meta.session_id ?? meta.id ?? null,
    parentId: spawn?.parent_thread_id ?? meta.parent_thread_id ?? null,
    subagent: Boolean(spawn) || meta.thread_source === "subagent",
    agentRole: spawn?.agent_role ?? meta.agent_role ?? null,
    agentPath: spawn?.agent_path ?? meta.agent_path ?? null,
    forkedFrom: meta.forked_from_id ?? null,
    cwd: meta.cwd ?? records.find((record) => record.type === "turn_context")?.payload?.cwd ?? null,
    originator: meta.originator ?? null,
    file,
    startedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    endedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    models, efforts, usage, costByModel, estimatedCostUSD: estimated, unpriced, toolCalls, apiErrors, interrupts, compactions,
    assistantMessages: responses.size,
    texts,
    inheritedTexts: inherited.map((record) => ({ record, text: promptText(record.payload) })).filter(({ text }) => text)
      .map(({ record, text }) => ({ at: record.timestamp ?? null, text, source: "codex" })),
    malformedLines: malformed + (meta.id ? 0 : 1),
  };
}

// Thread names from Codex's session_index.jsonl, the last entry per thread winning.
function threadTitles(home) {
  const file = join(home, "session_index.jsonl");
  const titles = new Map();
  if (!existsSync(file)) return titles;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.id === "string" && typeof entry.thread_name === "string") titles.set(entry.id, entry.thread_name);
    } catch {
      // A line still being written; the title is optional.
    }
  }
  return titles;
}

// Claude Code's project folder name for a working directory, so a repository's Claude
// and Codex sessions group under one project.
export const projectKey = (cwd) => (cwd ? cwd.replace(/[^A-Za-z0-9]/g, "-") : "codex");

const asSubagent = (thread) => ({
  id: thread.id,
  agentType: thread.agentRole ?? "default",
  description: thread.agentPath,
  toolUseId: null,
  model: mostCommon(Object.entries(thread.models).flatMap(([model, count]) => Array(count).fill(model))),
  effort: mostCommon(Object.entries(thread.efforts).flatMap(([effort, count]) => Array(count).fill(effort))),
  usage: thread.usage,
  costUSD: thread.estimatedCostUSD,
  assistantMessages: thread.assistantMessages,
  toolCalls: thread.toolCalls.length,
  toolErrors: thread.toolCalls.filter((call) => call.ok === false).length,
  unpriced: thread.unpriced,
  malformedLines: thread.malformedLines,
});

function asSession(thread, subagents, titles) {
  const prompts = thread.texts.filter(({ text }) => !isHostPrompt(text));
  const estimated = thread.estimatedCostUSD + subagents.reduce((total, agent) => total + agent.costUSD, 0);
  return {
    id: thread.id,
    harness: "codex",
    project: projectKey(thread.cwd),
    cwd: thread.cwd,
    file: thread.file,
    entrypoint: thread.originator,
    title: titles.get(thread.id) ?? null,
    startedAt: thread.startedAt,
    endedAt: thread.endedAt,
    models: thread.models,
    efforts: thread.efforts,
    prompts,
    hostPrompts: thread.texts.length - prompts.length,
    // A subagent whose root thread is missing was launched by an agent all the same.
    origin: thread.subagent ? "agent" : prompts.length ? (isAgentBrief(prompts[0].text) ? "agent" : "person") : null,
    forkedFrom: thread.subagent ? null : thread.forkedFrom,
    inheritedPrompts: thread.inheritedTexts.filter(({ text }) => !isHostPrompt(text)),
    assistantMessages: thread.assistantMessages,
    toolCalls: thread.toolCalls,
    usage: thread.usage,
    costByModel: thread.costByModel,
    // Codex records no cost, so it is always the usage estimate.
    costUSD: estimated,
    costSource: "estimated",
    estimatedCostUSD: estimated,
    unpriced: thread.unpriced || subagents.some((agent) => agent.unpriced),
    linesAdded: null,
    linesRemoved: null,
    compactions: thread.compactions,
    interrupts: thread.interrupts,
    apiErrors: thread.apiErrors,
    subagents,
    prLinks: [],
    automation: isAutomation(thread.cwd),
    malformedLines: thread.malformedLines,
  };
}

// Codex sessions active in [since, until], newest first. Subagent threads, at any depth,
// count as subagents of their root thread's session; the root is read even when its file
// is older than since. A subagent whose root rollout is gone becomes its own session.
export function loadCodexSessions({ root = codexSessionsRoot(), home = join(root, ".."), since = 0, until = Infinity } = {}) {
  const from = +since;
  const to = +until;
  const files = rolloutFiles(root);
  const threads = new Map();
  const add = (file) => {
    const thread = parseRollout(file);
    threads.set(thread.id ?? file, thread);
    return thread;
  };
  for (const { file, mtimeMs } of files) if (mtimeMs >= from) add(file);
  const byId = new Map(files.map((entry) => [entry.id, entry.file]));
  for (const thread of [...threads.values()])
    if (thread.subagent && thread.rootId && !threads.has(thread.rootId) && byId.has(thread.rootId)) add(byId.get(thread.rootId));

  const children = new Map();
  const roots = [];
  for (const thread of threads.values()) {
    const rootThread = thread.subagent ? threads.get(thread.rootId) : null;
    if (rootThread && !rootThread.subagent) {
      if (!children.has(rootThread)) children.set(rootThread, []);
      children.get(rootThread).push(thread);
    } else roots.push(thread);
  }
  const titles = threadTitles(home);
  return roots
    .map((thread) => asSession(thread, (children.get(thread) ?? []).sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "")).map(asSubagent), titles))
    .filter((session) => !session.endedAt || (Date.parse(session.endedAt) >= from && Date.parse(session.startedAt) <= to))
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
}
