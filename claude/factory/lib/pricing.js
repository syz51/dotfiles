// API-equivalent cost from token usage, for sessions without Claude Code's own
// cost-state record. Prices are USD per million tokens from the Anthropic pricing page as
// cached by the claude-api skill on 2026-10-06; check that page when they look stale.
// Cache writes cost 1.25x input for the 5-minute duration and 2x for 1 hour. The table
// states cache reads for Fable 5.1, Opus 5.5 and Sonnet 5.5; the others use the general
// 0.1x-of-input rate.
export const PRICES_AS_OF = "2026-10-06";

export const PRICES = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  // Haiku 5.5 charges more for a request whose prompt exceeds 100K tokens.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
};

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

// Cost of one API request, or null for a model without a known price.
export function requestCost(model, usage) {
  const price = PRICES[model];
  if (!price) return null;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
  const rate = price.long && prompt > price.long.above ? { ...price, ...price.long } : price;
  return (usage.input * rate.input
    + usage.cacheWrite5m * rate.input * 1.25
    + usage.cacheWrite1h * rate.input * 2
    + usage.cacheRead * rate.cacheRead
    + usage.output * rate.output) / 1e6;
}
