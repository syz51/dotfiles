import { readdir, lstat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { hash } from "./evidence.js";
export async function typedSnapshot(root) {
  const tree = Object.create(null);
  async function walk(path) {
    const info = await lstat(path),
      key = relative(root, path) || ".";
    if (info.isSymbolicLink())
      throw Error(`Unexpected fixture symlink: ${key}`);
    if (!info.isDirectory() && !info.isFile())
      throw Error(`Unexpected fixture type: ${key}`);
    tree[key] = {
      kind: info.isDirectory() ? "directory" : "file",
      mode: info.mode & 0o7777,
      sha256: info.isFile() ? hash(await readFile(path)) : null,
    };
    if (info.isDirectory())
      for (const name of await readdir(path)) await walk(join(path, name));
  }
  await walk(root);
  return tree;
}
export function assertFixtureMetadata(before, after, writable = []) {
  if (
    JSON.stringify(Object.keys(before).sort()) !==
    JSON.stringify(Object.keys(after).sort())
  )
    throw Error("Fixture inventory changed");
  for (const key of Object.keys(before)) {
    const a = before[key],
      b = after[key];
    if (a.kind !== b.kind || a.mode !== b.mode)
      throw Error(`Fixture type or mode changed: ${key}`);
    if (!writable.includes(key) && a.sha256 !== b.sha256)
      throw Error(`Unauthorized fixture content change: ${key}`);
  }
}
