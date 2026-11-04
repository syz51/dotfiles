import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bash, read, toolUse } from "./fixtures.js";
import { guidanceEvidence, guidanceTargets, scoreGuidance } from "./guidance.js";

let home;
let targets;
let skills;

beforeAll(() => {
  // home/.claude/skills/typescript -> home/releases/typescript, as installed skills are linked.
  home = realpathSync(mkdtempSync(join(tmpdir(), "guidance-test-")));
  const release = join(home, "releases", "typescript");
  mkdirSync(join(release, "references"), { recursive: true });
  writeFileSync(join(release, "SKILL.md"), "# TypeScript\n");
  writeFileSync(join(release, "references", "effect.md"), "# Effect\nUse Effect for new application logic.\n");
  writeFileSync(join(release, "references", "tooling.md"), "# Tooling\n");
  skills = join(home, ".claude", "skills");
  mkdirSync(skills, { recursive: true });
  symlinkSync(release, join(skills, "typescript"));
  writeFileSync(join(home, ".claude", "frontend-avoid.md"), "# Avoid\n- Rainbow gradients on every surface.\n");
  targets = guidanceTargets({ typescript: join(skills, "typescript"), preferences: join(home, ".claude", "frontend-avoid.md") }, home);
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

const linked = (file) => join(skills, "typescript", file);
const resolved = (file) => join(home, "releases", "typescript", file);

describe("targets", () => {
  test("know the linked, resolved and home-relative spellings", () => {
    const spellings = targets.find((target) => target.name === "typescript").spellings;
    expect(spellings).toEqual(expect.arrayContaining([
      join(skills, "typescript"), join(home, "releases", "typescript"), "~/.claude/skills/typescript", "$HOME/.claude/skills/typescript", "~/releases/typescript"]));
  });
});

describe("evidence", () => {
  test("a Read through the link or the resolved path is the same read", () => {
    const events = [...read(linked("SKILL.md"), "# TypeScript\n"), ...read(resolved("references/effect.md"), "# Effect\n")];
    expect(guidanceEvidence(events, targets).reads.map(({ target, file, complete }) => [target, file, complete])).toEqual([
      ["typescript", "SKILL.md", true], ["typescript", "references/effect.md", true]]);
  });

  test("failed reads are not reads, and partial reads are not complete", () => {
    const events = [...read(linked("references/effect.md"), "x", { isError: true }), ...read(linked("references/tooling.md"), "a\nb", { partial: true })];
    const evidence = guidanceEvidence(events, targets);
    expect(evidence.reads).toEqual([expect.objectContaining({ file: "references/tooling.md", complete: false })]);
    expect(scoreGuidance(evidence, { required: [{ target: "typescript", file: "references/tooling.md" }] }))
      .toEqual(["Required guidance was not read completely: typescript/references/tooling.md"]);
  });

  test("a literal cat of absolute paths is a read; a failed cat is not", () => {
    const evidence = guidanceEvidence([
      ...bash(`cat ${resolved("references/effect.md")} ${join(home, ".claude", "frontend-avoid.md")}`, "# Effect\n# Avoid\n"),
      ...bash(`cat ${linked("references/tooling.md")}`, "No such file", { isError: true }),
    ], targets);
    expect(evidence.reads.map(({ target, file, via }) => [target, file, via])).toEqual([
      ["typescript", "references/effect.md", "cat"], ["preferences", "", "cat"]]);
    expect(evidence.uncertain).toEqual([]);
  });

  test("printed paths and other commands that touch a target are uncertain, not reads", () => {
    const evidence = guidanceEvidence([
      ...bash("echo ~/.claude/skills/typescript/references/effect.md", "/home/references/effect.md"),
      ...bash(`sed -n 1,5p ${linked("SKILL.md")} | head`, "# TypeScript"),
      toolUse("Grep", { pattern: "Effect", path: resolved("references") }).event,
    ], targets);
    expect(evidence.reads).toEqual([]);
    expect(evidence.uncertain.map((entry) => entry.target)).toEqual(["typescript", "typescript", "typescript"]);
  });

  test("a compound command that printed a named file whole read it, yet leaves the target uncertain", () => {
    const avoid = "# Avoid\n- Rainbow gradients on every surface.\n";
    const evidence = guidanceEvidence([
      ...bash("cat brief.md; echo ----; cat ~/.claude/frontend-avoid.md; ls -la", `# Brief\n----\n${avoid}total 8\n`),
      ...bash("head -1 ~/.claude/frontend-avoid.md | cat", "# Avoid\n"),
      ...bash("cat ~/.claude/frontend-avoid.md || true", avoid, { isError: true }),
    ], targets);
    expect(evidence.reads).toEqual([{ target: "preferences", file: "", complete: true, parent: null, via: "output" }]);
    expect(evidence.uncertain.map((entry) => entry.target)).toEqual(["preferences", "preferences", "preferences"]);
    expect(scoreGuidance(evidence, { required: [{ target: "preferences" }] })).toEqual([]);
  });

  test("in a skill folder, only files the command names and printed whole count", () => {
    const whole = "# Effect\nUse Effect for new application logic.\n";
    expect(guidanceEvidence(bash(`cd ${linked("references")}; cat effect.md | head -1`, "# Effect\n"), targets).reads).toEqual([]);
    expect(guidanceEvidence(bash(`cd ${linked("")}; cat references/* | head`, whole), targets).reads).toEqual([]);
    const evidence = guidanceEvidence(bash(`cd ${linked("references")}; cat effect.md`, whole), targets);
    expect(evidence.reads).toEqual([{ target: "typescript", file: "references/effect.md", complete: true, parent: null, via: "output" }]);
    expect(evidence.uncertain.map((entry) => entry.target)).toEqual(["typescript"]);
  });
});

describe("scoring", () => {
  test("passes when the required guidance was read and nothing forbidden was touched", () => {
    const evidence = guidanceEvidence(read(join(home, ".claude", "frontend-avoid.md"), "# Avoid\n- Rainbow gradients on every surface.\n"), targets);
    expect(scoreGuidance(evidence, { required: [{ target: "preferences" }], forbidden: [{ target: "typescript" }] })).toEqual([]);
  });

  test("a forbidden read in a subagent fails the whole run", () => {
    const spawn = toolUse("Agent", { subagent_type: "explorer" });
    const evidence = guidanceEvidence([spawn.event, ...read(linked("SKILL.md"), "# TypeScript\n", { parent: spawn.id })], targets);
    expect(scoreGuidance(evidence, { forbidden: [{ target: "typescript" }] }))
      .toEqual(["Subagent: forbidden guidance was read: typescript/SKILL.md"]);
  });

  test("an unrouted reference is forbidden while the routed one is required", () => {
    const evidence = guidanceEvidence([
      ...read(linked("references/effect.md"), "# Effect\n"), ...read(linked("references/tooling.md"), "# Tooling\n")], targets);
    expect(scoreGuidance(evidence, {
      required: [{ target: "typescript", file: "references/effect.md" }],
      forbidden: [{ target: "typescript", file: "references/tooling.md" }],
    })).toEqual(["Main session: forbidden guidance was read: typescript/references/tooling.md"]);
  });

  test("an uncertain touch blocks the claim that forbidden guidance was not read", () => {
    const evidence = guidanceEvidence(bash("ls ~/.claude/skills/typescript/references", "effect.md"), targets);
    expect(scoreGuidance(evidence, { forbidden: [{ target: "typescript" }] })[0]).toStartWith("Cannot rule out a read of forbidden guidance typescript");
  });
});
