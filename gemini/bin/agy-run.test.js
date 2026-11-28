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
  buildAgyCliSettings,
  buildAgyPolicy,
  evaluateToolCall,
  UNRESTRICTED_CLAUDE_TOOLS,
} from "./agy-run-policy.js";
import { extractJsonFromText, runAgyPrompt } from "./agy-run.js";

const AGY_RUN = join(import.meta.dir, "agy-run.js");
const POLICY_HOOK = join(import.meta.dir, "agy-run-policy.js");
const REPO_HOOKS_JSON = join(import.meta.dir, "..", "hooks.json");

let scratch;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "agy-run-test-")));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function createTestHome(name = "home") {
  const home = join(scratch, name);
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  writeFileSync(join(home, ".gemini", "config", "hooks.json"), readFileSync(REPO_HOOKS_JSON, "utf8"));
  return home;
}

function createFakeAgyCli(behavior = {}) {
  const logFile = join(scratch, "cli-log.json");
  const bin = join(scratch, "fake-agy");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const behavior = ${JSON.stringify(behavior)};
const args = process.argv.slice(2);
const flagVal = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
};

const settingsPath = flagVal("--settings");
const schemaPath = flagVal("--json-schema");
const policyPath = process.env.AGY_RUN_POLICY_FILE || null;

const log = {
  args,
  cwd: process.cwd(),
  env: {
    AGENT_BOARD_HOOKS: process.env.AGENT_BOARD_HOOKS ?? null,
    AGY_RUN_ACTIVE: process.env.AGY_RUN_ACTIVE ?? null,
    AGY_RUN_POLICY_FILE: policyPath,
    AGY_ACP_FORCE_FILE_STORAGE: process.env.AGY_ACP_FORCE_FILE_STORAGE ?? null,
    GEMINI_HOME: process.env.GEMINI_HOME ?? null,
    SSH_CONNECTION: process.env.SSH_CONNECTION ?? null,
  },
  cliSettings: settingsPath && existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : null,
  schema: schemaPath && existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, "utf8")) : null,
  policyExists: Boolean(policyPath && existsSync(policyPath)),
  hookResults: [],
  stdinMessages: [],
};

if (policyPath && Array.isArray(behavior.hookChecks)) {
  for (const payload of behavior.hookChecks) {
    const res = spawnSync(process.execPath, [${JSON.stringify(POLICY_HOOK)}, "--policy", policyPath], {
      cwd: process.cwd(),
      input: JSON.stringify(payload),
      encoding: "utf8",
    });
    log.hookResults.push({
      tool: payload.toolCall?.name ?? null,
      path: payload.toolCall?.args?.Path ?? payload.toolCall?.args?.AbsolutePath ?? null,
      status: res.status,
      output: res.stdout.trim() ? JSON.parse(res.stdout.trim()) : null,
    });
  }
}

const rawStdin = await Bun.stdin.text();
for (const line of rawStdin.split("\\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  log.stdinMessages.push(JSON.parse(trimmed));
}

if (behavior.checkAttachmentExists) {
  const msg = log.stdinMessages[0]?.message?.content ?? "";
  const match = /inspect ([^\\s]+\\.png) using view_file/.exec(msg);
  log.attachmentExists = Boolean(match && existsSync(match[1]));
  log.attachmentPath = match ? match[1] : null;
}

writeFileSync(${JSON.stringify(logFile)}, JSON.stringify(log, null, 2));

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
send({
  event: "init",
  conversation_id: "conv-test-1",
  init: { model: flagVal("--model") || "gemini-4-neon", cwd: process.cwd(), permission_mode: "strict" },
});

if (Array.isArray(behavior.steps)) {
  for (const step of behavior.steps) {
    send({ event: "step_update", step_update: { conversation_id: "conv-test-1", ...step } });
  }
}

const reply = behavior.reply ?? "ok";
send({
  event: "step_update",
  step_update: {
    conversation_id: "conv-test-1",
    step_index: 1,
    state: "DONE",
    step_type: "agent_response",
    text_delta: reply,
  },
});

if (!behavior.omitResult) {
  const resultPayload = {
    conversation_id: "conv-test-1",
    status: behavior.status ?? "SUCCESS",
    response: reply,
    num_turns: 1,
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    ...(behavior.structuredOutput !== undefined ? { structured_output: behavior.structuredOutput } : {}),
    ...(behavior.error ? { error: behavior.error } : {}),
  };
  send({ event: "result", result: resultPayload });
}
process.exit(behavior.exitCode ?? 0);
`,
  );
  chmodSync(bin, 0o755);
  return { bin, logFile };
}

describe("agy-run policy builder and validator", () => {
  test("accepts proposer settings, single-file Read/Edit/Write tools (no recursive dir search or send_command_input), and acceptEdits confinement", () => {
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
    expect(policy.allowedAgyTools).toContain("read_file");
    expect(policy.allowedAgyTools).toContain("view_file");
    expect(policy.allowedAgyTools).toContain("view_file_outline");
    expect(policy.allowedAgyTools).toContain("view_code_item");
    expect(policy.allowedAgyTools).toContain("edit_file");
    expect(policy.allowedAgyTools).toContain("replace_file_content");
    expect(policy.allowedAgyTools).toContain("write_file");
    expect(policy.allowedAgyTools).toContain("write_to_file");
    // Recursive directory search tools must NOT be allowed under Read (parent-dir deny bypass)
    expect(policy.allowedAgyTools).not.toContain("grep_search");
    expect(policy.allowedAgyTools).not.toContain("find_by_name");
    expect(policy.allowedAgyTools).not.toContain("list_dir");
    expect(policy.allowedAgyTools).not.toContain("run_command");
    expect(policy.allowedAgyTools).not.toContain("send_command_input");
    expect(policy.exposedClaudeTools).toEqual(["Read", "Edit", "Write"]);

    const cliSettings = buildAgyCliSettings(policy);
    expect(cliSettings.allowNonWorkspaceAccess).toBe(false);
    expect(cliSettings.permissions.deny).toContain("command(*)");
    expect(cliSettings.permissions.deny).toContain("mcp(*)");
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
    expect(policy.allowedAgyTools).toContain("read_file");
    expect(policy.allowedAgyTools).toContain("edit_file");
    expect(policy.allowedAgyTools).not.toContain("run_command");
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
  test("enforces tool allowlist, read-deny patterns (including symlinks, CLI tool names, and //abs paths), and cwd write confinement", () => {
    const home = join(scratch, "home");
    const sshDir = join(home, ".ssh");
    const stateDir = join(scratch, "state");
    const work = join(scratch, "work");
    const outside = join(scratch, "outside");
    const internalDir = join(scratch, "internal");
    mkdirSync(sshDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(internalDir, { recursive: true });
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
      internalDenyPaths: [internalDir],
    });

    // Allowed file operations inside cwd (both ACP and CLI tool names)
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "read_file", args: { Path: join(work, "CLAUDE.md") } } }).decision).toBe("allow");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "view_file", args: { AbsolutePath: join(work, "CLAUDE.md") } } }).decision).toBe("allow");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "view_file_outline", args: { AbsolutePath: join(work, "CLAUDE.md") } } }).decision).toBe("allow");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "edit_file", args: { Path: join(work, "CLAUDE.md") } } }).decision).toBe("allow");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "replace_file_content", args: { TargetFile: join(work, "CLAUDE.md") } } }).decision).toBe("allow");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "write_file", args: { Path: join(work, "new-dir", "new.md") } } }).decision).toBe("allow");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "write_to_file", args: { TargetFile: join(work, "new-dir", "new2.md") } } }).decision).toBe("allow");

    // Denied non-file / directory-search / shell / send_command_input / web / subagent / MCP / unknown tools
    for (const badTool of [
      "grep_search",
      "find_by_name",
      "list_dir",
      "run_command",
      "send_command_input",
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

    // Read denies: tilde, absolute, traversal, symlink to denied file, internal dir
    for (const deniedRead of [
      "~/.ssh/id_rsa",
      join(sshDir, "id_rsa"),
      join(home, ".netrc"),
      join(stateDir, "scores.jsonl"),
      join(work, "..", "state", "scores.jsonl"),
      join(work, "ssh-link"),
      join(internalDir, "policy.json"),
    ]) {
      expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "view_file", args: { AbsolutePath: deniedRead } } }).decision, deniedRead).toBe("deny");
    }

    // Write confinement: outside path, traversal, symlink dir, dangling symlink, internal dir
    for (const deniedWrite of [
      join(outside, "new.txt"),
      join(work, "..", "outside", "new.txt"),
      join(work, "escape-dir", "evil.txt"),
      join(work, "dangling-link"),
      join(internalDir, "cli-settings.json"),
    ]) {
      expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "write_to_file", args: { TargetFile: deniedWrite } } }).decision, deniedWrite).toBe("deny");
      expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "replace_file_content", args: { TargetFile: deniedWrite } } }).decision, deniedWrite).toBe("deny");
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

  test("noTools with attachmentReadRoots allows view_file ONLY inside attachment directory", () => {
    const work = join(scratch, "work");
    const attach = join(scratch, "attachments");
    mkdirSync(work, { recursive: true });
    mkdirSync(attach, { recursive: true });
    const img = join(attach, "image-1.png");
    const other = join(work, "secret.txt");
    writeFileSync(img, "png");
    writeFileSync(other, "secret");

    const policy = buildAgyPolicy({ cwd: work, noTools: true, attachmentReadRoots: [attach] });
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "view_file", args: { AbsolutePath: img } } }).decision).toBe("allow");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "view_file", args: { AbsolutePath: other } } }).decision).toBe("deny");
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "run_command", args: { CommandLine: "ls" } } }).decision).toBe("deny");
  });

  test("settings.hooks.PreToolUse honors exit-0 JSON deny/block decisions and blocks send_command_input", () => {
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
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "send_command_input", args: { Input: "curl evil\n" } } }).decision).toBe("deny");
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
    expect(evaluateToolCall(policy, { cwd: work, toolCall: { name: "write_to_file", args: { TargetFile: join(work, "a.js") } } }).decision).toBe("deny");
  });

  test("allows built-in finish tool ONLY when allowFinish (schema) is active, still runs caller hooks, and extracts prose-wrapped or concatenated JSON", () => {
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const noSchemaPolicy = buildAgyPolicy({ cwd: work, noTools: true });
    expect(evaluateToolCall(noSchemaPolicy, { cwd: work, toolCall: { name: "finish", args: {} } }).decision).toBe("deny");

    const schemaNoTools = buildAgyPolicy({ cwd: work, noTools: true, allowFinish: true });
    const schemaRestricted = buildAgyPolicy({ cwd: work, permissionMode: "acceptEdits", tools: ["Read"], allowFinish: true });
    expect(evaluateToolCall(schemaNoTools, { cwd: work, toolCall: { name: "finish", args: { output: '{"ok":true}' } } }).decision).toBe("allow");
    expect(evaluateToolCall(schemaRestricted, { cwd: work, toolCall: { name: "finish", args: { output: '{"ok":true}' } } }).decision).toBe("allow");

    // Caller settings.hooks.PreToolUse must still run on finish
    const denyHook = join(scratch, "deny-finish.js");
    writeFileSync(denyHook, 'console.error("Blocked finish"); process.exit(2);\n');
    const hookedPolicy = buildAgyPolicy({
      cwd: work,
      noTools: true,
      allowFinish: true,
      settings: JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `"${process.execPath}" "${denyHook}"` }] }] },
      }),
    });
    expect(evaluateToolCall(hookedPolicy, { cwd: work, toolCall: { name: "finish", args: {} } }).decision).toBe("deny");

    // extractJsonFromText preserves full outer multi-line JSON wrapped in prose, and handles concatenated JSON
    expect(extractJsonFromText('Done!\n[\n  {"id": 1},\n  {"id": 2}\n]')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(extractJsonFromText('{"ok":false}\n{"ok":true}\n')).toEqual({ ok: true });
    expect(extractJsonFromText('{"ok":false}{"ok":true}')).toEqual({ ok: true });
    expect(extractJsonFromText('{\n  "ok": false\n}\n{\n  "ok": true\n}')).toEqual({ ok: true });
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
});

describe("agy-run CLI with fake official agy headless binary", () => {
  test("never clones OAuth tokens or sets AGY_ACP_FORCE_FILE_STORAGE / GEMINI_HOME; invokes official stream-json CLI in empty cwd for --no-tools", () => {
    const home = createTestHome();
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const { bin, logFile } = createFakeAgyCli({
      structuredOutput: { ok: true },
      reply: '{"ok":true}',
    });

    const run = spawnSync(
      process.execPath,
      [
        AGY_RUN,
        "--cwd", work,
        "--no-tools",
        "--model", "gemini-4-neon",
        "--effort", "low",
        "--json-schema", '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}',
        "--output-format", "stream-json",
      ],
      {
        input: "Check status",
        encoding: "utf8",
        env: { ...process.env, HOME: home, AGY_RUN_BIN: bin, SSH_CONNECTION: "1.2.3.4 1234 5.6.7.8 22" },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const events = run.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
    expect(events[2]).toMatchObject({ type: "result", subtype: "success", structured_output: { ok: true } });

    const log = JSON.parse(readFileSync(logFile, "utf8"));
    expect(log.cwd).not.toBe(work);
    expect(log.args).toContain("--input-format");
    expect(log.args).toContain("stream-json");
    expect(log.args).toContain("--output-format");
    expect(log.args).toContain("--disable-slash-commands");
    expect(log.args).not.toContain("acp");
    expect(log.args).not.toContain("--dangerously-skip-permissions");
    expect(log.env.AGY_ACP_FORCE_FILE_STORAGE).toBeNull();
    expect(log.env.GEMINI_HOME).toBeNull();
    expect(log.env.SSH_CONNECTION).toBeNull();
    expect(log.env.AGENT_BOARD_HOOKS).toBe("off");
    expect(log.env.AGY_RUN_ACTIVE).toBe("1");
    expect(log.policyExists).toBe(true);
    expect(log.cliSettings.toolPermission).toBe("strict");
    expect(log.cliSettings.permissions.deny).toContain("command(*)");
    expect(log.cliSettings.permissions.deny).toContain("read_file(*)");
    expect(log.schema).toEqual({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
    expect(log.stdinMessages).toHaveLength(1);
    expect(log.stdinMessages[0].event).toBe("user");
  });

  test("restricted proposer mode denies ~/.gemini/antigravity-cli OAuth token, SSH reads, and shell via AGY_RUN_POLICY_FILE", () => {
    const home = createTestHome();
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    const allowedFile = join(work, "CLAUDE.md");
    const sshKey = join(home, ".ssh", "id_rsa");
    const nativeToken = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    writeFileSync(allowedFile, "ok");
    writeFileSync(sshKey, "secret");
    writeFileSync(nativeToken, "live-token");

    const { bin, logFile } = createFakeAgyCli({
      hookChecks: [
        { cwd: work, toolCall: { name: "view_file", args: { AbsolutePath: allowedFile } } },
        { cwd: work, toolCall: { name: "view_file", args: { AbsolutePath: sshKey } } },
        { cwd: work, toolCall: { name: "view_file", args: { AbsolutePath: nativeToken } } },
        { cwd: work, toolCall: { name: "run_command", args: { CommandLine: "ls" } } },
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
        env: { ...process.env, HOME: home, AGY_RUN_BIN: bin },
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
    expect(log.args).toContain("--mode");
    expect(log.args).toContain("accept-edits");
    expect(log.cliSettings.permissions.deny).toContain("command(*)");
    expect(log.cliSettings.permissions.deny).toContain("mcp(*)");
    expect(log.hookResults.map((r) => ({ tool: r.tool, path: r.path, decision: r.output?.decision }))).toEqual([
      { tool: "view_file", path: allowedFile, decision: "allow" },
      { tool: "view_file", path: sshKey, decision: "deny" },
      { tool: "view_file", path: nativeToken, decision: "deny" },
      { tool: "run_command", path: null, decision: "deny" },
    ]);
  });

  test("fails closed before spawning when ~/.gemini/config/hooks.json is missing or shadowed by workspace .agents/hooks.json", () => {
    const emptyHome = join(scratch, "no-hooks-home");
    const work = join(scratch, "work");
    mkdirSync(emptyHome, { recursive: true });
    mkdirSync(work, { recursive: true });
    const { bin } = createFakeAgyCli({ reply: "ok" });

    const missing = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", work, "--no-tools", "--output-format", "stream-json"],
      { input: "hi", encoding: "utf8", env: { ...process.env, HOME: emptyHome, AGY_RUN_BIN: bin } },
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("hooks.json");

    const goodHome = createTestHome("good-home");
    mkdirSync(join(work, ".agents"), { recursive: true });
    writeFileSync(join(work, ".agents", "hooks.json"), JSON.stringify({ "agy-run-policy": { enabled: false } }));
    const shadowed = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", work, "--no-tools", "--output-format", "stream-json"],
      { input: "hi", encoding: "utf8", env: { ...process.env, HOME: goodHome, AGY_RUN_BIN: bin } },
    );
    expect(shadowed.status).toBe(1);
    expect(shadowed.stderr).toContain("overrides");
  });

  test("unrestricted --full-access passes --dangerously-skip-permissions and emits full exposed tools", () => {
    const home = createTestHome();
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const { bin, logFile } = createFakeAgyCli({ reply: "hi" });
    const run = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", work, "--full-access", "--output-format", "stream-json"],
      {
        input: "hello",
        encoding: "utf8",
        env: { ...process.env, HOME: home, AGY_RUN_BIN: bin },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const init = JSON.parse(run.stdout.trim().split("\n")[0]);
    expect(init.tools).toEqual(UNRESTRICTED_CLAUDE_TOOLS);
    expect(init.tools).toContain("Bash");

    const log = JSON.parse(readFileSync(logFile, "utf8"));
    expect(log.args).toContain("--dangerously-skip-permissions");
    expect(log.env.AGY_RUN_POLICY_FILE).toBeNull();
  });

  test("fails closed on disallowed tools, denied path reads in restricted mode, and non-DONE tool attempts in --no-tools mode", () => {
    const home = createTestHome();
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(home, ".ssh"), { recursive: true });
    const sshKey = join(home, ".ssh", "id_rsa");
    writeFileSync(sshKey, "secret");

    // 1. Disallowed tool DONE in restricted mode
    const { bin: bin1 } = createFakeAgyCli({
      steps: [{ step_index: 1, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "ls" } } }],
      reply: "done",
    });
    const run1 = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", work, "--permission-mode", "acceptEdits", "--tools", "Read,Edit,Write", "--output-format", "stream-json"],
      { input: "hi", encoding: "utf8", env: { ...process.env, HOME: home, AGY_RUN_BIN: bin1 } },
    );
    expect(run1.status).toBe(1);
    expect(run1.stderr).toContain("Disallowed tool completed in restricted mode: run_command");

    // 2. Allowed tool reading denied path in restricted mode (defense-in-depth post-hoc check)
    const { bin: bin2 } = createFakeAgyCli({
      steps: [{ step_index: 1, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: sshKey } } }],
      reply: "done",
    });
    const run2 = spawnSync(
      process.execPath,
      [
        AGY_RUN, "--cwd", work, "--permission-mode", "acceptEdits", "--tools", "Read,Edit,Write",
        "--settings", JSON.stringify({ permissions: { deny: ["Read(~/.ssh/**)"] } }),
        "--output-format", "stream-json",
      ],
      { input: "hi", encoding: "utf8", env: { ...process.env, HOME: home, AGY_RUN_BIN: bin2 } },
    );
    expect(run2.status).toBe(1);
    expect(run2.stderr).toContain("Read denied by policy");

    // 3. Non-DONE tool attempt (FAILED/ACTIVE) in --no-tools mode
    const { bin: bin3 } = createFakeAgyCli({
      steps: [{ step_index: 1, state: "FAILED", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "id" } } }],
      reply: "done",
    });
    const run3 = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", work, "--no-tools", "--output-format", "stream-json"],
      { input: "hi", encoding: "utf8", env: { ...process.env, HOME: home, AGY_RUN_BIN: bin3 } },
    );
    expect(run3.status).toBe(1);
    expect(run3.stderr).toContain("Model attempted a tool call in --no-tools mode");
  });

  test("supports base64 image attachments in --no-tools mode with empty cwd and no caller --add-dir forwarding", () => {
    const home = createTestHome();
    const work = join(scratch, "work");
    const extra = join(scratch, "extra");
    mkdirSync(work, { recursive: true });
    mkdirSync(extra, { recursive: true });
    const { bin, logFile } = createFakeAgyCli({
      checkAttachmentExists: true,
      structuredOutput: { score: 9 },
      reply: '{"score":9}',
    });
    const blocks = [
      { type: "text", text: "Score this UI screenshot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("fake-png").toString("base64") } },
    ];
    const run = spawnSync(
      process.execPath,
      [
        AGY_RUN,
        "--cwd", work,
        "--add-dir", extra,
        "--no-tools",
        "--content-json", "-",
        "--json-schema", '{"type":"object","properties":{"score":{"type":"number"}}}',
        "--output-format", "stream-json",
      ],
      {
        input: JSON.stringify(blocks),
        encoding: "utf8",
        env: { ...process.env, HOME: home, AGY_RUN_BIN: bin },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const log = JSON.parse(readFileSync(logFile, "utf8"));
    expect(log.cwd).not.toBe(work);
    expect(log.attachmentExists).toBe(true);
    expect(log.args).toContain("--add-dir");
    expect(log.args).not.toContain(extra);
    expect(log.cliSettings.permissions.allow?.some((r) => r.startsWith("read_file("))).toBe(true);
    expect(log.cliSettings.permissions.deny).toContain("write_file(*)");
    expect(log.cliSettings.permissions.deny).toContain("command(*)");
    expect(existsSync(log.attachmentPath)).toBe(false);
  });

  test("tailors --no-tools and restricted preambles for --json-schema (finish tool) with and without attachments", () => {
    const home = createTestHome();
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const schemaJson = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}';
    const imageBlocks = [
      { type: "text", text: "Inspect this screenshot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("fake-png").toString("base64") } },
    ];

    // 1. --no-tools without --json-schema (no attachments): forbids all tools and does not mention finish
    {
      const { bin, logFile } = createFakeAgyCli({ reply: "plain reply" });
      const run = spawnSync(
        process.execPath,
        [AGY_RUN, "--cwd", work, "--no-tools", "--output-format", "stream-json"],
        { input: "Summarize", encoding: "utf8", env: { ...process.env, HOME: home, AGY_RUN_BIN: bin } },
      );
      expect(run.status, run.stderr).toBe(0);
      const prompt = JSON.parse(readFileSync(logFile, "utf8")).stdinMessages[0].message.content;
      expect(prompt).toContain("Use only the input below. Do not use any tools, read or write files, run commands, or ask questions.");
      expect(prompt).not.toContain("finish tool");
    }

    // 2. --no-tools with --json-schema (no attachments): instructs calling finish on first response and no other tools
    {
      const { bin, logFile } = createFakeAgyCli({
        steps: [{ step_index: 1, state: "DONE", step_type: "tool", tool_name: "finish", tool_info: { name: "finish", parameters: { ok: true } } }],
        structuredOutput: { ok: true },
        reply: '{"ok":true}',
      });
      const run = spawnSync(
        process.execPath,
        [AGY_RUN, "--cwd", work, "--no-tools", "--json-schema", schemaJson, "--output-format", "stream-json"],
        { input: "Check status", encoding: "utf8", env: { ...process.env, HOME: home, AGY_RUN_BIN: bin } },
      );
      expect(run.status, run.stderr).toBe(0);
      const prompt = JSON.parse(readFileSync(logFile, "utf8")).stdinMessages[0].message.content;
      expect(prompt).toContain("Submit your JSON answer immediately on your first response by calling the finish tool; do not use any other tools");
      expect(prompt).toContain("Submit ONLY valid JSON matching this JSON Schema by calling the finish tool");
      expect(prompt).not.toContain("Do not use any tools");
    }

    // 3. --no-tools without --json-schema with image attachment: allows only view_file on attachments, does not mention finish
    {
      const { bin, logFile } = createFakeAgyCli({ reply: "looks good" });
      const run = spawnSync(
        process.execPath,
        [AGY_RUN, "--cwd", work, "--no-tools", "--content-json", "-", "--output-format", "stream-json"],
        { input: JSON.stringify(imageBlocks), encoding: "utf8", env: { ...process.env, HOME: home, AGY_RUN_BIN: bin } },
      );
      expect(run.status, run.stderr).toBe(0);
      const prompt = JSON.parse(readFileSync(logFile, "utf8")).stdinMessages[0].message.content;
      expect(prompt).toContain("You may call view_file ONLY on those attached image files; do not use any other tools");
      expect(prompt).not.toContain("finish tool");
    }

    // 4. --no-tools with --json-schema and image attachment: allows view_file on attachments and requires finish for final JSON
    {
      const { bin, logFile } = createFakeAgyCli({
        steps: [{ step_index: 2, state: "DONE", step_type: "tool", tool_name: "finish", tool_info: { name: "finish", parameters: { ok: true } } }],
        structuredOutput: { ok: true },
        reply: '{"ok":true}',
      });
      const run = spawnSync(
        process.execPath,
        [AGY_RUN, "--cwd", work, "--no-tools", "--content-json", "-", "--json-schema", schemaJson, "--output-format", "stream-json"],
        { input: JSON.stringify(imageBlocks), encoding: "utf8", env: { ...process.env, HOME: home, AGY_RUN_BIN: bin } },
      );
      expect(run.status, run.stderr).toBe(0);
      const prompt = JSON.parse(readFileSync(logFile, "utf8")).stdinMessages[0].message.content;
      expect(prompt).toContain("You may call view_file ONLY on those attached image files, and you MUST submit your final JSON answer by calling the finish tool; do not use any other tools");
      expect(prompt).toContain("Submit ONLY valid JSON matching this JSON Schema by calling the finish tool");
    }

    // 5. Restricted session with and without --json-schema: includes finish in permitted list only when schema is active
    {
      const { bin, logFile } = createFakeAgyCli({ structuredOutput: { ok: true }, reply: '{"ok":true}' });
      const withSchema = spawnSync(
        process.execPath,
        [AGY_RUN, "--cwd", work, "--permission-mode", "acceptEdits", "--tools", "Read", "--json-schema", schemaJson, "--output-format", "stream-json"],
        { input: "Check", encoding: "utf8", env: { ...process.env, HOME: home, AGY_RUN_BIN: bin } },
      );
      expect(withSchema.status, withSchema.stderr).toBe(0);
      const promptWith = JSON.parse(readFileSync(logFile, "utf8")).stdinMessages[0].message.content;
      expect(promptWith).toMatch(/Restricted session: only these tools are permitted: [^\n]*finish\./);

      const withoutSchema = spawnSync(
        process.execPath,
        [AGY_RUN, "--cwd", work, "--permission-mode", "acceptEdits", "--tools", "Read", "--output-format", "stream-json"],
        { input: "Check", encoding: "utf8", env: { ...process.env, HOME: home, AGY_RUN_BIN: bin } },
      );
      expect(withoutSchema.status, withoutSchema.stderr).toBe(0);
      const promptWithout = JSON.parse(readFileSync(logFile, "utf8")).stdinMessages[0].message.content;
      expect(promptWithout).not.toContain("finish");
    }
  });

  test("fails closed on invalid --timeout, missing terminal result event, or non-zero exit after result", () => {
    const home = createTestHome();
    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });

    const { bin: binOk } = createFakeAgyCli({ reply: "ok" });
    const badTimeout = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", work, "--full-access", "--timeout", "abc"],
      { input: "hi", encoding: "utf8", env: { ...process.env, HOME: home, AGY_RUN_BIN: binOk } },
    );
    expect(badTimeout.status).toBe(1);
    expect(badTimeout.stderr).toContain("Invalid timeoutMs");

    const { bin: binNoResult } = createFakeAgyCli({ omitResult: true, exitCode: 0 });
    const noRes = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", work, "--full-access"],
      { input: "hi", encoding: "utf8", env: { ...process.env, HOME: home, AGY_RUN_BIN: binNoResult } },
    );
    expect(noRes.status).toBe(1);
    expect(noRes.stderr).toContain("without emitting a terminal result");

    const { bin: binCrashAfter } = createFakeAgyCli({ reply: "ok", exitCode: 2 });
    const crashAfter = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", work, "--full-access"],
      { input: "hi", encoding: "utf8", env: { ...process.env, HOME: home, AGY_RUN_BIN: binCrashAfter } },
    );
    expect(crashAfter.status).toBe(1);
    expect(crashAfter.stderr).toContain("exited abnormally");
  });

  test("fails closed before spawning agy on unsupported settings (e.g. sandbox)", () => {
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

  test("fails closed before spawning agy on --agent (4x custom-agent billing guardrail #1890)", async () => {
    const run = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", scratch, "--agent", "custom-role", "--output-format", "stream-json"],
      {
        input: "hi",
        encoding: "utf8",
        env: { ...process.env, AGY_RUN_BIN: join(scratch, "nonexistent-binary") },
      },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--agent");
    expect(run.stderr).toContain("4x");
    expect(run.stderr).toContain("#1890");

    await expect(
      runAgyPrompt({
        prompt: "hi",
        agent: "custom-role",
        cwd: scratch,
        env: { ...process.env, AGY_RUN_BIN: join(scratch, "nonexistent-binary") },
      }),
    ).rejects.toThrow(/refuses --agent "custom-role".*4x.*#1890/);

    const bare = spawnSync(
      process.execPath,
      [AGY_RUN, "--cwd", scratch, "--agent"],
      {
        input: "hi",
        encoding: "utf8",
        env: { ...process.env, AGY_RUN_BIN: join(scratch, "nonexistent-binary") },
      },
    );
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain("refuses --agent:");
    expect(bare.stderr).not.toContain('"true"');
  });

  test("source code contains zero references to T3 OAuth token cloning", () => {
    const src = readFileSync(AGY_RUN, "utf8");
    expect(src).not.toContain("antigravity-oauth-token");
    expect(src).not.toContain("acp_token.json");
    expect(src).not.toContain("AGY_ACP_FORCE_FILE_STORAGE");
    expect(src).not.toContain("resolveT3ProfileDir");
    expect(src).not.toContain("prepareIsolatedProfile");
  });
});
