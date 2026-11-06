// Token sizes of each cell's board text, counted by the model's own tokenizer through the
// subscription: a tool-less `claude -p` call reports its input tokens, and the size of a
// text is that count minus the count for a one-word baseline prompt. The count_tokens
// API would need an API key, which this benchmark never uses.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../../tests/lib/process.js";
import { initEvent, parseStream, resultEvent } from "../../../tests/lib/stream.js";
import { claudeBin, isolatedEnv } from "./run.js";

const BASELINE = "OK";

async function inputTokens(text, model) {
  const cwd = mkdtempSync(join(tmpdir(), "board-bench-tokens-"));
  try {
    const argv = [claudeBin(), "--print", "--setting-sources", "", "--tools", "", "--strict-mcp-config", "--disable-slash-commands",
      "--no-session-persistence", "--system-prompt", "Reply with OK.", "--model", model, "--effort", "low",
      "--output-format", "stream-json", "--verbose"];
    const run = await runProcess(argv, { cwd, env: isolatedEnv(process.env, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }), timeout: 120_000, input: text });
    const events = parseStream(run.stdout);
    if (initEvent(events)?.apiKeySource !== "none") throw new Error("Token count call did not run on the subscription");
    const usage = resultEvent(events)?.usage;
    if (!usage) throw new Error(`Token count call returned no usage (exit ${run.code})`);
    return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// { [cell]: { startBlockTokens, showResultTokens } } for the first record of each cell
// that has samples.
export async function countTokens(records, model, log = () => {}) {
  const baseline = await inputTokens(BASELINE, model);
  const out = {};
  for (const record of records) {
    if (out[record.cell] || !record.samples?.startBlock) continue;
    const counts = {};
    for (const [key, text] of [["startBlockTokens", record.samples.startBlock], ["showResultTokens", record.samples.showResult]])
      counts[key] = text ? await inputTokens(text, model) - baseline : null;
    out[record.cell] = counts;
    log(`${record.cell}: start block ${counts.startBlockTokens} tokens, task_show ${counts.showResultTokens ?? "n/a"}`);
  }
  return out;
}
