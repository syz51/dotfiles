import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DOCUMENTED_KEYS, keyPaths, MAINTAINER, profileFor, readProfile, UNATTENDED } from "./sandbox.js";

const PROFILES = { unattended: UNATTENDED, maintainer: MAINTAINER };

describe("sandbox profiles", () => {
  for (const [name, path] of Object.entries(PROFILES)) {
    test(`${name} is valid JSON using only documented settings keys`, () => {
      const profile = JSON.parse(readFileSync(path, "utf8"));
      expect(keyPaths(profile).filter((key) => !DOCUMENTED_KEYS.has(key))).toEqual([]);
    });

    test(`${name} is strict: sandbox required, no escape, strict network, file tools confined`, () => {
      const { sandbox, permissions } = readProfile(path);
      expect(sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, excludedCommands: [] });
      expect(sandbox.network).toMatchObject({ strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false });
      expect(sandbox.network.allowedDomains).not.toContain("*");
      expect(sandbox.filesystem.disabled).toBeUndefined();
      expect(sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(["~/.ssh", "~/.aws", "~/.config/gh", "~/.claude.json"]));
      for (const entry of [...sandbox.filesystem.allowWrite, ...sandbox.filesystem.denyRead])
        expect(entry.startsWith("~/") || entry.startsWith("/")).toBe(true);
      expect(permissions.blockWritesOutsideWorkingDirectories).toBe(true);
    });
  }

  test("the unattended profile lists no hosts or extra write paths of its own", () => {
    const { sandbox, permissions } = readProfile(UNATTENDED);
    expect(sandbox.network.allowedDomains).toEqual([]);
    expect(sandbox.filesystem.allowWrite).toEqual([]);
    expect(permissions.deny).toEqual(["WebFetch", "WebSearch"]);
  });

  test("the maintainer profile allows the review's hosts and state folders, not the canonical checkout", () => {
    const { sandbox } = readProfile(MAINTAINER);
    expect(sandbox.network.allowedDomains).toEqual(expect.arrayContaining(["github.com", "docs.rs", "crates.io", "static.crates.io", "index.crates.io", "pypi.org", "files.pythonhosted.org"]));
    expect(sandbox.filesystem.allowWrite).toEqual(expect.arrayContaining(["~/.local/share/agent-skills/investigations", "~/.cache/agent-skills", "~/.cache/uv"]));
    expect(sandbox.filesystem.allowWrite.some((path) => path === "~/.local/share/agent-skills" || path.includes("repository"))).toBe(false);
  });

  test("profileFor adds one use's hosts and write paths without changing the file", () => {
    const before = readFileSync(UNATTENDED, "utf8");
    const profile = profileFor({ allowedDomains: ["github.com", "github.com"], allowWrite: ["~/out", "/tmp/x"] });
    expect(profile.sandbox.network.allowedDomains).toEqual(["github.com"]);
    expect(profile.sandbox.filesystem.allowWrite).toEqual(["~/out", "/tmp/x"]);
    expect(readFileSync(UNATTENDED, "utf8")).toBe(before);
    expect(() => profileFor({ allowWrite: ["relative/dir"] })).toThrow("absolute or start with ~/");
  });
});
