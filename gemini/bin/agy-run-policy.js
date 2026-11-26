#!/usr/bin/env bun
/**
 * Policy builder, validator, and fail-closed PreToolUse hook for agy-run.
 *
 * Enforces Claude-compatible tool allowlists (--tools), permission modes
 * (--permission-mode acceptEdits|bypassPermissions|default), --strict-mcp-config,
 * and --settings (permissions.deny, permissions.blockWritesOutsideWorkingDirectories,
 * permissions.additionalDirectories, hooks.PreToolUse). Fails closed on any setting,
 * deny rule, tool name, permission mode, or hook payload it cannot faithfully enforce.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const CLAUDE_TO_AGY = {
  Read: ["read_file", "view_file", "list_dir", "find_by_name", "grep_search"],
  Edit: ["edit_file", "replace_file_content", "multi_replace_file_content", "sed_file"],
  Write: ["write_file", "write_to_file"],
  Glob: [],
  Grep: [],
  Bash: ["run_command", "command_status", "send_command_input", "manage_task"],
  WebSearch: ["search_web"],
  WebFetch: ["read_url", "read_url_content"],
  Agent: ["invoke_subagent", "define_subagent", "manage_subagents", "send_message", "swarm"],
  Task: ["invoke_subagent", "define_subagent", "manage_subagents", "send_message", "swarm"],
  Workflow: ["run_workflow"],
  ScheduleWakeup: ["schedule"],
  NotebookEdit: [],
  AskUserQuestion: ["ask_question"],
};

export const UNRESTRICTED_CLAUDE_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Bash",
  "WebSearch",
  "Agent",
  "Workflow",
  "ScheduleWakeup",
  "AskUserQuestion",
];

const ACCEPT_EDITS_CLAUDE_TOOLS = new Set(["Read", "Edit", "Write"]);
const VALID_PERMISSION_MODES = new Set(["bypassPermissions", "acceptEdits", "default"]);
const MCP_TOOLS = new Set(["call_mcp_tool", "list_resources", "read_resource"]);
const READ_TOOLS = new Set(["read_file", "view_file", "list_dir", "find_by_name", "grep_search"]);
const EDIT_TOOLS = new Set(["edit_file", "replace_file_content", "multi_replace_file_content", "sed_file"]);
const WRITE_TOOLS = new Set(["write_file", "write_to_file"]);
const AGY_TO_CLAUDE = {
  read_file: "Read",
  view_file: "Read",
  list_dir: "Read",
  find_by_name: "Read",
  grep_search: "Read",
  edit_file: "Edit",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  sed_file: "Edit",
  write_file: "Write",
  write_to_file: "Write",
  run_command: "Bash",
  command_status: "Bash",
  send_command_input: "Bash",
  manage_task: "Bash",
  search_web: "WebSearch",
  read_url: "WebFetch",
  read_url_content: "WebFetch",
  invoke_subagent: "Agent",
  define_subagent: "Agent",
  manage_subagents: "Agent",
  send_message: "Agent",
  swarm: "Agent",
  run_workflow: "Workflow",
  schedule: "ScheduleWakeup",
  ask_question: "AskUserQuestion",
};

const MAX_SYMLINK_HOPS = 40;
const CASE_INSENSITIVE = process.platform === "darwin";

export function expandHome(target, home = homedir()) {
  if (target === "~") return home;
  if (target.startsWith("~/")) return join(home, target.slice(2));
  return target;
}

/**
 * Resolves symlinks and canonical filesystem casing in POSIX traversal order (resolving
 * each symlink BEFORE collapsing any subsequent `..` segment) even when leaf components
 * do not exist yet or when an intermediate/leaf entry is a dangling symlink. Throws on
 * symlink loops or unreadable paths so callers fail closed.
 */
export function resolveRealPath(rawPath, baseDir = "/") {
  let cur = "/";
  let segments;
  if (isAbsolute(rawPath)) {
    segments = rawPath.split("/");
  } else {
    const resolvedBase = baseDir === "/" ? "/" : resolveRealPath(resolve(baseDir), "/");
    cur = resolvedBase;
    segments = rawPath.split("/");
  }

  let hops = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      cur = dirname(cur);
      continue;
    }

    const next = cur === "/" ? `/${seg}` : `${cur}/${seg}`;
    let st;
    try {
      st = lstatSync(next);
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
        let base = cur;
        try {
          base = realpathSync.native(cur);
        } catch (baseErr) {
          if (baseErr?.code !== "ENOENT" && baseErr?.code !== "ENOTDIR") throw baseErr;
        }
        let tailCur = base;
        for (let j = i; j < segments.length; j++) {
          const tailSeg = segments[j];
          if (!tailSeg || tailSeg === ".") continue;
          if (tailSeg === "..") tailCur = dirname(tailCur);
          else tailCur = tailCur === "/" ? `/${tailSeg}` : `${tailCur}/${tailSeg}`;
        }
        return tailCur;
      }
      throw err;
    }

    if (st.isSymbolicLink()) {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) {
        throw new Error(`Too many symlink levels while resolving ${rawPath}`);
      }
      const target = readlinkSync(next);
      const targetSegs = target.split("/");
      segments = [...targetSegs, ...segments.slice(i + 1)];
      if (isAbsolute(target)) {
        cur = "/";
      }
      i = -1;
      continue;
    }

    cur = next;
  }

  try {
    return realpathSync.native(cur);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return cur;
    throw err;
  }
}

export function resolveCandidatePaths(rawPath, { cwd, home = homedir() }) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("Missing or empty path argument");
  }
  const expanded = expandHome(rawPath, home);
  const lexical = resolve(cwd, expanded);
  const real = resolveRealPath(expanded, cwd);
  return { lexical, real };
}

function escapeRegex(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegexSource(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  return `${out}$`;
}

function stripTrailingSlashes(p) {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function expandPatternVariants(rawPattern, { cwd, home }) {
  const trimmed = rawPattern.trim();
  const candidates = [];
  if (trimmed.startsWith("//")) {
    candidates.push(trimmed.slice(1));
  } else if (trimmed === "~" || trimmed.startsWith("~/")) {
    candidates.push(expandHome(trimmed, home));
  } else if (trimmed.startsWith("/")) {
    // Claude settings treat single leading `/` as project-relative; also match absolute defensively.
    candidates.push(resolve(cwd, trimmed.slice(1)));
    candidates.push(trimmed);
  } else {
    candidates.push(resolve(cwd, trimmed));
  }

  const expanded = new Set();
  for (const pat of candidates) {
    const cleaned = stripTrailingSlashes(pat);
    expanded.add(cleaned);
    // Resolve static prefix realpath (e.g. /var -> /private/var, /tmp -> /private/tmp).
    const wildIdx = cleaned.search(/[*?]/);
    const staticPrefix = wildIdx === -1
      ? cleaned
      : cleaned.slice(0, cleaned.lastIndexOf("/", wildIdx) + 1).replace(/\/+$/, "") || "/";
    const suffix = wildIdx === -1 ? "" : cleaned.slice(staticPrefix === "/" ? 1 : staticPrefix.length);
    try {
      const realPrefix = resolveRealPath(staticPrefix);
      if (realPrefix && realPrefix !== staticPrefix) {
        const joined = suffix
          ? (realPrefix === "/" ? `/${suffix.replace(/^\/+/, "")}` : `${realPrefix}${suffix.startsWith("/") ? suffix : `/${suffix}`}`)
          : realPrefix;
        expanded.add(stripTrailingSlashes(joined));
      }
    } catch {
      // Unresolvable prefix: keep lexical pattern only.
    }
  }
  return [...expanded];
}

export function compilePathPattern(rawPattern, { cwd, home = homedir() }) {
  const flags = CASE_INSENSITIVE ? "i" : "";
  const regexes = [];
  for (const variant of expandPatternVariants(rawPattern, { cwd, home })) {
    if (variant.endsWith("/**")) {
      const base = stripTrailingSlashes(variant.slice(0, -3));
      const baseSrc = globToRegexSource(base).slice(0, -1); // strip trailing $
      regexes.push(new RegExp(`${baseSrc}(?:/.*)?$`, flags));
    } else if (!/[*?]/.test(variant)) {
      const exactSrc = `^${escapeRegex(variant)}(?:/.*)?$`;
      regexes.push(new RegExp(exactSrc, flags));
    } else {
      regexes.push(new RegExp(globToRegexSource(variant), flags));
    }
  }
  return regexes;
}

export function matchesCompiledPatterns(paths, compiledList) {
  for (const regex of compiledList) {
    if (regex.test(paths.lexical) || regex.test(paths.real)) return true;
  }
  return false;
}

function normalizeForComparison(p) {
  const clean = stripTrailingSlashes(p);
  return CASE_INSENSITIVE ? clean.toLowerCase() : clean;
}

export function isWithinAllowedRoots(paths, allowedRoots) {
  const target = normalizeForComparison(paths.real);
  for (const root of allowedRoots) {
    const normRoot = normalizeForComparison(root);
    if (normRoot === "/") return true;
    if (target === normRoot || target.startsWith(`${normRoot}/`)) return true;
  }
  return false;
}

export function loadSettingsObject(settingsInput) {
  if (settingsInput === undefined || settingsInput === null || settingsInput === "") return null;
  if (typeof settingsInput === "object" && !Array.isArray(settingsInput)) {
    return settingsInput;
  }
  if (typeof settingsInput !== "string") {
    throw new Error("settings must be a JSON string, file path, or object");
  }
  const trimmed = settingsInput.trim();
  let raw = trimmed;
  if (!trimmed.startsWith("{")) {
    if (!existsSync(trimmed)) {
      throw new Error(`settings file not found: ${trimmed}`);
    }
    raw = readFileSync(trimmed, "utf8");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid settings JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings JSON must be an object");
  }
  return parsed;
}

function parseSettings(settingsObj) {
  const result = {
    deniedClaudeTools: new Set(),
    denyReadPatterns: [],
    denyEditPatterns: [],
    denyWritePatterns: [],
    blockWritesOutsideWorkingDirectories: false,
    additionalDirectories: [],
    preToolUseHooks: [],
  };
  if (!settingsObj) return result;

  const allowedTop = new Set(["$schema", "permissions", "hooks"]);
  for (const key of Object.keys(settingsObj)) {
    if (key === "sandbox") {
      throw new Error(
        'agy-run cannot enforce Claude Code "sandbox" settings; set CLAUDE_FACTORY_PROVIDER=claude or omit sandbox settings',
      );
    }
    if (!allowedTop.has(key)) {
      throw new Error(`Unsupported settings key for agy-run: "${key}"`);
    }
  }

  if (settingsObj.permissions !== undefined) {
    const perms = settingsObj.permissions;
    if (!perms || typeof perms !== "object" || Array.isArray(perms)) {
      throw new Error("settings.permissions must be an object");
    }
    const allowedPermKeys = new Set([
      "deny",
      "blockWritesOutsideWorkingDirectories",
      "additionalDirectories",
    ]);
    for (const key of Object.keys(perms)) {
      if (!allowedPermKeys.has(key)) {
        throw new Error(`Unsupported settings.permissions key for agy-run: "${key}"`);
      }
    }
    if (perms.blockWritesOutsideWorkingDirectories !== undefined) {
      if (typeof perms.blockWritesOutsideWorkingDirectories !== "boolean") {
        throw new Error("settings.permissions.blockWritesOutsideWorkingDirectories must be a boolean");
      }
      result.blockWritesOutsideWorkingDirectories = perms.blockWritesOutsideWorkingDirectories;
    }
    if (perms.additionalDirectories !== undefined) {
      if (
        !Array.isArray(perms.additionalDirectories) ||
        !perms.additionalDirectories.every((d) => typeof d === "string" && d.trim())
      ) {
        throw new Error("settings.permissions.additionalDirectories must be an array of paths");
      }
      result.additionalDirectories.push(...perms.additionalDirectories);
    }
    if (perms.deny !== undefined) {
      if (!Array.isArray(perms.deny) || !perms.deny.every((r) => typeof r === "string")) {
        throw new Error("settings.permissions.deny must be an array of strings");
      }
      for (const rule of perms.deny) {
        const trimmed = rule.trim();
        if (Object.hasOwn(CLAUDE_TO_AGY, trimmed)) {
          result.deniedClaudeTools.add(trimmed);
          continue;
        }
        const match = /^(Read|Edit|Write)\((.+)\)$/.exec(trimmed);
        if (match) {
          const [, kind, pattern] = match;
          const cleanPattern = pattern.trim();
          if (!cleanPattern) {
            throw new Error(`Empty path pattern in permissions.deny rule: "${rule}"`);
          }
          if (/[{}[\]]/.test(cleanPattern) || cleanPattern.startsWith("!")) {
            throw new Error(`Unsupported glob syntax in permissions.deny rule for agy-run: "${rule}"`);
          }
          if (kind === "Read") result.denyReadPatterns.push(cleanPattern);
          else if (kind === "Edit") result.denyEditPatterns.push(cleanPattern);
          else if (kind === "Write") result.denyWritePatterns.push(cleanPattern);
          continue;
        }
        throw new Error(`Unsupported permissions.deny rule for agy-run: "${rule}"`);
      }
    }
  }

  if (settingsObj.hooks !== undefined) {
    const hooks = settingsObj.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
      throw new Error("settings.hooks must be an object");
    }
    for (const key of Object.keys(hooks)) {
      if (key !== "PreToolUse") {
        throw new Error(`Unsupported settings.hooks event for agy-run: "${key}"`);
      }
    }
    if (hooks.PreToolUse !== undefined) {
      if (!Array.isArray(hooks.PreToolUse)) {
        throw new Error("settings.hooks.PreToolUse must be an array");
      }
      for (const group of hooks.PreToolUse) {
        if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
          throw new Error("Each settings.hooks.PreToolUse entry must have a hooks array");
        }
        if (group.matcher !== undefined && typeof group.matcher !== "string") {
          throw new Error("settings.hooks.PreToolUse matcher must be a string");
        }
        for (const handler of group.hooks) {
          if (
            !handler ||
            typeof handler !== "object" ||
            (handler.type !== undefined && handler.type !== "command") ||
            typeof handler.command !== "string" ||
            !handler.command.trim()
          ) {
            throw new Error("Only command hooks with a non-empty command string are supported in settings.hooks.PreToolUse");
          }
          result.preToolUseHooks.push({
            matcher: group.matcher ?? "",
            command: handler.command,
            timeout: typeof handler.timeout === "number" && handler.timeout > 0 ? handler.timeout : 30,
          });
        }
      }
    }
  }

  return result;
}

export function parseToolsInput(toolsInput) {
  if (toolsInput === undefined || toolsInput === null) return undefined;
  const list = Array.isArray(toolsInput)
    ? toolsInput
    : typeof toolsInput === "string"
      ? (toolsInput.trim() === "" ? [] : toolsInput.split(",").map((t) => t.trim()))
      : null;
  if (!list) throw new Error("tools must be a comma-separated string or array of tool names");
  for (const name of list) {
    if (typeof name !== "string" || !Object.hasOwn(CLAUDE_TO_AGY, name)) {
      throw new Error(`Unsupported tool in --tools for agy-run: "${name}"`);
    }
  }
  return list;
}

/**
 * Validates all restriction options and builds the serializable policy object shared by
 * agy-run.js (for ACP permissions, init.tools, and violation checks) and the PreToolUse hook.
 */
export function buildAgyPolicy({
  cwd,
  home = homedir(),
  noTools = false,
  fullAccess = false,
  permissionMode,
  tools,
  settings,
  strictMcp = false,
  addDirs = [],
  internalDenyPaths = [],
  attachmentReadRoots = [],
} = {}) {
  const workDir = resolve(cwd || process.cwd());
  if (fullAccess && permissionMode && permissionMode !== "bypassPermissions") {
    throw new Error(`Cannot combine --full-access with --permission-mode ${permissionMode}`);
  }
  const effectiveMode = permissionMode || (fullAccess ? "bypassPermissions" : "default");
  if (!VALID_PERMISSION_MODES.has(effectiveMode)) {
    throw new Error(`Unsupported --permission-mode for agy-run: "${effectiveMode}"`);
  }

  const parsedTools = parseToolsInput(tools);
  const effectiveNoTools = Boolean(noTools) || (Array.isArray(parsedTools) && parsedTools.length === 0);
  const settingsObj = loadSettingsObject(settings);
  const parsedSettings = parseSettings(settingsObj);

  const restricted =
    effectiveNoTools ||
    parsedTools !== undefined ||
    Boolean(strictMcp) ||
    effectiveMode !== "bypassPermissions" ||
    settingsObj !== null;

  let exposedClaudeTools;
  let allowedAgyTools;
  if (effectiveNoTools) {
    exposedClaudeTools = [];
    allowedAgyTools = [];
  } else {
    let claudeTools = parsedTools !== undefined
      ? [...new Set(parsedTools.filter((name) => CLAUDE_TO_AGY[name].length > 0))]
      : [...UNRESTRICTED_CLAUDE_TOOLS];
    if (effectiveMode === "acceptEdits") {
      claudeTools = claudeTools.filter((name) => ACCEPT_EDITS_CLAUDE_TOOLS.has(name));
    }
    claudeTools = claudeTools.filter((name) => !parsedSettings.deniedClaudeTools.has(name));
    exposedClaudeTools = claudeTools;
    allowedAgyTools = [...new Set(claudeTools.flatMap((name) => CLAUDE_TO_AGY[name]))];
  }

  const confineWrites =
    effectiveMode === "acceptEdits" || parsedSettings.blockWritesOutsideWorkingDirectories;

  const rawRoots = [workDir, ...(addDirs || []), ...parsedSettings.additionalDirectories];
  const allowedWriteRoots = [...new Set(rawRoots.map((dir) => resolveRealPath(resolve(workDir, expandHome(dir, home)))))];
  const resolvedAttachmentReadRoots = [
    ...new Set((attachmentReadRoots || []).filter(Boolean).map((dir) => resolveRealPath(resolve(workDir, expandHome(dir, home))))),
  ];

  const internalPatterns = (internalDenyPaths || [])
    .filter(Boolean)
    .map((p) => `/${resolve(p)}/**`);

  return {
    cwd: workDir,
    home,
    noTools: effectiveNoTools,
    permissionMode: effectiveMode,
    restricted,
    enforceHook: restricted,
    strictMcp: Boolean(strictMcp) || restricted,
    confineWrites,
    allowedWriteRoots,
    attachmentReadRoots: resolvedAttachmentReadRoots,
    allowedAgyTools,
    exposedClaudeTools,
    denyReadPatterns: [...parsedSettings.denyReadPatterns, ...internalPatterns],
    denyEditPatterns: [...parsedSettings.denyEditPatterns, ...internalPatterns],
    denyWritePatterns: [...parsedSettings.denyWritePatterns, ...internalPatterns],
    preToolUseHooks: parsedSettings.preToolUseHooks,
  };
}

/**
 * Builds an official Antigravity CLI `--settings` JSON object enforcing coarse native
 * permission boundaries alongside the fine-grained PreToolUse policy hook.
 */
export function buildAgyCliSettings(policy) {
  const allow = [];
  const deny = [];
  const hasAttachments = Array.isArray(policy.attachmentReadRoots) && policy.attachmentReadRoots.length > 0;

  if (policy.noTools) {
    if (hasAttachments) {
      for (const root of policy.attachmentReadRoots) {
        allow.push(`read_file(${root})`);
      }
      deny.push("write_file(*)", "read_url(*)", "execute_url(*)", "download_url(*)", "command(*)", "mcp(*)");
    } else {
      deny.push("read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "download_url(*)", "command(*)", "mcp(*)");
    }
    return {
      toolPermission: "strict",
      allowNonWorkspaceAccess: false,
      permissions: { ...(allow.length ? { allow } : {}), deny },
    };
  }

  const allowed = new Set(policy.allowedAgyTools || []);
  const allowRead = [...READ_TOOLS].some((t) => allowed.has(t));
  const allowWrite = [...EDIT_TOOLS, ...WRITE_TOOLS].some((t) => allowed.has(t));
  const allowCommand = allowed.has("run_command");
  const allowWeb = allowed.has("read_url") || allowed.has("read_url_content");

  if (!allowRead) deny.push("read_file(*)");
  if (!allowWrite) deny.push("write_file(*)");
  if (!allowCommand) deny.push("command(*)");
  if (!allowWeb) deny.push("read_url(*)", "execute_url(*)", "download_url(*)");
  if (policy.strictMcp) deny.push("mcp(*)");

  if (policy.permissionMode === "acceptEdits") {
    for (const root of policy.allowedWriteRoots || []) {
      if (allowRead) allow.push(`read_file(${root})`);
      if (allowWrite) allow.push(`write_file(${root})`);
    }
  }

  return {
    toolPermission: policy.permissionMode === "default" ? "strict" : "request-review",
    allowNonWorkspaceAccess: !policy.confineWrites,
    permissions: {
      ...(allow.length ? { allow } : {}),
      ...(deny.length ? { deny } : {}),
    },
  };
}

function isMcpToolName(name) {
  return MCP_TOOLS.has(name) || name.startsWith("mcp_") || name.startsWith("mcp__");
}

function extractPathArg(args) {
  if (!args || typeof args !== "object") return null;
  for (const key of ["Path", "path", "file_path", "AbsolutePath", "TargetFile", "DirectoryPath", "SearchPath"]) {
    if (typeof args[key] === "string" && args[key].trim()) return args[key];
  }
  return null;
}

function translateToClaudePreToolUse(toolName, args, cwd) {
  const safeArgs = args && typeof args === "object" ? args : {};
  if (toolName === "run_command") {
    const command = typeof safeArgs.CommandLine === "string"
      ? safeArgs.CommandLine
      : typeof safeArgs.command === "string"
        ? safeArgs.command
        : "";
    return { cwd, tool_name: "Bash", tool_input: { command } };
  }
  if (READ_TOOLS.has(toolName)) {
    return { cwd, tool_name: "Read", tool_input: { file_path: extractPathArg(safeArgs) ?? "" } };
  }
  if (EDIT_TOOLS.has(toolName)) {
    return { cwd, tool_name: "Edit", tool_input: { file_path: extractPathArg(safeArgs) ?? "" } };
  }
  if (WRITE_TOOLS.has(toolName)) {
    return { cwd, tool_name: "Write", tool_input: { file_path: extractPathArg(safeArgs) ?? "" } };
  }
  if (toolName === "search_web") {
    return { cwd, tool_name: "WebSearch", tool_input: { query: safeArgs.query ?? "" } };
  }
  if (toolName === "read_url" || toolName === "read_url_content") {
    return { cwd, tool_name: "WebFetch", tool_input: { url: safeArgs.url ?? safeArgs.Url ?? "" } };
  }
  return { cwd, tool_name: AGY_TO_CLAUDE[toolName] ?? toolName, tool_input: safeArgs };
}

function runSettingsPreToolUseHooks(policy, toolName, args, cwd) {
  if (!policy.preToolUseHooks?.length) return null;
  const claudePayload = translateToClaudePreToolUse(toolName, args, cwd);
  const stdinText = JSON.stringify(claudePayload);
  for (const hook of policy.preToolUseHooks) {
    if (hook.matcher && hook.matcher !== "*") {
      let re;
      try {
        re = new RegExp(hook.matcher);
      } catch (err) {
        return `Invalid settings PreToolUse matcher "${hook.matcher}": ${err.message}`;
      }
      if (!re.test(claudePayload.tool_name)) continue;
    }
    const res = spawnSync("/bin/sh", ["-c", hook.command], {
      cwd,
      input: stdinText,
      encoding: "utf8",
      timeout: (hook.timeout ?? 30) * 1000,
      env: process.env,
    });
    if (res.error) {
      return `Settings PreToolUse hook failed to execute: ${res.error.message}`;
    }
    if (res.signal) {
      return `Settings PreToolUse hook terminated by signal ${res.signal}`;
    }
    if (res.status === 2) {
      return (res.stderr || res.stdout || "Blocked by settings PreToolUse hook").trim();
    }
    if (res.status !== 0) {
      return `Settings PreToolUse hook exited ${res.status}: ${(res.stderr || res.stdout || "").trim()}`.trim();
    }
    const stdout = (res.stdout || "").trim();
    if (stdout.startsWith("{")) {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        return `Settings PreToolUse hook printed invalid JSON: ${err.message}`;
      }
      const permDecision = parsed?.hookSpecificOutput?.permissionDecision;
      if (permDecision === "deny" || permDecision === "ask") {
        return (parsed?.hookSpecificOutput?.permissionDecisionReason || parsed?.reason || `Blocked by settings PreToolUse hook (${permDecision})`).trim();
      }
      if (parsed?.decision === "block" || parsed?.decision === "deny" || parsed?.decision === "ask") {
        return (parsed?.reason || `Blocked by settings PreToolUse hook (${parsed.decision})`).trim();
      }
      if (parsed?.continue === false) {
        return (parsed?.stopReason || parsed?.reason || "Blocked by settings PreToolUse hook (continue=false)").trim();
      }
    }
  }
  return null;
}

/**
 * Evaluates an Antigravity PreToolUse payload against a policy object.
 * Always fails closed on missing tool names, missing path args, or evaluation errors.
 */
export function evaluateToolCall(policy, agyInput) {
  try {
    if (!policy || typeof policy !== "object") {
      return { decision: "deny", reason: "Policy object is missing or invalid" };
    }
    const toolName = agyInput?.toolCall?.name;
    const args = agyInput?.toolCall?.args;
    const cwd = typeof agyInput?.cwd === "string" && agyInput.cwd ? agyInput.cwd : policy.cwd;

    if (typeof toolName !== "string" || !toolName) {
      return { decision: "deny", reason: "Missing toolCall.name in PreToolUse payload" };
    }
    if (policy.noTools) {
      if (
        (toolName === "read_file" || toolName === "view_file") &&
        Array.isArray(policy.attachmentReadRoots) &&
        policy.attachmentReadRoots.length > 0
      ) {
        const rawPath = extractPathArg(args);
        const paths = resolveCandidatePaths(rawPath, { cwd, home: policy.home });
        if (isWithinAllowedRoots(paths, policy.attachmentReadRoots)) {
          return { decision: "allow" };
        }
      }
      return { decision: "deny", reason: `Tools are disabled (--no-tools): ${toolName}` };
    }
    if (policy.strictMcp && isMcpToolName(toolName)) {
      return { decision: "deny", reason: `MCP tools are disabled: ${toolName}` };
    }
    if (policy.restricted && !policy.allowedAgyTools.includes(toolName)) {
      return {
        decision: "deny",
        reason: `Tool "${toolName}" is not permitted in this restricted session (allowed: ${policy.allowedAgyTools.join(", ") || "none"})`,
      };
    }

    if (READ_TOOLS.has(toolName)) {
      const rawPath = extractPathArg(args);
      const paths = resolveCandidatePaths(rawPath, { cwd, home: policy.home });
      const compiled = (policy.denyReadPatterns || []).flatMap((pat) =>
        compilePathPattern(pat, { cwd: policy.cwd, home: policy.home }),
      );
      if (matchesCompiledPatterns(paths, compiled)) {
        return { decision: "deny", reason: `Read denied by policy for path: ${rawPath}` };
      }
    }

    if (EDIT_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
      const rawPath = extractPathArg(args);
      const paths = resolveCandidatePaths(rawPath, { cwd, home: policy.home });
      if (policy.confineWrites && !isWithinAllowedRoots(paths, policy.allowedWriteRoots || [])) {
        return {
          decision: "deny",
          reason: `Write/edit outside allowed workspace directories denied for path: ${rawPath}`,
        };
      }
      const denyPatterns = EDIT_TOOLS.has(toolName) ? policy.denyEditPatterns : policy.denyWritePatterns;
      const compiled = (denyPatterns || []).flatMap((pat) =>
        compilePathPattern(pat, { cwd: policy.cwd, home: policy.home }),
      );
      if (matchesCompiledPatterns(paths, compiled)) {
        return { decision: "deny", reason: `${toolName} denied by policy for path: ${rawPath}` };
      }
    }

    const hookDeny = runSettingsPreToolUseHooks(policy, toolName, args, cwd);
    if (hookDeny) {
      return { decision: "deny", reason: hookDeny };
    }

    return { decision: "allow" };
  } catch (err) {
    return { decision: "deny", reason: `Policy evaluation failed closed: ${err.message}` };
  }
}

/**
 * Evaluates an ACP session/request_permission payload as defense-in-depth alongside PreToolUse.
 * Accepts an optional trackedCall ({ name, args, kind }) correlated by toolCallId from earlier
 * session/update tool_call events when the ACP permission request omits toolCall.name.
 */
export function evaluatePermissionRequest(policy, params, trackedCall = null) {
  if (!policy || policy.noTools || policy.permissionMode === "default") {
    return { allow: false, reason: "Permissions disabled in this mode" };
  }
  const toolCall = params?.toolCall;
  const toolName = toolCall?.name ?? trackedCall?.name;
  const args = toolCall?.rawInput ?? toolCall?.args ?? trackedCall?.args;
  if (policy.restricted) {
    if (typeof toolName === "string" && toolName) {
      const check = evaluateToolCall(policy, { cwd: policy.cwd, toolCall: { name: toolName, args } });
      return check.decision === "allow"
        ? { allow: true }
        : { allow: false, reason: check.reason };
    }
    // In acceptEdits or restricted mode, never blindly approve an unidentified permission request.
    return { allow: false, reason: "Unidentified tool in restricted session/request_permission" };
  }
  return policy.permissionMode === "bypassPermissions"
    ? { allow: true }
    : { allow: false, reason: "Permission denied outside bypassPermissions" };
}

if (import.meta.main) {
  try {
    const policyIdx = process.argv.indexOf("--policy");
    const policyPath = policyIdx >= 0 ? process.argv[policyIdx + 1] : process.env.AGY_RUN_POLICY_FILE;
    if (!policyPath) {
      process.stdout.write(`${JSON.stringify({ decision: "deny", reason: "Missing --policy path" })}\n`);
      process.exit(0);
    }
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    const raw = readFileSync(0, "utf8").trim();
    if (!raw) {
      process.stdout.write(`${JSON.stringify({ decision: "deny", reason: "Empty PreToolUse hook payload" })}\n`);
      process.exit(0);
    }
    const input = JSON.parse(raw);
    const out = evaluateToolCall(policy, input);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({ decision: "deny", reason: `agy-run policy hook failed closed: ${err.message}` })}\n`,
    );
  }
}
