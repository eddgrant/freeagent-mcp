# FreeAgent MCP Server

An MCP server that lets AI assistants like Claude manage your FreeAgent accounting data — track time, create invoices, and query projects.

Forked from [markpitt/freeagent-mcp](https://github.com/markpitt/freeagent-mcp).

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
- "Update the invoice description to include the billing period"
- "Download invoice 285 as a PDF to my invoices folder"
- "Mark the draft invoice as sent"
- "Show me all overdue invoices"

### Projects & Users
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

## Tools Reference

| Tool                    | Description                                                                |
|-------------------------|----------------------------------------------------------------------------|
| `list_timeslips`        | List timeslips with optional date, project, task, user, and status filters |
| `get_timeslip`          | Get a single timeslip by ID                                                |
| `create_timeslip`       | Create a new timeslip                                                      |
| `create_timeslips`      | Batch create multiple timeslips (with deduplication)                       |
| `update_timeslip`       | Update an existing timeslip                                                |
| `delete_timeslip`       | Delete a timeslip                                                          |
| `start_timer`           | Start a timer on a timeslip                                                |
| `stop_timer`            | Stop a running timer                                                       |
| `create_invoice`        | Create an invoice, optionally attaching unbilled timeslips                 |
| `update_invoice`        | Update invoice fields or line item descriptions                            |
| `list_invoices`         | List invoices with optional filters                                        |
| `get_invoice`           | Get a single invoice by ID                                                 |
| `download_invoice_pdf`  | Download an invoice as base64-encoded PDF                                  |
| `delete_invoice`        | Delete an invoice (requires confirmation for non-draft invoices)           |
| `mark_invoice_as_draft` | Transition a sent invoice back to draft status                             |
| `mark_invoice_as_sent`  | Transition a draft invoice to sent status                                  |
| `list_projects`         | List projects with optional status filter                                  |
| `list_tasks`            | List tasks, optionally filtered by project                                 |
| `list_users`            | List users in the organisation                                             |
| `get_current_user`      | Get the currently authenticated user                                       |

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
