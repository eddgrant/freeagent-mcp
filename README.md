# FreeAgent MCP Server

An MCP (Model Context Protocol) server for managing FreeAgent accounting data. This server allows AI assistants like Claude to interact with your FreeAgent account to track time, manage invoices, and query projects and users.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

### Timeslips
- List and filter timeslips by date range, project, task, user, or billing status
- Create individual or batch timeslips (with automatic deduplication)
- Update and delete timeslips
- Start and stop timers

### Invoices
- Create invoices with manual line items or by attaching unbilled timeslips
- Update invoices (modify line item descriptions, payment terms, comments)
- List and filter invoices by status, project, or contact
- Download invoices as PDF
- Mark draft invoices as sent

### Projects, Tasks & Users
- List projects with status filtering
- List tasks, optionally filtered by project
- List users and get the current authenticated user

### Other
- Automatic OAuth token refresh

## Prerequisites

- Docker
- A FreeAgent account with API access
- OAuth credentials from the [FreeAgent Developer Dashboard](https://dev.freeagent.com)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/markpitt/freeagent-mcp.git
cd freeagent-mcp
```

2. Get your OAuth tokens:
```bash
export FREEAGENT_CLIENT_ID="your_client_id"
export FREEAGENT_CLIENT_SECRET="your_client_secret"

node scripts/get-oauth-tokens.js
```

3. Build the Docker image:
```bash
docker build -t freeagent-mcp .
```

## Configuration

Add the server to your Claude Code MCP settings (`~/.claude/settings.json`):
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
        "freeagent-mcp"
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

## Example Prompts

Here are some things you can ask Claude to do once the server is configured:

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

## Tools Reference

| Tool                   | Description                                                                |
|------------------------|----------------------------------------------------------------------------|
| `list_timeslips`       | List timeslips with optional date, project, task, user, and status filters |
| `get_timeslip`         | Get a single timeslip by ID                                                |
| `create_timeslip`      | Create a new timeslip                                                      |
| `create_timeslips`     | Batch create multiple timeslips (with deduplication)                       |
| `update_timeslip`      | Update an existing timeslip                                                |
| `delete_timeslip`      | Delete a timeslip                                                          |
| `start_timer`          | Start a timer on a timeslip                                                |
| `stop_timer`           | Stop a running timer                                                       |
| `create_invoice`       | Create an invoice, optionally attaching unbilled timeslips                 |
| `update_invoice`       | Update invoice fields or line item descriptions                            |
| `list_invoices`        | List invoices with optional filters                                        |
| `get_invoice`          | Get a single invoice by ID                                                 |
| `download_invoice_pdf` | Download an invoice as base64-encoded PDF                                  |
| `mark_invoice_as_sent` | Transition a draft invoice to sent status                                  |
| `list_projects`        | List projects with optional status filter                                  |
| `list_tasks`           | List tasks, optionally filtered by project                                 |
| `list_users`           | List users in the organisation                                             |
| `get_current_user`     | Get the currently authenticated user                                       |

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
