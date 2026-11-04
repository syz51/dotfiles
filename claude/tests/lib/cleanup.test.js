import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectName, removeSessionArtifacts } from "./cleanup.js";

let scratch;
let projects;
let claudeTmp;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cleanup-test-"));
  projects = join(scratch, "projects");
  claudeTmp = join(scratch, "claude-tmp");
  mkdirSync(projects);
  mkdirSync(claudeTmp);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const entry = (base, name, files = { "s.jsonl": "{}\n" }) => {
  mkdirSync(join(base, name), { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(base, name, file), content);
};

test("projectName replaces every non-alphanumeric character", () => {
  expect(projectName("/private/var/T/claude-live-a1B2c3/01_fix.x")).toBe("-private-var-T-claude-live-a1B2c3-01-fix-x");
});

test("removes entries for the root and paths inside it, and nothing else", () => {
  const root = "/private/var/T/claude-live-policy-Ab12Cd";
  const owned = [projectName(root), projectName(`${root}/python/fixture`), projectName(`${root}/python`)];
  const kept = [
    projectName("/private/var/T/claude-live-policy-Ab12Cdx"), // a different root sharing the prefix
    projectName("/Users/me/project"), projectName("/private/var/T/claude-live-policy"),
  ];
  for (const base of [projects, claudeTmp]) for (const name of [...owned, ...kept]) entry(base, name);
  const removed = removeSessionArtifacts({ bases: [projects, claudeTmp], roots: [root] });
  expect(removed.length).toBe(owned.length * 2);
  for (const base of [projects, claudeTmp]) expect(readdirSync(base).sort()).toEqual([...kept].sort());
});

test("for a session outside the roots, removes only its transcript and folder", () => {
  const cwd = "/Users/me/.config/nvim";
  entry(projects, projectName(cwd), { "mine.jsonl": "{}", "other.jsonl": "{}", "memory.md": "keep" });
  mkdirSync(join(projects, projectName(cwd), "mine", "subagents"), { recursive: true });
  removeSessionArtifacts({ bases: [projects], sessions: [{ cwd, id: "mine" }, { cwd, id: "../other" }, { cwd, id: undefined }] });
  expect(readdirSync(join(projects, projectName(cwd))).sort()).toEqual(["memory.md", "other.jsonl"]);
});

test("a symlinked entry is removed without following it, and missing bases are skipped", () => {
  const root = "/tmp/claude-live-x-Q1w2E3";
  const outside = join(scratch, "outside");
  entry(scratch, "outside", { "keep.txt": "keep" });
  symlinkSync(outside, join(projects, projectName(root)));
  removeSessionArtifacts({ bases: [projects, join(scratch, "absent")], roots: [root] });
  expect(lstatSync(join(projects, projectName(root)), { throwIfNoEntry: false })).toBeUndefined();
  expect(existsSync(join(outside, "keep.txt"))).toBe(true);
});
