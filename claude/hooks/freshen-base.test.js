import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createsWorktree, freshen } from "./freshen-base.js";

const HOOK = join(import.meta.dir, "freshen-base.js");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
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

// A checkout of origin's main, and an upstream clone that pushes to origin.
function setup() {
  const root = mkdtempSync(join(tmpdir(), "freshen-base-"));
  roots.push(root);
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

describe("which calls create a worktree", () => {
  test("EnterWorktree with a name, and Agent or Task with worktree isolation", () => {
    expect(createsWorktree({ tool_name: "EnterWorktree", tool_input: { name: "x" } })).toBe(true);
    expect(createsWorktree({ tool_name: "EnterWorktree", tool_input: {} })).toBe(true);
    expect(createsWorktree({ tool_name: "Agent", tool_input: { isolation: "worktree" } })).toBe(true);
    expect(createsWorktree({ tool_name: "Task", tool_input: { isolation: "worktree" } })).toBe(true);
  });

  test("not entering an existing worktree, a shared-checkout agent or other tools", () => {
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
    expect(freshen(work)).toMatch(/^Fast-forwarded main by 1 commit\(s\) to origin\/main/);
    expect(head()).toBe(tip);
  });

  test("an up-to-date main is left without a note", () => {
    const { work, head } = setup();
    const before = head();
    expect(freshen(work)).toBeUndefined();
    expect(head()).toBe(before);
  });

  test("an unpushed commit is kept, even when origin moved on", () => {
    const { work, advance, head } = setup();
    const local = commit(work, "local");
    expect(freshen(work)).toBeUndefined();
    expect(head()).toBe(local);
    advance();
    expect(freshen(work)).toMatch(/has commits of its own and is 1 commit\(s\) behind origin\/main; it was left as it is/);
    expect(head()).toBe(local);
  });

  test("tracked changes stop the fast-forward and are kept", () => {
    const { work, advance, head } = setup();
    const before = head();
    advance();
    writeFileSync(join(work, "first.txt"), "edited");
    expect(freshen(work)).toMatch(/has tracked changes, so it was not fast-forwarded/);
    expect(head()).toBe(before);
    expect(git(work, "status", "--porcelain")).toBe("M first.txt");
  });

  test("a feature branch is not touched", () => {
    const { work, advance, head } = setup();
    git(work, "checkout", "-q", "-b", "feature");
    const before = head();
    advance();
    expect(freshen(work)).toBeUndefined();
    expect(head()).toBe(before);
  });

  test("a folder outside git is ignored", () => {
    const root = mkdtempSync(join(tmpdir(), "freshen-base-"));
    roots.push(root);
    expect(freshen(root)).toBeUndefined();
  });
});

describe("hook process", () => {
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8", env: ENV });

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

  test("other calls and bad input do nothing and never block", () => {
    const { work, advance, head } = setup();
    const before = head();
    advance();
    const plain = run({ tool_name: "Agent", tool_input: {}, cwd: work });
    expect([plain.status, plain.stdout]).toEqual([0, ""]);
    expect(head()).toBe(before);
    const bad = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
    expect(bad.status).toBe(0);
    expect(bad.stderr).toMatch(/^freshen-base: /);
  });
});
