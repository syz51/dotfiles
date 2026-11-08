import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changesBranch, findMainCheckoutViolation } from "./guard-main-checkout.js";

const HOOK = join(import.meta.dir, "guard-main-checkout.js");

// A fake git: /main is a main checkout, /linked a linked worktree, /allowed a main checkout
// whose user allowed branch changes, and anything else is not a repository.
function fakeGit(dir, args) {
  const repos = {
    "/main": ["/main/.git", "/main/.git"],
    "/main/sub": ["/main/.git", "/main/.git"],
    "/linked": ["/main/.git/worktrees/linked", "/main/.git"],
    "/allowed": ["/allowed/.git", "/allowed/.git"],
  };
  if (!repos[dir]) return undefined;
  if (args[0] === "rev-parse" && args.includes("--git-common-dir")) return repos[dir].join("\n");
  if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return dir.replace(/\/sub$/, "");
  if (args[0] === "config") return dir === "/allowed" ? "Allow" : undefined;
  return undefined;
}
// Rows have one or two values, so test callbacks take `...row`: bun reads a declared
// parameter that a row does not fill as a `done` callback and waits for it.
const verdict = (command, cwd = "/main") => findMainCheckoutViolation(command, cwd, fakeGit);

describe("in a main checkout it blocks", () => {
  test.each([
    ["git switch feature"],
    ["git switch -c feature"],
    ["git checkout feature"],
    ["git checkout -"],
    ["git checkout -b feature"],
    ["git checkout -B feature origin/main"],
    ["git checkout --detach"],
    ["git checkout -q origin/main"],
    ["git checkout ."],
    ["git reset --hard"],
    ["git reset --hard origin/main"],
    ["git reset --keep HEAD~1"],
    ["git reset --soft HEAD~1"],
    ["git merge feature"],
    ["git merge --ff-only origin/main"],
    ["git rebase origin/main"],
    ["git rebase --continue"],
    ["git pull"],
    ["git pull --rebase origin main"],
    ["git stash"],
    ["git stash push -u -m wip"],
    ["git stash pop"],
    ["git stash apply stash@{0}"],
    ["git stash drop"],
    // the directory comes from -C, cd, a subdirectory or a wrapper
    ["git -C /main switch feature", "/elsewhere"],
    ["git -C sub checkout feature", "/main"],
    ["cd /main && git merge feature", "/elsewhere"],
    ["git switch feature", "/main/sub"],
    ["sh -c 'git switch feature'"],
    ["sudo git reset --hard"],
    ["/usr/bin/git switch feature"],
    ["git -c core.pager=cat -P switch feature"],
  ])("%s", (...row) => {
    expect(verdict(...row)).toContain("a main checkout other threads share");
  });

  test("names the checkout and the ways out", () => {
    const reason = verdict("git switch feature", "/main/sub");
    expect(reason).toStartWith("`git switch feature`: it changes the branch of /main, a main checkout");
    expect(reason).toContain("Move into your own worktree first");
    expect(reason).toContain("`git config claude.mainCheckout allow`");
    expect(reason).not.toContain("git restore");
    expect(verdict("git checkout feature")).toContain("use `git restore <path>` or `git checkout -- <path>`");
  });
});

describe("it allows", () => {
  test.each([
    // read-only, file-level and ending forms
    ["git status"],
    ["git log --oneline origin/main..HEAD"],
    ["git diff"],
    ["git fetch origin"],
    ["git add . && git commit -m x"],
    ["git push origin HEAD"],
    ["git restore file.txt"],
    ["git checkout -- file.txt"],
    ["git checkout HEAD -- file.txt"],
    ["git checkout -p file.txt"],
    ["git checkout"],
    ["git reset"],
    ["git reset HEAD file.txt"],
    ["git reset --mixed HEAD~1"],
    ["git merge --abort"],
    ["git rebase --abort"],
    ["git stash list"],
    ["git stash show -p"],
    ["git worktree add ../wt -b feature"],
    ["git branch feature"],
    ["git config --get claude.mainCheckout"],
    ["git config get claude.mainCheckout"],
    ["git config --get-all claude.mainCheckout"],
    // the guard does not know the repository
    ["git --git-dir=/main/.git switch feature"],
    ["git --work-tree /main switch feature"],
    ["cd \"$DIR\" && git switch feature"],
    ["git switch feature", "/not-a-repo"],
    // text, not a git command
    ["echo git switch feature"],
    ["grep -r 'git reset --hard' ."],
  ])("%s", (...row) => {
    expect(verdict(...row)).toBeUndefined();
  });

  test.each([
    ["git switch feature", "/linked"],
    ["git reset --hard origin/main", "/linked"],
    ["git rebase origin/main", "/linked"],
    ["git -C /linked stash", "/main"],
    ["git checkout -b feature", "/allowed"],
  ])("%s in a linked worktree or an allowed repository", (...row) => {
    expect(verdict(...row)).toBeUndefined();
  });
});

describe("the override", () => {
  test.each([
    ["git config claude.mainCheckout allow"],
    ["git config --local claude.mainCheckout allow"],
    ["git config set claude.maincheckout allow"],
    ["git config --global Claude.MainCheckout allow"],
    ["git -C /linked config claude.mainCheckout allow"],
  ])("only the user sets it: %s", (command) => {
    expect(verdict(command)).toContain("claude.mainCheckout is the user's switch for this guard");
  });
});

describe("changesBranch", () => {
  test("checkout skips the values of its options", () => {
    expect(changesBranch("checkout", ["--conflict", "diff3"])).toBe(false);
    expect(changesBranch("checkout", ["--conflict", "diff3", "main"])).toBe(true);
  });
  test("other subcommands never change the branch", () => {
    expect(changesBranch("commit", ["-m", "x"])).toBe(false);
    expect(changesBranch(undefined, [])).toBe(false);
  });
});

// Real repositories: a main checkout and a linked worktree of it.
describe("hook process", () => {
  const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-main-checkout-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => {
    const result = spawnSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, env: ENV, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  const main = join(root, "main");
  const linked = join(root, "linked");
  git(root, "init", "-q", main);
  writeFileSync(join(main, "a.txt"), "a");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "a");
  git(main, "worktree", "add", "-q", linked, "-b", "feature");

  const run = (command, cwd) => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd });
    const result = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", env: ENV });
    return { code: result.status, stderr: result.stderr };
  };

  test("blocks a branch switch in the main checkout with exit 2 and the reason on stderr", () => {
    const result = run("git switch feature", main);
    expect(result.code).toBe(2);
    expect(result.stderr).toStartWith(`Blocked by the guard-main-checkout hook: \`git switch feature\`: it changes the branch of ${main}, a main checkout`);
  });

  test("allows the same command in a linked worktree, and read-only commands in the main checkout", () => {
    expect(run("git switch -c other", linked)).toEqual({ code: 0, stderr: "" });
    expect(run("git status", main)).toEqual({ code: 0, stderr: "" });
    expect(run("ls", main)).toEqual({ code: 0, stderr: "" });
  });

  test("allows branch changes in a repository the user allowed", () => {
    git(main, "config", "claude.mainCheckout", "allow");
    try {
      expect(run("git reset --hard", main)).toEqual({ code: 0, stderr: "" });
    } finally {
      git(main, "config", "--unset", "claude.mainCheckout");
    }
  });

  test("allows commands outside a repository", () => {
    expect(run("git switch feature", root)).toEqual({ code: 0, stderr: "" });
  });
});
