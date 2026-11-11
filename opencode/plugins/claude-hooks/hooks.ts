// Runs the Claude Code hooks in ~/.claude/settings.json for opencode events.
// index.ts maps opencode's plugin hooks onto Claude's events; this file holds the
// parts that do not need opencode: name and input translation, matching, running
// hook commands with Claude-shaped stdin, and reading their results.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

type Json = Record<string, unknown>;

export interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export type HookConfig = Record<string, HookGroup[]>;

export interface Outcome {
  // Reason a PreToolUse hook refused the call, or a Stop hook asked to continue.
  block?: string;
  context: string[];
}

const TOOL_NAMES: Record<string, string> = {
  shell: "Bash",
  read: "Read",
  edit: "Edit",
  patch: "Edit",
  write: "Write",
  glob: "Glob",
  grep: "Grep",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  subagent: "Agent",
  skill: "Skill",
  question: "AskUserQuestion",
  opencode_worktree_create: "EnterWorktree",
};

// opencode names MCP tools `<server>_<tool>`; Claude names them `mcp__<server>__<tool>`.
export function claudeToolName(tool: string): string {
  const name = TOOL_NAMES[tool];
  if (name) return name;
  const mcp = /^([a-z0-9-]+)_(.+)$/.exec(tool);
  return mcp ? `mcp__${mcp[1]}__${mcp[2]}` : tool;
}

export function claudeToolInput(tool: string, input: Json): Json {
  switch (tool) {
    case "shell":
      return { command: input.command, timeout: input.timeout, run_in_background: input.background };
    case "read":
      return { file_path: input.path, offset: input.offset, limit: input.limit };
    case "edit":
      return { file_path: input.path, old_string: input.oldString, new_string: input.newString, replace_all: input.replaceAll };
    case "write":
      return { file_path: input.path, content: input.content };
    case "subagent":
      return {
        subagent_type: input.agent,
        description: input.description,
        prompt: input.prompt,
        model: input.model,
        run_in_background: input.background,
      };
    default:
      return input;
  }
}

// Claude's matcher rules: empty or "*" matches everything, a plain name or
// `A|B` list matches exactly, anything else is an unanchored regex.
export function matches(matcher: string | undefined, value: string | undefined): boolean {
  if (value === undefined || !matcher || matcher === "*") return true;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split("|").includes(value);
  return new RegExp(matcher).test(value);
}

export function loadHooks(settingsPath: string): HookConfig {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks?: HookConfig };
  return settings.hooks ?? {};
}

// Variables a parent T3 or Claude Code session leaks into opencode. Left in place,
// `board` and the guards would act as that parent instead of this session.
const LEAKED = /^(T3CODE_|CLAUDE_CODE_|CLAUDECODE$)/;

export function leakedKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((key) => LEAKED.test(key));
}

export function hookEnv(base: Record<string, string | undefined>, sessionID: string, projectDir: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !LEAKED.test(key)) env[key] = value;
  env.CLAUDE_CODE_SESSION_ID = sessionID;
  env.CLAUDE_PROJECT_DIR = projectDir;
  return env;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, stdin: string, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // A hook may exit without reading stdin; the resulting EPIPE is not a hook failure.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

// Events whose plain stdout Claude adds to the model's context.
const STDOUT_CONTEXT = new Set(["SessionStart", "UserPromptSubmit"]);

export function readResult(event: string, result: Run, command: string, outcome: Outcome) {
  if (result.code === 2) {
    outcome.block = [outcome.block, result.stderr.trim() || `hook refused: ${command}`].filter(Boolean).join("\n");
    return;
  }
  if (result.code !== 0) {
    console.warn(`claude-hooks: ${event} hook failed (exit ${result.code}): ${command}: ${result.stderr.trim()}`);
    return;
  }
  const stdout = result.stdout.trim();
  if (!stdout) return;
  if (!stdout.startsWith("{")) {
    if (STDOUT_CONTEXT.has(event)) outcome.context.push(stdout);
    return;
  }
  let output: Json;
  try {
    output = JSON.parse(stdout);
  } catch {
    if (STDOUT_CONTEXT.has(event)) outcome.context.push(stdout);
    return;
  }
  const specific = (output.hookSpecificOutput ?? {}) as Json;
  if (specific.permissionDecision === "deny") {
    outcome.block = [outcome.block, String(specific.permissionDecisionReason ?? `hook refused: ${command}`)]
      .filter(Boolean)
      .join("\n");
  }
  if (output.decision === "block") {
    const reason = String(output.reason ?? `hook blocked: ${command}`);
    // Claude feeds a PostToolUse block reason to the model; it cannot undo the call.
    if (event.startsWith("PostToolUse")) outcome.context.push(reason);
    else outcome.block = [outcome.block, reason].filter(Boolean).join("\n");
  }
  if (typeof specific.additionalContext === "string" && specific.additionalContext) outcome.context.push(specific.additionalContext);
}

export interface RunOptions {
  hooks: HookConfig;
  event: string;
  // The value the event's matchers test: a tool name, a SessionStart source and so on.
  // Undefined runs every group, as Claude does for events without matchers.
  target?: string;
  payload: Json;
  sessionID: string;
  cwd: string;
  projectDir: string;
  env: Record<string, string | undefined>;
}

export async function runHooks(options: RunOptions): Promise<Outcome> {
  const commands = new Map<string, number>();
  for (const group of options.hooks[options.event] ?? []) {
    if (!matches(group.matcher, options.target)) continue;
    for (const hook of group.hooks) {
      // Claude runs identical commands once.
      if (hook.type === "command" && hook.command && !commands.has(hook.command)) commands.set(hook.command, hook.timeout ?? 600);
    }
  }
  const outcome: Outcome = { context: [] };
  if (commands.size === 0) return outcome;
  const stdin = JSON.stringify({
    session_id: options.sessionID,
    transcript_path: "",
    cwd: options.cwd,
    permission_mode: "bypassPermissions",
    hook_event_name: options.event,
    ...options.payload,
  });
  const env = hookEnv(options.env, options.sessionID, options.projectDir);
  const results = await Promise.all(
    [...commands].map(async ([command, timeout]) => [command, await run(command, stdin, options.cwd, env, timeout * 1000)] as const),
  );
  for (const [command, result] of results) readResult(options.event, result, command, outcome);
  return outcome;
}

// Claude's StopFailure matcher values for a failed model request.
export function stopFailureType(error: { type?: string; status?: number } | undefined): string {
  const status = error?.status;
  if (status === 429 || /rate/i.test(error?.type ?? "")) return "rate_limit";
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 402) return "billing_error";
  if (status === 400) return "invalid_request";
  if (status !== undefined && status >= 500) return "server_error";
  return "unknown";
}

// Claude keeps a project's auto-memory in ~/.claude/projects/<path with / and . as ->/memory.
export function memoryDir(home: string, projectRoot: string): string {
  return `${home}/.claude/projects/${projectRoot.replace(/[/.]/g, "-")}/memory`;
}
