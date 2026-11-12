// API-equivalent cost from token usage, for sessions without Claude Code's own
// cost-state record. Prices are USD per million tokens from Anthropic's pricing page,
// https://platform.claude.com/docs/en/about-claude/pricing, checked on PRICES_AS_OF.
// Cache writes cost 1.25x input for the 5-minute duration and 2x for 1 hour. Cache reads
// cost 0.1x input, except Fable 5.1 and 5.2 (0.025x) and Opus 5.5 (0.05x). Fable 5.2 was
// checked on 2026-11-12.
// Models missing here, such as the GPT models Codex runs, take LiteLLM's cached price.
// Sessions run only Opus, Haiku or Fable 5.2 now, and no recorded transcript used another
// Claude tier, so the table lists no other tier; one would fall back to LiteLLM.
import { litellmPrice } from "./litellm.js";

export const PRICES_AS_OF = "2026-11-07";

export const PRICES = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  // Haiku 5.5 charges more for a request whose prompt exceeds 100K tokens.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
};

// Where a model's price comes from: "table", "litellm", or null when it has none.
export function priceSource(model) {
  if (Object.hasOwn(PRICES, model)) return "table";
  return litellmPrice(model) ? "litellm" : null;
}

export const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

// Normalized usage from an API message's usage object. Cache writes without a TTL
// breakdown count as 5-minute writes.
export function normalizeUsage(usage = {}) {
  const write = usage.cache_creation_input_tokens ?? 0;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const fiveMinute = usage.cache_creation?.ephemeral_5m_input_tokens ?? write - oneHour;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite5m: Math.max(0, fiveMinute),
    cacheWrite1h: oneHour,
  };
}

export function addUsage(total, usage) {
  for (const key of Object.keys(total)) total[key] += usage[key] ?? 0;
  return total;
}

// Cost of one API request, or null for a model without a known price. A price may state
// its cache-write rates; otherwise they follow Anthropic's multipliers.
export function requestCost(model, usage) {
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : litellmPrice(model);
  if (!price) return null;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
  const rate = price.long && prompt > price.long.above ? { ...price, ...price.long } : price;
  return (usage.input * rate.input
    + usage.cacheWrite5m * (rate.cacheWrite5m ?? rate.input * 1.25)
    + usage.cacheWrite1h * (rate.cacheWrite1h ?? rate.input * 2)
    + usage.cacheRead * rate.cacheRead
    + usage.output * rate.output) / 1e6;
}
