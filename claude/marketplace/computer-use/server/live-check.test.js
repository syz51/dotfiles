import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMcpClient,
  DESKTOP_SERVER,
  diffSnapshots,
  displayToScreenshot,
  parseArgs,
  parseScreenshotSize,
  pickDefaultApp,
  pickTargetPoint,
  PROBE_SOURCE,
  realStateDirs,
  runLiveCheck,
  snapshotDir,
} from "./live-check.js";

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080, pixelWidth: 1920, pixelHeight: 1080, scale: 1 };
const FINDER = { name: "Finder", bundleId: "com.apple.finder", pid: 20 };
const HELIUM = { name: "Helium", bundleId: "net.imput.helium", pid: 82 };
const DOCK = { name: "Dock", bundleId: "com.apple.dock", pid: 30 };
const T3 = { name: "T3 Code", bundleId: "com.t3tools.t3code", pid: 90 };

const win = (app, bounds, overrides = {}) => ({
  owner: app.name,
  name: "",
  layer: 0,
  alpha: 1,
  bounds,
  pid: app.pid,
  windowServer: false,
  app,
  ...overrides,
});

describe("parseArgs", () => {
  test("uses sensible defaults and parses explicit options", () => {
    expect(parseArgs([])).toEqual({ timeoutMs: 25_000 });
    expect(parseArgs(["--app", "Helium", "--x", "120", "--y", "340", "--timeout-ms", "5000"])).toEqual({
      app: "Helium",
      x: 120,
      y: 340,
      timeoutMs: 5000,
    });
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  test("rejects incomplete or invalid flags", () => {
    expect(() => parseArgs(["--x", "10"])).toThrow("Provide both --x and --y");
    expect(() => parseArgs(["--x", "-1", "--y", "10"])).toThrow("non-negative");
    expect(() => parseArgs(["--app"])).toThrow("Missing value");
    expect(() => parseArgs(["--bogus"])).toThrow("Unknown argument");
  });
});

describe("snapshotDir and diffSnapshots", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "live-check-snap-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("treats missing or identical directories as unchanged", () => {
    const missing = join(root, "does-not-exist");
    expect(diffSnapshots(snapshotDir(missing), snapshotDir(missing))).toEqual([]);

    const state = join(root, "state");
    mkdirSync(state);
    writeFileSync(join(state, "approvals.log"), "{\"ok\":true}\n");
    symlinkSync("approvals.log", join(state, "latest.log"));
    expect(diffSnapshots(snapshotDir(state), snapshotDir(state))).toEqual([]);
  });

  test("detects created directory, added user-stopped, edits and deletions", () => {
    const missing = join(root, "new-state");
    const beforeMissing = snapshotDir(missing);
    mkdirSync(missing);
    writeFileSync(join(missing, "user-stopped"), "{}\n");
    expect(diffSnapshots(beforeMissing, snapshotDir(missing))).toEqual([
      "directory was created",
      "added: user-stopped",
    ]);

    const before = snapshotDir(missing);
    writeFileSync(join(missing, "user-stopped"), "{\"pid\":1}\n");
    writeFileSync(join(missing, "session.json"), "{\"pid\":1}");
    expect(diffSnapshots(before, snapshotDir(missing))).toEqual([
      "added: session.json",
      "changed: user-stopped",
    ]);

    rmSync(join(missing, "user-stopped"));
    expect(diffSnapshots(before, snapshotDir(missing))).toEqual([
      "added: session.json",
      "removed: user-stopped",
    ]);
  });
});

describe("target picking and coordinate mapping", () => {
  test("picks an unobstructed point on an approved app window and skips covered points", () => {
    const cover = win(T3, { x: 100, y: 100, width: 300, height: 100 });
    const helium = win(HELIUM, { x: 100, y: 100, width: 800, height: 600 });
    const pt = pickTargetPoint({ mainDisplay: DISPLAY, frontmost: T3, dockLevel: 20, windows: [cover, helium] }, "Helium");
    expect(pt).not.toBeNull();
    expect(pt.kind).toBe("window");
    // Must not land under T3's covering rectangle.
    expect(pt.x >= 400 || pt.y >= 200).toBe(true);
  });

  test("falls back to bare desktop or blank menu bar for Finder", () => {
    const fullDock = win(DOCK, { x: 0, y: 0, width: 1920, height: 1080 }, { layer: 20 });
    const bare = pickTargetPoint({ mainDisplay: DISPLAY, frontmost: T3, dockLevel: 20, windows: [fullDock] }, "Finder");
    expect(bare?.kind).toBe("desktop");

    // When a full-screen window covers the desktop, Finder uses the blank menu bar once frontmost.
    const fullWindow = win(T3, { x: 0, y: 25, width: 1920, height: 1055 });
    const menubar = {
      owner: "Window Server",
      name: "Menubar",
      layer: 24,
      alpha: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 25 },
      pid: 1,
      windowServer: true,
      app: null,
    };
    expect(pickTargetPoint({ mainDisplay: DISPLAY, frontmost: T3, dockLevel: 20, windows: [menubar, fullWindow] }, "Finder")).toBeNull();
    const barPt = pickTargetPoint({ mainDisplay: DISPLAY, frontmost: FINDER, dockLevel: 20, windows: [menubar, fullWindow] }, "Finder");
    expect(barPt?.kind).toBe("menubar");
    expect(barPt.y).toBeLessThan(25);
  });

  test("pickDefaultApp prefers a visible non-dialog app (skipping Finder) and falls back to Calculator", () => {
    const t3 = win(T3, { x: 0, y: 25, width: 600, height: 600 });
    const finder = win(FINDER, { x: 650, y: 25, width: 500, height: 500 });
    const helium = win(HELIUM, { x: 700, y: 100, width: 800, height: 600 });
    expect(pickDefaultApp({ mainDisplay: DISPLAY, frontmost: T3, dockLevel: 20, windows: [t3, finder, helium] })).toBe("net.imput.helium");
    expect(pickDefaultApp({ mainDisplay: DISPLAY, frontmost: T3, dockLevel: 20, windows: [t3, finder] })).toBe("Calculator");
  });

  test("maps global display points to screenshot pixels and parses screenshot sizes", () => {
    const shot = parseScreenshotSize("Display 0 of 2, 1330x865 px. Give coordinates in this image's pixels.");
    expect(shot).toEqual({ width: 1330, height: 865 });
    expect(displayToScreenshot({ x: 0, y: 0, width: 1470, height: 956 }, shot, { x: 735, y: 478 })).toEqual({ x: 665, y: 432.5 });
  });
});

describe("runLiveCheck end-to-end with isolated stdio server", () => {
  let root;
  let realDir;
  let fakeServer;
  let probeEvents;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "live-check-e2e-"));
    realDir = join(root, "real-desktop-mcp");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "approvals.log"), "{\"existing\":true}\n");
    probeEvents = [];

    // A real Bun stdio MCP server that behaves like desktop.js: honors DESKTOP_MCP_STATE
    // (or optionally leaks to LEAK_REAL_DIR to test detection).
    fakeServer = join(root, "fake-desktop.js");
    writeFileSync(fakeServer, `
      import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
      import { join } from "node:path";

      const stateDir = process.env.DESKTOP_MCP_STATE;
      const leakDir = process.env.LEAK_REAL_DIR || "";
      const lockPath = join(stateDir, "session.json");
      const userStopFile = join(stateDir, "user-stopped");
      const stopFile = join(stateDir, "stop-" + process.pid);
      let active = false;
      let ended = null;
      let lastApp = "App";

      function noticeStop() {
        if (existsSync(stopFile)) {
          active = false;
          rmSync(lockPath, { force: true });
          writeFileSync(userStopFile, JSON.stringify({ pid: process.pid }) + "\\n");
          if (leakDir) writeFileSync(join(leakDir, "user-stopped"), "leaked\\n");
          rmSync(stopFile, { force: true });
          ended = "The user stopped computer use. Ask the user before calling request_access again; it will show the user a dialog.";
        }
      }

      const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const req = JSON.parse(line);
          if (req.method === "initialize") {
            send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "desktop", version: "0.1.0" } } });
            continue;
          }
          if (req.id === undefined) continue;
          if (req.method === "tools/call") {
            const { name, arguments: args } = req.params;
            noticeStop();
            if (name === "request_access") {
              if (existsSync(userStopFile)) {
                send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "Not approved: dialog required." }], isError: false } });
                continue;
              }
              mkdirSync(stateDir, { recursive: true });
              writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
              writeFileSync(join(stateDir, "approvals.log"), JSON.stringify({ apps: args.apps, mode: "auto" }) + "\\n");
              active = true;
              ended = null;
              lastApp = args.apps[0];
              send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "Approved: " + args.apps.join(", ") + ". No dialog was shown: the approval policy approves apps at once." }] } });
            } else if (name === "screenshot") {
              if (ended) {
                const msg = ended;
                ended = null;
                send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: msg }], isError: true } });
              } else if (!active) {
                send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "Call request_access first." }], isError: true } });
              } else {
                send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "Display 0 of 1, 1430x804 px. Give coordinates in this image's pixels." }] } });
              }
            } else if (name === "click") {
              send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "Clicked in " + lastApp + "." }] } });
            } else if (name === "open_app") {
              send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "Opened " + args.app + "." }] } });
            }
          }
        }
      });
      process.stdin.on("end", () => process.exit(0));
    `);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function makeFakeProbe(stateDirRef, serverPidRef) {
    let overlayAlive = false;
    let overlaySeq = 90000;
    return {
      findOverlay: (serverPid) => {
        serverPidRef.pid = serverPid;
        overlayAlive = true;
        return ++overlaySeq;
      },
      isAlive: () => overlayAlive,
      createProbe: (tempDir) => {
        stateDirRef.dir = tempDir;
        return {
          permissions: () => ({ screenRecording: true, accessibility: true }),
          sceneInfo: () => ({
            mainDisplay: DISPLAY,
            frontmost: HELIUM,
            dockLevel: 20,
            windows: [win(HELIUM, { x: 100, y: 100, width: 800, height: 600 })],
          }),
          findPanel: () => ({ found: true, bounds: { x: 1488, y: 1024, width: 420, height: 44 } }),
          clickUnmarked: (x, y) => {
            probeEvents.push(["click-unmarked", x, y]);
            writeFileSync(join(tempDir, `stop-${serverPidRef.pid}`), "");
            overlayAlive = false;
            return { ok: true };
          },
          escUnmarked: () => {
            probeEvents.push(["esc-unmarked"]);
            writeFileSync(join(tempDir, `stop-${serverPidRef.pid}`), "");
            overlayAlive = false;
            return { ok: true };
          },
        };
      },
    };
  }

  test("runs request_access, click, scripted Stop and scripted Esc in a temp folder and leaves real state unchanged", async () => {
    const stateDirRef = { dir: null };
    const serverPidRef = { pid: null };
    const fake = makeFakeProbe(stateDirRef, serverPidRef);

    const result = await runLiveCheck({
      serverCommand: [process.execPath, fakeServer],
      createProbe: fake.createProbe,
      findOverlay: fake.findOverlay,
      isAlive: fake.isAlive,
      realDirs: [realDir],
      overlaySettleMs: 0,
      sleep: async () => {},
      tempRoot: root,
    });

    expect(result.ok).toBe(true);
    expect(result.app).toBe("net.imput.helium");
    expect(result.checks.click).toContain("Clicked in net.imput.helium.");
    expect(result.checks.stop).toContain("The user stopped computer use.");
    expect(result.checks.esc).toContain("The user stopped computer use.");
    expect(probeEvents).toEqual([
      ["click-unmarked", 1848, 1046],
      ["esc-unmarked"],
    ]);
    // Temp state dir was removed and real state dir has no user-stopped.
    expect(existsSync(stateDirRef.dir)).toBe(false);
    expect(existsSync(join(realDir, "user-stopped"))).toBe(false);
    expect(readFileSync(join(realDir, "approvals.log"), "utf8")).toBe("{\"existing\":true}\n");
  });

  test("fails when the real state folder is modified during the run and still cleans up temp state", async () => {
    const stateDirRef = { dir: null };
    const serverPidRef = { pid: null };
    const fake = makeFakeProbe(stateDirRef, serverPidRef);

    await expect(runLiveCheck({
      serverCommand: [process.execPath, fakeServer],
      env: { ...process.env, LEAK_REAL_DIR: realDir },
      createProbe: fake.createProbe,
      findOverlay: fake.findOverlay,
      isAlive: fake.isAlive,
      realDirs: [realDir],
      overlaySettleMs: 0,
      sleep: async () => {},
      tempRoot: root,
    })).rejects.toThrow(/Real desktop-mcp state folder changed.*added: user-stopped/s);

    expect(existsSync(stateDirRef.dir)).toBe(false);
  });

  test("refuses sensitive and dialog-only apps before starting a server", async () => {
    await expect(runLiveCheck({ app: "Terminal", realDirs: [realDir], tempRoot: root })).rejects.toThrow("always needs a dialog");
    await expect(runLiveCheck({ app: "1Password", realDirs: [realDir], tempRoot: root })).rejects.toThrow("Cannot run unattended live check");
  });

  test("refuses to run when macOS grants are missing or screen is locked", async () => {
    await expect(runLiveCheck({
      serverCommand: [process.execPath, fakeServer],
      createProbe: () => ({
        permissions: () => ({ screenRecording: false, accessibility: true }),
        sceneInfo: () => ({ mainDisplay: DISPLAY, frontmost: FINDER, dockLevel: 20, windows: [] }),
      }),
      realDirs: [realDir],
      tempRoot: root,
    })).rejects.toThrow("Missing macOS grants");

    await expect(runLiveCheck({
      serverCommand: [process.execPath, fakeServer],
      createProbe: () => ({
        permissions: () => ({ screenRecording: true, accessibility: true }),
        sceneInfo: () => ({ mainDisplay: DISPLAY, frontmost: { name: "loginwindow", bundleId: "com.apple.loginwindow", pid: 1 }, dockLevel: 20, windows: [] }),
      }),
      realDirs: [realDir],
      tempRoot: root,
    })).rejects.toThrow("screen is locked");
  });

  test("real desktop.js starts over stdio with DESKTOP_MCP_STATE set to a temp folder", async () => {
    const isolated = join(root, "isolated-real-desktop");
    mkdirSync(isolated);
    const client = createMcpClient({
      command: process.execPath,
      args: [DESKTOP_SERVER],
      env: { ...process.env, DESKTOP_MCP_STATE: isolated },
      timeoutMs: 10_000,
    });
    try {
      const init = await client.request("initialize", { protocolVersion: "2025-06-18" });
      expect(init.serverInfo.name).toBe("desktop");
      client.notify("notifications/initialized");
      const listed = await client.request("tools/list", {});
      expect(listed.tools.map((t) => t.name)).toContain("request_access");
      // release touches only DESKTOP_MCP_STATE (no Swift compilation needed).
      const rel = await client.callTool("release", {});
      expect(rel.error).toBe(false);
      expect(rel.text).toContain("Released:");
    } finally {
      await client.close();
    }
    expect(existsSync(join(realDir, "user-stopped"))).toBe(false);
  });
});

describe("probe Swift source and documentation", () => {
  test("realStateDirs always includes ~/.local/state/desktop-mcp", () => {
    expect(realStateDirs({ XDG_STATE_HOME: "" }).some((d) => d.endsWith("/.local/state/desktop-mcp"))).toBe(true);
    expect(realStateDirs({ XDG_STATE_HOME: "/custom/state" })).toHaveLength(2);
  });

  test("live-check-probe.swift typechecks cleanly on macOS", () => {
    if (process.platform !== "darwin") return;
    const check = spawnSync("xcrun", ["swiftc", "-typecheck", "-swift-version", "5", PROBE_SOURCE], { encoding: "utf8" });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  }, 30_000);

  test("plugin README names live-check.js as the route for scripted Stop and Esc checks", () => {
    const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
    expect(readme).toContain("server/live-check.js");
    expect(readme).toContain("DESKTOP_MCP_STATE");
    expect(readme).toMatch(/only route for scripted Stop and Esc checks/i);
  });
});
