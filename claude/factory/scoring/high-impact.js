// High-impact paths (high-impact.toml) and the repository each edited file belongs to,
// for the review-skipped detector.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const HIGH_IMPACT_FILE = join(import.meta.dir, "high-impact.toml");

// The lists, checked: { default: [glob], ignore: [glob], repos: { [repo]: [glob] } }
// with repository keys lowercased, as the board keys them.
export function loadHighImpact(path = HIGH_IMPACT_FILE) {
  const raw = Bun.TOML.parse(readFileSync(path, "utf8"));
  const globs = (value, where) => {
    if (!Array.isArray(value) || !value.every((glob) => typeof glob === "string" && glob)) throw new Error(`${path}: ${where} must be a list of globs`);
    return value;
  };
  const repos = Object.entries(raw.repos ?? {}).map(([repo, entry]) => [repo.toLowerCase(), globs(entry?.paths, `repos."${repo}".paths`)]);
  return { default: globs(raw.default, "default"), ignore: globs(raw.ignore ?? [], "ignore"), repos: Object.fromEntries(repos) };
}

// A path with symbolic links resolved, such as ~/.claude for the dotfiles' claude
// folder: the deepest folder that exists is resolved and the rest kept.
const realFolders = new Map();
export function realFile(path) {
  const folder = dirname(path);
  if (folder === path) return path;
  if (!realFolders.has(folder)) realFolders.set(folder, existsSync(folder) ? realpathSync(folder) : realFile(folder));
  return join(realFolders.get(folder), basename(path));
}

// This device's checkouts of board repositories, longest root first: [{ repo, root }]
// from the board client's [projects] in config.toml. None when the board is not set up.
export function boardCheckouts(env = process.env) {
  const file = join(env.BOARD_HOME ?? join(homedir(), ".local", "share", "agent-board"), "config.toml");
  if (!existsSync(file)) return [];
  const projects = Bun.TOML.parse(readFileSync(file, "utf8")).projects ?? {};
  return Object.entries(projects)
    .map(([repo, root]) => ({ repo: repo.toLowerCase(), root: realFile(join(String(root), "_")).slice(0, -2) }))
    .sort((a, b) => b.root.length - a.root.length);
}

const CLAUDE_WORKTREE = /^\.claude\/worktrees\/[^/]+\/(.+)$/;
const T3_WORKTREE = /\/\.t3\/worktrees\/([^/]+)\/[^/]+\/(.+)$/;
const inRepo = (rest) => CLAUDE_WORKTREE.exec(rest)?.[1] ?? rest;

// The repository, its checkout root and the repository-relative path of an absolute
// file path: in a checkout, in a Claude Code worktree inside one
// (<root>/.claude/worktrees/<name>/), or in a T3 Code worktree
// (~/.t3/worktrees/<checkout folder name>/<name>/), which may hold a Claude Code
// worktree. null for other files.
export function locate(file, checkouts) {
  for (const { repo, root } of checkouts) {
    if (file.startsWith(`${root}/`)) return { repo, root, path: inRepo(file.slice(root.length + 1)) };
  }
  const t3 = T3_WORKTREE.exec(file);
  const checkout = t3 && checkouts.find(({ root }) => basename(root) === t3[1]);
  return checkout ? { repo: checkout.repo, root: checkout.root, path: inRepo(t3[2]) } : null;
}

// Whether git ignores a repository's file in its checkout: such files are never pushed.
// false when the checkout is not on this device.
const ignoredFiles = new Map();
export function gitIgnored({ root, path }) {
  const key = `${root}\0${path}`;
  if (!ignoredFiles.has(key)) {
    if (!existsSync(root)) return false;
    const run = Bun.spawnSync(["git", "-C", root, "check-ignore", "-q", "--", path], { stderr: "pipe" });
    if (run.exitCode !== 0 && run.exitCode !== 1) throw new Error(`git check-ignore in ${root}: ${run.stderr.toString().trim()}`);
    ignoredFiles.set(key, run.exitCode === 0);
  }
  return ignoredFiles.get(key);
}

// A test of whether a repository's file is high-impact: on the repository's own list,
// or on the default list and not ignored.
export function highImpactMatcher(lists) {
  const compile = (globs) => globs.map((glob) => new Bun.Glob(glob));
  const [defaults, ignored] = [compile(lists.default), compile(lists.ignore ?? [])];
  const own = new Map();
  const ownOf = (repo) => {
    if (!own.has(repo)) own.set(repo, compile(lists.repos[repo] ?? []));
    return own.get(repo);
  };
  const matches = (globs, path) => globs.some((glob) => glob.match(path));
  return ({ repo, path }) => matches(ownOf(repo), path) || (matches(defaults, path) && !matches(ignored, path));
}
