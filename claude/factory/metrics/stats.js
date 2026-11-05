// Window statistics over prepared session entries: { session, prompts, prs, corrections },
// where prompts are the person's prompts, prs the PRs the session created or linked, and
// corrections the heuristic count. prInfo maps PR keys to their GitHub state and revert,
// or is null when GitHub was not asked.

const sum = (values) => values.reduce((total, value) => total + value, 0);
const ratio = (part, whole) => (whole ? part / whole : null);

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
      pr.prompts += prompts.length / links.length;
      prs.set(link.key, pr);
    }
  return [...prs.values()];
}

function prStats(entries, prInfo, totalCost, totalPrompts) {
  const linked = attributePrs(entries);
  if (!prInfo) return { linked: linked.length, known: 0, merged: null, open: null, closed: null, reverted: null, costPerMergedUSD: null, spendPerMergedUSD: null, promptsPerMerged: null, promptsAllPerMerged: null };
  const state = (pr) => prInfo.get(pr.key)?.state;
  const merged = linked.filter((pr) => state(pr) === "MERGED");
  return {
    linked: linked.length,
    known: linked.filter((pr) => prInfo.has(pr.key)).length,
    merged: merged.length,
    open: linked.filter((pr) => state(pr) === "OPEN").length,
    closed: linked.filter((pr) => state(pr) === "CLOSED").length,
    reverted: merged.filter((pr) => prInfo.get(pr.key).revertedBy).length,
    // Mean cost of the sessions behind each merged PR, split across their PRs.
    costPerMergedUSD: ratio(sum(merged.map((pr) => pr.costUSD)), merged.length),
    // All spend in the window, PR or not, over the PRs that merged.
    spendPerMergedUSD: ratio(totalCost, merged.length),
    promptsPerMerged: ratio(sum(merged.map((pr) => pr.prompts)), merged.length),
    // All prompts in the window over the PRs that merged.
    promptsAllPerMerged: ratio(totalPrompts, merged.length),
  };
}

// Messages and estimated cost by role (main session or subagent type) and model. Main
// cost is the session's estimate less its subagents, split across models by their usage.
function modelMix(sessions) {
  const rows = new Map();
  const row = (role, model) => {
    const key = `${role}\u0000${model}`;
    if (!rows.has(key)) rows.set(key, { role, model, runs: 0, messages: 0, costUSD: 0 });
    return rows.get(key);
  };
  for (const session of sessions) {
    const subagentCost = sum(session.subagents.map((agent) => agent.costUSD));
    const mainCost = Math.max(0, session.estimatedCostUSD - subagentCost);
    // Per-request costs, so a model's long-prompt tier applies only where a request hit it.
    const weights = Object.keys(session.models).map((model) => [model, session.costByModel?.[model] ?? 0]);
    const totalWeight = sum(weights.map(([, weight]) => weight));
    for (const [model, weight] of weights) {
      const entry = row("main", model);
      entry.runs++;
      entry.messages += session.models[model];
      entry.costUSD += totalWeight ? (mainCost * weight) / totalWeight : 0;
    }
    for (const agent of session.subagents) {
      const entry = row(agent.agentType ?? "unknown", agent.model ?? "unknown");
      entry.runs++;
      entry.messages += agent.assistantMessages;
      entry.costUSD += agent.costUSD;
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
      medianUSD: quantile(costs, 0.5),
      p90USD: quantile(costs, 0.9),
      sources: { "cost-state": sessions.filter((session) => session.costSource === "cost-state").length, estimated: sessions.filter((session) => session.costSource === "estimated").length },
      unpricedSessions: sessions.filter((session) => session.unpriced).length,
    },
    prs: prStats(entries, prInfo, totalCost, totalPrompts),
    corrections: { heuristic: true, followUps, corrections, rate: ratio(corrections, followUps) },
    interrupts: { total: interrupts, perSession: ratio(interrupts, sessions.length) },
    toolErrors: {
      main: { known: known.length, errors: mainErrors, rate: ratio(mainErrors, known.length) },
      subagents: { calls: agentCalls, errors: agentErrors, rate: ratio(agentErrors, agentCalls) },
    },
    apiErrors,
    compactions: { total: compactions, perSession: ratio(compactions, sessions.length) },
    subagents: { runs: agents.length, costUSD: subagentCost, share: ratio(subagentCost, estimatedTotal) },
    // Sessions a person ran vs threads an orchestrating agent launched with a brief.
    origin: Object.fromEntries(["person", "agent"].map((origin) => {
      const of = sessions.filter((session) => (session.origin ?? "person") === origin);
      return [origin, { sessions: of.length, costUSD: sum(of.map((session) => session.costUSD)) }];
    })),
    modelMix: modelMix(sessions),
  };
}
