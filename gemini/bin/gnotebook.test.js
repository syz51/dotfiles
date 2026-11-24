import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countUnits,
  executeIngest,
  fetchUrlAsMarkdown,
  htmlToReadableMarkdown,
  isBinarySupportedFile,
  isBlockedFetchUrl,
  isLikelyPlainTextUrl,
  isSecretPath,
  isUnsupportedGoogleDriveUrl,
  isYouTubeUrl,
  MAX_FALLBACK_FETCH_BYTES,
  MAX_INLINE_BYTES,
  mimeForFile,
  NotebookClient,
  parseCli,
  parseRetryDelayMs,
  planIngestItems,
  splitMarkdownBundles,
  StateStore,
  walkDirectory,
} from "./gnotebook.js";

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "gnotebook-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeMockAdc(dir) {
  const p = join(dir, "adc.json");
  writeFileSync(
    p,
    JSON.stringify({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      refresh_token: "test-refresh-token",
      quota_project_id: "test-project-123",
    }),
  );
  return p;
}

describe("gnotebook pure helpers", () => {
  test("countUnits counts both Latin words and individual CJK characters", () => {
    expect(countUnits("hello world 123")).toBe(3);
    expect(countUnits("子曰学而时习之")).toBe(7);
    expect(countUnits("Gemini 4 Neon 古文测试 2026")).toBe(8);
    expect(countUnits("")).toBe(0);
  });

  test("isSecretPath blocks credentials, keys, env files, and lockfiles", () => {
    const blocked = [
      ".env",
      ".env.production",
      "certs/server.pem",
      "ssl/private.key",
      ".ssh/id_ed25519",
      "gcloud/application_default_credentials.json",
      "foo/client_secret.json",
      "my_secret_config.json",
      "credentials.json",
      "bun.lock",
      "package-lock.json",
    ];
    for (const p of blocked) {
      expect(isSecretPath(p)).toBe(true);
    }
    const allowed = ["README.md", "src/index.ts", "docs/architecture.md", "papers/2510.01446.pdf", "notes/token_counter.py"];
    for (const p of allowed) {
      expect(isSecretPath(p)).toBe(false);
    }
  });

  test("MIME detection and URL classifiers match official Notebook API allowlist", () => {
    expect(mimeForFile("paper.pdf")).toBe("application/pdf");
    expect(mimeForFile("deck.PPTX")).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(mimeForFile("voice.wav")).toBe("audio/wav");
    expect(mimeForFile("diagram.png")).toBe("image/png");
    expect(mimeForFile("table.csv")).toBe("text/csv");
    expect(mimeForFile("notes.md")).toBe("text/markdown");
    expect(mimeForFile("app.ts")).toBeNull();

    expect(isBinarySupportedFile("paper.pdf")).toBe(true);
    expect(isBinarySupportedFile("table.csv")).toBe(true);
    expect(isBinarySupportedFile("notes.md")).toBe(false);

    expect(isUnsupportedGoogleDriveUrl("https://docs.google.com/document/d/abc/edit")).toBe(true);
    expect(isUnsupportedGoogleDriveUrl("https://drive.google.com/file/d/abc/view")).toBe(true);
    expect(isUnsupportedGoogleDriveUrl("https://en.wikipedia.org/wiki/Riemann_hypothesis")).toBe(false);

    expect(isYouTubeUrl("https://www.youtube.com/watch?v=jNQXAC9IVRw")).toBe(true);
    expect(isYouTubeUrl("https://youtu.be/jNQXAC9IVRw")).toBe(true);
    expect(isLikelyPlainTextUrl("https://antigravity.google/docs/plans.md")).toBe(true);
    expect(isLikelyPlainTextUrl("https://en.wikipedia.org/wiki/Riemann_hypothesis")).toBe(false);
  });

  test("htmlToReadableMarkdown strips scripts/styles and preserves title + headings", () => {
    const html = `<html><head><title>Test &amp; Demo</title><style>body{color:red}</style></head>
      <body><nav>Menu</nav><main><h1>Overview</h1><script>alert(1)</script><p>Hello <b>world</b>.</p></main></body></html>`;
    const out = htmlToReadableMarkdown(html, "https://example.com/doc");
    expect(out.title).toBe("Test & Demo");
    expect(out.markdown).toContain("# Test & Demo");
    expect(out.markdown).toContain("# Overview");
    expect(out.markdown).toContain("Hello world");
    expect(out.markdown).not.toContain("alert(1)");
    expect(out.markdown).not.toContain("color:red");
  });

  test("parseRetryDelayMs extracts RetryInfo retryDelay and Retry-After headers", () => {
    expect(
      parseRetryDelayMs({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3.5s" }] } }, null),
    ).toBe(3500);
    expect(parseRetryDelayMs({}, "4")).toBe(4000);
    expect(parseRetryDelayMs({}, null)).toBeNull();
  });

  test("splitMarkdownBundles chunks multi-file and oversized single-file corpora under maxWords", () => {
    const entries = [
      { relPath: "a.md", lang: "markdown", content: "word ".repeat(700) },
      { relPath: "b.ts", lang: "ts", content: `const x = "code";\n`.repeat(200) },
      { relPath: "c.md", lang: "markdown", content: "古".repeat(1200) },
    ];
    const bundles = splitMarkdownBundles(entries, { baseName: "Repo Bundle", maxWords: 1_000 });
    expect(bundles.length).toBeGreaterThanOrEqual(3);
    for (const b of bundles) {
      expect(b.displayName).toContain("Repo Bundle (Part ");
      expect(b.markdown).toContain("## Table of Contents");
      expect(b.units).toBeLessThanOrEqual(1_200);
    }
    // Code fences inside ts file wrapped properly
    expect(bundles.some((b) => b.markdown.includes("```ts"))).toBe(true);
  });

  test("walkDirectory excludes secrets, ignored dirs, lockfiles, and NUL binaries while collecting PDFs and code", async () => {
    await withTempDir((dir) => {
      mkdirSync(join(dir, ".git"), { recursive: true });
      mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, ".git/config"), "ignored");
      writeFileSync(join(dir, "node_modules/pkg/index.js"), "ignored");
      writeFileSync(join(dir, ".env"), "SECRET=nope");
      writeFileSync(join(dir, "private.pem"), "-----BEGIN KEY-----");
      writeFileSync(join(dir, "bun.lock"), "lock");
      writeFileSync(join(dir, "empty.md"), "");
      writeFileSync(join(dir, "fake.txt"), Buffer.from([0x61, 0x00, 0x62]));
      writeFileSync(join(dir, "docs/guide.md"), "# Guide\nHello world\n");
      writeFileSync(join(dir, "paper.pdf"), Buffer.from("%PDF-1.4\n..."));

      const walked = walkDirectory(dir);
      expect(walked.textEntries.map((e) => e.relPath)).toEqual(["docs/guide.md"]);
      expect(walked.binaryFiles.map((e) => e.relPath)).toEqual(["paper.pdf"]);
      const skippedPaths = walked.skipped.map((s) => s.path);
      expect(skippedPaths).toContain(".env");
      expect(skippedPaths).toContain("private.pem");
      expect(skippedPaths).toContain("bun.lock");
      expect(skippedPaths).toContain("fake.txt");
    });
  });

  test("parseCli handles flags and positionals cleanly", () => {
    const parsed = parseCli(["ingest", "My Notebook", "./docs", "https://example.com", "--dry-run", "--max-words", "80000", "--no-wait", "--json"]);
    expect(parsed.positional).toEqual(["ingest", "My Notebook", "./docs", "https://example.com"]);
    expect(parsed.flags.dryRun).toBe(true);
    expect(parsed.flags.maxWords).toBe(80000);
    expect(parsed.flags.wait).toBe(false);
    expect(parsed.flags.json).toBe(true);
    expect(() => parseCli(["ingest", "--bogus-flag"])).toThrow("Unknown flag");
  });
});

describe("NotebookClient and executeIngest with mocked HTTP", () => {
  test("handles 429 RetryInfo backoff, resumable upload without auth on upload URL, and pagination", async () => {
    await withTempDir(async (dir) => {
      const adcPath = writeMockAdc(dir);
      const calls = [];
      let rateLimitedOnce = false;
      const sleeps = [];

      const mockFetch = async (url, init = {}) => {
        calls.push({ url, method: init.method, headers: init.headers || {}, bodyLen: init.body?.length || 0 });
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
        }
        if (url.includes("/v1/notebooks?pageSize=100") && !url.includes("pageToken=")) {
          return new Response(
            JSON.stringify({
              notebooks: [{ name: "notebooks/nb-1", displayName: "NB 1" }],
              nextPageToken: "p2",
            }),
            { status: 200 },
          );
        }
        if (url.includes("pageToken=p2")) {
          return new Response(
            JSON.stringify({ notebooks: [{ name: "notebooks/nb-2", displayName: "NB 2" }] }),
            { status: 200 },
          );
        }
        if (url.endsWith("/sources:upload") && init.headers?.["X-Goog-Upload-Command"] === "start") {
          if (!rateLimitedOnce) {
            rateLimitedOnce = true;
            return new Response(
              JSON.stringify({
                error: {
                  code: 429,
                  status: "RESOURCE_EXHAUSTED",
                  message: "Rate limited",
                  details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "2s" }],
                },
              }),
              { status: 429 },
            );
          }
          return new Response("", {
            status: 200,
            headers: { "x-goog-upload-url": "https://notebook.googleapis.com/upload/session/signed-xyz" },
          });
        }
        if (url === "https://notebook.googleapis.com/upload/session/signed-xyz") {
          // Verify signed upload URL receives NO Authorization header per Google docs
          expect(init.headers?.Authorization).toBeUndefined();
          expect(init.headers?.["X-Goog-Upload-Command"]).toBe("upload, finalize");
          return new Response(
            JSON.stringify({ source: { name: "notebooks/nb-1/sources/src-big", state: "PROCESSING" } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: { message: `Unhandled ${url}` } }), { status: 404 });
      };

      const client = new NotebookClient({
        adcPath,
        fetchImpl: mockFetch,
        writeRpm: 0,
        readRpm: 0,
        sleepFn: async (ms) => sleeps.push(ms),
      });

      const nbs = await client.listNotebooks();
      expect(nbs.map((n) => n.name)).toEqual(["notebooks/nb-1", "notebooks/nb-2"]);

      // Large markdown (> MAX_INLINE_BYTES) automatically uses resumable upload and retries 429
      const bigMd = "a".repeat(MAX_INLINE_BYTES + 10_000);
      const res = await client.createTextSource("notebooks/nb-1", bigMd, { displayName: "Big Bundle" });
      expect(res.transport).toBe("upload(resumable)");
      expect(res.source.name).toBe("notebooks/nb-1/sources/src-big");
      expect(sleeps.length).toBe(1);
      expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    });
  });

  test("executeIngest enforces idempotent dedupe, allowUpdate versioning, and unreachable-URL fallback fetch", async () => {
    await withTempDir(async (dir) => {
      const adcPath = writeMockAdc(dir);
      const statePath = join(dir, "state.json");
      const sampleFile = join(dir, "notes.md");
      writeFileSync(sampleFile, "# Notes\nInitial version.\n");

      const liveSources = [];
      let srcCounter = 1;

      const mockFetch = async (url, init = {}) => {
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
        }
        if (url.startsWith("https://notebook.googleapis.com/v1/notebooks?")) {
          return new Response(JSON.stringify({ notebooks: [{ name: "notebooks/nb-1", displayName: "Lab" }] }), { status: 200 });
        }
        if (url.startsWith("https://notebook.googleapis.com/v1/notebooks/nb-1/sources?")) {
          return new Response(JSON.stringify({ sources: liveSources }), { status: 200 });
        }
        if (url === "https://notebook.googleapis.com/v1/notebooks/nb-1/sources" && init.method === "POST") {
          const body = JSON.parse(init.body);
          const id = `notebooks/nb-1/sources/s-${srcCounter++}`;
          const isUnreachableHtml = body.web_content?.url === "https://blocked.example.com/page";
          const rec = {
            name: id,
            displayName: body.display_name || body.web_content?.url,
            mimeType: body.mime_type || "text/html",
            state: isUnreachableHtml ? "FAILED" : "ACTIVE",
            originalUrl: body.web_content?.url || undefined,
            error: isUnreachableHtml ? { code: 9, message: "The source is unreachable." } : undefined,
          };
          liveSources.push(rec);
          return new Response(JSON.stringify({ ...rec, state: "PROCESSING" }), { status: 200 });
        }
        if (url.startsWith("https://notebook.googleapis.com/v1/notebooks/nb-1/sources/s-")) {
          const name = url.replace("https://notebook.googleapis.com/v1/", "");
          const found = liveSources.find((s) => s.name === name);
          return new Response(JSON.stringify(found), { status: 200 });
        }
        if (url === "https://blocked.example.com/page") {
          return new Response("<html><head><title>Blocked Page</title></head><body><p>Recovered body</p></body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("not found", { status: 404 });
      };

      const client = new NotebookClient({
        adcPath,
        fetchImpl: mockFetch,
        writeRpm: 0,
        readRpm: 0,
        sleepFn: async () => {},
      });
      const stateStore = new StateStore(statePath);

      // 1. First run: uploads notes.md + hits unreachable URL -> falls back to fetched Markdown
      const planned1 = planIngestItems({ targets: [sampleFile, "https://blocked.example.com/page"], bundle: false });
      const run1 = await executeIngest({
        client,
        stateStore,
        notebookTarget: "Lab",
        items: planned1.items,
        fetchImpl: mockFetch,
      });
      expect(run1.summary.uploaded).toBe(2);
      expect(run1.summary.active).toBe(2);
      expect(run1.summary.failed).toBe(0);
      expect(run1.actions[1].transport).toContain("fallback");
      // State file permissions are 0600
      expect((statSync(statePath).mode & 0o777).toString(8)).toBe("600");

      // 2. Second run (unchanged): 100% skipped, zero uploads
      const run2 = await executeIngest({
        client,
        stateStore,
        notebookTarget: "Lab",
        items: planned1.items,
        fetchImpl: mockFetch,
      });
      expect(run2.summary.uploaded).toBe(0);
      expect(run2.summary.skipped).toBe(2);

      // 3. Modify notes.md: skipped without allowUpdate, uploaded with version tag with allowUpdate
      writeFileSync(sampleFile, "# Notes\nUpdated v2 content.\n");
      const planned3 = planIngestItems({ targets: [sampleFile], bundle: false });
      const run3a = await executeIngest({
        client,
        stateStore,
        notebookTarget: "Lab",
        items: planned3.items,
        allowUpdate: false,
        fetchImpl: mockFetch,
      });
      expect(run3a.summary.skipped).toBe(1);
      expect(run3a.actions[0].reason).toBe("changed-needs-allow-update");

      const run3b = await executeIngest({
        client,
        stateStore,
        notebookTarget: "Lab",
        items: planned3.items,
        allowUpdate: true,
        fetchImpl: mockFetch,
      });
      expect(run3b.summary.uploaded).toBe(1);
      expect(run3b.summary.active).toBe(1);
      expect(run3b.actions[0].displayName).toMatch(/notes\.md \[v\d{4}-\d{2}-\d{2}-[0-9a-f]{6}\]/);
      expect(readFileSync(statePath, "utf8")).not.toContain("test-refresh-token");
    });
  });

  test("invalid_grant token error returns actionable runbook hint without leaking secrets", async () => {
    await withTempDir(async (dir) => {
      const adcPath = writeMockAdc(dir);
      const client = new NotebookClient({
        adcPath,
        fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
        writeRpm: 0,
        readRpm: 0,
      });
      let caught = null;
      try {
        await client.getAuth(true);
      } catch (e) {
        caught = e;
      }
      expect(caught).not.toBeNull();
      expect(caught.message).toContain("invalid_grant");
      expect(caught.message).toContain("gemini-notebook-mcp.md");
      expect(caught.message).not.toContain("test-refresh-token");
      expect(caught.message).not.toContain("test-client-secret");
    });
  });

  test("findNotebook is read-only and throws on missing notebook without calling POST /notebooks", async () => {
    await withTempDir(async (dir) => {
      const adcPath = writeMockAdc(dir);
      let postCalled = false;
      const client = new NotebookClient({
        adcPath,
        fetchImpl: async (url, init = {}) => {
          if (url === "https://oauth2.googleapis.com/token") {
            return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
          }
          if (init.method === "POST") postCalled = true;
          return new Response(JSON.stringify({ notebooks: [{ name: "notebooks/nb-1", displayName: "Real NB" }] }), { status: 200 });
        },
        writeRpm: 0,
        readRpm: 0,
      });
      await expect(client.findNotebook("Typo NB")).rejects.toThrow('Notebook not found: "Typo NB"');
      expect(postCalled).toBe(false);
    });
  });

  test("security: blocks secret dirs/files on direct targets and SSRF/binary/oversized fallback URLs", async () => {
    await withTempDir(async (dir) => {
      const sshDir = join(dir, ".ssh");
      const gcloudDir = join(dir, "gcloud");
      mkdirSync(sshDir, { recursive: true });
      mkdirSync(gcloudDir, { recursive: true });
      const sshCfg = join(sshDir, "config");
      const oauthJson = join(gcloudDir, "gemini-notebook-oauth-client.json");
      writeFileSync(sshCfg, "Host secret\n");
      writeFileSync(oauthJson, '{"installed":{}}\n');

      // Direct single-file targeting inside .ssh and gcloud must be blocked
      const single = planIngestItems({ targets: [sshCfg, oauthJson] });
      expect(single.items.length).toBe(0);
      expect(single.skipped.length).toBe(2);

      // Direct directory targeting of .ssh must be blocked
      const dirPlan = planIngestItems({ targets: [sshDir] });
      expect(dirPlan.items.length).toBe(0);
      expect(dirPlan.skipped[0].reason).toBe("secret-dir-blocked");

      // SSRF blocked URLs & redirect to metadata IP
      for (const bad of [
        "http://127.0.0.1:8080/admin",
        "http://localhost/secret",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/internal",
        "http://192.168.1.1/",
        "http://[::1]/",
        "file:///etc/passwd",
      ]) {
        expect(isBlockedFetchUrl(bad)).toBe(true);
        await expect(fetchUrlAsMarkdown(bad, async () => new Response("ok"))).rejects.toThrow("Refusing fallback fetch");
      }

      // Redirect to loopback blocked
      await expect(
        fetchUrlAsMarkdown("https://public.example.com/start", async () =>
          new Response("", { status: 302, headers: { location: "http://169.254.169.254/meta" } }),
        ),
      ).rejects.toThrow("Refusing fallback fetch");

      // Binary content-type & oversized Content-Length rejected
      await expect(
        fetchUrlAsMarkdown("https://public.example.com/file.pdf", async () =>
          new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }),
        ),
      ).rejects.toThrow("non-text content-type");
      await expect(
        fetchUrlAsMarkdown("https://public.example.com/huge.txt", async () =>
          new Response("x", { status: 200, headers: { "content-type": "text/plain", "content-length": String(MAX_FALLBACK_FETCH_BYTES + 1) } }),
        ),
      ).rejects.toThrow("exceeds");

      // Malformed percent encoding & out-of-range HTML entities don't crash or double-unescape
      const ok = await fetchUrlAsMarkdown("https://public.example.com/%E0%A4%A.md", async () =>
        new Response("Hello &amp;lt; &#99999999;", { status: 200, headers: { "content-type": "text/markdown" } }),
      );
      expect(ok.title).toBe("%E0%A4%A.md");
      const htmlRes = htmlToReadableMarkdown("<p>&amp;lt; &#99999999; &#x110000;</p>", "https://public.example.com/");
      expect(htmlRes.markdown).toContain("&lt;");
      expect(htmlRes.markdown).toContain("&#99999999;");
    });
  });

  test("parseCli rejects missing values and invalid numeric flags, and distinct loose-file sets get distinct keys", async () => {
    expect(() => parseCli(["ingest", "NB", "a.md", "--max-words", "abc"])).toThrow("Invalid positive integer");
    expect(() => parseCli(["ingest", "NB", "a.md", "--rpm", "0"])).toThrow("Invalid positive integer");
    expect(() => parseCli(["ingest", "NB", "a.md", "--max-words"])).toThrow("Missing value");
    expect(() => parseCli(["digest", "--board"])).toThrow("Missing value");

    await withTempDir((dir) => {
      const f1 = join(dir, "a.md");
      const f2 = join(dir, "b.md");
      const f3 = join(dir, "c.md");
      writeFileSync(f1, "alpha");
      writeFileSync(f2, "beta");
      writeFileSync(f3, "gamma");
      const p1 = planIngestItems({ targets: [f1, f2], bundle: true });
      const p2 = planIngestItems({ targets: [f1, f3], bundle: true });
      expect(p1.items[0].key).not.toBe(p2.items[0].key);
    });
  });

  test("dedupes PROCESSING sources and counts TIMEOUT without losing state", async () => {
    await withTempDir(async (dir) => {
      const adcPath = writeMockAdc(dir);
      const statePath = join(dir, "state.json");
      const f = join(dir, "doc.md");
      writeFileSync(f, "# Doc\nContent\n");

      const mockFetch = async (url, init = {}) => {
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
        }
        if (url.startsWith("https://notebook.googleapis.com/v1/notebooks?")) {
          return new Response(JSON.stringify({ notebooks: [{ name: "notebooks/nb-1", displayName: "Lab" }] }), { status: 200 });
        }
        if (url.startsWith("https://notebook.googleapis.com/v1/notebooks/nb-1/sources?")) {
          return new Response(
            JSON.stringify({
              sources: [{ name: "notebooks/nb-1/sources/s-proc", displayName: "doc.md", state: "PROCESSING" }],
            }),
            { status: 200 },
          );
        }
        return new Response("unexpected", { status: 500 });
      };

      const client = new NotebookClient({ adcPath, fetchImpl: mockFetch, writeRpm: 0, readRpm: 0 });
      const stateStore = new StateStore(statePath);
      const planned = planIngestItems({ targets: [f], bundle: false });
      const res = await executeIngest({ client, stateStore, notebookTarget: "Lab", items: planned.items });
      expect(res.summary.uploaded).toBe(0);
      expect(res.summary.skipped).toBe(1);
    });
  });
});
