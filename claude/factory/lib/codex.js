// Codex rollouts as normalized Session objects, the same shape lib/transcripts.js gives
// Claude Code sessions, with harness "codex". A thread's rollout is
// <sessions>/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl; a long thread continues in
// further segments, rollout-<local time>-<thread id>_<segment id>.jsonl, each holding new
// records. The first record is the thread's session_meta. A subagent thread names its
// root thread (session_id) and starts with a copy of its parent's history, the records
// before subagent_history_start_ordinal, which belong to the parent and are skipped here.
// Only Codex's own files are read, never T3 Code's caches. Rollouts are external data:
// unreadable lines are counted, never trusted.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { excerpt, isAgentBrief, isAutomation, isHostPrompt, priceRequests, timestamps, topKey } from "./transcripts.js";

export const codexSessionsRoot = (env = process.env) => join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions");

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROLLOUT = new RegExp(`^rollout-(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-(${UUID})(?:_${UUID})?\\.jsonl$`);

// Threads with rollouts, newest first: [{ id, files, startedMs, mtimeMs }]. files are the
// thread's segments in order; startedMs is the first segment's local start time from its
// name, for comparing threads with each other.
export function rolloutThreads(root = codexSessionsRoot()) {
  if (!existsSync(root)) return [];
  const threads = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && ROLLOUT.test(entry.name)) {
        const [, date, hours, minutes, seconds, id] = ROLLOUT.exec(entry.name);
        if (!threads.has(id)) threads.set(id, { id, files: [], startedMs: Infinity, mtimeMs: 0 });
        const thread = threads.get(id);
        thread.files.push(path);
        thread.startedMs = Math.min(thread.startedMs, Date.parse(`${date}T${hours}:${minutes}:${seconds}`));
        thread.mtimeMs = Math.max(thread.mtimeMs, statSync(path).mtimeMs);
      }
    }
  };
  walk(root);
  // Names start with the time, and the first segment's name sorts before a later
  // segment started in the same second.
  for (const thread of threads.values()) thread.files.sort((a, b) => basename(a).localeCompare(basename(b)));
  return [...threads.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// The first line of a file, read in chunks: a rollout's session_meta, without the rest.
function firstLine(file, limit = 16 * 1024 * 1024) {
  const fd = openSync(file, "r");
  try {
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    for (let total = 0; total < limit;) {
      const read = readSync(fd, buffer, 0, buffer.length, total);
      if (!read) break;
      const newline = buffer.subarray(0, read).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, newline === -1 ? read : newline)));
      if (newline !== -1) break;
      total += read;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function threadMeta(thread) {
  try {
    const record = JSON.parse(firstLine(thread.files[0]));
    return record?.type === "session_meta" && record.payload?.id === thread.id ? record.payload : null;
  } catch {
    return null;
  }
}

// Every record starts with these fields. Compaction snapshots and world state carry
// nothing used here and are about a quarter of the bytes, and a subagent's copy of its
// parent's history is two thirds, so those lines are not parsed.
const HEADER = /^\{"timestamp":"([^"]*)","ordinal":(\d+),"type":"([a-z_]+)"/;
const BULKY = new Set(["compacted", "world_state"]);

// A thread's records across its segments, with its own session_meta. Unless inherited is
// set, the history a subagent copied from its parent is skipped.
function readThread(thread, { inherited = false } = {}) {
  const records = [];
  let malformed = 0;
  let meta = null;
  let start = 0;
  for (const file of thread.files)
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const header = meta ? HEADER.exec(line) : null;
      if (header) {
        const ordinal = Number(header[2]);
        if (!inherited && file === thread.files[0] && ordinal < start) continue;
        if (BULKY.has(header[3])) {
          records.push({ timestamp: header[1], ordinal, type: header[3], payload: {} });
          continue;
        }
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        malformed++;
        continue;
      }
      if (!meta && record.type === "session_meta" && record.payload?.id === thread.id) {
        meta = record.payload;
        start = meta.subagent_history_start_ordinal ?? 0;
      }
      records.push(record);
    }
  return { records, malformed: malformed + (meta ? 0 : 1), meta: meta ?? {}, start };
}

const contentText = (content) => typeof content === "string"
  ? content
  : Array.isArray(content) ? content.map((block) => (typeof block?.text === "string" ? block.text : "")).filter(Boolean).join("\n") : "";

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

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?!\d)/g;
const PR_CREATE = /\bgh\s+pr\s+create\b/;
// T3 Code's tool that links a PR to its thread, Codex's counterpart of a pr-link record.
const PR_LINK_TOOL = /(?<!un)link_pull_requests?\b/;
// `gh pr create` often outlives the exec call that started it, and its URL arrives in a
// later call that reads the process (write_stdin, wait): look this many calls ahead.
const PR_FOLLOW_CALLS = 4;

// PRs a thread created or linked, from its tool calls in order (with full outputs).
function prLinksOf(calls) {
  const links = new Map();
  const add = (url, at) => {
    for (const [, owner, repo, number] of url.matchAll(PR_URL)) {
      const key = `${owner}/${repo}#${number}`.toLowerCase();
      if (!links.has(key)) links.set(key, { url: `https://github.com/${owner}/${repo}/pull/${number}`, number: Number(number), repository: `${owner}/${repo}`, at });
    }
  };
  let follow = 0;
  for (const call of calls) {
    const input = JSON.stringify(call.input);
    if (PR_LINK_TOOL.test(call.name) || PR_LINK_TOOL.test(input)) add(input, call.at);
    if (PR_CREATE.test(input)) follow = PR_FOLLOW_CALLS;
    if (!follow) continue;
    const url = call.output?.match(PR_URL)?.[0];
    if (url) {
      add(url, call.at);
      follow = 0;
    } else follow--;
  }
  return [...links.values()];
}

// One thread from all its segments: metadata and the summary of its own records.
export function parseThread(thread, { inherited = false } = {}) {
  const { records, malformed, meta, start } = readThread(thread, { inherited });
  const isOwn = (record) => (record.ordinal ?? Infinity) >= start && record.metadata?.inherited_user_message !== true;
  const spawn = meta.source?.subagent?.thread_spawn ?? null;

  const responses = new Map();
  const calls = [];
  const outputs = new Map();
  const texts = [];
  const inheritedTexts = [];
  const apiErrors = {};
  const own = [];
  let model = null;
  let effort = null;
  let interrupts = 0;
  let compactions = 0;
  for (const record of records) {
    const payload = record.payload ?? {};
    if (!isOwn(record)) {
      const text = promptText(payload);
      if (text) inheritedTexts.push({ at: record.timestamp ?? null, text, source: "codex" });
      continue;
    }
    own.push(record);
    if (record.type === "turn_context") {
      model = payload.model ?? model;
      effort = payload.effort ?? payload.collaboration_mode?.settings?.reasoning_effort ?? effort;
    } else if (record.type === "event_msg" && payload.type === "thread_settings_applied") {
      model = payload.thread_settings?.model ?? model;
      effort = payload.thread_settings?.reasoning_effort ?? effort;
    } else if (record.type === "token_usage_record" && payload.usage && (!payload.thread_id || payload.thread_id === thread.id)) {
      responses.set(payload.response_id ?? `${record.timestamp}-${record.ordinal}`, { model: model ?? "unknown", effort, usage: normalizeCodexUsage(payload.usage) });
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
  for (const call of calls) call.output = outputs.get(call.id);
  const toolCalls = calls.map((call) => ({ ...call, ok: call.output === undefined ? null : !FAILED_OUTPUT.test(call.output), output: call.output === undefined ? "" : excerpt(call.output) }));
  return {
    id: thread.id,
    rootId: meta.session_id ?? thread.id,
    subagent: Boolean(spawn) || meta.thread_source === "subagent",
    agentRole: spawn?.agent_role ?? meta.agent_role ?? null,
    agentPath: spawn?.agent_path ?? meta.agent_path ?? null,
    forkedFrom: meta.forked_from_id ?? null,
    cwd: meta.cwd ?? records.find((record) => record.type === "turn_context")?.payload?.cwd ?? null,
    originator: meta.originator ?? null,
    file: thread.files[0],
    ...timestamps(own),
    ...priceRequests(responses.values()),
    toolCalls, apiErrors, interrupts, compactions,
    assistantMessages: responses.size,
    prLinks: prLinksOf(calls),
    texts,
    inheritedTexts,
    malformedLines: malformed,
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
  model: topKey(thread.models),
  effort: topKey(thread.efforts),
  usage: thread.usage,
  costUSD: thread.estimatedCostUSD,
  assistantMessages: thread.assistantMessages,
  toolCalls: thread.toolCalls.length,
  toolErrors: thread.toolCalls.filter((call) => call.ok === false).length,
  unpriced: thread.unpriced,
  malformedLines: thread.malformedLines,
});

function asSession(thread, children, titles) {
  const prompts = thread.texts.filter(({ text }) => !isHostPrompt(text));
  const subagents = children.map(asSubagent);
  const estimated = thread.estimatedCostUSD + subagents.reduce((total, agent) => total + agent.costUSD, 0);
  const prLinks = new Map();
  for (const link of [thread, ...children].flatMap((each) => each.prLinks)) if (!prLinks.has(link.url)) prLinks.set(link.url, link);
  const times = [thread, ...children].flatMap((each) => [each.startedAt, each.endedAt]).filter(Boolean).sort();
  return {
    id: thread.id,
    harness: "codex",
    project: projectKey(thread.cwd),
    cwd: thread.cwd,
    file: thread.file,
    entrypoint: thread.originator,
    title: titles.get(thread.id) ?? null,
    // Subagents often outlast their root's last record, so the session spans them too.
    startedAt: times[0] ?? null,
    endedAt: times.at(-1) ?? null,
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
    prLinks: [...prLinks.values()],
    automation: isAutomation(thread.cwd),
    malformedLines: thread.malformedLines,
  };
}

// Codex sessions active in [since, until], newest first. Subagent threads count as
// subagents of their root thread's session. A thread changed since `since` brings in its
// root and the root's other subagents, however old, so a session is always whole. A
// subagent whose root rollout is gone becomes its own session.
export function loadCodexSessions({ root = codexSessionsRoot(), home = join(root, ".."), since = 0, until = Infinity } = {}) {
  const from = +since;
  const to = +until;
  const threads = rolloutThreads(root);
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const parsed = new Map();
  const parse = (thread) => parsed.set(thread.id, parseThread(thread));
  for (const thread of threads) if (thread.mtimeMs >= from) parse(thread);
  for (const thread of [...parsed.values()])
    if (thread.subagent && !parsed.has(thread.rootId) && byId.has(thread.rootId)) parse(byId.get(thread.rootId));
  const roots = new Set([...parsed.values()].filter((thread) => !thread.subagent).map((thread) => thread.id));
  // A subagent starts after its root, so only threads started since the earliest loaded
  // root can be older subagents of one; their first line says.
  const earliest = Math.min(...[...roots].map((id) => byId.get(id).startedMs));
  for (const thread of threads)
    if (!parsed.has(thread.id) && thread.startedMs >= earliest) {
      const meta = threadMeta(thread);
      if (meta?.source?.subagent && roots.has(meta.session_id)) parse(thread);
    }

  const children = new Map();
  const sessions = [];
  for (const thread of parsed.values()) {
    if (thread.subagent && roots.has(thread.rootId)) {
      if (!children.has(thread.rootId)) children.set(thread.rootId, []);
      children.get(thread.rootId).push(thread);
    } else sessions.push(thread.subagent ? parseThread(byId.get(thread.id), { inherited: true }) : thread);
  }
  const titles = threadTitles(home);
  const byStart = (a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "");
  return sessions
    .map((thread) => asSession(thread, (children.get(thread.id) ?? []).sort(byStart), titles))
    .filter((session) => !session.endedAt || (Date.parse(session.endedAt) >= from && Date.parse(session.startedAt) <= to))
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
}
