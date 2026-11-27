// Claude Code and Antigravity Stop hook. Catches "phantom wait" / dropped-timer turns where
// the reply promises an automatic future wakeup (e.g. "Checking back in 4 minutes", "I'll
// deploy once the image job finishes", "Watching PR #308 until it merges") without any active
// timer, PR watch, delegate, subagent, or background task in the session transcript.
//
// Like open-items.js and deck-view.js, it is a once-only reminder, not an infinite gate:
// when `stop_hook_active` is true (second stop after a Stop hook continuation), it passes.
// It fails open when the transcript cannot be read or GUARD_WAKEUP=off is set.
import { existsSync, readFileSync } from "node:fs";

const HEADING = /^\s*#{1,6}\s+(.*)$/;
const OPEN_HEADING = /^\s*#{1,6}\s+(?:\*\*|__|\*)?open items(?:\s*[:：]|(?:\*\*|__|\*)?\s*(?:[:：]|\(|$))/i;
const OPEN_LABEL = /^\s*(?:(?:\*\*|__|\*)?open items\s*(?:[:：]\s*(?:\*\*|__|\*)?|(?:\*\*|__|\*)?\s*[:：])|(?:\*\*|__)open items(?:\*\*|__)\s*$)/i;
const INJECTED_USER = /^\s*<(?:local-command-stdout|local-command-stderr|system-reminder|bash-stdout|bash-stderr)>/;

const DURATION = String.raw`(?:about\s+|roughly\s+|~\s*)?(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty)\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b`;

const TIMER_CLAIM_PATTERNS = [
  // "Checking back in 4 minutes", "Check back after 30s", "Rechecking back in 2 min"
  new RegExp(`\\b(?:checking|check|recheck(?:ing)?|poll(?:ing)?|follow(?:ing)?\\s+up|coming|circling)\\s+back\\s+(?:in|after)\\s+${DURATION}`, "i"),
  // "I'll check back in 4 minutes", "I will recheck in 90s", "I'll wake back up in 3m"
  new RegExp(`\\b(?:i(?:'ll|'m\\s+going\\s+to|\\s+will|\\s+am\\s+going\\s+to)|we(?:'ll|\\s+will))\\s+(?:check(?:\\s+back)?|recheck|poll(?:\\s+again)?|resume|continue|retry|run|deploy|follow\\s+up|wake(?:\\s+back)?\\s+up)\\s+(?:again\\s+)?(?:in|after)\\s+${DURATION}`, "i"),
  // "Rechecking in 3 minutes", "Polling again in 2m", "Waking back up in 5 minutes"
  new RegExp(`\\b(?:rechecking|polling\\s+again|waking(?:\\s+back)?\\s+up)\\s+(?:in|after)\\s+${DURATION}`, "i"),
  // "Scheduled a 4-minute timer to check CI", "Set a one-shot timer for 2m"
  /\b(?:i(?:'ve|\s+have)?\s+)?(?:set|scheduled|armed)\s+(?:a|an)\s+(?:(?:\d+[-\s]?(?:second|sec|s|minute|min|m|hour|hr|h)|one-shot|wakeup|wake-up|check-back)\s+)*timer\s+(?:to|for)\b/i,
];

const USER_WAIT_TARGET = String.raw`(?:(?:a|an|the|your)\s+)?(?:you|your|user|human|ask\s*#?\d+|approval|input|confirmation|feedback|reply|response)\b`;

const ASYNC_CLAIM_PATTERNS = [
  // "I'll deploy once the image job finishes", "I will resume when CI completes"
  // (excludes "once you ...", "when the approval ...", "after your input ...")
  new RegExp(`\\b(?:i(?:'ll|\\s+will)|we(?:'ll|\\s+will))\\s+(?:wake(?:\\s+back)?\\s+up|resume|continue|proceed|deploy|merge|check(?:\\s+back)?|recheck|follow\\s+up|report\\s+back)\\s+(?:once|when|after|as\\s+soon\\s+as)\\s+(?!${USER_WAIT_TARGET})`, "i"),
  // "Once it merges, I'll deploy to sai", "When CI finishes, I will run deploy/upgrade.sh"
  new RegExp(`\\b(?:once|when|as\\s+soon\\s+as)\\s+(?!${USER_WAIT_TARGET})[^.!?\\n]{1,100},\\s*(?:i(?:'ll|\\s+will)|we(?:'ll|\\s+will))\\s+(?:deploy|merge|run|check(?:\\s+back)?|recheck|resume|continue|proceed|verify|follow\\s+up|report\\s+back|close|finish)\\b`, "i"),
  // "Waiting on the main CI run to finish ... before running deploy/upgrade.sh"
  // "Waiting for the docker and image publish jobs to finish before deploying"
  // (excludes "Waiting for an approval", "Waiting on ask #200", "Waiting for you to confirm")
  new RegExp(`\\bwaiting\\s+(?:on|for)\\s+(?!${USER_WAIT_TARGET})[^.!?\\n]{1,140}\\b(?:to\\s+(?:finish|complete|pass|merge|publish|build|deploy|settle|return)|before\\s+(?:running|deploying|merging|continuing|resuming|proceeding|closing|checking))\\b`, "i"),
  // "Watching PR #308 until it merges", "Watching [syz51/agent-board#308](...) until checks pass"
  /\b(?:watching|monitoring)\s+(?:PR\s*#?\d+|pull\s+request\s*#?\d+|\[[^\]]+#\d+\]\([^)]+\)|https?:\/\/\S+\/pull\/\d+)\s+until\b/i,
];

/** Strips fenced code, blockquotes, inline code, double-quoted snippets, and Open items sections. */
export function stripNonClaimText(message) {
  if (typeof message !== "string" || !message) return "";
  const kept = [];
  let fenced = false;
  let inOpenItems = false;

  for (const line of message.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^\s*>/.test(line)) continue;

    if (OPEN_HEADING.test(line) || OPEN_LABEL.test(line)) {
      inOpenItems = true;
      continue;
    }
    if (inOpenItems) {
      if (HEADING.test(line)) {
        inOpenItems = false;
      } else {
        continue;
      }
    }

    // Strip inline code and quoted literal snippets (preserving English apostrophes like I'll).
    const cleaned = line
      .replace(/`[^`\n]*`/g, " ")
      .replace(/"[^"\n]*"/g, " ")
      .replace(/\u201c[^\u201d\n]*\u201d/g, " ");
    kept.push(cleaned);
  }
  return kept.join("\n");
}

/**
 * Detects whether `message` promises a future self-wakeup.
 * Returns `{ kind: "timer" | "async", match: string } | null`.
 */
export function detectWakeupClaim(message) {
  const text = stripNonClaimText(message);
  if (!text.trim()) return null;

  for (const re of TIMER_CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (m) return { kind: "timer", match: m[0].trim() };
  }
  for (const re of ASYNC_CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (m) return { kind: "async", match: m[0].trim() };
  }
  return null;
}

function unquoteArg(val) {
  if (typeof val !== "string") return val;
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through to raw string
    }
  }
  return val;
}

function unwrapMcpTool(name, args) {
  if (name === "call_mcp_tool") {
    const server = unquoteArg(args?.ServerName ?? args?.serverName ?? "");
    const tool = unquoteArg(args?.ToolName ?? args?.toolName ?? "");
    let rawArgs = args?.Arguments ?? args?.arguments;
    if (typeof rawArgs === "string") {
      const unquoted = unquoteArg(rawArgs);
      try {
        rawArgs = JSON.parse(unquoted);
      } catch {
        rawArgs = {};
      }
    }
    return {
      name: server && tool ? `mcp_${server}_${tool}` : name,
      args: rawArgs && typeof rawArgs === "object" ? rawArgs : {},
    };
  }
  return { name, args: args && typeof args === "object" ? args : {} };
}

/** Normalizes either a PR URL or { repository, number } into a single canonical key. */
export function canonicalPrKey(urlOrArgs, maybeArgs = null) {
  const args = typeof urlOrArgs === "object" && urlOrArgs !== null ? urlOrArgs : maybeArgs;
  const rawUrl = typeof urlOrArgs === "string" ? urlOrArgs : unquoteArg(args?.url ?? "");
  if (typeof rawUrl === "string" && rawUrl.trim()) {
    const trimmed = rawUrl.trim().replace(/\/+$/, "");
    const slug = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(trimmed);
    if (slug) return `${slug[1].toLowerCase()}#${slug[2]}`;
    return trimmed.toLowerCase();
  }
  const repo = unquoteArg(args?.repository ?? "");
  const num = unquoteArg(args?.number ?? "");
  if (repo && num !== "" && num !== undefined && num !== null) {
    return `${String(repo).trim().toLowerCase()}#${String(num).trim()}`;
  }
  return "*";
}

function prKeyFromWatchOutput(body, args) {
  // Prefer the resolved repository/number/url returned by watch_pull_request when present.
  const urlMatch = /"url"\s*:\s*"([^"]+)"/.exec(body);
  if (urlMatch) return canonicalPrKey(urlMatch[1]);
  const repoMatch = /"repository"\s*:\s*"([^"]+)"/.exec(body);
  const numMatch = /"number"\s*:\s*(\d+)/.exec(body);
  if (repoMatch && numMatch) return canonicalPrKey({ repository: repoMatch[1], number: numMatch[1] });
  return canonicalPrKey(args);
}

function userText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
  }
  return "";
}

const PR_STOPPED_WATCH_RE = /\bso T3 Code stopped watching it\b/i;
const PR_URL_RE = /https?:\/\/[^\s)]+\/pull\/\d+/i;
const AGY_MSG_SENDER_RE = /\[Message\][^\n]*\bsender=([^\s\]]+)/g;
const AGY_BG_TASK_ID_RE = /Tool is running as a background task with task id:\s*(\S+)/i;
const AGY_BG_CRON_RE = /Task Description:\s*Cron:/i;
const AGY_SUBAGENT_ID_RE = /"conversationId"\s*:\s*"([^"]+)"/;
const AGY_ERROR_BODY_RE = /(?:^|\n)(?:Error:|Tool error|Encountered error|Blocked by\b|MCP error\b)/i;

function isAgyErrorRecord(rec, body) {
  if (rec.status === "ERROR" || rec.status === "FAILED" || rec.status === "CANCELLED") return true;
  if (AGY_ERROR_BODY_RE.test(body)) return true;
  return false;
}

function isTruthyArg(val) {
  const u = unquoteArg(val);
  return u === true || u === "true";
}

function clearStoppedPrWatch(activePrWatches, text) {
  if (!PR_STOPPED_WATCH_RE.test(text)) return;
  const m = PR_URL_RE.exec(text);
  if (m) {
    const key = canonicalPrKey(m[0]);
    if (activePrWatches.delete(key)) return;
  }
  if (activePrWatches.size === 1) activePrWatches.clear();
}

/**
 * Scans a Claude Code or Antigravity JSONL transcript and summarizes currently active
 * wakeup mechanisms at the end of the transcript.
 * Returns `{ hasTimer: boolean, hasAsync: boolean, readable: boolean }`.
 */
export function activeWakeups(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath || !existsSync(transcriptPath)) {
    return { hasTimer: false, hasAsync: false, readable: false };
  }
  let text;
  try {
    text = readFileSync(transcriptPath, "utf8");
  } catch {
    return { hasTimer: false, hasAsync: false, readable: false };
  }

  const activeTimers = new Set(); // Antigravity task IDs for schedule/timer tasks
  const activeCrons = new Set(); // Recurring cron task IDs (stay active across fires)
  const activeBgTasks = new Set(); // Antigravity non-daemon background task IDs (RUNNING)
  const activeSubagents = new Set(); // Antigravity subagent conversationIds
  const activePrWatches = new Set(); // Canonical PR watch keys across turns

  // Per-turn flags are reserved strictly for mechanisms without persistent IDs/sets:
  // - currentTurnHasTimer: ScheduleWakeup, Monitor, schedule_task, Claude background Bash
  // - currentTurnHasAsync: delegate_task, run_workflow, Claude background Agent
  let currentTurnHasTimer = false;
  let currentTurnHasAsync = false;
  let pendingAgyCalls = []; // FIFO queue for matching Antigravity GENERIC outputs to tool_calls
  const pendingClaudeCalls = new Map(); // tool_use id -> { name, input }
  let subagentFallbackSeq = 0;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || rec.isSidechain || rec.forkedFrom) continue;

    // --- Antigravity transcript records ---
    if (rec.type === "USER_INPUT") {
      currentTurnHasTimer = false;
      currentTurnHasAsync = false;
      pendingAgyCalls = [];
      clearStoppedPrWatch(activePrWatches, typeof rec.content === "string" ? rec.content : "");
      continue;
    }

    if (rec.type === "SYSTEM_MESSAGE") {
      const body = typeof rec.content === "string" ? rec.content : "";
      const senders = [...body.matchAll(AGY_MSG_SENDER_RE)].map((m) => m[1]);
      if (senders.length > 0) {
        // Only treat as a new turn boundary when no tool calls from an in-flight turn are awaiting GENERIC outputs.
        if (pendingAgyCalls.length === 0) {
          currentTurnHasTimer = false;
          currentTurnHasAsync = false;
        }
        for (const sender of senders) {
          if (!activeCrons.has(sender)) {
            activeTimers.delete(sender);
            activeBgTasks.delete(sender);
          }
          activeSubagents.delete(sender);
        }
      }
      continue;
    }

    if (rec.type === "PLANNER_RESPONSE" && Array.isArray(rec.tool_calls) && rec.tool_calls.length > 0) {
      pendingAgyCalls = [];
      for (const tc of rec.tool_calls) {
        pendingAgyCalls.push(unwrapMcpTool(tc?.name ?? "", tc?.args ?? {}));
      }
      continue;
    }

    if (rec.type === "GENERIC") {
      const body = typeof rec.content === "string" ? rec.content : "";
      const call = pendingAgyCalls.shift();
      const name = call?.name ?? "";
      const args = call?.args ?? {};
      const errored = isAgyErrorRecord(rec, body);

      if (errored) continue;

      // Background task started (schedule timer/cron, non-daemon run_command, run_workflow)
      const bgMatch = AGY_BG_TASK_ID_RE.exec(body);
      if (bgMatch && rec.status === "RUNNING") {
        const id = bgMatch[1];
        const isDaemonCmd = name === "run_command" && isTruthyArg(args?.IsDaemon);
        if (!isDaemonCmd) {
          activeBgTasks.add(id);
          if (name === "schedule" || AGY_BG_CRON_RE.test(body) || /Task Description:\s*Timer:/i.test(body)) {
            activeTimers.add(id);
          }
          if (AGY_BG_CRON_RE.test(body) || (name === "schedule" && Boolean(unquoteArg(args?.CronExpression ?? "")))) {
            activeCrons.add(id);
          }
        }
      }

      if (name === "mcp_t3-code_schedule_task" || name === "mcp__t3-code__schedule_task") {
        const enabled = unquoteArg(args?.enabled);
        if (enabled !== false && enabled !== "false") {
          currentTurnHasTimer = true;
        }
      } else if (name === "mcp_t3-code_watch_pull_request" || name === "mcp__t3-code__watch_pull_request") {
        if (!/"watching"\s*:\s*false/.test(body)) {
          activePrWatches.add(prKeyFromWatchOutput(body, args));
        }
      } else if (name === "mcp_t3-code_unwatch_pull_request" || name === "mcp__t3-code__unwatch_pull_request") {
        const key = prKeyFromWatchOutput(body, args);
        if (key === "*") activePrWatches.clear();
        else activePrWatches.delete(key);
      } else if (name === "mcp_t3-code_delegate_task" || name === "mcp__t3-code__delegate_task") {
        const mode = unquoteArg(args?.mode ?? "async");
        if (mode !== "wait") currentTurnHasAsync = true;
      } else if (name === "run_workflow") {
        currentTurnHasAsync = true;
      } else if (name === "invoke_subagent") {
        const subMatch = AGY_SUBAGENT_ID_RE.exec(body);
        activeSubagents.add(subMatch ? subMatch[1] : `subagent-${++subagentFallbackSeq}`);
      } else if (name === "manage_task") {
        const action = unquoteArg(args?.Action ?? "");
        const taskId = unquoteArg(args?.TaskId ?? "");
        if (action === "kill" && taskId) {
          activeTimers.delete(taskId);
          activeCrons.delete(taskId);
          activeBgTasks.delete(taskId);
        }
      } else if (name === "manage_subagents") {
        const action = unquoteArg(args?.Action ?? "");
        if (action === "kill_all") {
          activeSubagents.clear();
        } else if (action === "kill") {
          let ids = args?.ConversationIds;
          if (typeof ids === "string") {
            try {
              ids = JSON.parse(unquoteArg(ids));
            } catch {
              ids = [];
            }
          }
          if (Array.isArray(ids)) {
            for (const id of ids) activeSubagents.delete(String(id));
          }
        }
      }
      continue;
    }

    // --- Claude Code transcript records ---
    if (rec.type === "user") {
      if (rec.isMeta || rec.isCompactSummary || rec.isVisibleInTranscriptOnly) continue;
      const content = rec.message?.content;
      const toolResults = Array.isArray(content)
        ? content.filter((block) => block?.type === "tool_result")
        : [];
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const call = pendingClaudeCalls.get(tr.tool_use_id);
          pendingClaudeCalls.delete(tr.tool_use_id);
          if (!call || tr.is_error === true) continue;
          const trBody = userText(tr.content);
          const { name, input } = call;
          if (name === "ScheduleWakeup" || name === "Monitor") {
            currentTurnHasTimer = true;
          } else if (name === "mcp__t3-code__schedule_task") {
            if (input.enabled !== false) currentTurnHasTimer = true;
          } else if (name === "mcp__t3-code__watch_pull_request") {
            if (!/"watching"\s*:\s*false/.test(trBody)) {
              activePrWatches.add(prKeyFromWatchOutput(trBody, input));
            }
          } else if (name === "mcp__t3-code__unwatch_pull_request") {
            const key = prKeyFromWatchOutput(trBody, input);
            if (key === "*") activePrWatches.clear();
            else activePrWatches.delete(key);
          } else if (name === "mcp__t3-code__delegate_task") {
            if (input.mode !== "wait") currentTurnHasAsync = true;
          } else if (name === "Agent" && input.run_in_background === true) {
            currentTurnHasAsync = true;
          } else if (name === "Bash" && input.run_in_background === true) {
            currentTurnHasTimer = true;
          }
        }
        continue;
      }

      const textBody = userText(content);
      if (INJECTED_USER.test(textBody)) continue;

      // Both explicit user prompts and system-delivered wakeup turns start a new turn.
      currentTurnHasTimer = false;
      currentTurnHasAsync = false;
      pendingClaudeCalls.clear();
      clearStoppedPrWatch(activePrWatches, textBody);
      continue;
    }

    if (rec.type === "assistant") {
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== "tool_use" || !block.id) continue;
        pendingClaudeCalls.set(block.id, {
          name: block.name ?? "",
          input: block.input && typeof block.input === "object" ? block.input : {},
        });
      }
    }
  }

  const hasTimer = activeTimers.size > 0 || activeBgTasks.size > 0 || currentTurnHasTimer;
  const hasAsync = hasTimer || activePrWatches.size > 0 || activeSubagents.size > 0 || currentTurnHasAsync;
  return { hasTimer, hasAsync, readable: true };
}

/** Evaluates a Stop hook payload. Returns `{ block: boolean, reason?: string }`. */
export function checkStopWakeup(input) {
  if (!input || input.stop_hook_active) return { block: false };
  if (process.env.GUARD_WAKEUP === "off") return { block: false };
  const message = input.last_assistant_message;
  if (typeof message !== "string" || !message.trim()) return { block: false };

  const claim = detectWakeupClaim(message);
  if (!claim) return { block: false };

  const state = activeWakeups(input.transcript_path);
  if (!state.readable) return { block: false };

  if (claim.kind === "timer" && !state.hasTimer) {
    return {
      block: true,
      reason:
        `Your reply promises a timed check-back ("${claim.match}"), but this turn has no active timer or background task to wake you up (guard-wakeup hook).\n`
        + "Call `schedule` (Antigravity) / `ScheduleWakeup` (Claude Code) or start a background task before ending your turn, "
        + "or revise the reply if you are handing back to the user instead of waking up automatically.",
    };
  }

  if (claim.kind === "async" && !state.hasAsync) {
    return {
      block: true,
      reason:
        `Your reply promises an automatic wakeup or continuation ("${claim.match}"), but no timer, PR watch, delegate, subagent, or background task is active to wake you up (guard-wakeup hook).\n`
        + "Start the wake mechanism (`schedule` / `ScheduleWakeup`, `watch_pull_request`, `delegate_task`, `invoke_subagent`, or a background command) before ending your turn, "
        + "or revise the reply if you are handing back to the user.",
    };
  }

  return { block: false };
}

if (import.meta.main) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const result = checkStopWakeup(input);
  if (result.block) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(2);
  }
}
