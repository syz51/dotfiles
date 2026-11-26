import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

// Structural hygiene checks for this public repository. Rules match generic private-infra
// shapes (tailnet names/IPs, Vault KV secret paths, non-placeholder Cloud MCP hosts,
// personal mail addresses outside license texts, and machine hostnames) without embedding
// any real personal identifiers in tracked source code.
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|tar|gz|mp3|mp4|ogg)$/i;
const SELF = "claude/tests/public-hygiene.test.js";

const RULES = [
  {
    label: "non-placeholder Tailscale hostname",
    re: /\b(?!example\.ts\.net\b|your-tailnet\.ts\.net\b|tailnet\.ts\.net\b|test\.ts\.net\b)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/i,
  },
  {
    label: "Tailscale CGNAT IP",
    re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
  },
  {
    label: "HashiCorp Vault KV secret path or operator cert path",
    re: /\bkv\/data\/[^\s"'`]+|vault-operator\b/i,
  },
  {
    label: "non-placeholder board-mcp public host",
    re: /\bboard-mcp\.(?!example\.(?:com|org|net|invalid)\b|your-[a-z0-9-]+\b)[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i,
  },
  {
    label: "Windows machine hostname",
    re: /\bDESKTOP-[A-Z0-9]{7}\b/,
  },
  {
    label: "macOS MacBook hostname",
    re: /\b[A-Za-z0-9_-]*MacBook[A-Za-z0-9_-]*\.(?:local|ts\.net)\b/i,
  },
  {
    label: "personal consumer email outside LICENSES/",
    re: /\b[A-Za-z0-9._%+-]+@(?:gmail|icloud|outlook|hotmail|qq|163)\.com\b/i,
    skipPath: (rel) => rel.startsWith("LICENSES/") || rel.includes("/LICENSES/"),
  },
];

describe("public repository hygiene", () => {
  test("tracked files contain no tailnet names/IPs, Vault KV paths, live board-mcp URLs, machine hostnames, or personal emails", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    expect(tracked.length).toBeGreaterThan(50);

    const violations = [];
    for (const rel of tracked) {
      if (rel === SELF || BINARY_EXT.test(rel)) continue;
      const full = join(REPO, rel);
      const stat = lstatSync(full);
      if (!stat.isFile()) continue;
      const raw = readFileSync(full);
      if (raw.includes(0)) continue;
      const lines = raw.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const rule of RULES) {
          if (rule.skipPath?.(rel)) continue;
          if (rule.re.test(lines[i])) {
            violations.push(`${rel}:${i + 1} (${rule.label})`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
