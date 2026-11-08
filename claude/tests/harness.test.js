// Offline regressions for the live harness: each runs one live scenario against
// lib/fake-claude.js in a synthetic HOME and checks that failures fail, a clean run
// passes, and cleanup removes the sessions' own entries but nothing else.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredEffort, holdConfigSync, toolDirectories } from "./lib/live.js";
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
  for (const [path, content] of [["rust/notes/old.md", "# Old note\n"], ["rust/verifications/old.json", "{}\n"]]) {
    mkdirSync(join(home, ".codex", "skill-feedback", path, ".."), { recursive: true });
    writeFileSync(join(home, ".codex", "skill-feedback", path), content);
  }
  mkdirSync(join(home, ".claude", "skills"));
  symlinkSync(join(home, "releases", "typescript"), join(home, ".claude", "skills", "typescript"));
  // codex-skills releases as installed: skill links reach `current`, find-skills by way of
  // ~/.agents/skills. release-b, the next release, changes rust.
  const codex = join(home, ".local", "share", "codex-skills");
  for (const [release, rust] of [["release-a", "# Rust\n"], ["release-b", "# Rust, revised\n"]])
    for (const [skill, content] of [["rust", rust], ["find-skills", "# Find skills\n"]]) {
      mkdirSync(join(codex, "releases", release, "skills", skill), { recursive: true });
      writeFileSync(join(codex, "releases", release, "skills", skill, "SKILL.md"), content);
    }
  symlinkSync(join(codex, "releases", "release-a"), join(codex, "current"));
  mkdirSync(join(home, ".agents", "skills"), { recursive: true });
  symlinkSync(join(codex, "current", "skills", "find-skills"), join(home, ".agents", "skills", "find-skills"));
  symlinkSync(join(codex, "current", "skills", "rust"), join(home, ".claude", "skills", "rust"));
  symlinkSync(join(home, ".agents", "skills", "find-skills"), join(home, ".claude", "skills", "find-skills"));
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

// config-sync skips its checks while a live run holds a lock, so ~/.claude does not change
// under the run (config-sync/tests covers the config-sync side).
describe("config-sync lock", () => {
  const locks = () => join(home, ".local", "state", "config-sync", "locks");

  test("holds one file per process with its PID, written whole, until released", () => {
    const releaseA = holdConfigSync(locks(), 111);
    const releaseB = holdConfigSync(locks(), 222);
    expect(readdirSync(locks()).sort()).toEqual(["live-suite-111.lock", "live-suite-222.lock"]);
    expect(readFileSync(join(locks(), "live-suite-111.lock"), "utf8")).toBe("111\n");
    releaseA();
    releaseA();
    expect(readdirSync(locks())).toEqual(["live-suite-222.lock"]);
    releaseB();
    expect(readdirSync(locks())).toEqual([]);
  });

  test("suites in one process share the lock until the last one ends", async () => {
    const script = join(root, "suites.js");
    writeFileSync(script, `
      import { readdirSync } from "node:fs";
      import { liveSuite } from ${JSON.stringify(join(TESTS, "lib", "live.js"))};
      const locks = () => readdirSync(${JSON.stringify(locks())});
      const [a, b] = [liveSuite("a"), liveSuite("b")];
      const seen = [];
      a.setup(); b.setup(); seen.push(locks());
      await a.teardown(); seen.push(locks());
      await b.teardown(); seen.push(locks());
      b.setup(); seen.push(locks());
      await b.teardown(); seen.push(locks());
      console.log(JSON.stringify({ pid: process.pid, seen }));
    `);
    const env = childEnv(process.env, { HOME: home, TMPDIR: join(root, "tmp"), CLAUDE_LIVE_SETTLE_MS: "100" });
    const run = await runProcess([process.execPath, script], { cwd: root, env, timeout: 20_000 });
    expect(run.code, output(run)).toBe(0);
    const { pid, seen } = JSON.parse(run.stdout.trim().split("\n").at(-1));
    const held = [`live-suite-${pid}.lock`];
    expect(seen).toEqual([held, held, [], held, []]);
  }, 30_000);

  for (const [mode, passes] of [["python-clean", true], ["exit7", false]])
    test(`is held during a session and removed when the run ends (${mode})`, async () => {
      const seen = join(root, "locks.json");
      const run = await runLive("live-policy.test.js", "Python checks", mode, { FAKE_RECORD_LOCKS: seen });
      expect(run.code === 0, output(run)).toBe(passes);
      const held = Object.entries(JSON.parse(readFileSync(seen, "utf8")));
      expect(held).toHaveLength(1);
      const [name, text] = held[0];
      expect(name).toMatch(/^live-suite-\d+\.lock$/);
      expect(name).toBe(`live-suite-${text.trim()}.lock`);
      expect(readdirSync(locks())).toEqual([]);
    }, 30_000);
});

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

  test("a run the API refused before it did anything is run once more", async () => {
    const marker = join(root, "refused");
    const run = await runLive("live-policy.test.js", "Python checks", "python-clean", { FAKE_REFUSE_ONCE: marker });
    expect(run.code, output(run)).toBe(0);
    expect(existsSync(marker)).toBe(true);
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

// A session's background task can outlive it and write under the suite root, its TMPDIR,
// after the scenario ends; teardown waits for it before removing the root.
describe("teardown waits for the sessions' leftover processes", () => {
  test("a background task that writes after the session ends leaves no root behind", async () => {
    const run = await runLive("live-policy.test.js", "Python checks", "python-clean", { FAKE_LINGER: "late" });
    expect(run.code, output(run)).toBe(0);
    // Past the task's write, 2 s after it started: without the wait it recreates the root.
    await Bun.sleep(2500);
    assertCleanedUp();
  }, 30_000);

  test("a background task still running after the wait is killed and fails the suite with the root's path", async () => {
    const run = await runLive("live-policy.test.js", "Python checks", "python-clean", { FAKE_LINGER: "stuck", CLAUDE_LIVE_SETTLE_MS: "1500" });
    expect(run.code, output(run)).not.toBe(0);
    expect(output(run)).toMatch(new RegExp(`Session processes still ran 1500 ms after the suite's sessions; killed them, then removed ${join(root, "tmp")}/claude-live-policy-\\w+:\\n\\d+ sh -c while`));
    // A writer still alive would recreate the root within 200 ms.
    await Bun.sleep(500);
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

  test("skill feedback records appended by other sessions pass", async () => {
    const run = await runLive("live-policy.test.js", "Chinese-only", "chinese-feedback-append");
    expect(run.code, output(run)).toBe(0);
    expect(existsSync(join(home, ".codex", "skill-feedback", "tauri", "verifications", "first.json"))).toBe(true);
    assertCleanedUp();
  }, 30_000);

  test("a codex-skills release that moves current passes, through ~/.agents/skills too", async () => {
    const run = await runLive("live-policy.test.js", "Chinese-only", "chinese-release-switch");
    expect(run.code, output(run)).toBe(0);
    expect(realpathSync(join(home, ".claude", "skills", "find-skills"))).toContain("/release-b/");
    expect(readFileSync(join(home, ".claude", "skills", "rust", "SKILL.md"), "utf8")).toBe("# Rust, revised\n");
    assertCleanedUp();
  }, 30_000);

  for (const [mode, message] of [
    ["chinese-drift", "CLAUDE.md"],
    ["chinese-retarget", "skills/typescript"],
    ["chinese-agents-retarget", "skills/find-skills: Type, mode or link changed: ."],
    ["chinese-release-old-edit", "skills/rust: Unauthorized content change: SKILL.md"],
    ["chinese-skill-edit", "skills/typescript: Unauthorized content change: SKILL.md"],
    ["chinese-feedback-edit", "skill-feedback: Unauthorized content change: rust/notes/old.md"],
    ["chinese-feedback-remove", "skill-feedback: Inventory changed: added [], removed [\"rust/verifications/old.json\"]"],
    ["chinese-feedback-other", "skill-feedback: Inventory changed: added [\"rust/README.md\"]"],
  ])
    test(mode, async () => {
      const run = await runLive("live-policy.test.js", "Chinese-only", mode);
      expect(run.code).not.toBe(0);
      expect(output(run)).toContain("Configuration changed during the run");
      expect(output(run)).toContain(message);
      assertCleanedUp();
    }, 30_000);
});

// The follow-up goes in over stream-json input while the session runs, so these also
// prove the conversation keeps stdin open until the background review is done.
describe("background review", () => {
  const name = "background while the session answers";

  test("a review in a background agent, with the follow-up answered meanwhile, passes", async () => {
    const run = await runLive("live.test.js", name, "review-background");
    expect(run.code, output(run)).toBe(0);
    expect(output(run)).toMatch(/1 pass/);
    assertCleanedUp();
  }, 30_000);

  for (const [mode, message] of [
    ["review-foreground", "the review was not one background agent"],
    ["review-late", "the follow-up was answered only after the review ended"],
    ["review-unrecorded", "the session did not record the outcomes once through ReportFindings"],
    ["review-early", "the outcomes were recorded before the review ended"],
    ["review-dismissed", "the real owner-check finding was not recorded as skipped"],
    ["review-uncategorized", "a finding has no category"],
  ])
    test(mode, async () => {
      const run = await runLive("live.test.js", name, mode);
      expect(run.code).not.toBe(0);
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
    expect(report.sessions[0].cwds[check.id]).toEndWith("/fixture");
    expect(readFileSync(join(reports, "python-checks-run-through-uv-run.stream.jsonl"), "utf8")).toContain(check.id);
    assertCleanedUp();
  }, 30_000);

  test("keep the directories of intact records when a killed hook left one truncated", () => {
    const records = join(root, "records");
    mkdirSync(records);
    writeFileSync(join(records, "1.json"), JSON.stringify({ hook_event_name: "PreToolUse", tool_use_id: "toolu_1", cwd: "/work" }));
    writeFileSync(join(records, "2.json"), JSON.stringify({ hook_event_name: "InstructionsLoaded", cwd: "/work" }));
    writeFileSync(join(records, "3.json"), "");
    expect(toolDirectories(records)).toEqual({ toolu_1: "/work" });
    expect(toolDirectories(join(root, "missing"))).toEqual({});
  });

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

// Sessions load ~/.claude, which links to the installed checkout. From another checkout
// they cannot load this one's configuration, so the location checks are skipped with one
// notice before any session; from the installed checkout they run.
describe("location checks", () => {
  const location = "resolves to this checkout|repository subdirectory";
  const notice = "Live sessions use the installed checkout ";

  // The notice prints when lib/live.js loads, before any test, so before any session.
  test("are skipped with one notice when ~/.claude is another checkout", async () => {
    // The background review scenario runs a fake session alongside: the other tests still run.
    const run = await runLive("live.test.js", `${location}|background while the session answers`, "review-background");
    const text = output(run);
    expect(run.code, text).toBe(0);
    expect(text.split(notice)).toHaveLength(2);
    expect(text).toContain(`${notice}${home} (~/.claude is ${join(home, ".claude")}), not this checkout ${realpathSync(join(TESTS, "..", ".."))}.`);
    expect(text).toContain("live-tested only after merge and config-sync");
    expect(text).toContain("(pass) live Claude Code > a high-impact review runs in the background while the session answers");
    expect(text).toMatch(/ 1 pass\n 3 skip\n/);
    expect(text).toMatch(/\(skip\) live Claude Code > ~\/\.claude resolves to this checkout's claude directory/);
    assertCleanedUp();
  }, 30_000);

  test("run without the notice when ~/.claude is this checkout", async () => {
    rmSync(join(home, ".claude"), { recursive: true });
    symlinkSync(join(TESTS, ".."), join(home, ".claude"));
    const run = await runLive("live.test.js", "resolves to this checkout", "unused");
    expect(run.code, output(run)).toBe(0);
    expect(output(run)).not.toContain(notice);
    expect(output(run)).toMatch(/\(pass\) live Claude Code > ~\/\.claude resolves to this checkout's claude directory/);
    expect(output(run)).toMatch(/ 1 pass\n/);
  }, 30_000);
});
