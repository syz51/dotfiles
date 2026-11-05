// Reads of files in a session's working folder, bounded by a deadline. Such a read can
// block indefinitely: a background job (launchd) opening a file in a privacy-protected
// folder such as ~/Documents waits on macOS's consent check, and a hung network mount
// never answers. The read happens in a child process that is killed at the deadline.
import { spawnSync } from "node:child_process";

const reader = (maxChars) => `const fs = require("fs");
const out = {};
for (const path of JSON.parse(fs.readFileSync(0, "utf8"))) {
  try {
    out[path] = fs.readFileSync(path, "utf8").slice(0, ${maxChars});
  } catch (error) {
    out[path] = ["ENOENT", "ENOTDIR"].includes(error.code) ? null : { error: error.code ?? String(error) };
  }
}
process.stdout.write(JSON.stringify(out));`;

// A Map from each path to its text (up to maxChars), null when it does not exist, or
// { error } when it exists but cannot be read; or null for the whole call when the
// reads did not finish before the deadline.
export function readFilesWithDeadline(paths, { timeoutMs = 5000, maxChars = 50_000 } = {}) {
  const run = spawnSync(process.execPath, ["-e", reader(maxChars)], {
    input: JSON.stringify(paths), timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error?.code === "ETIMEDOUT" || run.signal) return null;
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`File reader exited ${run.status}: ${run.stderr.trim().slice(0, 300)}`);
  return new Map(Object.entries(JSON.parse(run.stdout)));
}
