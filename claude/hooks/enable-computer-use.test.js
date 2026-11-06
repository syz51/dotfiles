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

  test("keeps a submodule's own root", () => {
    const run = (dir, args) => ({
      "rev-parse --show-toplevel": "/super/mod",
      "rev-parse --path-format=absolute --absolute-git-dir": "/super/.git/modules/mod",
      "rev-parse --path-format=absolute --git-common-dir": "/super/.git/modules/mod",
    })[args.join(" ")];
    expect(projectKey("/super/mod", run)).toBe("/super/mod");
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

  test("releases the lock when the update throws", () => {
    const config = join(scratch, ".claude.json");
    expect(() => withConfigLock(config, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(`${config}.lock`)).toBe(false);
  });
});

describe("hook", () => {
  const runHook = (cwd, configDir) => spawnSync("bun", [HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
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
