// Fixture and tests for diff-review's weakened-guarantee rule (dotfiles-514):
// builds a synthetic git repository whose commit raises a test size cap without
// a `Loosens:` line, verifies the diff-review prompt embeds the rule offline, and
// (with RUN_AGY_LIVE=1) runs Gemini 4 Neon via agy-run to confirm the reviewer
// flags the unlabeled cap raise as a finding.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyBin } from "../factory/lib/claude.js";
import { reviewPrompt } from "../factory/review/cli.js";
import { partialEvents, resultEvent } from "./lib/stream.js";

const LIVE_AGY = process.env.RUN_AGY_LIVE === "1";
const AGY_TIMEOUT_MS = 150_000;
const SPAWN_TIMEOUT_MS = AGY_TIMEOUT_MS + 30_000;

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
    "live reviewer flags the unlabeled cap raise and passes the labeled control (RUN_AGY_LIVE=1)",
    () => {
      const bin = agyBin();
      expect(existsSync(bin), `agy-run not found at ${bin}`).toBe(true);
      const { repo, base, unlabeled, labeled } = createCapRaiseFixture(scratch);
      const runReview = (head) => {
        git(repo, ["checkout", "-q", head]);
        const prompt = reviewPrompt({ base, head });
        const run = Bun.spawnSync(
          [
            bin,
            "--cwd",
            repo,
            "--full-access",
            "--model",
            "gemini-4-neon",
            "--effort",
            "high",
            "--timeout",
            String(AGY_TIMEOUT_MS),
            "--output-format",
            "stream-json",
          ],
          { cwd: repo, stdin: Buffer.from(prompt), env: { ...process.env, AGENT_BOARD_HOOKS: "off" }, timeout: SPAWN_TIMEOUT_MS },
        );
        expect(run.exitCode, run.stderr.toString()).toBe(0);
        const result = resultEvent(partialEvents(run.stdout.toString()));
        expect(result?.is_error).toBe(false);
        return parseFindingsJson(result?.result ?? "");
      };

      const unlabeledFindings = runReview(unlabeled);
      expect(flagsCapRaise(unlabeledFindings), `Expected cap-raise finding, got: ${JSON.stringify(unlabeledFindings)}`).toBe(true);

      const labeledFindings = runReview(labeled);
      expect(flagsCapRaise(labeledFindings), `Expected labeled cap raise not to be flagged, got: ${JSON.stringify(labeledFindings)}`).toBe(false);
    },
    SPAWN_TIMEOUT_MS * 2,
  );
});
