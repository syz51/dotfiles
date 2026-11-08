import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changesBranch, findMainCheckoutViolation } from "./guard-main-checkout.js";

const HOOK = join(import.meta.dir, "guard-main-checkout.js");

// A fake git: /main is a main checkout, /linked a linked worktree, /allowed a main checkout
// whose user allowed branch changes, /scratch/repo a main checkout in a temporary directory,
// and anything else is not a repository.
function fakeGit(dir, args) {
  const repos = {
    "/main": ["/main/.git", "/main/.git", "/main"],
    "/main/sub": ["/main/.git", "/main/.git", "/main"],
    "/linked": ["/main/.git/worktrees/linked", "/main/.git", "/linked"],
    "/allowed": ["/allowed/.git", "/allowed/.git", "/allowed"],
    "/scratch/repo": ["/scratch/repo/.git", "/scratch/repo/.git", "/scratch/repo"],
  };
  if (!repos[dir]) return undefined;
  if (args[0] === "rev-parse") return repos[dir].join("\n");
  if (args[0] === "config") return dir === "/allowed" ? "Allow" : undefined;
  return undefined;
}
// Rows have one or two values, so test callbacks take `...row`: bun reads a declared
// parameter that a row does not fill as a `done` callback and waits for it.
const verdict = (command, cwd = "/main") => findMainCheckoutViolation(command, cwd, fakeGit, ["/scratch"]);

describe("in a main checkout it blocks", () => {
  test.each([
    ["git switch feature"],
    ["git switch -c feature"],
    ["git checkout feature"],
    ["git checkout -"],
    ["git checkout -b feature"],
    ["git checkout -bfeature"],
    ["git checkout -B feature origin/main"],
    ["git checkout -Bx"],
    ["git checkout --detach"],
    ["git checkout --det"],
    ["git checkout --orphan=gh-pages"],
    ["git checkout -q origin/main"],
    ["git checkout -t origin/feature"],
    ["git checkout ."],
    // a branch named before a `--` with no paths after it is still a switch
    ["git checkout feature --"],
    ["git checkout -b x --"],
    ["git checkout --detach --"],
    // discarding every change, as reset --hard does
    ["git checkout -f"],
    ["git checkout -fq"],
    ["git checkout --force"],
    ["git reset --hard"],
    ["git reset --hard origin/main"],
    ["git reset --har origin/main"],
    ["git reset --keep HEAD~1"],
    ["git reset --soft HEAD~1"],
    // a mixed reset to another commit moves the branch too
    ["git reset HEAD~3"],
    ["git reset --mixed origin/main"],
    ["git reset -q origin/main --"],
    ["git merge feature"],
    ["git merge --ff-only origin/main"],
    ["git rebase origin/main"],
    ["git rebase -i HEAD~3"],
    ["git pull"],
    ["git pull --rebase origin main"],
    ["git stash"],
    ["git stash push -u -m wip"],
    ["git stash pop"],
    ["git stash apply stash@{0}"],
    ["git stash drop"],
    ["git stash -- show"],
    ["git bisect start HEAD v1.0"],
    ["git bisect good"],
    ["gh pr checkout 12"],
    ["gh pr co 12"],
    // the program name ignores case, as macOS volumes do
    ["GIT switch feature"],
    ["Git reset --hard"],
    // the directory comes from -C, cd, a subdirectory or a wrapper
    ["git -C /main switch feature", "/elsewhere"],
    ["git -C sub checkout feature", "/main"],
    ["cd /main && git merge feature", "/elsewhere"],
    ["cd /main && gh pr checkout 12", "/elsewhere"],
    ["git switch feature", "/main/sub"],
    ["sh -c 'git switch feature'"],
    ["sudo git reset --hard"],
    ["eval eval git switch feature"],
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
    expect(verdict("git reset file.txt")).toContain("use `git restore --staged <path>` or `git reset -- <path>`");
  });
});

describe("it allows", () => {
  test.each([
    // read-only, file-level, finishing and ending forms
    ["git status"],
    ["git log --oneline origin/main..HEAD"],
    ["git diff"],
    ["git fetch origin"],
    ["git add . && git commit -m x"],
    ["git push origin HEAD"],
    ["git restore file.txt"],
    ["git checkout -- file.txt"],
    ["git checkout feature -- file.txt"],
    ["git checkout -f -- file.txt"],
    ["git checkout feature a.txt b.txt"],
    ["git checkout -p file.txt"],
    ["git checkout --patch"],
    ["git checkout"],
    ["git reset"],
    ["git reset -q"],
    ["git reset HEAD"],
    ["git reset HEAD file.txt"],
    ["git reset -- file.txt"],
    ["git reset HEAD~1 -- file.txt"],
    ["git reset -p"],
    ["git merge --abort"],
    ["git merge --continue"],
    ["git rebase --abort"],
    ["git rebase --continue"],
    ["git rebase --skip"],
    ["git stash list"],
    ["git stash show -p"],
    ["git bisect log"],
    ["git bisect reset"],
    ["git worktree add ../wt -b feature"],
    ["git branch feature"],
    ["gh pr view 12"],
    ["git config --get claude.mainCheckout"],
    ["git config get claude.mainCheckout"],
    ["git config --get-all claude.mainCheckout"],
    ["git config claude.mainCheckout"],
    ["git config --show-origin claude.mainCheckout"],
    // the guard does not know the repository
    ["git --git-dir=/main/.git switch feature"],
    ["git --work-tree /main switch feature"],
    ["cd \"$DIR\" && git switch feature"],
    ["git switch feature", "/not-a-repo"],
    // text, not a git command
    ["echo git switch feature"],
    ["grep -r 'git reset --hard' ."],
    // nested past what the parser follows: the guard fails open
    [`${"eval ".repeat(12)}git switch feature`],
  ])("%s", (...row) => {
    expect(verdict(...row)).toBeUndefined();
  });

  test.each([
    ["git switch feature", "/linked"],
    ["git reset --hard origin/main", "/linked"],
    ["git rebase origin/main", "/linked"],
    ["git -C /linked stash", "/main"],
    ["gh pr checkout 12", "/linked"],
    ["git checkout -b feature", "/allowed"],
    ["git checkout -b repro", "/scratch/repo"],
    ["git stash", "/scratch/repo"],
  ])("%s in a linked worktree, an allowed repository or a temporary one", (...row) => {
    expect(verdict(...row)).toBeUndefined();
  });
});

describe("the override", () => {
  test.each([
    ["git config claude.mainCheckout allow"],
    ["git config --local claude.mainCheckout allow"],
    ["git config set claude.maincheckout allow"],
    ["git config --global Claude.MainCheckout allow"],
    ["git config --type=bool claude.mainCheckout allow"],
    ["git config --unset claude.mainCheckout"],
    ["git -C /linked config claude.mainCheckout allow"],
    ["git config claude.mainCheckout allow", "/not-a-repo"],
  ])("only the user sets it: %s", (...row) => {
    expect(verdict(...row)).toContain("claude.mainCheckout is the user's switch for the guard-main-checkout hook");
  });
});

describe("changesBranch", () => {
  test("checkout skips the values of its options", () => {
    expect(changesBranch("checkout", ["--conflict", "diff3"])).toBe(false);
    expect(changesBranch("checkout", ["--conflict", "diff3", "main"])).toBe(true);
  });
  test("other subcommands never change the branch", () => {
    expect(changesBranch("commit", ["-m", "x"])).toBe(false);
    expect(changesBranch("cherry-pick", ["abc123"])).toBe(false);
    expect(changesBranch(undefined, [])).toBe(false);
  });
});

// Real repositories: a main checkout and a linked worktree of it. The hook treats its
// temporary directory as scratch space, so the repositories live outside the TMPDIR it gets.
describe("hook process", () => {
  const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-main-checkout-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const otherTmp = join(root, "tmp");
  mkdirSync(otherTmp);
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

  const run = (command, cwd, tmp = otherTmp) => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd });
    const result = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", env: { ...ENV, TMPDIR: tmp } });
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

  test("allows branch changes in a repository under its temporary directory", () => {
    expect(run("git switch feature", main, root)).toEqual({ code: 0, stderr: "" });
  });

  test("allows commands outside a repository", () => {
    expect(run("git switch feature", root)).toEqual({ code: 0, stderr: "" });
  });
});
