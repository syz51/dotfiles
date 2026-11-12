// Benchmark cases: loading and validation of bench/cases/<id>/case.json, and the
// fixture each run works in. A case has:
//   id, title, role (main, explorer or worker), prompt
//   fixture  { type: "files", dir } — a folder in the case — or
//            { type: "git", repo, commit } — repo "." is the repository holding the case,
//            other relative paths are relative to the case folder; either may add
//            overlay, a folder in the case copied over the fixture (and again before
//            the oracle, so edited tests do not count)
//   oracle   { command, timeoutMs } — sh -c in the fixture after the session, with
//            FINAL_ANSWER_FILE naming the session's final text; exit 0 passes
//   budgetUsd, timeoutMs for the session
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const ROLES = ["main", "explorer", "worker"];
export const CASES_DIR = join(import.meta.dir, "cases");
const KEYS = ["id", "title", "role", "prompt", "fixture", "oracle", "budgetUsd", "timeoutMs"];
const ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA = /^[0-9a-f]{7,40}$/;

// Runs git synchronously; fails with its stderr.
export function git(cwd, ...args) {
  const run = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

const isDir = (path) => existsSync(path) && statSync(path).isDirectory();
const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const positiveInt = (value) => Number.isInteger(value) && value > 0;

// The repository a git fixture names: "." is the repository containing the case, other
// relative paths are relative to the case folder.
function repoPath(repo, dir) {
  if (repo === ".") return git(dir, "rev-parse", "--show-toplevel").trim();
  return isAbsolute(repo) ? repo : resolve(dir, repo);
}

// A validated case with absolute paths: fixture.source (files), fixture.repoPath (git),
// fixture.overlayPath. Every problem is reported at once, prefixed with the file path.
export function validateCase(value, file) {
  const dir = dirname(file);
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file}: expected a JSON object`);
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) errors.push(`unknown key ${JSON.stringify(key)}`);
  if (!nonEmpty(value.id) || !ID.test(value.id)) errors.push("id must be lowercase letters, digits and dashes");
  else if (value.id !== dir.split("/").at(-1)) errors.push(`id ${JSON.stringify(value.id)} must match its folder name`);
  if (!nonEmpty(value.title)) errors.push("title must be a non-empty string");
  if (!ROLES.includes(value.role)) errors.push(`role must be one of ${ROLES.join(", ")}`);
  if (!nonEmpty(value.prompt)) errors.push("prompt must be a non-empty string");
  if (!positive(value.budgetUsd)) errors.push("budgetUsd must be a positive number");
  if (!positiveInt(value.timeoutMs)) errors.push("timeoutMs must be a positive integer");
  const oracle = value.oracle;
  if (!oracle || typeof oracle !== "object" || !nonEmpty(oracle.command) || !positiveInt(oracle.timeoutMs))
    errors.push("oracle must be { command: string, timeoutMs: positive integer }");
  const fixture = { ...value.fixture };
  if (fixture.overlay !== undefined) {
    if (!nonEmpty(fixture.overlay) || !isDir(join(dir, fixture.overlay))) errors.push(`fixture.overlay ${JSON.stringify(fixture.overlay)} must be a folder in the case`);
    else fixture.overlayPath = join(dir, fixture.overlay);
  }
  if (fixture.type === "files") {
    if (!nonEmpty(fixture.dir) || !isDir(join(dir, fixture.dir))) errors.push(`fixture.dir ${JSON.stringify(fixture.dir)} must be a folder in the case`);
    else fixture.source = join(dir, fixture.dir);
  } else if (fixture.type === "git") {
    if (!nonEmpty(fixture.repo)) errors.push("fixture.repo must be a path");
    else if (!nonEmpty(fixture.commit) || !SHA.test(fixture.commit)) errors.push("fixture.commit must be a commit SHA");
    else {
      try {
        fixture.repoPath = repoPath(fixture.repo, dir);
        git(fixture.repoPath, "cat-file", "-e", `${fixture.commit}^{commit}`);
      } catch (error) {
        errors.push(`fixture repository ${JSON.stringify(fixture.repo)} has no commit ${fixture.commit}: ${error.message}`);
      }
    }
  } else errors.push('fixture.type must be "files" or "git"');
  if (errors.length) throw new Error(`${file}: ${errors.join("; ")}`);
  return { ...value, fixture, dir, file };
}

export function loadCase(file) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  return validateCase(value, file);
}

// Every case under dir, sorted by id.
export function loadCases(dir = CASES_DIR) {
  if (!isDir(dir)) return [];
  return readdirSync(dir).sort()
    .filter((name) => existsSync(join(dir, name, "case.json")))
    .map((name) => loadCase(join(dir, name, "case.json")));
}

// Extracts commit of repo into dest without touching the repository's checkout.
export function extractCommit(repo, commit, dest) {
  mkdirSync(dest, { recursive: true });
  const archive = `${dest}.tar`;
  try {
    git(repo, "archive", "--format=tar", "-o", archive, commit);
    const tar = Bun.spawnSync(["tar", "-xf", archive, "-C", dest], { stdout: "pipe", stderr: "pipe" });
    if (tar.exitCode !== 0) throw new Error(`tar failed for ${archive}: ${tar.stderr.toString().trim()}`);
  } finally {
    rmSync(archive, { force: true });
  }
}

export function applyOverlay(fixture, dest) {
  if (fixture.overlayPath) cpSync(fixture.overlayPath, dest, { recursive: true, force: true });
}

// Fills dest (which must not exist) with the case's fixture and overlay.
export function materialize(benchCase, dest) {
  const { fixture } = benchCase;
  if (fixture.type === "files") cpSync(fixture.source, dest, { recursive: true });
  else extractCommit(fixture.repoPath, fixture.commit, dest);
  applyOverlay(fixture, dest);
}

// An agent definition with its frontmatter's model and effort set, added when missing.
export function agentOverride(text, { model, effort }) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("Agent definition has no frontmatter");
  const lines = match[1].split("\n").filter((line) => !/^(?:model|effort):/.test(line));
  lines.push(`model: ${model}`, `effort: ${effort}`);
  return `---\n${lines.join("\n")}\n---\n${text.slice(match[0].length)}`;
}

// Writes <workspace>/.claude/agents/<role>.md from agentsDir/<role>.md with the matrix
// model and effort. A project agent takes precedence over the user's agent of that name.
export function writeAgentOverride(workspace, role, { model, effort }, agentsDir) {
  const path = join(workspace, ".claude", "agents", `${role}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, agentOverride(readFileSync(join(agentsDir, `${role}.md`), "utf8"), { model, effort }));
  return path;
}
