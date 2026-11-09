// Turns of Claude Code sessions and Codex threads, and the friction signals in each. A turn
// is one prompt (from the person, an orchestrating agent or the host) and the agent's
// work until the next one. Only main sessions are read: a subagent's errors show in its
// own transcript, not here. Transcripts are external data: their text is clipped and
// quoted to the judge, never trusted.
import { basename } from "node:path";
import { contentText, FAILED_OUTPUT, promptText as codexPrompt, readThread } from "../lib/codex.js";
import { promptText, readRecords, textOf } from "../lib/transcripts.js";

const OUTPUT = 800;
const clip = (text, max) => {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
};
// A failed call's output keeps its start and its end, where the error usually is.
const ends = (text, max = OUTPUT) => {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.35);
  return `${value.slice(0, head)}\n[... ${value.length - max} characters omitted ...]\n${value.slice(value.length - (max - head))}`;
};

// texts, calls and hooks by kind, and events holding all of them in order. complete says
// whether the turn has ended: the next prompt started, Claude Code's Stop hooks let it end,
// or Codex marked it complete or aborted.
const newTurn = (index, at, prompt) => ({ index, start: at, end: at, prompt, texts: [], calls: [], hooks: [], events: [], complete: false });
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
      if (turn) turn.complete = true;
      turn = newTurn(turns.length + 1, record.timestamp ?? null, prompt);
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
    if (record.timestamp) turn.end = record.timestamp;
    // The Stop hooks' summary ends the turn unless a hook made the agent go on; any later
    // work reopens it.
    if (record.type === "system" && record.subtype === "stop_hook_summary") turn.complete = record.preventedContinuation !== true;
    else if (record.type === "assistant" || record.type === "user") turn.complete = false;
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
          call.output = ends(textOf(block.content));
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
      turn = newTurn(turns.length + 1, record.timestamp ?? null, "");
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
        // As in lib/codex.js: a command exiting non-zero inside a script that completed
        // is the script's business, not a failed call.
        call.ok = !FAILED_OUTPUT.test(output);
        call.output = ends(output);
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

// What a call runs in a shell: Claude Code's Bash command, a Codex shell command or
// exec_command, or a Codex custom tool's script. Other inputs, such as a Bash call's
// description or an edit's text, only mention commands.
export const commandText = (call) => {
  const input = call.input ?? {};
  return [input.command, input.cmd, input.input].flat().filter((part) => typeof part === "string").join(" ");
};

// A call that filed feedback: the board's MCP tool, or `board feedback` run in a shell. A
// call that failed (an older `board` rejecting its options, say) filed nothing, so the
// capture still judges that turn.
const FEEDBACK_TOOL = /(?:^|__|\.)feedback$/;
const FEEDBACK_COMMAND = /\bboard\s+feedback\b/;
export const filedFeedback = (turn) => turn.calls.some((call) => call.ok !== false && (FEEDBACK_TOOL.test(call.name) || FEEDBACK_COMMAND.test(commandText(call))));

const BOARD_CALL = /(?:^|__|\.)board(?:__|\.)|^board$/;
const BOARD_COMMAND = /(?:^|[\s;&|(/"'])board\s+[a-z]/;
const isBoard = (call) => BOARD_CALL.test(call.name) || BOARD_COMMAND.test(commandText(call));
// A board error the server counts itself: an answer with its error code, as the board's
// MCP tools ("error: <code>: …") and CLI ("board: <code>: …") print it, or text over a
// limit that the CLI refused before sending and reported to the server. The server files
// a signal once enough agents hit it, so capture leaves these alone. Other refusals reach
// no server, such as a runtime's schema check or `board mcp` rejecting an argument, and
// stay friction. See agent-board's docs/API.md "Errors" and docs/DESIGN.md "Client
// refusals".
const SERVER_ERROR = /^(?:error|board): (?:(?:invalid|evidence_required|invalid_transition|unauthorized|forbidden|not_found|version_conflict|claim_refused|internal): |\S+ is \d+ characters; the limit is \d+ \(not sent\)$)/m;
const serverCounted = (call) => isBoard(call) && SERVER_ERROR.test(call.output);

// The program a shell call runs first, to tell a retry from the next step.
const program = (call) => commandText(call).trim().split(/\s+/)[0]?.split("/").pop() ?? "";
// A search or comparison that found nothing exits 1 without output: an answer, not a failure.
const SEARCHES = new Set(["rg", "grep", "ugrep", "test", "[", "diff", "cmp"]);
const quietMiss = (call) => SEARCHES.has(program(call)) && /^\s*(?:Exit code 1\s*)?$/.test(call.output);

// Words that say the setup got in the way, in English and Chinese.
export const PHRASES = [
  /\bwork(?:ed)?[- ]?arounds?\b/i, /\bnoisy\b/i, /\bnot relevant\b/i, /\birrelevant\b/i, /\bhad to\b/i,
  /\bkept (?:failing|refusing|blocking)\b/i, /\bfor some reason\b/i,
  /变通|绕过|绕开|不得不|只好|太吵|噪音|不相关|无关|没用|又失败|卡住/,
];

// The friction signals of a turn, and a score to rank turns by. A retry is a failed call
// followed by another call of the same tool running the same program. Phrases count in the
// agent's own text, not in the prompt it was given. A turn whose only friction is board
// errors the server counts (serverErrors) scores 0; with any other friction it scores as
// usual, those errors included.
export function signals(turn) {
  const failedAt = (call) => call.ok === false && !quietMiss(call);
  const failed = turn.calls.filter(failedAt);
  let retries = 0;
  turn.calls.forEach((call, index) => {
    const next = turn.calls[index + 1];
    if (failedAt(call) && next?.name === call.name && program(next) === program(call)) retries++;
  });
  const hookBlocks = turn.hooks.length + failed.filter((call) => /\bhook\b/i.test(call.output)).length;
  const boardErrors = failed.filter(isBoard).length;
  const serverErrors = failed.filter(serverCounted).length;
  const phrases = turn.texts.reduce((count, text) => count + PHRASES.filter((pattern) => pattern.test(text)).length, 0);
  const otherFriction = failed.length > serverErrors || turn.hooks.length > 0 || phrases > 0;
  const score = otherFriction ? 3 * boardErrors + 2 * hookBlocks + Math.min(failed.length, 5) + 2 * Math.min(retries, 3) + Math.min(phrases, 3) : 0;
  return { toolErrors: failed.length, boardErrors, serverErrors, hookBlocks, retries, phrases, score };
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
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 40)}\n[... rest of the turn omitted ...]`;
  // The judge reads the turn between <turn> tags; a tag inside it cannot close them.
  return text.replace(/<\s*\/?\s*turn\b[^>]*>/gi, "[turn tag]");
}
