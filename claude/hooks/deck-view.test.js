import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render, sha256, shown, viewerHtml } from "../bin/deck-view.js";
import { staleDecks } from "./deck-view.js";

const HOOK = join(import.meta.dir, "deck-view.js");
const BIN = join(import.meta.dir, "../bin/deck-view");
let dir;
let tools;

// Fake soffice writes <name>.pdf into --outdir; fake pdftoppm writes two pages next to its prefix.
function fakeTools(sofficeExit = 0) {
  const soffice = join(dir, "soffice");
  writeFileSync(soffice, `#!/bin/sh\n[ ${sofficeExit} -eq 0 ] || { echo broken >&2; exit ${sofficeExit}; }\n`
    + `while [ "$1" != "--outdir" ]; do shift; done\nout=$2; deck=$3\nname=$(basename "$deck"); printf pdf > "$out/\${name%.*}.pdf"\n`);
  const pdftoppm = join(dir, "pdftoppm");
  writeFileSync(pdftoppm, `#!/bin/sh\nfor last; do :; done\nprintf one > "$last-01.jpg"\nprintf two > "$last-02.jpg"\nprintf x > "$last-other.txt"\n`);
  chmodSync(soffice, 0o755);
  chmodSync(pdftoppm, 0o755);
  return { soffice, pdftoppm };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deck-view-test-"));
  process.env.DECK_VIEW_STATE = join(dir, "state");
  tools = fakeTools();
});
afterEach(() => {
  delete process.env.DECK_VIEW_STATE;
  rmSync(dir, { recursive: true, force: true });
});

const deckFile = (text = "v1") => {
  const deck = join(dir, "Talk 1119.pptx");
  writeFileSync(deck, text);
  return deck;
};

function hook(input) {
  return Bun.spawnSync(["bun", HOOK], { stdin: Buffer.from(JSON.stringify(input)), env: { ...process.env } });
}

test("render writes one page with every slide in order and records the deck as shown", () => {
  const deck = deckFile();
  const { page, count } = render(deck, tools);
  expect(count).toBe(2);
  const html = readFileSync(page, "utf8");
  const one = Buffer.from("one").toString("base64");
  const two = Buffer.from("two").toString("base64");
  expect(html.indexOf(one)).toBeGreaterThan(0);
  expect(html.indexOf(one)).toBeLessThan(html.indexOf(two));
  expect(shown()).toEqual({ [deck]: sha256(deck) });
  // A second render of a changed deck replaces the page.
  writeFileSync(deck, "v2");
  expect(render(deck, tools).page).toBe(page);
  expect(readdirSync(join(dir, "state/html"))).toHaveLength(1);
  expect(shown()[deck]).toBe(sha256(deck));
});

test("a failed conversion throws and records nothing", () => {
  const deck = deckFile();
  expect(() => render(deck, fakeTools(1))).toThrow(/broken/);
  expect(shown()).toEqual({});
});

test("the viewer escapes the title and steps with buttons and arrow keys", () => {
  const html = viewerHtml("<a&b>", ["data:x"]);
  expect(html).toContain("<title>&#60;a&#38;b&#62;</title>");
  expect(html).toContain("ArrowLeft");
  expect(html).toContain("ArrowRight");
  expect(html).not.toMatch(/\bvh\b|body\s*\{/);
});

test("the wrapper prints usage without one deck and refuses a missing file", () => {
  expect(Bun.spawnSync([BIN]).exitCode).toBe(64);
  expect(Bun.spawnSync([BIN, join(dir, "missing.pptx")]).exitCode).toBe(66);
});

test("a deck is stale only when it changed since its render and the transcript names it", () => {
  const deck = deckFile();
  const state = { [deck]: sha256(deck), [join(dir, "gone.pptx")]: "x" };
  const named = `{"text":"saved Talk 1119.pptx"}`;
  expect(staleDecks(state, named)).toEqual([]);
  writeFileSync(deck, "v2");
  expect(staleDecks(state, named)).toEqual([deck]);
  expect(staleDecks(state, `{"text":"other work"}`)).toEqual([]);
  expect(staleDecks(state, `{"text":"saved old-Talk 1119.pptx and Talk 1119.pptx.bak"}`)).toEqual([]);
  expect(staleDecks(state, `{"text":"cp \\"$O/Talk 1119.pptx\\" ."}`)).toEqual([deck]);
});

test("the hook blocks a stop once for a changed deck, then lets it through", () => {
  const deck = deckFile();
  render(deck, tools);
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, `{"text":"edit ${deck}"}\n`);
  expect(hook({ transcript_path: transcript }).exitCode).toBe(0);
  writeFileSync(deck, "v2");
  const blocked = hook({ transcript_path: transcript });
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stderr.toString()).toContain(deck);
  expect(hook({ transcript_path: transcript, stop_hook_active: true }).exitCode).toBe(0);
  render(deck, tools);
  expect(hook({ transcript_path: transcript }).exitCode).toBe(0);
});

test("without shown decks the hook passes without reading the transcript", () => {
  expect(hook({ transcript_path: join(dir, "missing-dir") }).exitCode).toBe(0);
  mkdirSync(join(dir, "transcript-dir"));
  const run = hook({ transcript_path: join(dir, "transcript-dir") });
  expect(run.exitCode).toBe(0);
  expect(run.stderr.toString()).toBe("");
});

test("the hook fails open on unreadable state", () => {
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, "{}\n");
  process.env.DECK_VIEW_STATE = join(dir, "bad");
  mkdirSync(join(dir, "bad"));
  writeFileSync(join(dir, "bad/shown.json"), "not json");
  const run = hook({ transcript_path: transcript });
  expect(run.exitCode).toBe(0);
  expect(run.stderr.toString()).toContain("deck-view hook skipped");
});
