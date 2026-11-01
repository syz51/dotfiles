import { test, expect } from "bun:test";
import {
  mkdtemp,
  writeFile,
  mkdir,
  symlink,
  rm,
  chmod,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { typedSnapshot, assertFixtureMetadata } from "./lib/filesystem.js";
import { reportDirectory } from "./lib/reports.js";
test("filesystem inventory treats prototype names as ordinary file names", async () => {
  const root = await mkdtemp(
    join(process.env.TMPDIR || tmpdir(), "inventory-test-"),
  );
  try {
    const before = await typedSnapshot(root);
    for (const name of ["__proto__", "constructor", "toString"]) {
      await writeFile(join(root, name), "unexpected");
    }
    const after = await typedSnapshot(root);
    for (const name of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(after, name)).toBe(true);
    }
    expect(() => assertFixtureMetadata(before, after)).toThrow("inventory");
    await writeFile(join(root, "__proto__"), "changed");
    const changed = await typedSnapshot(root);
    expect(() => assertFixtureMetadata(after, changed)).toThrow("content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("real filesystem snapshots reject same-byte symlinks and mode changes", async () => {
  const root = await mkdtemp(
    join(process.env.TMPDIR || tmpdir(), "typed-test-"),
  );
  try {
    await mkdir(join(root, "fixture"));
    await writeFile(join(root, "fixture/a"), "same");
    await writeFile(join(root, "outside"), "same");
    const before = await typedSnapshot(join(root, "fixture"));
    await rm(join(root, "fixture/a"));
    await symlink(join(root, "outside"), join(root, "fixture/a"));
    await expect(typedSnapshot(join(root, "fixture"))).rejects.toThrow(
      "symlink",
    );
    await rm(join(root, "fixture/a"));
    await writeFile(join(root, "fixture/a"), "same");
    await chmod(join(root, "fixture/a"), 0o400);
    expect(() =>
      assertFixtureMetadata(before, {
        ...before,
        a: { ...before.a, mode: 0o400 },
      }),
    ).toThrow("mode");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("real filesystem guards preserve special permission bits on files and directories", async () => {
  const root = await mkdtemp(
    join(process.env.TMPDIR || tmpdir(), "special-mode-"),
  );
  try {
    await mkdir(join(root, "folder"));
    await chmod(join(root, "folder"), 0o755);
    await writeFile(join(root, "file"), "unchanged");
    await chmod(join(root, "file"), 0o644);
    const before = await typedSnapshot(root);
    await chmod(join(root, "file"), 0o4644);
    const changed = await typedSnapshot(root);
    expect(changed.file.mode).toBe(0o4644);
    expect(() => assertFixtureMetadata(before, changed)).toThrow("mode");
    await chmod(join(root, "file"), 0o644);
    await chmod(join(root, "folder"), 0o1755);
    const directory = await typedSnapshot(root);
    expect(directory.folder.mode).toBe(0o1755);
    expect(() => assertFixtureMetadata(before, directory)).toThrow("mode");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("report destinations reject outside paths and symlink escapes", async () => {
  const root = await mkdtemp(
    join(process.env.TMPDIR || tmpdir(), "report-test-"),
  );
  try {
    await mkdir(join(root, "scratch"));
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(root, "scratch/link"));
    await expect(
      reportDirectory(join(root, "scratch"), join(root, "outside/new")),
    ).rejects.toThrow();
    await expect(
      reportDirectory(join(root, "scratch"), join(root, "scratch/link/new")),
    ).rejects.toThrow();
    expect(
      await reportDirectory(
        join(root, "scratch"),
        join(root, "scratch/report"),
      ),
    ).toBe(await realpath(join(root, "scratch/report")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
