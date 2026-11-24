// Renders a slide deck (.pptx, .key or any file LibreOffice opens) into one HTML page that
// shows one slide at a time: Prev and Next buttons, a slide counter and the arrow keys. The
// slides are JPEGs inside the page, so it is one file for the T3 `html_render` tool. It prints
// the page's path and records the deck's sha256 as shown; the Stop hook
// claude/hooks/deck-view.js asks for a new render when a deck changes after that.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The folder that holds shown.json and the pages; DECK_VIEW_STATE overrides it in tests. */
export const stateDir = () => process.env.DECK_VIEW_STATE ?? join(homedir(), ".cache/deck-view");

export const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Absolute deck path to the sha256 it had when deck-view last rendered it. */
export function shown() {
  const file = join(stateDir(), "shown.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function recordShown(deck, hash) {
  const file = join(stateDir(), "shown.json");
  // A temporary name per process, so two renders at once never rename each other's file. The
  // later of two simultaneous writes can still drop the other's entry; that deck is then
  // unwatched until its next render.
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...shown(), [deck]: hash }, null, 2)}\n`);
  renameSync(temporary, file);
}

/** The viewer page for `slides` (data URLs). Theme variables only, no page background. */
export function viewerHtml(title, slides) {
  const esc = (text) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>
.deck{font-family:var(--font-sans);color:var(--foreground);max-width:712px;margin:0 auto}
.deck img{width:100%;display:block;border:1px solid var(--border);border-radius:var(--radius)}
.deck nav{display:flex;gap:8px;align-items:center;justify-content:center;margin-top:8px}
.deck button{font:inherit;padding:4px 14px;border-radius:var(--radius);border:1px solid var(--border);background:transparent;color:inherit;cursor:pointer}
.deck button:disabled{opacity:.4;cursor:default}
</style><div class="deck"><img id="slide" alt=""><nav><button id="prev">&#9664; Prev</button><span id="count"></span><button id="next">Next &#9654;</button></nav></div>
<script>const S=${JSON.stringify(slides)};let k=0;const img=document.getElementById("slide"),count=document.getElementById("count"),prev=document.getElementById("prev"),next=document.getElementById("next");
function go(d){k=Math.max(0,Math.min(S.length-1,k+d));img.src=S[k];img.alt="Slide "+(k+1);count.textContent=(k+1)+" / "+S.length;prev.disabled=k===0;next.disabled=k===S.length-1}
prev.onclick=()=>go(-1);next.onclick=()=>go(1);
document.addEventListener("keydown",e=>{if(e.key==="ArrowLeft")go(-1);if(e.key==="ArrowRight")go(1)});go(0);</script>
`;
}

function run(cmd) {
  const out = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(`${cmd[0]} failed (${out.exitCode}): ${out.stderr.toString().trim()}`);
}

/** Renders `deck` and returns the page path and slide count. */
export function render(deck, { soffice = process.env.SOFFICE ?? "soffice", pdftoppm = process.env.PDFTOPPM ?? "pdftoppm" } = {}) {
  const hash = sha256(deck);
  const work = mkdtempSync(join(tmpdir(), "deck-view-"));
  try {
    // Its own profile, so a LibreOffice window the user has open does not swallow the job.
    run([soffice, `-env:UserInstallation=${pathToFileURL(join(work, "profile")).href}`, "--headless",
      "--convert-to", "pdf", "--outdir", work, deck]);
    const pdf = join(work, `${basename(deck, extname(deck))}.pdf`);
    if (!existsSync(pdf)) throw new Error(`soffice wrote no PDF for ${deck}`);
    run([pdftoppm, "-r", "110", "-jpeg", "-jpegopt", "quality=85", pdf, join(work, "s")]);
    // pdftoppm pads the page number to one width, so the names sort in page order.
    const pages = readdirSync(work).filter((name) => /^s-\d+\.jpg$/.test(name)).sort();
    if (pages.length === 0) throw new Error(`pdftoppm wrote no slides for ${deck}`);
    const slides = pages.map((name) => `data:image/jpeg;base64,${readFileSync(join(work, name)).toString("base64")}`);
    mkdirSync(join(stateDir(), "html"), { recursive: true });
    // One page per deck path, replaced by each render, so pages do not pile up.
    const key = createHash("sha256").update(deck).digest("hex").slice(0, 8);
    const page = join(stateDir(), "html", `${basename(deck, extname(deck))}-${key}.html`);
    writeFileSync(page, viewerHtml(basename(deck), slides));
    recordShown(deck, hash);
    return { page, count: slides.length };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("-")) {
    process.stderr.write("usage: deck-view <deck.pptx>\n");
    process.exit(64);
  }
  const deck = resolve(args[0]);
  if (!existsSync(deck)) {
    process.stderr.write(`deck-view: no such file: ${deck}\n`);
    process.exit(66);
  }
  const { page, count } = render(deck);
  console.log(page);
  console.log(`${count} slides. Show it with the T3 html_render tool: path ${page}, height 474.`);
}
