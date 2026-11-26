// Claude Code and Antigravity Stop hook. Enforces the Work board rule in ~/.claude/CLAUDE.md
// (and ~/.gemini/config/GEMINI.md) that each tool-using reply in a repository with a work board
// ends with an `Open items:` label whose entries name the task or ask that holds them, or say
// `none` or `no action: <reason>`. The board's own Stop reminder fires only after task_done or
// a release, so later turns, no-task threads and delegated children passed unchecked.
//
// The hook reads the reply (`last_assistant_message`) and checks only its `Open items:` label
// section (no heading scan or lead-label scan). It blocks the stop once (exit 2) when:
//   - a tool-using turn (read from `transcript_path`) has no `Open items:` label, or an empty one;
//   - an entry under `Open items:` names no task of a known board, no ask and no exempt phrase.
//
// It applies only where the repository has a work board, and never when the stop already
// continues from a Stop hook. It is a reminder, not a gate: the second stop passes. The user
// tunes exempt phrases or turns it off in open-items.json. Like board-hook.sh, it does nothing
// with AGENT_BOARD_HOOKS=off (test, benchmark and nested `claude -p` sessions) or without the
// installed board. It fails open: when the board cannot answer or the transcript cannot be read,
// the stop goes through.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// An ask as "ask #31", or "ask 31" when no word follows (so "ask 3 reviewers" is not one).
const ASK = /\bask\s*#\d+\b|\bask \d+\b(?!\s+\p{L})/iu;
const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const HRULE = /^\s*(?:[-*_]\s*){3,}$/;
// `## Open items`, `## Open items: ...`, `## **Open items:** ...`, `## Open items (no action...)`
// (does not match topic headings such as `## Open items hook`).
const OPEN_HEADING = /^\s*#{1,6}\s+(?:\*\*|__|\*)?open items(?:\s*[:：]\s*(?:\*\*|__|\*)?\s*(.*)|(?:\*\*|__|\*)?\s*(?:[:：]\s*(.*)|\(([^)]+)\)\s*)?)$/i;
// `Open items:`, `Open items: ...`, `**Open items:** ...`, `**Open items**: ...`, `**Open items: none**`, or `**Open items**`.
const OPEN_LABEL = /^\s*(?:(?:\*\*|__|\*)?open items\s*(?:[:：]\s*(?:\*\*|__|\*)?|(?:\*\*|__|\*)?\s*[:：])\s*(.*)|(?:\*\*|__)open items(?:\*\*|__)\s*())$/i;
// Closing statements after an Open items list or entry are not open-item entries.
const CLOSING_LINE = /^(?:(?:i\s+)?settled\s+(?:this|the)\s+thread|(?:this|the)\s+thread\s+is\s+settled|thread\s+settled|no repository file changed and no check ran in this turn)(?:[.!?](?:\s|$)|$)/i;
const INJECTED_USER = /^\s*<(?:local-command-stdout|local-command-stderr|system-reminder|bash-stdout|bash-stderr)>/;
const plain = (text) => text.replace(/[*_`]/g, "").replace(/[\s.:：]+$/, "").trim();
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function userText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
  return "";
}

/** Whether tools ran in the transcript's latest turn (Claude Code or Antigravity JSONL). */
export function turnUsedTools(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath || !existsSync(transcriptPath)) return false;
  let text;
  try {
    text = readFileSync(transcriptPath, "utf8");
  } catch {
    return false;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || record.isSidechain || record.forkedFrom) continue;
    // Antigravity transcript records.
    if (record.type === "USER_INPUT") return false;
    if (record.type === "GENERIC") return true;
    if (record.type === "PLANNER_RESPONSE" && Array.isArray(record.tool_calls) && record.tool_calls.length > 0) return true;
    // Claude Code transcript records.
    if (record.type === "assistant") {
      const content = record.message?.content;
      if (Array.isArray(content) && content.some((block) => block?.type === "tool_use")) return true;
      continue;
    }
    if (record.type === "user") {
      if (record.isMeta || record.isCompactSummary || record.isVisibleInTranscriptOnly) continue;
      const content = record.message?.content;
      if (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) return true;
      if (record.promptSource === "system") continue;
      if (INJECTED_USER.test(userText(content))) continue;
      return false;
    }
  }
  return false;
}

/**
 * Parses `message`'s `Open items:` label section(s).
 * Returns `{ present, empty, items }`:
 * - `present`: true if an `Open items:` label or heading was found outside code/quotes/tables.
 * - `empty`: true if `present` is true but no non-closing entry appeared in it.
 * - `items`: non-exempt entries under `Open items:` that still require a task or ask id.
 */
export function openItemsSection(message, config) {
  const exempt = (config.exempt ?? []).map((source) => new RegExp(source, "i"));
  const isExempt = (text) => exempt.some((pattern) => pattern.test(plain(text)));
  const isClosing = (text) => CLOSING_LINE.test(plain(text));

  let present = false;
  let hasEntry = false;
  const items = [];

  let mode = "none"; // "none" | "block" | "inline"
  let seenBullet = false;
  let current = null;
  let fenced = false;

  const flush = () => {
    if (!current) return;
    const entry = current;
    current = null;
    if (!entry.bullet) {
      if (isClosing(entry.text)) return;
      if (!isExempt(entry.text) && /[:：]\s*$/.test(entry.text.replace(/[*_`]+$/, "").trim())) return;
    }
    hasEntry = true;
    if (!isExempt(entry.text)) items.push(entry.text);
  };

  for (const line of message.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fenced = !fenced;
      if (fenced) mode = "none";
      continue;
    }
    if (fenced) continue;
    if (/^\s*\|/.test(line)) { flush(); continue; }
    if (/^\s*>/.test(line)) { flush(); mode = "none"; continue; }

    if (line.trim() === "") {
      flush();
      if (mode === "inline") mode = "none";
      continue;
    }

    if (HRULE.test(line)) {
      flush();
      mode = "none";
      continue;
    }

    const headingMatch = OPEN_HEADING.exec(line);
    const labelMatch = headingMatch ? null : OPEN_LABEL.exec(line);
    if (headingMatch || labelMatch) {
      flush();
      present = true;
      seenBullet = false;
      const rawInline = (headingMatch ? (headingMatch[1] ?? headingMatch[2] ?? headingMatch[3] ?? "") : (labelMatch[1] ?? "")).trim();
      if (rawInline === "") {
        mode = "block";
      } else if (!isExempt(rawInline) && /[:：]\s*$/.test(rawInline.replace(/[*_`]+$/, "").trim())) {
        // Intro text leading into a list, e.g. `Open items: two follow-ups:`.
        mode = "block";
      } else {
        current = { text: rawInline, bullet: false, indent: 0 };
        mode = "inline";
      }
      continue;
    }

    if (HEADING.test(line)) {
      flush();
      mode = "none";
      continue;
    }

    if (mode === "none") continue;

    const bullet = BULLET.exec(line);
    const indent = bullet ? bullet[1].length : line.match(/^(\s*)/)[1].length;

    if (mode === "inline") {
      // Only indented non-bullet continuation lines wrap onto an inline `Open items: ...` entry.
      if (!bullet && indent > 0 && current && !isClosing(line)) {
        current.text += ` ${line.trim()}`;
        continue;
      }
      flush();
      mode = "none";
      continue;
    }

    if (bullet) {
      const text = line.replace(BULLET, "").trim();
      const nested = current?.bullet && indent > current.indent;
      if (nested) {
        current.text += ` ${text}`;
      } else {
        flush();
        seenBullet = true;
        current = { text, bullet: true, indent };
      }
      continue;
    }

    if (isClosing(line)) {
      flush();
      mode = "none";
      continue;
    }
    if (!current) {
      // After a bullet list and a blank line, a plain paragraph is a closing line, not an entry.
      if (seenBullet) {
        mode = "none";
        continue;
      }
      current = { text: line.trim(), bullet: false, indent };
    } else {
      current.text += ` ${line.trim()}`;
    }
  }
  flush();
  return { present, empty: present && !hasEntry, items };
}

/** The non-exempt entries of `message`'s `Open items:` section(s). */
export const openItems = (message, config) => openItemsSection(message, config).items;

/** The open items that name no task of the boards `slugs` and no ask. */
export function unfiledItems(items, slugs) {
  const task = slugs.length > 0 ? new RegExp(`\\b(?:${slugs.map(escape).join("|")})-\\d+\\b`, "i") : null;
  return items.filter((item) => !(task && task.test(item)) && !ASK.test(item));
}

/** The board's JSON answer to `args` in `cwd`, or undefined when it fails or is not JSON. */
function ask(board, args, cwd) {
  const run = Bun.spawnSync([board, ...args, "--json"], { cwd, timeout: 3000, stderr: "ignore" });
  if (run.exitCode !== 0) return undefined;
  try {
    return JSON.parse(run.stdout.toString());
  } catch {
    return undefined; // An old or broken board: fail open, as board-hook.sh does without one.
  }
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const config = JSON.parse(readFileSync(process.env.OPEN_ITEMS ?? join(import.meta.dir, "open-items.json"), "utf8"));
  const board = process.env.BOARD_BIN ?? join(homedir(), ".cargo/bin/board");
  const message = input.last_assistant_message;
  const active = config.enabled && process.env.AGENT_BOARD_HOOKS !== "off" && !input.stop_hook_active;
  if (!active || typeof message !== "string" || !existsSync(board)) process.exit(0);

  const section = openItemsSection(message, config);
  const missingLabel = section.empty || (!section.present && turnUsedTools(input.transcript_path));
  if (!missingLabel && section.items.length === 0) process.exit(0);

  if (!ask(board, ["status"], input.cwd)?.board) process.exit(0);

  if (missingLabel) {
    const why = section.empty
      ? "Your reply has an empty `Open items:` label (open-items hook)."
      : "Your tool-using reply has no `Open items:` label (open-items hook).";
    process.stderr.write(
      `${why}\n`
        + "End the reply with `Open items:` followed by each entry naming its task id or `ask #<n>`, "
        + "or `none`, or `no action: <reason>` (an agent's cut or verdict is no reason). "
        + "If the thread is settled, unsettle it first. Then give the reply again.\n",
    );
    process.exit(2);
  }

  const boards = ask(board, ["boards"], input.cwd);
  const unfiled = Array.isArray(boards) ? unfiledItems(section.items, boards.map((entry) => entry.slug)) : [];
  if (unfiled.length > 0) {
    const shown = unfiled.slice(0, 5).map((item) => `- ${item.length > 90 ? `${item.slice(0, 90)}…` : item}`).join("\n");
    const more = unfiled.length > 5 ? `\n(and ${unfiled.length - 5} more)` : "";
    process.stderr.write(
      `Your reply lists open items that name no task or ask (open-items hook):\n${shown}${more}\n`
        + "Do the item now, or put it on the board (a sub-task, a proposal, or a task blocked on an ask; "
        + "a note where a task already covers it) and name the task id or `ask #<n>` beside the item. "
        + "Where an item needs no work, say so in it (\"no action: <reason>\"). "
        + "If the thread is settled, unsettle it first. Then give the reply again.\n",
    );
    process.exit(2);
  }
}
