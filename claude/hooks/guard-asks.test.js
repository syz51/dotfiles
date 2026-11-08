import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { askViolation } from "./guard-asks.js";

const HOOK = join(import.meta.dir, "guard-asks.js");
const POLICY = JSON.parse(readFileSync(join(import.meta.dir, "ask-policy.json"), "utf8"));
const verdict = (input) => askViolation(input, POLICY);

describe("the policy file", () => {
  test("lists the reasons the Autonomy section names, and only-me for actions", () => {
    expect(Object.keys(POLICY.reasons)).toEqual(["design", "cost", "irreversible", "outside", "only-me", "security"]);
    expect(POLICY.action_reasons).toEqual(["only-me"]);
    expect(POLICY.never.length).toBeGreaterThan(0);
    const autonomy = readFileSync(join(import.meta.dir, "..", "CLAUDE.md"), "utf8").match(/\n## Autonomy\n((?:(?!\n## )[\s\S])*)/)[1];
    for (const name of Object.keys(POLICY.reasons)) expect(autonomy).toContain(`  - ${name}: `);
  });
});

describe("it lets through", () => {
  test.each([
    [{ question: "What: pick a J-Quants plan.\nWhy it waits on you: Reason: cost. It is a paid plan." }],
    [{ question: "Why it waits on you (Reason: design): the layout is a taste call." }],
    [{ question: "reason: `outside` — posting upstream", kind: "decision" }],
    [{ question: "Why it waits on you: Reason: only-me. The screen must be unlocked.", kind: "action" }],
    [{ question: "Reason: IRREVERSIBLE. Delete ~/.t3-fork for good?" }],
  ])("%j", (input) => expect(verdict(input)).toBeUndefined());
});

describe("it blocks", () => {
  test("an ask with no reason, and lists the reasons and what to do instead", () => {
    const reason = verdict({ question: "Should I fast-forward the trading checkout?" });
    expect(reason).toMatch(/names no reason/);
    for (const name of Object.keys(POLICY.reasons)) expect(reason).toContain(`- ${name}: `);
    expect(reason).toContain("a hook, guard or instruction blocks a step");
  });

  test("an unlisted reason", () => {
    expect(verdict({ question: "Reason: hook. The guard refused git switch." })).toMatch(/`Reason: hook` is not a listed reason/);
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

  test("fails open when the policy cannot be read", () => {
    const result = run({ question: "no reason" }, { ASK_POLICY: "/nonexistent/ask-policy.json" });
    expect(result.status).not.toBe(2);
  });
});
