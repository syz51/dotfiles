import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { askViolation } from "./guard-asks.js";

const HOOK = join(import.meta.dir, "guard-asks.js");
const POLICY = JSON.parse(readFileSync(join(import.meta.dir, "ask-policy.json"), "utf8"));
const verdict = (input, policy = POLICY) => askViolation(input, policy);

describe("the policy file", () => {
  test("names the same reasons as the Autonomy section, and only-me for actions", () => {
    const autonomy = readFileSync(join(import.meta.dir, "..", "CLAUDE.md"), "utf8").match(/\n## Autonomy\n((?:(?!\n## )[\s\S])*)/)[1];
    const notify = autonomy.match(/- Notify me[^\n]*\n((?: {2}- [^\n]*\n)+)/)[1];
    const listed = [...notify.matchAll(/^ {2}- ([a-z-]+): /gm)].map((match) => match[1]);
    expect(Object.keys(POLICY.reasons)).toEqual(listed);
    expect(listed).toContain("only-me");
    expect(POLICY.action_reasons).toEqual(["only-me"]);
    const never = autonomy.match(/- These are never reasons to ask[^\n]*\n((?: {2}- [^\n]*\n)+)/)[1];
    expect(POLICY.never).toHaveLength(never.trim().split("\n").length);
  });
});

describe("it lets through", () => {
  test.each([
    [{ question: "What: pick a J-Quants plan.\nWhy it waits on you: Reason: cost. It is a paid plan." }],
    [{ question: "Why it waits on you (Reason: design): the layout is a taste call." }],
    [{ question: "reason: `outside` — posting upstream", kind: "decision" }],
    [{ question: "Why it waits on you: Reason: only-me. The screen must be unlocked.", kind: "action" }],
    [{ question: "Reason: IRREVERSIBLE. Delete ~/.t3-fork for good?" }],
    // Markup, quotes, a copied placeholder and a space for the hyphen.
    [{ question: "**Reason:** cost" }],
    [{ question: 'Reason: "design"' }],
    [{ question: "Reason: <design>" }],
    [{ question: "Reason: only me, the screen is locked", kind: "action" }],
    [{ question: "Reason: cost because the plan is paid" }],
    // An earlier "reason:" in the text does not hide the labelled one.
    [{ question: "What: CI fails; the reason: missing secret. Why it waits on you: Reason: only-me.", kind: "action" }],
  ])("%j", (input) => expect(verdict(input)).toBeUndefined());

  test("a reason the user adds with capitals, digits or underscores", () => {
    const policy = { ...POLICY, reasons: { ...POLICY.reasons, legal_review: "legal", API2: "api" } };
    expect(verdict({ question: "Reason: legal_review" }, policy)).toBeUndefined();
    expect(verdict({ question: "Reason: API2" }, policy)).toBeUndefined();
  });
});

describe("it blocks", () => {
  test("an ask with no reason, and lists the reasons and what to do instead", () => {
    const reason = verdict({ question: "Should I fast-forward the trading checkout?" });
    expect(reason).toMatch(/names no reason/);
    for (const name of Object.keys(POLICY.reasons)) expect(reason).toContain(`- ${name}: `);
    expect(reason).toContain("a hook, guard or instruction blocks a safe step");
  });

  test("an unlisted reason", () => {
    expect(verdict({ question: "Reason: hook. The guard refused git switch." })).toMatch(/`Reason: hook\.?[^`]*` is not a listed reason/);
  });

  test("an action ask for anything but only-me", () => {
    expect(verdict({ question: "Reason: design. Please merge PR #105.", kind: "action" })).toMatch(/an action ask hands the user a step/);
  });

  test("a missing question", () => {
    expect(verdict({})).toMatch(/names no reason/);
    expect(verdict(undefined)).toMatch(/names no reason/);
  });
});

describe("as a hook", () => {
  const run = (toolInput, env = {}) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "mcp__board__ask_user", tool_input: toolInput }),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  test("exits 2 with the reason on stderr for a blocked ask", () => {
    const result = run({ question: "Can you run git pull in trading?", kind: "action" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^Blocked by the guard-asks hook: the ask names no reason/);
  });

  test("exits 0 for an allowed ask", () => {
    const result = run({ question: "Reason: cost. Subscribe to the Light plan?" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("fails open with a non-blocking error when the policy cannot be read", () => {
    const result = run({ question: "no reason" }, { ASK_POLICY: "/nonexistent/ask-policy.json" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ENOENT|no such file/i);
  });
});
