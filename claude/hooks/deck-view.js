// Claude Code Stop hook. When a slide deck that claude/bin/deck-view has shown changed since
// its last render, and this session's transcript names it, the hook blocks the stop once
// (exit 2) and asks for a new render, so the user sees each deck edit without asking. The
// user asked for this on 2026-11-19 after asking "slides" after every deck edit. It is a
// reminder, not a gate: a stop that continues from a Stop hook passes. A deck no session has
// shown with deck-view is not watched. It fails open: a state or transcript it cannot read
// lets the stop through, with the reason on stderr.
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { sha256, shown } from "../bin/deck-view.js";

/** The shown decks that changed since their last render and that `transcript` names. */
export function staleDecks(state, transcript) {
  return Object.entries(state).filter(([deck, hash]) =>
    existsSync(deck) && transcript.includes(basename(deck)) && sha256(deck) !== hash).map(([deck]) => deck);
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (input.stop_hook_active || typeof input.transcript_path !== "string" || !existsSync(input.transcript_path)) process.exit(0);
  let stale;
  try {
    stale = staleDecks(shown(), readFileSync(input.transcript_path, "utf8"));
  } catch (error) {
    process.stderr.write(`deck-view hook skipped: ${error.message}\n`);
    process.exit(0);
  }
  if (stale.length > 0) {
    process.stderr.write(
      `A slide deck changed since it was last shown (deck-view hook):\n${stale.map((deck) => `- ${deck}`).join("\n")}\n`
        + "For each, run `deck-view '<path>'` and show the page it prints with the T3 html_render tool "
        + "(path argument, height 474). Then end the turn as planned.\n",
    );
    process.exit(2);
  }
}
