import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUnchanged, snapshot } from "./filesystem.js";

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "filesystem-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("added, removed and changed files are caught; writable paths may change content", () => {
  writeFileSync(join(root, "a"), "one");
  writeFileSync(join(root, "b"), "two");
  const before = snapshot(root);
  writeFileSync(join(root, "a"), "changed");
  expect(() => assertUnchanged(before, snapshot(root))).toThrow("Unauthorized content change: a");
  assertUnchanged(before, snapshot(root), ["a"]);
  writeFileSync(join(root, "c"), "new");
  expect(() => assertUnchanged(before, snapshot(root), ["a"])).toThrow('added ["c"]');
  rmSync(join(root, "c"));
  rmSync(join(root, "b"));
  expect(() => assertUnchanged(before, snapshot(root), ["a"])).toThrow('removed ["b"]');
});

test("prototype names are ordinary file names", () => {
  const before = snapshot(root);
  for (const name of ["__proto__", "constructor", "toString"]) writeFileSync(join(root, name), "x");
  const after = snapshot(root);
  for (const name of ["__proto__", "constructor", "toString"]) expect(Object.hasOwn(after, name)).toBe(true);
  expect(() => assertUnchanged(before, after)).toThrow("Inventory changed");
  writeFileSync(join(root, "__proto__"), "y");
  expect(() => assertUnchanged(after, snapshot(root))).toThrow("content change: __proto__");
});

test("a same-byte symlink in a fixture is rejected", () => {
  mkdirSync(join(root, "fixture"));
  writeFileSync(join(root, "fixture", "a"), "same");
  writeFileSync(join(root, "outside"), "same");
  rmSync(join(root, "fixture", "a"));
  symlinkSync(join(root, "outside"), join(root, "fixture", "a"));
  expect(() => snapshot(join(root, "fixture"))).toThrow("Unexpected symlink: a");
});

test("mode changes, including setuid and sticky bits, are caught", () => {
  mkdirSync(join(root, "folder"));
  writeFileSync(join(root, "file"), "x");
  chmodSync(join(root, "file"), 0o644);
  chmodSync(join(root, "folder"), 0o755);
  const before = snapshot(root);
  chmodSync(join(root, "file"), 0o4644);
  expect(snapshot(root).file.mode).toBe(0o4644);
  expect(() => assertUnchanged(before, snapshot(root), ["file"])).toThrow("mode or link changed: file");
  chmodSync(join(root, "file"), 0o644);
  chmodSync(join(root, "folder"), 0o1755);
  expect(() => assertUnchanged(before, snapshot(root))).toThrow("mode or link changed: folder");
});

test("an installed link is followed at its root and a retarget is caught", () => {
  for (const release of ["a", "b"]) {
    mkdirSync(join(root, release));
    writeFileSync(join(root, release, "SKILL.md"), "same");
  }
  symlinkSync(join(root, "a"), join(root, "skill"));
  const options = { allowLinks: true, followRoot: true };
  const before = snapshot(join(root, "skill"), options);
  expect(before["SKILL.md"].kind).toBe("file");
  rmSync(join(root, "skill"));
  symlinkSync(join(root, "b"), join(root, "skill"));
  expect(() => assertUnchanged(before, snapshot(join(root, "skill"), options))).toThrow("mode or link changed: .");
});

test("links inside an allowed tree are compared by target, and ignored names are skipped", () => {
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "big"), "x");
  symlinkSync("one", join(root, "link"));
  const options = { allowLinks: true, ignore: new Set(["node_modules"]) };
  const before = snapshot(root, options);
  expect(Object.keys(before).sort()).toEqual([".", "link"]);
  writeFileSync(join(root, "node_modules", "big"), "changed");
  rmSync(join(root, "link"));
  symlinkSync("two", join(root, "link"));
  expect(() => assertUnchanged(before, snapshot(root, options))).toThrow("mode or link changed: link");
});
