// Opt-in installed-runtime checks. No Console credentials or paid model requests:
// temporary HOME/XDG roots and a loopback-only canned OpenAI-compatible endpoint.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const read = (path) => readFileSync(join(REPO, path), "utf8");
const enabled = process.env.RUN_OPENCODE_RUNTIME === "1";
const allowAll = [{ action: "*", resource: "*", effect: "allow" }];

(enabled ? describe : describe.skip)("installed OpenCode role and context behavior (no paid generation)", () => {
  let dir, home, project, worktree, server, mock, base, env;
  const requests = [];
  const sessions = [];
  let logs = "";

  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: project, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr}`);
  };
  async function api(path, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa("opencode:fixture-server-password")}`, "x-opencode-directory": project },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const value = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value?.data ?? value;
  }
  async function create(agent = "build", extra = {}) {
    const session = await api("/api/session", { agent, location: { directory: project }, ...extra });
    sessions.push(session.id);
    return session;
  }
  const permission = (session, action, resources = ["*"]) => api(`/api/session/${session.id}/permission`, { action, resources });

  beforeAll(async () => {
    const version = spawnSync("opencode", ["--version"], { encoding: "utf8" });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe("opencode v2.2.7");
    dir = realpathSync(mkdtempSync(join(tmpdir(), "opencode-policy-")));
    home = join(dir, "home");
    project = join(dir, "repo");
    worktree = join(dir, "worktree");
    const configDir = join(home, ".config/opencode");
    for (const path of [configDir, join(home, ".claude"), join(project, "nested")]) mkdirSync(path, { recursive: true });
    env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: dir,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_PASSWORD: "fixture-server-password",
      OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      AGENT_BOARD_HOOKS: "off",
      BUN_OPTIONS: "--bun",
    };
    writeFileSync(join(configDir, "AGENTS.md"), read("opencode/AGENTS.md") + "\nGLOBAL_POLICY_MARKER\n");
    writeFileSync(join(home, ".claude/CLAUDE.md"), "GLOBAL_CLAUDE_MARKER\n");
    for (const scope of [".claude", ".agents"]) {
      const path = join(home, scope, "skills/parity");
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "SKILL.md"), `---\nname: Parity\ndescription: Fixture precedence\n---\n${scope} skill wins\n`);
    }
    writeFileSync(join(project, "AGENTS.md"), read("AGENTS.md") + "\nROOT_POLICY_MARKER\n");
    writeFileSync(join(project, "nested/AGENTS.md"), "NESTED_POLICY_MARKER\n");
    writeFileSync(join(project, "CLAUDE.md"), "UNLOADED_CLAUDE_MARKER\n");
    cpSync(join(REPO, "opencode/agents"), join(configDir, "agents"), { recursive: true });
    cpSync(join(REPO, "opencode/plugins/setup-policy"), join(configDir, "plugins/setup-policy"), { recursive: true });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture instructions");
    git("worktree", "add", "--detach", worktree);

    mock = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (!path.endsWith("/chat/completions") && !path.endsWith("/responses")) return new Response(`Unexpected mock route: ${path}`, { status: 404 });
        const input = await request.json();
        requests.push(input);
        if (path.endsWith("/responses")) {
          const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture response", annotations: [] }] };
          const response = { id: "resp_fixture", object: "response", created_at: 1, model: input.model, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
          const events = [
            { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
            { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
            { type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
            { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "Fixture response" },
            { type: "response.output_text.done", output_index: 0, item_id: item.id, content_index: 0, text: "Fixture response" },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response },
          ];
          return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
        }
        const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(chunk({ role: "assistant", content: "Fixture response" }) + chunk({}, "stop") + "data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    const config = JSON.parse(read("opencode/opencode.json"));
    delete config.mcp; // Do not start the real board or desktop servers in a fixture.
    config.providers.opencode = {
      ...config.providers.opencode,
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: "fixture-only" },
    };
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify(config));
    server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs", "--log-level", "debug"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fixture server start timed out: ${logs}`)), 45_000);
      const capture = (data) => {
        logs += data.toString();
        const match = logs.match(/https?:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      };
      server.stdout.on("data", capture);
      server.stderr.on("data", capture);
      server.once("error", (error) => { clearTimeout(timer); reject(error); });
      server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Fixture server exited ${code}: ${logs}`)); });
    });
    expect((await api("/api/info")).version).toBe("2.2.7");
    // Public registry reads can precede activation in 2.2.7. A real model turn
    // waits for plugin readiness; use the local canned endpoint to establish it.
    const warmup = await create();
    await api(`/api/session/${warmup.id}/prompt`, { text: "Reply with the fixture response." });
    await api(`/api/experimental/session/${warmup.id}/wait`, {});
  }, 90_000);

  afterAll(async () => {
    try {
      if (base) for (const sessionID of sessions.reverse()) await api(`/api/session/${sessionID}`, undefined, "DELETE");
    } finally {
      if (server && server.exitCode === null) {
        const exited = new Promise((resolve) => server.once("exit", resolve));
        server.kill("SIGTERM");
        const timer = setTimeout(() => server.kill("SIGKILL"), 5_000);
        await exited;
        clearTimeout(timer);
        expect(server.exitCode !== null || server.signalCode !== null).toBe(true);
      }
      mock?.stop(true);
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("loads the plugin and corrects only the shipped skill", async () => {
    const plugins = await api(`/api/plugin?directory=${encodeURIComponent(project)}`);
    expect(plugins.map((plugin) => plugin.id)).toContain("setup-policy");
    const skills = await api(`/api/skill?directory=${encodeURIComponent(project)}`);
    const skill = skills.find((skill) => skill.id === "opencode");
    expect(skill.path).toBe("skill://opencode/SKILL.md");
    expect(skill.content).toContain("Do not use V1 documentation or general web search");
    expect(skill.content).not.toContain("which documents V1");
    const parity = skills.find((skill) => skill.id === "parity");
    expect(parity.path).toBe(join(home, ".agents/skills/parity/SKILL.md"));
    expect(parity.content).toContain(".agents skill wins");
  });

  test("keeps role restrictions after full-access inheritance in the real evaluator", async () => {
    const root = await create("build", { permissions: allowAll });
    for (const agent of ["explorer", "explore", "general", "worker", "solver", "title", "summary", "plan"]) {
      const child = await create(agent, { parentID: root.id });
      expect(child.permissions).toEqual(allowAll);
      expect((await permission(child, "subagent", ["worker"])).effect).toBe(["plan"].includes(agent) ? "allow" : "deny");
      const readOnly = ["explorer", "explore", "title", "summary"].includes(agent);
      expect((await permission(child, "shell", ["printf x > changed-file"])).effect).toBe(readOnly ? "deny" : "allow");
      expect((await permission(child, "execute")).effect).toBe(readOnly ? "deny" : "allow");
      expect((await permission(child, "edit", ["src/main.ts"])).effect).toBe(readOnly || agent === "plan" ? "deny" : "allow");
      expect((await permission(child, "read", ["src/main.ts"])).effect).toBe(["title", "summary"].includes(agent) ? "deny" : "allow");
      if (["explorer", "explore"].includes(agent)) {
        expect((await permission(child, "desktop_click")).effect).toBe("deny");
        expect((await permission(child, "read", [".env"])).effect).toBe("ask");
        expect((await permission(child, "skill", ["parity"])).effect).toBe(agent === "explorer" ? "allow" : "deny");
      }
      if (agent === "general") expect((await permission(child, "question")).effect).toBe("deny");
      if (agent === "plan") expect((await permission(child, "edit", [join(home, ".opencode/plan/design.md")])).effect).toBe("allow");
    }
    for (const action of ["edit", "shell", "execute", "subagent", "board_task_show"]) expect((await permission(root, action)).effect).toBe("allow");
  }, 60_000);

  test("native default policies still apply without a host override", async () => {
    const explorer = await create("explorer");
    expect((await permission(explorer, "shell", ["cat source.ts"])).effect).toBe("deny");
    expect((await permission(explorer, "read", ["source.ts"])).effect).toBe("allow");
    const build = await create();
    expect((await permission(build, "read", [".env"])).effect).toBe("ask");
    expect((await permission(build, "shell", ["bun test"])).effect).toBe("allow");
  });

  test("new root sessions retain xhigh through per-model settings", async () => {
    const model = await api(`/api/model/default?directory=${encodeURIComponent(project)}`);
    expect(model.providerID).toBe("opencode");
    expect(model.id ?? model.modelID).toBe("gpt-6.1-sol");
    const models = await api(`/api/model?directory=${encodeURIComponent(project)}`);
    const sol = models.find((model) => model.providerID === "opencode" && model.id === "gpt-6.1-sol");
    expect(sol.settings.reasoningEffort).toBe("xhigh");
    const agents = await api(`/api/agent?directory=${encodeURIComponent(project)}`);
    for (const id of ["worker", "solver"]) expect(agents.find((agent) => agent.id === id).model.variant).toBe("xhigh");
    expect(agents.find((agent) => agent.id === "explorer").model.variant).toBe("max");
  });

  test("nested and worktree sessions discover portable rules without duplicate globals", async () => {
    for (const directory of [join(project, "nested"), join(worktree, "nested")]) {
      const session = await create("build", { location: { directory } });
      const start = requests.length;
      await api(`/api/session/${session.id}/prompt`, { text: "Respond with the fixture response only." });
      await api(`/api/experimental/session/${session.id}/wait`, {});
      const calls = requests.slice(start);
      expect(calls.length).toBeGreaterThan(0);
      const request = calls.find((request) => JSON.stringify([request.instructions, request.messages ?? request.input]).includes("ROOT_POLICY_MARKER"));
      expect(request).toBeDefined();
      const context = [request.instructions ?? "", ...(request.messages ?? request.input).filter((message) => message.role === "system" || message.role === "developer").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))].join("\n");
      for (const marker of ["GLOBAL_POLICY_MARKER", "GLOBAL_CLAUDE_MARKER", "ROOT_POLICY_MARKER", "NESTED_POLICY_MARKER"]) {
        expect(context.split(marker)).toHaveLength(2);
      }
      expect(context).not.toContain("UNLOADED_CLAUDE_MARKER");
      expect(request.reasoning_effort ?? request.reasoning?.effort).toBe("xhigh");
    }
  }, 60_000);
});
