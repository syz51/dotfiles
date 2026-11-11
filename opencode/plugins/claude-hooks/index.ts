// Gives opencode sessions the Claude Code setup's hooks, board identity and memory.
// Event mapping (Claude event <- opencode plugin hook):
//   PreToolUse <- tool execute.before (a block throws, which refuses the call)
//   PostToolUse, PostToolUseFailure <- tool execute.after
//   SessionStart startup <- a root session's first prompt; compact <- the first request after compaction
//   UserPromptSubmit <- session prompt; PreCompact <- session compaction
//   Stop <- session experimental.idle (a block sends the reason back as a synthetic prompt)
//   StopFailure <- session.execution.failed; SessionEnd <- session.deleted and plugin shutdown
// Hook commands see session_id = the root opencode session, so subagents share their
// parent's board identity as they do in Claude Code. That identity is `opencode:<root>`
// with runtime opencode, so the board's Claude usage hold skips it. Board MCP calls get it
// through their `agent` argument, and shell commands and hooks through OPENCODE_SESSION_ID.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
    const settingsOption = ctx.options?.settingsPath;
    if (settingsOption !== undefined && (typeof settingsOption !== "string" || !settingsOption)) throw new Error("claude-hooks settingsPath must be a nonempty path");
    const settings = settingsOption === undefined ? join(home, ".claude", "settings.json") : resolve(settingsOption);
    const directory: string = ctx.location.directory;
    const parents = new Map<string, string | null>();
    const started = new Set<string>();
    const compacted = new Set<string>();
    const stopActive = new Set<string>();
    const toolCalls = new Map<string, { input: Record<string, unknown>; cwd: string; context: string[] }>();
    const children = new Set<string>();
    const pendingStarts = new Map<string, Promise<Outcome>>();
    const eventController = new AbortController();
    const hookController = new AbortController();
    let disposed = false;
    const callKey = (e: any) => JSON.stringify([e.sessionID, e.id]);

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
        signal: event === "SessionEnd" ? undefined : hookController.signal,
      });
    }

    async function putContext(sessionID: string, key: string, outcome: Outcome) {
      if (outcome.context.length) {
        await ctx.session.instructions.entry.put({ sessionID, key, value: outcome.context.join("\n\n") });
      } else {
        await ctx.session.instructions.entry.remove({ sessionID, key });
      }
    }

    function addMemory(outcome: Outcome) {
      const memory = memoryDir(home, projectRoot(directory));
      const index = join(memory, "MEMORY.md");
      if (existsSync(index)) {
        outcome.context.push(
          `Claude Code's persistent memory for this project is in ${memory}. Its index, MEMORY.md:\n\n${readFileSync(index, "utf8")}`,
        );
      }
    }

    async function sessionStart(sessionID: string, source: string) {
      const outcome = await fire("SessionStart", sessionID, { source }, source);
      if (outcome.block || outcome.halt) throw new Error(outcome.halt ?? outcome.block);
      addMemory(outcome);
      await putContext(sessionID, "claude-hooks.session-start", outcome);
      return outcome;
    }

    async function ensureStarted(sessionID: string): Promise<Outcome | undefined> {
      if ((await parentOf(sessionID)) !== null) {
        if (!children.has(sessionID)) {
          const outcome: Outcome = { context: [] };
          addMemory(outcome);
          await putContext(sessionID, "claude-hooks.memory", outcome);
          children.add(sessionID);
          return outcome;
        }
        return;
      }
      if (started.has(sessionID)) return;
      if (!pendingStarts.has(sessionID)) {
        const pending = (async () => {
          const entries = await ctx.session.instructions.entry.list({ sessionID });
          const source = entries.some((entry: any) => entry.key === "claude-hooks.session-start") ? "resume" : "startup";
          const outcome = await sessionStart(sessionID, source);
          ended.delete(sessionID);
          started.add(sessionID);
          return outcome;
        })();
        pendingStarts.set(sessionID, pending);
      }
      try { return await pendingStarts.get(sessionID)!; }
      finally { pendingStarts.delete(sessionID); }
    }

    await ctx.tool.hook("execute.before", async (e: any) => {
      if (disposed) throw new Error("claude-hooks plugin was unloaded");
      const root = await rootOf(e.sessionID);
      const input = (e.input ?? {}) as Record<string, unknown>;
      if (e.tool.startsWith("board_")) {
        if (input.agent !== undefined && input.agent !== `opencode:${root}`) throw new Error("Board actor must be the invoking OpenCode root session; omit agent.");
        input.agent = `opencode:${root}`;
      }
      const name = claudeToolName(e.tool);
      const cwd = e.tool === "shell" && typeof input.workdir === "string" ? input.workdir : directory;
      const outcome = await fire(
        "PreToolUse",
        root,
        { tool_name: name, tool_input: claudeToolInput(e.tool, input), tool_use_id: e.id },
        name,
        cwd,
      );
      if (disposed) throw new Error("claude-hooks plugin was unloaded");
      if (outcome.block || outcome.halt) throw new Error(outcome.halt ?? outcome.block);
      if (outcome.ask) {
        await ctx.permission.assert({
          sessionID: e.sessionID,
          action: "claude_hook_approval",
          resources: [e.tool],
          source: { type: "tool", messageID: e.messageID, id: e.id },
          metadata: { reason: outcome.ask },
        });
      }
      toolCalls.set(callKey(e), { input: { ...input }, cwd, context: outcome.context });
      // Shell create hooks have no session/call identifier in V2. Bind identity in this
      // invocation's command instead of correlating concurrent calls by command text.
      if (e.tool === "shell" && typeof input.command === "string") input.command = `export OPENCODE_SESSION_ID='${root.replaceAll("'", "'\\''")}';\n${input.command}`;
    });

    await ctx.tool.hook("execute.after", async (e: any) => {
      if (disposed) return;
      const call = toolCalls.get(callKey(e));
      const input = (call?.input ?? e.input ?? {}) as Record<string, unknown>;
      toolCalls.delete(callKey(e));
      const root = await rootOf(e.sessionID);
      const name = claudeToolName(e.tool);
      const tool_input = claudeToolInput(e.tool, input);
      const cwd = call?.cwd ?? (e.tool === "shell" && typeof input.workdir === "string" ? input.workdir : directory);
      if (e.status === "completed") {
        const outcome = await fire(
          "PostToolUse",
          root,
          { tool_name: name, tool_input, tool_response: e.result?.output ?? e.result, tool_use_id: e.id },
          name,
          cwd,
        );
        await ctx.session.instructions.entry.remove({ sessionID: e.sessionID, key: "claude-hooks.tool-failure" });
        const context = [...(call?.context ?? []), ...outcome.context];
        if (context.length) e.result.content = [...(e.result.content ?? []), { type: "text", text: context.join("\n\n") }];
      } else {
        const outcome = await fire(
          "PostToolUseFailure",
          root,
          { tool_name: name, tool_input, error: e.error?.message ?? String(e.error), tool_use_id: e.id },
          name,
          cwd,
        );
        outcome.context.unshift(...(call?.context ?? []));
        await putContext(e.sessionID, "claude-hooks.tool-failure", outcome);
      }
    });

    await ctx.shell.hook("create.before", (e: any) => {
      // Commands from shell tool calls run as their session; leaked parent ids never apply.
      for (const key of leakedKeys(process.env)) e.env[key] = undefined;
    });

    await ctx.permission.hook("evaluate", (e: any) => {
      if (e.action === "claude_hook_approval") {
        e.effect = "ask";
        e.message = e.metadata?.reason ?? "A Claude hook requires explicit approval.";
      }
    });

    await ctx.session.hook("prompt", async (e: any) => {
      if (disposed) return;
      stopActive.delete(e.sessionID);
      await ensureStarted(e.sessionID);
      if ((await parentOf(e.sessionID)) !== null) return;
      const outcome = await fire("UserPromptSubmit", e.sessionID, { prompt: e.prompt?.text ?? "" });
      if (outcome.block || outcome.halt) throw new Error(outcome.halt ?? outcome.block);
      await putContext(e.sessionID, "claude-hooks.prompt", outcome);
    });

    await ctx.session.hook("compaction", async (e: any) => {
      if (disposed || (await parentOf(e.sessionID)) !== null) return;
      // V2's compaction request hook does not expose the manual/automatic reason.
      // Undefined target deliberately matches both configurations rather than inventing it.
      const outcome = await fire("PreCompact", e.sessionID, { custom_instructions: "" });
      if (outcome.block || outcome.halt) throw new Error(outcome.halt ?? outcome.block);
      if (outcome.context.length) e.system.push({ type: "text", text: outcome.context.join("\n\n") });
      compacted.add(e.sessionID);
    });

    await ctx.session.hook("context", async (e: any) => {
      if (disposed) return;
      const fresh = await ensureStarted(e.sessionID);
      const outcome = compacted.delete(e.sessionID) ? await sessionStart(e.sessionID, "compact") : fresh;
      if (outcome?.context.length) e.system.push({ type: "text", text: outcome.context.join("\n\n") });
    });

    await ctx.session.hook("experimental.idle", async (e: any) => {
      if (disposed || (await parentOf(e.sessionID)) !== null) return;
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
      started.delete(sessionID);
      compacted.delete(sessionID);
      stopActive.delete(sessionID);
      for (const key of toolCalls.keys()) if ((JSON.parse(key) as string[])[0] === sessionID) toolCalls.delete(key);
    }

    const events = ctx.event.subscribe({ signal: eventController.signal, types: ["session.execution.failed", "session.deleted", "session.archived", "session.moved"] });
    const eventTask = (async () => {
      try { for await (const event of events) {
        if (disposed) break;
        try {
          const sessionID = event.data.sessionID;
          if (!started.has(sessionID)) continue;
          if (event.type === "session.moved") {
            // The destination plugin owns subsequent events, not this old location.
            if (event.data.location?.directory && resolve(event.data.location.directory) !== resolve(directory)) started.delete(sessionID);
            continue;
          }
          if (event.location?.directory && resolve(event.location.directory) !== resolve(directory)) continue;
          if (event.type === "session.execution.failed") {
            const error = event.data.error ?? {};
            const type = stopFailureType(error);
            await fire("StopFailure", sessionID, { error: type, error_details: error.message ?? "" }, type);
          } else if (event.type === "session.deleted" || event.type === "session.archived") {
            await sessionEnd(sessionID, "other");
          }
        } catch (error) {
          console.error(`claude-hooks: ${event.type} hooks failed`, error);
        }
      } } catch (error) { if (!eventController.signal.aborted) console.error("claude-hooks: event subscription failed", error); }
    })();

    return async () => {
      disposed = true;
      eventController.abort();
      hookController.abort();
      await eventTask;
      await Promise.all([...started].map((sessionID) => sessionEnd(sessionID, "other")));
      toolCalls.clear();
      parents.clear();
      children.clear();
    };
  },
};
