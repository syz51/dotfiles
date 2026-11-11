// Real OpenCode execution with a local, deterministic model endpoint. No paid inference.
import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const integration = process.env.RUN_OPENCODE_RUNTIME === "1" ? test : test.skip;
const repo = resolve(import.meta.dir, "../..");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
}

async function run(args, env, cwd) {
  const child = spawn("opencode", args, { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }, 60_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    return { code, output };
  } finally { clearTimeout(timer); }
}

integration("real CLI dispatch guards nested Code Mode and reports native shell/patch/MCP contracts", async () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-runtime-"));
  const project = join(root, "project");
  const config = join(root, "config");
  const home = join(root, "home");
  mkdirSync(project);
  mkdirSync(config);
  mkdirSync(home);
  const log = join(root, "hooks.jsonl");
  const hook = join(root, "hook.js");
  const board = join(root, "board.js");
  const control = join(root, "control");
  mkdirSync(control);
  writeFileSync(join(control, "index.js"), `export default {id:'fixture-control',async setup(ctx){
await ctx.tool.transform(editor=>editor.add({name:'compact_fixture',description:'Compact the fixture session',input:{type:'object',properties:{},additionalProperties:false},options:{codemode:false},execute:async(input,context)=>{
 await ctx.session.compact({sessionID:context.sessionID}); return {content:'compaction queued'};
}}));
}};`);
  writeFileSync(hook, `import {appendFileSync} from 'node:fs';
const input = JSON.parse(await Bun.stdin.text());
appendFileSync(process.env.FIXTURE_HOOK_LOG, JSON.stringify(input)+'\\n');
if(input.hook_event_name==='PreCompact') console.log('preserve-fixture-task-identity');
if (input.tool_name === 'Bash' && input.tool_input.command.includes('fixture-blocked')) {
  console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'fixture denied'}}));
}
`);
  writeFileSync(board, `import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line); if(m.id===undefined) continue;
 let result={};
 if(m.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 if(m.method==='tools/list') result={tools:[{name:'task_show',description:'Read a fixture task',inputSchema:{type:'object',properties:{id:{type:'string'},agent:{type:'string'}},required:['id'],additionalProperties:false}}]};
 if(m.method==='tools/call') result={content:[{type:'text',text:JSON.stringify(m.params.arguments)}]};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
}
`);
  const command = `'${process.execPath}' '${hook}'`;
  const settings = join(root, "settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ type: "command", command }] }],
    PostToolUse: [{ hooks: [{ type: "command", command }] }],
    PostToolUseFailure: [{ hooks: [{ type: "command", command }] }],
    SessionStart: [{ hooks: [{ type: "command", command }] }],
    PreCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command }] }],
  } }));
  writeFileSync(join(project, "seed.txt"), "fixture\n");
  writeFileSync(join(project, "move.txt"), "fixture\n");
  git(project, "init", "--quiet");
  git(project, "add", "seed.txt", "move.txt");
  git(project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture");
  const memory = join(home, ".claude/projects", realpathSync(project).replace(/[/.]/g, "-"), "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, "MEMORY.md"), "fixture-memory-verified\n");

  const calls = [
    ["shell", { command: 'printf "%s" "$OPENCODE_SESSION_ID"', workdir: project }],
    ["execute", { code: "const tree = await tools.opencode.worktree_create({name:'hook-fixture'}); await tools.opencode.worktree_remove({directory:tree.directory}); return {worktreeChecked:true};" }],
    ["board_task_show", { id: "fixture-task" }],
    ["shell", { command: "printf fixture-blocked", workdir: project }],
    ["subagent", { agent: "worker", description: "Check fixture child memory", prompt: "fixture-child-memory" }],
    ["compact_fixture", {}],
    ["patch", { patchText: "*** Begin Patch\n*** Add File: result.txt\n+runtime fixture\n*** Delete File: seed.txt\n*** Update File: move.txt\n*** Move to: renamed.txt\n@@\n-fixture\n+moved\n*** End Patch" }],
  ];
  let step = 0;
  const requests = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method === "GET") return Response.json({ data: [] });
      const body = await request.json();
      const child = Array.isArray(body.input) && body.input.some((item) => item.role === "user" && JSON.stringify(item.content ?? "").includes("fixture-child-memory"));
      const compaction = JSON.stringify(body).includes("preserve-fixture-task-identity");
      requests.push({ path: new URL(request.url).pathname, tools: body.tools?.map((tool) => tool.function?.name ?? tool.name),
        compactionGuidance: compaction, childMemory: child && JSON.stringify(body).includes("fixture-memory-verified") });
      const tool = body.tools?.length && !child && !compaction ? calls[step++] : undefined;
      if (new URL(request.url).pathname.endsWith("/responses")) {
        const item = tool
          ? { id: `fc_${step}`, type: "function_call", status: "completed", call_id: `fixture-call-${step}`, name: tool[0], arguments: JSON.stringify(tool[1]) }
          : { id: "message_fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Fixture complete.", annotations: [] }] };
        const response = { id: "resp_fixture", object: "response", created_at: 1, model: "gpt-6.1-sol", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
        if (body.stream === false) return Response.json(response);
        const events = [
          { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: tool ? { ...item, status: "in_progress", arguments: "" } : { ...item, status: "in_progress", content: [] } },
          ...(tool ? [
            { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
            { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments },
          ] : [
            { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
            { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Fixture complete." },
            { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "Fixture complete." },
            { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
          ]),
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ];
        return new Response(events.map((value, index) => `event: ${value.type}\ndata: ${JSON.stringify({ ...value, sequence_number: index })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      }
      const chunk = (delta, finish_reason = null) => ({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "gpt-6.1-sol", choices: [{ index: 0, delta, finish_reason }] });
      const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `fixture-call-${step}`, type: "function", function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] } : { role: "assistant", content: "Fixture complete." };
      if (body.stream === false) return Response.json({ id: "fixture", object: "chat.completion", created: 1, model: "gpt-6.1-sol", choices: [{ index: 0, message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      return new Response([chunk(delta), chunk({}, tool ? "tool_calls" : "stop")].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    writeFileSync(join(config, "opencode.json"), JSON.stringify({
      model: "opencode/gpt-6.1-sol#xhigh", update: "disable",
      plugins: [{ package: join(repo, "opencode/plugins/claude-hooks"), options: { settingsPath: settings } }, control],
      agents: { worker: { mode: "subagent", model: "opencode/gpt-6.1-sol#xhigh", system: "Complete the deterministic child fixture without tools." } },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      providers: { opencode: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture-not-a-secret" }, models: { "gpt-6.1-sol": { settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture-not-a-secret" } } } } },
      mcp: { servers: { board: { type: "local", command: [process.execPath, board], codemode: false } } },
    }));
    const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE|T3CODE|CLAUDE)/.test(key)));
    const result = await run(["run", "--standalone", "--auto", "--archived", "--format", "json", "--model", "opencode/gpt-6.1-sol#xhigh", "Exercise the deterministic fixture tools."], {
      ...isolatedEnv, HOME: home, PWD: project, OPENCODE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), FIXTURE_HOOK_LOG: log,
    }, project);
    if (result.code !== 0) throw new Error(`OpenCode fixture failed (${result.code}):\n${result.output}\n${JSON.stringify(requests)}`);
    const events = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
    expect(events.some((event) => event.tool_name === "EnterWorktree" && event.hook_event_name === "PreToolUse")).toBe(true);
    expect(events.some((event) => event.tool_name === "mcp__board__task_show" && event.tool_input.agent?.startsWith("opencode:"))).toBe(true);
    expect(events.some((event) => event.tool_name === "apply_patch" && event.hook_event_name === "PostToolUse" && event.tool_input.command.includes("result.txt")), `${JSON.stringify(requests)}\n${result.output}`).toBe(true);
    expect(result.output).toContain("fixture denied");
    if (!existsSync(join(project, "result.txt"))) throw new Error(`Patch did not reach the isolated project:\n${result.output}\n${JSON.stringify(events)}`);
    expect(readFileSync(join(project, "result.txt"), "utf8")).toBe("runtime fixture\n");
    expect(readFileSync(join(project, "renamed.txt"), "utf8")).toBe("moved\n");
    expect(existsSync(join(project, "seed.txt"))).toBe(false);
    expect(existsSync(join(project, "move.txt"))).toBe(false);
    expect(events.filter((event) => event.hook_event_name === "SessionStart").every((event) => realpathSync(event.cwd) === realpathSync(project))).toBe(true);
    expect(requests.length).toBeGreaterThanOrEqual(calls.length);
    expect(requests.some((request) => request.compactionGuidance)).toBe(true);
    expect(requests.some((request) => request.childMemory)).toBe(true);
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
