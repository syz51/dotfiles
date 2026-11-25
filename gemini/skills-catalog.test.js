import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const DOTFILES_SKILLS = [
  "cheat-sheets",
  "diff-review",
  "full-stop",
  "headless-browser",
  "ui-climb",
  "work-stages",
];

const AGENT_SKILLS = [
  "content-research-writer",
  "find-skills",
  "frontend-ui",
  "rust",
  "tauri",
  "typescript",
];

describe("gemini skills catalog and cross-machine skill hygiene", () => {
  const catalog = read("gemini/SKILLS_CATALOG.md");
  const geminiMd = read("gemini/GEMINI.md");

  test("catalog lists all 12 global skills under ~/.gemini/config/skills/", () => {
    for (const name of [...DOTFILES_SKILLS, ...AGENT_SKILLS]) {
      expect(catalog).toContain(`\`${name}\``);
      expect(catalog).toContain(`\`~/.gemini/config/skills/${name}\``);
    }
  });

  test("GEMINI.md points to SKILLS_CATALOG.md and uses portable ~/.config/claude/ paths", () => {
    expect(geminiMd).toContain("~/.gemini/config/SKILLS_CATALOG.md");
    expect(geminiMd).not.toContain("~/.claude/");
  });

  test.each(DOTFILES_SKILLS)("%s has valid frontmatter and no unportable ~/.claude/ paths", (name) => {
    const text = read(`claude/skills/${name}/SKILL.md`);
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match).not.toBeNull();
    expect(match[1]).toMatch(new RegExp(`^name:\\s*${name}$`, "m"));
    expect(match[1]).toMatch(/^description:\s*\S/m);
    expect(text).not.toContain("~/.claude/");
  });

  test("board-ops Gemini App skill passes upload validation and covers all 26 board mcp-http tools and guardrails", () => {
    const skillPath = "gemini/skills/board-ops/SKILL.md";
    const text = read(skillPath);
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
    expect(match).not.toBeNull();

    const meta = Bun.YAML.parse(match[1]);
    expect(meta.name).toBe("board-ops");
    expect(meta.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(typeof meta.description).toBe("string");
    expect(meta.description.trim().length).toBeGreaterThan(20);
    expect(match[2].trim().length).toBeGreaterThan(200);

    expect(text).not.toContain("~/.claude/");
    expect(text).not.toContain("/Users/");
    expect(text).not.toMatch(/\.ts\.net\b/);

    const expectedTools = [
      // Read-only (13)
      "fleet_overview",
      "boards_list",
      "board_status",
      "tasks_list",
      "task_show",
      "asks_list",
      "ask_show",
      "updates_list",
      "devices_list",
      "runs_list",
      "run_events",
      "usage_status",
      "stats_show",
      // Write (9)
      "task_add",
      "task_note",
      "task_update",
      "tasks_rank",
      "ask_answer",
      "updates_mark_seen",
      "feedback_resolve",
      "run_steer",
      "command_run",
      // Destructive / Governance (4)
      "run_cancel",
      "board_update",
      "board_approve",
      "device_update",
    ];
    expect(expectedTools).toHaveLength(26);
    for (const tool of expectedTools) {
      expect(text).toContain(`\`${tool}\``);
    }

    for (const needle of [
      "sunmacbook-air",
      "yizhemacbook-pro",
      "sai",
      "https://board-mcp.syzroy.com/mcp",
      "board-feedback",
      "UNTRUSTED DATA",
      "irreversible",
      "cost",
      "outside",
      "design",
      "only-me",
      "security",
      "intent",
      "active: false",
      "proposal",
      "include_closed",
      "parallel_tasks",
      "verdict_judges",
      "additive and complementary",
    ]) {
      expect(text).toContain(needle);
    }

    expect(catalog).toContain("`board-ops`");
    expect(catalog).toContain("`gemini/skills/board-ops/SKILL.md`");
    expect(catalog).not.toContain("`~/.gemini/config/skills/board-ops`");
  });

  test("gemini-board-workflow.md covers setup, scheduled tasks, Desktop Remote Access, and 4-pool division of labor", () => {
    const doc = read("gemini/docs/gemini-board-workflow.md");
    expect(doc).not.toContain("~/.claude/");
    expect(doc).not.toContain("/Users/");
    expect(doc).not.toMatch(/\.ts\.net\b/);

    for (const needle of [
      "https://board-mcp.syzroy.com/mcp",
      "board-ops",
      "Cloud MCP",
      "Desktop Remote Access",
      "Morning / Evening Fleet Digest",
      "`board-feedback` Triage Sweep",
      "Proposal & Backlog Grooming Sweep",
      "Watchdog Alert",
      "Only message me if",
      "runs_list(active=false)",
      "board_approve",
      "ask_answer",
      "only-me",
      "security",
      "Gemini App",
      "Jules",
      "Antigravity Mac Fleet",
      "Deterministic Runners",
      "UNTRUSTED DATA",
      "verdict_judges",
      "strictly additive and complementary",
    ]) {
      expect(doc).toContain(needle);
    }
  });
});
