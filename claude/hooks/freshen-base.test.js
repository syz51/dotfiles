import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createsWorktree, fetchEnv, freshen } from "./freshen-base.js";

const HOOK = join(import.meta.dir, "freshen-base.js");
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

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "freshen-base-"));
  roots.push(root);
  return root;
}

// A checkout of origin's main, and an upstream clone that pushes to origin.
function setup() {
  const root = scratch();
  git(root, "init", "-q", "--bare", "origin.git");
  git(root, "clone", "-q", "origin.git", "upstream");
  const upstream = join(root, "upstream");
  commit(upstream, "first");
  git(upstream, "push", "-q", "origin", "HEAD:main");
  git(root, "clone", "-q", "origin.git", "work");
  const work = join(root, "work");
  const advance = (name = "next") => {
    const sha = commit(upstream, name);
    git(upstream, "push", "-q", "origin", "HEAD:main");
    return sha;
  };
  return { root, work, advance, head: () => git(work, "rev-parse", "HEAD") };
}

const freshenHere = (cwd) => freshen(cwd, { env: ENV });

describe("which calls create a worktree", () => {
  test("EnterWorktree with a new name or none, and Agent or Task with worktree isolation", () => {
    const { work } = setup();
    expect(createsWorktree({ tool_name: "EnterWorktree", tool_input: { name: "x" }, cwd: work })).toBe(true);
    expect(createsWorktree({ tool_name: "EnterWorktree", tool_input: {}, cwd: work })).toBe(true);
    expect(createsWorktree({ tool_name: "Agent", tool_input: { isolation: "worktree" } })).toBe(true);
    expect(createsWorktree({ tool_name: "Task", tool_input: { isolation: "worktree" } })).toBe(true);
  });

  test("not entering or resuming an existing worktree, a shared-checkout agent or other tools", () => {
    const { work } = setup();
    mkdirSync(join(work, ".claude", "worktrees", "old"), { recursive: true });
    expect(createsWorktree({ tool_name: "EnterWorktree", tool_input: { name: "old" }, cwd: work })).toBe(false);
    expect(createsWorktree({ tool_name: "EnterWorktree", tool_input: { path: "/w" } })).toBe(false);
    expect(createsWorktree({ tool_name: "Agent", tool_input: { prompt: "p" } })).toBe(false);
    expect(createsWorktree({ tool_name: "Agent", tool_input: { isolation: "remote" } })).toBe(false);
    expect(createsWorktree({ tool_name: "Bash", tool_input: { command: "ls" } })).toBe(false);
  });
});

describe("freshen", () => {
  test("a clean main behind origin fast-forwards to origin's tip", () => {
    const { work, advance, head } = setup();
    const tip = advance();
    expect(freshenHere(work)).toBe(`Fast-forwarded main by 1 commit(s) to origin/main (${tip.slice(0, 12)}) before creating the worktree.`);
    expect(head()).toBe(tip);
  });

  test("an up-to-date main is left without a note", () => {
    const { work, head } = setup();
    const before = head();
    expect(freshenHere(work)).toBeUndefined();
    expect(head()).toBe(before);
  });

  test("without origin/HEAD, main still counts as the default branch", () => {
    const { work, advance, head } = setup();
    git(work, "remote", "set-head", "origin", "-d");
    const tip = advance();
    expect(freshenHere(work)).toMatch(/^Fast-forwarded main by 1 commit\(s\)/);
    expect(head()).toBe(tip);
  });

  test("an unpushed commit is kept, even when origin moved on", () => {
    const { work, advance, head } = setup();
    const local = commit(work, "local");
    expect(freshenHere(work)).toBeUndefined();
    expect(head()).toBe(local);
    advance();
    expect(freshenHere(work)).toMatch(/has commits of its own and is 1 commit\(s\) behind origin\/main; it was left as it is/);
    expect(head()).toBe(local);
  });

  test("tracked changes stop the fast-forward and are kept", () => {
    const { work, advance, head } = setup();
    const before = head();
    advance();
    writeFileSync(join(work, "first.txt"), "edited");
    expect(freshenHere(work)).toMatch(/has tracked changes, so it was not fast-forwarded/);
    expect(head()).toBe(before);
    expect(git(work, "status", "--porcelain")).toBe("M first.txt");
  });

  test("a failed fast-forward is reported in one line and leaves the checkout as it was", () => {
    const { work, advance, head } = setup();
    const before = head();
    advance("clash");
    writeFileSync(join(work, "clash.txt"), "mine");
    expect(freshenHere(work)).toMatch(/^Fast-forwarding main to origin\/main failed \([^\n]+\); the new worktree starts 1 commit\(s\) behind\.$/);
    expect(head()).toBe(before);
    expect(readFileSync(join(work, "clash.txt"), "utf8")).toBe("mine");
  });

  test("a failed fetch is reported, and nothing is changed", () => {
    const { root, work, head } = setup();
    const before = head();
    git(work, "remote", "set-url", "origin", join(root, "gone.git"));
    expect(freshenHere(work)).toMatch(/^Fetching origin\/main failed \([^\n]+\); the new worktree starts from local main as it is, which may be behind origin\/main\.$/);
    expect(head()).toBe(before);
  });

  test("a branch with no commits yet, or a remote branch the fetch does not track, is skipped", () => {
    const root = scratch();
    git(root, "init", "-q", "--bare", "origin.git");
    git(root, "init", "-q", "unborn");
    git(join(root, "unborn"), "remote", "add", "origin", join(root, "origin.git"));
    expect(freshenHere(join(root, "unborn"))).toBeUndefined();
    const { work } = setup();
    git(work, "config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other");
    git(work, "update-ref", "-d", "refs/remotes/origin/main");
    expect(freshenHere(work)).toBeUndefined();
  });

  test("a feature branch is not touched", () => {
    const { work, advance, head } = setup();
    git(work, "checkout", "-q", "-b", "feature");
    const before = head();
    advance();
    expect(freshenHere(work)).toBeUndefined();
    expect(head()).toBe(before);
  });

  test("a folder outside git is ignored", () => {
    expect(freshenHere(scratch())).toBeUndefined();
  });

  test("the fetch never prompts: git's prompt is off and ssh runs in batch mode", () => {
    const { work } = setup();
    expect(fetchEnv(work, ENV)).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
    git(work, "config", "core.sshCommand", "ssh -i key");
    expect(fetchEnv(work, ENV).GIT_SSH_COMMAND).toBe("ssh -i key -o BatchMode=yes");
    expect(fetchEnv(work, { ...ENV, GIT_SSH_COMMAND: "myssh" }).GIT_SSH_COMMAND).toBe("myssh -o BatchMode=yes");
  });
});

describe("hook process", () => {
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8", env: ENV });
  const runAsync = (input) => new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: ENV });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (status) => resolve({ status, stdout }));
    child.stdin.end(JSON.stringify(input));
  });

  test("tells Claude what it fast-forwarded and exits 0", () => {
    const { work, advance, head } = setup();
    const tip = advance();
    const result = run({ tool_name: "Agent", tool_input: { isolation: "worktree" }, cwd: work });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    expect(output.hookEventName).toBe("PreToolUse");
    expect(output.additionalContext).toMatch(/^Fast-forwarded main/);
    expect(head()).toBe(tip);
  });

  test("parallel calls take turns: one fast-forwards, none fails, and the lock is released", async () => {
    const { work, advance, head } = setup();
    const tip = advance();
    const results = await Promise.all(Array.from({ length: 4 }, () => runAsync({ tool_name: "Agent", tool_input: { isolation: "worktree" }, cwd: work })));
    expect(results.map((result) => result.status)).toEqual([0, 0, 0, 0]);
    const notes = results.filter((result) => result.stdout).map((result) => JSON.parse(result.stdout).hookSpecificOutput.additionalContext);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^Fast-forwarded main by 1 commit\(s\)/);
    expect(head()).toBe(tip);
    expect(existsSync(join(work, ".git", "freshen-base.lock"))).toBe(false);
  });

  test("other calls do nothing, and bad input is a non-blocking error", () => {
    const { work, advance, head } = setup();
    const before = head();
    advance();
    const plain = run({ tool_name: "Agent", tool_input: {}, cwd: work });
    expect([plain.status, plain.stdout]).toEqual([0, ""]);
    expect(head()).toBe(before);
    const bad = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
    // Exit 2 would block the tool; any other failure is shown and the call goes ahead.
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/JSON/);
  });
});
