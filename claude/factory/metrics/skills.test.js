import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../tests/lib/process.js";
import { loadAntigravitySessions } from "../lib/antigravity.js";
import { Transcript, writeProjects } from "../lib/testing/transcripts.js";
import { loadSessions } from "../lib/transcripts.js";
import {
  agentPreloads,
  dotfilesSkills,
  installedSkillFromPath,
  normalizeSkillName,
  sessionSkillLoads,
  skillCommits,
  skillFeedback,
  skillStats,
  weeklySkillLines,
  weeklySkillReport,
} from "./skills.js";

let scratch;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claude-factory-skills-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("discovery", () => {
  test("lists all six dotfiles-owned skills from setups.toml with their setup ids", () => {
    const skills = dotfilesSkills();
    expect(skills).toEqual([
      { name: "cheat-sheets", path: "claude/skills/cheat-sheets", setupId: "cheat-sheets" },
      { name: "diff-review", path: "claude/skills/diff-review", setupId: "instructions" },
      { name: "full-stop", path: "claude/skills/full-stop", setupId: "full-stop" },
      { name: "headless-browser", path: "claude/skills/headless-browser", setupId: "headless-browser" },
      { name: "ui-climb", path: "claude/skills/ui-climb", setupId: "ui-climb" },
      { name: "work-stages", path: "claude/skills/work-stages", setupId: "work-stages" },
    ]);
  });

  test("reads agent skill preloads from claude/agents frontmatter and supports list syntaxes", () => {
    const preloads = agentPreloads();
    expect(preloads.get("reviewer")).toEqual(["diff-review"]);
    expect(preloads.has("explorer")).toBe(false);

    const dir = join(scratch, "agents");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.md"), "---\nname: alpha\nskills: full-stop, work-stages\n---\nbody\n");
    writeFileSync(join(dir, "b.md"), "---\nname: beta\nskills: [\"cheat-sheets\", 'ui-climb']\n---\n");
    writeFileSync(join(dir, "c.md"), "---\nname: gamma\nskills:\n  - headless-browser\n  - diff-review\n---\n");
    writeFileSync(join(dir, "d.md"), "no frontmatter\n");
    const parsed = agentPreloads(dir);
    expect(parsed.get("alpha")).toEqual(["full-stop", "work-stages"]);
    expect(parsed.get("beta")).toEqual(["cheat-sheets", "ui-climb"]);
    expect(parsed.get("gamma")).toEqual(["headless-browser", "diff-review"]);
    expect(parsed.has("d")).toBe(false);
  });

  test("normalizes Skill names and recognizes only installed SKILL.md paths", () => {
    const known = new Set(["cheat-sheets", "diff-review", "full-stop", "work-stages"]);
    expect(normalizeSkillName("work-stages", known)).toBe("work-stages");
    expect(normalizeSkillName("/full-stop", known)).toBe("full-stop");
    expect(normalizeSkillName("dotfiles:cheat-sheets", known)).toBe("cheat-sheets");
    expect(normalizeSkillName("other:work-stages", known)).toBeNull();
    expect(normalizeSkillName("frontend-ui", known)).toBeNull();

    expect(installedSkillFromPath("/Users/u/.gemini/config/skills/diff-review/SKILL.md", known)).toBe("diff-review");
    expect(installedSkillFromPath("~/.gemini/config/skills/work-stages/SKILL.md", known)).toBe("work-stages");
    expect(installedSkillFromPath("/Users/u/.t3/userdata/providers/antigravity/abc123/config/skills/work-stages/SKILL.md", known)).toBe("work-stages");
    expect(installedSkillFromPath("/Users/u/.claude/skills/full-stop/SKILL.md", known)).toBe("full-stop");
    expect(installedSkillFromPath("/Users/u/.codex/skills/work-stages/SKILL.md", known)).toBe("work-stages");
    // Reading tracked dotfiles source files while editing does not count as loading a skill.
    expect(installedSkillFromPath("/Users/u/.t3/worktrees/.config/task-1/claude/skills/diff-review/SKILL.md", known)).toBeNull();
    expect(installedSkillFromPath("/Users/u/.config/claude/skills/diff-review/SKILL.md", known)).toBeNull();
    expect(installedSkillFromPath("/Users/u/.gemini/config/skills/rust/SKILL.md", known)).toBeNull();
  });
});

describe("transcript loads and post-load corrections", () => {
  test("counts Skill calls (main and subagent), deduped agent preloads, and Antigravity SKILL.md reads", () => {
    const start = Date.parse("2026-11-20T10:00:00Z");
    // Main session: loads work-stages, full-stop (with slash), refused cheat-sheets,
    // unrelated frontend-ui, one reviewer Agent with a matching subagent transcript,
    // one reviewer Agent without a transcript, and one refused reviewer Agent.
    const main = new Transcript({ start })
      .prompt("Implement the feature")
      .tool("Skill", { skill: "work-stages" }, "loaded")
      .tool("Skill", { skill: "/full-stop" }, "loaded")
      .tool("Skill", { skill: "cheat-sheets" }, "denied", { isError: true })
      .tool("Skill", { skill: "frontend-ui" }, "loaded")
      .tool("Agent", { subagent_type: "reviewer", prompt: "origin/main...abc" }, "[]");
    const firstReviewerId = main.records.findLast((r) => r.type === "assistant").message.content[0].id;
    main
      .tool("Agent", { subagent_type: "reviewer", prompt: "origin/main...def" }, "[]")
      .tool("Agent", { subagent_type: "reviewer", prompt: "HEAD" }, "refused", { isError: true });
    const refusedReviewerId = main.records.findLast((r) => r.type === "assistant").message.content[0].id;
    main
      .prompt("no, you forgot the edge case")
      .text("fixed");
    const reviewerSub = new Transcript({ sessionId: main.sessionId, start: start + 15_000 })
      .prompt("origin/main...abc")
      .text("[]");
    // Unmarked reviewer subagent (omitted toolUseId): pairs with the second reviewer Agent call, not double-counted.
    const unmarkedReviewer = new Transcript({ sessionId: main.sessionId, start: start + 20_000 })
      .prompt("origin/main...def")
      .text("[]");
    // Extra reviewer subagent with no Agent call in main: counts as a third preload.
    const orphanReviewer = new Transcript({ sessionId: main.sessionId, start: start + 22_000 })
      .prompt("origin/main...xyz")
      .text("[]");
    // Subagent left behind by the refused reviewer Agent call: must NOT count.
    const refusedReviewerSub = new Transcript({ sessionId: main.sessionId, start: start + 23_000 })
      .prompt("HEAD")
      .text("[]");
    const workerSub = new Transcript({ sessionId: main.sessionId, start: start + 25_000 })
      .prompt("capture")
      .tool("Skill", { skill: "headless-browser" }, "loaded")
      .tool("Skill", { skill: "ui-climb" }, "denied", { isError: true });

    // Second session: correction happened BEFORE ui-climb was loaded, so ui-climb has no post-load correction.
    const second = new Transcript({ start: start + 60_000 })
      .prompt("Update layout")
      .text("done")
      .prompt("wrong spacing")
      .tool("Skill", { skill: "ui-climb" }, "loaded")
      .text("climbed");

    // Third session: agent-launched session loading work-stages (excluded from person correction rate).
    const delegated = new Transcript({ start: start + 120_000 })
      .prompt("Act as the implementation sub-agent for this task.")
      .tool("Skill", { skill: "work-stages" }, "loaded")
      .prompt("no, redo that")
      .text("done");

    const claudeRoot = writeProjects([
      {
        transcript: main,
        subagents: [
          { id: "agent-r1", meta: { agentType: "reviewer", toolUseId: firstReviewerId }, transcript: reviewerSub },
          { id: "agent-r2", meta: { agentType: "reviewer" }, transcript: unmarkedReviewer },
          { id: "agent-r3", meta: { agentType: "reviewer" }, transcript: orphanReviewer },
          { id: "agent-r4", meta: { agentType: "reviewer", toolUseId: refusedReviewerId }, transcript: refusedReviewerSub },
          { id: "agent-w1", meta: { agentType: "worker", toolUseId: "toolu_99" }, transcript: workerSub },
        ],
      },
      { transcript: second },
      { transcript: delegated },
    ], join(scratch, "projects"));

    // Antigravity sessions:
    // 1. Person session with a same-second correcting prompt triggering diff-review read (must NOT count as post-load correction),
    //    a repo source read (ignored), a successful cheat-sheets read, and a failed full-stop read (ok: false, ignored).
    const brain = join(scratch, "brain");
    const conv1 = join(brain, "conv-1", ".system_generated", "logs");
    mkdirSync(conv1, { recursive: true });
    writeFileSync(join(conv1, "transcript.jsonl"), [
      { type: "USER_INPUT", source: "USER_EXPLICIT", created_at: "2026-11-20T11:00:00Z", content: "<user_request>Review diff</user_request>" },
      { type: "USER_INPUT", source: "USER_EXPLICIT", created_at: "2026-11-20T11:00:05Z", content: "no, read diff-review first" },
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T11:00:05Z",
        model: "gemini-4-neon-high",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        tool_calls: [
          { name: "read_file", args: { Path: JSON.stringify("/Users/u/.gemini/config/skills/diff-review/SKILL.md") } },
          { name: "read_file", args: { Path: JSON.stringify("/Users/u/.t3/worktrees/.config/task-1/claude/skills/ui-climb/SKILL.md") } },
          { name: "read_file", args: { Path: JSON.stringify("/Users/u/.t3/userdata/providers/antigravity/abc/config/skills/cheat-sheets/SKILL.md") } },
          { name: "read_file", args: { Path: JSON.stringify("/Users/u/.gemini/config/skills/full-stop/SKILL.md") } },
        ],
      },
      { type: "GENERIC", created_at: "2026-11-20T11:00:06Z", content: "Showing lines 1-70 of 70" },
      { type: "GENERIC", created_at: "2026-11-20T11:00:06Z", content: "Showing lines 1-10 of 10" },
      { type: "GENERIC", created_at: "2026-11-20T11:00:06Z", content: "Showing lines 1-49 of 49" },
      { type: "GENERIC", created_at: "2026-11-20T11:00:06Z", content: "Encountered error in tool execution: file does not exist" },
      { type: "USER_INPUT", source: "USER_EXPLICIT", created_at: "2026-11-20T11:01:00Z", content: "thanks, looks good" },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");

    // 2. Zero-prompt Antigravity subagent session (origin: null) reading diff-review:
    //    counts in loads and sessions, NOT in person corrections.sessions.
    const conv2 = join(brain, "conv-2", ".system_generated", "logs");
    mkdirSync(conv2, { recursive: true });
    writeFileSync(join(conv2, "transcript.jsonl"), [
      { type: "SYSTEM_MESSAGE", created_at: "2026-11-20T11:05:00Z", content: "Read diff-review" },
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T11:05:01Z",
        model: "gemini-4-neon-high",
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 0,
        tool_calls: [{ name: "read_file", args: { Path: JSON.stringify("/Users/u/.gemini/config/skills/diff-review/SKILL.md") } }],
      },
      { type: "GENERIC", created_at: "2026-11-20T11:05:02Z", content: "Showing lines 1-70 of 70" },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");

    // 3. Agent-delegated Antigravity session (origin: "agent") reading work-stages:
    //    counts in loads and sessions, NOT in person corrections.sessions.
    const conv3 = join(brain, "conv-3", ".system_generated", "logs");
    mkdirSync(conv3, { recursive: true });
    writeFileSync(join(conv3, "transcript.jsonl"), [
      { type: "USER_INPUT", source: "USER_EXPLICIT", created_at: "2026-11-20T11:10:00Z", content: "<user_request>Act as the worker subagent</user_request>" },
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T11:10:01Z",
        model: "gemini-4-neon-high",
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 0,
        tool_calls: [{ name: "read_file", args: { Path: JSON.stringify("/Users/u/.gemini/config/skills/work-stages/SKILL.md") } }],
      },
      { type: "GENERIC", created_at: "2026-11-20T11:10:02Z", content: "Showing lines 1-42 of 42" },
      { type: "USER_INPUT", source: "USER_EXPLICIT", created_at: "2026-11-20T11:11:00Z", content: "no, redo that" },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");

    const skills = dotfilesSkills();
    const preloads = agentPreloads();
    const allSessions = [...loadSessions({ root: claudeRoot }), ...loadAntigravitySessions({ roots: [brain] })];
    const entries = allSessions.map((session) => ({
      session,
      prompts: session.prompts,
      skillLoads: sessionSkillLoads(session, { skills, preloads }),
    }));
    const stats = skillStats(entries, { skills });
    const byName = Object.fromEntries(stats.map((row) => [row.name, row]));

    // diff-review: 3 preloads in main (r1 deduped by toolUseId, r2 deduped without toolUseId, orphan r3; refused r4 ignored)
    // + 2 reads in Antigravity (conv1 person with same-second prompt -> 0 correction, conv2 origin:null -> excluded from corrections.sessions).
    expect(byName["diff-review"]).toMatchObject({
      loads: 5, toolCalls: 0, preloads: 3, reads: 2, sessions: 3,
      corrections: { sessions: 2, withCorrection: 1, rate: 0.5 },
    });
    // work-stages: 1 in main (person, corrected after load) + 1 in Claude delegated + 1 in Antigravity delegated (both origin:"agent").
    expect(byName["work-stages"]).toMatchObject({
      loads: 3, toolCalls: 2, preloads: 0, reads: 1, sessions: 3,
      corrections: { sessions: 1, withCorrection: 1, rate: 1 },
    });
    // full-stop: 1 in main (person, corrected after load); failed Antigravity read ignored.
    expect(byName["full-stop"]).toMatchObject({
      loads: 1, toolCalls: 1, preloads: 0, reads: 0, sessions: 1,
      corrections: { sessions: 1, withCorrection: 1, rate: 1 },
    });
    // headless-browser: 1 in workerSub of main (person, loaded after main's correction prompt at +14s? No, main's correction is at +13s, workerSub is at +25s -> no post-load correction!).
    expect(byName["headless-browser"]).toMatchObject({
      loads: 1, toolCalls: 1, preloads: 0, reads: 0, sessions: 1,
      corrections: { sessions: 1, withCorrection: 0, rate: 0 },
    });
    // ui-climb: 1 in second (correction happened BEFORE load -> 0 withCorrection); repo source read in Antigravity ignored.
    expect(byName["ui-climb"]).toMatchObject({
      loads: 1, toolCalls: 1, preloads: 0, reads: 0, sessions: 1,
      corrections: { sessions: 1, withCorrection: 0, rate: 0 },
    });
    // cheat-sheets: refused Claude Skill ignored; Antigravity installed read counted (no correction).
    expect(byName["cheat-sheets"]).toMatchObject({
      loads: 1, toolCalls: 0, preloads: 0, reads: 1, sessions: 1,
      corrections: { sessions: 1, withCorrection: 0, rate: 0 },
    });
  });
});

describe("git commits and weekly report synthesis", () => {
  async function git(args, cwd, env = {}) {
    const res = await runProcess(["git", ...args], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@e.st", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@e.st", ...env },
    });
    expect(res.code).toBe(0);
    return res.stdout.trim();
  }

  test("counts non-merge dotfiles commits per skill in the window and handles git errors gracefully", async () => {
    const repo = join(scratch, "dotfiles");
    mkdirSync(join(repo, "claude", "skills", "full-stop"), { recursive: true });
    mkdirSync(join(repo, "claude", "skills", "work-stages"), { recursive: true });
    await git(["init", "-q", "-b", "main"], repo);

    // Commit 1: before window.
    writeFileSync(join(repo, "claude", "skills", "full-stop", "SKILL.md"), "v1\n");
    await git(["add", "."], repo);
    await git(["commit", "-q", "-m", "old commit"], repo, { GIT_COMMITTER_DATE: "2026-11-01T10:00:00Z", GIT_AUTHOR_DATE: "2026-11-01T10:00:00Z" });

    // Commit 2: in window, touches two skills + a non-skill file.
    writeFileSync(join(repo, "claude", "skills", "full-stop", "SKILL.md"), "v2\n");
    writeFileSync(join(repo, "claude", "skills", "work-stages", "SKILL.md"), "v1\n");
    writeFileSync(join(repo, "README.md"), "hi\n");
    await git(["add", "."], repo);
    await git(["commit", "-q", "-m", "update two skills"], repo, { GIT_COMMITTER_DATE: "2026-11-18T12:00:00Z", GIT_AUTHOR_DATE: "2026-11-18T12:00:00Z" });
    const h2 = await git(["rev-parse", "--short", "HEAD"], repo);

    // Commit 3: in window, touches full-stop only (two files in full-stop -> still 1 commit).
    writeFileSync(join(repo, "claude", "skills", "full-stop", "SKILL.md"), "v3\n");
    writeFileSync(join(repo, "claude", "skills", "full-stop", "extra.md"), "x\n");
    await git(["add", "."], repo);
    await git(["commit", "-q", "-m", "refine full-stop"], repo, { GIT_COMMITTER_DATE: "2026-11-20T12:00:00Z", GIT_AUTHOR_DATE: "2026-11-20T12:00:00Z" });
    const h3 = await git(["rev-parse", "--short", "HEAD"], repo);

    const { bySkill, error } = await skillCommits({
      repo,
      since: Date.parse("2026-11-15T00:00:00Z"),
      until: Date.parse("2026-11-22T00:00:00Z"),
    });
    expect(error).toBeNull();
    expect(bySkill["full-stop"].map((c) => c.hash)).toEqual([h3, h2]);
    expect(bySkill["work-stages"].map((c) => c.hash)).toEqual([h2]);
    expect(bySkill["cheat-sheets"]).toEqual([]);

    const missing = await skillCommits({ repo: join(scratch, "does-not-exist"), since: 0, until: Date.now() });
    expect(missing.bySkill).toBeNull();
    expect(missing.error).toContain("git log claude/skills");
  });

  test("aggregates feedback across <skill> and skills:<skill> and renders weekly lines", () => {
    const skills = dotfilesSkills();
    const evolve = {
      setups: [
        { id: "ui-climb", items: 2, reports: 3, untriaged: [], routedOpen: [{ id: "f1" }], fixed: 1, recurrences: 0 },
        { id: "skills:ui-climb", items: 1, reports: 1, untriaged: [{ id: "f2" }], routedOpen: [], fixed: 0, recurrences: 0 },
        { id: "headless-browser", items: 1, reports: 1, untriaged: [], routedOpen: [], fixed: 0, recurrences: 0 },
        // Older item with no new reports this week, but its routed owner task finished in the window.
        { id: "work-stages", items: 0, reports: 0, untriaged: [], routedOpen: [], fixed: 1, recurrences: 0 },
      ],
    };
    expect(skillFeedback(evolve, { name: "ui-climb" })).toEqual({ items: 3, reports: 4, untriaged: 1, routedOpen: 1, fixed: 1, recurrences: 0 });
    expect(skillFeedback(evolve, { name: "cheat-sheets" })).toEqual({ items: 0, reports: 0, untriaged: 0, routedOpen: 0, fixed: 0, recurrences: 0 });
    expect(skillFeedback(null, { name: "ui-climb" })).toBeNull();

    const metrics = {
      current: {
        skills: [
          { name: "diff-review", loads: 5, toolCalls: 1, preloads: 3, reads: 1, sessions: 4, corrections: { sessions: 3, withCorrection: 1, rate: 1 / 3 } },
          { name: "headless-browser", loads: 2, toolCalls: 2, preloads: 0, reads: 0, sessions: 2, corrections: { sessions: 0, withCorrection: 0, rate: null } },
        ],
      },
      previous: { skills: [] },
    };
    const commits = {
      "full-stop": [{ hash: "aaa1111" }, { hash: "bbb2222" }, { hash: "ccc3333" }, { hash: "ddd4444" }],
      "diff-review": [{ hash: "eee5555" }],
    };
    const report = weeklySkillReport({ metrics, evolve, commits, skills });
    const lines = weeklySkillLines(report);
    expect(lines).toEqual([
      "- cheat-sheets: 0 loads; 0 feedback reports; 0 commits",
      "- diff-review: 5 loads (1 Skill, 3 preloads, 1 read) in 4 sessions (1/3 with correction); 0 feedback reports (setup: instructions); 1 commit (eee5555)",
      "- full-stop: 0 loads; 0 feedback reports; 4 commits (aaa1111, bbb2222, ccc3333, … +1)",
      "- headless-browser: 2 loads (2 Skill) in 2 sessions; 1 feedback report (1 item); 0 commits",
      "- ui-climb: 0 loads; 4 feedback reports (3 items, 1 fixed, 1 open, 1 untriaged); 0 commits",
      "- work-stages: 0 loads; 0 feedback reports (1 fixed); 0 commits",
    ]);

    const degraded = weeklySkillLines(weeklySkillReport({ metrics: null, evolve: null, commits: null, commitsError: "git log failed", skills: skills.slice(0, 1) }));
    expect(degraded).toEqual([
      "- cheat-sheets: loads n/a; feedback n/a; commits n/a",
      "- Failed: git log failed",
    ]);
  });
});
