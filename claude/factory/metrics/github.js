// Pull request state and reverts from GitHub through the gh CLI (CLAUDE_FACTORY_GH
// replaces `gh`; tests point it at a fake). PR lookups are cached in the state folder:
// merged and closed PRs for good, open ones for an hour. A failed call becomes a note in
// the report instead of failing the run.
import { runProcess } from "../../tests/lib/process.js";
import { readJson, statePath, writeJsonAtomic } from "../lib/state.js";

export const OPEN_TTL_MS = 60 * 60 * 1000;
export const CACHE_FILE = "gh-cache.json";
const FIELDS = "number,url,title,state,createdAt,mergedAt,closedAt,additions,deletions,headRefName";
const REVERT_FIELDS = "number,title,body,url,mergedAt";

const firstLine = (text) => String(text ?? "").trim().split("\n")[0].slice(0, 200);

async function gh(args) {
  const result = await runProcess([process.env.CLAUDE_FACTORY_GH || "gh", ...args], { env: process.env, timeout: 60_000 });
  if (result.code !== 0) throw new Error(`exit ${result.code}${result.stderr.trim() ? `: ${firstLine(result.stderr)}` : ""}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`unreadable output: ${firstLine(result.stdout)}`);
  }
}

// State of each PR ({ key, url }), as a Map from key to gh's fields; PRs whose lookup
// failed are missing, with a note pushed to notes.
export async function lookupPrs(prs, { notes, now = Date.now() }) {
  const path = statePath(CACHE_FILE);
  const cache = readJson(path, {});
  cache.prs ??= {};
  const found = new Map();
  let changed = false;
  for (const { key, url } of prs) {
    const cached = cache.prs[key];
    if (cached && (cached.pr.state !== "OPEN" || now - cached.fetchedAt < OPEN_TTL_MS)) {
      found.set(key, cached.pr);
      continue;
    }
    try {
      const pr = await gh(["pr", "view", url, "--json", FIELDS]);
      cache.prs[key] = { fetchedAt: now, pr };
      found.set(key, pr);
      changed = true;
    } catch (error) {
      notes.push(`gh pr view ${url} failed (${error.message}); its state is unknown.`);
    }
  }
  if (changed) writeJsonAtomic(path, cache);
  return found;
}

const revertedTitle = (title) => title.replace(/^revert\s*/i, "").replace(/^"(.*)"$/s, "$1").trim();

// Whether revert names pr: its number as #N, its URL, or its exact title. A revert
// merged before the PR cannot revert it.
export function reverts(revert, pr) {
  if (revert.number === pr.number) return false;
  if (revert.mergedAt && pr.mergedAt && Date.parse(revert.mergedAt) < Date.parse(pr.mergedAt)) return false;
  const text = `${revert.title ?? ""}\n${revert.body ?? ""}`;
  if (new RegExp(`(?<!&)#${pr.number}(?!\\d)`).test(text)) return true;
  if (pr.url && new RegExp(`${RegExp.escape(pr.url)}(?!\\d)`, "i").test(text)) return true;
  return Boolean(pr.title) && (revertedTitle(revert.title ?? "") === pr.title || (revert.body ?? "").includes(`"${pr.title}"`));
}

// The revert of each merged PR, as a Map from key to the revert's fields. Lists each
// repository's merged "Revert" PRs once.
export async function findReverts(merged, { notes }) {
  const byRepository = Map.groupBy(merged, (pr) => pr.repository);
  const found = new Map();
  for (const [repository, prs] of byRepository) {
    let list;
    try {
      list = await gh(["pr", "list", "--repo", repository, "--state", "merged", "--search", "Revert in:title", "--json", REVERT_FIELDS, "--limit", "100"]);
    } catch (error) {
      notes.push(`gh pr list --repo ${repository} failed (${error.message}); reverts there are unknown.`);
      continue;
    }
    const revertPrs = list.filter((item) => /^revert\b/i.test(item.title ?? ""));
    for (const pr of prs) {
      const revert = revertPrs.find((item) => reverts(item, pr));
      if (revert) found.set(pr.key, { number: revert.number, url: revert.url, title: revert.title, mergedAt: revert.mergedAt ?? null });
    }
  }
  return found;
}
