import { describe, expect, test } from "bun:test";
import { loadOpenCodeData, loadOpenCodeSessions, normalizeOpenCodeUsage, openCodeApi, openCodeCall } from "./opencode.js";
import { openCodeApiFixture, openCodeInfo, openCodeMessage as message, openCodeTokens, openCodeTool } from "./testing/opencode.js";
import { costKnown, windowStats } from "../metrics/stats.js";
import { countCorrections } from "../metrics/corrections.js";
import { sessionPrs, sessionPushes } from "../metrics/prs.js";
import { openCodeTurns } from "../friction/turns.js";

const START = Date.parse("2026-11-01T10:00:00Z");
const info = (id, options) => openCodeInfo(id, { start: START, ...options });
const msg = (id, type, offset = 0, fields) => message(id, type, START + offset, fields);
const entry = (session) => ({ session, prompts: session.prompts, prs: sessionPrs(session), pushes: sessionPushes(session), corrections: countCorrections(session.prompts) });

describe("OpenCode read-only adapter", () => {
  test("follows opaque session/message cursors, deduplicates shared history and groups nested descendants exactly once", async () => {
    const inherited = [msg("prompt", "user"), msg("reply", "assistant", 1)];
    const entries = [
      { info: info("root"), messages: inherited },
      { info: info("child", { parentID: "root" }), messages: [...inherited, msg("child-prompt", "user", 2), msg("child-reply", "assistant", 3, { cost: 0.5 })] },
      { info: info("grandchild", { parentID: "child" }), messages: [...inherited, msg("grandchild-reply", "assistant", 4, { cost: 0.75 })] },
    ];
    const paths = [];
    const fixture = openCodeApiFixture(entries, { pageSize: 1 });
    const sessions = await loadOpenCodeSessions({ api: (path) => { paths.push(path); return fixture(path); } });
    expect(sessions).toHaveLength(1);
    const [session] = sessions;
    expect(session).toMatchObject({ harness: "opencode", costSource: "api", costUSD: 1.5, ownCostUSD: 0.25, descendantCostUSD: 1.25, assistantMessages: 1 });
    expect(session.subagents.map((agent) => [agent.id, agent.costUSD, agent.assistantMessages])).toEqual([["child", 0.5, 1], ["grandchild", 0.75, 1]]);
    expect(session.subagents[1].parentAgentId).toBe("child");
    expect(session.prompts).toHaveLength(1);
    expect(paths.some((path) => path.includes("cursor=fixture-"))).toBe(true);
    expect(paths.filter((path) => path.includes("cursor=")).every((path) => !path.includes("order="))).toBe(true);
    const stats = windowStats([entry(session)], null);
    expect(stats.harness.opencode).toEqual({ sessions: 1, costUSD: 1.5, tokens: 3 * 155, subagentRuns: 2, unpricedSessions: 0 });
    expect(stats.modelMix.reduce((sum, row) => sum + row.costUSD, 0)).toBe(1.5);
  });

  test("a recent child brings in its old root and siblings; orphan children remain agent-launched roots", async () => {
    const old = START - 10_000;
    const sessions = await loadOpenCodeSessions({ since: START, api: openCodeApiFixture([
      { info: info("root", { start: old, time: { created: old, updated: old } }), messages: [message("old", "assistant", old)] },
      { info: info("sibling", { start: old, parentID: "root", time: { created: old, updated: old } }), messages: [message("sibling", "assistant", old)] },
      { info: info("new", { parentID: "root" }), messages: [msg("new", "assistant", 2)] },
      { info: info("orphan", { parentID: "gone" }), messages: [msg("orphan", "assistant", 3)] },
    ]) });
    expect(sessions).toHaveLength(2);
    expect(sessions.find((session) => session.id === "root")).toMatchObject({ costUSD: 0.75, subagents: [{ id: "sibling" }, { id: "new" }] });
    expect(sessions.find((session) => session.id === "orphan").origin).toBe("agent");
  });

  test("overlapping message pages keep the last projection once and preserve timeline order at equal times", async () => {
    const fixtureInfo = info("root");
    const data = await loadOpenCodeData({ api: async (path) => {
      if (path.startsWith("/api/session?")) return { data: [fixtureInfo], cursor: {} };
      return path.includes("cursor=")
        ? { data: [msg("z-assistant", "assistant", 1, { cost: 0.5 }), msg("a-idle", "idle", 1)], cursor: {} }
        : { data: [msg("user", "user"), msg("z-assistant", "assistant", 1)], cursor: { next: "opaque-next" } };
    } });
    expect(data[0].messages.map((message) => message.id)).toEqual(["user", "z-assistant", "a-idle"]);
    expect(openCodeTurns(data[0]).turns[0].complete).toBe(true);
    const [session] = await loadOpenCodeSessions({ api: openCodeApiFixture(data) });
    expect(session).toMatchObject({ costUSD: 0.5, assistantMessages: 1 });
  });

  test("fork copies are not counted, including when the source lies outside the observation window", async () => {
    const old = START - 1000;
    const source = { info: info("source", { start: old, time: { created: old, updated: old } }), messages: [message("copied", "assistant", old, { cost: 10 })] };
    const fork = { info: info("fork", { fork: { sessionID: "source", boundary: { type: "through", messageID: "copied" } } }),
      messages: [...source.messages, msg("own", "assistant", 2)] };
    const sessions = await loadOpenCodeSessions({ since: START, api: openCodeApiFixture([fork, source], { pageSize: 1 }) });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "fork", forkedFrom: "source", costUSD: 0.25, assistantMessages: 1 });
  });

  test("unknown prices stay explicit partial costs, outside cost quantiles and PR averages", async () => {
    const [session] = await loadOpenCodeSessions({ api: openCodeApiFixture([{ info: info("partial"), messages: [
      msg("known", "assistant", 1, { cost: 0.5 }),
      msg("unknown", "assistant", 2, { cost: 0, model: { providerID: "fixture", id: "unpriced" }, content: [openCodeTool("pr", { name: "shell", ok: true, command: "gh pr create --fill", output: "https://github.com/o/r/pull/1" })] }),
      msg("missing", "assistant", 3, { cost: undefined, model: { providerID: "fixture", id: "unpriced" } }),
    ] }]) });
    expect(session).toMatchObject({ costUSD: 0.5, costSource: "partial", unpriced: true });
    expect(costKnown(session)).toBe(false);
    const stats = windowStats([entry(session)], new Map([["o/r#1", { state: "MERGED" }]]));
    expect(stats.cost).toMatchObject({ totalUSD: 0.5, medianUSD: null, p90USD: null, unpricedSessions: 1, sources: { partial: 1 } });
    expect(stats.prs).toMatchObject({ merged: 1, costPerMergedUSD: null, spendPerMergedUSD: null });
    expect(stats.modelMix.every((row) => row.harness === "opencode")).toBe(true);
  });

  test("tools, synthetic vs human prompts, errors, interrupts, variants and multi-model descendants normalize", async () => {
    const [session] = await loadOpenCodeSessions({ api: openCodeApiFixture([
      { info: info("root"), messages: [msg("user", "user"), msg("synthetic", "synthetic", 1),
        msg("a", "assistant", 2, { content: [openCodeTool("bad"), openCodeTool("running", { ok: true })] }),
        msg("b", "idle", 3, { outcome: "interrupted", error: { type: "ProviderError", status: 429, message: "fixture" } })] },
      { info: info("child", { parentID: "root" }), messages: [msg("c1", "assistant", 4),
        msg("c2", "assistant", 5, { model: { providerID: "other", id: "second", variant: "low" } })] },
    ]) });
    expect(session).toMatchObject({ prompts: [{ source: "opencode" }], efforts: { high: 1 }, interrupts: 1, apiErrors: { 429: 1 } });
    expect(session.toolCalls.map((call) => [call.name, call.ok])).toEqual([["board_board_task_claim", false], ["board_board_task_claim", true]]);
    const stats = windowStats([entry(session)], null);
    expect(stats.modelMix.filter((row) => row.role === "worker").map((row) => [row.model, row.messages, row.costUSD])).toEqual([["opencode/test-model", 1, 0.25], ["other/second", 1, 0.25]]);
    expect(normalizeOpenCodeUsage(openCodeTokens())).toEqual({ input: 100, output: 20, cacheRead: 30, cacheWrite5m: 5, cacheWrite1h: 0 });
  });

  test("repeated cursors, malformed API data and ancestry cycles fail without quoting response content", async () => {
    await expect(loadOpenCodeData({ api: async () => ({ data: [], cursor: { next: "same" } }) })).rejects.toThrow("repeated pagination cursor");
    await expect(loadOpenCodeData({ api: async () => ({ data: [{ secret: "must not be quoted" }], cursor: {} }) })).rejects.toThrow("invalid session header");
    await expect(loadOpenCodeData({ api: openCodeApiFixture([{ info: info("cycle", { parentID: "cycle" }), messages: [] }]) })).rejects.toThrow("ancestry cycle");
    await expect(openCodeApi("/api/credential")).rejects.toThrow("unsupported read path");
    await expect(loadOpenCodeData({ api: openCodeApiFixture([{ info: info("bad"), messages: [msg("bad", "assistant", 1, { tokens: { input: -1 } })] }]) })).rejects.toThrow("invalid token usage");
  });

  test("shell exit and timeout metadata determine command failures, not just transport success", () => {
    const part = openCodeTool("shell", { name: "shell", ok: true });
    for (const [metadata, ok] of [[{ status: "completed", exit: 1 }, false], [{ status: "completed", exit: 0 }, true],
      [{ status: "completed", timeout: true, signal: "SIGTERM" }, false], [{ status: "running" }, null]]) {
      expect(openCodeCall({ ...part, state: { ...part.state, metadata } }).ok).toBe(ok);
    }
  });
});
