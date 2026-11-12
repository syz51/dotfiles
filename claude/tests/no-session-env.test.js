// claude/bin/no-session-env: runs a command without the parent Claude Code session's
// variables and keeps the rest of the environment.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SESSION_VARIABLE, sessionVariables } from "../bin/session-env.js";
import { childEnv } from "./lib/process.js";

const COMMAND = join(import.meta.dir, "..", "bin", "no-session-env");
const PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

const root = mkdtempSync(join(tmpdir(), "no-session-env-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The variables a T3 Code session put in its Bash tool's environment (Claude Code 2.1.322),
// with made-up values, and names the pattern must leave alone.
const SESSION = {
  CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "t3-code", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_EFFORT: "high",
  CLAUDE_CODE_SESSION_ID: "session", CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/socket",
  CLAUDE_CODE_MESSAGING_TOKEN: "token", CLAUDE_CODE_EXECPATH: "/bin/claude", CLAUDE_PID: "1",
  CLAUDE_AGENT_SDK_VERSION: "0.0.0", AI_AGENT: "claude-code", T3CODE_THREAD_ID: "thread", T3CODE_CLI_PATH: "/bin/t3",
};
const KEPT = {
  PATH, HOME: "/home/someone", USER: "someone", LOGNAME: "someone", SHELL: "/bin/zsh", TERM: "xterm-256color", LANG: "en_US.UTF-8",
  ANTHROPIC_API_KEY: "kept", NOT_CLAUDE_X: "kept", CLAUDE: "kept", AI_AGENTS: "kept", T3CODE: "kept",
  SPACED: "a b  c", MULTILINE: "line 1\nCLAUDECODE=1\nline 3",
};

// Variables the system adds on its own: /bin/sh, which runs the script, exports PWD and
// SHLVL, and macOS adds __CF_USER_TEXT_ENCODING to every process.
const ADDED = ["PWD", "SHLVL", "__CF_USER_TEXT_ENCODING"];

// The environment a command sees through no-session-env, read with `env -0` so values
// may hold newlines.
function seenEnv(env, { command = COMMAND, cwd, args = [] } = {}) {
  const run = spawnSync(command, [...args, "env", "-0"], { env, cwd, encoding: "utf8" });
  expect(run.status).toBe(0);
  const seen = Object.fromEntries(run.stdout.split("\0").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  for (const name of ADDED) delete seen[name];
  return seen;
}

test("removes every session variable and keeps the rest unchanged", () => {
  expect(seenEnv({ ...KEPT, ...SESSION })).toEqual(KEPT);
});

test("passes the environment through unchanged outside a session", () => {
  expect(seenEnv(KEPT)).toEqual(KEPT);
});

test("works through a link in another folder, as installed in ~/.local/bin", () => {
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(COMMAND, join(bin, "no-session-env"));
  expect(seenEnv({ ...KEPT, ...SESSION }, { command: join(bin, "no-session-env") })).toEqual(KEPT);
});

test("a caller's bunfig.toml preload and .env do not change the list", () => {
  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(project, "preload.js"), 'console.log("HOME PATH");\n');
  writeFileSync(join(project, "bunfig.toml"), 'preload = ["./preload.js"]\n');
  writeFileSync(join(project, ".env"), "CLAUDE_FROM_DOTENV=1\n");
  expect(seenEnv({ ...KEPT, ...SESSION }, { cwd: project })).toEqual(KEPT);
});

test("variables given as NAME=value before the command are put back", () => {
  const seen = seenEnv({ ...KEPT, ...SESSION }, { args: ["CLAUDE_CONFIG_DIR=/cfg"] });
  expect(seen).toEqual({ ...KEPT, CLAUDE_CONFIG_DIR: "/cfg" });
});

test("without arguments prints the cleaned environment", () => {
  const run = spawnSync(COMMAND, [], { env: { ...KEPT, ...SESSION }, encoding: "utf8" });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("HOME=/home/someone\n");
  expect(run.stdout).not.toMatch(/^(?:CLAUDE_CODE_SESSION_ID|T3CODE_THREAD_ID|AI_AGENT)=/m);
});

test("passes arguments and exit status through and replaces itself with the command", () => {
  const run = spawnSync(COMMAND, ["sh", "-c", 'printf "%s|" "$@" "$$"; exit 7', "sh", "two words", "", "-u"], { env: { ...KEPT, ...SESSION }, encoding: "utf8" });
  expect(run.status).toBe(7);
  expect(run.stdout).toBe(`two words||-u|${run.pid}|`);
});

test("fails when bun is missing instead of running the command with the session's variables", () => {
  const run = spawnSync(COMMAND, ["sh", "-c", "echo ran"], { env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", CLAUDECODE: "1" }, encoding: "utf8" });
  expect(run.status).not.toBe(0);
  expect(run.stdout).toBe("");
});

test("the command and the test harness remove the same variables", () => {
  const env = { ...KEPT, ...SESSION };
  expect(sessionVariables(env).sort()).toEqual(Object.keys(SESSION).sort());
  expect(Object.keys(childEnv(env)).filter((name) => SESSION_VARIABLE.test(name))).toEqual([]);
  expect(childEnv(env)).toEqual({ ...KEPT, AGENT_BOARD_HOOKS: "off" });
});
