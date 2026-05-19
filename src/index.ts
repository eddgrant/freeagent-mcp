#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { FreeAgentClient } from './freeagent-client.js';
import { installLifecycleHandlers, type Closable } from './lifecycle.js';
import { setupStaging, cleanupStaging, type StagingState } from './evidence-staging.js';
import { toolSchemas } from './tool-schemas.js';
import {
  buildLogExpensesPromptBody,
  PROMPT_NAME as LOG_EXPENSES_PROMPT_NAME,
  PROMPT_DESCRIPTION as LOG_EXPENSES_PROMPT_DESCRIPTION,
} from './prompts/log-expenses.js';
import {
  normaliseProjectIds,
  normaliseNumberingSource,
  buildInvoicePayload,
  ORG_WIDE_NUMBERING,
  type InvoiceToolInput,
} from './validation.js';
import {
  buildExpensePayload,
  buildExpenseUpdatePayload,
  readStagedAttachment,
  type ResolvedExpenseRefs,
} from './expenses.js';
import { resolveCategory, resolveUser, resolveProject } from './resolvers.js';
import { findEngineOptionsForDate, resolveEngine, buildMileagePayload, type ResolvedEngine } from './mileage.js';
import type { MileageSettings, InvoiceAttributes } from './types.js';
import {
  deriveImplicatedProjectUrls,
  findUnbilledTimeslipsForProjects,
  formatUnbilledRefusal,
  inspectProjectsForNumbering,
  formatNumberingRefusal,
  formatNumberingPickIneligible,
  type NumberingCandidate,
  type UnbilledByProject,
} from './invoice-timeslip-check.js';

export interface FreeAgentServerOptions {
  /** Override evidence staging state. Default: setupStaging() runs and
   *  creates a real session subdirectory. Tests pass an opt-out state
   *  ({ ready: false, ... }) to avoid filesystem side effects. */
  stagingState?: StagingState;
}

// A tool result carrying a JSON-stringified payload.
const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});
// A tool result carrying a plain-text message.
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
// A business-logic refusal (not an exception) — surfaced with isError.
const refusal = (s: string) => ({
  content: [{ type: 'text' as const, text: s }],
  isError: true as const,
});

export class FreeAgentServer {
  private server: McpServer;
  private client: FreeAgentClient;
  private stagingState: StagingState;

  constructor(client?: FreeAgentClient, options?: FreeAgentServerOptions) {
    console.error('[Setup] Initializing FreeAgent MCP server...');

    if (client) {
      this.client = client;
    } else {
      const CLIENT_ID = process.env.FREEAGENT_CLIENT_ID;
      const CLIENT_SECRET = process.env.FREEAGENT_CLIENT_SECRET;
      const ACCESS_TOKEN = process.env.FREEAGENT_ACCESS_TOKEN;
      const REFRESH_TOKEN = process.env.FREEAGENT_REFRESH_TOKEN;

      if (!CLIENT_ID || !CLIENT_SECRET || !ACCESS_TOKEN || !REFRESH_TOKEN) {
        throw new Error('Missing required environment variables for FreeAgent authentication');
      }

      this.client = new FreeAgentClient({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
      });
    }

    this.stagingState = options?.stagingState ?? setupStaging();

    this.server = new McpServer({ name: 'freeagent-mcp', version: '0.1.0' });

    this.registerTools();
    this.registerPrompts();

    this.server.server.onerror = (error) => console.error('[MCP Error]', error);

    // Wrap close so cleanup runs as part of the existing shutdown path:
    // clean up the staging dir first, then close the MCP server.
    const closableWithStaging: Closable = {
      close: async () => {
        cleanupStaging(this.stagingState);
        await this.server.close();
      },
    };
    installLifecycleHandlers({ server: closableWithStaging });
  }

  // Tool input is validated by the SDK against each tool's Zod schema
  // before the handler runs, so handlers receive args already typed and
  // checked — no per-handler shape/type/enum guards. Handlers throw on
  // failure (the SDK converts that to an isError result); business-logic
  // refusals return refusal() explicitly.
  private registerTools() {
    const s = this.server;
    const c = this.client;

    // ---- Timeslips --------------------------------------------------------

    s.registerTool('list_timeslips',
      { description: 'List timeslips with optional filtering', inputSchema: toolSchemas.list_timeslips },
      async (args) => json(await c.listTimeslips(args)),
    );

    s.registerTool('get_timeslip',
      { description: 'Get a single timeslip by ID', inputSchema: toolSchemas.get_timeslip },
      async ({ id }) => json(await c.getTimeslip(id)),
    );

    s.registerTool('create_timeslip',
      { description: 'Create a new timeslip', inputSchema: toolSchemas.create_timeslip },
      async (args) => json(await c.createTimeslip(args)),
    );

    s.registerTool('update_timeslip',
      { description: 'Update an existing timeslip', inputSchema: toolSchemas.update_timeslip },
      async ({ id, ...updates }) => json(await c.updateTimeslip(id, updates)),
    );

    s.registerTool('delete_timeslip',
      { description: 'Delete a timeslip', inputSchema: toolSchemas.delete_timeslip },
      async ({ id }) => { await c.deleteTimeslip(id); return text('Timeslip deleted successfully'); },
    );

    s.registerTool('start_timer',
      { description: 'Start a timer for a timeslip', inputSchema: toolSchemas.start_timer },
      async ({ id }) => json(await c.startTimer(id)),
    );

    s.registerTool('stop_timer',
      { description: 'Stop a running timer for a timeslip', inputSchema: toolSchemas.stop_timer },
      async ({ id }) => json(await c.stopTimer(id)),
    );

    s.registerTool('create_timeslips',
      { description: 'Batch create multiple timeslips at once', inputSchema: toolSchemas.create_timeslips },
      async ({ timeslips }) => {
        // Deduplicate against existing timeslips for the date range.
        const dates = timeslips.map(t => t.dated_on);
        const minDate = dates.reduce((a, b) => (a < b ? a : b));
        const maxDate = dates.reduce((a, b) => (a > b ? a : b));
        const existing = await c.listTimeslips({ from_date: minDate, to_date: maxDate, user: timeslips[0].user });

        const duplicates: string[] = [];
        const newTimeslips = timeslips.filter(t => {
          const isDup = existing.some(e =>
            e.task === t.task && e.project === t.project && e.user === t.user && e.dated_on === t.dated_on);
          if (isDup) duplicates.push(t.dated_on);
          return !isDup;
        });

        if (newTimeslips.length === 0) {
          return text(`All ${timeslips.length} timeslips already exist (dates: ${duplicates.join(', ')}). No timeslips created.`);
        }
        const created = await c.createTimeslips(newTimeslips);
        let message = JSON.stringify(created, null, 2);
        if (duplicates.length > 0) {
          message += `\n\nSkipped ${duplicates.length} duplicate timeslip(s) for dates: ${duplicates.join(', ')}`;
        }
        return text(message);
      },
    );

    // ---- Projects & tasks -------------------------------------------------

    s.registerTool('list_projects',
      { description: 'List projects with optional filtering', inputSchema: toolSchemas.list_projects },
      async (args) => json(await c.listProjects(args)),
    );

    s.registerTool('create_project',
      { description: 'Create a new project', inputSchema: toolSchemas.create_project },
      async (args) => json(await c.createProject(args)),
    );

    s.registerTool('create_task',
      { description: 'Create a new task for a project', inputSchema: toolSchemas.create_task },
      async ({ project, ...task }) => json(await c.createTask(project, task)),
    );

    s.registerTool('list_tasks',
      { description: 'List tasks, optionally filtered by project', inputSchema: toolSchemas.list_tasks },
      async (args) => json(await c.listTasks(args)),
    );

    s.registerTool('list_users',
      { description: 'List users in the organisation', inputSchema: toolSchemas.list_users },
      async (args) => json(await c.listUsers(args)),
    );

    s.registerTool('get_current_user',
      { description: 'Get the currently authenticated user', inputSchema: toolSchemas.get_current_user },
      async () => json(await c.getCurrentUser()),
    );

    // ---- Invoices ---------------------------------------------------------

    s.registerTool('create_invoice',
      {
        description: 'Create a new invoice spanning one or more projects. Refuses to create the invoice if (a) unbilled timeslips exist on any implicated project and the caller has not handled them explicitly (pass include_timeslips to attach them, or omit_unbilled_timeslips: true to leave them), or (b) more than one project on the invoice has its own per-project invoice sequence — in which case the caller must pick one via numbering_source.',
        inputSchema: toolSchemas.create_invoice,
      },
      async (args) => {
        const projectIds = args.project_ids ? normaliseProjectIds(args.project_ids) : [];
        const numberingSource = args.numbering_source !== undefined
          ? normaliseNumberingSource(args.numbering_source, projectIds)
          : undefined;
        const input: InvoiceToolInput = {
          contact: args.contact,
          dated_on: args.dated_on,
          payment_terms_in_days: args.payment_terms_in_days ?? 30,
          comments: args.comments,
          ec_status: args.ec_status,
          include_timeslips: args.include_timeslips,
          invoice_items: args.invoice_items,
          project_ids: projectIds.length > 0 ? projectIds : undefined,
          numbering_source: numberingSource,
        };

        // Detect-and-refuse #1 (unbilled timeslips) and #2 (numbering source
        // for multi-project invoices) are independent — run both and surface
        // every blocker at once so the agent collects all decisions in one turn.
        const shouldCheckUnbilled = !input.include_timeslips && args.omit_unbilled_timeslips !== true && projectIds.length > 0;
        const shouldCheckNumbering = projectIds.length > 1 && numberingSource !== ORG_WIDE_NUMBERING;

        const [unbilled, candidates] = await Promise.all([
          shouldCheckUnbilled
            ? findUnbilledTimeslipsForProjects(c, deriveImplicatedProjectUrls({ projectIds }))
            : Promise.resolve([] as UnbilledByProject[]),
          shouldCheckNumbering
            ? inspectProjectsForNumbering(c, projectIds)
            : Promise.resolve([] as NumberingCandidate[]),
        ]);

        const refusals: string[] = [];
        if (unbilled.length > 0) refusals.push(formatUnbilledRefusal(unbilled));
        if (shouldCheckNumbering) {
          if (!numberingSource) {
            refusals.push(formatNumberingRefusal(candidates));
          } else {
            const picked = candidates.find(cand => cand.id === numberingSource);
            if (picked && !picked.usesProjectInvoiceSequence) {
              refusals.push(formatNumberingPickIneligible(picked, candidates));
            }
          }
        }
        if (refusals.length > 0) return refusal(refusals.join('\n\n---\n\n'));

        return json(await c.createInvoice(buildInvoicePayload(input)));
      },
    );

    s.registerTool('list_invoices',
      { description: 'List invoices with optional filtering', inputSchema: toolSchemas.list_invoices },
      async (args) => json(await c.listInvoices(args)),
    );

    s.registerTool('get_invoice',
      { description: 'Get a single invoice by ID', inputSchema: toolSchemas.get_invoice },
      async ({ id }) => json(await c.getInvoice(id)),
    );

    s.registerTool('update_invoice',
      {
        description: 'Update an existing invoice. Use this to modify line item descriptions, payment terms, comments, or to extend an existing single-project invoice to span additional projects via project_ids. When project_ids is set, the same unbilled-timeslip safety check as create_invoice applies. The invoice\'s reference number cannot be changed via update — numbering_source is set at creation only.',
        inputSchema: toolSchemas.update_invoice,
      },
      async ({ id, ...updates }) => {
        const invoiceUpdates: Partial<InvoiceAttributes> = {};
        if (updates.payment_terms_in_days !== undefined) invoiceUpdates.payment_terms_in_days = updates.payment_terms_in_days;
        if (updates.comments !== undefined) invoiceUpdates.comments = updates.comments;
        if (updates.ec_status !== undefined) invoiceUpdates.ec_status = updates.ec_status;
        if (updates.include_timeslips !== undefined) invoiceUpdates.include_timeslips = updates.include_timeslips;
        if (updates.invoice_items !== undefined) invoiceUpdates.invoice_items = updates.invoice_items;

        if (updates.project_ids !== undefined) {
          const projectIds = normaliseProjectIds(updates.project_ids);
          invoiceUpdates.project_ids = projectIds;

          // Extending project scope without an active timeslip directive
          // triggers the same unbilled-timeslip refusal as create_invoice.
          if (!invoiceUpdates.include_timeslips && updates.omit_unbilled_timeslips !== true && projectIds.length > 0) {
            const unbilled = await findUnbilledTimeslipsForProjects(c, deriveImplicatedProjectUrls({ projectIds }));
            if (unbilled.length > 0) return refusal(formatUnbilledRefusal(unbilled));
          }
        }
        return json(await c.updateInvoice(id, invoiceUpdates));
      },
    );

    s.registerTool('download_invoice_pdf',
      { description: 'Download an invoice as a PDF. Returns base64-encoded PDF content.', inputSchema: toolSchemas.download_invoice_pdf },
      async ({ id }) => text(await c.downloadInvoicePdf(id)),
    );

    s.registerTool('delete_invoice',
      {
        description: 'Delete an invoice. If the invoice has been sent, you must pass confirm: true to acknowledge that deleting sent invoices is bad accounting practice.',
        inputSchema: toolSchemas.delete_invoice,
      },
      async ({ id, confirm }) => {
        const invoice = await c.getInvoice(id);
        if (invoice.status !== 'Draft' && confirm !== true) {
          return refusal(`Invoice ${id} has status "${invoice.status}". Deleting a non-draft invoice is bad accounting practice (per HMRC guidance). To proceed, retry with confirm: true.`);
        }
        await c.deleteInvoice(id);
        return text(`Invoice ${id} deleted successfully`);
      },
    );

    s.registerTool('mark_invoice_as_draft',
      { description: 'Transition a sent invoice back to draft status', inputSchema: toolSchemas.mark_invoice_as_draft },
      async ({ id }) => json(await c.markInvoiceAsDraft(id)),
    );

    s.registerTool('mark_invoice_as_sent',
      { description: 'Mark a draft invoice as sent', inputSchema: toolSchemas.mark_invoice_as_sent },
      async ({ id }) => json(await c.markInvoiceAsSent(id)),
    );

    // ---- Categories, bank, bills, P&L -------------------------------------

    s.registerTool('list_categories',
      { description: 'List FreeAgent categories (nominal codes) grouped by type: admin expenses, cost of sales, income, and general', inputSchema: toolSchemas.list_categories },
      async (args) => json(await c.listCategories(args)),
    );

    s.registerTool('list_bank_accounts',
      { description: 'List all bank accounts', inputSchema: toolSchemas.list_bank_accounts },
      async () => json(await c.listBankAccounts()),
    );

    s.registerTool('list_bank_transactions',
      { description: 'List bank transactions for a given bank account, with optional date filtering', inputSchema: toolSchemas.list_bank_transactions },
      async (args) => json(await c.listBankTransactions(args)),
    );

    s.registerTool('list_bank_transaction_explanations',
      { description: 'List categorised bank transaction explanations for a bank account, with optional date filtering. Each explanation links to a category and shows the gross value.', inputSchema: toolSchemas.list_bank_transaction_explanations },
      async (args) => json(await c.listBankTransactionExplanations(args)),
    );

    s.registerTool('list_bills',
      { description: 'List bills (supplier invoices) with optional filtering by date range, contact, project, and status', inputSchema: toolSchemas.list_bills },
      async (args) => json(await c.listBills(args)),
    );

    s.registerTool('get_bill',
      { description: 'Get a single bill by ID, including its line items and categories', inputSchema: toolSchemas.get_bill },
      async ({ id }) => json(await c.getBill(id)),
    );

    s.registerTool('get_profit_and_loss_summary',
      { description: 'Get a profit and loss summary for a given period. Returns income, expenses, operating profit, deductions, and retained profit. The requested period must be 12 months or less, or contained within a single accounting year.', inputSchema: toolSchemas.get_profit_and_loss_summary },
      async (args) => json(await c.getProfitAndLossSummary(args)),
    );

    // ---- Evidence staging -------------------------------------------------

    s.registerTool('get_staging_directory',
      {
        description:
          'Return the session staging directory — a folder on a shared filesystem that both ' +
          'you and this server can read. To attach a receipt to an expense, copy the file into ' +
          'this directory yourself (e.g. with `cp`) and pass the resulting path as ' +
          'attachment.evidence_path to create_expense / update_expense / create_mileage_expense. ' +
          'This is the fast, lossless route — copy the original at full quality, no base64 and ' +
          'no downscaling to save tokens. (FreeAgent still rejects attachments over 5 MB, so ' +
          'reduce a file only if it genuinely exceeds that.) Returns { ready: false, path: null } ' +
          'when the shared volume is not mounted, in which case receipt attachments are ' +
          'unavailable until it is set up (the expense can still be created without one).',
        inputSchema: toolSchemas.get_staging_directory,
      },
      async () => json({
        ready: this.stagingState.ready,
        path: this.stagingState.sessionPath,
        ...(this.stagingState.reason ? { reason: this.stagingState.reason } : {}),
      }),
    );

    // ---- Expenses ---------------------------------------------------------

    s.registerTool('list_expenses',
      { description: 'List employee expenses, with optional filtering by date range, project, view, and claimant.', inputSchema: toolSchemas.list_expenses },
      async ({ user: userFilter, ...listParams }) => {
        let expenses = await c.listExpenses(listParams);
        // The FreeAgent /expenses endpoint has no claimant filter, so apply
        // it client-side after the (paginated) fetch.
        if (userFilter !== undefined && userFilter.trim() !== '') {
          const userUrl = await resolveUser(c, userFilter);
          expenses = expenses.filter(e => e.user === userUrl);
        }
        return json(expenses);
      },
    );

    s.registerTool('get_expense',
      { description: 'Get a single expense by ID, including read-only fields such as rebilled_on_invoice, capital_asset, and attachment metadata.', inputSchema: toolSchemas.get_expense },
      async ({ id }) => json(await c.getExpense(id)),
    );

    s.registerTool('create_expense',
      {
        description:
          'Create an employee expense — money a team member spent that the company should account for. ' +
          'Pass gross_value as a POSITIVE amount; by default it is treated as out-of-pocket spending owed ' +
          'back to the claimant. Set refund_due: true only when the claimant owes money back to the company. ' +
          'category may be a name, nominal code, or URL; the claimant defaults to the authenticated user. ' +
          'For mileage claims use create_mileage_expense instead.',
        inputSchema: toolSchemas.create_expense,
      },
      async (args) => {
        const [userUrl, categoryUrl, projectUrl] = await Promise.all([
          resolveUser(c, args.user),
          resolveCategory(c, args.category),
          args.project ? resolveProject(c, args.project) : Promise.resolve(undefined),
        ]);
        const refs: ResolvedExpenseRefs = { user: userUrl, category: categoryUrl };
        if (projectUrl) refs.project = projectUrl;
        if (args.attachment) refs.attachment = readStagedAttachment(args.attachment, this.stagingState.sessionPath);
        return json(await c.createExpense(buildExpensePayload(args, refs)));
      },
    );

    s.registerTool('update_expense',
      {
        description:
          'Update an existing expense. Only the fields you supply are changed. If you change gross_value, ' +
          'pass it as a positive amount and set refund_due to match the intended direction.',
        inputSchema: toolSchemas.update_expense,
      },
      async ({ id, ...updates }) => {
        const refs: ResolvedExpenseRefs = {};
        if (updates.user) refs.user = await resolveUser(c, updates.user);
        if (updates.category) refs.category = await resolveCategory(c, updates.category);
        if (updates.project) refs.project = await resolveProject(c, updates.project);
        if (updates.attachment) refs.attachment = readStagedAttachment(updates.attachment, this.stagingState.sessionPath);

        const payload = buildExpenseUpdatePayload(updates, refs);
        if (Object.keys(payload).length === 0) {
          return refusal('No update fields supplied — nothing to change.');
        }
        return json(await c.updateExpense(id, payload));
      },
    );

    s.registerTool('delete_expense',
      {
        description: 'Delete an expense. If the expense has already been rebilled onto an invoice, you must pass confirm: true to acknowledge that deleting it leaves that invoice referencing a removed expense.',
        inputSchema: toolSchemas.delete_expense,
      },
      async ({ id, confirm }) => {
        const expense = await c.getExpense(id);
        if (expense.rebilled_on_invoice && confirm !== true) {
          return refusal(`Expense ${id} has already been rebilled onto invoice ${expense.rebilled_on_invoice}. Deleting it leaves that invoice referencing a removed expense. To proceed, retry with confirm: true.`);
        }
        await c.deleteExpense(id);
        return text(`Expense ${id} deleted successfully`);
      },
    );

    s.registerTool('create_expenses',
      {
        description:
          'Batch-create multiple expenses in a single call. FreeAgent processes the batch ' +
          'atomically — if one item is invalid the whole batch is rejected. Each item takes ' +
          'the same fields as create_expense. Categories, claimants and projects are resolved ' +
          'once per distinct value across the batch.',
        inputSchema: toolSchemas.create_expenses,
      },
      async ({ expenses }) => {
        // Memoise resolution so a batch sharing categories, claimants or
        // projects does not re-fetch the same lookup once per item.
        const cache = new Map<string, Promise<string>>();
        const memo = (key: string, fn: () => Promise<string>) => {
          if (!cache.has(key)) cache.set(key, fn());
          return cache.get(key)!;
        };
        const payloads = await Promise.all(expenses.map(async (item, i) => {
          try {
            const [userUrl, categoryUrl, projectUrl] = await Promise.all([
              memo(`u:${item.user ?? ''}`, () => resolveUser(c, item.user)),
              memo(`c:${item.category}`, () => resolveCategory(c, item.category)),
              item.project ? memo(`p:${item.project}`, () => resolveProject(c, item.project!)) : Promise.resolve(undefined),
            ]);
            const refs: ResolvedExpenseRefs = { user: userUrl, category: categoryUrl };
            if (projectUrl) refs.project = projectUrl;
            if (item.attachment) refs.attachment = readStagedAttachment(item.attachment, this.stagingState.sessionPath);
            return buildExpensePayload(item, refs);
          } catch (e) {
            throw new Error(`expenses[${i}]: ${(e as Error).message}`);
          }
        }));
        return json(await c.createExpenses(payloads));
      },
    );

    // ---- Mileage ----------------------------------------------------------

    s.registerTool('get_mileage_settings',
      {
        description:
          'Get the FreeAgent mileage settings — the valid engine types, engine sizes, and ' +
          'mileage rates, scoped by date period. Use this to discover valid engine_type and ' +
          'engine_size values before calling create_mileage_expense.',
        inputSchema: toolSchemas.get_mileage_settings,
      },
      async () => json(await c.getMileageSettings()),
    );

    s.registerTool('create_mileage_expense',
      {
        description:
          'Log a mileage claim — reimbursement for business travel in a personal vehicle. ' +
          'engine_type and engine_size are validated against the official mileage settings ' +
          'for the claim date (call get_mileage_settings to see the valid options); engine_type ' +
          'defaults to Petrol for cars and motorcycles. Bicycles need no engine fields.',
        inputSchema: toolSchemas.create_mileage_expense,
      },
      async (args) => {
        // FreeAgent's /expenses endpoint rejects the bare word "Mileage" as
        // a nominal code, so resolve it to the Mileage category URL — the
        // same name->URL resolution create_expense uses.
        const [userUrl, categoryUrl] = await Promise.all([
          resolveUser(c, args.user),
          resolveCategory(c, 'Mileage'),
        ]);

        // Engine type/size validated against the dated mileage settings.
        // Bicycles carry no engine fields; if the settings can't be fetched,
        // resolveEngine degrades to passing the caller's values through.
        let engine: ResolvedEngine = {};
        if (args.vehicle_type !== 'Bicycle') {
          let settings: MileageSettings | null = null;
          try {
            settings = await c.getMileageSettings();
          } catch (e) {
            console.error('[expenses] mileage_settings unavailable, skipping engine validation:', (e as Error).message);
          }
          const options = settings ? findEngineOptionsForDate(settings, args.dated_on) : null;
          engine = resolveEngine(options, args);
        }

        const attachment = args.attachment
          ? readStagedAttachment(args.attachment, this.stagingState.sessionPath)
          : undefined;
        return json(await c.createExpense(buildMileagePayload(args, { user: userUrl, category: categoryUrl, engine, attachment })));
      },
    );
  }

  private registerPrompts() {
    this.server.registerPrompt(
      LOG_EXPENSES_PROMPT_NAME,
      {
        description: LOG_EXPENSES_PROMPT_DESCRIPTION,
        argsSchema: {
          claimant: z.string().optional().describe('Whose expenses these are — a name, email, or "me". If omitted, defaults to the authenticated user.'),
        },
      },
      (args) => ({
        description: LOG_EXPENSES_PROMPT_DESCRIPTION,
        messages: [
          { role: 'user' as const, content: { type: 'text' as const, text: buildLogExpensesPromptBody(this.stagingState, args) } },
        ],
      }),
    );
  }

  async run(transport?: Transport) {
    const t = transport ?? new StdioServerTransport();
    await this.server.connect(t);
    console.error('FreeAgent MCP server running on stdio');
  }
}

// Only run when executed directly (not when imported by tests)
const isDirectRun = process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectRun) {
  const server = new FreeAgentServer();
  server.run().catch(console.error);
}
