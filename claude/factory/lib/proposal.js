// What every proposal attempt shares, whatever proposed it: the proposer's read denies,
// the leak check, git in a fresh clone, the paths a session changed, the offline suites,
// the local patch, and the push with its draft PR.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { childEnv, runProcess } from "../../tests/lib/process.js";
import { initEvent } from "../../tests/lib/stream.js";
import { stateDir } from "./state.js";
import { projectsRoot } from "./transcripts.js";

export const TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
const TEST_PATHS = ["claude/hooks", "claude/tests", "claude/factory"];
// A verbatim run this long from the evidence in a pushed change counts as a leak.
const LEAK_RUN = 40;
// The proposer runs with the user's configuration; whatever it allows, these stay unread:
// credentials, and the private sources the leak check never sees (raw transcripts, the skill
// feedback notes taken from them, the state folder with its scores and evidence files, the work board's local cache).
const DENY_READ = ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.config/gh/**", "~/.netrc", "~/.claude.json", "~/.docker/config.json", "~/.claude/projects/**", "~/.codex/**", "~/.local/share/agent-skills/skill-feedback/**", "~/.local/share/agent-board/**"];

// Read deny rules for DENY_READ and the given absolute folders. A rule takes an absolute
// path as //path; a folder under home gets its ~/ form as well.
export function readDenies(folders, home = homedir()) {
  const paths = [...DENY_READ];
  for (const folder of folders.map((path) => resolve(path))) {
    paths.push(`/${folder}/**`);
    if (folder.startsWith(`${home}/`)) paths.push(`~/${relative(home, folder)}/**`);
  }
  return [...new Set(paths)].map((path) => `Read(${path})`);
}

// Whether text repeats a run of LEAK_RUN characters of any evidence line, whitespace
// collapsed. Runs also found in publicText (what the repository already holds, such as
// the rule a judge quoted) are not leaks.
export function leakedEvidence(text, evidence, { publicText = [] } = {}) {
  const collapse = (value) => String(value).replace(/\s+/g, " ");
  const runs = (value) => {
    const flat = collapse(value);
    return Array.from({ length: Math.max(0, flat.length - LEAK_RUN + 1) }, (_, i) => flat.slice(i, i + LEAK_RUN));
  };
  const known = new Set(publicText.flatMap(runs));
  const secret = new Set(evidence.flatMap(runs).filter((run) => !known.has(run)));
  return runs(text).some((run) => secret.has(run));
}

export const clip = (text, max = 400) => {
  const flat = String(text).replace(/\s*\n\s*/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export const git = async (cwd, args, { allowFailure = false } = {}) => {
  const result = await runProcess(["git", ...args], { cwd, env: process.env, timeout: 300_000 });
  if (result.code !== 0 && !allowFailure) throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result;
};

// Paths the working tree changed, untracked and ignored files included: a file the
// proposer wrote anywhere counts, such as a .env.* file Bun would load into the tests.
export async function changedPaths(cwd) {
  const { stdout } = await git(cwd, ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all"]);
  const paths = [];
  const entries = stdout.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    paths.push(entries[i].slice(3));
    if (/[RC]/.test(status)) paths.push(entries[++i]);
  }
  return paths;
}

// A test command's result: ok, the command, a one-line summary and the output's tail.
export async function runSuite(cwd, argv, { env = childEnv(process.env), timeout = 600_000 } = {}) {
  let result;
  try {
    result = await runProcess(argv, { cwd, env, timeout });
  } catch (error) {
    // A suite that could not start (its tool is missing) or did not finish failed.
    return { ok: false, command: argv.join(" "), summary: `did not finish: ${error.message}`, tail: `${error.stdout ?? ""}\n${error.stderr ?? ""}`.slice(-3000) };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  // bun prints "N pass"; cargo prints "test result: ok. N passed; M failed; …" per crate.
  const lines = output.split("\n").map((line) => line.trim());
  const bun = lines.filter((line) => /^\d+ (?:pass|fail|skip)\b|^Ran \d+ tests/.test(line));
  const cargo = lines.filter((line) => line.startsWith("test result:"));
  const total = (word) => cargo.reduce((sum, line) => sum + Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0), 0);
  const summary = bun.length ? bun.join(", ") : cargo.length ? `${total("passed")} passed, ${total("failed")} failed` : `exit ${result.code}`;
  return { ok: result.code === 0, command: argv.join(" "), summary, tail: output.slice(-3000) };
}

// The offline suites of this repository that exist in the clone.
export const runTests = (cwd) => runSuite(cwd, ["bun", "test", ...TEST_PATHS.filter((path) => existsSync(join(cwd, path)))]);

export const today = (now) => new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
// The UTC time of an attempt, YYYYMMDD-HHMMSS, which keeps each attempt's branch new.
export const stamp = (now) => new Date(now).toISOString().slice(0, 19).replace(/-|:/g, "").replace("T", "-");

// Stages everything in the clone and returns the staged diff; prefix names the clone in
// the diff's paths when one patch holds several.
export async function stagedPatch(clone, prefix = "") {
  await git(clone, ["add", "-A"]);
  const { stdout } = await git(clone, ["diff", "--cached", ...(prefix ? [`--src-prefix=a/${prefix}/`, `--dst-prefix=b/${prefix}/`] : [])]);
  return stdout;
}

export const writePatch = (record, patch) => {
  record.patchFile = record.evidenceFile.replace(/\.evidence\.md$/, ".patch");
  writeFileSync(record.patchFile, patch);
};

// The lines a patch adds.
export const addedLines = (patch) => patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1));

// The text of paths at HEAD that existed there, which the leak check treats as public.
export async function originalText(clone, paths) {
  const shown = await Promise.all(paths.map((path) => git(clone, ["show", `HEAD:${path}`], { allowFailure: true })));
  return shown.filter((result) => result.code === 0).map((result) => result.stdout);
}

// Commits the staged change, pushes the branch and opens a draft PR against base; returns
// its URL. onPushed runs once the branch is on the remote.
export async function publish(clone, { branch, base, title, body, onPushed }) {
  await git(clone, ["commit", "--quiet", "-m", title]);
  await git(clone, ["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${branch}`]);
  onPushed?.();
  const gh = process.env.CLAUDE_FACTORY_GH || "gh";
  const pr = await runProcess([gh, "pr", "create", "--draft", "--base", base, "--head", branch, "--title", title, "--body", body], { cwd: clone, env: process.env, timeout: 120_000 });
  if (pr.code !== 0) throw new Error(`${gh} pr create failed (${pr.code}) after pushing ${branch}: ${pr.stderr.trim()}`);
  return pr.stdout.trim().split("\n").at(-1);
}

// The board client keeps its token and cache in BOARD_HOME when that is set.
export const proposerSettings = () => JSON.stringify({ permissions: { deny: readDenies([stateDir(), projectsRoot(), ...(process.env.BOARD_HOME ? [process.env.BOARD_HOME] : [])]) } });

// Every file under a clone's .git with its size and modification time. Only the proposer
// runs between two readings, so a difference means it wrote there: a hook or a config
// entry that the git calls after it would run. Read it before any git call does. The index
// is left out: Claude Code's own git status at session start may refresh it.
export function gitState(clone) {
  const root = join(clone, ".git");
  return readdirSync(root, { recursive: true }).filter((path) => path !== "index").sort().map((path) => {
    const stat = statSync(join(root, path));
    return `${path} ${stat.isDirectory() ? "dir" : `${stat.size} ${stat.mtimeMs}`}`;
  }).join("\n");
}

// Proposal outcomes that do not count as having proposed: dry runs and errors, so the next
// run tries again. A proposer that failed for any reason but its budget (an API error or
// rate limit, say) is retried next run; one that used up its budget would again, so it
// waits.
const RETRYABLE = new Set(["dry-run", "error"]);
export const retryable = (proposal) => RETRYABLE.has(proposal.status)
  || (proposal.status === "proposer-failed" && proposal.resultSubtype !== "error_max_budget_usd");

// The checked-out clone of the local repository at origin's main, on a new branch. A
// local clone, so no network is needed for history, then origin's URL for fetch and push.
export async function cloneRepository(repo, clone, branch) {
  const { stdout: originUrl } = await git(repo, ["remote", "get-url", "origin"]);
  await git(tmpdir(), ["clone", "--quiet", "--no-local", repo, clone]);
  await git(clone, ["remote", "set-url", "origin", originUrl.trim()]);
  await git(clone, ["fetch", "--quiet", "origin", "main"]);
  await git(clone, ["checkout", "--quiet", "-B", branch, "origin/main"]);
}

// Fail closed if the session had more than the file tools (an MCP server or a built-in
// that slipped through), whatever it changed. Returns the rejected record, or null.
export function toolRejection(task, record) {
  const init = initEvent(task.events);
  record.tools = init?.tools ?? null;
  if (!init || init.tools.some((tool) => !TOOLS.includes(tool)) || (init.mcp_servers ?? []).length)
    return { ...record, status: "rejected-tools", mcpServers: init?.mcp_servers ?? null };
  return null;
}

// The title and private explanation of a finished proposer session.
export function proposerReply(task, fallback) {
  const title = /^TITLE:\s*(.+)$/m.exec(task.finalText)?.[1].trim().slice(0, 72) || fallback;
  return { title, explanation: task.finalText.replace(/^TITLE:.*$/m, "").trim() };
}
