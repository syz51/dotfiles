#!/usr/bin/env bun
/**
 * gnotebook: Official Gemini Notebook API ingestion, bundling, sync & digest CLI.
 *
 * Uses Google's official REST API (https://notebook.googleapis.com/v1 and /upload/v1)
 * authenticated with local Application Default Credentials (ADC) — zero unofficial
 * cookie scraping, zero external npm dependencies, and strict client-side deduplication
 * (since the Public Preview API has no delete endpoint yet).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

export const API_ROOT = "https://notebook.googleapis.com/v1";
export const UPLOAD_ROOT = "https://notebook.googleapis.com/upload/v1";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const MAX_INLINE_BYTES = 900_000; // Safe margin below 1 MB inline cap; larger uses resumable upload
export const SIMPLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB simple media upload; >5 MiB uses resumable
export const HARD_MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB official API cap
export const DEFAULT_BUNDLE_MAX_WORDS = 150_000; // Sharp Audio/Video Overview & citation target
export const HARD_MAX_WORDS = 450_000; // Safety margin under 500k word API limit
export const MAX_FALLBACK_FETCH_BYTES = 15 * 1024 * 1024; // 15 MiB cap on local fallback fetch
export const MAX_DISPLAY_NAME = 500;

export const SUPPORTED_UPLOAD_MIME_BY_EXT = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".epub": "application/epub+zip",
  ".rtf": "application/rtf",
  ".hwp": "application/x-hwp",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".opus": "audio/opus",
  ".3gp": "video/3gpp",
  ".3g2": "video/3gpp2",
};

export const BUNDLE_CODE_LANG_BY_EXT = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".ts": "ts",
  ".tsx": "tsx",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "zsh",
  ".fish": "fish",
  ".json": "json",
  ".toml": "toml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sql": "sql",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".vue": "vue",
  ".svelte": "svelte",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".ex": "elixir",
  ".exs": "elixir",
  ".tex": "latex",
  ".org": "org",
  ".rst": "rst",
  ".hcl": "hcl",
  ".tf": "hcl",
  ".xml": "xml",
};

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".turbo",
  ".cache",
  "coverage",
]);

const SKIP_FILENAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "uv.lock",
  "poetry.lock",
  "Gemfile.lock",
  "application_default_credentials.json",
  "credentials.json",
  "client_secret.json",
]);

const SECRET_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|age)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[._-])(secret|secrets|credential|credentials|private[_-]?key)([._-]|$)/i,
  /^token\.json$/i,
  /^mcp_oauth_tokens\.json$/i,
];

export function isSecretPath(relPath) {
  const parts = relPath.replace(/\\/g, "/").split("/");
  for (const part of parts) {
    if (!part) continue;
    if (part === ".ssh" || part === ".gnupg" || part === "gcloud") return true;
  }
  const base = parts[parts.length - 1] || "";
  if (SKIP_FILENAMES.has(base)) return true;
  return SECRET_FILE_PATTERNS.some((re) => re.test(base));
}

export function isSkippedDir(name) {
  return SKIP_DIRS.has(name) || name === ".ssh" || name === ".gnupg";
}

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function truncateDisplayName(name) {
  const clean = String(name || "Untitled").replace(/[\r\n\t]+/g, " ").trim() || "Untitled";
  if (clean.length <= MAX_DISPLAY_NAME) return clean;
  return `${clean.slice(0, MAX_DISPLAY_NAME - 3)}...`;
}

/**
 * Counts CJK ideographs/kana/hangul individually plus non-CJK word runs so
 * Chinese/Japanese corpora never silently exceed NotebookLM's 500k-word ceiling.
 */
export function countUnits(text) {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjk = text.replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, " ");
  const wordMatches = nonCjk.match(/[A-Za-z0-9_'-]+/g);
  const wordCount = wordMatches ? wordMatches.length : 0;
  return cjkCount + wordCount;
}

export function mimeForFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  return SUPPORTED_UPLOAD_MIME_BY_EXT[ext] || null;
}

export function isBinarySupportedFile(filePath) {
  const mime = mimeForFile(filePath);
  if (!mime) return false;
  return !mime.startsWith("text/") || extname(filePath).toLowerCase() === ".csv";
}

export function isUrl(target) {
  return /^https?:\/\//i.test(target);
}

export function isUnsupportedGoogleDriveUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname === "docs.google.com" ||
      u.hostname === "drive.google.com" ||
      u.hostname === "sheets.google.com" ||
      u.hostname === "slides.google.com"
    );
  } catch {
    return false;
  }
}

export function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, "");
    return h === "youtube.com" || h === "m.youtube.com" || h === "youtu.be";
  } catch {
    return false;
  }
}

export function isLikelyPlainTextUrl(url) {
  try {
    const u = new URL(url);
    return /\.(md|markdown|txt|rst|csv)$/i.test(u.pathname);
  } catch {
    return false;
  }
}

export function htmlToReadableMarkdown(html, url) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, " ").trim()) : url;
  let body = html;
  const article = html.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
  if (article) body = article[1];
  body = body
    .replace(/<(script|style|noscript|svg|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, "\n")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<(?:p|div|br|tr|section|header)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  body = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .trim();
  return {
    title,
    markdown: `# ${title}\n\nSource URL: ${url}\n\n${body}\n`,
  };
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => {
      const cp = Number(n);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => {
      const cp = parseInt(n, 16);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&amp;/gi, "&");
}

function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

export function isBlockedFetchUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return true;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host.includes(":")) {
    if (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fe80:") ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("::ffff:")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Splits a list of { relPath, content, lang } entries into word- and byte-bounded
 * structured Markdown bundles with TOC headers.
 */
export function splitMarkdownBundles(entries, { baseName, maxWords = DEFAULT_BUNDLE_MAX_WORDS, maxBytes = HARD_MAX_UPLOAD_BYTES - 10 * 1024 * 1024 } = {}) {
  const effectiveMaxWords = Math.min(Math.max(1_000, maxWords), HARD_MAX_WORDS);
  const renderedEntries = [];

  for (const entry of entries) {
    const isMd = entry.lang === "markdown" || entry.lang === "text";
    const body = isMd
      ? entry.content.trim()
      : `\`\`\`${entry.lang || ""}\n${entry.content.replace(/```/g, "``\\`").trimEnd()}\n\`\`\``;
    const section = `## File: \`${entry.relPath}\`\n\n${body}\n`;
    const units = countUnits(section);
    const bytes = Buffer.byteLength(section, "utf8");

    if (units <= effectiveMaxWords && bytes <= maxBytes) {
      renderedEntries.push({ relPath: entry.relPath, section, units, bytes });
      continue;
    }

    // Split oversized single file cleanly on line boundaries
    const lines = entry.content.split("\n");
    let partIdx = 1;
    let chunkLines = [];
    let chunkUnits = 0;
    let chunkBytes = 0;
    const flushChunk = () => {
      if (chunkLines.length === 0) return;
      const chunkText = chunkLines.join("\n");
      const wrapped = isMd
        ? chunkText.trim()
        : `\`\`\`${entry.lang || ""}\n${chunkText.replace(/```/g, "``\\`").trimEnd()}\n\`\`\``;
      const sec = `## File: \`${entry.relPath}\` (part ${partIdx})\n\n${wrapped}\n`;
      renderedEntries.push({
        relPath: `${entry.relPath}#part-${partIdx}`,
        section: sec,
        units: countUnits(sec),
        bytes: Buffer.byteLength(sec, "utf8"),
      });
      partIdx++;
      chunkLines = [];
      chunkUnits = 0;
      chunkBytes = 0;
    };

    for (const rawLine of lines) {
      // Slice single lines that individually exceed unit or byte budgets (e.g., long CJK paragraphs or minified text)
      const subLines = [];
      const lineLimit = Math.max(200, Math.floor(effectiveMaxWords * 0.85));
      const byteLimit = Math.max(4096, Math.floor(maxBytes * 0.85));
      if (countUnits(rawLine) > lineLimit || Buffer.byteLength(rawLine, "utf8") > byteLimit) {
        let rem = rawLine;
        while (rem.length > 0 && (countUnits(rem) > lineLimit || Buffer.byteLength(rem, "utf8") > byteLimit)) {
          let cut = Math.min(rem.length, lineLimit, byteLimit);
          while (
            cut > 100 &&
            (countUnits(rem.slice(0, cut)) > lineLimit || Buffer.byteLength(rem.slice(0, cut), "utf8") > byteLimit)
          ) {
            cut = Math.floor(cut * 0.8);
          }
          // Avoid splitting a UTF-16 surrogate pair
          if (cut > 1 && cut < rem.length) {
            const prevCode = rem.charCodeAt(cut - 1);
            if (prevCode >= 0xd800 && prevCode <= 0xdbff) cut -= 1;
          }
          const spaceIdx = rem.lastIndexOf(" ", cut);
          if (spaceIdx > cut * 0.5) cut = spaceIdx + 1;
          subLines.push(rem.slice(0, cut));
          rem = rem.slice(cut);
        }
        if (rem.length > 0) subLines.push(rem);
      } else {
        subLines.push(rawLine);
      }

      for (const line of subLines) {
        const lu = countUnits(line) + 1;
        const lb = Buffer.byteLength(line, "utf8") + 1;
        if (chunkLines.length > 0 && (chunkUnits + lu > effectiveMaxWords * 0.9 || chunkBytes + lb > maxBytes * 0.9)) {
          flushChunk();
        }
        chunkLines.push(line);
        chunkUnits += lu;
        chunkBytes += lb;
      }
    }
    flushChunk();
  }

  if (renderedEntries.length === 0) return [];

  const groups = [];
  let cur = [];
  let curUnits = 0;
  let curBytes = 0;

  for (const item of renderedEntries) {
    if (cur.length > 0 && (curUnits + item.units > effectiveMaxWords || curBytes + item.bytes > maxBytes)) {
      groups.push(cur);
      cur = [];
      curUnits = 0;
      curBytes = 0;
    }
    cur.push(item);
    curUnits += item.units;
    curBytes += item.bytes;
  }
  if (cur.length > 0) groups.push(cur);

  return groups.map((group, idx) => {
    const suffix = groups.length > 1 ? ` (Part ${idx + 1}/${groups.length})` : "";
    const displayName = truncateDisplayName(`${baseName}${suffix}`);
    const toc = group.map((g) => `- \`${g.relPath}\``).join("\n");
    const markdown = `# ${displayName}\n\n## Table of Contents\n\n${toc}\n\n---\n\n${group.map((g) => g.section).join("\n---\n\n")}`;
    return {
      displayName,
      markdown,
      bytes: Buffer.byteLength(markdown, "utf8"),
      units: countUnits(markdown),
      files: group.map((g) => g.relPath),
      sha256: sha256Hex(markdown),
    };
  });
}

export function walkDirectory(dirPath, { maxFileBytes = 5 * 1024 * 1024 } = {}) {
  const root = resolve(dirPath);
  const textEntries = [];
  const binaryFiles = [];
  const skipped = [];

  if (isSecretPath(root)) {
    skipped.push({ path: root, reason: "secret-dir-blocked" });
    return { root, textEntries, binaryFiles, skipped };
  }

  function visit(current) {
    const dirents = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      const full = join(current, d.name);
      const rel = relative(root, full).replace(/\\/g, "/");
      if (d.isDirectory()) {
        if (isSkippedDir(d.name)) {
          skipped.push({ path: rel, reason: "ignored-dir" });
          continue;
        }
        visit(full);
        continue;
      }
      if (!d.isFile()) continue;
      if (isSecretPath(rel)) {
        skipped.push({ path: rel, reason: "secret-or-lockfile" });
        continue;
      }
      const st = statSync(full);
      if (st.size === 0) {
        skipped.push({ path: rel, reason: "empty" });
        continue;
      }
      const ext = extname(d.name).toLowerCase();
      if (isBinarySupportedFile(full)) {
        if (st.size > HARD_MAX_UPLOAD_BYTES) {
          skipped.push({ path: rel, reason: "exceeds-200MiB" });
        } else {
          binaryFiles.push({ path: full, relPath: rel, mimeType: mimeForFile(full), bytes: st.size });
        }
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(BUNDLE_CODE_LANG_BY_EXT, ext)) {
        if (st.size > maxFileBytes) {
          skipped.push({ path: rel, reason: `text-exceeds-${maxFileBytes}B` });
          continue;
        }
        const buf = readFileSync(full);
        // Guard against NUL bytes (binary disguised with text extension)
        if (buf.includes(0)) {
          skipped.push({ path: rel, reason: "binary-bytes" });
          continue;
        }
        textEntries.push({
          relPath: rel,
          lang: BUNDLE_CODE_LANG_BY_EXT[ext],
          content: buf.toString("utf8"),
        });
        continue;
      }
      skipped.push({ path: rel, reason: "unsupported-extension" });
    }
  }

  visit(root);
  return { root, textEntries, binaryFiles, skipped };
}

export function parseRetryDelayMs(errBody, retryAfterHeader) {
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  }
  const details = errBody?.error?.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (typeof d?.retryDelay === "string") {
        const m = d.retryDelay.match(/^([0-9]+(?:\.[0-9]+)?)s$/);
        if (m) return Math.ceil(parseFloat(m[1]) * 1000);
      }
    }
  }
  return null;
}

export class RateLimiter {
  constructor(rpm, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.minIntervalMs = rpm > 0 ? Math.ceil(60_000 / rpm) : 0;
    this.nextAvailable = 0;
    this.sleepFn = sleepFn;
  }

  async wait() {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAvailable - now);
    this.nextAvailable = Math.max(now, this.nextAvailable) + this.minIntervalMs;
    if (waitMs > 0) await this.sleepFn(waitMs);
  }
}

export class StateStore {
  constructor(statePath = defaultStatePath()) {
    this.statePath = statePath;
    this.data = this._load();
  }

  _load() {
    if (!existsSync(this.statePath)) return { version: 1, notebooks: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.notebooks) return parsed;
    } catch {
      // Corrupt state file — start fresh without crashing
    }
    return { version: 1, notebooks: {} };
  }

  save() {
    const dir = dirname(this.statePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.state.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // ignore chmod failures on non-POSIX FS
      }
      renameSync(tmp, this.statePath);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // ignore cleanup failure
      }
      throw err;
    }
  }

  getEntry(notebookName, key) {
    return this.data.notebooks?.[notebookName]?.[key] || null;
  }

  setEntry(notebookName, key, record) {
    if (!this.data.notebooks[notebookName]) this.data.notebooks[notebookName] = {};
    this.data.notebooks[notebookName][key] = record;
    this.save();
  }
}

export function defaultAdcPath(env = process.env) {
  return env.GNOTEBOOK_ADC_PATH || join(homedir(), ".config/gcloud/application_default_credentials.json");
}

export function defaultClientPath(env = process.env) {
  return env.GNOTEBOOK_CLIENT_PATH || join(homedir(), ".config/gcloud/gemini-notebook-oauth-client.json");
}

export function defaultStatePath(env = process.env) {
  return env.GNOTEBOOK_STATE_PATH || join(homedir(), ".local/share/gnotebook/state.json");
}

export class NotebookClient {
  constructor({
    adcPath = defaultAdcPath(),
    fetchImpl = fetch,
    writeRpm = 18,
    readRpm = 55,
    sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
    maxRetries = 4,
  } = {}) {
    this.adcPath = adcPath;
    this.fetchImpl = fetchImpl;
    this.sleepFn = sleepFn;
    this.maxRetries = maxRetries;
    this.writeLimiter = new RateLimiter(writeRpm, sleepFn);
    this.readLimiter = new RateLimiter(readRpm, sleepFn);
    this._token = null;
    this._tokenExpiresAt = 0;
    this._projectId = null;
  }

  readAdc() {
    if (!existsSync(this.adcPath)) {
      throw new Error(
        `Missing Google ADC file at ${this.adcPath}. See ~/.config/gemini/docs/gemini-notebook-mcp.md to authenticate.`,
      );
    }
    const adc = JSON.parse(readFileSync(this.adcPath, "utf8"));
    for (const field of ["client_id", "client_secret", "refresh_token", "quota_project_id"]) {
      if (!adc[field]) {
        throw new Error(
          `ADC file ${this.adcPath} is missing "${field}". See ~/.config/gemini/docs/gemini-notebook-mcp.md.`,
        );
      }
    }
    return adc;
  }

  async getAuth(forceRefresh = false) {
    if (!forceRefresh && this._token && Date.now() < this._tokenExpiresAt - 60_000) {
      return { token: this._token, projectId: this._projectId };
    }
    const adc = this.readAdc();
    const form = new URLSearchParams({
      client_id: adc.client_id,
      client_secret: adc.client_secret,
      refresh_token: adc.refresh_token,
      grant_type: "refresh_token",
    });
    const resp = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const text = await resp.text();
    let parsed = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    if (!resp.ok || !parsed.access_token) {
      const errCode = parsed.error || `HTTP_${resp.status}`;
      const hint =
        errCode === "invalid_grant"
          ? " Refresh token expired or revoked — follow ~/.config/gemini/docs/gemini-notebook-mcp.md to re-login."
          : "";
      throw new Error(`OAuth token refresh failed (${errCode}).${hint}`);
    }
    this._token = parsed.access_token;
    this._projectId = adc.quota_project_id;
    this._tokenExpiresAt = Date.now() + Number(parsed.expires_in || 3600) * 1000;
    return { token: this._token, projectId: this._projectId };
  }

  async request({ method, url, body = undefined, rawBody = undefined, contentType = "application/json", extraHeaders = {}, isWrite = false, sendAuth = true }) {
    const limiter = isWrite ? this.writeLimiter : this.readLimiter;
    let attempt = 0;

    while (true) {
      await limiter.wait();
      const headers = { ...extraHeaders };
      if (sendAuth) {
        const { token, projectId } = await this.getAuth();
        headers.Authorization = `Bearer ${token}`;
        headers["x-goog-user-project"] = projectId;
      }
      if (contentType) headers["Content-Type"] = contentType;

      const reqBody = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
      const t0 = Date.now();
      const resp = await this.fetchImpl(url, { method, headers, body: reqBody });
      const elapsedMs = Date.now() - t0;
      const rawText = await resp.text();
      let parsed = {};
      if (rawText) {
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = { raw: rawText.slice(0, 500) };
        }
      }

      if (resp.ok) {
        return { status: resp.status, data: parsed, headers: resp.headers, elapsedMs };
      }

      // Retry once on 401 with fresh token
      if (resp.status === 401 && sendAuth && attempt === 0) {
        attempt++;
        await this.getAuth(true);
        continue;
      }

      const retryable = resp.status === 429 || (resp.status >= 500 && resp.status < 600);
      if (retryable && attempt < this.maxRetries) {
        attempt++;
        const serverDelay = parseRetryDelayMs(parsed, resp.headers?.get?.("retry-after"));
        const expDelay = Math.min(30_000, 1000 * Math.pow(2, attempt));
        const jitter = Math.floor(Math.random() * 400);
        await this.sleepFn((serverDelay ?? expDelay) + jitter);
        continue;
      }

      const apiMsg = parsed?.error?.message || parsed?.raw || `HTTP ${resp.status}`;
      const apiStatus = parsed?.error?.status || `HTTP_${resp.status}`;
      const err = new Error(`Gemini Notebook API error (${resp.status} ${apiStatus}): ${apiMsg}`);
      err.httpStatus = resp.status;
      err.apiStatus = apiStatus;
      err.body = parsed;
      throw err;
    }
  }

  async listNotebooks({ filter = null } = {}) {
    const notebooks = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({ pageSize: "100" });
      if (filter) params.set("filter", filter);
      if (pageToken) params.set("pageToken", pageToken);
      const { data } = await this.request({
        method: "GET",
        url: `${API_ROOT}/notebooks?${params.toString()}`,
        contentType: null,
      });
      if (Array.isArray(data.notebooks)) notebooks.push(...data.notebooks);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    return notebooks;
  }

  async getNotebook(notebookName) {
    const name = normalizeNotebookName(notebookName);
    const { data } = await this.request({ method: "GET", url: `${API_ROOT}/${name}`, contentType: null });
    return data;
  }

  async createNotebook(displayName) {
    const { data } = await this.request({
      method: "POST",
      url: `${API_ROOT}/notebooks`,
      body: { display_name: truncateDisplayName(displayName) },
      isWrite: false, // CreateNotebook has 60 RPM limit, not 20 RPM
    });
    return data;
  }

  async updateNotebook(notebookName, displayName) {
    const name = normalizeNotebookName(notebookName);
    const { data } = await this.request({
      method: "PATCH",
      url: `${API_ROOT}/${name}?updateMask=displayName`,
      body: { display_name: truncateDisplayName(displayName) },
    });
    return data;
  }

  async findNotebook(nameOrDisplayName) {
    if (nameOrDisplayName.startsWith("notebooks/")) {
      return this.getNotebook(nameOrDisplayName);
    }
    const existing = await this.listNotebooks();
    const match = existing.find((n) => n.displayName === nameOrDisplayName);
    if (!match) {
      throw new Error(`Notebook not found: "${nameOrDisplayName}". Use "gnotebook notebooks list" or "gnotebook notebooks ensure".`);
    }
    return match;
  }

  async ensureNotebook(nameOrDisplayName) {
    if (nameOrDisplayName.startsWith("notebooks/")) {
      return { notebook: await this.getNotebook(nameOrDisplayName), created: false };
    }
    const existing = await this.listNotebooks();
    const match = existing.find((n) => n.displayName === nameOrDisplayName);
    if (match) return { notebook: match, created: false };
    const created = await this.createNotebook(nameOrDisplayName);
    return { notebook: created, created: true };
  }

  async listSources(notebookName) {
    const name = normalizeNotebookName(notebookName);
    const sources = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({ pageSize: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const { data } = await this.request({
        method: "GET",
        url: `${API_ROOT}/${name}/sources?${params.toString()}`,
        contentType: null,
      });
      if (Array.isArray(data.sources)) sources.push(...data.sources);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    return sources;
  }

  async getSource(sourceName) {
    const { data } = await this.request({
      method: "GET",
      url: `${API_ROOT}/${sourceName}`,
      contentType: null,
    });
    return data;
  }

  async createWebSource(notebookName, url, displayName = null) {
    if (isUnsupportedGoogleDriveUrl(url)) {
      throw new Error(`Unsupported Google Drive/Docs URL: ${url}. Export as PDF/DOCX/Markdown and ingest locally instead.`);
    }
    const body = { web_content: { url } };
    if (displayName) body.display_name = truncateDisplayName(displayName);
    const { data, elapsedMs } = await this.request({
      method: "POST",
      url: `${API_ROOT}/${normalizeNotebookName(notebookName)}/sources`,
      body,
      isWrite: true,
    });
    return { source: data, elapsedMs, transport: "create_source(web)" };
  }

  async createTextSource(notebookName, content, { displayName, mimeType = "text/markdown" }) {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_INLINE_BYTES) {
      return this.uploadFileBytes(notebookName, Buffer.from(content, "utf8"), {
        displayName,
        mimeType,
        forceResumable: true,
      });
    }
    const { data, elapsedMs } = await this.request({
      method: "POST",
      url: `${API_ROOT}/${normalizeNotebookName(notebookName)}/sources`,
      body: {
        display_name: truncateDisplayName(displayName),
        mime_type: mimeType,
        text_content: { content },
      },
      isWrite: true,
    });
    return { source: data, elapsedMs, transport: "create_source(text)" };
  }

  async uploadFileBytes(notebookName, buffer, { displayName, mimeType, forceResumable = false }) {
    if (buffer.length === 0) throw new Error(`Cannot upload empty file (${displayName})`);
    if (buffer.length > HARD_MAX_UPLOAD_BYTES) {
      throw new Error(`File "${displayName}" is ${buffer.length} bytes, exceeding the 200 MiB NotebookLM API limit.`);
    }
    const normNb = normalizeNotebookName(notebookName);
    const cleanName = truncateDisplayName(displayName);

    if (!forceResumable && buffer.length <= SIMPLE_UPLOAD_MAX_BYTES) {
      const qs = new URLSearchParams({ uploadType: "media", "source.displayName": cleanName });
      const { data, elapsedMs } = await this.request({
        method: "POST",
        url: `${UPLOAD_ROOT}/${normNb}/sources:upload?${qs.toString()}`,
        rawBody: buffer,
        contentType: mimeType,
        isWrite: true,
      });
      return { source: data.source || data, elapsedMs, transport: "upload(media)" };
    }

    // Two-step resumable upload (no Authorization header on signed X-Goog-Upload-URL)
    const start = await this.request({
      method: "POST",
      url: `${UPLOAD_ROOT}/${normNb}/sources:upload`,
      body: { source: { displayName: cleanName } },
      contentType: "application/json",
      extraHeaders: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(buffer.length),
        "X-Goog-Upload-Header-Content-Type": mimeType,
      },
      isWrite: true,
    });
    const uploadUrl = start.headers?.get?.("x-goog-upload-url");
    if (!uploadUrl) {
      throw new Error(`Resumable upload start did not return x-goog-upload-url header for "${cleanName}".`);
    }
    const fin = await this.request({
      method: "POST",
      url: uploadUrl,
      rawBody: buffer,
      contentType: null,
      extraHeaders: {
        "X-Goog-Upload-Command": "upload, finalize",
        "X-Goog-Upload-Offset": "0",
      },
      isWrite: false,
      sendAuth: false,
    });
    return {
      source: fin.data.source || fin.data,
      elapsedMs: start.elapsedMs + fin.elapsedMs,
      transport: "upload(resumable)",
    };
  }

  async waitForSource(sourceName, { timeoutMs = 120_000 } = {}) {
    const start = Date.now();
    let delayMs = 1000;
    while (Date.now() - start < timeoutMs) {
      const src = await this.getSource(sourceName);
      if (src.state === "ACTIVE" || src.state === "FAILED") {
        return { source: src, pollMs: Date.now() - start };
      }
      await this.sleepFn(delayMs);
      delayMs = Math.min(Math.round(delayMs * 1.4), 5000);
    }
    return {
      source: { name: sourceName, state: "TIMEOUT" },
      pollMs: Date.now() - start,
    };
  }
}

export function normalizeNotebookName(nameOrId) {
  if (nameOrId.startsWith("notebooks/")) return nameOrId;
  return `notebooks/${nameOrId}`;
}

export async function fetchUrlAsMarkdown(url, fetchImpl = fetch, { timeoutMs = 30_000, maxRedirects = 5 } = {}) {
  let currentUrl = url;
  let resp = null;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (isBlockedFetchUrl(currentUrl)) {
      throw new Error(`Refusing fallback fetch to private/loopback/non-HTTP URL: ${currentUrl}`);
    }
    resp = await fetchImpl(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "gnotebook/1.0 (+https://developers.google.com/notebook/docs/mcp)" },
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers?.get?.("location");
      if (!loc) break;
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }
    break;
  }
  if (!resp || !resp.ok) {
    throw new Error(`Fallback fetch failed for ${currentUrl}: HTTP ${resp?.status ?? "ERR"}`);
  }
  const ct = (resp.headers?.get?.("content-type") || "").toLowerCase();
  if (ct && !ct.includes("text/") && !ct.includes("json") && !ct.includes("xml") && !ct.includes("markdown") && !ct.includes("xhtml")) {
    throw new Error(`Fallback fetch refused non-text content-type "${ct}" for ${currentUrl}.`);
  }
  const contentLen = Number(resp.headers?.get?.("content-length"));
  if (Number.isFinite(contentLen) && contentLen > MAX_FALLBACK_FETCH_BYTES) {
    throw new Error(`Fallback fetch response for ${currentUrl} exceeds ${MAX_FALLBACK_FETCH_BYTES} bytes.`);
  }

  let buf;
  if (resp.body && typeof resp.body.getReader === "function") {
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FALLBACK_FETCH_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        throw new Error(`Fallback fetch response for ${currentUrl} exceeds ${MAX_FALLBACK_FETCH_BYTES} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
    buf = Buffer.concat(chunks, total);
  } else {
    buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_FALLBACK_FETCH_BYTES) {
      throw new Error(`Fallback fetch response for ${currentUrl} exceeds ${MAX_FALLBACK_FETCH_BYTES} bytes.`);
    }
  }
  if (buf.includes(0)) {
    throw new Error(`Fallback fetch response for ${currentUrl} contains binary NUL bytes.`);
  }

  const text = buf.toString("utf8");
  if (ct.includes("text/html") || (!ct.includes("markdown") && !ct.includes("text/plain") && /<html[\s>]/i.test(text))) {
    return htmlToReadableMarkdown(text, currentUrl);
  }
  const u = new URL(currentUrl);
  const title = safeDecodeURIComponent(basename(u.pathname) || u.hostname);
  return {
    title,
    markdown: `# ${title}\n\nSource URL: ${currentUrl}\n\n${text}\n`,
  };
}

/**
 * Prepares a deterministic list of ingestion items from mixed targets (URLs, files, dirs, stdin).
 */
export function planIngestItems({ targets = [], stdinText = null, stdinName = null, bundle = true, maxWords = DEFAULT_BUNDLE_MAX_WORDS }) {
  const items = [];
  const skipped = [];
  const looseTextFiles = [];

  if (stdinText !== null) {
    const content = stdinText;
    const displayName = truncateDisplayName(stdinName || `Stdin ${new Date().toISOString().slice(0, 10)}`);
    items.push({
      kind: "text",
      key: `stdin:${displayName}`,
      displayName,
      mimeType: "text/markdown",
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      units: countUnits(content),
      sha256: sha256Hex(content),
    });
  }

  for (const rawTarget of targets) {
    if (isUrl(rawTarget)) {
      if (isUnsupportedGoogleDriveUrl(rawTarget)) {
        skipped.push({ path: rawTarget, reason: "unsupported-google-drive-url" });
        continue;
      }
      items.push({
        kind: "url",
        key: `url:${rawTarget}`,
        url: rawTarget,
        displayName: null,
        preferFallback: !isYouTubeUrl(rawTarget) && isLikelyPlainTextUrl(rawTarget),
      });
      continue;
    }

    const abs = resolve(rawTarget);
    if (!existsSync(abs)) {
      throw new Error(`Target not found: ${rawTarget}`);
    }
    const st = statSync(abs);
    if (st.isDirectory()) {
      const walked = walkDirectory(abs);
      skipped.push(...walked.skipped);
      for (const bf of walked.binaryFiles) {
        const buf = readFileSync(bf.path);
        items.push({
          kind: "file",
          key: `file:${bf.path}`,
          filePath: bf.path,
          displayName: truncateDisplayName(bf.relPath),
          mimeType: bf.mimeType,
          bytes: bf.bytes,
          sha256: sha256Hex(buf),
        });
      }
      if (bundle && walked.textEntries.length > 0) {
        const bundles = splitMarkdownBundles(walked.textEntries, {
          baseName: `${basename(abs)} Bundle`,
          maxWords,
        });
        for (const b of bundles) {
          items.push({
            kind: "text",
            key: `bundle:${abs}:${b.displayName}`,
            displayName: b.displayName,
            mimeType: "text/markdown",
            content: b.markdown,
            bytes: b.bytes,
            units: b.units,
            files: b.files,
            sha256: b.sha256,
          });
        }
      } else {
        for (const te of walked.textEntries) {
          const isMd = te.lang === "markdown" || te.lang === "text";
          const content = isMd ? te.content : `# ${te.relPath}\n\n\`\`\`${te.lang}\n${te.content}\n\`\`\`\n`;
          items.push({
            kind: "text",
            key: `file:${join(abs, te.relPath)}`,
            displayName: truncateDisplayName(te.relPath),
            mimeType: "text/markdown",
            content,
            bytes: Buffer.byteLength(content, "utf8"),
            units: countUnits(content),
            sha256: sha256Hex(content),
          });
        }
      }
      continue;
    }

    // Single file
    if (isSecretPath(abs)) {
      skipped.push({ path: rawTarget, reason: "secret-file-blocked" });
      continue;
    }
    if (st.size === 0) {
      skipped.push({ path: rawTarget, reason: "empty" });
      continue;
    }
    if (st.size > HARD_MAX_UPLOAD_BYTES) {
      skipped.push({ path: rawTarget, reason: "exceeds-200MiB" });
      continue;
    }
    const ext = extname(abs).toLowerCase();
    if (isBinarySupportedFile(abs)) {
      const buf = readFileSync(abs);
      items.push({
        kind: "file",
        key: `file:${abs}`,
        filePath: abs,
        displayName: truncateDisplayName(basename(abs)),
        mimeType: mimeForFile(abs),
        bytes: buf.length,
        sha256: sha256Hex(buf),
      });
    } else if (Object.prototype.hasOwnProperty.call(BUNDLE_CODE_LANG_BY_EXT, ext) || mimeForFile(abs)) {
      const buf = readFileSync(abs);
      if (buf.includes(0)) {
        skipped.push({ path: rawTarget, reason: "binary-bytes" });
        continue;
      }
      const text = buf.toString("utf8");
      const lang = BUNDLE_CODE_LANG_BY_EXT[ext] || "text";
      if (bundle && targets.length > 1) {
        looseTextFiles.push({ absPath: abs, relPath: basename(abs), lang, content: text });
      } else if (countUnits(text) > HARD_MAX_WORDS) {
        const bundles = splitMarkdownBundles([{ relPath: basename(abs), lang, content: text }], {
          baseName: basename(abs),
          maxWords,
        });
        for (const b of bundles) {
          items.push({
            kind: "text",
            key: `file:${abs}:${b.displayName}`,
            displayName: b.displayName,
            mimeType: "text/markdown",
            content: b.markdown,
            bytes: b.bytes,
            units: b.units,
            sha256: b.sha256,
          });
        }
      } else {
        const isMd = lang === "markdown" || lang === "text";
        const content = isMd ? text : `# ${basename(abs)}\n\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
        items.push({
          kind: "text",
          key: `file:${abs}`,
          displayName: truncateDisplayName(basename(abs)),
          mimeType: ext === ".txt" ? "text/plain" : "text/markdown",
          content,
          bytes: Buffer.byteLength(content, "utf8"),
          units: countUnits(content),
          sha256: sha256Hex(content),
        });
      }
    } else {
      skipped.push({ path: rawTarget, reason: "unsupported-file-type" });
    }
  }

  if (looseTextFiles.length > 0) {
    const setHash = sha256Hex(looseTextFiles.map((f) => f.absPath).sort().join("\n")).slice(0, 8);
    const bundles = splitMarkdownBundles(looseTextFiles, { baseName: `Files Bundle (${setHash})`, maxWords });
    for (const b of bundles) {
      items.push({
        kind: "text",
        key: `bundle:files:${setHash}:${b.displayName}`,
        displayName: b.displayName,
        mimeType: "text/markdown",
        content: b.markdown,
        bytes: b.bytes,
        units: b.units,
        files: b.files,
        sha256: b.sha256,
      });
    }
  }

  return { items, skipped };
}

export async function executeIngest({
  client,
  stateStore,
  notebookTarget,
  items,
  dryRun = false,
  wait = true,
  fallbackFetch = true,
  allowUpdate = false,
  fetchImpl = fetch,
}) {
  let notebook;
  let notebookCreated = false;
  let existingSources = [];

  if (dryRun) {
    const existing = await client.listNotebooks();
    const match = notebookTarget.startsWith("notebooks/")
      ? existing.find((n) => n.name === notebookTarget)
      : existing.find((n) => n.displayName === notebookTarget);
    notebook = match || { name: `notebooks/<new:${notebookTarget}>`, displayName: notebookTarget };
    notebookCreated = !match;
    if (match) existingSources = await client.listSources(match.name);
  } else {
    const res = await client.ensureNotebook(notebookTarget);
    notebook = res.notebook;
    notebookCreated = res.created;
    existingSources = await client.listSources(notebook.name);
  }

  const isLiveState = (s) => s.state === "ACTIVE" || s.state === "PROCESSING";
  const activeUrls = new Set(
    existingSources.filter((s) => isLiveState(s) && s.originalUrl).map((s) => s.originalUrl),
  );
  const existingNames = new Set(existingSources.filter(isLiveState).map((s) => s.displayName));

  const actions = [];
  const pendingPolls = [];

  for (const item of items) {
    const prev = stateStore.getEntry(notebook.name, item.key);
    const liveActive = prev?.sourceName
      ? existingSources.some((s) => s.name === prev.sourceName && isLiveState(s))
      : false;

    if (item.kind === "url") {
      if (activeUrls.has(item.url) || (prev && (prev.state === "ACTIVE" || prev.state === "PROCESSING") && liveActive)) {
        actions.push({ key: item.key, action: "skip", reason: "already-active-url", url: item.url });
        continue;
      }
      if (dryRun) {
        actions.push({
          key: item.key,
          action: "plan",
          transport: item.preferFallback && fallbackFetch ? "fallback_fetch(markdown)" : "create_source(web)",
          url: item.url,
        });
        continue;
      }

      // Direct fallback for .md/.txt URLs (empirically proven unreachable via HTML crawler)
      if (item.preferFallback && fallbackFetch) {
        const fetched = await fetchUrlAsMarkdown(item.url, fetchImpl);
        const hash = sha256Hex(fetched.markdown);
        if (prev && prev.sha256 === hash && liveActive) {
          actions.push({ key: item.key, action: "skip", reason: "unchanged-fallback", url: item.url });
          continue;
        }
        const displayName = truncateDisplayName(item.displayName || `${fetched.title} (fetched)`);
        const res = await client.createTextSource(notebook.name, fetched.markdown, {
          displayName,
          mimeType: "text/markdown",
        });
        const rec = {
          key: item.key,
          action: "uploaded",
          transport: `fallback->${res.transport}`,
          sourceName: res.source.name,
          displayName,
          sha256: hash,
          uploadMs: res.elapsedMs,
        };
        stateStore.setEntry(notebook.name, item.key, {
          sourceName: res.source.name,
          displayName,
          sha256: hash,
          state: "PROCESSING",
          updatedAt: new Date().toISOString(),
        });
        actions.push(rec);
        pendingPolls.push({ rec, item, hash });
        continue;
      }

      const res = await client.createWebSource(notebook.name, item.url, item.displayName);
      const urlHash = sha256Hex(item.url);
      const rec = {
        key: item.key,
        action: "uploaded",
        transport: res.transport,
        sourceName: res.source.name,
        url: item.url,
        uploadMs: res.elapsedMs,
      };
      stateStore.setEntry(notebook.name, item.key, {
        sourceName: res.source.name,
        displayName: item.displayName || item.url,
        sha256: urlHash,
        state: "PROCESSING",
        updatedAt: new Date().toISOString(),
      });
      actions.push(rec);
      pendingPolls.push({ rec, item, hash: urlHash });
      continue;
    }

    // Text or binary file item
    if (prev && prev.sha256 === item.sha256 && liveActive) {
      actions.push({ key: item.key, action: "skip", reason: "unchanged", displayName: item.displayName });
      continue;
    }

    let targetName = item.displayName;
    if (prev && prev.sha256 !== item.sha256 && liveActive) {
      if (!allowUpdate) {
        actions.push({
          key: item.key,
          action: "skip",
          reason: "changed-needs-allow-update",
          displayName: item.displayName,
        });
        continue;
      }
      const tag = `${new Date().toISOString().slice(0, 10)}-${item.sha256.slice(0, 6)}`;
      targetName = truncateDisplayName(`${item.displayName} [v${tag}]`);
    } else if (!prev && existingNames.has(targetName) && !allowUpdate) {
      actions.push({
        key: item.key,
        action: "skip",
        reason: "displayName-exists-in-notebook",
        displayName: targetName,
      });
      continue;
    }

    if (dryRun) {
      const transport =
        item.kind === "text"
          ? item.bytes > MAX_INLINE_BYTES
            ? "upload(resumable)"
            : "create_source(text)"
          : item.bytes > SIMPLE_UPLOAD_MAX_BYTES
            ? "upload(resumable)"
            : "upload(media)";
      actions.push({
        key: item.key,
        action: "plan",
        transport,
        displayName: targetName,
        bytes: item.bytes,
        units: item.units ?? null,
        mimeType: item.mimeType,
      });
      continue;
    }

    const res =
      item.kind === "text"
        ? await client.createTextSource(notebook.name, item.content, {
            displayName: targetName,
            mimeType: item.mimeType,
          })
        : await client.uploadFileBytes(notebook.name, readFileSync(item.filePath), {
            displayName: targetName,
            mimeType: item.mimeType,
          });

    const rec = {
      key: item.key,
      action: "uploaded",
      transport: res.transport,
      sourceName: res.source.name,
      displayName: targetName,
      bytes: item.bytes,
      units: item.units ?? null,
      uploadMs: res.elapsedMs,
    };
    stateStore.setEntry(notebook.name, item.key, {
      sourceName: res.source.name,
      displayName: targetName,
      sha256: item.sha256,
      state: "PROCESSING",
      updatedAt: new Date().toISOString(),
    });
    actions.push(rec);
    pendingPolls.push({ rec, item, hash: item.sha256 });
  }

  if (wait && pendingPolls.length > 0) {
    await Promise.all(
      pendingPolls.map(async ({ rec, item, hash }) => {
        const polled = await client.waitForSource(rec.sourceName);
        rec.state = polled.source.state;
        rec.pollMs = polled.pollMs;
        rec.mimeType = polled.source.mimeType;
        rec.error = polled.source.error || null;

        // Automatic fallback fetch if a web URL failed as unreachable (code 9)
        if (
          item.kind === "url" &&
          !item.preferFallback &&
          fallbackFetch &&
          !isYouTubeUrl(item.url) &&
          rec.state === "FAILED" &&
          rec.error?.code === 9
        ) {
          try {
            const fetched = await fetchUrlAsMarkdown(item.url, fetchImpl);
            const fbHash = sha256Hex(fetched.markdown);
            const fbName = truncateDisplayName(item.displayName || `${fetched.title} (fallback)`);
            const fbRes = await client.createTextSource(notebook.name, fetched.markdown, {
              displayName: fbName,
              mimeType: "text/markdown",
            });
            stateStore.setEntry(notebook.name, item.key, {
              sourceName: fbRes.source.name,
              displayName: fbName,
              sha256: fbHash,
              state: "PROCESSING",
              updatedAt: new Date().toISOString(),
            });
            const fbPolled = await client.waitForSource(fbRes.source.name);
            rec.fallbackSourceName = fbRes.source.name;
            rec.state = fbPolled.source.state;
            rec.error = fbPolled.source.error || null;
            rec.transport = `${rec.transport}->fallback(${fbRes.transport})`;
            rec.displayName = fbName;
            stateStore.setEntry(notebook.name, item.key, {
              sourceName: fbRes.source.name,
              displayName: fbName,
              sha256: fbHash,
              state: fbPolled.source.state,
              updatedAt: new Date().toISOString(),
            });
            return;
          } catch (fbErr) {
            rec.fallbackError = fbErr.message;
          }
        }

        stateStore.setEntry(notebook.name, item.key, {
          sourceName: rec.sourceName,
          displayName: rec.displayName || polled.source.displayName || item.url,
          sha256: hash,
          state: rec.state,
          updatedAt: new Date().toISOString(),
        });
      }),
    );
  }

  return {
    notebook: { name: notebook.name, displayName: notebook.displayName || notebookTarget, created: notebookCreated },
    dryRun,
    actions,
    summary: {
      total: actions.length,
      uploaded: actions.filter((a) => a.action === "uploaded").length,
      active: actions.filter((a) => a.state === "ACTIVE").length,
      failed: actions.filter((a) => a.state === "FAILED").length,
      timedOut: actions.filter((a) => a.state === "TIMEOUT").length,
      skipped: actions.filter((a) => a.action === "skip").length,
      planned: actions.filter((a) => a.action === "plan").length,
    },
  };
}

export function buildBoardDigestMarkdown({ board, days = 7, boardBin = join(homedir(), ".cargo/bin/board") }) {
  const runBoard = (args) => {
    const res = spawnSync(boardBin, args, { encoding: "utf8", timeout: 15_000 });
    if (res.error || res.status !== 0) {
      const detail = (res.error?.message || res.stderr || res.stdout || `exit ${res.status}`).trim();
      throw new Error(`board ${args.join(" ")} failed: ${detail}`);
    }
    return res.stdout.trim();
  };
  const statusText = runBoard(["status", "--board", board]);
  const statsText = runBoard(["stats", "--days", String(Math.min(365, Math.max(1, Math.round(days))))]);
  const doneList = runBoard(["ls", "--board", board, "--status", "done", "--limit", "30"]);
  const doingList = runBoard(["ls", "--board", board, "--status", "doing", "--limit", "20"]);
  const blockedList = runBoard(["ls", "--board", board, "--status", "blocked", "--limit", "20"]);
  const dateTag = new Date().toISOString().slice(0, 10);

  return {
    displayName: `Board Digest: ${board} (${dateTag})`,
    markdown: [
      `# Work Board Briefing: \`${board}\` (${dateTag}, ${days}d stats + live snapshot)`,
      "",
      "## Board Status",
      "```text",
      statusText,
      "```",
      "",
      `## Global Board Activity (Last ${days} Days)`,
      "```text",
      statsText,
      "```",
      "",
      "## Active (Doing)",
      "```text",
      doingList || "(none)",
      "```",
      "",
      "## Blocked / Waiting",
      "```text",
      blockedList || "(none)",
      "```",
      "",
      "## Recently Completed (Top 30 Done)",
      "```text",
      doneList || "(none)",
      "```",
      "",
    ].join("\n"),
  };
}

export function parseCli(argv) {
  const positional = [];
  const explicit = new Set();
  const flags = {
    json: false,
    dryRun: false,
    wait: true,
    bundle: true,
    fallbackFetch: true,
    allowUpdate: false,
    stdin: false,
    owned: false,
    shared: false,
    failed: false,
    active: false,
    processing: false,
    maxWords: DEFAULT_BUNDLE_MAX_WORDS,
    rpm: 18,
    days: 7,
    name: null,
    board: null,
    notebook: null,
    help: false,
  };

  const nextValue = (flag, idx) => {
    if (idx + 1 >= argv.length || argv[idx + 1].startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return argv[idx + 1];
  };
  const nextPositiveInt = (flag, idx) => {
    const raw = nextValue(flag, idx);
    const num = Number(raw);
    if (!Number.isInteger(num) || num <= 0) {
      throw new Error(`Invalid positive integer for ${flag}: ${raw}`);
    }
    return num;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--wait") { flags.wait = true; explicit.add("wait"); }
    else if (a === "--no-wait") { flags.wait = false; explicit.add("wait"); }
    else if (a === "--bundle") { flags.bundle = true; explicit.add("bundle"); }
    else if (a === "--no-bundle") { flags.bundle = false; explicit.add("bundle"); }
    else if (a === "--fallback-fetch") { flags.fallbackFetch = true; explicit.add("fallbackFetch"); }
    else if (a === "--no-fallback-fetch") { flags.fallbackFetch = false; explicit.add("fallbackFetch"); }
    else if (a === "--allow-update") { flags.allowUpdate = true; explicit.add("allowUpdate"); }
    else if (a === "--stdin") flags.stdin = true;
    else if (a === "--owned") flags.owned = true;
    else if (a === "--shared") flags.shared = true;
    else if (a === "--failed") flags.failed = true;
    else if (a === "--active") flags.active = true;
    else if (a === "--processing") flags.processing = true;
    else if (a === "--max-words") { flags.maxWords = nextPositiveInt(a, i); i++; explicit.add("maxWords"); }
    else if (a === "--rpm") { flags.rpm = nextPositiveInt(a, i); i++; explicit.add("rpm"); }
    else if (a === "--days") { flags.days = nextPositiveInt(a, i); i++; explicit.add("days"); }
    else if (a === "--name") { flags.name = nextValue(a, i); i++; }
    else if (a === "--board") { flags.board = nextValue(a, i); i++; }
    else if (a === "--notebook") { flags.notebook = nextValue(a, i); i++; }
    else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
    else positional.push(a);
  }
  return { positional, flags, explicit };
}

function usage() {
  return `gnotebook — Official Gemini Notebook API pipeline CLI

Usage:
  gnotebook doctor [--json]
  gnotebook notebooks list [--owned|--shared] [--json]
  gnotebook notebooks ensure <displayName> [--json]
  gnotebook notebooks rename <notebook> <newName> [--json]
  gnotebook sources list <notebook> [--active|--processing|--failed] [--json]
  gnotebook ingest <notebook> [urls|files|dirs...] [options]
  gnotebook sync <manifest.json> [--dry-run] [--no-wait] [--allow-update] [--json]
  gnotebook digest --board <slug> --notebook <name> [--days 7] [--dry-run] [--json]

Ingest options:
  --bundle / --no-bundle          Bundle text/code files into structured Markdown (default: on)
  --max-words <n>                 Target units (words + CJK chars) per bundle (default: 150000, max: 450000)
  --fallback-fetch / --no-fallback-fetch
                                  Locally fetch non-HTML/unreachable public URLs as Markdown (default: on)
  --allow-update                  Ingest a new versioned copy when a local file/bundle changes
  --stdin --name <title>          Read Markdown/text from stdin
  --wait / --no-wait              Wait for PROCESSING -> ACTIVE/FAILED (default: on)
  --rpm <n>                       Write pacing rate limit (default: 18)
  --dry-run                       Show plan without writing to NotebookLM
  --json                          Machine-readable JSON output
`;
}

async function runDoctor({ client, env = process.env }) {
  const adcPath = client.adcPath;
  const clientPath = defaultClientPath(env);
  const mcpPath = join(homedir(), ".gemini/config/mcp_config.json");
  const checks = {
    adcExists: existsSync(adcPath),
    adcModeOctal: existsSync(adcPath) ? (statSync(adcPath).mode & 0o777).toString(8) : null,
    clientJsonExists: existsSync(clientPath),
    mcpConfigured: false,
    tokenRefreshOk: false,
    liveListNotebooksOk: false,
    notebookCount: null,
    quotaProjectSet: false,
    error: null,
  };

  if (existsSync(mcpPath)) {
    try {
      const cfg = JSON.parse(readFileSync(mcpPath, "utf8"));
      checks.mcpConfigured = cfg?.mcpServers?.["gemini-notebook"]?.serverUrl === "https://notebook.googleapis.com/mcp";
    } catch {
      checks.mcpConfigured = false;
    }
  }

  try {
    const auth = await client.getAuth(true);
    checks.tokenRefreshOk = Boolean(auth.token);
    checks.quotaProjectSet = Boolean(auth.projectId);
    const nbs = await client.listNotebooks();
    checks.liveListNotebooksOk = true;
    checks.notebookCount = nbs.length;
  } catch (err) {
    checks.error = err.message;
  }

  const ok = checks.adcExists && checks.tokenRefreshOk && checks.liveListNotebooksOk;
  return { ok, checks };
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags, explicit } = parseCli(argv);
  if (flags.help || positional.length === 0) {
    console.log(usage());
    return 0;
  }

  const client = new NotebookClient({ writeRpm: flags.rpm });
  const stateStore = new StateStore();
  const cmd = positional[0];

  if (cmd === "doctor") {
    const res = await runDoctor({ client });
    if (flags.json) console.log(JSON.stringify(res, null, 2));
    else {
      console.log(`Status: ${res.ok ? "OK" : "ERROR"}`);
      for (const [k, v] of Object.entries(res.checks)) console.log(`  ${k}: ${v}`);
    }
    return res.ok ? 0 : 1;
  }

  if (cmd === "notebooks") {
    const sub = positional[1] || "list";
    if (sub === "list") {
      const filter = flags.owned ? "notebook.is_owner = true" : flags.shared ? "notebook.is_owner = false" : null;
      const nbs = await client.listNotebooks({ filter });
      if (flags.json) console.log(JSON.stringify(nbs, null, 2));
      else {
        for (const n of nbs) console.log(`${n.name}\t${n.displayName || "(untitled)"}\t${n.createTime || ""}`);
        console.log(`Total: ${nbs.length}`);
      }
      return 0;
    }
    if (sub === "ensure") {
      const title = positional[2];
      if (!title) throw new Error("Usage: gnotebook notebooks ensure <displayName>");
      const res = await client.ensureNotebook(title);
      if (flags.json) console.log(JSON.stringify(res, null, 2));
      else console.log(`${res.created ? "CREATED" : "EXISTING"} ${res.notebook.name} (${res.notebook.displayName || title})`);
      return 0;
    }
    if (sub === "rename") {
      const [, , nb, newName] = positional;
      if (!nb || !newName) throw new Error("Usage: gnotebook notebooks rename <notebook> <newName>");
      const updated = await client.updateNotebook(nb, newName);
      if (flags.json) console.log(JSON.stringify(updated, null, 2));
      else console.log(`RENAMED ${updated.name} -> ${updated.displayName}`);
      return 0;
    }
    throw new Error(`Unknown notebooks subcommand: ${sub}`);
  }

  if (cmd === "sources") {
    const sub = positional[1] || "list";
    if (sub !== "list" || !positional[2]) throw new Error("Usage: gnotebook sources list <notebook>");
    const notebook = await client.findNotebook(positional[2]);
    let sources = await client.listSources(notebook.name);
    if (flags.failed) sources = sources.filter((s) => s.state === "FAILED");
    else if (flags.active) sources = sources.filter((s) => s.state === "ACTIVE");
    else if (flags.processing) sources = sources.filter((s) => s.state === "PROCESSING");
    if (flags.json) console.log(JSON.stringify(sources, null, 2));
    else {
      for (const s of sources) {
        const err = s.error ? ` [ERR ${s.error.code}: ${s.error.message}]` : "";
        console.log(`${s.state}\t${s.mimeType || "-"}\t${s.displayName || s.name}${err}`);
      }
      console.log(`Total: ${sources.length}`);
    }
    return 0;
  }

  if (cmd === "ingest") {
    const nbTarget = positional[1];
    const targets = positional.slice(2);
    if (!nbTarget || (targets.length === 0 && !flags.stdin)) {
      throw new Error("Usage: gnotebook ingest <notebook> [urls|files|dirs...] [--stdin --name <title>]");
    }
    const stdinText = flags.stdin ? readFileSync(0, "utf8") : null;
    const planned = planIngestItems({
      targets,
      stdinText,
      stdinName: flags.name,
      bundle: flags.bundle,
      maxWords: flags.maxWords,
    });
    const res = await executeIngest({
      client,
      stateStore,
      notebookTarget: nbTarget,
      items: planned.items,
      dryRun: flags.dryRun,
      wait: flags.wait,
      fallbackFetch: flags.fallbackFetch,
      allowUpdate: flags.allowUpdate,
    });
    res.skippedInputs = planned.skipped;
    if (flags.json) console.log(JSON.stringify(res, null, 2));
    else {
      console.log(`Notebook: ${res.notebook.displayName} (${res.notebook.name})${res.dryRun ? " [DRY RUN]" : ""}`);
      for (const a of res.actions) {
        const label = a.displayName || a.url || a.key;
        const st = a.state ? ` -> ${a.state}` : "";
        const reason = a.reason ? ` (${a.reason})` : "";
        const err = a.error ? ` [ERR ${a.error.code}: ${a.error.message}]` : "";
        console.log(`  [${a.action.toUpperCase()}] ${label} ${a.transport || ""}${st}${reason}${err}`);
      }
      console.log(
        `Summary: total=${res.summary.total} uploaded=${res.summary.uploaded} active=${res.summary.active} failed=${res.summary.failed} timedOut=${res.summary.timedOut} skipped=${res.summary.skipped} skippedInputs=${planned.skipped.length}`,
      );
    }
    return res.summary.failed > 0 || res.summary.timedOut > 0 ? 1 : 0;
  }

  if (cmd === "sync") {
    const manifestPath = positional[1];
    if (!manifestPath) throw new Error("Usage: gnotebook sync <manifest.json> [--dry-run]");
    const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
    if (!Array.isArray(manifest.notebooks)) throw new Error('Manifest must contain a "notebooks" array.');
    const manifestDir = dirname(resolve(manifestPath));
    const results = [];
    let anyFailed = false;

    for (const [idx, entry] of manifest.notebooks.entries()) {
      const nbTarget = entry?.name || entry?.notebook;
      if (!nbTarget || typeof nbTarget !== "string") {
        throw new Error(`Manifest entry #${idx} is missing a string "name" or "notebook" field.`);
      }
      const resolvedTargets = (entry.sources || []).map((s) =>
        isUrl(s) ? s : s.startsWith("~/") ? join(homedir(), s.slice(2)) : resolve(manifestDir, s),
      );
      const planned = planIngestItems({
        targets: resolvedTargets,
        bundle: explicit.has("bundle") ? flags.bundle : (entry.bundle ?? flags.bundle),
        maxWords: explicit.has("maxWords") ? flags.maxWords : (entry.maxWords ?? flags.maxWords),
      });
      const res = await executeIngest({
        client,
        stateStore,
        notebookTarget: nbTarget,
        items: planned.items,
        dryRun: flags.dryRun,
        wait: flags.wait,
        fallbackFetch: explicit.has("fallbackFetch") ? flags.fallbackFetch : (entry.fallbackFetch ?? flags.fallbackFetch),
        allowUpdate: explicit.has("allowUpdate") ? flags.allowUpdate : (entry.allowUpdate ?? flags.allowUpdate),
      });
      res.skippedInputs = planned.skipped;
      if (res.summary.failed > 0 || res.summary.timedOut > 0) anyFailed = true;
      results.push(res);
    }

    if (flags.json) console.log(JSON.stringify(results, null, 2));
    else {
      for (const r of results) {
        console.log(
          `${r.notebook.displayName}: uploaded=${r.summary.uploaded} active=${r.summary.active} failed=${r.summary.failed} timedOut=${r.summary.timedOut} skipped=${r.summary.skipped} planned=${r.summary.planned}`,
        );
      }
    }
    return anyFailed ? 1 : 0;
  }

  if (cmd === "digest") {
    if (!flags.board || !flags.notebook) {
      throw new Error("Usage: gnotebook digest --board <slug> --notebook <name> [--days 7] [--dry-run]");
    }
    const digest = buildBoardDigestMarkdown({ board: flags.board, days: flags.days });
    const planned = planIngestItems({
      stdinText: digest.markdown,
      stdinName: digest.displayName,
    });
    const res = await executeIngest({
      client,
      stateStore,
      notebookTarget: flags.notebook,
      items: planned.items,
      dryRun: flags.dryRun,
      wait: flags.wait,
      allowUpdate: flags.allowUpdate,
    });
    if (flags.json) console.log(JSON.stringify(res, null, 2));
    else console.log(`Digest ${digest.displayName}: ${JSON.stringify(res.summary)}`);
    return res.summary.failed > 0 || res.summary.timedOut > 0 ? 1 : 0;
  }

  throw new Error(`Unknown command: ${cmd}. Run "gnotebook --help".`);
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`gnotebook error: ${err.message}\n`);
      process.exit(1);
    });
}
