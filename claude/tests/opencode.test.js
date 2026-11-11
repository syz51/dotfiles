// Offline checks of the opencode port in opencode/: its config, its agents (kept in step
// with claude/agents) and the claude-hooks plugin, which runs the Claude Code hooks for
// opencode sessions. The plugin tests drive it with a fake opencode plugin context.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeToolInput,
  claudeToolName,
  hookEnv,
  matches,
  memoryDir,
  readResult,
  runHooks,
  stopFailureType,
} from "../../opencode/plugins/claude-hooks/hooks.ts";

const REPO = join(import.meta.dir, "..", "..");
const read = (path) => readFileSync(join(REPO, path), "utf8");

function tracked(path) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: REPO, encoding: "utf8" });
  if (result.error) throw result.error;
  return result.status === 0;
}

function frontmatter(path) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(path));
  if (!match) throw new Error(`${path} has no frontmatter`);
  return { meta: Bun.YAML.parse(match[1]), body: match[2] };
}

// The user chose GPT models for opencode: Opus maps to Sol at xhigh, Haiku to Luna at max.
const OPENCODE_MODEL = { opus: "opencode/gpt-6.1-sol#xhigh", haiku: "opencode/gpt-6-luna#max" };

describe("opencode config", () => {
  const config = JSON.parse(read("opencode/opencode.json"));

  test("the port's files are tracked and the rest of opencode/ stays ignored", () => {
    for (const path of ["opencode/opencode.json", "opencode/AGENTS.md", "opencode/plugins/claude-hooks/index.ts", "opencode/plugins/claude-hooks/hooks.ts"]) {
      expect(tracked(path)).toBe(true);
    }
    const ignored = spawnSync("git", ["check-ignore", "-q", "opencode/service.json"], { cwd: REPO });
    expect(ignored.status).toBe(0);
  });

  test("loads the Claude Code instructions and runs GPT-6.1 Sol at xhigh", () => {
    expect(config.instructions).toEqual(["{env:HOME}/.claude/CLAUDE.md"]);
    expect(config.model).toBe("opencode/gpt-6.1-sol");
    expect(config.providers.opencode.models["gpt-6.1-sol"].settings.reasoningEffort).toBe("xhigh");
  });

  test("tells the model which models the Claude-only rule means here", () => {
    const notes = read("opencode/AGENTS.md");
    for (const model of Object.values(OPENCODE_MODEL)) expect(notes).toContain(model);
  });

  test("runs the board MCP server without a leaked parent identity", () => {
    const board = config.mcp.servers.board;
    expect(board.codemode).toBe(false);
    expect(board.command).toEqual(["/usr/bin/env", "-u", "T3CODE_THREAD_ID", "-u", "CLAUDE_CODE_SESSION_ID", "-u", "OPENCODE_SESSION_ID", "{env:HOME}/.cargo/bin/board", "mcp"]);
  });

  test("runs the computer-use server from the dotfiles marketplace", () => {
    const desktop = config.mcp.servers.desktop;
    const plugin = JSON.parse(read("claude/marketplace/computer-use/.mcp.json")).mcpServers.desktop;
    expect(plugin.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/server/desktop.js"]);
    expect(desktop.command).toEqual(["{env:HOME}/.bun/bin/bun", "{env:HOME}/.config/claude/marketplace/computer-use/server/desktop.js"]);
  });
});

describe("opencode agents", () => {
  const agents = readdirSync(join(REPO, "claude/agents")).filter((name) => name.endsWith(".md"));

  test("mirror the Claude Code agents", () => {
    expect(readdirSync(join(REPO, "opencode/agents")).sort()).toEqual(agents.sort());
  });

  for (const name of agents) {
    test(`${name} keeps the Claude agent's description and prompt, on its GPT model`, () => {
      const claude = frontmatter(`claude/agents/${name}`);
      const opencode = frontmatter(`opencode/agents/${name}`);
      expect(tracked(`opencode/agents/${name}`)).toBe(true);
      expect(opencode.meta.description).toBe(claude.meta.description);
      expect(opencode.body).toBe(claude.body);
      expect(opencode.meta.mode).toBe("subagent");
      expect(opencode.meta.model).toBe(OPENCODE_MODEL[claude.meta.model]);
      const denied = opencode.meta.permissions.filter((rule) => rule.effect === "deny").map((rule) => rule.action);
      expect(denied).toContain("subagent");
      if (claude.meta.disallowedTools.includes("Edit")) expect(denied).toEqual(expect.arrayContaining(["edit", "write", "patch"]));
      else expect(denied).not.toContain("edit");
    });
  }
});

describe("claude-hooks translation", () => {
  test("maps opencode tool names to Claude's", () => {
    expect(claudeToolName("shell")).toBe("Bash");
    expect(claudeToolName("subagent")).toBe("Agent");
    expect(claudeToolName("opencode_worktree_create")).toBe("EnterWorktree");
    expect(claudeToolName("board_ask_user")).toBe("mcp__board__ask_user");
    expect(claudeToolName("desktop_screenshot")).toBe("mcp__desktop__screenshot");
  });

  test("maps tool inputs to Claude's field names", () => {
    expect(claudeToolInput("shell", { command: "ls", workdir: "/x", background: true })).toEqual({ command: "ls", timeout: undefined, run_in_background: true });
    expect(claudeToolInput("edit", { path: "/a", oldString: "x", newString: "y" })).toMatchObject({ file_path: "/a", old_string: "x", new_string: "y" });
    expect(claudeToolInput("subagent", { agent: "worker", prompt: "p" })).toMatchObject({ subagent_type: "worker", prompt: "p" });
    expect(claudeToolInput("board_task_show", { id: "t-1" })).toEqual({ id: "t-1" });
    const patch = "*** Begin Patch\n*** Add File: a\n+x\n*** Delete File: b\n*** Update File: c\n*** Move to: d\n*** End Patch";
    expect(claudeToolName("patch")).toBe("apply_patch");
    expect(claudeToolInput("patch", { patchText: patch })).toEqual({ command: patch });
  });

  test("follows Claude's matcher rules", () => {
    expect(matches(undefined, "Bash")).toBe(true);
    expect(matches("*", "Bash")).toBe(true);
    expect(matches("Bash", "Bash")).toBe(true);
    expect(matches("Bash", "BashOutput")).toBe(false);
    expect(matches("startup|compact", "compact")).toBe(true);
    expect(matches("^Bash$", "Bash")).toBe(true);
    expect(matches("^(EnterWorktree|Agent|Task)$", "Agent")).toBe(true);
    expect(matches("^mcp__board__ask_user$", "mcp__board__task_show")).toBe(false);
    expect(matches("startup", undefined)).toBe(true);
  });

  test("hook env drops leaked T3, Claude Code and opencode ids and names this session for the board's opencode runtime", () => {
    const leaked = {
      PATH: "/bin",
      T3CODE_THREAD_ID: "t3:x",
      CLAUDE_CODE_SESSION_ID: "c",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      OPENCODE_SESSION_ID: "parent",
      BOARD_HOOK_RUNTIME: "codex",
    };
    const env = hookEnv(leaked, "ses_1", "/p");
    expect(env).toEqual({ PATH: "/bin", OPENCODE_SESSION_ID: "ses_1", BOARD_HOOK_RUNTIME: "opencode", CLAUDE_PROJECT_DIR: "/p" });
  });

  test("names StopFailure types and memory directories as Claude does", () => {
    expect(stopFailureType({ status: 429 })).toBe("rate_limit");
    expect(stopFailureType({ status: 503 })).toBe("server_error");
    expect(stopFailureType({ type: "unknown" })).toBe("unknown");
    expect(memoryDir("/h", "/Users/me/.config")).toBe("/h/.claude/projects/-Users-me--config/memory");
  });
});

describe("claude-hooks runner", () => {
  const base = { sessionID: "ses_1", cwd: tmpdir(), projectDir: tmpdir(), env: { PATH: process.env.PATH } };
  const hook = (command) => ({ type: "command", command });

  test("exit 2 and a deny decision refuse the call with the hook's reason", async () => {
    const hooks = {
      PreToolUse: [
        { matcher: "^Bash$", hooks: [hook("echo 'no npm' >&2; exit 2")] },
        { matcher: "Bash", hooks: [hook(`echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"denied"}}'`)] },
        { matcher: "Edit", hooks: [hook("exit 2")] },
      ],
    };
    const outcome = await runHooks({ ...base, hooks, event: "PreToolUse", target: "Bash", payload: {} });
    expect(outcome.block?.split("\n").sort()).toEqual(["denied", "no npm"]);
  });

  test("collects additionalContext, and plain stdout only where Claude does", async () => {
    const hooks = {
      SessionStart: [{ matcher: "startup", hooks: [hook("echo plain"), hook(`echo '{"hookSpecificOutput":{"additionalContext":"json"}}'`)] }],
      PostToolUse: [{ matcher: "*", hooks: [hook("echo ignored"), hook(`echo '{"decision":"block","reason":"look"}'`)] }],
    };
    const start = await runHooks({ ...base, hooks, event: "SessionStart", target: "startup", payload: {} });
    expect(start.context.sort()).toEqual(["json", "plain"]);
    const post = await runHooks({ ...base, hooks, event: "PostToolUse", target: "Read", payload: {} });
    expect(post).toEqual({ context: ["look"] });
    const other = await runHooks({ ...base, hooks, event: "SessionStart", target: "resume", payload: {} });
    expect(other).toEqual({ context: [] });
  });

  test("passes Claude-shaped stdin and runs identical commands once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hooks-"));
    const log = join(dir, "log");
    const command = `cat >> '${log}'; echo >> '${log}'`;
    const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [hook(command)] }, { matcher: "*", hooks: [hook(command)] }] };
    await runHooks({ ...base, hooks, event: "PreToolUse", target: "Bash", payload: { tool_name: "Bash", tool_input: { command: "ls" } } });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ session_id: "ses_1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    rmSync(dir, { recursive: true });
  });

  test("a failing or timed-out hook does not refuse the call", async () => {
    const hooks = { PreToolUse: [{ hooks: [hook("exit 1"), { type: "command", command: "sleep 5", timeout: 0.2 }] }] };
    expect(await runHooks({ ...base, hooks, event: "PreToolUse", target: "Bash", payload: {} })).toEqual({ context: [] });
  });

  test("critical guard failures fail closed, while optional hooks remain non-blocking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-guard-"));
    try {
      const script = join(dir, "guard-broken.js");
      writeFileSync(script, "process.exit(1)\n");
      const outcome = await runHooks({ ...base, hooks: { PreToolUse: [{ hooks: [hook(`'${process.execPath}' '${script}'`)] }] }, event: "PreToolUse", payload: {} });
      expect(outcome.block).toContain("hook failed");
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("timeouts terminate descendants instead of waiting for inherited output pipes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-timeout-"));
    const pidPath = join(dir, "child.pid");
    try {
      const started = performance.now();
      const outcome = await runHooks({ ...base, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `sleep 3 & echo $! > '${pidPath}'; wait`, timeout: 0.1 }] }] }, event: "PreToolUse", payload: {} });
      expect(outcome).toEqual({ context: [] });
      expect(performance.now() - started).toBeLessThan(1800);
      const pid = readFileSync(pidPath, "utf8").trim();
      const state = spawnSync("ps", ["-p", pid, "-o", "stat="], { encoding: "utf8" }).stdout.trim();
      expect(state === "" || state.startsWith("Z")).toBe(true);
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("cancellation bounds a hook and kills its process group", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75);
    const started = performance.now();
    try {
      await runHooks({ ...base, signal: controller.signal, hooks: { PreToolUse: [{ hooks: [hook("sleep 3 & wait")] }] }, event: "PreToolUse", payload: {} });
      expect(performance.now() - started).toBeLessThan(1800);
    } finally { clearTimeout(timer); }
  });

  test("preserves plain compaction guidance, approval requests and board halt decisions", () => {
    const context = { context: [] };
    readResult("PreCompact", { code: 0, stdout: "preserve agent and task IDs", stderr: "" }, "board", context);
    expect(context.context).toEqual(["preserve agent and task IDs"]);
    const ask = { context: [] };
    readResult("PreToolUse", { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "confirm" } }), stderr: "" }, "guard", ask);
    expect(ask.ask).toBe("confirm");
    const halt = { context: [] };
    readResult("UserPromptSubmit", { code: 0, stdout: JSON.stringify({ continue: false, stopReason: "board is paused" }), stderr: "" }, "board", halt);
    expect(halt.halt).toBe("board is paused");
  });
});

// Drives index.ts through a fake opencode plugin context. HOME points at a temporary
// directory whose ~/.claude/settings.json holds hooks that log what they receive.
describe("claude-hooks plugin", () => {
  let home;
  let project;
  let log;
  let plugin;
  const cleanups = [];
  const saved = {};

  const logger = (event, extra = "") =>
    `input=$(cat); printf '%s %s %s %s\\n' ${event} "$OPENCODE_SESSION_ID" "\${T3CODE_THREAD_ID:-none}" "$input" >> "$HOOK_LOG"; ${extra}`;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "claude-hooks-home-"));
    project = mkdtempSync(join(tmpdir(), "claude-hooks-project-"));
    log = join(home, "hooks.log");
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: logger("PreToolUse", `case "$input" in *npm*) echo 'no npm' >&2; exit 2;; esac`) }] }, { matcher: "^mcp__board__", hooks: [{ type: "command", command: logger("PreToolUse") }] }],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: logger("PostToolUse", `echo '{"hookSpecificOutput":{"additionalContext":"post ctx"}}'`) }] }],
        PostToolUseFailure: [{ hooks: [{ type: "command", command: logger("PostToolUseFailure", `echo '{"hookSpecificOutput":{"additionalContext":"failure ctx"}}'`) }] }],
        SessionStart: [{ matcher: "startup|resume|compact", hooks: [{ type: "command", command: logger("SessionStart", "echo start ctx") }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: logger("UserPromptSubmit", `echo '{"hookSpecificOutput":{"additionalContext":"prompt ctx"}}'`) }] }],
        PreCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: logger("PreCompact", "echo preserve-task-identity") }] }],
        Stop: [{ hooks: [{ type: "command", command: logger("Stop", `case "$input" in *'"stop_hook_active":false'*) echo '{"decision":"block","reason":"keep going"}';; esac`) }] }],
        StopFailure: [{ matcher: "rate_limit", hooks: [{ type: "command", command: logger("StopFailure") }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: logger("SessionEnd") }] }],
      },
    };
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
    const memory = memoryDir(home, project);
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "MEMORY.md"), "- [Fact](fact.md) — remembered\n");
    for (const key of ["HOME", "HOOK_LOG", "T3CODE_THREAD_ID"]) saved[key] = process.env[key];
    process.env.HOME = home;
    process.env.HOOK_LOG = log;
    process.env.T3CODE_THREAD_ID = "t3:leaked";
    plugin = (await import("../../opencode/plugins/claude-hooks/index.ts")).default;
  });

  afterAll(async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  async function start() {
    const hooks = {};
    const entries = [];
    const currentEntries = new Map();
    const synthetic = [];
    const queue = [];
    let wake = () => {};
    const sessions = { ses_root: {}, ses_child: { parentID: "ses_root" } };
    const ctx = {
      location: { directory: project },
      session: {
        get: async ({ sessionID }) => sessions[sessionID],
        hook: async (name, fn) => (hooks[`session.${name}`] = fn),
        instructions: { entry: {
          list: async ({ sessionID }) => [...currentEntries.values()].filter((entry) => entry.sessionID === sessionID),
          put: async (entry) => { currentEntries.set(`${entry.sessionID}:${entry.key}`, entry); entries.push(["put", entry]); },
          remove: async (entry) => { currentEntries.delete(`${entry.sessionID}:${entry.key}`); entries.push(["remove", entry]); },
        } },
        synthetic: async (message) => synthetic.push(message),
      },
      tool: { hook: async (name, fn) => (hooks[`tool.${name}`] = fn) },
      shell: { hook: async (name, fn) => (hooks[`shell.${name}`] = fn) },
      permission: {
        hook: async (name, fn) => (hooks[`permission.${name}`] = fn),
        assert: async (input) => { const event = { ...input, effect: "allow" }; await hooks["permission.evaluate"](event); return event; },
      },
      event: {
        subscribe: ({ signal }) =>
          (async function* () {
            while (!signal.aborted) {
              while (queue.length && !signal.aborted) yield queue.shift();
              if (signal.aborted) return;
              await new Promise((resolve) => {
                wake = () => { signal.removeEventListener("abort", wake); resolve(); };
                signal.addEventListener("abort", wake, { once: true });
              });
            }
          })(),
      },
    };
    const dispose = await plugin.setup(ctx);
    let cleaned = false;
    const cleanup = async () => { if (!cleaned) { cleaned = true; await dispose(); } };
    cleanups.push(cleanup);
    const emit = async (event) => {
      queue.push(event);
      wake();
      await Bun.sleep(300);
    };
    return { hooks, entries, synthetic, emit, cleanup, currentEntries, project };
  }

  const logged = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => {
        const [event, session, t3, ...rest] = line.split(" ");
        return { event, session, t3, input: JSON.parse(rest.join(" ")) };
      });
    } catch {
      return [];
    }
  };
  const reset = () => writeFileSync(log, "");

  async function withHookSettings(hooks, action) {
    const path = join(home, ".claude", "settings.json");
    const previous = readFileSync(path, "utf8");
    writeFileSync(path, JSON.stringify({ hooks }));
    try { await action(); }
    finally { writeFileSync(path, previous); }
  }

  test("a guard's refusal refuses the opencode tool call, in the root session's name", async () => {
    const { hooks } = await start();
    reset();
    await expect(hooks["tool.execute.before"]({ tool: "shell", sessionID: "ses_child", id: "c1", input: { command: "npm install x", workdir: "/" } })).rejects.toThrow("no npm");
    const [entry] = logged();
    expect(entry).toMatchObject({ event: "PreToolUse", session: "ses_root", t3: "none" });
    expect(entry.input).toMatchObject({ session_id: "ses_root", cwd: "/", tool_name: "Bash", tool_input: { command: "npm install x" } });
  });

  test("board MCP calls and shell commands carry the root session's board identity", async () => {
    const { hooks } = await start();
    reset();
    const input = { id: "dotfiles-1" };
    await hooks["tool.execute.before"]({ tool: "board_task_show", sessionID: "ses_child", id: "c2", input });
    expect(input.agent).toBe("opencode:ses_root");
    expect(logged()[0].input.tool_name).toBe("mcp__board__task_show");
    const explicit = { id: "dotfiles-1", agent: "opencode:other" };
    await expect(hooks["tool.execute.before"]({ tool: "board_task_show", sessionID: "ses_child", id: "c3", input: explicit })).rejects.toThrow("Board actor");

    const command = { command: "board status" };
    await hooks["tool.execute.before"]({ tool: "shell", sessionID: "ses_child", id: "c4", input: command });
    const shell = { command: command.command, env: {} };
    await hooks["shell.create.before"](shell);
    expect(shell.command).toStartWith("export OPENCODE_SESSION_ID='ses_root';\n");
    expect(shell.env.OPENCODE_SESSION_ID).toBeUndefined();
    expect(shell.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect("T3CODE_THREAD_ID" in shell.env && shell.env.T3CODE_THREAD_ID === undefined).toBe(true);
  });

  test("PostToolUse context reaches the tool result, and failure context the session", async () => {
    const { hooks, entries, currentEntries } = await start();
    reset();
    const result = { output: { output: "hi" }, content: [{ type: "text", text: "hi" }] };
    await hooks["tool.execute.after"]({ tool: "read", sessionID: "ses_root", id: "c5", input: { path: "/a" }, status: "completed", result });
    expect(result.content.at(-1)).toEqual({ type: "text", text: "post ctx" });
    expect(logged()[0].input).toMatchObject({ tool_name: "Read", tool_input: { file_path: "/a" } });
    await hooks["tool.execute.after"]({ tool: "shell", sessionID: "ses_root", id: "c6", input: { command: "false" }, status: "error", error: { message: "boom" } });
    expect(logged()[1]).toMatchObject({ event: "PostToolUseFailure", input: { error: "boom", tool_name: "Bash" } });
    expect(entries.at(-1)).toEqual(["put", { sessionID: "ses_root", key: "claude-hooks.tool-failure", value: "failure ctx" }]);
    await hooks["tool.execute.after"]({ tool: "read", sessionID: "ses_root", id: "c7", input: { path: "/a" }, status: "completed", result: { content: [] } });
    expect(currentEntries.has("ses_root:claude-hooks.tool-failure")).toBe(false);
  });

  test("identical concurrent commands execute with the correct per-invocation identity", async () => {
    const { hooks } = await start();
    const a = { command: 'printf "%s" "$OPENCODE_SESSION_ID"' };
    const b = { ...a };
    await Promise.all([
      hooks["tool.execute.before"]({ tool: "shell", sessionID: "ses_root", id: "same", input: a }),
      hooks["tool.execute.before"]({ tool: "shell", sessionID: "ses_other", id: "same", input: b }),
    ]);
    for (const [input, identity] of [[a, "ses_root"], [b, "ses_other"]]) {
      const shell = { command: input.command, env: { PATH: process.env.PATH } };
      await hooks["shell.create.before"](shell);
      const result = spawnSync("/bin/sh", ["-c", shell.command], { encoding: "utf8", env: shell.env });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(identity);
    }
  });

  test("post hooks keep the actual cwd and supported multi-file patch payload", async () => {
    const { hooks } = await start();
    reset();
    const input = { command: "true", workdir: tmpdir() };
    await hooks["tool.execute.before"]({ tool: "shell", sessionID: "ses_root", id: "cwd", input });
    await hooks["tool.execute.after"]({ tool: "shell", sessionID: "ses_root", id: "cwd", status: "completed", result: { content: [] } });
    expect(logged().at(-1).input).toMatchObject({ cwd: tmpdir(), tool_input: { command: "true" } });
    const patch = "*** Begin Patch\n*** Add File: a\n+x\n*** Delete File: b\n*** Update File: c\n*** Move to: d\n*** End Patch";
    await hooks["tool.execute.before"]({ tool: "patch", sessionID: "ses_root", id: "patch", input: { patchText: patch } });
    await hooks["tool.execute.after"]({ tool: "patch", sessionID: "ses_root", id: "patch", status: "completed", result: { content: [] } });
    expect(logged().at(-1).input).toMatchObject({ tool_name: "apply_patch", tool_input: { command: patch } });
  });

  test("approval hooks force a native ask even under an allow-all session", async () => {
    const { hooks } = await start();
    const evaluation = { action: "claude_hook_approval", effect: "allow", metadata: { reason: "confirm operation" } };
    await hooks["permission.evaluate"](evaluation);
    expect(evaluation).toMatchObject({ effect: "ask", message: "confirm operation" });
  });

  test("prompt blocking and board continue:false are not swallowed", async () => {
    const { hooks } = await start();
    await withHookSettings({ UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo '{"continue":false,"stopReason":"board paused"}'` }] }] }, async () => {
      await expect(hooks["session.prompt"]({ sessionID: "ses_root", prompt: { text: "hello" } })).rejects.toThrow("board paused");
    });
  });

  test("the first prompt starts the session with hook context and memory; later prompts do not", async () => {
    const { hooks, entries } = await start();
    reset();
    await hooks["session.prompt"]({ sessionID: "ses_root", prompt: { text: "hello" } });
    await hooks["session.prompt"]({ sessionID: "ses_root", prompt: { text: "again" } });
    await hooks["session.prompt"]({ sessionID: "ses_child", prompt: { text: "child" } });
    expect(logged().map((entry) => `${entry.event} ${entry.input.source ?? entry.input.prompt}`)).toEqual([
      "SessionStart startup",
      "UserPromptSubmit hello",
      "UserPromptSubmit again",
    ]);
    const startEntry = entries.find(([, entry]) => entry.key === "claude-hooks.session-start")[1];
    expect(startEntry.value).toStartWith("start ctx");
    expect(startEntry.value).toContain("- [Fact](fact.md) — remembered");
    expect(entries.find(([, entry]) => entry.sessionID === "ses_child" && entry.key === "claude-hooks.memory")[1].value).toContain("remembered");
    expect(entries.filter(([, entry]) => entry.key === "claude-hooks.prompt").map(([op, entry]) => [op, entry.value])).toEqual([
      ["put", "prompt ctx"],
      ["put", "prompt ctx"],
    ]);
  });

  test("concurrent startup runs once and child context gets memory without board lifecycle hooks", async () => {
    const { hooks } = await start();
    reset();
    await Promise.all(["a", "b"].map((text) => hooks["session.prompt"]({ sessionID: "ses_root", prompt: { text } })));
    expect(logged().filter((entry) => entry.event === "SessionStart")).toHaveLength(1);
    const child = { sessionID: "ses_child", system: [] };
    await hooks["session.context"](child);
    expect(child.system[0].text).toContain("remembered");
    expect(logged().some((entry) => entry.session === "ses_child")).toBe(false);
  });

  test("a Stop block continues the session once, then lets it stop", async () => {
    const { hooks, synthetic } = await start();
    reset();
    await hooks["session.experimental.idle"]({ sessionID: "ses_root", background: [] });
    await hooks["session.experimental.idle"]({ sessionID: "ses_root", background: [] });
    await hooks["session.experimental.idle"]({ sessionID: "ses_child", background: [] });
    expect(synthetic).toEqual([{ sessionID: "ses_root", text: "keep going" }]);
    expect(logged().map((entry) => entry.input.stop_hook_active)).toEqual([false, true]);
  });

  test("compaction runs PreCompact, then SessionStart compact on the next request", async () => {
    const { hooks } = await start();
    reset();
    await hooks["session.prompt"]({ sessionID: "ses_root", prompt: { text: "hello" } });
    reset();
    const compaction = { sessionID: "ses_root", system: [] };
    await hooks["session.compaction"](compaction);
    const request = { sessionID: "ses_root", system: [] };
    await hooks["session.context"](request);
    await hooks["session.context"]({ sessionID: "ses_root", system: [] });
    expect(logged().map((entry) => `${entry.event} ${entry.input.trigger ?? entry.input.source}`)).toEqual(["PreCompact undefined", "SessionStart compact"]);
    expect(compaction.system).toEqual([{ type: "text", text: "preserve-task-identity" }]);
    expect(request.system[0].text).toContain("start ctx");
  });

  test("failures and session ends run StopFailure and SessionEnd once", async () => {
    const { hooks, emit, cleanup } = await start();
    await hooks["session.prompt"]({ sessionID: "ses_root", prompt: { text: "hi" } });
    reset();
    await emit({ type: "session.execution.failed", data: { sessionID: "ses_root", error: { status: 429, message: "slow down" } } });
    await emit({ type: "session.deleted", data: { sessionID: "ses_root" } });
    await cleanup();
    expect(logged().map((entry) => `${entry.event} ${entry.input.error ?? entry.input.reason}`)).toEqual(["StopFailure rate_limit", "SessionEnd other"]);
  });

  test("archive ends a root once; later prompts resume it; unrelated events are ignored", async () => {
    const { hooks, emit, cleanup } = await start();
    await hooks["session.prompt"]({ sessionID: "ses_root", prompt: { text: "hello" } });
    reset();
    await emit({ type: "session.execution.failed", data: { sessionID: "unknown", error: { status: 429 } } });
    await emit({ type: "session.execution.failed", location: { directory: "/another-location" }, data: { sessionID: "ses_root", error: { status: 429 } } });
    expect(logged()).toEqual([]);
    await emit({ type: "session.archived", data: { sessionID: "ses_root" } });
    await emit({ type: "session.archived", data: { sessionID: "ses_root" } });
    expect(logged().filter((entry) => entry.event === "SessionEnd")).toHaveLength(1);
    await hooks["session.prompt"]({ sessionID: "ses_root", prompt: { text: "resume" } });
    expect(logged().some((entry) => entry.event === "SessionStart" && entry.input.source === "resume")).toBe(true);
    await cleanup();
    reset();
    await emit({ type: "session.execution.failed", data: { sessionID: "ses_root", error: { status: 429 } } });
    expect(logged()).toEqual([]);
  });

  test("a moved root belongs to its destination, not the old location's cleanup", async () => {
    const { hooks, emit, cleanup } = await start();
    await hooks["session.prompt"]({ sessionID: "ses_root", prompt: { text: "hello" } });
    reset();
    await emit({ type: "session.moved", location: { directory: "/destination" }, data: { sessionID: "ses_root", location: { directory: "/destination" } } });
    await cleanup();
    expect(logged()).toEqual([]);
  });
});
