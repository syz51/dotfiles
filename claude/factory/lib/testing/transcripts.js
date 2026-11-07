// Synthetic Claude Code transcripts for tests, shaped like real ones: one assistant record
// per content block repeating the message's usage, prompts with promptSource, cost-state
// and pr-link records, and subagent files with their meta.json.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const usage = (input = 10, output = 100, { cacheRead = 1000, cacheWrite = 200, oneHour = 0 } = {}) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  cache_creation: { ephemeral_5m_input_tokens: cacheWrite - oneHour, ephemeral_1h_input_tokens: oneHour },
});

// A builder for one transcript's records with increasing timestamps.
export class Transcript {
  constructor({ sessionId = crypto.randomUUID(), cwd = "/Users/test/project", start = Date.parse("2026-11-01T10:00:00Z"), entrypoint = "t3-code" } = {}) {
    Object.assign(this, { sessionId, cwd, entrypoint, clock: start, records: [], counter: 0 });
  }

  base(extra = {}) {
    this.clock += 1000;
    return { sessionId: this.sessionId, cwd: this.cwd, entrypoint: this.entrypoint, timestamp: new Date(this.clock).toISOString(), uuid: crypto.randomUUID(), ...extra };
  }

  prompt(text, { source = "sdk", ...extra } = {}) {
    this.records.push(this.base({ type: "user", promptSource: source, message: { role: "user", content: text }, ...extra }));
    return this;
  }

  // One API message; blocks are content blocks, each written as its own record.
  assistant(blocks, { model = "claude-opus-5-5", use = usage(), effort = "high", id = `msg_${++this.counter}`, ...extra } = {}) {
    for (const block of blocks)
      this.records.push(this.base({ type: "assistant", effort, message: { id, model, role: "assistant", content: [block], usage: use }, ...extra }));
    return this;
  }

  text(value, options) {
    return this.assistant([{ type: "text", text: value }], options);
  }

  // A tool call and its result.
  tool(name, input, output = "", { isError = false, ...options } = {}) {
    const id = `toolu_${++this.counter}`;
    this.assistant([{ type: "tool_use", id, name, input }], options);
    this.records.push(this.base({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output, ...(isError ? { is_error: true } : {}) }] } }));
    return this;
  }

  interrupt() {
    this.records.push(this.base({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
    return this;
  }

  apiError(status = 429) {
    this.records.push(this.base({ type: "assistant", isApiErrorMessage: true, apiErrorStatus: status, message: { id: `err_${++this.counter}`, model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } }));
    return this;
  }

  compact() {
    this.records.push(this.base({ type: "system", subtype: "compact_boundary" }));
    return this;
  }

  // The Stop hooks' summary that ends a turn, or that makes it go on when prevented.
  stop({ prevented = false } = {}) {
    this.records.push(this.base({ type: "system", subtype: "stop_hook_summary", hookCount: 1, hookErrors: [], preventedContinuation: prevented }));
    return this;
  }

  meta(record) {
    this.records.push({ sessionId: this.sessionId, ...record });
    return this;
  }

  costState(totalCostUSD, extra = {}) {
    return this.meta({ type: "cost-state", totalCostUSD, totalLinesAdded: 5, totalLinesRemoved: 2, ...extra });
  }

  prLink(url, number = Number(url.split("/").at(-1))) {
    return this.meta({ type: "pr-link", prUrl: url, prNumber: number, prRepository: url.split("/").slice(3, 5).join("/"), timestamp: new Date(this.clock).toISOString() });
  }

  title(aiTitle) {
    return this.meta({ type: "ai-title", aiTitle });
  }

  jsonl() {
    return `${this.records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  }
}

// Writes transcripts into a fresh projects folder: sessions are
// [{ project, transcript, subagents: [{ id, meta, transcript }], tail }], where tail is
// raw text appended to the main file (for partial lines).
export function writeProjects(sessions, root = mkdtempSync(join(tmpdir(), "claude-factory-projects-"))) {
  for (const { project = "-Users-test-project", transcript, subagents = [], tail = "" } of sessions) {
    const dir = join(root, project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${transcript.sessionId}.jsonl`), transcript.jsonl() + tail);
    if (subagents.length) {
      const agents = join(dir, transcript.sessionId, "subagents");
      mkdirSync(agents, { recursive: true });
      for (const agent of subagents) {
        writeFileSync(join(agents, `${agent.id}.jsonl`), agent.transcript.jsonl());
        if (agent.meta) writeFileSync(join(agents, `${agent.id}.meta.json`), JSON.stringify(agent.meta));
      }
    }
  }
  return root;
}
