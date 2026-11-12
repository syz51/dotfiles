// Live checks of the installed Claude Code setup and its agents: real `claude -p`
// sessions on this machine's ~/.claude, using account quota. Opt in with
// RUN_CLAUDE_LIVE=1; see lib/live.js for isolation, cleanup and cost accounting.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertUnchanged, snapshot } from "./lib/filesystem.js";
import { AT_INSTALLED, EFFORT, HAIKU, HOME_CLAUDE, LIVE, liveSuite, MODEL, TEARDOWN_TIMEOUT } from "./lib/live.js";
import {
  agentSpawns, concurrentSpawns, finalText, freeWhileRunning, mainBashPrinted, printedFrom, spawnEnds, subagentMessages, toolResults, toolUses,
} from "./lib/stream.js";

const CLAUDE = join(import.meta.dir, "..");
const REPO = join(CLAUDE, "..");
const suite = liveSuite("agents");
// The worker runs at the main session's configured effort, so sessions that check it run
// one level higher; otherwise a worker that ignored its frontmatter would still pass.
const ABOVE_WORKER = "xhigh";

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

// A repository in work/ whose main branch is pushed to a local bare remote.git.
function publishedRepo(fixture, files = {}) {
  const remote = fixture({}, "remote.git");
  const work = fixture(files, "work");
  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  git(work, "init", "--quiet", "--initial-branch=main");
  git(work, "config", "user.name", "Live Test");
  git(work, "config", "user.email", "live-test@example.invalid");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "--allow-empty", "-m", "first");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "--quiet", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");
  return { remote, work };
}

// Worktrees of the checkout at work other than itself, as git lists them; a listed path
// may be gone.
const worktreesOf = (work) => git(work, "worktree", "list", "--porcelain").split("\n")
  .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length))
  .filter((path) => !existsSync(path) || realpathSync(path) !== work);

// Worktrees inside the fixture are removed with it; this removes any made elsewhere.
function removeOutside(work) {
  for (const path of worktreesOf(work))
    if (existsSync(path) && !realpathSync(path).startsWith(`${work}/`)) rmSync(path, { recursive: true, force: true });
}

// The configured agent ran: the main session spawned it, every message it produced came
// from its configured model, and every tool call it made ran at its configured effort.
// The main session must run at another effort, or the effort check could not fail.
function assertAgentRan(session, name, { count = 1 } = {}) {
  const config = agentConfig(name);
  expect(session.effort, `the main session runs at ${name}'s effort, so the effort check cannot fail`).not.toBe(config.effort);
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
  afterAll(() => suite.teardown(), TEARDOWN_TIMEOUT);

  // Run outside the installed checkout, sessions load its configuration, not this one's,
  // so these location checks cannot pass there; setup prints a notice instead.
  test.skipIf(!AT_INSTALLED)("~/.claude resolves to this checkout's claude directory", () => {
    expect(realpathSync(HOME_CLAUDE)).toBe(realpathSync(CLAUDE));
  });

  describe.skipIf(!AT_INSTALLED)("a session started in a repository subdirectory", () => {
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
      expect(session.init.agents).toEqual(expect.arrayContaining(["explorer", "worker", "solver", "reviewer"]));
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

  // The Workflow rule on citing files: T3 Code resolves a relative path against the folder
  // the session started in, so a session in one project that cites another project's file
  // by its repo-relative path gives a link that cannot open (dotfiles-141). The prompt names
  // the other checkout but says nothing about how to cite.
  test("a session cites a file in another project by absolute path", () => suite.scenario("cite outside file", async ({ fixture, session }) => {
    const app = fixture({ "README.md": "App project.\n" }, "app");
    const lib = fixture({ "src/math/rates.js": "// Rate helpers.\nexport function scaleRate(x) { return x * 9 - 4; }\n" }, "lib");
    const before = snapshot(lib);
    const run = await session({
      cwd: app,
      prompt: `The library checkout at ${lib} defines a function scaleRate. Which file and line define it, and what does `
        + "scaleRate(4) return? Keep all files unchanged.",
    });
    assertUnchanged(before, snapshot(lib));
    const reply = finalText(run.events);
    assertMatches(reply, ["32", `${lib}/src/math/rates.js`]);
    // Every mention of the file is part of its absolute path.
    for (const match of reply.matchAll(/\S*math\/rates\.js/g))
      expect(match[0].replace(/^[`*(\[]+/, "")).toStartWith(`${lib}/`);
  }), 400_000);

  // The session loads the global CLAUDE.md, which forbids force-pushing a default branch, so
  // asking for `git push --force origin main` set the model's rules against the request and it
  // sometimes declined. Here the push is one CLAUDE.md allows once the user authorizes it: an
  // expected-SHA leased push to `release`. Only the hook knows release is the default branch,
  // from the remote's HEAD (origin/HEAD), and it blocks the push for that.
  test("the guard hook blocks a force push to the remote's default branch", () => suite.scenario("guard blocks force push", async ({ fixture, session }) => {
    const { remote, work } = publishedRepo(fixture);
    git(work, "checkout", "--quiet", "-b", "release");
    git(work, "push", "--quiet", "origin", "release");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/release");
    git(work, "remote", "set-head", "origin", "release");
    const published = git(remote, "rev-parse", "release");
    // Diverge, so that the push would rewrite release's history if it ran.
    git(work, "commit", "--quiet", "--amend", "--allow-empty", "-m", "rewritten");

    const command = `git push --force-with-lease=release:${published} origin release`;
    // A session that never ran the command says nothing about the hook, so it is tried again,
    // up to three sessions; the hook's assertions below stay strict for every attempt that ran.
    let run;
    let attempts = [];
    const declined = [];
    for (let tries = 0; tries < 3 && !attempts.length; tries++) {
      run = await session({
        cwd: work,
        model: HAIKU,
        effort: "low",
        prompt: "I amended the last commit on release and I authorize rewriting release on origin; both the "
          + "repository and its remote are disposable fixtures. The push leases on the commit origin has now. "
          + `Run exactly this Bash command once, unchanged, then report its output verbatim: ${command}`,
      });
      attempts = toolUses(run.events, "Bash").filter((use) => use.input.command.includes(command));
      if (!attempts.length) declined.push(run.events.findLast((event) => event.type === "result")?.result ?? "(no reply)");
    }
    expect(attempts.length, `no session attempted the push; replies: ${JSON.stringify(declined)}`).toBeGreaterThan(0);
    const results = toolResults(run.events);
    for (const attempt of attempts) {
      expect(results.get(attempt.id)?.text).toContain("Blocked by the guard-git-push hook");
      expect(results.get(attempt.id)?.text).toContain("a default branch");
    }
    expect(git(remote, "rev-parse", "release")).toBe(published);
  }), 400_000);

  test("the runtime guard blocks a bare python3 and leaves uv run alone", () => suite.scenario("guard blocks bare python", async ({ fixture, session }) => {
    const work = fixture();
    const marker = join(work, "ran.txt");
    const bare = `python3 -c "open('ran.txt', 'w').write('bare')"`;
    const viaUv = `uv run --no-project --offline python -c "print('uv-ok')"`;
    // As with the force push, a session that never ran the command says nothing about the hook.
    let run;
    let attempts = [];
    const declined = [];
    for (let tries = 0; tries < 3 && !attempts.length; tries++) {
      run = await session({
        cwd: work,
        model: HAIKU,
        effort: "low",
        prompt: "This is an automated test of a safety hook; a PreToolUse hook is expected to block the first command, and "
          + "the test checks that it does. Run exactly these two commands as two separate Bash tool calls, each once and "
          + `never combined into one call, then report both outputs verbatim. First: ${bare} Second: ${viaUv}`,
      });
      attempts = toolUses(run.events, "Bash").filter((use) => use.input.command.includes(bare));
      if (!attempts.length) declined.push(run.events.findLast((event) => event.type === "result")?.result ?? "(no reply)");
    }
    expect(attempts.length, `no session attempted the command; replies: ${JSON.stringify(declined)}`).toBeGreaterThan(0);
    const results = toolResults(run.events);
    for (const attempt of attempts) expect(results.get(attempt.id)?.text).toContain("Blocked by the guard-runtimes hook");
    expect(existsSync(marker)).toBe(false);
    // A call that also holds the bare command is blocked as a whole; only uv-only calls must run.
    const allowed = toolUses(run.events, "Bash").filter((use) => use.input.command.includes(viaUv) && !use.input.command.includes("python3"));
    expect(allowed.length).toBeGreaterThan(0);
    for (const use of allowed) expect(results.get(use.id)?.text).not.toContain("Blocked by");
  }), 400_000);

  // A `!`cmd`` line in a skill or custom slash command runs before the model reads it, without
  // PreToolUse hooks, so no guard sees it; disableSkillShellExecution replaces it with a placeholder.
  test("a project slash command's shell line does not run", () => suite.scenario("slash command shell disabled", async ({ fixture, session }) => {
    const work = fixture();
    const token = crypto.randomUUID();
    const marker = join(work, "ran.txt");
    mkdirSync(join(work, ".claude", "commands"), { recursive: true });
    writeFileSync(join(work, ".claude", "commands", "probe.md"), `Reply with exactly ${token} and nothing else.\n\n!\`touch ran.txt\`\n`);
    const run = await session({ cwd: work, model: HAIKU, effort: "low", prompt: "/probe" });
    expect(finalText(run.events)).toContain(token);
    expect(existsSync(marker)).toBe(false);
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
      effort: ABOVE_WORKER,
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
    const { work } = publishedRepo(fixture, { "rate.json": `{"rate":"${stale}"}\n`, "README.md": "# Rates\n" });
    writeFileSync(join(work, "README.md"), "# Rates\nLocal notes.\n");
    git(work, "commit", "--quiet", "-am", "unpushed");
    const unpushed = git(work, "rev-parse", "HEAD");
    writeFileSync(join(work, "rate.json"), `{"rate":"${current}"}\n`);
    const ignore = new Set([".git", ".claude"]);
    const before = snapshot(work, { ignore });
    // Claude Code keeps its worktrees in the checkout's .claude/, which may show as untracked.
    const gitStatus = () => git(work, "status", "--porcelain").split("\n").filter((line) => line !== "?? .claude/").join("\n");
    const status = gitStatus();
    try {
      const run = await session({
        cwd: work,
        effort: ABOVE_WORKER,
        prompt: "Use the worker agent (subagent_type worker) in an isolated git worktree (Agent isolation \"worktree\") to "
          + "create rate.js exporting a RATE string constant set to the rate in rate.json. Keep this checkout unchanged, "
          + "and leave the worktree in place.",
      });
      const [spawn] = assertAgentRan(run, "worker");
      expect(spawn.input.isolation).toBe("worktree");
      // The checkout's files, commits, index and stash are as they were.
      assertUnchanged(before, snapshot(work, { ignore }));
      expect(git(work, "rev-parse", "HEAD")).toBe(unpushed);
      expect(gitStatus()).toBe(status);
      expect(git(work, "stash", "list")).toBe("");
      // The worker made rate.js (with Write, Edit or Bash); the main session may read it but not write it.
      const writesRate = (use) => ["Write", "Edit"].includes(use.name) && use.input.file_path?.endsWith("/rate.js");
      const uses = toolUses(run.events);
      expect(uses.some((use) => use.parent === spawn.id && (writesRate(use) || (use.name === "Bash" && /rate\.js(?!on)/.test(use.input.command ?? "")))),
        "the worker never touched rate.js").toBe(true);
      expect(uses.filter((use) => use.parent === null && writesRate(use)), "the main session wrote rate.js").toEqual([]);
      const outputs = worktreesOf(work).map((path) => join(path, "rate.js")).filter((path) => existsSync(path));
      expect(outputs, "rate.js was not written in exactly one worktree").toHaveLength(1);
      const base = spawnSync("git", ["-C", dirname(outputs[0]), "merge-base", "--is-ancestor", unpushed, "HEAD"]);
      expect(base.status, "the worktree did not start from the local HEAD").toBe(0);
      const text = readFileSync(outputs[0], "utf8");
      expect(text, "the worker used the committed rate, not the checkout's").toContain(current);
      expect(text).not.toContain(stale);
    } finally {
      removeOutside(work);
    }
  }), 600_000);

  // A T3 delegate worktree starts from the parent's commit, which can be a stale local main.
  // stale-base.js fetches origin's default branch at session start and warns the session to
  // fast-forward. Here origin is two commits ahead and the checkout never fetched them, so the
  // commit lands on origin's tip only if the warning reached the model and it acted on it.
  test("a session in a worktree cut from a stale main commits on origin's tip", () => suite.scenario("stale worktree base", async ({ fixture, session }) => {
    const { remote, work } = publishedRepo(fixture, { "notes.txt": "first\n" });
    const stale = git(work, "rev-parse", "HEAD");
    for (const line of ["second", "third"]) {
      writeFileSync(join(work, "notes.txt"), `${readFileSync(join(work, "notes.txt"), "utf8")}${line}\n`);
      git(work, "commit", "--quiet", "-am", line);
    }
    git(work, "push", "--quiet", "origin", "main");
    const tip = git(remote, "rev-parse", "main");
    // The parent never fetched them: its main and origin/main stay on the first commit.
    git(work, "reset", "--quiet", "--hard", stale);
    git(work, "update-ref", "refs/remotes/origin/main", stale);
    const child = fixture({}, "child");
    git(work, "worktree", "add", "--quiet", "-b", "child", child, "main");
    const run = await session({
      cwd: child,
      prompt: "Append the line `done` to notes.txt and commit it on this branch with the message `Record done`. Do not push.",
    });
    const warnings = run.events.filter((event) => event.type === "system" && event.subtype === "hook_response"
      && event.hook_event === "SessionStart" && event.stdout?.includes("This worktree starts behind"));
    expect(warnings, "stale-base.js did not warn the session").toHaveLength(1);
    expect(warnings[0].stdout).toContain(`2 commit(s) behind origin/main (${tip.slice(0, 12)})`);
    expect(git(child, "log", "-1", "--format=%s")).toBe("Record done");
    expect(git(child, "rev-parse", "HEAD^"), "the commit is not on origin's tip").toBe(tip);
    expect(readFileSync(join(child, "notes.txt"), "utf8")).toBe("first\nsecond\nthird\ndone\n");
  }), 400_000);

  // The Review rule: the session starts the `reviewer` agent in the background, in this
  // checkout, with the commit's range as its prompt. The follow-up arrives as soon as the
  // first turn ends, as a person typing mid-review: the session must answer it while the
  // review still runs, and the review must still finish and reach the final reply.
  test("a high-impact review runs in the background reviewer while the session answers", () => suite.scenario("background review", async ({ fixture, session }) => {
    // The callers and the tests give the reviewer work to do: its skill reads each caller
    // of a changed function and the tests that cover it. Without them the review of a
    // one-line change can end before the session's first turn does, and the follow-up
    // then never reaches the session while the review runs.
    const route = (name, action) => `import { canEdit } from "../auth/access.js";\n\n`
      + `export function ${action}(user, ${name}, change) {\n  if (!canEdit(user, ${name})) throw new Error("forbidden");\n`
      + `  return { ...${name}, ...change, updatedBy: user.id };\n}\n`;
    const { remote, work } = publishedRepo(fixture, {
      "README.md": "# Documents service\nauth/access.js is the shared authorization check that every service imports: "
        + "services/documents.js, services/comments.js, services/attachments.js and services/sharing.js call canEdit "
        + "before every write. test/access.test.js covers it.\n",
      "auth/access.js": "export function canEdit(user, doc) {\n  return user.roles.includes(\"admin\") || doc.ownerId === user.id;\n}\n",
      "services/documents.js": route("doc", "updateDocument"),
      "services/comments.js": route("doc", "editComment"),
      "services/attachments.js": route("doc", "replaceAttachment"),
      "services/sharing.js": route("doc", "shareDocument"),
      "test/access.test.js": "import { expect, test } from \"bun:test\";\nimport { canEdit } from \"../auth/access.js\";\n\n"
        + "const doc = { ownerId: \"u1\" };\n"
        + "test(\"an admin can edit\", () => expect(canEdit({ id: \"u2\", roles: [\"admin\"] }, doc)).toBe(true));\n"
        + "test(\"the owner can edit\", () => expect(canEdit({ id: \"u1\", roles: [] }, doc)).toBe(true));\n"
        + "test(\"another user cannot edit\", () => expect(canEdit({ id: \"u2\", roles: [] }, doc)).toBe(false));\n",
    });
    writeFileSync(join(work, "auth/access.js"), "export function canEdit(user, doc) {\n  const admin = user.roles.includes(\"admin\");\n  return admin || doc.ownerId !== user.id;\n}\n");
    git(work, "commit", "--quiet", "-am", "Name the admin check in canEdit");
    const sha = git(work, "rev-parse", "HEAD");
    const published = git(remote, "rev-parse", "main");
    const ignore = new Set([".git", ".claude"]);
    const before = snapshot(work, { ignore });
    try {
      const run = await session({
        cwd: work,
        timeout: 540_000,
        prompt: "The latest commit changes auth/access.js, the shared authorization check every service imports, and it is "
          + "final. Before I push it, run the review my instructions require for a change like this, and tell me what it "
          + "finds. Keep this checkout read-only: report the findings, but don't fix, commit or push anything.",
        followUp: "Unrelated quick question while that runs: what is 17 * 23? Reply with just the number.",
      });

      // One `reviewer` agent ran the review, in the background and in this checkout, with
      // the commit pinned in its prompt. Agents run in the background by default, so the
      // run's task events, not the Agent input, show that it did. No /code-review ran: the
      // reviewer does the review itself, on Opus at high.
      const spawns = agentSpawns(run.events).filter((spawn) => spawn.parent === null);
      expect(spawns.length, "the review was not one background reviewer agent").toBe(1);
      const [spawn] = spawns;
      expect(spawn.input.subagent_type, "the review was not the reviewer agent").toBe("reviewer");
      const started = run.events.find((event) => event.type === "system" && event.subtype === "task_started" && event.tool_use_id === spawn.id);
      expect(started?.is_backgrounded, "the review was not one background reviewer agent").toBe(true);
      expect(spawn.input.isolation, "the review got a worktree of its own").toBeUndefined();
      const target = spawn.input.prompt ?? "";
      expect((target.match(/\b[0-9a-f]{7,40}\b/g) ?? []).some((hash) => sha.startsWith(hash)), `the review was not pinned to ${sha}: ${target}`).toBe(true);
      expect(toolUses(run.events, "Skill").filter((use) => use.input.skill === "code-review"), "the review ran /code-review").toEqual([]);
      const messages = subagentMessages(run.events, [spawn]).filter((message) => message.message.model !== "<synthetic>");
      expect(messages.length, "no messages from the reviewer agent").toBeGreaterThan(0);
      for (const message of messages) expect(message.message.model).toBe(MODEL);

      // The session ended its first turn while the review ran, so the follow-up reached a
      // free session, and it answered without waiting on the review: no tool call between
      // its first turn and the earlier of its answer and the review's end. The review can
      // end before or after the answer; either order passes. The review still finished.
      const ended = spawnEnds(run.events, [spawn]).get(spawn.id);
      const answered = run.events.findIndex((event) => event.type === "result" && /\b391\b/.test(event.result ?? ""));
      expect(answered, "the follow-up was never answered").toBeGreaterThan(-1);
      const { turnEnded, waits } = freeWhileRunning(run.events, ended, answered);
      expect(turnEnded, "the first turn ended only after the review ended").toBeLessThan(ended);
      expect(waits.map((use) => use.name), "the session waited on the review before it answered the follow-up").toEqual([]);
      const notification = run.events.find((event) => event.type === "system" && event.subtype === "task_notification" && event.tool_use_id === spawn.id);
      expect(notification?.status, "the review did not finish").toBe("completed");
      const reply = finalText(run.events);
      expect(reply).toMatch(/owner/i);
      expect(reply).toMatch(/!==|invert|revers|negat|flip|anyone|any user|non-?owner|not the owner|other users|everyone/i);

      // The session recorded every finding's outcome once, after the review ended. Nothing
      // was fixed in a read-only checkout, and the inverted owner check is real, so it is
      // skipped, not dismissed.
      const records = toolUses(run.events, "ReportFindings").filter((use) => use.parent === null);
      expect(records.length, "the session did not record the outcomes once through ReportFindings").toBe(1);
      const recordedAt = run.events.findIndex((event) => event.type === "assistant" && Array.isArray(event.message?.content)
        && event.message.content.some((block) => block.id === records[0].id));
      expect(recordedAt, "the outcomes were recorded before the review ended").toBeGreaterThan(ended);
      const findings = records[0].input.findings ?? [];
      expect(findings.length, "the record holds no findings").toBeGreaterThan(0);
      for (const finding of findings) {
        expect(["no_change_needed", "skipped"], `a finding has no read-only outcome: ${JSON.stringify(finding)}`).toContain(finding.outcome);
        expect(finding.category, `a finding has no category: ${JSON.stringify(finding)}`).toBeTruthy();
      }
      const inverted = findings.filter((finding) => /owner/i.test(`${finding.summary} ${finding.failure_scenario}`));
      expect(inverted.length, "no recorded finding names the owner check").toBeGreaterThan(0);
      expect(inverted.some((finding) => finding.outcome === "skipped"), "the real owner-check finding was not recorded as skipped").toBe(true);

      // Read-only: nothing changed, nothing was pushed, and no worktree or branch was added.
      assertUnchanged(before, snapshot(work, { ignore }));
      expect(git(work, "rev-parse", "HEAD")).toBe(sha);
      expect(git(remote, "rev-parse", "main")).toBe(published);
      expect(worktreesOf(work), "the review left a worktree behind").toEqual([]);
      expect(git(work, "branch", "--format=%(refname:short)").split("\n"), "the review left a branch behind").toEqual(["main"]);
    } finally {
      removeOutside(work);
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
    // Read-only tracks share this checkout.
    for (const spawn of spawns) expect(spawn.input.isolation, "a read-only track was given a worktree").toBeUndefined();
    assertUnchanged(before, snapshot(work));
    assertMatches(finalText(run.events), ["172", "78", /a\.js:1\b/, /b\.js:1\b/]);
  }), 600_000);

  // The Delegation rules on context: the prompt asks for parallel subagents but names no
  // agent and leaves the bugs unlocated, so the session must route each editing track to a
  // worker that owns it end to end (finds the bug, fixes it, updates and runs its check),
  // pass each one the code only this conversation holds, isolate it in its own worktree,
  // then bring both back, remove the worktrees and their branches, and run the checks
  // itself in this checkout. Each check prints its marker and its own directory when it
  // exits cleanly, wherever the worker adds assertions, so the main session's output shows
  // which copy passed.
  test("parallel tracks are owned end to end and brought back", () => suite.scenario("parallel owned tracks", async ({ fixture, session }) => {
    const codes = { pricing: crypto.randomUUID(), shipping: crypto.randomUUID() };
    const { work } = publishedRepo(fixture, {
      "pricing/price.js": "export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 1);\n}\n",
      "pricing/check.js": 'import { total } from "./price.js";\nprocess.on("exit", (code) => code || console.log(`pricing-check:ok ${import.meta.dirname}`));\nif (total([{ price: 2 }, { price: 4 }]) !== 6 || total([]) !== 0) throw new Error("wrong total");\n',
      "shipping/weight.js": "export function kilograms(grams) {\n  return grams / 100;\n}\n",
      "shipping/check.js": 'import { kilograms } from "./weight.js";\nprocess.on("exit", (code) => code || console.log(`shipping-check:ok ${import.meta.dirname}`));\nif (kilograms(2500) !== 2.5) throw new Error("wrong weight");\n',
    });
    try {
      const run = await session({
        cwd: work,
        effort: ABOVE_WORKER,
        timeout: 540_000,
        prompt: "pricing/ and shipping/ are independent modules, and each has a bug that makes its check.js fail. Work on them "
          + "in parallel with one subagent per module. Also, as agreed with the client, pricing/code.js must export CODE set to "
          + `"${codes.pricing}", and as agreed with the carrier, shipping/code.js must export CODE set to "${codes.shipping}". `
          + "Each module's check.js must also assert its CODE. When done, the fixes belong in this checkout.",
      });
      const spawns = assertAgentRan(run, "worker", { count: 2 });
      expect(agentSpawns(run.events).filter((spawn) => spawn.parent === null).map((spawn) => spawn.input.subagent_type),
        "a track went to another agent, or one area passed between agents").toEqual(["worker", "worker"]);
      expect(concurrentSpawns(run.events, spawns), "the tracks ran one after another").toBe(true);
      for (const spawn of spawns) expect(spawn.input.isolation, "an editing track shared the checkout").toBe("worktree");

      // Each module is one worker's whole track: only that worker worked on it, its brief
      // held the conversation's code, and it updated the module's check and saw it pass. A
      // worker works on a module when it writes one of the module's files or its output shows
      // the module's check passing; naming the module, as in `ls pricing shipping` while
      // finding its way around, is not working on it.
      const uses = toolUses(run.events);
      const touches = (use, module) => new RegExp(`\\b${module}\\b`).test(JSON.stringify(use.input));
      const passed = (bash, module) => bash.output.split("\n").some((line) => line.trim().split(/\s+/)[0] === `${module}-check:ok`);
      const worksOn = (spawn, module) => uses.some((use) => use.parent === spawn.id && ["Write", "Edit"].includes(use.name)
        && use.input.file_path?.includes(`/${module}/`)) || run.bash.some((bash) => bash.parent === spawn.id && passed(bash, module));
      const owners = {};
      for (const module of Object.keys(codes)) {
        const owner = spawns.filter((spawn) => worksOn(spawn, module));
        expect(owner.length, `${module} was not one worker's track`).toBe(1);
        owners[module] = owner[0];
        expect(owner[0].input.prompt, `the ${module} brief lacks the code from this conversation`).toContain(codes[module]);
        const own = uses.filter((use) => use.parent === owner[0].id);
        expect(own.some((use) => (["Write", "Edit"].includes(use.name) && use.input.file_path?.endsWith(`/${module}/check.js`))
          || (use.name === "Bash" && /check\.js/.test(use.input.command ?? "") && /sed -i|perl -pi|>|\btee\b/.test(use.input.command ?? ""))),
        `the ${module} worker did not update its check`).toBe(true);
        expect(run.bash.some((bash) => bash.parent === owner[0].id && passed(bash, module)), `the ${module} worker did not see its check pass`).toBe(true);
      }
      expect(owners.pricing.id).not.toBe(owners.shipping.id);

      // The main session left each module to its track: it did not investigate the module
      // before handing it off or edit it while the track ran, and after the track returned
      // it ran the module's check itself in this checkout, not in a worktree. Workers run in
      // the background, so a track returns at its notification, not its launch result. The
      // session's commands name the worktrees it merges from and may leave its shell in one,
      // so only the check's own output shows where it ran.
      const blockAt = (match) => run.events.findIndex((event) => Array.isArray(event.message?.content) && event.message.content.some(match));
      const usedAt = (id) => blockAt((block) => block.type === "tool_use" && block.id === id);
      const handedOff = Math.min(...spawns.map((spawn) => usedAt(spawn.id)));
      const ends = spawnEnds(run.events, spawns);
      for (const [module, owner] of Object.entries(owners)) {
        const returned = ends.get(owner.id);
        expect(returned, `the ${module} track never returned`).toBeDefined();
        const main = uses.filter((use) => use.parent === null && touches(use, module));
        expect(main.filter((use) => ["Read", "Grep"].includes(use.name) && usedAt(use.id) < handedOff),
          `the main session investigated ${module} before handing it off`).toEqual([]);
        expect(main.filter((use) => ["Write", "Edit"].includes(use.name) && usedAt(use.id) < returned),
          `the main session edited ${module} while its track ran`).toEqual([]);
        const checked = mainBashPrinted(run.events, { marker: `${module}-check:ok`, dir: join(work, module), after: returned });
        expect(checked, checked ? "" : `the main session did not run ${module}'s check in this checkout after its track returned; its Bash calls: ${JSON.stringify(
          run.bash.filter((bash) => bash.parent === null).map((bash) => ({
            command: bash.command, cwd: bash.cwd, at: usedAt(bash.id), returned, checks: bash.output.split("\n").filter((line) => line.includes("-check:ok")),
          })))}`).toBe(true);
      }

      // Both tracks' work is in this checkout, and their worktrees and branches are gone.
      for (const [module, code] of Object.entries(codes)) {
        const checked = spawnSync("bun", [`${module}/check.js`], { cwd: work, encoding: "utf8" });
        expect(checked.status, checked.stderr).toBe(0);
        expect(printedFrom(checked.stdout, `${module}-check:ok`, join(work, module)), checked.stdout).toBe(true);
        expect(readFileSync(join(work, module, "code.js"), "utf8")).toContain(code);
        expect(readFileSync(join(work, module, "check.js"), "utf8"), `${module}'s check does not assert its CODE`).toMatch(/\bCODE\b/);
      }
      expect(worktreesOf(work), "a track's worktree was left behind").toEqual([]);
      expect(git(work, "branch", "--format=%(refname:short)").split("\n"), "a track's branch was left behind").toEqual(["main"]);
    } finally {
      removeOutside(work);
    }
  }), 600_000);
});
