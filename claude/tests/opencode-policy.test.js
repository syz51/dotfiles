import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import plugin from "../../opencode/plugins/setup-policy/index.ts";

const REPO = join(import.meta.dir, "../..");
const read = (path) => readFileSync(join(REPO, path), "utf8");
const config = JSON.parse(read("opencode/opencode.json"));
const home = process.env.HOME || homedir();
const allowAll = [{ action: "*", resource: "*", effect: "allow" }];
const envRules = [
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
];
const safe = ["read", "glob", "grep", "webfetch", "websearch", "skill", "external_directory"];
const unsafe = ["edit", "write", "patch", "shell", "execute", "subagent", "question", "desktop_click", "opencode_worktree_create", "new_plugin_action"];

// Shipped 2.2.7 policies, followed by the actual tracked custom-agent rules.
// The runtime suite below checks the fixture against the installed evaluator.
function rulesFor(agent) {
  if (["explorer", "worker", "solver"].includes(agent)) {
    return Bun.YAML.parse(/^---\n([\s\S]*?)\n---/.exec(read(`opencode/agents/${agent}.md`))[1]).permissions;
  }
  if (["title", "summary"].includes(agent)) return [{ action: "*", resource: "*", effect: "deny" }];
  if (agent === "general") return ["question", "subagent"].map((action) => ({ action, resource: "*", effect: "deny" }));
  if (agent === "plan") return [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "edit", resource: `${home}/.opencode/plan/*`, effect: "allow" },
  ];
  if (agent === "explore") return [
    { action: "*", resource: "*", effect: "deny" },
    ...[...safe.filter((action) => action !== "skill"), "shell"].map((action) => ({ action, resource: "*", effect: "allow" })),
    ...envRules,
  ];
  return [];
}

function matches(pattern, value) {
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value);
}

async function fixture({ version = "2.2.7", skill } = {}) {
  let evaluate;
  let transform;
  const sessions = new Map([["root", { agent: "build", permissions: allowAll }]]);
  await plugin.setup({
    app: { version },
    location: { directory: "/repo" },
    session: { get: async ({ sessionID }) => sessions.get(sessionID) },
    permission: { hook: async (name, callback) => { expect(name).toBe("evaluate"); evaluate = callback; } },
    skill: { transform: async (callback) => { transform = callback; } },
  });
  const editor = {
    get: (id) => id === skill?.id ? skill : undefined,
    update: (id, change) => { expect(id).toBe(skill.id); change(skill); },
  };
  transform?.(editor);
  return {
    sessions,
    replay: () => transform?.(editor),
    evaluate,
    async check(agent, action, resources = ["*"], { hosted = true, explicitAgent = true } = {}) {
      // Native children inherit their parent's allow-all just as T3's children do.
      sessions.set("child", { agent, parentID: "root", permissions: hosted ? sessions.get("root").permissions : [] });
      const rules = [...allowAll, ...envRules, ...(config.permissions ?? []), ...rulesFor(agent), ...sessions.get("child").permissions];
      const effects = resources.map((resource) => rules.findLast((rule) => matches(rule.action, action) && matches(rule.resource, resource))?.effect ?? "ask");
      const effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow";
      const event = { sessionID: "child", ...(explicitAgent ? { agent } : {}), action, resources, effect };
      // Configured denies are final. Only allow/ask decisions reach the hook.
      if (effect !== "deny") await evaluate(event);
      return event;
    },
  };
}

describe("role policy under session allow-all", () => {
  test("has no redundant global allow; default reasoning is a model setting", () => {
    expect(config.permissions ?? []).not.toContainEqual({ action: "*", resource: "*", effect: "allow" });
    expect(config.model).toBe("opencode/gpt-6.1-sol");
    expect(config.providers.opencode.models["gpt-6.1-sol"].settings.reasoningEffort).toBe("xhigh");
    expect(config.providers.opencode.models["gpt-6-luna"].settings.reasoningEffort).toBe("max");
  });

  for (const hosted of [false, true]) {
    for (const agent of ["explore", "explorer"]) {
      test(`${agent} blocks mutation and escape tools (${hosted ? "inherited full access" : "native rules"})`, async () => {
        const f = await fixture();
        for (const action of unsafe) expect((await f.check(agent, action, ["arbitrary command or resource"], { hosted })).effect).toBe("deny");
        for (const action of safe.filter((action) => action !== "skill" || agent === "explorer")) {
          expect((await f.check(agent, action, ["ordinary source"], { hosted })).effect).toBe("allow");
        }
        if (agent === "explore") expect((await f.check(agent, "skill", ["rust"], { hosted })).effect).toBe("deny");
        expect((await f.check(agent, "read", ["config/.env"], { hosted })).effect).toBe("ask");
        expect((await f.check(agent, "read", ["config/.env.local"], { hosted })).effect).toBe("ask");
        expect((await f.check(agent, "read", ["config/.env.example"], { hosted })).effect).toBe("allow");
      });
    }
  }

  test("title and summary cannot use any tool under full access", async () => {
    const f = await fixture();
    for (const agent of ["title", "summary"]) for (const action of [...safe, ...unsafe]) {
      expect((await f.check(agent, action)).effect).toBe("deny");
    }
  });

  test("General, worker, and solver remain leaves; autonomous work still works", async () => {
    const f = await fixture();
    for (const agent of ["general", "worker", "solver"]) {
      expect((await f.check(agent, "subagent", ["worker"])).effect).toBe("deny");
      for (const action of ["edit", "shell", "execute", "board_task_show"]) expect((await f.check(agent, action)).effect).toBe("allow");
    }
    expect((await f.check("general", "question")).effect).toBe("deny");
    for (const action of [...safe, ...unsafe]) expect((await f.check("build", action)).effect).toBe("allow");
  });

  test("Plan edits only its plan directory, including multi-file and traversal checks", async () => {
    const f = await fixture();
    const good = `${home}/.opencode/plan/design.md`;
    for (const action of ["edit", "write", "patch"]) {
      expect((await f.check("plan", action, [good])).effect).toBe("allow");
      for (const bad of ["src/main.ts", `${home}/.opencode/plan-sibling/a`, `${home}/.opencode/plan/../outside.md`]) {
        expect((await f.check("plan", action, [good, bad])).effect).toBe("deny");
      }
    }
    expect((await f.check("plan", "question")).effect).toBe("allow");
  });

  test("uses explicit auxiliary roles and looks up current roles without a stale cache", async () => {
    const f = await fixture();
    const event = { sessionID: "root", action: "shell", resources: ["ls"], effect: "allow" };
    await f.evaluate(event);
    expect(event.effect).toBe("allow");
    f.sessions.get("root").agent = "explorer";
    await f.evaluate(event);
    expect(event.effect).toBe("deny");
    const auxiliary = { ...event, agent: "title", action: "read", effect: "allow" };
    await f.evaluate(auxiliary);
    expect(auxiliary.effect).toBe("deny");
  });

  test("never relaxes another policy's deny or asks on unrestricted roles", async () => {
    const f = await fixture();
    for (const effect of ["ask", "deny"]) {
      const event = { sessionID: "root", agent: "build", action: "shell", resources: ["ls"], effect };
      await f.evaluate(event);
      expect(event.effect).toBe(effect);
    }
  });
});

const broken = "Use only <https://opencode.ai/docs/> documentation as the source of truth for V2.\nDo not use <https://opencode.ai/docs/>, which documents V1, and do not use\ngeneral web search to resolve a V2 documentation question when the V2 docs or\nlinked pages cover it.\nKeep the remaining skill text.";

describe("known 2.2.7 built-in skill correction", () => {
  test("removes the contradiction once without replacing the skill", async () => {
    const skill = { id: "opencode", path: "skill://opencode/SKILL.md", content: broken };
    const f = await fixture({ skill });
    expect(skill.content).toContain("Use only <https://opencode.ai/docs/>");
    expect(skill.content).toContain("Do not use V1 documentation or general web search");
    expect(skill.content).not.toContain("which documents V1");
    expect(skill.content).toEndWith("Keep the remaining skill text.");
    const corrected = skill.content;
    f.replay();
    expect(skill.content).toBe(corrected);
  });

  test("does not touch local overrides, changed upstream text, or other runtime versions", async () => {
    for (const [version, path, content] of [
      ["2.2.8", "skill://opencode/SKILL.md", broken],
      ["2.2.7", "/home/user/.agents/skills/opencode/SKILL.md", broken],
      ["2.2.7", "skill://opencode/SKILL.md", "Different upstream guidance"],
    ]) {
      const skill = { id: "opencode", path, content };
      await fixture({ version, skill });
      expect(skill.content).toBe(content);
    }
    await fixture(); // Missing skill is valid.
  });
});
