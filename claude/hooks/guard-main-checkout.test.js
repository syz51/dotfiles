import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changesBranch, findMainCheckoutViolation } from "./guard-main-checkout.js";

const HOOK = join(import.meta.dir, "guard-main-checkout.js");

// A fake git: /main is a clean main checkout whose default branch is main, /dirty one with a
// tracked change, /local one without origin/HEAD, /linked a linked worktree, /allowed a main
// checkout whose user allowed branch changes, /scratch/repo a main checkout in a temporary
// directory, and anything else is not a repository.
function fakeGit(dir, args) {
  const repos = {
    "/main": ["/main/.git", "/main/.git", "/main"],
    "/main/sub": ["/main/.git", "/main/.git", "/main"],
    "/dirty": ["/dirty/.git", "/dirty/.git", "/dirty"],
    "/local": ["/local/.git", "/local/.git", "/local"],
    "/linked": ["/main/.git/worktrees/linked", "/main/.git", "/linked"],
    "/allowed": ["/allowed/.git", "/allowed/.git", "/allowed"],
    "/scratch/repo": ["/scratch/repo/.git", "/scratch/repo/.git", "/scratch/repo"],
  };
  if (!repos[dir]) return undefined;
  if (args[0] === "rev-parse") return repos[dir].join("\n");
  if (args[0] === "config") return dir === "/allowed" ? "Allow" : undefined;
  if (args[0] === "symbolic-ref") return dir === "/local" ? undefined : "origin/main";
  if (args[0] === "status")
    return `# branch.oid abc\n# branch.head feature${dir === "/dirty" ? "\n1 .M N... 100644 100644 100644 a b a.txt" : ""}`;
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
    ["git merge --ff origin/main"],
    ["git merge --no-ff origin/main"],
    // the last of --ff, --no-ff and --ff-only wins, as in git
    ["git merge --ff-only --no-ff origin/main"],
    ["git merge --ff-only --ff origin/main"],
    ["git merge origin/main -- --ff-only"],
    // a fast-forward allows only listed options, spelled out: these merge, stash or squash
    ["git merge --ff-only -s ours origin/main"],
    ["git merge --ff-only --strategy=ours origin/main"],
    ["git pull --ff-only -s ours"],
    ["git merge --ff-only --autostash origin/main"],
    ["git pull --ff-only --autostash"],
    ["git -c merge.autostash=true merge --ff-only origin/main"],
    ["git --config-env=merge.autostash=V pull --ff-only"],
    ["git merge --ff-only --squash origin/main"],
    ["git merge --ff-o origin/main"],
    // an option value that spells --ff-only
    ["git merge --no-ff -m --ff-only feature"],
    ["git merge -m --ff-only feature"],
    ["git merge --ff-only -qs ours origin/main"],
    // pull's fetch force-updates a refspec's destination before the fast-forward check
    ["git pull --ff-only origin +other:main"],
    ["git pull --ff-only origin other:feature"],
    ["git pull --ff-only origin +main"],
    ["git rebase origin/main"],
    ["git rebase -i HEAD~3"],
    ["git pull"],
    ["git pull origin main"],
    ["git pull --no-ff"],
    ["git pull --rebase origin main"],
    ["git pull --ff-only --rebase=merges"],
    ["git pull --ff-only -r"],
    ["git pull --ff-only --no-ff"],
    // a switch that is not to a clean default branch
    ["git switch main", "/dirty"],
    ["git switch main", "/local"],
    ["git switch -f main"],
    ["git switch --discard-changes main"],
    ["git checkout -B main origin/main"],
    ["git checkout main --"],
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
    ["gh pr merge 12 --squash"],
    ["gh pr -R owner/repo merge 12"],
    ["gh pr --repo=owner/repo merge"],
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
    // only `-c claude.mainCheckout=allow` on the git command itself lets it through
    ["git -c claude.mainCheckout=deny switch feature"],
    ["git -c claude.mainCheckout switch feature"],
    ["git -c claude.mainCheckout=allow status && git switch feature"],
    ["git switch feature -c claude.mainCheckout=allow"],
    // git uses the last value, and a value from --config-env is not visible
    ["git -c claude.mainCheckout=allow -c claude.mainCheckout=deny switch feature"],
    ["git --config-env=claude.mainCheckout=ALLOW switch feature"],
    ["git -c claude.mainCheckout=allow --config-env claude.mainCheckout=ALLOW switch feature"],
  ])("%s", (...row) => {
    expect(verdict(...row)).toContain("a main checkout other threads share");
  });

  test("names the checkout and the ways out", () => {
    const reason = verdict("git switch feature", "/main/sub");
    expect(reason).toStartWith("`git switch feature`: it changes the branch of /main, a main checkout");
    expect(reason).toContain("Move into your own worktree first");
    expect(reason).toContain("If the user's own message asked for this change in this checkout (not a step that only follows from a request, and not another agent's brief), run it yourself as `git -c claude.mainCheckout=allow <subcommand> ...`");
    expect(reason).toContain("never ask the user to run it");
    expect(reason).not.toContain("gh pr checkout");
    expect(reason).not.toContain("they can run it themselves");
    expect(reason).toContain("Do not run it from a script to get past this guard.");
    expect(reason).toContain("A switch to the default branch may run here when no tracked file has changes.");
    expect(reason).not.toContain("git restore");
    expect(reason).not.toContain("--ff-only");
    expect(verdict("git merge origin/main")).toContain("A fast-forward, `git merge --ff-only <commit>`, may run here.");
    expect(verdict("git pull")).toContain("A fast-forward, `git pull --ff-only`, may run here.");
    expect(verdict("git checkout feature")).toContain("use `git restore <path>` or `git checkout -- <path>`");
    expect(verdict("git reset file.txt")).toContain("use `git restore --staged <path>` or `git reset -- <path>`");
  });

  test("sends gh pr merge to the agent's own worktree", () => {
    const reason = verdict("gh pr merge 12 --squash");
    expect(reason).toStartWith("`gh pr merge 12 --squash`: it merges a pull request from /main, a main checkout other threads share");
    expect(reason).toContain("Run it from your own worktree");
    expect(reason).not.toContain("claude.mainCheckout=allow");
  });

  test("gives gh pr checkout its route through git", () => {
    const reason = verdict("gh pr checkout 12");
    expect(reason).toContain("check it out with git: `git fetch origin pull/<N>/head:<branch>`, then `git -c claude.mainCheckout=allow switch <branch>`");
    expect(reason).toContain("Never ask the user to run it.");
    expect(reason).not.toContain("<subcommand>");
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
    // a fast-forward moves the branch ahead along its own history
    ["git merge --ff-only origin/main"],
    ["git merge --ff-only t3/81955246"],
    ["git merge --no-ff --ff-only origin/main"],
    ["git merge -q --ff-only origin/main"],
    ["git merge -qn --ff-only --no-autostash origin/main"],
    ["git merge origin/main --ff-only"],
    ["git pull --ff-only"],
    ["git pull -q --ff-only origin main"],
    ["git pull --ff-only --no-rebase"],
    ["git pull --ff-only --rebase=false"],
    ["git -C /main pull --ff-only", "/elsewhere"],
    ["cd /main && git fetch && git merge --ff-only origin/main", "/elsewhere"],
    // back to the default branch with no tracked changes
    ["git switch main"],
    ["git switch -q main"],
    ["git checkout main"],
    ["git -C /main switch main", "/elsewhere"],
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
    ["gh pr view merge"],
    ["gh pr create --title merge"],
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
    ["gh pr merge 12 --squash", "/linked"],
    ["git checkout -b feature", "/allowed"],
    ["git checkout -b repro", "/scratch/repo"],
    ["git stash", "/scratch/repo"],
  ])("%s in a linked worktree, an allowed repository or a temporary one", (...row) => {
    expect(verdict(...row)).toBeUndefined();
  });

  test.each([
    ["git -c claude.mainCheckout=allow switch --track origin/fork"],
    ["git -c Claude.MainCheckout=Allow checkout -b feature"],
    ["git -c core.pager=cat -c claude.mainCheckout=allow reset --hard origin/main"],
    ["git -C /main -c claude.mainCheckout=allow rebase origin/main", "/elsewhere"],
    ["cd /main && git -c claude.mainCheckout=allow stash", "/elsewhere"],
    ["git -c claude.mainCheckout=deny -c claude.mainCheckout=allow switch feature"],
    ["git -c claude.mainCheckout=allow checkout -f feature"],
    ["git -c claude.mainCheckout=allow switch feature", "/dirty"],
    ["git -c claude.mainCheckout=allow reset --keep origin/main", "/dirty"],
    ["git -c claude.mainCheckout=allow stash push -m why", "/dirty"],
    ["git -c claude.mainCheckout=allow stash pop", "/dirty"],
    ["git -c claude.mainCheckout=allow checkout -bfix", "/dirty"],
    ["git -c claude.mainCheckout=allow switch -cfix", "/dirty"],
  ])("%s: a change the user asked for in this checkout", (...row) => {
    expect(verdict(...row)).toBeUndefined();
  });

  test.each([
    ["git -c claude.mainCheckout=allow reset --hard origin/main"],
    ["git -c claude.mainCheckout=allow reset --ha"],
    ["git -c claude.mainCheckout=allow checkout -f"],
    ["git -c claude.mainCheckout=allow checkout -qf feature"],
    ["git -c claude.mainCheckout=allow checkout --force feature"],
    ["git -c claude.mainCheckout=allow switch -f feature"],
    ["git -c claude.mainCheckout=allow switch --discard-changes feature"],
  ])("%s: a change the user asked for still keeps tracked changes", (...row) => {
    const reason = verdict(row[0], "/dirty");
    expect(reason).toContain("it would discard changes to tracked files in /dirty, a main checkout other threads share");
    expect(reason).toContain("`git -c claude.mainCheckout=allow stash push -m <why>`");
  });

  test.each([
    ["git -c claude.mainCheckout=allow stash drop"],
    ["git -c claude.mainCheckout=allow stash drop stash@{1}"],
    ["git -c claude.mainCheckout=allow stash clear"],
  ])("%s: a change the user asked for still keeps stashed work", (...row) => {
    expect(verdict(...row)).toContain("it deletes stashed work in /main");
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
    ["git -c claude.mainCheckout=allow config claude.mainCheckout allow"],
  ])("only the user sets it: %s", (...row) => {
    const reason = verdict(...row);
    expect(reason).toContain("claude.mainCheckout in git config is the user's standing switch for the guard-main-checkout hook, and only the user sets it.");
    expect(reason).toContain("pass it on that git command instead: If the user's own message asked");
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

  test("allows a fast-forward-only merge or pull in the main checkout, and blocks a plain one", () => {
    expect(run("git merge --ff-only feature", main)).toEqual({ code: 0, stderr: "" });
    expect(run("git pull --ff-only", main)).toEqual({ code: 0, stderr: "" });
    expect(run("git merge feature", main).code).toBe(2);
    expect(run("git pull", main).code).toBe(2);
  });

  test("allows a switch to the default branch only while no tracked file has changes", () => {
    git(main, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(main, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(run("git switch main", main)).toEqual({ code: 0, stderr: "" });
    expect(run("git switch feature", main).code).toBe(2);
    writeFileSync(join(main, "a.txt"), "changed");
    try {
      expect(run("git switch main", main).code).toBe(2);
    } finally {
      writeFileSync(join(main, "a.txt"), "a");
    }
  });

  test("allows branch changes in a repository the user allowed", () => {
    git(main, "config", "claude.mainCheckout", "allow");
    try {
      expect(run("git reset --hard", main)).toEqual({ code: 0, stderr: "" });
    } finally {
      git(main, "config", "--unset", "claude.mainCheckout");
    }
  });

  test("allows one branch change the user asked for, marked on the git command", () => {
    expect(run("git -c claude.mainCheckout=allow reset --hard", main)).toEqual({ code: 0, stderr: "" });
    expect(run("git reset --hard", main).code).toBe(2);
  });

  test("keeps tracked changes even in a change the user asked for", () => {
    writeFileSync(join(main, "a.txt"), "changed");
    try {
      const result = run("git -c claude.mainCheckout=allow reset --hard", main);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("it would discard changes to tracked files");
      expect(run("git -c claude.mainCheckout=allow stash push -m why", main)).toEqual({ code: 0, stderr: "" });
    } finally {
      writeFileSync(join(main, "a.txt"), "a");
    }
  });

  test("allows branch changes in a repository under its temporary directory", () => {
    expect(run("git switch feature", main, root)).toEqual({ code: 0, stderr: "" });
  });

  test("allows commands outside a repository", () => {
    expect(run("git switch feature", root)).toEqual({ code: 0, stderr: "" });
  });
});
