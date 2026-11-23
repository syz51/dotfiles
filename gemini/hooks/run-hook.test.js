import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractLastAssistantMessage,
  runAdaptedHook,
  translateInput,
  translateOutput,
} from "./run-hook.js";

describe("Antigravity hook adapter", () => {
  test("PreToolUse blocks bare python via guard-runtimes with deny decision", () => {
    const res = runAdaptedHook("pre-tool-use", "guard-runtimes", {
      cwd: "/tmp",
      toolCall: { id: "t1", name: "run_command", args: { CommandLine: "python3 foo.py" } },
    });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("uv run");
  });

  test("PreToolUse allows uv run python via guard-runtimes", () => {
    const res = runAdaptedHook("pre-tool-use", "guard-runtimes", {
      cwd: "/tmp",
      toolCall: { id: "t2", name: "run_command", args: { CommandLine: "uv run python foo.py" } },
    });
    expect(res).toEqual({ decision: "allow" });
  });

  test("PreToolUse blocks force push to main via guard-git-push", () => {
    const res = runAdaptedHook("pre-tool-use", "guard-git-push", {
      cwd: "/tmp",
      toolCall: { id: "t3", name: "run_command", args: { CommandLine: "git push --force origin main" } },
    });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("guard-git-push");
  });

  test("PreToolUse combined command-guards runs all four guards in-process with identical deny/allow behavior", () => {
    const combined = "guard-git-push,guard-runtimes,guard-main-checkout,guard-pr-merge";

    expect(
      runAdaptedHook("pre-tool-use", combined, {
        cwd: "/tmp",
        toolCall: { id: "c1", name: "run_command", args: { CommandLine: "ls -la && uv run python -V" } },
      }),
    ).toEqual({ decision: "allow" });

    const badPy = runAdaptedHook("pre-tool-use", combined, {
      cwd: "/tmp",
      toolCall: { id: "c2", name: "run_command", args: { CommandLine: "python3 -c 'print(1)'" } },
    });
    expect(badPy.decision).toBe("deny");
    expect(badPy.reason).toContain("guard-runtimes");

    const badPush = runAdaptedHook("pre-tool-use", combined, {
      cwd: "/tmp",
      toolCall: { id: "c3", name: "run_command", args: { CommandLine: "git push --force origin main" } },
    });
    expect(badPush.decision).toBe("deny");
    expect(badPush.reason).toContain("guard-git-push");

    const badMerge = runAdaptedHook("pre-tool-use", combined, {
      cwd: "/tmp",
      toolCall: { id: "c4", name: "run_command", args: { CommandLine: "gh pr merge 1 --admin" } },
    });
    expect(badMerge.decision).toBe("deny");
    expect(badMerge.reason).toContain("guard-pr-merge");
  });

  test("PostToolUse auto-merge fast-paths non-PR commands to empty object", () => {
    expect(
      runAdaptedHook("post-tool-use", "auto-merge", {
        cwd: "/tmp",
        toolCall: { id: "p1", name: "run_command", args: { CommandLine: "git status" } },
      }),
    ).toEqual({});
  });

  test("PreToolUse guard-asks blocks ask without Reason and allows listed Reason", () => {
    const blocked = runAdaptedHook("pre-tool-use", "guard-asks", {
      cwd: "/tmp",
      toolCall: {
        id: "t4",
        name: "mcp_board_ask_user",
        args: { kind: "decision", question: "Should I pick A or B?" },
      },
    });
    expect(blocked.decision).toBe("deny");
    expect(blocked.reason).toContain("Reason:");

    const allowed = runAdaptedHook("pre-tool-use", "guard-asks", {
      cwd: "/tmp",
      toolCall: {
        id: "t5",
        name: "mcp_board_ask_user",
        args: { kind: "decision", question: "Reason: design\nShould I pick A or B?" },
      },
    });
    expect(allowed).toEqual({ decision: "allow" });
  });

  test("extractLastAssistantMessage reads last PLANNER_RESPONSE from Antigravity transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-hook-test-"));
    try {
      const p = join(dir, "transcript.jsonl");
      writeFileSync(
        p,
        [
          JSON.stringify({ type: "USER_INPUT", content: "hello" }),
          JSON.stringify({ type: "PLANNER_RESPONSE", content: "first reply" }),
          JSON.stringify({ type: "PLANNER_RESPONSE", content: "final reply" }),
        ].join("\n") + "\n",
      );
      expect(extractLastAssistantMessage(p)).toBe("final reply");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("translateOutput maps SessionStart additionalContext to injectSteps", () => {
    const out = translateOutput(
      "session-start",
      0,
      JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Worktree is behind." } }),
      "",
    );
    expect(out).toEqual({
      injectSteps: [{ systemMessage: { systemMessage: "Worktree is behind." } }],
    });
  });

  test("translateOutput maps Stop exit 2 to continue", () => {
    expect(translateOutput("stop", 2, "", "Please file open items")).toEqual({
      decision: "continue",
      reason: "Please file open items",
    });
    expect(translateOutput("stop", 0, "", "")).toEqual({ decision: "allow" });
  });

  test("translateInput passes continuationActive as stop_hook_active", () => {
    const out = translateInput("stop", "deck-view", {
      cwd: "/tmp",
      continuationActive: true,
      transcriptPath: "/tmp/nonexistent.jsonl",
    });
    expect(out.stop_hook_active).toBe(true);
    expect(out.transcript_path).toBe("/tmp/nonexistent.jsonl");
  });
});
