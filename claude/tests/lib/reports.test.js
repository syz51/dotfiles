import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, reportDirectory, writeReport } from "./reports.js";

let root;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "reports-test-")));
  mkdirSync(join(root, "scratch"));
  mkdirSync(join(root, "outside"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("report folders stay inside the temp folder", () => {
  const scratch = join(root, "scratch");
  symlinkSync(join(root, "outside"), join(scratch, "link"));
  writeFileSync(join(scratch, "file"), "x");
  expect(() => reportDirectory(scratch, join(root, "outside", "new"))).toThrow("must be inside");
  expect(() => reportDirectory(scratch, scratch)).toThrow("must be inside");
  expect(() => reportDirectory(scratch, join(scratch, "link", "new"))).toThrow("Unsafe");
  expect(() => reportDirectory(scratch, join(scratch, "file", "new"))).toThrow("Unsafe");
  expect(reportDirectory(scratch, join(scratch, "a", "b"))).toBe(join(scratch, "a", "b"));
});

test("reports are named after the scenario", () => {
  writeReport(join(root, "scratch"), "Python checks run through `uv run`", { status: "passed" }, "{}\n");
  expect(JSON.parse(readFileSync(join(root, "scratch", "python-checks-run-through-uv-run.json"), "utf8"))).toEqual({ status: "passed" });
  expect(readFileSync(join(root, "scratch", "python-checks-run-through-uv-run.stream.jsonl"), "utf8")).toBe("{}\n");
});

test("the ledger totals cost and lists each session", () => {
  const ledger = new Ledger("policy");
  ledger.record({ label: "a", model: "m", effort: "low", durationMs: 1500, cost: 0.25, status: "ok" });
  ledger.record({ label: "b", model: "m", effort: "low", durationMs: 500, status: "timeout" });
  expect(ledger.total).toBe(0.25);
  expect(ledger.summary()).toBe([
    "policy: 2 sessions, total $0.2500",
    "  a: m/low, 1.5 s, $0.2500",
    "  b: m/low, 0.5 s, $0.0000 (timeout)",
  ].join("\n"));
});
