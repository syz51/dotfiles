import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAskUserInput,
  extractLastAssistantMessage,
  extractMcpPrCreateInput,
  extractMcpPrMergeInput,
  extractPrCreateTargets,
  resolveCreatedPrStdout,
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

  test("extractPrCreateTargets resolves cd, wrappers, -R/--repo, --head, and skips unknown or non-creating targets", () => {
    const cwd = "/work/repo-a";

    // Plain create & alias `new`
    expect(extractPrCreateTargets("gh pr create --fill", cwd)).toEqual([
      { dir: "/work/repo-a", repo: undefined, head: undefined },
    ]);
    expect(extractPrCreateTargets("gh pr new --title 'Ship' --body 'Details'", cwd)).toEqual([
      { dir: "/work/repo-a", repo: undefined, head: undefined },
    ]);

    // Absolute/relative cd, env -C, sh -c, and subshell isolation
    expect(extractPrCreateTargets("cd /work/repo-b && gh pr create --fill", cwd)).toEqual([
      { dir: "/work/repo-b", repo: undefined, head: undefined },
    ]);
    expect(extractPrCreateTargets("cd ../repo-b && gh pr create --fill", cwd)).toEqual([
      { dir: "/work/repo-b", repo: undefined, head: undefined },
    ]);
    expect(extractPrCreateTargets("env -C /work/repo-b gh pr create --fill", cwd)).toEqual([
      { dir: "/work/repo-b", repo: undefined, head: undefined },
    ]);
    expect(extractPrCreateTargets("sh -c 'cd /work/repo-b && gh pr create --fill'", cwd)).toEqual([
      { dir: "/work/repo-b", repo: undefined, head: undefined },
    ]);
    expect(extractPrCreateTargets("(cd /work/repo-b && gh pr create --fill) && gh pr create --fill", cwd)).toEqual([
      { dir: "/work/repo-b", repo: undefined, head: undefined },
      { dir: "/work/repo-a", repo: undefined, head: undefined },
    ]);

    // -R/--repo and -H/--head in all pflag spellings (before and after subcommand, short clusters)
    expect(extractPrCreateTargets("gh -R syz51/repo-b pr create --fill", cwd)).toEqual([
      { dir: "/work/repo-a", repo: "syz51/repo-b", head: undefined },
    ]);
    expect(extractPrCreateTargets("gh pr -R syz51/repo-b create --head=feat/x", cwd)).toEqual([
      { dir: "/work/repo-a", repo: "syz51/repo-b", head: "feat/x" },
    ]);
    expect(extractPrCreateTargets("gh pr create --repo=syz51/repo-b -H user:feat --fill", cwd)).toEqual([
      { dir: "/work/repo-a", repo: "syz51/repo-b", head: "user:feat" },
    ]);
    expect(extractPrCreateTargets("gh pr create -fRsyz51/repo-b -Hfeat", cwd)).toEqual([
      { dir: "/work/repo-a", repo: "syz51/repo-b", head: "feat" },
    ]);
    expect(extractPrCreateTargets("gh pr create -fH feat -R=syz51/repo-b --draft=false", cwd)).toEqual([
      { dir: "/work/repo-a", repo: "syz51/repo-b", head: "feat" },
    ]);

    // Flag values containing -R/--head or env var names/expansions are not misparsed
    expect(
      extractPrCreateTargets(
        'gh pr create -t "-R fake/repo Fix GH_REPO" --body "--head fake and $(cat /tmp/b) $VAR GH_HOST=x GIT_DIR=y"',
        cwd,
      ),
    ).toEqual([{ dir: "/work/repo-a", repo: undefined, head: undefined }]);

    // Unknown dir with BOTH literal -R and --head is still resolvable
    expect(extractPrCreateTargets('cd "$TARGET" && gh pr create -R syz51/repo-b --head feat --fill', cwd)).toEqual([
      { dir: undefined, repo: "syz51/repo-b", head: "feat" },
    ]);
    // Explicit -R overrides GH_REPO; explicit -R + --head overrides GIT_DIR
    expect(extractPrCreateTargets("GH_REPO=syz51/other gh pr create -R syz51/explicit --fill", cwd)).toEqual([
      { dir: "/work/repo-a", repo: "syz51/explicit", head: undefined },
    ]);
    expect(extractPrCreateTargets("GIT_DIR=/other/.git gh pr create -R syz51/repo-b --head feat --fill", cwd)).toEqual([
      { dir: "/work/repo-a", repo: "syz51/repo-b", head: "feat" },
    ]);

    // Unknown or unsafe targets are skipped instead of falling back to cwd
    for (const cmd of [
      'cd "$TARGET" && gh pr create --fill',
      "cd - && gh pr create --fill",
      "popd && gh pr create --fill",
      "cd repo-* && gh pr create --fill",
      'cd "$TARGET" && gh pr create -R syz51/repo-b --fill',
      'cd "$TARGET" && gh pr create --head feat --fill',
      'gh pr create -R "$REPO" --fill',
      'gh pr create --head "$BRANCH" --fill',
      "gh pr create -R syz51/* --fill",
      "gh pr create --repo",
      "gh pr create --repo=",
      "gh pr create --head=",
      "gh pr create $FLAGS",
      "gh pr create --unknown-flag",
      "ssh host 'gh pr create --fill'",
      "echo --fill | xargs gh pr create",
      "GH_REPO=syz51/other gh pr create --fill",
      "export GH_REPO=syz51/other && gh pr create --fill",
      "sh -c 'GH_REPO=syz51/other gh pr create --fill'",
      "GH_HOST=ghe.example.com gh pr create --fill",
      "GIT_DIR=/other/.git gh pr create --fill",
      "gh pr create --draft --fill",
      "gh pr create -fd",
      "gh pr create --dry-run --fill",
      "gh pr create --web",
      "gh pr create --help",
    ]) {
      expect(extractPrCreateTargets(cmd, cwd), cmd).toEqual([]);
    }

    // Post-create branch switch invalidates branch-dependent targets in that directory only
    expect(extractPrCreateTargets("cd /work/repo-b && gh pr create --fill && git switch main", cwd)).toEqual([]);
    expect(extractPrCreateTargets("cd /work/repo-b && gh pr create --head feat --fill && git switch main", cwd)).toEqual([
      { dir: "/work/repo-b", repo: undefined, head: "feat" },
    ]);
    expect(
      extractPrCreateTargets("(cd /work/repo-b && gh pr create --fill) && git switch main", cwd),
    ).toEqual([{ dir: "/work/repo-b", repo: undefined, head: undefined }]);
    expect(
      extractPrCreateTargets("cd /work/repo-b && gh pr create --fill && git checkout -- README.md", cwd),
    ).toEqual([{ dir: "/work/repo-b", repo: undefined, head: undefined }]);
  });

  test("PostToolUse auto-merge resolves Bash gh pr create/new PR URLs in the command's target dir/repo/head", () => {
    const URL_B = "https://github.com/syz51/repo-b/pull/42";
    const URL_C = "https://github.com/syz51/repo-c/pull/7";
    const ok = (value) => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
    const makeGh = (urlByCall, calls = []) => (dir, args) => {
      calls.push({ dir, args });
      if (args[0] === "pr" && args[1] === "view" && args.includes("-q")) {
        const resolved = urlByCall(dir, args);
        return resolved ? ok(`${resolved}\n`) : { code: 1, stdout: "", stderr: "no pull requests found" };
      }
      if (args[0] === "pr" && args[1] === "view") {
        const url = args[2];
        const id = url === URL_B ? "PR_node42" : "PR_node7";
        return ok({
          id,
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          mergeStateStatus: "BLOCKED",
          autoMergeRequest: null,
        });
      }
      const path = args[3];
      if (path === "graphql") return ok({ data: {} });
      if (path.endsWith("/protection")) {
        return ok({
          required_status_checks: { contexts: ["Portable tests"], checks: [{ context: "Portable tests" }] },
          required_pull_request_reviews: { required_approving_review_count: 0 },
        });
      }
      if (path.includes("/rules/branches/")) return ok([]);
      if (/^repos\/[^/]+\/[^/]+$/.test(path)) {
        return ok({ allow_auto_merge: true, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true });
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    // `cd /work/repo-b && gh pr create --fill` from repo-a queries repo-b, never repo-a
    const cdCalls = [];
    expect(
      runAdaptedHook(
        "post-tool-use",
        "auto-merge",
        {
          cwd: "/work/repo-a",
          toolCall: { id: "b1", name: "run_command", args: { CommandLine: "cd /work/repo-b && gh pr create --fill" } },
        },
        {
          runners: {
            gh: makeGh((dir) => (dir === "/work/repo-b" ? URL_B : "https://github.com/syz51/repo-a/pull/99"), cdCalls),
          },
        },
      ),
    ).toEqual({});
    expect(cdCalls[0]).toEqual({ dir: "/work/repo-b", args: ["pr", "view", "--json", "url", "-q", ".url"] });
    const cdMutation = cdCalls.find((c) => c.args[3] === "graphql");
    expect(cdMutation?.args).toContain("id=PR_node42");

    // Multiple creates across dirs/repos/heads resolve each target and enable auto-merge on both
    const multiCalls = [];
    expect(
      runAdaptedHook(
        "post-tool-use",
        "auto-merge",
        {
          cwd: "/work/repo-a",
          toolCall: {
            id: "b2",
            name: "run_command",
            args: {
              CommandLine:
                "(cd /work/repo-b && gh pr create --fill) && gh pr new -R syz51/repo-c --head feat-c --fill",
            },
          },
        },
        {
          runners: {
            gh: makeGh((dir, args) => {
              if (dir === "/work/repo-b" && !args.includes("--repo")) return URL_B;
              if (args.includes("feat-c") && args.includes("--repo") && args.includes("syz51/repo-c")) return URL_C;
              return undefined;
            }, multiCalls),
          },
        },
      ),
    ).toEqual({});
    expect(multiCalls[0]).toEqual({ dir: "/work/repo-b", args: ["pr", "view", "--json", "url", "-q", ".url"] });
    expect(multiCalls[1]).toEqual({
      dir: "/work/repo-a",
      args: ["pr", "view", "feat-c", "--repo", "syz51/repo-c", "--json", "url", "-q", ".url"],
    });
    const mutatedIds = multiCalls
      .filter((c) => c.args[3] === "graphql")
      .map((c) => c.args.find((a) => a.startsWith("id=")));
    expect(mutatedIds).toEqual(["id=PR_node42", "id=PR_node7"]);

    // Unknown directory or draft skips gh entirely so an unrelated open PR in repo-a is never touched
    for (const cmd of ['cd "$TARGET" && gh pr create --fill', "cd /work/repo-b && gh pr create --draft --fill"]) {
      const skipCalls = [];
      expect(
        runAdaptedHook(
          "post-tool-use",
          "auto-merge",
          { cwd: "/work/repo-a", toolCall: { id: "b3", name: "run_command", args: { CommandLine: cmd } } },
          { runners: { gh: makeGh(() => "https://github.com/syz51/repo-a/pull/99", skipCalls) } },
        ),
      ).toEqual({});
      expect(skipCalls).toEqual([]);
    }

    // translateInput uses the same target-aware resolution
    const translateCalls = [];
    const translated = translateInput(
      "post-tool-use",
      "auto-merge",
      {
        cwd: "/work/repo-a",
        toolCall: {
          name: "run_command",
          args: { CommandLine: "cd /work/repo-b && gh pr create -R syz51/repo-b --head feat-b --fill" },
        },
      },
      {
        runners: {
          gh: (dir, args) => {
            translateCalls.push({ dir, args });
            return ok(`${URL_B}\n`);
          },
        },
      },
    );
    expect(translateCalls).toEqual([
      { dir: "/work/repo-b", args: ["pr", "view", "feat-b", "--repo", "syz51/repo-b", "--json", "url", "-q", ".url"] },
    ]);
    expect(translated.tool_response.stdout).toBe(`${URL_B}\n`);

    const unknownTranslated = translateInput(
      "post-tool-use",
      "auto-merge",
      {
        cwd: "/work/repo-a",
        toolCall: { name: "run_command", args: { CommandLine: 'cd "$DIR" && gh pr create --fill' } },
      },
      {
        runners: {
          gh: () => {
            throw new Error("gh should not be called for unknown dir");
          },
        },
      },
    );
    expect(unknownTranslated.tool_response.stdout).toBe("");

    // resolveCreatedPrStdout tolerates a throwing gh call on one target and still resolves others
    expect(
      resolveCreatedPrStdout(
        "(cd /work/missing && gh pr create --fill) && (cd /work/repo-b && gh pr create --fill)",
        "/work/repo-a",
        (dir) => {
          if (dir === "/work/missing") throw new Error("ENOENT");
          return ok(`${URL_B}\n`);
        },
      ),
    ).toBe(`${URL_B}\n`);
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

  test("PreToolUse guard-pr-merge validates mcp_t3-code_pull_request_merge allow/deny, CircleCI fallback, draft, auto, and fail-closed", () => {
    const HEAD = "abc123";
    const ok = (value) => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
    const run = (name, status, conclusion, extra = {}) => ({
      __typename: "CheckRun",
      workflowName: "Checks",
      name,
      status,
      conclusion,
      ...extra,
    });
    const ctx = (name, state) => ({ __typename: "StatusContext", context: name, state });
    const BILLING_TEXT =
      "The job was not started because recent account payments have failed or your spending limit needs to be increased.";
    const PROTECTED = {
      protection: {
        enabled: true,
        required_status_checks: { enforcement_level: "everyone", contexts: ["Portable tests"], checks: [] },
      },
    };
    const VIEW = {
      number: 12,
      url: "https://github.com/syz51/dotfiles/pull/12",
      state: "OPEN",
      isDraft: false,
      mergeStateStatus: "CLEAN",
      baseRefName: "main",
      headRefOid: HEAD,
      statusCheckRollup: [run("Portable tests", "COMPLETED", "SUCCESS")],
    };
    const makeGh = ({ view = {}, branch, ci = {}, graphql, calls = [] } = {}) => (dir, args) => {
      calls.push({ dir, args });
      if (args[0] === "pr" && args[1] === "view") return ok({ ...VIEW, ...view });
      const path = args[3];
      if (path === "graphql" && args.some((a) => a.startsWith("query=") && a.includes("workflows: object"))) {
        return ok({
          data: {
            repository: {
              head: { oid: view.headRefOid ?? HEAD },
              workflows: ci.files
                ? { entries: Object.entries(ci.files).map(([name, text]) => ({ name, type: "blob", object: { text, isTruncated: false } })) }
                : null,
              baseWorkflows: null,
              circleci: ci.circleci === false || ci.circleci === null || ci.circleci === undefined
                ? null
                : typeof ci.circleci === "string"
                  ? { text: ci.circleci, isTruncated: false }
                  : typeof ci.circleci === "object"
                    ? ci.circleci
                    : { text: "version: 2.1\nworkflows:\n  build:\n    jobs: [test]\n", isTruncated: false },
            },
          },
        });
      }
      if (path === "graphql") return ok(graphql);
      if (path.includes("/rules/branches/")) return ok([]);
      if (path.includes("/branches/")) return ok(branch ?? { protection: { enabled: false } });
      if (path.includes("/actions/workflows")) return ok({ total_count: 0, workflows: [] });
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const callMerge = (args, ghOpts = {}, cwd = "/repo") =>
      runAdaptedHook(
        "pre-tool-use",
        "guard-pr-merge",
        { cwd, toolCall: { id: "m1", name: "mcp_t3-code_pull_request_merge", args } },
        { runners: { gh: typeof ghOpts === "function" ? ghOpts : makeGh(ghOpts) } },
      );

    // Passing direct merge with explicit number/repository and matching expectedHeadSha
    const calls = [];
    expect(callMerge({ number: 12, repository: "syz51/dotfiles", expectedHeadSha: HEAD, method: "squash" }, { calls })).toEqual({
      decision: "allow",
    });
    expect(calls[0].args).toContain("12");
    expect(calls[0].args).toContain("--repo");

    // Passing direct merge defaulting to current branch's PR in cwd
    const cwdCalls = [];
    expect(callMerge({ expectedHeadSha: HEAD }, { calls: cwdCalls }, "/wt")).toEqual({ decision: "allow" });
    expect(cwdCalls[0]).toEqual({ dir: "/wt", args: ["pr", "view", "--json", expect.any(String)] });

    // Failing check -> deny
    const failed = callMerge(
      { number: 12, expectedHeadSha: HEAD },
      { view: { statusCheckRollup: [run("Portable tests", "COMPLETED", "FAILURE")] } },
    );
    expect(failed.decision).toBe("deny");
    expect(failed.reason).toContain("checks failed");

    // Pending check -> deny
    const pending = callMerge(
      { number: 12, expectedHeadSha: HEAD },
      { view: { statusCheckRollup: [run("Portable tests", "IN_PROGRESS", "")] } },
    );
    expect(pending.decision).toBe("deny");
    expect(pending.reason).toContain("still running");

    // Missing CircleCI check -> deny
    const missingCircle = callMerge({ number: 12, expectedHeadSha: HEAD }, { ci: { circleci: true } });
    expect(missingCircle.decision).toBe("deny");
    expect(missingCircle.reason).toContain("CircleCI");

    // Opt-in fallback CircleCI config (all workflows gated off by default) -> allow
    const optInCircle = callMerge(
      { number: 12, expectedHeadSha: HEAD },
      {
        ci: {
          circleci: "version: 2.1\nparameters:\n  run-fallback:\n    type: boolean\n    default: false\nworkflows:\n  github-fallback:\n    when: << pipeline.parameters.run-fallback >>\n    jobs: [test]\n",
        },
      },
    );
    expect(optInCircle).toEqual({ decision: "allow" });

    // Billing-skipped Actions job with passing CircleCI fallback -> allow
    const skippedJob = run("build", "COMPLETED", "FAILURE", {
      detailsUrl: "https://github.com/syz51/dotfiles/actions/runs/7/job/11",
    });
    const billingGraphql = {
      data: {
        repository: {
          object: {
            checkSuites: {
              nodes: [
                {
                  app: { slug: "github-actions" },
                  checkRuns: {
                    nodes: [
                      {
                        databaseId: 11,
                        steps: { totalCount: 0 },
                        annotations: {
                          totalCount: 1,
                          nodes: [{ path: ".github", message: BILLING_TEXT, annotationLevel: "FAILURE" }],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    };
    expect(
      callMerge(
        { number: 12, expectedHeadSha: HEAD },
        { view: { statusCheckRollup: [skippedJob, ctx("ci/circleci: build", "SUCCESS")] }, graphql: billingGraphql },
      ),
    ).toEqual({ decision: "allow" });

    // Draft PR -> deny
    const draft = callMerge({ number: 12, expectedHeadSha: HEAD }, { view: { isDraft: true } });
    expect(draft.decision).toBe("deny");
    expect(draft.reason).toContain("is a draft");

    // auto: true on check-gated base (BLOCKED) -> allow; on ungated base -> deny
    expect(
      callMerge(
        { number: 12, auto: true, expectedHeadSha: HEAD },
        { branch: PROTECTED, view: { mergeStateStatus: "BLOCKED", statusCheckRollup: [run("Portable tests", "IN_PROGRESS", "")] } },
      ),
    ).toEqual({ decision: "allow" });

    const autoUngated = callMerge(
      { number: 12, auto: true, expectedHeadSha: HEAD },
      { view: { mergeStateStatus: "BLOCKED", statusCheckRollup: [run("Portable tests", "IN_PROGRESS", "")] } },
    );
    expect(autoUngated.decision).toBe("deny");
    expect(autoUngated.reason).toContain("still running");

    // stack: true -> deny
    const stacked = callMerge({ number: 12, expectedHeadSha: HEAD, stack: true });
    expect(stacked.decision).toBe("deny");
    expect(stacked.reason).toContain("stack=true");

    // Fail closed when gh throws
    const thrown = callMerge({ number: 12, expectedHeadSha: HEAD }, () => {
      throw new Error("simulated gh crash");
    });
    expect(thrown.decision).toBe("deny");
    expect(thrown.reason).toContain("simulated gh crash");

    // Malformed call_mcp_tool JSON fails closed
    const badLazy = runAdaptedHook("pre-tool-use", "guard-pr-merge", {
      cwd: "/repo",
      toolCall: {
        id: "m-lazy",
        name: "call_mcp_tool",
        args: { ServerName: "t3-code", ToolName: "pull_request_merge", Arguments: "{bad json" },
      },
    });
    expect(badLazy.decision).toBe("deny");
    expect(badLazy.reason).toContain("guard-pr-merge");

    // Valid call_mcp_tool for pull_request_merge enforces allow/deny, and unrelated tools pass through
    expect(
      runAdaptedHook(
        "pre-tool-use",
        "guard-pr-merge",
        {
          cwd: "/repo",
          toolCall: {
            id: "m-lazy-ok",
            name: "call_mcp_tool",
            args: { ServerName: "t3-code", ToolName: "pull_request_merge", Arguments: { number: 12, expectedHeadSha: HEAD } },
          },
        },
        { runners: { gh: makeGh() } },
      ),
    ).toEqual({ decision: "allow" });

    const lazyDraft = runAdaptedHook(
      "pre-tool-use",
      "guard-pr-merge",
      {
        cwd: "/repo",
        toolCall: {
          id: "m-lazy-draft",
          name: "call_mcp_tool",
          args: { ServerName: "t3-code", ToolName: "pull_request_merge", Arguments: JSON.stringify({ number: 12, expectedHeadSha: HEAD }) },
        },
      },
      { runners: { gh: makeGh({ view: { isDraft: true } }) } },
    );
    expect(lazyDraft.decision).toBe("deny");
    expect(lazyDraft.reason).toContain("is a draft");

    expect(
      runAdaptedHook("pre-tool-use", "guard-pr-merge", {
        cwd: "/repo",
        toolCall: {
          id: "m-lazy-other",
          name: "call_mcp_tool",
          args: { ServerName: "board", ToolName: "task_list", Arguments: {} },
        },
      }),
    ).toEqual({ decision: "allow" });
  });

  test("PostToolUse auto-merge handles mcp_t3-code_pull_request_create for eligible syz51 PRs vs draft/private/non-syz51", () => {
    const URL = "https://github.com/syz51/dotfiles/pull/12";
    const ok = (value) => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
    const makeGh = ({ prUrl = URL, view = {}, calls = [] } = {}) => (_dir, args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args.includes("-q")) return ok(`${prUrl}\n`);
      if (args[0] === "pr" && args[1] === "view") {
        return ok({
          id: "PR_node12",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          mergeStateStatus: "BLOCKED",
          autoMergeRequest: null,
          ...view,
        });
      }
      const path = args[3];
      if (path === "graphql") return ok({ data: {} });
      if (path.endsWith("/protection")) {
        return ok({
          required_status_checks: { contexts: ["Portable tests"], checks: [{ context: "Portable tests" }] },
          required_pull_request_reviews: { required_approving_review_count: 0 },
        });
      }
      if (path.includes("/rules/branches/")) return ok([]);
      if (/^repos\/[^/]+\/[^/]+$/.test(path)) {
        return ok({ allow_auto_merge: true, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true });
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    // Eligible non-draft syz51 PR resolved via gh pr view fallback enables auto-merge
    const eligibleCalls = [];
    expect(
      runAdaptedHook(
        "post-tool-use",
        "auto-merge",
        { cwd: "/repo", toolCall: { id: "c1", name: "mcp_t3-code_pull_request_create", args: { title: "Fix", body: "b" } } },
        { runners: { gh: makeGh({ calls: eligibleCalls }) } },
      ),
    ).toEqual({});
    expect(eligibleCalls.some((a) => a[0] === "pr" && a[1] === "view" && a.includes("-q"))).toBe(true);
    expect(eligibleCalls.some((a) => a[3] === "graphql" && a.some((x) => x.includes("enablePullRequestAutoMerge")))).toBe(true);

    // Populated toolResponse uses returned URL directly without gh pr view -q .url fallback
    const directRespCalls = [];
    expect(
      runAdaptedHook(
        "post-tool-use",
        "auto-merge",
        {
          cwd: "/repo",
          toolCall: { id: "c1-resp", name: "mcp_t3-code_pull_request_create", args: { title: "Fix", body: "b" } },
          toolResponse: { structuredContent: { url: URL } },
        },
        { runners: { gh: makeGh({ calls: directRespCalls }) } },
      ),
    ).toEqual({});
    expect(directRespCalls.some((a) => a[0] === "pr" && a[1] === "view" && a.includes("-q"))).toBe(false);
    expect(directRespCalls.some((a) => a[3] === "graphql" && a.some((x) => x.includes("enablePullRequestAutoMerge")))).toBe(true);

    // Lazy call_mcp_tool(t3-code, pull_request_create) enables auto-merge too
    const lazyCreateCalls = [];
    expect(
      runAdaptedHook(
        "post-tool-use",
        "auto-merge",
        {
          cwd: "/repo",
          toolCall: {
            id: "c1-lazy",
            name: "call_mcp_tool",
            args: { ServerName: "t3-code", ToolName: "pull_request_create", Arguments: JSON.stringify({ title: "Fix", body: "b" }) },
          },
        },
        { runners: { gh: makeGh({ calls: lazyCreateCalls }) } },
      ),
    ).toEqual({});
    expect(lazyCreateCalls.some((a) => a[3] === "graphql" && a.some((x) => x.includes("enablePullRequestAutoMerge")))).toBe(true);

    // Draft and private PRs skip without calling gh at all
    for (const args of [
      { title: "WIP", body: "b", draft: true },
      { title: "Priv", body: "b", private: true },
    ]) {
      const skipCalls = [];
      expect(
        runAdaptedHook(
          "post-tool-use",
          "auto-merge",
          { cwd: "/repo", toolCall: { id: "c2", name: "mcp_t3-code_pull_request_create", args } },
          { runners: { gh: makeGh({ calls: skipCalls }) } },
        ),
      ).toEqual({});
      expect(skipCalls).toEqual([]);
    }

    // Non-syz51 PR does not enable auto-merge
    const foreignCalls = [];
    expect(
      runAdaptedHook(
        "post-tool-use",
        "auto-merge",
        { cwd: "/repo", toolCall: { id: "c3", name: "mcp_t3-code_pull_request_create", args: { title: "Upstream", body: "b" } } },
        { runners: { gh: makeGh({ prUrl: "https://github.com/pingdotgg/t3code/pull/9", calls: foreignCalls }) } },
      ),
    ).toEqual({});
    expect(foreignCalls.some((a) => a[3] === "graphql")).toBe(false);
  });

  test("translateInput and extractors support mcp_t3-code_pull_request_merge and mcp_t3-code_pull_request_create", () => {
    expect(
      extractMcpPrMergeInput({
        toolCall: { name: "mcp_t3-code_pull_request_merge", args: { number: 12, auto: true } },
      }),
    ).toEqual({ number: 12, auto: true });
    expect(
      extractMcpPrCreateInput({
        toolCall: { name: "mcp_t3-code_pull_request_create", args: { title: "T", draft: false } },
      }),
    ).toEqual({ title: "T", draft: false });

    expect(
      translateInput("pre-tool-use", "guard-pr-merge", {
        cwd: "/repo",
        toolCall: { name: "mcp_t3-code_pull_request_merge", args: { number: 12 } },
      }),
    ).toEqual({
      cwd: "/repo",
      tool_name: "mcp__t3-code__pull_request_merge",
      tool_input: { number: 12 },
    });

    expect(
      translateInput("post-tool-use", "auto-merge", {
        cwd: "/repo",
        toolCall: { name: "mcp_t3-code_pull_request_create", args: { title: "T" } },
      }),
    ).toEqual({
      cwd: "/repo",
      tool_name: "mcp__t3-code__pull_request_create",
      tool_input: { title: "T" },
      tool_response: {},
    });
  });

  test("gemini/hooks.json wires mcp_t3-code_pull_request_merge and mcp_t3-code_pull_request_create (including call_mcp_tool)", () => {
    const hooksJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "hooks.json"), "utf8"));
    const mcpMerge = hooksJson["command-guards"].PreToolUse.find((g) => g.matcher.includes("mcp_t3-code_pull_request_merge"));
    expect(mcpMerge).toBeDefined();
    const mergeRe = new RegExp(`^(?:${mcpMerge.matcher})$`);
    expect(mergeRe.test("mcp_t3-code_pull_request_merge")).toBe(true);
    expect(mergeRe.test("call_mcp_tool")).toBe(true);
    expect(mergeRe.test("read_file")).toBe(false);
    expect(mcpMerge.hooks.some((h) => h.command.includes("guard-pr-merge") && h.timeout >= 45)).toBe(true);

    const mcpCreate = hooksJson["command-guards"].PostToolUse.find((g) => g.matcher.includes("mcp_t3-code_pull_request_create"));
    expect(mcpCreate).toBeDefined();
    const createRe = new RegExp(`^(?:${mcpCreate.matcher})$`);
    expect(createRe.test("mcp_t3-code_pull_request_create")).toBe(true);
    expect(createRe.test("call_mcp_tool")).toBe(true);
    expect(createRe.test("read_file")).toBe(false);
    expect(mcpCreate.hooks.some((h) => h.command.includes("auto-merge") && h.timeout >= 60)).toBe(true);
  });

  test("Stop open-items checks Antigravity transcripts for missing or unfiled Open items labels", () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-open-items-"));
    const script = join(import.meta.dir, "run-hook.js");
    try {
      const fakeBoard = join(dir, "board");
      writeFileSync(
        fakeBoard,
        '#!/bin/sh\nif [ "$1" = boards ]; then printf \'[{"slug":"dotfiles"}]\n\'; else printf \'{"board":{"slug":"dotfiles"}}\n\'; fi\n',
      );
      chmodSync(fakeBoard, 0o755);

      const runStop = (lines, extra = {}) => {
        const transcriptPath = join(dir, "transcript.jsonl");
        writeFileSync(transcriptPath, `${lines.map((r) => JSON.stringify(r)).join("\n")}\n`);
        const res = spawnSync(process.execPath, [script, "stop", "open-items"], {
          input: JSON.stringify({ cwd: dir, transcriptPath, ...extra }),
          encoding: "utf8",
          env: { ...process.env, AGENT_BOARD_HOOKS: "", BOARD_BIN: fakeBoard },
        });
        expect(res.status).toBe(0);
        return JSON.parse(res.stdout);
      };

      const toolMissing = runStop([
        { type: "USER_INPUT", source: "USER_EXPLICIT", content: "Fix it" },
        { type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "bun test" } }] },
        { type: "GENERIC", content: "ok" },
        { type: "PLANNER_RESPONSE", content: "Done." },
      ]);
      expect(toolMissing.decision).toBe("continue");
      expect(toolMissing.reason).toContain("Open items:");

      expect(
        runStop(
          [
            { type: "USER_INPUT", source: "USER_EXPLICIT", content: "Fix it" },
            { type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "bun test" } }] },
            { type: "GENERIC", content: "ok" },
            { type: "PLANNER_RESPONSE", content: "Done." },
          ],
          { continuationActive: true },
        ),
      ).toEqual({ decision: "allow" });

      expect(
        runStop([
          { type: "USER_INPUT", source: "USER_EXPLICIT", content: "Fix it" },
          { type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "bun test" } }] },
          { type: "GENERIC", content: "ok" },
          { type: "PLANNER_RESPONSE", content: "Done.\n\nOpen items: none." },
        ]),
      ).toEqual({ decision: "allow" });

      expect(
        runStop([
          { type: "USER_INPUT", source: "USER_EXPLICIT", content: "What does X mean?" },
          { type: "PLANNER_RESPONSE", content: "X means Y." },
        ]),
      ).toEqual({ decision: "allow" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("run-hook.js CLI fails closed on malformed, empty, or non-object stdin JSON when guard-pr-merge is active", () => {
    const script = join(import.meta.dir, "run-hook.js");
    for (const badInput of ["{ not valid json", "", "null", "[]"]) {
      const res = spawnSync(process.execPath, [script, "pre-tool-use", "guard-pr-merge"], {
        input: badInput,
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.decision).toBe("deny");
      expect(parsed.reason).toContain("Blocked by the guard-pr-merge hook");
    }
  });

  test("AGY_RUN_ACTIVE=1 bypasses stop/session-start hooks without loosening PreToolUse guards, and hooks.json agy-run-policy fails closed", () => {
    const script = join(import.meta.dir, "run-hook.js");
    const stopRes = spawnSync(process.execPath, [script, "stop", "open-items"], {
      input: JSON.stringify({ cwd: process.cwd() }),
      encoding: "utf8",
      env: { ...process.env, AGY_RUN_ACTIVE: "1" },
    });
    expect(stopRes.status).toBe(0);
    expect(JSON.parse(stopRes.stdout)).toEqual({ decision: "allow" });

    // PreToolUse security guards MUST remain active even when AGY_RUN_ACTIVE=1
    const preRes = spawnSync(process.execPath, [script, "pre-tool-use", "guard-git-push"], {
      input: JSON.stringify({ cwd: process.cwd(), toolCall: { name: "run_command", args: { CommandLine: "git push --force origin main" } } }),
      encoding: "utf8",
      env: { ...process.env, AGY_RUN_ACTIVE: "1" },
    });
    expect(preRes.status).toBe(0);
    expect(JSON.parse(preRes.stdout).decision).toBe("deny");

    const hooksJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "hooks.json"), "utf8"));
    const policyEntry = hooksJson["agy-run-policy"]?.PreToolUse?.[0];
    expect(policyEntry?.matcher).toBe("*");
    expect(policyEntry?.hooks?.[0]?.command).toContain("AGY_RUN_POLICY_FILE");
    expect(policyEntry?.hooks?.[0]?.command).toContain("agy-run-policy.js");

    // Fast-path when AGY_RUN_POLICY_FILE is unset returns allow immediately
    const fastPath = spawnSync("/bin/sh", ["-c", policyEntry.hooks[0].command], {
      input: JSON.stringify({ toolCall: { name: "read_file", args: {} } }),
      encoding: "utf8",
      env: { ...process.env, AGY_RUN_POLICY_FILE: "" },
    });
    expect(fastPath.status).toBe(0);
    expect(JSON.parse(fastPath.stdout)).toEqual({ decision: "allow" });

    // Missing bun/script when AGY_RUN_POLICY_FILE IS set must fail closed with deny
    const brokenHome = mkdtempSync(join(tmpdir(), "agy-broken-home-"));
    try {
      const failClosed = spawnSync("/bin/sh", ["-c", policyEntry.hooks[0].command], {
        input: JSON.stringify({ toolCall: { name: "read_file", args: {} } }),
        encoding: "utf8",
        env: { ...process.env, HOME: brokenHome, AGY_RUN_POLICY_FILE: "/nonexistent/policy.json" },
      });
      expect(JSON.parse(failClosed.stdout.trim()).decision).toBe("deny");
    } finally {
      rmSync(brokenHome, { recursive: true, force: true });
    }
  });

  test("gemini/hooks.json wires guard-wakeup at Stop and run-hook.js blocks dropped timers on Antigravity transcripts", () => {
    const hooksJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "hooks.json"), "utf8"));
    const stopHooks = hooksJson["command-guards"]?.Stop ?? [];
    expect(stopHooks.some((h) => h.command.includes("stop guard-wakeup"))).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "agy-guard-wakeup-"));
    const script = join(import.meta.dir, "run-hook.js");
    try {
      const runStop = (lines, extra = {}) => {
        const transcriptPath = join(dir, "transcript.jsonl");
        writeFileSync(transcriptPath, `${lines.map((r) => JSON.stringify(r)).join("\n")}\n`);
        const res = spawnSync(process.execPath, [script, "stop", "guard-wakeup"], {
          input: JSON.stringify({ cwd: dir, transcriptPath, ...extra }),
          encoding: "utf8",
          env: { ...process.env, GUARD_WAKEUP: "" },
        });
        expect(res.status).toBe(0);
        return JSON.parse(res.stdout);
      };

      const dropped = runStop([
        { type: "USER_INPUT", content: "Check CI" },
        { type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: '"gh run view 1"' } }] },
        { type: "GENERIC", status: "DONE", content: "in_progress" },
        { type: "PLANNER_RESPONSE", content: "Checking back in 4 minutes to run deploy/upgrade.sh." },
      ]);
      expect(dropped.decision).toBe("continue");
      expect(dropped.reason).toContain("guard-wakeup hook");

      expect(
        runStop(
          [
            { type: "USER_INPUT", content: "Check CI" },
            { type: "PLANNER_RESPONSE", content: "Checking back in 4 minutes to run deploy/upgrade.sh." },
          ],
          { continuationActive: true },
        ),
      ).toEqual({ decision: "allow" });

      expect(
        runStop([
          { type: "USER_INPUT", content: "Check CI" },
          { type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: "240", Prompt: '"Check CI"' } }] },
          { type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: conv/task-99\nTask Description: Timer: 4m" },
          { type: "PLANNER_RESPONSE", content: "Checking back in 4 minutes to run deploy/upgrade.sh." },
        ]),
      ).toEqual({ decision: "allow" });

      // Turn 2 ending with empty content must NOT inherit Turn 1's "Checking back in 4 minutes" message.
      expect(
        runStop([
          { type: "USER_INPUT", content: "Check CI" },
          { type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: "240", Prompt: '"Check CI"' } }] },
          { type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: conv/task-99\nTask Description: Timer: 4m" },
          { type: "PLANNER_RESPONSE", content: "Checking back in 4 minutes." },
          { type: "SYSTEM_MESSAGE", content: "[Message] timestamp=2026-11-27T08:30:00Z sender=conv/task-99 content=Check CI" },
          { type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: '"echo done"' } }] },
          { type: "GENERIC", status: "DONE", content: "done" },
          { type: "PLANNER_RESPONSE", content: "" },
        ]),
      ).toEqual({ decision: "allow" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
