import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../tests/lib/process.js";
import { browseArgv, captureShots, prepareRevision, serve } from "./capture.js";
import { checkTotals } from "./checks.js";
import { climbNoise, plateau, run as runCli, scoreLine } from "./cli.js";
import { ConfigError, DEFAULT_CONTROL_CSS, MAX_IMAGES, productShots, referenceShots, validateConfig } from "./config.js";
import {
  avoidList, barReach, buildContent, calibrationOf, checkRequestSize, combine, councilVersion, JudgeFailedError, JudgeOutputError, MAX_IMAGE_BYTES, MAX_REQUEST_BYTES,
  readOutput, RUBRIC, runJudge, shuffle, systemPrompt, topIssues, verdict,
} from "./council.js";
import { evaluateGates } from "./gates.js";
import { endLabels, escape, renderReport } from "./report.js";
import { identity, lockRun, RunError } from "./run.js";

const CLI = join(import.meta.dir, "..", "cli.js");
const FAKE = join(import.meta.dir, "..", "lib", "testing", "fake-claude.js");
const FAKE_JUDGE = join(import.meta.dir, "testing", "fake-judge.js");
const CATEGORIES = RUBRIC.categories.map((category) => category.id);
// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let scratch;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "claude-factory-ui-test-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const FILE = "/project/ui-climb.json";
const base = (extra = {}) => ({
  version: 1,
  name: "demo",
  product: "A task tracker for small teams.",
  serve: { command: ["bun", "server.ts", "--port", "{port}"], ready: "/healthz" },
  screens: [
    { id: "home", title: "Home", path: "/", views: ["desktop-light", "phone-dark"] },
    { id: "task", title: "Task", path: "/tasks/1", views: ["desktop-dark"], steps: [{ click: "text=Open" }, { wait: 100 }], before: ["/__dev/x"] },
  ],
  judges: [{ model: "claude-sonnet-5-5" }, { model: "claude-opus-5-5", effort: "high", samples: 3 }],
  ...extra,
});

describe("config", () => {
  test("fills defaults and normalizes screens and judges", () => {
    const config = validateConfig(base(), FILE);
    expect(config.rootDir).toBe("/project");
    expect(config.serve).toEqual({ command: ["bun", "server.ts", "--port", "{port}"], ready: "/healthz", timeoutMs: 60_000 });
    expect(config.judges).toEqual([{ model: "claude-sonnet-5-5", effort: "medium", samples: 2 }, { model: "claude-opus-5-5", effort: "high", samples: 3 }]);
    expect(config.pass).toEqual({ min: 8.5, gain: 0.5, references: null });
    expect(config.budgetUsd).toEqual({ call: 2, round: 15, run: 100 });
    expect(config.baseline).toBe("origin/main");
    expect(config.controlCss).toBe(DEFAULT_CONTROL_CSS);
    expect(config.screens[1].steps).toEqual([{ kind: "click", arg: "text=Open" }, { kind: "wait", arg: "100" }]);
    expect(productShots(config).map((shot) => [shot.id, shot.width, shot.scheme, shot.narrow])).toEqual([
      ["home.desktop-light", 1280, "light", false], ["home.phone-dark", 390, "dark", true], ["task.desktop-dark", 1280, "dark", false],
    ]);
  });

  test.each([
    [{ extra: 1 }, 'unknown field "extra"'],
    [{ version: 2 }, "version must be 1"],
    [{ name: "Has Spaces" }, "name must be"],
    [{ serve: { command: ["bun", "server.ts"] } }, "must contain {port}"],
    [{ viewports: { desktop: { width: 1280 } } }, "viewports.desktop.height"],
    [{ screens: [{ id: "a", title: "A", path: "/", views: ["tablet-light"] }] }, '"tablet-light" is not'],
    [{ screens: [{ id: "a", title: "A", path: "/", views: ["desktop-light"], steps: [{ click: "x", hover: "y" }] }] }, "exactly one of"],
    [{ screens: [{ id: "a", title: "A", path: "/", views: ["desktop-light"], steps: [{ fill: "input" }] }] }, "SELECTOR=TEXT"],
    // Names inherited from Object are not viewports or steps.
    [{ screens: [{ id: "a", title: "A", path: "/", views: ["constructor-light"] }] }, '"constructor-light" is not'],
    [{ screens: [{ id: "a", title: "A", path: "/", views: ["desktop-light"], steps: [{ toString: "x" }] }] }, "exactly one of"],
    [{ screens: [{ id: "a", title: "A", path: "x", views: ["desktop-light"] }] }, "path must start with /"],
    [{ screens: [{ id: "a", title: "A", path: "/", views: ["desktop-light"] }, { id: "a", title: "B", path: "/b", views: ["desktop-light"] }] }, "used twice"],
    [{ references: [{ id: "r", title: "R" }] }, "either url (with views) or files"],
    [{ references: [{ id: "r", title: "R", files: [{ path: "missing.png", view: "desktop-light" }] }] }, "does not exist"],
    [{ judges: [{ model: "m", effort: "turbo" }] }, "effort must be one of"],
    [{ judges: [{ model: "m" }, { model: "m" }] }, "same model and effort twice"],
    [{ budgetUsd: { call: 20, round: 10 } }, "call must not exceed"],
    [{ pass: { min: 11 } }, "pass.min must be"],
  ])("rejects %j", (extra, message) => {
    expect(() => validateConfig(base(extra), FILE)).toThrow(ConfigError);
    expect(() => validateConfig(base(extra), FILE)).toThrow(message);
  });

  test("keeps a judge call within the API's image limit", () => {
    const views = ["desktop-light", "desktop-dark", "phone-light", "phone-dark"];
    const screens = Array.from({ length: 12 }, (_, index) => ({ id: `s${index}`, title: "S", path: "/", views }));
    expect(() => validateConfig(base({ screens }), FILE)).toThrow(`would carry 96 images`);
    expect(2 * 4 * 11).toBeLessThanOrEqual(MAX_IMAGES);
    expect(() => validateConfig(base({ screens: screens.slice(0, 11) }), FILE)).not.toThrow();
  });

  test("names reference shots by reference and view", () => {
    const dir = join(scratch, "refs");
    mkdirSync(dir, { recursive: true });
    for (const name of ["a.png", "b.png"]) writeFileSync(join(dir, name), PNG);
    const config = validateConfig(base({ references: [
      { id: "files", title: "Files", files: [{ path: "a.png", view: "desktop-light" }, { path: "b.png", view: "desktop-light" }] },
      { id: "site", title: "Site", url: "https://example.com", views: ["phone-light"] },
    ] }), join(dir, "ui-climb.json"));
    expect(referenceShots(config).map((shot) => [shot.id, shot.file ?? shot.url])).toEqual([
      ["files.desktop-light.1", join(dir, "a.png")], ["files.desktop-light.2", join(dir, "b.png")], ["site.phone-light", "https://example.com"],
    ]);
  });
});

describe("capture", () => {
  test("turns a shot's steps into browser flags in order, with checks just before the screenshot", () => {
    const [, , shot] = productShots(validateConfig(base(), FILE));
    const argv = browseArgv(shot, { url: "http://127.0.0.1:1/tasks/1", out: "/tmp/x.png", settleMs: 300, inject: "body { color: red }" });
    const flags = argv.slice(3).filter((part) => part.startsWith("--"));
    expect(flags).toEqual(["--width", "--height", "--scheme", "--reduced-motion", "--timeout", "--click", "--wait", "--eval", "--wait", "--eval", "--shot"]);
    expect(argv[argv.indexOf("--scheme") + 1]).toBe("dark");
    expect(argv[argv.indexOf("--click") + 1]).toBe("text=Open");
    expect(argv.at(-1)).toBe("/tmp/x.png");
    expect(argv.at(-3)).toContain("pageChecks");
  });

  const gitIn = async (cwd, ...args) => {
    const result = await runProcess(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, env: process.env });
    expect(result.code).toBe(0);
    return result.stdout.trim();
  };

  test("extracts a revision's root inside the extract, even when the root is reached through a symbolic link", async () => {
    const repo = mkdtempSync(join(scratch, "revision-"));
    mkdirSync(join(repo, "web"));
    writeFileSync(join(repo, "web", "index.html"), "committed");
    await gitIn(repo, "init", "-q", "-b", "main");
    await gitIn(repo, "add", "-A");
    await gitIn(repo, "commit", "-q", "-m", "c");
    const sha = await gitIn(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "web", "index.html"), "uncommitted");
    const link = join(scratch, "web-link");
    symlinkSync(join(repo, "web"), link);
    const source = await prepareRevision({ rootDir: link, setup: [] }, sha);
    try {
      expect(source.root.endsWith("/web")).toBe(true);
      expect(realpathSync(source.root).startsWith(realpathSync(repo))).toBe(false);
      expect(readFileSync(join(source.root, "index.html"), "utf8")).toBe("committed");
    } finally {
      source.dispose();
    }
    expect(existsSync(source.root)).toBe(false);
  });

  test("keeps a reference file's type for the judges and the report", async () => {
    const jpeg = join(scratch, "peer.jpg");
    writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const [record] = await captureShots([{ id: "peer.desktop-light", file: jpeg }], { dir: join(scratch, "peer-copy") });
    expect(record.file).toBe(join(scratch, "peer-copy", "peer.desktop-light.jpg"));
    const shot = { ...record, title: "Peer", view: "desktop-light", scheme: "light", width: 1280, height: 800, narrow: false };
    const { content } = buildContent([{ key: "ref:peer", kind: "reference", title: "Peer", shots: [shot] }]);
    expect(content.find((block) => block.type === "image").source.media_type).toBe("image/jpeg");
  });

  test("finds a server on either loopback address and stops its descendants in other process groups", async () => {
    const ipv6 = await new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(0, "::1", () => probe.close(() => resolve(true)));
    });
    const dir = mkdtempSync(join(scratch, "serve-"));
    const pidFile = join(dir, "helper.pid");
    writeFileSync(join(dir, "server.js"), `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const helper = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
Bun.serve({ hostname: ${JSON.stringify(ipv6 ? "::1" : "127.0.0.1")}, port, fetch: () => new Response("ok") });
`);
    const server = await serve({ serve: { command: ["bun", "server.js", "--port", "{port}"], ready: "/", timeoutMs: 20_000 } }, dir, join(dir, "server.log"));
    expect(server.origin).toContain(ipv6 ? "[::1]" : "127.0.0.1");
    const helper = Number(readFileSync(pidFile, "utf8"));
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(helper)).toBe(true);
    await server.stop();
    // A killed process is gone once its new parent reaps it.
    for (const deadline = Date.now() + 3000; alive(helper) && Date.now() < deadline;) await Bun.sleep(50);
    expect(alive(helper)).toBe(false);
  }, 30_000);
});

describe("run", () => {
  test("a run's lock keeps out a live holder and recovers from a dead or abandoned one", () => {
    const run = { id: "r1", dir: mkdtempSync(join(scratch, "lock-")) };
    const file = join(run.dir, "lock");
    const unlock = lockRun(run);
    expect(() => lockRun(run)).toThrow(`in use by process ${process.pid}`);
    unlock();
    // A holder that has exited.
    writeFileSync(file, String(Bun.spawnSync(["true"]).pid));
    lockRun(run)();
    // A holder this process may not signal is alive all the same.
    writeFileSync(file, "1");
    expect(() => lockRun(run)).toThrow("in use by process 1");
    // A lock its owner is still writing, then one its owner left half-written.
    writeFileSync(file, "");
    expect(() => lockRun(run)).toThrow(RunError);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(file, old, old);
    lockRun(run)();
    expect(existsSync(file)).toBe(false);
  });
});

// Two product versions and a reference, with fake shot files.
function versionsFor(dir) {
  mkdirSync(dir, { recursive: true });
  const shot = (name, screen, narrow) => {
    const file = join(dir, `${name}.png`);
    writeFileSync(file, Buffer.concat([PNG, Buffer.from(name)]));
    return { id: `${screen}.x`, file, screen, title: screen, view: narrow ? "phone-light" : "desktop-light", scheme: "light", width: narrow ? 390 : 1280, height: 800, narrow };
  };
  return [
    { key: "baseline", kind: "product", shots: [shot("b1", "home", false), shot("b2", "home", true)] },
    { key: "candidate", kind: "product", shots: [shot("c1", "home", false), shot("c2", "home", true)] },
    { key: "ref:linear", kind: "reference", title: "Linear", shots: [{ ...shot("r1", "x", false), screen: undefined, view: "desktop-light" }] },
  ];
}

const output = (labels, scoreOf, issues = []) => ({
  designs: [...labels].map(([design, key]) => ({ design, scores: Object.fromEntries(CATEGORIES.map((id) => [id, id === "responsive" && key.startsWith("ref:") ? null : scoreOf(key, id)])), summary: "" })),
  issues, strengths: [],
});

describe("council", () => {
  const config = validateConfig(base({ taste: ["No gradients on buttons."] }), FILE);

  test("the shuffle is deterministic per seed and varies between seeds", () => {
    const items = ["a", "b", "c", "d"];
    expect(shuffle(items, "s1")).toEqual(shuffle(items, "s1"));
    expect([...shuffle(items, "s1")].sort()).toEqual(items);
    expect(new Set(Array.from({ length: 10 }, (_, index) => shuffle(items, `s${index}`).join(""))).size).toBeGreaterThan(1);
  });

  test("prompts never say which design is main, the candidate or the control, or that a climb is running", () => {
    const versions = versionsFor(join(scratch, "blind"));
    const { content, labels } = buildContent(versions);
    const words = /\b(baseline|candidate|control|round|main|target|threshold|climb|bar|sha)\b/i;
    for (const block of content.filter((item) => item.type === "text")) expect(block.text).not.toMatch(words);
    expect(systemPrompt(config, ["Avoid pill-shaped tabs."])).not.toMatch(words);
    expect(content.filter((item) => item.type === "image")).toHaveLength(5);
    expect(content[0].text).toContain("Designs 1, 2 are versions of the product under review");
    expect(content[0].text).toContain("Design 3 is another product");
    expect([...labels.values()]).toEqual(["baseline", "candidate", "ref:linear"]);
    expect(systemPrompt(config, ["Avoid pill-shaped tabs."])).toContain("- No gradients on buttons.\n- Avoid pill-shaped tabs.");
  });

  test("the judge prompt points to the anchors without naming a typical range or capping scores", () => {
    const prompt = systemPrompt(config, []);
    expect(prompt).not.toMatch(/reserve 9|6 to 8|most real products/i);
    expect(prompt).toContain("- Use the whole scale and score each category against the anchors above.");
    for (const [score, meaning] of RUBRIC.scale) expect(prompt).toContain(`- ${score}: ${meaning}`);
  });

  test("reads the owner's declined patterns from the avoid list", () => {
    const file = join(scratch, "avoid.md");
    writeFileSync(file, "# Avoid\n\nIntro.\n\n## Patterns\n\n- Purple gradients.\n* Glass cards.\n\n## Later\n- not this\n");
    expect(avoidList(file)).toEqual(["Purple gradients.", "Glass cards."]);
    expect(avoidList(join(scratch, "none.md"))).toEqual([]);
  });

  test("maps scores back to versions and checks the output", () => {
    const versions = versionsFor(join(scratch, "read"));
    const labels = new Map([[2, "baseline"], [1, "candidate"], [3, "ref:linear"]]);
    const read = readOutput(output(labels, (key) => (key === "candidate" ? 9 : 7)), labels, versions);
    expect(read.scores.candidate.hierarchy).toBe(9);
    expect(read.scores["ref:linear"].responsive).toBeNull();
    expect(read.overall.baseline).toBe(7);
    const bad = output(labels, () => 7);
    expect(() => readOutput({ ...bad, designs: bad.designs.slice(1) }, labels, versions)).toThrow(JudgeOutputError);
    expect(() => readOutput({ ...bad, designs: [...bad.designs, bad.designs[0]] }, labels, versions)).toThrow("twice");
    const missing = structuredClone(bad);
    missing.designs.find((entry) => entry.design === 1).scores.responsive = null;
    expect(() => readOutput(missing, labels, versions)).toThrow("no responsive score");
    const range = structuredClone(bad);
    range.designs[0].scores.color = 11;
    expect(() => readOutput(range, labels, versions)).toThrow("outside 1 to 10");
  });

  test("runs samples with their own order, retries output that does not fit, and passes or fails by the bar", async () => {
    const versions = versionsFor(join(scratch, "run"));
    // Each version's images have their own bytes, so the fake judge can tell them apart.
    const byData = new Map(versions.flatMap((version) => version.shots.map((shot) => [readFileSync(shot.file).toString("base64"), version.key])));
    const orders = [];
    let spentUsd = 0;
    const call = async ({ content, system, model, budgetUsd }) => {
      expect([model, budgetUsd]).toEqual(["claude-sonnet-5-5", 2]);
      expect(system).toContain("senior product designer");
      const map = new Map();
      let design = 0;
      for (const block of content) {
        const header = block.type === "text" && block.text.match(/^Design (\d+)(?: \(.*\))?: /);
        if (header) design = Number(header[1]);
        if (block.type === "image") map.set(design, byData.get(block.source.data));
      }
      orders.push([...map.values()].join(","));
      // The first call answers nothing usable, so its sample is retried.
      if (orders.length === 1) return { output: { designs: [], issues: [], strengths: [] }, costUSD: 0.1 };
      const candidate = [...map].find(([, key]) => key === "candidate")[0];
      return { output: output(map, (key) => (key === "candidate" ? 9 : key === "baseline" ? 7.5 : 8), [{ design: candidate, screen: "home.x", category: "color", severity: "high", problem: "p", fix: "f" }]), costUSD: 0.2 };
    };
    const result = await runJudge({ judge: { model: "claude-sonnet-5-5", effort: "medium", samples: 3 }, versions, config, seed: "seed", budgetUsd: 2, spend: (usd) => (spentUsd += usd), call });
    expect(orders).toHaveLength(4);
    expect(new Set(orders).size).toBeGreaterThan(1);
    expect(spentUsd).toBeCloseTo(0.7);
    expect(result.overall).toEqual({ baseline: 7.5, candidate: 9, "ref:linear": 8 });
    const pass = verdict({ result, pass: { min: 8.5, gain: 0.5, references: 0.5 }, noise: { sigmaOverall: 0.2 }, references: ["ref:linear"] });
    expect(pass).toMatchObject({ pass: true, lowest: 9, gain: 1.5, referenceMargin: 1 });
    const fail = verdict({ result, pass: { min: 9.5, gain: 0.5, references: 1.5 }, noise: { sigmaOverall: 1 }, references: ["ref:linear"] });
    expect(fail.pass).toBe(false);
    expect(fail.gainBar).toBe(2);
    expect(fail.reasons).toEqual([expect.stringContaining("under the bar 9.5"), expect.stringContaining("under 2.00"), expect.stringContaining("best reference")]);
    expect(topIssues([result])).toEqual([expect.objectContaining({ screen: "home.x", category: "color", weight: 9, count: 3, underBar: false })]);
    expect(pass.baselineLowest).toBe(7.5);
  });

  test("issues in categories under the bar come first, the furthest under first", () => {
    const issue = (category, severity) => ({ version: "candidate", screen: "home.x", category, severity, problem: category, fix: "f" });
    const results = [{ samples: [{ issues: [issue("layout", "high"), issue("layout", "high"), issue("typography", "low"), issue("color", "low"), issue("hierarchy", "medium")] }] }];
    expect(topIssues(results).map((item) => item.category)).toEqual(["layout", "hierarchy", "typography", "color"]);
    const ranked = topIssues(results, "candidate", 20, { typography: 0.25, color: 1, polish: 2 });
    expect(ranked.map((item) => [item.category, item.underBar])).toEqual([["color", true], ["typography", true], ["layout", false], ["hierarchy", false]]);
  });

  test("calibration warns when a judge almost never gives the bar", () => {
    const sample = (main, ref) => ({ scores: { baseline: Object.fromEntries(CATEGORIES.map((id) => [id, main])), control: Object.fromEntries(CATEGORIES.map((id) => [id, 3])), "ref:a": Object.fromEntries(CATEGORIES.map((id) => [id, id === "responsive" ? null : ref])) } });
    const result = { samples: [sample(8, 8.5), sample(8, 8.5)], scores: { "ref:a": Object.fromEntries(CATEGORIES.map((id) => [id, id === "responsive" ? null : 8.5])) } };
    const reach = barReach(result, { min: 9, references: ["ref:a"], sigmaCategory: 0.1 });
    expect(reach.share).toBe(0);
    expect(reach.beyond).toHaveLength(CATEGORIES.length - 1);
    expect(reach.warnings).toEqual([expect.stringContaining("above the best reference in hierarchy (8.50)"), "0% of its scores of main and the references reach 9"]);
    // Within the reference's reach, and given often enough: no warning. The control's low scores do not count.
    expect(barReach(result, { min: 8.5, references: ["ref:a"], sigmaCategory: 0.1 }).warnings).toEqual([]);
    // A bar a little over the best reference, inside twice the noise, is not beyond it.
    expect(barReach(result, { min: 8.75, references: ["ref:a"], sigmaCategory: 0.2 }).beyond).toEqual([]);
  });

  test("a change to what the judges are asked changes the council version and the run's identity", () => {
    const before = [councilVersion(), identity(config, [])];
    expect(before[0]).toMatch(/^[0-9a-f]{12}$/);
    const saved = RUBRIC.scale[0][1];
    RUBRIC.scale[0][1] = `${saved} Changed.`;
    try {
      expect(councilVersion()).not.toBe(before[0]);
      expect(identity(config, [])).not.toBe(before[1]);
    } finally {
      RUBRIC.scale[0][1] = saved;
    }
    expect([councilVersion(), identity(config, [])]).toEqual(before);
  });

  test("a judge whose output never fits fails after one retry", async () => {
    const versions = versionsFor(join(scratch, "never"));
    let count = 0;
    const call = async () => ({ output: { designs: [], issues: [], strengths: [] }, costUSD: (count++, 0.1) });
    await expect(runJudge({ judge: { model: "m", effort: "low", samples: 1 }, versions, config, seed: "s", budgetUsd: 1, spend: () => {}, call })).rejects.toThrow("m@low sample 1 failed twice: scored 0 of 3 designs");
    expect(count).toBe(2);
  });

  test("a failed call is retried only when the budget has room for it beside the calls still running", async () => {
    const versions = versionsFor(join(scratch, "room"));
    const attempt = async (samples, left) => {
      let count = 0;
      let spentUsd = 0;
      const call = async () => {
        count++;
        return { output: { designs: [], issues: [], strengths: [] }, costUSD: 0.4 };
      };
      const outcome = await runJudge({
        judge: { model: "m", effort: "low", samples }, versions, config, seed: "s", budgetUsd: 1,
        spend: (usd) => (spentUsd += usd), room: () => left - spentUsd, call,
      }).catch((error) => error);
      return { count, spentUsd, outcome };
    };
    let result = await attempt(1, 0.9);
    expect(result.count).toBe(1);
    expect(result.outcome).toBeInstanceOf(JudgeFailedError);
    expect(result.outcome.message).toContain("no room to retry it: scored 0 of 3 designs");
    result = await attempt(1, 1.5);
    expect(result.count).toBe(2);
    expect(result.outcome.message).toContain("failed twice");
    // Two samples with $2.50: after the first fails, its retry needs $1 beside the other
    // call still running; after the second fails, $1.70 is left, short of two calls' worth.
    result = await attempt(2, 2.5);
    expect(result.count).toBe(3);
    expect(result.spentUsd).toBeCloseTo(1.2);
  });

  test("a call that would not fit the API's request limits fails before any is made", async () => {
    expect(() => checkRequestSize(new Map(Array.from({ length: 7 }, (_, index) => [`s${index}.png`, { data: "x".repeat(MAX_IMAGE_BYTES) }]))))
      .toThrow(`over the ${(MAX_REQUEST_BYTES / 1024 / 1024).toFixed(1)} MB that fits one request`);
    const versions = versionsFor(join(scratch, "large"));
    // 4 MB of bytes is over 5 MB once encoded.
    writeFileSync(versions[2].shots[0].file, Buffer.alloc(4 * 1024 * 1024, 1));
    let calls = 0;
    const call = async () => (calls++, {});
    await expect(runJudge({ judge: { model: "m", effort: "low", samples: 1 }, versions, config, seed: "s", budgetUsd: 1, spend: () => {}, call }))
      .rejects.toThrow("limit per image");
    expect(calls).toBe(0);
  });

  test("combines samples and calibrates from main against the control", () => {
    const sample = (main, control) => ({
      scores: { baseline: Object.fromEntries(CATEGORIES.map((id) => [id, main])), control: Object.fromEntries(CATEGORIES.map((id) => [id, control])) },
      overall: { baseline: main, control },
    });
    const good = { judge: "j", samples: [sample(7, 4), sample(7.5, 4.5), sample(7, 4)] };
    Object.assign(good, combine(good.samples));
    const result = calibrationOf(good);
    expect(result.pass).toBe(true);
    expect(result.drop).toBeCloseTo(3, 5);
    expect(result.sigmaOverall).toBeCloseTo(0.289, 2);
    const blind = { judge: "j", samples: [sample(7, 7), sample(7, 7.5)] };
    Object.assign(blind, combine(blind.samples));
    expect(calibrationOf(blind)).toMatchObject({ pass: false, reasons: [expect.stringContaining("only -0.25 below"), expect.stringContaining("lower in 0%")] });
    const noisy = { judge: "j", samples: [sample(9, 3), sample(5, 1)] };
    Object.assign(noisy, combine(noisy.samples));
    expect(calibrationOf(noisy).reasons).toEqual([expect.stringContaining("vary by 2.83")]);
  });
});

describe("gates", () => {
  const checks = (overrides = {}) => ({ overflowX: false, contrast: { count: 0, samples: [] }, unlabeled: { count: 0, samples: [] }, targets: { count: 0, samples: [] }, missingAlt: 0, ...overrides });
  const shot = (id, extra = {}) => ({ id, error: null, pageErrors: [], consoleErrors: [], failedRequests: [], checks: checks(), ...extra });

  test("pass when nothing is worse than main", () => {
    const baseline = [shot("a", { consoleErrors: ["x"], checks: checks({ contrast: { count: 2, samples: [] } }) })];
    const candidate = [shot("a", { consoleErrors: ["x"], checks: checks({ contrast: { count: 1, samples: [] } }) })];
    expect(evaluateGates({ checks: { ok: true, results: [] }, candidate, baseline })).toMatchObject({ ok: true, failures: [] });
  });

  test("fail on failed checks, broken shots, new errors and worse page checks", () => {
    const baseline = [shot("a"), shot("b")];
    const candidate = [
      shot("a", { pageErrors: ["TypeError: x"], checks: checks({ overflowX: true, unlabeled: { count: 1, samples: ["button.icon"] }, contrast: { count: 1, samples: [{ text: "faint", ratio: 2.1, required: 4.5 }] } }) }),
      shot("b", { error: "Timeout 20000ms exceeded" }),
    ];
    const result = evaluateGates({ checks: { ok: false, failed: "check `bun test` exited 1", results: [{ output: "1 fail" }] }, candidate, baseline });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      "check `bun test` exited 1:\n1 fail",
      "a has 1 more page errors than main: TypeError: x",
      "b did not capture: Timeout 20000ms exceeded",
      "1 more screens that scroll sideways than main (1 vs 0): a",
      '1 more text below WCAG AA contrast than main (1 vs 0): a: "faint" 2.1:1, needs 4.5:1',
      "1 more controls without an accessible name than main (1 vs 0): a: button.icon",
    ]);
    expect(checkTotals(candidate)).toEqual({ overflow: 1, contrast: 1, unlabeled: 1, targets: 0, missingAlt: 0 });
  });
});

describe("rounds", () => {
  const config = validateConfig(base(), FILE);
  const judged = (round, gain, extra = {}, lowest = 8.25) => ({ round, sha: "abcdef1234567890", dirty: false, pass: false, stage: "judges", costUSD: 1.234, verdicts: [{ judge: "claude-sonnet-5-5@medium", lowest, gain, gainBar: 0.5, referenceMargin: null, overall: 8.6 }], ...extra });

  test("the score line names the round, result, bar, gain, cost and commit", () => {
    expect(scoreLine(judged(3, 0.75, { pass: true }), config)).toBe("score: round 3 pass · claude-sonnet-5-5@medium min 8.25 (bar 8.5) · +0.75 vs main · $1.23 · abcdef123456");
    expect(scoreLine({ round: 4, sha: "abcdef1234567890", dirty: true, pass: false, stage: "gates", costUSD: 0, verdicts: [], gates: { failures: ["check `bun test` exited 1:\nlots"] } }, config))
      .toBe("score: round 4 fail · gates: check `bun test` exited 1 · $0.00 · abcdef123456+dirty");
    expect(scoreLine(judged(5, 0.2, { stage: "error", error: "claude-opus-5-5@high sample 2 failed twice: timed out\nmore" }), config))
      .toBe("score: round 5 fail · claude-sonnet-5-5@medium min 8.25 (bar 8.5) · +0.20 vs main · error: claude-opus-5-5@high sample 2 failed twice: timed out · $1.23 · abcdef123456");
    expect(scoreLine(judged(6, 0.9, { calibrated: false }), config)).toBe("score: round 6 fail · claude-sonnet-5-5@medium min 8.25 (bar 8.5) · +0.90 vs main · uncalibrated · $1.23 · abcdef123456");
    expect(scoreLine(judged(7, 0.9, { structural: true }), config)).toBe("score: round 7 fail · claude-sonnet-5-5@medium min 8.25 (bar 8.5) · +0.90 vs main · structural · $1.23 · abcdef123456");
  });

  test("a stray argument is a usage error, exit 2", async () => {
    expect(await runCli(["status", "stray"])).toBe(2);
  });

  test("a plateau is two judged rounds in which nothing the bar needs moved beyond the noise", () => {
    const noise = () => ({ lowest: 0.1, gain: 0.25 });
    const at = (min, list) => plateau(list, { min, noise });
    expect(at(8.5, [judged(1, 0.2), judged(2, 0.9)]).plateau).toBe(false);
    expect(at(8.5, [judged(1, 0.2), { round: 2, stage: "gates", verdicts: [] }, judged(3, 0.3)]).judged).toBe(2);
    // Both under their bars: a plateau only when neither moved.
    const low = (round, gain, lowest) => judged(round, gain, {}, lowest);
    expect(at(8.5, [low(1, 0.2, 7), low(2, 0.3, 7.5), low(3, 0.35, 7.5), low(4, 0.4, 7.5)])).toMatchObject({
      plateau: true, metrics: { lowest: { before: 7.5, recent: 7.5, moved: false }, gain: { before: 0.3, recent: 0.4, moved: false } },
    });
    expect(at(8.5, [low(1, 0.2, 7), low(2, 0.3, 7.5), low(3, 0.35, 7.5), low(4, 0.45, 7.75)]).plateau).toBe(false);
    expect(at(8.5, [low(1, 0.1, 7), low(2, 0.2, 7.5), low(3, 0.2, 7.5), low(4, 0.48, 7.5)]).plateau).toBe(false);
    // The gain over its bar no longer counts: the first climb's rounds plateau at round 5.
    const first = [[0.69, 7.25], [0.91, 7.5], [1.0, 7.75], [1.13, 7.5], [1.03, 7.75]].map(([gain, lowest], index) => low(index + 1, gain, lowest));
    expect(at(8.5, first.slice(0, 4)).plateau).toBe(false);
    expect(at(8.5, first)).toMatchObject({ plateau: true, metrics: { lowest: { before: 7.75, recent: 7.75 } } });
    expect(at(8.5, first).metrics.gain).toBeUndefined();
    // A latest round that clears both bars tracks nothing: no plateau.
    expect(at(8, [judged(1, 0.9), judged(2, 0.9), judged(3, 0.9)])).toMatchObject({ plateau: false, metrics: {} });
    // Progress on one of two tied lowest categories shows in the total shortfall.
    const tied = (round, lowest, shortfall) => ({ round, stage: "judges", verdicts: [{ judge: "s", pass: false, lowest, shortfall, underCount: 2, gain: 0.9, gainBar: 0.5, referenceMargin: null }] });
    expect(at(8.5, [tied(1, 7.5, 2), tied(2, 7.5, 2), tied(3, 7.5, 1.5), tied(4, 7.5, 1.5)])).toMatchObject({ plateau: false, metrics: { lowest: { moved: false }, shortfall: { before: 2, recent: 1.5, moved: true } } });
    expect(at(8.5, [tied(1, 7.5, 2), tied(2, 7.5, 1.5), tied(3, 7.5, 1.5), tied(4, 7.5, 1.5)]).plateau).toBe(true);
    // movedAt: the latest round that beat every earlier one by more than the noise.
    expect(at(8.5, [tied(1, 7.5, 2), tied(2, 7.5, 1.5), tied(3, 7.5, 1.5), tied(4, 7.5, 1.5)]).movedAt).toBe(2);
    expect(at(8.5, [low(1, 0.2, 7), low(2, 0.3, 7.5), { round: 3, stage: "gates", verdicts: [] }, low(4, 0.35, 7.55), low(5, 0.4, 7.5), low(6, 0.4, 7.5)]).movedAt).toBe(2);
    expect(at(8.5, [low(1, 0.2, 7.5), low(2, 0.3, 7.5), low(3, 0.35, 7.5)]).movedAt).toBeNull();
  });

  test("a plateau follows the judge that binds, not only the first", () => {
    // The first judge clears the bar every round; the second fails it and never moves.
    const pair = (round) => ({ round, stage: "judges", verdicts: [
      { judge: "s", pass: true, lowest: 8.6, gain: 0.9, gainBar: 0.5, referenceMargin: null },
      { judge: "o", pass: false, lowest: 8, gain: 0.9, gainBar: 0.5, referenceMargin: null },
    ] });
    const noises = [];
    const result = plateau([pair(1), pair(2), pair(3), pair(4)], { min: 8.5, noise: (key) => (noises.push(key), { lowest: 0.1, gain: 0.25 }) });
    expect(result).toMatchObject({ plateau: true, judge: "o", metrics: { lowest: { before: 8, recent: 8 } } });
    expect(noises).toEqual(["o"]);
    // With pass.references set, a lead over the references still under it is tracked too.
    const lagging = (round, margin) => ({ round, stage: "judges", verdicts: [{ judge: "s", pass: false, lowest: 8.6, gain: 0.9, gainBar: 0.5, referenceMargin: margin }] });
    expect(plateau([lagging(1, -0.5), lagging(2, -0.5), lagging(3, -0.2)], { min: 8.5, references: 0, noise: () => ({ lowest: 0.1, gain: 0.25 }) }))
      .toMatchObject({ plateau: false, metrics: { references: { moved: true } } });
  });

  test("a climb's noise includes how much main's score moves between rounds", () => {
    const judge = { model: "claude-sonnet-5-5", effort: "medium", samples: 2 };
    const calibration = { sigmaOverall: 0.036, sigmaCategory: 0.1, calibrated: true };
    expect(climbNoise(calibration, judge, [])).toMatchObject({ sigmaOverall: 0.036 / Math.sqrt(2), sigmaLowest: 0.1 / Math.sqrt(2), calibrated: true });
    const round = (baseline, baselineLowest) => ({ verdicts: [{ judge: "claude-sonnet-5-5@medium", baseline, baselineLowest }, { judge: "claude-opus-5-5@high", baseline: 1 }] });
    const noise = climbNoise(calibration, judge, [round(6.91, 6.5), round(7.0, 6.5), round(6.72, 6), round(6.91, 6.5)]);
    expect(noise.sigmaOverall).toBeCloseTo(0.118, 3);
    expect(noise.sigmaLowest).toBeCloseTo(0.25, 3);
    // A verdict without main's score does not turn the noise into NaN.
    expect(climbNoise(calibration, judge, [round(6.9, 6.5), round(undefined, undefined), round(7.1, 6.5)]).sigmaOverall).toBeCloseTo(0.1414, 3);
  });

  test("chart end labels never overlap", () => {
    expect(endLabels([[50, "a"], [40, "b"], [50, "c"], [100, "d"]])).toEqual([[40, "b"], [54, "a"], [68, "c"], [100, "d"]]);
  });

  test("the report escapes what judges and the configuration wrote", () => {
    expect(escape(`<script>"x" & 'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;");
    const jpeg = join(scratch, "report.jpg");
    writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const html = renderReport({
      config: { ...config, name: "demo" },
      run: { id: "r1", baseline: { rev: "origin/main", sha: "abcdef1234567890" } },
      rounds: [{ ...judged(1, 0.3), issues: [{ screen: "<img src=x onerror=alert(1)>", category: "color", severity: "high", count: 2, problems: ["<b>bold</b>"], fixes: ["</li><script>"] }], gates: { failures: [], totals: { candidate: checkTotals([]), baseline: checkTotals([]) } } }],
      calibration: null, spentUSD: 1,
      versions: { baseline: [{ id: "home.x", file: jpeg }], "round-1": [{ id: "home.x", file: jpeg }] },
    });
    expect(html).toContain('src="data:image/jpeg;base64,');
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).not.toContain("</li><script>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("<svg");
    // Two judges configured, one verdict: the report says why.
    expect(html).toContain("Round 1 stopped at the first judge that failed");
    const partial = (extra) => renderReport({ config, run: { id: "r1", baseline: { rev: "origin/main", sha: "abcdef1234567890" } }, rounds: [{ ...judged(1, 0.3), ...extra, gates: { failures: [], totals: { candidate: checkTotals([]), baseline: checkTotals([]) } } }], calibration: null, spentUSD: 1, versions: {} });
    expect(partial({ stage: "error" })).toContain("a judge could not finish its calls");
    expect(partial({ stage: "budget" })).toContain("the budget ran out before every judge ran");
    expect(partial({ skipped: ["claude-opus-5-5@high"] })).toContain("did not cover claude-opus-5-5@high");
  });
});

// The whole command on a tiny Bun site in a temporary git repository, with real captures
// and page checks in headless Chromium and the fake judge.
const browse = [join(import.meta.dir, "..", "..", "skills", "headless-browser", "scripts", "browse.ts")]
  .find((file) => existsSync(join(file, "..", "..", "node_modules", "playwright")));

describe.skipIf(!browse)("ui command end to end", () => {
  const SERVER = `const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const page = (name) => Bun.file(new URL(\`./\${name}.html\`, import.meta.url)).text();
Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
  const { pathname } = new URL(request.url);
  if (pathname === "/healthz") return new Response("ok");
  return new Response(await page(pathname === "/" ? "home" : "other"), { headers: { "content-type": "text/html" } });
} });
`;
  const page = (title, extra = "", color = "#1b1b1b") => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
body { font: 16px system-ui; margin: 0; padding: 24px; background: #fff; color: ${color}; }
@media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
button { font: inherit; padding: 8px 16px; }
</style></head><body><h1>${title}</h1><p>Tasks for this week.</p><button>Save</button>${extra}</body></html>`;

  let repo;
  let state;
  let env;
  const git = async (...args) => {
    const result = await runProcess(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env: process.env });
    expect(result.code).toBe(0);
    return result.stdout.trim();
  };
  const write = (path, text) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = async (message) => {
    await git("add", "-A");
    await git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const ui = (args, scores = {}) => runProcess(["bun", CLI, "ui", ...args, "--config", join(repo, "ui-climb.json")], {
    cwd: repo, timeout: 300_000,
    env: { ...env, FAKE_UI_SCORES: JSON.stringify({ baseline: 7, control: 3, candidate: 7, references: 8, ...scores }) },
  });
  const calls = () => (existsSync(join(scratch, "calls.jsonl")) ? readFileSync(join(scratch, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "claude-factory-ui-repo-"));
    state = join(scratch, "state");
    env = {
      ...process.env,
      CLAUDE_FACTORY_STATE: state, CLAUDE_FACTORY_BIN: FAKE, CLAUDE_FACTORY_BROWSE: browse, CLAUDE_FACTORY_AVOID: join(scratch, "no-avoid.md"),
      FAKE_CLAUDE_MODE: "script", FAKE_CLAUDE_SCRIPT: FAKE_JUDGE, FAKE_CLAUDE_COST: "0.05",
      FAKE_UI_RUNS: join(state, "ui", "demo", "runs"), FAKE_UI_LEAKS: join(scratch, "leaks.txt"), FAKE_UI_CALLS: join(scratch, "calls.jsonl"),
    };
    await git("init", "-q", "-b", "main");
    write("web/server.ts", SERVER);
    write("web/home.html", page("This week"));
    write("web/other.html", page("Other"));
    writeFileSync(join(repo, "ref.png"), PNG);
    write("ui-climb.json", JSON.stringify({
      version: 1, name: "demo", product: "A task list.", root: "web",
      checks: [["test", "!", "-e", "FAIL"]],
      serve: { command: ["bun", "server.ts", "--port", "{port}"], ready: "/healthz" },
      screens: [
        { id: "home", title: "Home", path: "/", views: ["desktop-light", "phone-light"] },
        { id: "other", title: "Other", path: "/other", views: ["desktop-dark"] },
      ],
      references: [{ id: "ref", title: "Reference app", files: [{ path: "ref.png", view: "desktop-light" }] }],
      judges: [{ model: "claude-sonnet-5-5", samples: 2 }],
      pass: { min: 8.5, gain: 0.5, references: 0.5 },
      budgetUsd: { call: 0.5, round: 5, run: 20 },
      baseline: "main", settleMs: 0,
    }, null, 2));
    await commit("main");
    await git("checkout", "-q", "-b", "climb");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("captures, calibrates, gates, judges, reports, and keeps the judges blind", async () => {
    // A preview captures main, the reference and the working tree; no judge runs.
    let result = await ui(["capture"]);
    expect(result.code).toBe(0);
    const runs = join(state, "ui", "demo", "runs");
    const [runId] = readdirSync(runs);
    const run = join(runs, runId);
    expect(readdirSync(join(run, "versions", "baseline")).filter((name) => name.endsWith(".png")).sort()).toEqual(["home.desktop-light.png", "home.phone-light.png", "other.desktop-dark.png"]);
    expect(result.stdout).toContain(join(run, "versions", "references", "ref.desktop-light.png"));
    expect(result.stdout).toMatch(/Page checks \(this vs main\): overflow 0\/0, contrast 0\/0, unlabeled 0\/0/);
    expect(calls()).toHaveLength(0);

    // Rounds need a passing calibration.
    result = await ui(["round"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("run `ui calibrate` first");

    result = await ui(["calibrate", "--samples", "2"]);
    expect(result.code).toBe(0);
    const calibration = JSON.parse(readFileSync(join(run, "calibration.json"), "utf8"));
    expect(calibration.judges["claude-sonnet-5-5@medium"]).toMatchObject({ pass: true, baseline: 7, control: 3, sigmaCategory: 0 });
    expect(readdirSync(join(run, "versions", "control")).some((name) => name.endsWith(".png"))).toBe(true);
    expect(calls()).toHaveLength(2);
    expect(Object.values(calls()[0].order).sort()).toEqual(["baseline", "control", "references"]);
    // The reference scores 8 and main 7, so a bar of 8.5 is out of the judge's reach.
    expect(result.stdout).toContain("Bar reach: the bar 8.5 may be out of the judges' range.");
    expect(calibration.judges["claude-sonnet-5-5@medium"].barReach).toMatchObject({ min: 8.5, share: 0 });

    // Round 1: a change the judges rate below the bar.
    write("web/home.html", page("This week", "<p>Due soon</p>"));
    const first = await commit("tweak");
    result = await ui(["round"], { candidate: 8 });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`score: round 1 fail · claude-sonnet-5-5@medium min 8.00 (bar 8.5) · +1.00 vs main · +0.00 vs refs · $0.10 · ${first.slice(0, 12)}`);
    expect(result.stdout).toContain("1. [under bar] home.desktop-light · color · high ×2: <b>low contrast</b>");
    // Every category is under the bar and only color has issues: the judges' summaries follow.
    expect(result.stdout).toContain("Under the bar with few issues named: hierarchy (8.00)");
    expect(result.stdout).toContain("- candidate summary");
    expect(Object.values(calls().at(-1).order).sort()).toEqual(["baseline", "candidate", "references"]);

    // Round 2: the judges rate it above the bar, ahead of main and the reference.
    result = await ui(["round"], { candidate: 9 });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("score: round 2 pass · claude-sonnet-5-5@medium min 9.00 (bar 8.5) · +2.00 vs main · +1.00 vs refs");

    // Round 3: an unlabeled control, faint text and a console error fail the gates; no judge runs.
    const judgeCalls = calls().length;
    write("web/home.html", page("This week", `<button aria-hidden="false"></button><p style="color:#c8c8c8">faint</p><script>console.error("boom")</script>`));
    await commit("regress");
    result = await ui(["round"], { candidate: 10 });
    expect(result.code).toBe(1);
    expect(calls()).toHaveLength(judgeCalls);
    expect(result.stdout).toContain("home.desktop-light has 1 more console errors than main: boom");
    expect(result.stdout).toContain("more controls without an accessible name than main");
    expect(result.stdout).toContain('"faint"');
    expect(result.stdout).toMatch(/score: round 3 fail · gates: home\.desktop-light has 1 more console errors/);

    // Round 4: the project's checks fail.
    write("web/home.html", page("This week"));
    write("web/FAIL", "");
    await commit("break the checks");
    result = await ui(["round"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("check `test ! -e FAIL` exited 1");
    expect(existsSync(join(run, "versions", "round-4"))).toBe(false);

    // Uncommitted changes are refused.
    write("web/extra.txt", "x");
    result = await ui(["round"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("uncommitted changes");
    rmSync(join(repo, "web", "extra.txt"));

    // Round 5: a judge whose answers never fit is recorded with its cost, exit 2.
    rmSync(join(repo, "web", "FAIL"));
    const fifth = await commit("fix the checks");
    result = await ui(["round"], { broken: true });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(`score: round 5 fail · error: claude-sonnet-5-5@medium sample 1 failed twice: scored Design 99, which was not shown · $0.20 · ${fifth.slice(0, 12)}`);
    expect(JSON.parse(readFileSync(join(run, "rounds", "round-5.json"), "utf8"))).toMatchObject({ stage: "error", pass: false, costUSD: 0.2 });

    result = await ui(["status", "--json"]);
    expect(result.code).toBe(0);
    const status = JSON.parse(result.stdout);
    expect(status.rounds.map((round) => [round.round, round.pass, round.stage])).toEqual([[1, false, "judges"], [2, true, "judges"], [3, false, "gates"], [4, false, "gates"], [5, false, "error"]]);
    expect(status).toMatchObject({ passed: true, calibrated: true, plateau: { plateau: false }, judgesInLatest: { judged: 1, of: 1 }, main: { calibration: 7, rounds: { low: 7, high: 7, rounds: 2 } } });
    expect(status.council).toMatch(/^[0-9a-f]{12}$/);
    expect(status.barGap).toBeCloseTo(-0.5);
    expect(status.spentUSD).toBeCloseTo(0.5);

    result = await ui(["report", "--out", join(scratch, "report.html")]);
    expect(result.code).toBe(0);
    const html = readFileSync(join(scratch, "report.html"), "utf8");
    expect(html).toContain("UI climb: demo");
    expect(html).toContain("Passed in round 2");
    expect(html).not.toContain("<b>low contrast</b>");

    // Nothing in any prompt told a judge which design was which.
    expect(existsSync(join(scratch, "leaks.txt")) ? readFileSync(join(scratch, "leaks.txt"), "utf8") : "").toBe("");

    // A changed configuration needs a new run, which captures main again.
    const config = JSON.parse(readFileSync(join(repo, "ui-climb.json"), "utf8"));
    write("ui-climb.json", JSON.stringify({ ...config, pass: { ...config.pass, min: 8 } }));
    await commit("lower the bar");
    result = await ui(["round"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--new-run");
  }, 600_000);

  test("an uncalibrated round is a trial that never passes", async () => {
    const config = JSON.parse(readFileSync(join(repo, "ui-climb.json"), "utf8"));
    write("trial.json", JSON.stringify({ ...config, name: "trial" }));
    // A design that differs from main, so the judge tells them apart.
    write("web/home.html", page("This week", "<p>Trial</p>"));
    await commit("trial");
    const result = await runProcess(["bun", CLI, "ui", "round", "--uncalibrated", "--config", join(repo, "trial.json")], {
      cwd: repo, timeout: 300_000,
      env: { ...env, FAKE_UI_RUNS: join(state, "ui", "trial", "runs"), FAKE_UI_SCORES: JSON.stringify({ baseline: 7, candidate: 9.5, references: 8 }) },
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("UNCALIBRATED");
    expect(result.stdout).toContain("a trial and does not pass");
    expect(result.stdout).toMatch(/score: round 1 fail · claude-sonnet-5-5@medium min 9\.50 \(bar 8\) · \+2\.50 vs main · \+1\.50 vs refs · uncalibrated · /);
    const status = JSON.parse((await runProcess(["bun", CLI, "ui", "status", "--json", "--config", join(repo, "trial.json")], { cwd: repo, env, timeout: 60_000 })).stdout);
    expect(status).toMatchObject({ passed: false, calibrated: false });
  }, 300_000);

  test("a run's first judged round hears from every judge; later rounds stop at the first that fails", async () => {
    const config = JSON.parse(readFileSync(join(repo, "ui-climb.json"), "utf8"));
    write("pair.json", JSON.stringify({ ...config, name: "pair", judges: [{ model: "claude-sonnet-5-5", samples: 1 }, { model: "claude-opus-5-5", effort: "high", samples: 1 }] }));
    write("web/home.html", page("This week", "<p>Pair</p>"));
    await commit("pair");
    const round = () => runProcess(["bun", CLI, "ui", "round", "--uncalibrated", "--config", join(repo, "pair.json")], {
      cwd: repo, timeout: 300_000,
      env: { ...env, FAKE_UI_RUNS: join(state, "ui", "pair", "runs"), FAKE_UI_SCORES: JSON.stringify({ baseline: 7, candidate: 7.5, references: 8 }) },
    });
    const status = async () => (await runProcess(["bun", CLI, "ui", "status", "--config", join(repo, "pair.json")], { cwd: repo, env, timeout: 60_000 })).stdout;
    const before = calls().length;
    expect((await round()).code).toBe(1);
    expect(calls().slice(before).map((call) => call.model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    const second = await round();
    expect(second.code).toBe(1);
    expect(calls().slice(before).map((call) => call.model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    let text = await status();
    expect(text).toContain("Main scored 7.00–7.00 over 2 judged rounds (claude-sonnet-5-5@medium; scores are comparative).");
    expect(text).toContain("It was judged by 1 of 2 judges: run `ui round --all-judges` on the commit you hand over.");
    expect(text).toContain("Latest judged round 2: lowest hierarchy 7.50, 0.50 under the bar 8;");
    // Rounds that move nothing: a plateau. The bar is close, so no structural round is asked for.
    expect((await round()).code).toBe(1);
    text = await status();
    expect(text).toContain("Plateau (claude-sonnet-5-5@medium): in the last two judged rounds nothing the bar needs moved beyond the noise: lowest category best 7.50 vs 7.50 before");
    expect(text).not.toContain("structural round");
  }, 300_000);

  test("a structural round is asked for once, far from the bar, and a judge the round's budget cannot cover is skipped", async () => {
    const config = JSON.parse(readFileSync(join(repo, "ui-climb.json"), "utf8"));
    write("far.json", JSON.stringify({ ...config, name: "far", judges: [{ model: "claude-sonnet-5-5", samples: 1 }, { model: "claude-opus-5-5", effort: "high", samples: 2 }], budgetUsd: { call: 0.5, round: 0.9, run: 20 } }));
    write("web/home.html", page("This week", "<p>Far</p>"));
    await commit("far");
    const round = (...flags) => runProcess(["bun", CLI, "ui", "round", "--uncalibrated", ...flags, "--config", join(repo, "far.json")], {
      cwd: repo, timeout: 300_000,
      env: { ...env, FAKE_UI_RUNS: join(state, "ui", "far", "runs"), FAKE_UI_SCORES: JSON.stringify({ baseline: 7, candidate: 6, references: 8 }) },
    });
    const status = async () => (await runProcess(["bun", CLI, "ui", "status", "--config", join(repo, "far.json")], { cwd: repo, env, timeout: 60_000 })).stdout;
    // The first judge fails, and the second needs $1.00 of a $0.90 round: skipped, exit 1, not 3.
    const first = await round();
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("did not cover claude-opus-5-5@high, so they did not run");
    for (let index = 0; index < 2; index++) expect((await round()).code).toBe(1);
    let text = await status();
    expect(text).toContain("The bar is 2.00 away with");
    expect(text).toContain("judged with `ui round --structural`");
    const structural = await round("--structural");
    expect(structural.code).toBe(1);
    expect(structural.stdout).toMatch(/score: round 4 fail · .* · structural · /);
    text = await status();
    expect(text).toContain("Structural round 4 did not move it either: stop the climb");
    expect(text).not.toContain("The bar is 2.00 away");
    // Three judged rounds later nothing has moved since: the stop advice holds.
    for (let index = 0; index < 3; index++) expect((await round()).code).toBe(1);
    text = await status();
    expect(text).toContain("Structural round 4 did not move it either: stop the climb");
    expect(text).not.toContain("The bar is 2.00 away");
    expect(text).not.toContain("Calibration warned");
  }, 300_000);

  test("a structural round that moved a metric earns a new one at the next plateau", async () => {
    const config = JSON.parse(readFileSync(join(repo, "ui-climb.json"), "utf8"));
    write("moved.json", JSON.stringify({ ...config, name: "moved", judges: [{ model: "claude-sonnet-5-5", samples: 1 }], pass: { ...config.pass, min: 8 } }));
    write("web/home.html", page("This week", "<p>Moved</p>"));
    await commit("moved");
    const runs = join(state, "ui", "moved", "runs");
    const round = (candidate, ...flags) => runProcess(["bun", CLI, "ui", "round", "--uncalibrated", ...flags, "--config", join(repo, "moved.json")], {
      cwd: repo, timeout: 300_000,
      env: { ...env, FAKE_UI_RUNS: runs, FAKE_UI_SCORES: JSON.stringify({ baseline: 7, candidate, references: 8 }) },
    });
    const status = async () => (await runProcess(["bun", CLI, "ui", "status", "--config", join(repo, "moved.json")], { cwd: repo, env, timeout: 60_000 })).stdout;
    for (let index = 0; index < 3; index++) expect((await round(6)).code).toBe(1);
    expect(await status()).toContain("The bar is 2.00 away with");
    // The structural round lifts the lowest category from 6 to 7; two more rounds stay there.
    expect((await round(7, "--structural")).code).toBe(1);
    for (let index = 0; index < 2; index++) expect((await round(7)).code).toBe(1);
    let text = await status();
    expect(text).toContain("Plateau (claude-sonnet-5-5@medium)");
    expect(text).toContain("The bar is 1.00 away with");
    expect(text).not.toContain("Structural round 4");
    // A second structural round that moves nothing stops the climb, with the calibration's bar-reach warning.
    expect((await round(7, "--structural")).code).toBe(1);
    const [runId] = readdirSync(runs);
    writeFileSync(join(runs, runId, "calibration.json"), JSON.stringify({ judges: { "claude-sonnet-5-5@medium": { pass: false, barReach: { warnings: ["the bar 8 is above the best reference in hierarchy (7.00)"] } } } }));
    text = await status();
    expect(text).toContain("Structural round 7 did not move it either: stop the climb");
    expect(text).toContain("Calibration warned that the bar 8 may be out of the judges' range: say so in that note too.\n- claude-sonnet-5-5@medium: the bar 8 is above the best reference in hierarchy (7.00).");
    expect(text).not.toContain("The bar is 1.00 away");
  }, 300_000);

  test("stops before spending past the run's budget", async () => {
    const config = JSON.parse(readFileSync(join(repo, "ui-climb.json"), "utf8"));
    write("tiny.json", JSON.stringify({ ...config, name: "tiny", budgetUsd: { call: 0.5, round: 1, run: 0.6 } }));
    const result = await runProcess(["bun", CLI, "ui", "calibrate", "--config", join(repo, "tiny.json")], { cwd: repo, env, timeout: 60_000 });
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("could cost up to $1.50");
  }, 60_000);
});
