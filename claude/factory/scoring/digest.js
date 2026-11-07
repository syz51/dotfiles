// A bounded, deterministic text digest of a session for the judge: metadata, the human
// prompts, host notices, the main session's assistant text, its tool calls with an
// output excerpt, subagent spawns and the final assistant message. Events are labeled
// ([P2] prompt, [H1] host notice, [A7] assistant text, [T14] tool call, [I1] a fork's
// prompt from its parent conversation) so the judge can cite them; context that session
// start and prompt hooks added shows as [hook <event>, <time>]. Over the size limit
// it keeps prompts and host notices first, then other events from the start and the
// end, and says what it left out.
import { INTERRUPT, isHostPrompt, readRecords, textOf } from "../lib/transcripts.js";

export const DIGEST_CHARS = 60_000;
const PROMPT_CHARS = 4_000;
const TEXT_CHARS = 2_000;
const INPUT_CHARS = 300;
const OUTPUT_CHARS = 300;
const HOOK_CHARS = 400;
// Hook context the judge needs, such as which work board the session's repository has:
// the session start and each prompt. PostToolUse context (lease warnings on each edit) is
// left out, since it would crowd tool calls out of the digest.
const HOOK_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

const flat = (text) => String(text).replace(/\s*\n\s*/g, " ⏎ ");
// The start of text, at most max characters.
const head = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
// The start and end of text, at most max characters, where errors and results show.
function ends(text, max) {
  if (text.length <= max) return text;
  const marker = ` […${text.length - max} chars…] `;
  const half = Math.max(0, Math.floor((max - marker.length) / 2));
  return `${text.slice(0, half)}${marker}${text.slice(text.length - half)}`;
}

const time = (at) => (at ? `${at.slice(0, 16).replace("T", " ")}Z` : "?");

function duration(startedAt, endedAt) {
  const minutes = Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000);
  if (!Number.isFinite(minutes)) return "?";
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

// The most telling fields of a tool call's input, as one short line.
export function compactInput(name, input = {}) {
  const pick = {
    Bash: () => input.command,
    Read: () => input.file_path + (input.offset ? ` @${input.offset}` : ""),
    Write: () => `${input.file_path} (${String(input.content ?? "").length} chars)`,
    Edit: () => `${input.file_path} (-${String(input.old_string ?? "").length}/+${String(input.new_string ?? "").length} chars${input.replace_all ? ", all" : ""})`,
    MultiEdit: () => `${input.file_path} (${(input.edits ?? []).length} edits)`,
    Glob: () => input.pattern + (input.path ? ` in ${input.path}` : ""),
    Grep: () => `${input.pattern}${input.path ? ` in ${input.path}` : ""}${input.glob ? ` (${input.glob})` : ""}`,
    Skill: () => [input.skill, input.args].filter(Boolean).join(" "),
    Agent: () => `${input.subagent_type ?? "general-purpose"}${input.model ? `/${input.model}` : ""}: ${input.description ?? ""}${input.isolation ? ` [${input.isolation}]` : ""}${input.run_in_background ? " [background]" : ""}`,
  }[name === "Task" ? "Agent" : name];
  const value = pick?.();
  return head(flat(typeof value === "string" ? value : JSON.stringify(input)), INPUT_CHARS);
}

const promptEvent = (label, prompt) => ({ kind: "prompt", text: `[${label}] PROMPT (${prompt.source ?? "?"}, ${time(prompt.at)}):\n${ends(prompt.text, PROMPT_CHARS)}` });

const COMMAND = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

// A notice the host sent as a prompt (lib/transcripts.js's isHostPrompt): a slash
// command, a context handoff, a delegated task's result or a pull request update. A
// slash command shows as its name and arguments, anything else as its text.
function hostEvent(label, record, text) {
  const command = COMMAND.exec(text)?.[1];
  if (!command) return { kind: "host", text: `[${label}] HOST NOTICE (${time(record.timestamp)}):\n${ends(text, PROMPT_CHARS)}` };
  const args = flat(COMMAND_ARGS.exec(text)?.[1].trim() ?? "");
  return { kind: "host", text: `[${label}] HOST NOTICE (slash command, ${time(record.timestamp)}): /${command}${args ? ` ${ends(args, PROMPT_CHARS)}` : ""}` };
}

// Whether a user record is a prompt the host sent: what lib/transcripts.js would take as
// a prompt text, apart from its host filter.
const isHostRecord = (record, text) => !record.isMeta && !record.isCompactSummary && record.promptSource !== "system" && !record.isVisibleInTranscriptOnly
  && !(Array.isArray(record.message?.content) && record.message.content.some((block) => block?.type === "tool_result"))
  && isHostPrompt(text);

// The main session's events in transcript order and its final assistant message.
function collectEvents(session, records) {
  const prompts = new Map(session.prompts.map((prompt) => [`${prompt.at}\0${prompt.text}`, prompt]));
  const calls = new Map(session.toolCalls.map((call) => [call.id, call]));
  const events = [];
  const texts = new Map(); // message id -> its text event
  const counters = { prompt: 0, host: 0, assistant: 0, tool: 0 };
  const label = (kind) => `${{ prompt: "P", host: "H", assistant: "A", tool: "T" }[kind]}${++counters[kind]}`;
  for (const record of records) {
    const content = record.message?.content;
    if (record.type === "user" && !record.isSidechain) {
      const text = textOf(content);
      const prompt = prompts.get(`${record.timestamp ?? null}\0${text}`);
      if (prompt) {
        events.push(promptEvent(label("prompt"), prompt));
      } else if (isHostRecord(record, text)) events.push(hostEvent(label("host"), record, text));
      else if (text.startsWith(INTERRUPT)) events.push({ kind: "note", text: "[interrupted by the user]" });
    } else if (record.type === "assistant" && !record.isSidechain && Array.isArray(content)) {
      const id = record.message?.id ?? record.uuid;
      for (const block of content) {
        if (block?.type === "text" && block.text?.trim() && !record.isApiErrorMessage) {
          const existing = texts.get(id);
          if (existing) existing.raw += `\n${block.text}`;
          else {
            const event = { kind: "assistant", label: label("assistant"), raw: block.text };
            texts.set(id, event);
            events.push(event);
          }
        } else if (block?.type === "tool_use") {
          const call = calls.get(block.id);
          const status = call?.ok === true ? "ok" : call?.ok === false ? "ERROR" : "no result";
          const output = call?.output ? ` → ${ends(flat(call.output), OUTPUT_CHARS)}` : "";
          events.push({ kind: "tool", text: `[${label("tool")}] ${block.name} (${status}) ${compactInput(block.name, block.input)}${output}` });
        }
      }
    } else if (record.type === "system" && record.subtype === "compact_boundary") events.push({ kind: "note", text: "[context compacted]" });
    else if (record.type === "attachment" && !record.isSidechain && record.attachment?.type === "hook_additional_context" && HOOK_EVENTS.has(record.attachment.hookEvent)) {
      const text = [record.attachment.content].flat().filter((part) => typeof part === "string").join("\n").trim();
      if (text) events.push({ kind: "hook", text: `[hook ${record.attachment.hookEvent}, ${time(record.timestamp)}] ${head(flat(text), HOOK_CHARS)}` });
    }
  }
  const final = events.findLast((event) => event.kind === "assistant");
  for (const event of events)
    if (event.kind === "assistant")
      event.text = event === final
        ? `[${event.label}] ASSISTANT: (final message, shown in full below)`
        : `[${event.label}] ASSISTANT: ${ends(event.raw, TEXT_CHARS)}`;
  return { events, final: final ? { label: final.label, text: final.raw } : null };
}

function header(session) {
  const count = (map) => Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, n]) => `${key} x${n}`).join(", ") || "none";
  const toolErrors = session.toolCalls.filter((call) => call.ok === false).length;
  const lines = [
    `# Session ${session.id}`,
    `Project: ${session.project}  cwd: ${session.cwd ?? "?"}`,
    `Title: ${session.title ?? "(none)"}  Entrypoint: ${session.entrypoint ?? "?"}`,
    `Time: ${time(session.startedAt)} to ${time(session.endedAt)} (${duration(session.startedAt, session.endedAt)})`,
    `Models: ${count(session.models)}; efforts: ${count(session.efforts)}`,
    `Cost: $${session.costUSD.toFixed(2)} (${session.costSource})${session.linesAdded !== null ? `; lines +${session.linesAdded}/-${session.linesRemoved}` : ""}`,
    `Prompts: ${session.prompts.length}; host notices: ${session.hostPrompts}; assistant messages: ${session.assistantMessages}; tool calls: ${session.toolCalls.length} (${toolErrors} errors); interrupts: ${session.interrupts}; compactions: ${session.compactions}; API errors: ${count(session.apiErrors)}`,
  ];
  if (session.prLinks.length) lines.push(`PRs: ${session.prLinks.map((link) => link.url).join(", ")}`);
  if (session.subagents.length) {
    lines.push(`Subagents (${session.subagents.length}):`);
    for (const agent of session.subagents.slice(0, 40))
      lines.push(`- ${agent.agentType ?? "?"} on ${agent.model ?? "?"}${agent.effort ? `/${agent.effort}` : ""}: ${head(flat(agent.description ?? ""), 120)} (${agent.toolCalls} tool calls, ${agent.toolErrors} errors, $${agent.costUSD.toFixed(2)})`);
    if (session.subagents.length > 40) lines.push(`- … ${session.subagents.length - 40} more`);
  }
  return lines.join("\n");
}

// Indices of items to keep within budget characters: from the start up to half of it,
// then from the end, then from the start again with what is left.
function keepEnds(items, budget) {
  const kept = new Set();
  let used = 0;
  const take = (index) => {
    const size = items[index].text.length + 1;
    if (used + size > budget) return false;
    kept.add(index);
    used += size;
    return true;
  };
  let front = 0;
  while (front < items.length && used < budget / 2 && take(front)) front++;
  let back = items.length - 1;
  while (back >= front && take(back)) back--;
  while (front <= back && take(front)) front++;
  return kept;
}

// Events from index start up to end, with a marker for each run of omitted ones.
function render(events, kept, start = 0, end = events.length) {
  const lines = [];
  let omitted = null;
  const flush = () => {
    if (!omitted) return;
    const parts = Object.entries(omitted).map(([kind, n]) => `${n} ${{ prompt: "prompt", host: "host notice", assistant: "assistant message", tool: "tool call", note: "note", hook: "hook context" }[kind]}${n === 1 ? "" : "s"}`);
    lines.push(`[… omitted to fit the digest: ${parts.join(", ")} …]`);
    omitted = null;
  };
  for (let index = start; index < end; index++) {
    const event = events[index];
    if (kept.has(index)) {
      flush();
      lines.push(event.text);
    } else {
      omitted ??= {};
      omitted[event.kind] = (omitted[event.kind] ?? 0) + 1;
    }
  }
  flush();
  return lines.join("\n");
}

// The digest text. records are the main transcript's records (read from session.file
// when not given). A forked session starts with copies of its parent's records, marked
// forkedFrom; they belong to the parent's score, so only the fork's own events show,
// after the parent's prompts (session.inheritedPrompts) in their own section: the fork
// carries on the task they set.
export function buildDigest(session, { records = readRecords(session.file).records, maxChars = DIGEST_CHARS } = {}) {
  const own = records.filter((record) => !record.forkedFrom);
  const collected = collectEvents(session, own);
  const { final } = collected;
  const inherited = session.inheritedPrompts.map((prompt, index) => promptEvent(`I${index + 1}`, prompt));
  // Inherited prompts first, so the bounding below treats them as the earliest prompts.
  const events = [...inherited, ...collected.events];
  const parent = records.find((record) => record.forkedFrom)?.forkedFrom.sessionId;
  const top = parent
    ? `${header(session)}\nForked from session ${parent}: its ${records.length - own.length} inherited records are left out here and in the counts above, except its ${inherited.length} prompts, shown first as context. Judge the fork's own events against the full request.`
    : header(session);
  const finalBlock = final
    ? `## Final assistant message [${final.label}]\n${ends(final.text, Math.floor(maxChars / 4))}`
    : "## Final assistant message\n(none)";
  const compose = (kept, note) => {
    const before = inherited.length
      ? `\n\n## Prompts from the parent conversation, before the fork; the fork's own events follow\n${render(events, kept, 0, inherited.length)}`
      : "";
    return `${top}${before}\n\n## Events${note}\n${render(events, kept, inherited.length)}\n\n${finalBlock}\n`;
  };
  const full = compose(new Set(events.keys()), "");
  if (full.length <= maxChars) return full;
  // Prompts and host notices first, up to half of the space when they need more; the
  // rest goes to the other events. Omission markers take space too, so shrink until it
  // fits.
  const indexed = events.map((event, index) => ({ ...event, index }));
  const asked = (event) => event.kind === "prompt" || event.kind === "host";
  const prompts = indexed.filter(asked);
  const others = indexed.filter((event) => !asked(event));
  let available = maxChars - compose(new Set(), " (partial)").length - 200;
  for (let attempt = 0; attempt < 8 && available > 0; attempt++) {
    const promptChars = prompts.reduce((sum, event) => sum + event.text.length + 1, 0);
    const keptPrompts = keepEnds(prompts, Math.min(promptChars, available / 2));
    const promptUsed = [...keptPrompts].reduce((sum, i) => sum + prompts[i].text.length + 1, 0);
    const keptOthers = keepEnds(others, available - promptUsed);
    const kept = new Set([...[...keptPrompts].map((i) => prompts[i].index), ...[...keptOthers].map((i) => others[i].index)]);
    const note = ` (partial: ${events.length - kept.size} of ${events.length} events omitted to fit ${maxChars} characters)`;
    const text = compose(kept, note);
    if (text.length <= maxChars) return text;
    available -= text.length - maxChars + 200;
  }
  return `${full.slice(0, maxChars - 40)}\n[… digest truncated …]\n`;
}
