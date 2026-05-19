# TASKS

## Generate an invoice which pulls in expenses from a project

_No spec yet._ (Related: the rebill flow in "Manage employee expenses" below
sets `rebill_type`/`rebill_factor`/`project` on an expense, which is what
later feeds a rebilled invoice.)

## Manage employee expenses (v1)

**Status:** Built — all four phases complete on the `expenses` branch.

### Goal

Support the FreeAgent Expenses API end-to-end with a curated MCP surface:
categories and claimants given by name, the sign convention hidden, receipts
via the shared staging volume, and a guided entry prompt.

### Scope

**In:**
- CRUD over the expense resource (`list`/`get`/`create`/`update`/`delete`).
- Money expenses, mileage claims, rebillable, recurring, and foreign-currency
  expenses; batch creation.
- History-free curation: name → URL resolution for categories and claimants;
  the out-of-pocket sign convention applied for the caller; receipts staged
  through a shared-filesystem volume.
- A `/log-expenses` guided prompt.

**Out (deferred):**
- Stock-purchase expenses — need a Stock Items API the server does not expose.
- Property expenses — only for `UkUnincorporatedLandlord` companies; the
  `property` field is passed through but gets no dedicated UX.

### The sign convention

FreeAgent stores an out-of-pocket expense as a **negative** `gross_value`
("a payment to the claimant") and money owed back as **positive** ("a refund
due"). The tools accept a positive `gross_value` plus an optional `refund_due`
flag; `applySign()` in `expenses.ts` does the negation so the trap never
reaches the caller.

### Phases

1. **Core CRUD** — types, client methods, `resolvers.ts` (category/claimant),
   `expenses.ts` (validation + payload building), the five CRUD tools.
2. **Mileage** — `get_mileage_settings` + `create_mileage_expense`, resolving
   engine type/size against the mileage settings for the claim date.
3. **Advanced modes** — rebilling, recurring, foreign currency, batch
   `create_expenses`.
4. **Guided prompt** — `/log-expenses`, a guided receipts → review → create flow.

### Key files

- `src/resolvers.ts` — shared name → URL resolvers.
- `src/expenses.ts` — curated input validation, sign convention, payload build.
- `src/freeagent-client.ts` — `/expenses` HTTP methods.
- `src/index.ts` — tool definitions + handlers.

## Ideas

* Calculate the answer to ONS surveys.
* Connect to an email provider and download invoices from emails. Attach them to transactions in FreeAgent.
* Summarise business costs over a given period, grouped by category.