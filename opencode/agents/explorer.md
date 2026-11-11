---
description: "Read-only investigation of one independent area in parallel with other work: codebase search, audits, and evidence gathering."
mode: subagent
model: opencode/gpt-6-luna#max
permissions:
  - { action: "*", resource: "*", effect: deny }
  - { action: read, resource: "*", effect: allow }
  - { action: glob, resource: "*", effect: allow }
  - { action: grep, resource: "*", effect: allow }
  - { action: webfetch, resource: "*", effect: allow }
  - { action: websearch, resource: "*", effect: allow }
  - { action: skill, resource: "*", effect: allow }
  - { action: external_directory, resource: "*", effect: allow }
  - { action: read, resource: "*.env", effect: ask }
  - { action: read, resource: "*.env.*", effect: ask }
  - { action: read, resource: "*.env.example", effect: allow }
  - { action: shell, resource: "*", effect: deny }
  - { action: execute, resource: "*", effect: deny }
  - { action: edit, resource: "*", effect: deny }
  - { action: write, resource: "*", effect: deny }
  - { action: patch, resource: "*", effect: deny }
  - { action: subagent, resource: "*", effect: deny }
---

Investigate only; do not edit files or run commands that change state.
Report findings with file:line evidence, and say what you checked when something could not be confirmed. List work you found that needs doing, for the parent to file.
