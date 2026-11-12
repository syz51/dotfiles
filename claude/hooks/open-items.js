// Claude Code Stop hook. Enforces the Work board rule in ~/.claude/CLAUDE.md that each open
// item of a reply (a limit that needs work, a follow-up, a step not done or not verified)
// names the task or ask that holds it, or states why it needs no work. The board's own Stop
// reminder fires only after task_done or a release, so a reply that lists unfinished parts
// under a heading such as "Limits" passed unchecked, and the thread could settle with them
// in chat only.
//
// The hook reads the reply (`last_assistant_message`), finds its open-item sections by the
// heading patterns in open-items.json, and blocks the stop once (exit 2) when an item there
// has no board id and no exempt phrase. It applies only where the repository has a work
// board, and never when the stop already continues from a Stop hook. It is a reminder, not
// a gate: the second stop passes. The user tunes or turns it off in open-items.json. It
// fails open: on a crash, an unreadable config or an unreachable board the stop goes through.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A task id such as dotfiles-426 or board-feedback-12, or an ask such as "ask 31" or "ask #31".
// The lookahead leaves out version-like text such as claude-opus-5-5.
const ID = /\b[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-\d+\b(?![-.]\d)|\bask\s*#?\d+\b/i;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const plain = (text) => text.replace(/[*_`]/g, "").replace(/[\s.:：]+$/, "").trim();

/** The reply as blocks: `{heading}` for a heading line, `{text}` for a list item or paragraph. */
function blocks(message) {
  const out = [];
  let open;
  let fenced = false;
  for (const line of message.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; open = undefined; continue; }
    if (fenced || /^\s*\|/.test(line)) continue;
    if (line.trim() === "") { open = undefined; continue; }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line) ?? /^\s*\*\*([^*]+)\*\*\s*$/.exec(line);
    if (heading) { out.push({ heading: plain(heading[1]) }); open = undefined; continue; }
    // A list marker or a lead label starts a new block; other lines continue the block above.
    if (BULLET.test(line) || /^\s*\*\*[^*]+\*\*/.test(line) || !open) { open = { text: line.replace(BULLET, "").trim() }; out.push(open); }
    else open.text += ` ${line.trim()}`;
  }
  return out;
}

/** The open items of `message` that name no task or ask and carry no exempt phrase. */
export function unfiledItems(message, config) {
  const headings = config.headings.map((source) => new RegExp(source, "i"));
  const exempt = config.exempt.map((source) => new RegExp(source, "i"));
  const isOpen = (title) => headings.some((pattern) => pattern.test(title));
  const found = [];
  let inOpen = false;
  for (const block of blocks(message)) {
    if (block.heading !== undefined) { inOpen = isOpen(block.heading); continue; }
    // A lead label such as `**Not run:** the races` makes its own block an open item.
    const label = /^\*\*([^*]+)\*\*/.exec(block.text);
    const body = label ? block.text.slice(label[0].length) : block.text;
    if (!inOpen && !(label && isOpen(plain(label[1])))) continue;
    // A label line that only introduces the list below it is not an item.
    if (label && plain(body) === "") continue;
    if (ID.test(block.text) || exempt.some((pattern) => pattern.test(plain(body)))) continue;
    found.push(block.text);
  }
  return found;
}

/** True when the repository at `cwd` has a work board; false when it has none or the board cannot say. */
function hasBoard(cwd) {
  const run = Bun.spawnSync([process.env.BOARD_BIN ?? "board", "status", "--json"], { cwd, timeout: 3000, stderr: "ignore" });
  if (run.exitCode !== 0) return false;
  return JSON.parse(run.stdout.toString()).board !== undefined;
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const config = JSON.parse(readFileSync(process.env.OPEN_ITEMS ?? join(import.meta.dir, "open-items.json"), "utf8"));
  const message = input.last_assistant_message;
  if (config.enabled && !input.stop_hook_active && typeof message === "string") {
    const items = unfiledItems(message, config);
    if (items.length > 0 && hasBoard(input.cwd)) {
      const shown = items.slice(0, 5).map((item) => `- ${item.length > 90 ? `${item.slice(0, 90)}…` : item}`).join("\n");
      const more = items.length > 5 ? `\n(and ${items.length - 5} more)` : "";
      process.stderr.write(
        `Your reply lists open items that name no task or ask (open-items hook):\n${shown}${more}\n`
          + "Do the item now, or put it on the board (a sub-task, a proposal, or a task blocked on an ask; "
          + "a note where a task already covers it) and name the id beside the item. "
          + "Where an item needs no work, say so in it (\"no action: <reason>\"). "
          + "If the thread is settled, unsettle it first. Then give the reply again.\n",
      );
      process.exit(2);
    }
  }
}
