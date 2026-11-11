// OpenCode 2.2.7 evaluates session permissions AFTER agent permissions, and native
// children inherit the session rules. Enforce role invariants at the supported
// post-evaluation boundary, including when a host supplies session-wide allow-all.
import { homedir } from "node:os";
import { resolve } from "node:path";

// Structural subset of the documented @opencode/plugin server context. No runtime
// SDK dependency is needed for a local plugin; OpenCode owns these validated values.
type Evaluation = {
  readonly sessionID: string;
  readonly agent?: string;
  readonly action: string;
  readonly resources: readonly string[];
  effect: "allow" | "ask" | "deny";
  message?: string;
};
type Skill = { id: string; path: string; content: string };
type Context = {
  app: { version: string };
  location: { directory: string };
  session: { get(input: { sessionID: string }): Promise<{ agent?: string }> };
  permission: { hook(name: "evaluate", callback: (event: Evaluation) => Promise<void>): Promise<unknown> };
  skill: {
    transform(callback: (editor: {
      get(id: string): Skill | undefined;
      update(id: string, update: (skill: Skill) => void): void;
    }) => void): Promise<unknown>;
  };
};

const investigation = new Set(["read", "glob", "grep", "webfetch", "websearch", "skill", "external_directory"]);
const leafAgents = new Set(["general", "worker", "solver"]);

// This exact paragraph in the shipped 2.2.7 skill mistakenly labels the SAME URL
// V1 and V2. Do not replace user skills, other prose, or future built-in versions.
const typo = "Do not use <https://opencode.ai/docs/>, which documents V1, and do not use\ngeneral web search to resolve a V2 documentation question when the V2 docs or\nlinked pages cover it.";
const correction = "Do not use V1 documentation or general web search to resolve a V2\ndocumentation question when the V2 docs or linked pages cover it.";

export default {
  id: "setup-policy",
  async setup(ctx: Context) {
    const home = process.env.HOME || homedir();
    const plan = resolve(home, ".opencode/plan") + "/";

    await ctx.permission.hook("evaluate", async (event) => {
      // Core does not call evaluate for a configured deny. Never relax one if a
      // future runtime does, and do not cache an agent across session switches.
      if (event.effect === "deny") return;
      const agent = event.agent ?? (await ctx.session.get({ sessionID: event.sessionID })).agent;
      let denied = agent === "title" || agent === "summary";
      if (agent === "explorer" || agent === "explore") {
        denied = !investigation.has(event.action) || (agent === "explore" && event.action === "skill");
        if (event.action === "read" && event.resources.some((path) => /\.env(?:\..*)?$/.test(path) && !path.endsWith(".env.example"))) {
          event.effect = "ask";
          event.message = "Investigation roles require approval to read environment secrets.";
        }
      }
      if (agent && leafAgents.has(agent)) {
        denied ||= event.action === "subagent" || (agent === "general" && event.action === "question");
      }
      if (agent === "plan" && ["edit", "write", "patch"].includes(event.action)) {
        denied = event.resources.some((resource) => {
          const path = resource.startsWith("~/") ? resolve(home, resource.slice(2)) : resolve(ctx.location.directory, resource);
          return !path.startsWith(plan);
        });
      }
      if (denied) {
        event.effect = "deny";
        event.message = `The ${agent} role does not permit ${event.action}; session-wide approvals do not override role restrictions.`;
      }
    });

    if (ctx.app.version === "2.2.7") {
      await ctx.skill.transform((editor) => {
        const skill = editor.get("opencode");
        if (skill?.path !== "skill://opencode/SKILL.md" || !skill.content.includes(typo)) return;
        editor.update("opencode", (draft) => { draft.content = draft.content.replace(typo, correction); });
      });
    }
  },
};
