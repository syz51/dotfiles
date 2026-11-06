import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendJsonl, readJsonl } from "../lib/state.js";
import { RUBRIC } from "./rubric.js";
import { allowedPath, alreadyProposed, failureGroups, leakedEvidence, readDenies, run } from "./propose.js";

const FAKE = join(import.meta.dir, "..", "lib", "testing", "fake-claude.js");
let scratch;
let output;
const saved = {};
const setEnv = (values) => {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const put = (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};

// A source checkout whose origin is a local bare repository standing in for GitHub.
function repository() {
  const remote = join(scratch, "remote.git");
  const source = join(scratch, "source");
  git(scratch, "init", "--quiet", "--bare", "-b", "main", remote);
  mkdirSync(source);
  git(source, "init", "--quiet", "-b", "main");
  put(source, {
    ".gitignore": ".env.*\n",
    "claude/CLAUDE.md": "# Rules\n\n## Workflow\n\n- Stay in scope.\n\n## Delegation\n\n- Delegate rarely.\n",
    "claude/agents/worker.md": "# Worker\n\nDo the task.\n",
    "claude/settings.json": "{}\n",
    "claude/tests/ok.test.js": 'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n',
    // Pins rule text, as claude/tests/config.test.js does.
    "claude/tests/config.test.js": 'import { expect, test } from "bun:test";\nimport { readFileSync } from "node:fs";\ntest("delegation rule", () => expect(readFileSync("claude/CLAUDE.md", "utf8")).toContain("Delegate rarely."));\n',
  });
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "init");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "--quiet", "origin", "main");
  // Work happens on a branch named factory, on both sides, as in the real checkout: a
  // proposal branch under factory/ would clash with it.
  git(source, "checkout", "--quiet", "-b", "factory");
  git(source, "push", "--quiet", "origin", "factory");
  // An unpushed local commit, which proposals must not build on.
  put(source, { "local-only.txt": "x" });
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "local");
  return { remote, source };
}

const record = (sessionId, { dimension = "scope-creep", verdict = "fail", evidence = `[T3] edited unrelated file in ${sessionId}`, ...extra } = {}) => ({
  sessionId,
  transcriptSha: "a".repeat(64),
  rubricVersion: RUBRIC.version,
  scoredAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  project: "-Users-test-project",
  model: "claude-sonnet-5-5",
  effort: "medium",
  detectors: { "package-runner": { verdict: "pass", hits: [] } },
  dimensions: { [dimension]: { verdict, evidence } },
  corrections: [],
  error: null,
  ...extra,
});

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claude-factory-propose-"));
  const gitConfig = join(scratch, "gitconfig");
  writeFileSync(gitConfig, "");
  const gh = join(scratch, "fake-gh.js");
  // The fake gh fails for a --head branch containing FAKE_GH_FAIL.
  writeFileSync(gh, `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");\nif (process.env.FAKE_GH_FAIL && args[args.indexOf("--head") + 1].includes(process.env.FAKE_GH_FAIL)) { console.error("HTTP 502"); process.exit(1); }\nconsole.log("https://github.com/o/r/pull/42");\n`);
  chmodSync(gh, 0o755);
  // The proposer: writes FAKE_EDITS ({ path: content }) into its working folder, then
  // ends with FAKE_RESULT (a result event) when set, else a success.
  const proposer = join(scratch, "proposer.js");
  writeFileSync(proposer, `import { mkdirSync, writeFileSync } from "node:fs";\nimport { dirname, join } from "node:path";\nexport default async ({ cwd, emit }) => {\n  for (const [path, content] of Object.entries(JSON.parse(process.env.FAKE_EDITS ?? "{}"))) {\n    mkdirSync(dirname(join(cwd, path)), { recursive: true });\n    writeFileSync(join(cwd, path), content);\n  }\n  emit({ type: "system", subtype: "init", tools: JSON.parse(process.env.FAKE_TOOLS ?? JSON.stringify(["Read", "Edit", "Write", "Glob", "Grep"])), mcp_servers: [] });\n  emit(process.env.FAKE_RESULT ? JSON.parse(process.env.FAKE_RESULT) : { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.7, num_turns: 3, result: "The scope rule was vague.\\nTITLE: Clarify the scope rule" });\n};\n`);
  setEnv({
    CLAUDE_FACTORY_STATE: join(scratch, "state"),
    CLAUDE_FACTORY_BIN: FAKE,
    CLAUDE_FACTORY_GH: gh,
    FAKE_CLAUDE_MODE: "script",
    FAKE_CLAUDE_SCRIPT: proposer,
    FAKE_CLAUDE_LOG: join(scratch, "claude.jsonl"),
    FAKE_GH_LOG: join(scratch, "gh.jsonl"),
    FAKE_EDITS: undefined,
    FAKE_TOOLS: undefined,
    FAKE_RESULT: undefined,
    FAKE_GH_FAIL: undefined,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
  output = [];
  spyOn(console, "log").mockImplementation((...args) => output.push(args.join(" ")));
  spyOn(console, "error").mockImplementation((...args) => output.push(args.join(" ")));
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  console.log.mockRestore();
  console.error.mockRestore();
  rmSync(scratch, { recursive: true, force: true });
});

const scores = (records) => {
  for (const entry of records) appendJsonl(join(scratch, "state", "scores.jsonl"), entry);
};
const proposals = () => readJsonl(join(scratch, "state", "proposals.jsonl"));
const log = (name) => (existsSync(join(scratch, name)) ? readJsonl(join(scratch, name)) : []);
const remoteBranches = (remote) => git(remote, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);
const edits = (files) => setEnv({ FAKE_EDITS: JSON.stringify(files) });
// Runs at a fixed second, so branch names are known: factory-proposal/<id>-<UTC stamp>.
const NOW = Date.parse("2026-11-05T09:08:07Z");
const branchName = "factory-proposal/scope-creep-20261105-090807";
const CLEARER = "# Rules\n\n## Workflow\n\n- Stay in the requested scope; report unrelated issues.\n\n## Delegation\n\n- Delegate rarely.\n";

describe("proposal rules", () => {
  test("only the global instructions and agent definitions may change: text, never code", () => {
    for (const path of ["claude/CLAUDE.md", "claude/agents/worker.md"]) expect(allowedPath(path), path).toBe(true);
    for (const path of ["claude/tests/config.test.js", "claude/tests/lib/new.js", "claude/settings.json", "claude/hooks/guard-git-push.js", "claude/agents/x/y.md", "claude/agents/worker.json", "CLAUDE.md", "claude/tests/../settings.json", "claude/factory/scoring/rubric.json", ".env.test"])
      expect(allowedPath(path), path).toBe(false);
  });

  test("the proposer may not read private sources: a folder gets its absolute rule, and its ~/ rule under home", () => {
    const denies = readDenies(["/home/me/.local/share/claude-factory", "/srv/state", "/home/me/.claude/projects"], "/home/me");
    expect(denies).toEqual(expect.arrayContaining(["Read(~/.ssh/**)", "Read(~/.claude/projects/**)", "Read(~/.codex/**)",
      "Read(//home/me/.local/share/claude-factory/**)", "Read(~/.local/share/claude-factory/**)", "Read(//srv/state/**)", "Read(//home/me/.claude/projects/**)"]));
    expect(denies.filter((rule) => rule === "Read(~/.claude/projects/**)")).toHaveLength(1);
    expect(denies.some((rule) => rule.startsWith("Read(~/") && rule.includes("srv"))).toBe(false);
  });

  test("a leak is a verbatim run of 40 characters of evidence that the repository did not already hold", () => {
    const evidence = ["[T3] ran a deploy against the staging cluster without asking first"];
    expect(leakedEvidence("- Never run a deploy against the staging cluster without asking first.", evidence)).toBe(true);
    // Whitespace differences do not hide a run.
    expect(leakedEvidence("- Never run a deploy against the staging\n  cluster without asking.", evidence)).toBe(true);
    expect(leakedEvidence("- Ask before deploying anywhere.", evidence)).toBe(false);
    // Evidence that quotes the existing rule text leaks nothing when the rule is kept.
    const rule = "Ask before any action that changes shared state.";
    expect(leakedEvidence(`- ${rule} This covers deploys.`, [`[A2] ignored "${rule}"`], { publicText: [rule] })).toBe(false);
  });

  test("groups distinct failing sessions per dimension from each session's latest records", () => {
    const old = { ...record("s1"), scoredAt: "2026-01-01T00:00:00.000Z" };
    const fixed = { ...record("s1", { verdict: "pass" }), scoredAt: "2026-01-02T00:00:00.000Z", endedAt: "2026-01-02T00:00:00.000Z" };
    const detectorOnly = { ...record("s3"), dimensions: null, model: null, detectors: { "force-push": { verdict: "fail", hits: [{ evidence: "git push -f" }] } } };
    const errored = { ...record("s4"), dimensions: null, error: "invalid" };
    const otherVersion = { ...record("s5"), rubricVersion: RUBRIC.version + 1 };
    const groups = Object.fromEntries(failureGroups([old, fixed, record("s2"), detectorOnly, errored, otherVersion], { since: 0 }).map((group) => [group.dimension.id, group]));
    expect(groups["scope-creep"].failures.map((failure) => failure.sessionId)).toEqual(["s2"]);
    expect(groups["force-push"].failures).toEqual([{ sessionId: "s3", project: "-Users-test-project", evidence: ["git push -f"] }]);
    expect([...groups["scope-creep"].judges]).toEqual(["claude-sonnet-5-5 (medium)"]);
    expect(failureGroups([record("s2")], { since: Date.now() + 1000 }).every((group) => !group.failures.length)).toBe(true);
  });

  test("a recent real proposal sharing a session blocks the dimension; a dry run or an error does not", () => {
    const now = Date.now();
    const at = new Date(now - 86_400_000).toISOString();
    const proposalsMade = [
      { dimension: "scope-creep", status: "proposed", createdAt: at, sessions: ["s1", "s2"] },
      { dimension: "delegation-fit", status: "dry-run", createdAt: at, sessions: ["s1"] },
      { dimension: "delegation-fit", status: "error", createdAt: at, sessions: ["s1"] },
    ];
    expect(alreadyProposed(proposalsMade, "scope-creep", ["s2", "s9"], now)).toBeTruthy();
    expect(alreadyProposed(proposalsMade, "scope-creep", ["s9"], now)).toBeUndefined();
    expect(alreadyProposed(proposalsMade, "delegation-fit", ["s1"], now)).toBeUndefined();
    expect(alreadyProposed(proposalsMade, "scope-creep", ["s1"], now + 40 * 86_400_000)).toBeUndefined();
  });

  test("a proposer that ran out of budget blocks a retry; one that failed otherwise does not", () => {
    const now = Date.now();
    const at = new Date(now - 86_400_000).toISOString();
    const failed = (resultSubtype) => [{ dimension: "scope-creep", status: "proposer-failed", resultSubtype, createdAt: at, sessions: ["s1"] }];
    expect(alreadyProposed(failed("error_max_budget_usd"), "scope-creep", ["s1"], now)).toBeTruthy();
    expect(alreadyProposed(failed("error_during_execution"), "scope-creep", ["s1"], now)).toBeUndefined();
    expect(alreadyProposed(failed(null), "scope-creep", ["s1"], now)).toBeUndefined();
  });
});

describe("propose command", () => {
  test("pushes a branch from the remote's main and opens a draft PR without the proposer's words or the evidence", async () => {
    const { remote, source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    edits({ "claude/CLAUDE.md": CLEARER, "claude/agents/worker.md": "# Worker\n\nDo only the task.\n" });
    expect(await run(["--repo", source], { now: NOW })).toBe(0);

    const [proposer] = log("claude.jsonl");
    expect(proposer.args).toEqual(expect.arrayContaining(["--tools", "Read,Edit,Write,Glob,Grep", "--permission-mode", "acceptEdits", "--model", "claude-opus-5-5", "--effort", "high", "--max-budget-usd", "3"]));
    // Reads of credentials, raw transcripts and the state folder are denied, whatever the
    // user's settings allow; an absolute path is written //path.
    const settings = JSON.parse(proposer.args[proposer.args.indexOf("--settings") + 1]);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(~/.gnupg/**)", "Read(~/.config/gh/**)", "Read(~/.netrc)", "Read(~/.claude.json)", "Read(~/.docker/config.json)",
      "Read(~/.claude/projects/**)", "Read(~/.codex/**)", `Read(/${join(scratch, "state")}/**)`]));
    expect(proposer.stdin).toContain("- Stay in scope.");
    expect(proposer.stdin).toContain("[T3] edited unrelated file in s2");
    expect(proposer.stdin).toContain("Prefer clarifying, replacing or deleting");
    expect(proposer.stdin).toContain("Edit only claude/CLAUDE.md and claude/agents/*.md");
    expect(existsSync(proposer.cwd)).toBe(false);

    expect(remoteBranches(remote).sort()).toEqual([branchName, "factory", "main"].sort());
    expect(git(remote, "show", `${branchName}:claude/CLAUDE.md`)).toContain("report unrelated issues");
    expect(git(remote, "log", "-1", "--format=%s", branchName)).toBe("Clarify the scope rule");
    expect(() => git(remote, "show", `${branchName}:local-only.txt`)).toThrow();

    const [pr] = log("gh.jsonl");
    expect(pr.args.slice(0, 7)).toEqual(["pr", "create", "--draft", "--base", "main", "--head", branchName]);
    const body = pr.args[pr.args.indexOf("--body") + 1];
    for (const text of ["`scope-creep`", "3 scored sessions", "- `s1`", "- `s3`", "Judge: claude-sonnet-5-5 (medium)", "Tests: `bun test claude/tests`: 2 pass"]) expect(body).toContain(text);
    expect(body).not.toMatch(/Generated with|Co-Authored-By|\u{1F916}/u);
    // The proposer's reply and the evidence quote private transcripts: they stay local.
    expect(body).not.toContain("The scope rule was vague.");
    expect(body).not.toContain("edited unrelated file");
    expect(body).not.toContain("-Users-test-project");
    expect(body).not.toContain("TITLE:");

    const [entry] = proposals();
    expect(entry).toMatchObject({ dimension: "scope-creep", status: "proposed", sessions: ["s1", "s2", "s3"], prUrl: "https://github.com/o/r/pull/42", branch: branchName, pushed: true, costUSD: 0.7, paths: ["claude/CLAUDE.md", "claude/agents/worker.md"] });
    expect(readFileSync(entry.patchFile, "utf8")).toContain("+- Stay in the requested scope");
    const evidence = readFileSync(entry.evidenceFile, "utf8");
    expect(evidence).toContain("- s2 (-Users-test-project)\n  - [T3] edited unrelated file in s2");
    expect(evidence).toContain("The scope rule was vague.");
    expect(body).toContain(`\`proposals/${entry.evidenceFile.split("/").at(-1)}\``);

    // The same sessions do not get a second proposal.
    expect(await run(["--repo", source], { now: NOW + 60_000 })).toBe(0);
    expect(log("claude.jsonl")).toHaveLength(1);
    expect(output.join("\n")).toMatch(/scope-creep\s+3 failing sessions\s+already proposed/);
  });

  test("rejects a proposer session that had more than the file tools", async () => {
    const { remote, source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    edits({ "claude/CLAUDE.md": "changed\n" });
    setEnv({ FAKE_TOOLS: JSON.stringify(["Read", "Edit", "Bash"]) });
    expect(await run(["--repo", source], { now: NOW })).toBe(1);
    expect(proposals()[0]).toMatchObject({ status: "rejected-tools", tools: ["Read", "Edit", "Bash"] });
    expect(remoteBranches(remote).sort()).toEqual(["factory", "main"]);
    expect(log("gh.jsonl")).toHaveLength(0);
  });

  test.each([
    ["a settings file", { "claude/settings.json": '{"permissions":{"allow":["Bash"]}}\n' }, ["claude/settings.json"]],
    ["a test, which the suite would run as code", { "claude/tests/scope.test.js": 'import { test } from "bun:test";\ntest("x", () => {});\n' }, ["claude/tests/scope.test.js"]],
    ["an ignored file, such as one Bun loads into the test run's environment", { ".env.test": "X=1\n" }, [".env.test"]],
    ["a git hook, which the commit would run", { ".git/hooks/pre-commit": "#!/bin/sh\nexit 0\n" }, [".git"]],
  ])("rejects a change to %s without running the tests or pushing", async (_, extra, rejected) => {
    const { remote, source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    edits({ "claude/CLAUDE.md": CLEARER, ...extra });
    expect(await run(["--repo", source], { now: NOW })).toBe(1);
    const [entry] = proposals();
    expect(entry).toMatchObject({ status: "rejected-paths", rejected, tests: null });
    expect(remoteBranches(remote).sort()).toEqual(["factory", "main"]);
    expect(log("gh.jsonl")).toHaveLength(0);
  });

  test("an edit that breaks a test pinning rule text is recorded as failing tests, kept locally and not pushed", async () => {
    const { remote, source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    edits({ "claude/CLAUDE.md": "# Rules\n\n## Workflow\n\n- Stay in scope.\n\n## Delegation\n\n- Delegate when it pays off.\n" });
    expect(await run(["--repo", source], { now: NOW })).toBe(1);
    const [entry] = proposals();
    expect(entry.status).toBe("tests-failed");
    expect(entry.tests).toMatchObject({ ok: false, command: "bun test claude/tests" });
    expect(entry.tests.summary).toContain("1 fail");
    expect(entry.tests.tail).toContain("delegation rule");
    expect(readFileSync(entry.patchFile, "utf8")).toContain("+- Delegate when it pays off.");
    expect(remoteBranches(remote).sort()).toEqual(["factory", "main"]);
    expect(log("gh.jsonl")).toHaveLength(0);
  });

  test("rejects a change that repeats the private evidence without pushing", async () => {
    const { remote, source } = repository();
    const quote = "ran rm -rf build in the payments checkout without asking";
    scores(["s1", "s2", "s3"].map((id) => record(id, { evidence: `[T4] ${quote}` })));
    edits({ "claude/CLAUDE.md": `${CLEARER}- Never do what this agent did: it ${quote}.\n` });
    expect(await run(["--repo", source], { now: NOW })).toBe(1);
    expect(proposals()[0]).toMatchObject({ status: "leak-suspected", tests: null, prUrl: null });
    expect(existsSync(proposals()[0].patchFile)).toBe(true);
    expect(remoteBranches(remote).sort()).toEqual(["factory", "main"]);
    expect(log("gh.jsonl")).toHaveLength(0);
  });

  test("a failure after the push is recorded with the branch, the next dimension still runs, and a later run retries on a new branch", async () => {
    const { remote, source } = repository();
    scores([...["s1", "s2", "s3"].map((id) => record(id)), ...["d1", "d2", "d3"].map((id) => record(id, { dimension: "delegation-fit" }))]);
    edits({ "claude/CLAUDE.md": CLEARER });
    setEnv({ FAKE_GH_FAIL: "scope-creep" });
    expect(await run(["--repo", source], { now: NOW })).toBe(1);
    const [failed, next] = proposals();
    expect(failed).toMatchObject({ dimension: "scope-creep", status: "error", branch: branchName, pushed: true, prUrl: null, costUSD: 0.7 });
    expect(failed.error).toContain("HTTP 502");
    expect(next).toMatchObject({ dimension: "delegation-fit", status: "proposed", branch: "factory-proposal/delegation-fit-20261105-090807" });

    // The error does not block a retry, which pushes a branch of its own the same day.
    setEnv({ FAKE_GH_FAIL: undefined });
    expect(await run(["--repo", source, "--dimension", "scope-creep"], { now: NOW + 3_600_000 })).toBe(0);
    expect(proposals()[2]).toMatchObject({ dimension: "scope-creep", status: "proposed", branch: "factory-proposal/scope-creep-20261105-100807" });
    expect(remoteBranches(remote).sort()).toEqual([branchName, "factory", "factory-proposal/delegation-fit-20261105-090807", "factory-proposal/scope-creep-20261105-100807", "main"].sort());
  });

  test("a proposer run that fails is recorded at its budget without a branch", async () => {
    const { remote, source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    setEnv({ FAKE_CLAUDE_MODE: "exit" });
    expect(await run(["--repo", source], { now: NOW })).toBe(1);
    expect(proposals()[0]).toMatchObject({ status: "error", branch: null, pushed: false, costUSD: 3 });
    expect(proposals()[0].error).toContain("Task run");
    expect(remoteBranches(remote).sort()).toEqual(["factory", "main"]);
  });

  test("a proposer that hit its budget keeps its partial edits as a local patch, untested and unpushed", async () => {
    const { remote, source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    edits({ "claude/CLAUDE.md": CLEARER });
    setEnv({ FAKE_RESULT: JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 3 }) });
    expect(await run(["--repo", source], { now: NOW })).toBe(1);
    const [entry] = proposals();
    expect(entry).toMatchObject({ status: "proposer-failed", resultSubtype: "error_max_budget_usd", proposerOk: false, costUSD: 3, tests: null, pushed: false, prUrl: null, paths: ["claude/CLAUDE.md"] });
    expect(readFileSync(entry.patchFile, "utf8")).toContain("+- Stay in the requested scope");
    expect(remoteBranches(remote).sort()).toEqual(["factory", "main"]);
    expect(log("gh.jsonl")).toHaveLength(0);
    expect(output.join("\n")).toContain("proposer-failed: error_max_budget_usd");

    // Without edits there is no patch.
    rmSync(join(scratch, "state", "proposals.jsonl"));
    edits({});
    expect(await run(["--repo", source], { now: NOW + 1000 })).toBe(1);
    expect(proposals()[0]).toMatchObject({ status: "proposer-failed", paths: [], patchFile: null });
  });

  test("a dry run runs the proposer and tests but pushes and opens nothing, and does not block a real run", async () => {
    const { remote, source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    edits({ "claude/CLAUDE.md": CLEARER });
    expect(await run(["--repo", source, "--dry-run"], { now: NOW })).toBe(0);
    const [entry] = proposals();
    expect(entry).toMatchObject({ status: "dry-run", dryRun: true, prUrl: null, tests: { ok: true } });
    expect(existsSync(entry.patchFile)).toBe(true);
    expect(remoteBranches(remote).sort()).toEqual(["factory", "main"]);
    expect(git(source, "branch", "--format=%(refname:short)")).toBe("factory\nmain");
    expect(log("gh.jsonl")).toHaveLength(0);
    expect(await run(["--repo", source], { now: NOW + 1000 })).toBe(0);
    expect(proposals()[1].status).toBe("proposed");
  });

  test("no change is recorded as such", async () => {
    const { source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    expect(await run(["--repo", source], { now: NOW })).toBe(0);
    expect(proposals()[0]).toMatchObject({ status: "no-change", paths: [] });
  });

  test("stops starting sessions once the next budget would pass the run's total, and the rest qualify next run", async () => {
    const { source } = repository();
    const dimensions = ["scope-creep", "delegation-fit", "concise-reporting"];
    scores(dimensions.flatMap((dimension) => ["1", "2", "3"].map((n) => record(`${dimension}-${n}`, { dimension }))));
    edits({ "claude/CLAUDE.md": CLEARER });
    // Each session costs 0.7 of its 3 budget: 0 + 3 and 0.7 + 3 fit under 4; 1.4 + 3 does not.
    expect(await run(["--repo", source, "--max-total-usd", "4"], { now: NOW })).toBe(0);
    expect(proposals().map((entry) => entry.dimension)).toEqual(["scope-creep", "delegation-fit"]);
    expect(log("claude.jsonl")).toHaveLength(2);
    expect(output.join("\n")).toContain("Stopped at the run's limit: spent $1.40 of $4.00, and the next session may cost $3.00. Not proposed this run: concise-reporting.");

    expect(await run(["--repo", source], { now: NOW + 1000 })).toBe(0);
    expect(proposals().map((entry) => entry.dimension)).toEqual(["scope-creep", "delegation-fit", "concise-reporting"]);
  });

  test("never-attempted dimensions go before ones that keep retrying, so the limit starves none", async () => {
    const { source } = repository();
    scores(["scope-creep", "delegation-fit"].flatMap((dimension) => ["1", "2", "3"].map((n) => record(`${dimension}-${n}`, { dimension }))));
    appendJsonl(join(scratch, "state", "proposals.jsonl"), { dimension: "scope-creep", status: "error", createdAt: new Date(NOW - 3_600_000).toISOString(), sessions: ["scope-creep-1"] });
    edits({ "claude/CLAUDE.md": CLEARER });
    expect(await run(["--repo", source, "--max-total-usd", "3"], { now: NOW })).toBe(0);
    expect(proposals().map((entry) => entry.dimension)).toEqual(["scope-creep", "delegation-fit"]);
    expect(output.join("\n")).toContain("Not proposed this run: scope-creep.");
  });

  test("a session whose stream never reported its cost counts at its budget", async () => {
    const { source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    setEnv({ FAKE_RESULT: JSON.stringify({ type: "assistant", message: { content: [] } }) });
    await run(["--repo", source], { now: NOW });
    expect(proposals()[0].costUSD).toBe(3);
  });

  test("a session budget above the run's limit is rejected before anything runs", async () => {
    expect(await run(["--budget-usd", "12"])).toBe(2);
    expect(output.join("\n")).toContain("--budget-usd 12 is more than --max-total-usd 10");
    expect(log("claude.jsonl")).toHaveLength(0);
  });

  test("a failed session counts at its budget toward the run's total", async () => {
    const { source } = repository();
    scores(["scope-creep", "delegation-fit"].flatMap((dimension) => ["1", "2", "3"].map((n) => record(`${dimension}-${n}`, { dimension }))));
    setEnv({ FAKE_CLAUDE_MODE: "exit" });
    expect(await run(["--repo", source, "--max-total-usd", "5"], { now: NOW })).toBe(1);
    expect(proposals()).toHaveLength(1);
    expect(output.join("\n")).toContain("spent $3.00 of $5.00");
  });

  test("dimensions below the threshold or filtered out run nothing; --list prints the evidence", async () => {
    const { source } = repository();
    scores([record("s1"), record("s2"), record("s3", { dimension: "delegation-fit" })]);
    expect(await run(["--repo", source])).toBe(0);
    expect(await run(["--repo", source, "--threshold", "2", "--dimension", "delegation-fit"])).toBe(0);
    expect(log("claude.jsonl")).toHaveLength(0);
    expect(output.join("\n")).toContain("Nothing qualifies.");
    expect(await run(["--repo", source, "--threshold", "2", "--list"])).toBe(0);
    expect(log("claude.jsonl")).toHaveLength(0);
    expect(output.join("\n")).toContain("- s2 (-Users-test-project): [T3] edited unrelated file in s2");
    expect(await run(["--dimension", "nope"])).toBe(2);
  });
});
