# Gemini Notebook MCP (`gemini-notebook`) Runbook

`gemini/mcp_config.json` connects Antigravity to Google's official remote Gemini Notebook MCP server (`https://notebook.googleapis.com/mcp`) using `"authProviderType": "google_credentials"` (Google Application Default Credentials, ADC).

- **No secrets or project IDs live in dotfiles.** Antigravity reads the refresh token and `quota_project_id` directly from local gitignored `~/.config/gcloud/application_default_credentials.json`.
- **Supported accounts:** Personal Google Accounts only during Public Preview (Google Workspace accounts return `403 WORKSPACE_ACCOUNT_NOT_SUPPORTED`). The account must have signed in to `https://notebook.google.com` at least once.
- **Available MCP tools:** `create_notebook`, `get_notebook`, `list_notebooks`, `update_notebook`, `create_source`, `get_source`, `list_sources`.

## 1. Check whether ADC is valid

```bash
gcloud auth application-default print-access-token >/dev/null && echo "ADC_OK"
```

If this exits `0`, credentials are valid (Antigravity refreshes access tokens automatically). If `gemini-notebook` still fails with auth/scope/project errors or `print-access-token` fails (for example, `invalid_grant` / expired refresh token), follow the steps below.

## 2. Ensure the Desktop OAuth client JSON exists locally

Google blocks `gcloud`'s shared default OAuth client for the `notebook` scope (`This app is blocked`), so re-authentication must pass `--client-id-file` with the personal Desktop OAuth client JSON:

- Local path (`0600`): `~/.config/gcloud/gemini-notebook-oauth-client.json`
- HashiCorp Vault backup (`svps`, KV v2): `kv/data/hosts/mac/gemini-notebook-oauth-client` (field `client_secret_json`)

If the local file is missing, restore it from Vault using operator access (`~/Developer/vps/docs/vault.md#operator-access`) with `umask 077` so permissions stay `0600` (and revoke the Vault token afterward).

## 3. Refresh ADC credentials

Read `PROJECT_ID` dynamically from the client JSON and run ADC login with the required scopes:

```bash
set -euo pipefail
CLIENT_FILE="$HOME/.config/gcloud/gemini-notebook-oauth-client.json"
PROJECT_ID=$(jq -er '.installed.project_id' "$CLIENT_FILE")

gcloud auth application-default login \
  --client-id-file="$CLIENT_FILE" \
  --scopes="https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/notebook"

gcloud auth application-default set-quota-project "$PROJECT_ID"
chmod 600 "$HOME/.config/gcloud/application_default_credentials.json"
```

### Handling the browser OAuth step

Google's OAuth consent screen requires a human click (**Continue → Allow** in the browser; on an unverified personal app, click **Advanced → Continue**).

- **Local desktop session:** Launch `gcloud auth application-default login ...` directly in the background so the browser opens automatically, and share the printed OAuth URL in chat in case the window did not focus. Once the user clicks Allow, the command exits `0` and you can immediately run `set-quota-project`.
- **Headless / remote SSH session (for example, running on Air while the user is elsewhere):** Pass `--no-launch-browser` (or run on the user's active Mac and copy `application_default_credentials.json` over SSH stdin with atomic temp-file replacement).

### Syncing refreshed ADC to the other Mac

`application_default_credentials.json` is portable across Macs (`authorized_user` JSON). After refreshing on one Mac, you can copy it atomically to the peer Mac without repeating the browser login:

```bash
ssh <peer-mac> '
  set -euo pipefail
  mkdir -p "$HOME/.config/gcloud" && chmod 700 "$HOME/.config/gcloud"
  umask 077
  tmp=$(mktemp "$HOME/.config/gcloud/adc.XXXXXX")
  trap '\''rm -f "$tmp"'\'' EXIT
  cat > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$HOME/.config/gcloud/application_default_credentials.json"
' < "$HOME/.config/gcloud/application_default_credentials.json"
```

## 4. Verify live MCP connectivity

```bash
set -euo pipefail
PROJECT_ID=$(jq -er '.quota_project_id' "$HOME/.config/gcloud/application_default_credentials.json")
ACCESS_TOKEN=$(gcloud auth application-default print-access-token)
curl -sSf -X POST "https://notebook.googleapis.com/mcp" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "x-goog-user-project: $PROJECT_ID" \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/call" \
  -H "Mcp-Name: list_notebooks" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_notebooks","arguments":{"pageSize":5},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}' | jq -e '.result.structuredContent'
```

## 5. Avoiding 7-day refresh token expiry

If the GCP OAuth app is left in **Testing** mode on Google Auth Platform → **Audience**, Google automatically expires refresh tokens after **7 days**. Switching Publishing status to **In production** (no Google verification is required for personal apps under 100 users) and re-running step 3 once produces a long-lived refresh token that persists until revoked or unused for 6+ months.

## 6. `gnotebook` ingestion & sync pipeline CLI

Because the MCP endpoint (`https://notebook.googleapis.com/mcp`) does not expose file uploads (`UploadSource`), client-side deduplication, directory bundling, or rate pacing, use `~/.local/bin/gnotebook` (symlinked to `~/.config/gemini/bin/gnotebook`) for automated pipelines on Air and Pro:

```bash
# Verify ADC, token refresh, MCP config, and live API reachability
gnotebook doctor

# Idempotently create/reuse a notebook and ingest mixed sources (PDFs, dirs, URLs, YouTube)
gnotebook ingest "Riemann Reading" ~/.arxiv-papers/ https://en.wikipedia.org/wiki/Riemann_hypothesis --dry-run
gnotebook ingest "Riemann Reading" ~/.arxiv-papers/ https://en.wikipedia.org/wiki/Riemann_hypothesis

# Pipe generated Markdown straight from an agent or command
cat report.md | gnotebook ingest "Weekly Briefings" --stdin --name "2026-W48 Digest"

# Generate and push a work-board briefing ready for an Audio Overview
gnotebook digest --board dotfiles --notebook "Weekly Briefings" --days 7

# Declarative multi-notebook sync from a manifest JSON
gnotebook sync ./notebooks-manifest.json
```

### Design & empirically verified guardrails

- **Direct ADC auth:** Refreshes tokens directly from `~/.config/gcloud/application_default_credentials.json` (no `gcloud` subprocess per request).
- **Smart transport routing:** Inline `CreateSource` (`<= 900 KB`), simple `uploadType=media` (`<= 5 MiB` binaries), and two-step resumable `UploadSource` (`> 900 KB` Markdown bundles or `5–200 MiB` binaries, omitting `Authorization` on the signed `X-Goog-Upload-URL`).
- **CJK-aware bundling & secret exclusion:** Directory ingestion wraps code/Markdown in structured TOC bundles (default `150,000` units = Latin words + CJK chars, hard cap `450,000`) and automatically skips `.env*`, keys/certs, credentials, `.git/`, `node_modules/`, and lockfiles.
- **Strict idempotency:** Tracks ingested `(notebook, key, sha256)` in `0600` `~/.local/share/gnotebook/state.json` and checks live `list_sources` so re-runs never duplicate sources (use `--allow-update` to append a dated version tag `[vYYYY-MM-DD-xxxxxx]` when content changes).
- **Unreachable-URL fallback:** Non-HTML `.md`/`.txt` URLs and `code: 9` unreachable web pages automatically fall back to local HTTP fetch + Markdown ingestion (`--no-fallback-fetch` disables).
- **Rate pacing & retries:** Paces writes at `<= 18 RPM` (official cap: `20 RPM`) and honors `429` `RetryInfo.retryDelay` with jitter.

## 7. `gnotebook-monitor` official API release monitor

Because the Gemini Notebook API is in Public Preview (with delete, Drive URLs, Q&A retrieval, and artifact generation on Google's roadmap), `~/.local/bin/gnotebook-monitor` watches Google's public unauthenticated endpoints so it never depends on the 7-day OAuth refresh token:

- `https://notebook.googleapis.com/$discovery/rest?version=v1` (methods, schemas/fields, OAuth scopes — ignores revision-only doc bumps)
- New API version probes (`v1alpha`, `v1beta`, `v1beta1`, `v2`)
- `https://developers.google.com/notebook/docs/mcp` (Available MCP tools table)
- `https://developers.google.com/notebook/docs/roadmap` (Roadmap items)

```bash
# Run a check manually (first run seeds baseline in ~/.local/state/gnotebook-monitor/state.json)
gnotebook-monitor check

# Inspect current baseline snapshot and LaunchAgent state
gnotebook-monitor status

# Install/uninstall the weekly macOS LaunchAgent (com.syz51.gnotebook-monitor)
gnotebook-monitor install
gnotebook-monitor uninstall
```

When a structural API, MCP tool, version, or roadmap change appears, `gnotebook-monitor` checks the `dotfiles` work board for an existing matching change key (preventing duplicates across Macs), files a ready `p2` integration task on `dotfiles`, and sends a macOS notification.
