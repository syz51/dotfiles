// Claude Code Stop hook. Enforces the Work board rule in ~/.claude/CLAUDE.md that each open
// item of a reply (a limit that needs work, a follow-up, a step not done or not verified)
// names the task or ask that holds it, or states why it needs no work. The board's own Stop
// reminder fires only after task_done or a release, so a reply that lists unfinished parts
// under a heading such as "Limits" passed unchecked, and the thread could settle with them
// in chat only.
//
// The hook reads the reply (`last_assistant_message`), finds its open-item sections by the
// heading patterns in open-items.json, and blocks the stop once (exit 2) when an item there
// names no task of a known board, no ask and no exempt phrase. It applies only where the
// repository has a work board, and never when the stop already continues from a Stop hook.
// It is a reminder, not a gate: the second stop passes. The user tunes or turns it off in
// open-items.json. Like board-hook.sh, it does nothing with AGENT_BOARD_HOOKS=off (test,
// benchmark and nested `claude -p` sessions) or without the installed board. It fails open:
// when the board cannot answer, the stop goes through.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// An ask as "ask #31", or "ask 31" when no word follows (so "ask 3 reviewers" is not one).
const ASK = /\bask\s*#\d+\b|\bask \d+\b(?!\s+\p{L})/iu;
const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
// A heading line, or a bold label alone on its line: `**Not run:**` or `**Not run**:`.
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const LABEL_LINE = /^\s*\*\*([^*]+)\*\*\s*[:：]?\s*$/;
const LEAD_LABEL = /^\*\*([^*]+)\*\*/;
const plain = (text) => text.replace(/[*_`]/g, "").replace(/[\s.:：]+$/, "").trim();
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reply as blocks: `{heading, level}` for a heading or label line, `{text, bullet}` otherwise. */
function blocks(message) {
  const out = [];
  let open;
  let fenced = false;
  for (const line of message.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; open = undefined; continue; }
    if (fenced || /^\s*\|/.test(line)) continue;
    if (line.trim() === "") { open = undefined; continue; }
    const heading = HEADING.exec(line);
    const label = heading ? undefined : LABEL_LINE.exec(line);
    if (heading || label) {
      out.push({ heading: plain((heading ?? label)[1]), level: heading ? "section" : "label" });
      open = undefined;
      continue;
    }
    const bullet = BULLET.exec(line);
    const indent = bullet ? bullet[1].length : 0;
    // A nested bullet and a wrapped line belong to the item above; a new bullet or a lead label starts one.
    const nested = bullet && open?.bullet && indent > open.indent;
    if (!open || (bullet && !nested) || (!bullet && LEAD_LABEL.test(line.trim()))) {
      open = { text: line.replace(BULLET, "").trim(), bullet: Boolean(bullet), indent };
      out.push(open);
    } else open.text += ` ${line.replace(BULLET, "").trim()}`;
  }
  return out;
}

/** The items of `message`'s open sections, after exempt sections and exempt items are left out. */
export function openItems(message, config) {
  const headings = config.headings.map((source) => new RegExp(source, "i"));
  const exempt = config.exempt.map((source) => new RegExp(source, "i"));
  const isOpen = (title) => headings.some((pattern) => pattern.test(title));
  const isExempt = (text) => exempt.some((pattern) => pattern.test(plain(text)));
  const found = [];
  let section = false;
  let open = false;
  for (const block of blocks(message)) {
    if (block.heading !== undefined) {
      // A label opens its list inside or outside an open section; a section heading starts over.
      const opens = isOpen(block.heading) && !isExempt(block.heading);
      if (block.level === "section") section = open = opens;
      else open = opens || (section && !isExempt(block.heading));
      continue;
    }
    const label = LEAD_LABEL.exec(block.text);
    const body = label ? block.text.slice(label[0].length) : block.text;
    if (!open && !(label && isOpen(plain(label[1])))) continue;
    if (!block.bullet && !label) {
      // An intro paragraph: "no action" in it closes the section; one that leads into a list is no item.
      if (isExempt(body)) { open = section = false; continue; }
      if (/[:：]\s*$/.test(body)) continue;
    }
    if (!isExempt(body)) found.push(block.text);
  }
  return found;
}

/** The open items that name no task of the boards `slugs` and no ask. */
export function unfiledItems(items, slugs) {
  const task = new RegExp(`\\b(?:${slugs.map(escape).join("|")})-\\d+\\b`, "i");
  return items.filter((item) => !task.test(item) && !ASK.test(item));
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
  const items = active && typeof message === "string" && existsSync(board) ? openItems(message, config) : [];
  const boards = items.length > 0 && ask(board, ["status"], input.cwd)?.board ? ask(board, ["boards"], input.cwd) : undefined;
  const unfiled = Array.isArray(boards) ? unfiledItems(items, boards.map((entry) => entry.slug)) : [];
  if (unfiled.length > 0) {
    const shown = unfiled.slice(0, 5).map((item) => `- ${item.length > 90 ? `${item.slice(0, 90)}…` : item}`).join("\n");
    const more = unfiled.length > 5 ? `\n(and ${unfiled.length - 5} more)` : "";
    process.stderr.write(
      `Your reply lists open items that name no task or ask (open-items hook):\n${shown}${more}\n`
        + "Do the item now, or put it on the board (a sub-task, a proposal, or a task blocked on an ask; "
        + "a note where a task already covers it) and name the task id or `ask #<n>` beside the item. "
        + "Where an item needs no work, say so in it (\"no action: <reason>\"). Where the section describes "
        + "the subject, not open work, put \"no action\" in its heading. "
        + "If the thread is settled, unsettle it first. Then give the reply again.\n",
    );
    process.exit(2);
  }
}
