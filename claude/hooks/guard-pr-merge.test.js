import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyChecks, findMergeViolation, parseMerge, runGh } from "./guard-pr-merge.js";

const HOOK = join(import.meta.dir, "guard-pr-merge.js");

const run = (name, status, conclusion, extra = {}) => ({ __typename: "CheckRun", workflowName: "Checks", name, status, conclusion, ...extra });
const context = (name, state) => ({ __typename: "StatusContext", context: name, state });
const PASSING = [run("Portable tests", "COMPLETED", "SUCCESS")];
const VIEW = { number: 12, url: "https://github.com/o/r/pull/12", state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", baseRefName: "main", statusCheckRollup: PASSING };
const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const NOT_FOUND = { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
const PROTECTED = { protection: { enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: ["Portable tests"], checks: [] } } };
const WORKFLOWS = { total_count: 1, workflows: [{ path: ".github/workflows/checks.yml", state: "active" }] };

// A stubbed gh. `view` overrides the pull request fields; `branch`, `rules` and `workflows` are
// the API answers (undefined: none). `calls` records { dir, args } for each call.
function fakeGh({ view = {}, branch, rules, workflows, calls = [] } = {}) {
  return (dir, args) => {
    calls.push({ dir, args });
    if (args[0] === "pr") return ok({ ...VIEW, ...view });
    const path = args[3];
    if (path.includes("/rules/branches/")) return rules === undefined ? ok([]) : ok(rules);
    if (path.includes("/branches/")) return ok(branch ?? { protection: { enabled: false } });
    if (path.includes("/actions/workflows")) return workflows === undefined ? ok({ total_count: 0, workflows: [] }) : ok(workflows);
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}

const verdict = (command, options = {}, cwd = "/repo") => findMergeViolation(command, cwd, fakeGh(options));

describe("refuses", () => {
  test.each([
    ["gh pr merge 12 --admin", {}, "--admin bypasses"],
    ["gh pr merge 12 --squash --admin=true", {}, "--admin bypasses"],
    ["gh pr merge 12 --auto --admin", { branch: PROTECTED }, "--admin bypasses"],
    ["gh pr merge 12", { view: { isDraft: true } }, "is a draft"],
    ["gh pr merge 12", { view: { mergeStateStatus: "BEHIND" } }, "is behind main"],
    ["gh pr merge 12", { view: { mergeStateStatus: "DIRTY" } }, "conflicts with main"],
    // an in-progress run has conclusion "", so its status decides
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "IN_PROGRESS", "")] } }, "still running"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "QUEUED", "")] } }, "still running"],
    ["gh pr merge 12", { view: { statusCheckRollup: [...PASSING, context("ci/x", "PENDING")] } }, "still running"],
    ["gh pr merge 12", { view: { statusCheckRollup: [context("ci/x", "EXPECTED")] } }, "still running"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "COMPLETED", "FAILURE")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "COMPLETED", "CANCELLED")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "COMPLETED", "TIMED_OUT")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "COMPLETED", "ACTION_REQUIRED")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [context("ci/x", "FAILURE")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [context("ci/x", "ERROR")] } }, "checks failed"],
    // no checks yet while the repository has workflows: CI may not have started
    ["gh pr merge 12", { view: { statusCheckRollup: [] }, workflows: WORKFLOWS }, "CI may not have started"],
    // --auto is a direct merge where the base branch requires no checks
    ["gh pr merge 12 --auto", { view: { statusCheckRollup: [run("Portable tests", "IN_PROGRESS", "")] } }, "still running"],
    ["gh pr merge 12 --auto", { view: { mergeStateStatus: "BLOCKED", statusCheckRollup: [run("t", "IN_PROGRESS", "")] }, branch: { protection: { required_status_checks: { enforcement_level: "off", contexts: ["x"] } } } }, "still running"],
    ["gh pr merge 12 --auto", { view: { isDraft: true, mergeStateStatus: "BLOCKED" }, branch: PROTECTED }, "is a draft"],
    // gh merges at once rather than enabling auto-merge when the pull request can merge now
    ["gh pr merge 12 --auto", { view: { mergeStateStatus: "UNSTABLE", statusCheckRollup: [...PASSING, run("Lint", "COMPLETED", "FAILURE")] }, branch: PROTECTED }, "checks failed"],
    ["gh pr merge 12 --auto", { view: { mergeStateStatus: "CLEAN", statusCheckRollup: [] }, branch: PROTECTED, workflows: WORKFLOWS }, "CI may not have started"],
    // the shell fills in the selector, repository, an option or the subcommand
    ["gh pr merge $PR", {}, "the shell fills in `$PR`"],
    ["gh pr merge \"$(gh pr list -q .[0].number)\"", {}, "the shell fills in"],
    ["gh pr merge 12 -R $REPO", {}, "the shell fills in"],
    ["gh pr merge 12 --repo=${REPO}", {}, "the shell fills in"],
    ["gh pr -R $REPO merge 12", {}, "the shell fills in the repository"],
    ["gh pr merge 12 --$OPT", {}, "the shell fills in"],
    ["gh pr $SUB 12", {}, "the gh pr subcommand"],
    ["gh $CMD merge 12", {}, "the gh subcommand"],
    ["$GH pr merge 12", {}, "the command name"],
    ["GH_REPO=o/other gh pr merge 12", {}, "sets GH_REPO"],
    ["export GH_REPO=o/other; gh pr merge 12", {}, "sets GH_REPO"],
    ["GH_HOST=ghe.example gh pr merge 12", {}, "sets GH_HOST"],
    // gh resolves -R against GH_HOST, which the guard's own query does not see
    ["GH_HOST=ghe.example gh pr merge 12 -R o/r", {}, "sets GH_HOST"],
    // an unquoted value the shell fills in can vanish and shift the selector
    ["gh pr merge --body $B 12", {}, "the shell fills in `$B`"],
    ["gh pr merge 12 --subject \"$(date)\"", {}, "the shell fills in"],
    // xargs appends the selector, which the guard cannot see
    ["echo 13 | xargs gh pr merge --squash", {}, "xargs adds arguments"],
    // a push in the same command moves the head after the guard reads its checks, in any order
    ["git push && gh pr merge 12", {}, "also runs `git push`"],
    ["git push -u origin feature; gh pr merge 12 --squash", {}, "also runs `git push`"],
    ["gh pr merge 12 && git push", {}, "also runs `git push`"],
    ["git -C /repo push & gh pr merge 12", {}, "also runs `git push`"],
    ["bash -c 'git push' && gh pr merge 12", {}, "also runs `git push`"],
    ["GIT push && gh pr merge 12", {}, "also runs `git push`"],
    ["$GIT push && gh pr merge 12", {}, "also runs `git push`"],
    ["git $SUB && gh pr merge 12", {}, "also runs `git push`"],
    // an option the guard does not know could take a value and hide the selector
    ["gh pr merge --new-option 12", {}, "does not know the option"],
    ["gh pr merge -x 12", {}, "does not know the option"],
    // gh reads options before the subcommand too, and may take the next word as a value
    ["gh pr --foo merge 12", {}, "before the subcommand"],
    ["gh --admin=true pr merge 12", {}, "before the subcommand"],
    ["gh -b x pr merge 12", {}, "before the subcommand"],
    ["gh -R o/r pr merge 12 --admin", {}, "--admin bypasses"],
    // the directory, and so the repository, is unknown
    ["cd \"$DIR\" && gh pr merge 12", {}, "cannot tell which directory"],
    ["ssh host gh pr merge 12", {}, "cannot tell which directory"],
    // wrappers and shells
    ["cd /repo && gh pr merge 12 --squash", { view: { isDraft: true } }, "is a draft"],
    ["bash -c 'gh pr merge 12'", { view: { isDraft: true } }, "is a draft"],
    ["sudo -u me gh pr merge 12", { view: { isDraft: true } }, "is a draft"],
    ["/opt/homebrew/bin/gh pr merge 12", { view: { isDraft: true } }, "is a draft"],
    ["GH pr merge 12", { view: { isDraft: true } }, "is a draft"],
    ["x=$(gh pr merge 12)", { view: { isDraft: true } }, "is a draft"],
    [`${"eval ".repeat(12)}gh pr merge 12`, {}, "too deeply"],
    // merges through the API skip the checks
    ["gh api -X PUT repos/o/r/pulls/12/merge", {}, "through the API"],
    ["gh api --method PUT /repos/o/r/pulls/$N/merge -f merge_method=squash", {}, "through the API"],
    ["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'", {}, "through the API"],
    ["gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }'", {}, "through the API"],
    ["gh --method=PUT api repos/o/r/pulls/12/merge", {}, "through the API"],
    ["gh -X PUT api repos/o/r/pulls/12/merge", {}, "through the API"],
    ["gh api graphql --input - <<'EOF'\n{\"query\": \"mutation { mergePullRequest(input: {}) { clientMutationId } }\"}\nEOF", {}, "through the API"],
    ["$GH api repos/o/r/pulls/12/merge", {}, "the command name"],
  ])("%s", (command, options, reason) => {
    const violation = verdict(command, options);
    expect(violation).toBeString();
    expect(violation).toContain(reason);
  });

  test("names the command, the pull request and the failing checks", () => {
    const violation = verdict("gh pr merge 12 --squash", { view: { statusCheckRollup: [...PASSING, run("Lint", "COMPLETED", "FAILURE")] } });
    expect(violation).toStartWith("`gh pr merge 12 --squash`: checks failed on pull request #12's head commit: Checks / Lint (FAILURE).");
  });

  test.each([
    ["gh exits with an error", () => ({ code: 1, stdout: "", stderr: "GraphQL: Could not resolve to a PullRequest\nmore" }), "Could not resolve to a PullRequest"],
    ["gh times out", () => { throw new Error("spawnSync gh ETIMEDOUT"); }, "ETIMEDOUT"],
    ["gh prints no JSON", () => ({ code: 0, stdout: "oops", stderr: "" }), "not JSON"],
  ])("when %s", (_, gh, reason) => {
    const violation = findMergeViolation("gh pr merge 12", "/repo", gh);
    expect(violation).toContain(reason);
    expect(violation).toContain("The guard refuses a merge it cannot check");
  });

  test("when a later API query fails", () => {
    const gh = (dir, args) => (args[0] === "pr" ? ok({ ...VIEW, statusCheckRollup: [] }) : { code: 1, stdout: "", stderr: "HTTP 500" });
    expect(findMergeViolation("gh pr merge 12", "/repo", gh)).toContain("gh could not list the repository's workflows (HTTP 500)");
  });

  test("once the time budget is spent", () => {
    const calls = [];
    expect(findMergeViolation("gh pr merge 12", "/repo", fakeGh({ calls }), { budgetMs: 0 })).toContain("ran out of time");
    expect(calls).toHaveLength(0);
  });
});

describe("allows", () => {
  test.each([
    ["gh pr merge 12 --squash --delete-branch", {}],
    ["gh pr merge 12 -sd", {}],
    ["gh pr merge 12 --admin=false", {}],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("a", "COMPLETED", "SUCCESS"), run("b", "COMPLETED", "NEUTRAL"), run("c", "COMPLETED", "SKIPPED"), context("ci/x", "SUCCESS")] } }],
    // no checks in a repository without active workflows
    ["gh pr merge 12", { view: { statusCheckRollup: [] } }],
    ["gh pr merge 12", { view: { statusCheckRollup: [] }, workflows: { workflows: [{ path: ".github/workflows/old.yml", state: "disabled_manually" }, { path: "dynamic/dependabot/dependabot-updates", state: "active" }] } }],
    // --auto where the base branch requires checks, by protection or a ruleset: GitHub waits for them
    ["gh pr merge 12 --auto --squash", { branch: PROTECTED, view: { mergeStateStatus: "BLOCKED", statusCheckRollup: [run("Portable tests", "IN_PROGRESS", "")] } }],
    ["gh pr merge 12 --auto", { rules: [{ type: "required_status_checks" }], view: { mergeStateStatus: "BEHIND", statusCheckRollup: [] }, workflows: WORKFLOWS }],
    ["gh pr merge 12 --disable-auto", { view: { isDraft: true } }],
    ["gh pr merge --help", { view: { isDraft: true } }],
    // gh refuses a closed or merged pull request itself
    ["gh pr merge 12", { view: { state: "MERGED", mergeStateStatus: "UNKNOWN", statusCheckRollup: [] }, workflows: WORKFLOWS }],
    // other gh and git commands
    ["gh pr view 12", { view: { isDraft: true } }],
    ["gh pr create --title merge", { view: { isDraft: true } }],
    ["gh api repos/o/r/pulls/12", {}],
    ["gh api repos/o/r/merges", {}],
    ["git merge --ff-only origin/main", {}],
    ["echo gh pr merge 12", { view: { isDraft: true } }],
    // a push with no merge in the same command, or a merge after a fetch or pull
    ["git push && gh pr view 12", {}],
    ["git fetch && git pull --ff-only && gh pr merge 12", {}],
    ["echo git push && gh pr merge 12", {}],
  ])("%s", (command, options) => {
    expect(verdict(command, options)).toBeUndefined();
  });

  // The rollup does not say which event started a run, so a later success with the same name,
  // say from pull_request, must not hide a failure from push.
  test("every run with the same name counts, in either order", () => {
    const failed = run("t", "COMPLETED", "FAILURE", { completedAt: "2026-11-08T10:00:00Z" });
    const passed = run("t", "COMPLETED", "SUCCESS", { completedAt: "2026-11-08T11:00:00Z" });
    expect(verdict("gh pr merge 12", { view: { statusCheckRollup: [failed, passed] } })).toContain("checks failed");
    expect(verdict("gh pr merge 12", { view: { statusCheckRollup: [passed, failed] } })).toContain("checks failed");
    expect(classifyChecks([failed, run("t", "QUEUED", "")])).toEqual({ pending: ["Checks / t"], failed: ["Checks / t (FAILURE)"] });
  });
});

describe("resolves the pull request", () => {
  const query = (command, cwd = "/repo") => {
    const calls = [];
    expect(findMergeViolation(command, cwd, fakeGh({ calls }))).toBeUndefined();
    return calls[0];
  };
  const json = ["--json", "number,url,state,isDraft,mergeStateStatus,baseRefName,statusCheckRollup"];

  test.each([
    ["gh pr merge 12", ["pr", "view", "12", ...json]],
    ["gh pr merge https://github.com/o/r/pull/12", ["pr", "view", "https://github.com/o/r/pull/12", ...json]],
    ["gh pr merge feature-branch", ["pr", "view", "feature-branch", ...json]],
    ["gh pr merge --squash", ["pr", "view", ...json]],
    ["gh pr merge 12 -R o/r", ["pr", "view", "12", "--repo", "o/r", ...json]],
    ["gh pr merge 12 -Ro/r", ["pr", "view", "12", "--repo", "o/r", ...json]],
    ["gh pr merge 12 --repo=o/r", ["pr", "view", "12", "--repo", "o/r", ...json]],
    ["gh pr -R o/r merge 12", ["pr", "view", "12", "--repo", "o/r", ...json]],
    ["gh pr merge -b 'body text' -t subject -- 12", ["pr", "view", "12", ...json]],
    ["GH_REPO=o/r gh pr merge 12 -R o/r", ["pr", "view", "12", "--repo", "o/r", ...json]],
    ["gh -R o/r pr merge 12", ["pr", "view", "12", "--repo", "o/r", ...json]],
    ["gh pr merge 12 --body \"$B\" -R o/r", undefined],
  ])("%s", (command, args) => {
    if (args === undefined) expect(findMergeViolation(command, "/repo", fakeGh())).toContain("the shell fills in");
    else expect(query(command)).toEqual({ dir: "/repo", args });
  });

  test("in the directory the command runs in", () => {
    expect(query("cd /other && gh pr merge 12").dir).toBe("/other");
    expect(query("(cd /other && ls); gh pr merge 13").dir).toBe("/repo");
    expect(query("cd /other | cat; gh pr merge 13").dir).toBe("/repo");
    // zsh runs a pipeline's last part in the current shell, so its cd moves later commands
    expect(query("ls | cd /other; gh pr merge 13").dir).toBe("/other");
    expect(query("ls | (cd /other); gh pr merge 13").dir).toBe("/repo");
    expect(query("cd /other & gh pr merge 13").dir).toBe("/repo");
    expect(query("(cd /other; gh pr merge 13)").dir).toBe("/other");
  });

  test("from a URL or -R when the directory is unknown", () => {
    expect(query("cd \"$D\" && gh pr merge https://github.com/o/r/pull/12").args[2]).toBe("https://github.com/o/r/pull/12");
    expect(query("cd \"$D\" && gh pr merge 12 -R o/r").args).toContain("o/r");
  });

  test("and queries the API on the pull request's host", () => {
    const calls = [];
    findMergeViolation("gh pr merge 12 --auto", "/repo", fakeGh({ calls, view: { url: "https://ghe.example/team/app/pull/12", baseRefName: "release/1", mergeStateStatus: "BLOCKED" } }));
    expect(calls.slice(1).map((call) => call.args)).toEqual([
      ["api", "--hostname", "ghe.example", "repos/team/app/branches/release%2F1"],
      ["api", "--hostname", "ghe.example", "repos/team/app/rules/branches/release%2F1"],
    ]);
  });
});

test("parseMerge reads short option groups and values", () => {
  expect(parseMerge(["-sdR", "o/r", "12"])).toMatchObject({ repo: "o/r", selector: "12", admin: false });
  expect(parseMerge(["-b", "--admin", "12"])).toMatchObject({ admin: false, selector: "12" });
  expect(parseMerge(["--auto=false", "12"])).toMatchObject({ auto: false });
});

describe("the hook", () => {
  let root;
  let bin;
  const env = () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_LOG: join(root, "log") });
  const hook = (stdin, extraEnv = {}) => {
    const result = Bun.spawnSync({ cmd: [process.execPath, HOOK], stdin: Buffer.from(stdin), env: { ...env(), ...extraEnv } });
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };
  const bash = (command, extraEnv) => hook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: root }), extraEnv);
  const reply = (value) => writeFileSync(join(root, "reply"), JSON.stringify(value));

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "guard-pr-merge-"));
    bin = join(root, "bin");
    Bun.spawnSync({ cmd: ["mkdir", bin] });
    // A fake gh: logs its arguments and GH_REPO, then prints the reply file or fails.
    writeFileSync(join(bin, "gh"), [
      "#!/bin/sh",
      'echo "GH_REPO=$GH_REPO $*" >> "$FAKE_GH_LOG"',
      'if [ -n "$FAKE_GH_SLEEP" ]; then sleep "$FAKE_GH_SLEEP"; fi',
      'if [ -n "$FAKE_GH_FAIL" ]; then echo "$FAKE_GH_FAIL" >&2; exit 1; fi',
      `cat "${join(root, "reply")}"`,
      "",
    ].join("\n"));
    chmodSync(join(bin, "gh"), 0o755);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("blocks a draft with exit 2 and the reason", () => {
    reply({ ...VIEW, isDraft: true });
    const result = bash("gh pr merge 12 --squash");
    expect(result.code).toBe(2);
    expect(result.stderr).toStartWith("Blocked by the guard-pr-merge hook: `gh pr merge 12 --squash`: pull request #12 is a draft.");
  });

  test("allows a merge whose checks pass, and gh sees GH_REPO from the environment", () => {
    reply(VIEW);
    rmSync(join(root, "log"), { force: true });
    expect(bash("gh pr merge 12 --squash", { GH_REPO: "o/r" })).toEqual({ code: 0, stderr: "" });
    expect(readFileSync(join(root, "log"), "utf8")).toStartWith("GH_REPO=o/r pr view 12 --json");
  });

  test("blocks when gh fails", () => {
    const result = bash("gh pr merge 12", { FAKE_GH_FAIL: "HTTP 502" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("gh could not read the pull request (HTTP 502)");
  });

  test("stops a gh call that runs past its timeout", () => {
    const saved = { PATH: process.env.PATH, FAKE_GH_SLEEP: process.env.FAKE_GH_SLEEP, FAKE_GH_LOG: process.env.FAKE_GH_LOG };
    Object.assign(process.env, { PATH: env().PATH, FAKE_GH_SLEEP: "5", FAKE_GH_LOG: join(root, "log") });
    try {
      const started = Date.now();
      expect(() => runGh(root, ["pr", "view"], 300)).toThrow();
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  test.each([
    ["a line continuation inside the subcommand", "gh pr m\\\nerge 12 --admin", "--admin bypasses"],
    ["a subcommand the shell fills in mid-word", "gh pr mer${E}ge 12 --admin", "the shell fills in"],
    ["a subcommand from a command substitution", "gh pr \"$(printf m)erge\" 12", "the shell fills in"],
    ["an ANSI-C quoted subcommand", "gh pr $'\\x6derge' 12", "the shell fills in"],
  ])("blocks %s", (_, command, reason) => {
    const result = bash(command);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(reason);
  });

  test("blocks rather than crash on input it cannot parse", () => {
    const result = hook("{ not json, gh pr merge 12");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("the guard failed");
  });

  test("skips commands that do not mention merge without calling gh", () => {
    rmSync(join(root, "log"), { force: true });
    expect(bash("gh pr view 12")).toEqual({ code: 0, stderr: "" });
    expect(() => readFileSync(join(root, "log"))).toThrow();
  });
});
