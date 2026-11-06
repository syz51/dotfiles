// Pull requests a session created or linked: Claude Code's pr-link records, PR URLs
// printed by Bash calls that ran `gh pr create` (most sessions that open a PR have no
// pr-link record), and PR links a git server printed on push (`remote: … /pull/12`).
// Branches a session pushed, from git push's output.
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?!\d)/g;

// { url, repository, number, key } of a GitHub PR URL; key ignores letter case, as GitHub does.
function pr(owner, repo, number) {
  const repository = `${owner}/${repo}`;
  return { url: `https://github.com/${repository}/pull/${number}`, repository, number: Number(number), key: `${repository.toLowerCase()}#${number}` };
}

export const prUrls = (text) => [...String(text ?? "").matchAll(PR_URL)].map(([, owner, repo, number]) => pr(owner, repo, number));

export function sessionPrs(session) {
  const found = new Map();
  const add = (link) => found.has(link.key) || found.set(link.key, link);
  for (const link of session.prLinks) for (const parsed of prUrls(link.url)) add(parsed);
  for (const call of session.toolCalls) {
    if (call.name === "Bash" && /\bgh\s+pr\s+create\b/.test(call.input?.command ?? ""))
      for (const parsed of prUrls(call.output)) add(parsed);
    for (const line of String(call.output ?? "").split("\n")) if (line.startsWith("remote:")) for (const parsed of prUrls(line)) add(parsed);
  }
  return [...found.values()];
}

// The repository a remote URL names (`o/r` for GitHub over https or ssh), else the URL.
const repositoryOf = (remote) => /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote)?.slice(1, 3).join("/") ?? remote;

// A ref line of git push: flag, summary (`[new branch]`, `abc..def`, `abc...def`), src -> dst.
const REF_LINE = /^\s*([ +*=!-])\s+(\[new branch\]|[0-9a-f]{7,}\.\.\.?[0-9a-f]{7,})\s+\S+\s+->\s+(\S+)/;
const PULL_NEW = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/new\/(\S+)/;

// Branches a session pushed: { repository, branch, created, key }, once each, read from the
// output of any tool call (Bash, or Codex's exec): the ref lines under git push's
// `To <remote>` line (new branches, updates and forced updates; not rejected, up-to-date
// or deleted refs, nor tags), and GitHub's `remote: … /pull/new/<branch>` hint for a new
// branch. A quiet push (`-q`) prints neither, so it is not seen.
export function sessionPushes(session) {
  const found = new Map();
  const add = (repository, branch, created) => {
    const key = `${repository.toLowerCase()}:${branch}`;
    const known = found.get(key);
    if (known) known.created ||= created;
    else found.set(key, { repository, branch, created, key });
  };
  for (const call of session.toolCalls) {
    let remote = null;
    for (const line of String(call.output ?? "").split(/\r?\n/)) {
      const to = /^To (\S+)\s*$/.exec(line);
      if (to) {
        remote = repositoryOf(to[1]);
        continue;
      }
      const pullNew = PULL_NEW.exec(line);
      if (line.startsWith("remote:") && pullNew) add(`${pullNew[1]}/${pullNew[2]}`, pullNew[3], true);
      const ref = remote && REF_LINE.exec(line);
      if (ref && !ref[3].startsWith("refs/tags/")) add(remote, ref[3].replace(/^refs\/heads\//, ""), ref[2] === "[new branch]");
      else if (!/^\s|^remote:/.test(line)) remote = null;
    }
  }
  return [...found.values()];
}
