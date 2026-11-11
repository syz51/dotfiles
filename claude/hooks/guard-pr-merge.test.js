import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyChecks, findMergeViolation, globMatches, parseMerge, runGh } from "./guard-pr-merge.js";

const HOOK = join(import.meta.dir, "guard-pr-merge.js");

const run = (name, status, conclusion, extra = {}) => ({ __typename: "CheckRun", workflowName: "Checks", name, status, conclusion, ...extra });
const context = (name, state) => ({ __typename: "StatusContext", context: name, state });
const PASSING = [run("Portable tests", "COMPLETED", "SUCCESS")];
const VIEW = { number: 12, url: "https://github.com/o/r/pull/12", state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", baseRefName: "main", headRefOid: "abc123", statusCheckRollup: PASSING };
const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const NOT_FOUND = { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
const PROTECTED = { protection: { enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: ["Portable tests"], checks: [] } } };
const WORKFLOWS = { total_count: 1, workflows: [{ path: ".github/workflows/checks.yml", state: "active" }] };

// Actions jobs as the rollup and the GraphQL answer show them. GitHub records a job it never
// started for billing as a failed run with no steps and one annotation on .github.
const BILLING_TEXT = "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";
const job = (name, id, conclusion = "FAILURE") => run(name, "COMPLETED", conclusion, { workflowName: "Checks", detailsUrl: `https://github.com/o/r/actions/runs/7/job/${id}` });
const graphRun = (id, steps, annotations) => ({ databaseId: id, steps: { totalCount: steps }, annotations: { totalCount: annotations.length, nodes: annotations } });
const billingRun = (id) => graphRun(id, 0, [{ path: ".github", message: BILLING_TEXT }]);
const graph = (runs, slug = "github-actions") => ({ data: { repository: { object: { checkSuites: { nodes: [{ app: { slug: "vercel" }, checkRuns: { nodes: [] } }, { app: { slug }, checkRuns: { nodes: runs } }] } } } } });

// A stubbed gh. `view` overrides the pull request fields; `branch`, `rules`, `workflows` and
// `graphql` are the API answers (undefined: none). `calls` records { dir, args } for each call.
function fakeGh({ view = {}, branch, rules, workflows, graphql, calls = [] } = {}) {
  return (dir, args) => {
    calls.push({ dir, args });
    if (args[0] === "pr") return ok({ ...VIEW, ...view });
    const path = args[3];
    if (path === "graphql") {
      if (graphql === undefined) throw new Error("unexpected GraphQL call");
      return typeof graphql === "function" ? graphql() : ok(graphql);
    }
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
    // env -S puts its words first, so the words after the string are the merge's arguments (dotfiles-339)
    ["env -S 'gh pr' merge 12 -R o/r --admin", {}, "--admin bypasses"],
    ["env -S 'gh pr merge 12 -R o/r' --admin", {}, "--admin bypasses"],
    ["gh pr merge 12 --auto --admin", { branch: PROTECTED }, "--admin bypasses"],
    ["gh pr merge 12", { view: { isDraft: true } }, "is a draft"],
    // without required checks, only an update and a wait help, also for an --auto merge that just got here
    ["gh pr merge 12", { view: { mergeStateStatus: "BEHIND" } }, "is behind main. Update it first (`gh pr update-branch https://github.com/o/r/pull/12`), then wait for its checks to pass."],
    ["gh pr merge 12 --auto --squash", { view: { mergeStateStatus: "BEHIND" } }, "then wait for its checks to pass."],
    // with required checks, the refusal points at auto-merge, so an agent stops re-waiting by hand (dotfiles-282);
    // the update names the URL, so it reaches the pull request that -R chose from any directory
    ["gh pr merge 12 --squash", { view: { mergeStateStatus: "BEHIND" }, branch: PROTECTED }, "Update it first (`gh pr update-branch https://github.com/o/r/pull/12`), then, in a separate command, rerun this merge with --auto and watch the pull request; GitHub merges it once main's required checks pass."],
    ["gh pr merge 12 -R o/r --squash", { view: { mergeStateStatus: "BEHIND" }, rules: [{ type: "required_status_checks" }] }, "`gh pr update-branch https://github.com/o/r/pull/12`), then, in a separate command, rerun this merge with --auto"],
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
    ["git push && gh pr merge 12", {}, "also runs `git push`, which may push a new head"],
    ["git push -u origin feature; gh pr merge 12 --squash", {}, "also runs `git push -u origin feature`"],
    ["gh pr merge 12 && git push", {}, "also runs `git push`"],
    ["git -C /repo push & gh pr merge 12", {}, "also runs `git -C /repo push`"],
    ["bash -c 'git push' && gh pr merge 12", {}, "also runs `git push`"],
    ["GIT push && gh pr merge 12", {}, "also runs `GIT push`"],
    ["$GIT push && gh pr merge 12", {}, "also runs `$GIT push`"],
    ["git $SUB && gh pr merge 12", {}, "also runs `git $SUB`"],
    ["[g]it push && gh pr merge 12", {}, "also runs `[g]it push`"],
    // an alias, even one set with -c, may push: aliases cannot take a read-only subcommand's name
    ["git -c alias.p=push p origin HEAD && gh pr merge 12", {}, "also runs `git -c alias.p=push p origin HEAD`"],
    // a branch or pull request change makes a merge without a selector pick another pull request
    ["gh pr checkout 13 && gh pr merge --squash -d", {}, "also runs `gh pr checkout 13`"],
    ["git switch feature-b && gh pr merge --squash", {}, "also runs `git switch feature-b`"],
    ["git checkout feature-b && gh pr merge", {}, "also runs `git checkout feature-b`"],
    ["gh repo set-default o/other && gh pr merge 12", {}, "also runs `gh repo set-default o/other`"],
    ["gh pr update-branch 12 && gh pr merge 12", {}, "also runs `gh pr update-branch 12`"],
    ["gh api -X PATCH repos/o/r/git/refs/heads/x -f sha=abc; gh pr merge 12", {}, "also runs `gh api -X PATCH"],
    ["gh api repos/o/r/git/refs -f ref=refs/heads/x && gh pr merge 12", {}, "also runs `gh api repos/o/r/git/refs"],
    ["gh pr merge 12 && gh pr merge 13", {}, "runs another `gh pr merge`"],
    // GIT_DIR and GIT_WORK_TREE change the repository gh resolves
    ["GIT_DIR=/other/.git gh pr merge 12", {}, "sets GIT_DIR or GIT_WORK_TREE"],
    // a glob can name gh, its subcommand, or the selector
    ["/opt/homebrew/bin/[g]h pr merge 12 --admin", {}, "--admin bypasses"],
    ["g? pr merge 12 --admin", {}, "--admin bypasses"],
    ["gh pr m[e]rge 12 --admin", {}, "the gh pr subcommand"],
    ["gh p* merge 12", {}, "the gh subcommand"],
    ["gh pr merge 1? --squash", {}, "the shell fills in `1?`"],
    ["noglob gh pr merge 12 --admin", {}, "--admin bypasses"],
    ["nocorrect gh pr merge 12 --admin", {}, "--admin bypasses"],
    // a body the guard cannot read gets a route that works
    ["gh pr merge 12 --body 'Fixes `foo`'", {}, "pass --body-file"],
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
    ["ssh host gh pr merge 12", {}, "on another host over ssh"],
    // a directory on another host stays unknown, so the advice names -R, not a literal cd
    ["ssh host 'cd /repo && gh pr merge 12'", {}, "Pass -R OWNER/REPO"],
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
    // read-only git and gh commands in the same command
    ["git status && git log -1 && gh pr checks 12 && gh pr merge 12", {}],
    ["gh api repos/o/r/pulls/12/reviews && gh pr merge 12", {}],
    ["gh api -X GET repos/o/r/issues -f state=open && gh pr merge 12", {}],
    ["gh pr view 12 && gh pr merge 12 --squash", {}],
    // a glob that cannot match gh, and one in a body value
    ["l? && gh pr merge 12", {}],
    ["gh pr merge 12 --subject 'Fix it?'", {}],
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
    expect(classifyChecks([failed, run("t", "QUEUED", "")])).toEqual({ pending: ["Checks / t"], failed: ["Checks / t (FAILURE)"], actionsFailed: 0 });
    // runs from different workflow runs, as a push run and a pull_request run are, all count
    const pushRun = run("t", "COMPLETED", "FAILURE", { detailsUrl: "https://github.com/o/r/actions/runs/1/job/10", startedAt: "2026-11-08T10:00:00Z" });
    const prRun = run("t", "COMPLETED", "SUCCESS", { detailsUrl: "https://github.com/o/r/actions/runs/2/job/20", startedAt: "2026-11-08T11:00:00Z" });
    expect(classifyChecks([pushRun, prRun]).failed).toEqual(["Checks / t (FAILURE)"]);
  });

  // A re-run keeps the workflow run's id and adds a new attempt of each job.
  test("only the latest attempt of a job in one workflow run counts", () => {
    const attempt = (conclusion, startedAt, job, status = "COMPLETED") =>
      run("t", status, conclusion, { detailsUrl: `https://github.com/o/r/actions/runs/7/job/${job}`, startedAt });
    const first = attempt("FAILURE", "2026-11-08T10:00:00Z", 1);
    const second = attempt("SUCCESS", "2026-11-08T11:00:00Z", 2);
    expect(classifyChecks([first, second])).toEqual({ pending: [], failed: [], actionsFailed: 0 });
    expect(classifyChecks([second, first])).toEqual({ pending: [], failed: [], actionsFailed: 0 });
    expect(verdict("gh pr merge 12", { view: { statusCheckRollup: [first, second] } })).toBeUndefined();
    // a queued re-run has no start time yet, or GitHub's zero time, and is the latest
    expect(classifyChecks([first, attempt("", null, 3, "QUEUED")]).pending).toEqual(["Checks / t"]);
    expect(classifyChecks([first, attempt("", "0001-01-01T00:00:00Z", 3, "QUEUED")]).pending).toEqual(["Checks / t"]);
    // a failed re-run still fails
    expect(classifyChecks([second, attempt("FAILURE", "2026-11-08T12:00:00Z", 4)]).failed).toEqual(["Checks / t (FAILURE)"]);
  });

  test("globMatches reads zsh's *, ? and [...]", () => {
    expect(globMatches("[g]h", "gh")).toBe(true);
    expect(globMatches("G?", "gh")).toBe(true);
    expect(globMatches("*", "gh")).toBe(true);
    expect(globMatches("[!g]h", "gh")).toBe(false);
    expect(globMatches("l?", "gh")).toBe(false);
    expect(globMatches("g.", "gh")).toBe(false);
  });
});

describe("resolves the pull request", () => {
  const query = (command, cwd = "/repo") => {
    const calls = [];
    expect(findMergeViolation(command, cwd, fakeGh({ calls }))).toBeUndefined();
    return calls[0];
  };
  const json = ["--json", "number,url,state,isDraft,mergeStateStatus,baseRefName,headRefOid,statusCheckRollup"];

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
    // gh uses the last -R, which env -S puts after the string's words
    ["env -S 'gh pr merge 12 -R good/repo' -R other/repo", ["pr", "view", "12", "--repo", "other/repo", ...json]],
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

// GitHub refused both Actions jobs for billing, and another CI ran them instead.
describe("an Actions job GitHub never started for billing", () => {
  const BUILD = job("build", 11);
  const TEST = job("test", 12);
  const FALLBACKS = [context("ci/circleci: build", "SUCCESS"), context("ci/circleci: test", "SUCCESS")];
  const BOTH = graph([billingRun(11), billingRun(12)]);
  const merge = (rollup, graphql, calls) => verdict("gh pr merge 12 --merge", { view: { statusCheckRollup: rollup }, graphql, calls });
  const graphCalls = (calls) => calls.filter((call) => call.args[3] === "graphql");

  test("passes when a non-Actions check of the same job passed, after one GraphQL call on the head commit", () => {
    const calls = [];
    expect(merge([BUILD, TEST, ...FALLBACKS], BOTH, calls)).toBeUndefined();
    expect(graphCalls(calls)).toHaveLength(1);
    const { args } = graphCalls(calls)[0];
    expect(args.slice(0, 4)).toEqual(["api", "--hostname", "github.com", "graphql"]);
    expect(args).toContain("owner=o");
    expect(args).toContain("name=r");
    expect(args).toContain("oid=abc123");
    // only the Actions app's suites, in small pages, to keep the rate-limit cost low
    expect(args.find((arg) => arg.startsWith("query="))).toContain("checkSuites(first: 20, filterBy: {appId: 15368})");
    // a non-Actions check run counts as well as a status, and a pull_request run of the same workflow shares the fallback
    const prRun = run("build", "COMPLETED", "FAILURE", { workflowName: "Checks", detailsUrl: "https://github.com/o/r/actions/runs/8/job/13" });
    expect(merge([BUILD, prRun, run("ci/other: build", "COMPLETED", "SUCCESS", { workflowName: "", detailsUrl: "https://ci.example/1" })],
      graph([billingRun(11), billingRun(13)]))).toBeUndefined();
  });

  test("makes no GraphQL call unless every failed check is a failed Actions job", () => {
    const calls = [];
    expect(merge([job("build", 11, "SUCCESS"), ...FALLBACKS], undefined, calls)).toBeUndefined();
    // a failed attempt that a passing re-run replaced
    const rerun = run("build", "COMPLETED", "SUCCESS", { workflowName: "Checks", detailsUrl: "https://github.com/o/r/actions/runs/7/job/21", startedAt: "2026-11-08T11:00:00Z" });
    expect(merge([{ ...BUILD, startedAt: "2026-11-08T10:00:00Z" }, rerun], undefined, calls)).toBeUndefined();
    // the merge is refused anyway: a failed status, a failed non-Actions check run, a cancelled Actions job
    expect(merge([BUILD, ...FALLBACKS, context("ci/other", "FAILURE")], undefined, calls)).toContain("ci/other (FAILURE)");
    expect(merge([BUILD, ...FALLBACKS, run("Lint", "COMPLETED", "FAILURE", { detailsUrl: "https://ci.example/2" })], undefined, calls)).toContain("Checks / Lint (FAILURE)");
    expect(merge([BUILD, ...FALLBACKS, job("lint", 14, "CANCELLED")], undefined, calls)).toContain("Checks / lint (CANCELLED)");
    expect(graphCalls(calls)).toHaveLength(0);
  });

  test("refuses a job with steps even when its annotation carries the billing text", () => {
    // `::error file=.github,line=1::<text>` writes the same annotation from a job that ran
    const violation = merge([BUILD, ...FALLBACKS], graph([graphRun(11, 3, [{ path: ".github", message: BILLING_TEXT }])]));
    expect(violation).toContain("checks failed on pull request #12's head commit: Checks / build (FAILURE)");
  });

  test.each([
    ["has no annotation", graphRun(11, 0, [])],
    ["has another annotation", graphRun(11, 0, [{ path: ".github", message: "The workflow is not valid." }])],
    ["quotes the billing text inside another message", graphRun(11, 0, [{ path: ".github", message: `Invalid input "${BILLING_TEXT}"` }])],
    ["has the billing text on another path", graphRun(11, 0, [{ path: ".github/workflows/ci.yml", message: BILLING_TEXT }])],
    ["has a second annotation", graphRun(11, 0, [{ path: ".github", message: BILLING_TEXT }, { path: ".github", message: "other" }])],
    ["has more annotations than the call read", { ...billingRun(11), annotations: { totalCount: 3, nodes: billingRun(11).annotations.nodes } }],
    ["has no step count", { ...billingRun(11), steps: undefined }],
  ])("refuses a job that %s", (_, graphRunAnswer) => {
    expect(merge([BUILD, ...FALLBACKS], graph([graphRunAnswer]))).toContain("Checks / build (FAILURE)");
  });

  test("refuses a run that another app reports, or that the call did not return", () => {
    expect(merge([BUILD, ...FALLBACKS], graph([billingRun(11)], "some-app"))).toContain("Checks / build (FAILURE)");
    expect(merge([BUILD, ...FALLBACKS], graph([billingRun(99)]))).toContain("Checks / build (FAILURE)");
    expect(merge([BUILD, ...FALLBACKS], { data: { repository: { object: null } } })).toContain("Checks / build (FAILURE)");
  });

  test("refuses a skipped job without a passing non-Actions check of its name, and names it", () => {
    const violation = merge([BUILD, TEST, FALLBACKS[0]], BOTH);
    expect(violation).toContain("checks failed on pull request #12's head commit: Checks / test (not started for billing, and no passing non-Actions check is named \"<context>: test\")");
    expect(violation).not.toContain("/ build");
    // a failed fallback is a failed check of its own, so the guard refuses without the GraphQL call
    expect(merge([BUILD, context("ci/circleci: build", "FAILURE")])).toContain("ci/circleci: build (FAILURE)");
    // no fallback at all, a skipped one, a name that only ends the same, and an Actions job of that name
    for (const others of [[], [run("ci/x: build", "COMPLETED", "SKIPPED", { workflowName: "" })],
      [context("ci/circleci: prebuild", "SUCCESS")], [context("build", "SUCCESS")], [job("ci: build", 13, "SUCCESS")]]) {
      expect(merge([BUILD, ...others], graph([billingRun(11)]))).toContain("Checks / build (not started for billing");
    }
  });

  test("refuses skipped jobs of different workflows that share a name, since one check cannot stand for both", () => {
    const docs = run("build", "COMPLETED", "FAILURE", { workflowName: "Docs", detailsUrl: "https://github.com/o/r/actions/runs/9/job/15" });
    const violation = merge([BUILD, docs, ...FALLBACKS], graph([billingRun(11), billingRun(15)]));
    expect(violation).toContain("Checks / build (not started for billing, and a skipped job of another workflow has the same name");
    expect(violation).toContain("Docs / build (not started for billing, and a skipped job of another workflow has the same name");
  });

  test("waits while the non-Actions check of its name is pending", () => {
    expect(merge([BUILD, context("ci/circleci: build", "PENDING")], graph([billingRun(11)])))
      .toContain("checks are still running on pull request #12's head commit: ci/circleci: build.");
    expect(merge([BUILD, run("ci/other: build", "IN_PROGRESS", "", { workflowName: "", detailsUrl: "https://ci.example/3" })], graph([billingRun(11)])))
      .toContain("checks are still running on pull request #12's head commit: ci/other: build.");
  });

  test("refuses a real failed Actions job next to a skipped one", () => {
    const violation = merge([BUILD, ...FALLBACKS, job("lint", 14)], graph([billingRun(11), graphRun(14, 5, [{ path: "src/a.js", message: "lint error" }])]));
    expect(violation).toContain("Checks / lint (FAILURE)");
    expect(violation).not.toContain("/ build");
  });

  test.each([
    ["gh exits with an error", () => ({ code: 1, stdout: "", stderr: "GraphQL: Something went wrong" }), "gh could not read the failed Actions jobs' steps and annotations (GraphQL: Something went wrong)"],
    ["gh times out", () => { throw new Error("spawnSync gh ETIMEDOUT"); }, "gh could not read the failed Actions jobs' steps and annotations (spawnSync gh ETIMEDOUT)"],
    ["gh prints no JSON", () => ({ code: 0, stdout: "<html>", stderr: "" }), "not JSON when asked to read the failed Actions jobs' steps"],
  ])("refuses when %s", (_, graphql, reason) => {
    const violation = merge([BUILD, ...FALLBACKS], graphql);
    expect(violation).toContain(reason);
    expect(violation).toContain("The guard refuses a merge it cannot check");
  });

  test("refuses once the time budget is spent before the GraphQL call", () => {
    let now = 1000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const gh = (dir, args) => {
        if (args[0] === "pr") { now += 50; return ok({ ...VIEW, statusCheckRollup: [BUILD, ...FALLBACKS] }); }
        throw new Error("no call after the budget");
      };
      expect(findMergeViolation("gh pr merge 12", "/repo", gh, { budgetMs: 40 })).toContain("gh ran out of time to read the failed Actions jobs' steps and annotations.");
    } finally {
      Date.now = realNow;
    }
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

describe("xargs over ssh", () => {
  // The remote shell runs ssh's words joined, so the words xargs adds land in the merge.
  test.each([
    ["echo --admin | xargs ssh host gh pr merge 12 -R owner/repo"],
    ["echo --admin | xargs ssh host 'gh pr merge 12 -R owner/repo'"],
    ["echo --admin | xargs nice ssh host gh pr merge 12 -R owner/repo"],
    ["echo --admin | xargs ssh host bash -c \\''gh pr merge 12 -R owner/repo'\\'"],
    ["echo --admin | xargs watch gh pr merge 12 -R owner/repo"],
    ["echo --admin | xargs env -S 'gh pr merge 12 -R owner/repo'"],
    ["echo --admin | xargs env -S 'gh pr merge 12 -R owner/repo --subject' ssh"],
    ["echo --admin | xargs sudo gh pr merge 12 -R owner/repo"],
    ["echo --admin | xargs env gh pr merge 12 -R owner/repo"],
  ])("refuses %s", (command) => {
    const calls = [];
    expect(verdict(command, { calls })).toContain("xargs adds arguments");
    expect(calls).toHaveLength(0);
  });

  test("still checks a merge over ssh without xargs", () => {
    expect(verdict("ssh host gh pr merge 12 -R owner/repo", { view: { isDraft: true } })).toContain("is a draft");
  });
});

describe("commands xargs supplies or extends (dotfiles-338)", () => {
  // Each passes every check gh would answer, so only the xargs rule can refuse it.
  test.each([
    // 1: ssh and watch parse the added words again, so they can start a new command
    ["echo '; gh pr merge 12 -R o/r --admin' | xargs ssh host true", "xargs runs the words it reads"],
    ["echo '; gh pr merge 12 -R o/r --admin' | xargs watch true", "xargs runs the words it reads"],
    // 2: ssh with no host or command, and an option added after the host
    ["echo 'host gh pr merge 12 -R o/r --admin' | xargs ssh", "xargs runs the words it reads"],
    ["echo 'host gh pr merge 12 -R o/r --admin' | xargs ssh -p 22", "xargs runs the words it reads"],
    ["echo '-oProxyCommand=gh\\ pr\\ merge\\ 12\\ -R\\ o/r\\ --admin' | xargs ssh host", "xargs runs the words it reads"],
    // 3: wrappers with no command, and a shell's -c without its script
    ["echo 'gh pr merge 12 -R o/r --admin' | xargs sudo", "xargs runs the words it reads"],
    ["echo 'gh pr merge 12 -R o/r --admin' | xargs env", "xargs runs the words it reads"],
    ["echo 'gh pr merge 12 -R o/r --admin' | xargs nice", "xargs runs the words it reads"],
    ["echo 'gh pr merge 12 -R o/r --admin' | xargs bash -c", "xargs runs the words it reads"],
    ["echo 'gh pr merge 12 -R o/r --admin' | xargs xargs", "xargs runs the words it reads"],
    // 4: xargs supplies gh's subcommand, here and over ssh
    ["echo 'merge 12 -R o/r --admin' | xargs gh pr", "xargs adds arguments"],
    ["echo 'pr merge 12 -R o/r' | xargs gh", "xargs adds arguments"],
    ["echo 'merge 12 -R o/r --admin' | xargs ssh host gh pr", "xargs adds arguments"],
    // 5: find runs an -exec the added words supply
    ["echo '-exec gh pr merge 12 -R o/r --admin ;' | xargs find . -maxdepth 0", "xargs runs the words it reads"],
    // 6: a piped reader under xargs gets every line joined into one command
    ["printf 'gh pr merge 12 -R o/r\\n--admin\\n' | xargs ssh host", "xargs runs the words it reads"],
    // -I puts the input in a script or the command name
    ["echo 'gh pr merge 12 -R o/r --admin' | xargs -I{} sh -c '{}'", "xargs runs the words it reads"],
    ["echo gh | xargs -I{} {} pr merge 12 -R o/r --admin", "xargs runs the words it reads"],
    ["echo merge | xargs -I{} gh pr {} 12 -R o/r --admin", "xargs adds arguments"],
    ["echo 12 | xargs gh api -X PUT", "xargs adds arguments"],
  ])("refuses %s", (command, reason) => {
    const calls = [];
    expect(verdict(command, { calls })).toContain(reason);
    expect(calls).toHaveLength(0);
  });

  test("an added git subcommand counts as one that may move the head", () => {
    expect(verdict("echo push | xargs git; gh pr merge 12")).toContain("may push a new head");
  });

  test.each([["git ls-files | xargs grep foo"], ["ls | xargs -n1 basename"], ["find . -name x | xargs rm -f"],
    // a read-only gh subcommand stays read-only whatever words xargs adds
    ["gh pr list -q x | xargs -n1 gh pr view"], ["echo 12 | xargs gh pr checks"]])("allows %s", (command) => {
    expect(verdict(command)).toBeUndefined();
  });
});
