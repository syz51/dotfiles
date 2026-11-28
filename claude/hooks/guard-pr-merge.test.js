import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { circleciRunsOnPullRequests, classifyChecks, findMcpMergeViolation, findMergeViolation, globMatches, parseMerge, runGh, runsOnEveryPullRequest } from "./guard-pr-merge.js";

const HOOK = join(import.meta.dir, "guard-pr-merge.js");

const run = (name, status, conclusion, extra = {}) => ({ __typename: "CheckRun", workflowName: "Checks", name, status, conclusion, ...extra });
const context = (name, state) => ({ __typename: "StatusContext", context: name, state });
const PASSING = [run("Portable tests", "COMPLETED", "SUCCESS")];
const VIEW = { number: 12, url: "https://github.com/o/r/pull/12", state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", baseRefName: "main", headRefOid: "abc123", statusCheckRollup: PASSING };
const HEAD = VIEW.headRefOid;
const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const NOT_FOUND = { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
const PROTECTED = { protection: { enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: ["Portable tests"], checks: [] } } };
const WORKFLOWS = { total_count: 1, workflows: [{ path: ".github/workflows/checks.yml", state: "active" }] };

// Actions jobs as the rollup and the GraphQL answer show them. GitHub records a job it never
// started for billing as a failed run with no steps and one failure-level annotation on .github.
// It adds notices on .github to a job on a migrating runner label, such as ubuntu-latest.
const BILLING_TEXT = "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";
const job = (name, id, conclusion = "FAILURE") => run(name, "COMPLETED", conclusion, { workflowName: "Checks", detailsUrl: `https://github.com/o/r/actions/runs/7/job/${id}` });
const graphRun = (id, steps, annotations) => ({ databaseId: id, steps: { totalCount: steps }, annotations: { totalCount: annotations.length, nodes: annotations } });
const BILLING = { path: ".github", message: BILLING_TEXT, annotationLevel: "FAILURE" };
const NOTICE = { path: ".github", message: "The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026.", annotationLevel: "NOTICE" };
const billingRun = (id, ...others) => graphRun(id, 0, [BILLING, ...others]);
const graph = (runs, slug = "github-actions") => ({ data: { repository: { object: { checkSuites: { nodes: [{ app: { slug: "vercel" }, checkRuns: { nodes: [] } }, { app: { slug }, checkRuns: { nodes: runs } }] } } } } });

// The answer to the guard's GraphQL query for the CI configuration: `files` and `baseFiles` map
// each name in .github/workflows at the head commit and on the base branch to its text (an
// object: the entry itself), and `circleci` is false/null, true (an ungated config), YAML text,
// or the GraphQL blob object itself.
const CIRCLECI_DEFAULT = "version: 2.1\nworkflows:\n  build:\n    jobs: [test]\n";
const CIRCLECI_FALLBACK = [
  "version: 2.1",
  "parameters:",
  "  run-fallback:",
  "    type: boolean",
  "    default: false",
  "workflows:",
  "  github-fallback:",
  "    when: << pipeline.parameters.run-fallback >>",
  "    jobs: [ci-check]",
  "",
].join("\n");
const circleCiBlob = (circleci) => {
  if (circleci === false || circleci === null || circleci === undefined) return null;
  if (circleci === true) return { text: CIRCLECI_DEFAULT, isTruncated: false };
  if (typeof circleci === "string") return { text: circleci, isTruncated: false };
  return circleci;
};
const tree = (files) => (Object.keys(files).length === 0 ? null : { entries: Object.entries(files).map(([name, text]) =>
  (typeof text === "object" ? { name, ...text } : { name, type: "blob", object: { text, isTruncated: false } })) });
const ciFiles = ({ files = {}, baseFiles = {}, circleci = false, head = HEAD } = {}) => ({ data: { repository: {
  head: head === null ? null : { oid: head }, workflows: tree(files), baseWorkflows: tree(baseFiles),
  circleci: circleCiBlob(circleci) } } });
const isCiQuery = (args) => args.some((arg) => arg.startsWith("query=") && arg.includes("workflows: object"));
const PR_WORKFLOW = "name: Checks\non: [push, pull_request]\njobs: {}\n";

// A stubbed gh. `view` overrides the pull request fields; `branch`, `rules`, `workflows`, `ci`
// (ciFiles' options, or a function returning gh's result) and `graphql` (the failed-jobs query)
// are the API answers (undefined: none). `calls` records { dir, args } for each call.
function fakeGh({ view = {}, branch, rules, workflows, ci, graphql, calls = [] } = {}) {
  return (dir, args) => {
    calls.push({ dir, args });
    if (args[0] === "pr") return ok({ ...VIEW, ...view });
    const path = args[3];
    if (path === "graphql" && isCiQuery(args)) return typeof ci === "function" ? ci() : ok(ciFiles({ head: view.headRefOid ?? HEAD, ...ci }));
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
// A merge that passes must pin the head commit the guard judged (dotfiles-290). The cases that test
// something else pin it with this, after the first " merge".
const pinned = (command) => command.replace(" merge", ` merge --match-head-commit ${HEAD}`);

describe("refuses", () => {
  test.each([
    ["gh pr merge 12 --admin", {}, "--admin bypasses"],
    ["gh pr merge 12 --squash --admin=true", {}, "--admin bypasses"],
    // a short value flag with trailing `=` keeps `=` as its value in pflag and does not swallow the next word (dotfiles-874)
    ["gh pr merge 12 -t= --admin", {}, "--admin bypasses"],
    ["gh pr merge 12 -b= --admin", {}, "--admin bypasses"],
    ["gh pr merge 12 -R= --admin", {}, "--admin bypasses"],
    ["gh pr merge 12 -sdR= --admin", {}, "--admin bypasses"],
    ["gh pr merge 12 -A= --admin", {}, "--admin bypasses"],
    ["gh pr merge 12 -F= --admin", {}, "--admin bypasses"],
    ["gh pr merge 12 -b= --unknown-flag", {}, "does not know the option"],
    ["gh pr merge 12 -t= --unknown-flag", {}, "does not know the option"],
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
    // a non-COMPLETED run without a conclusion is still running; one with a failing conclusion counts as failed
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "IN_PROGRESS", "")] } }, "still running"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "IN_PROGRESS", null)] } }, "still running"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "QUEUED", "")] } }, "still running"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "IN_PROGRESS", "FAILURE")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "QUEUED", "CANCELLED")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "COMPLETED", "")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [...PASSING, context("ci/x", "PENDING")] } }, "still running"],
    ["gh pr merge 12", { view: { statusCheckRollup: [context("ci/x", "EXPECTED")] } }, "still running"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "COMPLETED", "FAILURE")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "COMPLETED", "CANCELLED")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "COMPLETED", "TIMED_OUT")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [run("Portable tests", "COMPLETED", "ACTION_REQUIRED")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [context("ci/x", "FAILURE")] } }, "checks failed"],
    ["gh pr merge 12", { view: { statusCheckRollup: [context("ci/x", "ERROR")] } }, "checks failed"],
    // no check yet from a workflow that runs on every pull request: CI may not have started
    ["gh pr merge 12", { view: { statusCheckRollup: [] }, ci: { files: { "checks.yml": PR_WORKFLOW } } }, 'no check yet from workflow "Checks"'],
    // --auto is a direct merge where the base branch requires no checks
    ["gh pr merge 12 --auto", { view: { statusCheckRollup: [run("Portable tests", "IN_PROGRESS", "")] } }, "still running"],
    ["gh pr merge 12 --auto", { view: { mergeStateStatus: "BLOCKED", statusCheckRollup: [run("t", "IN_PROGRESS", "")] }, branch: { protection: { required_status_checks: { enforcement_level: "off", contexts: ["x"] } } } }, "still running"],
    ["gh pr merge 12 --auto", { view: { isDraft: true, mergeStateStatus: "BLOCKED" }, branch: PROTECTED }, "is a draft"],
    // gh merges at once rather than enabling auto-merge when the pull request can merge now
    ["gh pr merge 12 --auto", { view: { mergeStateStatus: "UNSTABLE", statusCheckRollup: [...PASSING, run("Lint", "COMPLETED", "FAILURE")] }, branch: PROTECTED }, "checks failed"],
    ["gh pr merge 12 --auto", { view: { mergeStateStatus: "CLEAN", statusCheckRollup: [] }, branch: PROTECTED, ci: { files: { "checks.yml": PR_WORKFLOW } } }, "CI may not have started"],
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
    // a push before an unpinned merge moves the head after the guard reads its checks;
    // a post-merge mover passes the mover check, so an unpinned merge still fails on missing pin
    ["git push && gh pr merge 12", {}, "also runs `git push`, which may push a new head"],
    ["git push -u origin feature; gh pr merge 12 --squash", {}, "also runs `git push -u origin feature`"],
    ["gh pr merge 12 && git push", {}, "Pin the merge to that commit"],
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
    expect(findMergeViolation("gh pr merge 12", "/repo", gh)).toContain("gh could not read the CI configuration (HTTP 500)");
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
    // a check run with a passing conclusion is finished even if GitHub left status non-COMPLETED (dotfiles-360)
    ["gh pr merge 12", { view: { statusCheckRollup: [...PASSING, run("Changes", "IN_PROGRESS", "SUCCESS"), run("Docs", "QUEUED", "SKIPPED"), run("Info", "IN_PROGRESS", "NEUTRAL")] } }],
    // no checks where no CI runs on every pull request
    ["gh pr merge 12", { view: { statusCheckRollup: [] } }],
    // the Actions API lists a workflow as active that the head commit no longer has
    ["gh pr merge 12", { view: { statusCheckRollup: [] }, workflows: WORKFLOWS }],
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
    expect(verdict(pinned(command), options)).toBeUndefined();
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
    expect(verdict(pinned("gh pr merge 12"), { view: { statusCheckRollup: [first, second] } })).toBeUndefined();
    // a queued re-run has no start time yet, or GitHub's zero time, and is the latest
    expect(classifyChecks([first, attempt("", null, 3, "QUEUED")]).pending).toEqual(["Checks / t"]);
    expect(classifyChecks([first, attempt("", "0001-01-01T00:00:00Z", 3, "QUEUED")]).pending).toEqual(["Checks / t"]);
    // a failed re-run still fails
    expect(classifyChecks([second, attempt("FAILURE", "2026-11-08T12:00:00Z", 4)]).failed).toEqual(["Checks / t (FAILURE)"]);
  });

  // GitHub can leave a check run at status IN_PROGRESS after recording a final conclusion (dotfiles-360).
  test("treats a check run with a non-empty conclusion as finished regardless of status", () => {
    const stuckSuccess = run("Changes", "IN_PROGRESS", "SUCCESS", { workflowName: "CI" });
    expect(classifyChecks([...PASSING, stuckSuccess])).toEqual({ pending: [], failed: [], actionsFailed: 0 });
    expect(verdict(pinned("gh pr merge 12"), { view: { statusCheckRollup: [...PASSING, stuckSuccess] } })).toBeUndefined();
    expect(findMcpMergeViolation({ number: 12, expectedHeadSha: HEAD }, "/repo", fakeGh({ view: { statusCheckRollup: [...PASSING, stuckSuccess] } }))).toBeUndefined();

    // non-COMPLETED with FAILURE counts as failed, not running, and counts toward actionsFailed when it is an Actions job
    const stuckFail = run("Lint", "IN_PROGRESS", "FAILURE", { workflowName: "CI", detailsUrl: "https://github.com/o/r/actions/runs/7/job/31" });
    expect(classifyChecks([...PASSING, stuckFail])).toEqual({ pending: [], failed: ["CI / Lint (FAILURE)"], actionsFailed: 1 });
    const failViolation = verdict("gh pr merge 12", { view: { statusCheckRollup: [...PASSING, stuckFail] }, graphql: graph([]) });
    expect(failViolation).toContain("checks failed");
    expect(failViolation).not.toContain("still running");

    // non-COMPLETED with no conclusion still blocks as running
    for (const empty of ["", null, undefined, "   "]) {
      expect(classifyChecks([run("Changes", "IN_PROGRESS", empty, { workflowName: "CI" })])).toEqual({ pending: ["CI / Changes"], failed: [], actionsFailed: 0 });
    }

    // COMPLETED with no conclusion stays failed, not pending
    expect(classifyChecks([run("Changes", "COMPLETED", "", { workflowName: "CI" })])).toEqual({ pending: [], failed: ["CI / Changes (no conclusion)"], actionsFailed: 0 });
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
    expect(findMergeViolation(pinned(command), cwd, fakeGh({ calls }))).toBeUndefined();
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
    ["gh pr merge 12 -R=o/r", ["pr", "view", "12", "--repo", "o/r", ...json]],
    ["gh pr merge -t= 12", ["pr", "view", "12", ...json]],
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
      ["api", "--hostname", "ghe.example", "graphql", ...calls[3].args.slice(4)],
    ]);
    expect(calls[3].args).toContain("owner=team");
  });
});

// GitHub refused both Actions jobs for billing, and another CI ran them instead.
describe("an Actions job GitHub never started for billing", () => {
  const BUILD = job("build", 11);
  const TEST = job("test", 12);
  const FALLBACKS = [context("ci/circleci: build", "SUCCESS"), context("ci/circleci: test", "SUCCESS")];
  const BOTH = graph([billingRun(11), billingRun(12)]);
  const merge = (rollup, graphql, calls) => verdict(pinned("gh pr merge 12 --merge"), { view: { statusCheckRollup: rollup }, graphql, calls });
  const graphCalls = (calls) => calls.filter((call) => call.args[3] === "graphql" && !isCiQuery(call.args));

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
    const violation = merge([BUILD, ...FALLBACKS], graph([graphRun(11, 3, [BILLING])]));
    expect(violation).toContain("checks failed on pull request #12's head commit: Checks / build (FAILURE)");
    expect(merge([BUILD, ...FALLBACKS], graph([graphRun(11, 3, [BILLING, NOTICE])]))).toContain("Checks / build (FAILURE)");
  });

  test("passes a skipped job that also carries GitHub's notices on .github, and reads every annotation's level", () => {
    const calls = [];
    expect(merge([BUILD, TEST, ...FALLBACKS], graph([billingRun(11, NOTICE), billingRun(12, NOTICE, { ...NOTICE, message: "another notice" })]), calls)).toBeUndefined();
    const query = graphCalls(calls)[0].args.find((arg) => arg.startsWith("query="));
    expect(query).toContain("annotations(first: 10) { totalCount nodes { path message annotationLevel } }");
    // the notice may come first, and up to ten annotations are read
    expect(merge([BUILD, ...FALLBACKS], graph([graphRun(11, 0, [NOTICE, BILLING])]))).toBeUndefined();
    expect(merge([BUILD, ...FALLBACKS], graph([billingRun(11, ...Array(9).fill(NOTICE))]))).toBeUndefined();
  });

  test.each([
    ["has no annotation", graphRun(11, 0, [])],
    ["has another annotation", graphRun(11, 0, [{ ...BILLING, message: "The workflow is not valid." }])],
    ["quotes the billing text inside another message", graphRun(11, 0, [{ ...BILLING, message: `Invalid input "${BILLING_TEXT}"` }])],
    ["has the billing text on another path", graphRun(11, 0, [{ ...BILLING, path: ".github/workflows/ci.yml" }])],
    ["has a second annotation", billingRun(11, { ...BILLING, message: "other" })],
    ["has more annotations than the call read", { ...billingRun(11), annotations: { totalCount: 3, nodes: billingRun(11).annotations.nodes } }],
    ["has no step count", { ...billingRun(11), steps: undefined }],
    // only notices may join the billing annotation, and only on .github
    ["has only notices", graphRun(11, 0, [NOTICE])],
    ["has the billing text only as a notice", graphRun(11, 0, [{ ...BILLING, annotationLevel: "NOTICE" }, NOTICE])],
    ["has the billing text without a level", graphRun(11, 0, [{ path: ".github", message: BILLING_TEXT }])],
    ["has the billing text as a warning", graphRun(11, 0, [{ ...BILLING, annotationLevel: "WARNING" }])],
    ["has a warning next to the billing annotation", billingRun(11, { ...NOTICE, annotationLevel: "WARNING" })],
    ["has another failure next to the billing annotation", billingRun(11, NOTICE, { ...NOTICE, annotationLevel: "FAILURE" })],
    ["has the billing annotation twice", billingRun(11, BILLING)],
    ["has a notice without a level", billingRun(11, { path: ".github", message: NOTICE.message })],
    ["has a notice on another path", billingRun(11, { ...NOTICE, path: ".github/workflows/ci.yml" })],
    ["has a notice without a path", billingRun(11, { ...NOTICE, path: null })],
    ["has more notices than the call read", { ...billingRun(11, ...Array(9).fill(NOTICE)), annotations: { totalCount: 11, nodes: billingRun(11, ...Array(9).fill(NOTICE)).annotations.nodes } }],
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
    expect(violation).toContain("checks failed on pull request #12's head commit: Checks / test (not started for billing, and no passing non-Actions check is named \"<context>: test\" or passing Actions check matches \"Checks / test\")");
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
    expect(merge([BUILD, run("ci/other: build", "IN_PROGRESS", null, { workflowName: "", detailsUrl: "https://ci.example/3" })], graph([billingRun(11)])))
      .toContain("checks are still running on pull request #12's head commit: ci/other: build.");
  });

  test("applies the same finished test to billing-skipped jobs and fallback check runs (dotfiles-360)", () => {
    const stuckSkipped = run("build", "IN_PROGRESS", "FAILURE", { workflowName: "Checks", detailsUrl: "https://github.com/o/r/actions/runs/7/job/11" });
    const stuckFallbackSuccess = run("ci/other: build", "IN_PROGRESS", "SUCCESS", { workflowName: "", detailsUrl: "https://ci.example/4" });
    const stuckFallbackSkipped = run("ci/other: build", "IN_PROGRESS", "SKIPPED", { workflowName: "", detailsUrl: "https://ci.example/5" });
    const stuckFallbackFailure = run("ci/other: build", "IN_PROGRESS", "FAILURE", { workflowName: "", detailsUrl: "https://ci.example/6" });

    // billing-skipped job with non-COMPLETED status and FAILURE conclusion passes with a passing fallback
    expect(merge([stuckSkipped, FALLBACKS[0]], graph([billingRun(11)]))).toBeUndefined();
    // fallback CheckRun with non-COMPLETED status and SUCCESS conclusion counts as passed, not running
    expect(merge([BUILD, stuckFallbackSuccess], graph([billingRun(11)]))).toBeUndefined();
    expect(merge([stuckSkipped, stuckFallbackSuccess], graph([billingRun(11)]))).toBeUndefined();
    // fallback CheckRun with non-COMPLETED status and non-SUCCESS conclusion counts as finished (not running), so the skipped job fails
    expect(merge([BUILD, stuckFallbackSkipped], graph([billingRun(11)])))
      .toContain("Checks / build (not started for billing, and no passing non-Actions check is named \"<context>: build\" or passing Actions check matches \"Checks / build\")");
    expect(classifyChecks([BUILD, stuckFallbackFailure], new Set(["11"]))).toEqual({
      pending: [],
      failed: [
        "Checks / build (not started for billing, and no passing non-Actions check is named \"<context>: build\" or passing Actions check matches \"Checks / build\")",
        "ci/other: build (FAILURE)",
      ],
      actionsFailed: 0,
    });
  });

  // Tier-3 workflow_dispatch runs the same workflow and job names on self-hosted runners (dotfiles-938).
  describe("Actions workflow_dispatch fallback with matching (workflowName, name) (dotfiles-938)", () => {
    const dispatchJob = (name, id, conclusion = "SUCCESS", { workflowName = "Checks", runId = 8, status = "COMPLETED", ...extra } = {}) =>
      run(name, status, conclusion, { workflowName, detailsUrl: `https://github.com/o/r/actions/runs/${runId}/job/${id}`, ...extra });

    test("allows merge when a billing-skipped CheckRun has a passing Actions CheckRun with matching workflowName and name", () => {
      const dispatchBuild = dispatchJob("build", 21, "SUCCESS");
      const dispatchTest = dispatchJob("test", 22, "SUCCESS");
      expect(classifyChecks([BUILD, dispatchBuild], new Set(["11"]))).toEqual({ pending: [], failed: [], actionsFailed: 0 });
      expect(merge([BUILD, TEST, dispatchBuild, dispatchTest], BOTH)).toBeUndefined();
      // Stuck-status SUCCESS conclusion on the workflow_dispatch CheckRun counts as passed too
      const stuckDispatch = dispatchJob("build", 23, "SUCCESS", { status: "IN_PROGRESS" });
      expect(merge([BUILD, stuckDispatch], graph([billingRun(11)]))).toBeUndefined();
      // MCP pull_request_merge shares the same fallback check
      expect(findMcpMergeViolation(
        { number: 12, expectedHeadSha: HEAD },
        "/repo",
        fakeGh({ view: { statusCheckRollup: [BUILD, dispatchBuild] }, graphql: graph([billingRun(11)]) }),
      )).toBeUndefined();
      // If one job lacks a fallback, only that job is reported as failed
      const partial = merge([BUILD, TEST, dispatchBuild], BOTH);
      expect(partial).toContain("Checks / test (not started for billing");
      expect(partial).not.toContain("/ build");
    });

    test("blocks when the matching Actions CheckRun is still pending or failed or non-SUCCESS", () => {
      // Pending workflow_dispatch runs block with "still running"
      for (const pending of [
        dispatchJob("build", 21, "", { status: "IN_PROGRESS" }),
        dispatchJob("build", 21, null, { status: "QUEUED" }),
      ]) {
        expect(classifyChecks([BUILD, pending], new Set(["11"]))).toEqual({ pending: ["Checks / build"], failed: [], actionsFailed: 0 });
        expect(merge([BUILD, pending], graph([billingRun(11)])))
          .toContain("checks are still running on pull request #12's head commit: Checks / build.");
      }

      // Failing workflow_dispatch runs stay blocked
      for (const failed of [
        dispatchJob("build", 21, "FAILURE"),
        dispatchJob("build", 21, "CANCELLED"),
        dispatchJob("build", 21, "TIMED_OUT"),
        dispatchJob("build", 21, "FAILURE", { status: "IN_PROGRESS" }),
      ]) {
        const result = classifyChecks([BUILD, failed], new Set(["11"]));
        expect(result.failed).toHaveLength(2);
        expect(result.failed[0]).toContain("Checks / build (not started for billing");
        expect(result.failed[1]).toBe(`Checks / build (${failed.conclusion})`);
        expect(merge([BUILD, failed], graph([billingRun(11)]))).toContain(`Checks / build (${failed.conclusion})`);
      }

      // SKIPPED or NEUTRAL Actions runs did not run the checks and do not satisfy a billing-skipped job
      for (const conclusion of ["SKIPPED", "NEUTRAL"]) {
        const nonPassing = dispatchJob("build", 21, conclusion);
        expect(classifyChecks([BUILD, nonPassing], new Set(["11"])).failed)
          .toEqual(["Checks / build (not started for billing, and no passing non-Actions check is named \"<context>: build\" or passing Actions check matches \"Checks / build\")"]);
        expect(merge([BUILD, nonPassing], graph([billingRun(11)]))).toContain("Checks / build (not started for billing");
      }

      // Another billing-skipped job of the same (workflowName, name) does not satisfy itself or its peer
      const secondSkipped = dispatchJob("build", 21, "FAILURE", { runId: 9 });
      expect(merge([BUILD, secondSkipped], graph([billingRun(11), billingRun(21)]))).toContain("Checks / build (not started for billing");
    });

    test("blocks when the passing CheckRun has a different workflowName, a different name, or is not an Actions CheckRun", () => {
      const differentWorkflow = dispatchJob("build", 21, "SUCCESS", { workflowName: "Other Workflow" });
      const differentName = dispatchJob("lint", 21, "SUCCESS", { workflowName: "Checks" });
      const nonActionsSameFields = run("build", "COMPLETED", "SUCCESS", { workflowName: "Checks", detailsUrl: "https://ci.example/1" });
      for (const other of [differentWorkflow, differentName, nonActionsSameFields]) {
        expect(classifyChecks([BUILD, other], new Set(["11"])).failed)
          .toEqual(["Checks / build (not started for billing, and no passing non-Actions check is named \"<context>: build\" or passing Actions check matches \"Checks / build\")"]);
        expect(merge([BUILD, other], graph([billingRun(11)]))).toContain("Checks / build (not started for billing");
      }
      // A billing-skipped check without workflowName does not match another check lacking workflowName
      const noWorkflowSkipped = run("build", "COMPLETED", "FAILURE", { workflowName: "", detailsUrl: "https://github.com/o/r/actions/runs/7/job/11" });
      const noWorkflowPass = dispatchJob("build", 21, "SUCCESS", { workflowName: "" });
      expect(classifyChecks([noWorkflowSkipped, noWorkflowPass], new Set(["11"])).failed[0]).toContain("not started for billing");
    });

    test("keeps non-billing FAILURE CheckRuns strictly blocked even with a passing same-(workflowName, name) CheckRun", () => {
      const dispatchBuild = dispatchJob("build", 21, "SUCCESS");
      // Direct classifyChecks with empty billingSkipped
      expect(classifyChecks([BUILD, dispatchBuild])).toEqual({
        pending: [],
        failed: ["Checks / build (FAILURE)"],
        actionsFailed: 1,
      });
      // End-to-end: failed job ran steps, so GraphQL does not mark it billingSkipped
      expect(merge([BUILD, dispatchBuild], graph([graphRun(11, 3, [BILLING])]))).toContain("Checks / build (FAILURE)");
      // End-to-end: failed job had a non-billing failure annotation
      expect(merge([BUILD, dispatchBuild], graph([graphRun(11, 0, [{ path: ".github", message: "The workflow is not valid.", annotationLevel: "FAILURE" }])])))
        .toContain("Checks / build (FAILURE)");
      // A real failed workflow_dispatch alongside a billing-skipped PR run and a later passing dispatch run still blocks
      const realFailedDispatch = dispatchJob("build", 20, "FAILURE", { runId: 8 });
      const passingDispatch = dispatchJob("build", 21, "SUCCESS", { runId: 9 });
      expect(merge([BUILD, realFailedDispatch, passingDispatch], graph([billingRun(11), graphRun(20, 2, [{ path: "src/a.js", message: "test failed", annotationLevel: "FAILURE" }])])))
        .toContain("Checks / build (FAILURE)");
    });

    test("resolves ambiguous job names across workflows using exact (workflowName, name) Actions fallbacks", () => {
      const docsSkipped = run("build", "COMPLETED", "FAILURE", { workflowName: "Docs", detailsUrl: "https://github.com/o/r/actions/runs/9/job/15" });
      const checksDispatch = dispatchJob("build", 21, "SUCCESS", { workflowName: "Checks", runId: 10 });
      const docsDispatch = dispatchJob("build", 22, "SUCCESS", { workflowName: "Docs", runId: 11 });
      // Both workflows covered by their own matching Actions fallbacks -> allowed
      expect(merge([BUILD, docsSkipped, checksDispatch, docsDispatch], graph([billingRun(11), billingRun(15)]))).toBeUndefined();
      // Only Checks covered by Actions fallback; non-Actions ci/circleci: build still cannot disambiguate Docs / build
      const partial = merge([BUILD, docsSkipped, checksDispatch, FALLBACKS[0]], graph([billingRun(11), billingRun(15)]));
      expect(partial).toContain("Docs / build (not started for billing, and a skipped job of another workflow has the same name");
      expect(partial).not.toContain("Checks / build");
    });

    test("uses only the latest attempt of a workflow_dispatch run as the fallback", () => {
      const failedAttempt = dispatchJob("build", 21, "FAILURE", { runId: 8, startedAt: "2026-11-28T10:00:00Z" });
      const passedRerun = dispatchJob("build", 22, "SUCCESS", { runId: 8, startedAt: "2026-11-28T11:00:00Z" });
      expect(merge([BUILD, failedAttempt, passedRerun], graph([billingRun(11)]))).toBeUndefined();

      const passedFirst = dispatchJob("build", 21, "SUCCESS", { runId: 8, startedAt: "2026-11-28T10:00:00Z" });
      const failedRerun = dispatchJob("build", 22, "FAILURE", { runId: 8, startedAt: "2026-11-28T11:00:00Z" });
      expect(merge([BUILD, passedFirst, failedRerun], graph([billingRun(11)]))).toContain("Checks / build (FAILURE)");
    });
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

// The guard expects a check from each workflow at the head commit that runs on every pull
// request, and from CircleCI where it is configured (dotfiles-291).
describe("CI that runs on every pull request", () => {
  test.each([
    ["pull_request", true],
    ["pull_request_target", true],
    ["push", false],
    [["push", "pull_request"], true],
    [["push", "schedule"], false],
    [{ pull_request: null }, true],
    [{ pull_request: {} }, true],
    [{ pull_request_target: null, push: { branches: ["main"] } }, true],
    // a filter the guard does not evaluate: the workflow may not run on a given pull request
    [{ pull_request: { paths: ["src/**"] } }, false],
    [{ pull_request: { "paths-ignore": ["docs/**"] } }, false],
    [{ pull_request: { branches: ["main"] } }, false],
    [{ pull_request: { "branches-ignore": ["dev"] } }, false],
    [{ pull_request: { types: ["opened"] } }, false],
    [{ pull_request: { types: ["opened"] }, pull_request_target: null }, true],
    // marketing-frontend's shape: dispatch only, and dispatch with tag pushes
    [{ workflow_dispatch: null }, false],
    [{ workflow_dispatch: null, push: { tags: ["v*"] } }, false],
    [{ schedule: [{ cron: "0 0 * * *" }] }, false],
    [{ workflow_call: null }, false],
    [{ pull_request: ["opened"] }, false],
    [null, false],
    [undefined, false],
  ])("on: %j runs on every pull request: %p", (on, expected) => {
    expect(runsOnEveryPullRequest(on)).toBe(expected);
  });

  const merge = (options) => verdict(pinned("gh pr merge 12"), options);
  const CHECKS = run("test", "COMPLETED", "SUCCESS", { workflowName: "Checks" });

  test.each([
    ["no checks yet", [], { "checks.yml": PR_WORKFLOW }, 'workflow "Checks"'],
    // a fast third-party status passed before the Actions runs appeared
    ["only a third-party status", [context("license/cla", "SUCCESS")], { "checks.yml": PR_WORKFLOW }, 'workflow "Checks"'],
    ["a run of another workflow only", [run("lint", "COMPLETED", "SUCCESS", { workflowName: "Lint" })], { "checks.yml": PR_WORKFLOW }, 'workflow "Checks"'],
    ["a workflow without a name, named by its path", [], { "ci.yaml": "on:\n  pull_request:\n" }, 'workflow ".github/workflows/ci.yaml"'],
    // two workflows share a name, and only one has a workflow run
    ["one run for two workflows of the same name", [CHECKS], { "a.yml": PR_WORKFLOW, "b.yml": PR_WORKFLOW }, 'workflow "Checks"'],
    ["two missing workflows", [], { "a.yml": "name: A\non: pull_request\n", "b.yml": "name: B\non: [pull_request]\n" }, 'workflow "A", workflow "B"'],
  ])("refuses with %s", (_, rollup, files, missing) => {
    expect(merge({ view: { statusCheckRollup: rollup }, ci: { files } })).toContain(`pull request #12's head commit has no check yet from ${missing}, which run on every pull request`);
  });

  // GitHub runs pull_request_target workflows from the base branch, not the head commit.
  test("expects pull_request_target workflows from the base branch, and pull_request ones from the head commit", () => {
    const target = "name: Target\non: pull_request_target\n";
    expect(merge({ view: { statusCheckRollup: [] }, ci: { baseFiles: { "t.yml": target } } })).toContain('no check yet from workflow "Target"');
    expect(merge({ view: { statusCheckRollup: [] }, ci: { files: { "t.yml": target } } })).toBeUndefined();
    expect(merge({ view: { statusCheckRollup: [] }, ci: { baseFiles: { "checks.yml": PR_WORKFLOW } } })).toBeUndefined();
    expect(merge({ view: { statusCheckRollup: [] }, ci: { baseFiles: { "t.yml": "on: [pull_request_target\n" } } })).toContain(".github/workflows/t.yml on main does not parse as YAML");
  });

  test("keeps expecting a workflow that Actions lists as active", () => {
    const workflows = { workflows: [{ path: ".github/workflows/checks.yml", state: "active" }] };
    expect(merge({ view: { statusCheckRollup: [] }, ci: { files: { "checks.yml": PR_WORKFLOW } }, workflows })).toContain('workflow "Checks"');
  });

  test("refuses when CircleCI is configured and has not reported, also with only a CircleCI check run", () => {
    for (const rollup of [[], [CHECKS], [run("ci/circleci: build", "COMPLETED", "SUCCESS", { workflowName: undefined })]]) {
      expect(merge({ view: { statusCheckRollup: rollup }, ci: { circleci: true } })).toContain("no check yet from CircleCI");
    }
    expect(merge({ view: { statusCheckRollup: [] }, ci: { circleci: true, files: { "checks.yml": PR_WORKFLOW } } })).toContain('workflow "Checks", CircleCI');
  });

  test.each([
    ["the workflow file does not parse", { "checks.yml": "on: [pull_request\n" }, ".github/workflows/checks.yml at the head commit does not parse as YAML"],
    ["the workflow file is not a mapping", { "checks.yml": "- pull_request\n" }, ".github/workflows/checks.yml at the head commit is not a YAML mapping"],
    ["the workflow file is truncated", { "checks.yml": { type: "blob", object: { text: "on: push", isTruncated: true } } }, "gh could not read the text of .github/workflows/checks.yml"],
    ["the workflow file is binary", { "checks.yml": { type: "blob", object: { text: null, isTruncated: false } } }, "gh could not read the text of .github/workflows/checks.yml"],
  ])("refuses when %s", (_, files, reason) => {
    const violation = merge({ ci: { files } });
    expect(violation).toContain(reason);
    expect(violation).toContain("The guard refuses a merge it cannot check");
  });

  test.each([
    ["the query fails", () => ({ code: 1, stdout: "", stderr: "GraphQL: Something went wrong" }), "gh could not read the CI configuration (GraphQL: Something went wrong)"],
    ["the query times out", () => { throw new Error("spawnSync gh ETIMEDOUT"); }, "gh could not read the CI configuration (spawnSync gh ETIMEDOUT)"],
    ["the head commit is not found", () => ok(ciFiles({ head: null })), "gh could not find the head commit abc123"],
  ])("refuses when %s", (_, ci, reason) => {
    expect(merge({ ci })).toContain(reason);
  });

  test.each([
    ["no CI configuration", [], {}],
    ["dispatch, push, schedule, tag and reusable workflows only", [], {
      "ci.yml": "on:\n  workflow_dispatch:\n", "image.yml": "on:\n  workflow_dispatch:\n  push:\n    tags:\n      - v*\n",
      "nightly.yml": "on:\n  schedule:\n    - cron: '0 3 * * *'\n", "main.yml": "on:\n  push:\n    branches: [main]\n", "reuse.yml": "on: workflow_call\n" }],
    ["workflows with filtered pull request triggers", [], { "docs.yml": "on:\n  pull_request:\n    paths: [docs/**]\n", "rel.yml": "on:\n  pull_request:\n    branches: [release]\n" }],
    ["a check from the workflow", [CHECKS], { "checks.yml": PR_WORKFLOW }],
    ["a check from the workflow named by its path", [run("t", "COMPLETED", "SUCCESS", { workflowName: ".github/workflows/ci.yml" })], { "ci.yml": "on: pull_request\n" }],
    // GitHub runs only YAML files directly in .github/workflows
    ["files GitHub does not run", [], { "README.md": "on: pull_request\n", "ci.yml.disabled": "on: pull_request\n", nested: { type: "tree", object: {} } }],
  ])("passes with %s", (_, rollup, files) => {
    const calls = [];
    expect(verdict(pinned("gh pr merge 12"), { view: { statusCheckRollup: rollup }, ci: { files }, calls })).toBeUndefined();
    // one added call: the CI configuration query, and no workflow list
    expect(calls.map((call) => (call.args[0] === "pr" ? "pr" : call.args[3]))).toEqual(["pr", "graphql"]);
    expect(calls[1].args).toContain("oid=abc123");
    expect(calls[1].args).toContain("circleci=abc123:.circleci/config.yml");
    expect(calls[1].args).toContain("baseWorkflows=main:.github/workflows");
  });

  test("passes when CircleCI reported a status, or a check run through its GitHub App", () => {
    expect(merge({ view: { statusCheckRollup: [context("ci/circleci: build", "SUCCESS")] }, ci: { circleci: true } })).toBeUndefined();
    const app = run("build", "COMPLETED", "SUCCESS", { workflowName: "", detailsUrl: "https://app.circleci.com/pipelines/gh/o/r/1/workflows/w/jobs/1" });
    expect(merge({ view: { statusCheckRollup: [app] }, ci: { circleci: true } })).toBeUndefined();
    // even if .circleci/config.yml is truncated, a passing CircleCI check already satisfies the guard
    expect(merge({ view: { statusCheckRollup: [context("ci/circleci: build", "SUCCESS")] }, ci: { circleci: { text: "", isTruncated: true } } })).toBeUndefined();
  });

  // On-demand fallback configs like syz51/email-agent gate every workflow off by default (board-feedback-1237).
  describe("CircleCI opt-in fallback evaluation", () => {
    test.each([
      ["absent blob", null, false],
      ["email-agent on-demand fallback", CIRCLECI_FALLBACK, false],
      ["no spaces inside parameter brackets", "version: 2.1\nparameters:\n  run-fallback:\n    type: boolean\n    default: false\nworkflows:\n  fb:\n    when: <<pipeline.parameters.run-fallback>>\n    jobs: [test]\n", false],
      ["literal when: false", "version: 2.1\nworkflows:\n  off:\n    when: false\n    jobs: [test]\n", false],
      ["when: and with a false term and a dynamic branch term", "version: 2.1\nparameters:\n  run-fallback:\n    type: boolean\n    default: false\nworkflows:\n  fb:\n    when:\n      and:\n        - << pipeline.parameters.run-fallback >>\n        - equal: [main, << pipeline.git.branch >>]\n    jobs: [test]\n", false],
      ["when: equal false against string default", "version: 2.1\nparameters:\n  mode:\n    type: string\n    default: off\nworkflows:\n  fb:\n    when:\n      equal: [fallback, << pipeline.parameters.mode >>]\n    jobs: [test]\n", false],
      ["when: equal false against enum default", "version: 2.1\nparameters:\n  mode:\n    type: enum\n    enum: [off, fallback]\n    default: off\nworkflows:\n  fb:\n    when:\n      equal: [fallback, << pipeline.parameters.mode >>]\n    jobs: [test]\n", false],
      ["when: equal false against integer default", "version: 2.1\nparameters:\n  level:\n    type: integer\n    default: 0\nworkflows:\n  fb:\n    when:\n      equal: [1, << pipeline.parameters.level >>]\n    jobs: [test]\n", false],
      ["when: or of false terms", "version: 2.1\nparameters:\n  a:\n    type: boolean\n    default: false\nworkflows:\n  fb:\n    when:\n      or:\n        - false\n        - << pipeline.parameters.a >>\n    jobs: [test]\n", false],
      ["when: not true", "version: 2.1\nparameters:\n  skip:\n    type: boolean\n    default: true\nworkflows:\n  fb:\n    when:\n      not: << pipeline.parameters.skip >>\n    jobs: [test]\n", false],
      ["unless: true", "version: 2.1\nparameters:\n  skip:\n    type: boolean\n    default: true\nworkflows:\n  fb:\n    unless: << pipeline.parameters.skip >>\n    jobs: [test]\n", false],
      ["unless: not default-false parameter", "version: 2.1\nparameters:\n  run-fallback:\n    type: boolean\n    default: false\nworkflows:\n  fb:\n    unless:\n      not: << pipeline.parameters.run-fallback >>\n    jobs: [test]\n", false],
      ["workflows.version ignored alongside gated workflows", "version: 2.1\nparameters:\n  a:\n    type: boolean\n    default: false\nworkflows:\n  version: 2\n  fb1:\n    when: << pipeline.parameters.a >>\n    jobs: [a]\n  fb2:\n    when: false\n    jobs: [b]\n", false],
      // normal / active configs must continue expecting CircleCI
      ["ungated workflow", CIRCLECI_DEFAULT, true],
      ["default-true parameter", "version: 2.1\nparameters:\n  run-ci:\n    type: boolean\n    default: true\nworkflows:\n  ci:\n    when: << pipeline.parameters.run-ci >>\n    jobs: [test]\n", true],
      ["mixed gated and ungated workflows", "version: 2.1\nparameters:\n  run-fallback:\n    type: boolean\n    default: false\nworkflows:\n  fallback:\n    when: << pipeline.parameters.run-fallback >>\n    jobs: [a]\n  always:\n    jobs: [b]\n", true],
      ["when: equal true", "version: 2.1\nparameters:\n  mode:\n    type: string\n    default: ci\nworkflows:\n  ci:\n    when:\n      equal: [ci, << pipeline.parameters.mode >>]\n    jobs: [test]\n", true],
      ["when: or with dynamic term", "version: 2.1\nparameters:\n  run-fallback:\n    type: boolean\n    default: false\nworkflows:\n  ci:\n    when:\n      or:\n        - << pipeline.parameters.run-fallback >>\n        - equal: [main, << pipeline.git.branch >>]\n    jobs: [test]\n", true],
      ["unless: false", "version: 2.1\nworkflows:\n  ci:\n    unless: false\n    jobs: [test]\n", true],
      // fail-closed cases
      ["truncated blob", { text: CIRCLECI_FALLBACK, isTruncated: true }, true],
      ["binary / null text blob", { text: null, isTruncated: false }, true],
      ["non-blob object without text", { oid: "c1" }, true],
      ["invalid YAML", "workflows: [\n", true],
      ["non-mapping YAML", "- workflows\n", true],
      ["legacy v2.0 config without workflows", "version: 2\njobs:\n  build:\n    docker: [{ image: cimg/base:stable }]\n", true],
      ["empty workflows with version only", "version: 2.1\nworkflows:\n  version: 2\n", true],
      ["undeclared parameter", "version: 2.1\nworkflows:\n  fb:\n    when: << pipeline.parameters.missing >>\n    jobs: [test]\n", true],
      ["parameter without default", "version: 2.1\nparameters:\n  run-fallback:\n    type: boolean\nworkflows:\n  fb:\n    when: << pipeline.parameters.run-fallback >>\n    jobs: [test]\n", true],
      ["parameter default type mismatch", "version: 2.1\nparameters:\n  run-fallback:\n    type: boolean\n    default: 'false'\nworkflows:\n  fb:\n    when: << pipeline.parameters.run-fallback >>\n    jobs: [test]\n", true],
      ["string parameter in boolean when position", "version: 2.1\nparameters:\n  empty:\n    type: string\n    default: ''\nworkflows:\n  fb:\n    when: << pipeline.parameters.empty >>\n    jobs: [test]\n", true],
      ["unknown when operator (matches)", "version: 2.1\nworkflows:\n  fb:\n    when:\n      matches:\n        pattern: '^release$'\n        value: << pipeline.git.branch >>\n    jobs: [test]\n", true],
      ["both when and unless present", "version: 2.1\nworkflows:\n  fb:\n    when: false\n    unless: true\n    jobs: [test]\n", true],
      ["non-mapping parameters", "version: 2.1\nparameters: [bad]\nworkflows:\n  fb:\n    when: false\n    jobs: [test]\n", true],
      ["empty file", "", true],
      ["when nesting exceeding depth limit", `version: 2.1\nworkflows:\n  fb:\n    when: ${"{ not: ".repeat(22)}false${" }".repeat(22)}\n    jobs: [test]\n`, true],
    ])("%s -> expects CircleCI: %p", (_, input, expected) => {
      const blob = input === null ? null : typeof input === "string" ? { text: input, isTruncated: false } : input;
      expect(circleciRunsOnPullRequests(blob)).toBe(expected);
    });

    test("allows merge when CircleCI only has an opt-in fallback workflow and Actions checks pass", () => {
      const calls = [];
      expect(verdict(pinned("gh pr merge 12"), {
        view: { statusCheckRollup: [CHECKS] },
        ci: { files: { "checks.yml": PR_WORKFLOW }, circleci: CIRCLECI_FALLBACK },
        calls,
      })).toBeUndefined();
      const ciQuery = calls[1].args.find((arg) => arg.startsWith("query="));
      expect(ciQuery).toContain("circleci: object(expression: $circleci) { ... on Blob { text isTruncated } }");
      // MCP pull_request_merge shares the same logic
      expect(findMcpMergeViolation(
        { number: 12, expectedHeadSha: HEAD },
        "/repo",
        fakeGh({ view: { statusCheckRollup: [CHECKS] }, ci: { files: { "checks.yml": PR_WORKFLOW }, circleci: CIRCLECI_FALLBACK } }),
      )).toBeUndefined();
    });

    test.each([
      ["normal ungated workflow", CIRCLECI_DEFAULT],
      ["default-true parameter", "version: 2.1\nparameters:\n  run-ci:\n    type: boolean\n    default: true\nworkflows:\n  ci:\n    when: << pipeline.parameters.run-ci >>\n    jobs: [test]\n"],
      ["mixed gated and ungated workflows", "version: 2.1\nparameters:\n  run-fallback:\n    type: boolean\n    default: false\nworkflows:\n  fallback:\n    when: << pipeline.parameters.run-fallback >>\n    jobs: [a]\n  always:\n    jobs: [b]\n"],
      ["truncated config", { text: CIRCLECI_FALLBACK, isTruncated: true }],
      ["empty config file", ""],
      ["invalid YAML", "workflows: [\n"],
      ["unknown when expression", "version: 2.1\nworkflows:\n  ci:\n    when: << pipeline.git.branch >>\n    jobs: [test]\n"],
    ])("blocks merge until CircleCI reports for %s", (_, circleci) => {
      expect(merge({ view: { statusCheckRollup: [CHECKS] }, ci: { files: { "checks.yml": PR_WORKFLOW }, circleci } }))
        .toContain("no check yet from CircleCI");
    });
  });

  test("passes two workflows of the same name once each has a workflow run", () => {
    const rollup = [job("test", 1, "SUCCESS"), { ...job("test", 2, "SUCCESS"), detailsUrl: "https://github.com/o/r/actions/runs/8/job/2" }];
    expect(merge({ view: { statusCheckRollup: rollup }, ci: { files: { "a.yml": PR_WORKFLOW, "b.yml": PR_WORKFLOW } } })).toBeUndefined();
  });

  test("does not expect a workflow that Actions lists as disabled", () => {
    const calls = [];
    const workflows = { workflows: [{ path: ".github/workflows/checks.yml", state: "disabled_manually" }] };
    expect(verdict(pinned("gh pr merge 12"), { view: { statusCheckRollup: [] }, ci: { files: { "checks.yml": PR_WORKFLOW } }, workflows, calls })).toBeUndefined();
    expect(calls.at(-1).args[3]).toBe("repos/o/r/actions/workflows?per_page=100");
  });

  test("waits for pending and failed checks before reading the CI configuration", () => {
    const calls = [];
    expect(verdict(pinned("gh pr merge 12"), { view: { statusCheckRollup: [run("t", "QUEUED", "")] }, calls })).toContain("still running");
    expect(calls).toHaveLength(1);
  });
});

test("parseMerge reads short option groups and values", () => {
  expect(parseMerge(["-sdR", "o/r", "12"])).toMatchObject({ repo: "o/r", selector: "12", admin: false });
  expect(parseMerge(["-b", "--admin", "12"])).toMatchObject({ admin: false, selector: "12" });
  expect(parseMerge(["12", "-t=", "--admin"])).toMatchObject({ selector: "12", admin: true, unknown: undefined });
  expect(parseMerge(["12", "-b=", "--unknown-flag"])).toMatchObject({ selector: "12", unknown: "--unknown-flag" });
  expect(parseMerge(["12", "-R=", "--admin"])).toMatchObject({ selector: "12", repo: "=", admin: true });
  expect(parseMerge(["-sdR=", "--admin", "12"])).toMatchObject({ selector: "12", repo: "=", admin: true });
  expect(parseMerge(["12", "-R=o/r"])).toMatchObject({ selector: "12", repo: "o/r" });
  expect(parseMerge(["12", "-R==o/r"])).toMatchObject({ selector: "12", repo: "=o/r" });
  expect(parseMerge(["12", "-t=", "--match-head-commit", "abc"])).toMatchObject({ selector: "12", matchHead: "abc" });
  expect(parseMerge(["-t=", "12"])).toMatchObject({ selector: "12", selectorIndex: 1 });
  expect(parseMerge(["--auto=false", "12"])).toMatchObject({ auto: false });
  expect(parseMerge(["12", "--match-head-commit", "abc"])).toMatchObject({ matchHead: "abc", selector: "12" });
  expect(parseMerge(["--match-head-commit=abc", "12"])).toMatchObject({ matchHead: "abc", selector: "12" });
});

// GitHub refuses a merge whose --match-head-commit is not the head, so a push after the check
// cannot merge on the checks of the commit before (dotfiles-290).
describe("pins the merge to the head commit it checked", () => {
  test.each([
    [`gh pr merge 12 --squash --match-head-commit ${HEAD}`, {}],
    [`gh pr merge 12 --squash --match-head-commit=${HEAD}`, {}],
    [`gh pr merge 12 -t= --match-head-commit ${HEAD}`, {}],
    [`cd /other && gh pr merge 12 -R o/r --match-head-commit ${HEAD} --delete-branch`, {}],
    // GitHub waits for the required checks of whatever head it merges, so this --auto needs no pin
    ["gh pr merge 12 --auto --squash", { branch: PROTECTED, view: { mergeStateStatus: "BLOCKED" } }],
    // these merge nothing now
    ["gh pr merge 12 --disable-auto", {}],
    ["gh pr merge --help", {}],
    ["gh pr merge 12", { view: { state: "MERGED", mergeStateStatus: "UNKNOWN" } }],
  ])("allows %s", (command, options) => {
    expect(verdict(command, options)).toBeUndefined();
  });

  test("refuses a merge without a pin, and names the SHA and the command to rerun", () => {
    expect(verdict("gh pr merge 12 --squash")).toBe("`gh pr merge 12 --squash`: the checks passed on pull request #12's head commit abc123. "
      + "Pin the merge to that commit, so GitHub refuses it if the head moves: `gh pr merge https://github.com/o/r/pull/12 --match-head-commit abc123 --squash`.");
    // an --auto merge that the guard checks like a direct merge
    expect(verdict("gh pr merge 12 --auto --squash")).toContain("`gh pr merge https://github.com/o/r/pull/12 --match-head-commit abc123 --auto --squash`");
    expect(verdict("gh pr merge 12 --auto", { branch: PROTECTED })).toContain("--match-head-commit abc123");
    // the rerun command quotes a word with spaces or quotes
    expect(verdict("gh pr merge 12 -t \"it's done\" -b 'a body'")).toContain("`gh pr merge https://github.com/o/r/pull/12 --match-head-commit abc123 -t 'it'\\''s done' -b 'a body'`");
  });

  // A `cd`, `ssh` or the current branch chose the pull request; the URL names it from any directory.
  test.each([
    ["cd /other && gh pr merge 12 --squash", "`gh pr merge https://github.com/o/r/pull/12 --match-head-commit abc123 --squash`"],
    ["gh pr merge --squash", "`gh pr merge https://github.com/o/r/pull/12 --match-head-commit abc123 --squash`"],
    ["gh pr merge", "`gh pr merge https://github.com/o/r/pull/12 --match-head-commit abc123`"],
    ["gh -R o/r pr merge -b body -- 12", "`gh -R o/r pr merge https://github.com/o/r/pull/12 --match-head-commit abc123 -b body --`"],
    ["ssh host gh pr merge 12 -R o/r -d", "`gh pr merge https://github.com/o/r/pull/12 --match-head-commit abc123 -R o/r -d`"],
  ])("names the pull request by its URL in the rerun command: %s", (command, rerun) => {
    expect(verdict(command)).toContain(rerun);
  });

  test.each([
    [`gh pr merge 12 --match-head-commit 0000000`, {}],
    // an abbreviated SHA is not the head GitHub compares
    [`gh pr merge 12 --match-head-commit ${HEAD.slice(0, 4)}`, {}],
    ["gh pr merge 12 --match-head-commit=0000000 --auto", { branch: PROTECTED, view: { mergeStateStatus: "BLOCKED" } }],
  ])("refuses a pin that is not the head: %s", (command, options) => {
    const violation = verdict(command, options);
    expect(violation).toContain("is not pull request #12's head commit abc123.");
    // the rerun command replaces the stale pin
    expect(violation).toMatch(/rerun with it: `gh pr merge https:\/\/github\.com\/o\/r\/pull\/12 --match-head-commit abc123[^`]*`\.$/);
    expect(violation.match(/--match-head-commit/g)).toHaveLength(3);
  });

  test.each([
    ["gh pr merge 12 --match-head-commit \"$SHA\"", "the shell fills in `$SHA`"],
    ["gh pr merge 12 --match-head-commit $(git rev-parse HEAD)", "the shell fills in"],
    // without a head pin, a pre-merge push is still refused before calling gh
    ["git push && gh pr merge 12", "the same command also runs `git push`"],
  ])("refuses %s", (command, reason) => {
    expect(verdict(command)).toContain(reason);
  });

  test("checks the pin against the SHA from the same query as the checks", () => {
    const calls = [];
    expect(verdict("gh pr merge 12 --match-head-commit def456", { view: { headRefOid: "def456" }, calls })).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0].args.at(-1)).toContain("headRefOid,statusCheckRollup");
    expect(calls[1].args).toContain("workflows=def456:.github/workflows");
  });
});

describe("chained commands with a pinned or top-level merge (dotfiles-756)", () => {
  const URL = "https://github.com/o/r/pull/12";

  test.each([
    // pre-merge allowlist before a merge naming its PR by number or URL and pinning --match-head-commit
    [`gh pr update-branch 12 && gh pr merge 12 --squash --match-head-commit ${HEAD}`, {}],
    [`gh pr update-branch 12 --rebase && gh pr merge ${URL} --squash --match-head-commit ${HEAD}`, {}],
    [`git push && gh pr merge 12 --squash --match-head-commit ${HEAD}`, {}],
    [`git push -u origin feature; gh pr merge 12 --squash --match-head-commit=${HEAD}`, {}],
    [`git add -A && git commit -m "fix" && git push && gh pr merge 12 --squash --match-head-commit ${HEAD}`, {}],
    [`git -C /repo push && gh pr merge ${URL} --match-head-commit ${HEAD}`, {}],
    [`gh pr edit 12 --body "updated summary" && gh pr merge 12 --squash --match-head-commit ${HEAD}`, {}],
    [`gh pr edit 12 --title "New title" --add-label bug -F body.md && gh pr merge ${URL} --match-head-commit ${HEAD}`, {}],
    [`gh pr edit 12 -b -B && gh pr merge 12 --match-head-commit ${HEAD}`, {}],
    // post-merge commands strictly after a single top-level merge in a sequential list
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} && git push origin --delete feat`, {}],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD}; git push origin --delete feat`, {}],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD}\ngit push origin --delete feat`, {}],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} && gh run rerun 99`, {}],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} && git merge --ff-only origin/main`, {}],
    [`gh pr merge --squash --match-head-commit ${HEAD} && git push origin --delete feat`, {}],
    ["gh pr merge 12 --auto --squash && git push origin --delete feat", { branch: PROTECTED, view: { mergeStateStatus: "BLOCKED" } }],
    [`cd /other && gh pr merge 12 --squash --match-head-commit ${HEAD} && git branch -d feat && git push origin --delete feat`, {}],
    // both an allowlisted pre-merge command and a post-merge cleanup command
    [`gh pr update-branch 12 && gh pr merge 12 --squash --match-head-commit ${HEAD} && git push origin --delete feat`, {}],
    // a closed loop or function before a top-level merge does not prevent post-merge pass
    [`for i in 1; do echo ok; done && gh pr merge 12 --squash --match-head-commit ${HEAD} && git push origin --delete feat`, {}],
    // a benign process substitution with no mover still passes
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} > >(cat)`, {}],
  ])("allows %s", (command, options) => {
    expect(verdict(command, options)).toBeUndefined();
  });

  test("still runs GitHub checks on allowed chained merges", () => {
    expect(verdict(`gh pr update-branch 12 && gh pr merge 12 --squash --match-head-commit ${HEAD}`, { view: { isDraft: true } }))
      .toContain("is a draft");
    expect(verdict(`gh pr update-branch 12 && gh pr merge 12 --squash --match-head-commit 0000000`))
      .toContain("is not pull request #12's head commit");
    expect(verdict(`gh pr merge 12 --squash --match-head-commit ${HEAD} && git push origin --delete feat`, { view: { mergeStateStatus: "BEHIND" } }))
      .toContain("is behind main");
  });

  test.each([
    // pre-merge commands the head pin does not cover
    [`gh pr edit 12 --base develop && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr edit 12 --base develop`"],
    [`gh pr edit 12 --base=develop && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr edit 12 --base=develop`"],
    [`gh pr edit 12 -B develop && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr edit 12 -B develop`"],
    [`gh pr edit 12 -Bdevelop && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr edit 12 -Bdevelop`"],
    [`gh pr edit 12 -b= --base develop && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr edit 12 -b= --base develop`"],
    [`gh pr edit 12 -b= -B develop && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr edit 12 -b= -B develop`"],
    [`gh pr edit 12 -R= --base develop && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr edit 12 -R= --base develop`"],
    [`gh pr edit 12 --body= --base develop && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr edit 12 --body= --base develop`"],
    [`gh pr edit 12 -bfoo --base develop && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr edit 12 -bfoo --base develop`"],
    [`gh pr update-branch 12 -R= --unknown && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr update-branch 12 -R= --unknown`"],
    [`gh pr edit 12 --unknown-flag && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr edit 12 --unknown-flag`"],
    [`gh pr edit 12 $OPT && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr edit 12 $OPT`"],
    [`gh pr -B develop edit 12 && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr -B develop edit 12`"],
    [`gh api -X PATCH repos/o/r/pulls/12 -f base=develop && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh api -X PATCH"],
    [`gh api repos/o/r/pulls/12 -f base=develop && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh api repos/o/r/pulls/12"],
    [`gh repo edit --allow-squash-merge && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh repo edit --allow-squash-merge`"],
    [`gh pr ready 12 && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh pr ready 12`"],
    [`gh pr create --title x --body y && gh pr merge --auto`, "also runs `gh pr create"],
    [`gh pr create --title x --body y && gh pr merge 12 --auto --match-head-commit ${HEAD}`, "also runs `gh pr create"],
    // commands that can change which repository gh resolves before a number-only merge without -R
    [`git remote set-url origin https://github.com/other/r.git && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `git remote set-url"],
    [`git config remote.origin.url https://github.com/other/r.git && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `git config"],
    [`gh repo set-default o/other && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh repo set-default o/other`"],
    // non-allowlisted or obfuscated pre-merge commands, including alongside an allowlisted one
    [`git push && gh repo edit && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh repo edit`"],
    [`git -c alias.p=push p origin HEAD && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `git -c alias.p=push"],
    [`[g]it push && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `[g]it push`"],
    [`$GIT push && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `$GIT push`"],
    [`git -$OPT push && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `git -$OPT push`"],
    [`git -C $DIR push && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `git -C $DIR push`"],
    [`gh -R $REPO pr edit 12 --body ok && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "also runs `gh -R $REPO pr edit"],
    [`echo --base other | xargs gh pr edit 12 && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "xargs adds arguments"],
    // selector-less or branch-selector merge with pre-merge mover
    [`gh pr checkout 13 && gh pr merge --squash --match-head-commit ${HEAD}`, "also runs `gh pr checkout 13`"],
    [`git switch feature-b && gh pr merge --squash --match-head-commit ${HEAD}`, "also runs `git switch feature-b`"],
    [`git push && gh pr merge --squash --match-head-commit ${HEAD}`, "also runs `git push`"],
    [`git push && gh pr merge feature-branch --squash --match-head-commit ${HEAD}`, "also runs `git push`"],
    // two merges in one call, even pinned
    [`gh pr merge 12 --match-head-commit ${HEAD} && gh pr merge 13 --match-head-commit ${HEAD}`, "runs another `gh pr merge`"],
    // post-merge pass does NOT hold inside a loop, function body, group, subshell, conditional, or nested script
    [`for i in 1 2; do gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; done`, "inside a loop, function or group"],
    [`for ((i=0; i<2; i++)); do gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; done`, "inside a loop, function or group"],
    [`while true; do gh pr merge 12 --squash --match-head-commit ${HEAD} && git push; done`, "inside a loop, function or group"],
    [`until false; do gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; done`, "inside a loop, function or group"],
    [`select x in 1 2; do gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; done`, "inside a loop, function or group"],
    [`repeat 2; do gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; done`, "inside a loop, function or group"],
    [`f() { gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; }; f`, "inside a loop, function or group"],
    [`function f { gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; }; f`, "inside a loop, function or group"],
    [`f() gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; f`, "inside a loop, function or group"],
    [`{ gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; }`, "inside a loop, function or group"],
    [`(gh pr merge 12 --squash --match-head-commit ${HEAD} && git push)`, "inside a loop, function or group"],
    [`if true; then gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; fi`, "inside a loop, function or group"],
    [`case a in a) gh pr merge 12 --squash --match-head-commit ${HEAD}; git push;; esac`, "inside a loop, function or group"],
    [`bash -c 'gh pr merge 12 --squash --match-head-commit ${HEAD} && git push'`, "inside a loop, function or group"],
    [`x=$(gh pr merge 12 --squash --match-head-commit ${HEAD}); git push`, "inside a loop, function or group"],
    // piped and backgrounded forms
    [`git push | gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} | git push`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} | cat && git push`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} && git push | cat`, "in a pipeline or background job"],
    [`git push & gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} & git push`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} && git push &`, "in a pipeline or background job"],
    [`{ git push; } & gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`(git push &) && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} && (git push &)`, "in a pipeline or background job"],
    [`({ git push; echo ok; } &) && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} && ({ git push; echo ok; } &)`, "in a pipeline or background job"],
    [`({ git push; } && echo ok &) && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`((git push; echo ok) &) && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`(for i in 1; do git push; done &) && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`(if true; then git push; fi &) && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`coproc git push; gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`coproc gh pr merge 12 --squash --match-head-commit ${HEAD}; git push`, "in a pipeline or background job"],
    [`coproc { echo ok; git push; } && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`coproc NAME { echo ok; git push; } && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} && coproc { echo ok; git push; }`, "in a pipeline or background job"],
    [`coproc (echo ok; git push) && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`coproc NAME (echo ok; git push) && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} && coproc (echo ok; git push)`, "in a pipeline or background job"],
    [`coproc for i in 1; do git push; done && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    // process substitutions >(...) and <(...) run concurrently via pipe, and =(...) still checks pre-merge allowlist
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} > >(gh pr edit 12 --base develop)`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} 2> >(gh api -X PATCH repos/o/r/pulls/12 -f base=develop)`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} > >(gh repo edit)`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} &> >(gh repo edit)`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} >> >(gh repo edit)`, "in a pipeline or background job"],
    [`gh pr merge --squash --match-head-commit ${HEAD} > >(git switch other)`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} < <(git push)`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} --body-file=<(gh pr edit 12 --base develop)`, "in a pipeline or background job"],
    [`echo hi > >(git push) && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`echo hi < <(git push) && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} && echo hi > >(git push)`, "in a pipeline or background job"],
    [`(echo hi) > >(git push) && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`> >(git push) && gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
    [`cat <(gh pr merge 12 --squash --match-head-commit ${HEAD}) && git push`, "in a pipeline or background job"],
    [`echo hi > >(gh pr merge 12 --squash --match-head-commit ${HEAD}) && git push`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} >>(gh repo edit)`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} >>>(gh repo edit)`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} >|>(gh repo edit)`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} 2>>(gh repo edit)`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} 2>|>(gh repo edit)`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} <<(git push)`, "in a pipeline or background job"],
    [`gh pr merge 12 --squash --match-head-commit ${HEAD} < =(gh pr edit 12 --base develop)`, "also runs `gh pr edit 12 --base develop`"],
    // quoted closing keywords inside loops, functions, conditionals, or backgrounded brace groups
    [`for i in 1 2; do echo ok; "done"; gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; done`, "inside a loop, function or group"],
    [`{ echo ok; "}"; gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; }`, "inside a loop, function or group"],
    [`f() { echo ok; "}"; gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; }; f`, "inside a loop, function or group"],
    [`if true; then echo ok; "fi"; gh pr merge 12 --squash --match-head-commit ${HEAD}; git push; fi`, "inside a loop, function or group"],
    [`{ git push; "}"; echo ok; } & gh pr merge 12 --squash --match-head-commit ${HEAD}`, "in a pipeline or background job"],
  ])("refuses %s", (command, reason) => {
    const calls = [];
    const violation = verdict(command, { calls });
    expect(violation).toBeString();
    expect(violation).toContain(reason);
    expect(calls).toHaveLength(0);
  });
});

describe("the hook", () => {
  let root;
  let bin;
  const env = () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_LOG: join(root, "log") });
  const hook = (stdin, extraEnv = {}) => {
    const result = Bun.spawnSync({ cmd: [process.execPath, HOOK], stdin: Buffer.from(stdin), env: { ...env(), ...extraEnv } });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  const bash = (command, extraEnv) => hook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: root }), extraEnv);
  // Every reply also answers the CI configuration query: no workflows at the head commit.
  const reply = (value) => writeFileSync(join(root, "reply"), JSON.stringify({ ...value, data: { ...value.data, repository: { ...ciFiles().data.repository, ...value.data?.repository } } }));

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
    expect(bash(pinned("gh pr merge 12 --squash"), { GH_REPO: "o/r" })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readFileSync(join(root, "log"), "utf8")).toStartWith("GH_REPO=o/r pr view 12 --json");
  });

  // The guard refuses and never rewrites the command, so it prints no updatedInput (dotfiles-290).
  test("blocks a merge without the head pin, names the SHA and the command, and prints nothing on stdout", () => {
    reply(VIEW);
    const result = bash("cd /tmp && gh pr merge 12 --squash -R o/r");
    expect(result).toEqual({ code: 2, stdout: "",
      stderr: "Blocked by the guard-pr-merge hook: `gh pr merge 12 --squash -R o/r`: the checks passed on pull request #12's head commit abc123. "
        + "Pin the merge to that commit, so GitHub refuses it if the head moves: `gh pr merge https://github.com/o/r/pull/12 --match-head-commit abc123 --squash -R o/r`.\n" });
    const stale = bash("gh pr merge 12 --squash --match-head-commit 0000000");
    expect(stale.code).toBe(2);
    expect(stale.stderr).toContain("--match-head-commit 0000000 is not pull request #12's head commit abc123.");
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

  // The fake gh prints one reply to every call: the pull request's fields and the GraphQL answer.
  test("passes a billing-skipped job with a GitHub notice, and refuses one with a warning or with steps", () => {
    const rollup = [job("Scan history", 11), context("ci/circleci: Scan history", "SUCCESS")];
    const answer = (runs) => reply({ ...VIEW, statusCheckRollup: rollup, ...graph(runs) });
    answer([billingRun(11, NOTICE)]);
    rmSync(join(root, "log"), { force: true });
    expect(bash(pinned("gh pr merge 12 --squash"), { GH_REPO: "o/r" })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readFileSync(join(root, "log"), "utf8")).toContain("graphql");
    for (const runs of [[billingRun(11, { ...NOTICE, annotationLevel: "WARNING" })], [graphRun(11, 2, [BILLING, NOTICE])]]) {
      answer(runs);
      const result = bash("gh pr merge 12 --squash", { GH_REPO: "o/r" });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Checks / Scan history (FAILURE)");
    }
  });

  test("skips commands that do not mention merge without calling gh", () => {
    rmSync(join(root, "log"), { force: true });
    expect(bash("gh pr view 12")).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(() => readFileSync(join(root, "log"))).toThrow();
  });

  test("handles Claude Code mcp__t3-code__pull_request_merge PreToolUse inputs", () => {
    const mcp = (toolInput, extraEnv) => hook(
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__t3-code__pull_request_merge", tool_input: toolInput, cwd: root }),
      extraEnv,
    );
    reply({ ...VIEW, isDraft: true });
    const draft = mcp({ number: 12, repository: "o/r", expectedHeadSha: HEAD });
    expect(draft.code).toBe(2);
    expect(draft.stderr).toContain("pull_request_merge: pull request #12 is a draft.");

    reply(VIEW);
    rmSync(join(root, "log"), { force: true });
    expect(mcp({ number: 12, repository: "o/r", expectedHeadSha: HEAD, method: "squash" })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readFileSync(join(root, "log"), "utf8")).toContain("pr view 12 --repo o/r --json");

    const missingPin = mcp({ number: 12, repository: "o/r" });
    expect(missingPin.code).toBe(2);
    expect(missingPin.stderr).toContain(`expectedHeadSha "${HEAD}"`);

    const ghFailed = mcp({ number: 12, expectedHeadSha: HEAD }, { FAKE_GH_FAIL: "HTTP 502" });
    expect(ghFailed.code).toBe(2);
    expect(ghFailed.stderr).toContain("gh could not read the pull request (HTTP 502)");
  });
});

describe("T3 MCP pull_request_merge (dotfiles-824)", () => {
  const mcpVerdict = (toolInput, options = {}, cwd = "/repo") => findMcpMergeViolation(toolInput, cwd, fakeGh(options));

  test("allows a passing direct merge with matching expectedHeadSha, with or without explicit number/repository", () => {
    const calls = [];
    expect(mcpVerdict({ number: 12, repository: "o/r", expectedHeadSha: HEAD, method: "squash" }, { calls })).toBeUndefined();
    expect(calls[0]).toEqual({ dir: "/repo", args: ["pr", "view", "12", "--repo", "o/r", "--json", expect.any(String)] });

    const branchCalls = [];
    expect(mcpVerdict({ expectedHeadSha: HEAD }, { calls: branchCalls }, "/wt")).toBeUndefined();
    expect(branchCalls[0]).toEqual({ dir: "/wt", args: ["pr", "view", "--json", expect.any(String)] });
  });

  test("allows billing-skipped Actions job when CircleCI fallback passed, and refuses without fallback", () => {
    const rollup = [job("build", 11), context("ci/circleci: build", "SUCCESS")];
    expect(
      mcpVerdict(
        { number: 12, expectedHeadSha: HEAD },
        { view: { statusCheckRollup: rollup }, graphql: graph([billingRun(11, NOTICE)]) },
      ),
    ).toBeUndefined();

    const noFallback = mcpVerdict(
      { number: 12, expectedHeadSha: HEAD },
      { view: { statusCheckRollup: [job("build", 11)] }, graphql: graph([billingRun(11)]) },
    );
    expect(noFallback).toContain("not started for billing");
  });

  test("allows auto=true on check-gated bases when not mergeable now, and refuses on ungated or mergeable-now bases", () => {
    expect(
      mcpVerdict(
        { number: 12, auto: true, expectedHeadSha: HEAD },
        { branch: PROTECTED, view: { mergeStateStatus: "BLOCKED", statusCheckRollup: [run("Portable tests", "IN_PROGRESS", "")] } },
      ),
    ).toBeUndefined();

    expect(
      mcpVerdict(
        { number: 12, auto: true },
        { rules: [{ type: "required_status_checks" }], view: { mergeStateStatus: "BEHIND", statusCheckRollup: [] }, workflows: WORKFLOWS },
      ),
    ).toBeUndefined();

    // Ungated base: auto=true must pass direct-merge checks
    expect(
      mcpVerdict(
        { number: 12, auto: true, expectedHeadSha: HEAD },
        { view: { mergeStateStatus: "BLOCKED", statusCheckRollup: [run("Portable tests", "IN_PROGRESS", "")] } },
      ),
    ).toContain("still running");

    // Mergeable-now (UNSTABLE / CLEAN): auto=true merges immediately, so checks/missing-CI still apply
    expect(
      mcpVerdict(
        { number: 12, auto: true, expectedHeadSha: HEAD },
        { branch: PROTECTED, view: { mergeStateStatus: "UNSTABLE", statusCheckRollup: [...PASSING, run("Lint", "COMPLETED", "FAILURE")] } },
      ),
    ).toContain("checks failed");
    expect(
      mcpVerdict(
        { number: 12, auto: true, expectedHeadSha: HEAD },
        { branch: PROTECTED, view: { mergeStateStatus: "CLEAN", statusCheckRollup: [] }, ci: { files: { "checks.yml": PR_WORKFLOW } } },
      ),
    ).toContain("CI may not have started");
  });

  test.each([
    ["a failing check", { number: 12, expectedHeadSha: HEAD }, { view: { statusCheckRollup: [run("Portable tests", "COMPLETED", "FAILURE")] } }, "checks failed"],
    ["a pending check", { number: 12, expectedHeadSha: HEAD }, { view: { statusCheckRollup: [run("Portable tests", "IN_PROGRESS", "")] } }, "still running"],
    ["missing workflow CI", { number: 12, expectedHeadSha: HEAD }, { view: { statusCheckRollup: [] }, ci: { files: { "checks.yml": PR_WORKFLOW } } }, 'no check yet from workflow "Checks"'],
    ["missing CircleCI check", { number: 12, expectedHeadSha: HEAD }, { view: { statusCheckRollup: PASSING }, ci: { circleci: true } }, "no check yet from CircleCI"],
    ["a draft PR", { number: 12, expectedHeadSha: HEAD }, { view: { isDraft: true } }, "is a draft"],
    ["a draft PR with auto=true", { number: 12, auto: true, expectedHeadSha: HEAD }, { branch: PROTECTED, view: { isDraft: true, mergeStateStatus: "BLOCKED" } }, "is a draft"],
    ["a BEHIND PR on check-gated base", { number: 12, expectedHeadSha: HEAD }, { branch: PROTECTED, view: { mergeStateStatus: "BEHIND" } }, "rerun this merge with auto=true"],
    ["a DIRTY PR", { number: 12, expectedHeadSha: HEAD }, { view: { mergeStateStatus: "DIRTY" } }, "conflicts with main"],
    ["a stale expectedHeadSha", { number: 12, expectedHeadSha: "0000000" }, {}, `expectedHeadSha 0000000 is not pull request #12's head commit ${HEAD}`],
    ["a stale expectedHeadSha with auto=true", { number: 12, auto: true, expectedHeadSha: "0000000" }, { branch: PROTECTED, view: { mergeStateStatus: "BLOCKED" } }, `expectedHeadSha 0000000 is not pull request #12's head commit ${HEAD}`],
    ["a missing expectedHeadSha on direct merge", { number: 12 }, {}, `passing expectedHeadSha "${HEAD}"`],
    ["stack=true", { number: 12, expectedHeadSha: HEAD, stack: true }, {}, "stack=true merges multiple pull requests"],
    ["invalid number", { number: -1, expectedHeadSha: HEAD }, {}, "invalid pull request number"],
    ["invalid repository flag", { number: 12, repository: "--admin", expectedHeadSha: HEAD }, {}, "invalid repository"],
    ["invalid auto type", { number: 12, auto: "yes", expectedHeadSha: HEAD }, {}, "invalid auto value"],
    ["invalid expectedHeadSha type", { number: 12, expectedHeadSha: 123 }, {}, "invalid expectedHeadSha"],
    ["non-object input", null, {}, "arguments are not an object"],
    ["invalid environmentId type", { environmentId: { id: "env-remote" }, expectedHeadSha: HEAD }, {}, "invalid environmentId"],
    ["environmentId without repository and number", { environmentId: "env-remote", expectedHeadSha: HEAD }, {}, "environmentId targets another environment"],
  ])("refuses %s", (_, toolInput, options, reason) => {
    const violation = mcpVerdict(toolInput, options);
    expect(violation).toBeString();
    expect(violation).toContain(reason);
  });

  test("allows environmentId when repository and number are both explicit, and allows closed/merged PRs", () => {
    expect(mcpVerdict({ environmentId: "env-remote", repository: "o/r", number: 12, expectedHeadSha: HEAD })).toBeUndefined();
    expect(mcpVerdict({ number: 12, expectedHeadSha: HEAD }, { view: { state: "MERGED", statusCheckRollup: [] }, workflows: WORKFLOWS })).toBeUndefined();
  });

  test("fails closed when gh errors, throws, or runs out of budget", () => {
    expect(findMcpMergeViolation({ number: 12, expectedHeadSha: HEAD }, "/repo", () => ({ code: 1, stdout: "", stderr: "HTTP 502" }))).toContain("HTTP 502");
    expect(findMcpMergeViolation({ number: 12, expectedHeadSha: HEAD }, "/repo", () => { throw new Error("ETIMEDOUT"); })).toContain("ETIMEDOUT");
    expect(findMcpMergeViolation({ number: 12, expectedHeadSha: HEAD }, "/repo", fakeGh(), { budgetMs: 0 })).toContain("ran out of time");
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
    ["gh pr list -q x | xargs -n1 gh pr view"], ["echo 12 | xargs gh pr checks"],
    ["ls | xargs -I{} sh -c 'test -s \"$1\" && echo \"$1\"' _ {}"],
    ["ls | while IFS= read -r f; do test -s \"$f\" && echo \"$f\"; done"]])("allows %s", (command) => {
    expect(verdict(command)).toBeUndefined();
  });

  test("opaque xargs refusal names the positional sh -c form and a while read loop (dotfiles-757)", () => {
    const reason = verdict("ls | xargs -I{} sh -c 'test -s {} && echo {}'");
    expect(reason).toContain('`xargs -I{} sh -c \'… "$1" …\' _ {}`');
    expect(reason).toContain("`while read`");
  });
});
