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

### Expenses
Manage employee expenses — money a team member spent that the company should account for. Type `/mcp__freeagent__log-expenses` in Claude Code for a guided receipts → categorise → review → create flow with an explicit approval gate. Or just ask:

- "Log a £42 train fare to Travel on my account, dated yesterday."
- "Add a £12.50 lunch expense for Jane Smith, category Subsistence."
- "Show me all of my expenses for April."
- "Change the category on expense 305 to Travel."
- "Log a 47-mile mileage claim in my diesel car for Tuesday's client visit."

Amounts are entered as a **positive** number; out-of-pocket spending — money owed back to the claimant — is the default. Set `refund_due` when the claimant owes money back to the company instead. Categories and claimants can be given by name ("Travel", "Jane Smith") and are resolved automatically; the claimant defaults to you.

Mileage claims use `create_mileage_expense`: give the miles, vehicle type, and — for cars and motorcycles — the engine. Engine type and size are checked against the official mileage settings for the claim date, so a wrong value comes back with the valid options listed; `engine_type` defaults to Petrol.

`create_expense` and `update_expense` also handle the advanced modes: **rebillable** expenses (associate with a `project`, optionally `rebill_type` cost/markup/price), **recurring** expenses (a `recurring` frequency), and **foreign-currency** expenses (`currency` plus an optional native-currency amount). `create_expenses` posts a whole batch in one call.

Receipts attach via an opt-in staging volume (see [Optional: enable receipt attachments](#optional-enable-receipt-attachments)): stage the file with `stage_evidence`, then pass the returned path to `create_expense`.

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

Attaching evidence files (PDF/JPEG/PNG receipts) to expenses needs a shared filesystem volume between your host and the Docker container. The volume is the channel through which the agent hands bytes to the FreeAgent MCP without round-tripping them through the model's context window.

Skip this if you don't need to attach receipts — expenses without attachments work without the volume.

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

A per-session subdirectory is created inside `FREEAGENT_EVIDENCE_BASE` at startup and removed on shutdown; stale subdirectories from previous runs are auto-reaped after 24 hours, so you never need to clean up manually.

**How to tell it's working:** call `stage_evidence` with a small test file. A `{ "ok": true, "evidence_path": "..." }` response means the volume is mounted; `{ "ok": false, "error": { "code": "staging_volume_not_mounted" } }` means it isn't (expenses without attachments still work).

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

The log-expenses prompt is invoked via `/mcp__freeagent_test__log-expenses` in that session.

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
| `stage_evidence`                     | Stage a base64 receipt file in the session staging dir for later attachment            |
| `list_expenses`                      | List expenses with optional date, project, view, and claimant filters                  |
| `get_expense`                        | Get a single expense by ID                                                             |
| `create_expense`                     | Create an employee expense (category/claimant by name, receipts via staging)            |
| `update_expense`                     | Update an existing expense                                                              |
| `delete_expense`                     | Delete an expense (requires confirmation if rebilled onto an invoice)                   |
| `get_mileage_settings`               | Get valid engine types, sizes, and mileage rates by date period                         |
| `create_mileage_expense`             | Log a mileage claim (engine validated against the dated mileage settings)               |
| `create_expenses`                    | Batch-create multiple expenses in a single call                                         |

## Prompts

| Prompt                          | Description                                                                       |
|---------------------------------|-----------------------------------------------------------------------------------|
| `/mcp__freeagent__log-expenses` | Guided expense entry: gather receipts → categorise → review → create with a gate  |

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
