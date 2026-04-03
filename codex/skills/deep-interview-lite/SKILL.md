---
name: deep-interview-lite
description: Use this skill when a request is broad, vague, or under-specified and execution would be risky. It turns ambiguous requests into execution-ready scope by asking one high-value question at a time, clarifying intent and non-goals first, and gathering codebase facts before asking the user for facts you can inspect yourself.
argument-hint: "[--quick|--standard] <idea or request>"
---

# Deep Interview Lite

Use this skill before planning or implementation when the request is still too vague for safe execution.

## Use When

- The user wants a feature but the boundaries are unclear.
- The request is broad enough that multiple interpretations would materially change the implementation.
- The user is likely to care about intent, non-goals, tradeoffs, or decision boundaries.

## Do Not Use When

- The task already has concrete file targets and acceptance criteria.
- The user explicitly says to skip planning and execute now.
- The missing facts are retrievable from the codebase or workspace.

## Core Rules

- Ask one question at a time.
- Ask about intent, success criteria, and non-goals before implementation detail.
- Do not ask the user for codebase facts you can inspect yourself.
- Stop once the task is clear enough to plan or implement.
- Prefer concise questions with high branching value.

## Recommended Order

1. Restate the goal in one sentence.
2. Inspect the workspace for obvious facts or constraints.
3. Ask for the highest-value missing boundary:
   - primary goal
   - non-goals
   - risk tolerance
   - success criteria
   - allowed shortcuts or forbidden changes
4. Repeat only while ambiguity is still material.
5. Once the task is clear, switch to planning or execution immediately.

## Good Question Shapes

- "What outcome matters most?"
- "What should stay out of scope?"
- "If tradeoffs are needed, what must not be compromised?"
- "What would make this feel done to you?"

## Exit Condition

Stop interviewing when:

- the intended outcome is clear
- the main boundaries are known
- the next action is plan or execute, not ask again
