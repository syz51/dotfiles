#!/usr/bin/env bun
/**
 * gnotebook-monitor: Unauthenticated Gemini Notebook API release monitor.
 *
 * Watches Google's public Discovery document, alternative API version endpoints,
 * official MCP tool documentation, and roadmap page — requiring zero OAuth tokens
 * so it never expires on 7-day Testing-mode refresh tokens.
 *
 * When a structural API/MCP/version/roadmap change appears, files a deduplicated
 * integration task on the `dotfiles` work board and sends a macOS notification.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LABEL = "com.syz51.gnotebook-monitor";
export const DEFAULT_CALENDAR_SCHEDULE = Object.freeze({ weekday: 1, hour: 10, minute: 0 }); // Monday 10:00 local time
export const FETCH_TIMEOUT_MS = 20_000;
export const FETCH_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000, 10_000, 20_000, 30_000]);
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB safety cap
export const BOARD_SLUG = "dotfiles";
export const BOARD_AGENT = "claude:gnotebook-monitor";
export const DISCOVERY_BASE = "https://notebook.googleapis.com/$discovery/rest";
export const PROBE_VERSIONS = ["v1alpha", "v1beta", "v1beta1", "v2"];
export const MCP_DOC_URL = "https://developers.google.com/notebook/docs/mcp";
export const ROADMAP_DOC_URL = "https://developers.google.com/notebook/docs/roadmap";
export const FETCH_FAILURE_GRACE_MS = 24 * 60 * 60 * 1000;

export function defaultStateDir(home = homedir()) {
  return join(home, ".local", "state", "gnotebook-monitor");
}

export function launchAgentPlistPath(home = homedir()) {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function defaultSearchPath(home = homedir()) {
  return [
    join(home, ".cargo", "bin"),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
}

export function decodeHtmlEntities(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = Number.parseInt(dec, 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function stripHtmlTags(html) {
  return decodeHtmlEntities(
    String(html ?? "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sortedObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = obj[key];
  }
  return out;
}

/**
 * Extract the structural API surface from a Google REST Discovery document.
 * Ignores prose descriptions and timestamps so doc-only edits never alert.
 */
export function parseDiscoverySnapshot(doc) {
  if (!doc || typeof doc !== "object") {
    throw new Error("Discovery document is not a JSON object");
  }
  const methods = {};
  const walkResources = (resources, prefix = "") => {
    if (!resources || typeof resources !== "object") return;
    for (const [resName, resDef] of Object.entries(resources)) {
      const fullRes = prefix ? `${prefix}.${resName}` : resName;
      if (resDef?.methods && typeof resDef.methods === "object") {
        for (const [methodName, methodDef] of Object.entries(resDef.methods)) {
          const fullMethod = `${fullRes}.${methodName}`;
          methods[fullMethod] = {
            httpMethod: String(methodDef?.httpMethod || ""),
            path: String(methodDef?.flatPath || methodDef?.path || ""),
            supportsMediaUpload: Boolean(methodDef?.supportsMediaUpload),
          };
        }
      }
      if (resDef?.resources) {
        walkResources(resDef.resources, fullRes);
      }
    }
  };
  walkResources(doc.resources);

  const schemas = {};
  if (doc.schemas && typeof doc.schemas === "object") {
    for (const [schemaName, schemaDef] of Object.entries(doc.schemas)) {
      const props =
        schemaDef?.properties && typeof schemaDef.properties === "object"
          ? Object.keys(schemaDef.properties).sort()
          : [];
      schemas[schemaName] = props;
    }
  }

  const scopes =
    doc.auth?.oauth2?.scopes && typeof doc.auth.oauth2.scopes === "object"
      ? Object.keys(doc.auth.oauth2.scopes).sort()
      : [];

  return {
    name: String(doc.name || "notebook"),
    version: String(doc.version || "v1"),
    revision: String(doc.revision || ""),
    methods: sortedObject(methods),
    schemas: sortedObject(schemas),
    scopes,
  };
}

/**
 * Extract tool names from the "Available MCP tools" table on developers.google.com/notebook/docs/mcp.
 * Returns null if the expected table is not found (layout change) so callers preserve the baseline.
 */
export function parseMcpToolsHtml(html) {
  const source = String(html ?? "");
  const headingMatch = source.match(/Available MCP tools<\/h[1-6]>/i);
  if (!headingMatch || headingMatch.index === undefined) return null;
  const afterHeading = source.slice(headingMatch.index);
  const tableMatch = afterHeading.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return null;
  const tbodyMatch = tableMatch[0].match(/<tbody[\s\S]*?<\/tbody>/i);
  const rowsHtml = tbodyMatch ? tbodyMatch[0] : tableMatch[0];
  const tools = new Set();
  for (const rowMatch of rowsHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const firstCell = rowMatch[1].match(/<td\b[^>]*>([\s\S]*?)<\/td>/i);
    if (!firstCell) continue;
    const codeMatch = firstCell[1].match(/<code\b[^>]*>([\s\S]*?)<\/code>/i);
    const raw = stripHtmlTags(codeMatch ? codeMatch[1] : firstCell[1]);
    if (/^[a-z][a-z0-9_]*$/.test(raw)) {
      tools.add(raw);
    }
  }
  return tools.size > 0 ? [...tools].sort() : null;
}

/**
 * Extract bullet items from the roadmap page article body.
 * Requires the devsite-article-body container so navigation/sidebar lists are never parsed.
 * Slices through </article> or <devsite-content-footer to survive nested <div>s inside the body.
 */
export function parseRoadmapHtml(html) {
  const source = String(html ?? "");
  const startMatch = source.match(/<div\b[^>]*class="[^"]*devsite-article-body[^"]*"[^>]*>/i);
  if (!startMatch || startMatch.index === undefined) return null;
  const afterStart = source.slice(startMatch.index + startMatch[0].length);
  const endMatch = afterStart.match(/<\/article>|<devsite-content-footer\b/i);
  const scope = endMatch && endMatch.index !== undefined ? afterStart.slice(0, endMatch.index) : afterStart;
  const ulMatch = scope.match(/<ul\b[^>]*>([\s\S]*?)<\/ul>/i);
  if (!ulMatch) return null;
  const items = [];
  for (const liMatch of ulMatch[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const text = stripHtmlTags(liMatch[1]);
    if (text) items.push(text);
  }
  return items.length > 0 ? items : null;
}

function setDiff(prevList, nextList) {
  const prevSet = new Set(prevList || []);
  const nextSet = new Set(nextList || []);
  const added = [...nextSet].filter((x) => !prevSet.has(x)).sort();
  const removed = [...prevSet].filter((x) => !nextSet.has(x)).sort();
  return { added, removed };
}

/**
 * Compare two saved snapshots and compute a structural diff.
 * Revision-only bumps with identical methods/schemas/scopes/versions/mcpTools/roadmap do NOT trigger.
 */
export function diffSnapshots(prev, next) {
  const prevMethods = prev?.discovery?.methods || {};
  const nextMethods = next?.discovery?.methods || {};
  const methodKeys = setDiff(Object.keys(prevMethods), Object.keys(nextMethods));
  const changedMethods = [];
  for (const key of Object.keys(nextMethods).sort()) {
    if (!prevMethods[key]) continue;
    const a = prevMethods[key];
    const b = nextMethods[key];
    if (
      a.httpMethod !== b.httpMethod ||
      a.path !== b.path ||
      Boolean(a.supportsMediaUpload) !== Boolean(b.supportsMediaUpload)
    ) {
      changedMethods.push({
        method: key,
        before: `${a.httpMethod} ${a.path}${a.supportsMediaUpload ? " [media]" : ""}`,
        after: `${b.httpMethod} ${b.path}${b.supportsMediaUpload ? " [media]" : ""}`,
      });
    }
  }

  const prevSchemas = prev?.discovery?.schemas || {};
  const nextSchemas = next?.discovery?.schemas || {};
  const schemaKeys = setDiff(Object.keys(prevSchemas), Object.keys(nextSchemas));
  const addedSchemaFields = [];
  const removedSchemaFields = [];
  for (const schemaName of Object.keys(nextSchemas).sort()) {
    if (!prevSchemas[schemaName]) continue;
    const fieldDiff = setDiff(prevSchemas[schemaName], nextSchemas[schemaName]);
    for (const f of fieldDiff.added) addedSchemaFields.push(`${schemaName}.${f}`);
    for (const f of fieldDiff.removed) removedSchemaFields.push(`${schemaName}.${f}`);
  }

  const scopesDiff = setDiff(prev?.discovery?.scopes, next?.discovery?.scopes);
  const versionsDiff = setDiff(prev?.probeVersions, next?.probeVersions);

  // Only diff docs-derived lists when both baseline and current parsed cleanly.
  const mcpDiff =
    Array.isArray(prev?.mcpTools) && Array.isArray(next?.mcpTools)
      ? setDiff(prev.mcpTools, next.mcpTools)
      : { added: [], removed: [] };

  const roadmapDiff =
    Array.isArray(prev?.roadmapItems) && Array.isArray(next?.roadmapItems)
      ? setDiff(prev.roadmapItems, next.roadmapItems)
      : { added: [], removed: [] };

  const structural = {
    addedMethods: methodKeys.added.map((m) => ({
      method: m,
      spec: `${nextMethods[m].httpMethod} ${nextMethods[m].path}${nextMethods[m].supportsMediaUpload ? " [media]" : ""}`,
    })),
    removedMethods: methodKeys.removed,
    changedMethods,
    addedSchemas: schemaKeys.added,
    removedSchemas: schemaKeys.removed,
    addedSchemaFields: addedSchemaFields.sort(),
    removedSchemaFields: removedSchemaFields.sort(),
    addedScopes: scopesDiff.added,
    removedScopes: scopesDiff.removed,
    addedVersions: versionsDiff.added,
    removedVersions: versionsDiff.removed,
    addedMcpTools: mcpDiff.added,
    removedMcpTools: mcpDiff.removed,
    addedRoadmapItems: roadmapDiff.added,
    removedRoadmapItems: roadmapDiff.removed,
  };

  const hasChanges = Object.values(structural).some((arr) => arr.length > 0);
  const changeKey = createHash("sha256").update(JSON.stringify(structural)).digest("hex").slice(0, 16);

  return {
    hasChanges,
    changeKey,
    revisionBefore: prev?.discovery?.revision || "",
    revisionAfter: next?.discovery?.revision || "",
    ...structural,
  };
}

export function formatReleaseTask(diff, prev, next) {
  const revTag = diff.revisionAfter || new Date().toISOString().slice(0, 10);
  const headlineParts = [];
  if (diff.addedMethods.length) headlineParts.push(`+${diff.addedMethods.length} method(s)`);
  if (diff.addedVersions.length) headlineParts.push(`+${diff.addedVersions.join("/")}`);
  if (diff.removedVersions.length) headlineParts.push(`-${diff.removedVersions.join("/")}`);
  if (diff.addedMcpTools.length) headlineParts.push(`+${diff.addedMcpTools.length} MCP tool(s)`);
  if (diff.addedSchemaFields.length || diff.addedSchemas.length) headlineParts.push("schema updates");
  if (diff.removedRoadmapItems.length || diff.addedRoadmapItems.length) headlineParts.push("roadmap update");
  const summarySuffix = headlineParts.length ? headlineParts.slice(0, 2).join(", ") : revTag;
  const rawTitle = `Integrate Gemini Notebook API release (${summarySuffix})`;
  const title = rawTitle.length <= 80 ? rawTitle : rawTitle.slice(0, 77) + "...";

  const lines = [
    `Detected a structural change in Google's official Gemini Notebook API (change key: \`gnotebook-api:${diff.changeKey}\`).`,
    "",
    `- Discovery revision: \`${diff.revisionBefore || "unknown"}\` -> \`${diff.revisionAfter || "unknown"}\``,
    `- Discovery URL: \`${DISCOVERY_BASE}?version=v1\``,
    `- Docs: \`${MCP_DOC_URL}\` · \`${ROADMAP_DOC_URL}\``,
  ];

  const addSection = (heading, items) => {
    if (!items || items.length === 0) return;
    lines.push("", `### ${heading}`);
    for (const item of items) {
      lines.push(`- ${item}`);
    }
  };

  addSection(
    "Added REST methods",
    diff.addedMethods.map((m) => `\`${m.method}\` (${m.spec})`),
  );
  addSection(
    "Removed REST methods",
    diff.removedMethods.map((m) => `\`${m}\``),
  );
  addSection(
    "Changed REST methods",
    diff.changedMethods.map((m) => `\`${m.method}\`: ${m.before} -> ${m.after}`),
  );
  addSection(
    "New API versions live",
    diff.addedVersions.map((v) => `\`${v}\` (\`${DISCOVERY_BASE}?version=${v}\`)`),
  );
  addSection(
    "Removed API versions",
    diff.removedVersions.map((v) => `\`${v}\``),
  );
  addSection(
    "Added schemas / fields",
    [
      ...diff.addedSchemas.map((s) => `Schema \`${s}\``),
      ...diff.addedSchemaFields.map((f) => `Field \`${f}\``),
    ],
  );
  addSection(
    "Removed schemas / fields",
    [
      ...diff.removedSchemas.map((s) => `Schema \`${s}\``),
      ...diff.removedSchemaFields.map((f) => `Field \`${f}\``),
    ],
  );
  addSection(
    "OAuth scope changes",
    [
      ...diff.addedScopes.map((s) => `Added \`${s}\``),
      ...diff.removedScopes.map((s) => `Removed \`${s}\``),
    ],
  );
  addSection(
    "MCP tool changes",
    [
      ...diff.addedMcpTools.map((t) => `Added \`${t}\``),
      ...diff.removedMcpTools.map((t) => `Removed \`${t}\``),
    ],
  );
  addSection(
    "Roadmap changes",
    [
      ...diff.removedRoadmapItems.map((r) => `Shipped / removed: ${r}`),
      ...diff.addedRoadmapItems.map((r) => `Added: ${r}`),
    ],
  );

  lines.push(
    "",
    "### Integration targets",
    "- Inspect the updated Discovery JSON and official docs to evaluate new endpoints (delete, Drive URLs, Q&A retrieval, artifacts, etc.).",
    "- Extend `gemini/bin/gnotebook.js`, `gemini/bin/gnotebook.test.js`, and `gemini/docs/gemini-notebook-mcp.md` where useful.",
    `- Baseline snapshot had ${Object.keys(prev?.discovery?.methods || {}).length} methods; current has ${Object.keys(next?.discovery?.methods || {}).length}.`,
  );

  const body = lines.join("\n").slice(0, 3950);
  const acceptance = [
    "Reviewed the new Gemini Notebook API / MCP / roadmap release details",
    "Integrated relevant capabilities into gemini/bin/gnotebook.js (or documented why skipped) with passing bun test gemini",
  ].join("\n");

  return { title, body, acceptance };
}

function responseTooLargeError(message) {
  const err = new Error(message);
  err.code = "ERR_RESPONSE_TOO_LARGE";
  return err;
}

export async function readBoundedText(resp, maxBytes = MAX_RESPONSE_BYTES) {
  const lenHeader = resp.headers?.get?.("content-length");
  if (lenHeader && Number.parseInt(lenHeader, 10) > maxBytes) {
    throw responseTooLargeError(`Response exceeds ${maxBytes} bytes (${lenHeader})`);
  }
  if (!resp.body || typeof resp.body.getReader !== "function") {
    const text = await resp.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw responseTooLargeError(`Response exceeds ${maxBytes} bytes`);
    }
    return text;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        throw responseTooLargeError(`Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function isRetryableFetchError(err) {
  if (!err || typeof err !== "object") return false;
  if (err instanceof SyntaxError || err instanceof RangeError) return false;
  if (err.code === "ERR_INVALID_URL" || err.code === "ERR_RESPONSE_TOO_LARGE") return false;
  return true;
}

function markTransientError(err) {
  if (err && typeof err === "object") {
    try {
      err.transient = true;
      return err;
    } catch {}
  }
  const wrapped = new Error(err?.message || String(err), { cause: err });
  wrapped.transient = true;
  return wrapped;
}

export async function fetchTextWithRetry(
  fetchImpl,
  url,
  {
    headers,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxBytes = MAX_RESPONSE_BYTES,
    retryDelaysMs = FETCH_RETRY_DELAYS_MS,
    sleep = defaultSleep,
  } = {},
) {
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : [];
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (isRetryableHttpStatus(resp.status) && attempt < delays.length) {
        try {
          await resp.body?.cancel?.();
        } catch {}
      } else if (!resp.ok) {
        try {
          await resp.body?.cancel?.();
        } catch {}
        return { ok: false, status: resp.status, text: null };
      } else {
        const text = await readBoundedText(resp, maxBytes);
        return { ok: true, status: resp.status, text };
      }
    } catch (err) {
      if (!isRetryableFetchError(err)) {
        throw err;
      }
      if (attempt >= delays.length) {
        throw markTransientError(err);
      }
    }
    await sleep(delays[attempt]);
  }
}

export async function fetchCurrentSnapshot(
  fetchImpl = fetch,
  { retryDelaysMs = FETCH_RETRY_DELAYS_MS, sleep = defaultSleep } = {},
) {
  const headers = {
    "User-Agent": "gnotebook-monitor/1.0 (+https://developers.google.com/notebook/docs/mcp)",
  };
  const warnings = [];
  const secondaryRetryDelays = Array.isArray(retryDelaysMs) ? retryDelaysMs.slice(0, 2) : [];

  // 1. Discovery v1 (authoritative, required) — retry transient DNS/network/stream/5xx errors
  const discResp = await fetchTextWithRetry(fetchImpl, `${DISCOVERY_BASE}?version=v1`, {
    headers,
    retryDelaysMs,
    sleep,
  });
  if (!discResp.ok) {
    const err = new Error(`Discovery v1 fetch failed with HTTP ${discResp.status}`);
    if (isRetryableHttpStatus(discResp.status)) err.transient = true;
    throw err;
  }
  const discovery = parseDiscoverySnapshot(JSON.parse(discResp.text));

  // 2. Probe alternative versions concurrently (distinguish confirmed 404 vs transient errors)
  const probeEntries = await Promise.all(
    PROBE_VERSIONS.map(async (ver) => {
      try {
        const res = await fetchTextWithRetry(fetchImpl, `${DISCOVERY_BASE}?version=${encodeURIComponent(ver)}`, {
          headers,
          maxBytes: 512 * 1024,
          retryDelaysMs: secondaryRetryDelays,
          sleep,
        });
        if (res.status === 200) {
          // Verify valid JSON discovery doc to avoid false positives on soft-200 error pages
          const parsed = JSON.parse(res.text);
          if (parsed && parsed.name === "notebook") {
            return { version: ver, status: "live" };
          }
          warnings.push(`probe ${ver}: HTTP 200 but not a notebook discovery document`);
          return { version: ver, status: "error" };
        }
        if (res.status === 404) {
          return { version: ver, status: "absent" };
        }
        warnings.push(`probe ${ver}: HTTP ${res.status}`);
        return { version: ver, status: "error" };
      } catch (err) {
        warnings.push(`probe ${ver}: ${err.message}`);
        return { version: ver, status: "error" };
      }
    }),
  );
  const probeVersions = probeEntries.filter((e) => e.status === "live").map((e) => e.version).sort();
  const erroredProbeVersions = probeEntries.filter((e) => e.status === "error").map((e) => e.version);

  // 3. Official MCP tools doc (best-effort; preserves null on error/layout shift)
  let mcpTools = null;
  try {
    const mcpResp = await fetchTextWithRetry(fetchImpl, MCP_DOC_URL, {
      headers,
      retryDelaysMs: secondaryRetryDelays,
      sleep,
    });
    if (mcpResp.ok) {
      mcpTools = parseMcpToolsHtml(mcpResp.text);
      if (!mcpTools) warnings.push("mcp doc: table not found");
    } else {
      warnings.push(`mcp doc: HTTP ${mcpResp.status}`);
    }
  } catch (err) {
    warnings.push(`mcp doc: ${err.message}`);
  }

  // 4. Official Roadmap doc (best-effort)
  let roadmapItems = null;
  try {
    const rmResp = await fetchTextWithRetry(fetchImpl, ROADMAP_DOC_URL, {
      headers,
      retryDelaysMs: secondaryRetryDelays,
      sleep,
    });
    if (rmResp.ok) {
      roadmapItems = parseRoadmapHtml(rmResp.text);
      if (!roadmapItems) warnings.push("roadmap doc: list not found");
    } else {
      warnings.push(`roadmap doc: HTTP ${rmResp.status}`);
    }
  } catch (err) {
    warnings.push(`roadmap doc: ${err.message}`);
  }

  return {
    snapshot: {
      discovery,
      probeVersions,
      mcpTools,
      roadmapItems,
    },
    erroredProbeVersions,
    warnings,
  };
}

export function loadState(stateDir) {
  const path = join(stateDir, "state.json");
  if (!existsSync(path)) {
    return {
      version: 1,
      snapshot: null,
      reportedChangeKeys: [],
      lastCheck: null,
      fetchFailingSince: null,
    };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return {
    version: 1,
    snapshot: parsed.snapshot || null,
    reportedChangeKeys: Array.isArray(parsed.reportedChangeKeys) ? parsed.reportedChangeKeys : [],
    lastCheck: parsed.lastCheck || null,
    fetchFailingSince: parsed.fetchFailingSince || null,
  };
}

export function saveState(stateDir, state) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "state.json");
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {}
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

export function appendEvent(stateDir, event) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  appendFileSync(join(stateDir, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
}

export function defaultRunCommand(args) {
  const res = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout || "",
    stderr: res.stderr || (res.error ? res.error.message : ""),
  };
}

export function findExecutable(name, searchPath = defaultSearchPath()) {
  for (const dir of searchPath.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function sendNotification(runCommand, title, message) {
  if (process.platform !== "darwin") return false;
  const res = runCommand([
    "/usr/bin/osascript",
    "-e",
    "on run argv",
    "-e",
    "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e",
    "end run",
    "--",
    String(message),
    String(title),
  ]);
  return res.status === 0;
}

export function reportRelease({
  diff,
  prev,
  next,
  runCommand = defaultRunCommand,
  boardPath = findExecutable("board"),
  dryRun = false,
}) {
  const task = formatReleaseTask(diff, prev, next);
  if (dryRun) {
    return { ok: true, channel: "dry-run", taskId: null, task };
  }

  const marker = `gnotebook-api:${diff.changeKey}`;
  if (boardPath) {
    // Cross-Mac dedupe: check if another host already filed a task for this exact change key.
    const ls = runCommand([
      boardPath,
      "--agent",
      BOARD_AGENT,
      "--register",
      "ls",
      "--board",
      BOARD_SLUG,
      "--search",
      diff.changeKey,
      "--detailed",
      "--json",
    ]);
    if (ls.status === 0) {
      try {
        const existing = JSON.parse(ls.stdout || "[]");
        const match = Array.isArray(existing)
          ? existing.find((t) => `${t.title || ""}\n${t.body || ""}`.includes(marker))
          : null;
        if (match) {
          return { ok: true, channel: "board-deduped", taskId: match.id || null, task };
        }
      } catch {
        // Proceed to add if listing JSON was unexpected
      }
    }

    const add = runCommand([
      boardPath,
      "--agent",
      BOARD_AGENT,
      "--register",
      "add",
      "--board",
      BOARD_SLUG,
      "--priority",
      "p2",
      "--body",
      task.body,
      "--accept",
      task.acceptance,
      "--json",
      task.title,
    ]);
    if (add.status === 0) {
      let taskId = null;
      try {
        const created = JSON.parse(add.stdout || "{}");
        taskId = created.id || null;
      } catch {}
      sendNotification(
        runCommand,
        "Gemini Notebook API Update",
        `${task.title}${taskId ? ` (${taskId})` : ""}`,
      );
      return { ok: true, channel: "board", taskId, task };
    }

    // Board CLI exists but failed (e.g., offline or missing token): do NOT mark reported so next run retries.
    return {
      ok: false,
      channel: "board-failed",
      taskId: null,
      error: (add.stderr || add.stdout || "board add failed").trim().slice(0, 300),
      task,
    };
  }

  // Fallback when board CLI is not installed on this host.
  const notified = sendNotification(runCommand, "Gemini Notebook API Update", task.title);
  return {
    ok: notified,
    channel: notified ? "notification" : "unreported",
    taskId: null,
    error: notified ? null : "board CLI not found and macOS notification failed",
    task,
  };
}

export async function runCheck({
  stateDir = defaultStateDir(),
  fetchImpl = fetch,
  runCommand = defaultRunCommand,
  boardPath = findExecutable("board"),
  now = new Date(),
  dryRun = false,
  retryDelaysMs = FETCH_RETRY_DELAYS_MS,
  sleep = defaultSleep,
} = {}) {
  const nowIso = now.toISOString();
  const state = loadState(stateDir);

  let fetched;
  try {
    fetched = await fetchCurrentSnapshot(fetchImpl, { retryDelaysMs, sleep });
  } catch (err) {
    const failingSince = state.fetchFailingSince || nowIso;
    state.fetchFailingSince = failingSince;
    state.lastCheck = nowIso;
    const elapsedMs = now.getTime() - new Date(failingSince).getTime();
    const transient = Boolean(err?.transient);
    const persistent = elapsedMs >= FETCH_FAILURE_GRACE_MS;
    if (!dryRun) {
      saveState(stateDir, state);
      if (persistent || !transient) {
        appendEvent(stateDir, {
          at: nowIso,
          event: "fetch-error",
          error: err.message,
          failingSince,
          transient,
        });
      }
    }
    return {
      ok: false,
      status: "fetch-error",
      error: err.message,
      failingSince,
      transient,
      persistent,
    };
  }

  const { snapshot: nextSnapshot, erroredProbeVersions = [], warnings } = fetched;
  state.fetchFailingSince = null;
  state.lastCheck = nowIso;

  // Baseline initialization on first run
  if (!state.snapshot) {
    state.snapshot = nextSnapshot;
    if (!dryRun) {
      saveState(stateDir, state);
      appendEvent(stateDir, {
        at: nowIso,
        event: "initialized",
        revision: nextSnapshot.discovery.revision,
        methodCount: Object.keys(nextSnapshot.discovery.methods).length,
        schemaCount: Object.keys(nextSnapshot.discovery.schemas).length,
        mcpToolCount: nextSnapshot.mcpTools?.length ?? null,
        roadmapCount: nextSnapshot.roadmapItems?.length ?? null,
        warnings,
      });
    }
    return {
      ok: true,
      status: "initialized",
      dryRun,
      snapshot: nextSnapshot,
      warnings,
    };
  }

  // Preserve prior baseline presence for any version probe that hit a transient non-404 error,
  // and preserve non-null doc fields so transient HTML/fetch errors never trigger false alerts.
  const prevProbeSet = new Set(state.snapshot.probeVersions || []);
  const mergedProbeSet = new Set(nextSnapshot.probeVersions || []);
  for (const ver of erroredProbeVersions) {
    if (prevProbeSet.has(ver)) mergedProbeSet.add(ver);
  }
  const mergedNext = {
    discovery: nextSnapshot.discovery,
    probeVersions: [...mergedProbeSet].sort(),
    mcpTools: nextSnapshot.mcpTools ?? state.snapshot.mcpTools ?? null,
    roadmapItems: nextSnapshot.roadmapItems ?? state.snapshot.roadmapItems ?? null,
  };

  const diff = diffSnapshots(state.snapshot, mergedNext);
  if (!diff.hasChanges) {
    // Update revision & lastCheck silently without alerting
    state.snapshot = mergedNext;
    if (!dryRun) {
      saveState(stateDir, state);
    }
    return {
      ok: true,
      status: "unchanged",
      dryRun,
      revision: mergedNext.discovery.revision,
      warnings,
    };
  }

  if (state.reportedChangeKeys.includes(diff.changeKey)) {
    state.snapshot = mergedNext;
    if (!dryRun) {
      saveState(stateDir, state);
    }
    return {
      ok: true,
      status: "already-reported",
      dryRun,
      changeKey: diff.changeKey,
      diff,
      warnings,
    };
  }

  const report = reportRelease({
    diff,
    prev: state.snapshot,
    next: mergedNext,
    runCommand,
    boardPath,
    dryRun,
  });

  if (!dryRun && report.ok) {
    state.snapshot = mergedNext;
    state.reportedChangeKeys = [...state.reportedChangeKeys, diff.changeKey].slice(-50);
    saveState(stateDir, state);
    appendEvent(stateDir, {
      at: nowIso,
      event: "release-detected",
      changeKey: diff.changeKey,
      channel: report.channel,
      taskId: report.taskId,
      title: report.task.title,
      revisionBefore: diff.revisionBefore,
      revisionAfter: diff.revisionAfter,
    });
  } else if (!dryRun && !report.ok) {
    // Save lastCheck only; keep prior baseline so next run retries reporting!
    saveState(stateDir, state);
    appendEvent(stateDir, {
      at: nowIso,
      event: "report-failed",
      changeKey: diff.changeKey,
      channel: report.channel,
      error: report.error,
    });
  }

  return {
    ok: report.ok,
    status: report.ok ? "release-detected" : "report-failed",
    dryRun,
    changeKey: diff.changeKey,
    channel: report.channel,
    taskId: report.taskId,
    error: report.error || null,
    diff,
    warnings,
  };
}

export function buildLaunchAgentPlist({
  bunPath,
  scriptPath,
  stateDir = defaultStateDir(),
  intervalSeconds = null,
  calendarInterval = DEFAULT_CALENDAR_SCHEDULE,
  searchPath = defaultSearchPath(),
}) {
  const logPath = join(stateDir, "launchd.log");
  let scheduleXml;
  if (intervalSeconds !== null && intervalSeconds !== undefined) {
    scheduleXml = `  <key>StartInterval</key>\n  <integer>${Math.max(300, Math.floor(intervalSeconds))}</integer>`;
  } else {
    const entries = [
      ["Weekday", calendarInterval?.weekday],
      ["Hour", calendarInterval?.hour],
      ["Minute", calendarInterval?.minute],
    ].filter(([, value]) => Number.isInteger(value));
    if (entries.length === 0) {
      throw new Error("calendarInterval must specify at least one integer field");
    }
    const dictBody = entries
      .map(([k, v]) => `    <key>${k}</key>\n    <integer>${v}</integer>`)
      .join("\n");
    scheduleXml = `  <key>StartCalendarInterval</key>\n  <dict>\n${dictBody}\n  </dict>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(bunPath)}</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>check</string>
    <string>--state-dir</string>
    <string>${escapeXml(stateDir)}</string>
  </array>
${scheduleXml}
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(searchPath)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

export function parseMonitorCli(argv) {
  const positional = [];
  const opts = {
    dryRun: false,
    json: false,
    stateDir: null,
    intervalSeconds: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      return { command: "help", opts };
    }
    if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--state-dir") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) throw new Error("--state-dir requires a path");
      opts.stateDir = resolve(val);
    } else if (a === "--interval") {
      const raw = argv[++i];
      if (!raw || !/^\d+$/.test(raw)) throw new Error("--interval requires a positive integer (seconds)");
      const n = Number.parseInt(raw, 10);
      if (n < 300) throw new Error("--interval must be at least 300 seconds");
      opts.intervalSeconds = n;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0] || "help", opts };
}

function usageText() {
  return `gnotebook-monitor — Official Gemini Notebook API release monitor (zero OAuth)

Usage:
  gnotebook-monitor check [--dry-run] [--json] [--state-dir <dir>]
  gnotebook-monitor status [--json] [--state-dir <dir>]
  gnotebook-monitor install [--dry-run] [--interval <seconds>]
  gnotebook-monitor uninstall
`;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { command, opts } = parseMonitorCli(argv);
  const stateDir = opts.stateDir || defaultStateDir();
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;

  if (command === "help") {
    stdout.write(usageText());
    return 0;
  }

  if (command === "check") {
    const res = await runCheck({
      stateDir,
      dryRun: opts.dryRun,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.runCommand ? { runCommand: deps.runCommand } : {}),
      ...(deps.boardPath !== undefined ? { boardPath: deps.boardPath } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.retryDelaysMs !== undefined ? { retryDelaysMs: deps.retryDelaysMs } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    const gracedTransientFetchError =
      res.status === "fetch-error" && res.transient && !res.persistent && !opts.dryRun;
    if (opts.json) {
      stdout.write(JSON.stringify(res, null, 2) + "\n");
    } else if (res.status === "initialized") {
      const d = res.snapshot.discovery;
      stdout.write(
        `Initialized baseline (rev ${d.revision}, ${Object.keys(d.methods).length} methods, ${Object.keys(d.schemas).length} schemas, ${res.snapshot.mcpTools?.length ?? 0} MCP tools, ${res.snapshot.roadmapItems?.length ?? 0} roadmap items)\n`,
      );
    } else if (res.status === "unchanged") {
      stdout.write(`No Gemini Notebook API changes (rev ${res.revision})\n`);
    } else if (res.status === "release-detected") {
      stdout.write(
        `Release detected (${res.changeKey}) -> ${res.channel}${res.taskId ? ` (${res.taskId})` : ""}\n`,
      );
    } else if (res.status === "already-reported") {
      stdout.write(`Change ${res.changeKey} already reported\n`);
    } else if (gracedTransientFetchError) {
      stderr.write(`gnotebook-monitor ${res.status} (transient, within 24h grace): ${res.error}\n`);
    } else {
      stderr.write(`gnotebook-monitor ${res.status}: ${res.error}\n`);
    }
    return res.ok || gracedTransientFetchError ? 0 : 1;
  }

  if (command === "status") {
    const state = loadState(stateDir);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const loaded =
      process.platform === "darwin" &&
      defaultRunCommand(["/bin/launchctl", "print", `gui/${uid}/${LABEL}`]).status === 0;
    const out = {
      label: LABEL,
      plistPath: launchAgentPlistPath(),
      plistExists: existsSync(launchAgentPlistPath()),
      launchAgentLoaded: loaded,
      stateDir,
      lastCheck: state.lastCheck,
      fetchFailingSince: state.fetchFailingSince,
      reportedCount: state.reportedChangeKeys.length,
      baseline: state.snapshot
        ? {
            revision: state.snapshot.discovery.revision,
            methods: Object.keys(state.snapshot.discovery.methods),
            schemas: Object.keys(state.snapshot.discovery.schemas),
            probeVersions: state.snapshot.probeVersions,
            mcpTools: state.snapshot.mcpTools,
            roadmapItems: state.snapshot.roadmapItems,
          }
        : null,
    };
    stdout.write(JSON.stringify(out, null, 2) + "\n");
    return 0;
  }

  if (command === "install") {
    const bunPath = findExecutable("bun") || process.execPath;
    const scriptPath = realpathSync(fileURLToPath(import.meta.url));
    const plist = buildLaunchAgentPlist({
      bunPath,
      scriptPath,
      stateDir,
      intervalSeconds: opts.intervalSeconds,
    });
    if (opts.dryRun) {
      stdout.write(plist);
      return 0;
    }
    if (process.platform !== "darwin") {
      throw new Error("install is only supported on macOS (LaunchAgents)");
    }
    const targetPlist = launchAgentPlistPath();
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(targetPlist), { recursive: true });
    writeFileSync(targetPlist, plist, { mode: 0o644 });
    const uid = process.getuid();
    const domain = `gui/${uid}`;
    defaultRunCommand(["/bin/launchctl", "bootout", `${domain}/${LABEL}`]);
    const boot = defaultRunCommand(["/bin/launchctl", "bootstrap", domain, targetPlist]);
    if (boot.status !== 0) {
      throw new Error(`launchctl bootstrap failed: ${boot.stderr.trim()}`);
    }
    stdout.write(`Loaded ${LABEL} from ${targetPlist}\n`);
    return 0;
  }

  if (command === "uninstall") {
    if (process.platform === "darwin") {
      const uid = process.getuid();
      defaultRunCommand(["/bin/launchctl", "bootout", `gui/${uid}/${LABEL}`]);
    }
    const targetPlist = launchAgentPlistPath();
    if (existsSync(targetPlist)) unlinkSync(targetPlist);
    stdout.write(`Removed ${LABEL}; state in ${stateDir} is kept.\n`);
    return 0;
  }

  throw new Error(`Unknown command: ${command}. Run "gnotebook-monitor --help".`);
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`gnotebook-monitor error: ${err.message}\n`);
      process.exit(1);
    },
  );
}
