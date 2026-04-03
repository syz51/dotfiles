---
name: openviking-memory-context
description: Use OpenViking as Codex's explicit context and long-term memory backend. Trigger this skill when Codex needs to search indexed repositories, docs, or other resources in OpenViking; browse or read `viking://` URIs; recall prior user preferences, project decisions, fixes, or reusable patterns from OpenViking memory; add new repositories or documents into OpenViking for later retrieval; or persist distilled durable notes from the current task into OpenViking after important work is completed or when the user asks to remember something.
---

# OpenViking Memory Context

Use the bundled `scripts/ov_bridge.py` to talk to OpenViking over HTTP when a healthy server is available, or in embedded local mode when only `ov.conf` is present.

Treat this as an explicit memory system. Codex does not have automatic Claude-style session hooks here, so recall and commit are deliberate actions.

## Preconditions

- Install `uv`.
- Sync the skill environment once after installation:
  - `cd "$SKILL_DIR" && uv sync`
- Ad hoc execution should use `uv run --project "$SKILL_DIR" ...`
- Provide configuration in one of these places:
  - `OPENVIKING_CONFIG_FILE`
  - `./ov.conf`
  - `~/.openviking/ov.conf`
- If an HTTP server is configured and healthy, the bridge uses it.
- If no healthy HTTP server is found but `ov.conf` exists, the bridge falls back to embedded local mode.

## Decision Rules

- Recall first when the user refers to prior work, earlier decisions, established preferences, recurring constraints, or "what we did before."
- Search OpenViking context before answering questions about repos, docs, notes, or other materials that may already be indexed.
- Persist memory only when the fact is durable and likely to matter later.
- Do not store secrets, tokens, raw noisy transcripts, or temporary execution chatter.
- Distill before writing memory. Prefer short summaries of the user need, the outcome, and the reusable lesson.

## Resolve the Bridge

Resolve the skill directory, then use the sibling script:

```bash
SKILL_DIR="/absolute/path/to/openviking-memory-context"
BRIDGE="$SKILL_DIR/scripts/ov_bridge.py"
```

If the skill is installed elsewhere, adjust `SKILL_DIR` accordingly. The bridge prints JSON so inspect results before summarizing them to the user.

## Search Context

Use this when the user asks about indexed repos, docs, tickets, notes, or general project context.

```bash
uv run --project "$SKILL_DIR" python "$BRIDGE" search --query "OAuth refresh flow" --target-uri "viking://resources/" --limit 8
uv run --project "$SKILL_DIR" python "$BRIDGE" search --query "embedding configuration" --target-uri "viking://resources/my-project/" --limit 8
uv run --project "$SKILL_DIR" python "$BRIDGE" ls --uri "viking://resources/my-project/"
uv run --project "$SKILL_DIR" python "$BRIDGE" read --uri "viking://resources/my-project/docs/auth.md" --level read
uv run --project "$SKILL_DIR" python "$BRIDGE" read --uri "viking://resources/my-project/docs/" --level overview
```

Prefer narrowing `--target-uri` once you know the relevant subtree. That improves retrieval quality and reduces noise.

## Recall Memory

Use this when the user asks about prior preferences, earlier fixes, previously chosen approaches, historical constraints, or reusable lessons.

```bash
uv run --project "$SKILL_DIR" python "$BRIDGE" recall --query "user preferences for code review style" --top-k 5
uv run --project "$SKILL_DIR" python "$BRIDGE" recall --query "previous deployment decisions for this project" --top-k 5
```

Read the returned URIs if the preview is not enough. Summarize only the relevant memories back to the user.

## Add New Context

Use this when the user wants OpenViking to index a repo, local folder, file, or URL for later reuse.

```bash
uv run --project "$SKILL_DIR" python "$BRIDGE" add-resource --path "https://github.com/owner/repo" --to "viking://resources/repo" --timeout 300
uv run --project "$SKILL_DIR" python "$BRIDGE" add-resource --path "/absolute/path/to/docs" --to "viking://resources/project-docs" --timeout 300
```

For repo and document ingestion, tell the user indexing may continue in the background depending on the backend and payload size.

## Persist Memory

Use this after substantial work or when the user explicitly says to remember something.

Write one compact user-side summary and one compact assistant-side summary. Keep them durable.

```bash
uv run --project "$SKILL_DIR" python "$BRIDGE" remember \
  --user-text "User prefers concise findings-first code reviews and wants OpenViking used for project memory." \
  --assistant-text "Created an OpenViking Codex skill with a bridge script for search, recall, add-resource, and explicit memory commit." \
  --commit
```

Use `--commit` for durable notes that should be extracted into long-term memory now. Omit it only when intentionally batching several related notes into one OpenViking session.

## Session Management

The bridge stores lightweight local state in `./.openviking/codex_state.json` under the current workspace.

Useful commands:

```bash
uv run --project "$SKILL_DIR" python "$BRIDGE" status
uv run --project "$SKILL_DIR" python "$BRIDGE" ensure-session
uv run --project "$SKILL_DIR" python "$BRIDGE" commit
uv run --project "$SKILL_DIR" python "$BRIDGE" health
```

- `ensure-session` creates or reuses the active OpenViking session for this workspace.
- `commit` commits the active session and clears it from local state so the next remember action starts fresh.
- `status` shows the detected backend, config path, and current local state.

## Output Expectations

- Inspect the JSON response from the bridge before answering.
- Quote URIs when reporting where information came from.
- If recall or search returns nothing useful, say so plainly instead of inventing context.
