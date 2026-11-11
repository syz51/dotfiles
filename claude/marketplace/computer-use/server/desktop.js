// The desktop MCP server: screenshots, mouse and keyboard on this Mac, behind four safeguards.
// - Each app is approved before it can be controlled: at once, or in a native dialog when the
//   approval policy says "dialog", after the user pressed Stop, or for an app that reaches past
//   Claude Code's permission rules (DIALOG_APPS). approvals.log records each approval.
// - Banking, healthcare, government and password apps are refused, approved or not.
// - One session at a time holds the lock file; another session's request_access is refused.
// - A stop panel (button or Esc) ends the session at any time.
// Every action checks the app it lands on: the app under the pointer for mouse actions
// (chooseApp), the app with keyboard focus for keys and typing. helper.swift does the macOS
// calls.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  if (!Array.isArray(names)) throw new ToolError("modifiers must be a list, such as [\"cmd\"].");
  return [...new Set(names.map((name) => {
    const modifier = MODIFIERS[String(name).toLowerCase()];
    if (!modifier) throw new ToolError(`Unknown modifier "${name}". Use cmd, ctrl, alt, shift or fn.`);
    return modifier;
  }))].join(",");
}

/** Parses a combo such as "cmd+shift+t" or "Return" into a key code and helper modifiers. */
export function parseKey(combo) {
  if (typeof combo !== "string" || combo === "") throw new ToolError("Give combo, such as cmd+t or Return.");
  const parts = combo.split("+").map((part) => part.trim());
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
const SENSITIVE_WORDS = /\b(bank|banking|paypal|venmo|revolut|wise|coinbase|binance|crypto|wallet|ledger|trezor|turbotax|taxact|irs|gov|government|health|medical|mychart|patient|pharmacy|password|passwords|passwordmanager|1password|bitwarden|lastpass|dashlane|keeper|keepass|keepassxc|enpass|proton pass|authy|authenticator|keychain)\b/i;

// The helper binary is named desktop-helper-<hash>; its stop panel is never controlled.
const HELPER_NAME = /^desktop-helper(-[0-9a-f]+)?$/;

/** Why `app` may never be controlled, or undefined. */
export function sensitiveReason(app) {
  if (HELPER_NAME.test(app.name ?? "")) return "it is the stop panel";
  const category = SENSITIVE_CATEGORIES[app.category];
  if (category) return `it is ${category}`;
  const words = `${app.name ?? ""} ${(app.bundleId ?? "").replace(/\./g, " ")}`;
  const match = SENSITIVE_WORDS.exec(words);
  return match ? `it looks like a banking, healthcare, government or password app ("${match[1].toLowerCase()}")` : undefined;
}

// Apps that reach past Claude Code's permission rules and hooks: they run commands, start
// agents, change system settings or install software. The user approves them in a dialog
// whatever the policy says. Each is matched by bundle id, where a trailing "." matches every id
// that starts with it, and by name, both ignoring case.
const DIALOG_APPS = [
  { why: "it runs shell commands", names: ["Terminal"], ids: ["com.apple.Terminal"] },
  { why: "it runs shell commands", names: ["iTerm", "iTerm2"], ids: ["com.googlecode.iterm2"] },
  { why: "it runs shell commands", names: ["Ghostty"], ids: ["com.mitchellh.ghostty"] },
  { why: "it runs shell commands", names: ["Warp"], ids: ["dev.warp."] },
  { why: "it runs shell commands", names: ["Alacritty"], ids: ["org.alacritty", "io.alacritty"] },
  { why: "it runs shell commands", names: ["kitty"], ids: ["net.kovidgoyal.kitty"] },
  { why: "it runs shell commands", names: ["WezTerm"], ids: ["com.github.wez.wezterm"] },
  { why: "it runs agents and their permission prompts", names: ["T3 Code"], ids: ["com.t3tools."] },
  { why: "it runs agents and their permission prompts", names: ["OpenCode"], ids: [] },
  { why: "it runs agents and their permission prompts", names: ["Claude", "Claude Code"], ids: ["com.anthropic."] },
  { why: "it runs agents and their permission prompts", names: ["ChatGPT", "Codex"], ids: ["com.openai."] },
  { why: "it has a terminal and runs agents", names: ["Visual Studio Code", "Code", "Cursor", "Windsurf", "Zed", "Xcode"],
    ids: ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders", "com.todesktop.230313mzl4w4u92", "com.exafunction.windsurf", "dev.zed.", "com.apple.dt.Xcode"] },
  { why: "it runs scripts", names: ["Raycast", "Alfred"], ids: ["com.raycast.", "com.runningwithcrayons.Alfred"] },
  { why: "it changes system and privacy settings", names: ["System Settings", "System Preferences"], ids: ["com.apple.systempreferences"] },
  { why: "it answers system and privacy prompts", names: ["Control Center", "CoreServicesUIAgent", "UserNotificationCenter", "SecurityAgent", "SystemUIServer"],
    ids: ["com.apple.controlcenter", "com.apple.coreservices.uiagent", "com.apple.UserNotificationCenter", "com.apple.SecurityAgent", "com.apple.systemuiserver"] },
  { why: "it is the lock screen and the Force Quit window", names: ["loginwindow"], ids: ["com.apple.loginwindow"] },
  { why: "its tiles open files in any app", names: ["Dock"], ids: ["com.apple.dock"] },
  { why: "it opens files and scripts in any app", names: ["Finder"], ids: ["com.apple.finder"] },
  { why: "it opens files and scripts in any app", names: ["Spotlight"], ids: ["com.apple.Spotlight"] },
  { why: "it runs scripts", names: ["Script Editor"], ids: ["com.apple.ScriptEditor2"] },
  { why: "it runs scripts", names: ["Shortcuts"], ids: ["com.apple.shortcuts"] },
  { why: "it runs scripts", names: ["Automator"], ids: ["com.apple.Automator"] },
  { why: "it ends processes", names: ["Activity Monitor"], ids: ["com.apple.ActivityMonitor"] },
  { why: "it installs software", names: ["Installer"], ids: ["com.apple.installer"] },
];

/** Why `app` always needs the user's dialog, or undefined. */
export function dialogReason(app) {
  const name = (app.name ?? "").toLowerCase();
  const id = (app.bundleId ?? "").toLowerCase();
  const entry = DIALOG_APPS.find((candidate) => candidate.names.some((n) => n.toLowerCase() === name)
    || candidate.ids.some((i) => (i.endsWith(".") ? id.startsWith(i.toLowerCase()) : id === i.toLowerCase())));
  return entry?.why;
}

const DOCK = "com.apple.dock";
const covers = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y
  && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;

/**
 * The app under a point, from the helper's scene: the visible windows containing the point,
 * front to back, the pid the Accessibility hit-test found there (null when it failed), the
 * Dock's window level and the display bounds. This decides which app the approval check
 * sees, so a window is passed over only when it cannot take the input:
 * - a window with alpha 0, and a Window Server surface, known by the owner's executable path,
 *   never by its name (its menu bar is the frontmost app's);
 * - the Dock's full-display window at the Dock level, matched by bundle id, never by its
 *   localized name, when the hit-test reaches another app through it. The window that then
 *   decides must belong to the app the hit-test found, or no app is chosen.
 * Every other window decides, including the Dock's tiles, menus and Mission Control, a failed
 * hit-test, and screencaptureui, whose buttons take the click. The first other visible window
 * of a process with no running app is refused with a ToolError, past the Dock's layer too,
 * whatever the hit-test found.
 */
export function chooseApp({ windows, hitPid, dockLevel, displays, frontmost, finder }) {
  let passedDock = false;
  const decide = (window, app) => (!passedDock || window.pid === hitPid ? app : null);
  for (const window of windows) {
    if (window.alpha === 0) continue;
    if (window.windowServer) {
      if (window.name === "Menubar") return decide(window, frontmost);
      continue;
    }
    // Refused here, never sent to check(): appKey falls back to the name, which a process
    // chooses, so a window named like an approved app would pass the approval lookup. The
    // name is untrusted text in the model's tool result, so it is quoted and cut short.
    if (!window.app) {
      const owner = JSON.stringify((window.owner ?? "").slice(0, 40));
      throw new ToolError(`A window of the process ${owner} (pid ${window.pid ?? "unknown"}), which is not an app, is at the point; nothing was done.`);
    }
    if (window.app.bundleId === DOCK && window.layer === dockLevel
      && displays.some((display) => covers(window.bounds, display))
      && Number.isInteger(hitPid) && hitPid !== window.pid) {
      passedDock = true;
      continue;
    }
    return decide(window, window.app);
  }
  // Nothing but the desktop: Finder owns it.
  return passedDock && finder?.pid !== hitPid ? null : finder;
}

/** An error the model should read: it becomes a tool result with isError. */
export class ToolError extends Error {}

const appKey = (app) => (app.bundleId || app.name).toLowerCase();

/** The plugin's own policy file, used when the user's file is missing. */
export const BUNDLED_POLICY = join(import.meta.dir, "..", "policy.json");
const APPROVALS = ["auto", "dialog"];

/** The state folder; an empty variable counts as unset, so it is never relative to the cwd. */
export const stateDirFor = (env) => env.DESKTOP_MCP_STATE || join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "desktop-mcp");

/**
 * The policy files, first match wins: the user's file, DESKTOP_MCP_POLICY or else policy.json in
 * the state folder, which no checkout tracks; then the plugin's own. An empty variable counts as
 * unset.
 */
export const policyPaths = (env, stateDir) => [env.DESKTOP_MCP_POLICY || join(stateDir, "policy.json"), BUNDLED_POLICY];

/**
 * The approval policy from the first of `paths` that exists: "auto" approves the asked apps
 * without a dialog, "dialog" asks the user. It is read at each request_access, so an edit takes
 * effect at once. With no file it is "dialog"; a broken or unreadable file is an error, never a
 * guess.
 */
export function readPolicy(paths) {
  for (const path of paths) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new ToolError(`Could not read the approval policy ${path} (${error.code ?? error.message}); nothing was approved.`);
    }
    let policy;
    try {
      policy = JSON.parse(text);
    } catch (error) {
      throw new ToolError(`The approval policy ${path} is not valid JSON (${error.message}); nothing was approved.`);
    }
    if (!APPROVALS.includes(policy?.approval)) {
      throw new ToolError(`The approval policy ${path} must set "approval" to "auto" or "dialog"; nothing was approved.`);
    }
    return { approval: policy.approval };
  }
  return { approval: "dialog" };
}

// Signals a user sends to end the panel, as Force Quit and kill do. Our own stop() also sends
// one, but the session has already dropped that panel by then.
const STOP_SIGNALS = ["SIGKILL", "SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];

/**
 * How the stop panel's exit reads: undefined for the user's Stop, which is exit 0 after the
 * button or Esc, or a stop signal; otherwise the failure, such as a crash or exit 3 when the
 * server is gone.
 */
export function panelExit(code, signal) {
  if (code === 0 || STOP_SIGNALS.includes(signal)) return undefined;
  return signal ? `crashed with ${signal}` : `exit ${code}`;
}

/** The file the stop panel writes when the user stops the session of server `pid`. */
export const stopPath = (stateDir, pid) => join(stateDir, `stop-${pid}`);
/**
 * Written when any session sees the user's Stop; while it exists, request_access in every
 * session and every later server asks in a dialog. Only an Allow in that dialog removes it.
 */
export const userStopPath = (stateDir) => join(stateDir, "user-stopped");
/** One JSON line per approval: time, apps, reason, and mode "auto" or "dialog". */
export const approvalLogPath = (stateDir) => join(stateDir, "approvals.log");

const STOPPED = "The user stopped computer use. Ask the user before calling request_access again; it will show the user a dialog.";

// A lock holder counts only while its pid still runs this server, so a pid reused after a
// crash or a reboot does not hold the lock.
function holdsLock(pid) {
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 && result.stdout.includes("desktop.js");
}

function integer(value, name, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new ToolError(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
}

function choice(value, name, options, fallback) {
  if (value === undefined) return fallback;
  if (!options.includes(value)) throw new ToolError(`${name} must be one of ${options.join(", ")}.`);
  return value;
}

const POINT = { type: "number", description: "Pixels in the latest screenshot of the display." };
const DISPLAY = { type: "integer", minimum: 0, description: "Display index from the screenshot. Default: the last screenshot's display." };
export const TOOLS = [
  {
    name: "request_access",
    description: "Approve apps for control. By default the approval policy approves them at once, with no dialog and no wait for the user. "
      + "The user allows or denies them in a dialog on the Mac instead when the policy asks for one, after the user pressed Stop, and for apps "
      + "that reach past Claude Code's permission rules: terminals, agent apps such as T3 Code or Claude, System Settings, editors with "
      + "a terminal, script tools, system prompts, the Dock, loginwindow, Activity Monitor and Installer. The call then waits up to 2 "
      + "minutes for the answer. "
      + "The reply says whether a dialog was shown. Only the named apps are approved. Banking, healthcare, government and password apps "
      + "are refused. Only one session at a time can hold access.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["apps", "reason"],
      properties: {
        apps: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" }, description: "App names or bundle ids, such as Safari or com.apple.Notes." },
        reason: { type: "string", description: "One sentence on why. It is logged, and the user reads it when a dialog is shown." },
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
    description: "Type text into the app with keyboard focus, which must be approved. A newline presses Return.",
    inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 5000 } } },
  },
  {
    name: "key",
    description: "Press a key or combination in the app with keyboard focus, which must be approved, such as cmd+t, Return, Escape or shift+Tab.",
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
 * helper(args) returns the helper's parsed JSON; dialog(text) resolves true when the user allows
 * and throws when the dialog could not be shown; startOverlay(text, stopFile, onExit) returns a
 * handle with stop() and calls onExit() once when the user pressed Stop, or onExit(failure),
 * a description, when the panel ended any other way; open(app) brings an app forward;
 * readImage(path) returns base64 and deletes the file; holds(pid) says whether that pid still
 * runs a desktop server; policy() returns the approval policy, as readPolicy does; now()
 * returns the time.
 */
export function createDesktop({ helper, dialog, startOverlay, open, readImage, policy, stateDir, pid = process.pid, holds = holdsLock, now = () => new Date() }) {
  const lockPath = join(stateDir, "session.json");
  const stopFile = stopPath(stateDir, pid);
  const userStopFile = userStopPath(stateDir);
  const approved = new Map();
  const shots = new Map();
  let lastDisplay;
  let overlay;
  // Why the last session ended, reported once to the next call: STOPPED or a panel failure.
  let ended;

  function lockHolder() {
    try {
      const holder = JSON.parse(readFileSync(lockPath, "utf8"))?.pid;
      return Number.isInteger(holder) ? holder : null;
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) return null; // empty or corrupt: stale
      throw error;
    }
  }

  function holdLock() {
    mkdirSync(stateDir, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeFileSync(lockPath, JSON.stringify({ pid }), { flag: "wx" });
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const holder = lockHolder();
      if (holder === pid) return;
      if (holder && holds(holder)) throw new ToolError(`Another session (pid ${holder}) is controlling this computer. Try again after it releases.`);
      // Move the stale lock aside under a unique name, so two sessions taking it over cannot
      // delete each other's new lock.
      const aside = `${lockPath}.${pid}.stale`;
      try {
        renameSync(lockPath, aside);
        rmSync(aside, { force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw new ToolError("Could not take the session lock.");
  }

  function dropLock() {
    if (lockHolder() === pid) rmSync(lockPath, { force: true });
  }

  function endSession() {
    const handle = overlay;
    overlay = undefined;
    handle?.stop();
    approved.clear();
    dropLock();
  }

  function release() {
    // A Stop whose panel exit event has not run yet still counts.
    noticeStop();
    endSession();
    rmSync(stopFile, { force: true });
  }

  // The user's Stop ends the session and makes every session ask in a dialog until the user
  // allows apps in one. The stop file is consumed, so it never stops a later session.
  // The state folder exists: a session held the lock, or the panel wrote its stop file there.
  function userStop() {
    endSession();
    writeFileSync(userStopFile, `${JSON.stringify({ time: now().toISOString(), pid })}\n`);
    rmSync(stopFile, { force: true });
    ended = STOPPED;
  }

  // The stop file is checked as well as the panel's exit event, because the event waits for
  // the event loop while queued actions run. One found with no panel is a Stop that a killed
  // server with this pid never saw; it counts too, so it cannot end a later session.
  function noticeStop() {
    if (existsSync(stopFile)) userStop();
  }

  function requireSession() {
    noticeStop();
    if (ended) {
      const message = ended;
      ended = undefined;
      throw new ToolError(message);
    }
    if (!overlay) throw new ToolError("Call request_access first.");
    if (lockHolder() !== pid) {
      endSession();
      throw new ToolError("This session lost the session lock, so it no longer controls the computer. Call request_access again.");
    }
  }

  function check(app, where) {
    if (!app) throw new ToolError(`No app found ${where}; nothing was done.`);
    const reason = sensitiveReason(app);
    if (reason) throw new ToolError(`${app.name} is refused: ${reason}.`);
    if (!approved.has(appKey(app))) throw new ToolError(`${app.name} (${where}) is not approved. Call request_access with it first.`);
    return app;
  }

  function point(args, x = args.x, y = args.y) {
    const index = integer(args.display, "display", 0, 15, lastDisplay);
    const shot = shots.get(index);
    if (!shot) throw new ToolError(index === undefined ? "Take a screenshot first." : `Take a screenshot of display ${index} first.`);
    return toGlobal(shot.display, shot, x, y);
  }

  const appAt = (p) => check(chooseApp(helper(["scene", String(p.x), String(p.y)])), "under the pointer");
  // The Accessibility focused-app query fails for some apps, such as Helium. Only then does
  // the frontmost app stand in, and it passes the same check.
  function focused() {
    const { app, axError, frontmost } = helper(["focused"]);
    if (axError === undefined) return check(app, "the app with keyboard focus");
    return check(frontmost, `the frontmost app; Accessibility found no focused app, error ${axError}`);
  }
  const at = (p) => [String(p.x), String(p.y)];
  const text = (value) => ({ content: [{ type: "text", text: value }] });

  // The panel names the approved apps, so it is replaced when the list grows; it cuts a long
  // label short with an ellipsis. The old panel's exit is then ignored; a Stop it wrote stays
  // in the shared stop file.
  function showPanel() {
    const names = [...approved.values()].map((app) => app.name).join(", ");
    const previous = overlay;
    let handle;
    handle = startOverlay(`Claude controls: ${names}`, stopFile, (failure) => {
      if (overlay !== handle) return; // a panel this session already closed or replaced
      if (failure === undefined) {
        userStop();
        return;
      }
      // A crash or a failed start is not the user's Stop: the session ends without the
      // dialog that a Stop brings back.
      endSession();
      ended = `The stop panel failed (${failure}), so the session ended. Call request_access again.`;
    });
    overlay = handle;
    previous?.stop();
  }

  // Runs after holdLock(), so the state folder exists.
  function logApproval(apps, reason, mode) {
    const path = approvalLogPath(stateDir);
    const entry = { time: now().toISOString(), mode, apps: apps.map(({ name, bundleId }) => ({ name, bundleId })), reason };
    try {
      appendFileSync(path, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      throw new ToolError(`Could not write the approval log ${path} (${error.code ?? error.message}); nothing was approved.`);
    }
  }

  async function requestAccess({ apps, reason }) {
    if (!Array.isArray(apps) || apps.length === 0 || apps.length > 10 || !apps.every((app) => typeof app === "string")) {
      throw new ToolError("apps must be a list of 1 to 10 app names or bundle ids.");
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new ToolError("Give a reason: one sentence on why. It is logged, and the user reads it when a dialog is shown.");
    }
    noticeStop();
    // This call reports how the last session ended, in its reply or its error, so the next
    // call does not again.
    const previous = ended;
    const notice = previous === STOPPED ? "The user pressed Stop, which ended the last session." : previous;
    ended = undefined;
    try {
      return text([...(notice ? [notice] : []), ...(await approve(apps, reason))].join("\n"));
    } catch (error) {
      if (!notice) throw error;
      if (error instanceof ToolError) throw new ToolError(`${notice}\n${error.message}`);
      ended ??= previous;
      throw error;
    }
  }

  async function approve(apps, reason) {
    const lines = [];
    const notFound = [];
    const refused = [];
    const wanted = [];
    for (const name of apps) {
      const app = helper(["app-info", name]);
      const sensitive = app && sensitiveReason(app);
      if (!app) notFound.push(name);
      else if (sensitive) refused.push(`${app.name}: ${sensitive}`);
      else if (!approved.has(appKey(app)) && !wanted.some((w) => appKey(w) === appKey(app))) wanted.push(app);
    }
    if (notFound.length) lines.push(`Not found: ${notFound.join(", ")}.`);
    if (refused.length) lines.push(`Refused: ${refused.join("; ")}.`);
    if (wanted.length) {
      // Read before the lock is taken, so a broken policy file leaves nothing held.
      const mode = policy().approval;
      const why = [
        ...(existsSync(userStopFile) ? ["the user pressed Stop and has not allowed apps in a dialog since"] : []),
        ...wanted.flatMap((app) => {
          const always = dialogReason(app);
          return always ? [`${app.name} always needs the user: ${always}`] : [];
        }),
        ...(mode === "dialog" ? ["the approval policy asks for a dialog"] : []),
      ];
      const ask = why.length > 0;
      holdLock();
      const names = wanted.map((app) => app.name).join(", ");
      let allowed = true;
      if (ask) {
        allowed = false;
        try {
          allowed = await dialog(`Claude wants to control: ${names}.\n\nReason: ${reason}\n\nIt can click and type in these apps until you press Stop or Esc, or the session ends.`);
        } finally {
          if (!allowed && !overlay) dropLock();
        }
      }
      if (allowed) {
        try {
          logApproval(wanted, reason, ask ? "dialog" : "auto");
        } catch (error) {
          if (!overlay) dropLock();
          throw error;
        }
        if (ask) {
          // A Stop during the dialog ended the old session; the Allow is the newer answer. The
          // user's Stop record goes only once this session holds the lock again.
          noticeStop();
          ended = undefined;
          holdLock();
          rmSync(userStopFile, { force: true });
        }
        for (const app of wanted) approved.set(appKey(app), app);
        showPanel();
        lines.push(ask
          ? `Approved: ${names}. A dialog was shown, because ${why.join("; ")}, and the user allowed them.`
          : `Approved: ${names}. No dialog was shown: the approval policy approves apps at once.`);
      } else {
        lines.push(`Not approved: ${names}. A dialog was shown, because ${why.join("; ")}; the user denied it or did not answer within 2 minutes.`);
      }
    }
    lines.push(`Approved apps: ${[...approved.values()].map((app) => app.name).join(", ") || "none"}.`);
    return lines;
  }

  const tools = {
    request_access: requestAccess,
    list_displays: () => text(JSON.stringify(helper(["displays"]))),
    screenshot(args) {
      requireSession();
      const displays = helper(["displays"]);
      const index = integer(args.display, "display", 0, 15, undefined);
      const display = index === undefined ? displays.find((d) => d.main) ?? displays[0] : displays[index];
      if (!display) throw new ToolError(`No display ${index}; there are ${displays.length}.`);
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
      const button = choice(args.button, "button", ["left", "right", "middle"], "left");
      const count = integer(args.count, "count", 1, 3, 1);
      const modifiers = modifierList(args.modifiers);
      const p = point(args);
      const app = appAt(p);
      helper(["click", ...at(p), button, String(count), modifiers]);
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
      const modifiers = modifierList(args.modifiers);
      const from = point(args, args.from_x, args.from_y);
      const to = point(args, args.to_x, args.to_y);
      appAt(from);
      const app = appAt(to);
      helper(["drag", ...at(from), ...at(to), modifiers]);
      return text(`Dragged in ${app.name}.`);
    },
    scroll(args) {
      requireSession();
      const direction = choice(args.direction, "direction", ["up", "down", "left", "right"], undefined);
      if (!direction) throw new ToolError("Give direction: up, down, left or right.");
      const amount = integer(args.amount, "amount", 1, 50, 3);
      const p = point(args);
      const app = appAt(p);
      const [dx, dy] = { up: [0, amount], down: [0, -amount], left: [amount, 0], right: [-amount, 0] }[direction];
      helper(["scroll", ...at(p), String(dx), String(dy)]);
      return text(`Scrolled ${direction} in ${app.name}.`);
    },
    type(args) {
      requireSession();
      if (typeof args.text !== "string" || args.text.length > 5000) throw new ToolError("Give text of at most 5000 characters.");
      const app = focused();
      helper(["type", args.text]);
      return text(`Typed into ${app.name}.`);
    },
    key(args) {
      requireSession();
      const { code, modifiers } = parseKey(args.combo);
      const app = focused();
      helper(["key", String(code), modifiers]);
      return text(`Pressed ${args.combo} in ${app.name}.`);
    },
    open_app(args) {
      requireSession();
      if (typeof args.app !== "string" || args.app === "") throw new ToolError("Give app, a name or bundle id.");
      const app = check(helper(["app-info", args.app]), "by that name");
      open(app);
      return text(`Opened ${app.name}.`);
    },
    release() {
      release();
      const before = ended ? ` ${ended}` : "";
      ended = undefined;
      return text(`Released: no apps are approved and the lock is free.${before}`);
    },
  };

  async function call(name, args) {
    const tool = tools[name];
    if (!tool) return { content: [{ type: "text", text: `Unknown tool ${name}.` }], isError: true };
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      return { content: [{ type: "text", text: "Tool arguments must be an object." }], isError: true };
    }
    try {
      return await tool(args);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
  }

  return { call, release };
}
export const INSTRUCTIONS = "Controls this Mac's screen, mouse and keyboard. Call request_access with the apps you need. "
  + "Depending on the approval policy, it approves them at once or shows the user an Allow/Deny dialog on the Mac; it always "
  + "shows one after the user pressed Stop and for terminals, agent apps, editors, System Settings and script tools. Its reply says "
  + "whether a dialog was shown. When a dialog may show, tell the user to look at the Mac: the call waits up to 2 minutes "
  + "for the answer. Banking, healthcare, government and password apps are always refused, and the user can stop you at "
  + "any time. Take a screenshot before pointing; coordinates are pixels in the latest screenshot of that display. Prefer "
  + "keyboard shortcuts. Call release when done.";

/** Answers one JSON-RPC message; undefined for notifications. */
export async function handle(desktop, message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
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

// Compiles helper.swift once per source version into the state folder. Binaries of other
// versions stay, since another session may still run one; each build writes its own
// temporary file and renames it into place.
function helperBinary(stateDir) {
  const source = join(import.meta.dir, "helper.swift");
  const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12);
  const binary = join(stateDir, `desktop-helper-${hash}`);
  if (existsSync(binary)) return binary;
  mkdirSync(stateDir, { recursive: true });
  const temporary = `${binary}.${process.pid}.tmp`;
  const build = spawnSync("xcrun", ["swiftc", "-O", "-swift-version", "5", source, "-o", temporary], { encoding: "utf8" });
  if (build.status !== 0) {
    rmSync(temporary, { force: true });
    throw new Error(`could not compile helper.swift: ${build.stderr || build.error?.message}`);
  }
  renameSync(temporary, binary);
  return binary;
}

function realDependencies(stateDir) {
  let binary;
  const bin = () => (binary ??= helperBinary(stateDir));
  const env = { ...process.env, DESKTOP_STOP_FILE: stopPath(stateDir, process.pid) };
  const paths = policyPaths(process.env, stateDir);
  return {
    policy: () => readPolicy(paths),
    helper(args) {
      const result = spawnSync(bin(), args, { encoding: "utf8", timeout: 20_000, env });
      if (result.error) throw result.error;
      if (result.status === 4) throw new ToolError("The user stopped computer use during this action.");
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
      const child = Bun.spawn(["osascript", ...script.flatMap((line) => ["-e", line]), message], { stdout: "pipe", stderr: "pipe" });
      const [answer, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      // Exit 0 with no button means the dialog gave up after 120 s; error -128 is Deny.
      if (code === 0) return answer.trim() === "Allow";
      if (/\(-128\)/.test(errors)) return false;
      throw new Error(`the approval dialog failed: ${errors.trim() || `exit ${code}`}`);
    },
    startOverlay(label, stopFile, onExit) {
      const child = spawn(bin(), ["overlay", String(process.pid), stopFile, label], { stdio: ["ignore", "ignore", "inherit"] });
      child.on("exit", (code, signal) => onExit(panelExit(code, signal)));
      child.on("error", (error) => onExit(`could not start: ${error.message}`));
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
  const stateDir = stateDirFor(process.env);
  const desktop = createDesktop({ ...realDependencies(stateDir), stateDir });
  process.on("exit", () => desktop.release());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(0));

  const send = (response) => process.stdout.write(`${JSON.stringify(response)}\n`);
  // Messages are handled one at a time, so actions never interleave. A failure answers that
  // message and leaves the queue running.
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
          send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          return;
        }
        try {
          const response = await handle(desktop, message);
          if (response) send(response);
        } catch (error) {
          process.stderr.write(`desktop: ${error.stack ?? error}\n`);
          if (message?.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error.message ?? error) } });
        }
      });
    }
  });
  process.stdin.on("end", () => queue.then(() => process.exit(0)));
}
