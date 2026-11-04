// Typed filesystem snapshots, to prove which side effects a session had.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Every entry under root by relative path ("." for root): its kind, permission bits
// including setuid/setgid/sticky, and a content hash for files or a target for links.
// The inventory has no prototype, so file names such as __proto__ are ordinary keys.
// A fixture must not gain links, so links throw unless allowLinks; a followRoot snapshot
// describes what a symlinked root (such as an installed skill) points to. Entries named
// in ignore (such as node_modules) are skipped with their contents.
export function snapshot(root, { allowLinks = false, followRoot = false, ignore = new Set() } = {}) {
  const base = followRoot ? realpathSync(root) : root;
  const tree = Object.create(null);
  const walk = (path) => {
    const info = lstatSync(path);
    const key = relative(base, path) || ".";
    const entry = { kind: "other", mode: info.mode & 0o7777 };
    if (info.isSymbolicLink()) {
      if (!allowLinks) throw new Error(`Unexpected symlink: ${key}`);
      Object.assign(entry, { kind: "link", target: readlinkSync(path) });
    } else if (info.isFile()) Object.assign(entry, { kind: "file", sha256: sha256(readFileSync(path)) });
    else if (info.isDirectory()) entry.kind = "directory";
    else throw new Error(`Unexpected file type: ${key}`);
    tree[key] = entry;
    if (entry.kind === "directory")
      for (const name of readdirSync(path)) if (!ignore.has(name)) walk(join(path, name));
  };
  walk(base);
  if (followRoot) tree["."].resolved = base;
  return tree;
}

// Throws on any difference except content changes to the writable paths.
export function assertUnchanged(before, after, writable = []) {
  const keys = (tree) => JSON.stringify(Object.keys(tree).sort());
  if (keys(before) !== keys(after)) {
    const added = Object.keys(after).filter((key) => !(key in before));
    const removed = Object.keys(before).filter((key) => !(key in after));
    throw new Error(`Inventory changed: added ${JSON.stringify(added)}, removed ${JSON.stringify(removed)}`);
  }
  for (const key of Object.keys(before)) {
    const [a, b] = [before[key], after[key]];
    if (a.kind !== b.kind || a.mode !== b.mode || a.target !== b.target || a.resolved !== b.resolved)
      throw new Error(`Type, mode or link changed: ${key}`);
    if (a.sha256 !== b.sha256 && !writable.includes(key)) throw new Error(`Unauthorized content change: ${key}`);
  }
}
