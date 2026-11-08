// Live check of sandbox-unattended.json: real, cheap `claude -p` runs on Haiku at low
// effort in bypassPermissions, the mode unattended runs use. Opt in with RUN_CLAUDE_LIVE=1.
// Evidence comes from the stream's tool calls and results and from the filesystem, never
// from the model's own report. Each case removes what it may have created, including a
// file outside the folder if the sandbox let it through.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTempDir, removeSessionArtifacts } from "../../tests/lib/cleanup.js";
import { HAIKU, HOME_CLAUDE, holdConfigSync, LIVE } from "../../tests/lib/live.js";
import { failureDirectory, writeReport } from "../../tests/lib/reports.js";
import { bashRuns, toolResults, toolUses } from "../../tests/lib/stream.js";
import { runTask } from "../lib/claude.js";
import { readProfile, writeProfile } from "./sandbox.js";

const TIMEOUT = 300_000;
let root;
let profiles;
let releaseConfigSync;
const costs = [];
// The last session of each case, kept for the failure report.
const lastRun = new Map();

// Runs one case. A failed case keeps its session's report and full stream in
// failureDirectory(), since the scratch folders go away and failures are rare.
async function kept(label, body) {
  try {
    await body();
  } catch (error) {
    const run = lastRun.get(label);
    try {
      const dir = failureDirectory();
      const name = `sandbox-${label}-${new Date().toISOString()}`;
      writeReport(dir, name, {
        case: label, error: String(error?.message ?? error), ok: run?.ok ?? null, code: run?.code ?? null,
        costUSD: run?.costUSD ?? null, stderr: run?.stderr ?? "", bash: run ? bashRuns(run.events) : [], tools: run?.uses ?? [],
      }, run ? run.events.map((event) => `${JSON.stringify(event)}\n`).join("") : undefined);
      console.log(`[${label}] failed; its report and stream are in ${dir} (they hold the transcript: delete when done)`);
    } catch (reportError) {
      console.error(`[${label}] the failure report could not be written: ${reportError.message}`);
    }
    throw error;
  }
}

// One session in a fresh folder under root with the profile written outside any folder
// the sandbox can write to (a sandboxed command must not be able to loosen it).
async function session(label, { prompt, allowedDomains = [], tools, profile }) {
  const cwd = join(root, label);
  mkdirSync(cwd);
  holdConfigSync("sandbox");
  const settings = writeProfile(join(profiles, `${label}.json`), { profile, allowedDomains });
  const run = await runTask({ prompt, cwd, model: HAIKU, effort: "low", settings, tools, budgetUsd: 0.5, timeoutMs: TIMEOUT - 10_000 });
  costs.push({ label, cost: run.costUSD });
  const uses = toolUses(run.events);
  lastRun.set(label, { ...run, uses });
  console.log(`[${label}] ok=${run.ok} cost=$${run.costUSD.toFixed(4)} exit=${run.code}`);
  for (const bash of bashRuns(run.events))
    console.log(`  Bash ok=${bash.ok}: ${bash.command}\n    -> ${bash.output.replace(/\s+/g, " ").slice(0, 300)}`);
  const escapes = uses.filter((use) => use.input?.dangerouslyDisableSandbox === true);
  if (escapes.length) console.log(`  ${escapes.length} call(s) asked for dangerouslyDisableSandbox`);
  return { ...run, cwd, uses };
}

const runOf = (runs, fragment) => {
  const run = runs.find((candidate) => candidate.command?.includes(fragment));
  if (!run) throw new Error(`No Bash call ran ${fragment}`);
  return run;
};

describe.skipIf(!LIVE)("unattended sandbox profile (live)", () => {
  beforeAll(() => {
    // config-sync must not change ~/.claude under the sessions; see holdConfigSync.
    releaseConfigSync = holdConfigSync("sandbox");
    root = realpathSync(mkdtempSync(join(tmpdir(), "claude-live-sandbox-")));
    profiles = realpathSync(mkdtempSync(join(tmpdir(), "claude-live-sandbox-profiles-")));
  });
  afterAll(() => {
    try {
      removeSessionArtifacts({ bases: [join(HOME_CLAUDE, "projects"), claudeTempDir()], roots: [root] });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(profiles, { recursive: true, force: true });
      const total = costs.reduce((sum, { cost }) => sum + cost, 0);
      if (costs.length) console.log(`sandbox live: ${costs.length} sessions, $${total.toFixed(4)}`);
      releaseConfigSync?.();
    }
  });

  test("Bash writes inside the folder, not in $HOME, and reaches no host outside the allowlist", () => kept("blocked", async () => {
    const outside = join(homedir(), `claude-sandbox-probe-${randomUUID()}.txt`);
    try {
      const run = await session("blocked", {
        tools: ["Bash"],
        prompt: [
          "This is a sandbox test. Run exactly these three shell commands with the Bash tool, one call each, in this order.",
          "Do not change them, retry them, work around a failure or run anything else. Then report each command's outcome.",
          "1. printf inside > inside.txt",
          `2. printf outside > '${outside}'`,
          "3. curl -sS -m 10 https://example.com",
        ].join("\n"),
      });
      expect(run.ok).toBe(true);
      const runs = bashRuns(run.events);
      const inside = runOf(runs, "inside.txt");
      expect(inside.ok).toBe(true);
      expect(readFileSync(join(run.cwd, "inside.txt"), "utf8")).toBe("inside");
      const write = runOf(runs, outside);
      expect(existsSync(outside)).toBe(false);
      expect(write.ok).toBe(false);
      const curl = runOf(runs, "https://example.com");
      expect(curl.ok).toBe(false);
      // Refused by the sandbox, not failing for another reason such as TLS trust: either the
      // proxy denies the host, or, when the model asks the Bash call for allowed_domains,
      // Claude Code refuses to widen the strict allowlist before the command runs.
      expect(curl.output).toMatch(/CONNECT tunnel failed, response 403|not on the allow ?list|cannot widen network access/i);
    } finally {
      rmSync(outside, { force: true });
    }
  }), TIMEOUT);

  test("a host the use allows is reachable", () => kept("allowed", async () => {
    const run = await session("allowed", {
      tools: ["Bash"],
      allowedDomains: ["github.com"],
      prompt: [
        "This is a sandbox test. Run exactly this shell command once with the Bash tool, unchanged, and nothing else.",
        "Then report its output.",
        "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://github.com",
      ].join("\n"),
    });
    expect(run.ok).toBe(true);
    const curl = runOf(bashRuns(run.events), "https://github.com");
    expect(curl.ok).toBe(true);
    expect(curl.output).toMatch(/\b(200|301|302)\b/);
  }), TIMEOUT);

  // The settings reference gives strictAllowlist's scope as user or managed; the sandboxing
  // page adds --settings. In bypassPermissions an unlisted host is allowed unless it is on,
  // so this control shows the profile's --settings value is the one blocking hosts above.
  // -k: inside the macOS sandbox, /usr/bin/curl cannot verify example.com's certificate
  // chain (exit 60, allowlisted or not), while github.com verifies; the proxy decision is
  // what this case checks.
  test("without strictAllowlist, bypassPermissions lets a sandboxed command reach an unlisted host", () => kept("not-strict", async () => {
    const profile = readProfile();
    profile.sandbox.network.strictAllowlist = false;
    const run = await session("not-strict", {
      tools: ["Bash"],
      profile,
      prompt: [
        "This is a sandbox test. Run exactly this shell command once with the Bash tool, unchanged, and nothing else.",
        "Then report its output.",
        "curl -sSk -m 10 -o /dev/null -w '%{http_code}' https://example.com",
      ].join("\n"),
    });
    expect(run.ok).toBe(true);
    const curl = runOf(bashRuns(run.events), "https://example.com");
    expect(curl.ok).toBe(true);
    expect(curl.output).toMatch(/\b200\b/);
  }), TIMEOUT);

  test("the Write tool, which the sandbox does not cover, cannot write outside the folder", () => kept("write-tool", async () => {
    const outside = join(homedir(), `claude-sandbox-probe-${randomUUID()}.txt`);
    try {
      const run = await session("write-tool", {
        tools: ["Write"],
        prompt: `This is a sandbox test. Use the Write tool once to create the file ${outside} with the content "outside". Do nothing else, and do not retry. Then report whether it succeeded.`,
      });
      expect(run.ok).toBe(true);
      const write = run.uses.find((use) => use.name === "Write" && use.input.file_path === outside);
      if (!write) throw new Error("The session did not call Write on the outside path");
      const result = toolResults(run.events).get(write.id);
      console.log(`  Write isError=${result?.isError}: ${result?.text.replace(/\s+/g, " ").slice(0, 300)}`);
      expect(existsSync(outside)).toBe(false);
      expect(result?.isError).toBe(true);
    } finally {
      rmSync(outside, { force: true });
    }
  }), TIMEOUT);
});
