import { test, expect } from "bun:test";
import {
  parseEvents,
  injected,
  owned,
  delegated,
  currentTurnCompleted,
  successfulCommand,
  finalAnswer,
  checkFiles,
  commandWords,
  ownedRoots,
} from "./lib/evidence.js";
const event = { type: "turn.completed" };
test("owned cleanup expands transitive fixture lineage and preserves unlinked sessions", () => {
  const meta = (id, parent, cwd = "/fixture") => ({
    records: [
      {
        type: "session_meta",
        payload: {
          id,
          cwd,
          source: parent
            ? { subagent: { thread_spawn: { parent_thread_id: parent } } }
            : "cli",
        },
      },
    ],
  });
  const entries = [
    meta("grandchild", "child"),
    meta("child", "root"),
    meta("root"),
    meta("orphan", "other"),
    meta("wrong-cwd", "root", "/unrelated"),
  ];
  expect([...ownedRoots(entries, "/fixture", "root")].sort()).toEqual([
    "child",
    "grandchild",
    "root",
  ]);
});
test("current settings, start and completion must identify the same latest child turn", () => {
  const event = (type, turn_id) => ({
    type: "event_msg",
    payload: { type, turn_id },
  });
  const context = (turn_id) => ({
    type: "turn_context",
    payload: { turn_id, model: "gpt-6.1-terra", effort: "medium" },
  });
  const meta = {
    type: "session_meta",
    payload: {
      agent_role: "explorer",
      source: { subagent: { thread_spawn: { parent_thread_id: "p" } } },
    },
  };
  const parent = [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        arguments: '{"agent_type":"explorer"}',
      },
    },
  ];
  const historical = [
    meta,
    context("old"),
    event("task_started", "old"),
    event("task_complete", "old"),
  ];
  const bad = [
    [...historical, context("new")],
    [...historical, context("new"), event("task_started", "new")],
    [
      ...historical,
      context("new"),
      event("task_started", "other"),
      event("task_complete", "new"),
    ],
    [
      ...historical,
      context(undefined),
      event("task_started", "new"),
      event("task_complete", "new"),
    ],
    [
      ...historical,
      context("new"),
      event("task_started", "new"),
      event("task_complete", "old"),
    ],
    [
      ...historical,
      event("task_started", "new"),
      event("task_complete", "new"),
      context("new"),
    ],
  ];
  for (const records of bad) {
    expect(currentTurnCompleted(records)).toBe(false);
    expect(
      delegated(parent, [records], "explorer", "gpt-6.1-terra", "medium", "p"),
    ).toBe(false);
  }
  for (const middle of [
    [context("new"), event("task_started", "new")],
    [event("task_started", "new"), context("new")],
  ]) {
    const records = [...historical, ...middle, event("task_complete", "new")];
    expect(currentTurnCompleted(records)).toBe(true);
    expect(
      delegated(parent, [records], "explorer", "gpt-6.1-terra", "medium", "p"),
    ).toBe(true);
  }
});
test("current failures cannot hide before or between start and context markers", () => {
  const event = (type, turn_id) => ({
    type: "event_msg",
    payload: { type, turn_id },
  });
  const context = { type: "turn_context", payload: { turn_id: "new" } };
  const start = event("task_started", "new");
  const complete = event("task_complete", "new");
  for (const kind of [
    "turn_aborted",
    "task_failed",
    "task_cancelled",
    "error",
  ]) {
    for (const middle of [
      [event(kind, "new"), context, start],
      [context, event(kind, "new"), start],
      [start, event(kind, "new"), context],
      [start, event(kind, undefined), context],
    ]) {
      expect(currentTurnCompleted([...middle, complete])).toBe(false);
    }
  }
  expect(
    currentTurnCompleted([
      event("error", "old"),
      event("error", undefined),
      context,
      start,
      complete,
    ]),
  ).toBe(true);
});
test("delegation completion belongs to the latest child turn, not inherited history", () => {
  const record = (type, turn_id) => ({
    type: "event_msg",
    payload: { type, turn_id },
  });
  const parent = [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        arguments: '{"agent_type":"explorer"}',
      },
    },
  ];
  const context = [
    {
      type: "session_meta",
      payload: {
        agent_role: "explorer",
        source: { subagent: { thread_spawn: { parent_thread_id: "root" } } },
      },
    },
    {
      type: "turn_context",
      payload: { turn_id: "current", model: "gpt-6.1-terra", effort: "medium" },
    },
  ];
  for (const historical of ["inherited-parent", "prior-child"]) {
    const records = [
      ...context,
      record("task_started", historical),
      record("task_complete", historical),
      record("task_started", "current"),
    ];
    expect(
      delegated(
        parent,
        [records],
        "explorer",
        "gpt-6.1-terra",
        "medium",
        "root",
      ),
    ).toBe(false);
    expect(
      currentTurnCompleted([...records, record("task_complete", historical)]),
    ).toBe(false);
    expect(
      currentTurnCompleted([...records, record("task_complete", "current")]),
    ).toBe(true);
    expect(
      currentTurnCompleted([
        ...records,
        record("turn_aborted", "current"),
        record("task_complete", "current"),
      ]),
    ).toBe(false);
  }
  expect(
    currentTurnCompleted([
      record("task_complete", "current"),
      record("task_started", "current"),
    ]),
  ).toBe(false);
  expect(
    currentTurnCompleted([
      record("task_started", undefined),
      record("task_complete", undefined),
    ]),
  ).toBe(false);
});
test("completion evidence rejects empty, malformed, truncated and failed traces", () => {
  for (const s of [
    "",
    "{",
    '{"type":"turn.started"}',
    '{"type":"turn.failed"}\n' + JSON.stringify(event),
    '{"type":"error"}\n' + JSON.stringify(event),
  ])
    expect(() => parseEvents(s)).toThrow();
  expect(parseEvents(JSON.stringify(event))).toEqual([event]);
});
test("instruction claims and outputs are not injection proof", () => {
  const message = (role) => ({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ text: "# User defaults\nA real policy" }],
    },
  });
  expect(injected([message("assistant")], "A real policy")).toBe(false);
  expect(
    injected(
      [
        {
          type: "response_item",
          payload: { type: "function_call_output", output: "A real policy" },
        },
      ],
      "A real policy",
    ),
  ).toBe(false);
  expect(injected([message("user")], "A real policy")).toBe(true);
  expect(injected([message("user")], "Different policy")).toBe(false);
});
test("cleanup ownership requires metadata cwd and parent lineage", () => {
  const r = [{ type: "session_meta", payload: { id: "p", cwd: "/fixture" } }];
  expect(owned(r, "/other")).toBe(false);
  expect(owned(r, "/fixture", "other")).toBe(false);
  expect(owned(r, "/fixture", "p")).toBe(true);
  expect(
    owned(
      [{ type: "message", payload: { id: "p", cwd: "/fixture" } }],
      "/fixture",
    ),
  ).toBe(false);
});
test("delegation requires actual spawn and linked configured child", () => {
  const p = [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        arguments: '{"agent_type":"explorer"}',
      },
    },
  ];
  const c = [
    {
      type: "session_meta",
      payload: {
        agent_role: "explorer",
        source: { subagent: { thread_spawn: { parent_thread_id: "p" } } },
      },
    },
    {
      type: "turn_context",
      payload: {
        turn_id: "child-current",
        model: "gpt-6.1-terra",
        effort: "medium",
      },
    },
    {
      type: "event_msg",
      payload: { type: "task_started", turn_id: "child-current" },
    },
    {
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "child-current" },
    },
  ];
  expect(delegated(p, [c], "explorer", "gpt-6.1-terra", "medium", "p")).toBe(
    true,
  );
  for (const args of [
    [[], [c], "p"],
    [p, [], "p"],
    [p, [c], "other"],
  ])
    expect(
      delegated(
        args[0],
        args[1],
        "explorer",
        "gpt-6.1-terra",
        "medium",
        args[2],
      ),
    ).toBe(false);
  expect(delegated(p, [c], "explorer", "wrong", "medium", "p")).toBe(false);
});
test("successful checks require completed zero-exit tool events", () => {
  const e = {
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "uv run python check.py",
      exit_code: 0,
      aggregated_output: "fixture-check:ok\n",
    },
  };
  expect(successfulCommand([e], { tool: "uv", script: "check.py" })).toBe(true);
  for (const x of [
    { ...e, type: "item.started" },
    { ...e, item: { ...e.item, exit_code: 1 } },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "uv run passed" },
    },
  ])
    expect(successfulCommand([x], { tool: "uv", script: "check.py" })).toBe(
      false,
    );
});
test("fixture inventory catches unauthorized new, deleted and changed files", () => {
  for (const after of [{}, { a: "x", b: "y" }, { a: "changed" }])
    expect(() => checkFiles({ a: "x" }, after)).toThrow();
  expect(() => checkFiles({ a: "x" }, { a: "changed" }, ["a"])).not.toThrow();
});
test("missing final answers fail closed", () => {
  expect(() => finalAnswer([event])).toThrow();
  expect(
    finalAnswer([
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
    ]),
  ).toBe("done");
});

test("safe uv environment controls preserve check attribution without trusting arbitrary assignments", () => {
  const event = (command) => ({
    type: "item.completed",
    item: {
      type: "command_execution",
      exit_code: 0,
      command,
      aggregated_output: "fixture-check:ok\n",
    },
  });
  const contract = { tool: "uv", script: "check.py" };
  expect(
    successfulCommand(
      [
        event(
          "/bin/zsh -lc 'UV_OFFLINE=1 UV_NO_CACHE=1 UV_PYTHON_DOWNLOADS=never uv run --no-project --no-managed-python python -B check.py'",
        ),
      ],
      contract,
    ),
  ).toBe(true);
  for (const command of [
    "PATH=/evil uv run python check.py",
    "PYTHONPATH=/evil uv run python check.py",
    "UV_PROJECT=/other uv run python check.py",
    "UV_OFFLINE=1 echo uv run python check.py",
    "UV_OFFLINE=1 uv run python -c 'print(42)'",
    "UV_OFFLINE=1 uv run python other.py",
  ]) {
    expect(successfulCommand([event(command)], contract)).toBe(false);
  }
});
test("printed and compound commands cannot prove a check invocation", () => {
  const event = (command) => ({
    type: "item.completed",
    item: {
      type: "command_execution",
      exit_code: 0,
      command,
      aggregated_output: "fixture-check:ok\n",
    },
  });
  const contract = { tool: "uv", script: "check.py" };
  for (const command of [
    "echo 'uv run python check.py'",
    "true # uv run python check.py",
    "printf 'uv run python check.py'",
    "uv run python check.py; true",
    "false; uv run python check.py",
    "uv run python check.py && echo ok",
    "bash -c 'echo uv run python check.py'",
    "uv run python other.py",
    "'uv run python check.py",
  ])
    expect(successfulCommand([event(command)], contract)).toBe(false);
  expect(
    successfulCommand(
      [event("/bin/zsh -lc 'uv run --no-project python check.py'")],
      contract,
    ),
  ).toBe(true);
  expect(
    successfulCommand(
      [
        {
          ...event("uv run python check.py"),
          item: {
            ...event("").item,
            command: "uv run python check.py",
            aggregated_output: "",
          },
        },
      ],
      contract,
    ),
  ).toBe(false);
});
test("a started child and a claimed summary cannot establish completed delegation", () => {
  const p = [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        arguments: '{"agent_type":"explorer"}',
      },
    },
  ];
  const c = [
    {
      type: "session_meta",
      payload: {
        agent_role: "explorer",
        source: { subagent: { thread_spawn: { parent_thread_id: "p" } } },
      },
    },
    {
      type: "turn_context",
      payload: { model: "gpt-6.1-terra", effort: "medium" },
    },
  ];
  expect(delegated(p, [c], "explorer", "gpt-6.1-terra", "medium", "p")).toBe(
    false,
  );
  expect(
    delegated(
      [
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: "I spawned an explorer",
          },
        },
      ],
      [c],
      "explorer",
      "gpt-6.1-terra",
      "medium",
      "p",
    ),
  ).toBe(false);
});

test("parallel evidence requires real positive-duration overlapping child turns", async () => {
  const { overlappingTurns } = await import("./lib/evidence.js");
  const turn = (id, start, end) => [
    {
      timestamp: start,
      type: "event_msg",
      payload: { type: "task_started", turn_id: id },
    },
    {
      timestamp: end,
      type: "event_msg",
      payload: { type: "task_complete", turn_id: id },
    },
  ];
  const a = turn("a", "2026-10-31T10:00:00Z", "2026-10-31T10:00:10Z");
  expect(
    overlappingTurns([
      a,
      turn("b", "2026-10-31T10:00:05Z", "2026-10-31T10:00:15Z"),
    ]),
  ).toBe(true);
  expect(
    overlappingTurns([
      a,
      turn("b", "2026-10-31T10:00:10Z", "2026-10-31T10:00:15Z"),
    ]),
  ).toBe(false);
  expect(
    overlappingTurns([
      a,
      [{ type: "event_msg", payload: { type: "task_complete" } }],
    ]),
  ).toBe(false);
  expect(overlappingTurns([a, turn("b", "bad", "bad")])).toBe(false);
});
test("fallback guidance proof rejects mentions, failed reads and unrelated files", async () => {
  const { literalGuidanceRead } = await import("./lib/evidence.js");
  const e = (command) => ({
    type: "item.completed",
    item: {
      type: "command_execution",
      exit_code: 0,
      command,
      aggregated_output: "guide text\n",
    },
  });
  expect(literalGuidanceRead([e("cat /guide")], "/guide", "guide text\n")).toBe(
    true,
  );
  for (const command of ["echo /guide", "cat /other", "cat /guide; true"])
    expect(literalGuidanceRead([e(command)], "/guide", "guide text\n")).toBe(
      false,
    );
  expect(
    literalGuidanceRead(
      [{ ...e("cat /guide"), item: { ...e("cat /guide").item, exit_code: 1 } }],
      "/guide",
      "guide text\n",
    ),
  ).toBe(false);
});

test("actual offline uv Python check supports bounded non-mutating runtime flags", () => {
  const event = (command) => ({
    type: "item.completed",
    item: {
      type: "command_execution",
      exit_code: 0,
      command,
      aggregated_output: "fixture-check:ok\n",
    },
  });
  const command =
    "/bin/zsh -lc 'uv run --offline --no-project --no-cache --no-python-downloads python -B check.py'";
  expect(
    successfulCommand(
      [
        event(
          "/bin/zsh -lc 'PYTHONDONTWRITEBYTECODE=1 uv run --no-project --no-config --offline --no-cache check.py'",
        ),
      ],
      { tool: "uv", script: "check.py" },
    ),
  ).toBe(true);
  expect(
    successfulCommand([event(command)], { tool: "uv", script: "check.py" }),
  ).toBe(true);
  expect(
    successfulCommand([event("uv run --offline python3 -B ./check.py")], {
      tool: "uv",
      script: "check.py",
    }),
  ).toBe(true);
  for (const bad of [
    "uv run --unknown python check.py",
    "uv run python -c check.py",
    "uv run python -B other.py",
    "echo 'uv run --offline python -B check.py'",
  ])
    expect(
      successfulCommand([event(bad)], { tool: "uv", script: "check.py" }),
    ).toBe(false);
});
