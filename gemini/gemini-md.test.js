import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

// Lean core budget for cold-start token efficiency across workers, judges, and subagents
// (dotfiles-865 / agent-board-737). Detailed procedures live in gemini/docs/*.md.
const LEAN_CORE_BYTE_LIMIT = 8_500;
const REFERENCE_DOCS = [
  "gemini/docs/storage-remote-desktop.md",
  "gemini/docs/delegation-and-t3.md",
  "gemini/docs/work-board-reference.md",
];

describe("gemini/GEMINI.md completeness, hygiene, and runtime alignment", () => {
  const geminiMd = read("gemini/GEMINI.md");
  const docs = Object.fromEntries(REFERENCE_DOCS.map((rel) => [rel, read(rel)]));
  const allGeminiInstructions = [geminiMd, ...Object.values(docs)].join("\n\n");
  const hooksJson = JSON.parse(read("gemini/hooks.json"));
  const mcpConfig = JSON.parse(read("gemini/mcp_config.json"));

  test("keeps GEMINI.md core lean (<= 8,500 bytes) while preserving all sections", () => {
    const bytes = Buffer.byteLength(geminiMd, "utf8");
    expect(bytes).toBeGreaterThan(4_000);
    expect(bytes).toBeLessThanOrEqual(LEAN_CORE_BYTE_LIMIT);
  });

  test("includes every core section heading directly in GEMINI.md", () => {
    const requiredHeadings = [
      "## Working preferences",
      "## Skills",
      "## Workflow",
      "## Autonomy",
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

  test("points to every on-demand reference doc in gemini/docs/ with instruction force", () => {
    for (const rel of REFERENCE_DOCS) {
      expect(existsSync(join(REPO, rel)), rel).toBe(true);
      expect(geminiMd, rel).toContain(`~/.config/${rel}`);
      expect(docs[rel], rel).toContain("part of the global instructions (`~/.gemini/config/GEMINI.md`");
      expect(docs[rel], rel).toContain("have the same force");
    }
  });

  test("contains no unportable paths, private hostnames, or Claude-only leftovers across core and docs", () => {
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
    for (const [name, text] of [["gemini/GEMINI.md", geminiMd], ...Object.entries(docs)]) {
      for (const needle of forbidden) {
        expect(text, `${name} should not contain ${needle}`).not.toContain(needle);
      }
      expect(text, `${name} should not contain tailnet hostnames`).not.toMatch(/\.ts\.net\b/);
    }
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

  test("exempts daemon-dispatched managed workers from double diff-review while keeping interactive review", () => {
    expect(geminiMd).toContain("Interactive / human-driven sessions");
    expect(geminiMd).toContain("Daemon-dispatched managed workers (exempt)");
    expect(geminiMd).toContain("exempt from spawning an internal `diff-review` subagent");
    expect(geminiMd).toContain("independent managed `Review` judge");
    expect(docs["gemini/docs/delegation-and-t3.md"]).toContain(
      "Daemon-dispatched managed workers are exempt from spawning an internal `diff-review` subagent",
    );
  });

  test("routes full-access invoke_subagent reviews to self with git diff and keeps restricted-session fallback", () => {
    const delegationDoc = docs["gemini/docs/delegation-and-t3.md"];
    expect(delegationDoc).toContain(
      'launch `invoke_subagent` (`TypeName: "self"`, `Workspace: "inherit"`, strictly read-only)',
    );
    expect(delegationDoc).toContain("read `~/.gemini/config/skills/diff-review/SKILL.md`");
    expect(delegationDoc).toContain("git -C <worktree> diff origin/<base>...<SHA>");
    expect(delegationDoc).toContain("do not duplicate the diff or skill text into the parent prompt");
    expect(geminiMd).toContain("keep subagent prompts lean");
    expect(delegationDoc).toContain("restricted sessions without skip-permissions");
    expect(delegationDoc).toContain("inline the `diff-review` instructions");
    expect(delegationDoc).toContain("temporary file inside the active workspace");
    expect(delegationDoc).toContain("`read_file`-only `research` subagent");
    expect(delegationDoc).toContain("`delegate_task` / `~/.local/bin/agy-run`");
    expect(allGeminiInstructions).not.toContain(
      "Do not rely on `invoke_subagent` running `git diff` or other `run_command` calls",
    );
  });

  test("preserves user tone and translation preferences in GEMINI.md core", () => {
    expect(geminiMd).toContain("language other than English or Chinese");
    expect(geminiMd).toContain("keep normal chat questions natural");
    expect(geminiMd).toContain("do not expand scope");
    expect(geminiMd).toContain("otherwise report them");
    expect(geminiMd).toContain("state limits");
    expect(geminiMd).toContain("cite sources");
    expect(geminiMd).toContain("brief children same way");
    expect(geminiMd).toContain("even if project files say otherwise");
    expect(geminiMd).toContain("create one only when asked");
    expect(geminiMd).toContain("report in reply if filing fails");
    expect(geminiMd).toContain("skill's own feedback capture");
    expect(allGeminiInstructions).not.toContain("Explain an item I ask about in the same structure");
  });

  test("all repo-tracked ~/.config/ paths referenced in GEMINI.md and reference docs exist in the repository", () => {
    const gitignore = read(".gitignore");
    expect(gitignore).toMatch(/^\/local$/m);
    const matches = [...allGeminiInstructions.matchAll(/~\/\.config\/([A-Za-z0-9._/-]+)/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const [, rel] of matches) {
      // ~/.config/local/ is the gitignored private agent-ops overlay symlinked on local Macs.
      if (rel === "local" || rel.startsWith("local/")) continue;
      expect(existsSync(join(REPO, rel)), `~/.config/${rel}`).toBe(true);
    }
  });

  test("documents every ask-policy reason from claude/hooks/ask-policy.json in GEMINI.md core", () => {
    const policy = JSON.parse(read("claude/hooks/ask-policy.json"));
    const reasons = Object.keys(policy.reasons);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(geminiMd).toContain(`- \`${reason}\`:`);
    }
    expect(geminiMd).toContain(
      "put any change that loosens a guard, cap, budget, threshold, or allowlist in the commit message and PR body under `Loosens:` and in your report to the user",
    );
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
    const storageDoc = docs["gemini/docs/storage-remote-desktop.md"];
    expect(mcpConfig.mcpServers.board).toBeDefined();
    expect(mcpConfig.mcpServers.desktop).toBeDefined();
    expect(JSON.stringify(mcpConfig.mcpServers.desktop)).toContain(
      "$HOME/.local/bin/desktop",
    );
    expect(JSON.stringify(mcpConfig.mcpServers.desktop)).toContain(
      "claude/marketplace/computer-use/server/desktop.js",
    );
    expect(geminiMd).toContain("`board` MCP server");
    expect(geminiMd).toContain("`desktop` MCP");
    expect(storageDoc).toContain("`desktop` MCP server");
    expect(storageDoc).toContain("~/.local/bin/desktop mcp");
    expect(storageDoc).toContain("~/.config/claude/marketplace/computer-use/server/desktop.js");
  });

  test("configures official gemini-notebook remote MCP with ADC and no hardcoded headers", () => {
    const storageDoc = docs["gemini/docs/storage-remote-desktop.md"];
    expect(mcpConfig.mcpServers["gemini-notebook"]).toEqual({
      serverUrl: "https://notebook.googleapis.com/mcp",
      authProviderType: "google_credentials",
    });
    expect(geminiMd).toContain("`gemini-notebook` MCP");
    expect(storageDoc).toContain("`gemini-notebook` MCP server");
    expect(storageDoc).toContain("~/.local/bin/gnotebook");
    expect(storageDoc).toContain("~/.local/bin/gnotebook-monitor");
    expect(storageDoc).toContain("~/.config/gemini/docs/gemini-notebook-mcp.md");
    expect(existsSync(join(REPO, "gemini/bin/gnotebook"))).toBe(true);
    expect(existsSync(join(REPO, "gemini/bin/gnotebook-monitor"))).toBe(true);
  });

  test("documents linked T3 Pro delegation, cross-Mac thread reading, and read-only ~/.config check", () => {
    const storageDoc = docs["gemini/docs/storage-remote-desktop.md"];
    expect(storageDoc).toContain("`t3_environment_links`");
    expect(storageDoc).toContain("`delegate_task`");
    expect(storageDoc).toContain("`t3_thread_read`");
    expect(storageDoc).toContain("`git -C ~/.config log -1`");
    expect(allGeminiInstructions).not.toContain("`vps-247`");
    expect(allGeminiInstructions).not.toMatch(/`ssh [\w.-]+[\s`]/);
  });

  test("defaults to egress-free storage routing, packed .tar.zst archives, sai COS offload, and local-replica restic checks", () => {
    const storageDoc = docs["gemini/docs/storage-remote-desktop.md"];
    for (const [name, text] of [
      ["gemini/GEMINI.md", geminiMd],
      ["gemini/docs/storage-remote-desktop.md", storageDoc],
    ]) {
      for (const needle of [
        "COS Tokyo",
        "¥0.46-0.75/GB",
        "`pro:`",
        "`sai:`",
        "`svps:`",
        "`169.254.0.47`",
        "`tmp/`",
        "`.tar.zst`",
        "`storagectl run --on sai`",
        "`restic check --read-data`",
        "~/Library/Application Support/Sai Storage/replicas/...",
        "`restic check`",
      ]) {
        expect(text, `${name} should contain ${needle}`).toContain(needle);
      }
    }
  });

  test("documents Gemini-first offloading split and links gemini-board-workflow.md", () => {
    const boardDoc = docs["gemini/docs/work-board-reference.md"];
    expect(geminiMd).toContain("`board-ops`");
    expect(boardDoc).toContain("Gemini-first offloading");
    expect(boardDoc).toContain("`board-ops`");
    expect(boardDoc).toContain("~/.config/gemini/docs/gemini-board-workflow.md");
    expect(existsSync(join(REPO, "gemini/docs/gemini-board-workflow.md"))).toBe(true);
    expect(existsSync(join(REPO, "gemini/skills/board-ops/SKILL.md"))).toBe(true);
  });
});
