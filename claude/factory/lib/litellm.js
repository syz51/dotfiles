// Fallback prices for models missing from pricing.js's table, such as the GPT models Codex
// runs: LiteLLM's public price list, kept in the state folder and refreshed by the metrics
// command when it is older than a week. Entries give USD per token; prices here are USD
// per million tokens, the shape pricing.js uses.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, stateDir, writeJsonAtomic } from "./state.js";

export const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const LITELLM_FILE = "litellm-prices.json";
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The cache as { fetchedAt, source, prices }, read once per state folder.
let loaded = null;

function cache() {
  const path = join(stateDir(), LITELLM_FILE);
  if (loaded?.path !== path) loaded = { path, data: existsSync(path) ? readJson(path) : null, prices: new Map() };
  return loaded;
}

// When the cached list was fetched, or null when there is none.
export const litellmFetchedAt = () => cache().data?.fetchedAt ?? null;

// Fetches the list when the cache is missing or older than MAX_AGE_MS. A failed fetch
// keeps the old copy and adds a note; it never stops the report.
export async function refreshLitellm({ fetch = globalThis.fetch, now = Date.now(), notes = [] } = {}) {
  const fetchedAt = litellmFetchedAt();
  if (fetchedAt && now - Date.parse(fetchedAt) < MAX_AGE_MS) return false;
  let prices;
  try {
    const response = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    prices = await response.json();
    if (!prices || typeof prices !== "object" || Array.isArray(prices)) throw new Error("not a JSON object");
  } catch (error) {
    notes.push(`LiteLLM's price list could not be refreshed (${error.message}); ${fetchedAt ? `using the copy fetched ${fetchedAt.slice(0, 10)}` : "models missing from the price table stay unpriced"}.`);
    return false;
  }
  const data = { fetchedAt: new Date(now).toISOString(), source: LITELLM_URL, prices };
  const path = join(stateDir(), LITELLM_FILE);
  writeJsonAtomic(path, data);
  loaded = { path, data, prices: new Map() };
  return true;
}

const perMillion = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value * 1e6 : undefined);

// A LiteLLM entry as { input, output, cacheRead, cacheWrite5m, cacheWrite1h, long? }, or
// null without input and output prices. Missing cache prices fall back to the input price
// (OpenAI bills cache writes as input); a 1-hour write without its own price costs a
// 5-minute one. The lowest "above N k tokens" tier becomes the long-prompt price, its
// missing fields taken from the base price.
export function fromLitellm(entry) {
  const input = perMillion(entry?.input_cost_per_token);
  const output = perMillion(entry?.output_cost_per_token);
  if (input === undefined || output === undefined) return null;
  const cacheRead = perMillion(entry.cache_read_input_token_cost) ?? input;
  const cacheWrite5m = perMillion(entry.cache_creation_input_token_cost) ?? input;
  const cacheWrite1h = perMillion(entry.cache_creation_input_token_cost_above_1hr) ?? cacheWrite5m;
  const price = { input, output, cacheRead, cacheWrite5m, cacheWrite1h };
  const tiers = Object.keys(entry).map((key) => /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  const [tier] = tiers.filter((k) => perMillion(entry[`input_cost_per_token_above_${k}k_tokens`]) !== undefined);
  if (tier !== undefined) {
    const above = (key) => perMillion(entry[`${key}_above_${tier}k_tokens`]);
    price.long = {
      above: tier * 1000,
      input: above("input_cost_per_token"),
      output: above("output_cost_per_token") ?? output,
      cacheRead: above("cache_read_input_token_cost") ?? cacheRead,
      cacheWrite5m: above("cache_creation_input_token_cost") ?? cacheWrite5m,
      cacheWrite1h: above("cache_creation_input_token_cost_above_1hr") ?? cacheWrite1h,
    };
  }
  return price;
}

// The cached LiteLLM price of a model by its exact name, or null.
export function litellmPrice(model) {
  const { data, prices } = cache();
  if (!data) return null;
  if (!prices.has(model)) prices.set(model, Object.hasOwn(data.prices, model) ? fromLitellm(data.prices[model]) : null);
  return prices.get(model);
}
