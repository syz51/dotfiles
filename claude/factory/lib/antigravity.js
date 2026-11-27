// Antigravity session transcripts as normalized Session and Turn objects, matching
// lib/transcripts.js and lib/codex.js with harness "antigravity".
// Transcripts live under:
//   ~/.t3/userdata/providers/antigravity/<hash>/antigravity-acp/brain/<conv-id>/.system_generated/logs/transcript.jsonl
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { excerpt, isAgentBrief, isAutomation, priceRequests, timestamps, topKey } from "./transcripts.js";

const TOOL_ERROR = /Command exited with code [1-9]|Encountered error in tool execution/i;

export function antigravityBrainRoots(env = process.env) {
  if (env.AGY_BRAIN_ROOT) return [env.AGY_BRAIN_ROOT];
  const home = env.HOME || homedir();
  const t3Home = env.T3CODE_HOME || join(home, ".t3");
  const providersDir = join(t3Home, "userdata", "providers", "antigravity");
  const roots = [];
  if (existsSync(providersDir)) {
    for (const entry of readdirSync(providersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const brain = join(providersDir, entry.name, "antigravity-acp", "brain");
      if (existsSync(brain)) roots.push(brain);
    }
  }
  return roots;
}

export function antigravityTranscriptFiles(roots = antigravityBrainRoots()) {
  const files = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const conv of readdirSync(root, { withFileTypes: true })) {
      if (!conv.isDirectory()) continue;
      const file = join(root, conv.name, ".system_generated", "logs", "transcript.jsonl");
      if (!existsSync(file)) continue;
      try {
        files.push({ id: conv.name, file, mtimeMs: statSync(file).mtimeMs });
      } catch {}
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readJsonlRecords(file) {
  const records = [];
  let malformed = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === "object" && !Array.isArray(rec)) records.push(rec);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

export function unwrapUserRequest(text) {
  if (typeof text !== "string") return "";
  const inner = /<user_request>\s*([\s\S]*?)\s*<\/user_request>/.exec(text);
  if (inner) return inner[1].trim();
  const outer = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(text);
  if (outer) return outer[1].trim();
  return text.trim();
}

// Antigravity stores each tool argument value as a JSON-encoded string inside args.
export function parseAntigravityArg(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function loadAntigravitySessions({ since = -Infinity, until = Infinity, roots = antigravityBrainRoots() } = {}) {
  const sessions = [];
  for (const { id, file, mtimeMs } of antigravityTranscriptFiles(roots)) {
    if (mtimeMs < since) continue;
    let parsed;
    try {
      parsed = readJsonlRecords(file);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const { records, malformed } = parsed;
    if (!records.length) continue;
    const { startedAt, endedAt } = timestamps(records.map((r) => ({ timestamp: r.created_at })));
    const endMs = Date.parse(endedAt);
    if (!Number.isFinite(endMs) || endMs <= since || endMs > until) continue;
    const startMs = Date.parse(startedAt);
    const durationMs = Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : 0;

    const prompts = [];
    const requests = [];
    const toolCalls = [];
    let pendingCalls = [];
    for (const r of records) {
      if (r.type === "USER_INPUT" && r.source === "USER_EXPLICIT") {
        pendingCalls = [];
        const text = unwrapUserRequest(r.content);
        if (text) prompts.push({ at: r.created_at ?? null, text, source: "user" });
      } else if (r.type === "PLANNER_RESPONSE") {
        pendingCalls = [];
        if (r.model) {
          const model = String(r.model);
          const effortMatch = /-(low|medium|high|xhigh)$/.exec(model);
          requests.push({
            model,
            effort: effortMatch ? effortMatch[1] : null,
            usage: {
              input: Number(r.input_tokens ?? 0),
              output: Number(r.output_tokens ?? 0),
              cacheRead: Number(r.cache_read_tokens ?? 0),
              cacheWrite: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
            },
          });
        }
        if (Array.isArray(r.tool_calls)) {
          for (const tc of r.tool_calls) {
            if (!tc || typeof tc.name !== "string") continue;
            const rawArgs = tc.args && typeof tc.args === "object" && !Array.isArray(tc.args) ? tc.args : {};
            const input = Object.fromEntries(Object.entries(rawArgs).map(([key, value]) => [key, parseAntigravityArg(value)]));
            const call = { id: null, name: tc.name, input, at: r.created_at ?? null, ok: null, output: "" };
            toolCalls.push(call);
            pendingCalls.push(call);
          }
        }
      } else if (r.type === "GENERIC" && typeof r.content === "string" && pendingCalls.length) {
        const call = pendingCalls.shift();
        call.ok = !TOOL_ERROR.test(r.content);
        call.output = excerpt(r.content);
      }
    }

    const priced = priceRequests(requests);
    const cwd = null;
    sessions.push({
      harness: "antigravity",
      id,
      file,
      project: "antigravity",
      cwd,
      branch: null,
      entrypoint: "t3-code",
      title: null,
      startedAt,
      endedAt,
      durationMs,
      automation: isAutomation(cwd),
      origin: prompts.length ? (isAgentBrief(prompts[0].text) ? "agent" : "person") : null,
      prompts,
      hostPrompts: 0,
      inheritedPrompts: [],
      model: topKey(priced.models),
      models: priced.models,
      efforts: priced.efforts,
      usage: priced.usage,
      costByModel: priced.costByModel,
      costUSD: priced.estimatedCostUSD,
      estimatedCostUSD: priced.estimatedCostUSD,
      costSource: "estimated",
      unpriced: priced.unpriced,
      linesAdded: null,
      linesRemoved: null,
      assistantMessages: requests.length,
      prLinks: [],
      toolCalls,
      subagents: [],
      apiErrors: {},
      interrupts: 0,
      compactions: 0,
      malformedLines: malformed,
    });
  }
  return sessions;
}

export function antigravityTurns(file) {
  const { records } = readJsonlRecords(file);
  const turns = [];
  let turn = null;
  for (const r of records) {
    if (r.type === "USER_INPUT" && r.source === "USER_EXPLICIT") {
      if (turn) turn.complete = true;
      const prompt = unwrapUserRequest(r.content);
      turn = {
        index: turns.length + 1,
        start: r.created_at ?? null,
        end: r.created_at ?? null,
        prompt,
        texts: [],
        calls: [],
        hooks: [],
        events: [],
        complete: false,
      };
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
    if (r.created_at) turn.end = r.created_at;
    if (r.type === "PLANNER_RESPONSE" && typeof r.content === "string" && r.content.trim()) {
      turn.texts.push(r.content);
      turn.events.push({ text: r.content });
      turn.complete = true;
    } else if (r.type === "GENERIC" && typeof r.content === "string") {
      const isError = TOOL_ERROR.test(r.content);
      if (isError) {
        const call = { name: "tool", input: {}, output: r.content.slice(0, 800), isError: true };
        turn.calls.push(call);
        turn.events.push({ call });
        turn.complete = false;
      }
    }
  }
  return { sessionId: basename(join(file, "..", "..", "..")), cwd: null, turns };
}
