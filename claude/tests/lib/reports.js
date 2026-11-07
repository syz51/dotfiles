// Run reports and cost accounting for live sessions.
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// Where a live check keeps the evidence of a failed case: CLAUDE_LIVE_REPORT_DIR when set,
// else claude-live-failures in the temp folder, so a rare failure is kept even when no one
// asked for reports. It holds transcripts; delete it when done.
export const failureDirectory = (env = process.env, root = tmpdir()) =>
  reportDirectory(root, env.CLAUDE_LIVE_REPORT_DIR || join(root, "claude-live-failures"));

// Creates target as a folder strictly inside root and returns its real path. Rejects a
// target outside root, root itself, and any existing component that is a symlink or not
// a folder, so a report can never be written through a link out of the temp folder.
export function reportDirectory(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Report folder must be inside ${root}: ${target}`);
  let current = realpathSync(root);
  for (const part of rel.split("/")) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) mkdirSync(current);
    else if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe report folder: ${current}`);
  }
  return current;
}

export function writeReport(dir, name, report, stream) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  writeFileSync(join(dir, `${base}.json`), `${JSON.stringify(report, null, 2)}\n`);
  if (stream !== undefined) writeFileSync(join(dir, `${base}.stream.jsonl`), stream);
}

// Cost and duration of each session in one suite.
export class Ledger {
  constructor(suite) {
    this.suite = suite;
    this.runs = [];
  }

  record(run) {
    this.runs.push({ cost: 0, ...run });
  }

  get total() {
    return this.runs.reduce((sum, run) => sum + run.cost, 0);
  }

  summary() {
    const lines = this.runs.map((run) =>
      `  ${run.label}: ${run.model}/${run.effort}, ${(run.durationMs / 1000).toFixed(1)} s, $${run.cost.toFixed(4)}${run.status === "ok" ? "" : ` (${run.status})`}`);
    return [`${this.suite}: ${this.runs.length} sessions, total $${this.total.toFixed(4)}`, ...lines].join("\n");
  }
}
