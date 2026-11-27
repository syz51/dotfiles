import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeWakeups,
  canonicalPrKey,
  checkStopWakeup,
  detectWakeupClaim,
  stripNonClaimText,
} from "./guard-wakeup.js";

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

test("detectWakeupClaim ignores user waits (including leading articles), third-party automation, quoted text, code blocks, and Open items", () => {
  for (const msg of [
    "Waiting for your approval before merging.",
    "Waiting on an approval before merging.",
    "Waiting for the confirmation before deploying.",
    "I'll merge once the approval arrives.",
    "Once a confirmation arrives, I'll proceed.",
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

test("canonicalPrKey normalizes URL and repository+number to the same key", () => {
  expect(canonicalPrKey("https://github.com/O/R/pull/12")).toBe("o/r#12");
  expect(canonicalPrKey({ url: '"https://github.com/o/r/pull/12/"' })).toBe("o/r#12");
  expect(canonicalPrKey({ repository: '"O/R"', number: "12" })).toBe("o/r#12");
});

test("stripNonClaimText preserves contractions while stripping quotes and code", () => {
  const cleaned = stripNonClaimText('I\'ll check back in 4 minutes, not "Checking back in 10 minutes".');
  expect(cleaned).toContain("I'll check back in 4 minutes");
  expect(cleaned).not.toContain("10 minutes");
});

test("replays the exact Antigravity incident (steps 447-486): passes active timers/watches, blocks dropped 3rd timer", () => {
  const prWatchTurn = [
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "mcp_t3-code_watch_pull_request", args: { url: '"https://github.com/syz51/agent-board/pull/308"', until: '"merged"' } }] },
    { type: "GENERIC", status: "DONE", content: '{"watching":true,"url":"https://github.com/syz51/agent-board/pull/308"}' },
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

test("PR watch handles URL/repo+num equivalence, multiple watched PRs, and failed watch calls", () => {
  // Watch by repo+num, watch second PR by URL, merge first PR -> second PR watch MUST survive!
  const twoWatches = [
    { type: "PLANNER_RESPONSE", tool_calls: [
      { name: "mcp_t3-code_watch_pull_request", args: { repository: '"o/r"', number: "12" } },
      { name: "mcp_t3-code_watch_pull_request", args: { url: '"https://github.com/o/r/pull/13"' } },
    ] },
    { type: "GENERIC", status: "DONE", content: '{"watching":true,"repository":"o/r","number":12}' },
    { type: "GENERIC", status: "DONE", content: '{"watching":true,"url":"https://github.com/o/r/pull/13"}' },
    { type: "USER_INPUT", content: "Pull request #12 (https://github.com/o/r/pull/12) was merged, so T3 Code stopped watching it." },
  ];
  withTranscript(twoWatches, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: true, readable: true });
    expect(checkStopWakeup({ last_assistant_message: "Watching PR #13 until it merges.", transcript_path: tp }).block).toBe(false);
  });

  // Watch by URL, unwatch by repo+num -> watch is cleared
  const crossFormUnwatch = [
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "mcp_t3-code_watch_pull_request", args: { url: '"https://github.com/o/r/pull/12"' } }] },
    { type: "GENERIC", status: "DONE", content: '{"watching":true}' },
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "mcp_t3-code_unwatch_pull_request", args: { repository: '"o/r"', number: "12" } }] },
    { type: "GENERIC", status: "DONE", content: '{"watching":false}' },
  ];
  withTranscript(crossFormUnwatch, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: false, readable: true });
  });

  // Failed watch_pull_request must NOT poison activePrWatches
  const failedWatch = [
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "mcp_t3-code_watch_pull_request", args: {} }] },
    { type: "GENERIC", status: "ERROR", content: "Error: missing repository" },
  ];
  withTranscript(failedWatch, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: false, readable: true });
    expect(checkStopWakeup({ last_assistant_message: "Watching PR #12 until it merges.", transcript_path: tp }).block).toBe(true);
  });
});

test("daemon run_command (IsDaemon: true) does not count as an active wakeup, and sibling same-turn async survives kills/unwatches", () => {
  const daemonServer = [
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: '"bun run dev"', IsDaemon: "true", WaitMsBeforeAsync: "500" } }] },
    { type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: conv/task-dev" },
  ];
  withTranscript(daemonServer, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: false, readable: true });
    expect(checkStopWakeup({ last_assistant_message: "Checking back in 4 minutes.", transcript_path: tp }).block).toBe(true);
  });

  // Same-turn delegate_task + unwatch of finished PR -> delegate stays active
  const delegatePlusUnwatch = [
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "mcp_t3-code_watch_pull_request", args: { url: '"https://github.com/o/r/pull/1"' } }] },
    { type: "GENERIC", status: "DONE", content: '{"watching":true}' },
    { type: "USER_INPUT", content: "PR merged, delegate next step" },
    { type: "PLANNER_RESPONSE", tool_calls: [
      { name: "mcp_t3-code_delegate_task", args: { task: '"do work"', mode: '"async"' } },
      { name: "mcp_t3-code_unwatch_pull_request", args: { url: '"https://github.com/o/r/pull/1"' } },
    ] },
    { type: "GENERIC", status: "DONE", content: '{"taskId":"t-1"}' },
    { type: "GENERIC", status: "DONE", content: '{"watching":false}' },
  ];
  withTranscript(delegatePlusUnwatch, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: true, readable: true });
    expect(checkStopWakeup({ last_assistant_message: "I'll resume once the delegated task finishes.", transcript_path: tp }).block).toBe(false);
  });
});

test("clears multiple senders in one SYSTEM_MESSAGE and preserves pending tool results on mid-turn notifications", () => {
  const multiSender = [
    { type: "PLANNER_RESPONSE", tool_calls: [
      { name: "schedule", args: { DurationSeconds: "60", Prompt: '"A"' } },
      { name: "schedule", args: { DurationSeconds: "60", Prompt: '"B"' } },
    ] },
    { type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: conv/task-1\nTask Description: Timer: 1m" },
    { type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: conv/task-2\nTask Description: Timer: 1m" },
    { type: "SYSTEM_MESSAGE", content: "[Message] timestamp=t1 sender=conv/task-1 content=A\n[Message] timestamp=t2 sender=conv/task-2 content=B" },
  ];
  withTranscript(multiSender, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: false, readable: true });
  });

  // Mid-turn notification while delegate_task + invoke_subagent are running must not drop pendingAgyCalls
  const midTurnNotif = [
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: "60", Prompt: '"old"' } }] },
    { type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: conv/task-old\nTask Description: Timer: 1m" },
    { type: "USER_INPUT", content: "start reviewer" },
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "invoke_subagent", args: { Role: '"Reviewer"' } }] },
    { type: "SYSTEM_MESSAGE", content: "[Message] timestamp=t1 sender=conv/task-old content=old" },
    { type: "GENERIC", status: "DONE", content: 'Created the following subagent:\n{"conversationId": "sub-99"}' },
  ];
  withTranscript(midTurnNotif, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: true, readable: true });
  });
});

test("supports Claude Code JSONL transcripts: errors, injected reminders, system wakeup resets, and same-turn unwatch", () => {
  // Failed ScheduleWakeup (is_error: true) must NOT count as active
  const claudeError = [
    { type: "user", message: { role: "user", content: "Watch the deploy" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ScheduleWakeup", input: { delaySeconds: 180 } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "denied" }] } },
  ];
  withTranscript(claudeError, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: false, readable: true });
    expect(runHook({ last_assistant_message: "Checking back in 3 minutes.", transcript_path: tp }).code).toBe(2);
  });

  // Injected <system-reminder> mid-turn must NOT clear ScheduleWakeup
  const claudeInjected = [
    { type: "user", message: { role: "user", content: "Watch the deploy" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ScheduleWakeup", input: { delaySeconds: 180 } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "scheduled" }] } },
    { type: "user", message: { role: "user", content: "<system-reminder>Keep responses concise.</system-reminder>" } },
  ];
  withTranscript(claudeInjected, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: true, hasAsync: true, readable: true });
  });

  // System wakeup prompt (promptSource: "system") MUST reset prior turn's ScheduleWakeup
  const claudeWakeupTurn = [
    ...claudeInjected,
    { type: "user", promptSource: "system", message: { role: "user", content: "Wakeup fired: recheck deploy" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "gh run view 1" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "in_progress" }] } },
  ];
  withTranscript(claudeWakeupTurn, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: false, readable: true });
    expect(runHook({ last_assistant_message: "Checking back in 4 minutes.", transcript_path: tp }).code).toBe(2);
  });

  // Claude same-turn watch + unwatch clears activePrWatches cleanly
  const claudeUnwatch = [
    { type: "user", message: { role: "user", content: "Check PR" } },
    { type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "w1", name: "mcp__t3-code__watch_pull_request", input: { url: "https://github.com/o/r/pull/5" } },
      { type: "tool_use", id: "w2", name: "mcp__t3-code__unwatch_pull_request", input: { repository: "o/r", number: 5 } },
    ] } },
    { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "w1", content: '{"watching":true}' },
      { type: "tool_result", tool_use_id: "w2", content: '{"watching":false}' },
    ] } },
  ];
  withTranscript(claudeUnwatch, (tp) => {
    expect(activeWakeups(tp)).toEqual({ hasTimer: false, hasAsync: false, readable: true });
  });

  // Claude background Agent (succeeded)
  const claudeWithBgAgent = [
    { type: "user", message: { role: "user", content: "Review it" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { run_in_background: true } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "launched" }] } },
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
