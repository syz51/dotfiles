import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { owned } from "./evidence.js";

// Cleanup ownership is independent of trace validity. Only the first metadata
// record is used here; these entries must never be passed to scoring functions.
export async function cleanupEntries(root, before, fixture) {
  const entries = [];
  for await (const name of new Bun.Glob("**/*.jsonl").scan(root)) {
    if (before.has(name)) continue;
    let source;
    try {
      source = await readFile(join(root, name), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    try {
      const metadata = JSON.parse(source.split(/\r?\n/, 1)[0]);
      if (owned([metadata], fixture))
        entries.push({ name, records: [metadata] });
    } catch {
      // Missing or malformed ownership metadata is never deletion authority.
    }
  }
  return entries;
}
