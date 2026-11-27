import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeWakeups, checkStopWakeup, detectWakeupClaim, stripNonClaimText } from "./guard-wakeup.js";

const HOOK = join(import.meta.dir, "guard-wakeup.js");

function withTranscript(records, fn) {
  const dir = mkdtempSync(join(tmpdir(), "guard-wakeup-"));
  const transcriptPath = join(dir, "transcript.jsonl");
  try {
    writeFileSync(transcriptPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
    return fn(transcriptPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runHook(payload, env = {}) {
  const res = Bun.spawnSync([process.execPath, HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: { ...process.env, GUARD_WAKEUP: "", ...env },
  });
  return {
    code: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

test("detectWakeupClaim flags timed check-back promises", () => {
  for (const msg of [
    "`web`, `docker`, and `rust` all succeeded on `main`; the `image` publish job is now running. Checking back in 4 minutes to run `deploy/upgrade.sh`.",
    "I'll check back in 2 minutes once the build finishes.",
    "I will recheck in 90s.",
    "Rechecking in 3 minutes.",
    "Waking back up in 5m to verify deployment.",
    "Scheduled a 4-minute timer to check CI.",
  ]) {
    const claim = detectWakeupClaim(msg);
    expect(claim?.kind, msg).toBe("timer");
  }
});

test("detectWakeupClaim flags async self-wakeup promises", () => {
  for (const msg of [
    "Waiting on the main CI run (`45964634122`) to finish publishing the Docker image before running `deploy/upgrade.sh`.",
    "Auto-merge is enabled and watching [syz51/agent-board#308](https://github.com/syz51/agent-board/pull/308) until it merges.",
    "Once it merges, I'll deploy to `sai` and verify live.",
    "I'll resume once the diff-review subagent finishes.",
    "Watching PR #308 until checks pass.",
  ]) {
    const claim = detectWakeupClaim(msg);
    expect(claim?.kind, msg).toBe("async");
  }
});

test("detectWakeupClaim ignores user waits, third-party automation, quoted text, code blocks, and Open items", () => {
  for (const msg of [
    "Waiting for your approval before merging.",
    "Waiting on ask #200 before continuing.",
    "Once you confirm, I'll deploy the change.",
    "I'll proceed once your review lands.",
    "Once Pro wakes up and receives `53eabc0b` on the next upgrade, `dispatch:yizhemacbook-pro` will switch from `claude` to `antigravity` automatically.",
    "Auto-merge is enabled; GitHub will merge it once checks pass.",
    'The first two timers I scheduled (180s and 150s) both fired, but on the third turn I wrote "Checking back in 4 minutes" without calling `schedule`.',
    "```text\nChecking back in 4 minutes to run deploy/upgrade.sh.\n```",
    "> Checking back in 4 minutes to run deploy/upgrade.sh.",
    "All done.\n\nOpen items: `agent-board-816` (in progress, waiting on `image` job to finish before deploying).",
  ]) {
    expect(detectWakeupClaim(msg), msg).toBeNull();
  }
});

test("stripNonClaimText preserves contractions while stripping quotes and code", () => {
  const cleaned = stripNonClaimText('I\'ll check back in 4 minutes, not "Checking back in 10 minutes".');
  expect(cleaned).toContain("I'll check back in 4 minutes");
  expect(cleaned).not.toContain("10 minutes");
});

test("replays the exact Antigravity incident (steps 447-486): passes active timers/watches, blocks dropped 3rd timer", () => {
  const prWatchTurn = [
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "mcp_t3-code_watch_pull_request", args: { url: '"https://github.com/syz51/agent-board/pull/308"', until: '"merged"' } }] },
    { type: "GENERIC", status: "DONE", content: '{"watching":true}' },
    { type: "PLANNER_RESPONSE", content: "Auto-merge is enabled and watching [syz51/agent-board#308](https://github.com/syz51/agent-board/pull/308) until it merges. Once it merges, I'll deploy." },
  ];
  withTranscript(prWatchTurn, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: true, readable: true });
    expect(checkStopWakeup({ last_assistant_message: prWatchTurn.at(-1).content, transcript_path: tp }).block).toBe(false);
  });

  const firstTimerTurn = [
    ...prWatchTurn,
    { type: "USER_INPUT", content: "<USER_REQUEST>\nPull request #308 (https://github.com/syz51/agent-board/pull/308) was merged into main by syz51 as 53eabc0, so T3 Code stopped watching it.\n</USER_REQUEST>" },
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: "180", Prompt: '"Check CI"' } }] },
    { type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: conv/task-473\nTask Description: Timer: 3m" },
    { type: "SYSTEM_MESSAGE", content: "<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>" },
    { type: "PLANNER_RESPONSE", content: "Waiting on the main CI run to finish publishing the Docker image before running deploy/upgrade.sh." },
  ];
  withTranscript(firstTimerTurn, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: true, hasAsync: true, readable: true });
    expect(checkStopWakeup({ last_assistant_message: firstTimerTurn.at(-1).content, transcript_path: tp }).block).toBe(false);
  });

  const droppedThirdTimerTurn = [
    ...firstTimerTurn,
    { type: "SYSTEM_MESSAGE", content: "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-27T08:24:26Z sender=conv/task-473 priority=HIGH content=Check CI\n</SYSTEM_MESSAGE>" },
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: "150", Prompt: '"Check CI again"' } }] },
    { type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: conv/task-481\nTask Description: Timer: 2m 30s" },
    { type: "PLANNER_RESPONSE", content: "Waiting for the docker and image publish jobs to finish before deploying." },
    { type: "SYSTEM_MESSAGE", content: "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-27T08:27:20Z sender=conv/task-481 priority=HIGH content=Check CI again\n</SYSTEM_MESSAGE>" },
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: '"gh run view 45964634122"' } }] },
    { type: "GENERIC", status: "DONE", content: "Command exited with code 0." },
    { type: "PLANNER_RESPONSE", content: "`web`, `docker`, and `rust` all succeeded on `main`; the `image` publish job is now running. Checking back in 4 minutes to run `deploy/upgrade.sh`.\n\nOpen items: `agent-board-816`." },
  ];
  withTranscript(droppedThirdTimerTurn, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: false, readable: true });
    const res = checkStopWakeup({ last_assistant_message: droppedThirdTimerTurn.at(-1).content, transcript_path: tp });
    expect(res.block).toBe(true);
    expect(res.reason).toContain("Checking back in 4 minutes");
    expect(res.reason).toContain("guard-wakeup hook");
  });
});

test("PR watch persists across intermediate wake turns until unwatch or merge/close", () => {
  const afterCommentWake = [
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "mcp_t3-code_watch_pull_request", args: { url: '"https://github.com/o/r/pull/12"' } }] },
    { type: "GENERIC", status: "DONE", content: '{"watching":true}' },
    { type: "USER_INPUT", content: "New review comment on PR #12" },
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: '"git push"' } }] },
    { type: "GENERIC", status: "DONE", content: "ok" },
    { type: "PLANNER_RESPONSE", content: "Pushed the fix; waiting for required checks to pass before merging." },
  ];
  withTranscript(afterCommentWake, (tp) => {
    // Still watched, so async wait passes
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: true, readable: true });
    expect(checkStopWakeup({ last_assistant_message: afterCommentWake.at(-1).content, transcript_path: tp }).block).toBe(false);
    // But a timed check-back ("Checking back in 4 minutes") still requires a timer, not just a PR watch
    expect(checkStopWakeup({ last_assistant_message: "Checking back in 4 minutes.", transcript_path: tp }).block).toBe(true);
  });

  const afterUnwatch = [
    ...afterCommentWake,
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "mcp_t3-code_unwatch_pull_request", args: { url: '"https://github.com/o/r/pull/12"' } }] },
    { type: "GENERIC", status: "DONE", content: '{"watching":false}' },
  ];
  withTranscript(afterUnwatch, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: false, readable: true });
    expect(checkStopWakeup({ last_assistant_message: "Watching PR #12 until it merges.", transcript_path: tp }).block).toBe(true);
  });
});

test("tracks Antigravity subagents, recurring crons, and killed timers", () => {
  const activeSubagent = [
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "invoke_subagent", args: { Role: '"Reviewer"' } }] },
    { type: "GENERIC", status: "DONE", content: 'Created the following subagent:\n{"conversationId": "sub-123"}' },
  ];
  withTranscript(activeSubagent, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: true, readable: true });
    expect(checkStopWakeup({ last_assistant_message: "Waiting for the reviewer to finish before pushing.", transcript_path: tp }).block).toBe(false);
  });

  const killedSubagent = [
    ...activeSubagent,
    { type: "SYSTEM_MESSAGE", content: "[Message] timestamp=2026-11-27T08:00:00Z sender=sub-123 content=done" },
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "manage_subagents", args: { Action: '"kill"', ConversationIds: '["sub-123"]' } }] },
    { type: "GENERIC", status: "DONE", content: "killed" },
  ];
  withTranscript(killedSubagent, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: false, readable: true });
  });

  const recurringCron = [
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { CronExpression: '"*/5 * * * *"', Prompt: '"Poll"' } }] },
    { type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: conv/task-9\nTask Description: Cron: */5 * * * *" },
    { type: "SYSTEM_MESSAGE", content: "[Message] timestamp=2026-11-27T08:05:00Z sender=conv/task-9 content=Poll" },
  ];
  withTranscript(recurringCron, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: true, hasAsync: true, readable: true });
  });

  const killedTimer = [
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: "180", Prompt: '"Check"' } }] },
    { type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: conv/task-10\nTask Description: Timer: 3m" },
    { type: "USER_INPUT", content: "cancel it" },
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "manage_task", args: { Action: '"kill"', TaskId: '"conv/task-10"' } }] },
    { type: "GENERIC", status: "DONE", content: "killed" },
  ];
  withTranscript(killedTimer, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: false, readable: true });
  });
});

test("supports Claude Code JSONL transcripts (ScheduleWakeup, Monitor, watch_pull_request, background Bash/Agent)", () => {
  const claudeDropped = [
    { type: "user", message: { role: "user", content: "Watch the deploy" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh run view 1" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "in_progress" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Checking back in 3 minutes." }] } },
  ];
  withTranscript(claudeDropped, (tp) => {
    const res = runHook({ last_assistant_message: "Checking back in 3 minutes.", transcript_path: tp });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("guard-wakeup hook");
  });

  const claudeWithWakeup = [
    { type: "user", message: { role: "user", content: "Watch the deploy" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ScheduleWakeup", input: { delaySeconds: 180, prompt: "recheck" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "scheduled" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Checking back in 3 minutes." }] } },
  ];
  withTranscript(claudeWithWakeup, (tp) => {
    const res = runHook({ last_assistant_message: "Checking back in 3 minutes.", transcript_path: tp });
    expect(res.code).toBe(0);
  });

  const claudeWithBgAgent = [
    { type: "user", message: { role: "user", content: "Review it" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { run_in_background: true } }] } },
  ];
  withTranscript(claudeWithBgAgent, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: true, readable: true });
    expect(runHook({ last_assistant_message: "Waiting for the reviewer to finish before pushing.", transcript_path: tp }).code).toBe(0);
  });
});

test("once-only reminder (stop_hook_active=true), GUARD_WAKEUP=off, and missing transcript fail open", () => {
  const noWake = [
    { type: "USER_INPUT", content: "check CI" },
    { type: "PLANNER_RESPONSE", content: "Checking back in 4 minutes." },
  ];
  withTranscript(noWake, (tp) => {
    expect(runHook({ last_assistant_message: "Checking back in 4 minutes.", transcript_path: tp }).code).toBe(2);
    expect(runHook({ last_assistant_message: "Checking back in 4 minutes.", transcript_path: tp, stop_hook_active: true }).code).toBe(0);
    expect(runHook({ last_assistant_message: "Checking back in 4 minutes.", transcript_path: tp }, { GUARD_WAKEUP: "off" }).code).toBe(0);
  });
  expect(runHook({ last_assistant_message: "Checking back in 4 minutes.", transcript_path: "/nonexistent/transcript.jsonl" }).code).toBe(0);
});
