// Dotfiles-owned skills: loads in session transcripts (Skill tool calls, agent preloads
// and installed SKILL.md reads), follow-up corrections after a load, feedback reports from
// `evolve`, and dotfiles commits touching each skill in the window.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { childEnv, runProcess } from "../../tests/lib/process.js";
import { isSkillCall } from "../lib/transcripts.js";
import { REPO_ROOT } from "../scoring/rubric.js";
import { loadSetups } from "../setups/cli.js";
import { isCorrection } from "./corrections.js";
import { ratio } from "./stats.js";

const SKILL_COVER = /^claude\/skills\/([a-z0-9-]+)$/;
const SKILL_FILE = /^claude\/skills\/([a-z0-9-]+)\//;
// Installed skill roots across Antigravity, Gemini, Claude Code, Codex and shared agent
// layouts. Worktree/repo paths like .../claude/skills/<name>/SKILL.md do not match, so
// reading dotfiles source code while editing a skill is not counted as loading it.
const INSTALLED_SKILL_PATH = /(?:^~\/|\/)(?:\.gemini\/config|\.claude|\.codex|\.agents|providers\/antigravity\/[^/]+\/config)\/skills\/([a-z0-9-]+)\/SKILL\.md$/;

/**
 * The dotfiles-owned skills listed in setups.toml, sorted by name:
 * [{ name, path, setupId }].
 */
export function dotfilesSkills({ setups, registryPath } = {}) {
  const list = setups ?? loadSetups(registryPath, { paths: false });
  const byName = new Map();
  for (const setup of list) {
    for (const entry of setup.covers ?? []) {
      const match = SKILL_COVER.exec(entry);
      if (match && !byName.has(match[1])) byName.set(match[1], { name: match[1], path: entry, setupId: setup.id });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const unquote = (text) => text.trim().replace(/^(['"])(.*)\1$/, "$2").trim();

// Minimal frontmatter reader for claude/agents/*.md: returns { name, skills }.
function parseAgentSkills(text, fallbackName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return { name: fallbackName, skills: [] };
  const lines = match[1].split(/\r?\n/);
  let name = fallbackName;
  const skills = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameMatch = /^name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      const parsed = unquote(nameMatch[1]);
      if (parsed) name = parsed;
      continue;
    }
    const skillMatch = /^skills:\s*(.*)$/.exec(line);
    if (!skillMatch) continue;
    const rest = skillMatch[1].trim();
    if (!rest) {
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
        const item = unquote(lines[++i].replace(/^\s+-\s+/, ""));
        if (item) skills.push(item);
      }
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      for (const part of rest.slice(1, -1).split(",")) {
        const item = unquote(part);
        if (item) skills.push(item);
      }
    } else {
      for (const part of rest.split(",")) {
        const item = unquote(part);
        if (item) skills.push(item);
      }
    }
  }
  return { name, skills };
}

/**
 * Agent definitions that preload skills via frontmatter (`skills:`), as Map<agentType, string[]>.
 */
export function agentPreloads(agentsDir = join(REPO_ROOT, "claude", "agents")) {
  const map = new Map();
  if (!existsSync(agentsDir)) return map;
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const { name, skills } = parseAgentSkills(readFileSync(join(agentsDir, entry.name), "utf8"), basename(entry.name, ".md"));
    if (skills.length) map.set(name, skills);
  }
  return map;
}

export function normalizeSkillName(raw, known) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^\/+/, "");
  if (known.has(trimmed)) return trimmed;
  if (trimmed.startsWith("dotfiles:")) {
    const bare = trimmed.slice("dotfiles:".length);
    if (known.has(bare)) return bare;
  }
  return null;
}

export function installedSkillFromPath(filePath, known) {
  if (typeof filePath !== "string") return null;
  const normalized = filePath.trim().replace(/\\/g, "/");
  const match = INSTALLED_SKILL_PATH.exec(normalized);
  return match && known.has(match[1]) ? match[1] : null;
}

/**
 * Dotfiles skill loads in one normalized session: [{ skill, kind, at }],
 * where kind is "skill" (Skill tool call), "preload" (agent frontmatter preload),
 * or "read" (Read/read_file of an installed SKILL.md).
 */
export function sessionSkillLoads(session, { skills = dotfilesSkills(), preloads = agentPreloads() } = {}) {
  const known = new Set(skills.map((skill) => skill.name));
  const loads = [];
  const subagents = session.subagents ?? [];
  const matched = new Set();

  for (const call of session.toolCalls ?? []) {
    if (isSkillCall(call)) {
      const name = normalizeSkillName(call.input?.skill, known);
      if (name) loads.push({ skill: name, kind: "skill", at: call.at ?? null });
    }
    if (call.ok !== false && (call.name === "read_file" || call.name === "Read")) {
      const filePath = call.input?.Path ?? call.input?.file_path ?? call.input?.path;
      const name = installedSkillFromPath(filePath, known);
      if (name) loads.push({ skill: name, kind: "read", at: call.at ?? null });
    }
    if (["Agent", "Task"].includes(call.name)) {
      const agentType = call.input?.subagent_type;
      const preloaded = typeof agentType === "string" ? preloads.get(agentType) : null;
      if (preloaded?.length) {
        let paired = call.id ? subagents.find((candidate) => candidate.toolUseId === call.id) : null;
        if (!paired && call.ok !== false)
          paired = subagents.find((candidate) => !matched.has(candidate) && !candidate.toolUseId && candidate.agentType === agentType) ?? null;
        if (paired) matched.add(paired);
        if (call.ok !== false) {
          for (const skill of preloaded)
            if (known.has(skill)) loads.push({ skill, kind: "preload", at: call.at ?? null });
        }
      }
    }
  }

  for (const agent of subagents) {
    if (!matched.has(agent)) {
      const preloaded = typeof agent.agentType === "string" ? preloads.get(agent.agentType) : null;
      if (preloaded?.length) {
        for (const skill of preloaded)
          if (known.has(skill)) loads.push({ skill, kind: "preload", at: agent.startedAt ?? null });
      }
    }
    for (const call of agent.skillCalls ?? []) {
      const name = normalizeSkillName(call.skill, known);
      if (name) loads.push({ skill: name, kind: "skill", at: call.at ?? null });
    }
  }

  return loads;
}

/**
 * Per-skill load and post-load correction statistics across session entries.
 * Always returns one row per dotfiles skill, sorted by name.
 */
export function skillStats(entries, { skills = dotfilesSkills() } = {}) {
  const rows = new Map(skills.map((skill) => [skill.name, {
    name: skill.name,
    path: skill.path,
    setupId: skill.setupId,
    loads: 0,
    toolCalls: 0,
    preloads: 0,
    reads: 0,
    sessions: 0,
    corrections: { sessions: 0, withCorrection: 0, rate: null },
  }]));

  for (const entry of entries) {
    const bySkill = new Map();
    for (const load of entry.skillLoads ?? []) {
      if (!rows.has(load.skill)) continue;
      if (!bySkill.has(load.skill)) bySkill.set(load.skill, []);
      bySkill.get(load.skill).push(load);
    }
    const followUps = entry.session.origin === "person" ? (entry.prompts ?? []).slice(1) : null;
    for (const [name, events] of bySkill) {
      const row = rows.get(name);
      row.loads += events.length;
      for (const event of events) {
        if (event.kind === "skill") row.toolCalls += 1;
        else if (event.kind === "preload") row.preloads += 1;
        else if (event.kind === "read") row.reads += 1;
      }
      row.sessions += 1;
      if (followUps !== null) {
        row.corrections.sessions += 1;
        const times = events.map((event) => Date.parse(event.at ?? "")).filter(Number.isFinite);
        const earliest = times.length ? Math.min(...times) : null;
        const corrected = followUps.some((prompt) => {
          if (!isCorrection(prompt.text)) return false;
          if (earliest === null) return true;
          const promptMs = Date.parse(prompt.at ?? "");
          return !Number.isFinite(promptMs) || promptMs > earliest;
        });
        if (corrected) row.corrections.withCorrection += 1;
      }
    }
  }

  return [...rows.values()].map((row) => ({
    ...row,
    corrections: { ...row.corrections, rate: ratio(row.corrections.withCorrection, row.corrections.sessions) },
  }));
}

/**
 * Non-merge commits in the dotfiles repository touching `claude/skills/<name>/` in [since, until].
 * Returns { bySkill, error }; never throws on git failures so callers can still render the rest.
 */
export async function skillCommits({
  repo,
  since,
  until,
  skills = dotfilesSkills(),
  env = process.env,
} = {}) {
  const repoDir = repo || env.CLAUDE_FACTORY_DOTFILES_REPO || REPO_ROOT;
  const known = new Set(skills.map((skill) => skill.name));
  const bySkill = Object.fromEntries(skills.map((skill) => [skill.name, []]));
  const args = [
    "git", "-C", repoDir, "log", "--no-merges",
    ...(since !== undefined ? [`--since=${new Date(since).toISOString()}`] : []),
    ...(until !== undefined ? [`--until=${new Date(until).toISOString()}`] : []),
    "--name-only",
    "--format=COMMIT%x09%h%x09%cI%x09%s",
    "--", "claude/skills",
  ];
  let run;
  try {
    run = await runProcess(args, { env: childEnv(env), timeout: 30_000 });
  } catch (error) {
    return { bySkill: null, error: `git log claude/skills: ${error.message}` };
  }
  if (run.code !== 0) {
    const detail = run.stderr.trim() || run.stdout.trim() || "no output";
    return { bySkill: null, error: `git log claude/skills exited ${run.code}: ${detail}` };
  }
  let current = null;
  let seen = new Set();
  for (const rawLine of run.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("COMMIT\t")) {
      const [, hash, at, ...subjectParts] = line.split("\t");
      current = { hash, at, subject: subjectParts.join("\t") };
      seen = new Set();
      continue;
    }
    if (!current) continue;
    const match = SKILL_FILE.exec(line);
    if (match && known.has(match[1]) && !seen.has(match[1])) {
      seen.add(match[1]);
      bySkill[match[1]].push(current);
    }
  }
  return { bySkill, error: null };
}

/**
 * Feedback counts for one dotfiles skill from `evolve --json` output, matching both
 * `<skill>` and `skills:<skill>` setup ids. Returns null when evolve output is unavailable.
 */
export function skillFeedback(evolveOutput, skill) {
  if (!evolveOutput || !Array.isArray(evolveOutput.setups)) return null;
  const ids = new Set([skill.name, `skills:${skill.name}`]);
  const totals = { items: 0, reports: 0, untriaged: 0, routedOpen: 0, fixed: 0, recurrences: 0 };
  for (const entry of evolveOutput.setups) {
    if (!ids.has(entry?.id)) continue;
    totals.items += entry.items ?? 0;
    totals.reports += entry.reports ?? 0;
    totals.untriaged += entry.untriaged?.length ?? 0;
    totals.routedOpen += entry.routedOpen?.length ?? 0;
    totals.fixed += entry.fixed ?? 0;
    totals.recurrences += entry.recurrences ?? 0;
  }
  return totals;
}

/**
 * Combines transcript usage (from metrics), feedback counts (from evolve) and dotfiles commits
 * into one per-skill summary for the weekly report.
 */
export function weeklySkillReport({ metrics = null, evolve = null, commits = null, commitsError = null, skills = dotfilesSkills() } = {}) {
  const currentByName = new Map((metrics?.current?.skills ?? []).map((row) => [row.name, row]));
  const previousByName = new Map((metrics?.previous?.skills ?? []).map((row) => [row.name, row]));
  const hasMetrics = Array.isArray(metrics?.current?.skills);
  const rows = skills.map((skill) => {
    const usage = hasMetrics
      ? (currentByName.get(skill.name) ?? { loads: 0, toolCalls: 0, preloads: 0, reads: 0, sessions: 0, corrections: { sessions: 0, withCorrection: 0, rate: null } })
      : null;
    const previousLoads = Array.isArray(metrics?.previous?.skills) ? (previousByName.get(skill.name)?.loads ?? 0) : null;
    return {
      name: skill.name,
      path: skill.path,
      setupId: skill.setupId,
      usage,
      previousLoads,
      feedback: skillFeedback(evolve, skill),
      commits: commits ? (commits[skill.name] ?? []) : null,
    };
  });
  return { skills: rows, errors: commitsError ? [commitsError] : [] };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * One concise Markdown line per dotfiles skill for the factory weekly report.
 */
export function weeklySkillLines(report) {
  const lines = [];
  for (const row of report?.skills ?? []) {
    let loadsText;
    if (!row.usage) loadsText = "loads n/a";
    else if (row.usage.loads === 0) loadsText = "0 loads";
    else {
      const kinds = [];
      if (row.usage.toolCalls) kinds.push(`${row.usage.toolCalls} Skill`);
      if (row.usage.preloads) kinds.push(plural(row.usage.preloads, "preload"));
      if (row.usage.reads) kinds.push(plural(row.usage.reads, "read"));
      const breakdown = kinds.length ? ` (${kinds.join(", ")})` : "";
      const corr = row.usage.corrections?.sessions
        ? ` (${row.usage.corrections.withCorrection}/${row.usage.corrections.sessions} with correction)`
        : "";
      loadsText = `${plural(row.usage.loads, "load")}${breakdown} in ${plural(row.usage.sessions, "session")}${corr}`;
    }

    let feedbackText;
    if (!row.feedback) feedbackText = "feedback n/a";
    else {
      const details = [];
      if (row.feedback.items) details.push(plural(row.feedback.items, "item"));
      if (row.feedback.fixed) details.push(`${row.feedback.fixed} fixed`);
      if (row.feedback.routedOpen) details.push(`${row.feedback.routedOpen} open`);
      if (row.feedback.untriaged) details.push(`${row.feedback.untriaged} untriaged`);
      feedbackText = details.length
        ? `${plural(row.feedback.reports, "feedback report")} (${details.join(", ")})`
        : "0 feedback reports";
    }
    if (row.setupId && row.setupId !== row.name) feedbackText += ` (setup: ${row.setupId})`;

    let commitsText;
    if (!row.commits) commitsText = "commits n/a";
    else if (row.commits.length === 0) commitsText = "0 commits";
    else {
      const hashes = row.commits.slice(0, 3).map((commit) => commit.hash).join(", ");
      const more = row.commits.length > 3 ? `, … +${row.commits.length - 3}` : "";
      commitsText = `${plural(row.commits.length, "commit")} (${hashes}${more})`;
    }

    lines.push(`- ${row.name}: ${loadsText}; ${feedbackText}; ${commitsText}`);
  }
  for (const error of report?.errors ?? []) lines.push(`- Failed: ${error}`);
  return lines;
}
