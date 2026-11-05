// Offline checks of the Claude Code configuration kept in this repository. They read
// only tracked files, so they run in CI; tests/live.test.js covers the installed setup.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CLAUDE = join(import.meta.dir, "..");
const REPO = join(CLAUDE, "..");
const read = (path) => readFileSync(join(REPO, path), "utf8");
const globalInstructions = read("claude/CLAUDE.md");

function tracked(path) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: REPO, encoding: "utf8" });
  if (result.error) throw result.error;
  return result.status === 0;
}

function frontmatter(path) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(path));
  if (!match) throw new Error(`${path} has no frontmatter`);
  return { meta: Bun.YAML.parse(match[1]), body: match[2] };
}

// Text of one `## Heading` section of the global instructions.
function section(heading) {
  const match = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(globalInstructions);
  if (!match) throw new Error(`claude/CLAUDE.md has no "${heading}" section`);
  return match[1];
}

const POLICY = {
  explorer: { model: "haiku", effort: "xhigh", disallowedTools: ["Write", "Edit", "NotebookEdit", "Agent"] },
  // The main session's configured Opus effort, so a parallel track loses no effort.
  worker: { model: "opus", effort: "high", disallowedTools: ["Agent"] },
  solver: { model: "opus", effort: "xhigh", disallowedTools: ["Agent"] },
};
const agentFiles = readdirSync(join(CLAUDE, "agents")).filter((name) => name.endsWith(".md"));

describe("agents", () => {
  test("the agents directory holds exactly the policy's agents, all tracked", () => {
    expect(agentFiles.map((name) => name.slice(0, -3)).sort()).toEqual(Object.keys(POLICY).sort());
    for (const name of agentFiles) expect(tracked(`claude/agents/${name}`)).toBe(true);
  });

  test.each(Object.entries(POLICY))("%s frontmatter matches the policy", (name, policy) => {
    const { meta, body } = frontmatter(`claude/agents/${name}.md`);
    expect(Object.keys(meta).sort()).toEqual(["description", "disallowedTools", "effort", "model", "name"]);
    expect(meta.name).toBe(name);
    expect(meta.model).toBe(policy.model);
    expect(meta.effort).toBe(policy.effort);
    expect(meta.disallowedTools.split(",").map((tool) => tool.trim())).toEqual(policy.disallowedTools);
    expect(meta.description.length).toBeGreaterThan(20);
    expect(body.trim().length).toBeGreaterThan(30);
  });

  test("explorer's instructions keep it read-only", () => {
    expect(frontmatter("claude/agents/explorer.md").body).toMatch(/do not edit files/);
  });

  test("every agent is described as one independent track run in parallel", () => {
    for (const name of agentFiles)
      expect(frontmatter(`claude/agents/${name}`).meta.description).toMatch(/\bindependent\b.*\bin parallel with other work\b/);
  });

  test("implementing agents stay within their assigned files", () => {
    for (const name of ["worker", "solver"])
      expect(frontmatter(`claude/agents/${name}.md`).body).toMatch(/change only the files in your assignment/i);
  });
});

describe("global instructions", () => {
  test("every agent the Delegation section names exists, and every agent is named", () => {
    const named = [...section("Delegation").matchAll(/ to `([\w-]+)`/g)].map((match) => match[1]);
    expect(named.sort()).toEqual(Object.keys(POLICY).sort());
  });

  test("every ~/.claude file they reference is tracked in this repository", () => {
    const references = [...globalInstructions.matchAll(/~\/\.claude\/([\w./-]+)/g)].map((match) => match[1]);
    expect(references).toContain("frontend-avoid.md");
    for (const path of references) expect(tracked(`claude/${path}`), `claude/${path}`).toBe(true);
  });

  test("they keep the high-consequence and mode safeguards", () => {
    for (const concept of [
      /fast mode/,
      /`ultra` code review/,
      /secrets/,
      /credentials/,
      /force-with-lease/,
      /default branch/,
      /production/,
      /external writes/,
      /read-only/,
      /`\/code-review` is the only review process/,
      /at `xhigh` on the final diff/,
    ])
      expect(globalInstructions).toMatch(concept);
  });

  test("the repository's own skill has matching frontmatter", () => {
    const { meta } = frontmatter("claude/skills/headless-browser/SKILL.md");
    expect(meta.name).toBe("headless-browser");
    expect(meta.description.length).toBeGreaterThan(20);
  });
});

describe("settings", () => {
  const settings = JSON.parse(read("claude/settings.json"));
  const handlers = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));

  test("every hook command under ~/.claude runs a tracked script", () => {
    const scripts = handlers.flatMap((hook) =>
      [...hook.command.matchAll(/\$HOME\/\.claude\/([\w./-]+)/g)].map((match) => match[1]));
    expect(scripts).toContain("hooks/guard-git-push.js");
    for (const path of scripts) expect(tracked(`claude/${path}`), `claude/${path}`).toBe(true);
  });

  test("the guard is registered for Bash PreToolUse", () => {
    const guard = settings.hooks.PreToolUse.filter((group) =>
      new RegExp(group.matcher).test("Bash")
      && group.hooks.some((hook) => hook.type === "command" && hook.command.includes("hooks/guard-git-push.js")));
    expect(guard).toHaveLength(1);
  });
});

test("the root CLAUDE.md holds the repository instructions directly", () => {
  expect(lstatSync(join(REPO, "CLAUDE.md")).isFile()).toBe(true);
  const instructions = read("CLAUDE.md");
  expect(instructions).not.toMatch(/^\s*@/m);
  expect(instructions).toMatch(/clean up temporary test files/);
  expect(instructions).toMatch(/^- Keep the test suite in step with every change/m);
});

// The live suites test these rules; a rule changing or disappearing means the matching
// live scenario needs updating too.
describe("rules the live suites test", () => {
  test("Skills routes each language and UI skill", () => {
    const skills = section("Skills");
    for (const name of ["frontend-ui", "typescript", "rust", "tauri"]) expect(skills).toContain(`\`${name}\``);
    expect(skills).toMatch(/load `frontend-ui` first/);
    expect(skills).toMatch(/unrelated work in a TypeScript or Rust repository needs neither language skill/i);
    expect(skills).toMatch(/data-visualization skill/);
    expect(skills).toContain("~/.claude/frontend-avoid.md");
  });

  test("Working preferences keep uv and bun with project lockfiles", () => {
    const preferences = section("Working preferences");
    expect(preferences).toMatch(/`uv run`/);
    expect(preferences).toMatch(/`bun`/);
    expect(preferences).toMatch(/lockfiles/);
  });

  test("Delegation is a standing request limited to parallel tracks", () => {
    const delegation = section("Delegation");
    expect(delegation).toMatch(/standing request to use subagents, so don't wait for me to ask/);
    expect(delegation).toMatch(/Delegate only when running work in parallel pays off/);
    expect(delegation).toMatch(/one agent per track/);
    expect(delegation).toMatch(/takes only a handful of tool calls/);
    expect(delegation).toMatch(/Don't use subagents to verify your own work/);
    expect(delegation).toMatch(/Choose each track's agent by what it does/);
    expect(section("Review")).toMatch(/delegating only fixes that split into parallel tracks/);
  });

  test("Delegation isolates work in runtime worktrees and transfers their inputs", () => {
    const delegation = section("Delegation");
    expect(delegation).toMatch(/the runtime's worktree facility, never a worktree made in the shell/);
    expect(delegation).toMatch(/default branch rather than `HEAD` and never has uncommitted changes/);
    expect(delegation).toMatch(/transfer required inputs explicitly and have the child verify them in its checkout/);
  });

  test("Workflow keeps the Chinese meaning rule and its exceptions", () => {
    const workflow = section("Workflow");
    expect(workflow).toMatch(/followed by its Chinese meaning/);
    expect(workflow).toMatch(/explicit output-only or structured-format requirement/);
    expect(workflow).toMatch(/Do not duplicate Chinese-only replies/);
    expect(workflow).toMatch(/`headless-browser` skill/);
  });
});
