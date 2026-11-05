// Runs the Claude Code CLI for the factory: restricted judge calls with structured output,
// and task sessions for benchmarks and proposals. CLAUDE_FACTORY_BIN replaces `claude`
// (tests point it at a fake). Every call is bounded by a budget and a deadline and is
// not saved as a session, so the factory's own calls never get scored or captured.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, runProcess } from "../../tests/lib/process.js";
import { completed, parseStream, resultEvent } from "../../tests/lib/stream.js";

export const STRUCTURED_TOOL = "StructuredOutput";
const bin = () => process.env.CLAUDE_FACTORY_BIN || "claude";

const quietEnv = (overrides = {}) => childEnv(process.env, {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  ...overrides,
});

// A failed call. costUSD is what its stream reported, or null when it never reported a
// result (then the caller cannot know what it spent and should assume its budget).
export class ClaudeCallError extends Error {
  constructor(message, { events = [], stderr = "", code = null } = {}) {
    super(message);
    this.name = "ClaudeCallError";
    Object.assign(this, { events, stderr, code, costUSD: resultEvent(events)?.total_cost_usd ?? null });
  }
}

// Events of a stream cut off mid-run: complete lines only. The last line of a killed
// process is usually truncated, so an unparsable line is expected here, not an error.
function partialEvents(stdout = "") {
  return stdout.split("\n").filter((line) => line.trim()).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return [];
    }
  });
}

// Events of a run's stdout; a run with no parseable stream fails with its exit status.
function eventsOf(result, what) {
  try {
    return parseStream(result.stdout);
  } catch (error) {
    throw new ClaudeCallError(`${what}: ${error.message} (exit ${result.code})`, { stderr: result.stderr.slice(-2000), code: result.code });
  }
}

// A tool-less call that must answer with JSON matching schema. No settings, CLAUDE.md,
// MCP servers, skills or slash commands load; a session that exposes or uses any tool
// other than the structured-output one fails closed.
export async function judge({ prompt, schema, model, effort = "medium", budgetUsd = 0.5, timeoutMs = 240_000 }) {
  const cwd = mkdtempSync(join(tmpdir(), "claude-factory-judge-"));
  try {
    const argv = [bin(), "--print", "--setting-sources", "", "--tools", "", "--strict-mcp-config",
      "--disable-slash-commands", "--no-session-persistence", "--model", model, "--effort", effort,
      "--max-budget-usd", String(budgetUsd), "--output-format", "stream-json", "--verbose",
      "--json-schema", JSON.stringify(schema)];
    let result;
    try {
      result = await runProcess(argv, { cwd, env: quietEnv(), timeout: timeoutMs, input: prompt });
    } catch (error) {
      // A deadline, the output bound or a spawn failure: one failed call, not a crash of
      // the caller's loop. The partial stream may still say what it cost.
      throw new ClaudeCallError(`Judge call did not finish: ${error.message}`, { events: partialEvents(error.stdout), stderr: (error.stderr ?? "").slice(-2000) });
    }
    const events = eventsOf(result, "Judge call");
    for (const event of events) {
      if (event.type === "system" && event.subtype === "init"
        && ((event.tools ?? []).some((tool) => tool !== STRUCTURED_TOOL) || (event.mcp_servers ?? []).length))
        throw new ClaudeCallError("Judge session exposed tools or MCP servers", { events });
      if (event.type === "assistant" && (event.message?.content ?? []).some((block) => block.type === "tool_use" && block.name !== STRUCTURED_TOOL))
        throw new ClaudeCallError("Judge session used a tool", { events });
    }
    const final = resultEvent(events);
    const costUSD = final?.total_cost_usd ?? 0;
    if (!completed(events) || !final.structured_output || typeof final.structured_output !== "object")
      throw new ClaudeCallError(`Judge call failed: ${final?.subtype ?? "no result"}${final?.api_error_status ? ` (HTTP ${final.api_error_status})` : ""}`, { events, code: result.code });
    return { output: final.structured_output, costUSD, events };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// A task session in cwd with the user's configuration. agent runs the session as that
// agent; settings is a path or JSON string passed to --settings; tools limits the
// built-in tools. Returns the stream whether or not the task succeeded.
export async function runTask({
  prompt, cwd, model, effort, agent, settings, tools, budgetUsd = 2, timeoutMs = 900_000,
  permissionMode = "bypassPermissions", env = {}, addDirs = [],
}) {
  const argv = [bin(), "--print", "--no-session-persistence", "--output-format", "stream-json", "--verbose",
    "--permission-mode", permissionMode, "--max-budget-usd", String(budgetUsd)];
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  if (agent) argv.push("--agent", agent);
  if (settings) argv.push("--settings", settings);
  if (tools) argv.push("--tools", tools.join(","));
  // Extra folders the file tools may use; a sandbox profile's allowWrite covers Bash only.
  for (const dir of addDirs) argv.push("--add-dir", dir);
  const result = await runProcess(argv, { cwd, env: quietEnv(env), timeout: timeoutMs, input: prompt });
  const events = eventsOf(result, "Task run");
  const final = resultEvent(events);
  return {
    events,
    ok: completed(events),
    finalText: typeof final?.result === "string" ? final.result : "",
    costUSD: final?.total_cost_usd ?? 0,
    turns: final?.num_turns ?? null,
    durationMs: result.durationMs,
    code: result.code,
    stderr: result.stderr.slice(-2000),
  };
}
