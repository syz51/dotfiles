// The desktop MCP server: screenshots, mouse and keyboard on this Mac, behind four safeguards.
// - The user approves each app in a native dialog before it can be controlled.
// - Banking, healthcare, government and password apps are refused, approved or not.
// - One session at a time holds the lock file; another session's request_access is refused.
// - A stop panel (button or Esc) ends the session at any time.
// Every action checks the app it lands on: the app under the pointer for mouse actions, the
// frontmost app for keys and typing. helper.swift does the macOS calls.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SERVER_NAME = "desktop";
const VERSION = "0.1.0";

// Screenshots fit the image limits vision models handle well: 1568 px on the long edge and
// about 1.15 megapixels.
const MAX_EDGE = 1568;
const MAX_PIXELS = 1_150_000;

export function fitScreenshot(width, height) {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Maps a point in a screenshot of `display` to global display points. */
export function toGlobal(display, shot, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= shot.width || y >= shot.height) {
    throw new ToolError(`(${x}, ${y}) is outside the ${shot.width}x${shot.height} screenshot of display ${display.index}.`);
  }
  return { x: display.x + (x * display.width) / shot.width, y: display.y + (y * display.height) / shot.height };
}

const MODIFIERS = {
  cmd: "cmd", command: "cmd", meta: "cmd", super: "cmd",
  ctrl: "ctrl", control: "ctrl",
  alt: "alt", opt: "alt", option: "alt",
  shift: "shift", fn: "fn",
};

// macOS virtual key codes (ANSI layout).
const KEYS = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, "=": 24, 9: 25, 7: 26, "-": 27, 8: 28, 0: 29, "]": 30, o: 31, u: 32,
  "[": 33, i: 34, p: 35, return: 36, l: 37, j: 38, "'": 39, k: 40, ";": 41, "\\": 42, ",": 43, "/": 44, n: 45, m: 46,
  ".": 47, tab: 48, space: 49, "`": 50, backspace: 51, escape: 53,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  home: 115, pageup: 116, delete: 117, end: 119, pagedown: 121, left: 123, right: 124, down: 125, up: 126,
};
const KEY_ALIASES = { enter: "return", esc: "escape", forwarddelete: "delete", pgup: "pageup", pgdn: "pagedown", arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down", " ": "space", plus: "=" };

export function modifierList(names = []) {
  return [...new Set(names.map((name) => {
    const modifier = MODIFIERS[String(name).toLowerCase()];
    if (!modifier) throw new ToolError(`Unknown modifier "${name}". Use cmd, ctrl, alt, shift or fn.`);
    return modifier;
  }))].join(",");
}

/** Parses a combo such as "cmd+shift+t" or "Return" into a key code and helper modifiers. */
export function parseKey(combo) {
  const parts = String(combo).split("+").map((part) => part.trim());
  const keyName = parts.pop();
  const lower = keyName.length === 1 ? keyName.toLowerCase() : keyName.toLowerCase().replace(/[\s_]/g, "");
  const code = KEYS[KEY_ALIASES[lower] ?? lower];
  if (code === undefined) throw new ToolError(`Unknown key "${keyName}" in "${combo}".`);
  return { code, modifiers: modifierList(parts) };
}

const SENSITIVE_CATEGORIES = {
  "public.app-category.finance": "a finance app",
  "public.app-category.medical": "a medical app",
  "public.app-category.healthcare-fitness": "a health app",
};
// Matched against the app's name and bundle id, word by word.
const SENSITIVE_WORDS = /\b(bank|banking|paypal|venmo|revolut|wise|coinbase|binance|crypto|wallet|ledger|trezor|turbotax|taxact|irs|gov|government|health|medical|mychart|patient|pharmacy|1password|bitwarden|lastpass|dashlane|keychain|passwords)\b/i;

/** Why `app` may never be controlled, or undefined. */
export function sensitiveReason(app) {
  if (app.name === "desktop-helper") return "it is the stop panel";
  const category = SENSITIVE_CATEGORIES[app.category];
  if (category) return `it is ${category}`;
  const words = `${app.name ?? ""} ${(app.bundleId ?? "").replace(/\./g, " ")}`;
  const match = SENSITIVE_WORDS.exec(words);
  return match ? `it looks like a banking, healthcare, government or password app ("${match[1].toLowerCase()}")` : undefined;
}

/** An error the model should read: it becomes a tool result with isError. */
export class ToolError extends Error {}

const appKey = (app) => (app.bundleId || app.name).toLowerCase();

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const POINT = { type: "number", description: "Pixels in the latest screenshot of the display." };
const DISPLAY = { type: "integer", minimum: 0, description: "Display index from the screenshot. Default: the last screenshot's display." };
export const TOOLS = [
  {
    name: "request_access",
    description: "Ask the user to approve controlling apps. Shows a dialog on the Mac. Banking, healthcare, government and password apps are refused. Only one session at a time can hold access.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["apps", "reason"],
      properties: {
        apps: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" }, description: "App names or bundle ids, such as Safari or com.apple.Notes." },
        reason: { type: "string", description: "One sentence the user reads in the dialog." },
      },
    },
  },
  { name: "list_displays", description: "List the displays with their index, size and scale.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  {
    name: "screenshot",
    description: "Capture a display. Coordinates for the other tools are pixels in the latest screenshot of that display.",
    inputSchema: { type: "object", additionalProperties: false, properties: { display: { ...DISPLAY, description: "Display index. Default: the main display." } } },
  },
  {
    name: "click",
    description: "Click at a point. The app under the point must be approved.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["x", "y"],
      properties: {
        x: POINT, y: POINT, display: DISPLAY,
        button: { type: "string", enum: ["left", "right", "middle"] },
        count: { type: "integer", minimum: 1, maximum: 3, description: "2 for a double click." },
        modifiers: { type: "array", items: { type: "string" }, description: "Held during the click: cmd, ctrl, alt, shift, fn." },
      },
    },
  },
  {
    name: "mouse_move",
    description: "Move the pointer, for example to show a hover menu.",
    inputSchema: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: POINT, y: POINT, display: DISPLAY } },
  },
  {
    name: "drag",
    description: "Press the left button at one point, move to another and release.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["from_x", "from_y", "to_x", "to_y"],
      properties: { from_x: POINT, from_y: POINT, to_x: POINT, to_y: POINT, display: DISPLAY, modifiers: { type: "array", items: { type: "string" } } },
    },
  },
  {
    name: "scroll",
    description: "Scroll at a point.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["x", "y", "direction"],
      properties: {
        x: POINT, y: POINT, display: DISPLAY,
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 1, maximum: 50, description: "Lines. Default 3." },
      },
    },
  },
  {
    name: "type",
    description: "Type text into the frontmost app, which must be approved. A newline presses Return.",
    inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 5000 } } },
  },
  {
    name: "key",
    description: "Press a key or combination in the frontmost app, such as cmd+t, Return, Escape or shift+Tab.",
    inputSchema: { type: "object", additionalProperties: false, required: ["combo"], properties: { combo: { type: "string" } } },
  },
  {
    name: "open_app",
    description: "Open or bring an approved app to the front.",
    inputSchema: { type: "object", additionalProperties: false, required: ["app"], properties: { app: { type: "string" } } },
  },
  { name: "release", description: "End the session: drop every approval, close the stop panel and free the lock.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
];

/**
 * The session. Dependencies are injected for tests:
 * helper(args) returns the helper's parsed JSON; dialog(text) resolves true when the user allows;
 * startOverlay(text, onExit) returns a handle with stop(); open(app) brings an app forward;
 * readImage(path) returns base64 and deletes the file.
 */
export function createDesktop({ helper, dialog, startOverlay, open, readImage, stateDir, pid = process.pid, alive = isAlive }) {
  const lockPath = join(stateDir, "session.json");
  const approved = new Map();
  const shots = new Map();
  let lastDisplay;
  let overlay;
  let stopped = false;

  function holdLock() {
    mkdirSync(stateDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(lockPath, JSON.stringify({ pid }), { flag: "wx" });
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const holder = JSON.parse(readFileSync(lockPath, "utf8")).pid;
      if (holder === pid) return;
      if (alive(holder)) throw new ToolError(`Another session (pid ${holder}) is controlling this computer. Try again after it releases.`);
      rmSync(lockPath, { force: true });
    }
    throw new ToolError("Could not take the session lock.");
  }

  function dropLock() {
    try {
      if (JSON.parse(readFileSync(lockPath, "utf8")).pid === pid) rmSync(lockPath, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  function release() {
    const handle = overlay;
    overlay = undefined;
    handle?.stop();
    approved.clear();
    dropLock();
  }

  function requireSession() {
    if (stopped) {
      stopped = false;
      throw new ToolError("The user stopped computer use. Ask the user before calling request_access again.");
    }
    if (!overlay) throw new ToolError("Call request_access first.");
  }

  function check(app, where) {
    if (!app) throw new ToolError(`No app found ${where}; nothing was done.`);
    const reason = sensitiveReason(app);
    if (reason) throw new ToolError(`${app.name} is refused: ${reason}.`);
    if (!approved.has(appKey(app))) throw new ToolError(`${app.name} (${where}) is not approved. Call request_access with it first.`);
    return app;
  }

  function point(args, x = args.x, y = args.y) {
    const index = args.display ?? lastDisplay;
    const shot = shots.get(index);
    if (!shot) throw new ToolError(index === undefined ? "Take a screenshot first." : `Take a screenshot of display ${index} first.`);
    return toGlobal(shot.display, shot, x, y);
  }

  const appAt = (p) => check(helper(["app-at", String(p.x), String(p.y)]), "under the pointer");
  const frontmost = () => check(helper(["frontmost"]), "the frontmost app");
  const at = (p) => [String(p.x), String(p.y)];
  const text = (value) => ({ content: [{ type: "text", text: value }] });

  async function requestAccess({ apps, reason }) {
    if (!Array.isArray(apps) || apps.length === 0 || typeof reason !== "string") throw new ToolError("Give apps (a list of names) and a reason.");
    if (stopped) stopped = false; // the model asks again after a stop; the dialog is the user's answer
    const notFound = [];
    const refused = [];
    const wanted = [];
    for (const name of apps) {
      const app = helper(["app-info", String(name)]);
      if (!app) notFound.push(name);
      else if (sensitiveReason(app)) refused.push(`${app.name}: ${sensitiveReason(app)}`);
      else if (!approved.has(appKey(app)) && !wanted.some((w) => appKey(w) === appKey(app))) wanted.push(app);
    }
    const lines = [];
    if (notFound.length) lines.push(`Not found: ${notFound.join(", ")}.`);
    if (refused.length) lines.push(`Refused: ${refused.join("; ")}.`);
    if (wanted.length) {
      holdLock();
      const names = wanted.map((app) => app.name).join(", ");
      const allowed = await dialog(`Claude wants to control: ${names}.\n\nReason: ${reason}\n\nIt can click and type in these apps until you press Stop or Esc, or the session ends.`);
      if (allowed) {
        for (const app of wanted) approved.set(appKey(app), app);
        overlay ??= startOverlay("Claude is controlling this Mac", (code) => {
          if (overlay) {
            overlay = undefined;
            stopped = true;
            approved.clear();
            dropLock();
          }
        });
        lines.push(`Approved: ${names}.`);
      } else {
        if (!overlay) dropLock();
        lines.push(`The user denied: ${names}.`);
      }
    }
    lines.push(`Approved apps: ${[...approved.values()].map((app) => app.name).join(", ") || "none"}.`);
    return text(lines.join("\n"));
  }

  const tools = {
    request_access: requestAccess,
    list_displays: () => text(JSON.stringify(helper(["displays"]))),
    screenshot(args) {
      requireSession();
      const displays = helper(["displays"]);
      const display = args.display === undefined ? displays.find((d) => d.main) ?? displays[0] : displays[args.display];
      if (!display) throw new ToolError(`No display ${args.display}; there are ${displays.length}.`);
      const size = fitScreenshot(display.pixelWidth, display.pixelHeight);
      mkdirSync(stateDir, { recursive: true });
      const path = join(stateDir, `shot-${pid}.jpg`);
      helper(["screenshot", String(display.id), String(size.width), String(size.height), path]);
      shots.set(display.index, { ...size, display });
      lastDisplay = display.index;
      return {
        content: [
          { type: "image", data: readImage(path), mimeType: "image/jpeg" },
          { type: "text", text: `Display ${display.index} of ${displays.length}, ${size.width}x${size.height} px. Give coordinates in this image's pixels.` },
        ],
      };
    },
    click(args) {
      requireSession();
      const p = point(args);
      const app = appAt(p);
      const count = args.count ?? 1;
      helper(["click", ...at(p), args.button ?? "left", String(count), modifierList(args.modifiers)]);
      return text(`Clicked in ${app.name}.`);
    },
    mouse_move(args) {
      requireSession();
      const p = point(args);
      const app = appAt(p);
      helper(["move", ...at(p)]);
      return text(`Moved the pointer over ${app.name}.`);
    },
    drag(args) {
      requireSession();
      const from = point(args, args.from_x, args.from_y);
      const to = point(args, args.to_x, args.to_y);
      appAt(from);
      const app = appAt(to);
      helper(["drag", ...at(from), ...at(to), modifierList(args.modifiers)]);
      return text(`Dragged in ${app.name}.`);
    },
    scroll(args) {
      requireSession();
      const p = point(args);
      const app = appAt(p);
      const amount = args.amount ?? 3;
      const [dx, dy] = { up: [0, amount], down: [0, -amount], left: [amount, 0], right: [-amount, 0] }[args.direction] ?? [];
      if (dx === undefined) throw new ToolError(`Unknown direction "${args.direction}".`);
      helper(["scroll", ...at(p), String(dx), String(dy)]);
      return text(`Scrolled ${args.direction} in ${app.name}.`);
    },
    type(args) {
      requireSession();
      if (typeof args.text !== "string") throw new ToolError("Give text.");
      const app = frontmost();
      helper(["type", args.text]);
      return text(`Typed into ${app.name}.`);
    },
    key(args) {
      requireSession();
      const { code, modifiers } = parseKey(args.combo);
      const app = frontmost();
      helper(["key", String(code), modifiers]);
      return text(`Pressed ${args.combo} in ${app.name}.`);
    },
    open_app(args) {
      requireSession();
      const app = check(helper(["app-info", String(args.app)]), "by that name");
      open(app);
      return text(`Opened ${app.name}.`);
    },
    release() {
      release();
      stopped = false;
      return text("Released: no apps are approved and the lock is free.");
    },
  };

  async function call(name, args = {}) {
    const tool = tools[name];
    if (!tool) return { content: [{ type: "text", text: `Unknown tool ${name}.` }], isError: true };
    try {
      return await tool(args);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
  }

  return { call, release };
}

const INSTRUCTIONS = "Controls this Mac's screen, mouse and keyboard. Call request_access with the apps you need; "
  + "the user approves them in a dialog and can stop you at any time. Take a screenshot before pointing; coordinates "
  + "are pixels in the latest screenshot of that display. Prefer keyboard shortcuts. Call release when done.";

/** Answers one JSON-RPC message; undefined for notifications. */
export async function handle(desktop, message) {
  const { id, method, params } = message;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  if (method === "initialize") {
    return reply({
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: VERSION },
      instructions: INSTRUCTIONS,
    });
  }
  if (id === undefined) return undefined;
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: TOOLS });
  if (method === "tools/call") {
    try {
      return reply(await desktop.call(params?.name, params?.arguments ?? {}));
    } catch (error) {
      return reply({ content: [{ type: "text", text: `The desktop helper failed: ${error.message}` }], isError: true });
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// Compiles helper.swift once per source version into the state folder.
function helperBinary(stateDir) {
  const source = join(import.meta.dir, "helper.swift");
  const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12);
  const binary = join(stateDir, `desktop-helper-${hash}`);
  if (existsSync(binary)) return binary;
  mkdirSync(stateDir, { recursive: true });
  const build = spawnSync("xcrun", ["swiftc", "-O", "-swift-version", "5", source, "-o", `${binary}.tmp`], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(`could not compile helper.swift: ${build.stderr || build.error?.message}`);
  renameSync(`${binary}.tmp`, binary);
  for (const name of readdirSync(stateDir)) {
    if (name.startsWith("desktop-helper-") && join(stateDir, name) !== binary) rmSync(join(stateDir, name), { force: true });
  }
  return binary;
}

function realDependencies(stateDir) {
  let binary;
  const bin = () => (binary ??= helperBinary(stateDir));
  return {
    helper(args) {
      const result = spawnSync(bin(), args, { encoding: "utf8", timeout: 20_000 });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const message = result.stderr.trim() || `exit ${result.status}`;
        // Missing permissions are for the model to report, not a crash.
        if (/Grant (Screen Recording|Accessibility)/.test(message)) throw new ToolError(message);
        throw new Error(message);
      }
      return JSON.parse(result.stdout);
    },
    async dialog(message) {
      const script = [
        "on run argv",
        'display dialog (item 1 of argv) with title "Claude computer use" buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution giving up after 120',
        "return button returned of result",
        "end run",
      ];
      const child = Bun.spawn(["osascript", ...script.flatMap((line) => ["-e", line]), message], { stdout: "pipe", stderr: "ignore" });
      const answer = (await new Response(child.stdout).text()).trim();
      await child.exited;
      return answer === "Allow";
    },
    startOverlay(label, onExit) {
      const child = spawn(bin(), ["overlay", String(process.pid), label], { stdio: ["ignore", "ignore", "inherit"] });
      child.on("exit", onExit);
      return { stop: () => child.kill() };
    },
    open(app) {
      const result = spawnSync("open", app.bundleId ? ["-b", app.bundleId] : ["-a", app.path ?? app.name], { encoding: "utf8" });
      if (result.status !== 0) throw new ToolError(`Could not open ${app.name}: ${result.stderr.trim()}`);
    },
    readImage(path) {
      const data = readFileSync(path).toString("base64");
      rmSync(path, { force: true });
      return data;
    },
  };
}

if (import.meta.main) {
  const stateDir = process.env.DESKTOP_MCP_STATE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "desktop-mcp");
  const desktop = createDesktop({ ...realDependencies(stateDir), stateDir });
  process.on("exit", () => desktop.release());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(0));

  // Messages are handled one at a time, so actions never interleave.
  let queue = Promise.resolve();
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      queue = queue.then(async () => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
          return;
        }
        const response = await handle(desktop, message);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
  process.stdin.on("end", () => queue.then(() => process.exit(0)));
}
