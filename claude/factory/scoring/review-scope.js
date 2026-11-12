// Which changed files need a review (review-scope.toml) and the repository each edited
// file belongs to, for the review-skipped detector.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const REVIEW_SCOPE_FILE = join(import.meta.dir, "review-scope.toml");

// The list, checked: { trivial: [glob] }.
export function loadReviewScope(path = REVIEW_SCOPE_FILE) {
  const raw = Bun.TOML.parse(readFileSync(path, "utf8"));
  const unknown = Object.keys(raw).filter((key) => key !== "trivial");
  if (unknown.length) throw new Error(`${path}: unknown keys ${unknown.join(", ")}; the list is by file kind, never by repository`);
  if (!Array.isArray(raw.trivial) || !raw.trivial.every((glob) => typeof glob === "string" && glob)) throw new Error(`${path}: trivial must be a list of globs`);
  return { trivial: raw.trivial };
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

// A repository's name from its remote URL, as the board writes it: host/owner/name,
// lowercased, such as github.com/syz51/papers. A remote without a host, such as a local
// path, is its own name.
export function repoName(url) {
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(url);
  const parsed = scp ? { host: scp[1], path: scp[2] } : URL.canParse(url) ? { host: new URL(url).hostname, path: new URL(url).pathname } : null;
  if (!parsed?.host) return url;
  return `${parsed.host}/${parsed.path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`.toLowerCase();
}

// The repository, checkout root and repository-relative path of a file in a git checkout
// that the board does not list, from git itself: the repository is the `origin` remote,
// or the checkout root when it has none. null outside a checkout on this device. The
// Review rule covers every repository, not only those with a board.
const gitRoots = new Map();
export function gitCheckout(file) {
  let folder = dirname(file);
  // The nearest folder that exists: a command's path may name a file as a folder.
  while (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) folder = dirname(folder);
  if (!gitRoots.has(folder)) {
    const top = Bun.spawnSync(["git", "-C", folder, "rev-parse", "--show-toplevel"], { stderr: "pipe" });
    const error = top.stderr.toString().trim();
    if (top.exitCode !== 0 && !/not a git repository/.test(error)) throw new Error(`git rev-parse in ${folder}: ${error}`);
    let found = null;
    if (top.exitCode === 0) {
      const root = realpathSync(top.stdout.toString().trim());
      const remote = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"], { stderr: "pipe" });
      found = { repo: remote.exitCode === 0 ? repoName(remote.stdout.toString().trim()) : root, root };
    }
    gitRoots.set(folder, found);
  }
  const found = gitRoots.get(folder);
  return found && file.startsWith(`${found.root}/`) ? { ...found, path: file.slice(found.root.length + 1) } : null;
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

// A test of whether a repository's changed file needs a review: every file does unless
// it is on the trivial list, in any repository.
export function reviewMatcher(scope) {
  const trivial = scope.trivial.map((glob) => new Bun.Glob(glob));
  return ({ path }) => !trivial.some((glob) => glob.match(path));
}
