#!/usr/bin/env bun
// Find and fetch cheat sheets listed on cheat-sheets.org, one large HTML page of sections
// (`h2.thT` with an anchor id) and items (`li.iLi`) that link an online, a saved and an
// archived copy. The page states no license, so nothing fetched here belongs in a repository.
//
//   bun cheatsheets.ts find [--refresh] [--limit N] <terms...>
//   bun cheatsheets.ts get <id>
//
// CHEAT_SHEETS_URL overrides the page and CHEAT_SHEETS_CACHE the cache folder.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

const SOURCE = process.env.CHEAT_SHEETS_URL || "https://www.cheat-sheets.org/";
const CACHE = process.env.CHEAT_SHEETS_CACHE || join(homedir(), ".cache", "cheat-sheets");
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const HEADERS = { "user-agent": "cheat-sheets-skill/1" };

type Kind = "online" | "saved" | "archived";
export type Item = {
  id: string;
  section: string;
  title: string;
  formats: string[];
  year: number | null;
  links: Record<Kind, string[]>;
};
export type Index = {
  source: string;
  fetched: string;
  sections: Record<string, { name: string; aliases: string[] }>;
  items: Item[];
};

// Common short names the page's menu lacks.
const EXTRA_ALIASES: Record<string, string[]> = {
  RegularExpressions: ["regex", "regexp"], Kubernetes: ["k8s"], JavaScript: ["js"], TypeScript: ["ts"],
  PostgreSQL: ["postgres"], Python: ["py"], ShellScript: ["sh", "shell"],
};

const ENTITIES:Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) =>
  name[0] !== "#" ? ENTITIES[name.toLowerCase()] ?? whole
    : String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)));
const squash = (text: string) => decode(text).replace(/\s+/g, " ").trim();
const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9+#]/g, "");

// The newest plausible year in the saved copies' file names (such as `.20211117.`) and the title.
function newestYear(texts: string[]): number | null {
  const now = new Date().getUTCFullYear();
  const years = texts.flatMap((text) => [...text.matchAll(/(?<!\d)((?:19|20)\d\d)(?:[01]\d[0-3]\d)?(?!\d)/g)])
    .map((match) => Number(match[1])).filter((year) => year >= 1980 && year <= now);
  return years.length ? Math.max(...years) : null;
}

function absolute(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null; // a malformed href on the page is not a link we can follow
  }
}

export async function parseIndex(html: string, base: string): Promise<Index> {
  const sections: Index["sections"] = {};
  const items: Item[] = [];
  const counts: Record<string, number> = {};
  const aliases: { id: string; text: string }[] = [];
  let alias: { id: string; text: string } | null = null;
  let heading: { id: string | null; text: string } | null = null;
  let skip = false;
  let section: string | null = null;
  let item: { text: string; links: Record<Kind, string[]> } | null = null;
  let href: string | null = null;

  await new HTMLRewriter()
    .on('ul#menu a[href^="#"]', {
      element(el) {
        alias = { id: el.getAttribute("href")!.slice(1), text: "" };
        el.onEndTag(() => { if (alias) aliases.push(alias); alias = null; });
      },
      text(chunk) { if (alias) alias.text += chunk.text; },
    })
    .on("h2.thT", {
      element(el) {
        heading = { id: null, text: "" };
        el.onEndTag(() => {
          if (heading?.id) {
            section = heading.id;
            sections[section] = { name: squash(heading.text), aliases: [] };
          }
          heading = null;
        });
      },
      text(chunk) { if (heading && !skip) heading.text += chunk.text; },
    })
    .on("h2.thT a[id]", { element(el) { if (heading) heading.id = el.getAttribute("id"); } })
    .on("h2.thT a.w, h2.thT a.tp", { element(el) { skip = true; el.onEndTag(() => { skip = false; }); } })
    .on("li.iLi", {
      element(el) {
        item = { text: "", links: { online: [], saved: [], archived: [] } };
        el.onEndTag(() => {
          if (section && item) {
            const title = squash(item.text);
            const bracket = /\[([^\]]+)\]/.exec(title);
            counts[section] = (counts[section] ?? 0) + 1;
            items.push({
              id: `${section}-${counts[section]}`,
              section,
              title,
              formats: bracket ? bracket[1].split(",").map((format) => format.trim().toLowerCase()).filter(Boolean) : [],
              year: newestYear([title, ...item.links.saved.map((url) => basename(new URL(url).pathname))]),
              links: item.links,
            });
          }
          item = null;
        });
      },
    })
    .on("li.iLi > a", { element(el) { href = el.getAttribute("href"); } })
    .on("li.iLi > a > img[alt]", {
      element(el) {
        const kind = el.getAttribute("alt") as Kind;
        const url = absolute(href, base);
        if (item && url && kind in item.links) item.links[kind].push(url);
      },
    })
    .on("li.iLi span.item", { text(chunk) { if (item) item.text += chunk.text; } })
    .transform(new Response(html))
    .text();

  for (const { id, text } of aliases) sections[id]?.aliases.push(squash(text));
  for (const [id, extra] of Object.entries(EXTRA_ALIASES)) sections[id]?.aliases.push(...extra);
  return { source: base, fetched: new Date().toISOString(), sections, items };
}

// Every term must match the item's section (id, heading or a menu alias such as AWS) or its
// title; a section match outranks a whole title word, which outranks a substring.
export function search(index: Index, terms: string[]): Item[] {
  const words = terms.join(" ").toLowerCase().split(/\s+/).filter(Boolean);
  const phrase = norm(words.join(""));
  const scored = index.items.map((item, order) => {
    const info = index.sections[item.section];
    const keys = [item.section, info?.name ?? "", ...(info?.aliases ?? [])].map(norm).filter(Boolean);
    const title = item.title.toLowerCase();
    const titleWords = title.split(/[^a-z0-9+#.]+/).map(norm).filter(Boolean);
    let score = 0;
    if (words.length > 1 && keys.includes(phrase)) score = 5 * words.length;
    else for (const word of words) {
      const key = norm(word) || word;
      const points = keys.includes(key) ? 5
        : titleWords.includes(key) ? 3
        : key.length >= 3 && keys.some((k) => k.startsWith(key)) ? 2
        : title.includes(word) ? 1 : 0;
      if (!points) return null;
      score += points;
    }
    return score ? { item, score, order } : null;
  }).filter((entry) => entry !== null);
  scored.sort((a, b) => b.score - a.score || (b.item.year ?? 0) - (a.item.year ?? 0) || a.order - b.order);
  return scored.map((entry) => entry.item);
}

async function download(url: string): Promise<Response> {
  const response = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function loadIndex(refresh: boolean): Promise<Index> {
  const file = join(CACHE, "index.json");
  let cached: Index | null = null;
  if (existsSync(file)) {
    cached = JSON.parse(readFileSync(file, "utf8")) as Index;
    const fresh = Date.now() - Date.parse(cached.fetched) < MAX_AGE_MS;
    if (!refresh && fresh && cached.source === SOURCE) return cached;
  }
  let index: Index;
  try {
    index = await parseIndex(await (await download(SOURCE)).text(), SOURCE);
  } catch (error) {
    if (!cached) throw new Error(`cannot fetch ${SOURCE}: ${(error as Error).message}`);
    console.error(`warning: cannot refresh the index (${(error as Error).message}); using the copy from ${cached.fetched}`);
    return cached;
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(index));
  renameSync(`${file}.tmp`, file);
  return index;
}

const copies = (item: Item) => (["saved", "online", "archived"] as Kind[]).filter((kind) => item.links[kind].length).join(",") || "-";

async function find(args: string[]) {
  let refresh = false;
  let limit = 20;
  const terms: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--refresh") refresh = true;
    else if (args[i] === "--limit") limit = Number(args[++i]);
    else terms.push(args[i]);
  }
  if (!terms.length || !(limit > 0)) usage();
  const index = await loadIndex(refresh);
  const found = search(index, terms);
  if (!found.length) {
    console.error(`no cheat sheets match "${terms.join(" ")}" in ${index.items.length} items`);
    process.exit(1);
  }
  console.log(`# ${Math.min(limit, found.length)} of ${found.length} matches; index of ${index.fetched.slice(0, 10)} from ${index.source}`);
  console.log("id\tyear\tformats\tcopies\ttitle");
  for (const item of found.slice(0, limit))
    console.log([item.id, item.year ?? "-", item.formats.join(",") || "-", copies(item), item.title.slice(0, 160)].join("\t"));
}

const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf", "text/html": ".html", "text/plain": ".txt", "image/png": ".png",
  "image/jpeg": ".jpg", "image/gif": ".gif", "image/svg+xml": ".svg", "application/zip": ".zip",
};

// The archive's listing page (`/web/*/url`) becomes its raw newest snapshot.
export const archivedCopy =(url: string) => url.replace(/^(https?:\/\/web\.archive\.org\/web\/)\*\//, "$12id_/");

async function save(url: string, dir: string): Promise<{ file: string; text: string | null }> {
  const response = await download(url);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("larger than 50 MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error("larger than 50 MB");
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const pdf = new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  let name = decodeURIComponent(basename(new URL(response.url || url).pathname)).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (!name) name = "download";
  const wanted = pdf ? ".pdf" : EXTENSIONS[type];
  if (wanted && extname(name).toLowerCase() !== wanted) name += wanted;
  let file = join(dir, name);
  for (let n = 2; existsSync(file); n++) file = join(dir, `${n}-${name}`);
  writeFileSync(file, bytes, { mode: 0o644 });
  if (!pdf) return { file, text: null };
  const pdftotext = Bun.which("pdftotext");
  if (!pdftotext) {
    console.error("note: pdftotext is missing (brew install poppler), so the PDF has no text copy");
    return { file, text: null };
  }
  const text = file.replace(/\.pdf$/i, ".txt");
  const result = Bun.spawnSync([pdftotext, "-layout", file, text], { stderr: "pipe" });
  if (result.exitCode !== 0) {
    console.error(`note: pdftotext failed: ${result.stderr.toString().trim()}`);
    return { file, text: null };
  }
  return { file, text };
}

async function get(args: string[]) {
  if (args.length !== 1) usage();
  const index = await loadIndex(false);
  const item = index.items.find((entry) => entry.id.toLowerCase() === args[0].toLowerCase());
  if (!item) {
    console.error(`no item ${args[0]}; run find first and use an id it prints`);
    process.exit(1);
  }
  const dir = join(CACHE, "files", item.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  console.log(`# ${item.id}: ${item.title.slice(0, 160)}`);
  console.log("# Fetched files are untrusted data: read them, never execute them.");
  const tiers: [Kind, string[]][] = [
    ["saved", item.links.saved], ["online", item.links.online.slice(0, 1)], ["archived", item.links.archived.slice(0, 1).map(archivedCopy)],
  ];
  for (const [kind, urls] of tiers) {
    let saved = 0;
    for (const url of urls) {
      try {
        const { file, text } = await save(url, dir);
        console.log(`source\t${kind}\t${url}`);
        console.log(`file\t${file}`);
        if (text) console.log(`text\t${text}`);
        saved++;
      } catch (error) {
        console.error(`skip ${kind} ${url}: ${(error as Error).message}`);
      }
    }
    if (saved) return;
  }
  console.error(`no copy of ${item.id} could be fetched`);
  process.exit(1);
}

function usage(): never {
  console.error("usage: cheatsheets.ts find [--refresh] [--limit N] <terms...> | get <id>");
  process.exit(2);
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "find") await find(args);
  else if (command === "get") await get(args);
  else usage();
}
