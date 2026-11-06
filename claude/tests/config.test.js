// Offline checks of the Claude Code configuration kept in this repository. They read
// only tracked files, so they run in CI; tests/live.test.js covers the installed setup.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configuredEffort } from "./lib/live.js";

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

  test("worker runs at the main session's configured Opus effort, so a parallel track loses none", () => {
    expect(POLICY.worker.effort).toBe(configuredEffort("claude-opus-5-5"));
  });

  test("implementing agents own their whole track and stay within their assigned files", () => {
    for (const name of ["worker", "solver"]) {
      const { body } = frontmatter(`claude/agents/${name}.md`);
      expect(body).toMatch(/You own this (track|problem) end to end/);
      expect(body).toMatch(/change only the files in your assignment/i);
    }
    expect(frontmatter("claude/agents/worker.md").body).toMatch(/investigate what it needs, design within the interfaces you were given, and implement it, keeping its tests in step when your assignment includes them/);
  });
});

describe("global instructions", () => {
  test("every agent the Delegation section names exists, and every agent is named", () => {
    const named = [...section("Delegation").matchAll(/ to `([\w-]+)`/g)].map((match) => match[1]);
    expect(named.sort()).toEqual(Object.keys(POLICY).sort());
  });

  test("every ~/.claude file they reference is tracked in this repository", () => {
    const references = [...globalInstructions.matchAll(/~\/\.claude\/([\w./-]+)/g)].map((match) => match[1]);
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

  test("headless-browser screenshots go to the session scratchpad when there is one", () => {
    expect(read("claude/skills/headless-browser/SKILL.md")).toContain("`--dir <scratchpad>/headless-browser`");
    expect(read("claude/skills/headless-browser/scripts/browse.ts")).toMatch(/case 'dir': opts\.dir = resolve\(next\(\)\)/);
  });

  // No live scenario covers continuing an agent: it needs a defect to surface after a
  // track returns, which a fixture cannot trigger reliably.
  test("Delegation sends a parallel correction back to the agent that has the context", () => {
    expect(section("Delegation")).toMatch(/continue the agent that did the track when it and its checkout still exist, otherwise start a new task with the original brief and findings/);
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

  // Opus 5.5 has a 1M window and otherwise compacts only near 967K, so long threads re-read
  // 300K-970K of context on every turn; 56% of two weeks' usage came from requests above 200K.
  test("conversations compact at 300K tokens, not near the 1M window", () => {
    expect(settings.autoCompactWindow).toBe(300000);
  });

  // This applies to every Claude Code worktree (--worktree, EnterWorktree and subagent
  // isolation), so all of them carry the current branch and its unpushed commits.
  test("worktrees branch from the local HEAD, not the remote default branch", () => {
    expect(settings.worktree).toEqual({ baseRef: "head" });
  });

  // The claude.ai Gmail connector is the Claude counterpart of Codex's Gmail plugin; it
  // signs in only on claude.ai, so it loads only through claude.ai connectors.
  test("claude.ai connectors load, so the Gmail connector is available", () => {
    expect(settings.disableClaudeAiConnectors).toBeUndefined();
  });

  test.each(["guard-git-push.js", "guard-runtimes.js"])("the %s guard is registered for Bash PreToolUse", (script) => {
    const guard = settings.hooks.PreToolUse.filter((group) =>
      new RegExp(group.matcher).test("Bash")
      && group.hooks.some((hook) => hook.type === "command" && hook.command.includes(`hooks/${script}`)));
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

describe("rejected frontend defaults list", () => {
  test("is tracked and keeps its rule for using and adding patterns", () => {
    expect(tracked("claude/frontend-avoid.md")).toBe(true);
    const list = read("claude/frontend-avoid.md");
    expect(list).toMatch(/do not use them unless the brief, a reference, or the existing project calls for them/);
    expect(list).toMatch(/explicitly rejects a pattern as an unwanted default, not for feedback on a single design/);
    expect(list).toMatch(/one per line/);
  });

  // The skill feedback pipeline proposes additions as "- <pattern>" lines in this section.
  test("ends with a Patterns section of one-line entries", () => {
    const parts = read("claude/frontend-avoid.md").split(/^## Patterns\n/m);
    expect(parts).toHaveLength(2);
    expect(parts[1]).not.toMatch(/^## /m);
    for (const line of parts[1].split("\n").filter((text) => text.trim())) expect(line).toMatch(/^- \S/);
  });
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
  });

  // The installed frontend-ui skill tells Claude Code and Codex to read the list, and the
  // list states its own rule, so the global instructions don't repeat either; the live
  // chart scenario checks that the read still happens.
  test("the rejected frontend defaults list is left to the frontend-ui skill", () => {
    expect(globalInstructions).not.toContain("frontend-avoid");
  });

  test("Working preferences keep uv and bun with project lockfiles", () => {
    const preferences = section("Working preferences");
    expect(preferences).toMatch(/`uv run`/);
    expect(preferences).toMatch(/`bun`/);
    expect(preferences).toContain("never `node`, including for fallbacks");
    expect(preferences).toMatch(/lockfiles/);
  });

  test("Delegation is a standing request limited to parallel tracks", () => {
    const delegation = section("Delegation");
    expect(delegation).toMatch(/standing request to use subagents, so don't wait for me to ask/);
    expect(delegation).toMatch(/Delegate only when running work in parallel pays off/);
    expect(delegation).toMatch(/each needing little of this conversation's context or of the others'/);
    expect(delegation).toMatch(/one agent per track/);
    expect(delegation).toMatch(/Unless I ask for one, don't hand a single track to an agent and then just wait for it/);
    expect(delegation).toMatch(/takes only a handful of tool calls/);
    expect(delegation).toMatch(/Don't use subagents to verify your own work/);
    expect(delegation).toMatch(/Agents that stand in for a tool you lack, such as `web-fetch`, are tool use, not delegation/);
    expect(section("Review")).toMatch(/delegating only fixes that split into parallel tracks/);
  });

  // Anthropic's multi-agent guidance: split by context, not by type of work, because
  // each handoff between phases of the same work loses context.
  test("Delegation splits by context, and each agent owns its whole track", () => {
    const delegation = section("Delegation");
    expect(delegation).toMatch(/Split work by context, not by type of work/);
    expect(delegation).toMatch(/each agent owns its whole track, from investigation through implementation and tests/);
    expect(delegation).toMatch(/one area's work never passes from one agent to another, such as an explorer's findings to a worker/);
    expect(delegation).toMatch(/Choose each track's agent by what the whole track does/);
    expect(delegation).toMatch(/file edits and other state-changing work to `worker`/);
    expect(delegation).toMatch(/hard debugging or reasoning, including its fix, to `solver`/);
    expect(delegation).toMatch(/Settle only the interfaces tracks share/);
    expect(delegation).toMatch(/those interfaces, what it needs from this conversation/);
    expect(delegation).not.toMatch(/decided design/);
    expect(delegation).toMatch(/Keep planning across tracks, judgment, communication, and completion verification yourself/);
  });

  test("Review fixes every real defect it finds and reports the rest", () => {
    const review = section("Review");
    expect(review).toMatch(/on the final diff before pushing or reporting done/);
    expect(review).toMatch(/Check each finding against the code before deciding/);
    expect(review).toMatch(/Fix every one that is a real defect in what the change is meant to do and verify the fix/);
    expect(review).toMatch(/rerun the affected checks instead of reviewing again/);
    expect(review).toMatch(/Report the rest, as with unrelated issues, instead of fixing them/);
  });

  // A review run in the main thread is cut off when a message arrives mid-review; in the
  // background the thread stays free and the review finishes.
  test("Review runs in one background agent, pinned to the commit, while this thread keeps answering", () => {
    const review = section("Review");
    expect(review).toMatch(/Run that review in one background agent on this session's model, such as `general-purpose` \(not `explorer`\), so this thread stays free to answer me/);
    expect(review).toMatch(/its own worktree holding exactly the final diff/);
    expect(review).toMatch(/for a commit, have it run `\/code-review` pinned to its SHA, such as `\/code-review xhigh origin\/main\.\.\.<SHA>`/);
    // A new worktree lacks uncommitted changes, and committing needs my say-so.
    expect(review).toMatch(/for uncommitted work, transfer the diff as for any track/);
    expect(review).toMatch(/return the findings unchanged/);
    expect(review).toMatch(/answer my messages and continue work that leaves that diff alone, but don't push or report done until its findings are handled/);
    // The review covers the final diff, so a change to it, mine or the session's, restarts it.
    expect(review).toMatch(/cancel and restart it whenever the diff under review changes/);
  });

  test("Delegation isolates work in runtime worktrees and transfers their inputs", () => {
    const delegation = section("Delegation");
    expect(delegation).toMatch(/Give each track that edits files its own worktree through the runtime's worktree facility when one is available, never one made in the shell/);
    expect(delegation).toMatch(/Other tracks share this checkout; never let two tracks, or a track and you, change the same files or state at the same time/);
    expect(delegation).toMatch(/A new worktree never has uncommitted changes/);
    expect(delegation).toMatch(/transfer required inputs explicitly and have the child verify them in its checkout/);
    expect(delegation).toMatch(/bring its changes into this checkout and remove the worktree and its branch, unless I say otherwise/);
  });

  test("Workflow keeps the Chinese meaning rule and its exceptions", () => {
    const workflow = section("Workflow");
    expect(workflow).toMatch(/followed by its Chinese meaning/);
    expect(workflow).toMatch(/explicit output-only or structured-format requirement/);
    expect(workflow).toMatch(/Do not duplicate Chinese-only replies/);
    expect(workflow).toMatch(/`headless-browser` skill/);
  });
});
