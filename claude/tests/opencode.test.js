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

const ALLOWED_MODEL = /^opencode\/claude-(opus|haiku)-5-5(#[a-z]+)?$/;

describe("opencode config", () => {
  const config = JSON.parse(read("opencode/opencode.json"));

  test("the port's files are tracked and the rest of opencode/ stays ignored", () => {
    for (const path of ["opencode/opencode.json", "opencode/AGENTS.md", "opencode/plugins/claude-hooks/index.ts", "opencode/plugins/claude-hooks/hooks.ts"]) {
      expect(tracked(path)).toBe(true);
    }
    const ignored = spawnSync("git", ["check-ignore", "-q", "opencode/service.json"], { cwd: REPO });
    expect(ignored.status).toBe(0);
  });

  test("loads the Claude Code instructions and uses only Opus or Haiku", () => {
    expect(config.instructions).toEqual(["{env:HOME}/.claude/CLAUDE.md"]);
    expect(config.model).toMatch(ALLOWED_MODEL);
  });

  test("runs the board MCP server without a leaked parent identity", () => {
    const board = config.mcp.servers.board;
    expect(board.codemode).toBe(false);
    expect(board.command).toEqual(["/usr/bin/env", "-u", "T3CODE_THREAD_ID", "-u", "CLAUDE_CODE_SESSION_ID", "{env:HOME}/.cargo/bin/board", "mcp"]);
  });

  test("runs the computer-use server from the dotfiles marketplace", () => {
    const desktop = config.mcp.servers.desktop;
    const plugin = JSON.parse(read("claude/marketplace/computer-use/.mcp.json")).mcpServers.desktop;
    expect(plugin.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/server/desktop.js"]);
    expect(desktop.command).toEqual(["{env:HOME}/.bun/bin/bun", "{env:HOME}/.config/claude/marketplace/computer-use/server/desktop.js"]);
  });
});

describe("opencode agents", () => {
  const VARIANT = { haiku: "claude-haiku-5-5", opus: "claude-opus-5-5" };
  const agents = readdirSync(join(REPO, "claude/agents")).filter((name) => name.endsWith(".md"));

  test("mirror the Claude Code agents", () => {
    expect(readdirSync(join(REPO, "opencode/agents")).sort()).toEqual(agents.sort());
  });

  for (const name of agents) {
    test(`${name} keeps the Claude agent's description, prompt, model and effort`, () => {
      const claude = frontmatter(`claude/agents/${name}`);
      const opencode = frontmatter(`opencode/agents/${name}`);
      expect(tracked(`opencode/agents/${name}`)).toBe(true);
      expect(opencode.meta.description).toBe(claude.meta.description);
      expect(opencode.body).toBe(claude.body);
      expect(opencode.meta.mode).toBe("subagent");
      expect(opencode.meta.model).toBe(`opencode/${VARIANT[claude.meta.model]}#${claude.meta.effort}`);
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

  test("hook env drops leaked T3 and Claude Code ids and names this session", () => {
    const env = hookEnv({ PATH: "/bin", T3CODE_THREAD_ID: "t3:x", CLAUDE_CODE_SESSION_ID: "c", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" }, "ses_1", "/p");
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_SESSION_ID: "ses_1", CLAUDE_PROJECT_DIR: "/p" });
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
});

// Drives index.ts through a fake opencode plugin context. HOME points at a temporary
// directory whose ~/.claude/settings.json holds hooks that log what they receive.
describe("claude-hooks plugin", () => {
  let home;
  let project;
  let log;
  let plugin;
  const saved = {};

  const logger = (event, extra = "") =>
    `input=$(cat); printf '%s %s %s %s\\n' ${event} "$CLAUDE_CODE_SESSION_ID" "\${T3CODE_THREAD_ID:-none}" "$input" >> "$HOOK_LOG"; ${extra}`;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "claude-hooks-home-"));
    project = mkdtempSync(join(tmpdir(), "claude-hooks-project-"));
    log = join(home, "hooks.log");
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: logger("PreToolUse", `case "$input" in *npm*) echo 'no npm' >&2; exit 2;; esac`) }] }, { matcher: "^mcp__board__", hooks: [{ type: "command", command: logger("PreToolUse") }] }],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: logger("PostToolUse", `echo '{"hookSpecificOutput":{"additionalContext":"post ctx"}}'`) }] }],
        PostToolUseFailure: [{ hooks: [{ type: "command", command: logger("PostToolUseFailure", `echo '{"hookSpecificOutput":{"additionalContext":"failure ctx"}}'`) }] }],
        SessionStart: [{ matcher: "startup|compact", hooks: [{ type: "command", command: logger("SessionStart", "echo start ctx") }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: logger("UserPromptSubmit", `echo '{"hookSpecificOutput":{"additionalContext":"prompt ctx"}}'`) }] }],
        PreCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: logger("PreCompact") }] }],
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

  afterAll(() => {
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
    const synthetic = [];
    const queue = [];
    let wake = () => {};
    const sessions = { ses_root: {}, ses_child: { parentID: "ses_root" } };
    const ctx = {
      location: { directory: project },
      session: {
        get: async ({ sessionID }) => sessions[sessionID],
        hook: async (name, fn) => (hooks[`session.${name}`] = fn),
        instructions: { entry: { put: async (entry) => entries.push(["put", entry]), remove: async (entry) => entries.push(["remove", entry]) } },
        synthetic: async (message) => synthetic.push(message),
      },
      tool: { hook: async (name, fn) => (hooks[`tool.${name}`] = fn) },
      shell: { hook: async (name, fn) => (hooks[`shell.${name}`] = fn) },
      event: {
        subscribe: () =>
          (async function* () {
            for (;;) {
              while (queue.length) yield queue.shift();
              await new Promise((resolve) => (wake = resolve));
            }
          })(),
      },
    };
    const cleanup = await plugin.setup(ctx);
    const emit = async (event) => {
      queue.push(event);
      wake();
      await Bun.sleep(300);
    };
    return { hooks, entries, synthetic, emit, cleanup };
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
    expect(input.agent).toBe("claude:ses_root");
    expect(logged()[0].input.tool_name).toBe("mcp__board__task_show");
    const explicit = { id: "dotfiles-1", agent: "claude:other" };
    await hooks["tool.execute.before"]({ tool: "board_task_show", sessionID: "ses_child", id: "c3", input: explicit });
    expect(explicit.agent).toBe("claude:other");

    await hooks["tool.execute.before"]({ tool: "shell", sessionID: "ses_child", id: "c4", input: { command: "board status" } });
    const shell = { command: "board status", env: {} };
    await hooks["shell.create.before"](shell);
    expect(shell.env.CLAUDE_CODE_SESSION_ID).toBe("ses_root");
    expect("T3CODE_THREAD_ID" in shell.env && shell.env.T3CODE_THREAD_ID === undefined).toBe(true);
  });

  test("PostToolUse context reaches the tool result, and failure context the session", async () => {
    const { hooks, entries } = await start();
    reset();
    const result = { output: { output: "hi" }, content: [{ type: "text", text: "hi" }] };
    await hooks["tool.execute.after"]({ tool: "read", sessionID: "ses_root", id: "c5", input: { path: "/a" }, status: "completed", result });
    expect(result.content.at(-1)).toEqual({ type: "text", text: "post ctx" });
    expect(logged()[0].input).toMatchObject({ tool_name: "Read", tool_input: { file_path: "/a" } });
    await hooks["tool.execute.after"]({ tool: "shell", sessionID: "ses_root", id: "c6", input: { command: "false" }, status: "error", error: { message: "boom" } });
    expect(logged()[1]).toMatchObject({ event: "PostToolUseFailure", input: { error: "boom", tool_name: "Bash" } });
    expect(entries.at(-1)).toEqual(["put", { sessionID: "ses_root", key: "claude-hooks.tool-failure", value: "failure ctx" }]);
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
    expect(entries.filter(([, entry]) => entry.key === "claude-hooks.prompt").map(([op, entry]) => [op, entry.value])).toEqual([
      ["put", "prompt ctx"],
      ["put", "prompt ctx"],
    ]);
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
    await hooks["session.compaction"]({ sessionID: "ses_root" });
    await hooks["session.context"]({ sessionID: "ses_root" });
    await hooks["session.context"]({ sessionID: "ses_root" });
    expect(logged().map((entry) => `${entry.event} ${entry.input.trigger ?? entry.input.source}`)).toEqual(["PreCompact auto", "SessionStart compact"]);
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
});
