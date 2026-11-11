// Gives opencode sessions the Claude Code setup's hooks, board identity and memory.
// Event mapping (Claude event <- opencode plugin hook):
//   PreToolUse <- tool execute.before (a block throws, which refuses the call)
//   PostToolUse, PostToolUseFailure <- tool execute.after
//   SessionStart startup <- a root session's first prompt; compact <- the first request after compaction
//   UserPromptSubmit <- session prompt; PreCompact <- session compaction
//   Stop <- session experimental.idle (a block sends the reason back as a synthetic prompt)
//   StopFailure <- session.execution.failed; SessionEnd <- session.deleted and plugin shutdown
// Hook commands see session_id = the root opencode session, so subagents share their
// parent's board identity as they do in Claude Code. Board MCP calls get that identity
// through their `agent` argument, and shell commands through CLAUDE_CODE_SESSION_ID.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeToolInput,
  claudeToolName,
  leakedKeys,
  loadHooks,
  memoryDir,
  runHooks,
  stopFailureType,
  type Outcome,
} from "./hooks.ts";

function projectRoot(directory: string): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return common.endsWith("/.git") ? common.slice(0, -5) : directory;
  } catch {
    // Not a git repository: Claude keys the memory by the directory itself.
    return directory;
  }
}

export default {
  id: "claude-hooks",
  async setup(ctx: any) {
    // The hook commands expand $HOME, so the settings and memory follow it too.
    const home = process.env.HOME || homedir();
    const settings = join(home, ".claude", "settings.json");
    const directory: string = ctx.location.directory;
    const parents = new Map<string, string | null>();
    const started = new Set<string>();
    const compacted = new Set<string>();
    const stopActive = new Set<string>();
    const toolInputs = new Map<string, unknown>();
    const shellSessions = new Map<string, string>();

    async function parentOf(sessionID: string): Promise<string | null> {
      if (!parents.has(sessionID)) {
        const session = await ctx.session.get({ sessionID });
        parents.set(sessionID, session?.parentID ?? null);
      }
      return parents.get(sessionID)!;
    }

    async function rootOf(sessionID: string): Promise<string> {
      let current = sessionID;
      for (let parent = await parentOf(current); parent; parent = await parentOf(current)) current = parent;
      return current;
    }

    function fire(event: string, sessionID: string, payload: Record<string, unknown>, target?: string, cwd = directory) {
      return runHooks({
        hooks: loadHooks(settings),
        event,
        target,
        payload,
        sessionID,
        cwd,
        projectDir: directory,
        env: process.env,
      });
    }

    async function putContext(sessionID: string, key: string, outcome: Outcome) {
      if (outcome.context.length) {
        await ctx.session.instructions.entry.put({ sessionID, key, value: outcome.context.join("\n\n") });
      } else {
        await ctx.session.instructions.entry.remove({ sessionID, key });
      }
    }

    async function sessionStart(sessionID: string, source: string) {
      const outcome = await fire("SessionStart", sessionID, { source }, source);
      const memory = memoryDir(home, projectRoot(directory));
      const index = join(memory, "MEMORY.md");
      if (existsSync(index)) {
        outcome.context.push(
          `Claude Code's persistent memory for this project is in ${memory}. Its index, MEMORY.md:\n\n${readFileSync(index, "utf8")}`,
        );
      }
      await putContext(sessionID, "claude-hooks.session-start", outcome);
    }

    await ctx.tool.hook("execute.before", async (e: any) => {
      const root = await rootOf(e.sessionID);
      const input = (e.input ?? {}) as Record<string, unknown>;
      if (e.tool.startsWith("board_") && input.agent === undefined) input.agent = `claude:${root}`;
      if (e.tool === "shell" && typeof input.command === "string") shellSessions.set(input.command, root);
      toolInputs.set(e.id, input);
      const name = claudeToolName(e.tool);
      const cwd = e.tool === "shell" && typeof input.workdir === "string" ? input.workdir : directory;
      const outcome = await fire(
        "PreToolUse",
        root,
        { tool_name: name, tool_input: claudeToolInput(e.tool, input), tool_use_id: e.id },
        name,
        cwd,
      );
      if (outcome.block) {
        toolInputs.delete(e.id);
        throw new Error(outcome.block);
      }
    });

    await ctx.tool.hook("execute.after", async (e: any) => {
      const input = (toolInputs.get(e.id) ?? e.input ?? {}) as Record<string, unknown>;
      toolInputs.delete(e.id);
      const root = await rootOf(e.sessionID);
      const name = claudeToolName(e.tool);
      const tool_input = claudeToolInput(e.tool, input);
      if (e.status === "completed") {
        const outcome = await fire(
          "PostToolUse",
          root,
          { tool_name: name, tool_input, tool_response: e.result?.output ?? e.result, tool_use_id: e.id },
          name,
        );
        if (outcome.context.length) e.result.content = [...(e.result.content ?? []), { type: "text", text: outcome.context.join("\n\n") }];
      } else {
        const outcome = await fire(
          "PostToolUseFailure",
          root,
          { tool_name: name, tool_input, error: e.error?.message ?? String(e.error), tool_use_id: e.id },
          name,
        );
        await putContext(e.sessionID, "claude-hooks.tool-failure", outcome);
      }
    });

    await ctx.shell.hook("create.before", (e: any) => {
      // Commands from shell tool calls run as their session; leaked parent ids never apply.
      for (const key of leakedKeys(process.env)) e.env[key] = undefined;
      const sessionID = shellSessions.get(e.command);
      if (sessionID) {
        shellSessions.delete(e.command);
        e.env.CLAUDE_CODE_SESSION_ID = sessionID;
      }
    });

    await ctx.session.hook("prompt", async (e: any) => {
      // A throw here fails the user's prompt, so hook problems are logged instead.
      try {
        stopActive.delete(e.sessionID);
        if ((await parentOf(e.sessionID)) !== null) return;
        if (!started.has(e.sessionID)) {
          started.add(e.sessionID);
          await sessionStart(e.sessionID, "startup");
        }
        const outcome = await fire("UserPromptSubmit", e.sessionID, { prompt: e.prompt?.text ?? "" });
        await putContext(e.sessionID, "claude-hooks.prompt", outcome);
      } catch (error) {
        console.error("claude-hooks: prompt hooks failed", error);
      }
    });

    await ctx.session.hook("compaction", async (e: any) => {
      if ((await parentOf(e.sessionID)) !== null) return;
      await fire("PreCompact", e.sessionID, { trigger: "auto", custom_instructions: "" }, "auto");
      compacted.add(e.sessionID);
    });

    await ctx.session.hook("context", async (e: any) => {
      if (!compacted.delete(e.sessionID)) return;
      await sessionStart(e.sessionID, "compact");
    });

    await ctx.session.hook("experimental.idle", async (e: any) => {
      if ((await parentOf(e.sessionID)) !== null) return;
      const active = stopActive.has(e.sessionID);
      const outcome = await fire("Stop", e.sessionID, { stop_hook_active: active });
      if (outcome.block && !active) {
        stopActive.add(e.sessionID);
        await ctx.session.synthetic({ sessionID: e.sessionID, text: outcome.block });
      } else {
        stopActive.delete(e.sessionID);
      }
    });

    const ended = new Set<string>();
    async function sessionEnd(sessionID: string, reason: string) {
      if (!started.has(sessionID) || ended.has(sessionID)) return;
      ended.add(sessionID);
      await fire("SessionEnd", sessionID, { reason });
    }

    const events = ctx.event.subscribe();
    (async () => {
      for await (const event of events) {
        try {
          if (event.type === "session.execution.failed") {
            const sessionID = event.data.sessionID;
            if ((await parentOf(sessionID)) !== null) continue;
            const error = event.data.error ?? {};
            const type = stopFailureType(error);
            await fire("StopFailure", sessionID, { error: type, error_details: error.message ?? "" }, type);
          } else if (event.type === "session.deleted") {
            await sessionEnd(event.data.sessionID, "other");
          }
        } catch (error) {
          console.error(`claude-hooks: ${event.type} hooks failed`, error);
        }
      }
    })();

    return async () => {
      await Promise.all([...started].map((sessionID) => sessionEnd(sessionID, "other")));
    };
  },
};
