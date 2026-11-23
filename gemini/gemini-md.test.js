import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

// Antigravity truncates single instruction/rule files past 24,000 bytes.
const ANTIGRAVITY_BYTE_LIMIT = 24_000;

describe("gemini/GEMINI.md completeness, hygiene, and runtime alignment", () => {
  const geminiMd = read("gemini/GEMINI.md");
  const hooksJson = JSON.parse(read("gemini/hooks.json"));
  const mcpConfig = JSON.parse(read("gemini/mcp_config.json"));

  test("stays comfortably below Antigravity's 24,000-byte per-file truncation limit", () => {
    const bytes = Buffer.byteLength(geminiMd, "utf8");
    expect(bytes).toBeGreaterThan(8_000);
    expect(bytes).toBeLessThan(ANTIGRAVITY_BYTE_LIMIT);
  });

  test("includes every core section self-contained in GEMINI.md", () => {
    const requiredHeadings = [
      "## Working preferences",
      "## Skills",
      "## Workflow",
      "### Settling a T3 thread",
      "## Autonomy",
      "### Merging pull requests",
      "## Delegation",
      "## Review",
      "## Work board",
      "## Storage, Remote Hosts, Vault & Desktop",
      "## Feedback",
      "## Basic safeguards",
    ];
    for (const heading of requiredHeadings) {
      expect(geminiMd).toContain(heading);
    }
  });

  test("contains no unportable paths, private hostnames, or Claude-only leftovers", () => {
    const forbidden = [
      "~/.claude/",
      "/Users/",
      "EnterWorktree",
      "ToolSearch",
      "select:Artifact",
      "ReportFindings",
      "ultrathink",
      "ultracode",
      "no-session-env",
      "Simple Technical English",
      "/code-review",
      "/simplify",
      "/security-review",
      "dataviz",
    ];
    for (const needle of forbidden) {
      expect(geminiMd).not.toContain(needle);
    }
    expect(geminiMd).not.toMatch(/\.ts\.net\b/);
  });

  test("enforces Gemini 4 Neon / Antigravity model routing and native orchestration", () => {
    expect(geminiMd).toContain("Gemini 4 Neon");
    expect(geminiMd).toContain("~/.local/bin/agy-run");
    expect(geminiMd).toContain("invoke_subagent");
    expect(geminiMd).toContain("define_subagent");
    expect(geminiMd).toContain("run_workflow");
    expect(geminiMd).toContain("/swarm");
    expect(geminiMd).toContain("t3_worktree_handoff");
    expect(geminiMd).toContain("t3_thread_launch");
    expect(geminiMd).toContain("t3_thread_organize");
    expect(geminiMd).toContain("diff-review");
  });

  test("warns against invoke_subagent run_command timeouts and stages diffs for read_file-only review", () => {
    expect(geminiMd).not.toContain('use `invoke_subagent` (`TypeName: "self"`, `Workspace: "inherit"`, strictly read-only)');
    expect(geminiMd).toContain("Do not rely on `invoke_subagent` running `git diff` or other `run_command` calls");
    expect(geminiMd).toContain("`invoke_subagent` `run_command` calls time out in T3 Antigravity threads");
    expect(geminiMd).toContain("use `delegate_task` or `~/.local/bin/agy-run`");
  });

  test("preserves user tone and translation preferences", () => {
    expect(geminiMd).toContain("language other than English or Chinese");
    expect(geminiMd).toContain("keep normal chat questions natural");
    expect(geminiMd).not.toContain("Explain an item I ask about in the same structure");
  });

  test("all repo-tracked ~/.config/ paths referenced in GEMINI.md exist in the repository", () => {
    const matches = [...geminiMd.matchAll(/~\/\.config\/([A-Za-z0-9._/-]+)/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const [, rel] of matches) {
      expect(existsSync(join(REPO, rel))).toBe(true);
    }
  });

  test("documents every ask-policy reason from claude/hooks/ask-policy.json", () => {
    const policy = JSON.parse(read("claude/hooks/ask-policy.json"));
    const reasons = Object.keys(policy.reasons);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(geminiMd).toContain(`- \`${reason}\`:`);
    }
  });

  test("lists all 12 global skills matching SKILLS_CATALOG.md and keeps frontend-avoid unconditional", () => {
    const catalog = read("gemini/SKILLS_CATALOG.md");
    const catalogSkills = [...catalog.matchAll(/`~\/\.gemini\/config\/skills\/([a-z0-9-]+)`/g)].map(
      ([, name]) => name,
    );
    expect(catalogSkills.length).toBe(12);
    for (const skill of catalogSkills) {
      expect(geminiMd).toContain(`\`${skill}\``);
    }
    expect(geminiMd).toContain("For all `frontend-ui` work, also check `~/.config/claude/frontend-avoid.md`");
  });

  test("aligns with hooks configured in gemini/hooks.json", () => {
    const hooksRaw = JSON.stringify(hooksJson);
    const hookedInGeminiMd = [
      "guard-main-checkout",
      "guard-pr-merge",
      "auto-merge",
      "guard-asks",
      "open-items",
    ];
    for (const hook of [...hookedInGeminiMd, "guard-runtimes", "board-hook.sh"]) {
      expect(hooksRaw).toContain(hook);
    }
    for (const hook of hookedInGeminiMd) {
      expect(geminiMd).toContain(`\`${hook}\``);
    }
  });

  test("aligns with MCP servers configured in gemini/mcp_config.json (board + desktop)", () => {
    expect(mcpConfig.mcpServers.board).toBeDefined();
    expect(mcpConfig.mcpServers.desktop).toBeDefined();
    expect(JSON.stringify(mcpConfig.mcpServers.desktop)).toContain(
      "claude/marketplace/computer-use/server/desktop.js",
    );
    expect(geminiMd).toContain("`board` MCP server");
    expect(geminiMd).toContain("`desktop` MCP server");
    expect(geminiMd).toContain("~/.config/claude/marketplace/computer-use/server/desktop.js");
  });
});
