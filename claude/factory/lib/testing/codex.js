// Synthetic Codex rollouts for tests, shaped like real ones (Codex CLI 0.166): a
// session_meta first record, turn_context and thread_settings_applied for model and effort,
// response items for prompts and tool calls, one token_usage_record per response, long
// threads continued in segment files, and subagent threads that start with a copy of their
// parent's history before subagent_history_start_ordinal.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const codexUsage = (input = 1000, output = 100, { cached = 800, cacheWrite = 0, reasoning = 10 } = {}) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: cacheWrite,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});

export class Rollout {
  constructor({ id = crypto.randomUUID(), cwd = "/Users/test/project", start = Date.parse("2026-11-01T10:00:00Z"), model = "gpt-test", effort = "high", parent = null, role = "worker", path = "/root/task", originator = "T3 Code" } = {}) {
    Object.assign(this, { id, cwd, clock: start, records: [], ordinal: 0, counter: 0, turn: null, parent, splits: [] });
    const source = parent ? { subagent: { thread_spawn: { parent_thread_id: parent.id, depth: 1, agent_path: path, agent_nickname: "Nick", agent_role: role } } } : "vscode";
    this.push("session_meta", {
      id, session_id: parent ? parent.id : id, cwd, originator, cli_version: "0.166.0", source, model_provider: "openai",
      ...(parent ? { forked_from_id: parent.id, parent_thread_id: parent.id, thread_source: "subagent", agent_role: role, agent_path: path } : {}),
    });
    if (parent) {
      // A forked subagent's file starts with its parent's history (the parent's own
      // session_meta included), then its own settings.
      for (const record of parent.records) this.records.push({ ...record, ordinal: this.ordinal++ });
      this.records[0].payload.subagent_history_start_ordinal = this.ordinal;
      this.event({ type: "thread_settings_applied", thread_id: id, thread_settings: { model, reasoning_effort: effort } });
    } else this.turnContext(model, effort);
  }

  push(type, payload, extra = {}) {
    this.clock += 1000;
    this.records.push({ timestamp: new Date(this.clock).toISOString(), ordinal: this.ordinal++, type, payload, ...extra });
    return this;
  }

  // Moves the clock, so the next record comes later.
  at(iso) {
    this.clock = Date.parse(iso);
    return this;
  }

  event(payload) {
    return this.push("event_msg", payload);
  }

  item(payload, extra) {
    return this.push("response_item", payload, extra);
  }

  turnContext(model, effort = "high") {
    this.turn = `turn_${++this.counter}`;
    return this.push("turn_context", { turn_id: this.turn, model, effort, cwd: this.cwd });
  }

  // A person's prompt (kind user.text); kinds marks injected context instead.
  prompt(text, { kinds = ["user.text"] } = {}) {
    this.event({ type: "task_started", turn_id: this.turn });
    return this.item({ type: "message", role: "user", content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { turn_id: this.turn, content_item_kinds: kinds } });
  }

  // One model response with its usage, logged twice as real rollouts do (token_count too).
  response(use = codexUsage(), { text = "ok" } = {}) {
    const responseId = `resp_${this.id.slice(0, 8)}_${++this.counter}`;
    if (text) this.item({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
    this.push("token_usage_record", { thread_id: this.id, turn_id: this.turn, response_id: responseId, usage: use });
    return this.event({ type: "token_count", info: { last_token_usage: use, total_token_usage: use } });
  }

  // A freeform custom tool call (the exec tool takes code) and its output.
  exec(code, output = "Script completed\nWall time 0.1 seconds\nOutput:\n", options) {
    const callId = `call_${++this.counter}`;
    this.item({ type: "custom_tool_call", call_id: callId, name: "exec", input: code, status: "completed" });
    this.item({ type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text: output }] });
    return this.response(options?.use);
  }

  // A function tool call with JSON arguments and its output.
  call(name, args, output = "{}", { namespace } = {}) {
    const callId = `call_${++this.counter}`;
    this.item({ type: "function_call", call_id: callId, name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args) });
    this.item({ type: "function_call_output", call_id: callId, output });
    return this.response();
  }

  interrupt() {
    return this.event({ type: "turn_aborted", turn_id: this.turn, reason: "interrupted" });
  }

  complete({ error } = {}) {
    return this.event({ type: "task_complete", turn_id: this.turn, ...(error ? { error: { message: "failed", codex_error_info: error } } : {}) });
  }

  compact() {
    return this.push("compacted", { message: "", replacement_history: [] });
  }

  // Continues the thread in a new segment file, as Codex does for a long thread: its
  // session_meta names the thread, and ordinals restart a little below the last one.
  continueInSegment() {
    this.splits.push(this.records.length);
    this.ordinal -= 2;
    return this.push("session_meta", { id: this.id, session_id: this.id, cwd: this.cwd, history_base: { thread_id: this.id } });
  }

  // The segment files' records: [{ records, segment }], segment null for the first file.
  segments() {
    const bounds = [0, ...this.splits, this.records.length];
    return bounds.slice(0, -1).map((from, index) => ({ records: this.records.slice(from, bounds[index + 1]), segment: index ? crypto.randomUUID() : null }));
  }
}

// Writes rollouts into a sessions folder as YYYY/MM/DD/rollout-<time>-<id>.jsonl, later
// segments as rollout-<time>-<id>_<segment>.jsonl, dated by each file's first record (in
// UTC; Codex uses local time). An entry is a Rollout or { rollout, head, tail }: head
// replaces the first file's first line and tail is appended to the last file, both raw
// text. Returns the folder; files lists each rollout's files by id.
export function writeRollouts(rollouts, root = mkdtempSync(join(tmpdir(), "claude-factory-codex-")), files = {}) {
  for (const entry of rollouts) {
    const { rollout, head, tail = "" } = entry instanceof Rollout ? { rollout: entry } : entry;
    const segments = rollout.segments();
    files[rollout.id] = segments.map(({ records, segment }, index) => {
      const started = records[0].timestamp;
      const dir = join(root, started.slice(0, 4), started.slice(5, 7), started.slice(8, 10));
      mkdirSync(dir, { recursive: true });
      const lines = records.map((record) => JSON.stringify(record));
      if (index === 0 && head !== undefined) lines[0] = head;
      const file = join(dir, `rollout-${started.slice(0, 19).replace(/:/g, "-")}-${rollout.id}${segment ? `_${segment}` : ""}.jsonl`);
      writeFileSync(file, `${lines.join("\n")}\n${index === segments.length - 1 ? tail : ""}`);
      return file;
    });
  }
  return root;
}
