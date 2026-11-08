import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseApp, createDesktop, fitScreenshot, handle, modifierList, parseKey, SERVER_NAME, sensitiveReason, stopPath, toGlobal, TOOLS } from "./desktop.js";

// A Retina laptop as the main display and a 1080p display to its left, one point above.
const RETINA = { index: 0, id: 1, main: true, x: 0, y: 0, width: 1470, height: 956, pixelWidth: 2940, pixelHeight: 1912, scale: 2 };
const SIDE = { index: 1, id: 2, main: false, x: -1920, y: -1, width: 1920, height: 1080, pixelWidth: 1920, pixelHeight: 1080, scale: 1 };

const SAFARI = { name: "Safari", bundleId: "com.apple.Safari", category: "public.app-category.productivity" };
const NOTES = { name: "Notes", bundleId: "com.apple.Notes" };
const BANK = { name: "Chase", bundleId: "com.chase.sig.Chase", category: "public.app-category.finance" };
const HELIUM = { name: "Helium", bundleId: "net.imput.helium", pid: 82 };
// The Dock's localized name on a Chinese system.
const DOCK = { name: "程序坞", bundleId: "com.apple.dock", pid: 30 };
const SCREENCAPTURE = { name: "screencaptureui", bundleId: "com.apple.screencaptureui", pid: 40 };
const FINDER = { name: "Finder", bundleId: "com.apple.finder", pid: 20 };
const DOCK_LEVEL = 20;

// A window of `app` at a point; by default an ordinary window at layer 0.
const win = (app, { layer = 0, alpha = 1, bounds = { x: 0, y: 30, width: 1470, height: 875 }, owner = app.name, name = "" } = {}) =>
  ({ owner, name, layer, alpha, bounds, pid: app.pid ?? 1, app });
// The Dock's full-display window over the Retina display.
const dockLayer = (overrides = {}) => win(DOCK, { layer: DOCK_LEVEL, bounds: { x: 0, y: 0, width: 1470, height: 956 }, ...overrides });
const scene = (windows, hitPid = windows.at(-1)?.pid ?? null) =>
  ({ windows, hitPid, dockLevel: DOCK_LEVEL, displays: [RETINA, SIDE].map(({ x, y, width, height }) => ({ x, y, width, height })), frontmost: SAFARI, finder: FINDER });

describe("screenshots and coordinates", () => {
  test("screenshots fit 1568 px and about 1.15 megapixels", () => {
    expect(fitScreenshot(2940, 1912)).toEqual({ width: 1330, height: 865 });
    expect(fitScreenshot(1920, 1080)).toEqual({ width: 1430, height: 804 });
    expect(fitScreenshot(800, 600)).toEqual({ width: 800, height: 600 });
  });

  test("a point in a Retina screenshot maps to display points", () => {
    const shot = { ...fitScreenshot(RETINA.pixelWidth, RETINA.pixelHeight), display: RETINA };
    expect(toGlobal(RETINA, shot, 665, 432.5)).toEqual({ x: 735, y: 478 });
    expect(toGlobal(RETINA, shot, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  test("a point on the second display includes its origin", () => {
    const shot = { ...fitScreenshot(SIDE.pixelWidth, SIDE.pixelHeight), display: SIDE };
    expect(toGlobal(SIDE, shot, 715, 402)).toEqual({ x: -960, y: 539 });
  });

  test("a point outside the screenshot is refused", () => {
    const shot = { width: 100, height: 50 };
    expect(() => toGlobal(RETINA, shot, 100, 10)).toThrow("outside the 100x50 screenshot");
    expect(() => toGlobal(RETINA, shot, -1, 10)).toThrow();
    expect(() => toGlobal(RETINA, shot, Number.NaN, 10)).toThrow();
  });
});

describe("keys", () => {
  test.each([
    ["Return", 36, ""],
    ["enter", 36, ""],
    ["cmd+t", 17, "cmd"],
    ["Cmd+Shift+T", 17, "cmd,shift"],
    ["ctrl+alt+Delete", 117, "ctrl,alt"],
    ["shift+Tab", 48, "shift"],
    ["Escape", 53, ""],
    ["Page Down", 121, ""],
    ["F5", 96, ""],
  ])("%s", (combo, code, modifiers) => {
    expect(parseKey(combo)).toEqual({ code, modifiers });
  });

  test("unknown keys and modifiers are refused", () => {
    expect(() => parseKey("cmd+banana")).toThrow('Unknown key "banana"');
    expect(() => parseKey("hyper+a")).toThrow('Unknown modifier "hyper"');
  });

  test("a combo that is not text and modifiers that are not a list are refused", () => {
    expect(() => parseKey(undefined)).toThrow("Give combo");
    expect(() => parseKey(5)).toThrow("Give combo");
    expect(() => modifierList("cmd")).toThrow("modifiers must be a list");
  });
});

describe("sensitive apps", () => {
  test.each([
    [BANK, "finance"],
    [{ name: "Health", bundleId: "com.apple.Health" }, "health"],
    [{ name: "MyChart", bundleId: "org.epic.mychart" }, "mychart"],
    [{ name: "Tax Portal", bundleId: "gov.irs.portal" }, "gov"],
    [{ name: "1Password", bundleId: "com.1password.1password" }, "1password"],
    [{ name: "Passwords", bundleId: "com.apple.Passwords" }, "passwords"],
    [{ name: "Keychain Access", bundleId: "com.apple.keychainaccess" }, "keychain"],
    [{ name: "Doctor Notes", category: "public.app-category.medical" }, "medical"],
    [{ name: "desktop-helper", bundleId: "" }, "stop panel"],
    [{ name: "desktop-helper-0123456789ab", bundleId: "" }, "stop panel"],
    [{ name: "Bitwarden", bundleId: "com.bitwarden.desktop" }, "bitwarden"],
    [{ name: "KeePassXC", bundleId: "org.keepassxc.keepassxc" }, "keepassxc"],
    [{ name: "Proton Pass", bundleId: "me.proton.pass.electron" }, "proton pass"],
    [{ name: "Authy Desktop", bundleId: "com.authy.authy-mac" }, "authy"],
  ])("%o is refused", (app, word) => {
    expect(sensitiveReason(app)).toContain(word);
  });

  test.each([[SAFARI], [NOTES], [{ name: "Otherwise", bundleId: "com.example.otherwise" }], [{ name: "TextEdit", bundleId: "com.apple.TextEdit" }]])(
    "%o is allowed", (app) => {
      expect(sensitiveReason(app)).toBeUndefined();
    });
});

describe("the app under the pointer", () => {
  const helium = win(HELIUM);

  test("the topmost ordinary window decides", () => {
    expect(chooseApp(scene([win(NOTES), helium]))).toBe(NOTES);
    expect(chooseApp(scene([helium]))).toBe(HELIUM);
  });

  test("the Dock's full-display layer is passed over when the hit-test reaches the app below", () => {
    expect(chooseApp(scene([dockLayer(), helium], HELIUM.pid))).toBe(HELIUM);
    // A full-display Dock window on the second display, too.
    expect(chooseApp(scene([dockLayer({ bounds: { x: -1920, y: -1, width: 1920, height: 1080 } }), helium], HELIUM.pid))).toBe(HELIUM);
  });

  test("the Dock's tiles, where the hit-test finds the Dock, decide", () => {
    expect(chooseApp(scene([dockLayer(), helium], DOCK.pid))).toBe(DOCK);
  });

  test("a failed hit-test fails closed", () => {
    expect(chooseApp(scene([dockLayer(), helium], null))).toBe(DOCK);
  });

  test("past the Dock's layer, the deciding window must belong to the app the hit-test found", () => {
    // The hit-test found an app whose window is not in the list, or is one the loop passes over.
    expect(chooseApp(scene([dockLayer(), helium], 77))).toBeNull();
    const appless = { owner: "SomeService", name: "", layer: 0, alpha: 1, bounds: { x: 0, y: 30, width: 400, height: 300 }, pid: 77, app: null };
    expect(chooseApp(scene([dockLayer(), appless, helium], 77))).toBeNull();
    // The bare desktop past the Dock's layer is Finder's only when the hit-test says so.
    expect(chooseApp(scene([dockLayer()], FINDER.pid))).toBe(FINDER);
    expect(chooseApp(scene([dockLayer()], HELIUM.pid))).toBeNull();
  });

  test.each([
    ["a Dock menu", { layer: 101 }],
    ["Mission Control", { layer: 18 }],
    ["a Dock window smaller than the display", { bounds: { x: 0, y: 880, width: 1470, height: 76 } }],
  ])("%s decides", (_, overrides) => {
    expect(chooseApp(scene([dockLayer(overrides), helium], HELIUM.pid))).toBe(DOCK);
  });

  test("the Dock is matched by bundle id, never by name", () => {
    const impostor = { name: "Dock", bundleId: "com.example.dock", pid: 50 };
    expect(chooseApp(scene([win(impostor, { layer: DOCK_LEVEL, bounds: { x: 0, y: 0, width: 1470, height: 956 } }), helium], HELIUM.pid))).toBe(impostor);
    // The real Dock under any localized name is still passed over.
    expect(chooseApp(scene([dockLayer({ owner: "Dock" }), helium], HELIUM.pid))).toBe(HELIUM);
  });

  test("a visible screencaptureui window decides; an invisible one does not", () => {
    expect(chooseApp(scene([win(SCREENCAPTURE, { layer: 1000 }), helium], HELIUM.pid))).toBe(SCREENCAPTURE);
    expect(chooseApp(scene([win(SCREENCAPTURE, { layer: 1000, alpha: 0.2 }), helium], HELIUM.pid))).toBe(SCREENCAPTURE);
    expect(chooseApp(scene([win(SCREENCAPTURE, { layer: 1000, alpha: 0 }), helium], HELIUM.pid))).toBe(HELIUM);
  });

  test("the menu bar is the frontmost app's and the bare desktop is Finder's", () => {
    const menubar = { owner: "Window Server", name: "Menubar", layer: 24, alpha: 1, bounds: { x: 0, y: 0, width: 1470, height: 30 }, pid: 1, app: null };
    expect(chooseApp(scene([menubar, helium]))).toBe(SAFARI);
    expect(chooseApp(scene([{ ...menubar, name: "Backstop" }, helium]))).toBe(HELIUM);
    expect(chooseApp(scene([]))).toBe(FINDER);
  });
});

describe("session", () => {
  let stateDir;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "desktop-mcp-"));
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  // A fake Mac: apps by name, the app under each point, the focused app, and a log of the
  // helper calls that change something.
  // `under` gives an app, which becomes a one-window scene, or a whole scene. `focus` is the
  // helper's focused reply; `front` is the focused app when `focus` is not given.
  function fakeMac({ under = () => SAFARI, front = SAFARI, focus, frontmost = front, allow = true, pid = 100, holds = () => true } = {}) {
    const apps = { Safari: SAFARI, Notes: NOTES, Chase: BANK, Helium: HELIUM };
    const toScene = (value) => (value === null ? { ...scene([]), finder: null } : "windows" in value ? value : scene([win(value)]));
    const mac = { actions: [], dialogs: [], overlays: [] };
    mac.desktop = createDesktop({
      stateDir, pid, holds,
      helper(args) {
        switch (args[0]) {
          case "displays": return [RETINA, SIDE];
          case "app-info": return apps[args[1]] ?? null;
          case "scene": return toScene(under({ x: Number(args[1]), y: Number(args[2]) }));
          case "focused":
            if (!focus) return { app: front };
            return "axError" in focus ? { ...focus, frontmost: typeof frontmost === "function" ? frontmost() : frontmost } : focus;
          case "screenshot": return { path: args[4] };
          default:
            mac.actions.push(args);
            return { ok: true };
        }
      },
      async dialog(text) {
        mac.dialogs.push(text);
        return typeof allow === "function" ? allow(mac) : allow;
      },
      startOverlay(label, stopFile, onExit) {
        const overlay = { label, stopFile, onExit, stopped: false, stop() { overlay.stopped = true; } };
        mac.overlays.push(overlay);
        return overlay;
      },
      open: (app) => mac.actions.push(["open", app.bundleId]),
      readImage: () => "aW1n",
    });
    mac.call = async (name, args) => {
      const result = await mac.desktop.call(name, args);
      return { error: result.isError === true, text: result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), result };
    };
    return mac;
  }

  test("nothing is controlled before request_access", async () => {
    const mac = fakeMac();
    expect((await mac.call("screenshot", {})).text).toBe("Call request_access first.");
    expect((await mac.call("type", { text: "hi" })).text).toBe("Call request_access first.");
    expect(mac.actions).toEqual([]);
  });

  test("approval shows a dialog for the asked apps, refuses a bank app, and starts the stop panel", async () => {
    const mac = fakeMac();
    const result = await mac.call("request_access", { apps: ["Safari", "Chase", "Nope"], reason: "Check the page title." });
    expect(result.text).toContain("Refused: Chase: it is a finance app.");
    expect(result.text).toContain("Not found: Nope.");
    expect(result.text).toContain("Approved: Safari.");
    expect(mac.dialogs).toHaveLength(1);
    expect(mac.dialogs[0]).toContain("Claude wants to control: Safari.");
    expect(mac.dialogs[0]).not.toContain("Chase");
    expect(mac.overlays).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(stateDir, "session.json"), "utf8"))).toEqual({ pid: 100 });
  });

  test("a denied dialog approves nothing and frees the lock", async () => {
    const mac = fakeMac({ allow: false });
    expect((await mac.call("request_access", { apps: ["Safari"], reason: "r" })).text).toContain("The user denied: Safari.");
    expect(mac.overlays).toHaveLength(0);
    expect(existsSync(join(stateDir, "session.json"))).toBe(false);
    expect((await mac.call("screenshot", {})).text).toBe("Call request_access first.");
  });

  test("a click maps screenshot pixels to the display and lands in an approved app", async () => {
    const mac = fakeMac();
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    const shot = await mac.call("screenshot", {});
    expect(shot.result.content[0]).toEqual({ type: "image", data: "aW1n", mimeType: "image/jpeg" });
    expect(shot.text).toContain("Display 0 of 2, 1330x865 px");
    expect((await mac.call("click", { x: 665, y: 432.5 })).text).toBe("Clicked in Safari.");
    expect(mac.actions).toEqual([["click", "735", "478", "left", "1", ""]]);
  });

  test("a click on the second display uses that screenshot", async () => {
    const mac = fakeMac();
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    expect((await mac.call("click", { x: 1, y: 1 })).text).toBe("Take a screenshot first.");
    await mac.call("screenshot", { display: 1 });
    await mac.call("click", { x: 715, y: 402, count: 2, modifiers: ["command"] });
    expect(mac.actions).toEqual([["click", "-960", "539", "left", "2", "cmd"]]);
    expect((await mac.call("click", { x: 1, y: 1, display: 0 })).text).toBe("Take a screenshot of display 0 first.");
  });

  test("a click on an unapproved or sensitive app is refused", async () => {
    let under = SAFARI;
    const mac = fakeMac({ under: () => under });
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    await mac.call("screenshot", {});
    under = NOTES;
    expect((await mac.call("click", { x: 10, y: 10 })).text).toBe("Notes (under the pointer) is not approved. Call request_access with it first.");
    under = BANK;
    expect((await mac.call("click", { x: 10, y: 10 })).text).toBe("Chase is refused: it is a finance app.");
    under = null;
    expect((await mac.call("scroll", { x: 10, y: 10, direction: "down" })).text).toBe("No app found under the pointer; nothing was done.");
    expect(mac.actions).toEqual([]);
  });

  test("keys and typing go only to an approved focused app", async () => {
    const mac = fakeMac({ front: NOTES });
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    expect((await mac.call("key", { combo: "cmd+t" })).error).toBe(true);
    expect((await mac.call("type", { text: "secret" })).error).toBe(true);
    await mac.call("request_access", { apps: ["Notes"], reason: "r" });
    expect((await mac.call("key", { combo: "cmd+t" })).text).toBe("Pressed cmd+t in Notes.");
    expect(mac.actions).toEqual([["key", "17", "cmd"]]);
    expect(mac.overlays).toHaveLength(1);
  });

  test("with only Helium approved, a click passes the Dock's layer but not its tiles or a screenshot overlay", async () => {
    let under = scene([dockLayer(), win(HELIUM)], HELIUM.pid);
    const mac = fakeMac({ under: () => under });
    await mac.call("request_access", { apps: ["Helium"], reason: "r" });
    await mac.call("screenshot", {});
    expect((await mac.call("click", { x: 10, y: 10 })).text).toBe("Clicked in Helium.");
    expect((await mac.call("mouse_move", { x: 10, y: 10 })).text).toBe("Moved the pointer over Helium.");
    expect(mac.actions.map((action) => action[0])).toEqual(["click", "move"]);
    mac.actions.length = 0;
    under = scene([dockLayer(), win(HELIUM)], DOCK.pid);
    expect((await mac.call("click", { x: 10, y: 10 })).text).toBe("程序坞 (under the pointer) is not approved. Call request_access with it first.");
    under = scene([dockLayer({ layer: 101 }), win(HELIUM)], HELIUM.pid);
    expect((await mac.call("click", { x: 10, y: 10 })).text).toContain("程序坞 (under the pointer) is not approved");
    under = scene([dockLayer(), win(HELIUM)], null);
    expect((await mac.call("click", { x: 10, y: 10 })).text).toContain("程序坞 (under the pointer) is not approved");
    under = scene([win(SCREENCAPTURE, { layer: 1000 }), dockLayer(), win(HELIUM)], HELIUM.pid);
    expect((await mac.call("click", { x: 10, y: 10 })).text).toBe("screencaptureui (under the pointer) is not approved. Call request_access with it first.");
    expect(mac.actions).toEqual([]);
  });

  test("when Accessibility finds no focused app, keys and typing go to the frontmost app only if it is approved", async () => {
    let frontmost = HELIUM;
    const mac = fakeMac({ focus: { axError: -25212 }, frontmost: () => frontmost });
    await mac.call("request_access", { apps: ["Helium"], reason: "r" });
    expect((await mac.call("type", { text: "hi" })).text).toBe("Typed into Helium.");
    frontmost = NOTES;
    expect((await mac.call("type", { text: "secret" })).text).toBe(
      "Notes (the frontmost app; Accessibility found no focused app, error -25212) is not approved. Call request_access with it first.");
    expect((await mac.call("key", { combo: "cmd+t" })).error).toBe(true);
    frontmost = BANK;
    expect((await mac.call("key", { combo: "cmd+t" })).text).toBe("Chase is refused: it is a finance app.");
    frontmost = null;
    expect((await mac.call("type", { text: "x" })).text).toContain("No app found the frontmost app");
    expect(mac.actions).toEqual([["type", "hi"]]);
  });

  test("any Accessibility error on the focus query uses the frontmost app", async () => {
    const mac = fakeMac({ focus: { axError: -25204 }, frontmost: HELIUM });
    await mac.call("request_access", { apps: ["Helium"], reason: "r" });
    expect((await mac.call("key", { combo: "cmd+l" })).text).toBe("Pressed cmd+l in Helium.");
  });

  test("a focused-app answer without an app is refused, not replaced by the frontmost app", async () => {
    const mac = fakeMac({ focus: { app: null }, frontmost: SAFARI });
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    expect((await mac.call("type", { text: "hi" })).text).toBe("No app found the app with keyboard focus; nothing was done.");
    expect(mac.actions).toEqual([]);
  });

  test("a drag checks both ends", async () => {
    const mac = fakeMac({ under: (p) => (p.x > 500 ? NOTES : SAFARI) });
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    await mac.call("screenshot", {});
    expect((await mac.call("drag", { from_x: 10, from_y: 10, to_x: 1000, to_y: 10 })).text).toContain("Notes (under the pointer) is not approved");
    expect(mac.actions).toEqual([]);
  });

  test("open_app opens only approved apps", async () => {
    const mac = fakeMac();
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    expect((await mac.call("open_app", { app: "Notes" })).error).toBe(true);
    expect((await mac.call("open_app", { app: "Safari" })).text).toBe("Opened Safari.");
    expect(mac.actions).toEqual([["open", "com.apple.Safari"]]);
  });

  test("the stop panel ends the session at once", async () => {
    const mac = fakeMac();
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    await mac.call("screenshot", {});
    mac.overlays[0].onExit(0);
    expect(existsSync(join(stateDir, "session.json"))).toBe(false);
    expect((await mac.call("click", { x: 10, y: 10 })).text).toBe("The user stopped computer use. Ask the user before calling request_access again.");
    expect((await mac.call("click", { x: 10, y: 10 })).text).toBe("Call request_access first.");
    expect(mac.actions).toEqual([]);
    // Asking again shows a new dialog; nothing stays approved from before.
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    expect(mac.dialogs).toHaveLength(2);
    expect(mac.overlays).toHaveLength(2);
  });

  test("a second session cannot take control while the first holds it", async () => {
    const first = fakeMac({ pid: 100 });
    const second = fakeMac({ pid: 200 });
    await first.call("request_access", { apps: ["Safari"], reason: "r" });
    const refused = await second.call("request_access", { apps: ["Safari"], reason: "r" });
    expect(refused.text).toBe("Another session (pid 100) is controlling this computer. Try again after it releases.");
    expect(second.dialogs).toHaveLength(0);
    expect((await first.call("release", {})).text).toContain("Released");
    expect(first.overlays[0].stopped).toBe(true);
    expect((await second.call("request_access", { apps: ["Safari"], reason: "r" })).text).toContain("Approved: Safari.");
  });

  test("pressing Stop interrupts actions already queued", async () => {
    const mac = fakeMac();
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    await mac.call("screenshot", {});
    // The panel writes the stop file before its exit event reaches the server.
    expect(mac.overlays[0].stopFile).toBe(stopPath(stateDir, 100));
    writeFileSync(mac.overlays[0].stopFile, "");
    expect((await mac.call("click", { x: 10, y: 10 })).text).toBe("The user stopped computer use. Ask the user before calling request_access again.");
    expect(mac.overlays[0].stopped).toBe(true);
    expect(existsSync(join(stateDir, "session.json"))).toBe(false);
    expect(mac.actions).toEqual([]);
    // A later approval clears the stop file.
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    expect(existsSync(stopPath(stateDir, 100))).toBe(false);
    await mac.call("screenshot", {});
    expect((await mac.call("click", { x: 10, y: 10 })).text).toBe("Clicked in Safari.");
  });

  test("Allow after Stop during the dialog takes the lock again", async () => {
    const mac = fakeMac({
      allow: (m) => {
        // The user presses Stop on the open panel, then answers Allow in the second dialog.
        if (m.dialogs.length === 2) m.overlays[0].onExit(0);
        return true;
      },
    });
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    expect((await mac.call("request_access", { apps: ["Notes"], reason: "r" })).text).toContain("Approved apps: Notes.");
    expect(JSON.parse(readFileSync(join(stateDir, "session.json"), "utf8"))).toEqual({ pid: 100 });
    expect(mac.overlays).toHaveLength(2);
    await mac.call("screenshot", {});
    expect((await mac.call("click", { x: 10, y: 10 })).text).toContain("Safari (under the pointer) is not approved");
  });

  test("a session that lost its lock stops acting", async () => {
    const mac = fakeMac();
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    writeFileSync(join(stateDir, "session.json"), JSON.stringify({ pid: 300 }));
    expect((await mac.call("screenshot", {})).text).toContain("lost the session lock");
    expect(mac.overlays[0].stopped).toBe(true);
    expect((await mac.call("screenshot", {})).text).toBe("Call request_access first.");
  });

  test("a corrupt lock file counts as free", async () => {
    writeFileSync(join(stateDir, "session.json"), "{not json");
    const mac = fakeMac();
    expect((await mac.call("request_access", { apps: ["Safari"], reason: "r" })).text).toContain("Approved: Safari.");
    expect(JSON.parse(readFileSync(join(stateDir, "session.json"), "utf8"))).toEqual({ pid: 100 });
  });

  test("bad arguments are tool errors and do nothing", async () => {
    const mac = fakeMac();
    expect((await mac.call("request_access", { apps: "Safari", reason: "r" })).text).toContain("apps must be a list");
    expect((await mac.call("request_access", { apps: ["Safari"] })).text).toContain("Give a reason");
    await mac.call("request_access", { apps: ["Safari"], reason: "r" });
    await mac.call("screenshot", {});
    expect((await mac.call("click", { x: 10, y: 10, button: "huge" })).text).toBe("button must be one of left, right, middle.");
    expect((await mac.call("click", { x: 10, y: 10, count: 9 })).text).toBe("count must be a whole number from 1 to 3.");
    expect((await mac.call("click", { x: 10, y: 10, modifiers: "cmd" })).error).toBe(true);
    expect((await mac.call("scroll", { x: 10, y: 10, direction: "sideways" })).error).toBe(true);
    expect((await mac.call("scroll", { x: 10, y: 10, direction: "up", amount: 0.5 })).error).toBe(true);
    expect((await mac.call("type", { text: 42 })).error).toBe(true);
    expect((await mac.call("key", {})).text).toContain("Give combo");
    expect((await mac.call("open_app", {})).text).toContain("Give app");
    expect((await mac.call("screenshot", { display: "0" })).error).toBe(true);
    expect((await mac.call("click", null)).text).toBe("Tool arguments must be an object.");
    expect(mac.actions).toEqual([]);
  });

  test("a lock left by a dead session is taken over", async () => {
    const first = fakeMac({ pid: 100 });
    await first.call("request_access", { apps: ["Safari"], reason: "r" });
    const second = fakeMac({ pid: 200, holds: (pid) => pid !== 100 });
    expect((await second.call("request_access", { apps: ["Safari"], reason: "r" })).text).toContain("Approved: Safari.");
    expect(JSON.parse(readFileSync(join(stateDir, "session.json"), "utf8"))).toEqual({ pid: 200 });
  });
});

describe("MCP protocol", () => {
  const desktop = { call: async (name) => ({ content: [{ type: "text", text: name }] }) };

  test("the server is not named computer-use", async () => {
    const response = await handle(desktop, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(SERVER_NAME).toBe("desktop");
    expect(response.result.serverInfo.name).toBe("desktop");
    expect(response.result.protocolVersion).toBe("2025-06-18");
    expect(response.result.capabilities).toEqual({ tools: {} });
  });

  test("it lists the tools and calls them", async () => {
    const list = await handle(desktop, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.result.tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    expect(list.result.tools.map((tool) => tool.name)).toContain("request_access");
    const call = await handle(desktop, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "screenshot", arguments: {} } });
    expect(call.result.content[0].text).toBe("screenshot");
  });

  test("a helper failure becomes a tool error, not a crash", async () => {
    const broken = { call: async () => { throw new Error("boom"); } };
    const call = await handle(broken, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "click", arguments: {} } });
    expect(call.result).toEqual({ content: [{ type: "text", text: "The desktop helper failed: boom" }], isError: true });
  });

  test("a message that is not an object is an invalid request", async () => {
    expect((await handle(desktop, null)).error.code).toBe(-32600);
    expect((await handle(desktop, [1])).error.code).toBe(-32600);
  });

  test("notifications get no answer and unknown methods an error", async () => {
    expect(await handle(desktop, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect((await handle(desktop, { jsonrpc: "2.0", id: 5, method: "resources/list" })).error.code).toBe(-32601);
  });
});
