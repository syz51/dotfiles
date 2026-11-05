// Sandbox profiles for unattended `claude -p` runs, passed with --settings. --settings sits
// above user and project settings, and Claude Code merges list keys across scopes, so a
// profile turns the sandbox on even when ~/.claude/settings.json has it off.
//
// sandbox-unattended.json: strict. Bash, PowerShell and Monitor commands run in the OS
// sandbox (Seatbelt on macOS), Claude Code exits if the sandbox cannot start, the
// dangerouslyDisableSandbox retry is ignored, network goes only to the hosts a use lists
// (strictAllowlist: other hosts are refused even in bypassPermissions), Bash writes go
// only to the working folder, the per-user temp folder and the paths a use lists, and
// common credential files are unreadable. The sandbox does not cover Claude's file and
// web tools, so the profile also confines Write/Edit/NotebookEdit to the working folders
// and denies WebFetch and WebSearch.
//
// maintainer-sandbox.json: draft for the codex-skills weekly review (not applied yet).
//
// Key names and semantics: code.claude.com/docs/en/settings-reference (sandbox.*,
// permissions.*) and code.claude.com/docs/en/sandboxing, checked against Claude Code
// 2.1.318.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UNATTENDED = join(import.meta.dir, "sandbox-unattended.json");
export const MAINTAINER = join(import.meta.dir, "maintainer-sandbox.json");

// Every settings key the profiles may use, each documented in the settings reference.
export const DOCUMENTED_KEYS = new Set([
  "$schema",
  "sandbox",
  "sandbox.enabled",
  "sandbox.failIfUnavailable",
  "sandbox.allowUnsandboxedCommands",
  "sandbox.autoAllowBashIfSandboxed",
  "sandbox.excludedCommands",
  "sandbox.enableWeakerNetworkIsolation",
  "sandbox.enableWeakerNestedSandbox",
  "sandbox.allowAppleEvents",
  "sandbox.network",
  "sandbox.network.allowedDomains",
  "sandbox.network.deniedDomains",
  "sandbox.network.strictAllowlist",
  "sandbox.network.allowLocalBinding",
  "sandbox.network.allowAllUnixSockets",
  "sandbox.network.allowUnixSockets",
  "sandbox.filesystem",
  "sandbox.filesystem.allowWrite",
  "sandbox.filesystem.denyWrite",
  "sandbox.filesystem.denyRead",
  "sandbox.filesystem.allowRead",
  "sandbox.filesystem.disabled",
  "permissions",
  "permissions.allow",
  "permissions.deny",
  "permissions.additionalDirectories",
  "permissions.blockWritesOutsideWorkingDirectories",
]);

// Dotted paths of every key in a settings object, objects included.
export function keyPaths(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...keyPaths(child, path)];
  });
}

export const readProfile = (path = UNATTENDED) => JSON.parse(readFileSync(path, "utf8"));

// The profile with one use's hosts and extra write paths added. Paths follow the sandbox
// prefixes: /abs, ~/home-relative; a relative path in --settings is not portable.
export function profileFor({ profile, allowedDomains = [], allowWrite = [] } = {}) {
  profile ??= readProfile();
  for (const path of allowWrite)
    if (!path.startsWith("/") && !path.startsWith("~/")) throw new Error(`allowWrite path must be absolute or start with ~/: ${path}`);
  const copy = structuredClone(profile);
  copy.sandbox.network.allowedDomains = [...new Set([...(copy.sandbox.network.allowedDomains ?? []), ...allowedDomains])];
  copy.sandbox.filesystem.allowWrite = [...new Set([...(copy.sandbox.filesystem.allowWrite ?? []), ...allowWrite])];
  return copy;
}

// Writes profileFor(options) to path for --settings and returns path.
export function writeProfile(path, options) {
  writeFileSync(path, `${JSON.stringify(profileFor(options), null, 2)}\n`);
  return path;
}
