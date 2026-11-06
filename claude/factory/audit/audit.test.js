import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { childEnv, runProcess } from "../../tests/lib/process.js";
import { audit, commandWords, frontMatter, hookTestFinding } from "./audit.js";
import { readProfile, UNATTENDED } from "./sandbox.js";

const CLI = join(import.meta.dir, "..", "cli.js");
// Shaped like a real token so a leak would be obvious; never valid anywhere.
const TOKEN = "sk-ant-oat01-FAKEtoken0000DO-NOT-LEAK-7f3c9e";
let scratch;
let home;
let config;

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
};
const script = (path) => {
  write(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
};

const SETTINGS = {
  permissions: { defaultMode: "bypassPermissions", allow: ["Bash(git status)", "Bash(*)"] },
  skipDangerousModePermissionPrompt: true,
  sandbox: { enabled: false },
  enabledPlugins: { "formatter@team": true, "off@team": false },
  hooks: {
    PreToolUse: [{ matcher: "^Bash$", hooks: [
      { type: "command", command: "\"$HOME/bin/runner\" \"$HOME/.claude/hooks/guard.js\"" },
      { type: "command", command: "\"$HOME/bin/runner\" \"$HOME/.claude/hooks/gone.js\" --flag" },
      { type: "command", command: "$CLAUDE_PROJECT_DIR/hook.sh" },
    ] }],
    PostToolUse: [{ hooks: [{ type: "command", command: "~/bin/missing-tool hook && echo done" }] }],
  },
};

const CLAUDE_JSON = {
  oauthAccount: { token: TOKEN },
  mcpServers: {
    remote: { type: "http", url: `https://mcp.example.com/?key=${TOKEN}`, headers: { Authorization: `Bearer ${TOKEN}` } },
    local: { command: "node", args: ["server.js", `--token=${TOKEN}`], env: { API_KEY: TOKEN } },
    odd: { type: TOKEN },
  },
  projects: {
    "/work/app": { mcpServers: { local: { command: "node", env: { SECRET: TOKEN } }, db: { type: "stdio", command: "db", args: [TOKEN] } } },
  },
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claude-factory-audit-"));
  home = join(scratch, "home");
  config = join(home, ".claude");
  script(join(home, "bin", "runner"));
  write(join(config, "hooks", "guard.js"), "");
  write(join(config, "settings.json"), SETTINGS);
  write(join(config, ".claude.json"), CLAUDE_JSON);
  write(join(config, "agents", "looker.md"), "---\nname: looker\ndescription: \"Read-only investigation\"\nmodel: haiku\ndisallowedTools: Write, Edit\n---\n\nInvestigate only.\n");
  write(join(config, "agents", "runner.md"), "---\nname: runner\ndescription: Does things\npermissionMode: bypassPermissions\ntools:\n  - Read\n  - Bash\n---\nBody\n");
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const env = (extra = {}) => childEnv(process.env, {
  HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_FACTORY_STATE: join(scratch, "state"), PATH: "/usr/bin:/bin", ...extra,
});
const cli = async (args, extra) => {
  const result = await runProcess([process.execPath, CLI, "audit", "--codex-skills", join(scratch, "codex"), ...args], { cwd: scratch, env: env(extra) });
  return { ...result, all: `${result.stdout}\n${result.stderr}` };
};
const json = async (args = [], extra) => {
  const result = await cli(["--json", ...args], extra);
  return { ...result, report: JSON.parse(result.stdout) };
};
const byId = (report) => Object.fromEntries(report.findings.map((item) => [item.id, item]));

describe("audit command", () => {
  test("reports the posture with a severity and fix per finding", async () => {
    const { report, code } = await json();
    const found = byId(report);
    expect(code).toBe(1);
    expect(found["permissions.default-bypass"].severity).toBe("high");
    expect(found["permissions.skip-dangerous-prompt"].severity).toBe("low");
    expect(found["permissions.writes-outside-workdir"].severity).toBe("low");
    expect(found["permissions.broad-allow"]).toMatchObject({ severity: "medium", title: "permissions.allow has tool-wide rules: Bash(*)" });
    expect(found["sandbox.disabled"].severity).toBe("medium");
    expect(found["mcp.claude-ai-connectors-on"].severity).toBe("info");
    expect(found["plugin:formatter@team"].severity).toBe("low");
    expect(found["plugin:off@team"]).toBeUndefined();
    expect(found["codex-skills.review-missing"].severity).toBe("info");
    for (const item of report.findings) {
      expect(["high", "medium", "low", "info"]).toContain(item.severity);
      expect(item.fix.length).toBeGreaterThan(0);
    }
    expect(report.failing.sort()).toEqual(["agent:runner:bypass", "permissions.broad-allow", "permissions.default-bypass", "sandbox.disabled",
      "hook.missing-script:PreToolUse:\"$HOME/.claude/hooks/gone.js\"", "hook.missing-executable:PostToolUse:~/bin/missing-tool"].sort());
  });

  test("flags missing hook executables and scripts, high where a guard fails open", async () => {
    const found = byId((await json()).report);
    expect(found["hook.missing-script:PreToolUse:\"$HOME/.claude/hooks/gone.js\""].severity).toBe("high");
    expect(found["hook.missing-executable:PostToolUse:~/bin/missing-tool"].severity).toBe("medium");
    expect(found["hook.unchecked:PreToolUse:$CLAUDE_PROJECT_DIR/hook.sh"].severity).toBe("info");
    expect(Object.keys(found).filter((id) => id.startsWith("hook.") && (id.includes("guard.js") || id.includes("runner")))).toEqual([]);
    expect(found["hooks.count"].title).toBe("4 command hooks configured");
  });

  test("reads settings.local.json too: its scalars win and its lists add", async () => {
    write(join(config, "settings.local.json"), {
      permissions: { defaultMode: "acceptEdits", allow: ["Write"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "/nowhere/stop-hook" }] }] },
    });
    const found = byId((await json()).report);
    expect(found["permissions.default-bypass"]).toBeUndefined();
    expect(found["permissions.default-mode"].title).toContain("acceptEdits");
    expect(found["permissions.broad-allow"].title).toBe("permissions.allow has tool-wide rules: Bash(*), Write");
    expect(found["hook.missing-executable:Stop:/nowhere/stop-hook"].severity).toBe("medium");
  });

  test("lists MCP servers by name and type, and never prints a value from .claude.json", async () => {
    const { report, all } = await json();
    const found = byId(report);
    expect(found["mcp:remote:http"].title).toBe("MCP server remote (http; user)");
    expect(found["mcp:local:stdio"]).toMatchObject({ severity: "low", title: expect.stringContaining("(stdio; user, 1 project)") });
    expect(found["mcp:odd:unknown"]).toBeDefined();
    expect(found["mcp:db:stdio"].title).toContain("1 project");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("FAKEtoken");
    const text = await cli([]);
    expect(text.all).not.toContain("FAKEtoken");
    await cli(["--update-baseline"]);
    expect(readFileSync(join(scratch, "state", "audit-baseline.json"), "utf8")).not.toContain("FAKEtoken");
  });

  test("a .claude.json that does not parse is reported without its contents", async () => {
    write(join(config, ".claude.json"), `{"mcpServers": {"x": {"env": {"K": "${TOKEN}"}}}, oops`);
    const { report, all } = await json();
    expect(byId(report)["mcp.config-unreadable"].severity).toBe("medium");
    expect(all).not.toContain("FAKEtoken");
  });

  test("reports each agent's tool limits and flags weak ones", async () => {
    const found = byId((await json()).report);
    expect(found["agent:looker"].title).toBe("Agent looker: model haiku, tools all, disallowedTools Write, Edit");
    expect(found["agent:looker:read-only-by-instruction"].severity).toBe("low");
    expect(found["agent:runner"].title).toContain("tools Read, Bash");
    expect(found["agent:runner:bypass"].severity).toBe("medium");
    expect(found["agent:runner:read-only-by-instruction"]).toBeUndefined();
  });

  test("checks whether the codex-skills weekly review runs unsandboxed", async () => {
    const file = join(scratch, "codex", "scripts", "claude_cli.py");
    write(file, "def review_command(cli):\n    return [str(cli), '--print', '--permission-mode', 'bypassPermissions']\n");
    expect(byId((await json()).report)["codex-skills.review-unsandboxed"].severity).toBe("high");
    write(file, "def review_command(cli):\n    return [str(cli), '--permission-mode', 'bypassPermissions', '--settings', PROFILE]\n");
    expect(byId((await json()).report)["codex-skills.review-settings"].severity).toBe("info");
  });

  test("a baseline accepts findings by id; --fail-on sets the threshold for the rest", async () => {
    expect((await cli(["--update-baseline"])).code).toBe(0);
    const accepted = await json();
    expect(accepted.code).toBe(0);
    expect(accepted.report.failing).toEqual([]);
    expect(accepted.report.findings.every((item) => item.accepted)).toBe(true);

    // A new medium finding fails the default threshold but not --fail-on high.
    write(join(config, "settings.local.json"), { permissions: { allow: ["Edit"] }, disableClaudeAiConnectors: true });
    const changed = await cli(["--update-baseline", "--baseline", join(scratch, "other.json")]);
    expect(changed.code).toBe(0);
    rmSync(join(config, "settings.local.json"));
    write(join(config, "settings.local.json"), { hooks: { Stop: [{ hooks: [{ type: "command", command: "/nowhere/x" }] }] } });
    const regressed = await json();
    expect(regressed.code).toBe(1);
    expect(regressed.report.failing).toEqual(["hook.missing-executable:Stop:/nowhere/x"]);
    expect((await cli(["--fail-on", "high"])).code).toBe(0);
    expect((await cli(["--fail-on", "none"])).code).toBe(0);
    expect((await cli(["--fail-on", "low"])).code).toBe(1);

    // Text output names what fails.
    const text = await cli([]);
    expect(text.stdout).toContain("1 finding at or above medium not in the baseline: hook.missing-executable:Stop:/nowhere/x");
    expect(text.stdout).toContain("[accepted]");
  });

  test("a finding accepted at one severity fails again when it grows more severe", async () => {
    write(join(config, "settings.json"), { ...SETTINGS, hooks: {}, sandbox: { enabled: true } });
    await cli(["--update-baseline"]);
    expect((await cli([])).code).toBe(0);
    write(join(config, "settings.json"), { ...SETTINGS, hooks: {}, sandbox: { enabled: false } });
    const { report, code } = await json();
    expect(code).toBe(1);
    expect(report.failing).toContain("permissions.default-bypass");
  });

  test("rejects unknown options and severities with exit 2", async () => {
    expect((await cli(["--nope"])).code).toBe(2);
    const bad = await cli(["--fail-on", "critical"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--fail-on must be one of");
    expect((await cli(["--help"])).code).toBe(0);
  });

  test("a malformed baseline fails loudly", async () => {
    write(join(scratch, "state", "audit-baseline.json"), { accepted: [] });
    const result = await cli([]);
    expect(result.code).not.toBe(0);
    expect(result.all).toContain("not an audit baseline");
  });
});

describe("audit internals", () => {
  test("commandWords splits like sh, expands known variables and stops at operators", () => {
    const vars = { HOME: "/h", CLAUDE_CONFIG_DIR: "/c" };
    const words = (command) => commandWords(command, vars).map(({ text, unresolved }) => (unresolved ? `?${text}` : text));
    expect(words("\"$HOME/bin/x\" '$HOME/lit' ${CLAUDE_CONFIG_DIR}/hooks/a.js")).toEqual(["/h/bin/x", "$HOME/lit", "/c/hooks/a.js"]);
    expect(words("~/bin/tool --flag && rm -rf /")).toEqual(["/h/bin/tool", "--flag"]);
    expect(words("a\\ b \"c \\\"d\\\"\" | e")).toEqual(["a b", "c \"d\""]);
    expect(words("$CLAUDE_PROJECT_DIR/x.sh")).toEqual(["?$CLAUDE_PROJECT_DIR/x.sh"]);
  });

  test("frontMatter reads scalars and both list forms", () => {
    expect(frontMatter("---\nname: a\ntools: Read, Bash\ndisallowedTools:\n  - Write\n  - \"Edit\"\n---\nbody")).toEqual({
      name: "a", tools: "Read, Bash", disallowedTools: ["Write", "Edit"],
    });
    expect(frontMatter("no front matter")).toBeNull();
  });

  test("--with-tests reports passing and failing hook suites", async () => {
    const passing = write(join(scratch, "pass", "ok.test.js"), "import { test, expect } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n");
    const failing = write(join(scratch, "fail", "bad.test.js"), "import { test, expect } from 'bun:test';\ntest('bad', () => expect(1).toBe(2));\n");
    expect(await hookTestFinding(dirname(passing))).toMatchObject({ id: "hooks.tests", severity: "info", title: "Hook tests pass (1 pass, 0 fail)" });
    expect(await hookTestFinding(dirname(failing))).toMatchObject({ id: "hooks.tests-failed", severity: "high" });
    expect(await hookTestFinding(join(scratch, "absent"))).toMatchObject({ id: "hooks.tests-missing", severity: "medium" });
  }, 60_000);

  test("settings equal to the unattended profile pass the audit's sandbox checks", async () => {
    const profile = readProfile(UNATTENDED);
    write(join(config, "settings.json"), { ...profile, permissions: { ...profile.permissions, defaultMode: "bypassPermissions" }, disableClaudeAiConnectors: true });
    const findings = await audit({ paths: { home, configDir: config, claudeJson: join(scratch, "none.json"), codexSkills: join(scratch, "codex") }, env: env() });
    const flagged = findings.filter((item) => item.severity !== "info" && /^(sandbox|permissions)\./.test(item.id)).map((item) => `${item.severity} ${item.id}`);
    expect(flagged).toEqual(["medium permissions.default-bypass"]);
  });
});
