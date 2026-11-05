import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFilesWithDeadline } from "./probe.js";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-factory-probe-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("reads files, reports missing and unreadable ones, and clips text", () => {
  writeFileSync(join(dir, "a.md"), "hello world");
  writeFileSync(join(dir, "locked"), "secret");
  chmodSync(join(dir, "locked"), 0o000);
  const read = readFilesWithDeadline([join(dir, "a.md"), join(dir, "missing"), join(dir, "locked")], { maxChars: 5 });
  expect(read.get(join(dir, "a.md"))).toBe("hello");
  expect(read.get(join(dir, "missing"))).toBeNull();
  expect(read.get(join(dir, "locked"))).toEqual({ error: "EACCES" });
});

test("a read that blocks returns null at the deadline instead of hanging", () => {
  // Opening a FIFO with no writer blocks, like a privacy check or a hung mount.
  const fifo = join(dir, "fifo");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  const started = Date.now();
  expect(readFilesWithDeadline([fifo], { timeoutMs: 500 })).toBeNull();
  expect(Date.now() - started).toBeLessThan(3000);
});
