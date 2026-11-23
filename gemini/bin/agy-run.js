#!/usr/bin/env bun
/**
 * agy-run: Headless Antigravity ACP runner that reuses T3 Code's existing Google OAuth login.
 *
 * Designed as the Gemini 4 Neon replacement for unattended `claude -p` calls across:
 *   - claude/factory (friction capture, scoring, proposals, ui-climb judges)
 *   - agent-skills (extract, verify, correct, weekly maintainer review)
 *   - ad-hoc headless prompts
 *
 * Uses an isolated temporary GEMINI_HOME containing a copy of T3's OAuth token and settings
 * so headless calls never trigger global hooks/MCP, never pollute T3 session history, and leave
 * zero leftover files behind.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { arch, homedir, platform, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_INSTANCE = "antigravity";
const DEFAULT_MODEL = "gemini-4-neon";
const DEFAULT_EFFORT = "low";
const DEFAULT_TIMEOUT_MS = 240_000;

export function resolveAgyBinary(env = process.env) {
  if (env.AGY_RUN_BIN) return env.AGY_RUN_BIN;
  const home = env.HOME || homedir();
  const t3Home = env.T3CODE_HOME || join(home, ".t3");
  const platArch = `${platform()}-${arch()}`;
  const base = join(t3Home, "tools", "antigravity-acp", platArch);
  const activePath = join(base, "active.json");
  if (existsSync(activePath)) {
    const active = JSON.parse(readFileSync(activePath, "utf8"));
    if (active?.releaseId) {
      const bin = join(base, "versions", active.releaseId, "antigravity");
      if (existsSync(bin)) return bin;
    }
  }
  throw new Error(`Could not find T3 Antigravity binary under ${base}; set AGY_RUN_BIN`);
}

export function resolveT3ProfileDir(env = process.env) {
  if (env.AGY_RUN_GEMINI_HOME) return env.AGY_RUN_GEMINI_HOME;
  const home = env.HOME || homedir();
  const t3Home = env.T3CODE_HOME || join(home, ".t3");
  const instance = env.AGY_RUN_INSTANCE || DEFAULT_INSTANCE;
  const hash = createHash("sha256").update(instance).digest("hex");
  return join(t3Home, "userdata", "providers", "antigravity", hash);
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
  ]);
  const dropPrefix = ["CLAUDE_", "T3CODE_", "T3_"];
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (dropExact.has(k) || dropPrefix.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  out.AGENT_BOARD_HOOKS = "off";
  return out;
}

function prepareIsolatedProfile(sourceProfileDir, tempRoot) {
  const isolated = join(tempRoot, "gemini-home");
  const acpSrc = join(sourceProfileDir, "antigravity-acp");
  const acpDst = join(isolated, "antigravity-acp");
  const cfgDst = join(isolated, "config");
  const tmpDst = join(tempRoot, "runtime-tmp");
  mkdirSync(acpDst, { recursive: true, mode: 0o700 });
  mkdirSync(cfgDst, { recursive: true, mode: 0o700 });
  mkdirSync(tmpDst, { recursive: true, mode: 0o700 });

  const tokenFiles = [
    "antigravity-oauth-token",
    "acp_token.json",
    "settings.json",
    "installation_id",
  ];
  let copiedAnyToken = false;
  for (const file of tokenFiles) {
    const src = join(acpSrc, file);
    if (existsSync(src)) {
      copyFileSync(src, join(acpDst, file));
      if (file.includes("token")) copiedAnyToken = true;
    }
  }
  if (!copiedAnyToken) {
    throw new Error(`No Antigravity OAuth token found in ${acpSrc}`);
  }
  return { geminiHome: isolated, runtimeTmp: tmpDst };
}

function mimeForPath(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

export function extractJsonFromText(text) {
  const trimmed = text.trim();
  // Try raw parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // Strip ```json ... ``` fences
    const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(trimmed);
    if (fence) {
      return JSON.parse(fence[1].trim());
    }
    // Try substring between first {/[ and last }/]
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
        return JSON.parse(trimmed.slice(start, end + 1));
      }
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
  // Map legacy Claude aliases/models to Gemini 4 Neon
  if (m.includes("claude") || m === "opus" || m === "haiku" || m === "sonnet" || m === "fable") {
    return DEFAULT_MODEL;
  }
  return model;
}

export async function runAgyPrompt({
  prompt,
  contentBlocks,
  system,
  schema,
  model = DEFAULT_MODEL,
  effort = DEFAULT_EFFORT,
  cwd,
  noTools = false,
  fullAccess = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
}) {
  const startedAt = Date.now();
  const binary = resolveAgyBinary(env);
  const sourceProfile = resolveT3ProfileDir(env);
  const tempRoot = mkdtempSync(join(tmpdir(), "agy-run-"));
  const workDir = cwd ? resolve(cwd) : join(tempRoot, "work");
  if (!cwd) mkdirSync(workDir, { recursive: true });

  const { geminiHome, runtimeTmp } = prepareIsolatedProfile(sourceProfile, tempRoot);

  const resolvedModel = normalizeModel(model);
  const resolvedEffort = mapEffort(effort);

  const childEnv = {
    ...cleanBaseEnv(env),
    GEMINI_HOME: geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    PYTHONUNBUFFERED: "1",
    TMPDIR: runtimeTmp,
  };

  let proc;
  let timer;
  try {
    proc = spawn(
      binary,
      ["acp", "--gemini-dir", geminiHome, "--app-data-dir", "antigravity-acp"],
      {
        cwd: workDir,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stderrBuf = "";
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 32_000) stderrBuf = stderrBuf.slice(-32_000);
    });

    let nextId = 1;
    const pending = new Map();
    let collectedText = "";
    let toolViolation = null;
    let sessionId = null;

    const sendRaw = (obj) => {
      proc.stdin.write(`${JSON.stringify(obj)}\n`);
    };

    const request = (method, params) =>
      new Promise((resolveReq, rejectReq) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveReq, reject: rejectReq, method });
        sendRaw({ jsonrpc: "2.0", id, method, params });
      });

    const handleServerRequest = (msg) => {
      const { id, method, params } = msg;
      if (method === "session/request_permission") {
        if (noTools) {
          toolViolation = `Tool permission requested in --no-tools mode: ${JSON.stringify(params?.toolCall?.title || params?.toolCall?.kind || "unknown")}`;
          sendRaw({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
          return;
        }
        const options = params?.options || [];
        const allow =
          options.find((o) => o.kind === "allow_always") ||
          options.find((o) => o.kind === "allow_once") ||
          options[0];
        if (fullAccess && allow?.optionId) {
          sendRaw({
            jsonrpc: "2.0",
            id,
            result: { outcome: { outcome: "selected", optionId: allow.optionId } },
          });
        } else {
          sendRaw({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        }
        return;
      }
      // Reject client fs/terminal/elicitation requests in headless mode
      sendRaw({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unsupported client method in headless mode: ${method}` },
      });
    };

    let stdoutLineBuf = "";
    proc.stdout.on("data", (chunk) => {
      stdoutLineBuf += chunk.toString("utf8");
      let nl;
      while ((nl = stdoutLineBuf.indexOf("\n")) !== -1) {
        const line = stdoutLineBuf.slice(0, nl).trim();
        stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
        if (!line || !line.startsWith("{")) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        // Response to our request
        if (msg.id !== undefined && !msg.method) {
          const entry = pending.get(msg.id);
          if (entry) {
            pending.delete(msg.id);
            if (msg.error) {
              entry.reject(
                new Error(`ACP ${entry.method} error (${msg.error.code}): ${msg.error.message}`),
              );
            } else {
              entry.resolve(msg.result);
            }
          }
          continue;
        }
        // Server-to-client request
        if (msg.id !== undefined && msg.method) {
          handleServerRequest(msg);
          continue;
        }
        // Notification
        if (msg.method === "session/update") {
          const update = msg.params?.update;
          if (!update) continue;
          if (
            noTools &&
            (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
          ) {
            toolViolation = `Model attempted a tool call in --no-tools mode: ${update.title || update.toolCallId || "tool"}`;
          }
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content?.type === "text" &&
            typeof update.content.text === "string"
          ) {
            collectedText += update.content.text;
          }
        }
      }
    });

    const exitPromise = new Promise((_, rejectExit) => {
      proc.on("error", (err) => rejectExit(err));
      proc.on("exit", (code, signal) => {
        for (const [, entry] of pending) {
          entry.reject(
            new Error(`antigravity acp exited prematurely (code=${code}, signal=${signal}): ${stderrBuf.slice(-800)}`),
          );
        }
        pending.clear();
      });
    });

    const timeoutPromise = new Promise((_, rejectTimeout) => {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {}
        rejectTimeout(new Error(`agy-run timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const run = async () => {
      await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "t3-code", title: "T3 Code", version: "0.1.12" },
      });

      await request("authenticate", { methodId: "oauth-personal" });

      const newSession = await request("session/new", {
        cwd: workDir,
        mcpServers: [],
      });
      sessionId = newSession.sessionId;
      const configOptions = newSession.configOptions || [];

      const modelOption = configOptions.find((o) => o.id === "model");
      if (modelOption && resolvedModel) {
        await request("session/set_config_option", {
          sessionId,
          configId: "model",
          value: resolvedModel,
        });
      }

      const thoughtOption = configOptions.find(
        (o) => o.category === "thought_level" || o.id === "thought_level",
      );
      if (thoughtOption && resolvedEffort) {
        try {
          await request("session/set_config_option", {
            sessionId,
            configId: thoughtOption.id,
            value: resolvedEffort,
          });
        } catch {
          // Some models may not support every thought_level
        }
      }

      const blocks = [];
      const preambleParts = [];
      if (noTools) {
        preambleParts.push(
          "Use only the input below. Do not use any tools, read or write files, run commands, or ask questions.",
        );
      }
      if (system) {
        preambleParts.push(system);
      }
      if (schema) {
        const schemaStr = typeof schema === "string" ? schema : JSON.stringify(schema);
        preambleParts.push(
          `Return ONLY valid JSON matching this JSON Schema (no prose, no markdown fences):\n${schemaStr}`,
        );
      }
      if (preambleParts.length > 0) {
        blocks.push({ type: "text", text: preambleParts.join("\n\n") });
      }
      if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
        for (const block of contentBlocks) {
          if (block.type === "text") {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "image" && block.source?.type === "base64") {
            blocks.push({
              type: "image",
              data: block.source.data,
              mimeType: block.source.media_type || "image/png",
            });
          } else if (block.type === "image" && block.data) {
            blocks.push({
              type: "image",
              data: block.data,
              mimeType: block.mimeType || "image/png",
            });
          }
        }
      } else if (prompt) {
        blocks.push({ type: "text", text: prompt });
      }

      const promptResult = await request("session/prompt", {
        sessionId,
        prompt: blocks,
      });

      if (toolViolation) {
        throw new Error(toolViolation);
      }

      const text = collectedText.trim();
      let structuredOutput = undefined;
      if (schema) {
        structuredOutput = extractJsonFromText(text);
      }

      return {
        text,
        structured_output: structuredOutput,
        model: resolvedModel,
        effort: resolvedEffort,
        stop_reason: promptResult?.stopReason || "end_turn",
        duration_ms: Date.now() - startedAt,
        cost_usd: 0,
        session_id: sessionId,
      };
    };

    return await Promise.race([run(), exitPromise, timeoutPromise]);
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
    console.log("agy-run 1.0.0 (Antigravity ACP / gemini-4-neon)");
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
  const fullAccess =
    values["full-access"] ||
    values["permission-mode"] === "bypassPermissions" ||
    values["permission-mode"] === "acceptEdits";
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
      cwd: values.cwd,
      noTools,
      fullAccess,
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
        tools: [],
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
