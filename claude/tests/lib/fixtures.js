// Builders for small synthetic stream-json traces used by the offline tests and the fake
// claude CLI. They mirror the shapes Claude Code 2.1 emits in print mode.
let counter = 0;
const nextId = (prefix) => `${prefix}_${String(++counter).padStart(4, "0")}`;

export const init = (overrides = {}) => ({
  type: "system", subtype: "init", cwd: "/work", session_id: "session-1", model: "claude-opus-5-5",
  tools: ["Bash", "Read", "Skill", "Agent"], agents: ["explorer", "worker", "solver"], skills: ["typescript"], ...overrides,
});

// One assistant event carrying one content block, as the CLI streams them.
export function assistant(block, { parent = null, model = "claude-opus-5-5", message = nextId("msg") } = {}) {
  return { type: "assistant", parent_tool_use_id: parent, message: { id: message, model, role: "assistant", content: [block] } };
}

export const text = (value, options) => assistant({ type: "text", text: value }, options);

export function toolUse(name, input, options = {}) {
  const id = options.id ?? nextId("toolu");
  return { id, event: assistant({ type: "tool_use", id, name, input }, options) };
}

export const toolResult = (id, content, { isError = false, meta, parent = null } = {}) => ({
  type: "user", parent_tool_use_id: parent, tool_use_result: meta,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
});

export const result = (overrides = {}) => ({
  type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0.0123, num_turns: 2, ...overrides,
});

// A Read call and its result; partial reads return fewer lines than the file has.
export function read(path, content, { partial = false, isError = false, parent = null } = {}) {
  const use = toolUse("Read", { file_path: path }, { parent });
  const lines = content.split("\n").length;
  const meta = isError ? undefined : { type: "text", file: { filePath: path, content, startLine: 1, numLines: partial ? 1 : lines, totalLines: lines } };
  return [use.event, toolResult(use.id, isError ? "File does not exist." : content, { isError, meta, parent })];
}

export function bash(command, output, { isError = false, parent = null, id } = {}) {
  const use = toolUse("Bash", { command }, { parent, id });
  return [use.event, toolResult(use.id, output, { isError, parent })];
}

export function skill(name, { parent = null } = {}) {
  const use = toolUse("Skill", { skill: name }, { parent });
  return [use.event, toolResult(use.id, `Launching skill: ${name}`, { parent })];
}

export const stream = (events) => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
