// Window statistics over prepared session entries: { session, prompts, prs, corrections },
// where prompts are the person's prompts, prs the PRs the session created or linked, and
// corrections the heuristic count. prInfo maps PR keys to their GitHub state and revert,
// or is null when GitHub was not asked.

export const sum = (values) => values.reduce((total, value) => total + value, 0);
// Tokens of normalized usage, input, cache and output together, and of a usage map
// ({ [model]: normalized usage }).
const usageTokens = (entry) => entry.input + entry.output + entry.cacheRead + entry.cacheWrite5m + entry.cacheWrite1h;
const tokens = (usage) => sum(Object.values(usage).map(usageTokens));
// Harnesses a session can come from, with their names in reports.
export const HARNESSES = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
export const ratio = (part, whole) => (whole ? part / whole : null);

// Linear-interpolation quantile of values (q in [0, 1]); null for no values.
export function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (position - low);
}

// Each linked PR with the cost and prompts of its sessions, split evenly when a session
// has several PRs: [{ key, url, repository, number, sessions, costUSD, prompts }].
export function attributePrs(entries) {
  const prs = new Map();
  for (const { session, prompts, prs: links } of entries)
    for (const link of links) {
      const pr = prs.get(link.key) ?? { ...link, sessions: [], costUSD: 0, prompts: 0 };
      pr.sessions.push(session.id);
      pr.costUSD += session.costUSD / links.length;
      if (!costKnown(session)) pr.partialCost = true;
      pr.prompts += prompts.length / links.length;
      prs.set(link.key, pr);
    }
  return [...prs.values()];
}

// A session's cost is unknown when it is a usage estimate with an unpriced model, such as
// every Codex session until GPT models have prices: its $0 is partial, not a cost.
export const costKnown = (session) => Number.isFinite(session.costUSD) && session.costSource !== "partial" && !(session.unpriced && session.costSource === "estimated");

function prStats(entries, prInfo, totalPrompts) {
  const linked = attributePrs(entries);
  if (!prInfo) return { linked: linked.length, known: 0, merged: null, open: null, closed: null, reverted: null, costPerMergedUSD: null, spendPerMergedUSD: null, promptsPerMerged: null, promptsAllPerMerged: null };
  const state = (pr) => prInfo.get(pr.key)?.state;
  const merged = linked.filter((pr) => state(pr) === "MERGED");
  // Cost per merged PR counts only PRs whose sessions all have a known cost.
  const unknown = new Set(entries.filter(({ session }) => !costKnown(session)).map(({ session }) => session.id));
  const priced = merged.filter((pr) => pr.sessions.every((id) => !unknown.has(id)));
  const knownSpend = sum(entries.filter(({ session }) => !unknown.has(session.id)).map(({ session }) => session.costUSD));
  return {
    linked: linked.length,
    known: linked.filter((pr) => prInfo.has(pr.key)).length,
    merged: merged.length,
    open: linked.filter((pr) => state(pr) === "OPEN").length,
    closed: linked.filter((pr) => state(pr) === "CLOSED").length,
    reverted: merged.filter((pr) => prInfo.get(pr.key).revertedBy).length,
    // Mean cost of the sessions behind each merged PR, split across their PRs.
    costPerMergedUSD: ratio(sum(priced.map((pr) => pr.costUSD)), priced.length),
    // All known spend in the window, PR or not, over the merged PRs of known cost.
    spendPerMergedUSD: ratio(knownSpend, priced.length),
    promptsPerMerged: ratio(sum(merged.map((pr) => pr.prompts)), merged.length),
    // All prompts in the window over the PRs that merged.
    promptsAllPerMerged: ratio(totalPrompts, merged.length),
  };
}

// Messages and estimated cost by role (main session or subagent type) and model. Main
// cost is the session's estimate less its subagents, split across models by their usage.
function modelMix(sessions) {
  const rows = new Map();
  const row = (harness, role, model) => {
    const key = `${harness}\u0000${role}\u0000${model}`;
    if (!rows.has(key)) rows.set(key, { harness, role, model, runs: 0, messages: 0, tokens: 0, costUSD: 0 });
    return rows.get(key);
  };
  for (const session of sessions) {
    const subagentCost = sum(session.subagents.map((agent) => agent.costUSD));
    const mainCost = Math.max(0, session.estimatedCostUSD - subagentCost);
    // Per-request costs, so a model's long-prompt tier applies only where a request hit it.
    const weights = Object.keys(session.models).map((model) => [model, session.costByModel?.[model] ?? 0]);
    const totalWeight = sum(weights.map(([, weight]) => weight));
    for (const [model, weight] of weights) {
      const entry = row(session.harness, "main", model);
      entry.runs++;
      entry.messages += session.models[model];
      entry.tokens += session.usage[model] ? usageTokens(session.usage[model]) : 0;
      entry.costUSD += totalWeight ? (mainCost * weight) / totalWeight : 0;
      if (session.ownCostSource ? session.ownCostSource === "partial" : !costKnown(session)) entry.partialCost = true;
    }
    for (const agent of session.subagents) {
      if (agent.models) {
        // OpenCode preserves each descendant's model mix, not only its top model.
        for (const [model, messages] of Object.entries(agent.models)) {
          const entry = row(session.harness, agent.agentType ?? "unknown", model);
          entry.runs++;
          entry.messages += messages;
          entry.tokens += agent.usage[model] ? usageTokens(agent.usage[model]) : 0;
          entry.costUSD += agent.costByModel[model] ?? 0;
          if (agent.unpriced) entry.partialCost = true;
        }
      } else {
        const entry = row(session.harness, agent.agentType ?? "unknown", agent.model ?? "unknown");
        entry.runs++;
        entry.messages += agent.assistantMessages;
        entry.tokens += tokens(agent.usage);
        entry.costUSD += agent.costUSD;
        if (agent.unpriced) entry.partialCost = true;
      }
    }
  }
  const total = sum([...rows.values()].map((entry) => entry.costUSD));
  return [...rows.values()]
    .map((entry) => ({ ...entry, share: ratio(entry.costUSD, total) }))
    .sort((a, b) => b.costUSD - a.costUSD);
}

export function windowStats(entries, prInfo) {
  const sessions = entries.map((entry) => entry.session);
  const promptCounts = entries.map((entry) => entry.prompts.length);
  const costs = sessions.map((session) => session.costUSD);
  const pricedCosts = sessions.filter(costKnown).map((session) => session.costUSD);
  const totalCost = sum(costs);
  const totalPrompts = sum(promptCounts);
  // Follow-ups in an agent-launched thread come from the orchestrating agent, so only
  // sessions a person ran count toward the correction rate.
  const personEntries = entries.filter((entry) => entry.session.origin !== "agent");
  const followUps = sum(personEntries.map((entry) => entry.corrections.followUps));
  const corrections = sum(personEntries.map((entry) => entry.corrections.corrections));
  const known = sessions.flatMap((session) => session.toolCalls.filter((call) => call.ok !== null));
  const mainErrors = known.filter((call) => call.ok === false).length;
  const agents = sessions.flatMap((session) => session.subagents);
  const agentCalls = sum(agents.map((agent) => agent.toolCalls));
  const agentErrors = sum(agents.map((agent) => agent.toolErrors));
  const apiErrors = {};
  for (const session of sessions)
    for (const [status, count] of Object.entries(session.apiErrors)) apiErrors[status] = (apiErrors[status] ?? 0) + count;
  const interrupts = sum(sessions.map((session) => session.interrupts));
  const compactions = sum(sessions.map((session) => session.compactions));
  const subagentCost = sum(agents.map((agent) => agent.costUSD));
  const estimatedTotal = sum(sessions.map((session) => session.estimatedCostUSD));
  return {
    sessions: sessions.length,
    prompts: { total: totalPrompts, meanPerSession: ratio(totalPrompts, sessions.length), medianPerSession: quantile(promptCounts, 0.5) },
    cost: {
      totalUSD: totalCost,
      // Over sessions with a known cost: an estimate with an unpriced model, such as every
      // Codex session, is a partial $0 that would drag these down.
      medianUSD: quantile(pricedCosts, 0.5),
      p90USD: quantile(pricedCosts, 0.9),
      sources: { "cost-state": sessions.filter((session) => session.costSource === "cost-state").length, estimated: sessions.filter((session) => session.costSource === "estimated").length,
        ...Object.fromEntries(["api", "partial"].map((source) => [source, sessions.filter((session) => session.costSource === source).length]).filter(([, count]) => count)) },
      unpricedSessions: sessions.filter((session) => session.unpriced).length,
    },
    prs: prStats(entries, prInfo, totalPrompts),
    // Branches pushed in the window, each once however many sessions pushed it.
    pushes: (() => {
      const created = new Map();
      for (const entry of entries) for (const push of entry.pushes) created.set(push.key, created.get(push.key) === true || push.created);
      return { branches: created.size, created: [...created.values()].filter(Boolean).length, sessions: entries.filter((entry) => entry.pushes.length).length };
    })(),
    corrections: { heuristic: true, followUps, corrections, rate: ratio(corrections, followUps) },
    interrupts: { total: interrupts, perSession: ratio(interrupts, sessions.length) },
    toolErrors: {
      main: { known: known.length, errors: mainErrors, rate: ratio(mainErrors, known.length) },
      subagents: { calls: agentCalls, errors: agentErrors, rate: ratio(agentErrors, agentCalls) },
    },
    apiErrors,
    compactions: { total: compactions, perSession: ratio(compactions, sessions.length) },
    subagents: { runs: agents.length, costUSD: subagentCost, share: ratio(subagentCost, estimatedTotal) },
    // Sessions, cost and tokens (subagents included) per harness: Claude Code or Codex.
    harness: Object.fromEntries(Object.keys(HARNESSES).map((harness) => {
      const of = sessions.filter((session) => session.harness === harness);
      return [harness, {
        sessions: of.length,
        costUSD: sum(of.map((session) => session.costUSD)),
        unpricedSessions: of.filter((session) => session.unpriced).length,
        tokens: sum(of.map((session) => tokens(session.usage) + sum(session.subagents.map((agent) => tokens(agent.usage))))),
        subagentRuns: sum(of.map((session) => session.subagents.length)),
      }];
    })),
    // Sessions a person ran vs threads an orchestrating agent launched with a brief.
    origin: Object.fromEntries(["person", "agent"].map((origin) => {
      const of = sessions.filter((session) => (session.origin ?? "person") === origin);
      return [origin, { sessions: of.length, costUSD: sum(of.map((session) => session.costUSD)) }];
    })),
    modelMix: modelMix(sessions),
  };
}
