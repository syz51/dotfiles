// Pull requests a session created or linked: Claude Code's pr-link records, plus PR URLs
// printed by calls that ran `gh pr create`: Claude Code Bash commands and Codex exec
// scripts (most sessions that open a PR have no pr-link record).
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
  for (const call of session.toolCalls)
    if ((call.name === "Bash" || call.name === "exec") && /\bgh\s+pr\s+create\b/.test(call.input?.command ?? call.input?.input ?? ""))
      for (const parsed of prUrls(call.output)) add(parsed);
  return [...found.values()];
}
