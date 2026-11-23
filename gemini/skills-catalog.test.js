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
});
