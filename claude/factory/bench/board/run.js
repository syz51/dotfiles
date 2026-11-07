// One board-format run: a fresh fixture repository, a fresh `board serve` on a free
// loopback port with its own database and device token, the scenario's board state, then
// a multi-turn Claude Code session whose hooks and MCP server point at that server only.
// Sessions run on the subscription through plain `claude`, never the API wrapper, and
// every run checks that Claude Code reported no API key.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { claudeTempDir, removeSessionArtifacts } from "../../../tests/lib/cleanup.js";
import { userMessage } from "../../../tests/lib/conversation.js";
import { childEnv, runProcess } from "../../../tests/lib/process.js";
import { parseStream, partialEvents } from "../../../tests/lib/stream.js";
import { benchSettings, observedModels } from "../runner.js";
import { measure } from "./measure.js";
import { FILES, ORIGIN, TURNS, blockMatches, peerTouch, plantHandoff, seedCommands } from "./scenario.js";

// Plain `claude`: subscription auth. BOARD_BENCH_CLAUDE replaces it in tests.
export function claudeBin(env = process.env) {
  const bin = env.BOARD_BENCH_CLAUDE || "claude";
  if (basename(bin) === "claude-api") throw new Error("The board benchmark runs on the subscription only; claude-api bills the API");
  return bin;
}

const OFFLINE = { UV_OFFLINE: "1", UV_PYTHON_DOWNLOADS: "never", CARGO_NET_OFFLINE: "true", PYTHONDONTWRITEBYTECODE: "1" };
// Credentials and board settings a run must never inherit: API keys would bill the API,
// and board variables would reach the user's real server or database.
const INHERITED = /^(?:ANTHROPIC_\w*|BOARD_\w*|CLAUDE_CODE_USE_\w+)$/;
export const isolatedEnv = (base, overrides = {}) => childEnv(
  Object.fromEntries(Object.entries(base).filter(([name]) => !INHERITED.test(name))), overrides);

const HOOK_EVENTS = [
  ["SessionStart", "startup|resume|clear|compact"], ["UserPromptSubmit"], ["PostToolUse", "*"],
  ["Stop"], ["StopFailure", "rate_limit"], ["SessionEnd"], ["PreCompact", "manual|auto"],
];

// --settings for a run: the live suites' install block and web denial, plus the board's
// Claude Code hooks (as `board install` writes them) pointing at boardBin.
export function sessionSettings(boardBin) {
  const settings = benchSettings();
  for (const [event, matcher] of HOOK_EVENTS)
    (settings.hooks[event] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `"${boardBin}" hook ${event} --runtime claude`, timeout: 5 }] });
  return settings;
}

export const mcpConfig = (boardBin, agent, env) => ({ mcpServers: { board: { command: boardBin, args: ["mcp", "--agent", agent], env } } });

export const serverConfig = (db, port) => `db = ${JSON.stringify(db)}\nlisten = "127.0.0.1:${port}"\n`;
export const clientConfig = (port, { format, framing }) =>
  `server = "http://127.0.0.1:${port}"\ndevice = "bench"\n\n[experimental]\ntext_format = "${format}"\npeer_framing = "${framing}"\n`;

function freePort() {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

function git(args, cwd) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.trim()}`);
  return run.stdout;
}

// The fixture repository, with origin's pushes going to a local bare repository.
export function makeFixture(repo, remote) {
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(["init", "-q", "--bare", remote], dirname(remote));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.name", "bench"], repo);
  git(["config", "user.email", "bench@example.invalid"], repo);
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "Initial commit"], repo);
  git(["remote", "add", "origin", ORIGIN], repo);
  git(["remote", "set-url", "--push", "origin", remote], repo);
}

// Runs `board --agent agent ...args`, with input as JSON on stdin; fails on a nonzero exit.
function board(boardBin, env, cwd, [agent, args, input]) {
  const run = spawnSync(boardBin, ["--agent", agent, ...args], { cwd, env, encoding: "utf8", input: input ? JSON.stringify(input) : "", timeout: 30_000 });
  if (run.status !== 0) throw new Error(`board ${args.join(" ")}: exit ${run.status}: ${(run.stderr || run.stdout).trim().slice(0, 500)}`);
  return run.stdout;
}

async function waitHealthy(port, server, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`board serve exited with ${server.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100);
  }
  throw new Error(`board serve did not answer on port ${port} within ${timeoutMs} ms`);
}

// A turn's result that says the session hit a usage limit: the run is void and the
// matrix must stop.
export const isLimit = (result) => result?.is_error === true
  && (result.api_error_status === 429 || /usage limit|rate limit|limit reached|resets? (at|in)/i.test(String(result.result ?? "")));

// Sends the scenario's turns one after another, running each turn's board step first;
// stops after a failed turn.
function turnDriver(steps) {
  return (stdin) => {
    let next = 0;
    const send = () => {
      const turn = TURNS[next++];
      if (turn.before) steps[turn.before]();
      stdin.write(userMessage(turn.prompt));
    };
    send();
    let pending = "";
    return (text) => {
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          throw new Error(`Malformed stream line: ${line.slice(0, 200)}`);
        }
        if (event.type !== "result" || stdin.writableEnded) continue;
        if (event.is_error || next >= TURNS.length) stdin.end();
        else send();
      }
    };
  };
}

// Runs one session of a cell and returns its record. Infrastructure failures (setup,
// API errors, limits, the wrong model, API billing) are marked infra; limited also stops
// the matrix.
// streamDir, when set, keeps the session's stream as <runId>.jsonl for checking the
// measures; it holds transcript text, so it belongs in the state folder only.
const ROOT_PREFIX = "board-bench-";

// What an interrupted run left: processes whose command line names a run root (its
// server and session; the board MCP server ends with its session), the roots, and their
// Claude Code session entries. Only for when no run is in progress. Returns the roots.
export function cleanLeftovers(dir = tmpdir()) {
  const roots = readdirSync(dir).filter((name) => name.startsWith(ROOT_PREFIX) && !name.startsWith(`${ROOT_PREFIX}tokens-`))
    .map((name) => realpathSync(join(dir, name)));
  for (const root of roots) spawnSync("pkill", ["-KILL", "-f", root]);
  removeSessionArtifacts({ bases: [join(homedir(), ".claude", "projects"), claudeTempDir()], roots });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  return roots;
}

export async function runOne(cell, { model, effort, trial, runId, series, boardBin, cliVersion = null, timeoutMs = 1_800_000, streamDir }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const sessionId = crypto.randomUUID();
  const me = `claude:${sessionId}`;
  const record = {
    runId, series, cell: cell.id, format: cell.format, framing: cell.framing, model, effort, trial,
    at: new Date().toISOString(), cliVersion, modelObserved: null, subscription: null, blockOk: null,
    error: null, infra: false, limited: false, durationMs: null, nextTask: null,
  };
  let server;
  // What failed, for an error that ends the run: setup, or a board step between turns.
  let phase = "setup";
  try {
    mkdirSync(repo);
    mkdirSync(home);
    makeFixture(repo, join(root, "remote.git"));
    const port = freePort();
    const db = join(root, "board.db");
    writeFileSync(join(root, "server.toml"), serverConfig(db, port));
    const env = isolatedEnv(process.env, { BOARD_HOME: home, BOARD_KEYCHAIN: "0" });
    const device = spawnSync(boardBin, ["admin", "device", "bench", "--db", db], { env, encoding: "utf8", timeout: 30_000 });
    const token = device.stdout.split("\n")[0].trim();
    if (device.status !== 0 || !token) throw new Error(`board admin device: exit ${device.status}: ${device.stderr.trim()}`);
    writeFileSync(join(home, "config.toml"), clientConfig(port, cell));
    writeFileSync(join(home, "token"), token);
    chmodSync(join(home, "token"), 0o600);
    server = spawn(boardBin, ["serve", "--config", join(root, "server.toml")], { env, stdio: "ignore", detached: true });
    await waitHealthy(port, server);
    for (const command of seedCommands({ me, sessionId, repo })) board(boardBin, env, repo, command);

    const settings = join(root, "settings.json");
    writeFileSync(settings, JSON.stringify(sessionSettings(boardBin)));
    const mcp = join(root, "mcp.json");
    writeFileSync(mcp, JSON.stringify(mcpConfig(boardBin, me, { BOARD_HOME: home, BOARD_KEYCHAIN: "0" })));
    const argv = [claudeBin(), "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--include-hook-events", "--model", model, "--effort", effort, "--permission-mode", "bypassPermissions",
      "--settings", settings, "--strict-mcp-config", "--mcp-config", mcp, "--session-id", sessionId];
    const sessionEnv = isolatedEnv(process.env, {
      ...OFFLINE, BOARD_HOME: home, BOARD_KEYCHAIN: "0", CLAUDE_CODE_TMPDIR: root, TMPDIR: root,
      // Turns off board hooks in the user's own settings (claude/hooks/board-hook.sh),
      // which would inject a second, production-style snapshot from this run's server.
      AGENT_BOARD_HOOKS: "off",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    const steps = {
      peerTouch: () => peerTouch(repo, me, sessionId).forEach((command) => board(boardBin, env, repo, command)),
      plantHandoff: () => plantHandoff(me).reduce((output, command) => {
        if (typeof command !== "function") return board(boardBin, env, repo, command);
        const claim = command(output);
        record.nextTask = claim[1][1];
        return board(boardBin, env, repo, claim);
      }, ""),
    };
    const started = Date.now();
    phase = "board step";
    let events;
    let stdout;
    try {
      const run = await runProcess(argv, { cwd: repo, env: sessionEnv, timeout: timeoutMs, interact: turnDriver(steps) });
      stdout = run.stdout;
      events = parseStream(stdout);
    } catch (error) {
      if (!/^Process timeout/.test(error.message ?? "")) throw error;
      stdout = error.stdout ?? "";
      events = partialEvents(stdout);
      record.error = `session timed out after ${timeoutMs} ms`;
      record.infra = true;
    }
    record.durationMs = Date.now() - started;
    if (streamDir) {
      mkdirSync(streamDir, { recursive: true });
      writeFileSync(join(streamDir, `${runId}.jsonl`), stdout);
    }

    const inits = events.filter((event) => event.type === "system" && event.subtype === "init");
    record.subscription = inits.length > 0 && inits.every((event) => event.apiKeySource === "none");
    const results = events.filter((event) => event.type === "result");
    const failed = results.find((result) => result.is_error || result.subtype !== "success");
    const models = observedModels(events);
    record.modelObserved = models.join(",") || null;
    const remoteRefs = git(["for-each-ref", "--format=%(refname)"], join(root, "remote.git")).split("\n").filter(Boolean);
    const measures = measure(events, { canaryFileExists: existsSync(join(repo, "CANARY_HOOK")), remoteRefs });
    const { startBlock, showResult, ...rest } = measures;
    Object.assign(record, rest, {
      blockOk: startBlock ? blockMatches(startBlock, cell) : false,
      startBlockChars: startBlock?.length ?? null,
      showResultChars: showResult?.length ?? null,
    });
    record.samples = { startBlock, showResult };
    if (record.infra) {
      // Timed out: partial measures would bias the cell, so the run is void.
    } else if (!record.subscription) {
      record.error = `Claude Code reported apiKeySource ${JSON.stringify(inits.map((event) => event.apiKeySource))}, not the subscription`;
      record.infra = true;
    } else if (failed) {
      record.limited = isLimit(failed);
      record.error = `turn ${results.indexOf(failed) + 1} ended with ${failed.subtype}${failed.api_error_status ? ` (HTTP ${failed.api_error_status})` : ""}: ${String(failed.result ?? "").slice(0, 200)}`;
      record.infra = true;
    } else if (results.length < TURNS.length && !record.error) {
      record.error = `the session ended after ${results.length} of ${TURNS.length} turns`;
      record.infra = true;
    } else if (models.length && models.some((observed) => observed !== model && !observed.startsWith(`${model}-`))) {
      record.error = `requested ${model} but the session ran ${models.join(", ")}`;
      record.infra = true;
    } else if (!record.blockOk) {
      record.error = "the session-start snapshot is not in the cell's format and framing";
      record.infra = true;
    } else if (record.boardBlocks !== 1) {
      record.error = `${record.boardBlocks} board blocks at session start: another board hook ran`;
      record.infra = true;
    }
    return record;
  } catch (error) {
    record.error = `${phase}: ${error.message}`;
    record.infra = true;
    return record;
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        server.kill("SIGKILL");
      }
      // The server holds the database open in root; wait before removing it.
      await exited;
    }
    removeSessionArtifacts({ bases: [join(homedir(), ".claude", "projects"), claudeTempDir()], roots: [root], sessions: [{ cwd: repo, id: sessionId }] });
    rmSync(root, { recursive: true, force: true });
  }
}
