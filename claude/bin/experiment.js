// The experiment route: a headless `claude -p` call that sends the model only the
// experiment's system prompt and input. claude-experiment (a shell script) runs this file.
//
// Claude Code adds two blocks to every request that no flag or environment variable removes
// on the claude.ai subscription (checked on 2.1.322 by capturing its requests at a local
// ANTHROPIC_BASE_URL): a user-context reminder with the account's email, and an
// "# Environment" message with the working directory, platform, shell, OS, model and date.
// --bare (CLAUDE_CODE_SIMPLE=1) refuses OAuth, and with an API key it still sent both
// blocks; --exclude-dynamic-system-prompt-sections is ignored with --system-prompt. So this
// route starts a local proxy, points Claude Code at it through claude-api's
// API_FIRST_PROXY_URL (after the billing plan, so API-first billing still applies), and the
// proxy removes both blocks from each Messages request before it forwards the request.
// A request that still holds a <system-reminder> or a system-role message after that is
// refused, so a new Claude Code that changes the blocks' form fails the run instead of
// leaking. preflight also scans each forwarded canary request for the blocks' marks
// anywhere in it (contextMarks), so a form that slips past both checks fails the preflight
// whatever the size of the caller's prompt. The billing header, the SDK identity line and the request metadata stay: the
// model does not read the metadata, and the subscription needs the other two.
//
// The route also sets flags and variables that keep tools, settings, MCP servers (also
// claude.ai connectors), skills and the session-title side call out of the run, and refuses
// a run without --system-prompt[-file], since Claude Code's default system prompt holds the
// environment itself.
//
// Variables:
//   ANTHROPIC_BASE_URL   the proxy's upstream; default https://api.anthropic.com. claude-api
//                        also sees it and, as for any caller's own endpoint, passes the run
//                        through on claude's own auth instead of billing the API first.
//   API_FIRST_*          passed through to claude-api (API_FIRST_SUBSCRIPTION=1 runs on the
//                        subscription without spending API credit)
//   EXPERIMENT_ALLOW_REMINDERS=1
//                        lets messages hold <system-reminder> text (an experiment whose input
//                        quotes one); system-role messages and a system field with the
//                        removed blocks are still refused
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";

export const CANARY = "Reply with the single word OK.";
export const DEFAULT_CAP = 2000;
export const OVER_CAP = 3;
export const LEAKED = 4;

export const USAGE = `usage: claude-experiment <claude args>
       claude-experiment preflight [--cap N] <claude args>

Runs \`claude -p\` so the model sees only the experiment's system prompt and input.
Pass --system-prompt or --system-prompt-file; the run refuses without one.

Defaults, each added unless the caller passes that flag: -p, --tools "",
--setting-sources "", --strict-mcp-config, --disable-slash-commands. Variables:
ENABLE_CLAUDEAI_MCP_SERVERS=false, CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1.
A local proxy removes Claude Code's user-context reminder (account email) and its
"# Environment" message (working directory, platform, model, date) from each request,
and refuses a request that still holds a <system-reminder> or system-role message.
EXPERIMENT_ALLOW_REMINDERS=1 accepts <system-reminder> text in messages, for input
that quotes one. Billing goes through claude-api: the API first, the subscription as
fallback; API_FIRST_SUBSCRIPTION=1 uses the subscription. A caller's own
ANTHROPIC_BASE_URL becomes the proxy's upstream, and claude-api then passes the run
through on claude's own auth.

preflight sends the canary text on stdin with the same flags (give no prompt). Run it
before a batch. It exits ${LEAKED} when no request reached the proxy, or when a request the
proxy forwards would still carry the account email block ("# userEmail", "The user's
email address is") or the environment block (a "# Environment" line, "Primary working
directory:") anywhere, whatever the prompt's size; the proxy then refuses that request.
A system prompt that itself holds those lines fails it too. It exits ${OVER_CAP} when a
request's prompt tokens (input, cache creation and cache read) exceed the cap (default
${DEFAULT_CAP}), and with claude's code when the canary run fails. It prints what the
proxy removed.

See SETUP.md, "Experiment calls".`;

export const UPSTREAM = "https://api.anthropic.com";
export const ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1" };
// [flag, value or null]: added when the caller's options before `--` do not name the flag.
const DEFAULTS = [["--tools", ""], ["--setting-sources", ""], ["--strict-mcp-config", null], ["--disable-slash-commands", null]];
// The opening of Claude Code's user-context reminder (2.1.322).
export const CONTEXT_OPENING = "<system-reminder>\nAs you answer the user's questions, you can use the following context:";
export const ENVIRONMENT_OPENING = "# Environment";
const REMINDER_CLOSE = "</system-reminder>";

// The caller's arguments with the route's defaults before any `--` marker. Throws when the
// run has no system prompt of its own.
export function experimentArgs(argv) {
  const end = argv.indexOf("--") === -1 ? argv.length : argv.indexOf("--");
  const options = argv.slice(0, end);
  const named = (flag) => options.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (!named("--system-prompt") && !named("--system-prompt-file")) {
    throw new Error("pass --system-prompt or --system-prompt-file: Claude Code's default system prompt holds the environment");
  }
  const added = [];
  if (!named("-p") && !named("--print")) added.push("-p");
  for (const [flag, value] of DEFAULTS) if (!named(flag)) added.push(...(value === null ? [flag] : [flag, value]));
  return [...added, ...argv];
}

// All text in a message's content, also inside nested parts such as tool results.
const textOf = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => `${part.text ?? ""}\n${textOf(part.content)}`).join("\n") : "";
// Text without a leading user-context reminder: what follows its closing tag stays.
const withoutContext = (text) => {
  if (!text.startsWith(CONTEXT_OPENING)) return text;
  const end = text.indexOf(REMINDER_CLOSE);
  return end === -1 ? "" : text.slice(end + REMINDER_CLOSE.length).replace(/^\s+/, "");
};

// A Messages request body without the user-context reminder and the environment message.
export function strip(body) {
  if (!Array.isArray(body?.messages)) return body;
  const messages = [];
  for (const message of body.messages) {
    if (message.role === "system" && textOf(message.content).startsWith(ENVIRONMENT_OPENING)) continue;
    if (message.role === "user" && Array.isArray(message.content)) {
      const content = message.content
        .map((part) => part.type === "text" && part.text?.startsWith(CONTEXT_OPENING) ? { ...part, text: withoutContext(part.text) } : part)
        .filter((part) => !(part.type === "text" && part.text === ""));
      const changed = content.length !== message.content.length || content.some((part, index) => part !== message.content[index]);
      if (content.length > 0) messages.push(changed ? { ...message, content } : message);
      continue;
    }
    if (message.role === "user" && typeof message.content === "string" && message.content.startsWith(CONTEXT_OPENING)) {
      const content = withoutContext(message.content);
      if (content !== "") messages.push({ ...message, content });
      continue;
    }
    messages.push(message);
  }
  return { ...body, messages };
}

// What harness context a request still holds, as short descriptions: the removed blocks in
// the top-level system field, system-role messages, and (unless allowReminders) any
// <system-reminder> text in a message, also inside nested parts.
export function leftovers(body, { allowReminders = false } = {}) {
  const found = [];
  const system = textOf(body?.system);
  if (system.includes(CONTEXT_OPENING) || system.includes(`\n${ENVIRONMENT_OPENING}\n`) || system.startsWith(`${ENVIRONMENT_OPENING}\n`)) {
    found.push("the system field holds the user context or the environment");
  }
  for (const [index, message] of (body?.messages ?? []).entries()) {
    if (message.role === "system") found.push(`messages[${index}] is a system message`);
    else if (!allowReminders && textOf(message.content).includes("<system-reminder>")) found.push(`messages[${index}] holds a <system-reminder>`);
  }
  return found;
}

// Text that marks Claude Code's two blocks, with the block it marks.
const MARKS = [
  [/# userEmail/, "the account email block"],
  [/The user's email address is/, "the account email block"],
  [/^# Environment[ \t]*$/m, "the # Environment block"],
  [/Primary working directory:/, "the # Environment block"],
];
function* stringsOf(value, path) {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (const [index, item] of value.entries()) yield* stringsOf(item, `${path}[${index}]`);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) yield* stringsOf(item, path ? `${path}.${key}` : key);
}

// Where a request body holds a mark of the email or environment block, in any field and at
// any depth, as [block, path] pairs without the text itself.
export function contextMarks(body) {
  const found = new Map();
  for (const [path, text] of stringsOf(body, "")) {
    for (const [pattern, block] of MARKS) if (pattern.test(text)) found.set(`${block}@${path}`, [block, path]);
  }
  return [...found.values()];
}

// The prompt-token usage from the start of a Messages response, streamed or not.
export function usageOf(text) {
  const start = text.match(/^data: (\{"type":"message_start".*)$/m);
  try {
    const usage = start ? JSON.parse(start[1]).message?.usage : JSON.parse(text).usage;
    if (!usage) return undefined;
    const { input_tokens: input = 0, cache_creation_input_tokens: creation = 0, cache_read_input_tokens: read = 0 } = usage;
    return { input, creation, read, prompt: input + creation + read };
  } catch {
    return undefined;
  }
}

const refusal = (message) => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
  status: 400, headers: { "content-type": "application/json" },
});

// The local proxy. usages collects each Messages response's prompt-token usage. With
// refuseMarks (the preflight), requests collects each Messages request's block marks: before
// the proxy removed the blocks (seen) and in what it would forward (left), and the proxy
// refuses a request that has any left.
export function startProxy({ upstream = UPSTREAM, usages = [], requests = [], allowReminders = false, refuseMarks = false, log = (line) => console.error(line) } = {}) {
  const base = upstream.replace(/\/+$/, "");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      for (const name of ["host", "content-length", "accept-encoding"]) headers.delete(name);
      let body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
      const messages = url.pathname === "/v1/messages" && request.method === "POST";
      if (messages) {
        const original = JSON.parse(body);
        const stripped = strip(original);
        const marks = refuseMarks ? { seen: contextMarks(original), left: contextMarks(stripped) } : undefined;
        if (marks) requests.push(marks);
        const left = leftovers(stripped, { allowReminders });
        if (left.length > 0) {
          const message = `claude-experiment: harness context left in the request (${left.join("; ")}): Claude Code changed the blocks' form or added context, or the experiment's input quotes a <system-reminder> (then set EXPERIMENT_ALLOW_REMINDERS=1)`;
          log(message);
          return refusal(message);
        }
        if (marks && marks.left.length > 0) {
          const message = `claude-experiment: Claude Code's context left in the request (${marks.left.map(([block, path]) => `${block} at ${path}`).join("; ")})`;
          log(message);
          return refusal(message);
        }
        body = JSON.stringify(stripped);
      }
      const response = await fetch(base + url.pathname + url.search, { method: request.method, headers, body, redirect: "manual" });
      const out = new Headers(response.headers);
      // fetch has decoded the body.
      for (const name of ["content-encoding", "content-length"]) out.delete(name);
      if (!messages || !response.body) return new Response(response.body, { status: response.status, headers: out });
      // Pass the body through, reading the usage from its first 64 KB.
      let seen = "";
      let done = false;
      const decoder = new TextDecoder();
      const tap = new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          if (done) return;
          seen += decoder.decode(chunk, { stream: true });
          const usage = usageOf(seen);
          if (usage || seen.length > 65536) done = true;
          if (usage) usages.push(usage);
        },
        flush() {
          if (done) return;
          const usage = usageOf(seen);
          if (usage) usages.push(usage);
        },
      });
      return new Response(response.body.pipeThrough(tap), { status: response.status, headers: out });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}`, usages, requests };
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// Runs claude-api with the route's arguments behind the proxy and resolves to its exit code,
// the requests' usage and, with refuseMarks, their block marks. With input, claude reads it on stdin and its
// output is dropped. refuseMarks goes to the proxy. A signal to this process goes on to claude.
export async function run(argv, { env = process.env, input, refuseMarks = false, wrapper = join(import.meta.dir, "claude-api") } = {}) {
  const args = experimentArgs(argv);
  const proxy = startProxy({ upstream: env.ANTHROPIC_BASE_URL || UPSTREAM, allowReminders: env.EXPERIMENT_ALLOW_REMINDERS === "1", refuseMarks });
  const stdio = input === undefined ? "inherit" : ["pipe", "ignore", "inherit"];
  const child = spawn(wrapper, args, { env: { ...env, ...ENV, API_FIRST_PROXY_URL: proxy.url }, stdio });
  if (input !== undefined) child.stdin.end(input);
  const forward = (signal) => child.kill(signal);
  for (const signal of SIGNALS) process.on(signal, forward);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (status, signal) => resolve(status ?? 128 + (constants.signals[signal] ?? 0)));
  }).finally(() => {
    for (const signal of SIGNALS) process.off(signal, forward);
    proxy.server.stop(true);
  });
  return { code, usages: proxy.usages, requests: proxy.requests };
}

// Sends the canary with the experiment's flags, checks that no request would still carry
// Claude Code's blocks, then each request's prompt tokens against the cap. Resolves to an exit
// code: LEAKED for a block left in a request or no request seen, claude's when the run
// failed, OVER_CAP above the cap.
export async function preflight(argv, { env = process.env, wrapper, report = (line) => console.error(line) } = {}) {
  let cap = DEFAULT_CAP;
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--cap" || arg.startsWith("--cap=")) {
      const value = arg === "--cap" ? argv[++index] : arg.slice("--cap=".length);
      cap = Number(value);
      if (!Number.isInteger(cap) || cap <= 0) throw new Error(`--cap takes a positive whole number, not ${value}`);
    } else rest.push(arg);
  }
  const { code, usages, requests } = await run(rest, { env, input: CANARY, wrapper, refuseMarks: true });
  const leaks = requests.flatMap(({ left }, index) => left.map(([block, path]) => `request ${index + 1}: ${block} at ${path}`));
  if (leaks.length > 0) {
    report(`claude-experiment preflight: LEAK: the canary request still carries Claude Code's context after the proxy (${leaks.join("; ")}); the proxy refused it. Do not run the batch: Claude Code changed the blocks' form, or the system prompt holds those lines`);
    return LEAKED;
  }
  if (code !== 0) {
    report(`claude-experiment preflight: the canary run failed with exit ${code}`);
    return code;
  }
  if (requests.length === 0) {
    report("claude-experiment preflight: no Messages request reached the proxy, so it removed nothing");
    return LEAKED;
  }
  if (usages.length === 0) {
    report("claude-experiment preflight: no Messages usage seen");
    return OVER_CAP;
  }
  const worst = usages.reduce((a, b) => (b.prompt > a.prompt ? b : a));
  const removed = [...new Set(requests.flatMap(({ seen }) => seen.map(([block]) => block)))];
  report(`claude-experiment preflight: ${usages.length} request(s); removed ${removed.length > 0 ? removed.join(" and ") : "no block"}, none left; largest prompt ${worst.prompt} tokens (input ${worst.input}, cache creation ${worst.creation}, cache read ${worst.read}); cap ${cap}`);
  return worst.prompt > cap ? OVER_CAP : 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    process.exit(argv.length === 0 ? 64 : 0);
  }
  try {
    process.exit(argv[0] === "preflight" ? await preflight(argv.slice(1)) : (await run(argv)).code);
  } catch (error) {
    console.error(`claude-experiment: ${error.message}`);
    process.exit(64);
  }
}
