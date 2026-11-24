import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgyPolicy,
  evaluatePermissionRequest,
  evaluateToolCall,
  UNRESTRICTED_CLAUDE_TOOLS,
} from "./agy-run-policy.js";

const AGY_RUN = join(import.meta.dir, "agy-run.js");
const POLICY_HOOK = join(import.meta.dir, "agy-run-policy.js");

let scratch;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "agy-run-test-")));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function createFakeAcpEnv(behavior = {}) {
  const profile = join(scratch, "profile");
  mkdirSync(join(profile, "antigravity-acp"), { recursive: true });
  writeFileSync(join(profile, "antigravity-acp", "antigravity-oauth-token"), "fake-token");
  const logFile = join(scratch, "acp-log.json");
  const bin = join(scratch, "fake-antigravity");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const behavior = ${JSON.stringify(behavior)};
const args = process.argv.slice(2);
const geminiDir = args[args.indexOf("--gemini-dir") + 1];
const hooksPath = join(geminiDir, "config", "hooks.json");
const log = {
  args,
  cwd: process.cwd(),
  hooksExists: existsSync(hooksPath),
  hooks: existsSync(hooksPath) ? JSON.parse(readFileSync(hooksPath, "utf8")) : null,
  configUpdates: [],
  permissionResponses: [],
  prompts: [],
};

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let nextServerId = 100;
const serverPending = new Map();
const askClient = (method, params) => new Promise((resolve) => {
  const id = nextServerId++;
  serverPending.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
});

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && !msg.method) {
      const resolve = serverPending.get(msg.id);
      if (resolve) {
        serverPending.delete(msg.id);
        resolve(msg.result);
      }
      continue;
    }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    } else if (msg.method === "authenticate") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else if (msg.method === "session/new") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "sess-test-1",
          configOptions: [
            { id: "model", category: "model" },
            { id: "thought_level", category: "thought_level" },
            { id: "mode", category: "mode" },
          ],
        },
      });
    } else if (msg.method === "session/set_config_option") {
      log.configUpdates.push({ configId: msg.params.configId, value: msg.params.value });
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else if (msg.method === "session/prompt") {
      log.prompts.push(msg.params.prompt);
      if (Array.isArray(behavior.preUpdates)) {
        for (const update of behavior.preUpdates) {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-test-1", update } });
        }
      }
      if (Array.isArray(behavior.permissionRequests)) {
        for (const req of behavior.permissionRequests) {
          const resp = await askClient("session/request_permission", req);
          log.permissionResponses.push({ tool: req.toolCall?.name ?? null, outcome: resp?.outcome });
        }
      }
      if (Array.isArray(behavior.updates)) {
        for (const update of behavior.updates) {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-test-1", update } });
        }
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-test-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: behavior.reply ?? "ok" },
          },
        },
      });
      writeFileSync(${JSON.stringify(logFile)}, JSON.stringify(log, null, 2));
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, profile, logFile };
}

describe("agy-run policy builder and validator", () => {
  test("accepts proposer settings, file-only tools, and acceptEdits confinement", () => {
    const work = join(scratch, "work");
    const home = join(scratch, "home");
    const state = join(scratch, "state");
    mkdirSync(work, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(state, { recursive: true });

    const policy = buildAgyPolicy({
      cwd: work,
      home,
      permissionMode: "acceptEdits",
      tools: ["Read", "Edit", "Write", "Glob", "Grep"],
      strictMcp: true,
      settings: JSON.stringify({
        permissions: {
          deny: ["Read(~/.ssh/**)", "Read(~/.claude/projects/**)", `Read(/${state}/**)`],
        },
      }),
    });

    expect(policy.restricted).toBe(true);
    expect(policy.enforceHook).toBe(true);
    expect(policy.confineWrites).toBe(true);
    expect(policy.strictMcp).toBe(true);
    expect(policy.allowedAgyTools).toEqual(["read_file", "edit_file", "write_file"]);
    expect(policy.exposedClaudeTools).toEqual(["Read", "Edit", "Write"]);
  });

  test("unrestricted --full-access reports full exposed tools instead of empty []", () => {
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const policy = buildAgyPolicy({ cwd: work, fullAccess: true });
    expect(policy.restricted).toBe(false);
    expect(policy.exposedClaudeTools).toEqual(UNRESTRICTED_CLAUDE_TOOLS);
    expect(policy.exposedClaudeTools).toContain("Bash");
  });

  test("acceptEdits never widens to Bash even if Bash was listed in tools", () => {
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const policy = buildAgyPolicy({
      cwd: work,
      permissionMode: "acceptEdits",
      tools: ["Read", "Edit", "Bash"],
    });
    expect(policy.allowedAgyTools).toEqual(["read_file", "edit_file"]);
    expect(policy.exposedClaudeTools).toEqual(["Read", "Edit"]);
    expect(policy.confineWrites).toBe(true);
  });

  test("fails closed on unsupported settings, deny rules, tools, and permission modes", () => {
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });

    expect(() =>
      buildAgyPolicy({ cwd: work, settings: JSON.stringify({ sandbox: { enabled: true } }) }),
    ).toThrow(/sandbox/);
    expect(() =>
      buildAgyPolicy({ cwd: work, settings: JSON.stringify({ unknownKey: 1 }) }),
    ).toThrow(/Unsupported settings key/);
    expect(() =>
      buildAgyPolicy({ cwd: work, settings: JSON.stringify({ permissions: { allow: ["Bash"] } }) }),
    ).toThrow(/Unsupported settings\.permissions key/);
    expect(() =>
      buildAgyPolicy({ cwd: work, settings: JSON.stringify({ permissions: { deny: ["Bash(rm -rf *)"] } }) }),
    ).toThrow(/Unsupported permissions\.deny rule/);
    expect(() =>
      buildAgyPolicy({ cwd: work, settings: JSON.stringify({ permissions: { deny: ["Read(~/.env.{local,prod})"] } }) }),
    ).toThrow(/Unsupported glob syntax/);
    expect(() =>
      buildAgyPolicy({ cwd: work, settings: JSON.stringify({ permissions: { deny: ["Read(~/secrets/[a-z].key)"] } }) }),
    ).toThrow(/Unsupported glob syntax/);
    expect(() =>
      buildAgyPolicy({ cwd: work, settings: JSON.stringify({ permissions: { deny: ["Read(!~/ok.txt)"] } }) }),
    ).toThrow(/Unsupported glob syntax/);
    expect(() =>
      buildAgyPolicy({ cwd: work, settings: JSON.stringify({ hooks: { PostToolUse: [] } }) }),
    ).toThrow(/Unsupported settings\.hooks event/);
    expect(() => buildAgyPolicy({ cwd: work, tools: ["Read", "NotATool"] })).toThrow(
      /Unsupported tool/,
    );
    expect(() => buildAgyPolicy({ cwd: work, permissionMode: "plan" })).toThrow(
      /Unsupported --permission-mode/,
    );
    expect(() =>
      buildAgyPolicy({ cwd: work, fullAccess: true, permissionMode: "acceptEdits" }),
    ).toThrow(/Cannot combine --full-access/);
  });
});

describe("agy-run policy PreToolUse evaluation", () => {
  test("enforces tool allowlist, read-deny patterns (including symlinks and //abs paths), and cwd write confinement", () => {
    const home = join(scratch, "home");
    const sshDir = join(home, ".ssh");
    const stateDir = join(scratch, "state");
    const work = join(scratch, "work");
    const outside = join(scratch, "outside");
    const internalGem = join(scratch, "gemini-home");
    mkdirSync(sshDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(internalGem, { recursive: true });
    writeFileSync(join(sshDir, "id_rsa"), "secret");
    writeFileSync(join(stateDir, "scores.jsonl"), "private");
    writeFileSync(join(work, "CLAUDE.md"), "ok");
    writeFileSync(join(outside, "target.txt"), "outside");
    symlinkSync(join(sshDir, "id_rsa"), join(work, "ssh-link"));
    symlinkSync(outside, join(work, "escape-dir"));
    symlinkSync(join(outside, "dangling.txt"), join(work, "dangling-link"));

    const policy = buildAgyPolicy({
      cwd: work,
      home,
      permissionMode: "acceptEdits",
      tools: ["Read", "Edit", "Write", "Glob", "Grep"],
      strictMcp: true,
      settings: JSON.stringify({
        permissions: {
          deny: ["Read(~/.ssh/**)", "Read(~/.netrc)", `Read(/${stateDir}/**)`],
        },
      }),
      internalDenyPaths: [internalGem],
    });

    // Allowed file operations inside cwd
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "read_file", args: { Path: join(work, "CLAUDE.md") } } }).decision).toBe("allow");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "edit_file", args: { Path: join(work, "CLAUDE.md") } } }).decision).toBe("allow");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "write_file", args: { Path: join(work, "new-dir", "new.md") } } }).decision).toBe("allow");

    // Denied non-file / shell / web / subagent / MCP / unknown tools
    for (const badTool of [
      "run_command",
      "manage_task",
      "search_web",
      "invoke_subagent",
      "run_workflow",
      "swarm",
      "schedule",
      "call_mcp_tool",
      "mcp_board_ask_user",
      "unknown_future_tool",
    ]) {
      expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: badTool, args: {} } }).decision, badTool).toBe("deny");
    }

    // Read denies: tilde, absolute, //abs, traversal, symlink to denied file, internal geminiHome
    for (const deniedRead of [
      "~/.ssh/id_rsa",
      join(sshDir, "id_rsa"),
      join(home, ".netrc"),
      join(stateDir, "scores.jsonl"),
      join(work, "..", "state", "scores.jsonl"),
      join(work, "ssh-link"),
      join(internalGem, "antigravity-acp", "antigravity-oauth-token"),
    ]) {
      expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "read_file", args: { Path: deniedRead } } }).decision, deniedRead).toBe("deny");
    }

    // Write confinement: outside path, traversal, symlink dir, dangling symlink, internal geminiHome
    for (const deniedWrite of [
      join(outside, "new.txt"),
      join(work, "..", "outside", "new.txt"),
      join(work, "escape-dir", "evil.txt"),
      join(work, "dangling-link"),
      join(internalGem, "config", "hooks.json"),
    ]) {
      expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "write_file", args: { Path: deniedWrite } } }).decision, deniedWrite).toBe("deny");
      expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "edit_file", args: { Path: deniedWrite } } }).decision, deniedWrite).toBe("deny");
    }

    // Symlink followed by `..` must resolve symlink before collapsing `..` (POSIX semantics)
    const sshSub = join(sshDir, "subdir");
    const outsideDeep = join(outside, "deep");
    mkdirSync(sshSub, { recursive: true });
    mkdirSync(outsideDeep, { recursive: true });
    symlinkSync(sshSub, join(work, "ssh-sub"));
    symlinkSync(outsideDeep, join(work, "deep-link"));
    symlinkSync("deep-link/../via-dangling.txt", join(work, "nested-dangling"));
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "read_file", args: { Path: `${work}/ssh-sub/../id_rsa` } } }).decision).toBe("deny");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "read_file", args: { Path: "ssh-sub/../id_rsa" } } }).decision).toBe("deny");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "write_file", args: { Path: `${work}/deep-link/../escaped.txt` } } }).decision).toBe("deny");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "write_file", args: { Path: join(work, "nested-dangling") } } }).decision).toBe("deny");

    // Missing path arg fails closed
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "read_file", args: {} } }).decision).toBe("deny");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "write_file", args: {} } }).decision).toBe("deny");
  });

  test("settings.hooks.PreToolUse honors exit-0 JSON deny/block decisions", () => {
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const jsonHook = join(scratch, "json-deny.js");
    writeFileSync(
      jsonHook,
      `const input = JSON.parse(await Bun.stdin.text());
if ((input.tool_input?.command ?? "").includes("deny-json")) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Denied via JSON" } }));
} else if ((input.tool_input?.command ?? "").includes("block-top")) {
  console.log(JSON.stringify({ decision: "block", reason: "Blocked top-level" }));
}
`,
    );
    const policy = buildAgyPolicy({
      cwd: work,
      fullAccess: true,
      tools: ["Bash"],
      settings: JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `"${process.execPath}" "${jsonHook}"` }] }] },
      }),
    });
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "run_command", args: { CommandLine: "echo ok" } } }).decision).toBe("allow");
    const d1 = evaluateToolCall(policy, { cwd: work, toolCall: { name: "run_command", args: { CommandLine: "deny-json" } } });
    expect(d1).toEqual({ decision: "deny", reason: "Denied via JSON" });
    const d2 = evaluateToolCall(policy, { cwd: work, toolCall: { name: "run_command", args: { CommandLine: "block-top" } } });
    expect(d2).toEqual({ decision: "deny", reason: "Blocked top-level" });
  });

  test("executes settings.hooks.PreToolUse command hooks (e.g. benchSettings block-installs)", () => {
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const hook = join(scratch, "block.js");
    writeFileSync(
      hook,
      `const input = JSON.parse(await Bun.stdin.text());
if (input.tool_name === "Bash" && /curl/.test(input.tool_input?.command ?? "")) {
  console.error("Blocked curl");
  process.exit(2);
}
`,
    );

    const policy = buildAgyPolicy({
      cwd: work,
      fullAccess: true,
      tools: ["Read", "Grep", "Glob", "Bash"],
      settings: JSON.stringify({
        permissions: { deny: ["WebFetch", "WebSearch"] },
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: `"${process.execPath}" "${hook}"` }] }],
        },
      }),
    });

    expect(policy.exposedClaudeTools).toEqual(["Read", "Bash"]);
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "run_command", args: { CommandLine: "git diff main" } } }).decision).toBe("allow");
    const blocked = evaluateToolCall(policy, { cwd: work, toolCall: { name: "run_command", args: { CommandLine: "curl https://example.com" } } });
    expect(blocked.decision).toBe("deny");
    expect(blocked.reason).toContain("Blocked curl");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "write_file", args: { Path: join(work, "a.js") } } }).decision).toBe("deny");
  });

  test("standalone hook CLI fails closed on malformed stdin or missing policy", () => {
    const policyPath = join(scratch, "policy.json");
    writeFileSync(policyPath, JSON.stringify(buildAgyPolicy({ cwd: scratch, noTools: true })));

    const badJson = spawnSync(process.execPath, [POLICY_HOOK, "--policy", policyPath], {
      input: "{bad json",
      encoding: "utf8",
    });
    expect(JSON.parse(badJson.stdout).decision).toBe("deny");

    const missingPolicy = spawnSync(process.execPath, [POLICY_HOOK, "--policy", join(scratch, "nope.json")], {
      input: JSON.stringify({ toolCall: { name: "read_file", args: { Path: join(scratch, "a") } } }),
      encoding: "utf8",
    });
    expect(JSON.parse(missingPolicy.stdout).decision).toBe("deny");
  });

  test("evaluatePermissionRequest never blindly approves unidentified or disallowed calls in restricted mode", () => {
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const policy = buildAgyPolicy({ cwd: work, permissionMode: "acceptEdits", tools: ["Read", "Edit", "Write"] });
    expect(evaluatePermissionRequest(policy, { toolCall: { name: "run_command", rawInput: { CommandLine: "ls" } } }).allow).toBe(false);
    expect(evaluatePermissionRequest(policy, { toolCall: { name: "write_file", rawInput: { Path: join(scratch, "outside.txt") } } }).allow).toBe(false);
    expect(evaluatePermissionRequest(policy, { toolCall: { name: "write_file", rawInput: { Path: join(work, "ok.txt") } } }).allow).toBe(true);
    expect(evaluatePermissionRequest(policy, { toolCall: {} }).allow).toBe(false);
  });
});

describe("agy-run CLI with fake Antigravity ACP server", () => {
  test("restricted proposer mode installs PreToolUse hook, sets accept-edits mode, denies shell permission requests, and emits accurate init.tools", () => {
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const { bin, profile, logFile } = createFakeAcpEnv({
      permissionRequests: [
        {
          toolCall: { name: "run_command", rawInput: { CommandLine: "cat ~/.ssh/id_rsa" } },
          options: [{ optionId: "allow_once", kind: "allow_once" }],
        },
        {
          toolCall: { name: "write_file", rawInput: { Path: join(work, "CLAUDE.md") } },
          options: [
            { optionId: "allow_always", kind: "allow_always" },
            { optionId: "allow_once", kind: "allow_once" },
          ],
        },
      ],
      reply: "done\nTITLE: Test",
    });

    const settings = JSON.stringify({ permissions: { deny: ["Read(~/.ssh/**)"] } });
    const run = spawnSync(
      process.execPath,
      [
        AGY_RUN,
        "--cwd", work,
        "--permission-mode", "acceptEdits",
        "--tools", "Read,Edit,Write,Glob,Grep",
        "--strict-mcp-config",
        "--settings", settings,
        "--output-format", "stream-json",
      ],
      {
        input: "Update the rule",
        encoding: "utf8",
        env: { ...process.env, AGY_RUN_BIN: bin, AGY_RUN_GEMINI_HOME: profile },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const events = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      type: "system",
      subtype: "init",
      tools: ["Read", "Edit", "Write"],
      mcp_servers: [],
    });

    const log = JSON.parse(readFileSync(logFile, "utf8"));
    expect(log.hooksExists).toBe(true);
    expect(log.hooks["agy-run-policy"].PreToolUse[0].matcher).toBe("*");
    expect(log.configUpdates).toContainEqual({ configId: "mode", value: "accept-edits" });
    expect(log.permissionResponses).toEqual([
      { tool: "run_command", outcome: { outcome: "cancelled" } },
      { tool: "write_file", outcome: { outcome: "selected", optionId: "allow_once" } },
    ]);
  });

  test("unrestricted --full-access emits full exposed tools (never tools: [])", () => {
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const { bin, profile } = createFakeAcpEnv({ reply: "hi" });
    const run = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", work, "--full-access", "--output-format", "stream-json"],
      {
        input: "hello",
        encoding: "utf8",
        env: { ...process.env, AGY_RUN_BIN: bin, AGY_RUN_GEMINI_HOME: profile },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const init = JSON.parse(run.stdout.trim().split("\n")[0]);
    expect(init.tools).toEqual(UNRESTRICTED_CLAUDE_TOOLS);
    expect(init.tools).toContain("Bash");
  });

  test("fails closed when a disallowed tool reports completed in session/update", () => {
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const { bin, profile } = createFakeAcpEnv({
      updates: [{ sessionUpdate: "tool_call_update", name: "run_command", status: "completed" }],
      reply: "done",
    });
    const run = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", work, "--permission-mode", "acceptEdits", "--tools", "Read,Edit,Write", "--output-format", "stream-json"],
      {
        input: "hi",
        encoding: "utf8",
        env: { ...process.env, AGY_RUN_BIN: bin, AGY_RUN_GEMINI_HOME: profile },
      },
    );
    expect(run.status).toBe(1);
    // Fails closed when a disallowed tool reports completed via toolCallId (without repeating name on update)
    const { bin: bin2, profile: profile2 } = createFakeAcpEnv({
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "tc-99", name: "run_command", status: "in_progress" },
        { sessionUpdate: "tool_call_update", toolCallId: "tc-99", status: "completed" },
      ],
      reply: "done",
    });
    const run2 = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", work, "--permission-mode", "acceptEdits", "--tools", "Read,Edit,Write", "--output-format", "stream-json"],
      {
        input: "hi",
        encoding: "utf8",
        env: { ...process.env, AGY_RUN_BIN: bin2, AGY_RUN_GEMINI_HOME: profile2 },
      },
    );
    expect(run2.status).toBe(1);
    expect(run2.stderr).toContain("Disallowed tool completed in restricted mode: run_command");
  });

  test("correlates toolCallId for session/request_permission without name, refuses allow_always fallback in restricted mode, and resolves relative --add-dir against caller cwd", () => {
    const extra = join(scratch, "extra-dir");
    mkdirSync(extra, { recursive: true });
    const { bin, profile, logFile } = createFakeAcpEnv({
      preUpdates: [
        { sessionUpdate: "tool_call", toolCallId: "tc-1", name: "run_command", rawInput: { CommandLine: "git status" }, status: "in_progress" },
        { sessionUpdate: "tool_call", toolCallId: "tc-2", name: "run_command", rawInput: { CommandLine: "git log" }, status: "in_progress" },
      ],
      permissionRequests: [
        // Standard ACP request_permission without toolCall.name; correlated via toolCallId, approved with allow_once
        {
          toolCall: { toolCallId: "tc-1", kind: "execute", rawInput: { CommandLine: "git status" } },
          options: [{ optionId: "allow_once", kind: "allow_once" }],
        },
        // No allow_once option offered (only allow_always): restricted mode must NOT fall back to allow_always
        {
          toolCall: { toolCallId: "tc-2", kind: "execute", rawInput: { CommandLine: "git log" } },
          options: [{ optionId: "allow_always", kind: "allow_always" }],
        },
      ],
      reply: "ok",
    });
    const run = spawnSync(
      process.execPath,
      [
        AGY_RUN,
        "--full-access",
        "--tools", "Read,Bash",
        "--add-dir", "./extra-dir",
        "--output-format", "stream-json",
      ],
      {
        cwd: scratch,
        input: "check",
        encoding: "utf8",
        env: { ...process.env, AGY_RUN_BIN: bin, AGY_RUN_GEMINI_HOME: profile },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const log = JSON.parse(readFileSync(logFile, "utf8"));
    expect(log.args).toContain(extra);
    expect(log.permissionResponses).toEqual([
      { tool: null, outcome: { outcome: "selected", optionId: "allow_once" } },
      { tool: null, outcome: { outcome: "cancelled" } },
    ]);
  });

  test("fails closed before spawning ACP on unsupported settings (e.g. sandbox)", () => {
    const run = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", scratch, "--settings", JSON.stringify({ sandbox: { enabled: true } }), "--output-format", "stream-json"],
      {
        input: "hi",
        encoding: "utf8",
        env: { ...process.env, AGY_RUN_BIN: join(scratch, "nonexistent-binary") },
      },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("sandbox");
  });
});
