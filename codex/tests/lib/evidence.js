import { createHash } from "node:crypto";

export function parseEvents(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Empty trace");
  const events = text
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  if (events.some((e) => ["error", "turn.failed"].includes(e.type)))
    throw new Error("Failed turn");
  if (!events.some((e) => e.type === "turn.completed"))
    throw new Error("Incomplete turn");
  return events;
}
export function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(strings);
  return [];
}
export function injected(records, instruction) {
  // Only instruction-bearing input messages qualify; final claims and tool output do not.
  return records.some(
    (r) =>
      r.type === "response_item" &&
      r.payload?.type === "message" &&
      ["user", "developer", "system"].includes(r.payload.role) &&
      strings(r.payload.content).some((s) => s.includes(instruction.trim())),
  );
}
export function owned(records, fixture, parentId) {
  const meta = records[0];
  return (
    meta?.type === "session_meta" &&
    meta.payload?.cwd === fixture &&
    typeof meta.payload.id === "string" &&
    meta.payload.id.length > 0 &&
    (!parentId ||
      meta.payload.id === parentId ||
      meta.payload.source?.subagent?.thread_spawn?.parent_thread_id ===
        parentId)
  );
}
export function currentTurnCompleted(records) {
  const contextIndex = records.findLastIndex((r) => r.type === "turn_context");
  const contextTurn = records[contextIndex]?.payload?.turn_id;
  const index = records.findLastIndex(
    (r) => r.type === "event_msg" && r.payload?.type === "task_started",
  );
  const turn = records[index]?.payload?.turn_id;
  if (typeof turn !== "string" || !turn || contextTurn !== turn) return false;
  const current = records.slice(Math.max(index, contextIndex) + 1);
  if (
    records.some(
      (r, recordIndex) =>
        r.type === "event_msg" &&
        ["error", "turn_aborted", "task_failed", "task_cancelled"].includes(
          r.payload?.type,
        ) &&
        (r.payload.turn_id === turn ||
          (!r.payload.turn_id && recordIndex > Math.min(index, contextIndex))),
    )
  )
    return false;
  return current.some(
    (r) =>
      r.type === "event_msg" &&
      r.payload?.type === "task_complete" &&
      r.payload.turn_id === turn,
  );
}
export function delegated(parent, children, role, model, effort, parentId) {
  const call = parent.some((r) => {
    if (
      r.type !== "response_item" ||
      r.payload?.type !== "function_call" ||
      r.payload.name !== "spawn_agent"
    )
      return false;
    try {
      return JSON.parse(r.payload.arguments).agent_type === role;
    } catch {
      return false;
    }
  });
  return (
    call &&
    children.some((records) => {
      const m = records[0]?.payload;
      const c = records.findLast((r) => r.type === "turn_context")?.payload;
      return (
        m?.agent_role === role &&
        m?.source?.subagent?.thread_spawn?.parent_thread_id === parentId &&
        c?.model === model &&
        c?.effort === effort &&
        currentTurnCompleted(records)
      );
    })
  );
}
export { commandWords, successfulCommand } from "./command-evidence.js";
import { commandWords } from "./command-evidence.js";
export function finalAnswer(events) {
  const a = events
    .filter(
      (e) => e.type === "item.completed" && e.item?.type === "agent_message",
    )
    .at(-1)?.item.text;
  if (typeof a !== "string" || !a.trim()) throw new Error("Missing answer");
  return a;
}
export function checkFiles(before, after, writable = []) {
  if (
    JSON.stringify(Object.keys(before).sort()) !==
    JSON.stringify(Object.keys(after).sort())
  )
    throw new Error("File inventory changed");
  for (const key of Object.keys(before))
    if (!writable.includes(key) && before[key] !== after[key])
      throw new Error(`Unauthorized change: ${key}`);
}
export const hash = (text) => createHash("sha256").update(text).digest("hex");

export function turnInterval(records) {
  const start = records.findLast(
    (r) => r.type === "event_msg" && r.payload?.type === "task_started",
  );
  if (!start || typeof start.payload.turn_id !== "string") return null;
  const end = records.findLast(
    (r) =>
      r.type === "event_msg" &&
      r.payload?.type === "task_complete" &&
      r.payload.turn_id === start.payload.turn_id,
  );
  const from = Date.parse(start.timestamp),
    to = Date.parse(end?.timestamp);
  return Number.isFinite(from) && Number.isFinite(to) && to > from
    ? [from, to]
    : null;
}
export function overlappingTurns(children) {
  const intervals = children.map(turnInterval).filter(Boolean);
  return intervals.some((a, i) =>
    intervals
      .slice(i + 1)
      .some((b) => Math.max(a[0], b[0]) < Math.min(a[1], b[1])),
  );
}
export function literalGuidanceRead(events, path, content) {
  return events.some((e) => {
    const i = e.item;
    if (
      e.type !== "item.completed" ||
      i?.type !== "command_execution" ||
      i.exit_code !== 0 ||
      i.aggregated_output !== content
    )
      return false;
    const words = commandWords(i.command);
    return words?.length === 2 && words[0] === "cat" && words[1] === path;
  });
}

// Callers supply only newly-created, fully parsed sessions from their unique fixture.
// Recover the root independently of stdout/completion; a failed CLI may still have
// created owned transcripts. Unknown/malformed records never qualify.
export function ownedRoots(entries, fixture, reportedId) {
  const roots = new Set(reportedId ? [reportedId] : []);
  for (const { records } of entries) {
    const meta = records[0]?.payload;
    if (
      owned(records, fixture) &&
      meta.id &&
      !meta.source?.subagent?.thread_spawn
    )
      roots.add(meta.id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const { records } of entries) {
      const meta = records[0]?.payload;
      const parent = meta?.source?.subagent?.thread_spawn?.parent_thread_id;
      if (owned(records, fixture) && roots.has(parent) && !roots.has(meta.id)) {
        roots.add(meta.id);
        changed = true;
      }
    }
  }
  return roots;
}
