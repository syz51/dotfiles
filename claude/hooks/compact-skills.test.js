import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { output, REMINDER } from "./compact-skills.js";

const HOOK = join(import.meta.dir, "compact-skills.js");
const ENV = process.env;

function run(input) {
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8", env: ENV });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("compact-skills hook", () => {
  test("adds the one-line skill reminder for SessionStart source compact", () => {
    expect(REMINDER).toBe("skills loaded before the compaction still apply; invoke the skill again before the next step it covers");
    expect(REMINDER).not.toContain("\n");
    const out = output({ hook_event_name: "SessionStart", source: "compact", cwd: "/repo" });
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: REMINDER,
      },
    });
  });

  test("adds nothing for startup, resume, clear, or missing/unknown source", () => {
    for (const source of ["startup", "resume", "clear", "", "other", undefined]) {
      expect(output({ hook_event_name: "SessionStart", source, cwd: "/repo" }), String(source)).toBeUndefined();
    }
    expect(output(null)).toBeUndefined();
  });

  test("adds nothing for non-SessionStart hook events even when source is compact", () => {
    for (const event of ["PreToolUse", "PostToolUse", "SubagentStart", "PreCompact", "Stop"]) {
      expect(output({ hook_event_name: event, source: "compact", cwd: "/repo" }), event).toBeUndefined();
    }
  });

  test("as a command it emits SessionStart additionalContext only for source compact", () => {
    const compactOut = JSON.parse(run({ hook_event_name: "SessionStart", source: "compact", cwd: "/repo" }));
    expect(compactOut).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: REMINDER,
      },
    });
    for (const source of ["startup", "resume", "clear"]) {
      expect(run({ hook_event_name: "SessionStart", source, cwd: "/repo" }), source).toBe("");
    }
  });

  test("invalid JSON input fails without blocking", () => {
    const bad = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8", env: ENV });
    // Exit 2 would block; exit 1 is a non-blocking hook error.
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/JSON/);
  });
});
