// Runs the Claude Code CLI for the factory: restricted judge calls with structured output,
// and task sessions for benchmarks and proposals. CLAUDE_FACTORY_BIN replaces `claude`
// (tests point it at a fake). Every call is bounded by a budget and a deadline and is
// not saved as a session, or its transcript is deleted when the call ends, so the
// factory's own calls never get scored or captured.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectName } from "../../tests/lib/cleanup.js";
import { childEnv, runProcess } from "../../tests/lib/process.js";
import { completed, cost, parseStream, partialEvents, resultEvent, retryRefused } from "../../tests/lib/stream.js";
import { projectsRoot, readRecords } from "./transcripts.js";

export const STRUCTURED_TOOL = "StructuredOutput";
// By default the API-first wrapper: billed to the API while it has credit, else the
// subscription (claude/bin/claude-api).
export const API_FIRST = join(import.meta.dir, "..", "..", "bin", "claude-api");
export const claudeBin = () => process.env.CLAUDE_FACTORY_BIN || API_FIRST;

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
// other than the structured-output one fails closed. system holds instructions that stay
// the same from call to call. They replace Claude Code's default system prompt, which is
// written for coding sessions with tools, and keep its short identity line, which
// appending would turn into "You are Claude Code". Passed from a file, so their size is
// not bound by argv limits, they fall inside the prefix Claude Code caches, and a run of
// judge calls reads them from the cache. prompt, the part that changes per call, goes on
// stdin.
export async function judge({ prompt, system, schema, model, effort = "medium", budgetUsd = 0.5, timeoutMs = 240_000 }) {
  const cwd = mkdtempSync(join(tmpdir(), "claude-factory-judge-"));
  try {
    const argv = [claudeBin(), "--print", "--setting-sources", "", "--tools", "", "--strict-mcp-config",
      "--disable-slash-commands", "--no-session-persistence", "--model", model, "--effort", effort,
      "--max-budget-usd", String(budgetUsd), "--output-format", "stream-json", "--verbose",
      "--json-schema", JSON.stringify(schema)];
    if (system) {
      const file = join(cwd, "judge-system.md");
      writeFileSync(file, system);
      argv.push("--system-prompt-file", file);
    }
    // A call the API refused for credit or the key before it did anything runs once more,
    // on the subscription.
    const { result, events, refused } = await retryRefused(async (timeout, { subscription }) => {
      let result;
      try {
        result = await runProcess(argv, { cwd, env: quietEnv(subscription ? { API_FIRST_SUBSCRIPTION: "1" } : {}), timeout, input: prompt });
      } catch (error) {
        // A deadline, the output bound or a spawn failure: one failed call, not a crash of
        // the caller's loop. The partial stream may still say what it cost.
        throw new ClaudeCallError(`Judge call did not finish: ${error.message}`, { events: partialEvents(error.stdout), stderr: (error.stderr ?? "").slice(-2000) });
      }
      return { result, events: eventsOf(result, "Judge call") };
    }, timeoutMs);
    const spentUSD = refused ? cost(refused.events) : 0;
    for (const event of events) {
      if (event.type === "system" && event.subtype === "init"
        && ((event.tools ?? []).some((tool) => tool !== STRUCTURED_TOOL) || (event.mcp_servers ?? []).length))
        throw new ClaudeCallError("Judge session exposed tools or MCP servers", { events });
      if (event.type === "assistant" && (event.message?.content ?? []).some((block) => block.type === "tool_use" && block.name !== STRUCTURED_TOOL))
        throw new ClaudeCallError("Judge session used a tool", { events });
    }
    const final = resultEvent(events);
    const costUSD = spentUSD + (final?.total_cost_usd ?? 0);
    if (!completed(events) || !final.structured_output || typeof final.structured_output !== "object")
      throw new ClaudeCallError(`Judge call failed: ${final?.subtype ?? "no result"}${final?.api_error_status ? ` (HTTP ${final.api_error_status})` : ""}`, { events, code: result.code });
    return { output: final.structured_output, costUSD, events };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Messages per effort in a transcript's main thread; Claude Code writes one record per
// content block, so each message counts once.
function transcriptEfforts(file) {
  const byMessage = new Map();
  for (const record of readRecords(file).records)
    if (record.type === "assistant" && !record.isSidechain && typeof record.effort === "string")
      byMessage.set(record.message?.id ?? record.uuid, record.effort);
  const counts = {};
  for (const effort of byMessage.values()) counts[effort] = (counts[effort] ?? 0) + 1;
  return counts;
}

// A task session in cwd with the user's configuration. agent runs the session as that
// agent; settings is a path or JSON string passed to --settings; tools limits the
// built-in tools; strictMcp loads no MCP servers (--strict-mcp-config with no
// --mcp-config), as the user's servers would add tools that --tools does not limit.
// readEffort lets the session save its transcript, the only place Claude Code records
// the effort each request ran at (the stream does not), reads it and deletes it;
// efforts then counts the main thread's messages per effort, or is null when no
// transcript was found. Returns the stream whether or not the task succeeded; a session
// past timeoutMs is killed and returns what it streamed, with timedOut set.
export async function runTask({
  prompt, cwd, model, effort, agent, settings, tools, budgetUsd = 2, timeoutMs = 900_000,
  permissionMode = "bypassPermissions", env = {}, addDirs = [], strictMcp = false, readEffort = false,
}) {
  const argv = [claudeBin(), "--print", ...(readEffort ? [] : ["--no-session-persistence"]), "--output-format", "stream-json", "--verbose",
    "--permission-mode", permissionMode, "--max-budget-usd", String(budgetUsd)];
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  if (agent) argv.push("--agent", agent);
  if (settings) argv.push("--settings", settings);
  if (tools) argv.push("--tools", tools.join(","));
  if (strictMcp) argv.push("--strict-mcp-config");
  // Extra folders the file tools may use; a sandbox profile's allowWrite covers Bash only.
  for (const dir of addDirs) argv.push("--add-dir", dir);
  // Each attempt's transcript, known before it starts, so a failed or killed session's
  // is removed too.
  const transcripts = [];
  let run;
  let efforts = null;
  try {
    run = await retryRefused(async (timeout, { subscription }) => {
      const attemptEnv = quietEnv(subscription ? { ...env, API_FIRST_SUBSCRIPTION: "1" } : env);
      const attemptArgv = [...argv];
      if (readEffort) {
        const id = randomUUID();
        attemptArgv.push("--session-id", id);
        transcripts.push(join(projectsRoot(attemptEnv), projectName(realpathSync(cwd)), id));
      }
      let result;
      try {
        result = await runProcess(attemptArgv, { cwd, env: attemptEnv, timeout, input: prompt });
      } catch (error) {
        // Running out of time is the task's outcome, not a failed call: the stream so far.
        if (!/^Process timeout/.test(error.message ?? "")) throw error;
        const stdout = error.stdout ?? "";
        return { result: { code: null, stdout, stderr: error.stderr ?? "", durationMs: timeout }, events: partialEvents(stdout), timedOut: true };
      }
      return { result, events: eventsOf(result, "Task run") };
    }, timeoutMs);
  } finally {
    try {
      const last = transcripts.at(-1);
      if (last && existsSync(`${last}.jsonl`)) efforts = transcriptEfforts(`${last}.jsonl`);
    } finally {
      // The transcript, the folder of its subagents, and the project folder when no other
      // session is in it.
      for (const base of transcripts) {
        rmSync(`${base}.jsonl`, { force: true });
        rmSync(base, { recursive: true, force: true });
        try {
          rmdirSync(dirname(base));
        } catch (error) {
          if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
        }
      }
    }
  }
  const { result, events, refused, timedOut = false } = run;
  const final = resultEvent(events);
  return {
    events,
    ...(readEffort ? { efforts } : {}),
    ok: !timedOut && completed(events),
    timedOut,
    finalText: typeof final?.result === "string" ? final.result : "",
    costUSD: (refused ? cost(refused.events) : 0) + (final?.total_cost_usd ?? 0),
    turns: final?.num_turns ?? null,
    durationMs: result.durationMs + (refused?.result.durationMs ?? 0),
    code: result.code,
    stderr: result.stderr.slice(-2000),
  };
}
