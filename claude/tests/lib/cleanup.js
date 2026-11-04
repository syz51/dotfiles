// Removal of what test sessions leave in Claude Code's own folders. Only entries
// derived from the test's own paths qualify; everything else is left alone.
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Claude Code names a project folder after its path, every character other than an
// ASCII letter or digit replaced with "-".
export const projectName = (path) => path.replace(/[^a-zA-Z0-9]/g, "-");

const entries = (dir) => existsSync(dir) ? readdirSync(dir) : [];

// Removes, from each folder in bases (such as ~/.claude/projects and Claude Code's temp
// folder), the entries named after a temporary root or a path inside it, and for each
// session that ran outside the roots only that session's own transcript and folder.
// roots must be unique temporary folders (mkdtemp); sessions are { cwd, id }.
// Returns the removed paths.
export function removeSessionArtifacts({ bases, roots = [], sessions = [] }) {
  const removed = [];
  const remove = (path) => {
    if (!lstatSync(path, { throwIfNoEntry: false })) return;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  };
  const prefixes = roots.map(projectName);
  for (const base of bases) {
    for (const name of entries(base))
      if (prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}-`))) remove(join(base, name));
    for (const { cwd, id } of sessions) {
      if (typeof id !== "string" || !/^[\w-]+$/.test(id)) continue;
      const project = join(base, projectName(cwd));
      remove(join(project, `${id}.jsonl`));
      remove(join(project, id));
    }
  }
  return removed;
}
