// Turns a real commit with tests into a case: the fixture is the parent commit, the
// overlay is the commit's versions of the test files, and the oracle runs them. The
// case is created only when the oracle fails on the parent plus overlay and passes on
// the commit itself.
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { ROLES, extractCommit, git, loadCase } from "./cases.js";
import { runOracle } from "./runner.js";

export function defaultPrompt(subject, body, tests) {
  return [`Make the failing tests pass: ${subject}`, body.trim(),
    `The tests are ${tests.join(", ")}. Change the code, not the tests.`].filter(Boolean).join("\n\n");
}

const toplevel = (dir) => {
  try {
    return realpathSync(git(dir, "rev-parse", "--show-toplevel").trim());
  } catch {
    return null;
  }
};

// Returns { benchCase, parentRun, commitRun }; throws when the oracle does not flip.
export async function addFromCommit({
  repo, sha, tests, oracle, role = "worker", id, prompt, title, casesDir,
  budgetUsd = 3, timeoutMs = 900_000, oracleTimeoutMs = 300_000, log = () => {},
}) {
  if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(", ")}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id ?? "")) throw new Error("--id must be lowercase letters, digits and dashes");
  if (!tests.length) throw new Error("--tests needs at least one path");
  for (const path of tests)
    if (normalize(path).startsWith("..") || path.startsWith("/")) throw new Error(`Test path ${path} must be relative to the repository`);
  const caseDir = join(casesDir, id);
  if (existsSync(caseDir)) throw new Error(`Case ${id} already exists at ${caseDir}`);
  const commit = git(repo, "rev-parse", "--verify", `${sha}^{commit}`).trim();
  const parent = git(repo, "rev-parse", "--verify", `${commit}^`).trim();
  const subject = git(repo, "log", "-1", "--format=%s", commit).trim();
  const body = git(repo, "log", "-1", "--format=%b", commit);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "claude-bench-add-")));
  try {
    const overlay = join(scratch, "overlay");
    for (const path of tests) {
      const target = join(overlay, path);
      mkdirSync(dirname(target), { recursive: true });
      const show = Bun.spawnSync(["git", "-C", repo, "show", `${commit}:${path}`], { stdout: "pipe", stderr: "pipe" });
      if (show.exitCode !== 0) throw new Error(`${path} does not exist at ${commit}: ${show.stderr.toString().trim()}`);
      writeFileSync(target, show.stdout);
    }
    const check = { command: oracle, timeoutMs: oracleTimeoutMs };
    const answer = join(scratch, "final-answer.txt");
    writeFileSync(answer, "");
    extractCommit(repo, parent, join(scratch, "parent"));
    log(`Running the oracle on ${parent.slice(0, 12)} with the tests from ${commit.slice(0, 12)}`);
    const parentRun = await runOracle(check, join(scratch, "parent"), answer, { overlayPath: overlay });
    extractCommit(repo, commit, join(scratch, "commit"));
    log(`Running the oracle on ${commit.slice(0, 12)}`);
    const commitRun = await runOracle(check, join(scratch, "commit"), answer);
    if (parentRun.exit === 0 || commitRun.exit !== 0) {
      const problems = [];
      if (parentRun.exit === 0) problems.push(`it passes on the parent ${parent.slice(0, 12)} with the new tests`);
      if (commitRun.exit !== 0) problems.push(`it fails on ${commit.slice(0, 12)} (exit ${commitRun.exit}):\n${commitRun.output}`);
      throw Object.assign(new Error(`Refusing to create ${id}: the oracle does not flip; ${problems.join("; ")}`), { parentRun, commitRun });
    }
    mkdirSync(casesDir, { recursive: true });
    const repoTop = toplevel(repo);
    const repoField = repoTop && repoTop === toplevel(casesDir) ? "." : realpathSync(repo);
    const value = {
      id, title: title ?? subject, role, prompt: prompt ?? defaultPrompt(subject, body, tests),
      fixture: { type: "git", repo: repoField, commit: parent, overlay: "overlay" },
      oracle: check, budgetUsd, timeoutMs,
    };
    mkdirSync(caseDir, { recursive: true });
    try {
      cpSync(overlay, join(caseDir, "overlay"), { recursive: true });
      writeFileSync(join(caseDir, "case.json"), `${JSON.stringify(value, null, 2)}\n`);
      return { benchCase: loadCase(join(caseDir, "case.json")), parentRun, commitRun, commit, parent };
    } catch (error) {
      rmSync(caseDir, { recursive: true, force: true });
      throw error;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
