---
name: analyze
description: Use this skill for evidence-heavy investigation and root-cause analysis. It is for why questions, ambiguous failures, architecture diagnosis, and cross-file reasoning where the answer should be structured around observations, competing hypotheses, evidence, and the best next discriminating probe.
argument-hint: "<question, failure, or system behavior>"
---

# Analyze

Use this skill when the goal is to explain what is happening and why, not to jump straight into implementation.

## Good Fits

- "Why is this failing?"
- "What changed?"
- "Where is the bottleneck?"
- "What is causing this behavior?"
- architecture, dependency, config, or regression investigations

## Not A Fit

- obvious one-file factual lookups
- direct implementation requests
- broad product planning without a concrete observed problem

## Investigation Contract

Always preserve these sections in your reasoning and answer:

1. Observation
2. Ranked hypotheses
3. Evidence for each leading hypothesis
4. Evidence against or missing evidence
5. Current best explanation
6. Critical unknown
7. Best discriminating probe or next action

## Rules

- Generate at least two plausible hypotheses before settling on one.
- Try to falsify your favorite explanation.
- Rank evidence by strength.
- Prefer direct artifacts over intuition.
- Cite concrete files, lines, commands, logs, or test results when available.
- If the evidence is incomplete, say so plainly instead of manufacturing certainty.

## Delegation Guidance

- Use `explorer` for bounded repository mapping and lookup.
- Use `worker` only for isolated reproduction or measurement tasks that do not overlap with your main analysis.
- Keep synthesis and ranking in the main thread.

## Output Shape

Return:

- observed result
- ranked hypotheses with confidence
- best explanation
- single highest-value next step
