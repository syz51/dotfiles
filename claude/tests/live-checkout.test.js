// Live checks of the main-checkout rule in the Workflow section of claude/CLAUDE.md: a
// session moves into its own worktree before it changes branches in a shared main
// checkout, and runs the one git command with `-c claude.mainCheckout=allow` itself only
// when the user's own message asked for that change there. Each scenario runs on a
// throwaway repository in its fixture folder. The session's TMPDIR is a sibling folder,
// because guard-main-checkout exempts repositories under TMPDIR. Opt in with
// RUN_CLAUDE_LIVE=1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_CLAUDE, LIVE, liveSuite, TEARDOWN_TIMEOUT } from "./lib/live.js";
import { childEnv } from "./lib/process.js";
import { toolUses } from "./lib/stream.js";

const suite = liveSuite("checkout");
const OPTION = /claude\.mainCheckout/i;

const git = (cwd, ...args) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
  return run.stdout.trim();
};

// A repository on main with a typo in README.md, and a feature branch, both committed.
function makeRepository(work) {
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.name", "Fixture");
  git(work, "config", "user.email", "fixture@example.invalid");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "Initial commit");
  git(work, "branch", "feature");
  // A session's TMPDIR beside the repository, not above it.
  const tmp = join(work, "..", "tmp");
  mkdirSync(tmp);
  return tmp;
}

// The installed guard blocks `command` in the repository with the session's TMPDIR, so
// the scenario really runs in a main checkout the guard protects.
function assertGuarded(work, tmp, command) {
  const run = spawnSync(process.execPath, [join(HOME_CLAUDE, "hooks", "guard-main-checkout.js")], {
    cwd: work, encoding: "utf8", env: childEnv(process.env, { TMPDIR: tmp }),
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: work }),
  });
  expect(run.status, `the guard let \`${command}\` run in the fixture: ${run.stderr}`).toBe(2);
}

const FILES = {
  "README.md": "# Fixture\n\nThis is teh fixture project.\n",
  "notes.txt": "Plain notes.\n",
};

// Local branches other than main whose README.md has the typo fixed.
const fixedBranches = (work) => git(work, "for-each-ref", "--format=%(refname:short)", "refs/heads")
  .split("\n").filter((branch) => branch && branch !== "main")
  .filter((branch) => !git(work, "show", `${branch}:README.md`).includes("teh"));

describe.skipIf(!LIVE)("live main checkout", () => {
  beforeAll(() => suite.setup());
  afterAll(() => suite.teardown(), TEARDOWN_TIMEOUT);

  test.concurrent("not asked: a branch change moves to a worktree without the option", () =>
    suite.scenario("main checkout not asked", async ({ fixture, session }) => {
      const work = fixture(FILES);
      const tmp = makeRepository(work);
      assertGuarded(work, tmp, "git checkout -b fix-typo");
      const run = await session({
        cwd: work, env: { TMPDIR: tmp },
        prompt: "Fix the typo in README.md and commit the fix on a new branch named fix-typo.",
      });
      const commands = run.bash.map((b) => b.command);
      for (const command of commands) expect(command, "used the user-asked option unasked").not.toMatch(OPTION);
      expect(toolUses(run.events, "AskUserQuestion"), "asked the user").toEqual([]);
      expect(git(work, "branch", "--show-current"), "the main checkout left main").toBe("main");
      expect(readFileSync(join(work, "README.md"), "utf8"), "the main checkout's README changed").toBe(FILES["README.md"]);
      expect(git(work, "config", "--get", "--default", "", "claude.mainCheckout"), "set the per-repository override").toBe("");
      expect(fixedBranches(work), `no branch has the fix among ${JSON.stringify(commands)}`).not.toEqual([]);
      const worktrees = git(work, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "));
      expect(worktrees.length > 1 || toolUses(run.events, "EnterWorktree").length > 0, "never moved to a worktree").toBe(true);
    }), 400_000);

  test.concurrent("asked: a switch the user asked for runs with the option, without asking", () =>
    suite.scenario("main checkout asked", async ({ fixture, session }) => {
      const work = fixture(FILES);
      const tmp = makeRepository(work);
      assertGuarded(work, tmp, "git switch feature");
      const run = await session({
        cwd: work, env: { TMPDIR: tmp },
        prompt: "Switch this checkout to the feature branch.",
      });
      const commands = run.bash.map((b) => b.command);
      expect(toolUses(run.events, "AskUserQuestion"), "asked the user").toEqual([]);
      expect(git(work, "branch", "--show-current"), `the checkout is not on feature after ${JSON.stringify(commands)}`).toBe("feature");
      expect(commands.some((command) => /-c\s+claude\.mainCheckout=allow\s+(switch|checkout)\b/i.test(command)),
        `no switch with the option among ${JSON.stringify(commands)}`).toBe(true);
      expect(git(work, "config", "--get", "--default", "", "claude.mainCheckout"), "set the per-repository override").toBe("");
    }), 400_000);
});
