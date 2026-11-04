// Which guidance files (skill directories, preference files) a session actually read.
// A successful Read call, or a literal `cat` of absolute paths, is a read; a failed
// one is not. Another successful Bash call that names a file and printed its whole
// content also read it (the harness proves guidance files do not change during a run).
// Any Bash, Grep or Glob call that touches a target other than by literal `cat` might
// have read more than this can attribute, so it blocks a claim that the target was not
// read.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { commandLists } from "./command.js";
import { bashRuns, fileReads, toolUses } from "./stream.js";

const canonical = (path) => existsSync(path) ? realpathSync(path) : resolve(path);

// specs: { name: path } of a skill directory or a single file. Each target keeps the
// spellings a command may use for it: the given path, the symlink chain and the
// resolved path, each also with `~` and `$HOME` for the home directory.
export function guidanceTargets(specs, home = homedir()) {
  return Object.entries(specs).map(([name, path]) => {
    const spellings = new Set([path, canonical(path)]);
    for (let link = path; lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink();) {
      link = resolve(dirname(link), readlinkSync(link));
      spellings.add(link);
    }
    for (const spelling of [...spellings])
      if (spelling.startsWith(home + sep)) {
        spellings.add(`~${spelling.slice(home.length)}`);
        spellings.add(`$HOME${spelling.slice(home.length)}`);
      }
    return { name, root: canonical(path), spellings: [...spellings] };
  });
}

// The target and target-relative file a path falls in ("" for a single-file target).
function locate(targets, path) {
  const real = canonical(path);
  for (const target of targets) {
    if (real === target.root) return { target: target.name, file: "" };
    if (real.startsWith(target.root + sep)) return { target: target.name, file: relative(target.root, real) };
  }
  return null;
}

// Files of a target that a command names: the target itself for a file, otherwise the
// files whose name appears in the command.
function namedFiles(target, command) {
  if (!lstatSync(target.root).isDirectory()) return [target.root];
  return readdirSync(target.root, { recursive: true })
    .map((path) => join(target.root, path))
    .filter((path) => lstatSync(path).isFile() && command.includes(basename(path)));
}

// Whether output holds the file's whole content; trivially short files never qualify.
function printed(output, path) {
  const content = readFileSync(path, "utf8").trim();
  return content.length >= 20 && output.includes(content);
}

const mentions = (targets, text) => targets.filter((target) => target.spellings.some((spelling) => text.includes(spelling)));

export function guidanceEvidence(events, targets) {
  const reads = [];
  const uncertain = [];
  for (const read of fileReads(events)) {
    const found = read.ok && typeof read.path === "string" ? locate(targets, read.path) : null;
    if (found) reads.push({ ...found, complete: read.complete, parent: read.parent, via: "Read" });
  }
  for (const run of bashRuns(events)) {
    const touched = mentions(targets, run.command);
    if (!touched.length) continue;
    const lists = commandLists(run.command);
    const cat = lists?.length === 1 && lists[0][0] === "cat" && lists[0].length > 1
      && lists[0].slice(1).every((word) => word.startsWith("/")) ? lists[0].slice(1) : null;
    if (!cat) {
      for (const target of touched) {
        uncertain.push({ target: target.name, parent: run.parent, detail: run.command });
        if (run.ok)
          for (const path of namedFiles(target, run.command).filter((path) => printed(run.output, path)))
            reads.push({ ...locate(targets, path), complete: true, parent: run.parent, via: "output" });
      }
      continue;
    }
    if (!run.ok) continue;
    for (const path of cat) {
      const found = locate(targets, path);
      if (found) reads.push({ ...found, complete: true, parent: run.parent, via: "cat" });
    }
  }
  for (const use of toolUses(events).filter((use) => ["Grep", "Glob"].includes(use.name)))
    for (const target of mentions(targets, JSON.stringify(use.input)))
      uncertain.push({ target: target.name, parent: use.parent, detail: `${use.name} ${JSON.stringify(use.input)}` });
  return { reads, uncertain };
}

const describe = ({ target, file }) => file ? `${target}/${file}` : target;
const covers = (rule, entry) => entry.target === rule.target && (rule.file === undefined || entry.file === rule.file);

// Failures against the rules, over the whole run including subagents. required and
// forbidden hold { target, file? }; a rule without file covers the whole target.
export function scoreGuidance({ reads, uncertain }, { required = [], forbidden = [] }) {
  const failures = [];
  for (const rule of required)
    if (!reads.some((read) => read.complete && covers(rule, read)))
      failures.push(`Required guidance was not read completely: ${describe(rule)}`);
  for (const rule of forbidden) {
    for (const read of reads.filter((read) => covers(rule, read)))
      failures.push(`${read.parent ? "Subagent" : "Main session"}: forbidden guidance was read: ${describe(read)}`);
    for (const entry of uncertain.filter((entry) => entry.target === rule.target))
      failures.push(`Cannot rule out a read of forbidden guidance ${describe(rule)}: ${entry.detail}`);
  }
  return [...new Set(failures)];
}
