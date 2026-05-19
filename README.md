# FreeAgent MCP Server

An MCP server that lets AI assistants like Claude manage your FreeAgent accounting data — track time, create invoices, and query projects.

Forked from [markpitt/freeagent-mcp](https://github.com/markpitt/freeagent-mcp).

[![Docker Image Version](https://img.shields.io/docker/v/eddgrant/freeagent-mcp/latest?label=Docker%20Hub)](https://hub.docker.com/r/eddgrant/freeagent-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Warning: This server can create, modify, and delete real financial data in your FreeAgent account, including invoices and timeslips. It has not been extensively tested and is provided as-is with no warranty. Use entirely at your own risk. The authors accept no responsibility for any data loss or unintended changes to your accounting records.**

## Example Prompts

### Timesheets
- "Create timesheets for this month on the Consulting project, 8 hours per day"
- "Show me my unbilled timeslips for February"
- "Start a timer on today's timeslip"
- "How many hours have I logged this week?"

### Invoices
- "Create an invoice for Client Foo for March, pulling in all unbilled timeslips"
- "Bill Client Foo for both the Discovery and Healthcheck projects on a single invoice"
- "Update the invoice description to include the billing period"
- "Download invoice 285 as a PDF to my invoices folder"
- "Mark the draft invoice as sent"
- "Show me all overdue invoices"

`create_invoice` and `update_invoice` accept a `project_ids` array (numeric IDs or URLs) listing which projects the invoice covers. They refuse by default in two situations, surfacing a clear menu of next steps so the agent can ask you what to do:

- The implicated project(s) have unbilled timeslips and you haven't told the tool what to do with them. Either pass `include_timeslips` (with a grouping mode) to attach them, or `omit_unbilled_timeslips: true` to leave them — this prevents accidentally invoicing a project while leaving billable time stranded.
- The invoice spans multiple projects (`project_ids.length > 1`) and you haven't picked which project's invoice sequence the new invoice should be numbered from. Pass `numbering_source` set to one of the project IDs to use that project's per-project sequence (if it has one configured), or `"org-wide"` to use the organisation-wide sequence.

### Bills, Bank Transactions & Categories
- "Show me all bills from January to March"
- "What categories have I spent money in this year?"
- "List my bank transactions for March"
- "Show me the categorised breakdown of outgoings for my current account"
- "What are my FreeAgent nominal categories?"

### Reconciliation
Type `/mcp__freeagent__reconcile` in Claude Code to start an end-to-end reconciliation flow with explicit user-approval gates. Or just ask:

- "Reconcile my Starling business account for April."
- "Propose reconciliations for unexplained transactions on the current account, last 30 days, then I'll review."

The flow:

1. `propose_reconciliations` (read-only) returns proposals with category, VAT, and project pre-filled from your reconciliation history. Recurring payments (Netflix, insurance, etc.) are detected and flagged at high confidence. Inter-account transfers and likely refunds are surfaced in `notes[]` rather than proposed (deferred to a future version).
2. If the agent has access to email/document search MCPs (Gmail, Drive, etc.) and you authorise their use, it can find supporting receipts and re-call `propose_reconciliations` with the evidence to refine confidence.
3. After your explicit approval, `stage_evidence` writes any approved attachment to the session staging directory and `apply_reconciliations` posts each explanation to FreeAgent — best-effort, with idempotency keys protecting against duplicate writes on retry.

**Attachments are opt-in** — they require a shared filesystem volume between your host and the Docker container (see [Optional: enable receipt attachments](#optional-enable-receipt-attachments) below). Reconciliations without attachments work without it; only the attachment step is gated.

### Projects & Tasks
- "Set up a new project for Client Foo with a day rate of £123"
- "Create a billable task called 'Consultancy' on the Foo project"
- "List my active projects"
- "What tasks are available on the Consulting project?"
- "Who is the current authenticated user?"

## Getting Started

You'll need Docker, a FreeAgent account with API access, and OAuth credentials from the [FreeAgent Developer Dashboard](https://dev.freeagent.com).

### 1. Get your OAuth tokens

```bash
export FREEAGENT_CLIENT_ID="your_client_id"
export FREEAGENT_CLIENT_SECRET="your_client_secret"

node scripts/get-oauth-tokens.js
```

### 2. Configure the MCP server

The easiest way to run the server is to pull the pre-built image from [Docker Hub](https://hub.docker.com/r/eddgrant/freeagent-mcp). Add the following to your Claude Code MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "freeagent": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e", "FREEAGENT_CLIENT_ID",
        "-e", "FREEAGENT_CLIENT_SECRET",
        "-e", "FREEAGENT_ACCESS_TOKEN",
        "-e", "FREEAGENT_REFRESH_TOKEN",
        "eddgrant/freeagent-mcp"
      ],
      "env": {
        "FREEAGENT_CLIENT_ID": "your_client_id",
        "FREEAGENT_CLIENT_SECRET": "your_client_secret",
        "FREEAGENT_ACCESS_TOKEN": "your_access_token",
        "FREEAGENT_REFRESH_TOKEN": "your_refresh_token"
      }
    }
  }
}
```

### Image tags

The Docker Hub image uses the following tagging convention:

| Tag | Description |
|-----|-------------|
| `latest` | Most recent build from `main` — always up to date |
| `sha-<short>` | Immutable tag for a specific commit, useful for pinning a known-good version |
| `pr-<number>` | Latest build from a pull request, for testing changes before they land on `main` |

To pin to a specific version, replace `eddgrant/freeagent-mcp` with e.g. `eddgrant/freeagent-mcp:sha-d775a51` in the config above.

### Building from source

If you prefer to build the image yourself:

```bash
git clone https://github.com/eddgrant/freeagent-mcp.git
cd freeagent-mcp
docker build -t freeagent-mcp .
```

Then replace `eddgrant/freeagent-mcp` with `freeagent-mcp` in the MCP settings above.

### Optional: enable receipt attachments

Attaching evidence files (PDF/JPEG/PNG receipts) to reconciliations needs a shared filesystem volume between your host and the Docker container. The volume is the channel through which the agent hands bytes to the FreeAgent MCP without round-tripping them through the model's context window.

Skip this if you only want category-only reconciliations or `paid_bill` linking — those work without the volume.

**One-time setup:**

```bash
# Create the staging directory on the host. IMPORTANT: do this BEFORE
# the first container run. If the directory doesn't exist when Docker
# mounts it, Docker creates it as root and the container (running as
# your user) won't be able to write to it.
mkdir -p /tmp/freeagent-mcp
```

If you've already hit that ownership trap, fix it once with:

```bash
sudo chown -R "$USER" /tmp/freeagent-mcp
```

**MCP config additions** — three extra args to your `docker run` invocation:

```jsonc
{
  "mcpServers": {
    "freeagent": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--user", "1000:1000",                                  // run as your host UID:GID
        "-v", "/tmp/freeagent-mcp:/tmp/freeagent-mcp",          // shared staging dir
        "-e", "FREEAGENT_EVIDENCE_BASE",                        // tells the server where it lives
        "-e", "FREEAGENT_CLIENT_ID",
        "-e", "FREEAGENT_CLIENT_SECRET",
        "-e", "FREEAGENT_ACCESS_TOKEN",
        "-e", "FREEAGENT_REFRESH_TOKEN",
        "eddgrant/freeagent-mcp"
      ],
      "env": {
        "FREEAGENT_EVIDENCE_BASE": "/tmp/freeagent-mcp",
        "FREEAGENT_CLIENT_ID": "...",
        "FREEAGENT_CLIENT_SECRET": "...",
        "FREEAGENT_ACCESS_TOKEN": "...",
        "FREEAGENT_REFRESH_TOKEN": "..."
      }
    }
  }
}
```

Replace `1000:1000` with the output of `id -u`:`id -g` on your host. The path can be anything writable by your user — `/tmp/freeagent-mcp`, `~/.cache/freeagent-mcp`, etc. — but it must be the same on both sides of the `-v` mount.

A per-session subdirectory is created inside `FREEAGENT_EVIDENCE_BASE` at startup and removed on shutdown; stale subdirectories from previous runs are auto-reaped after 24 hours, so you never need to clean up manually. See [`SECURITY.md`](./SECURITY.md) for the threat model around evidence handling.

**How to tell it's working:** call the `propose_reconciliations` tool. The response includes a `staging` field:
- `{ "ready": true, "path": "/tmp/freeagent-mcp/<session-id>" }` — attachments will work.
- `{ "ready": false, "path": null, "reason": "..." }` — attachments will be skipped with `staging_volume_not_mounted`. Reconciliation itself still posts.

### Testing a pre-release image interactively

When a PR builds an image (e.g. `eddgrant/freeagent-mcp:pr-42`) and you want to actually use it from a Claude Code session — without polluting your normal `~/.claude/settings.json` and without losing your stable MCP setup — use:

```bash
./scripts/test-image.sh pr-42
```

This creates a self-contained temp directory with:
- a project-scoped `.mcp.json` pointing at the image, server-named `freeagent_test` so it doesn't collide with your real `freeagent` server
- a pre-created `evidence/` staging directory mounted into the container at the same path on both sides
- a `CLAUDE.md` that Claude Code auto-loads, containing a smoke-test checklist

The script prints `cd <temp-dir> && claude` for you to run. Credentials pass through from your shell via bare `-e VAR` flags — nothing is written to disk. When you're done, `rm -rf` the temp dir.

```bash
./scripts/test-image.sh                       # latest from Docker Hub
./scripts/test-image.sh sha-abc1234           # specific commit
./scripts/test-image.sh --image fa-dev        # local image (skips Docker Hub prefix)
./scripts/test-image.sh pr-42 --no-staging    # test the unmounted-volume code path
```

The reconcile prompt is invoked via `/mcp__freeagent_test__reconcile` in that session.

Required env vars in your shell: `FREEAGENT_CLIENT_ID`, `FREEAGENT_CLIENT_SECRET`, `FREEAGENT_ACCESS_TOKEN`, `FREEAGENT_REFRESH_TOKEN`.

## Tools Reference

| Tool                                 | Description                                                                           |
|--------------------------------------|---------------------------------------------------------------------------------------|
| `list_timeslips`                     | List timeslips with optional date, project, task, user, and status filters            |
| `get_timeslip`                       | Get a single timeslip by ID                                                           |
| `create_timeslip`                    | Create a new timeslip                                                                 |
| `create_timeslips`                   | Batch create multiple timeslips (with deduplication)                                  |
| `update_timeslip`                    | Update an existing timeslip                                                           |
| `delete_timeslip`                    | Delete a timeslip                                                                     |
| `start_timer`                        | Start a timer on a timeslip                                                           |
| `stop_timer`                         | Stop a running timer                                                                  |
| `create_invoice`                     | Create an invoice, optionally attaching unbilled timeslips                            |
| `update_invoice`                     | Update invoice fields or line item descriptions                                       |
| `list_invoices`                      | List invoices with optional filters                                                   |
| `get_invoice`                        | Get a single invoice by ID                                                            |
| `download_invoice_pdf`               | Download an invoice as base64-encoded PDF                                             |
| `delete_invoice`                     | Delete an invoice (requires confirmation for non-draft invoices)                      |
| `mark_invoice_as_draft`              | Transition a sent invoice back to draft status                                        |
| `mark_invoice_as_sent`               | Transition a draft invoice to sent status                                             |
| `list_categories`                    | List FreeAgent categories (nominal codes) grouped by type                             |
| `list_bank_accounts`                 | List all bank accounts                                                                |
| `list_bank_transactions`             | List bank transactions for a bank account with optional date filtering                |
| `list_bank_transaction_explanations` | List categorised bank transaction explanations with optional date filtering            |
| `list_bills`                         | List bills (supplier invoices) with optional date, contact, project, and status filter |
| `get_bill`                           | Get a single bill by ID, including line items and categories                           |
| `create_project`                     | Create a new project                                                                  |
| `list_projects`                      | List projects with optional status filter                                             |
| `create_task`                        | Create a new task for a project                                                       |
| `list_tasks`                         | List tasks, optionally filtered by project                                            |
| `list_users`                         | List users in the organisation                                                        |
| `get_current_user`                   | Get the currently authenticated user                                                  |
| `propose_reconciliations`            | Read-only: propose reconciliations for unexplained transactions, history-aware        |
| `stage_evidence`                     | Stage a base64 evidence file in the session staging dir for later attachment          |
| `apply_reconciliations`              | Best-effort batch write of approved reconciliations (with idempotency keys)            |

## Prompts

| Prompt                          | Description                                                                       |
|---------------------------------|-----------------------------------------------------------------------------------|
| `/mcp__freeagent__reconcile`    | End-to-end reconciliation orchestration: propose → review → apply with user gates |

## Development

```bash
# Build the project
npm run build

# Watch for changes
npm run watch

# Build Docker image
docker build -t freeagent-mcp .

# Run the MCP inspector
npm run inspector
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
