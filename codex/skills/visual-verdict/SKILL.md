---
name: visual-verdict
description: Use this skill for screenshot-based UI verification against one or more references. It returns a strict JSON verdict with score, mismatches, and next edits so visual work can iterate deterministically instead of drifting through vague feedback.
argument-hint: "<reference image(s)> <generated screenshot>"
---

# Visual Verdict

Use this skill when you need deterministic visual feedback for frontend work.

## Use When

- comparing a generated UI screenshot to a reference
- iterating on layout, spacing, typography, or styling fidelity
- deciding whether another edit pass is needed

## Output Contract

Return JSON only with this exact shape:

```json
{
  "score": 0,
  "verdict": "revise",
  "category_match": false,
  "differences": ["..."],
  "suggestions": ["..."],
  "reasoning": "short explanation"
}
```

## Rules

- `score` is an integer from 0 to 100.
- `verdict` is `pass`, `revise`, or `fail`.
- `category_match` indicates whether the result still fits the intended UI category and style.
- `differences` must be concrete and visual.
- `suggestions` must map directly to the differences.
- `reasoning` stays short.

## Threshold

- Treat `90+` as the pass threshold.
- If `score < 90`, keep iterating before claiming fidelity.

## Debugging Guidance

- Use screenshots as the primary evidence.
- If mismatch localization is difficult, use a pixel diff or overlay as a secondary aid.
- Convert all visual observations into actionable next edits.

## Good Difference Types

- spacing
- alignment
- typography
- hierarchy
- sizing
- color and contrast
- component state styling
