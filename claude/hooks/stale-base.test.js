import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleBase } from "./stale-base.js";

const HOOK = join(import.meta.dir, "stale-base.js");
// Every git call here, the hook's included, ignores the developer's global and system config.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
delete ENV.GIT_SSH_COMMAND;
delete ENV.GIT_SSH;
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, env: ENV, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd, name) {
  writeFileSync(join(cwd, `${name}.txt`), name);
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", name);
  return git(cwd, "rev-parse", "HEAD");
}

// A main checkout of origin, a linked worktree on a new branch cut from its local main (as T3's
// delegate_task and `claude --worktree` do), and an upstream clone that pushes to origin.
function setup() {
  const root = mkdtempSync(join(tmpdir(), "stale-base-"));
  roots.push(root);
  git(root, "init", "-q", "--bare", "origin.git");
  git(root, "clone", "-q", "origin.git", "upstream");
  const upstream = join(root, "upstream");
  commit(upstream, "first");
  git(upstream, "push", "-q", "origin", "HEAD:main");
  git(root, "clone", "-q", "origin.git", "main");
  const main = join(root, "main");
  const tree = join(root, "tree");
  git(main, "worktree", "add", "-q", "-b", "t3/child", tree);
  const advance = (name = "next") => {
    const sha = commit(upstream, name);
    git(upstream, "push", "-q", "origin", "HEAD:main");
    return sha;
  };
  return { root, main, tree, advance };
}

const check = (cwd, options) => staleBase(cwd, { env: ENV, ...options });

describe("staleBase", () => {
  test("a fresh worktree whose base is behind origin is told to fast-forward, and is not changed", () => {
    const { tree, advance } = setup();
    const before = git(tree, "rev-parse", "HEAD");
    advance("a");
    const tip = advance("b");
    expect(check(tree)).toBe(`This worktree starts behind: its branch t3/child has no commits of its own and is 2 commit(s) behind origin/main (${tip.slice(0, 12)}). Before the first edit, run \`git merge --ff-only origin/main\`, unless the task asks for this older base.`);
    expect(git(tree, "rev-parse", "HEAD")).toBe(before);
    // The fetch updated only the remote-tracking ref, so the advice works as given.
    git(tree, "merge", "--ff-only", "-q", "origin/main");
    expect(check(tree)).toBeUndefined();
  });

  test("a worktree at origin's tip has no note", () => {
    const { tree } = setup();
    expect(check(tree)).toBeUndefined();
  });

  test("a main checkout is left to config-sync and freshen-base, even when behind", () => {
    const { main, advance } = setup();
    advance();
    expect(check(main)).toBeUndefined();
  });

  test("a branch with commits of its own is a chosen base and has no note", () => {
    const { tree, advance } = setup();
    commit(tree, "mine");
    advance();
    expect(check(tree)).toBeUndefined();
  });

  test("a failed fetch falls back to the last fetched ref, and says so", () => {
    const { root, tree, advance } = setup();
    git(tree, "remote", "set-url", "origin", join(root, "gone.git"));
    expect(check(tree)).toBeUndefined();
    git(tree, "remote", "set-url", "origin", join(root, "origin.git"));
    const tip = advance();
    git(tree, "fetch", "-q", "origin");
    git(tree, "remote", "set-url", "origin", join(root, "gone.git"));
    advance("later");
    expect(check(tree)).toMatch(new RegExp(`is 1 commit\\(s\\) behind origin/main \\(${tip.slice(0, 12)}\\) \\(the fetch failed, so this is the last fetched origin/main\\)\\.`));
  });

  test("a hung fetch is cut off at the timeout and the session goes on", () => {
    const { tree, advance } = setup();
    advance();
    // An ssh remote whose ssh command hangs stands in for an unreachable network.
    git(tree, "remote", "set-url", "origin", "ssh://example.invalid/repo.git");
    git(tree, "config", "core.sshCommand", "sleep 2;");
    const started = Date.now();
    expect(check(tree, { fetchTimeout: 300 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("ssh gives up connecting within the fetch timeout, without prompting", () => {
    const { tree, advance } = setup();
    advance();
    git(tree, "remote", "set-url", "origin", "ssh://example.invalid/repo.git");
    const log = join(tree, "..", "ssh-args");
    git(tree, "config", "core.sshCommand", `echo >${log}`);
    check(tree, { fetchTimeout: 2_500 });
    expect(readFileSync(log, "utf8")).toMatch(/^-o BatchMode=yes -o ConnectTimeout=3 /);
  });

  test("without origin/HEAD, main still counts as the default branch", () => {
    const { tree, main, advance } = setup();
    git(main, "remote", "set-head", "origin", "-d");
    advance();
    expect(check(tree)).toMatch(/is 1 commit\(s\) behind origin\/main/);
  });

  test("a detached HEAD is named as such", () => {
    const { tree, advance } = setup();
    git(tree, "checkout", "-q", "--detach");
    advance();
    expect(check(tree)).toMatch(/^This worktree starts behind: its detached HEAD has no commits of its own/);
  });

  test("a folder outside git, or a worktree with no remote, is ignored", () => {
    const root = mkdtempSync(join(tmpdir(), "stale-base-"));
    roots.push(root);
    expect(check(root)).toBeUndefined();
    git(root, "init", "-q", "solo");
    commit(join(root, "solo"), "first");
    git(join(root, "solo"), "worktree", "add", "-q", "-b", "child", join(root, "solo-tree"));
    expect(check(join(root, "solo-tree"))).toBeUndefined();
  });
});

describe("hook process", () => {
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8", env: ENV });

  test("gives Claude the note as SessionStart context and exits 0", () => {
    const { tree, advance } = setup();
    advance();
    const result = run({ hook_event_name: "SessionStart", source: "startup", cwd: tree });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    expect(output.hookEventName).toBe("SessionStart");
    expect(output.additionalContext).toMatch(/^This worktree starts behind/);
  });

  test("prints nothing when current, and bad input is a non-blocking error", () => {
    const { tree } = setup();
    const quiet = run({ hook_event_name: "SessionStart", source: "startup", cwd: tree });
    expect([quiet.status, quiet.stdout]).toEqual([0, ""]);
    const bad = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/JSON/);
  });
});
