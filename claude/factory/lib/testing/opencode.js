// Synthetic V2 API projections only. Never copy private service responses into fixtures.
export const openCodeTokens = (input = 100, output = 20) => ({ input, output, reasoning: 10, cache: { read: 30, write: 5 } });
export const openCodeInfo = (id, { start = Date.parse("2026-11-01T10:00:00Z"), parentID, ...overrides } = {}) => ({
  id, ...(parentID ? { parentID } : {}), projectID: "project-test", agent: parentID ? "worker" : "build",
  cost: 999, tokens: openCodeTokens(), time: { created: start, updated: start + 60_000, idle: start + 60_000 },
  location: { directory: "/Users/test/project" }, ...overrides,
});
export const openCodeMessage = (id, type, at, fields = {}) => ({ id, type, time: { created: at },
  ...(["user", "synthetic"].includes(type) ? { text: "Check the fixture" } : {}),
  ...(type === "assistant" ? { agent: "build", model: { providerID: "opencode", id: "test-model", variant: "high" },
    content: [], tokens: openCodeTokens(), cost: 0.25, finish: "stop", time: { created: at, completed: at + 1 } } : {}),
  ...(type === "idle" ? { outcome: "succeeded" } : {}), ...fields,
});
export const openCodeTool = (id, { name = "board_board_task_claim", ok = false, output = "claim refused", command, at = Date.parse("2026-11-01T10:00:00Z") } = {}) => ({
  type: "tool", id, name, time: { created: at, completed: at + 1 },
  state: { status: ok ? "completed" : "error", input: command ? { command } : { id: "test-1" },
    ...(ok ? {} : { error: { type: "ToolError", message: output } }), content: [{ type: "text", text: output }] },
});

// { info, messages } entries, paged by an opaque fixture cursor. Used in-process and by
// fake-opencode.js so integration tests exercise the CLI discovery/auth delegation too.
export function openCodeApiFixture(entries = [], { pageSize = 100 } = {}) {
  return async (path) => {
    const url = new URL(path, "http://fixture.invalid");
    const id = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname)?.[1];
    const items = url.pathname === "/api/session" ? entries.map((entry) => entry.info)
      : id ? entries.find((entry) => entry.info.id === decodeURIComponent(id))?.messages : undefined;
    if (!items) throw new Error("Unexpected fixture API read");
    const sorted = [...items].sort((a, b) => a.time.created - b.time.created);
    const offset = Number(url.searchParams.get("cursor")?.replace("fixture-", "") ?? 0);
    return { data: sorted.slice(offset, offset + pageSize), cursor: { previous: null, next: offset + pageSize < sorted.length ? `fixture-${offset + pageSize}` : null } };
  };
}
