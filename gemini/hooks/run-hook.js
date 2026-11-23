#!/usr/bin/env bun
/**
 * Antigravity lifecycle hook adapter for ~/.config/claude/hooks/*.js.
 *
 * Usage: bun run-hook.js <event> <hook-name>
 *   event:     pre-tool-use | post-tool-use | session-start | stop
 *   hook-name: guard-git-push | guard-runtimes | guard-main-checkout | guard-pr-merge |
 *              guard-asks | auto-merge | stale-base | open-items | deck-view
 *
 * Translates Antigravity's camelCase JSON hook protocol to/from the existing Claude Code
 * hook scripts so both runtimes share one tested implementation.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createsPullRequest } from "../../claude/hooks/auto-merge.js";

const HOOKS_DIR = resolve(dirname(import.meta.path), "..", "..", "claude", "hooks");

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

export function translateInput(event, hookName, agyInput) {
  const cwd = typeof agyInput?.cwd === "string" && agyInput.cwd ? agyInput.cwd : process.cwd();
  if (event === "pre-tool-use") {
    const args = agyInput?.toolCall?.args ?? {};
    if (hookName === "guard-asks") {
      return { cwd, tool_name: agyInput?.toolCall?.name ?? "ask_user", tool_input: args };
    }
    const command =
      typeof args.CommandLine === "string"
        ? args.CommandLine
        : typeof args.command === "string"
          ? args.command
          : "";
    return { cwd, tool_name: "Bash", tool_input: { command } };
  }
  if (event === "post-tool-use") {
    const args = agyInput?.toolCall?.args ?? {};
    const command =
      typeof args.CommandLine === "string"
        ? args.CommandLine
        : typeof args.command === "string"
          ? args.command
          : "";
    let stdout = "";
    if (hookName === "auto-merge" && !agyInput?.error && command && createsPullRequest(command, cwd)) {
      // Antigravity PostToolUse does not pass command stdout; resolve the current branch's PR URL via gh.
      const pr = spawnSync("gh", ["pr", "view", "--json", "url", "-q", ".url"], {
        cwd,
        encoding: "utf8",
        timeout: 5000,
      });
      if (pr.status === 0 && pr.stdout?.trim()) {
        stdout = `${pr.stdout.trim()}\n`;
      }
    }
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

export function runAdaptedHook(event, hookName, agyInput, { hooksDir = HOOKS_DIR, bunBin = process.execPath } = {}) {
  if (event === "post-tool-use" && agyInput?.error) {
    return {};
  }
  const scriptPath = join(hooksDir, `${hookName}.js`);
  if (!existsSync(scriptPath)) {
    return event === "pre-tool-use" || event === "stop" ? { decision: "allow" } : {};
  }
  const claudeInput = translateInput(event, hookName, agyInput);
  if (event === "post-tool-use" && hookName === "auto-merge" && !claudeInput.tool_response.stdout) {
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

if (import.meta.main) {
  const [event, hookName] = process.argv.slice(2);
  let agyInput = {};
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (raw) agyInput = JSON.parse(raw);
  } catch {
    agyInput = {};
  }
  try {
    const out = runAdaptedHook(event, hookName, agyInput);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    // Fail open on adapter crash, matching Claude Code guard semantics
    const fallback = event === "pre-tool-use" || event === "stop" ? { decision: "allow" } : {};
    process.stderr.write(`run-hook adapter error (${hookName}): ${err.message}\n`);
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
  }
}
