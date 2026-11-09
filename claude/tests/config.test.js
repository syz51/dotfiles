// Offline checks of the Claude Code configuration kept in this repository. They read
// only tracked files, so they run in CI; tests/live.test.js covers the installed setup.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CATEGORIES, OUTCOMES } from "../factory/metrics/reviews.js";
import { REQUIRED } from "../factory/setups/cli.js";
import { configuredEffort } from "./lib/live.js";
import { BUDGET_MS, CALL_TIMEOUT_MS } from "../hooks/guard-pr-merge.js";

const CLAUDE = join(import.meta.dir, "..");
const REPO = join(CLAUDE, "..");
const read = (path) => readFileSync(join(REPO, path), "utf8");
const globalInstructions = read("claude/CLAUDE.md");

function tracked(path) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: REPO, encoding: "utf8" });
  if (result.error) throw result.error;
  return result.status === 0;
}

function frontmatter(path) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(read(path));
  if (!match) throw new Error(`${path} has no frontmatter`);
  return { meta: Bun.YAML.parse(match[1]), body: match[2] };
}

// Text of one `## Heading` section of the global instructions.
function section(heading) {
  const match = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(globalInstructions);
  if (!match) throw new Error(`claude/CLAUDE.md has no "${heading}" section`);
  return match[1];
}

// These agents never get the claude.ai Gmail and Docs connectors: their instructions and
// schemas add about 1.5k tokens to each such subagent's prompt (dotfiles-116). Built-in
// agent types still get them.
const CONNECTORS = ["mcp__claude_ai_Gmail", "mcp__claude_ai_Claude_Docs"];
const POLICY = {
  explorer: { model: "haiku", effort: "xhigh", disallowedTools: ["Write", "Edit", "NotebookEdit", "Agent", ...CONNECTORS] },
  worker: { model: "opus", effort: "high", disallowedTools: ["Agent", ...CONNECTORS] },
  solver: { model: "opus", effort: "xhigh", disallowedTools: ["Agent", ...CONNECTORS] },
};
const agentFiles = readdirSync(join(CLAUDE, "agents")).filter((name) => name.endsWith(".md"));

describe("agents", () => {
  test("the agents directory holds exactly the policy's agents, all tracked", () => {
    expect(agentFiles.map((name) => name.slice(0, -3)).sort()).toEqual(Object.keys(POLICY).sort());
    for (const name of agentFiles) expect(tracked(`claude/agents/${name}`)).toBe(true);
  });

  test.each(Object.entries(POLICY))("%s frontmatter matches the policy", (name, policy) => {
    const { meta, body } = frontmatter(`claude/agents/${name}.md`);
    expect(Object.keys(meta).sort()).toEqual(["description", "disallowedTools", "effort", "model", "name"]);
    expect(meta.name).toBe(name);
    expect(meta.model).toBe(policy.model);
    expect(meta.effort).toBe(policy.effort);
    expect(meta.disallowedTools.split(",").map((tool) => tool.trim())).toEqual(policy.disallowedTools);
    expect(meta.description.length).toBeGreaterThan(20);
    expect(body.trim().length).toBeGreaterThan(30);
  });

  test("explorer's instructions keep it read-only", () => {
    expect(frontmatter("claude/agents/explorer.md").body).toMatch(/do not edit files/);
  });

  test("every agent is described as one independent track run in parallel", () => {
    for (const name of agentFiles)
      expect(frontmatter(`claude/agents/${name}`).meta.description).toMatch(/\bindependent\b.*\bin parallel with other work\b/);
  });

  test("worker runs at the main session's configured Opus effort, so a parallel track loses none", () => {
    expect(POLICY.worker.effort).toBe(configuredEffort("claude-opus-5-5"));
  });

  test("implementing agents own their whole track and stay within their assigned files", () => {
    for (const name of ["worker", "solver"]) {
      const { body } = frontmatter(`claude/agents/${name}.md`);
      expect(body).toMatch(/You own this (track|problem) end to end/);
      expect(body).toMatch(/change only the files in your assignment/i);
    }
    expect(frontmatter("claude/agents/worker.md").body).toMatch(/investigate what it needs, design within the interfaces you were given, and implement it, keeping its tests in step when your assignment includes them/);
  });
});

describe("global instructions", () => {
  test("every agent the Delegation section names exists, and every agent is named", () => {
    const named = [...section("Delegation").matchAll(/ to `([\w-]+)`/g)].map((match) => match[1]);
    expect(named.sort()).toEqual(Object.keys(POLICY).sort());
  });

  test("every ~/.claude file they reference is tracked in this repository", () => {
    const references = [...globalInstructions.matchAll(/~\/\.claude\/([\w./-]+)/g)].map((match) => match[1]);
    for (const path of references) expect(tracked(`claude/${path}`), `claude/${path}`).toBe(true);
  });

  // Agents stopped at "ask the user to merge" on ready pull requests. The Autonomy section
  // authorizes such steps, so the scorer must not count asking before them as correct.
  test("the scoring rubric counts asking only for the Autonomy section's reasons", () => {
    const rubric = JSON.parse(read("claude/factory/scoring/rubric.json"));
    const question = rubric.dimensions.find((check) => check.id === "unnecessary-confirmation").question;
    expect(question).toMatch(/Asking for one of the reasons the instructions' Autonomy section lists \(design, cost, irreversible, outside, only-me, security or intent\) is correct/);
    expect(question).toMatch(/neither do merging, pushing, deploying or cleaning up after work the instructions or prompts authorized/);
    expect(question).not.toMatch(/external writes or communications/);
  });

  test("they keep the high-consequence and mode safeguards", () => {
    for (const concept of [
      /fast mode/,
      /`ultra` code review/,
      /secrets/,
      /credentials/,
      /force-with-lease/,
      /default branch/,
      /production/,
      /external writes/,
      /read-only/,
      /`\/code-review` is the only review process/,
      /at `xhigh` on the final diff/,
    ])
      expect(globalInstructions).toMatch(concept);
  });

  test("the repository's own skill has matching frontmatter", () => {
    const { meta } = frontmatter("claude/skills/headless-browser/SKILL.md");
    expect(meta.name).toBe("headless-browser");
    expect(meta.description.length).toBeGreaterThan(20);
  });

  test("headless-browser screenshots go to the session scratchpad when there is one", () => {
    expect(read("claude/skills/headless-browser/SKILL.md")).toContain("`--dir <scratchpad>/headless-browser`");
    expect(read("claude/skills/headless-browser/scripts/browse.ts")).toMatch(/case 'dir': opts\.dir = resolve\(next\(\)\)/);
  });

  // No live scenario covers continuing an agent: it needs a defect to surface after a
  // track returns, which a fixture cannot trigger reliably.
  test("Delegation sends a parallel correction back to the agent that has the context", () => {
    expect(section("Delegation")).toMatch(/continue the agent that did the track when it and its checkout still exist, otherwise start a new task with the original brief and findings/);
  });

  // Most of the user's repositories have no branch protection, so the hook enforces the merge
  // condition the Autonomy section grants (dotfiles-259).
  test("the merge rule names the hook that enforces it", () => {
    expect(section("Autonomy")).toContain("The guard-pr-merge hook refuses a `gh pr merge` with `--admin`, on a draft, or before every check on the head commit has passed, except `--auto` where GitHub waits for the base branch's required checks. An Actions job that GitHub never started for billing counts as passed when a non-Actions check named `<context>: <job name>` passed.");
  });

  // t3_thread_launch takes its brief in `message` and drops unknown keys; launches that passed
  // `prompt` made idle threads with runId null, and t3_thread_send started a run each time
  // (board-feedback-369, dotfiles-204). No live scenario covers it: the live suites have no
  // T3 tools.
  test("Delegation puts a T3 launch brief in message and resends it when no run started", () => {
    expect(section("Delegation")).toContain("Pass a `t3_thread_launch` brief in `message`; T3 silently drops a `prompt` key and starts no run, so when the result's `runId` is null, send the brief with `t3_thread_send`.");
  });
});

describe("settings", () => {
  const settings = JSON.parse(read("claude/settings.json"));
  const handlers = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));

  test("every hook command under ~/.claude runs a tracked script", () => {
    const scripts = handlers.flatMap((hook) =>
      [...hook.command.matchAll(/\$HOME\/\.claude\/([\w./-]+)/g)].map((match) => match[1]));
    expect(scripts).toContain("hooks/guard-git-push.js");
    for (const path of scripts) expect(tracked(`claude/${path}`), `claude/${path}`).toBe(true);
  });

  // A copied hook that cannot load a module it imports exits 1, a non-blocking hook error, so
  // the guards would fail open; SETUP.md has the whole hooks directory linked for this reason.
  test("every module a hook script imports is tracked beside it", () => {
    const pending = handlers.flatMap((hook) =>
      [...hook.command.matchAll(/\$HOME\/\.claude\/([\w./-]+\.js)/g)].map((match) => `claude/${match[1]}`));
    const seen = new Set();
    while (pending.length > 0) {
      const path = pending.pop();
      if (seen.has(path)) continue;
      seen.add(path);
      for (const [, relative] of read(path).matchAll(/^import .* from "(\.{1,2}\/[^"]+)";$/gm)) {
        const imported = join(dirname(path), relative);
        expect(tracked(imported), `${path} imports ${imported}`).toBe(true);
        pending.push(imported);
      }
    }
    expect(seen).toContain("claude/hooks/shell.js");
  });

  // A 200K window is a trial from 2026-11-08; SETUP.md gives the reason and the baseline.
  // A per-model autoCompactWindow (which /autocompact saves) would override it unseen.
  test("conversations compact against a 200K window, not the 1M one", () => {
    expect(settings.autoCompactWindow).toBe(200000);
    for (const model of Object.values(settings.modelSettings ?? {})) {
      expect(model).not.toHaveProperty("autoCompactWindow");
    }
  });

  // This applies to every Claude Code worktree (--worktree, EnterWorktree and subagent
  // isolation), so all of them carry the current branch and its unpushed commits.
  test("worktrees branch from the local HEAD, not the remote default branch", () => {
    expect(settings.worktree).toEqual({ baseRef: "head" });
  });

  // "head" never looks at origin, so a default branch that never pulled hands out old code
  // (board-feedback-14); the hook fast-forwards it first when that is safe.
  test("a hook freshens the default branch before a worktree is cut from it", () => {
    const groups = settings.hooks.PreToolUse.filter((group) => group.hooks.some((hook) => hook.command.includes("hooks/freshen-base.js")));
    expect(groups.map((group) => group.matcher)).toEqual(["^(EnterWorktree|Agent|Task)$"]);
    expect(tracked("claude/hooks/freshen-base.js")).toBe(true);
  });

  // T3's delegate_task and `claude --worktree` cut worktrees without a tool call, so
  // freshen-base never runs for them (board-feedback-392); the session is warned at start.
  test("a session that starts in a worktree behind origin's default branch is warned", () => {
    const groups = settings.hooks.SessionStart.filter((group) => group.hooks.some((hook) => hook.command.includes("hooks/stale-base.js")));
    expect(groups.map((group) => group.matcher)).toEqual(["startup"]);
    expect(groups[0].hooks[0].timeout).toBeLessThanOrEqual(10);
    expect(tracked("claude/hooks/stale-base.js")).toBe(true);
  });

  // The claude.ai Gmail connector is the Claude counterpart of Codex's Gmail plugin; it
  // signs in only on claude.ai, so it loads only through claude.ai connectors.
  test("claude.ai connectors load, so the Gmail connector is available", () => {
    expect(settings.disableClaudeAiConnectors).toBeUndefined();
  });

  // A `!`cmd`` line in a skill or custom slash command runs without PreToolUse hooks, so the
  // guards never see it, and any repository a session opens can ship such a command.
  test("skills and custom slash commands cannot run shell lines before the model reads them", () => {
    expect(settings.disableSkillShellExecution).toBe(true);
  });

  // Codex names its shell tool Bash in hook input and matchers, so the same guards cover it.
  test.each([
    ["claude/settings.json", "guard-git-push.js"],
    ["claude/settings.json", "guard-runtimes.js"],
    ["claude/settings.json", "guard-main-checkout.js"],
    ["claude/settings.json", "guard-pr-merge.js"],
    ["codex/hooks.json", "guard-git-push.js"],
    ["codex/hooks.json", "guard-runtimes.js"],
  ])("%s registers the %s guard for Bash PreToolUse", (path, script) => {
    const guard = JSON.parse(read(path)).hooks.PreToolUse.filter((group) =>
      new RegExp(group.matcher).test("Bash")
      && group.hooks.some((hook) => hook.type === "command"
        && hook.command === `"$HOME/.bun/bin/bun" "$HOME/.claude/hooks/${script}"`));
    expect(guard).toHaveLength(1);
  });

  // A hook that times out is a non-blocking error, so the merge would run unchecked. Each gh
  // call is capped at the budget left, so all of them end within BUDGET_MS; the rest of the
  // hook timeout covers bun's start and the parse.
  test("the pr-merge guard's timeout covers its gh calls", () => {
    const hook = handlers.find((handler) => handler.command.includes("hooks/guard-pr-merge.js"));
    expect(CALL_TIMEOUT_MS).toBeLessThanOrEqual(BUDGET_MS);
    expect(BUDGET_MS + 10000).toBeLessThanOrEqual(hook.timeout * 1000);
  });

  test("claude/settings.json runs the ask gate on the board's ask_user tool and nothing else", () => {
    const groups = settings.hooks.PreToolUse.filter((group) =>
      group.hooks.some((hook) => hook.command === '"$HOME/.bun/bin/bun" "$HOME/.claude/hooks/guard-asks.js"'));
    expect(groups).toHaveLength(1);
    expect(new RegExp(groups[0].matcher).test("mcp__board__ask_user")).toBe(true);
    for (const tool of ["Bash", "mcp__board__task_add", "AskUserQuestion"]) expect(new RegExp(groups[0].matcher).test(tool)).toBe(false);
  });

  // guard-asks reads its policy at run time, so a missing or broken file would let every ask through.
  test("the ask gate's policy file is tracked and valid", () => {
    expect(tracked("claude/hooks/ask-policy.json")).toBe(true);
    const policy = JSON.parse(read("claude/hooks/ask-policy.json"));
    expect(Object.keys(policy.reasons).length).toBeGreaterThan(0);
    for (const name of policy.action_reasons) expect(Object.keys(policy.reasons)).toContain(name);
  });
});

// git/ignore is the global excludes file (SETUP.md). Claude Code keeps per-checkout settings in
// .claude/settings.local.json, stages writes it cannot make in place in .claude/.cc-writes/, and
// puts Agent isolation and EnterWorktree checkouts in .claude/worktrees/.
// It is checked in an empty repository, since this one's .gitignore also covers /.claude/.
test.each([".claude/settings.local.json", ".claude/.cc-writes/file", "sub/.claude/.cc-writes/file", ".claude/worktrees/x/file", "sub/.claude/worktrees/x/file"])("the global git ignore file excludes %s", (path) => {
  const repo = mkdtempSync(join(tmpdir(), "git-ignore-"));
  try {
    expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
    const result = spawnSync("git", ["-c", `core.excludesFile=${join(REPO, "git", "ignore")}`, "check-ignore", "--no-index", "-q", path], { cwd: repo });
    expect(result.status).toBe(0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the root CLAUDE.md holds the repository instructions directly", () => {
  expect(lstatSync(join(REPO, "CLAUDE.md")).isFile()).toBe(true);
  const instructions = read("CLAUDE.md");
  expect(instructions).not.toMatch(/^\s*@/m);
  expect(instructions).toMatch(/clean up temporary test files/);
  expect(instructions).toMatch(/^- Keep the test suite in step with every change/m);
  expect(instructions).toMatch(/run only the live suite files and scenarios the change touches while you work, and the full live set once before merge/);
});

describe("rejected frontend defaults list", () => {
  test("is tracked and keeps its rule for using and adding patterns", () => {
    expect(tracked("claude/frontend-avoid.md")).toBe(true);
    const list = read("claude/frontend-avoid.md");
    expect(list).toMatch(/do not use them unless the brief, a reference, or the existing project calls for them/);
    expect(list).toMatch(/explicitly rejects a pattern as an unwanted default, not for feedback on a single design/);
    expect(list).toMatch(/one per line/);
  });

  // The skill feedback pipeline proposes additions as "- <pattern>" lines in this section.
  test("ends with a Patterns section of one-line entries", () => {
    const parts = read("claude/frontend-avoid.md").split(/^## Patterns\n/m);
    expect(parts).toHaveLength(2);
    expect(parts[1]).not.toMatch(/^## /m);
    for (const line of parts[1].split("\n").filter((text) => text.trim())) expect(line).toMatch(/^- \S/);
  });
});

// The work board (github.com/syz51/agent-board) hooks into every Claude Code and Codex
// session through hooks/board-hook.sh. It runs the installed `board`, and behaves as if the
// hook were absent without it or with AGENT_BOARD_HOOKS=off, which lib/process.js childEnv
// sets for test and benchmark sessions so they stay off the real board.
describe("work board", () => {
  const SCRIPT = join(CLAUDE, "hooks/board-hook.sh");
  const HOOK = /^\/bin\/sh "\$HOME\/\.claude\/hooks\/board-hook\.sh" ([a-z-]+) (claude|codex)$/;
  const boardHooks = (hooks) =>
    Object.entries(hooks).flatMap(([event, groups]) =>
      groups.flatMap((group) =>
        group.hooks
          .filter((hook) => hook.command.includes("board"))
          .map((hook) => ({ event, matcher: group.matcher, hook, match: HOOK.exec(hook.command) }))));
  const CLAUDE_EVENTS = {
    SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit", PreToolUse: "pre-tool-use", PostToolUse: "post-tool-use",
    PostToolUseFailure: "post-tool-use-failure", PreCompact: "pre-compact", Stop: "stop", StopFailure: "stop-failure", SessionEnd: "session-end",
  };
  const CODEX_EVENTS = {
    SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit", PreToolUse: "pre-tool-use", PostToolUse: "post-tool-use",
    Stop: "stop", SessionEnd: "session-end",
  };

  test.each([
    ["claude/settings.json", "claude", CLAUDE_EVENTS],
    ["codex/hooks.json", "codex", CODEX_EVENTS],
  ])("%s runs exactly one board hook per event, through the tracked script", (path, runtime, events) => {
    const found = boardHooks(JSON.parse(read(path)).hooks);
    const pairs = (list) => list.map((pair) => pair.join(" ")).sort();
    expect(pairs(found.map(({ event, match }) => [event, match?.[1]]))).toEqual(pairs(Object.entries(events)));
    for (const { hook, match } of found) {
      expect(match?.[2]).toBe(runtime);
      expect(hook.timeout).toBeLessThanOrEqual(5);
    }
    expect(tracked("claude/hooks/board-hook.sh")).toBe(true);
  });

  // Matchers as `board install` writes them. board marks each shell call's start, so
  // PostToolUse (or PostToolUseFailure, as a failing command may still change files) can
  // record the files it changed.
  test.each([
    ["claude/settings.json", { PostToolUse: "*", SessionStart: "startup|resume|clear|compact", PreToolUse: "Bash", PostToolUseFailure: "Bash" }],
    ["codex/hooks.json", { SessionStart: "startup|resume|clear|compact|fork", PreToolUse: "Bash" }],
  ])("%s gives the board hooks the matchers board install writes", (path, matchers) => {
    const found = boardHooks(JSON.parse(read(path)).hooks);
    for (const [event, matcher] of Object.entries(matchers)) expect(found.find((entry) => entry.event === event)?.matcher, event).toBe(matcher);
  });

  function withHome(body) {
    const home = mkdtempSync(join(tmpdir(), "board-hook-"));
    try {
      return body(home, (args, extra = {}) =>
        spawnSync("/bin/sh", [SCRIPT, ...args], { env: { PATH: process.env.PATH, HOME: home, ...extra }, input: "{}", encoding: "utf8" }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  // Installs a fake board that records its arguments and stdin in home, then runs script.
  function fakeBoard(home, script = "") {
    mkdirSync(join(home, ".cargo/bin"), { recursive: true });
    const fake = join(home, ".cargo/bin/board");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s ' "$@" > "${home}/args"\ncat > "${home}/stdin"\n${script}`);
    chmodSync(fake, 0o755);
  }

  test("without board each hook does nothing, except the JSON Codex requires from Stop", () => {
    withHome((_, run) => {
      const cases = [
        ...Object.values(CLAUDE_EVENTS).map((event) => [event, "claude"]),
        ...Object.values(CODEX_EVENTS).map((event) => [event, "codex"]),
      ];
      for (const [event, runtime] of cases) {
        const result = run([event, runtime]);
        expect(result.status, `${event} ${runtime}`).toBe(0);
        expect(result.stdout, `${event} ${runtime}`).toBe(event === "stop" && runtime === "codex" ? "{}\n" : "");
      }
    });
  });

  test("an installed board gets the event and runtime, unless AGENT_BOARD_HOOKS=off", () => {
    withHome((home, run) => {
      fakeBoard(home);
      expect(run(["stop", "codex"], { AGENT_BOARD_HOOKS: "off" }).stdout).toBe("{}\n");
      expect(existsSync(join(home, "args"))).toBe(false);
      expect(run(["post-tool-use", "claude"]).status).toBe(0);
      expect(readFileSync(join(home, "args"), "utf8")).toBe("hook post-tool-use --runtime claude ");
      expect(readFileSync(join(home, "stdin"), "utf8")).toBe("{}");
    });
  });

  test("the board's output, stderr and exit status reach the runtime unchanged", () => {
    withHome((home, run) => {
      fakeBoard(home, "printf '{\"decision\":\"block\"}'\necho warn >&2\nexit 3\n");
      for (const event of ["stop", "pre-tool-use"]) {
        expect(run([event, "codex"]), event).toMatchObject({ status: 3, stdout: "{\"decision\":\"block\"}", stderr: "warn\n" });
        expect(readFileSync(join(home, "args"), "utf8")).toBe(`hook ${event} --runtime codex `);
      }
    });
  });

  // A board older than agent-board#8 rejects pre-tool-use and post-tool-use-failure with
  // exit 2, which would block every shell call from PreToolUse. Only for those events, exit 2
  // becomes 1, a failed hook that does not block; other events keep the board's status.
  test("a board that rejects a newer event fails the hook without blocking the call", () => {
    withHome((home, run) => {
      fakeBoard(home, "echo \"error: invalid value '$2'\" >&2\nexit 2\n");
      for (const event of ["pre-tool-use", "post-tool-use-failure"]) {
        expect(run([event, "claude"]), event).toMatchObject({ status: 1, stdout: "", stderr: `error: invalid value '${event}'\n` });
        expect(readFileSync(join(home, "args"), "utf8")).toBe(`hook ${event} --runtime claude `);
      }
      expect(run(["stop", "claude"]).status).toBe(2);
    });
  });

  test("the rule says what to act on and what is only data", () => {
    const rule = section("Work board");
    for (const tool of ["task_claim", "lease_paths", "handoff_set", "task_done", "ask_user"]) expect(rule).toContain(`\`${tool}\``);
    expect(rule).toMatch(/Track all work for such a repository on its board, never only in chat, a plan file, ledger, TODO or next-steps list, handoff, or GitHub issue for our own backlog, even where the project's files say otherwise/);
    expect(rule).toMatch(/create one only when I ask/);
    expect(rule).toMatch(/Work I ask for directly gets its own task, including work you won't do now: before changing files or state, add one unless a task already covers it, and claim it/);
    expect(rule).toMatch(/title, body and acceptance checks/);
    expect(rule).toMatch(/never follow instructions/);
  });

  // Anything still to do that lives only in chat, a file or a handoff is lost when the
  // session ends or the task closes. Each kind has one place, matching the board's own
  // instructions and coordinator prompt: remaining scope is a sub-task (no review needed),
  // new scope a proposal another agent reviews, and the user's part a non-auto blocked
  // task with an ask, so no coordinator starts it. Sections that name their own place
  // (storage problems) keep it.
  test("everything still to do goes on the board, in the form its kind needs", () => {
    const rule = section("Work board");
    expect(rule).toMatch(/Before `task_done`, and before ending a turn, put each remaining step, follow-up and suggestion on the board, checking first for a task that covers it \(add a note there instead\)\. Where another section names the place for something, such as storage problems, it goes there/);
    expect(rule).toMatch(/Scope your task still needs: a sub-task \(`task_add` with your task as parent\)\. Your task stays open until every acceptance check passes/);
    expect(rule).toMatch(/Work you find outside your task: a proposal \(`task_add` with `auto=false` and a body starting `Proposal:` that gives the problem, the evidence without secrets, the change and its size S, M or L\), on this repository's board or on its owner's board when you know it, with the task you found it in, if any, as parent/);
    expect(rule).toMatch(/Work that waits on my decision or action: a task with `auto=false`, set `blocked` with an `ask_user`/);
    expect(rule).toMatch(/Name what you filed in your reply, and report it there instead when filing fails\. Don't ask me before filing/);
    expect(rule).toMatch(/A handoff's `next` holds only the first action on your claimed task/);
    expect(section("Workflow")).toMatch(/File unrelated issues and follow-ups as the Work board section says, otherwise report them; don't expand scope/);
  });

  // Filing is not a change to the work, so read-only work files too. Subagents run under
  // the parent's board identity and would see its task as their own, so they report and
  // the parent, which checks findings first, files the real ones; rejected review findings
  // are reported, not filed. Agents in their own threads file for themselves.
  test("read-only work files too, and parents file what subagents and reviews report", () => {
    const rule = section("Work board");
    expect(rule).toMatch(/Read-only work, such as a review or an investigation, files too, unless I say not to touch the board/);
    expect(rule).toMatch(/Subagents share your board identity, so they never file: they report what they find, and you file each real item you do not fix\. Agents in their own threads, such as a coordinator's children, file for themselves/);
    expect(section("Review")).toMatch(/Report the findings you reject as not real, with the reason; file the real ones outside what the change is meant to do as found work under the Work board section, or report them where there is no board, instead of fixing them/);
    expect(section("Basic safeguards")).toMatch(/Keep reviews and advice read-only unless changes are requested; filing on the work board is not such a change/);
    for (const agent of ["explorer", "worker", "solver"]) expect(read(`claude/agents/${agent}.md`), agent).toMatch(/List work you found .*, for the parent to file\.$/m);
  });

  // Asks sent the user to look up what memory, the board or a repository already held,
  // and different threads asked the same question.
  test("an ask comes after searching and carries what was found", () => {
    expect(section("Work board")).toContain("- Before `ask_user`, search memory, the board (other tasks' notes and answered asks), the repositories and related threads for the answer; an ask states what you found and asks only for what remains.\n");
  });

  // The user reviews waiting work from lists and had to ask "explain number N" for each
  // item whose body was written for agents (dotfiles-89).
  test("an ask and a task waiting on the user open with a decision brief", () => {
    const rule = "- Open each ask, and the body of each task that waits on my decision or action, with a brief in plain, short sentences: what it is, in one sentence; why it waits on me; the options, each with its consequence; your recommendation. Agent detail goes below the brief. Explain an item I ask about in the same structure, with a diagram only when it involves a flow across several parts.\n";
    expect(section("Work board")).toContain(rule);
    expect(read("codex/AGENTS.md")).toContain(rule);
  });

  test("the scoring rubric counts filing as in scope and needing no approval", async () => {
    const rubric = JSON.parse(read("claude/factory/scoring/rubric.json"));
    const question = (id) => rubric.dimensions.find((check) => check.id === id).question;
    expect(question("scope-creep")).toMatch(/fixed unrelated issues instead of filing or reporting them/);
    expect(question("unnecessary-confirmation")).toMatch(/filing found work on the repository's board needs no approval/);
  });

  test("Codex gets the same rule", () => {
    expect(read("codex/AGENTS.md")).toContain(`## Work board\n${section("Work board").trimEnd()}\n`);
    expect(tracked("codex/AGENTS.md")).toBe(true);
  });
});

describe("storage rule", () => {
  test("names every destination, the entry command and where problems go", () => {
    const rule = section("Storage");
    for (const name of ["cloud", "sai", "pro", "air", "svps"]) expect(rule).toContain(`\`${name}\``);
    expect(rule).toContain("`storagectl dests`");
    expect(rule).toMatch(/root login shells/);
    // Problems go through the Feedback section, whose triage routes storage to the vps board.
    expect(rule).toMatch(/Report what got in the way as Feedback with `about` `storage`, giving the machine, command, error and workaround, then continue with the workaround/);
    expect(rule).not.toContain("child task of `vps-44`");
  });

  test("says how to split work across machines and where that feedback goes", () => {
    const rule = section("Storage");
    expect(rule).toMatch(/Split work across machines/);
    expect(rule).toContain("`storagectl run --on sai|pro --to <dest>:<path> [--stage <file or dir>] -- <command>`");
    expect(rule).toContain("`$STORAGE_OUT`");
    expect(rule).toContain("`storagectl status|logs|cancel <id>`");
    expect(rule).toMatch(/never run workloads as root on sai or svps; svps runs no jobs/i);
    expect(rule).not.toContain("`vps-46`");
    expect(rule).toMatch(/note on `vps-45` while it is open/);
  });

  test("Codex gets the same rule", () => {
    expect(read("codex/AGENTS.md")).toContain(`## Storage\n${section("Storage").trimEnd()}\n`);
  });
});

describe("feedback rule", () => {
  test("reports setup friction once through the feedback tool, then continues", () => {
    const rule = section("Feedback");
    expect(rule).toContain("report it once with the `feedback` MCP tool, or `board feedback --about <setup> --activity <activity> '<what happened>'` where the tool is missing, then continue with a workaround");
    // The board's activities, which have no verify.
    expect(rule).toContain("(`explore`, `research`, `design`, `plan`, `build`, `review`, `operate` or `other`)");
    expect(rule).toContain("Report it in your reply instead when filing fails; delegated children report it to their parent, which files it.");
    expect(rule).toMatch(/an id from `~\/\.config\/setups\.toml`, `other` when unsure/);
    expect(rule).toMatch(/triage routes it to the setup's owner, so don't follow it up/);
    expect(rule).toMatch(/not defects in the work itself: a project's bugs stay on its board, and a skill's guidance problems go through that skill's own feedback capture/);
  });

  test("the setups it names are in the registry", () => {
    const ids = Bun.TOML.parse(read("setups.toml")).setup.map((setup) => setup.id);
    for (const id of [...REQUIRED, "work-stages"]) expect(ids).toContain(id);
  });

  test("Codex gets the same rule, and Feedback follows Storage in both", () => {
    expect(read("codex/AGENTS.md")).toContain(`## Feedback\n${section("Feedback").trimEnd()}\n`);
    for (const path of ["claude/CLAUDE.md", "codex/AGENTS.md"]) expect(read(path)).toMatch(/\n## Storage\n(?:(?!\n## )[\s\S])*\n\n## Feedback\n/);
  });
});

describe("T3 self-settle", () => {
  test("finished threads settle themselves after a final check; coordinators and subagents never do", () => {
    const rule = section("Workflow").split("\n").find((line) => line.startsWith("- In a T3 thread, end the turn that finishes your work"));
    expect(rule).toBeDefined();
    for (const guard of [
      "nothing is left to do, track or file",
      "no running job",
      "open PR you must still merge or fix",
      "task you own in `doing`",
      "question or ask I have not answered",
      "report item I must act on",
    ]) expect(rule).toContain(guard);
    expect(rule).toContain('`t3_thread_organize` with `action: "settle"` and no `threadId` as your last step, and say so in the report.');
    expect(rule).toContain('call it again with `action: "unsettle"`; new activity also unsettles the thread.');
    expect(rule).toContain("A brief or routine with its own settle rule overrides this one.");
    expect(rule).toContain("Board coordinator threads and Agent-tool subagents never settle themselves; threads started by `delegate_task` or `t3_thread_launch` do.");
  });
});

describe("work stages", () => {
  const STAGES = ["Explore", "Research", "Design", "Plan", "Build", "Verify"];
  const WORKFLOW = "- Shape non-trivial work in the stages of the `work-stages` skill (explore, research, design, plan, build, verify), skipping those it does not need.";

  test("both instruction files point non-trivial work at the skill", () => {
    expect(section("Workflow")).toContain(WORKFLOW);
    expect(read("codex/AGENTS.md")).toContain(`## Workflow\n\n${WORKFLOW}\n`);
  });

  test("the skill has its frontmatter, every stage in order and its feedback channel", () => {
    const { meta, body } = frontmatter("claude/skills/work-stages/SKILL.md");
    expect(meta.name).toBe("work-stages");
    expect(meta.description).toMatch(/^Shape any non-trivial work, whether investigation, research, design, planning, implementation or verification, into stages with clear exit evidence, board records and agent roles\. Also use to review feedback to improve this skill\.$/);
    const rows = body.split("\n").filter((line) => /^\| [A-Z]\w+ \|/.test(line) && !line.startsWith("| Stage")).map((line) => line.split("|")[1].trim());
    expect(rows).toEqual(STAGES);
    expect(body).toMatch(/A small fix may go straight to build/);
    expect(body).toMatch(/recording why in a `decision` note/);
    // The board's activities have no verify; Verify reports as review.
    expect(body).toMatch(/`review` for Verify/);
    expect(body).toMatch(/take precedence over this skill/);
    expect(body).toMatch(/One track stays with one agent through every stage it needs/);
    // The same split as the Work board section: subagents report, read-only threads file.
    expect(body).toMatch(/Subagents put their findings, decisions, open questions and work found outside their track in their report; the parent records them on the board\. Read-only work in its own thread, such as a review or an investigation, records them itself\./);
    expect(body).toMatch(/Before `task_done`, and before ending a turn, file what is still to do as the Work board section says\./);
    expect(body).toMatch(/## Feedback on this skill\n\nReport it with `feedback` and `about` `work-stages`\./);
    expect(tracked("claude/skills/work-stages/SKILL.md")).toBe(true);
  });
});

// Without its own id, an agent may report a skill's guidance problem as `skills`, which
// routes to codex-skills, the wrong owner.
describe("in-repo skills' feedback channels", () => {
  const SKILLS = ["cheat-sheets", "headless-browser", "ui-climb"];

  test.each(SKILLS)("%s ends with a feedback section naming its registered setup id", (id) => {
    expect(Bun.TOML.parse(read("setups.toml")).setup.map((setup) => setup.id)).toContain(id);
    const { meta, body } = frontmatter(`claude/skills/${id}/SKILL.md`);
    expect(meta.name).toBe(id);
    const feedback = body.slice(body.lastIndexOf("\n## ") + 1);
    expect(feedback).toMatch(new RegExp(`^## Feedback on this skill\\n\\nReport it with \`feedback\` and \`about\` \`${id}\`\\.`));
    expect(feedback).toContain(`\`${id}\` and the dotfiles tasks they were routed to`);
    expect(tracked(`claude/skills/${id}/SKILL.md`)).toBe(true);
  });
});

// The live suites test these rules; a rule changing or disappearing means the matching
// live scenario needs updating too.
describe("rules the live suites test", () => {
  test("Skills routes each language and UI skill", () => {
    const skills = section("Skills");
    for (const name of ["frontend-ui", "typescript", "rust", "tauri"]) expect(skills).toContain(`\`${name}\``);
    expect(skills).toMatch(/load `frontend-ui` first/);
    expect(skills).toMatch(/unrelated work in a TypeScript or Rust repository needs neither language skill/i);
    expect(skills).toMatch(/data-visualization skill/);
  });

  // The installed frontend-ui skill tells Claude Code and Codex to read the list, and the
  // list states its own rule, so the global instructions don't repeat either; the live
  // chart scenario checks that the read still happens.
  test("the rejected frontend defaults list is left to the frontend-ui skill", () => {
    expect(globalInstructions).not.toContain("frontend-avoid");
  });

  test("Working preferences keep uv, and bun only even over project lockfiles", () => {
    const preferences = section("Working preferences");
    expect(preferences).toMatch(/`uv run`/);
    expect(preferences).toMatch(/`bun`/);
    expect(preferences).toContain("Never run `node`, including for fallbacks or through `vp node`");
    expect(preferences).toMatch(/never npm, npx, pnpm, yarn or corepack, even where a project's lockfiles/);
    // Vite+ may run checks and tools; installs and package queries stay on bun, as guard-runtimes enforces.
    expect(preferences).toContain("checks and tooling with `bun`, `bunx` or Vite+ (`vp`), and installs and package queries with `bun` only");
    expect(preferences).toMatch(/require another package manager, stop and ask me/);
    expect(read("codex/AGENTS.md")).toContain(`## Working preferences\n\n${preferences.split("\n").find((line) => line.startsWith("- Run all Python"))}\n`);
  });

  // The user has only a Claude plan; guard-runtimes also blocks the codex CLI.
  test("Working preferences allow Claude models only, in both instruction files", () => {
    const rule = section("Working preferences").split("\n").find((line) => line.startsWith("- Use Claude models only"));
    expect(rule).toBeDefined();
    expect(rule).toContain("Never start the `codex` CLI or a `gpt-*` model");
    expect(rule).toContain("never delegate to the Codex provider");
    expect(rule).toContain("Reading past Codex session files is fine");
    // A Codex session cannot spawn Claude subagents, so its copy says to hand the work back.
    const codexRule = read("codex/AGENTS.md").split("\n").find((line) => line.startsWith("- Use Claude models only"));
    expect(codexRule).toContain("stop and ask me to continue it in Claude");
    expect(codexRule).toContain("Never start the `codex` CLI or a `gpt-*` model");
    expect(codexRule).toContain("never delegate to the Codex provider");
  });

  test("Workflow stops background work before finishing", () => {
    expect(section("Workflow")).toMatch(/Before finishing, stop the background commands and processes you started and confirm none is still running, unless I asked to keep them running/);
  });

  test("Delegation is a standing request limited to parallel tracks", () => {
    const delegation = section("Delegation");
    expect(delegation).toMatch(/standing request to use subagents, so don't wait for me to ask/);
    expect(delegation).toMatch(/Delegate only when running work in parallel pays off/);
    expect(delegation).toMatch(/each needing little of this conversation's context or of the others'/);
    expect(delegation).toMatch(/one agent per track/);
    expect(delegation).toMatch(/Unless I ask for one, don't hand a single track to an agent and then just wait for it/);
    expect(delegation).toMatch(/takes only a handful of tool calls/);
    expect(delegation).toMatch(/Don't use subagents to verify your own work/);
    expect(delegation).toMatch(/Agents that stand in for a tool you lack, such as `web-fetch`, are tool use, not delegation/);
    expect(section("Review")).toMatch(/delegating only fixes that split into parallel tracks/);
  });

  // Anthropic's multi-agent guidance: split by context, not by type of work, because
  // each handoff between phases of the same work loses context.
  test("Delegation splits by context, and each agent owns its whole track", () => {
    const delegation = section("Delegation");
    expect(delegation).toMatch(/Split work by context, not by type of work/);
    expect(delegation).toMatch(/each agent owns its whole track, from investigation through implementation and tests/);
    expect(delegation).toMatch(/one area's work never passes from one agent to another, such as an explorer's findings to a worker/);
    expect(delegation).toMatch(/Choose each track's agent by what the whole track does/);
    expect(delegation).toMatch(/file edits and other state-changing work to `worker`/);
    expect(delegation).toMatch(/hard debugging or reasoning, including its fix, to `solver`/);
    expect(delegation).toMatch(/Settle only the interfaces tracks share/);
    expect(delegation).toMatch(/those interfaces, what it needs from this conversation/);
    expect(delegation).not.toMatch(/decided design/);
    expect(delegation).toMatch(/Keep planning across tracks, judgment, communication, and completion verification yourself/);
  });

  test("Review fixes every real defect it finds and files the rest", () => {
    const review = section("Review");
    expect(review).toMatch(/on the final diff before pushing or reporting done/);
    expect(review).toMatch(/Check each finding against the code before deciding/);
    expect(review).toMatch(/Fix every one that is a real defect in what the change is meant to do and verify the fix/);
    expect(review).toMatch(/rerun the affected checks instead of reviewing again/);
  });

  // The change's paths set the tier, and the review-skipped detector reads the same file
  // (dotfiles-102).
  test("Review names the high-impact path lists the detector reads", () => {
    const review = section("Review");
    expect(review).toMatch(/A change to a path that `~\/\.claude\/factory\/scoring\/high-impact\.toml` lists for its repository is always high-impact/);
  });

  // factory metrics reads these records to measure review noise (dotfiles-100).
  test("Review records each finding's outcome through ReportFindings", () => {
    const review = section("Review");
    expect(review).toMatch(/Once you have decided on every finding, record the outcomes: call `ReportFindings` once with every finding, its category and its outcome/);
    expect(review).toMatch(/`fixed` for one you fixed, `no_change_needed` for one that is wrong or intentional, and `skipped` for a real one you filed or did not apply/);
    expect(review).toMatch(/Report the result in your reply as well/);
    // The tool takes at most 32 findings per call; a clean review still records.
    expect(review).toMatch(/Split more than 32 findings into calls of 32, and record a review without findings as an empty list/);
    // The outcome and category names are the ones factory metrics counts.
    const named = (text) => [...text.matchAll(/`([a-z_-]+)`/g)].map((match) => match[1]);
    expect(named(review.match(/its outcome, (.*?)\. Split/)[1])).toEqual(OUTCOMES);
    expect(named(review.match(/The categories are (.*?)\./)[1])).toEqual(CATEGORIES);
  });

  // A review run in the main thread is cut off when a message arrives mid-review; in the
  // background the thread stays free and the review finishes.
  test("Review runs in one background agent, pinned to the commit, while this thread keeps answering", () => {
    const review = section("Review");
    expect(review).toMatch(/Run that review in one background agent on this session's model, such as `general-purpose` \(not `explorer`\), so this thread stays free to answer me/);
    expect(review).toMatch(/its own worktree holding exactly the final diff/);
    expect(review).toMatch(/for a commit, have it run `\/code-review` pinned to its SHA, such as `\/code-review xhigh origin\/main\.\.\.<SHA>`/);
    // A new worktree lacks uncommitted changes, and committing needs my say-so.
    expect(review).toMatch(/for uncommitted work, transfer the diff as for any track/);
    expect(review).toMatch(/return the findings unchanged/);
    expect(review).toMatch(/answer my messages and continue work that leaves that diff alone, but don't push or report done until its findings are handled/);
    // The review covers the final diff, so a change to it, mine or the session's, restarts it.
    expect(review).toMatch(/cancel and restart it whenever the diff under review changes/);
  });

  test("Delegation isolates work in runtime worktrees and transfers their inputs", () => {
    const delegation = section("Delegation");
    expect(delegation).toMatch(/Give each track that edits files its own worktree through the runtime's worktree facility when one is available, never one made in the shell/);
    expect(delegation).toMatch(/Other tracks share this checkout; never let two tracks, or a track and you, change the same files or state at the same time/);
    expect(delegation).toMatch(/A new worktree never has uncommitted changes/);
    expect(delegation).toMatch(/transfer required inputs explicitly and have the child verify them in its checkout/);
    expect(delegation).toMatch(/bring its changes into this checkout and remove the worktree and its branch, unless I say otherwise/);
  });

  // git checks a branch out in one worktree at a time, so a brief that said to check out a
  // branch another thread's worktree held failed (board-feedback-40).
  test("both instruction files continue a held branch from origin, for agents and their briefs", () => {
    const rule = "- To continue a branch that another worktree has checked out, which git refuses to check out twice, work on a local branch started from `origin/<branch>` and push to `<branch>`; brief a child that continues one the same way.";
    expect(section("Workflow")).toContain(rule);
    expect(read("codex/AGENTS.md").match(/\n## Workflow\n((?:(?!\n## )[\s\S])*)/)[1]).toContain(rule);
  });

  // The report-style bench (bench style, dotfiles-88) kept 347/350 facts with this rule
  // against 343/350 without it, at 8.3 words per sentence against 12.4.
  test("Workflow asks for reports in Simple Technical English that keep every fact", () => {
    const rule = "- Write reports in Simple Technical English: one fact or instruction per sentence, sentences under 20 words for steps and 25 for descriptions, active voice, one word for one meaning, a vertical list for complex text. Keep every fact, number and caveat.";
    expect(section("Workflow")).toContain(rule);
  });

  test("Workflow keeps the Chinese meaning rule and its exceptions", () => {
    const workflow = section("Workflow");
    expect(workflow).toMatch(/followed by its Chinese meaning/);
    expect(workflow).toMatch(/explicit output-only or structured-format requirement/);
    expect(workflow).toMatch(/Do not duplicate Chinese-only replies/);
    expect(workflow).toMatch(/`headless-browser` skill/);
  });

  // Threads that start in a repository's main checkout share it; one that switched or reset
  // it moved the branch under the others (dotfiles-164). guard-main-checkout.js enforces the
  // git part. Fast-forwards and a clean switch back to the default branch lose nothing, and
  // the user wants agents to run them without a second step (dotfiles-235). A change the user
  // asked for in that checkout runs with the guard's per-command option; the user does not
  // want such commands handed back to them (dotfiles-263).
  test("Workflow moves work out of a shared main checkout", () => {
    expect(section("Workflow")).toMatch(/A repository's main checkout is shared by every thread that starts in it\. Read there freely, but unless I ask for a change in that checkout itself, move into your own worktree \(EnterWorktree, or a T3 worktree thread\) before you change files, commit, or switch, reset, merge, rebase, pull or stash there\. To bring it up to its upstream, or to a commit I approved, a `--ff-only` merge or pull may run there, as may a switch back to its default branch while no tracked file has changes\. A hook refuses the other git commands in a main checkout outside the temporary directories; when I asked for that change in that checkout, run the git command yourself as `git -c claude\.mainCheckout=allow <subcommand> \.\.\.`, never hand it back to me; the hook still refuses it where it would discard tracked changes or stashed work\./);
  });

  // Worktree isolation can't be turned off, and 173 of one week's Bash errors were its
  // refusals; plain one-command calls pass its checks the first time.
  // The guard also refuses commands that are not git (sed -i with heredocs, cd to computed
  // paths, CLI text naming git, terraform with a variable path): feedback items 9, 13, 24.
  test("Workflow says which forms pass the guard in a worktree-isolated session", () => {
    const workflow = section("Workflow");
    expect(workflow).toMatch(/In a worktree-isolated session, Claude Code refuses any Bash command, not only git, that it cannot verify stays in the worktree/);
    expect(workflow).toMatch(/Give each git command its own Bash call; use literal program paths and directories, without loops, variables, `\$\(…\)` or `cd` to a computed path/);
    expect(workflow).toMatch(/edit files with the Edit and Write tools, not `sed -i` or heredocs/);
    expect(workflow).toMatch(/pass long text that may mention git through MCP tools \(such as `task_add`\) or a file, not as a command-line argument or ssh script/);
    expect(workflow).toMatch(/do work on other checkouts from a session or delegate started there/);
    // Codex has no such guard, so its instructions leave the rule out.
    expect(read("codex/AGENTS.md")).not.toMatch(/worktree-isolated/);
  });
});

// The computer-use plugin (SETUP.md "Computer use"). Claude Code reserves the MCP server name
// computer-use and keeps it off in every project, so the plugin's server has another name.
describe("computer-use plugin", () => {
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  const settings = JSON.parse(read("claude/settings.json"));

  test("the dotfiles marketplace at the repo root lists it from its folder", () => {
    expect(marketplace.name).toBe("dotfiles");
    const entry = marketplace.plugins.find((plugin) => plugin.name === "computer-use");
    expect(entry.source).toBe("./claude/marketplace/computer-use");
    const manifest = JSON.parse(read("claude/marketplace/computer-use/.claude-plugin/plugin.json"));
    expect(manifest.name).toBe("computer-use");
    // Without a version Claude Code versions the plugin by commit, so each change reinstalls it.
    expect(manifest.version).toBeUndefined();
    expect(entry.version).toBeUndefined();
  });

  // Declared in the tracked settings, so no install command writes a machine path into them.
  test("the tracked settings fetch the marketplace from GitHub and enable the plugin", () => {
    const source = settings.extraKnownMarketplaces.dotfiles.source;
    expect(source).toEqual({ source: "github", repo: "syz51/dotfiles", sparsePaths: [".claude-plugin", "claude/marketplace"] });
    expect(settings.enabledPlugins["computer-use@dotfiles"]).toBe(true);
  });

  // GitHub marketplaces do not auto-update by default, so installed plugins stayed at old
  // commits after merges (dotfiles-281). This makes Claude Code refresh the marketplace and
  // update its installed plugins on its own.
  test("the tracked settings auto-update the dotfiles marketplace", () => {
    expect(settings.extraKnownMarketplaces.dotfiles.autoUpdate).toBe(true);
  });

  // No policy path from a checkout: agents edit tracked files and branch switches reset them.
  // The user's policy lives in the server's untracked state folder; the plugin's is the fallback.
  test("its only MCP server is desktop, run by bun from the plugin, with the auto policy bundled", () => {
    const servers = JSON.parse(read("claude/marketplace/computer-use/.mcp.json")).mcpServers;
    expect(Object.keys(servers)).toEqual(["desktop"]);
    expect(servers.desktop).toEqual({
      command: "${HOME}/.bun/bin/bun",
      args: ["${CLAUDE_PLUGIN_ROOT}/server/desktop.js"],
    });
    expect(JSON.parse(read("claude/marketplace/computer-use/policy.json"))).toEqual({ approval: "auto" });
  });

  test("its tests run in the verification suites and CI", () => {
    expect(read("SETUP.md")).toMatch(/^bun test .* claude\/marketplace$/m);
    expect(read(".github/workflows/checks.yml")).toMatch(/^\s+bun test .* claude\/marketplace$/m);
  });
});

// The fixed prompt every session re-reads (dotfiles-116). The Artifact tool's description is
// about 12k tokens. Turning it off (enableArtifact: false) is off in every layer, so no
// session could turn it back on; the lean-prompt plugin defers it behind ToolSearch instead,
// and a session that publishes a page loads it for itself.
describe("lean prompt", () => {
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  const settings = JSON.parse(read("claude/settings.json"));

  test("the lean-prompt plugin is listed from its folder and enabled", () => {
    const entry = marketplace.plugins.find((plugin) => plugin.name === "lean-prompt");
    expect(entry.source).toBe("./claude/marketplace/lean-prompt");
    const manifest = JSON.parse(read("claude/marketplace/lean-prompt/.claude-plugin/plugin.json"));
    expect(manifest.name).toBe("lean-prompt");
    expect(manifest.version).toBeUndefined();
    expect(JSON.parse(read("claude/marketplace/lean-prompt/hooks/hooks.json"))).toEqual({ modules: ["./register.ts"] });
    expect(settings.enabledPlugins["lean-prompt@dotfiles"]).toBe(true);
  });

  test("Artifact is deferred, not turned off, so a session can still opt in", () => {
    expect(settings.enableArtifact).toBeUndefined();
    expect(settings.disableArtifact).toBeUndefined();
    expect(settings.permissions.deny ?? []).not.toContain("Artifact");
    expect(section("Working preferences")).toMatch(/Artifact tool is hidden behind ToolSearch\. Load it for your own session with `select:Artifact` only when you must publish, read, open or update an artifact/);
    // A deferred tool is not in the tool list, so "when that tool is available" would skip it.
    expect(read("claude/skills/ui-climb/SKILL.md")).toContain("load that tool with ToolSearch `select:Artifact`");
  });

  // Skills with no skillUsage record in ~/.claude.json on 2026-11-08. A skill the model may
  // still need to load (a tool or the user asks for it) keeps its name in the listing; only
  // the two skills that just explain Claude Code to the user are hidden from the model. Their
  // slash commands stay typable. Overrides match any skill of that name, project ones too.
  test("unused skills are trimmed from the model's listing", () => {
    expect(settings.skillOverrides).toEqual({
      "artifact-capabilities": "name-only",
      "artifact-diagramming": "name-only",
      "workflow-authoring": "name-only",
      init: "name-only",
      loop: "name-only",
      run: "name-only",
      schedule: "name-only",
      "security-review": "name-only",
      simplify: "name-only",
      "update-config": "name-only",
      "fewer-permission-prompts": "user-invocable-only",
      "keybindings-help": "user-invocable-only",
    });
    // Skills these instructions or the Artifact tool tell agents to load stay listed.
    for (const name of ["work-stages", "headless-browser", "frontend-ui", "code-review", "artifact-design", "cheat-sheets"]) {
      expect(settings.skillOverrides[name]).toBeUndefined();
    }
  });
});

// On 2026-11-08 GitHub's release host returned 504 for about 48 minutes, and CI failed
// before any test ran. Retries cover short failures of the gitleaks download; the cache
// covers long ones. setup-uv uses the Astral mirror, and setup-bun caches Bun itself.
describe("CI release downloads", () => {
  const workflow = read(".github/workflows/checks.yml");
  const steps = Bun.YAML.parse(workflow).jobs.tests.steps;
  // A step by its name, or by its action for an unnamed one, such as "astral-sh/setup-uv".
  const step = (name) => steps.find((entry) => entry.name === name || entry.uses?.split("@")[0] === name);
  const fetch = step("Fetch and check gitleaks").run;
  const download = /^ *curl (?:[^\n]*\\\n)*[^\n]*\n/m.exec(fetch)?.[0] ?? "";
  const flag = (name) => Number(new RegExp(`--${name} (\\d+)`).exec(download)?.[1]);
  const key = "${{ steps.gitleaks.outputs.archive }}-${{ steps.gitleaks.outputs.checksum }}";

  test("the download retries every error within the job's timeout", () => {
    expect(download).toMatch(/releases\/download\/v[\d.]+\/\$archive"/);
    // A 504 can end curl with exit 56 over HTTP/2, which plain --retry does not retry.
    expect(download).toContain("--retry-all-errors");
    expect(flag("retry")).toBeGreaterThanOrEqual(5);
    expect(Bun.YAML.parse(workflow).jobs.tests["timeout-minutes"]).toBe(10);
    // curl checks --retry-max-time before it waits --retry-delay, and the last attempt
    // runs up to --max-time, which leaves the tests at least 6 of the job's 10 minutes.
    expect(flag("retry-max-time") + flag("retry-delay") + flag("max-time")).toBeLessThanOrEqual(240);
  });

  test("a pinned cache keyed by archive and checksum skips the download", () => {
    const restore = step("Restore the gitleaks archive");
    const save = step("Save the gitleaks archive");
    expect(restore.uses).toMatch(/^actions\/cache\/restore@[0-9a-f]{40}$/);
    expect(save.uses).toMatch(/^actions\/cache\/save@[0-9a-f]{40}$/);
    expect(restore.with).toEqual({ path: "${{ steps.gitleaks.outputs.cache }}", key });
    expect(save.with).toEqual(restore.with);
    expect(save.if).toBe(`steps.${restore.id}.outputs.cache-hit != 'true'`);
    // A failing cache service falls through to the download instead of failing the job.
    for (const entry of [restore, save]) expect(entry["continue-on-error"]).toBe(true);
    expect(step("Fetch and check gitleaks").env.cache).toBe(restore.with.path);
    expect(fetch).toMatch(/^if \[ -f "\$cache\/\$archive" \]; then$/m);
  });

  test("the checksum check runs on a downloaded or cached archive before extraction and saving", () => {
    const end = fetch.search(/^fi$/m);
    const check = fetch.indexOf(`(cd "$cache" && printf '%s  %s\\n' "$checksum" "$archive" | shasum -a 256 --check)`);
    const extract = fetch.indexOf(`tar -xzf "$cache/$archive" -C "$bin" gitleaks`);
    expect(download).not.toBe("");
    expect(fetch.indexOf(download)).toBeLessThan(end);
    // The check follows the if's closing fi, so both the hit and the miss reach it.
    expect(end).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(end);
    expect(extract).toBeGreaterThan(check);
    const names = steps.map((entry) => entry.name);
    expect(names.indexOf("Save the gitleaks archive")).toBe(names.indexOf("Fetch and check gitleaks") + 1);
    expect(names.indexOf("Scan history and run isolated tests")).toBeGreaterThan(names.indexOf("Save the gitleaks archive"));
  });

  // setup-uv v10.3.2 added the known checksums for uv 0.13.5; v10 downloads from the
  // Astral mirror and falls back to GitHub's release host.
  test("setup-uv is the mirror release and keeps uv pinned", () => {
    const setup = step("astral-sh/setup-uv");
    expect(setup.uses).toBe("astral-sh/setup-uv@68559e99cc807c1eb7e9238fd43a15bba460eec2");
    expect(workflow).toContain("- uses: astral-sh/setup-uv@68559e99cc807c1eb7e9238fd43a15bba460eec2 # v10.3.3\n");
    expect(setup.with).toEqual({ version: "0.13.5", "enable-cache": false });
  });

  test("setup-bun keeps its Bun cache on a pinned version, and a slow cache cannot stall the job", () => {
    const bun = step("oven-sh/setup-bun");
    // A pinned version turns on setup-bun's own cache of the Bun binary.
    expect(bun.with).toEqual({ "bun-version": "1.4.4" });
    expect(bun.env).toEqual({ SEGMENT_DOWNLOAD_TIMEOUT_MINS: 1 });
    expect(bun["timeout-minutes"]).toBe(3);
  });
});

// Since 2026-11-08 the user allows only Opus or Haiku models. Pricing keeps the other rows
// to price past sessions; tests may name any model as data. Installed packages, such as the
// headless-browser skill's Playwright, are not ours to change, so the scan skips node_modules.
describe("models", () => {
  const exempt = /(?:^|\/)node_modules\/|\.test\.js$|\/testing\/|\/bench\/cases\/|factory\/lib\/pricing\.js$|factory\/PLAN\.md$/;

  test("no default, agent or skill template selects Sonnet or Fable", () => {
    const glob = new Bun.Glob("claude/{factory,agents,skills,bin,hooks}/**/*.{js,md,json,toml}");
    const offenders = [...glob.scanSync({ cwd: REPO })].filter((path) =>
      !exempt.test(path) && /\b(?:claude-)?(?:sonnet|fable)\b/i.test(read(path)));
    expect(offenders).toEqual([]);
  });

  test("the scan skips installed packages but not our own files", () => {
    expect(exempt.test("claude/skills/headless-browser/node_modules/playwright/lib/agents/playwright-test-planner.agent.md")).toBe(true);
    expect(exempt.test("claude/skills/headless-browser/SKILL.md")).toBe(false);
    expect(exempt.test("claude/factory/ui/node_modules_notes.md")).toBe(false);
  });
});
