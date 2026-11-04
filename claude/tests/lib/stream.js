// Evidence from `claude -p --output-format stream-json --verbose` output. Only tool
// calls and their results count as evidence of actions; the model's text claims do not.

export function parseStream(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Empty stream");
  return text.split("\n").filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Malformed stream line ${index + 1}: ${line.slice(0, 200)}`);
    }
  });
}

export const initEvent = (events) => events.find((event) => event.type === "system" && event.subtype === "init");
export const resultEvent = (events) => events.findLast((event) => event.type === "result");
export const cost = (events) => resultEvent(events)?.total_cost_usd ?? 0;

// Whether the session ended normally. With allowMaxTurns, stopping at the turn limit
// also counts, for scenarios whose assertion needs only the first steps.
export function completed(events, { allowMaxTurns = false } = {}) {
  const result = resultEvent(events);
  if (!result) return false;
  if (result.subtype === "success") return result.is_error === false;
  return allowMaxTurns && result.subtype === "error_max_turns";
}

// The final reply. Fails closed when the session produced none.
export function finalText(events) {
  const result = resultEvent(events);
  if (result?.subtype !== "success" || typeof result.result !== "string" || !result.result.trim())
    throw new Error("Missing final answer");
  return result.result;
}

// Every tool call in order: parent is the Agent tool_use id for a subagent's calls,
// null for the main session's, and message is the API message that issued it.
export function toolUses(events, name) {
  const uses = [];
  for (const event of events) {
    if (event.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content)
      if (block.type === "tool_use" && (!name || block.name === name))
        uses.push({ id: block.id, name: block.name, input: block.input ?? {}, parent: event.parent_tool_use_id ?? null, message: event.message.id, model: event.message.model });
  }
  return uses;
}

const blockText = (content) => typeof content === "string"
  ? content
  : Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "";

// Tool results by tool_use id, with the structured tool_use_result when present.
export function toolResults(events) {
  const results = new Map();
  events.forEach((event, index) => {
    if (event.type !== "user" || !Array.isArray(event.message?.content)) return;
    for (const block of event.message.content)
      if (block.type === "tool_result")
        results.set(block.tool_use_id, { isError: block.is_error === true, text: blockText(block.content), meta: event.tool_use_result, index });
  });
  return results;
}

// Skills loaded with the Skill tool, in call order. Main session only unless a parent is given.
export const skillLoads = (events, { parent = null } = {}) => toolUses(events, "Skill")
  .filter((use) => use.parent === parent)
  .map((use) => use.input.skill);

// Bash calls with their outcome: ok is false for a nonzero exit, a hook block or no result.
export function bashRuns(events) {
  const results = toolResults(events);
  return toolUses(events, "Bash").map((use) => {
    const result = results.get(use.id);
    return { id: use.id, parent: use.parent, command: use.input.command, ok: !!result && !result.isError, output: result?.text ?? "" };
  });
}

// Read calls with their outcome. complete means the whole file came back.
export function fileReads(events) {
  const results = toolResults(events);
  return toolUses(events, "Read").map((use) => {
    const result = results.get(use.id);
    const file = result && !result.isError ? result.meta?.file : undefined;
    const complete = !!file && file.startLine === 1 && file.numLines >= file.totalLines;
    return { id: use.id, parent: use.parent, path: use.input.file_path, ok: !!result && !result.isError, complete };
  });
}

export const agentSpawns = (events, subagentType) => toolUses(events, "Agent")
  .filter((use) => !subagentType || use.input.subagent_type === subagentType);

// API messages that subagents started by the given Agent calls produced.
export function subagentMessages(events, spawns) {
  const ids = new Set(spawns.map((spawn) => spawn.id));
  return events.filter((event) => event.type === "assistant" && ids.has(event.parent_tool_use_id));
}

// Whether two of the spawns ran at the same time: one was issued while another was
// still running. A spawn runs until its result, its last subagent event or, for an
// agent Claude Code runs in the background (whose result only confirms the launch), its
// task_notification, whichever comes last. A spawn after another finished is sequential.
export function concurrentSpawns(events, spawns) {
  const ids = new Set(spawns.map((spawn) => spawn.id));
  const issued = new Map();
  const ended = new Map();
  const end = (id, index) => ids.has(id) && ended.set(id, Math.max(ended.get(id) ?? index, index));
  events.forEach((event, index) => {
    if (event.type === "assistant" && Array.isArray(event.message?.content))
      for (const block of event.message.content) if (block.type === "tool_use" && ids.has(block.id)) issued.set(block.id, index);
    if (event.type === "user" && Array.isArray(event.message?.content))
      for (const block of event.message.content) if (block.type === "tool_result") end(block.tool_use_id, index);
    if (event.type === "system" && event.subtype === "task_notification") end(event.tool_use_id, index);
    if (event.parent_tool_use_id) end(event.parent_tool_use_id, index);
  });
  const spans = [...ids].filter((id) => issued.has(id) && ended.has(id)).map((id) => [issued.get(id), ended.get(id)]);
  return spans.some(([from], i) => spans.some(([otherFrom, otherTo], j) => i !== j && otherFrom <= from && from < otherTo));
}
