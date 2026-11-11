// OpenCode V2's read-only service API, via its supported discovery/authentication CLI.
// No database, credential files or transcript snapshots are read or written here.
// Contract checked against 2.2.7 /openapi.json: session.list and session.message.list.
import { runProcess } from "../../tests/lib/process.js";
import { projectKey } from "./codex.js";
import { addUsage, emptyUsage, requestCost } from "./pricing.js";
import { excerpt, isAgentBrief, isAutomation, isHostPrompt, topKey } from "./transcripts.js";
import { sessionPrs, sessionPushes } from "../metrics/prs.js";

const PAGE_SIZE = 100;
const MAX_CALLS = 2000;
const DEADLINE_MS = 300_000;
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const iso = (value) => new Date(value).toISOString();
const total = (values) => values.reduce((sum, value) => sum + value, 0);
const bad = (what) => { throw new Error(`OpenCode API: invalid ${what}`); };

export async function openCodeApi(path) {
  // Keep this boundary GET-only and narrow, including when callers supply a path.
  if (!/^\/api\/session(?:\?|\/[^/?]+(?:\/message\?)|$)/.test(path)) throw new Error("OpenCode API: unsupported read path");
  let result;
  try {
    result = await runProcess([process.env.CLAUDE_FACTORY_OPENCODE || "opencode", "api", "get", path], {
      timeout: 30_000, maxBytes: 16 * 1024 * 1024,
    });
  } catch {
    // CLI diagnostics may contain service addresses, auth context or response bodies.
    throw new Error("OpenCode API: CLI unavailable, timed out or exceeded its output bound");
  }
  if (result.code !== 0) throw new Error(`OpenCode API: CLI exited ${result.code}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("OpenCode API: CLI returned invalid JSON");
  }
}

function checkInfo(info) {
  if (!object(info) || typeof info.id !== "string" || !info.id || !number(info.time?.created) || !number(info.time?.updated)
    || typeof info.location?.directory !== "string" || (info.parentID !== undefined && typeof info.parentID !== "string")) bad("session header");
  if (info.fork !== undefined && (typeof info.fork?.sessionID !== "string" || !["before", "through"].includes(info.fork?.boundary?.type)
    || typeof info.fork.boundary.messageID !== "string")) bad("fork boundary");
  for (const key of ["busy", "idle"]) if (info.time[key] !== undefined && !number(info.time[key])) bad("session time");
  if ((info.agent !== undefined && typeof info.agent !== "string") || (info.title !== undefined && typeof info.title !== "string")) bad("session metadata");
  return info;
}

function checkMessage(message) {
  if (!object(message) || typeof message.id !== "string" || !message.id || typeof message.type !== "string" || !number(message.time?.created)) bad("message header");
  for (const key of ["streamed", "completed"]) if (message.time[key] !== undefined && !number(message.time[key])) bad("message time");
  if (["user", "synthetic", "system"].includes(message.type) && typeof message.text !== "string") bad("prompt text");
  if (message.type === "assistant") {
    if (typeof message.model?.id !== "string" || typeof message.model?.providerID !== "string" || !Array.isArray(message.content)) bad("assistant message");
    for (const part of message.content) {
      if (!object(part) || typeof part.type !== "string") bad("assistant content");
      if (part.type === "text" && typeof part.text !== "string") bad("assistant text");
      if (part.type === "tool" && (typeof part.id !== "string" || typeof part.name !== "string"
        || !["streaming", "running", "completed", "error"].includes(part.state?.status)
        || (part.state.status === "streaming" ? typeof part.state.input !== "string" : !object(part.state.input)))) bad("tool call");
      if (part.type === "tool") {
        if (!number(part.time?.created)) bad("tool time");
        for (const key of ["ran", "completed"]) if (part.time[key] !== undefined && !number(part.time[key])) bad("tool time");
        if (part.state.content !== undefined && (!Array.isArray(part.state.content)
          || part.state.content.some((item) => !object(item) || typeof item.type !== "string" || item.type === "text" && typeof item.text !== "string"))) bad("tool output");
        if (part.state.error !== undefined && typeof part.state.error?.message !== "string") bad("tool error");
      }
    }
  }
  if (message.tokens !== undefined && (!object(message.tokens) || !number(message.tokens.input) || !number(message.tokens.output)
    || !number(message.tokens.reasoning) || !number(message.tokens.cache?.read) || !number(message.tokens.cache?.write))) bad("token usage");
  if (message.cost !== undefined && !number(message.cost)) bad("message cost");
  if (message.model !== undefined && (typeof message.model?.id !== "string" || typeof message.model?.providerID !== "string"
    || message.model.variant !== undefined && typeof message.model.variant !== "string")) bad("message model");
  if (message.error !== undefined && (typeof message.error?.type !== "string" || typeof message.error?.message !== "string"
    || message.error.status !== undefined && !number(message.error.status))) bad("message error");
  if (message.type === "idle" && !["succeeded", "failed", "interrupted"].includes(message.outcome)) bad("idle outcome");
  return message;
}

// Pages can overlap while a session is being written. Last projection wins by stable ID;
// follow opaque next cursors (even a short page has one), never decode or construct them.
async function pages(path, get, check) {
  const items = new Map();
  const seen = new Set();
  let cursor;
  for (;;) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...(cursor ? { cursor } : { order: "asc" }) });
    const page = await get(`${path}?${query}`);
    if (!Array.isArray(page?.data) || !object(page.cursor) || (page.cursor.next != null && typeof page.cursor.next !== "string")) bad("page");
    for (const item of page.data) {
      const checked = check(item);
      items.set(checked.id, checked);
    }
    if (!page.cursor.next) break;
    if (seen.has(page.cursor.next)) throw new Error("OpenCode API: repeated pagination cursor");
    seen.add(page.cursor.next);
    cursor = page.cursor.next;
  }
  return [...items.values()];
}

// Load whole root/descendant groups if any member changed in the window. Old ancestors
// still supply ownership and old siblings still belong to the root's lifetime metrics.
// Errors fail the read, never masquerade as an empty, successfully observed runtime.
export async function loadOpenCodeData({ since = 0, until = Infinity, api = openCodeApi } = {}) {
  let calls = 0;
  const deadline = Date.now() + DEADLINE_MS;
  const get = (path) => {
    if (++calls > MAX_CALLS || Date.now() > deadline) throw new Error("OpenCode API: scan bound exceeded");
    return api(path);
  };
  const infos = await pages("/api/session", get, checkInfo);
  const byId = new Map(infos.map((info) => [info.id, info]));
  const rootOf = (info) => {
    const seen = new Set([info.id]);
    while (info.parentID && byId.has(info.parentID)) {
      if (seen.has(info.parentID)) bad("session ancestry cycle");
      seen.add(info.parentID);
      info = byId.get(info.parentID);
    }
    return info.id;
  };
  const roots = new Set(infos.filter((info) => info.time.updated >= +since && info.time.created <= +until).map(rootOf));
  const selected = infos.filter((info) => roots.has(rootOf(info)));
  // Fetch fork sources too, so copied messages have an owner even outside this window.
  for (let i = 0; i < selected.length; i++) {
    const source = byId.get(selected[i].fork?.sessionID);
    if (source && !selected.includes(source)) selected.push(source);
  }
  const ordered = [], visiting = new Set(), visited = new Set();
  const visit = (info) => {
    if (visited.has(info.id)) return;
    if (visiting.has(info.id)) bad("session ancestry cycle");
    visiting.add(info.id);
    for (const id of [info.parentID, info.fork?.sessionID]) {
      const ancestor = selected.find((entry) => entry.id === id);
      if (ancestor) visit(ancestor);
    }
    visiting.delete(info.id);
    visited.add(info.id);
    ordered.push(info);
  };
  for (const info of selected.sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))) visit(info);
  const owners = new Map();
  const data = [];
  for (const info of ordered) {
    const messages = await pages(`/api/session/${encodeURIComponent(info.id)}/message`, get, checkMessage);
    const own = messages.filter((message) => {
      // Forks retain pre-creation history. Shared IDs also cover copied parent history.
      if (message.time.created < info.time.created || owners.has(message.id)) return false;
      owners.set(message.id, info.id);
      return true;
    }); // The API's ascending timeline order also settles equal timestamps.
    if (roots.has(rootOf(info))) data.push({ info, messages: own, rootId: rootOf(info) });
  }
  return data;
}

// OpenCode input excludes caches; reasoning is a subset of output, not extra tokens.
export const normalizeOpenCodeUsage = (tokens) => ({ input: tokens.input, output: tokens.output,
  cacheRead: tokens.cache.read, cacheWrite5m: tokens.cache.write, cacheWrite1h: 0 });
const textContent = (content) => Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") : "";
export const openCodeMessageTime = (message) => (message.content ?? []).reduce((at, part) => part.type === "tool"
  ? Math.max(at, part.time.created, part.time.ran ?? 0, part.time.completed ?? 0) : at,
  Math.max(message.time.created, message.time.streamed ?? 0, message.time.completed ?? 0));

export function openCodeCall(part) {
  const state = part.state;
  const output = textContent(state.content) || state.error?.message || "";
  const shell = part.name === "shell" ? state.metadata : undefined;
  const ok = state.status === "error" ? false : state.status !== "completed" ? null
    : shell?.status === "running" ? null
    : shell?.timeout === true || shell?.signal || (Number.isFinite(shell?.exit) && shell.exit !== 0) ? false : true;
  return { id: part.id, name: part.name, input: object(state.input) ? state.input : { input: state.input },
    ok,
    output: excerpt(output), at: number(part.time?.created) ? iso(part.time.created) : null };
}

function summarize({ info, messages }) {
  const models = {}, efforts = {}, usage = {}, costByModel = {}, apiErrors = {};
  const toolCalls = [], prompts = [];
  let costUSD = 0, unpriced = false, estimated = false, assistantMessages = 0, interrupts = 0, compactions = 0, hostPrompts = 0;
  for (const message of messages) {
    if (message.type === "user") {
      if (isHostPrompt(message.text)) hostPrompts++;
      else prompts.push({ at: iso(message.time.created), text: message.text, source: "opencode" });
    }
    if (message.type === "idle" && message.outcome === "interrupted") interrupts++;
    if (message.type === "compaction" && message.status === "completed") compactions++;
    if (message.type === "idle" && message.error) {
      const status = String(message.error.status ?? message.error.type ?? "unknown");
      apiErrors[status] = (apiErrors[status] ?? 0) + 1;
    }
    if (message.type === "assistant") {
      assistantMessages++;
      for (const part of message.content) if (part.type === "tool") toolCalls.push(openCodeCall(part));
    }
    if (message.type !== "assistant" && message.type !== "compaction") continue;
    if (!message.model) { if (message.tokens || message.cost) unpriced = true; continue; }
    // Keep the provider: the same model ID can have different prices on another provider.
    const model = `${message.model.providerID}/${message.model.id}`;
    models[model] = (models[model] ?? 0) + 1;
    if (message.model.variant) efforts[message.model.variant] = (efforts[message.model.variant] ?? 0) + 1;
    const normalized = message.tokens ? normalizeOpenCodeUsage(message.tokens) : null;
    if (normalized) addUsage(usage[model] ??= emptyUsage(), normalized);
    // Some providers record zero when they have no price. Never call that free usage.
    const hasTokens = normalized && Object.values(normalized).some((value) => value > 0);
    let cost = number(message.cost) && (message.cost > 0 || !hasTokens && normalized) ? message.cost : null;
    if (cost === null && normalized) {
      cost = requestCost(model, normalized);
      if (cost !== null) estimated = true;
    }
    if (cost === null) unpriced = true;
    else {
      costUSD += cost;
      costByModel[model] = (costByModel[model] ?? 0) + cost;
    }
  }
  return { id: info.id, harness: "opencode", project: projectKey(info.location.directory), cwd: info.location.directory,
    file: null, entrypoint: "opencode-api", title: info.title ?? null,
    startedAt: iso(info.time.created), endedAt: iso(messages.reduce((end, message) => Math.max(end, openCodeMessageTime(message)), info.time.created)),
    models, efforts, usage, costByModel, costUSD, costSource: unpriced ? "partial" : estimated ? "estimated" : "api",
    estimatedCostUSD: costUSD, unpriced, prompts, hostPrompts,
    origin: info.parentID ? "agent" : prompts.length ? (isAgentBrief(prompts[0].text) ? "agent" : "person") : null,
    forkedFrom: info.fork?.sessionID ?? null, inheritedPrompts: [], assistantMessages, toolCalls, apiErrors, interrupts, compactions,
    linesAdded: null, linesRemoved: null, subagents: [], prLinks: [], automation: isAutomation(info.location.directory), malformedLines: 0 };
}

export function openCodeSessions(data, { since = 0, until = Infinity } = {}) {
  const groups = Map.groupBy(data, (entry) => entry.rootId);
  return [...groups.values()].map((group) => {
    const root = group.find((entry) => entry.info.id === entry.rootId);
    if (!root) bad("missing group root");
    const session = summarize(root);
    const descendants = group.filter((entry) => entry !== root).map((entry) => ({ info: entry.info, session: summarize(entry) }));
    session.subagents = descendants.map(({ info, session: child }) => ({ id: child.id, parentAgentId: info.parentID === root.info.id ? null : info.parentID,
      agentType: info.agent ?? "default", description: null, toolUseId: null, model: topKey(child.models), effort: topKey(child.efforts),
      models: child.models, usage: child.usage, costByModel: child.costByModel, costUSD: child.costUSD, costSource: child.costSource,
      assistantMessages: child.assistantMessages, toolCalls: child.toolCalls.length, toolErrors: child.toolCalls.filter((call) => call.ok === false).length,
      unpriced: child.unpriced, malformedLines: 0 }));
    session.ownCostUSD = session.costUSD;
    session.ownCostSource = session.costSource;
    session.descendantCostUSD = total(session.subagents.map((agent) => agent.costUSD));
    session.costUSD += session.descendantCostUSD;
    session.estimatedCostUSD = session.costUSD;
    session.unpriced ||= session.subagents.some((agent) => agent.unpriced);
    if (session.unpriced) session.costSource = "partial";
    else if (session.subagents.some((agent) => agent.costSource === "estimated")) session.costSource = "estimated";
    session.endedAt = [session, ...descendants.map((entry) => entry.session)].map((entry) => entry.endedAt).sort().at(-1);
    const all = [session, ...descendants.map((entry) => entry.session)];
    session.prLinks = all.flatMap(sessionPrs);
    session.descendantPushes = descendants.flatMap(({ session: child }) => sessionPushes(child));
    for (const { session: child } of descendants) {
      session.interrupts += child.interrupts;
      session.compactions += child.compactions;
      for (const [status, count] of Object.entries(child.apiErrors)) session.apiErrors[status] = (session.apiErrors[status] ?? 0) + count;
    }
    return session;
  }).filter((session) => Date.parse(session.endedAt) >= +since && Date.parse(session.startedAt) <= +until);
}

export async function loadOpenCodeSessions(options = {}) {
  return openCodeSessions(await loadOpenCodeData(options), options);
}
