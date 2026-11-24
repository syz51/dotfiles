// Fixture and tests for diff-review's weakened-guarantee rule (dotfiles-514):
// builds a synthetic git repository whose commit raises a test size cap without
// a `Loosens:` line, verifies the diff-review prompt embeds the rule offline, and
// (with RUN_AGY_LIVE=1) runs Gemini 4 Neon via agy-run to confirm the reviewer
// flags the unlabeled cap raise as a finding.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { reviewPrompt } from "../factory/review/cli.js";

const AGY_RUN = process.env.CLAUDE_FACTORY_AGY_BIN || join(homedir(), ".local", "bin", "agy-run");
const LIVE_AGY = process.env.RUN_AGY_LIVE === "1";

let scratch;

function git(cwd, args) {
  const run = Bun.spawnSync(
    ["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd },
  );
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

// Synthetic repository with a size-cap test, an unlabeled cap raise, and a labeled control.
function createCapRaiseFixture(root) {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "tests"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);

  writeFileSync(join(repo, "instructions.md"), "# Agent Defaults\n\n- Keep instructions concise.\n");
  writeFileSync(
    join(repo, "tests", "config.test.js"),
    [
      'import { expect, test } from "bun:test";',
      'import { readFileSync } from "node:fs";',
      "",
      "// A new rule displaces text; raising this cap needs the user's approval through `ask_user`.",
      'test("instructions stay under their size budget", () => {',
      '  const text = readFileSync("instructions.md", "utf8");',
      "  expect(text.length).toBeLessThan(17_000);",
      "});",
      "",
    ].join("\n"),
  );
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "Add instructions size cap"]);
  const base = git(repo, ["rev-parse", "HEAD"]);

  // Unlabeled cap raise: adds a rule and raises 17_000 -> 17_500 with no `Loosens:` line.
  git(repo, ["checkout", "-q", "-b", "unlabeled-raise"]);
  writeFileSync(
    join(repo, "instructions.md"),
    "# Agent Defaults\n\n- Keep instructions concise.\n- Cache build outputs per repository.\n",
  );
  writeFileSync(
    join(repo, "tests", "config.test.js"),
    [
      'import { expect, test } from "bun:test";',
      'import { readFileSync } from "node:fs";',
      "",
      "// A new rule displaces text; raising this cap needs the user's approval through `ask_user`.",
      'test("instructions stay under their size budget", () => {',
      '  const text = readFileSync("instructions.md", "utf8");',
      "  expect(text.length).toBeLessThan(17_500);",
      "});",
      "",
    ].join("\n"),
  );
  git(repo, ["commit", "-q", "-am", "Add caching guidance"]);
  const unlabeled = git(repo, ["rev-parse", "HEAD"]);

  // Labeled control: identical diff, with a `Loosens:` line in the commit message.
  git(repo, ["checkout", "-q", "-b", "labeled-raise", base]);
  writeFileSync(
    join(repo, "instructions.md"),
    "# Agent Defaults\n\n- Keep instructions concise.\n- Cache build outputs per repository.\n",
  );
  writeFileSync(
    join(repo, "tests", "config.test.js"),
    [
      'import { expect, test } from "bun:test";',
      'import { readFileSync } from "node:fs";',
      "",
      "// A new rule displaces text; raising this cap needs the user's approval through `ask_user`.",
      'test("instructions stay under their size budget", () => {',
      '  const text = readFileSync("instructions.md", "utf8");',
      "  expect(text.length).toBeLessThan(17_500);",
      "});",
      "",
    ].join("\n"),
  );
  git(repo, [
    "commit",
    "-q",
    "-am",
    "Add caching guidance\n\nLoosens: raise instructions size cap from 17,000 to 17,500 after owner approval",
  ]);
  const labeled = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-q", unlabeled]);

  return { repo, base, unlabeled, labeled };
}

function parseFindingsJson(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(trimmed);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(`Could not parse findings JSON (${err.message}): ${trimmed.slice(0, 400)}`);
  }
}

function flagsCapRaise(findings) {
  return (
    Array.isArray(findings)
    && findings.some((f) => {
      const text = `${f.summary ?? ""} ${f.failure_scenario ?? ""}`;
      return (
        String(f.file ?? "").endsWith("tests/config.test.js")
        && /cap|limit|budget|17[_ ,]?000|17[_ ,]?500|loosens|weakened/i.test(text)
      );
    })
  );
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "diff-review-loosens-")));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("diff-review weakened-guarantee fixture", () => {
  test("constructs an unlabeled cap-raise diff and embeds the diff-review Loosens: rule", () => {
    const { repo, base, unlabeled, labeled } = createCapRaiseFixture(scratch);
    const diff = git(repo, ["diff", `${base}...${unlabeled}`]);
    expect(diff).toContain("-  expect(text.length).toBeLessThan(17_000);");
    expect(diff).toContain("+  expect(text.length).toBeLessThan(17_500);");
    expect(git(repo, ["log", "--format=%B", `${base}..${unlabeled}`])).not.toMatch(/^Loosens:/m);
    expect(git(repo, ["log", "--format=%B", `${base}..${labeled}`])).toMatch(/^Loosens:/m);

    const prompt = reviewPrompt({ base, head: unlabeled });
    expect(prompt).toContain(`Target: ${base}...${unlabeled}`);
    expect(prompt).toContain("raised limit, cap, budget or threshold, a widened allowlist");
    expect(prompt).toContain("deleted or relaxed assertion is a weakened guarantee");
    expect(prompt).toContain("`Loosens:`");

    expect(
      flagsCapRaise([
        {
          file: "tests/config.test.js",
          line: 7,
          category: "conventions",
          summary: "Size budget raised from 17,000 to 17,500 without a Loosens: line.",
          failure_scenario: "Cap rises silently without notifying the user.",
        },
      ]),
    ).toBe(true);
    expect(flagsCapRaise([])).toBe(false);
  });

  test.skipIf(!LIVE_AGY)(
    "live reviewer flags the unlabeled cap raise through diff-review (RUN_AGY_LIVE=1)",
    () => {
      expect(existsSync(AGY_RUN), `agy-run not found at ${AGY_RUN}`).toBe(true);
      const { repo, base, unlabeled } = createCapRaiseFixture(scratch);
      const prompt = reviewPrompt({ base, head: unlabeled });
      const run = Bun.spawnSync(
        [AGY_RUN, "--cwd", repo, "--full-access", "--model", "gemini-4-neon", "--effort", "high", "--output-format", "stream-json"],
        { cwd: repo, stdin: Buffer.from(prompt), env: { ...process.env, AGENT_BOARD_HOOKS: "off" }, timeout: 180_000 },
      );
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      const events = run.stdout
        .toString()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
      const result = events.findLast((event) => event.type === "result");
      expect(result?.is_error).toBe(false);
      const findings = parseFindingsJson(result?.result ?? "");
      expect(flagsCapRaise(findings), `Expected cap-raise finding, got: ${JSON.stringify(findings)}`).toBe(true);
    },
    180_000,
  );
});
