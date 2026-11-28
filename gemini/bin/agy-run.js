#!/usr/bin/env bun
/**
 * agy-run: Headless Antigravity CLI runner backed by the official first-party `agy`
 * headless mode (`agy --input-format stream-json --output-format stream-json`).
 *
 * Uses `agy`'s own native sign-in (macOS Keychain / native CLI auth) — never extracts or
 * copies OAuth tokens from T3 Code or any other application, and never wraps `agy acp`.
 *
 * Provides Claude-CLI-compatible flags and stream-json output for:
 *   - claude/factory (friction capture, scoring, proposals, weekly reviews, ui-climb judges)
 *   - agent-skills (extract, verify, correct, weekly maintainer review)
 *   - ad-hoc headless prompts
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  buildAgyCliSettings,
  buildAgyPolicy,
  evaluateToolCall,
  expandHome,
} from "./agy-run-policy.js";

const DEFAULT_MODEL = "gemini-4-neon";
const DEFAULT_EFFORT = "low";
const DEFAULT_TIMEOUT_MS = 240_000;

export function resolveAgyBinary(env = process.env) {
  if (env.AGY_RUN_BIN) return env.AGY_RUN_BIN;
  const pathEnv = env.PATH || "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "agy");
    if (existsSync(candidate)) return candidate;
  }
  const home = env.HOME || homedir();
  const localAgy = join(home, ".local", "bin", "agy");
  if (existsSync(localAgy)) return localAgy;
  throw new Error(
    "Could not find official `agy` CLI (~/.local/bin/agy). Install it via `curl -fsSL https://antigravity.google/cli/install.sh | bash` and run `agy` once to sign in, or set AGY_RUN_BIN.",
  );
}

function cleanBaseEnv(env = process.env) {
  const dropExact = new Set([
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GEMINI_HOME",
    "ELECTRON_RUN_AS_NODE",
    "CHROME_CRASHPAD_PIPE_NAME",
    "SSH_CLIENT",
    "SSH_CONNECTION",
    "SSH_TTY",
    "AGY_RUN_POLICY_FILE",
    "AGY_RUN_ACTIVE",
  ]);
  const dropPrefix = ["CLAUDE_", "T3CODE_", "T3_", "AGY_ACP_"];
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (dropExact.has(k) || dropPrefix.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  out.AGENT_BOARD_HOOKS = "off";
  out.AGY_RUN_ACTIVE = "1";
  return out;
}

function extForMime(mimeType) {
  const m = String(mimeType || "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  return ".png";
}

function mimeForPath(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function extractLastBalancedJson(text) {
  let lastParsed;
  let found = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          try {
            lastParsed = JSON.parse(text.slice(start, i + 1));
            found = true;
          } catch {}
          start = -1;
        }
      }
    }
  }
  return found ? { found: true, value: lastParsed } : { found: false };
}

export function extractJsonFromText(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(trimmed);
    if (fence) {
      return JSON.parse(fence[1].trim());
    }
    const firstObj = trimmed.indexOf("{");
    const firstArr = trimmed.indexOf("[");
    let start = -1;
    let endChar = "}";
    if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
      start = firstObj;
      endChar = "}";
    } else if (firstArr !== -1) {
      start = firstArr;
      endChar = "]";
    }
    if (start !== -1) {
      const end = trimmed.lastIndexOf(endChar);
      if (end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch {
          // Fall through to balanced top-level JSON scanner (e.g. concatenated multi-turn outputs)
        }
      }
    }
    const balanced = extractLastBalancedJson(trimmed);
    if (balanced.found) {
      return balanced.value;
    }
    throw new Error(`Could not extract JSON from model output: ${trimmed.slice(0, 300)}`);
  }
}

export function mapEffort(effort) {
  const e = (effort || DEFAULT_EFFORT).toLowerCase();
  if (["low", "medium", "high", "xhigh"].includes(e)) return e;
  if (e === "max") return "xhigh";
  return DEFAULT_EFFORT;
}

export function normalizeModel(model) {
  if (!model) return DEFAULT_MODEL;
  const m = model.toLowerCase();
  if (m.startsWith("gemini-")) return model;
  if (m.includes("claude") || m === "opus" || m === "haiku" || m === "sonnet" || m === "fable") {
    return DEFAULT_MODEL;
  }
  return model;
}

function materializePromptAndAttachments(prompt, contentBlocks, tempRoot) {
  const textParts = [];
  const attachmentPaths = [];
  let attachmentDir = null;

  if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
    let imgIdx = 0;
    for (const block of contentBlocks) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "image") {
        const b64 = block.source?.type === "base64" ? block.source.data : block.data;
        const mime = block.source?.media_type || block.mimeType || "image/png";
        if (typeof b64 === "string" && b64.length > 0) {
          if (!attachmentDir) {
            attachmentDir = join(tempRoot, "attachments");
            mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
          }
          imgIdx += 1;
          const filePath = join(attachmentDir, `image-${imgIdx}${extForMime(mime)}`);
          writeFileSync(filePath, Buffer.from(b64, "base64"), { mode: 0o600 });
          attachmentPaths.push(filePath);
          textParts.push(`[Attached image ${imgIdx}: inspect ${filePath} using view_file]`);
        }
      }
    }
  } else if (prompt) {
    textParts.push(prompt);
  }

  return {
    userText: textParts.join("\n\n"),
    attachmentDir,
    attachmentPaths,
  };
}

const WORKSPACE_HOOK_SUBPATHS = [
  join(".agents", "hooks.json"),
  join(".agent", "hooks.json"),
  join("_agents", "hooks.json"),
  join("_agent", "hooks.json"),
];

/**
 * Verifies fail-closed that global `~/.gemini/config/hooks.json` wires `agy-run-policy`
 * on PreToolUse matcher `*`, and that no workspace hooks.json between `workDir` and the
 * repository root shadows or disables `agy-run-policy`.
 */
export function verifyPolicyHookInstalled(home, workDir) {
  const globalHooksPath = join(home, ".gemini", "config", "hooks.json");
  if (!existsSync(globalHooksPath)) {
    throw new Error(
      `Restricted agy-run requires agy-run-policy PreToolUse hook in ${globalHooksPath}, but the file is missing.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(globalHooksPath, "utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in ${globalHooksPath}: ${err.message}`);
  }
  const policyGroup = parsed?.["agy-run-policy"];
  const preEntries = Array.isArray(policyGroup?.PreToolUse) ? policyGroup.PreToolUse : [];
  const validHook =
    policyGroup?.enabled !== false &&
    preEntries.some(
      (entry) =>
        entry?.matcher === "*" &&
        Array.isArray(entry?.hooks) &&
        entry.hooks.some(
          (h) =>
            typeof h?.command === "string" &&
            h.command.includes("AGY_RUN_POLICY_FILE") &&
            h.command.includes("agy-run-policy.js"),
        ),
    );
  if (!validHook) {
    throw new Error(
      `Restricted agy-run requires an enabled "agy-run-policy" PreToolUse (matcher "*") hook in ${globalHooksPath}.`,
    );
  }

  // Check workspace hook overrides walking up to the git root (if any).
  let cur = resolve(workDir);
  for (let depth = 0; depth < 64; depth++) {
    for (const rel of WORKSPACE_HOOK_SUBPATHS) {
      const candidate = join(cur, rel);
      if (!existsSync(candidate)) continue;
      let wsHooks;
      try {
        wsHooks = JSON.parse(readFileSync(candidate, "utf8"));
      } catch (err) {
        throw new Error(`Invalid workspace hooks file ${candidate}: ${err.message}`);
      }
      if (wsHooks && typeof wsHooks === "object" && Object.hasOwn(wsHooks, "agy-run-policy")) {
        throw new Error(
          `Workspace hooks file ${candidate} overrides "agy-run-policy"; refusing to run restricted session.`,
        );
      }
    }
    if (existsSync(join(cur, ".git"))) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

export async function runAgyPrompt({
  prompt,
  contentBlocks,
  system,
  schema,
  model = DEFAULT_MODEL,
  effort = DEFAULT_EFFORT,
  agent,
  cwd,
  noTools = false,
  fullAccess = false,
  permissionMode,
  tools,
  settings,
  strictMcp = false,
  addDirs = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
}) {
  if (agent !== undefined && agent !== null && agent !== false) {
    const label = typeof agent === "string" && agent.trim() ? ` "${agent}"` : "";
    throw new Error(
      `agy-run refuses --agent${label}: Antigravity bills custom agents at 4x quota (google-antigravity/antigravity-cli#1890); pass instructions via --system/--system-file, GEMINI.md, AGENTS.md, or skills instead.`,
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeoutMs for agy-run: ${timeoutMs}`);
  }
  const startedAt = Date.now();
  const home = env.HOME || homedir();
  const callerBase = cwd ? resolve(cwd) : process.cwd();
  const resolvedAddDirs = (addDirs || []).map((dir) => resolve(callerBase, expandHome(dir, home)));

  // Validate restrictions up front (fail closed before spawning or touching temp files).
  const preflightPolicy = buildAgyPolicy({
    cwd: callerBase,
    home,
    noTools,
    fullAccess,
    permissionMode,
    tools,
    settings,
    strictMcp,
    addDirs: resolvedAddDirs,
  });

  if (preflightPolicy.enforceHook) {
    verifyPolicyHookInstalled(home, callerBase);
  }

  const binary = resolveAgyBinary(env);
  const tempRoot = mkdtempSync(join(tmpdir(), "agy-run-"));

  let proc;
  let timer;
  try {
    const workDir = preflightPolicy.noTools
      ? join(tempRoot, "empty-work")
      : cwd
        ? resolve(cwd)
        : join(tempRoot, "work");
    if (preflightPolicy.noTools || !cwd) {
      mkdirSync(workDir, { recursive: true, mode: 0o700 });
    }

    const { userText, attachmentDir, attachmentPaths } = materializePromptAndAttachments(
      prompt,
      contentBlocks,
      tempRoot,
    );

    const policyPath = join(tempRoot, "policy.json");
    const cliSettingsPath = join(tempRoot, "cli-settings.json");
    const schemaPath = schema ? join(tempRoot, "schema.json") : null;
    const runtimeTmp = join(tempRoot, "runtime-tmp");
    mkdirSync(runtimeTmp, { recursive: true, mode: 0o700 });

    const internalDenyPaths = [
      policyPath,
      cliSettingsPath,
      ...(schemaPath ? [schemaPath] : []),
      join(home, ".gemini", "antigravity-cli"),
      join(home, ".gemini", "config"),
      join(home, ".t3", "userdata", "providers", "antigravity"),
    ];

    const policy = buildAgyPolicy({
      cwd: workDir,
      home,
      noTools,
      fullAccess,
      permissionMode,
      tools,
      settings,
      strictMcp,
      addDirs: preflightPolicy.noTools ? [] : resolvedAddDirs,
      internalDenyPaths,
      attachmentReadRoots: attachmentDir ? [attachmentDir] : [],
      allowFinish: Boolean(schema),
    });

    if (policy.enforceHook) {
      writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
    }

    const cliSettings = buildAgyCliSettings(policy);
    writeFileSync(cliSettingsPath, `${JSON.stringify(cliSettings, null, 2)}\n`, { mode: 0o600 });

    if (schemaPath) {
      const schemaObj = typeof schema === "string" ? JSON.parse(schema) : schema;
      writeFileSync(schemaPath, `${JSON.stringify(schemaObj, null, 2)}\n`, { mode: 0o600 });
    }

    const resolvedModel = normalizeModel(model);
    const resolvedEffort = mapEffort(effort);
    const timeoutSecs = Math.max(1, Math.ceil(timeoutMs / 1000));

    const cliArgs = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      resolvedModel,
      "--effort",
      resolvedEffort,
      "--disable-slash-commands",
      "--print-timeout",
      `${timeoutSecs}s`,
      "--settings",
      cliSettingsPath,
    ];

    if (schemaPath) {
      cliArgs.push("--json-schema", schemaPath);
    }

    if (!policy.noTools) {
      if (policy.permissionMode === "acceptEdits") {
        cliArgs.push("--mode", "accept-edits");
      } else if (policy.permissionMode === "bypassPermissions") {
        cliArgs.push("--dangerously-skip-permissions");
      }
    }

    const extraDirs = new Set(policy.noTools ? [] : policy.allowedWriteRoots.slice(1));
    if (attachmentDir) extraDirs.add(attachmentDir);
    for (const extraDir of extraDirs) {
      cliArgs.push("--add-dir", extraDir);
    }

    const childEnv = {
      ...cleanBaseEnv(env),
      PYTHONUNBUFFERED: "1",
      TMPDIR: runtimeTmp,
      ...(policy.enforceHook ? { AGY_RUN_POLICY_FILE: policyPath } : {}),
    };

    const preambleParts = [];
    if (policy.noTools) {
      if (attachmentPaths.length > 0) {
        preambleParts.push(
          policy.allowFinish
            ? `Use only the input and attached image files below (${attachmentPaths.join(", ")}). You may call view_file ONLY on those attached image files, and you MUST submit your final JSON answer by calling the finish tool; do not use any other tools, read other files, write files, run commands, or ask questions.`
            : `Use only the input and attached image files below (${attachmentPaths.join(", ")}). You may call view_file ONLY on those attached image files; do not use any other tools, read other files, write files, run commands, or ask questions.`,
        );
      } else {
        preambleParts.push(
          policy.allowFinish
            ? "Use only the input below. Submit your JSON answer immediately on your first response by calling the finish tool; do not use any other tools, read or write files, run commands, or ask questions."
            : "Use only the input below. Do not use any tools, read or write files, run commands, or ask questions.",
        );
      }
    } else if (policy.restricted) {
      const allowedList = [...policy.allowedAgyTools, ...(policy.allowFinish ? ["finish"] : [])].join(", ") || "none";
      const notes = [`Restricted session: only these tools are permitted: ${allowedList}.`];
      if (policy.confineWrites) {
        notes.push("File edits and writes are confined to the working directory.");
      }
      preambleParts.push(notes.join(" "));
    }
    if (system) {
      preambleParts.push(system);
    }
    if (schema) {
      const schemaStr = typeof schema === "string" ? schema : JSON.stringify(schema);
      preambleParts.push(
        `Submit ONLY valid JSON matching this JSON Schema by calling the finish tool (no prose, no markdown fences):\n${schemaStr}`,
      );
    }

    const fullPrompt = [...preambleParts, userText].filter(Boolean).join("\n\n");

    proc = spawn(binary, cliArgs, {
      cwd: workDir,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrBuf = "";
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 32_000) stderrBuf = stderrBuf.slice(-32_000);
    });

    let collectedText = "";
    let conversationId = null;
    let terminalResult = null;
    let toolViolation = null;
    let stdoutLineBuf = "";

    const handleStreamEvent = (msg) => {
      if (msg.event === "init") {
        if (typeof msg.conversation_id === "string" && msg.conversation_id) {
          conversationId = msg.conversation_id;
        }
        return;
      }

      if (msg.event === "step_update" && msg.step_update) {
        const step = msg.step_update;
        if (!conversationId && typeof step.conversation_id === "string" && step.conversation_id) {
          conversationId = step.conversation_id;
        }
        if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
          collectedText += step.text_delta;
        }
        if (step.step_type === "tool") {
          const toolName = step.tool_name || step.tool_info?.name || "";
          const toolArgs = step.tool_info?.parameters ?? {};
          const failed = Boolean(step.tool_info?.error);
          if (policy.noTools) {
            const verdict = evaluateToolCall(policy, {
              cwd: workDir,
              toolCall: { name: toolName, args: toolArgs },
            });
            if (verdict.decision !== "allow") {
              toolViolation = `Model attempted a tool call in --no-tools mode: ${toolName || "unknown"} (${verdict.reason})`;
            }
          } else if (policy.restricted && step.state === "DONE" && !failed) {
            const verdict = evaluateToolCall(policy, {
              cwd: workDir,
              toolCall: { name: toolName, args: toolArgs },
            });
            if (verdict.decision !== "allow") {
              toolViolation = `Disallowed tool completed in restricted mode: ${toolName || "unknown"} (${verdict.reason})`;
            }
          }
        }
        return;
      }

      if (msg.event === "result" && msg.result) {
        terminalResult = msg.result;
        if (!conversationId && typeof msg.result.conversation_id === "string" && msg.result.conversation_id) {
          conversationId = msg.result.conversation_id;
        }
      }
    };

    const parseLines = (flush = false) => {
      let nl;
      while ((nl = stdoutLineBuf.indexOf("\n")) !== -1) {
        const line = stdoutLineBuf.slice(0, nl).trim();
        stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
        if (!line || !line.startsWith("{")) continue;
        try {
          handleStreamEvent(JSON.parse(line));
        } catch {
          // Ignore non-JSON notice lines
        }
      }
      if (flush && stdoutLineBuf.trim().startsWith("{")) {
        try {
          handleStreamEvent(JSON.parse(stdoutLineBuf.trim()));
        } catch {}
        stdoutLineBuf = "";
      }
    };

    proc.stdout.on("data", (chunk) => {
      stdoutLineBuf += chunk.toString("utf8");
      parseLines(false);
    });

    // Attach error/close handlers before writing stdin so early-exit EPIPE never goes unhandled.
    proc.stdin.on("error", () => {});

    const completionPromise = new Promise((resolveDone, rejectDone) => {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {}
        rejectDone(new Error(`agy-run timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.on("error", (err) => rejectDone(err));
      proc.on("close", (code, signal) => {
        parseLines(true);
        resolveDone({ code, signal });
      });
    });

    // Write the single NDJSON user turn and close stdin so `agy` exits cleanly after the turn.
    proc.stdin.write(`${JSON.stringify({ event: "user", message: { content: fullPrompt } })}\n`);
    proc.stdin.end();

    const completed = await completionPromise;

    if (toolViolation) {
      throw new Error(toolViolation);
    }

    if (!terminalResult) {
      throw new Error(
        `agy exited without emitting a terminal result (code=${completed.code} signal=${completed.signal}): ${stderrBuf.trim().slice(-800)}`,
      );
    }

    if (terminalResult.status !== "SUCCESS") {
      const detail = terminalResult.error || stderrBuf.trim().slice(-800) || `status=${terminalResult.status}`;
      throw new Error(`agy failed (${terminalResult.status || "unknown"}): ${detail}`);
    }

    if (completed.code !== 0 || completed.signal) {
      throw new Error(
        `agy exited abnormally after result (code=${completed.code} signal=${completed.signal}): ${stderrBuf.trim().slice(-800)}`,
      );
    }

    let structuredOutput = undefined;
    let text = (typeof terminalResult?.response === "string" && terminalResult.response.trim()
      ? terminalResult.response
      : collectedText
    ).trim();

    if (schema) {
      if (terminalResult?.structured_output !== undefined && terminalResult?.structured_output !== null) {
        structuredOutput = terminalResult.structured_output;
        text = JSON.stringify(structuredOutput);
      } else {
        structuredOutput = extractJsonFromText(text);
      }
    }

    return {
      text,
      structured_output: structuredOutput,
      model: resolvedModel,
      effort: resolvedEffort,
      tools: policy.exposedClaudeTools,
      stop_reason: terminalResult?.status === "SUCCESS" ? "end_turn" : (terminalResult?.status || "end_turn"),
      duration_ms: Date.now() - startedAt,
      num_turns: terminalResult?.num_turns ?? 1,
      usage: terminalResult?.usage ?? undefined,
      cost_usd: 0,
      session_id: conversationId || terminalResult?.conversation_id || "",
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (proc && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string", default: DEFAULT_MODEL },
      effort: { type: "string", default: DEFAULT_EFFORT },
      agent: { type: "string" },
      system: { type: "string" },
      "system-file": { type: "string" },
      "system-prompt": { type: "string" },
      "system-prompt-file": { type: "string" },
      "json-schema": { type: "string" },
      "output-format": { type: "string", default: "text" },
      "input-format": { type: "string" },
      "content-json": { type: "string" },
      image: { type: "string", multiple: true },
      cwd: { type: "string" },
      "no-tools": { type: "boolean", default: false },
      "full-access": { type: "boolean", default: false },
      timeout: { type: "string" },
      // Claude CLI compatibility flags (for agent-skills and other callers)
      print: { type: "boolean", short: "p", default: false },
      "setting-sources": { type: "string" },
      tools: { type: "string" },
      "strict-mcp-config": { type: "boolean", default: false },
      "disable-slash-commands": { type: "boolean", default: false },
      "no-session-persistence": { type: "boolean", default: false },
      "permission-mode": { type: "string" },
      settings: { type: "string" },
      verbose: { type: "boolean", default: false },
      "max-budget-usd": { type: "string" },
      "add-dir": { type: "string", multiple: true },
      cap: { type: "string" },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.version) {
    console.log("agy-run 2.0.0 (official agy headless CLI / gemini-4-neon)");
    process.exit(0);
  }

  if (values.help) {
    console.log(
      `Usage: agy-run [options] [prompt]\n` +
        `Options:\n` +
        `  --model <slug>          Model (default: ${DEFAULT_MODEL})\n` +
        `  --effort <level>        low | medium | high | xhigh (default: ${DEFAULT_EFFORT})\n` +
        `  --system <text>         System instruction text\n` +
        `  --system-file <path>    File containing system instructions\n` +
        `  --json-schema <json>    JSON Schema string or @file path for structured output\n` +
        `  --output-format <fmt>   text | json | stream-json (default: text)\n` +
        `  --image <path>          Attach image file (repeatable)\n` +
        `  --content-json <path>   File (or - for stdin) containing Messages API content blocks JSON\n` +
        `  --cwd <dir>             Working directory\n` +
        `  --no-tools              Disallow all tool calls\n` +
        `  --full-access           Auto-approve all tool calls\n` +
        `  --timeout <ms>          Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})\n` +
        `  --print, --setting-sources, --tools, --strict-mcp-config, --disable-slash-commands,\n` +
        `  --no-session-persistence, --permission-mode, --settings, --verbose, --max-budget-usd,\n` +
        `  --add-dir, --version    Claude CLI compatibility flags`,
    );
    process.exit(0);
  }

  let system = values.system || values["system-prompt"];
  const sysFile = values["system-file"] || values["system-prompt-file"];
  if (sysFile) {
    system = readFileSync(sysFile, "utf8");
  }

  const noTools = values["no-tools"] || values.tools === "";
  const fullAccess = Boolean(values["full-access"]);
  const permissionMode = values["permission-mode"];
  const resolvedEffort =
    typeof values.model === "string" && /haiku/i.test(values.model)
      ? "low"
      : values.effort;

  let schema;
  if (values["json-schema"]) {
    const raw = values["json-schema"];
    schema = raw.startsWith("@")
      ? JSON.parse(readFileSync(raw.slice(1), "utf8"))
      : existsSync(raw)
        ? JSON.parse(readFileSync(raw, "utf8"))
        : JSON.parse(raw);
  }

  const isPreflight = positionals[0] === "preflight";
  let prompt = (isPreflight ? positionals.slice(1) : positionals).join(" ");
  let contentBlocks;

  if (isPreflight) {
    prompt = "Preflight check: reply with minimal valid JSON matching the schema (e.g. an empty list) and no prose.";
  } else if (values["content-json"]) {
    const raw =
      values["content-json"] === "-"
        ? await readStdin()
        : readFileSync(values["content-json"], "utf8");
    contentBlocks = JSON.parse(raw);
  } else {
    if (!prompt && !process.stdin.isTTY) {
      prompt = await readStdin();
    }
    if (values.image && values.image.length > 0) {
      contentBlocks = [];
      if (prompt) contentBlocks.push({ type: "text", text: prompt });
      for (const imgPath of values.image) {
        contentBlocks.push({
          type: "image",
          data: readFileSync(imgPath).toString("base64"),
          mimeType: mimeForPath(imgPath),
        });
      }
    }
  }

  try {
    const res = await runAgyPrompt({
      prompt,
      contentBlocks,
      system,
      schema,
      model: values.model,
      effort: resolvedEffort,
      agent: values.agent,
      cwd: values.cwd,
      noTools,
      fullAccess,
      permissionMode,
      tools: values.tools,
      settings: values.settings,
      strictMcp: Boolean(values["strict-mcp-config"]),
      addDirs: values["add-dir"] || [],
      timeoutMs: values.timeout ? Number(values.timeout) : DEFAULT_TIMEOUT_MS,
    });

    if (values["output-format"] === "json") {
      process.stdout.write(`${JSON.stringify({ is_error: false, ...res })}\n`);
    } else if (values["output-format"] === "stream-json") {
      const init = {
        type: "system",
        subtype: "init",
        session_id: res.session_id,
        model: res.model,
        tools: res.tools,
        mcp_servers: [],
      };
      const assistant = {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: res.text }] },
      };
      const final = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: res.duration_ms,
        num_turns: res.num_turns,
        result: res.text,
        structured_output: res.structured_output,
        total_cost_usd: 0,
        session_id: res.session_id,
      };
      process.stdout.write(`${JSON.stringify(init)}\n${JSON.stringify(assistant)}\n${JSON.stringify(final)}\n`);
    } else {
      process.stdout.write(`${res.text}\n`);
    }
  } catch (err) {
    process.stderr.write(`agy-run error: ${err.message}\n`);
    process.exit(1);
  }
}
