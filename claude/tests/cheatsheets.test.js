// The cheat-sheets skill's script against a small synthetic copy of the cheat-sheets.org
// page. The real page states no license, so no copy of it or of its files is committed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivedCopy, parseIndex, search } from "../skills/cheat-sheets/scripts/cheatsheets.ts";

const SKILL = join(import.meta.dir, "..", "skills", "cheat-sheets");
const SCRIPT = join(SKILL, "scripts", "cheatsheets.ts");

const PAGE = `<!DOCTYPE html><html><body>
<nav id="leftPanel"><h2 id="contentH2" class="thT"><a></a>Content</h2><ul id="menu">
 <li><a href="#Git">Git</a></li>
 <li><a href="#AmazonWebServices">Amazon Web Services</a></li>
 <li><a href="#AmazonWebServices">AWS</a></li>
 <li><a href="#RegularExpressions">Regular Expressions</a></li>
</ul></nav>
<ul><li class="iLi"><a href="saved-copy/outside.pdf"><img alt="saved" src="sc.gif"></a><span class="item">Outside any section [pdf]</span></li></ul>
<section class="csB"><h2 class="thT"><a id="Git"></a>Git <a href="https://en.wikipedia.org/wiki/Git" class="w">W</a><a class="tp" href="#topPanel">^</a></h2>
<ul class="items">
 <li class="iLi">
  <a href="{{base}}online/git-card.pdf"><img alt="online" src="on.gif"></a>
  <a href="saved-copy/git-card.20230105.pdf"><img alt="saved" src="sc.gif"></a>
  <a href="https://web.archive.org/web/*/{{base}}online/git-card.pdf"><img alt="archived" src="ar.png"></a>
  <span class="item">Git Reference Card &amp; Tips [pdf] (example.org)</span>
 </li>
 <li class="iLi">
  <a href="{{base}}online/git-tour.html"><img alt="online" src="on.gif"></a>
  <a href="saved-copy/missing.pdf"><img alt="saved" src="sc.gif"></a>
  <span class="item">git tour 2019 [html, pdf] (example.org)<br>
   See also: <a href="{{base}}online/git-init.html">git init</a></span>
 </li>
 <li class="iLi">
  <a href="bitcoin:abc"><img alt="online" src="on.gif"></a>
  <span class="item">Git without a usable link [html]</span>
 </li>
</ul></section>
<section class="csB"><h2 class="thT"><a id="AmazonWebServices"></a>Amazon Web Services (AWS) <a class="tp" href="#topPanel">^</a></h2>
<ul class="items"><li class="iLi">
 <a href="{{base}}online/aws.html"><img alt="online" src="on.gif"></a>
 <span class="item">AWS CLI Guide [html] (aws.example)</span>
</li></ul></section>
<section class="csB"><h2 class="thT"><a id="RegularExpressions"></a>Regular Expressions <a class="tp" href="#topPanel">^</a></h2>
<ul class="items"><li class="iLi">
 <a href="saved-copy/regex.png"><img alt="saved" src="sc.gif"></a>
 <span class="item">Regex syntax table [png] (example.org)</span>
</li></ul></section>
<section class="csB"><h2 class="thT"><a id="Perl"></a>Perl <a class="tp" href="#topPanel">^</a></h2>
<ul class="items"><li class="iLi">
 <a href="saved-copy/perl.pdf"><img alt="saved" src="sc.gif"></a>
 <span class="item">Perl card with a git appendix [pdf]</span>
</li></ul></section>
</body></html>`;

// A one-page PDF that prints `text`, with a correct cross-reference table.
function pdf(text) {
  const stream = `BT /F1 18 Tf 20 50 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

let server;
let base;
let cache;
let pageHits = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/") {
        pageHits++;
        return new Response(PAGE.replaceAll("{{base}}", base), { headers: { "content-type": "text/html" } });
      }
      if (path === "/saved-copy/git-card.20230105.pdf") return new Response(pdf("Synthetic git card"), { headers: { "content-type": "application/pdf" } });
      if (path === "/online/git-tour.html") return new Response("<p>tour</p>", { headers: { "content-type": "text/html" } });
      return new Response("missing", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}/`;
  cache = mkdtempSync(join(tmpdir(), "cheat-sheets-test-"));
});

afterAll(() => {
  server.stop(true);
  rmSync(cache, { recursive: true, force: true });
});

async function cli(...args) {
  const child = Bun.spawn([process.execPath, SCRIPT, ...args], {
    env: { ...process.env, CHEAT_SHEETS_URL: base, CHEAT_SHEETS_CACHE: cache }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
}

describe("parseIndex", () => {
  let index;
  beforeAll(async () => { index = await parseIndex(PAGE.replaceAll("{{base}}", "https://example.test/"), "https://example.test/"); });

  test("reads sections, their headings without the W and ^ links, and menu and built-in aliases", () => {
    expect(Object.keys(index.sections)).toEqual(["Git", "AmazonWebServices", "RegularExpressions", "Perl"]);
    expect(index.sections.Git).toEqual({ name: "Git", aliases: ["Git"] });
    expect(index.sections.AmazonWebServices.aliases).toEqual(["Amazon Web Services", "AWS"]);
    expect(index.sections.RegularExpressions.aliases).toEqual(["Regular Expressions", "regex", "regexp"]);
  });

  test("numbers items per section and skips items outside a section", () => {
    expect(index.items.map((item) => item.id)).toEqual(["Git-1", "Git-2", "Git-3", "AmazonWebServices-1", "RegularExpressions-1", "Perl-1"]);
  });

  test("keeps title, formats, newest year and absolute http links", () => {
    const [card, tour, unusable] = index.items;
    expect(card).toEqual({
      id: "Git-1", section: "Git", title: "Git Reference Card & Tips [pdf] (example.org)", formats: ["pdf"], year: 2023,
      links: {
        online: ["https://example.test/online/git-card.pdf"],
        saved: ["https://example.test/saved-copy/git-card.20230105.pdf"],
        archived: ["https://web.archive.org/web/*/https://example.test/online/git-card.pdf"],
      },
    });
    expect(tour.title).toBe("git tour 2019 [html, pdf] (example.org) See also: git init");
    expect(tour.formats).toEqual(["html", "pdf"]);
    expect(tour.year).toBe(2019);
    expect(unusable.links).toEqual({ online: [], saved: [], archived: [] });
    expect(unusable.year).toBeNull();
  });

  test("search ranks section and alias matches over title matches and needs every term", () => {
    const ids = (...terms) => search(index, terms).map((item) => item.id);
    expect(ids("git")).toEqual(["Git-1", "Git-2", "Git-3", "Perl-1"]);
    expect(ids("aws")).toEqual(["AmazonWebServices-1"]);
    expect(ids("amazon", "web", "services")).toEqual(["AmazonWebServices-1"]);
    expect(ids("regex")).toEqual(["RegularExpressions-1"]);
    expect(ids("git", "card")).toEqual(["Git-1", "Perl-1"]);
    expect(ids("tour", "git")).toEqual(["Git-2"]);
    expect(ids("git", "nothing")).toEqual([]);
  });

  test("an archive listing link becomes the newest raw snapshot", () => {
    expect(archivedCopy("https://web.archive.org/web/*/https://example.org/a.pdf")).toBe("https://web.archive.org/web/2id_/https://example.org/a.pdf");
  });
});

describe("the command line", () => {
  test("find fetches the index once, caches it and prints ids", async () => {
    const first = await cli("find", "git", "card");
    expect(first.code).toBe(0);
    expect(first.out).toContain("id\tyear\tformats\tcopies\ttitle");
    expect(first.out).toContain("Git-1\t2023\tpdf\tsaved,online,archived\tGit Reference Card & Tips [pdf] (example.org)");
    expect(existsSync(join(cache, "index.json"))).toBe(true);
    const hits = pageHits;
    expect((await cli("find", "aws")).out).toContain("AmazonWebServices-1\t-\thtml\tonline\tAWS CLI Guide");
    expect(pageHits).toBe(hits);
  });

  test("find refetches an index older than 7 days and fails when nothing matches", async () => {
    const file = join(cache, "index.json");
    const index = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...index, fetched: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() }));
    const hits = pageHits;
    const none = await cli("find", "cobol");
    expect(pageHits).toBe(hits + 1);
    expect(none.code).toBe(1);
    expect(none.err).toContain('no cheat sheets match "cobol"');
  });

  test.skipIf(!Bun.which("pdftotext"))("get saves the PDF in its own folder with a text copy", async () => {
    const { out, code } = await cli("get", "git-1");
    expect(code).toBe(0);
    const dir = join(cache, "files", "Git-1");
    const pdfFile = join(dir, "git-card.20230105.pdf");
    const text = join(dir, "git-card.20230105.txt");
    expect(out).toContain(`source\tsaved\t${base}saved-copy/git-card.20230105.pdf`);
    expect(out).toContain(`file\t${pdfFile}`);
    expect(out).toContain(`text\t${text}`);
    expect(readFileSync(text, "utf8")).toContain("Synthetic git card");
  });

  test("get falls back to the online copy when the saved copy is missing", async () => {
    const { out, err, code } = await cli("get", "Git-2");
    expect(code).toBe(0);
    expect(err).toContain(`skip saved ${base}saved-copy/missing.pdf: HTTP 404`);
    expect(out).toContain(`source\tonline\t${base}online/git-tour.html`);
    expect(readdirSync(join(cache, "files", "Git-2"))).toEqual(["git-tour.html"]);
  });

  test("get fails for an unknown id and for an item without a reachable copy", async () => {
    expect((await cli("get", "Git-99")).code).toBe(1);
    const unusable = await cli("get", "Git-3");
    expect(unusable.code).toBe(1);
    expect(unusable.err).toContain("no copy of Git-3 could be fetched");
  });
});

test("the skill's description stays short, since every session loads it", () => {
  const meta = Bun.YAML.parse(/^---\n([\s\S]*?)\n---/.exec(readFileSync(join(SKILL, "SKILL.md"), "utf8"))[1]);
  expect(meta.name).toBe("cheat-sheets");
  expect(meta.description.length).toBeLessThanOrEqual(250);
});
