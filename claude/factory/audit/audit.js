// Security posture checks for this Claude Code setup. Everything here reads only; the one
// exception is --with-tests, which runs the hooks' own test suite. Each finding has a
// stable id (the baseline accepts findings by id), a severity, a title and a short fix.
//
// ~/.claude.json can hold tokens (MCP server env, headers, URLs), so nothing read from it
// reaches a finding except server names that pass a strict pattern and a transport type
// from a fixed list. Settings values that may carry secrets (permission rules, hook
// arguments, env) are summarized, never echoed, apart from the fixed patterns matched below.
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { childEnv, runProcess } from "../../tests/lib/process.js";

export const SEVERITIES = ["info", "low", "medium", "high"];
export const rank = (severity) => SEVERITIES.indexOf(severity);

const finding = (id, severity, title, fix, detail) => ({ id, severity, title, fix, ...(detail ? { detail } : {}) });

// Paths the audit reads, from the environment it runs in. CLAUDE_CONFIG_DIR moves both
// ~/.claude and ~/.claude.json (code.claude.com/docs/en/claude-directory).
export function auditPaths(env = process.env, { agentSkills } = {}) {
  const home = env.HOME || homedir();
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return {
    home,
    configDir,
    claudeJson: env.CLAUDE_CONFIG_DIR ? join(configDir, ".claude.json") : join(home, ".claude.json"),
    agentSkills: agentSkills || join(home, ".local", "share", "agent-skills", "repository"),
    hooksTests: join(import.meta.dir, "..", "..", "hooks"),
  };
}

// A settings file as { file, settings }, null when absent, or { file, error } when it
// does not parse (Claude Code then skips the file).
function readSettings(file) {
  if (!existsSync(file)) return null;
  try {
    const settings = JSON.parse(readFileSync(file, "utf8"));
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { file, error: "not a JSON object" };
    return { file, settings };
  } catch {
    return { file, error: "invalid JSON" };
  }
}

// Scalars from settings.local.json win over settings.json; lists are combined, as Claude
// Code merges them across scopes.
function merged(sources, path) {
  const values = sources.map(({ settings }) => path.reduce((value, key) => value?.[key], settings)).filter((value) => value !== undefined);
  if (values.some(Array.isArray)) return values.flatMap((value) => (Array.isArray(value) ? value : []));
  if (values.length && values.every((value) => value && typeof value === "object")) return Object.assign({}, ...values);
  return values.at(-1);
}

const BROAD_ALLOW = new Set(["*", "Bash", "Bash(*)", "Bash(**)", "Bash(:*)", "Edit", "Edit(**)", "Edit(//**)", "Write", "Write(**)", "mcp__*", "WebFetch"]);

function settingsFindings(sources) {
  const findings = [];
  const get = (...path) => merged(sources, path);
  const mode = get("permissions", "defaultMode");
  const sandboxOn = get("sandbox", "enabled") === true;
  const bypass = mode === "bypassPermissions";

  if (bypass)
    findings.push(finding("permissions.default-bypass", sandboxOn ? "medium" : "high",
      `permissions.defaultMode is bypassPermissions${sandboxOn ? "" : " with the sandbox off"}: every tool call runs without a prompt`,
      "Use auto or acceptEdits for interactive sessions, or keep bypass and enable the sandbox with allowUnsandboxedCommands: false"));
  else findings.push(finding("permissions.default-mode", "info", `permissions.defaultMode is ${JSON.stringify(mode ?? "unset")}`, "None needed"));

  if (get("skipDangerousModePermissionPrompt") === true)
    findings.push(finding("permissions.skip-dangerous-prompt", "low",
      "skipDangerousModePermissionPrompt is true: bypassPermissions starts without its confirmation dialog",
      "Remove the key so entering bypassPermissions asks once per session"));

  if (bypass && get("permissions", "blockWritesOutsideWorkingDirectories") !== true)
    findings.push(finding("permissions.writes-outside-workdir", "low",
      "Write, Edit and NotebookEdit can write anywhere in bypassPermissions (the sandbox never covers file tools)",
      "Set permissions.blockWritesOutsideWorkingDirectories: true; add other folders with --add-dir or additionalDirectories"));

  const allow = get("permissions", "allow") ?? [];
  const broad = allow.filter((rule) => BROAD_ALLOW.has(rule));
  if (broad.length)
    findings.push(finding("permissions.broad-allow", "medium", `permissions.allow has tool-wide rules: ${broad.join(", ")}`,
      "Replace tool-wide allow rules with command- or path-scoped ones"));
  findings.push(finding("permissions.rules", "info",
    `${allow.length} allow and ${(get("permissions", "deny") ?? []).length} deny rules`, "None needed"));

  if (!sandboxOn) {
    findings.push(finding("sandbox.disabled", "medium", "sandbox.enabled is not true: Bash runs with full filesystem and network access",
      "Opt in to the sandbox for interactive sessions, or keep it off and rely on the unattended profile for claude -p runs"));
  } else {
    if (get("sandbox", "filesystem", "disabled") === true)
      findings.push(finding("sandbox.filesystem-disabled", "high", "sandbox.filesystem.disabled is true: sandboxed commands can write anywhere", "Remove sandbox.filesystem.disabled"));
    if (get("sandbox", "failIfUnavailable") !== true)
      findings.push(finding("sandbox.fail-open", "low", "sandbox.failIfUnavailable is not true: commands run unsandboxed when the sandbox cannot start", "Set sandbox.failIfUnavailable: true"));
    if (get("sandbox", "allowUnsandboxedCommands") !== false)
      findings.push(finding("sandbox.unsandboxed-retry", bypass ? "high" : "medium",
        `sandbox.allowUnsandboxedCommands is not false: Claude can retry commands outside the sandbox${bypass ? " without a prompt (bypassPermissions)" : ""}`,
        "Set sandbox.allowUnsandboxedCommands: false (strict sandbox mode)"));
    const excluded = get("sandbox", "excludedCommands") ?? [];
    if (excluded.length)
      findings.push(finding("sandbox.excluded-commands", "low", `${excluded.length} sandbox.excludedCommands entries run with full access`, "Prefer filesystem.allowWrite or allowedDomains over excluding a command"));
    const domains = get("sandbox", "network", "allowedDomains") ?? [];
    if (domains.includes("*"))
      findings.push(finding("sandbox.network-any", "medium", "sandbox.network.allowedDomains contains \"*\"", "List the hosts commands need instead of \"*\""));
    if (bypass && get("sandbox", "network", "strictAllowlist") !== true)
      findings.push(finding("sandbox.network-open-in-bypass", "medium",
        "In bypassPermissions, hosts outside allowedDomains are allowed unless sandbox.network.strictAllowlist is true",
        "Set sandbox.network.strictAllowlist: true"));
    for (const [path, severity] of [
      [["network", "allowAllUnixSockets"], "medium"], [["enableWeakerNetworkIsolation"], "medium"],
      [["enableWeakerNestedSandbox"], "medium"], [["allowAppleEvents"], "medium"],
      [["allowNestedUserNamespaces"], "medium"], [["network", "allowLocalBinding"], "low"],
    ])
      if (get("sandbox", ...path) === true)
        findings.push(finding(`sandbox.${path.join(".")}`, severity, `sandbox.${path.join(".")} is true and weakens the sandbox`, `Remove sandbox.${path.join(".")}`));
  }

  if (get("disableClaudeAiConnectors") === true)
    findings.push(finding("mcp.claude-ai-connectors-off", "info", "disableClaudeAiConnectors is true: claude.ai connectors are not loaded", "None needed"));
  else
    findings.push(finding("mcp.claude-ai-connectors-on", "info", "claude.ai connectors load into every session, such as Gmail",
      "None needed; turn off connectors you do not use in /mcp or deniedMcpServers"));

  const plugins = Object.entries(get("enabledPlugins") ?? {}).filter(([, on]) => on === true).map(([name]) => name);
  if (plugins.length)
    for (const name of plugins)
      findings.push(finding(`plugin:${name}`, "low", `Plugin ${name} is enabled; its hooks and MCP servers run outside the sandbox`, "Disable plugins you do not use"));
  else findings.push(finding("plugins.none", "info", "No plugins enabled", "None needed"));
  return findings;
}

// Splits a hook command into words: quotes and backslash escapes as in sh, expanding
// $HOME, ${HOME}, $CLAUDE_CONFIG_DIR and a leading ~. Stops at the first control operator,
// so only the first command of a pipeline or list is checked. A word that still holds a
// variable is returned with unresolved set.
export function commandWords(command, vars) {
  const words = [];
  let word = null;
  let unresolved = false;
  const expand = (text) => text.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced, bare) => {
    const name = braced ?? bare;
    if (name in vars) return vars[name];
    unresolved = true;
    return match;
  });
  const flush = () => {
    if (word !== null) words.push({ text: word.text, raw: word.raw, unresolved: word.unresolved });
    word = null;
  };
  const add = (text, raw, expandIt) => {
    word ??= { text: "", raw: "", unresolved: false };
    unresolved = false;
    word.text += expandIt ? expand(text) : text;
    word.raw += raw;
    word.unresolved ||= unresolved;
  };
  for (let i = 0; i < command.length;) {
    const char = command[i];
    if (/\s/.test(char)) {
      flush();
      i++;
    } else if (/[;&|<>()]/.test(char)) {
      break;
    } else if (char === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end;
      add(command.slice(i + 1, stop), command.slice(i, stop + 1), false);
      i = stop + 1;
    } else if (char === '"') {
      let j = i + 1;
      let text = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) j++;
        text += command[j++];
      }
      add(text, command.slice(i, j + 1), true);
      i = j + 1;
    } else {
      let j = i;
      while (j < command.length && !/[\s;&|<>()'"]/.test(command[j])) j += command[j] === "\\" ? 2 : 1;
      const raw = command.slice(i, j);
      let text = raw.replace(/\\(.)/g, "$1");
      if (word === null && text.startsWith("~/")) text = vars.HOME + text.slice(1);
      add(text, raw, true);
      i = j;
    }
  }
  flush();
  return words;
}

const executable = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const onPath = (name, path) => (path ?? "").split(delimiter).some((dir) => dir && executable(join(dir, name)));

function hookFindings(sources, env, home, configDir) {
  const findings = [];
  const vars = { HOME: home, CLAUDE_CONFIG_DIR: configDir };
  let commands = 0;
  for (const { file, settings } of sources) {
    for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      // A failing PreToolUse hook is a non-blocking error, so a missing guard fails open.
      const severity = event === "PreToolUse" ? "high" : "medium";
      for (const group of groups)
        for (const hook of group?.hooks ?? []) {
          if (hook?.type !== "command" || typeof hook.command !== "string") continue;
          commands++;
          const words = commandWords(hook.command, vars);
          if (!words.length) continue;
          const [program, ...rest] = words;
          const where = `${event} hook in ${basename(file)}`;
          if (program.unresolved)
            findings.push(finding(`hook.unchecked:${event}:${program.raw}`, "info", `${where}: executable ${program.raw} depends on a variable the audit cannot resolve`, "None needed"));
          else if (program.text.includes("/") ? !executable(program.text) : !onPath(program.text, env.PATH))
            findings.push(finding(`hook.missing-executable:${event}:${program.raw}`, severity,
              `${where}: executable ${program.raw} is missing or not executable${severity === "high" ? "; the hook fails open" : ""}`,
              "Install the program or fix the hook's path"));
          for (const word of rest) {
            // Only arguments that are absolute paths after expansion are checked as scripts.
            if (word.unresolved || !word.text.startsWith("/")) continue;
            if (!existsSync(word.text))
              findings.push(finding(`hook.missing-script:${event}:${word.raw}`, severity,
                `${where}: script ${word.raw} does not exist${severity === "high" ? "; the hook fails open" : ""}`,
                "Restore the script or remove the hook"));
          }
        }
    }
  }
  findings.push(finding("hooks.count", "info", `${commands} command hooks configured`, "None needed"));
  return findings;
}

// Hook tests: bun test over the hooks folder that ships with this audit.
export async function hookTestFinding(dir) {
  if (!existsSync(dir)) return finding("hooks.tests-missing", "medium", `Hook tests folder ${dir} does not exist`, "Restore claude/hooks");
  const result = await runProcess([process.execPath, "test", dir], { cwd: dir, env: childEnv(process.env), timeout: 300_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  const count = (label) => Number(output.match(new RegExp(`(\\d+) ${label}\\b`))?.[1] ?? 0);
  const pass = count("pass");
  const fail = count("fail");
  if (result.code === 0 && pass > 0)
    return finding("hooks.tests", "info", `Hook tests pass (${pass} pass, ${fail} fail)`, "None needed");
  return finding("hooks.tests-failed", "high", `Hook tests fail (exit ${result.code}, ${pass} pass, ${fail} fail): guards may not block what they should`,
    `Run bun test ${dir} and fix the failures`);
}

const SERVER_NAME = /^[\w.@-]{1,64}$/;
const SERVER_TYPES = new Set(["stdio", "sse", "http", "ws", "sdk"]);
const serverType = (server) => {
  if (server?.type === undefined) return typeof server?.command === "string" ? "stdio" : "unknown";
  return SERVER_TYPES.has(server.type) ? server.type : "unknown";
};

// MCP servers from ~/.claude.json, by name and type only.
function mcpFindings(path) {
  if (!existsSync(path)) return [finding("mcp.config-missing", "info", ".claude.json not found; no user MCP servers", "None needed")];
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // The parser's message can quote the file, so it is not reported.
    return [finding("mcp.config-unreadable", "medium", ".claude.json does not parse; MCP servers could not be checked", "Run claude doctor")];
  }
  const servers = new Map();
  const add = (entries, scope) => {
    if (!entries || typeof entries !== "object") return;
    for (const [name, server] of Object.entries(entries)) {
      const safe = SERVER_NAME.test(name) ? name : "<unprintable name>";
      const key = `${safe}|${serverType(server)}`;
      const entry = servers.get(key) ?? { name: safe, type: serverType(server), user: false, projects: 0 };
      if (scope === "user") entry.user = true;
      else entry.projects++;
      servers.set(key, entry);
    }
  };
  add(config?.mcpServers, "user");
  for (const project of Object.values(config?.projects ?? {})) add(project?.mcpServers, "project");
  if (!servers.size) return [finding("mcp.none", "info", "No MCP servers in .claude.json", "None needed")];
  return [...servers.values()].map(({ name, type, user, projects }) => {
    const scope = [user && "user", projects && `${projects} project${projects > 1 ? "s" : ""}`].filter(Boolean).join(", ");
    return finding(`mcp:${name}:${type}`, type === "stdio" ? "low" : "info",
      `MCP server ${name} (${type}; ${scope})${type === "stdio" ? " runs with your full access outside the sandbox" : ""}`,
      "Remove servers you do not use; keep tokens in env references, not inline");
  });
}

// The YAML front matter keys this audit needs: scalars and comma-separated or dash lists.
export function frontMatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = {};
  let list = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) {
      fields[list].push(item[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const pair = line.match(/^([\w-]+):\s*(.*)$/);
    if (!pair) continue;
    const value = pair[2].trim().replace(/^["']|["']$/g, "");
    if (value === "") {
      fields[pair[1]] = [];
      list = pair[1];
    } else {
      fields[pair[1]] = value;
      list = null;
    }
  }
  return fields;
}

const toolList = (value) => (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []).map((tool) => tool.trim()).filter(Boolean);

function agentFindings(configDir) {
  const dir = join(configDir, "agents");
  if (!existsSync(dir)) return [finding("agents.none", "info", "No agents folder", "None needed")];
  const findings = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const fields = frontMatter(text);
    const name = SERVER_NAME.test(fields?.name ?? "") ? fields.name : file.replace(/\.md$/, "");
    if (!fields) {
      findings.push(finding(`agent:${name}:front-matter`, "low", `Agent file ${file} has no front matter`, "Add name, description and tool limits"));
      continue;
    }
    const tools = toolList(fields.tools);
    const denied = toolList(fields.disallowedTools);
    const has = (tool) => (!tools.length || tools.includes(tool)) && !denied.includes(tool);
    findings.push(finding(`agent:${name}`, "info",
      `Agent ${name}: model ${fields.model ?? "inherit"}, tools ${tools.length ? tools.join(", ") : "all"}, disallowedTools ${denied.length ? denied.join(", ") : "none"}`,
      "None needed"));
    if (fields.permissionMode === "bypassPermissions")
      findings.push(finding(`agent:${name}:bypass`, "medium", `Agent ${name} sets permissionMode: bypassPermissions`, "Remove permissionMode or use a narrower mode"));
    const body = text.slice(text.indexOf("---", 3) + 3);
    if (/read-only|read only|do not edit/i.test(`${fields.description ?? ""}\n${body}`) && has("Bash"))
      findings.push(finding(`agent:${name}:read-only-by-instruction`, "low",
        `Agent ${name} is described as read-only but can run Bash, so it can still write files`,
        "Accept it (Bash is needed to investigate) or add Bash to disallowedTools"));
  }
  return findings;
}

// The agent-skills weekly review: unsandboxed when it runs bypassPermissions without a
// sandbox --settings.
function agentSkillsFindings(repo) {
  const file = join(repo, "scripts", "claude_cli.py");
  if (!existsSync(file)) return [finding("agent-skills.review-missing", "info", "agent-skills claude_cli.py not found; review not checked", "None needed")];
  const text = readFileSync(file, "utf8");
  const bypass = /["']--permission-mode["']\s*,\s*["']bypassPermissions["']/.test(text) || /--permission-mode[ =]bypassPermissions/.test(text);
  const settings = /["']--settings["']/.test(text);
  if (bypass && !settings)
    return [finding("agent-skills.review-unsandboxed", "high",
      "agent-skills weekly review runs claude --permission-mode bypassPermissions with full tools and no sandbox --settings",
      "Pass --settings with factory/audit/maintainer-sandbox.json in review_command")];
  if (bypass)
    return [finding("agent-skills.review-settings", "info", "agent-skills weekly review passes --settings; confirm it enables the sandbox", "None needed")];
  return [finding("agent-skills.review", "info", "agent-skills weekly review does not use bypassPermissions", "None needed")];
}

// All findings for the setup the paths describe, ordered most severe first.
export async function audit({ paths, env = process.env, withTests = false }) {
  const findings = [];
  const sources = [];
  for (const name of ["settings.json", "settings.local.json"]) {
    const source = readSettings(join(paths.configDir, name));
    if (!source) continue;
    if (source.error) findings.push(finding(`settings.unreadable:${name}`, "medium", `${name} is ${source.error}; Claude Code skips it`, "Fix the file; claude doctor shows the error"));
    else sources.push(source);
  }
  if (!sources.length) findings.push(finding("settings.missing", "info", `No readable settings in ${paths.configDir}`, "None needed"));
  findings.push(...settingsFindings(sources));
  findings.push(...hookFindings(sources, env, paths.home, paths.configDir));
  if (withTests) findings.push(await hookTestFinding(paths.hooksTests));
  findings.push(...mcpFindings(paths.claudeJson));
  findings.push(...agentFindings(paths.configDir));
  findings.push(...agentSkillsFindings(paths.agentSkills));
  return findings.sort((a, b) => rank(b.severity) - rank(a.severity) || a.id.localeCompare(b.id));
}
