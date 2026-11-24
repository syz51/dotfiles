// Isolated live check for the computer-use MCP server: starts its own
// `bun server/desktop.js` over stdio with DESKTOP_MCP_STATE set to a temporary
// folder, runs request_access, a click, a scripted Stop button click and a
// scripted Esc press through that server, removes the temporary folder, and
// verifies that the real ~/.local/state/desktop-mcp folder is unchanged.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dialogReason, sensitiveReason, SERVER_NAME, stateDirFor, userStopPath } from "./desktop.js";

export const DESKTOP_SERVER = join(import.meta.dir, "desktop.js");
export const PROBE_SOURCE = join(import.meta.dir, "live-check-probe.swift");
const STOPPED_PREFIX = "The user stopped computer use.";
const DOCK = "com.apple.dock";
const FINDER = "com.apple.finder";
const LOGINWINDOW = "com.apple.loginwindow";
const FALLBACK_APP = "Calculator";

const USAGE = `Usage: bun claude/marketplace/computer-use/server/live-check.js [options]

Starts an isolated desktop.js MCP server with DESKTOP_MCP_STATE set to a
temporary folder, verifies request_access, click, scripted Stop and scripted
Esc, and checks that ~/.local/state/desktop-mcp is unchanged afterwards.

Options:
  --app <name>          App name or bundle id to approve and click (default: auto-pick a visible non-dialog app, else Calculator)
  --x <px> --y <px>     Explicit screenshot pixel coordinates for the click
  --timeout-ms <ms>     Per-step timeout in milliseconds (default: 25000)
  -h, --help            Show this message
`;

export function parseArgs(argv) {
  const options = { timeoutMs: 25_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      return options;
    }
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}.`);
      return argv[++i];
    };
    if (arg === "--app") {
      options.app = next();
    } else if (arg === "--x") {
      options.x = Number(next());
    } else if (arg === "--y") {
      options.y = Number(next());
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(next());
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.app !== undefined && (!options.app || typeof options.app !== "string")) {
    throw new Error("--app must be a non-empty app name or bundle id.");
  }
  if ((options.x !== undefined) !== (options.y !== undefined)) throw new Error("Provide both --x and --y together.");
  if (options.x !== undefined && (!Number.isFinite(options.x) || options.x < 0 || !Number.isFinite(options.y) || options.y < 0)) {
    throw new Error("--x and --y must be non-negative numbers.");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100) {
    throw new Error("--timeout-ms must be at least 100.");
  }
  return options;
}

/** Real state folder(s) that a live check must never modify. */
export function realStateDirs(env = process.env) {
  const dirs = [resolve(stateDirFor({}))];
  const xdg = resolve(stateDirFor({ XDG_STATE_HOME: env.XDG_STATE_HOME }));
  if (!dirs.includes(xdg)) dirs.unshift(xdg);
  return dirs;
}

/** Captures the full recursive contents and metadata of a state folder. */
export function snapshotDir(dir) {
  if (!existsSync(dir)) return { exists: false, entries: {} };
  const entries = {};
  const walk = (current, prefix) => {
    const names = readdirSync(current).sort();
    for (const name of names) {
      const full = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        entries[rel] = { kind: "symlink", target: readlinkSync(full) };
      } else if (st.isDirectory()) {
        entries[rel] = { kind: "dir" };
        walk(full, rel);
      } else if (st.isFile()) {
        const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
        entries[rel] = { kind: "file", size: st.size, mtimeMs: st.mtimeMs, sha256 };
      } else {
        entries[rel] = { kind: "other" };
      }
    }
  };
  walk(dir, "");
  return { exists: true, entries };
}

/** Returns human-readable differences between two directory snapshots (empty if identical). */
export function diffSnapshots(before, after) {
  const diffs = [];
  if (!before.exists && !after.exists) return diffs;
  if (!before.exists && after.exists) {
    diffs.push("directory was created");
    for (const key of Object.keys(after.entries).sort()) diffs.push(`added: ${key}`);
    return diffs;
  }
  if (before.exists && !after.exists) {
    diffs.push("directory was removed");
    return diffs;
  }
  const keys = [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].sort();
  for (const key of keys) {
    const a = before.entries[key];
    const b = after.entries[key];
    if (!a) {
      diffs.push(`added: ${key}`);
    } else if (!b) {
      diffs.push(`removed: ${key}`);
    } else if (
      a.kind !== b.kind
      || a.target !== b.target
      || a.size !== b.size
      || a.sha256 !== b.sha256
      || a.mtimeMs !== b.mtimeMs
    ) {
      diffs.push(`changed: ${key}`);
    }
  }
  return diffs;
}

const containsPoint = (rect, x, y) => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
const covers = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y
  && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;

function matchesApp(app, query) {
  if (!app) return false;
  const q = query.toLowerCase();
  return (app.name ?? "").toLowerCase() === q || (app.bundleId ?? "").toLowerCase() === q;
}

function isFinderQuery(query) {
  const q = query.toLowerCase();
  return q === "finder" || q === FINDER;
}

/**
 * Picks a safe, unobstructed global display point on `mainDisplay` belonging to
 * `appName`, avoiding the bottom-right stop panel zone. Returns null when no
 * unobstructed point is visible yet (caller may call open_app and retry).
 */
export function pickTargetPoint(sceneInfo, appName) {
  const display = sceneInfo?.mainDisplay;
  if (!display) return null;
  const windows = sceneInfo.windows ?? [];
  const dockLevel = sceneInfo.dockLevel;
  const panelZone = {
    x: display.x + display.width - 450,
    y: display.y + display.height - 120,
    width: 450,
    height: 120,
  };
  const inPanelZone = (x, y) => containsPoint(panelZone, x, y);

  // Mirrors desktop.js chooseApp's front-to-back window traversal.
  const topWindowAt = (x, y) => {
    for (const win of windows) {
      if (win.alpha === 0 || !containsPoint(win.bounds, x, y)) continue;
      if (win.windowServer) {
        if (win.name === "Menubar") return win;
        continue;
      }
      if (!win.app) return win;
      if (win.app.bundleId === DOCK && win.layer === dockLevel && covers(win.bounds, display)) continue;
      return win;
    }
    return null;
  };

  // 1. Prefer an unobstructed point on an ordinary window of the target app.
  for (const win of windows) {
    if (win.alpha === 0 || win.layer !== 0 || !matchesApp(win.app, appName)) continue;
    const x1 = Math.max(display.x + 8, win.bounds.x);
    const y1 = Math.max(display.y + 30, win.bounds.y);
    const x2 = Math.min(display.x + display.width - 8, win.bounds.x + win.bounds.width);
    const y2 = Math.min(display.y + display.height - 8, win.bounds.y + win.bounds.height);
    if (x2 - x1 < 40 || y2 - y1 < 30) continue;

    const candidates = [];
    // Harmless titlebar area first (avoiding left traffic-light buttons).
    if (x2 - x1 >= 160) {
      candidates.push({ x: Math.min(x1 + 140, (x1 + x2) / 2), y: y1 + 14 });
    }
    for (const fy of [0.25, 0.5, 0.75]) {
      for (const fx of [0.25, 0.5, 0.75]) {
        candidates.push({ x: x1 + (x2 - x1) * fx, y: y1 + (y2 - y1) * fy });
      }
    }
    for (const pt of candidates) {
      if (inPanelZone(pt.x, pt.y)) continue;
      if (topWindowAt(pt.x, pt.y) === win) return { x: pt.x, y: pt.y, kind: "window" };
    }
  }

  // 2. For Finder, bare desktop or blank menu bar (when Finder is frontmost).
  if (isFinderQuery(appName)) {
    const x1 = display.x + Math.min(90, display.width * 0.1);
    const x2 = display.x + display.width - Math.min(90, display.width * 0.1);
    const y1 = display.y + Math.min(60, display.height * 0.1);
    const y2 = display.y + display.height - Math.min(130, display.height * 0.2);
    if (x2 > x1 && y2 > y1) {
      for (const fy of [0.2, 0.5, 0.8]) {
        for (const fx of [0.2, 0.5, 0.8]) {
          const x = x1 + (x2 - x1) * fx;
          const y = y1 + (y2 - y1) * fy;
          if (inPanelZone(x, y)) continue;
          if (topWindowAt(x, y) === null) return { x, y, kind: "desktop" };
        }
      }
    }

    if (matchesApp(sceneInfo.frontmost, FINDER) || matchesApp(sceneInfo.frontmost, "Finder")) {
      const menubar = windows.find((win) => win.alpha > 0 && win.windowServer && win.name === "Menubar"
        && win.bounds.x < display.x + display.width && win.bounds.x + win.bounds.width > display.x);
      if (menubar) {
        const y = menubar.bounds.y + Math.min(12, menubar.bounds.height / 2);
        const minMenuX = display.width >= 1000 ? display.x + 360 : display.x + display.width * 0.35;
        for (const frac of [0.45, 0.55, 0.38, 0.62]) {
          const x = display.x + display.width * frac;
          if (x < minMenuX || x >= display.x + display.width - 80) continue;
          if (topWindowAt(x, y) === menubar) return { x, y, kind: "menubar" };
        }
      }
    }
  }

  return null;
}

/**
 * Chooses a default non-dialog, non-sensitive app for an unattended live check:
 * prefers an already-visible ordinary window on the main display (excluding Finder,
 * which may require a dialog), otherwise falls back to Calculator.
 */
export function pickDefaultApp(sceneInfo) {
  for (const win of sceneInfo?.windows ?? []) {
    if (win.alpha === 0 || win.layer !== 0 || !win.app) continue;
    const id = (win.app.bundleId ?? "").toLowerCase();
    const name = win.app.name ?? "";
    if (!name && !id) continue;
    if (id === FINDER || name.toLowerCase() === "finder") continue;
    if (sensitiveReason(win.app) || dialogReason(win.app)) continue;
    const candidate = win.app.bundleId || name;
    if (pickTargetPoint(sceneInfo, candidate)) return candidate;
  }
  return FALLBACK_APP;
}

/** Converts a global display point on `display` to screenshot pixel coordinates. */
export function displayToScreenshot(display, shot, pt) {
  if (pt.x < display.x || pt.y < display.y || pt.x >= display.x + display.width || pt.y >= display.y + display.height) {
    throw new Error(`Point (${pt.x}, ${pt.y}) is outside display bounds.`);
  }
  const x = Math.min(shot.width - 0.5, Math.max(0, ((pt.x - display.x) * shot.width) / display.width));
  const y = Math.min(shot.height - 0.5, Math.max(0, ((pt.y - display.y) * shot.height) / display.height));
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

/** Parses screenshot dimensions from desktop.js's screenshot tool reply. */
export function parseScreenshotSize(text) {
  const match = /\b(\d+)x(\d+)\s+px\b/.exec(text ?? "");
  if (!match) throw new Error(`Could not parse screenshot dimensions from reply: ${JSON.stringify(text)}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Finds the live desktop-helper overlay child PID spawned by `serverPid`. */
export function findOverlayPid(serverPid) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return null;
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cmd = match[3];
    if (ppid === serverPid && /desktop-helper-[0-9a-f]+/.test(cmd) && /\boverlay\b/.test(cmd)) {
      return pid;
    }
  }
  return null;
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Compiles live-check-probe.swift into `tempDir` and returns a typed runner. */
export function compileProbe(tempDir, source = PROBE_SOURCE) {
  const binary = join(tempDir, "live-check-probe");
  const build = spawnSync("xcrun", ["swiftc", "-O", "-swift-version", "5", source, "-o", binary], { encoding: "utf8" });
  if (build.status !== 0) {
    throw new Error(`Could not compile live-check-probe.swift: ${build.stderr || build.error?.message}`);
  }
  const run = (args) => {
    const result = spawnSync(binary, args, { encoding: "utf8", timeout: 15_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`live-check-probe ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    return JSON.parse(result.stdout);
  };
  return {
    permissions: () => run(["permissions"]),
    sceneInfo: () => run(["scene-info"]),
    findPanel: (pid) => run(["find-panel", String(pid)]),
    clickUnmarked: (x, y) => run(["click-unmarked", String(x), String(y)]),
    escUnmarked: () => run(["esc-unmarked"]),
  };
}

/** Minimal newline-delimited JSON-RPC 2.0 client for a stdio MCP server. */
export function createMcpClient({ command, args, env, timeoutMs = 25_000 }) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1;
  let buffer = "";
  let stderrText = "";
  let exited = false;
  let exitInfo = null;
  const pending = new Map();

  const rejectAll = (error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  };

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrText = (stderrText + chunk).slice(-8192);
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
      } else {
        entry.resolve(message.result);
      }
    }
  });

  const exitPromise = new Promise((resolveExit) => {
    child.on("exit", (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      rejectAll(new Error(`MCP server exited (${signal ?? `code ${code}`}).${stderrText ? ` stderr: ${stderrText.trim()}` : ""}`));
      resolveExit(exitInfo);
    });
    child.on("error", (error) => {
      exited = true;
      exitInfo = { error };
      rejectAll(error);
      resolveExit(exitInfo);
    });
  });

  function request(method, params = {}, callTimeoutMs = timeoutMs) {
    if (exited) return Promise.reject(new Error("MCP server already exited."));
    const id = nextId++;
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectReq(new Error(`Timed out after ${callTimeoutMs}ms waiting for ${method}.${stderrText ? ` stderr: ${stderrText.trim()}` : ""}`));
      }, callTimeoutMs);
      pending.set(id, { resolve: resolveReq, reject: rejectReq, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  function notify(method, params = {}) {
    if (!exited) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async function callTool(name, toolArgs = {}, callTimeoutMs = timeoutMs) {
    const result = await request("tools/call", { name, arguments: toolArgs }, callTimeoutMs);
    const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { error: result.isError === true, text, result };
  }

  async function close() {
    if (exited) return exitInfo;
    try {
      child.stdin.end();
    } catch {
      // ignore broken pipe on shutdown
    }
    const graceful = await Promise.race([
      exitPromise.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 3_000)),
    ]);
    if (!graceful && !exited) {
      try { child.kill("SIGTERM"); } catch {}
      const termed = await Promise.race([
        exitPromise.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 1_000)),
      ]);
      if (!termed && !exited) {
        try { child.kill("SIGKILL"); } catch {}
        await exitPromise;
      }
    }
    return exitInfo;
  }

  function killNow() {
    if (!exited) {
      try { child.kill("SIGTERM"); } catch {}
    }
  }

  return { pid: child.pid, request, notify, callTool, stderr: () => stderrText, close, killNow };
}

async function pollUntil(fn, { timeoutMs, intervalMs = 50, sleep, label }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(intervalMs);
  }
}

/**
 * Runs the full isolated live check: request_access, click, scripted Stop,
 * scripted Esc, cleanup, and strict before/after check of the real state folder.
 */
export async function runLiveCheck({
  app,
  x,
  y,
  timeoutMs = 25_000,
  env = process.env,
  serverCommand = [process.execPath, DESKTOP_SERVER],
  createProbe = (tempDir) => compileProbe(tempDir),
  findOverlay = findOverlayPid,
  isAlive = defaultIsAlive,
  realDirs = realStateDirs(env),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  overlaySettleMs = 150,
  tempRoot = tmpdir(),
} = {}) {
  const checkAllowedApp = (target) => {
    const candidate = { name: target, bundleId: target };
    const sensitive = sensitiveReason(candidate);
    if (sensitive) throw new Error(`Cannot run unattended live check against ${target}: ${sensitive}.`);
    const needsDialog = dialogReason(candidate);
    if (needsDialog) throw new Error(`Cannot run unattended live check against ${target}: it always needs a dialog (${needsDialog}).`);
  };
  if (app !== undefined) checkAllowedApp(app);

  const beforeSnapshots = new Map(realDirs.map((dir) => [dir, snapshotDir(dir)]));
  const tempDir = mkdtempSync(join(tempRoot, "desktop-mcp-live-"));
  const resolvedTemp = resolve(tempDir);
  if (realDirs.some((dir) => resolve(dir) === resolvedTemp)) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Temporary state folder ${tempDir} collides with a real state folder.`);
  }

  let client;
  let primaryError;
  let report;
  const onSignal = (signal) => {
    client?.killNow();
    rmSync(tempDir, { recursive: true, force: true });
    process.stderr.write(`live-check interrupted by ${signal}\n`);
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const probe = await createProbe(tempDir);
    const perms = probe.permissions();
    if (!perms.screenRecording || !perms.accessibility) {
      throw new Error(
        `Missing macOS grants (screenRecording=${perms.screenRecording}, accessibility=${perms.accessibility}). `
        + "Run from an app granted Screen Recording and Accessibility (see README.md).",
      );
    }

    const initialScene = probe.sceneInfo();
    if (initialScene.frontmost?.bundleId === LOGINWINDOW) {
      throw new Error("The Mac's screen is locked (loginwindow is frontmost); unlock it before running the live check.");
    }

    const targetApp = app ?? pickDefaultApp(initialScene);
    checkAllowedApp(targetApp);

    const serverEnv = { ...env, DESKTOP_MCP_STATE: tempDir };
    delete serverEnv.DESKTOP_MCP_POLICY;

    const [command, ...args] = serverCommand;
    client = createMcpClient({ command, args, env: serverEnv, timeoutMs });

    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "computer-use-live-check", version: "0.1.0" },
    });
    if (init?.serverInfo?.name !== SERVER_NAME) {
      throw new Error(`Expected server "${SERVER_NAME}", got ${JSON.stringify(init?.serverInfo?.name)}.`);
    }
    client.notify("notifications/initialized");

    const waitForPanel = async (label) => {
      const overlayPid = await pollUntil(() => findOverlay(client.pid, tempDir), {
        timeoutMs: Math.min(timeoutMs, 10_000),
        sleep,
        label: `${label} overlay process`,
      });
      const panel = await pollUntil(() => {
        const res = probe.findPanel(overlayPid);
        return res?.found ? res : null;
      }, {
        timeoutMs: Math.min(timeoutMs, 10_000),
        sleep,
        label: `${label} panel window`,
      });
      if (overlaySettleMs > 0) await sleep(overlaySettleMs);
      return { overlayPid, bounds: panel.bounds };
    };

    // 1. request_access (isolated temp state -> auto approval, no dialog).
    const access1 = await client.callTool("request_access", {
      apps: [targetApp],
      reason: "Isolated computer-use live check (Stop and Esc).",
    });
    if (access1.error || !access1.text.includes("Approved:") || !access1.text.includes("No dialog was shown")) {
      throw new Error(`request_access failed: ${access1.text}`);
    }
    const lockPath = join(tempDir, "session.json");
    if (!existsSync(lockPath)) throw new Error(`Expected session lock in temp state folder ${tempDir}.`);
    const lockHolder = JSON.parse(readFileSync(lockPath, "utf8"))?.pid;
    if (lockHolder !== client.pid) {
      throw new Error(`Expected temp session.json pid ${client.pid}, got ${lockHolder}.`);
    }
    if (!existsSync(join(tempDir, "approvals.log"))) {
      throw new Error(`Expected approvals.log in temp state folder ${tempDir}.`);
    }

    // 2. screenshot + click in the approved app.
    let clickPoint;
    let targetKind = "explicit";
    if (x !== undefined && y !== undefined) {
      const shot = await client.callTool("screenshot", { display: 0 });
      if (shot.error) throw new Error(`screenshot failed: ${shot.text}`);
      clickPoint = { x, y };
    } else {
      let scene = initialScene;
      let target = pickTargetPoint(scene, targetApp);
      if (!target) {
        const opened = await client.callTool("open_app", { app: targetApp });
        if (opened.error) throw new Error(`open_app(${targetApp}) failed: ${opened.text}`);
        const found = await pollUntil(() => {
          scene = probe.sceneInfo();
          return pickTargetPoint(scene, targetApp);
        }, { timeoutMs: Math.min(timeoutMs, 5_000), intervalMs: 100, sleep, label: `visible target for ${targetApp}` });
        target = found;
      }
      targetKind = target.kind;
      const shot = await client.callTool("screenshot", { display: 0 });
      if (shot.error) throw new Error(`screenshot failed: ${shot.text}`);
      const shotSize = parseScreenshotSize(shot.text);
      clickPoint = displayToScreenshot(scene.mainDisplay, shotSize, target);
    }

    const clickResult = await client.callTool("click", { x: clickPoint.x, y: clickPoint.y, display: 0 });
    if (clickResult.error || !clickResult.text.startsWith("Clicked in ")) {
      throw new Error(`click failed at (${clickPoint.x}, ${clickPoint.y}): ${clickResult.text}`);
    }

    // 3. Scripted Stop: click the panel's Stop (Esc) button from the separate probe process.
    const stopPanel = await waitForPanel("Stop");
    const stopX = stopPanel.bounds.x + stopPanel.bounds.width - 60;
    const stopY = stopPanel.bounds.y + stopPanel.bounds.height / 2;
    probe.clickUnmarked(stopX, stopY);
    await pollUntil(() => !isAlive(stopPanel.overlayPid), {
      timeoutMs: Math.min(timeoutMs, 10_000),
      sleep,
      label: "Stop overlay exit",
    });

    const afterStop = await client.callTool("screenshot", { display: 0 });
    if (!afterStop.error || !afterStop.text.includes(STOPPED_PREFIX)) {
      throw new Error(`Expected user-stopped error after Stop click, got: ${afterStop.text}`);
    }
    const tempUserStop = userStopPath(tempDir);
    if (!existsSync(tempUserStop)) throw new Error(`Expected ${tempUserStop} to be written after Stop click.`);
    if (existsSync(lockPath)) throw new Error("Expected temp session.json to be removed after Stop click.");

    // 4. Scripted Esc: clear only the temp user-stopped record, re-approve, and post unmarked Esc.
    rmSync(tempUserStop, { force: true });
    const access2 = await client.callTool("request_access", {
      apps: [targetApp],
      reason: "Isolated computer-use live check (Esc).",
    });
    if (access2.error || !access2.text.includes("Approved:") || !access2.text.includes("No dialog was shown")) {
      throw new Error(`second request_access failed: ${access2.text}`);
    }

    const escPanel = await waitForPanel("Esc");
    probe.escUnmarked();
    await pollUntil(() => !isAlive(escPanel.overlayPid), {
      timeoutMs: Math.min(timeoutMs, 10_000),
      sleep,
      label: "Esc overlay exit",
    });

    const afterEsc = await client.callTool("screenshot", { display: 0 });
    if (!afterEsc.error || !afterEsc.text.includes(STOPPED_PREFIX)) {
      throw new Error(`Expected user-stopped error after Esc press, got: ${afterEsc.text}`);
    }
    if (!existsSync(tempUserStop)) throw new Error(`Expected ${tempUserStop} to be written after Esc press.`);
    if (existsSync(lockPath)) throw new Error("Expected temp session.json to be removed after Esc press.");

    report = {
      ok: true,
      app: targetApp,
      checks: {
        requestAccess: "approved without dialog in isolated temp state",
        click: `${clickResult.text} (${targetKind} at ${clickPoint.x},${clickPoint.y})`,
        stop: afterStop.text,
        esc: afterEsc.text,
        realStateUnchanged: realDirs,
      },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (client) await client.close();
    rmSync(tempDir, { recursive: true, force: true });

    const realDiffs = [];
    for (const dir of realDirs) {
      const diffs = diffSnapshots(beforeSnapshots.get(dir), snapshotDir(dir));
      for (const diff of diffs) realDiffs.push(`${dir}: ${diff}`);
    }
    if (realDiffs.length > 0) {
      const message = `Real desktop-mcp state folder changed during live check:\n  ${realDiffs.join("\n  ")}`;
      if (primaryError) {
        primaryError = new Error(`${primaryError.message}\n${message}`);
      } else {
        primaryError = new Error(message);
      }
    }
  }

  if (primaryError) throw primaryError;
  return report;
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const result = await runLiveCheck(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`live-check failed: ${error.message}\n`);
    process.exit(1);
  }
}
