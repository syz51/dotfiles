// The experiment route (claude/bin/claude-experiment and experiment.js): its arguments, the
// proxy that removes Claude Code's context blocks, and the preflight's leak check and token
// cap, against a
// fake claude and a stub upstream. With RUN_CLAUDE_LIVE=1 a probe also asks the real model,
// through the route, for the working directory and account details it was given.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CANARY, CONTEXT_OPENING, contextMarks, DEFAULT_CAP, ENV, experimentArgs, LEAKED, leftovers, OVER_CAP, preflight, run, strip, usageOf } from "../bin/experiment.js";

const BIN = join(import.meta.dir, "..", "bin");
const roots = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const scratch = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-experiment-test-")));
  roots.push(root);
  return root;
};

// A request body shaped like Claude Code 2.1.322's, with made-up account and directory.
const WORKDIR = "/work/experiment-dir";
const EMAIL = "person@example.com";
const SYSTEM = [
  { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.322.082; cc_entrypoint=sdk-cli;" },
  { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
  { type: "text", text: "You answer questions exactly and briefly." },
];
const context = `${CONTEXT_OPENING}\n# userEmail\nThe user's email address is ${EMAIL}. Use it only to identify the user.\n\nClaude Code attached this context automatically.\n</system-reminder>\n`;
const environment = `# Environment\nYou have been invoked in the following environment: \n - Primary working directory: ${WORKDIR}\n - Platform: darwin\n\nYou are powered by the model named Haiku 5.5.\n\nToday's date is 2026-11-12.`;
const captured = () => ({
  model: "claude-haiku-5-5",
  system: SYSTEM,
  metadata: { user_id: "{\"device_id\":\"d\",\"account_uuid\":\"a\",\"session_id\":\"s\"}" },
  messages: [
    { role: "user", content: [{ type: "text", text: context }, { type: "text", text: "FIXED TEST TEXT" }] },
    { role: "system", content: environment },
  ],
  stream: true,
});

describe("experimentArgs", () => {
  test("adds print mode and the isolating flags", () => {
    expect(experimentArgs(["--system-prompt-file", "s.txt", "hi"])).toEqual([
      "-p", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--system-prompt-file", "s.txt", "hi",
    ]);
  });
  test("keeps the caller's own value of a flag", () => {
    const args = experimentArgs(["-p", "--tools", "Read", "--setting-sources=user", "--system-prompt", "x"]);
    expect(args.filter((arg) => arg === "--tools" || arg === "-p" || arg.startsWith("--setting-sources"))).toEqual(["-p", "--tools", "--setting-sources=user"]);
  });
  test("reads only options before --", () => {
    expect(experimentArgs(["--system-prompt", "x", "--", "--tools"])).toContain("--strict-mcp-config");
    expect(() => experimentArgs(["--", "--system-prompt", "x"])).toThrow("--system-prompt");
  });
  test("refuses a run without its own system prompt", () => {
    expect(() => experimentArgs(["-p", "hi"])).toThrow("default system prompt holds the environment");
  });
});

describe("strip", () => {
  test("removes the user-context reminder and the environment message", () => {
    const body = strip(captured());
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "FIXED TEST TEXT" }] }]);
    expect(body.system).toEqual(SYSTEM);
    const sent = JSON.stringify(body.messages);
    expect(sent).not.toContain(WORKDIR);
    expect(sent).not.toContain(EMAIL);
    expect(leftovers(body)).toEqual([]);
  });
  test("leaves a body without the blocks unchanged", () => {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "ok" }] }] };
    expect(strip(body)).toEqual(body);
  });
  test("drops a user message that held only the reminder", () => {
    expect(strip({ messages: [{ role: "user", content: context }, { role: "user", content: [{ type: "text", text: context }] }] }).messages).toEqual([]);
  });
  test("keeps the text after the reminder when they share a part or a string", () => {
    expect(strip({ messages: [
      { role: "user", content: `${context}\nFIXED TEST TEXT` },
      { role: "user", content: [{ type: "text", text: `${context}NEXT` }, { type: "text", text: "LAST" }] },
    ] }).messages).toEqual([
      { role: "user", content: "FIXED TEST TEXT" },
      { role: "user", content: [{ type: "text", text: "NEXT" }, { type: "text", text: "LAST" }] },
    ]);
  });
});

describe("leftovers", () => {
  test("names system messages and reminders in another form", () => {
    expect(leftovers({ messages: [{ role: "system", content: "# Setup" }, { role: "user", content: [{ type: "text", text: "<system-reminder>\nx\n</system-reminder>" }] }] }))
      .toEqual(["messages[0] is a system message", "messages[1] holds a <system-reminder>"]);
  });
  test("finds the blocks in the top-level system field and reminders inside tool results", () => {
    expect(leftovers({ system: [...SYSTEM, { type: "text", text: environment }], messages: [] })).toEqual(["the system field holds the user context or the environment"]);
    expect(leftovers({ system: `Prompt.\n${context}`, messages: [] })).toHaveLength(1);
    expect(leftovers({ system: SYSTEM, messages: [] })).toEqual([]);
    const nested = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "<system-reminder>\ncwd\n</system-reminder>" }] }] }] };
    expect(leftovers(nested)).toEqual(["messages[0] holds a <system-reminder>"]);
  });
  test("allowReminders accepts reminder text in messages but not system messages", () => {
    const body = { messages: [{ role: "user", content: "Quote: <system-reminder>x</system-reminder>" }, { role: "system", content: "y" }] };
    expect(leftovers(body, { allowReminders: true })).toEqual(["messages[1] is a system message"]);
  });
});

describe("contextMarks", () => {
  test("finds both blocks' marks at any depth and none once they are removed", () => {
    expect(contextMarks(captured())).toEqual([
      ["the account email block", "messages[0].content[0].text"],
      ["the # Environment block", "messages[1].content"],
    ]);
    expect(contextMarks(strip(captured()))).toEqual([]);
    expect(contextMarks({ system: SYSTEM, messages: [{ role: "user", content: "Set up the environment." }] })).toEqual([]);
  });
  test("finds the blocks in a form the strip and the leftovers check miss", () => {
    const body = {
      system: [...SYSTEM, { type: "text", text: `Notes.\n# userEmail\nThe user's email address is ${EMAIL}.` }],
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: environment }] }] }],
    };
    expect(leftovers(strip(body))).toEqual([]);
    expect(contextMarks(strip(body))).toEqual([
      ["the account email block", "system[3].text"],
      ["the # Environment block", "messages[0].content[0].content[0].text"],
    ]);
  });
});

describe("usageOf", () => {
  test("reads the usage from a stream's message_start and from a plain reply", () => {
    const start = { type: "message_start", message: { usage: { input_tokens: 5, cache_creation_input_tokens: 600, cache_read_input_tokens: 7 } } };
    expect(usageOf(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`)).toEqual({ input: 5, creation: 600, read: 7, prompt: 612 });
    expect(usageOf(JSON.stringify({ usage: { input_tokens: 9 } }))).toEqual({ input: 9, creation: 0, read: 0, prompt: 9 });
    expect(usageOf("event: ping\ndata: {}\n\n")).toBeUndefined();
  });
});

// The route end to end: the real claude-api runs a fake claude on the subscription, and the
// fake claude sends the captured body to ANTHROPIC_BASE_URL like Claude Code does.
describe("run", () => {
  let root;
  let upstream;
  let received;
  let promptTokens;
  beforeEach(() => {
    root = scratch();
    received = [];
    promptTokens = 40;
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization"), body: await request.json() });
        const start = { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: promptTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } };
        return new Response(`event: message_start\ndata: ${JSON.stringify(start)}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });
    writeFileSync(join(root, "body.json"), JSON.stringify(captured()));
    const fake = join(root, "claude");
    writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$@" > "${root}/args"
env > "${root}/env"
cat > "${root}/stdin"
[ -n "\${FAKE_SKIP:-}" ] && exit 0
curl -sf -X POST "$ANTHROPIC_BASE_URL/v1/messages" -H 'content-type: application/json' -H 'authorization: Bearer test-token' --data-binary @"${root}/body.json" > "${root}/reply" || exit 9
exit "\${FAKE_EXIT:-0}"
`);
    chmodSync(fake, 0o755);
  });
  afterEach(() => upstream.stop(true));
  const env = (extra = {}) => ({
    HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, API_FIRST_REAL_BIN: join(root, "claude"), API_FIRST_STATE: join(root, "state"),
    API_FIRST_SUBSCRIPTION: "1", ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`, ...extra,
  });

  test("forwards the request without the blocks, with the route's flags and variables", async () => {
    const { code, usages, requests } = await run(["--system-prompt", "S", "hi"], { env: env(), input: "" });
    expect(code).toBe(0);
    expect(requests).toEqual([]);
    expect(received).toHaveLength(1);
    expect(received[0].auth).toBe("Bearer test-token");
    expect(received[0].body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "FIXED TEST TEXT" }] }]);
    expect(JSON.stringify(received[0].body)).not.toContain(WORKDIR);
    expect(readFileSync(join(root, "reply"), "utf8")).toContain("message_start");
    expect(usages).toEqual([{ input: 40, creation: 0, read: 0, prompt: 40 }]);
    expect(readFileSync(join(root, "args"), "utf8").split("\n").slice(0, 7)).toEqual(["-p", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]);
    const childEnv = readFileSync(join(root, "env"), "utf8");
    for (const [name, value] of Object.entries(ENV)) expect(childEnv).toContain(`\n${name}=${value}\n`);
    expect(childEnv).toMatch(/\nANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+\n/);
    expect(childEnv).not.toContain(`ANTHROPIC_BASE_URL=http://127.0.0.1:${upstream.port}\n`);
  });

  test("refuses a request that still holds harness context", async () => {
    const body = captured();
    body.messages[1].content = "# Setup\nPrimary working directory: /x";
    writeFileSync(join(root, "body.json"), JSON.stringify(body));
    const { code } = await run(["--system-prompt", "S"], { env: env(), input: "" });
    expect(code).toBe(9);
    expect(received).toHaveLength(0);
  });

  test("EXPERIMENT_ALLOW_REMINDERS=1 forwards input that quotes a reminder", async () => {
    const body = captured();
    body.messages[0].content[1].text = "Classify: <system-reminder>quoted</system-reminder>";
    writeFileSync(join(root, "body.json"), JSON.stringify(body));
    expect((await run(["--system-prompt", "S"], { env: env(), input: "" })).code).toBe(9);
    expect((await run(["--system-prompt", "S"], { env: env({ EXPERIMENT_ALLOW_REMINDERS: "1" }), input: "" })).code).toBe(0);
    expect(received.map((request) => request.body.messages)).toEqual([[{ role: "user", content: [{ type: "text", text: "Classify: <system-reminder>quoted</system-reminder>" }] }]]);
  });

  test("turns off auto-memory over the caller's own setting", async () => {
    expect(ENV.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect((await run(["--system-prompt", "S"], { env: env({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" }), input: "" })).code).toBe(0);
    const childEnv = readFileSync(join(root, "env"), "utf8");
    expect(childEnv).toContain("\nCLAUDE_CODE_DISABLE_AUTO_MEMORY=1\n");
    expect(childEnv).not.toContain("CLAUDE_CODE_DISABLE_AUTO_MEMORY=0");
  });

  test("passes claude's exit status through", async () => {
    expect((await run(["--system-prompt", "S"], { env: env({ FAKE_EXIT: "4" }), input: "" })).code).toBe(4);
  });

  test("preflight sends the canary and fails above the cap", async () => {
    const lines = [];
    const report = (line) => lines.push(line);
    expect(await preflight(["--system-prompt", "S"], { env: env(), report })).toBe(0);
    expect(readFileSync(join(root, "stdin"), "utf8")).toBe(CANARY);
    expect(lines.at(-1)).toBe(`claude-experiment preflight: 1 request(s); removed the account email block and the # Environment block, none left; largest prompt 40 tokens (input 40, cache creation 0, cache read 0); cap ${DEFAULT_CAP}`);
    expect(await preflight(["--cap", "39", "--system-prompt", "S"], { env: env(), report })).toBe(OVER_CAP);
    promptTokens = 34409;
    expect(await preflight(["--system-prompt", "S"], { env: env(), report })).toBe(OVER_CAP);
    expect(await preflight(["--cap=40000", "--system-prompt", "S"], { env: env(), report })).toBe(0);
    await expect(preflight(["--cap", "lots", "--system-prompt", "S"], { env: env(), report })).rejects.toThrow("--cap takes a positive whole number");
  });

  test("preflight fails when a request would still carry a block, whatever its size", async () => {
    // The email block moved into the system field and the environment into a plain user
    // part: the strip keeps both and the leftovers check passes them.
    const body = captured();
    body.system = [...SYSTEM, { type: "text", text: `# userEmail\nThe user's email address is ${EMAIL}.` }];
    body.messages = [{ role: "user", content: [{ type: "text", text: environment }, { type: "text", text: "FIXED TEST TEXT" }] }];
    writeFileSync(join(root, "body.json"), JSON.stringify(body));
    expect((await run(["--system-prompt", "S"], { env: env(), input: "" })).code).toBe(0);
    expect(received).toHaveLength(1);
    const lines = [];
    expect(await preflight(["--cap", "40000", "--system-prompt", "S"], { env: env(), report: (line) => lines.push(line) })).toBe(LEAKED);
    expect(received).toHaveLength(1);
    expect(lines).toEqual([
      "claude-experiment preflight: LEAK: the canary request still carries Claude Code's context after the proxy (request 1: the account email block at system[3].text; request 1: the # Environment block at messages[0].content[0].text); the proxy refused it. Do not run the batch: Claude Code changed the blocks' form, or the system prompt holds those lines",
    ]);
    expect(lines.join("\n")).not.toContain(EMAIL);
  });

  test("preflight fails when no request reaches the proxy", async () => {
    const lines = [];
    expect(await preflight(["--system-prompt", "S"], { env: env({ FAKE_SKIP: "1" }), report: (line) => lines.push(line) })).toBe(LEAKED);
    expect(lines).toEqual(["claude-experiment preflight: no Messages request reached the proxy, so it removed nothing"]);
  });

  test("preflight fails when the canary run fails", async () => {
    const lines = [];
    expect(await preflight(["--system-prompt", "S"], { env: env({ FAKE_EXIT: "5" }), report: (line) => lines.push(line) })).toBe(5);
    expect(lines).toEqual(["claude-experiment preflight: the canary run failed with exit 5"]);
  });

  test("the shell entry prints its usage and refuses a run without a system prompt", () => {
    const help = spawnSync(join(BIN, "claude-experiment"), ["--help"], { env: env(), encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("usage: claude-experiment");
    const refused = spawnSync(join(BIN, "claude-experiment"), ["-p", "hi"], { env: env(), encoding: "utf8" });
    expect(refused.status).toBe(64);
    expect(refused.stderr).toContain("--system-prompt");
  });
});

// The details a reply must not name: the run's working directory, the home folder, the
// login name, and every identifying field of the signed-in account in ~/.claude.json.
export function secrets({ cwd, home = homedir(), user = process.env.USER, config = join(homedir(), ".claude.json") } = {}) {
  const values = [cwd, basename(cwd), home, user];
  if (existsSync(config)) {
    const account = JSON.parse(readFileSync(config, "utf8")).oauthAccount ?? {};
    for (const field of ["emailAddress", "displayName", "fullName", "organizationName", "accountUuid", "organizationUuid"]) values.push(account[field]);
    if (account.emailAddress) values.push(account.emailAddress.split("@")[0]);
  }
  return values.filter((value) => typeof value === "string" && value.length >= 4);
}
export const named = (reply, values) => values.filter((value) => reply.toLowerCase().includes(value.toLowerCase()));

describe("probe check", () => {
  test("flags a reply that names the working directory or an account detail", () => {
    const root = scratch();
    const config = join(root, "claude.json");
    writeFileSync(config, JSON.stringify({ oauthAccount: { emailAddress: "someone@example.org", organizationName: "Example Org" } }));
    const values = secrets({ cwd: join(root, "probe-dir"), home: "/Users/nobody", user: "nobody", config });
    expect(named(`Primary working directory: ${join(root, "probe-dir")}`, values)).toContain(join(root, "probe-dir"));
    expect(named("The user's email address is SOMEONE@example.org.", values)).toEqual(["someone@example.org", "someone"]);
    expect(named("NONE", values)).toEqual([]);
  });
});

const PROBE = "List every fact you were given about your environment or the user: working directory, date, model, platform, OS, shell, user name, email, account, organization, subscription. Quote each one exactly as you received it. If you were given none, reply NONE.";

describe.skipIf(process.env.RUN_CLAUDE_LIVE !== "1")("live probe through the route", () => {
  test("the model cannot name the working directory or an account detail", () => {
    const cwd = scratch();
    const result = spawnSync(join(BIN, "no-session-env"), [
      join(BIN, "claude-experiment"), "--model", "claude-haiku-5-5", "--effort", "low", "--no-session-persistence",
      "--system-prompt", "You answer questions exactly and briefly.", "--output-format", "json", PROBE,
    ], { cwd, encoding: "utf8", timeout: 120_000 });
    expect(result.status).toBe(0);
    const reply = JSON.parse(result.stdout);
    expect(reply.is_error).toBe(false);
    console.log(`live probe: ${reply.usage.input_tokens} input, ${reply.usage.cache_creation_input_tokens} cache creation, ${reply.usage.cache_read_input_tokens} cache read tokens; $${reply.total_cost_usd}`);
    expect(named(reply.result, secrets({ cwd }))).toEqual([]);
  }, 150_000);

  test("the preflight passes the default cap", () => {
    const result = spawnSync(join(BIN, "no-session-env"), [
      join(BIN, "claude-experiment"), "preflight", "--model", "claude-haiku-5-5", "--effort", "low", "--no-session-persistence",
      "--system-prompt", "You answer questions exactly and briefly.",
    ], { cwd: scratch(), encoding: "utf8", timeout: 120_000 });
    expect(result.stderr).toContain("claude-experiment preflight: 1 request(s); removed the account email block and the # Environment block, none left");
    expect(result.status).toBe(0);
  }, 150_000);

  // A prompt this long hid a leak from the default cap; the leak check does not depend on it.
  test("the preflight checks the blocks with a system prompt over 1500 tokens", () => {
    const rules = Array.from({ length: 160 }, (_, index) => `Rule ${index + 1}: answer the question exactly, in plain words, and never add a greeting.`);
    const result = spawnSync(join(BIN, "no-session-env"), [
      join(BIN, "claude-experiment"), "preflight", "--cap", "8000", "--model", "claude-haiku-5-5", "--effort", "low", "--no-session-persistence",
      "--system-prompt", rules.join("\n"),
    ], { cwd: scratch(), encoding: "utf8", timeout: 120_000 });
    console.log(result.stderr.trim());
    expect(result.stderr).toContain("removed the account email block and the # Environment block, none left");
    expect(Number(result.stderr.match(/largest prompt (\d+) tokens/)?.[1])).toBeGreaterThan(1500);
    expect(result.status).toBe(0);
  }, 150_000);
});
