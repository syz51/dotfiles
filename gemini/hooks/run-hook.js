#!/usr/bin/env bun
/**
 * Antigravity lifecycle hook adapter for ~/.config/claude/hooks/*.js.
 *
 * Usage: bun run-hook.js <event> <hook-name[,hook-name,...]>
 *   event:     pre-tool-use | post-tool-use | session-start | stop
 *   hook-name: guard-git-push | guard-runtimes | guard-main-checkout | guard-pr-merge |
 *              guard-asks | auto-merge | stale-base | open-items | deck-view
 *
 * Hot-path command guards (guard-git-push, guard-runtimes, guard-main-checkout,
 * guard-pr-merge, guard-asks, auto-merge) execute in-process via their exported functions so a
 * single Bun invocation handles all PreToolUse guards instead of spawning nested Bun VMs.
 * Low-frequency hooks (stale-base, open-items, deck-view) still delegate via spawnSync to share
 * the exact same Claude Code hook scripts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  pullRequestUrls,
  report as autoMergeReport,
  reportMcpCreate as autoMergeMcpReport,
} from "../../claude/hooks/auto-merge.js";
import {
  askViolation,
  findBoardAskViolation,
  loadAskPolicy,
} from "../../claude/hooks/guard-asks.js";
import { findViolation as findGitPushViolation } from "../../claude/hooks/guard-git-push.js";
import { findMainCheckoutViolation } from "../../claude/hooks/guard-main-checkout.js";
import {
  findMcpMergeViolation,
  findMergeViolation,
  runGh,
} from "../../claude/hooks/guard-pr-merge.js";
import { findRuntimeViolation } from "../../claude/hooks/guard-runtimes.js";
import {
  expands,
  ghSubcommands,
  gitGlobalOptions,
  parseScript,
  visitCommands,
} from "../../claude/hooks/shell.js";

const HOOKS_DIR = resolve(dirname(import.meta.path), "..", "..", "claude", "hooks");

function runGitStrict(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`git was stopped by ${result.signal}`);
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function runGitLenient(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  });
  if (result.error || result.signal || result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function mainCheckoutTempRoots() {
  const roots = [tmpdir(), join("/tmp", `claude-${userInfo().uid}`)];
  return roots.filter((root) => existsSync(root)).map((root) => realpathSync(root));
}

const CREATE_BOOL_FLAGS = new Set([
  "--draft",
  "--dry-run",
  "--editor",
  "--fill",
  "--fill-first",
  "--fill-verbose",
  "--help",
  "--no-maintainer-edit",
  "--web",
]);

const CREATE_VALUE_FLAGS = new Set([
  "--assignee",
  "--attach",
  "--base",
  "--body",
  "--body-file",
  "--head",
  "--label",
  "--milestone",
  "--project",
  "--recover",
  "--repo",
  "--reviewer",
  "--template",
  "--title",
]);

const CREATE_SHORT_FLAGS = {
  a: "--assignee",
  B: "--base",
  b: "--body",
  d: "--draft",
  e: "--editor",
  F: "--body-file",
  f: "--fill",
  H: "--head",
  h: "--help",
  l: "--label",
  m: "--milestone",
  p: "--project",
  R: "--repo",
  r: "--reviewer",
  T: "--template",
  t: "--title",
  w: "--web",
};

const PFLAG_FALSE = new Set(["0", "f", "F", "false", "FALSE", "False"]);
const GLOB = /[*?[]/;
const TOO_DEEP = Symbol("tooDeep");
const ENV_OVERRIDE_RE = /^(GH_REPO|GH_HOST|GIT_DIR|GIT_WORK_TREE)=(.*)$/s;
const EXPORT_BUILTINS = new Set(["export", "declare", "typeset", "local", "readonly", "setenv"]);
const PREFIX_KEYWORDS = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "time",
  "command",
  "builtin",
  "nohup",
  "exec",
  "coproc",
  "noglob",
  "nocorrect",
]);
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

function isValidLiteralValue(val) {
  return typeof val === "string" && val.length > 0 && !val.startsWith("-") && !expands(val) && !GLOB.test(val);
}

function parseCreate(args, initialRepo) {
  const parsed = {
    repoSeen: initialRepo !== undefined,
    repo: initialRepo,
    headSeen: false,
    head: undefined,
    draft: false,
    dryRun: false,
    web: false,
    help: false,
    unknown: false,
  };
  const set = (name, value) => {
    if (name === "--repo") {
      parsed.repoSeen = true;
      parsed.repo = value;
    } else if (name === "--head") {
      parsed.headSeen = true;
      parsed.head = value;
    } else if (name === "--draft") {
      parsed.draft = value;
    } else if (name === "--dry-run") {
      parsed.dryRun = value;
    } else if (name === "--web") {
      parsed.web = value;
    } else if (name === "--help") {
      parsed.help = value;
    }
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (CREATE_VALUE_FLAGS.has(name)) {
        const value = equals === -1 ? args[++i] : arg.slice(equals + 1);
        set(name, value);
      } else if (CREATE_BOOL_FLAGS.has(name)) {
        set(name, equals === -1 || !PFLAG_FALSE.has(arg.slice(equals + 1)));
      } else {
        parsed.unknown = true;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (let k = 1; k < arg.length; k += 1) {
        const name = CREATE_SHORT_FLAGS[arg[k]];
        if (name === undefined) {
          parsed.unknown = true;
          break;
        }
        if (CREATE_VALUE_FLAGS.has(name)) {
          const rawRest = arg.slice(k + 1);
          if (rawRest.startsWith("=")) {
            set(name, rawRest.slice(1));
          } else if (rawRest !== "") {
            set(name, rawRest);
          } else {
            set(name, args[++i]);
          }
          break;
        }
        set(name, true);
      }
    } else if (expands(arg)) {
      // An unexpanded positional word (e.g. `$FLAGS`) may supply -R, --head, or --draft.
      parsed.unknown = true;
    }
  }
  return parsed;
}

function detectEnvOverrides(source, depth = 0) {
  const flags = { setsRepo: false, setsHost: false, setsGitDir: false };
  if (depth > 8 || !source) return flags;
  const record = (name) => {
    if (name === "GH_REPO") flags.setsRepo = true;
    else if (name === "GH_HOST") flags.setsHost = true;
    else if (name === "GIT_DIR" || name === "GIT_WORK_TREE") flags.setsGitDir = true;
  };
  const merge = (other) => {
    flags.setsRepo ||= other.setsRepo;
    flags.setsHost ||= other.setsHost;
    flags.setsGitDir ||= other.setsGitDir;
  };
  const { commands } = parseScript(source);
  for (const cmd of commands) {
    for (const sub of cmd.substitutions) merge(detectEnvOverrides(sub, depth + 1));
    const argv = cmd.argv;
    let i = 0;
    while (i < argv.length) {
      const word = argv[i];
      if (PREFIX_KEYWORDS.has(word)) {
        i += 1;
        continue;
      }
      const match = ENV_OVERRIDE_RE.exec(word);
      if (match) {
        record(match[1]);
        i += 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        i += 1;
        continue;
      }
      const name = basename(word);
      if (EXPORT_BUILTINS.has(name)) {
        for (let k = i + 1; k < argv.length; k += 1) {
          const item = argv[k];
          if (item.startsWith("-")) continue;
          const eq = item.indexOf("=");
          record(eq === -1 ? item : item.slice(0, eq));
        }
        break;
      }
      if (name === "env") {
        i += 1;
        while (i < argv.length && argv[i].startsWith("-")) {
          const opt = argv[i];
          if (opt === "--") {
            i += 1;
            break;
          }
          if (opt === "-S" || opt === "--split-string") {
            const val = argv[i + 1];
            if (val) merge(detectEnvOverrides(val, depth + 1));
            i += 2;
          } else if (opt.startsWith("-S") && opt.length > 2) {
            merge(detectEnvOverrides(opt.slice(2), depth + 1));
            i += 1;
          } else if (opt.startsWith("--split-string=")) {
            merge(detectEnvOverrides(opt.slice("--split-string=".length), depth + 1));
            i += 1;
          } else if (["-u", "-P", "-C", "--unset", "--chdir"].includes(opt)) {
            i += 2;
          } else {
            i += 1;
          }
        }
        continue;
      }
      if (name === "sudo" || name === "doas") {
        i += 1;
        const valOpts =
          name === "sudo"
            ? new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "--chdir"])
            : new Set(["-u", "-C"]);
        while (i < argv.length && argv[i].startsWith("-")) {
          const opt = argv[i];
          if (opt === "--") {
            i += 1;
            break;
          }
          i += valOpts.has(opt) ? 2 : 1;
        }
        continue;
      }
      if (SHELL_NAMES.has(name)) {
        for (const input of cmd.inputs) merge(detectEnvOverrides(input, depth + 1));
        for (let k = i + 1; k < argv.length; k += 1) {
          const opt = argv[k];
          if (opt === "-o" || opt === "+o" || opt === "-O" || opt === "+O" || opt === "--rcfile" || opt === "--init-file") {
            k += 1;
          } else if (/^-[A-Za-z]*c[A-Za-z]*$/.test(opt)) {
            if (argv[k + 1]) merge(detectEnvOverrides(argv[k + 1], depth + 1));
            break;
          } else if (!/^[-+]/.test(opt)) {
            break;
          }
        }
        break;
      }
      if (name === "eval") {
        const evalWords = argv[i + 1] === "--" || argv[i + 1] === "-" ? argv.slice(i + 2) : argv.slice(i + 1);
        if (evalWords.length > 0) merge(detectEnvOverrides(evalWords.join(" "), depth + 1));
        break;
      }
      break;
    }
  }
  return flags;
}

function switchesBranch(words, dir) {
  const name = basename(words[0]).toLowerCase();
  if (name === "git") {
    const { dir: gitDir, index } = gitGlobalOptions(words, dir);
    const sub = words[index];
    const rest = words.slice(index + 1);
    if (rest.includes("--help") || rest.includes("-h")) return { switched: false };
    if (sub === "switch") return { switched: true, targetDir: gitDir };
    if (sub === "checkout") {
      const firstNonOptIdx = rest.findIndex((w) => !w.startsWith("-"));
      if (rest[0] === "--" || rest.includes("-p") || rest.includes("--patch") || firstNonOptIdx === -1) {
        return { switched: false };
      }
      const dashDash = rest.indexOf("--");
      if (dashDash !== -1 && dashDash < firstNonOptIdx) return { switched: false };
      return { switched: true, targetDir: gitDir };
    }
    return { switched: false };
  }
  if (name === "gh") {
    const { path: [group, sub], next } = ghSubcommands(words, 2);
    if (group === "pr" && sub === "checkout") {
      const rest = words.slice(next);
      if (rest.includes("--help") || rest.includes("-h")) return { switched: false };
      return { switched: true, targetDir: dir };
    }
  }
  return { switched: false };
}

/**
 * Extracts resolvable `{ dir, repo, head }` targets for each `gh pr create` / `gh pr new`
 * invocation in `command` (starting from `cwd`). Skips invocations whose target repo or branch
 * cannot be resolved safely (unknown `cd`, remote `ssh`, `xargs`, draft/dry-run/web/help,
 * shell-expanded `-R`/`--head`, conflicting env overrides, or post-create branch switches).
 */
export function extractPrCreateTargets(command, cwd) {
  if (!command || !/gh/i.test(normalizeForPrefilter(command))) return [];
  const envOverrides = detectEnvOverrides(command);
  if (envOverrides.setsHost) return [];

  const targets = [];
  const result = visitCommands(
    command,
    cwd,
    (words, dir, meta) => {
      if (meta.opaque) {
        for (const t of targets) {
          if (t.head === undefined) t.stale = true;
        }
        return undefined;
      }
      if (words.length === 0) return undefined;

      if (!meta.remote && targets.length > 0) {
        const sw = switchesBranch(words, dir);
        if (sw.switched) {
          for (const t of targets) {
            if (t.head === undefined && (sw.targetDir === undefined || t.dir === sw.targetDir)) {
              t.stale = true;
            }
          }
        }
      }

      if (basename(words[0]).toLowerCase() !== "gh") return undefined;
      const { path: [group, subcommand], next, repo: initialRepo, other } = ghSubcommands(words, 2);
      if (group !== "pr" || (subcommand !== "create" && subcommand !== "new")) return undefined;
      if (meta.remote || meta.appended || other !== undefined) return undefined;

      const parsed = parseCreate(words.slice(next), initialRepo);
      if (parsed.unknown || parsed.draft || parsed.dryRun || parsed.web || parsed.help) return undefined;
      if (parsed.repoSeen && !isValidLiteralValue(parsed.repo)) return undefined;
      if (parsed.headSeen && !isValidLiteralValue(parsed.head)) return undefined;

      const repo = parsed.repoSeen ? parsed.repo : undefined;
      const head = parsed.headSeen ? parsed.head : undefined;
      if (envOverrides.setsRepo && repo === undefined) return undefined;
      if (envOverrides.setsGitDir && (repo === undefined || head === undefined)) return undefined;
      if (dir === undefined && (repo === undefined || head === undefined)) return undefined;

      targets.push({ dir, repo, head, stale: false });
      return undefined;
    },
    TOO_DEEP,
  );
  if (result === TOO_DEEP) return [];

  const unique = [];
  const seen = new Set();
  for (const { dir, repo, head, stale } of targets) {
    if (stale) continue;
    const key = `${dir ?? ""}\0${repo ?? ""}\0${head ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ dir, repo, head });
  }
  return unique;
}

/**
 * Antigravity PostToolUse does not pass command stdout; resolve each created PR's URL via
 * `gh pr view` in the command's target directory/repo/head (skipping unknown targets).
 */
export function resolveCreatedPrStdout(command, cwd, ghRunner = runGh) {
  const targets = extractPrCreateTargets(command, cwd);
  if (targets.length === 0) return "";
  const urls = new Set();
  for (const target of targets) {
    const args = [
      "pr",
      "view",
      ...(target.head !== undefined ? [target.head] : []),
      ...(target.repo !== undefined ? ["--repo", target.repo] : []),
      "--json",
      "url",
      "-q",
      ".url",
    ];
    let res;
    try {
      res = ghRunner(target.dir ?? cwd, args, 5000);
    } catch {
      continue;
    }
    if (res && res.code === 0 && typeof res.stdout === "string") {
      for (const url of pullRequestUrls(res.stdout)) {
        urls.add(url);
      }
    }
  }
  return urls.size > 0 ? `${[...urls].join("\n")}\n` : "";
}

export function extractLastAssistantMessage(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  try {
    const lines = readFileSync(transcriptPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type === "PLANNER_RESPONSE" && typeof rec.content === "string" && rec.content.trim()) {
        return rec.content;
      }
    }
  } catch {
    return "";
  }
  return "";
}

function extractCommand(agyInput) {
  const args = agyInput?.toolCall?.args ?? {};
  if (typeof args.CommandLine === "string") return args.CommandLine;
  if (typeof args.command === "string") return args.command;
  return "";
}

function normalizeForPrefilter(command) {
  // Collapse POSIX backslash-newline line continuations before stripping quotes and backslashes.
  return command.replace(/\\\r?\n/g, "").replace(/["'\\]/g, "");
}

const DIRECT_ASK_TOOLS = new Set(["mcp_board_ask_user", "mcp__board__ask_user", "ask_user"]);
const DIRECT_PR_MERGE_TOOLS = new Set(["mcp_t3-code_pull_request_merge", "mcp__t3-code__pull_request_merge"]);
const DIRECT_PR_CREATE_TOOLS = new Set(["mcp_t3-code_pull_request_create", "mcp__t3-code__pull_request_create"]);

function unwrapMcpArgs(rawArgs, { failClosed = false } = {}) {
  if (rawArgs === undefined) return {};
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      return failClosed ? false : {};
    } catch {
      return failClosed ? false : {};
    }
  }
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) return rawArgs;
  return failClosed ? false : {};
}

function extractMcpToolInput(agyInput, server, tool, directTools, { failClosed = false } = {}) {
  const toolName = agyInput?.toolCall?.name ?? "";
  const args = agyInput?.toolCall?.args;
  if (toolName === "call_mcp_tool") {
    const serverName = args?.ServerName ?? args?.serverName;
    const mcpToolName = args?.ToolName ?? args?.toolName;
    if (serverName !== server || mcpToolName !== tool) {
      return null;
    }
    const rawArgs = args?.Arguments !== undefined ? args.Arguments : args?.arguments;
    return unwrapMcpArgs(rawArgs, { failClosed });
  }
  if (directTools.has(toolName)) {
    return unwrapMcpArgs(args, { failClosed });
  }
  return null;
}

/**
 * Extracts the board `ask_user` argument object from an Antigravity PreToolUse payload.
 * Returns the argument object when the tool call invokes board `ask_user` (either lazily via
 * `call_mcp_tool` with `ServerName === "board"` and `ToolName === "ask_user"`, or eagerly via
 * `mcp_board_ask_user`), or `null` when the tool call is not an MCP `ask_user` call.
 */
export function extractAskUserInput(agyInput) {
  return extractMcpToolInput(agyInput, "board", "ask_user", DIRECT_ASK_TOOLS);
}

/**
 * Extracts the T3 `pull_request_merge` argument object from an Antigravity PreToolUse payload.
 * Returns `null` when the tool call is not an MCP `pull_request_merge` call, or `false` when a
 * matching call has malformed non-object arguments so the fail-closed merge guard refuses it.
 */
export function extractMcpPrMergeInput(agyInput) {
  return extractMcpToolInput(agyInput, "t3-code", "pull_request_merge", DIRECT_PR_MERGE_TOOLS, { failClosed: true });
}

/**
 * Extracts the T3 `pull_request_create` argument object from an Antigravity PostToolUse payload,
 * or `null` when the tool call is not an MCP `pull_request_create` call.
 */
export function extractMcpPrCreateInput(agyInput) {
  return extractMcpToolInput(agyInput, "t3-code", "pull_request_create", DIRECT_PR_CREATE_TOOLS);
}

function extractToolResponse(agyInput) {
  return agyInput?.toolResponse ?? agyInput?.toolResult ?? agyInput?.result ?? agyInput?.output;
}

export function translateInput(event, hookName, agyInput, { runners = {} } = {}) {
  const cwd = typeof agyInput?.cwd === "string" && agyInput.cwd ? agyInput.cwd : process.cwd();
  if (event === "pre-tool-use") {
    if (hookName === "guard-asks") {
      const toolName = agyInput?.toolCall?.name ?? "";
      const command = extractCommand(agyInput);
      if (toolName === "run_command" || toolName === "Bash" || (!toolName && command)) {
        return { cwd, tool_name: "Bash", tool_input: { command } };
      }
      const askInput = extractAskUserInput(agyInput);
      if (askInput === null) return null;
      return { cwd, tool_name: "mcp__board__ask_user", tool_input: askInput };
    }
    if (hookName === "guard-pr-merge") {
      const mcpMergeInput = extractMcpPrMergeInput(agyInput);
      if (mcpMergeInput !== null) {
        return { cwd, tool_name: "mcp__t3-code__pull_request_merge", tool_input: mcpMergeInput };
      }
    }
    return { cwd, tool_name: "Bash", tool_input: { command: extractCommand(agyInput) } };
  }
  if (event === "post-tool-use") {
    if (hookName === "auto-merge") {
      const mcpCreateInput = extractMcpPrCreateInput(agyInput);
      if (mcpCreateInput !== null) {
        return {
          cwd,
          tool_name: "mcp__t3-code__pull_request_create",
          tool_input: mcpCreateInput,
          tool_response: extractToolResponse(agyInput) ?? {},
        };
      }
    }
    const command = extractCommand(agyInput);
    const stdout =
      hookName === "auto-merge" && !agyInput?.error && command
        ? resolveCreatedPrStdout(command, cwd, runners.gh ?? runGh)
        : "";
    return {
      cwd,
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { stdout, stderr: agyInput?.error || "" },
    };
  }
  if (event === "session-start") {
    return { cwd, source: "startup" };
  }
  if (event === "stop") {
    const transcriptPath = typeof agyInput?.transcriptPath === "string" ? agyInput.transcriptPath : "";
    return {
      cwd,
      stop_hook_active: Boolean(agyInput?.continuationActive),
      transcript_path: transcriptPath,
      last_assistant_message:
        hookName === "open-items" ? extractLastAssistantMessage(transcriptPath) : "",
    };
  }
  return { cwd };
}

export function translateOutput(event, exitCode, stdout, stderr) {
  if (event === "pre-tool-use") {
    if (exitCode === 2) {
      return { decision: "deny", reason: (stderr || stdout || "Blocked by hook").trim() };
    }
    return { decision: "allow" };
  }
  if (event === "post-tool-use") {
    return {};
  }
  if (event === "session-start") {
    if (stdout && stdout.trim()) {
      try {
        const parsed = JSON.parse(stdout);
        const ctx = parsed?.hookSpecificOutput?.additionalContext;
        if (typeof ctx === "string" && ctx.trim()) {
          return { injectSteps: [{ systemMessage: { systemMessage: ctx } }] };
        }
      } catch {
        // Non-JSON output ignored
      }
    }
    return {};
  }
  if (event === "stop") {
    if (exitCode === 2) {
      return { decision: "continue", reason: (stderr || stdout || "Continue before stopping").trim() };
    }
    return { decision: "allow" };
  }
  return {};
}

function runInProcessPreToolUse(hookName, command, cwd, runners = {}) {
  const unquoted = normalizeForPrefilter(command);
  if (hookName === "guard-git-push") {
    if (/\bgit\b/i.test(unquoted) && /\bpush\b|alias\./i.test(unquoted)) {
      const violation = findGitPushViolation(command, cwd, runners.gitStrict ?? runGitStrict);
      if (violation) return { decision: "deny", reason: `Blocked by the guard-git-push hook: ${violation}` };
    }
    return { decision: "allow" };
  }
  if (hookName === "guard-runtimes") {
    const violation = findRuntimeViolation(command, cwd);
    if (violation) return { decision: "deny", reason: `Blocked by the guard-runtimes hook: ${violation}` };
    return { decision: "allow" };
  }
  if (hookName === "guard-main-checkout") {
    if (/\b(?:git|gh|xargs)\b/i.test(unquoted)) {
      const violation = findMainCheckoutViolation(
        command,
        cwd,
        runners.gitLenient ?? runGitLenient,
        runners.tempRoots ?? mainCheckoutTempRoots(),
      );
      if (violation) return { decision: "deny", reason: `Blocked by the guard-main-checkout hook: ${violation}` };
    }
    return { decision: "allow" };
  }
  return null;
}

function runInProcessGuardPrMerge(agyInput, command, cwd, runners = {}) {
  // Fail closed if the merge guard throws, matching claude/hooks/guard-pr-merge.js.
  const mcpMergeInput = extractMcpPrMergeInput(agyInput);
  let violation;
  try {
    if (mcpMergeInput !== null) {
      violation = findMcpMergeViolation(mcpMergeInput, cwd, runners.gh ?? runGh);
    } else if (command) {
      const unquoted = normalizeForPrefilter(command);
      if (/merge|gh|[$`*?[{]/i.test(unquoted)) {
        violation = findMergeViolation(command, cwd, runners.gh ?? runGh);
      }
    }
  } catch (error) {
    violation = `the guard failed (${error.message}), so it cannot check this command.`;
  }
  if (violation) return { decision: "deny", reason: `Blocked by the guard-pr-merge hook: ${violation}` };
  return { decision: "allow" };
}

function runInProcessGuardAsks(agyInput, command, cwd, runners = {}) {
  const toolName = agyInput?.toolCall?.name ?? "";
  if (toolName === "run_command" || toolName === "Bash" || (!toolName && command)) {
    if (!command) return { decision: "allow" };
    const violation = findBoardAskViolation(command, cwd, runners.askPolicy);
    if (violation) return { decision: "deny", reason: `Blocked by the guard-asks hook: ${violation}` };
    return { decision: "allow" };
  }
  const askInput = extractAskUserInput(agyInput);
  if (askInput === null) return { decision: "allow" };
  const policy = runners.askPolicy ?? loadAskPolicy();
  const violation = askViolation(askInput, policy);
  if (violation) return { decision: "deny", reason: `Blocked by the guard-asks hook: ${violation}` };
  return { decision: "allow" };
}

const IN_PROCESS_PRE = new Set([
  "guard-git-push",
  "guard-runtimes",
  "guard-main-checkout",
  "guard-pr-merge",
  "guard-asks",
]);

function runSubprocessHook(event, hookName, agyInput, hooksDir, bunBin, runners = {}) {
  const scriptPath = join(hooksDir, `${hookName}.js`);
  if (!existsSync(scriptPath)) {
    return event === "pre-tool-use" || event === "stop" ? { decision: "allow" } : {};
  }
  const claudeInput = translateInput(event, hookName, agyInput, { runners });
  if (claudeInput === null) {
    return event === "pre-tool-use" || event === "stop" ? { decision: "allow" } : {};
  }
  if (
    event === "post-tool-use" &&
    hookName === "auto-merge" &&
    claudeInput.tool_name === "Bash" &&
    !claudeInput.tool_response?.stdout
  ) {
    return {};
  }
  const run = spawnSync(bunBin, [scriptPath], {
    input: JSON.stringify(claudeInput),
    encoding: "utf8",
    timeout: 45_000,
    env: process.env,
  });
  return translateOutput(event, run.status ?? 0, run.stdout ?? "", run.stderr ?? "");
}

export function runAdaptedHook(
  event,
  hookSpec,
  agyInput,
  { hooksDir = HOOKS_DIR, bunBin = process.execPath, runners = {} } = {},
) {
  if (event === "post-tool-use" && agyInput?.error) {
    return {};
  }

  const hookNames = String(hookSpec)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (hookNames.length === 0) {
    return event === "pre-tool-use" || event === "stop" ? { decision: "allow" } : {};
  }

  const useInProcess = hooksDir === HOOKS_DIR;
  const cwd = typeof agyInput?.cwd === "string" && agyInput.cwd ? agyInput.cwd : process.cwd();

  if (event === "pre-tool-use") {
    const command = extractCommand(agyInput);
    for (const hookName of hookNames) {
      // Isolate each guard so a crash in an earlier fail-open guard never skips later guards
      // (especially fail-closed guard-pr-merge).
      try {
        if (useInProcess && IN_PROCESS_PRE.has(hookName)) {
          if (hookName === "guard-asks") {
            const res = runInProcessGuardAsks(agyInput, command, cwd, runners);
            if (res && res.decision === "deny") return res;
            continue;
          }
          if (hookName === "guard-pr-merge") {
            const res = runInProcessGuardPrMerge(agyInput, command, cwd, runners);
            if (res && res.decision === "deny") return res;
            continue;
          }
          if (!command) continue;
          const res = runInProcessPreToolUse(hookName, command, cwd, runners);
          if (res && res.decision === "deny") return res;
          continue;
        }
        const res = runSubprocessHook(event, hookName, agyInput, hooksDir, bunBin);
        if (res.decision === "deny") return res;
      } catch (err) {
        if (hookName === "guard-pr-merge") {
          return {
            decision: "deny",
            reason: `Blocked by the guard-pr-merge hook: the guard failed (${err.message}), so it cannot check this command.`,
          };
        }
        process.stderr.write(`run-hook guard error (${hookName}): ${err.message}\n`);
      }
    }
    return { decision: "allow" };
  }

  if (event === "post-tool-use") {
    for (const hookName of hookNames) {
      if (hookName === "auto-merge" && useInProcess) {
        const mcpCreateInput = extractMcpPrCreateInput(agyInput);
        if (mcpCreateInput !== null) {
          try {
            const text = autoMergeMcpReport(
              mcpCreateInput,
              extractToolResponse(agyInput),
              cwd,
              (args, timeout) => (runners.gh ?? runGh)(cwd, args, timeout),
            );
            if (text) process.stderr.write(`${text}\n`);
          } catch (err) {
            process.stderr.write(`auto-merge hook failed (${err.message})\n`);
          }
          continue;
        }
        const command = extractCommand(agyInput);
        if (!command || !/gh/i.test(normalizeForPrefilter(command))) {
          continue;
        }
        const ghRunner = runners.gh ?? runGh;
        const stdout = resolveCreatedPrStdout(command, cwd, ghRunner);
        if (!stdout || !stdout.includes("/pull/")) continue;
        try {
          const text = autoMergeReport(command, cwd, stdout, (args, timeout) =>
            ghRunner(cwd, args, timeout),
          );
          if (text) process.stderr.write(`${text}\n`);
        } catch (err) {
          process.stderr.write(`auto-merge hook failed (${err.message})\n`);
        }
        continue;
      }
      runSubprocessHook(event, hookName, agyInput, hooksDir, bunBin, runners);
    }
    return {};
  }

  if (event === "session-start") {
    const injectSteps = [];
    for (const hookName of hookNames) {
      const res = runSubprocessHook(event, hookName, agyInput, hooksDir, bunBin);
      if (Array.isArray(res.injectSteps)) injectSteps.push(...res.injectSteps);
    }
    return injectSteps.length > 0 ? { injectSteps } : {};
  }

  if (event === "stop") {
    for (const hookName of hookNames) {
      const res = runSubprocessHook(event, hookName, agyInput, hooksDir, bunBin);
      if (res.decision === "continue") return res;
    }
    return { decision: "allow" };
  }

  return {};
}

if (import.meta.main) {
  const [event, hookSpec] = process.argv.slice(2);
  const failClosed =
    event === "pre-tool-use" &&
    String(hookSpec ?? "")
      .split(",")
      .map((name) => name.trim())
      .includes("guard-pr-merge");
  let agyInput = {};
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (!raw) {
      if (failClosed) throw new Error("stdin hook payload is empty");
    } else {
      const parsed = JSON.parse(raw);
      if (failClosed && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
        throw new Error("stdin hook payload is not a JSON object");
      }
      agyInput = parsed;
    }
    const out = runAdaptedHook(event, hookSpec, agyInput);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    if (failClosed) {
      const deny = {
        decision: "deny",
        reason: `Blocked by the guard-pr-merge hook: the guard failed (${err.message}), so it cannot check this command.`,
      };
      process.stdout.write(`${JSON.stringify(deny)}\n`);
    } else {
      // Fail open on adapter crash, matching Claude Code guard semantics
      const fallback = event === "pre-tool-use" || event === "stop" ? { decision: "allow" } : {};
      process.stderr.write(`run-hook adapter error (${hookSpec}): ${err.message}\n`);
      process.stdout.write(`${JSON.stringify(fallback)}\n`);
    }
  }
}
