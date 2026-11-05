import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendJsonl, readJsonl } from "../lib/state.js";
import { RUBRIC } from "./rubric.js";
import { allowedPath, alreadyProposed, failureGroups, run } from "./propose.js";

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
    "claude/CLAUDE.md": "# Rules\n\n## Workflow\n\n- Stay in scope.\n\n## Delegation\n\n- Delegate rarely.\n",
    "claude/settings.json": "{}\n",
    "claude/tests/ok.test.js": 'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n',
  });
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "init");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "--quiet", "origin", "main");
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
  writeFileSync(gh, `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");\nconsole.log("https://github.com/o/r/pull/42");\n`);
  chmodSync(gh, 0o755);
  // The proposer: writes FAKE_EDITS ({ path: content }) into its working folder.
  const proposer = join(scratch, "proposer.js");
  writeFileSync(proposer, `import { mkdirSync, writeFileSync } from "node:fs";\nimport { dirname, join } from "node:path";\nexport default async ({ cwd, emit }) => {\n  for (const [path, content] of Object.entries(JSON.parse(process.env.FAKE_EDITS ?? "{}"))) {\n    mkdirSync(dirname(join(cwd, path)), { recursive: true });\n    writeFileSync(join(cwd, path), content);\n  }\n  emit({ type: "system", subtype: "init", tools: JSON.parse(process.env.FAKE_TOOLS ?? JSON.stringify(["Read", "Edit", "Write", "Glob", "Grep"])), mcp_servers: [] });\n  emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.7, num_turns: 3, result: "The scope rule was vague.\\nTITLE: Clarify the scope rule" });\n};\n`);
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
const branchName = `factory/proposal-scope-creep-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

describe("proposal rules", () => {
  test("only the global instructions, agent definitions and tests may change", () => {
    for (const path of ["claude/CLAUDE.md", "claude/agents/worker.md", "claude/tests/config.test.js", "claude/tests/lib/new.js"]) expect(allowedPath(path), path).toBe(true);
    for (const path of ["claude/settings.json", "claude/hooks/guard-git-push.js", "claude/agents/x/y.md", "claude/agents/worker.json", "CLAUDE.md", "claude/tests/../settings.json", "claude/factory/scoring/rubric.json"])
      expect(allowedPath(path), path).toBe(false);
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

  test("a recent real proposal sharing a session blocks the dimension; a dry run does not", () => {
    const now = Date.now();
    const at = new Date(now - 86_400_000).toISOString();
    const proposalsMade = [{ dimension: "scope-creep", status: "proposed", createdAt: at, sessions: ["s1", "s2"] }, { dimension: "delegation-fit", status: "dry-run", createdAt: at, sessions: ["s1"] }];
    expect(alreadyProposed(proposalsMade, "scope-creep", ["s2", "s9"], now)).toBeTruthy();
    expect(alreadyProposed(proposalsMade, "scope-creep", ["s9"], now)).toBeUndefined();
    expect(alreadyProposed(proposalsMade, "delegation-fit", ["s1"], now)).toBeUndefined();
    expect(alreadyProposed(proposalsMade, "scope-creep", ["s1"], now + 40 * 86_400_000)).toBeUndefined();
  });
});

describe("propose command", () => {
  test("pushes a branch from the remote's main and opens a draft PR with the evidence", async () => {
    const { remote, source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    edits({ "claude/CLAUDE.md": "# Rules\n\n## Workflow\n\n- Stay in the requested scope; report unrelated issues.\n\n## Delegation\n\n- Delegate rarely.\n", "claude/tests/scope.test.js": 'import { expect, test } from "bun:test";\ntest("scope", () => expect(true).toBe(true));\n' });
    expect(await run(["--repo", source])).toBe(0);

    const [proposer] = log("claude.jsonl");
    expect(proposer.args).toEqual(expect.arrayContaining(["--tools", "Read,Edit,Write,Glob,Grep", "--permission-mode", "acceptEdits", "--model", "claude-opus-5-5", "--effort", "high", "--max-budget-usd", "3"]));
    expect(proposer.stdin).toContain("- Stay in scope.");
    expect(proposer.stdin).toContain("[T3] edited unrelated file in s2");
    expect(proposer.stdin).toContain("Prefer clarifying, replacing or deleting");
    expect(existsSync(proposer.cwd)).toBe(false);

    expect(remoteBranches(remote).sort()).toEqual([branchName, "main"].sort());
    expect(git(remote, "show", `${branchName}:claude/CLAUDE.md`)).toContain("report unrelated issues");
    expect(git(remote, "log", "-1", "--format=%s", branchName)).toBe("Clarify the scope rule");
    expect(() => git(remote, "show", `${branchName}:local-only.txt`)).toThrow();

    const [pr] = log("gh.jsonl");
    expect(pr.args.slice(0, 7)).toEqual(["pr", "create", "--draft", "--base", "main", "--head", branchName]);
    const body = pr.args[pr.args.indexOf("--body") + 1];
    for (const text of ["The scope rule was vague.", "- `s1`", "- `s3`", "Judge: claude-sonnet-5-5 (medium)", "Proposer: claude-opus-5-5 (high), $0.70", "Tests: `bun test claude/tests`: 2 pass"]) expect(body).toContain(text);
    expect(body).not.toMatch(/Generated with|Co-Authored-By|\u{1F916}/u);
    // Evidence quotes private transcripts: it stays local, and the body names the file.
    expect(body).not.toContain("edited unrelated file");
    expect(body).not.toContain("-Users-test-project");
    expect(body).not.toContain("TITLE:");

    const [entry] = proposals();
    expect(entry).toMatchObject({ dimension: "scope-creep", status: "proposed", sessions: ["s1", "s2", "s3"], prUrl: "https://github.com/o/r/pull/42", branch: branchName, costUSD: 0.7, paths: ["claude/CLAUDE.md", "claude/tests/scope.test.js"] });
    expect(readFileSync(entry.patchFile, "utf8")).toContain("+- Stay in the requested scope");
    expect(readFileSync(entry.evidenceFile, "utf8")).toContain("- s2 (-Users-test-project)\n  - [T3] edited unrelated file in s2");
    expect(body).toContain(`\`proposals/${entry.evidenceFile.split("/").at(-1)}\``);

    // The same sessions do not get a second proposal.
    expect(await run(["--repo", source])).toBe(0);
    expect(log("claude.jsonl")).toHaveLength(1);
    expect(output.join("\n")).toMatch(/scope-creep\s+3 failing sessions\s+already proposed/);
  });

  test("rejects a proposer session that had more than the file tools", async () => {
    const { remote, source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    edits({ "claude/CLAUDE.md": "changed\n" });
    setEnv({ FAKE_TOOLS: JSON.stringify(["Read", "Edit", "Bash"]) });
    expect(await run(["--repo", source])).toBe(1);
    expect(proposals()[0]).toMatchObject({ status: "rejected-tools", tools: ["Read", "Edit", "Bash"] });
    expect(remoteBranches(remote)).toEqual(["main"]);
    expect(log("gh.jsonl")).toHaveLength(0);
  });

  test("rejects a change outside the allowed paths without pushing", async () => {
    const { remote, source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    edits({ "claude/CLAUDE.md": "changed\n", "claude/settings.json": '{"permissions":{"allow":["Bash"]}}\n' });
    expect(await run(["--repo", source])).toBe(1);
    expect(proposals()[0]).toMatchObject({ status: "rejected-paths", rejected: ["claude/settings.json"] });
    expect(remoteBranches(remote)).toEqual(["main"]);
    expect(log("gh.jsonl")).toHaveLength(0);
  });

  test("records failing tests and pushes nothing", async () => {
    const { remote, source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    edits({ "claude/tests/bad.test.js": 'import { expect, test } from "bun:test";\ntest("bad", () => expect(1).toBe(2));\n' });
    expect(await run(["--repo", source])).toBe(1);
    const [entry] = proposals();
    expect(entry.status).toBe("tests-failed");
    expect(entry.tests).toMatchObject({ ok: false, command: "bun test claude/tests" });
    expect(entry.tests.summary).toContain("1 fail");
    expect(entry.tests.tail).toContain("bad");
    expect(remoteBranches(remote)).toEqual(["main"]);
    expect(log("gh.jsonl")).toHaveLength(0);
  });

  test("a dry run runs the proposer and tests but pushes and opens nothing, and does not block a real run", async () => {
    const { remote, source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    edits({ "claude/CLAUDE.md": "# Rules\n\n## Workflow\n\n- Clearer.\n" });
    expect(await run(["--repo", source, "--dry-run"])).toBe(0);
    const [entry] = proposals();
    expect(entry).toMatchObject({ status: "dry-run", dryRun: true, prUrl: null, tests: { ok: true } });
    expect(existsSync(entry.patchFile)).toBe(true);
    expect(remoteBranches(remote)).toEqual(["main"]);
    expect(git(source, "branch", "--format=%(refname:short)")).toBe("main");
    expect(log("gh.jsonl")).toHaveLength(0);
    expect(await run(["--repo", source])).toBe(0);
    expect(proposals()[1].status).toBe("proposed");
  });

  test("no change is recorded as such", async () => {
    const { source } = repository();
    scores(["s1", "s2", "s3"].map((id) => record(id)));
    expect(await run(["--repo", source])).toBe(0);
    expect(proposals()[0]).toMatchObject({ status: "no-change", paths: [] });
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
