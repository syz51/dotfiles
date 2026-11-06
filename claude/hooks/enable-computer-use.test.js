import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enable, enableInFile, isTemporary, projectKey, SERVER, withConfigLock } from "./enable-computer-use.js";

const HOOK = join(import.meta.dir, "enable-computer-use.js");
let scratch;

beforeEach(() => { scratch = realpathSync(mkdtempSync(join(tmpdir(), "enable-computer-use-"))); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const sh = (cwd, ...args) => {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

describe("enable", () => {
  test("adds the server to a new project", () => {
    expect(enable({ numStartups: 1 }, "/repo")).toEqual({ numStartups: 1, projects: { "/repo": { enabledMcpServers: [SERVER] } } });
  });

  test("keeps the project's other settings and enabled servers", () => {
    const config = { projects: { "/repo": { allowedTools: ["Bash"], enabledMcpServers: ["other"] }, "/x": {} } };
    expect(enable(config, "/repo").projects).toEqual({
      "/repo": { allowedTools: ["Bash"], enabledMcpServers: ["other", SERVER] },
      "/x": {},
    });
  });

  test("returns undefined when the server is already enabled", () => {
    expect(enable({ projects: { "/repo": { enabledMcpServers: [SERVER] } } }, "/repo")).toBeUndefined();
  });
});

describe("projectKey", () => {
  test("is the folder itself outside git", () => {
    expect(projectKey(scratch)).toBe(scratch);
  });

  test("is the repository root from a subfolder, and the main root from a linked worktree", () => {
    const repo = join(scratch, "repo");
    mkdirSync(join(repo, "sub"), { recursive: true });
    sh(repo, "git", "init", "-q");
    sh(repo, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    sh(repo, "git", "worktree", "add", "-q", join(scratch, "wt"));
    expect(projectKey(join(repo, "sub"))).toBe(repo);
    expect(projectKey(join(scratch, "wt"))).toBe(repo);
  });

  test("is the bare repository for a worktree of one", () => {
    const bare = join(scratch, "repo.git");
    sh(scratch, "git", "init", "-q", "--bare", bare);
    sh(scratch, "git", "-C", bare, "worktree", "add", "-q", "--orphan", join(scratch, "wt"));
    expect(projectKey(join(scratch, "wt"))).toBe(bare);
  });

  // git answers: toplevel, git dir, common dir
  const answering = (lines) => () => lines.join("\n");
  test("keeps a submodule's own root, and the worktree's when the common dir is a checkout", () => {
    expect(projectKey("/super/mod", answering(["/super/mod", "/super/.git/modules/mod", "/super/.git/modules/mod"]))).toBe("/super/mod");
    expect(projectKey("/s/wt", answering(["/s/wt", "/s/.git/modules/mod/worktrees/wt", "/s/.git/modules/mod"]))).toBe("/s/.git/modules/mod");
    const checkout = join(scratch, "co");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    expect(projectKey("/s/wt", answering(["/s/wt", `${checkout}/worktrees/wt`, checkout]))).toBe("/s/wt");
  });

  test("is undefined when git cannot answer inside a repository", () => {
    mkdirSync(join(scratch, "repo", ".git", "x"), { recursive: true });
    expect(projectKey(join(scratch, "repo", ".git", "x"), () => undefined)).toBeUndefined();
    expect(() => projectKey(scratch, () => { throw new Error("git timed out"); })).toThrow("git timed out");
  });
});

test("isTemporary matches folders inside the roots only", () => {
  expect(isTemporary("/tmp/x", ["/tmp"])).toBe(true);
  expect(isTemporary("/tmp", ["/tmp"])).toBe(true);
  expect(isTemporary("/tmpfoo", ["/tmp"])).toBe(false);
  expect(isTemporary("/Users/me/project")).toBe(false);
  expect(isTemporary(realpathSync(tmpdir()))).toBe(true);
});

describe("enableInFile", () => {
  test("writes through a linked config, keeping the link, its mode and the other data", () => {
    const target = join(scratch, "real.json");
    writeFileSync(target, JSON.stringify({ numStartups: 3, projects: { "/a": { x: 1 } } }, null, 2), { mode: 0o600 });
    const link = join(scratch, ".claude.json");
    symlinkSync(target, link);
    expect(enableInFile(link, "/repo")).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
      numStartups: 3,
      projects: { "/a": { x: 1 }, "/repo": { enabledMcpServers: [SERVER] } },
    });
    expect(existsSync(`${link}.lock`)).toBe(false);
    expect(enableInFile(link, "/repo")).toBe(false);
  });

  test("leaves the file alone while another process holds the lock", () => {
    const config = join(scratch, ".claude.json");
    writeFileSync(config, "{}");
    mkdirSync(`${config}.lock`);
    expect(enableInFile(config, "/repo")).toBe(false);
    expect(readFileSync(config, "utf8")).toBe("{}");
    expect(existsSync(`${config}.lock`)).toBe(true);
  });

  test("returns without the lock when the server is already enabled", () => {
    const config = join(scratch, ".claude.json");
    writeFileSync(config, JSON.stringify({ projects: { "/repo": { enabledMcpServers: [SERVER] } } }));
    mkdirSync(`${config}.lock`);
    const start = Date.now();
    expect(enableInFile(config, "/repo")).toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("releases the lock when the update throws", () => {
    const config = join(scratch, ".claude.json");
    expect(() => withConfigLock(config, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(`${config}.lock`)).toBe(false);
  });
});

describe("hook", () => {
  const runHook = (cwd, configDir, env = {}) => spawnSync("bun", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...env },
  });

  test("ignores an inherited GIT_DIR", () => {
    const home = join(scratch, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".claude.json"), "{}");
    const other = join(scratch, "other");
    sh(scratch, "git", "init", "-q", other);
    expect(runHook("/Users", home, { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other }).status).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects)).toEqual(["/Users"]);
  });

  test("reports a missing folder or malformed input without failing the session", () => {
    for (const input of [JSON.stringify({ cwd: join(scratch, "gone") }), "not json"]) {
      const result = spawnSync("bun", [HOOK], { input, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("enable-computer-use:");
    }
  });

  test("enables the session's project and prints nothing into the context", () => {
    const home = join(scratch, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".claude.json"), "{}");
    const project = "/Users"; // a stable folder outside git and outside temporary roots
    const result = runHook(project, home);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects[project].enabledMcpServers).toEqual([SERVER]);
  });

  test("skips sessions in temporary folders", () => {
    const home = join(scratch, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".claude.json"), "{}");
    const result = runHook(scratch, home);
    expect(result.status).toBe(0);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe("{}");
  });

  test("reports an unreadable config on stderr without failing the session", () => {
    const home = join(scratch, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".claude.json"), "not json");
    const result = runHook("/Users", home);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("enable-computer-use:");
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe("not json");
  });
});
