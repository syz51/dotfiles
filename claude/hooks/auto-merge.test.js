import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createsPullRequest, METHODS, OWNERS, pullRequestUrls, report } from "./auto-merge.js";
import { findMergeViolation } from "./guard-pr-merge.js";

const HOOK = join(import.meta.dir, "auto-merge.js");
const URL = "https://github.com/syz51/dotfiles/pull/12";
const CREATE = "git push -u origin feature && gh pr create --base main --title t --body-file /tmp/b";
const ok = (value) => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const NOT_FOUND = { code: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
const VIEW = { state: "OPEN", isDraft: false, baseRefName: "main", mergeStateStatus: "BLOCKED", autoMergeRequest: null };
const REPO = { allow_auto_merge: true, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true };
const CHECKS = { required_status_checks: { contexts: ["Portable tests"], checks: [{ context: "Portable tests" }] },
  required_pull_request_reviews: { required_approving_review_count: 0 } };

// A stubbed gh. `view`, `repo`, `protection` and `rules` override the answers (protection
// null: HTTP 404); `merge` is the merge call's result. `calls` records each call's args.
function fakeGh({ view = {}, repo = {}, protection = CHECKS, rules = [], merge = ok(""), calls = [] } = {}) {
  return (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") return ok({ ...VIEW, ...view });
    if (args[0] === "pr" && args[1] === "merge") return typeof merge === "function" ? merge() : merge;
    const path = args[3];
    if (path.endsWith("/protection")) return protection === null ? NOT_FOUND : typeof protection === "function" ? protection() : ok(protection);
    if (path.includes("/rules/branches/")) return ok(rules);
    if (/^repos\/[^/]+\/[^/]+$/.test(path)) return ok({ ...REPO, ...repo });
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}

const mergeCalls = (calls) => calls.filter((args) => args[0] === "pr" && args[1] === "merge");
const hook = (options = {}, { command = CREATE, stdout = `${URL}\n` } = {}) => {
  const calls = [];
  const text = report(command, "/repo", stdout, fakeGh({ ...options, calls }));
  return { text, merges: mergeCalls(calls), calls };
};

describe("turns on auto-merge", () => {
  test("for a syz51 pull request whose base requires checks, with a merge commit first", () => {
    const { text, merges } = hook();
    expect(merges).toEqual([["pr", "merge", URL, "--auto", "--merge"]]);
    expect(text).toContain(`${URL}: auto-merge is on (--merge)`);
    expect(text).toContain(`gh pr update-branch ${URL}`);
  });

  test.each([
    [{ allow_merge_commit: false }, "--squash"],
    [{ allow_merge_commit: false, allow_squash_merge: false }, "--rebase"],
  ])("with the first method the repository allows: %o", (repo, flag) => {
    expect(hook({ repo }).merges).toEqual([["pr", "merge", URL, "--auto", flag]]);
  });

  test.each([
    ["required reviews in branch protection", { protection: { required_pull_request_reviews: { required_approving_review_count: 1 } } }],
    ["a required-checks ruleset", { protection: null, rules: [{ type: "required_status_checks" }] }],
    ["a ruleset that requires an approval", { protection: null, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }] }],
  ])("where the base has %s", (_, options) => {
    expect(hook(options).merges).toHaveLength(1);
  });

  test("for each pull request the call printed, once each", () => {
    const other = "https://github.com/syz51/agent-board/pull/3";
    const { merges } = hook({}, { stdout: `${URL}\n${URL}\n${other}\n` });
    expect(merges.map((args) => args[2])).toEqual([URL, other]);
  });

  test("for a gh pr create inside a shell script or after cd", () => {
    expect(hook({}, { command: "cd /repo && sh -c 'gh pr create --fill'" }).merges).toHaveLength(1);
  });
});

describe("does nothing", () => {
  test.each([
    ["another owner's repository", { stdout: "https://github.com/pingdotgg/t3code/pull/9\n" }, "is not one auto-merge acts for"],
    ["another host", { stdout: "https://ghe.example.com/syz51/dotfiles/pull/9\n" }, "is not one auto-merge acts for"],
  ])("for %s, without calling gh", (_, io, reason) => {
    const { text, calls } = hook({}, io);
    expect(text).toContain(reason);
    expect(calls).toEqual([]);
  });

  test.each([
    ["a draft", { view: { isDraft: true } }, "is a draft"],
    ["a closed pull request", { view: { state: "CLOSED" } }, "skipped, it is closed"],
    ["auto-merge already on", { view: { autoMergeRequest: { enabledAt: "2026-11-12T00:00:00Z" } } }, "auto-merge is already on"],
    ["allow_auto_merge off", { repo: { allow_auto_merge: false } }, "does not allow auto-merge"],
    ["a base without protection or rulesets", { protection: null }, "requires no checks or reviews"],
    ["a base whose protection requires neither checks nor approvals", { protection: { required_status_checks: { contexts: [], checks: [] }, required_pull_request_reviews: { required_approving_review_count: 0 } } }, "requires no checks or reviews"],
    ["a ruleset that requires a pull request but no approval", { protection: null, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 0 } }] }, "requires no checks or reviews"],
    ["no merge method allowed", { repo: { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: false } }, "allows no merge method"],
    // gh would merge a CLEAN or UNSTABLE pull request at once; only guard-pr-merge may let that through
    ["a pull request gh would merge at once", { view: { mergeStateStatus: "UNSTABLE" } }, "gh would merge it at once"],
  ])("for %s", (_, options, reason) => {
    const { text, merges } = hook(options);
    expect(text).toContain(reason);
    expect(merges).toEqual([]);
  });

  test.each([
    ["a command without gh pr create", "gh pr view 12 --json url --jq .url"],
    ["gh pr list", "gh pr list"],
  ])("for %s, even when it prints a pull request URL", (_, command) => {
    expect(hook({}, { command }).text).toBeUndefined();
  });

  test("when gh pr create printed no URL", () => {
    expect(hook({}, { stdout: "Warning: 1 uncommitted change\n" }).text).toBeUndefined();
  });
});

describe("reports a gh failure without throwing", () => {
  test.each([
    ["a failed merge call", { merge: { code: 1, stdout: "", stderr: "GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)" } }, "could not turn on auto-merge (GraphQL: Pull request is in clean status"],
    ["a gh that cannot run", { merge: () => { throw new Error("spawnSync gh ETIMEDOUT"); } }, "could not turn on auto-merge (spawnSync gh ETIMEDOUT)"],
    ["a refused protection read", { protection: () => ({ code: 1, stdout: "", stderr: "gh: Must have admin rights to Repository. (HTTP 403)" }) }, "could not read the base branch's protection (gh: Must have admin rights"],
  ])("%s", (_, options, reason) => {
    const { text } = hook(options);
    expect(text).toContain(`${URL}: auto-merge failed: gh ${reason}`);
    expect(text).toContain("~/.claude/reference/merge.md");
  });

  test("and goes on to the next pull request", () => {
    const other = "https://github.com/syz51/agent-board/pull/3";
    let first = true;
    const merge = () => {
      if (!first) return ok("");
      first = false;
      return { code: 1, stdout: "", stderr: "HTTP 502" };
    };
    const text = report(CREATE, "/repo", `${URL}\n${other}\n`, fakeGh({ merge }));
    expect(text).toContain(`${URL}: auto-merge failed`);
    expect(text).toContain(`${other}: auto-merge is on`);
  });

  test("once the time budget is spent", () => {
    const text = report(CREATE, "/repo", `${URL}\n`, fakeGh(), { budgetMs: 0 });
    expect(text).toContain("gh ran out of time to read the pull request");
  });

  // The script itself: a crash or a gh failure leaves exit 0 and reports through additionalContext.
  test.each([
    ["input that is not JSON", "not json", "auto-merge hook failed"],
    ["a gh that fails", JSON.stringify({ cwd: "/nonexistent-auto-merge-test", tool_input: { command: "gh pr create --fill" }, tool_response: { stdout: `${URL}\n` } }), "auto-merge failed"],
  ])("the script exits 0 on %s", (_, input, reason) => {
    // A PATH without gh makes every gh call fail to start.
    const result = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", env: { PATH: "/nonexistent" } });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(output.hookSpecificOutput.additionalContext).toContain(reason);
  });

  test("the script prints nothing for a command that is not gh", () => {
    const input = JSON.stringify({ cwd: "/repo", tool_input: { command: "ls" }, tool_response: { stdout: `${URL}\n` } });
    const result = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("parsing", () => {
  test.each([
    ["gh pr create --fill", true],
    ["gh pr new --fill", true],
    ["GH_PROMPT_DISABLED=1 gh -R syz51/dotfiles pr create --fill", true],
    ["echo $(gh pr create --fill)", true],
    ["gh pr view 12", false],
    ["echo gh pr create", false],
    ["gh issue create", false],
  ])("%s creates a pull request: %p", (command, expected) => {
    expect(createsPullRequest(command, "/repo")).toBe(expected);
  });

  test("only URLs alone on a line count", () => {
    expect(pullRequestUrls(`Creating pull request\n  ${URL}  \nsee ${URL.replace("12", "13")} too\n${URL}/files\n`)).toEqual([URL]);
  });

  test("the policy is in named constants", () => {
    expect(OWNERS).toEqual(["syz51"]);
    expect(METHODS.map(([, flag]) => flag)).toEqual(["--merge", "--squash", "--rebase"]);
  });
});

// The hook spawns gh itself, so no PreToolUse hook sees its call; config.test.js pins that
// guard-pr-merge is registered only there. Were a Bash call to run the same command, the guard
// would let it through: --auto on a BLOCKED pull request whose base requires checks.
test("guard-pr-merge allows the hook's merge command", () => {
  const view = { number: 12, url: URL, state: "OPEN", isDraft: false, mergeStateStatus: "BLOCKED", baseRefName: "main", headRefOid: "abc", statusCheckRollup: [] };
  const gh = (dir, args) => {
    if (args[0] === "pr") return ok(view);
    if (args[3].includes("/rules/branches/")) return ok([]);
    if (args[3].includes("/branches/")) return ok({ protection: { required_status_checks: { enforcement_level: "everyone", contexts: ["Portable tests"] } } });
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  expect(findMergeViolation(`gh pr merge ${URL} --auto --merge`, "/repo", gh)).toBeUndefined();
});
