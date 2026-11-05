// Live checks of the installed Claude Code setup and its agents: real `claude -p`
// sessions on this machine's ~/.claude, using account quota. Opt in with
// RUN_CLAUDE_LIVE=1; see lib/live.js for isolation, cleanup and cost accounting.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertUnchanged, snapshot } from "./lib/filesystem.js";
import { EFFORT, HAIKU, HOME_CLAUDE, LIVE, liveSuite, MODEL } from "./lib/live.js";
import { agentSpawns, concurrentSpawns, finalText, subagentMessages, toolResults, toolUses } from "./lib/stream.js";

const CLAUDE = join(import.meta.dir, "..");
const REPO = join(CLAUDE, "..");
const suite = liveSuite("agents");

// model alias and effort from an agent's frontmatter; a model alias such as "haiku"
// resolves to a claude-haiku-* model.
function agentConfig(name) {
  const meta = Bun.YAML.parse(/^---\n([\s\S]*?)\n---/.exec(readFileSync(join(CLAUDE, "agents", `${name}.md`), "utf8"))[1]);
  return { modelPrefix: `claude-${meta.model}-`, effort: meta.effort };
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function assertMatches(text, patterns) {
  for (const pattern of patterns)
    if (typeof pattern === "string") expect(text).toContain(pattern);
    else expect(text).toMatch(pattern);
}

// The configured agent ran: the main session spawned it, every message it produced came
// from its configured model, and every tool call it made ran at its configured effort.
function assertAgentRan(session, name, { count = 1 } = {}) {
  const config = agentConfig(name);
  const spawns = agentSpawns(session.events, name).filter((spawn) => spawn.parent === null);
  expect(spawns.length, `the session did not spawn ${name}`).toBeGreaterThanOrEqual(count);
  const messages = subagentMessages(session.events, spawns);
  expect(messages.length, `no messages from ${name}`).toBeGreaterThan(0);
  for (const message of messages) expect(message.message.model).toStartWith(config.modelPrefix);
  const calls = session.preToolUse.filter((record) => record.agent_type === name);
  expect(calls.length, `${name} made no tool calls`).toBeGreaterThan(0);
  for (const call of calls) expect(call.effort).toEqual({ level: config.effort });
  return spawns;
}

describe.skipIf(!LIVE)("live Claude Code", () => {
  beforeAll(() => suite.setup());
  afterAll(() => suite.teardown());

  test("~/.claude resolves to this checkout's claude directory", () => {
    expect(realpathSync(HOME_CLAUDE)).toBe(realpathSync(CLAUDE));
  });

  describe("a session started in a repository subdirectory", () => {
    let session;

    beforeAll(async () => {
      session = await suite.session({
        label: "instructions in nvim/", cwd: join(REPO, "nvim"), prompt: "Reply with the single word OK.", model: HAIKU, effort: "low",
      });
    }, 300_000);

    test("loads the global and the repository instructions", () => {
      const files = Object.fromEntries(session.instructions.map((record) => [record.memory_type, realpathSync(record.file_path)]));
      expect(files).toEqual({ User: realpathSync(join(CLAUDE, "CLAUDE.md")), Project: realpathSync(join(REPO, "CLAUDE.md")) });
    });

    test("offers the configured agents and installed skills", () => {
      expect(session.init.model).toBe(HAIKU);
      expect(session.init.agents).toEqual(expect.arrayContaining(["explorer", "worker", "solver"]));
      const installed = readdirSync(join(CLAUDE, "skills"), { withFileTypes: true })
        .filter((entry) => existsSync(join(CLAUDE, "skills", entry.name, "SKILL.md")))
        .map((entry) => entry.name);
      expect(installed).toEqual(expect.arrayContaining([
        "content-research-writer", "find-skills", "frontend-ui", "headless-browser", "rust", "tauri", "typescript"]));
      expect(session.init.skills).toEqual(expect.arrayContaining(installed));
      expect(session.result.subtype).toBe("success");
    });
  });

  // The main session runs on a non-haiku model so that haiku messages can only come
  // from the explorer.
  test("a spawned explorer runs on its configured model and effort", () => suite.scenario("explorer model and effort", async ({ fixture, session }) => {
    expect(MODEL, "the main session must not run on haiku, or the model check cannot fail").not.toContain("haiku");
    const work = fixture();
    const token = crypto.randomUUID();
    writeFileSync(join(work, "data.txt"), `token=${token}\n`);
    const run = await session({
      cwd: work,
      prompt: "Use the explorer agent (subagent_type explorer) to read data.txt in the current directory, "
        + "then report the token it contains. Do not read the file yourself.",
    });
    assertAgentRan(run, "explorer");
    const main = run.events.filter((event) => event.type === "assistant" && event.parent_tool_use_id === null);
    for (const message of main) expect(message.message.model).toBe(MODEL);
    for (const call of run.preToolUse.filter((record) => !record.agent_type)) expect(call.effort).toEqual({ level: EFFORT });
    expect(finalText(run.events)).toContain(token);
  }), 400_000);

  test("the guard hook blocks a force push to main", () => suite.scenario("guard blocks force push", async ({ fixture, session }) => {
    const remote = fixture({}, "remote.git");
    const work = fixture({}, "work");
    git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
    git(work, "init", "--quiet", "--initial-branch=main");
    git(work, "config", "user.name", "Live Test");
    git(work, "config", "user.email", "live-test@example.invalid");
    git(work, "commit", "--quiet", "--allow-empty", "-m", "first");
    git(work, "remote", "add", "origin", remote);
    git(work, "push", "--quiet", "origin", "main");
    const published = git(remote, "rev-parse", "main");
    // Diverge, so that the push would rewrite main's history if it ran.
    git(work, "commit", "--quiet", "--amend", "--allow-empty", "-m", "rewritten");

    const command = "git push --force origin main";
    const run = await session({
      cwd: work,
      model: HAIKU,
      effort: "low",
      prompt: "This is a test of a safety hook in a throwaway repository whose remote is a temporary local bare "
        + `repository. Run exactly this Bash command once, then report its output verbatim: ${command}`,
    });
    const attempts = toolUses(run.events, "Bash").filter((use) => use.input.command.includes(command));
    expect(attempts.length, "the session did not attempt the push").toBeGreaterThan(0);
    const results = toolResults(run.events);
    for (const attempt of attempts) expect(results.get(attempt.id)?.text).toContain("Blocked by the guard-git-push hook");
    expect(git(remote, "rev-parse", "main")).toBe(published);
  }), 400_000);

  // Contract probes: the prompt names the agent, and the test checks that the configured
  // agent really ran, on its model and effort, within its file boundary.
  const archive = {
    "README.md": "# Synthetic research archive\nCurrent direction: decisions/current.md\nHistory: research-log.md\nTopic: topics/evidence.md\n",
    "research-log.md": "# History\n2026-09-01: Proposed Japanese answer generation.\n2026-10-12: Replaced that proposal; see decisions/current.md.\n",
    "decisions/current.md": "# Current decision\nAs of 2026-10-12, query language is English.\nThe deliverable is source-linked evidence retrieval.\nJapanese answer generation is deferred, not adopted.\n",
    "topics/evidence.md": "# Evidence topic\nEvidence coverage is the primary evaluation target.\nAnswer fluency is not an evaluation target.\n",
    "references.md": "# References\nREF-001: Synthetic project charter; retained historical reference.\n",
    "verified-facts.md": "# Verified synthetic facts\nOBS-028: On 2026-10-28 the coverage audit checked 18 queries; 15 have complete source-linked evidence and 3 need additional evidence.\nPROP-029: A reranking experiment is proposed, not adopted or evaluated.\nREF-002: Synthetic audit sheet, 2026-10-28, supports OBS-028.\nThe current research direction is unchanged.\n",
  };
  const updates = {
    "topics/evidence.md": [/OBS-028/, /18/, /15/, /\b3\b/, /PROP-029/, /propos/i, /not(?:\s+(?:been|yet))?\s+adopted/i, /verified-facts\.md:[2-5]\b/, /decisions\/current\.md/],
    "research-log.md": [/2026-10-28/, /OBS-028/, /PROP-029/, /propos/i, /unchanged/i, /verified-facts\.md:[2-5]\b/],
    "references.md": [/REF-002/, /Synthetic audit sheet/i, /2026-10-28/, /OBS-028/, /verified-facts\.md:4\b/],
  };

  test("a worker makes an authorized archive update and changes nothing else", () => suite.scenario("worker archive update", async ({ fixture, session }) => {
    const work = fixture(archive);
    const before = snapshot(work);
    const run = await session({
      cwd: work,
      prompt: "Use the worker agent (subagent_type worker) for this edit. Update this synthetic research archive using the "
        + "explicitly supplied verified facts in verified-facts.md. Append a dated audit section to topics/evidence.md, append a "
        + "research-log.md entry, and append REF-002 to references.md. Only these three paths are authorized for edits; preserve "
        + "their existing text, reference IDs, and history exactly. In the topic section record OBS-028's 18 checked queries, 15 "
        + "complete evidence sets, and 3 incomplete ones; distinguish observed results from PROP-029's proposed reranking "
        + "experiment, which is not adopted or evaluated. In the log distinguish observation and proposal and state that the "
        + "current direction is unchanged. In references record the supplied audit sheet, date, and supported observation ID. "
        + "Include file:line citations to verified-facts.md in each addition, and connect the topic addition to "
        + "decisions/current.md without changing that decision. Keep all other files unchanged. Report each updated path.",
    });
    assertAgentRan(run, "worker");
    assertUnchanged(before, snapshot(work), Object.keys(updates));
    for (const [path, patterns] of Object.entries(updates)) {
      const text = readFileSync(join(work, path), "utf8");
      expect(text.startsWith(archive[path]), `${path} must keep its existing text`).toBe(true);
      assertMatches(text.slice(archive[path].length), patterns);
    }
    assertMatches(finalText(run.events), [/topics\/evidence\.md/, /research-log\.md/, /references\.md/]);
  }), 600_000);

  test("a solver analyzes a race read-only", () => suite.scenario("solver race analysis", async ({ fixture, session }) => {
    const work = fixture({
      "reserve.js": "export async function reserve(stock, n) { const count = await stock.read(); if (count < n) return false; await stock.write(count - n); return true; }\n",
      "invariant.md": "Initial stock is 1. Two concurrent calls each reserve 1 unit. Successful reservations must never exceed initial stock. A read and a write are individually atomic, but the whole function is not.\n",
    });
    const before = snapshot(work);
    const run = await session({
      cwd: work,
      prompt: "Use the solver agent (subagent_type solver) to analyze reserve.js against invariant.md. Give a minimal two-call "
        + "interleaving, each return value and final stored count, and a correction that enforces the invariant. This is "
        + "analysis only; keep files unchanged.",
    });
    assertAgentRan(run, "solver");
    assertUnchanged(before, snapshot(work));
    assertMatches(finalText(run.events), [/both|two/i, /\b0\b/, /atomic|compare.and.swap|transaction|lock|mutex/i]);
  }), 600_000);

  // The Delegation rule on worktrees: a new worktree misses the main checkout's
  // uncommitted edit, so the worker gets the right value only if the session transfers it.
  // With worktree.baseRef "head" the worktree starts from the local HEAD, so it also
  // carries a commit that was never pushed.
  test("a worktree-isolated worker gets the uncommitted input it needs", () => suite.scenario("worktree worker input", async ({ fixture, session }) => {
    const [stale, current] = [crypto.randomUUID(), crypto.randomUUID()];
    const remote = fixture({}, "remote.git");
    const work = fixture({ "rate.json": `{"rate":"${stale}"}\n`, "README.md": "# Rates\n" }, "work");
    git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
    git(work, "init", "--quiet", "--initial-branch=main");
    git(work, "config", "user.name", "Live Test");
    git(work, "config", "user.email", "live-test@example.invalid");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "first");
    git(work, "remote", "add", "origin", remote);
    git(work, "push", "--quiet", "origin", "main");
    git(work, "remote", "set-head", "origin", "main");
    writeFileSync(join(work, "README.md"), "# Rates\nLocal notes.\n");
    git(work, "commit", "--quiet", "-am", "unpushed");
    const unpushed = git(work, "rev-parse", "HEAD");
    writeFileSync(join(work, "rate.json"), `{"rate":"${current}"}\n`);
    const ignore = new Set([".git", ".claude"]);
    const before = snapshot(work, { ignore });
    const others = () => git(work, "worktree", "list", "--porcelain").split("\n")
      .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length))
      .filter((path) => realpathSync(path) !== work);
    try {
      const run = await session({
        cwd: work,
        prompt: "Use the worker agent (subagent_type worker) in an isolated git worktree (Agent isolation \"worktree\") to "
          + "create rate.js exporting a RATE string constant set to the rate in rate.json. Keep this checkout unchanged.",
      });
      const [spawn] = assertAgentRan(run, "worker");
      expect(spawn.input.isolation).toBe("worktree");
      assertUnchanged(before, snapshot(work, { ignore }));
      const outputs = others().map((path) => join(path, "rate.js")).filter((path) => existsSync(path));
      expect(outputs, "rate.js was not written in exactly one worktree").toHaveLength(1);
      const base = spawnSync("git", ["-C", dirname(outputs[0]), "merge-base", "--is-ancestor", unpushed, "HEAD"]);
      expect(base.status, "the worktree did not start from the local HEAD").toBe(0);
      const text = readFileSync(outputs[0], "utf8");
      expect(text, "the worker used the committed rate, not the checkout's").toContain(current);
      expect(text).not.toContain(stale);
    } finally {
      for (const path of others()) git(work, "worktree", "remove", "--force", "--force", path);
    }
  }), 600_000);

  test("two explorers investigate independent modules in parallel", () => suite.scenario("parallel explorers", async ({ fixture, session }) => {
    const work = fixture({
      "a.js": "export function computeA(x) { return x * 7 + 11; }\n",
      "b.js": "export function computeB(x) { return x * x - 3; }\n",
    });
    const before = snapshot(work);
    const run = await session({
      cwd: work,
      prompt: "Investigate these independent modules in parallel with two explorer agents (subagent_type explorer), one per "
        + "module, started together: explain computeA(23) from a.js and computeB(9) from b.js. Cite file:line evidence and "
        + "summarize both exact results. Keep all files unchanged.",
    });
    const spawns = assertAgentRan(run, "explorer", { count: 2 });
    expect(concurrentSpawns(run.events, spawns), "the explorers ran one after another").toBe(true);
    assertUnchanged(before, snapshot(work));
    assertMatches(finalText(run.events), ["172", "78", /a\.js:1\b/, /b\.js:1\b/]);
  }), 600_000);
});
