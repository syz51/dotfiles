import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAskUserInput,
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

    // Line continuation and brace expansion cannot evade prefilters
    const contMerge = runAdaptedHook("pre-tool-use", combined, {
      cwd: "/tmp",
      toolCall: { id: "c5", name: "run_command", args: { CommandLine: "g\\\nh pr m\\\nerge 1 --admin" } },
    });
    expect(contMerge.decision).toBe("deny");
    expect(contMerge.reason).toContain("guard-pr-merge");

    // guard-main-checkout blocks branch switches in a simulated shared main checkout
    const badMain = runAdaptedHook(
      "pre-tool-use",
      combined,
      {
        cwd: "/fake/repo",
        toolCall: { id: "c6", name: "run_command", args: { CommandLine: "git switch -c feat" } },
      },
      {
        runners: {
          tempRoots: [],
          gitLenient: (_dir, args) => {
            if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
              return "/fake/repo/.git\n/fake/repo/.git\n/fake/repo";
            }
            return undefined;
          },
        },
      },
    );
    expect(badMain.decision).toBe("deny");
    expect(badMain.reason).toContain("guard-main-checkout");
  });

  test("PreToolUse isolates errors in earlier guards so fail-closed guard-pr-merge still blocks", () => {
    const combined = "guard-git-push,guard-runtimes,guard-main-checkout,guard-pr-merge";
    const res = runAdaptedHook(
      "pre-tool-use",
      combined,
      {
        cwd: "/tmp",
        toolCall: {
          id: "iso1",
          name: "run_command",
          args: { CommandLine: "git push origin feat && gh pr merge 1 --admin" },
        },
      },
      {
        runners: {
          gitStrict: () => {
            throw new Error("simulated git timeout");
          },
        },
      },
    );
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("guard-pr-merge");
  });

  test("PreToolUse guard-pr-merge fails closed if its runner throws", () => {
    const res = runAdaptedHook(
      "pre-tool-use",
      "guard-pr-merge",
      {
        cwd: "/tmp",
        toolCall: {
          id: "fc1",
          name: "run_command",
          args: { CommandLine: "gh pr merge 1 --squash" },
        },
      },
      {
        runners: {
          gh: () => {
            throw new Error("simulated gh failure");
          },
        },
      },
    );
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("guard-pr-merge");
    expect(res.reason).toContain("simulated gh failure");
  });

  test("PostToolUse auto-merge fast-paths non-PR commands to empty object", () => {
    expect(
      runAdaptedHook("post-tool-use", "auto-merge", {
        cwd: "/tmp",
        toolCall: { id: "p1", name: "run_command", args: { CommandLine: "git status" } },
      }),
    ).toEqual({});
  });

  test("PreToolUse guard-asks blocks ask without Reason and allows listed Reason on eager mcp_board_ask_user", () => {
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

  test("PreToolUse guard-asks enforces ask-policy on lazy call_mcp_tool(board, ask_user) with object and JSON-string Arguments", () => {
    // Missing Reason (object Arguments)
    const missingReason = runAdaptedHook("pre-tool-use", "guard-asks", {
      cwd: "/tmp",
      toolCall: {
        id: "mcp1",
        name: "call_mcp_tool",
        args: {
          ServerName: "board",
          ToolName: "ask_user",
          Arguments: { kind: "decision", question: "Should I pick A or B?" },
        },
      },
    });
    expect(missingReason.decision).toBe("deny");
    expect(missingReason.reason).toContain("Blocked by the guard-asks hook");
    expect(missingReason.reason).toContain("names no reason");

    // Unlisted Reason (JSON-string Arguments)
    const unlistedReason = runAdaptedHook("pre-tool-use", "guard-asks", {
      cwd: "/tmp",
      toolCall: {
        id: "mcp2",
        name: "call_mcp_tool",
        args: {
          ServerName: "board",
          ToolName: "ask_user",
          Arguments: JSON.stringify({ kind: "decision", question: "Reason: convenience. Pick A?" }),
        },
      },
    });
    expect(unlistedReason.decision).toBe("deny");
    expect(unlistedReason.reason).toContain("is not a listed reason");

    // Valid decision ask (object Arguments)
    expect(
      runAdaptedHook("pre-tool-use", "guard-asks", {
        cwd: "/tmp",
        toolCall: {
          id: "mcp3",
          name: "call_mcp_tool",
          args: {
            ServerName: "board",
            ToolName: "ask_user",
            Arguments: { kind: "decision", question: "Reason: design\nShould I pick A or B?" },
          },
        },
      }),
    ).toEqual({ decision: "allow" });

    // Valid decision ask (JSON-string Arguments)
    expect(
      runAdaptedHook("pre-tool-use", "guard-asks", {
        cwd: "/tmp",
        toolCall: {
          id: "mcp4",
          name: "call_mcp_tool",
          args: {
            ServerName: "board",
            ToolName: "ask_user",
            Arguments: JSON.stringify({ kind: "decision", question: "Reason: cost. Subscribe to plan?" }),
          },
        },
      }),
    ).toEqual({ decision: "allow" });

    // Action ask without only-me is blocked; action ask with only-me passes
    const badAction = runAdaptedHook("pre-tool-use", "guard-asks", {
      cwd: "/tmp",
      toolCall: {
        id: "mcp5",
        name: "call_mcp_tool",
        args: {
          ServerName: "board",
          ToolName: "ask_user",
          Arguments: { kind: "action", question: "Reason: design\nPlease merge PR #1" },
        },
      },
    });
    expect(badAction.decision).toBe("deny");
    expect(badAction.reason).toContain("only-me");

    expect(
      runAdaptedHook("pre-tool-use", "guard-asks", {
        cwd: "/tmp",
        toolCall: {
          id: "mcp6",
          name: "call_mcp_tool",
          args: {
            ServerName: "board",
            ToolName: "ask_user",
            Arguments: JSON.stringify({ kind: "action", question: "Reason: only-me\nApprove macOS dialog" }),
          },
        },
      }),
    ).toEqual({ decision: "allow" });

    // Malformed JSON string fails to missing reason instead of crashing
    const badJson = runAdaptedHook("pre-tool-use", "guard-asks", {
      cwd: "/tmp",
      toolCall: {
        id: "mcp7",
        name: "call_mcp_tool",
        args: {
          ServerName: "board",
          ToolName: "ask_user",
          Arguments: "{not valid json",
        },
      },
    });
    expect(badJson.decision).toBe("deny");
    expect(badJson.reason).toContain("names no reason");
  });

  test("PreToolUse guard-asks passes through non-board and non-ask_user call_mcp_tool calls", () => {
    expect(
      runAdaptedHook("pre-tool-use", "guard-asks", {
        cwd: "/tmp",
        toolCall: {
          id: "pass1",
          name: "call_mcp_tool",
          args: { ServerName: "desktop", ToolName: "screenshot", Arguments: {} },
        },
      }),
    ).toEqual({ decision: "allow" });

    expect(
      runAdaptedHook("pre-tool-use", "guard-asks", {
        cwd: "/tmp",
        toolCall: {
          id: "pass2",
          name: "call_mcp_tool",
          args: { ServerName: "board", ToolName: "task_add", Arguments: { title: "No reason needed" } },
        },
      }),
    ).toEqual({ decision: "allow" });

    expect(
      extractAskUserInput({
        toolCall: {
          name: "call_mcp_tool",
          args: { ServerName: "desktop", ToolName: "click", Arguments: { x: 1, y: 2 } },
        },
      }),
    ).toBeNull();
  });

  test("PreToolUse guard-asks enforces ask-policy on run_command `board ask` CLI invocations", () => {
    const combined = "guard-git-push,guard-runtimes,guard-main-checkout,guard-pr-merge,guard-asks";

    // Invalid asks blocked
    const noReason = runAdaptedHook("pre-tool-use", combined, {
      cwd: "/tmp",
      toolCall: {
        id: "cli1",
        name: "run_command",
        args: { CommandLine: 'board ask --board dotfiles --task dotfiles-822 "Should I pick A or B?"' },
      },
    });
    expect(noReason.decision).toBe("deny");
    expect(noReason.reason).toContain("guard-asks");
    expect(noReason.reason).toContain("names no reason");

    const unlisted = runAdaptedHook("pre-tool-use", combined, {
      cwd: "/tmp",
      toolCall: {
        id: "cli2",
        name: "run_command",
        args: { CommandLine: '~/.cargo/bin/board ask "Reason: hook. The hook blocked me"' },
      },
    });
    expect(unlisted.decision).toBe("deny");
    expect(unlisted.reason).toContain("is not a listed reason");

    const badAction = runAdaptedHook("pre-tool-use", combined, {
      cwd: "/tmp",
      toolCall: {
        id: "cli3",
        name: "run_command",
        args: { CommandLine: 'board ask --kind action "Reason: design. Merge PR #1?"' },
      },
    });
    expect(badAction.decision).toBe("deny");
    expect(badAction.reason).toContain("only-me");

    const badActionEq = runAdaptedHook("pre-tool-use", combined, {
      cwd: "/tmp",
      toolCall: {
        id: "cli4",
        name: "run_command",
        args: { CommandLine: 'board ask --kind=action --option "A" "Reason: cost. Pay?"' },
      },
    });
    expect(badActionEq.decision).toBe("deny");
    expect(badActionEq.reason).toContain("only-me");

    const reasonOnlyInOption = runAdaptedHook("pre-tool-use", combined, {
      cwd: "/tmp",
      toolCall: {
        id: "cli5",
        name: "run_command",
        args: { CommandLine: 'board ask --option "Reason: design" "Pick A or B?"' },
      },
    });
    expect(reasonOnlyInOption.decision).toBe("deny");
    expect(reasonOnlyInOption.reason).toContain("names no reason");

    const wrappedAsk = runAdaptedHook("pre-tool-use", combined, {
      cwd: "/tmp",
      toolCall: {
        id: "cli6",
        name: "run_command",
        args: { CommandLine: 'board status && sh -c \'board --agent t3:11a1 ask "Missing reason"\'' },
      },
    });
    expect(wrappedAsk.decision).toBe("deny");
    expect(wrappedAsk.reason).toContain("names no reason");

    // Valid asks allowed
    expect(
      runAdaptedHook("pre-tool-use", combined, {
        cwd: "/tmp",
        toolCall: {
          id: "cli7",
          name: "run_command",
          args: { CommandLine: 'board ask --board dotfiles --option "A" --option "B" "Reason: design. Pick A or B?"' },
        },
      }),
    ).toEqual({ decision: "allow" });

    expect(
      runAdaptedHook("pre-tool-use", combined, {
        cwd: "/tmp",
        toolCall: {
          id: "cli8",
          name: "run_command",
          args: { CommandLine: 'board ask --kind action "Reason: only-me. Unlock the Mac screen"' },
        },
      }),
    ).toEqual({ decision: "allow" });

    // Pass-through cases: help, `board asks`, unrelated commands mentioning `board ask`
    for (const cmd of [
      "board ask --help",
      "board ask -h",
      "board --help",
      "board help ask",
      "board asks --status all",
      'echo "board ask without reason"',
      'git commit -m "wire board ask CLI guard"',
    ]) {
      expect(
        runAdaptedHook("pre-tool-use", combined, {
          cwd: "/tmp",
          toolCall: { id: `pass-${cmd}`, name: "run_command", args: { CommandLine: cmd } },
        }),
      ).toEqual({ decision: "allow" });
    }
  });

  test("translateInput for guard-asks unwraps call_mcp_tool, skips non-ask MCP tools, and handles omitted toolCall.name commands", () => {
    expect(
      translateInput("pre-tool-use", "guard-asks", {
        cwd: "/tmp",
        toolCall: {
          name: "call_mcp_tool",
          args: {
            ServerName: "board",
            ToolName: "ask_user",
            Arguments: JSON.stringify({ kind: "decision", question: "Reason: design. Pick A?" }),
          },
        },
      }),
    ).toEqual({
      cwd: "/tmp",
      tool_name: "mcp__board__ask_user",
      tool_input: { kind: "decision", question: "Reason: design. Pick A?" },
    });

    expect(
      translateInput("pre-tool-use", "guard-asks", {
        cwd: "/tmp",
        toolCall: {
          name: "call_mcp_tool",
          args: { ServerName: "desktop", ToolName: "screenshot", Arguments: {} },
        },
      }),
    ).toBeNull();

    expect(
      translateInput("pre-tool-use", "guard-asks", {
        cwd: "/tmp",
        toolCall: { args: { CommandLine: 'board ask "No reason"' } },
      }),
    ).toEqual({
      cwd: "/tmp",
      tool_name: "Bash",
      tool_input: { command: 'board ask "No reason"' },
    });
  });

  test("gemini/hooks.json wires guard-asks on run_command, call_mcp_tool, and mcp_board_ask_user", () => {
    const hooksJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "hooks.json"), "utf8"));
    const cmdGuards = hooksJson["command-guards"].PreToolUse.find((g) => g.matcher === "run_command");
    expect(cmdGuards).toBeDefined();
    expect(cmdGuards.hooks.some((h) => h.command.includes("guard-asks"))).toBe(true);

    const mcpAskGuard = hooksJson["board-integration"].PreToolUse.find((g) =>
      g.hooks.some((h) => h.command.includes("guard-asks")),
    );
    expect(mcpAskGuard).toBeDefined();
    const re = new RegExp(`^(?:${mcpAskGuard.matcher})$`);
    expect(re.test("call_mcp_tool")).toBe(true);
    expect(re.test("mcp_board_ask_user")).toBe(true);
    expect(re.test("read_file")).toBe(false);
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
