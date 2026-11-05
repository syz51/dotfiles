// Offline regressions for the live harness: each runs one live scenario against
// lib/fake-claude.js in a synthetic HOME and checks that failures fail, a clean run
// passes, and cleanup removes the sessions' own entries but nothing else.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredEffort } from "./lib/live.js";
import { childEnv, runProcess } from "./lib/process.js";

const TESTS = import.meta.dir;

test("behavioral scenarios default to the effort settings.json configures for the model", () => {
  const settings = JSON.parse(readFileSync(join(TESTS, "..", "settings.json"), "utf8"));
  expect(configuredEffort("claude-opus-5-5")).toBe(settings.modelSettings["claude-opus-5-5"].effortLevel);
  expect(configuredEffort("claude-no-such-model")).toBe("high");
});
const GLOBAL = "# Synthetic global instructions\n";
let root;
let home;
let projects;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harness-test-")));
  home = join(root, "home");
  projects = join(home, ".claude", "projects");
  mkdirSync(join(projects, "-preexisting"), { recursive: true });
  writeFileSync(join(projects, "-preexisting", "kept.jsonl"), "kept\n");
  writeFileSync(join(home, ".claude", "CLAUDE.md"), GLOBAL);
  writeFileSync(join(home, ".claude", "frontend-avoid.md"), "# Avoid rainbow gradients\n");
  for (const release of ["typescript", "typescript-b"]) {
    mkdirSync(join(home, "releases", release), { recursive: true });
    writeFileSync(join(home, "releases", release, "SKILL.md"), "# TypeScript\n");
  }
  mkdirSync(join(home, ".claude", "skills"));
  symlinkSync(join(home, "releases", "typescript"), join(home, ".claude", "skills", "typescript"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(TESTS, "lib", "fake-claude.js")}" "$@"\n`);
  chmodSync(join(root, "bin", "claude"), 0o755);
  mkdirSync(join(root, "tmp"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// Runs the named test of a live suite file with the fake CLI. Returns bun's result.
function runLive(file, name, mode, extra = {}) {
  const env = childEnv(process.env, {
    HOME: home,
    TMPDIR: join(root, "tmp"),
    RUN_CLAUDE_LIVE: "1",
    CLAUDE_LIVE_BIN: join(root, "bin", "claude"),
    FAKE_MODE: mode,
    ...extra,
  });
  delete env.CLAUDE_LIVE_MODEL;
  delete env.CLAUDE_LIVE_EFFORT;
  return runProcess([process.execPath, "test", join(TESTS, file), "-t", name], { cwd: TESTS, env, timeout: 60_000 });
}

// Cleanup removed every entry the fake wrote for its fixture, kept the others, and left
// no temporary folder behind.
function assertCleanedUp() {
  expect(readdirSync(projects).sort()).toEqual(["-preexisting", "-unrelated-project"]);
  expect(readFileSync(join(projects, "-preexisting", "kept.jsonl"), "utf8")).toBe("kept\n");
  expect(readdirSync(join(root, "tmp")).filter((name) => name.startsWith("claude-live-"))).toEqual([]);
}

const output = (run) => run.stdout + run.stderr;

describe("failed sessions still clean up", () => {
  for (const mode of ["exit7", "malformed", "incomplete", "timeout"])
    test(mode, async () => {
      const run = await runLive("live-policy.test.js", "Python checks", mode, { CLAUDE_LIVE_TIMEOUT_MS: "2000" });
      expect(run.code, output(run)).not.toBe(0);
      expect(output(run)).toMatch(/1 fail/);
      assertCleanedUp();
    }, 30_000);
});

describe("policy final verification boundary", () => {
  test("a clean fix passes", async () => {
    const run = await runLive("live-policy.test.js", "Python checks", "python-clean");
    expect(run.code, output(run)).toBe(0);
    expect(output(run)).toMatch(/1 pass/);
    expect(output(run)).toMatch(/policy: 1 sessions, total \$0\.0010/);
    assertCleanedUp();
  }, 30_000);

  test("a single-track fix handed to a subagent fails", async () => {
    const run = await runLive("live-policy.test.js", "Python checks", "python-delegated");
    expect(run.code).not.toBe(0);
    expect(output(run)).toContain("a single track was delegated");
    assertCleanedUp();
  }, 30_000);

  test("a fix that tampers with the check when re-run fails", async () => {
    const run = await runLive("live-policy.test.js", "Python checks", "python-mutation");
    expect(run.code).not.toBe(0);
    expect(output(run)).toContain("Unauthorized content change: check.py");
    assertCleanedUp();
  }, 30_000);
});

describe("guidance scope covers subagents", () => {
  test("a run that reads only the routed guidance passes", async () => {
    const run = await runLive("live-dispatch.test.js", "chart work", "chart-clean");
    expect(run.code, output(run)).toBe(0);
    assertCleanedUp();
  }, 30_000);

  test("a forbidden read in a subagent fails", async () => {
    const run = await runLive("live-dispatch.test.js", "chart work", "chart-forbidden");
    expect(run.code).not.toBe(0);
    expect(output(run)).toContain("Subagent: forbidden guidance was read: typescript/SKILL.md");
    assertCleanedUp();
  }, 30_000);
});

describe("configuration must not change during a run", () => {
  test("an unchanged configuration passes", async () => {
    const run = await runLive("live-policy.test.js", "Chinese-only", "chinese-clean");
    expect(run.code, output(run)).toBe(0);
    assertCleanedUp();
  }, 30_000);

  for (const [mode, message] of [
    ["chinese-drift", "CLAUDE.md"],
    ["chinese-retarget", "skills/typescript"],
    ["chinese-skill-edit", "skills/typescript: Unauthorized content change: SKILL.md"],
  ])
    test(mode, async () => {
      const run = await runLive("live-policy.test.js", "Chinese-only", mode);
      expect(run.code).not.toBe(0);
      expect(output(run)).toContain("Configuration changed during the run");
      expect(output(run)).toContain(message);
      assertCleanedUp();
    }, 30_000);
});

test("a claimed artifact that was never saved fails the full skill run", async () => {
  const run = await runLive("live-dispatch.test.js", "drafting an article", "article-claim");
  expect(run.code).not.toBe(0);
  expect(output(run)).toContain("article.md was not saved");
  assertCleanedUp();
}, 30_000);

describe("reports", () => {
  test("record a failure, then clean up", async () => {
    const reports = join(root, "tmp", "reports");
    const run = await runLive("live-policy.test.js", "Python checks", "exit7", { CLAUDE_LIVE_REPORT_DIR: reports });
    expect(run.code).not.toBe(0);
    const report = JSON.parse(readFileSync(join(reports, "python-checks-run-through-uv-run.json"), "utf8"));
    expect(report).toMatchObject({ scenario: "Python checks run through uv run", status: "failed" });
    expect(report.error).toContain("claude exited 7");
    expect(report.sessions[0]).toMatchObject({ status: "failed", model: "claude-opus-5-5", effort: configuredEffort("claude-opus-5-5") });
    assertCleanedUp();
  }, 30_000);

  // The stream lacks the directory each tool call ran from, which the hooks record.
  test("keep each tool call's directory alongside the stream", async () => {
    const reports = join(root, "tmp", "reports");
    const run = await runLive("live-policy.test.js", "Python checks", "python-clean", { CLAUDE_LIVE_REPORT_DIR: reports });
    expect(run.code, output(run)).toBe(0);
    const report = JSON.parse(readFileSync(join(reports, "python-checks-run-through-uv-run.json"), "utf8"));
    const [check] = report.sessions[0].tools.filter((tool) => tool.name === "Bash");
    expect(check.input.command).toContain("check.py");
    expect(check.cwd).toEndWith("/fixture");
    expect(readFileSync(join(reports, "python-checks-run-through-uv-run.stream.jsonl"), "utf8")).toContain(check.id);
    assertCleanedUp();
  }, 30_000);

  test("a report that cannot be written fails a passing run without skipping cleanup", async () => {
    const reports = join(root, "tmp", "reports");
    mkdirSync(join(reports, "python-checks-run-through-uv-run.json"), { recursive: true });
    const run = await runLive("live-policy.test.js", "Python checks", "python-clean", { CLAUDE_LIVE_REPORT_DIR: reports });
    expect(run.code).not.toBe(0);
    expect(output(run)).toMatch(/EISDIR|illegal operation on a directory/);
    assertCleanedUp();
  }, 30_000);

  test("a report folder outside the temp folder stops the suite before any session", async () => {
    const run = await runLive("live-policy.test.js", "Python checks", "python-clean", { CLAUDE_LIVE_REPORT_DIR: join(root, "outside") });
    expect(run.code).not.toBe(0);
    expect(output(run)).toContain("Report folder must be inside");
    expect(existsSync(join(root, "outside"))).toBe(false);
    expect(readdirSync(projects).sort()).toEqual(["-preexisting"]);
    expect(readdirSync(join(root, "tmp")).filter((name) => name.startsWith("claude-live-"))).toEqual([]);
  }, 30_000);
});
