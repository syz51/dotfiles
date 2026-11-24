#!/usr/bin/env bun
/**
 * Antigravity lifecycle hook adapter for ~/.config/claude/hooks/*.js.
 *
 * Usage: bun run-hook.js <event> <hook-name[,hook-name,...]>
 *   event:     pre-tool-use | post-tool-use | session-start | stop
 *   hook-name: guard-git-push | guard-runtimes | guard-main-checkout | guard-pr-merge |
 *              guard-asks | auto-merge | stale-base | open-items | deck-view
 *
 * Hot-path command guards (guard-git-push, guard-runtimes, guard-main-checkout,
 * guard-pr-merge, guard-asks, auto-merge) execute in-process via their exported functions so a
 * single Bun invocation handles all PreToolUse guards instead of spawning nested Bun VMs.
 * Low-frequency hooks (stale-base, open-items, deck-view) still delegate via spawnSync to share
 * the exact same Claude Code hook scripts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createsPullRequest,
  report as autoMergeReport,
  reportMcpCreate as autoMergeMcpReport,
} from "../../claude/hooks/auto-merge.js";
import {
  askViolation,
  findBoardAskViolation,
  loadAskPolicy,
} from "../../claude/hooks/guard-asks.js";
import { findViolation as findGitPushViolation } from "../../claude/hooks/guard-git-push.js";
import { findMainCheckoutViolation } from "../../claude/hooks/guard-main-checkout.js";
import {
  findMcpMergeViolation,
  findMergeViolation,
  runGh,
} from "../../claude/hooks/guard-pr-merge.js";
import { findRuntimeViolation } from "../../claude/hooks/guard-runtimes.js";

const HOOKS_DIR = resolve(dirname(import.meta.path), "..", "..", "claude", "hooks");

function runGitStrict(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`git was stopped by ${result.signal}`);
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function runGitLenient(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
  if (result.error || result.signal || result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function mainCheckoutTempRoots() {
  const roots = [tmpdir(), join("/tmp", `claude-${userInfo().uid}`)];
  return roots.filter((root) => existsSync(root)).map((root) => realpathSync(root));
}

function resolveBranchPrStdout(cwd) {
  // Antigravity PostToolUse does not pass command stdout; resolve the current branch's PR URL via gh.
  const pr = spawnSync("gh", ["pr", "view", "--json", "url", "-q", ".url"], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
  if (pr.status === 0 && pr.stdout?.trim()) {
    return `${pr.stdout.trim()}\n`;
  }
  return "";
}

export function extractLastAssistantMessage(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  try {
    const lines = readFileSync(transcriptPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type === "PLANNER_RESPONSE" && typeof rec.content === "string" && rec.content.trim()) {
        return rec.content;
      }
    }
  } catch {
    return "";
  }
  return "";
}

function extractCommand(agyInput) {
  const args = agyInput?.toolCall?.args ?? {};
  if (typeof args.CommandLine === "string") return args.CommandLine;
  if (typeof args.command === "string") return args.command;
  return "";
}

function normalizeForPrefilter(command) {
  // Collapse POSIX backslash-newline line continuations before stripping quotes and backslashes.
  return command.replace(/\\\r?\n/g, "").replace(/["'\\]/g, "");
}

const DIRECT_ASK_TOOLS = new Set(["mcp_board_ask_user", "mcp__board__ask_user", "ask_user"]);
const DIRECT_PR_MERGE_TOOLS = new Set(["mcp_t3-code_pull_request_merge", "mcp__t3-code__pull_request_merge"]);
const DIRECT_PR_CREATE_TOOLS = new Set(["mcp_t3-code_pull_request_create", "mcp__t3-code__pull_request_create"]);

function unwrapMcpArgs(rawArgs, { failClosed = false } = {}) {
  if (rawArgs === undefined) return {};
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      return failClosed ? false : {};
    } catch {
      return failClosed ? false : {};
    }
  }
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) return rawArgs;
  return failClosed ? false : {};
}

/**
 * Extracts the board `ask_user` argument object from an Antigravity PreToolUse payload.
 * Returns the argument object when the tool call invokes board `ask_user` (either lazily via
 * `call_mcp_tool` with `ServerName === "board"` and `ToolName === "ask_user"`, or eagerly via
 * `mcp_board_ask_user`), or `null` when the tool call is not an MCP `ask_user` call.
 */
export function extractAskUserInput(agyInput) {
  const toolName = agyInput?.toolCall?.name ?? "";
  const args = agyInput?.toolCall?.args ?? {};
  if (toolName === "call_mcp_tool") {
    const serverName = args.ServerName ?? args.serverName;
    const mcpToolName = args.ToolName ?? args.toolName;
    if (serverName !== "board" || mcpToolName !== "ask_user") {
      return null;
    }
    const rawArgs = args.Arguments !== undefined ? args.Arguments : args.arguments;
    return unwrapMcpArgs(rawArgs);
  }
  if (DIRECT_ASK_TOOLS.has(toolName)) {
    return unwrapMcpArgs(args);
  }
  return null;
}

/**
 * Extracts the T3 `pull_request_merge` argument object from an Antigravity PreToolUse payload.
 * Returns `null` when the tool call is not an MCP `pull_request_merge` call, or `false` when a
 * matching call has malformed non-object arguments so the fail-closed merge guard refuses it.
 */
export function extractMcpPrMergeInput(agyInput) {
  const toolName = agyInput?.toolCall?.name ?? "";
  const args = agyInput?.toolCall?.args;
  if (toolName === "call_mcp_tool") {
    const serverName = args?.ServerName ?? args?.serverName;
    const mcpToolName = args?.ToolName ?? args?.toolName;
    if (serverName !== "t3-code" || mcpToolName !== "pull_request_merge") {
      return null;
    }
    const rawArgs = args?.Arguments !== undefined ? args.Arguments : args?.arguments;
    return unwrapMcpArgs(rawArgs, { failClosed: true });
  }
  if (DIRECT_PR_MERGE_TOOLS.has(toolName)) {
    return unwrapMcpArgs(args, { failClosed: true });
  }
  return null;
}

/**
 * Extracts the T3 `pull_request_create` argument object from an Antigravity PostToolUse payload,
 * or `null` when the tool call is not an MCP `pull_request_create` call.
 */
export function extractMcpPrCreateInput(agyInput) {
  const toolName = agyInput?.toolCall?.name ?? "";
  const args = agyInput?.toolCall?.args;
  if (toolName === "call_mcp_tool") {
    const serverName = args?.ServerName ?? args?.serverName;
    const mcpToolName = args?.ToolName ?? args?.toolName;
    if (serverName !== "t3-code" || mcpToolName !== "pull_request_create") {
      return null;
    }
    const rawArgs = args?.Arguments !== undefined ? args.Arguments : args?.arguments;
    return unwrapMcpArgs(rawArgs);
  }
  if (DIRECT_PR_CREATE_TOOLS.has(toolName)) {
    return unwrapMcpArgs(args);
  }
  return null;
}

function extractToolResponse(agyInput) {
  return agyInput?.toolResponse ?? agyInput?.toolResult ?? agyInput?.result ?? agyInput?.output;
}

export function translateInput(event, hookName, agyInput) {
  const cwd = typeof agyInput?.cwd === "string" && agyInput.cwd ? agyInput.cwd : process.cwd();
  if (event === "pre-tool-use") {
    if (hookName === "guard-asks") {
      const toolName = agyInput?.toolCall?.name ?? "";
      const command = extractCommand(agyInput);
      if (toolName === "run_command" || toolName === "Bash" || (!toolName && command)) {
        return { cwd, tool_name: "Bash", tool_input: { command } };
      }
      const askInput = extractAskUserInput(agyInput);
      if (askInput === null) return null;
      return { cwd, tool_name: "mcp__board__ask_user", tool_input: askInput };
    }
    if (hookName === "guard-pr-merge") {
      const mcpMergeInput = extractMcpPrMergeInput(agyInput);
      if (mcpMergeInput !== null) {
        return { cwd, tool_name: "mcp__t3-code__pull_request_merge", tool_input: mcpMergeInput };
      }
    }
    return { cwd, tool_name: "Bash", tool_input: { command: extractCommand(agyInput) } };
  }
  if (event === "post-tool-use") {
    if (hookName === "auto-merge") {
      const mcpCreateInput = extractMcpPrCreateInput(agyInput);
      if (mcpCreateInput !== null) {
        return {
          cwd,
          tool_name: "mcp__t3-code__pull_request_create",
          tool_input: mcpCreateInput,
          tool_response: extractToolResponse(agyInput) ?? {},
        };
      }
    }
    const command = extractCommand(agyInput);
    const stdout =
      hookName === "auto-merge" && !agyInput?.error && command && createsPullRequest(command, cwd)
        ? resolveBranchPrStdout(cwd)
        : "";
    return {
      cwd,
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { stdout, stderr: agyInput?.error || "" },
    };
  }
  if (event === "session-start") {
    return { cwd, source: "startup" };
  }
  if (event === "stop") {
    const transcriptPath = typeof agyInput?.transcriptPath === "string" ? agyInput.transcriptPath : "";
    return {
      cwd,
      stop_hook_active: Boolean(agyInput?.continuationActive),
      transcript_path: transcriptPath,
      last_assistant_message:
        hookName === "open-items" ? extractLastAssistantMessage(transcriptPath) : "",
    };
  }
  return { cwd };
}

export function translateOutput(event, exitCode, stdout, stderr) {
  if (event === "pre-tool-use") {
    if (exitCode === 2) {
      return { decision: "deny", reason: (stderr || stdout || "Blocked by hook").trim() };
    }
    return { decision: "allow" };
  }
  if (event === "post-tool-use") {
    return {};
  }
  if (event === "session-start") {
    if (stdout && stdout.trim()) {
      try {
        const parsed = JSON.parse(stdout);
        const ctx = parsed?.hookSpecificOutput?.additionalContext;
        if (typeof ctx === "string" && ctx.trim()) {
          return { injectSteps: [{ systemMessage: { systemMessage: ctx } }] };
        }
      } catch {
        // Non-JSON output ignored
      }
    }
    return {};
  }
  if (event === "stop") {
    if (exitCode === 2) {
      return { decision: "continue", reason: (stderr || stdout || "Continue before stopping").trim() };
    }
    return { decision: "allow" };
  }
  return {};
}

function runInProcessPreToolUse(hookName, command, cwd, runners = {}) {
  const unquoted = normalizeForPrefilter(command);
  if (hookName === "guard-git-push") {
    if (/\bgit\b/i.test(unquoted) && /\bpush\b|alias\./i.test(unquoted)) {
      const violation = findGitPushViolation(command, cwd, runners.gitStrict ?? runGitStrict);
      if (violation) return { decision: "deny", reason: `Blocked by the guard-git-push hook: ${violation}` };
    }
    return { decision: "allow" };
  }
  if (hookName === "guard-runtimes") {
    const violation = findRuntimeViolation(command, cwd);
    if (violation) return { decision: "deny", reason: `Blocked by the guard-runtimes hook: ${violation}` };
    return { decision: "allow" };
  }
  if (hookName === "guard-main-checkout") {
    if (/\b(?:git|gh|xargs)\b/i.test(unquoted)) {
      const violation = findMainCheckoutViolation(
        command,
        cwd,
        runners.gitLenient ?? runGitLenient,
        runners.tempRoots ?? mainCheckoutTempRoots(),
      );
      if (violation) return { decision: "deny", reason: `Blocked by the guard-main-checkout hook: ${violation}` };
    }
    return { decision: "allow" };
  }
  return null;
}

function runInProcessGuardPrMerge(agyInput, command, cwd, runners = {}) {
  // Fail closed if the merge guard throws, matching claude/hooks/guard-pr-merge.js.
  const mcpMergeInput = extractMcpPrMergeInput(agyInput);
  let violation;
  try {
    if (mcpMergeInput !== null) {
      violation = findMcpMergeViolation(mcpMergeInput, cwd, runners.gh ?? runGh);
    } else if (command) {
      const unquoted = normalizeForPrefilter(command);
      if (/merge|gh|[$`*?[{]/i.test(unquoted)) {
        violation = findMergeViolation(command, cwd, runners.gh ?? runGh);
      }
    }
  } catch (error) {
    violation = `the guard failed (${error.message}), so it cannot check this command.`;
  }
  if (violation) return { decision: "deny", reason: `Blocked by the guard-pr-merge hook: ${violation}` };
  return { decision: "allow" };
}

function runInProcessGuardAsks(agyInput, command, cwd, runners = {}) {
  const toolName = agyInput?.toolCall?.name ?? "";
  if (toolName === "run_command" || toolName === "Bash" || (!toolName && command)) {
    if (!command) return { decision: "allow" };
    const violation = findBoardAskViolation(command, cwd, runners.askPolicy);
    if (violation) return { decision: "deny", reason: `Blocked by the guard-asks hook: ${violation}` };
    return { decision: "allow" };
  }
  const askInput = extractAskUserInput(agyInput);
  if (askInput === null) return { decision: "allow" };
  const policy = runners.askPolicy ?? loadAskPolicy();
  const violation = askViolation(askInput, policy);
  if (violation) return { decision: "deny", reason: `Blocked by the guard-asks hook: ${violation}` };
  return { decision: "allow" };
}

const IN_PROCESS_PRE = new Set([
  "guard-git-push",
  "guard-runtimes",
  "guard-main-checkout",
  "guard-pr-merge",
  "guard-asks",
]);

function runSubprocessHook(event, hookName, agyInput, hooksDir, bunBin) {
  const scriptPath = join(hooksDir, `${hookName}.js`);
  if (!existsSync(scriptPath)) {
    return event === "pre-tool-use" || event === "stop" ? { decision: "allow" } : {};
  }
  const claudeInput = translateInput(event, hookName, agyInput);
  if (claudeInput === null) {
    return event === "pre-tool-use" || event === "stop" ? { decision: "allow" } : {};
  }
  if (
    event === "post-tool-use" &&
    hookName === "auto-merge" &&
    claudeInput.tool_name === "Bash" &&
    !claudeInput.tool_response?.stdout
  ) {
    return {};
  }
  const run = spawnSync(bunBin, [scriptPath], {
    input: JSON.stringify(claudeInput),
    encoding: "utf8",
    timeout: 45_000,
    env: process.env,
  });
  return translateOutput(event, run.status ?? 0, run.stdout ?? "", run.stderr ?? "");
}

export function runAdaptedHook(
  event,
  hookSpec,
  agyInput,
  { hooksDir = HOOKS_DIR, bunBin = process.execPath, runners = {} } = {},
) {
  if (event === "post-tool-use" && agyInput?.error) {
    return {};
  }

  const hookNames = String(hookSpec)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (hookNames.length === 0) {
    return event === "pre-tool-use" || event === "stop" ? { decision: "allow" } : {};
  }

  const useInProcess = hooksDir === HOOKS_DIR;
  const cwd = typeof agyInput?.cwd === "string" && agyInput.cwd ? agyInput.cwd : process.cwd();

  if (event === "pre-tool-use") {
    const command = extractCommand(agyInput);
    for (const hookName of hookNames) {
      // Isolate each guard so a crash in an earlier fail-open guard never skips later guards
      // (especially fail-closed guard-pr-merge).
      try {
        if (useInProcess && IN_PROCESS_PRE.has(hookName)) {
          if (hookName === "guard-asks") {
            const res = runInProcessGuardAsks(agyInput, command, cwd, runners);
            if (res && res.decision === "deny") return res;
            continue;
          }
          if (hookName === "guard-pr-merge") {
            const res = runInProcessGuardPrMerge(agyInput, command, cwd, runners);
            if (res && res.decision === "deny") return res;
            continue;
          }
          if (!command) continue;
          const res = runInProcessPreToolUse(hookName, command, cwd, runners);
          if (res && res.decision === "deny") return res;
          continue;
        }
        const res = runSubprocessHook(event, hookName, agyInput, hooksDir, bunBin);
        if (res.decision === "deny") return res;
      } catch (err) {
        if (hookName === "guard-pr-merge") {
          return {
            decision: "deny",
            reason: `Blocked by the guard-pr-merge hook: the guard failed (${err.message}), so it cannot check this command.`,
          };
        }
        process.stderr.write(`run-hook guard error (${hookName}): ${err.message}\n`);
      }
    }
    return { decision: "allow" };
  }

  if (event === "post-tool-use") {
    for (const hookName of hookNames) {
      if (hookName === "auto-merge" && useInProcess) {
        const mcpCreateInput = extractMcpPrCreateInput(agyInput);
        if (mcpCreateInput !== null) {
          try {
            const text = autoMergeMcpReport(
              mcpCreateInput,
              extractToolResponse(agyInput),
              cwd,
              (args, timeout) => (runners.gh ?? runGh)(cwd, args, timeout),
            );
            if (text) process.stderr.write(`${text}\n`);
          } catch (err) {
            process.stderr.write(`auto-merge hook failed (${err.message})\n`);
          }
          continue;
        }
        const command = extractCommand(agyInput);
        if (!command || !/gh/i.test(command) || !createsPullRequest(command, cwd)) {
          continue;
        }
        const stdout = resolveBranchPrStdout(cwd);
        if (!stdout || !stdout.includes("/pull/")) continue;
        try {
          const text = autoMergeReport(command, cwd, stdout, (args, timeout) =>
            (runners.gh ?? runGh)(cwd, args, timeout),
          );
          if (text) process.stderr.write(`${text}\n`);
        } catch (err) {
          process.stderr.write(`auto-merge hook failed (${err.message})\n`);
        }
        continue;
      }
      runSubprocessHook(event, hookName, agyInput, hooksDir, bunBin);
    }
    return {};
  }

  if (event === "session-start") {
    const injectSteps = [];
    for (const hookName of hookNames) {
      const res = runSubprocessHook(event, hookName, agyInput, hooksDir, bunBin);
      if (Array.isArray(res.injectSteps)) injectSteps.push(...res.injectSteps);
    }
    return injectSteps.length > 0 ? { injectSteps } : {};
  }

  if (event === "stop") {
    for (const hookName of hookNames) {
      const res = runSubprocessHook(event, hookName, agyInput, hooksDir, bunBin);
      if (res.decision === "continue") return res;
    }
    return { decision: "allow" };
  }

  return {};
}

if (import.meta.main) {
  const [event, hookSpec] = process.argv.slice(2);
  const failClosed =
    event === "pre-tool-use" &&
    String(hookSpec ?? "")
      .split(",")
      .map((name) => name.trim())
      .includes("guard-pr-merge");
  let agyInput = {};
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (raw) agyInput = JSON.parse(raw);
    const out = runAdaptedHook(event, hookSpec, agyInput);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    if (failClosed) {
      const deny = {
        decision: "deny",
        reason: `Blocked by the guard-pr-merge hook: the guard failed (${err.message}), so it cannot check this command.`,
      };
      process.stdout.write(`${JSON.stringify(deny)}\n`);
    } else {
      // Fail open on adapter crash, matching Claude Code guard semantics
      const fallback = event === "pre-tool-use" || event === "stop" ? { decision: "allow" } : {};
      process.stderr.write(`run-hook adapter error (${hookSpec}): ${err.message}\n`);
      process.stdout.write(`${JSON.stringify(fallback)}\n`);
    }
  }
}
