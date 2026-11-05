import { describe, expect, test } from "bun:test";
import { countCorrections, isCorrection } from "./corrections.js";
import { reverts } from "./github.js";
import { humanPrompts, isHostPrompt } from "./prompts.js";
import { prUrls, sessionPrs } from "./prs.js";
import { quantile } from "./stats.js";

describe("correction heuristic", () => {
  test.each([
    "no, that's the wrong file",
    "No i meant the comments",
    "nope",
    "not with bun. with rust",
    "That's not what I asked for",
    "I said to keep the colors",
    "you forgot the tests",
    "why did you ask for permission again?",
    "it still doesn't work",
    "the build is still failing",
    "Actions failed again",
    "instead of localhost, use the tailscale URL",
    "stop, revert that",
    "**Status:** All done.\nno, the tests never ran",
  ])("counts %p", (text) => expect(isCorrection(text)).toBe(true));

  test.each([
    "no problem, thanks",
    "No worries, go ahead",
    "no need to hurry",
    "yes, do that",
    "Looks good, commit it",
    "is it pushed?",
    "why is my default not the latest version?",
    "Notes on the design: keep it simple",
    "Update on pull request #3 (https://github.com/o/r/pull/3), which T3 Code is watching for you:\n- Checks failed, still failing",
    "<command-name>/compact</command-name>",
    "Could you also add a dark mode?",
  ])("does not count %p", (text) => expect(isCorrection(text)).toBe(false));

  test("never counts the first prompt", () => {
    const prompts = ["no, that's wrong", "thanks", "you forgot the tests"].map((text) => ({ text }));
    expect(countCorrections(prompts)).toEqual({ followUps: 2, corrections: 1 });
    expect(countCorrections(prompts.slice(0, 1))).toEqual({ followUps: 0, corrections: 0 });
    expect(countCorrections([])).toEqual({ followUps: 0, corrections: 0 });
  });
});

describe("prompts", () => {
  test("host notices are not the person's prompts", () => {
    for (const text of [
      "Update on pull request #13 (https://github.com/o/r/pull/13), which T3 Code is watching for you:\n- All checks passed.",
      "Pull request #9 (https://github.com/o/r/pull/9) was closed, so T3 Code stopped watching it.",
      "Delegated task node:delegated-task:command%3Amcp%3Ax (Build) [completed]",
      "Continue where you left off.",
      "<command-name>/compact</command-name>\n<command-message>compact</command-message>",
    ]) expect(isHostPrompt(text)).toBe(true);
    expect(isHostPrompt("Continue where you left off, but use Rust")).toBe(false);
    const session = { prompts: [{ text: "Build it" }, { text: "Continue where you left off." }, { text: "now test it" }] };
    expect(humanPrompts(session).map((prompt) => prompt.text)).toEqual(["Build it", "now test it"]);
  });
});

describe("pull request links", () => {
  test("parses PR URLs and ignores other GitHub links", () => {
    const text = "https://github.com/o/r/pull/12\nhttps://github.com/o/r/pull/new/branch https://github.com/o/r.js/pull/3/files https://github.com/o/r/issues/4";
    expect(prUrls(text).map((pr) => [pr.url, pr.repository, pr.number])).toEqual([
      ["https://github.com/o/r/pull/12", "o/r", 12],
      ["https://github.com/o/r.js/pull/3", "o/r.js", 3],
    ]);
  });

  test("a session links pr-link records and URLs printed by gh pr create, once each", () => {
    const session = {
      prLinks: [{ url: "https://github.com/O/R/pull/1" }],
      toolCalls: [
        { name: "Bash", input: { command: "git push && gh pr create --fill" }, output: "https://github.com/o/r/pull/2\n" },
        { name: "Bash", input: { command: "gh pr create --draft" }, output: "https://github.com/o/r/pull/1" },
        { name: "Bash", input: { command: "gh pr view 3" }, output: "https://github.com/o/r/pull/3" },
        { name: "Read", input: { command: "gh pr create" }, output: "https://github.com/o/r/pull/4" },
      ],
    };
    expect(sessionPrs(session).map((pr) => pr.key)).toEqual(["o/r#1", "o/r#2"]);
  });
});

describe("revert matching", () => {
  const pr = { number: 7, url: "https://github.com/o/r/pull/7", title: "Add the widget", mergedAt: "2026-11-02T00:00:00Z" };
  const revert = (fields) => ({ number: 9, title: "Revert something", body: "", mergedAt: "2026-11-03T00:00:00Z", ...fields });

  test("names the PR by number, URL or exact title", () => {
    expect(reverts(revert({ body: "Reverts o/r#7" }), pr)).toBe(true);
    expect(reverts(revert({ body: "Reverts #7." }), pr)).toBe(true);
    expect(reverts(revert({ body: "See https://github.com/O/R/pull/7" }), pr)).toBe(true);
    expect(reverts(revert({ title: 'Revert "Add the widget"' }), pr)).toBe(true);
    expect(reverts(revert({ body: 'This reverts "Add the widget".' }), pr)).toBe(true);
  });

  test("ignores other numbers, itself and earlier reverts", () => {
    expect(reverts(revert({ body: "Reverts #70 and #17" }), pr)).toBe(false);
    expect(reverts(revert({ body: "https://github.com/o/r/pull/77" }), pr)).toBe(false);
    expect(reverts(revert({ title: 'Revert "Add the widget twice"' }), pr)).toBe(false);
    expect(reverts(revert({ number: 7, body: "#7" }), pr)).toBe(false);
    expect(reverts(revert({ body: "#7", mergedAt: "2026-11-01T00:00:00Z" }), pr)).toBe(false);
  });
});

test("quantile interpolates between ranks", () => {
  expect(quantile([], 0.5)).toBeNull();
  expect(quantile([3, 1, 2], 0.5)).toBe(2);
  expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  expect(quantile([0, 10], 0.9)).toBe(9);
});
