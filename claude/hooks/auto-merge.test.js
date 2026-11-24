import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createsPullRequest, extractMcpPullRequestUrls, METHODS, OWNERS, pullRequestUrls, report, reportMcpCreate } from "./auto-merge.js";

const HOOK = join(import.meta.dir, "auto-merge.js");
const URL = "https://github.com/syz51/dotfiles/pull/12";
const CREATE = "git push -u origin feature && gh pr create --base main --title t --body-file /tmp/b";
const ok = (value) => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const NOT_FOUND = { code: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
const VIEW = { id: "PR_node12", state: "OPEN", isDraft: false, baseRefName: "main", mergeStateStatus: "BLOCKED", autoMergeRequest: null };
const REPO = { allow_auto_merge: true, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true };
const CHECKS = { required_status_checks: { contexts: ["Portable tests"], checks: [{ context: "Portable tests" }] },
  required_pull_request_reviews: { required_approving_review_count: 0 } };

// A stubbed gh. `view`, `repo`, `protection` and `rules` override the answers (protection
// null: HTTP 404); `merge` is the auto-merge mutation's result. `calls` records each call's args.
function fakeGh({ view = {}, repo = {}, protection = CHECKS, rules = [], merge = ok({ data: {} }), calls = [] } = {}) {
  return (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") return ok({ ...VIEW, ...view });
    const path = args[3];
    if (path === "graphql") return typeof merge === "function" ? merge() : merge;
    if (path.endsWith("/protection")) return protection === null ? NOT_FOUND : typeof protection === "function" ? protection() : ok(protection);
    if (path.includes("/rules/branches/")) return ok(rules);
    if (/^repos\/[^/]+\/[^/]+$/.test(path)) return ok({ ...REPO, ...repo });
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
}

// The auto-merge mutations, as [pull request node id, merge method].
const mergeCalls = (calls) => calls.filter((args) => args[3] === "graphql").map((args) => {
  expect(args.find((arg) => arg.startsWith("query="))).toContain("enablePullRequestAutoMerge(");
  return [args.find((arg) => arg.startsWith("id=")).slice(3), args.find((arg) => arg.startsWith("method=")).slice(7)];
});
const hook = (options = {}, { command = CREATE, stdout = `${URL}\n` } = {}) => {
  const calls = [];
  const text = report(command, "/repo", stdout, fakeGh({ ...options, calls }));
  return { text, merges: mergeCalls(calls), calls };
};

describe("turns on auto-merge", () => {
  test("for a syz51 pull request whose base requires checks, with a merge commit first", () => {
    const { text, merges, calls } = hook();
    expect(merges).toEqual([["PR_node12", "MERGE"]]);
    expect(text).toContain(`${URL}: auto-merge is on (merge commit)`);
    // gh pr merge --auto would merge at once a pull request that can merge now, so the hook never runs it.
    expect(calls.filter((args) => args[0] === "pr" && args[1] === "merge")).toEqual([]);
    expect(text).toContain(`gh pr update-branch ${URL}`);
  });

  test.each([
    [{ allow_merge_commit: false }, "SQUASH"],
    [{ allow_merge_commit: false, allow_squash_merge: false }, "REBASE"],
  ])("with the first method the repository allows: %o", (repo, flag) => {
    expect(hook({ repo }).merges).toEqual([["PR_node12", flag]]);
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
    expect(merges).toHaveLength(2);
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
    ["an UNSTABLE pull request", { view: { mergeStateStatus: "UNSTABLE" } }, "it can merge now"],
    ["a HAS_HOOKS pull request", { view: { mergeStateStatus: "HAS_HOOKS" } }, "it can merge now"],
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
    ["a failed mutation", { merge: { code: 1, stdout: "", stderr: "GraphQL: Pull request is not in the correct state (enablePullRequestAutoMerge)" } }, "could not turn on auto-merge (GraphQL: Pull request is not in the correct state"],
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
      if (!first) return ok({ data: {} });
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
    expect(METHODS.map(([setting, method]) => [setting, method])).toEqual([["allow_merge_commit", "MERGE"], ["allow_squash_merge", "SQUASH"], ["allow_rebase_merge", "REBASE"]]);
  });
});

// A pull request read as UNKNOWN right after gh pr create can be CLEAN by the mutation; GitHub
// then refuses it, and the hook reports a skip, not a failure (it never merges at once).
test("a pull request that became mergeable after the read is skipped", () => {
  const merge = { code: 1, stdout: "", stderr: "GraphQL: Pull request is in clean status (enablePullRequestAutoMerge)" };
  const { text } = hook({ view: { mergeStateStatus: "UNKNOWN" }, merge });
  expect(text).toContain(`${URL}: skipped, it can merge now`);
  expect(text).not.toContain("failed");
});

describe("T3 MCP pull_request_create (dotfiles-824)", () => {
  test("extracts PR URLs from structured MCP responses, content blocks, and plain text without scanning body", () => {
    const other = "https://github.com/syz51/dotfiles/pull/99";
    expect(extractMcpPullRequestUrls({ url: URL, body: `Follow-up to ${other}` })).toEqual([URL]);
    expect(
      extractMcpPullRequestUrls([{ type: "text", text: JSON.stringify({ url: URL, body: `See ${other}` }) }]),
    ).toEqual([URL]);
    expect(
      extractMcpPullRequestUrls({ content: [{ type: "text", text: JSON.stringify({ pullRequest: { url: URL } }) }] }),
    ).toEqual([URL]);
    expect(extractMcpPullRequestUrls(`Opened ${URL} (diff: ${URL}/files)`)).toEqual([URL]);
    expect(extractMcpPullRequestUrls({ isError: true, content: [{ type: "text", text: URL }] })).toEqual([]);
    expect(extractMcpPullRequestUrls(undefined)).toEqual([]);
  });

  test("enables auto-merge for an eligible non-draft syz51 PR from toolResponse without calling gh pr view --json url", () => {
    const calls = [];
    const text = reportMcpCreate(
      { title: "Add guard", body: "desc", draft: false },
      { content: [{ type: "text", text: JSON.stringify({ url: URL, number: 12 }) }] },
      "/repo",
      fakeGh({ calls }),
    );
    expect(text).toContain(`${URL}: auto-merge is on (merge commit)`);
    expect(mergeCalls(calls)).toEqual([["PR_node12", "MERGE"]]);
    expect(calls.some((args) => args.includes("-q"))).toBe(false);
  });

  test("falls back to gh pr view --json url -q .url when toolResponse omits the URL", () => {
    const calls = [];
    const baseGh = fakeGh({ calls });
    const gh = (args) => {
      if (args[0] === "pr" && args[1] === "view" && args.includes("-q")) {
        calls.push(args);
        return ok(`${URL}\n`);
      }
      return baseGh(args);
    };
    const text = reportMcpCreate({ title: "Add guard", body: "desc" }, undefined, "/repo", gh);
    expect(text).toContain(`${URL}: auto-merge is on (merge commit)`);
    expect(mergeCalls(calls)).toEqual([["PR_node12", "MERGE"]]);
    expect(calls[0]).toEqual(["pr", "view", "--json", "url", "-q", ".url"]);
  });

  test.each([
    ["draft: true", { title: "WIP", draft: true }, { url: URL }],
    ["private: true", { title: "Internal", private: true }, { url: URL }],
    ["toolResponse.isError", { title: "Failed" }, { isError: true, content: [{ type: "text", text: URL }] }],
    ["environmentId with no URL in response", { title: "Remote", environmentId: "env-remote" }, undefined],
  ])("skips without calling gh for %s", (_, toolInput, toolResponse) => {
    const calls = [];
    expect(reportMcpCreate(toolInput, toolResponse, "/repo", fakeGh({ calls }))).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("skips non-syz51 PRs and draft PRs reported by GitHub", () => {
    const foreignUrl = "https://github.com/pingdotgg/t3code/pull/9";
    const foreignCalls = [];
    const foreignText = reportMcpCreate({ title: "Upstream" }, { url: foreignUrl }, "/repo", fakeGh({ calls: foreignCalls }));
    expect(foreignText).toContain("is not one auto-merge acts for");
    expect(foreignCalls).toEqual([]);

    const draftCalls = [];
    const draftText = reportMcpCreate({ title: "Draft on server" }, { url: URL }, "/repo", fakeGh({ view: { isDraft: true }, calls: draftCalls }));
    expect(draftText).toContain("is a draft");
    expect(mergeCalls(draftCalls)).toEqual([]);
  });

  test("reports gh pr view fallback failure without throwing", () => {
    const text = reportMcpCreate(
      { title: "Add guard" },
      undefined,
      "/repo",
      () => ({ code: 1, stdout: "", stderr: "no pull requests found for branch" }),
    );
    expect(text).toContain("auto-merge failed: gh could not read the created pull request URL");
  });

  test("the script handles mcp__t3-code__pull_request_create and skips draft/private quietly", () => {
    const draftInput = JSON.stringify({
      cwd: "/repo",
      tool_name: "mcp__t3-code__pull_request_create",
      tool_input: { title: "WIP", draft: true },
      tool_response: { url: URL },
    });
    const draftRes = spawnSync(process.execPath, [HOOK], { input: draftInput, encoding: "utf8", env: { PATH: "/nonexistent" } });
    expect(draftRes.status).toBe(0);
    expect(draftRes.stdout).toBe("");

    const liveInput = JSON.stringify({
      cwd: "/nonexistent-auto-merge-test",
      tool_name: "mcp__t3-code__pull_request_create",
      tool_input: { title: "Ship" },
      tool_response: { url: URL },
    });
    const liveRes = spawnSync(process.execPath, [HOOK], { input: liveInput, encoding: "utf8", env: { PATH: "/nonexistent" } });
    expect(liveRes.status).toBe(0);
    const out = JSON.parse(liveRes.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("auto-merge failed");
  });
});
