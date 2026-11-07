// Turns of Claude Code sessions and Codex threads, and the friction signals in each. A turn
// is one prompt (from the person, an orchestrating agent or the host) and the agent's
// work until the next one. Only main sessions are read: a subagent's errors show in its
// own transcript, not here. Transcripts are external data: their text is clipped and
// quoted to the judge, never trusted.
import { basename } from "node:path";
import { contentText, FAILED_OUTPUT, promptText as codexPrompt, readThread } from "../lib/codex.js";
import { promptText, readRecords, textOf } from "../lib/transcripts.js";

const OUTPUT = 600;
const clip = (text, max) => {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
};

// texts, calls and hooks by kind, and events holding all of them in order.
const newTurn = (index, at, prompt) => ({ index, start: at, end: at, prompt, texts: [], calls: [], hooks: [], events: [] });
const addText = (turn, text) => {
  turn.texts.push(text);
  turn.events.push({ text });
};
const addCall = (turn, call) => {
  turn.calls.push(call);
  turn.events.push({ call });
};
const addHook = (turn, hook) => {
  turn.hooks.push(hook);
  turn.events.push({ hook });
};

// Turns of one Claude Code transcript: { sessionId, cwd, turns }. A fork's copy of its
// parent's history is skipped, as it belongs to the parent.
export function claudeTurns(file) {
  const { records } = readRecords(file);
  const own = records.filter((record) => !record.forkedFrom && !record.isSidechain);
  const turns = [];
  let turn = null;
  const calls = new Map();
  for (const record of own) {
    const prompt = promptText(record);
    if (prompt !== null) {
      turn = newTurn(turns.length + 1, record.timestamp ?? null, prompt);
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
    if (record.timestamp) turn.end = record.timestamp;
    const content = record.message?.content;
    if (record.type === "assistant" && Array.isArray(content))
      for (const block of content) {
        if (block?.type === "text" && block.text?.trim()) addText(turn, block.text);
        if (block?.type === "tool_use" && !calls.has(block.id)) {
          const call = { name: block.name, input: block.input ?? {}, ok: null, output: "" };
          calls.set(block.id, call);
          addCall(turn, call);
        }
      }
    else if (record.type === "user" && Array.isArray(content)) {
      for (const block of content)
        if (block?.type === "tool_result" && calls.has(block.tool_use_id)) {
          const call = calls.get(block.tool_use_id);
          call.ok = block.is_error !== true;
          call.output = clip(textOf(block.content), OUTPUT);
        }
    } else if (record.type === "attachment" && /^hook_(?:blocking|non_blocking)_error$/.test(record.attachment?.type ?? "")) {
      const hook = record.attachment;
      addHook(turn, { event: hook.hookName ?? hook.hookEvent ?? "hook", blocking: hook.type === "hook_blocking_error", message: clip(hook.blockingError?.blockingError ?? hook.stderr ?? "", OUTPUT) });
    }
  }
  return {
    sessionId: records.find((record) => record.sessionId)?.sessionId ?? basename(file, ".jsonl"),
    cwd: records.find((record) => record.cwd)?.cwd ?? null,
    turns,
  };
}

// A Codex call failed when the call itself did, or the command it ran exited non-zero.
const codexFailed = (output) => FAILED_OUTPUT.test(output) || /"exit_code":\s*[1-9]|\bexit(?:ed with)? code:? [1-9]/i.test(output);

// Turns of one Codex thread (from lib/codex.js rolloutThreads): { sessionId, cwd, turns },
// or null for a subagent thread. A turn runs from task_started to task_complete or
// turn_aborted; one without either is still running and has complete false.
export function codexTurns(thread) {
  const { records, meta, start } = readThread(thread);
  if (meta.source?.subagent || meta.thread_source === "subagent") return null;
  const turns = [];
  const calls = new Map();
  let turn = null;
  for (const record of records) {
    if ((record.ordinal ?? Infinity) < start) continue;
    const payload = record.payload ?? {};
    if (record.type === "event_msg" && payload.type === "task_started") {
      turn = { ...newTurn(turns.length + 1, record.timestamp ?? null, ""), complete: false };
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
    if (record.timestamp) turn.end = record.timestamp;
    if (record.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")) {
      turn.complete = true;
      continue;
    }
    if (record.type !== "response_item") continue;
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      let input;
      if (payload.type === "custom_tool_call") input = { input: payload.input ?? "" };
      else
        try {
          input = JSON.parse(payload.arguments ?? "{}");
        } catch {
          input = { arguments: payload.arguments };
        }
      const call = { name: payload.namespace ? `${payload.namespace}.${payload.name}` : payload.name, input, ok: null, output: "" };
      calls.set(payload.call_id, call);
      addCall(turn, call);
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const call = calls.get(payload.call_id);
      if (call) {
        const output = contentText(payload.output);
        call.ok = !codexFailed(output);
        call.output = clip(output, OUTPUT);
      }
    } else if (payload.type === "message") {
      const prompt = codexPrompt(payload);
      if (prompt && !turn.prompt) turn.prompt = prompt;
      else if (payload.role === "assistant") {
        const text = contentText(payload.content);
        if (text.trim()) addText(turn, text);
      }
    }
  }
  return { sessionId: thread.id, cwd: meta.cwd ?? null, turns };
}

// A call that filed feedback: the board's MCP tool, or `board feedback` run in a shell.
const FEEDBACK_TOOL = /(?:^|__|\.)feedback$/;
const FEEDBACK_COMMAND = /\bboard\s+feedback\b/;
export const filedFeedback = (turn) => turn.calls.some((call) => FEEDBACK_TOOL.test(call.name) || FEEDBACK_COMMAND.test(JSON.stringify(call.input)));

const BOARD_CALL = /(?:^|__|\.)board(?:__|\.)|^board$/;
// `board <command>` in a shell command, matched in the call's JSON-encoded input.
const BOARD_COMMAND = /(?:^|[\s;&|(/"'])board\s+[a-z]/;
const isBoard = (call) => BOARD_CALL.test(call.name) || BOARD_COMMAND.test(JSON.stringify(call.input));

// Words that say the setup got in the way, in English and Chinese.
export const PHRASES = [
  /\bwork(?:ed)?[- ]?arounds?\b/i, /\bnoisy\b/i, /\bnot relevant\b/i, /\birrelevant\b/i, /\bhad to\b/i,
  /\bkept (?:failing|refusing|blocking)\b/i, /\bfor some reason\b/i,
  /变通|绕过|绕开|不得不|只好|太吵|噪音|不相关|无关|没用|又失败|卡住/,
];

// The friction signals of a turn, and a score to rank turns by. A retry is a failed call
// followed by another call of the same tool.
export function signals(turn) {
  const failed = turn.calls.filter((call) => call.ok === false);
  let retries = 0;
  turn.calls.forEach((call, index) => {
    if (call.ok === false && turn.calls[index + 1]?.name === call.name) retries++;
  });
  const hookBlocks = turn.hooks.length + failed.filter((call) => /\bhook\b/i.test(call.output)).length;
  const boardErrors = failed.filter(isBoard).length;
  const phrases = [turn.prompt, ...turn.texts].reduce((count, text) => count + PHRASES.filter((pattern) => pattern.test(text)).length, 0);
  const score = 3 * boardErrors + 2 * hookBlocks + Math.min(failed.length, 5) + 2 * Math.min(retries, 3) + Math.min(phrases, 3);
  return { toolErrors: failed.length, boardErrors, hookBlocks, retries, phrases, score };
}

// The turn as the judge reads it, at most maxChars: the prompt, then the agent's text,
// tool calls and hook messages in order. Failed calls keep their output; others only
// their input. A turn too long for maxChars keeps the events that show friction (failed
// calls, hooks, friction phrases) and their neighbours, and marks what it left out.
export function digest(turn, { maxChars = 12_000 } = {}) {
  let tools = 0;
  const events = turn.events.map(({ text, call, hook }) => {
    if (text !== undefined) return { line: `[Agent] ${clip(text, 800)}`, key: PHRASES.some((pattern) => pattern.test(text)) };
    if (hook) return { line: `[Hook ${hook.event}${hook.blocking ? ", blocked" : ""}] ${hook.message}`, key: true };
    const status = call.ok === false ? "FAILED" : call.ok === null ? "no result" : "ok";
    return { line: `[Tool ${++tools} ${call.name} ${status}] ${clip(JSON.stringify(call.input), 300)}${call.ok === false ? `\n  output: ${call.output}` : ""}`, key: call.ok === false };
  });
  const head = `[Prompt] ${clip(turn.prompt, 1500)}`;
  const render = (keep) => {
    const lines = [head];
    let omitted = 0;
    events.forEach((event, index) => {
      if (keep(index)) {
        if (omitted) lines.push(`[... ${omitted} events omitted ...]`);
        omitted = 0;
        lines.push(event.line);
      } else omitted++;
    });
    if (omitted) lines.push(`[... ${omitted} events omitted ...]`);
    return lines.join("\n");
  };
  let text = render(() => true);
  if (text.length > maxChars) text = render((index) => [index - 1, index, index + 1].some((near) => events[near]?.key));
  if (text.length > maxChars) text = render((index) => events[index].key);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 40)}\n[... rest of the turn omitted ...]`;
}
