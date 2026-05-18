#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { FreeAgentClient } from './freeagent-client.js';
import { TimeslipAttributes, InvoiceAttributes, ProjectAttributes } from './types.js';
import { validateId, validateTimeslipAttributes, validateInvoiceItemAttributes, validateInvoiceAttributes, validateProjectAttributes, validateTaskAttributes, normaliseProjectIds, normaliseNumberingSource, buildInvoicePayload, ORG_WIDE_NUMBERING } from './validation.js';
import { installLifecycleHandlers, type Closable } from './lifecycle.js';
import { setupStaging, cleanupStaging, type StagingState } from './evidence-staging.js';
import { stageEvidence, ALLOWED_CONTENT_TYPES } from './stage-evidence.js';
import { aggregatePatterns } from './explanation-patterns.js';
import { buildProposals } from './propose-reconciliations.js';
import { applyExplanations } from './apply-reconciliations.js';
import {
  buildReconcilePromptBody,
  PROMPT_NAME as RECONCILE_PROMPT_NAME,
  PROMPT_DESCRIPTION as RECONCILE_PROMPT_DESCRIPTION,
  PROMPT_ARGUMENTS as RECONCILE_PROMPT_ARGUMENTS,
  type ReconcilePromptArgs,
} from './prompts/reconcile.js';
import type { Evidence, ExplanationToApply } from './types.js';
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

export class FreeAgentServer {
  private server: Server;
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
        refreshToken: REFRESH_TOKEN
      });
    }

    this.stagingState = options?.stagingState ?? setupStaging();

    this.server = new Server(
      {
        name: 'freeagent-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupPromptHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);

    // Wrap server.close so cleanup runs as part of the existing shutdown
    // path. Order: clean up staging dir first, then close the MCP server.
    const closableWithStaging: Closable = {
      close: async () => {
        cleanupStaging(this.stagingState);
        await this.server.close();
      },
    };
    installLifecycleHandlers({ server: closableWithStaging });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_timeslips',
          description: 'List timeslips with optional filtering',
          inputSchema: {
            type: 'object' as const,
            properties: {
              from_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
              to_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
              updated_since: { type: 'string', description: 'ISO datetime' },
              view: {
                type: 'string',
                enum: ['all', 'unbilled', 'running'],
                description: 'Filter view type'
              },
              user: { type: 'string', description: 'Filter by user URL' },
              task: { type: 'string', description: 'Filter by task URL' },
              project: { type: 'string', description: 'Filter by project URL' },
              nested: { type: 'boolean', description: 'Include nested resources' }
            }
          }
        },
        {
          name: 'get_timeslip',
          description: 'Get a single timeslip by ID',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Timeslip ID' }
            },
            required: ['id']
          }
        },
        {
          name: 'create_timeslip',
          description: 'Create a new timeslip',
          inputSchema: {
            type: 'object' as const,
            properties: {
              task: { type: 'string', description: 'Task URL' },
              user: { type: 'string', description: 'User URL' },
              project: { type: 'string', description: 'Project URL' },
              dated_on: { type: 'string', description: 'Date (YYYY-MM-DD)' },
              hours: { type: 'string', description: 'Hours worked (e.g. "1.5")' },
              comment: { type: 'string', description: 'Optional comment' }
            },
            required: ['task', 'user', 'project', 'dated_on', 'hours']
          }
        },
        {
          name: 'update_timeslip',
          description: 'Update an existing timeslip',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Timeslip ID' },
              task: { type: 'string', description: 'Task URL' },
              user: { type: 'string', description: 'User URL' },
              project: { type: 'string', description: 'Project URL' },
              dated_on: { type: 'string', description: 'Date (YYYY-MM-DD)' },
              hours: { type: 'string', description: 'Hours worked (e.g. "1.5")' },
              comment: { type: 'string', description: 'Optional comment' }
            },
            required: ['id']
          }
        },
        {
          name: 'delete_timeslip',
          description: 'Delete a timeslip',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Timeslip ID' }
            },
            required: ['id']
          }
        },
        {
          name: 'start_timer',
          description: 'Start a timer for a timeslip',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Timeslip ID' }
            },
            required: ['id']
          }
        },
        {
          name: 'stop_timer',
          description: 'Stop a running timer for a timeslip',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Timeslip ID' }
            },
            required: ['id']
          }
        },
        {
          name: 'list_projects',
          description: 'List projects with optional filtering',
          inputSchema: {
            type: 'object' as const,
            properties: {
              view: {
                type: 'string',
                enum: ['active', 'completed', 'cancelled', 'hidden'],
                description: 'Filter by project status'
              },
              sort: { type: 'string', description: 'Sort order' },
              contact: { type: 'string', description: 'Filter by contact URL' }
            }
          }
        },
        {
          name: 'create_project',
          description: 'Create a new project',
          inputSchema: {
            type: 'object' as const,
            properties: {
              contact: { type: 'string', description: 'Contact URL' },
              name: { type: 'string', description: 'Project name' },
              status: {
                type: 'string',
                enum: ['Active', 'Completed', 'Cancelled', 'Hidden'],
                description: 'Project status'
              },
              budget: { type: 'number', description: 'Budget amount (use 0 if no budget)' },
              budget_units: {
                type: 'string',
                enum: ['Hours', 'Days', 'Monetary'],
                description: 'Budget units'
              },
              currency: { type: 'string', description: 'Currency code (e.g. "GBP", "USD")' },
              uses_project_invoice_sequence: { type: 'boolean', description: 'Use project-level invoice sequence' },
              contract_po_reference: { type: 'string', description: 'Contract/PO reference' },
              hours_per_day: { type: 'number', description: 'Hours per day (e.g. 7.5)' },
              normal_billing_rate: { type: 'string', description: 'Normal billing rate' },
              billing_period: {
                type: 'string',
                enum: ['hour', 'day'],
                description: 'Billing period'
              },
              is_ir35: { type: 'boolean', description: 'IR35 employment status' },
              starts_on: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
              ends_on: { type: 'string', description: 'End date (YYYY-MM-DD)' },
              include_unbilled_time_in_profitability: { type: 'boolean', description: 'Include unbilled time in profitability' }
            },
            required: ['contact', 'name', 'status', 'budget', 'budget_units', 'currency', 'uses_project_invoice_sequence']
          }
        },
        {
          name: 'create_task',
          description: 'Create a new task for a project',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: { type: 'string', description: 'Project URL' },
              name: { type: 'string', description: 'Task name' },
              is_billable: { type: 'boolean', description: 'Whether the task is billable' },
              status: {
                type: 'string',
                enum: ['Active', 'Completed', 'Hidden'],
                description: 'Task status'
              },
              billing_rate: { type: 'string', description: 'Billing rate' },
              billing_period: {
                type: 'string',
                enum: ['hour', 'day'],
                description: 'Billing period'
              }
            },
            required: ['project', 'name']
          }
        },
        {
          name: 'list_tasks',
          description: 'List tasks, optionally filtered by project',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: { type: 'string', description: 'Filter by project URL' },
              view: { type: 'string', description: 'Filter view type' },
              sort: { type: 'string', description: 'Sort order' }
            }
          }
        },
        {
          name: 'list_users',
          description: 'List users in the organisation',
          inputSchema: {
            type: 'object' as const,
            properties: {
              view: { type: 'string', description: 'Filter view type' }
            }
          }
        },
        {
          name: 'get_current_user',
          description: 'Get the currently authenticated user',
          inputSchema: {
            type: 'object' as const,
            properties: {}
          }
        },
        {
          name: 'create_invoice',
          description: 'Create a new invoice spanning one or more projects. Refuses to create the invoice if (a) unbilled timeslips exist on any implicated project and the caller has not handled them explicitly (pass include_timeslips to attach them, or omit_unbilled_timeslips: true to leave them), or (b) more than one project on the invoice has its own per-project invoice sequence — in which case the caller must pick one via numbering_source.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              contact: { type: 'string', description: 'Contact URL' },
              project_ids: {
                type: 'array',
                description: 'Numeric project IDs that this invoice covers. Use a single-element array for a single-project invoice; multiple entries make this a multi-project invoice. URLs are accepted in entries and converted to IDs. Order does not matter.',
                items: { type: 'string' }
              },
              numbering_source: {
                type: 'string',
                description: 'Which project\'s invoice sequence to draw the reference number from. Set to a project ID present in project_ids to use that project\'s per-project sequence, or to "org-wide" to use the organisation-wide sequence. For single-project invoices this defaults to that project. For multi-project invoices it is required if any project on the invoice has uses_project_invoice_sequence=true.'
              },
              dated_on: { type: 'string', description: 'Invoice date (YYYY-MM-DD)' },
              payment_terms_in_days: { type: 'number', description: 'Payment terms in days (default: 30)' },
              comments: { type: 'string', description: 'Additional comments' },
              ec_status: {
                type: 'string',
                enum: ['UK Non-EC', 'EC VAT Registered', 'EC VAT Moss', 'EC Non-VAT Registered', 'Non-EC'],
                description: 'EC/VAT status'
              },
              include_timeslips: {
                type: 'string',
                enum: [
                  'billed_grouped_by_timeslip',
                  'billed_grouped_by_single_timeslip',
                  'billed_grouped_by_timeslip_task',
                  'billed_grouped_by_timeslip_date'
                ],
                description: 'How to group unbilled timeslips into invoice line items. When set, all unbilled timeslips on the implicated project(s) are attached.'
              },
              omit_unbilled_timeslips: {
                type: 'boolean',
                description: 'Set to true to deliberately create the invoice without attaching unbilled timeslips that exist on the implicated project(s). Required when include_timeslips is omitted and unbilled timeslips exist.'
              },
              invoice_items: {
                type: 'array',
                description: 'Manual line items (use instead of include_timeslips for full control over descriptions)',
                items: {
                  type: 'object',
                  properties: {
                    item_type: { type: 'string', description: 'Item type (e.g. "Days", "Hours")' },
                    description: { type: 'string', description: 'Line item description' },
                    quantity: { type: 'string', description: 'Quantity' },
                    price: { type: 'string', description: 'Unit price' },
                    sales_tax_rate: { type: 'string', description: 'Sales tax rate (e.g. "20.0")' }
                  },
                  required: ['item_type', 'description', 'quantity', 'price']
                }
              }
            },
            required: ['contact', 'dated_on']
          }
        },
        {
          name: 'list_invoices',
          description: 'List invoices with optional filtering',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: { type: 'string', description: 'Filter by project URL' },
              contact: { type: 'string', description: 'Filter by contact URL' },
              view: {
                type: 'string',
                enum: ['recent_open_or_overdue', 'open_or_overdue', 'draft', 'scheduled_to_email', 'thank_you_emails', 'reminders', 'overdue'],
                description: 'Filter view type'
              },
              sort: { type: 'string', description: 'Sort order' },
              updated_since: { type: 'string', description: 'Only return invoices updated after this ISO datetime (e.g. 2026-03-01T00:00:00.000Z)' }
            }
          }
        },
        {
          name: 'get_invoice',
          description: 'Get a single invoice by ID',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Invoice ID' }
            },
            required: ['id']
          }
        },
        {
          name: 'update_invoice',
          description: 'Update an existing invoice. Use this to modify line item descriptions, payment terms, comments, or to extend an existing single-project invoice to span additional projects via project_ids. When project_ids is set, the same unbilled-timeslip safety check as create_invoice applies. The invoice\'s reference number cannot be changed via update — numbering_source is set at creation only.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Invoice ID' },
              payment_terms_in_days: { type: 'number', description: 'Payment terms in days' },
              comments: { type: 'string', description: 'Additional comments' },
              ec_status: {
                type: 'string',
                enum: ['UK Non-EC', 'EC VAT Registered', 'EC VAT Moss', 'EC Non-VAT Registered', 'Non-EC'],
                description: 'EC/VAT status'
              },
              project_ids: {
                type: 'array',
                description: 'Numeric project IDs that this invoice should cover. Pass the full set (existing + extras); URLs accepted and converted to IDs. Order does not matter.',
                items: { type: 'string' }
              },
              include_timeslips: {
                type: 'string',
                enum: [
                  'billed_grouped_by_timeslip',
                  'billed_grouped_by_single_timeslip',
                  'billed_grouped_by_timeslip_task',
                  'billed_grouped_by_timeslip_date'
                ],
                description: 'When extending the invoice with project_ids, set this to attach unbilled timeslips from the newly added project(s).'
              },
              omit_unbilled_timeslips: {
                type: 'boolean',
                description: 'When extending the invoice with project_ids, set to true to deliberately leave unbilled timeslips on the added project(s) untouched.'
              },
              invoice_items: {
                type: 'array',
                description: 'Updated line items. Include "id" (from invoice_item URL) to update an existing item, or omit "id" to add a new item. Set "_destroy": 1 to delete an item.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Invoice item ID (from URL) - required to update an existing item' },
                    position: { type: 'number', description: 'Line item position (starting at 1)' },
                    item_type: { type: 'string', description: 'Item type (e.g. "Days", "Hours")' },
                    description: { type: 'string', description: 'Line item description/details' },
                    quantity: { type: 'string', description: 'Quantity' },
                    price: { type: 'string', description: 'Unit price' },
                    sales_tax_rate: { type: 'string', description: 'Sales tax rate (e.g. "20.0")' },
                    _destroy: { type: 'number', description: 'Set to 1 to delete this line item' }
                  },
                  required: ['item_type', 'description', 'quantity', 'price']
                }
              }
            },
            required: ['id']
          }
        },
        {
          name: 'download_invoice_pdf',
          description: 'Download an invoice as a PDF. Returns base64-encoded PDF content.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Invoice ID' }
            },
            required: ['id']
          }
        },
        {
          name: 'delete_invoice',
          description: 'Delete an invoice. If the invoice has been sent, you must pass confirm: true to acknowledge that deleting sent invoices is bad accounting practice.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Invoice ID' },
              confirm: { type: 'boolean', description: 'Required when invoice status is not Draft. Confirms intent to delete a sent/non-draft invoice.' }
            },
            required: ['id']
          }
        },
        {
          name: 'mark_invoice_as_draft',
          description: 'Transition a sent invoice back to draft status',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Invoice ID' }
            },
            required: ['id']
          }
        },
        {
          name: 'mark_invoice_as_sent',
          description: 'Mark a draft invoice as sent',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Invoice ID' }
            },
            required: ['id']
          }
        },
        {
          name: 'list_categories',
          description: 'List FreeAgent categories (nominal codes) grouped by type: admin expenses, cost of sales, income, and general',
          inputSchema: {
            type: 'object' as const,
            properties: {
              sub_accounts: { type: 'boolean', description: 'Return sub-accounts instead of top-level accounts' }
            }
          }
        },
        {
          name: 'list_bank_accounts',
          description: 'List all bank accounts',
          inputSchema: {
            type: 'object' as const,
            properties: {}
          }
        },
        {
          name: 'list_bank_transactions',
          description: 'List bank transactions for a given bank account, with optional date filtering',
          inputSchema: {
            type: 'object' as const,
            properties: {
              bank_account: { type: 'string', description: 'Bank account URL (required)' },
              from_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
              to_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
              updated_since: { type: 'string', description: 'ISO datetime' },
              view: {
                type: 'string',
                enum: ['all', 'unexplained', 'explained', 'manual', 'imported', 'marked_for_review'],
                description: 'Filter view type'
              }
            },
            required: ['bank_account']
          }
        },
        {
          name: 'list_bank_transaction_explanations',
          description: 'List categorised bank transaction explanations for a bank account, with optional date filtering. Each explanation links to a category and shows the gross value.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              bank_account: { type: 'string', description: 'Bank account URL (required)' },
              from_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
              to_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
              updated_since: { type: 'string', description: 'ISO datetime' }
            },
            required: ['bank_account']
          }
        },
        {
          name: 'list_bills',
          description: 'List bills (supplier invoices) with optional filtering by date range, contact, project, and status',
          inputSchema: {
            type: 'object' as const,
            properties: {
              from_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
              to_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
              updated_since: { type: 'string', description: 'ISO datetime' },
              contact: { type: 'string', description: 'Filter by contact/supplier URL' },
              project: { type: 'string', description: 'Filter by project URL' },
              view: {
                type: 'string',
                enum: ['all', 'open', 'overdue', 'open_or_overdue', 'paid', 'recurring', 'hire_purchase', 'cis'],
                description: 'Filter by bill status'
              },
              nested_bill_items: { type: 'boolean', description: 'Include bill line items in response' }
            }
          }
        },
        {
          name: 'get_bill',
          description: 'Get a single bill by ID, including its line items and categories',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Bill ID' }
            },
            required: ['id']
          }
        },
        {
          name: 'get_profit_and_loss_summary',
          description: 'Get a profit and loss summary for a given period. Returns income, expenses, operating profit, deductions, and retained profit. The requested period must be 12 months or less, or contained within a single accounting year.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              from_date: { type: 'string', description: 'Period start date (YYYY-MM-DD). Defaults to accounting year start if omitted.' },
              to_date: { type: 'string', description: 'Period end date (YYYY-MM-DD). Defaults to today if omitted.' },
              accounting_period: { type: 'string', description: 'Accounting period in YYYY/YY format (e.g. "2025/26"). Alternative to from_date/to_date.' }
            }
          }
        },
        {
          name: 'create_timeslips',
          description: 'Batch create multiple timeslips at once',
          inputSchema: {
            type: 'object' as const,
            properties: {
              timeslips: {
                type: 'array',
                description: 'Array of timeslip objects to create',
                items: {
                  type: 'object',
                  properties: {
                    task: { type: 'string', description: 'Task URL' },
                    user: { type: 'string', description: 'User URL' },
                    project: { type: 'string', description: 'Project URL' },
                    dated_on: { type: 'string', description: 'Date (YYYY-MM-DD)' },
                    hours: { type: 'string', description: 'Hours worked (e.g. "1.5")' },
                    comment: { type: 'string', description: 'Optional comment' }
                  },
                  required: ['task', 'user', 'project', 'dated_on', 'hours']
                }
              }
            },
            required: ['timeslips']
          }
        },
        {
          name: 'stage_evidence',
          description:
            'Stage a single evidence file in the session staging directory for later attachment ' +
            'to a reconciliation. Accepts base64 bytes (≤5 MB) and returns the on-disk path to ' +
            'pass into apply_reconciliations. Use once per attachment immediately before calling ' +
            'apply_reconciliations — bytes pass through model context only during this call. ' +
            'Requires the shared evidence volume to be mounted; returns ' +
            '{ ok: false, error: { code: "staging_volume_not_mounted" } } if not. ' +
            'Returns a structured { ok: true | false, ... } result; never throws for business-logic errors.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              data: { type: 'string', description: 'Base64-encoded file bytes (≤5 MB decoded).' },
              file_name: { type: 'string', description: 'Suggested filename. Server sanitises and prefixes with a random suffix to avoid collisions.' },
              content_type: {
                type: 'string',
                description: 'MIME type. Must be one of: image/jpeg, image/png, image/gif, application/pdf. Magic bytes are verified against this claim.',
                enum: [...ALLOWED_CONTENT_TYPES],
              },
            },
            required: ['data', 'file_name', 'content_type'],
          },
        },
        {
          name: 'apply_reconciliations',
          description:
            'Apply a batch of approved reconciliations to FreeAgent. Best-effort: each ' +
            'explanation is processed independently and reported in the result map ' +
            '(posted/skipped/failed). Idempotent against re-runs via per-explanation ' +
            '`idempotency_key` (sha256 of canonical fields including description) — replayed ' +
            'calls match existing explanations and skip with `duplicate_of_existing_explanation`. ' +
            'ALWAYS REQUIRE EXPLICIT USER APPROVAL BEFORE CALLING. FreeAgent has no draft state — ' +
            'a posted explanation in a closed VAT period cannot be deleted via the API. ' +
            'V1 SCOPE: refuses foreign-currency, transfers, refunds (these go in `failed[]`).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              explanations: {
                type: 'array',
                description: 'Up to 100 ExplanationToApply objects. Each carries the bank_transaction URL, dated_on, gross_value, category | paid_bill | paid_invoice, optional VAT/project/description, optional attachment.evidence_path (must be under the session staging dir from propose_reconciliations.staging.path), optional marked_for_review (default true if confidence <0.9), and a stable idempotency_key (sha256 hex over canonical JSON of bank_transaction|gross_value|dated_on|one_of(category,paid_bill,paid_invoice)|description).',
                items: { type: 'object' },
              },
            },
            required: ['explanations'],
          },
        },
        {
          name: 'propose_reconciliations',
          description:
            'Propose reconciliations for unexplained bank transactions on a given account and date range. ' +
            'Read-only — does NOT write to FreeAgent. Returns proposals with category/VAT/project pre-filled ' +
            'based on the user\'s prior reconciliation history (recurring payments are detected and flagged ' +
            'as high-confidence). Pass `evidence` collected from external search MCPs to refine confidence ' +
            'and seed attachments on matching transactions. Inter-account transfers and likely refunds are ' +
            'detected from history and surfaced in `notes[]` rather than proposed (deferred to v1.x). ' +
            'V1 SCOPE: same-currency expenses only.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              bank_account: { type: 'string', description: 'Bank account URL (e.g. https://api.freeagent.com/v2/bank_accounts/123) or numeric ID.' },
              from_date: { type: 'string', description: 'Inclusive start date (YYYY-MM-DD).' },
              to_date: { type: 'string', description: 'Inclusive end date (YYYY-MM-DD).' },
              evidence: {
                type: 'array',
                description: 'Optional list of Evidence objects gathered from external search MCPs. Each carries source, ref_id, file_name, content_type, and an extracted bag (dated_on, gross_value, etc.). Re-call propose_reconciliations with this populated to see refined proposals + match_confidence on each evidence item.',
                items: { type: 'object' },
              },
              limit: { type: 'number', description: 'Max unexplained transactions to consider. Default 50, capped at 200. The response sets `truncated: true` if more existed.' },
            },
            required: ['bank_account', 'from_date', 'to_date'],
          },
        }
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error(`[Tool] Executing ${request.params.name}:`, request.params.arguments);

      try {
        switch (request.params.name) {
          case 'list_timeslips': {
            const timeslips = await this.client.listTimeslips(request.params.arguments);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(timeslips, null, 2) }]
            };
          }

          case 'get_timeslip': {
            const { id: rawId } = request.params.arguments as { id: string };
            const id = validateId(rawId);
            const timeslip = await this.client.getTimeslip(id);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(timeslip, null, 2) }]
            };
          }

          case 'create_timeslip': {
            const attributes = validateTimeslipAttributes(request.params.arguments);
            const timeslip = await this.client.createTimeslip(attributes);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(timeslip, null, 2) }]
            };
          }

          case 'update_timeslip': {
            const { id: rawId, ...updates } = request.params.arguments as { id: string } & Record<string, unknown>;
            const id = validateId(rawId);
            // Only include valid update fields
            const validUpdates: Partial<TimeslipAttributes> = {};
            if (typeof updates.task === 'string') validUpdates.task = updates.task;
            if (typeof updates.user === 'string') validUpdates.user = updates.user;
            if (typeof updates.project === 'string') validUpdates.project = updates.project;
            if (typeof updates.dated_on === 'string') validUpdates.dated_on = updates.dated_on;
            if (typeof updates.hours === 'string') validUpdates.hours = updates.hours;
            if (typeof updates.comment === 'string') validUpdates.comment = updates.comment;

            const timeslip = await this.client.updateTimeslip(id, validUpdates);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(timeslip, null, 2) }]
            };
          }

          case 'delete_timeslip': {
            const { id: rawId } = request.params.arguments as { id: string };
            const id = validateId(rawId);
            await this.client.deleteTimeslip(id);
            return {
              content: [{ type: 'text' as const, text: 'Timeslip deleted successfully' }]
            };
          }

          case 'start_timer': {
            const { id: rawId } = request.params.arguments as { id: string };
            const id = validateId(rawId);
            const timeslip = await this.client.startTimer(id);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(timeslip, null, 2) }]
            };
          }

          case 'stop_timer': {
            const { id: rawId } = request.params.arguments as { id: string };
            const id = validateId(rawId);
            const timeslip = await this.client.stopTimer(id);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(timeslip, null, 2) }]
            };
          }

          case 'list_projects': {
            const projects = await this.client.listProjects(request.params.arguments as any);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }]
            };
          }

          case 'create_project': {
            const projectAttrs = validateProjectAttributes(request.params.arguments);
            const project = await this.client.createProject(projectAttrs);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(project, null, 2) }]
            };
          }

          case 'create_task': {
            const { project: projectUrl, task: taskAttrs } = validateTaskAttributes(request.params.arguments);
            const task = await this.client.createTask(projectUrl, taskAttrs);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }]
            };
          }

          case 'list_tasks': {
            const tasks = await this.client.listTasks(request.params.arguments as any);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(tasks, null, 2) }]
            };
          }

          case 'list_users': {
            const users = await this.client.listUsers(request.params.arguments as any);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(users, null, 2) }]
            };
          }

          case 'get_current_user': {
            const user = await this.client.getCurrentUser();
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(user, null, 2) }]
            };
          }

          case 'list_categories': {
            const params = request.params.arguments as { sub_accounts?: boolean } | undefined;
            const categories = await this.client.listCategories(params);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(categories, null, 2) }]
            };
          }

          case 'list_bank_accounts': {
            const bankAccounts = await this.client.listBankAccounts();
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(bankAccounts, null, 2) }]
            };
          }

          case 'list_bank_transactions': {
            const params = request.params.arguments as {
              bank_account: string;
              from_date?: string;
              to_date?: string;
              updated_since?: string;
              view?: 'all' | 'unexplained' | 'explained' | 'manual' | 'imported' | 'marked_for_review';
            };
            if (typeof params.bank_account !== 'string') {
              throw new Error('bank_account is required');
            }
            const transactions = await this.client.listBankTransactions(params);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(transactions, null, 2) }]
            };
          }

          case 'list_bank_transaction_explanations': {
            const params = request.params.arguments as {
              bank_account: string;
              from_date?: string;
              to_date?: string;
              updated_since?: string;
            };
            if (typeof params.bank_account !== 'string') {
              throw new Error('bank_account is required');
            }
            const explanations = await this.client.listBankTransactionExplanations(params);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(explanations, null, 2) }]
            };
          }

          case 'list_bills': {
            const bills = await this.client.listBills(request.params.arguments as any);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(bills, null, 2) }]
            };
          }

          case 'get_bill': {
            const { id: rawId } = request.params.arguments as { id: string };
            const id = validateId(rawId);
            const bill = await this.client.getBill(id);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(bill, null, 2) }]
            };
          }

          case 'create_timeslips': {
            const { timeslips: timeslipItems } = request.params.arguments as { timeslips: unknown[] };
            if (!Array.isArray(timeslipItems) || timeslipItems.length === 0) {
              throw new Error('timeslips must be a non-empty array');
            }
            const validated = timeslipItems.map((item, i) => {
              try {
                return validateTimeslipAttributes(item);
              } catch (e: any) {
                throw new Error(`Timeslip at index ${i}: ${e.message}`);
              }
            });

            // Deduplicate against existing timeslips for the date range
            const dates = validated.map(t => t.dated_on);
            const minDate = dates.reduce((a, b) => a < b ? a : b);
            const maxDate = dates.reduce((a, b) => a > b ? a : b);
            const existing = await this.client.listTimeslips({
              from_date: minDate,
              to_date: maxDate,
              user: validated[0].user,
            });

            const duplicates: string[] = [];
            const newTimeslips = validated.filter(t => {
              const isDuplicate = existing.some(e =>
                e.task === t.task &&
                e.project === t.project &&
                e.user === t.user &&
                e.dated_on === t.dated_on
              );
              if (isDuplicate) {
                duplicates.push(t.dated_on);
              }
              return !isDuplicate;
            });

            if (newTimeslips.length === 0) {
              return {
                content: [{ type: 'text' as const, text: `All ${validated.length} timeslips already exist (dates: ${duplicates.join(', ')}). No timeslips created.` }]
              };
            }

            const created = await this.client.createTimeslips(newTimeslips);
            let message = JSON.stringify(created, null, 2);
            if (duplicates.length > 0) {
              message += `\n\nSkipped ${duplicates.length} duplicate timeslip(s) for dates: ${duplicates.join(', ')}`;
            }
            return {
              content: [{ type: 'text' as const, text: message }]
            };
          }

          case 'download_invoice_pdf': {
            const { id: rawId } = request.params.arguments as { id: string };
            const id = validateId(rawId);
            const base64Content = await this.client.downloadInvoicePdf(id);
            return {
              content: [{ type: 'text' as const, text: base64Content }]
            };
          }

          case 'update_invoice': {
            const { id: rawId, ...updates } = request.params.arguments as { id: string } & Record<string, unknown>;
            const id = validateId(rawId);
            const invoiceUpdates: Partial<InvoiceAttributes> = {};
            if (typeof updates.payment_terms_in_days === 'number') invoiceUpdates.payment_terms_in_days = updates.payment_terms_in_days;
            if (typeof updates.comments === 'string') invoiceUpdates.comments = updates.comments;
            if (typeof updates.ec_status === 'string') invoiceUpdates.ec_status = updates.ec_status;
            if (typeof updates.include_timeslips === 'string') invoiceUpdates.include_timeslips = updates.include_timeslips;
            if (Array.isArray(updates.invoice_items)) {
              invoiceUpdates.invoice_items = updates.invoice_items.map((item, i) => validateInvoiceItemAttributes(item, i));
            }
            if (updates.project_ids !== undefined) {
              const projectIds = normaliseProjectIds(updates.project_ids);
              invoiceUpdates.project_ids = projectIds;

              // Detect-and-refuse on update applies when the caller is
              // extending project scope (project_ids set) without an active
              // timeslip directive. The numbering check is NOT applied on
              // update — invoice references are immutable post-creation.
              const omitUnbilled = updates.omit_unbilled_timeslips === true;
              if (!invoiceUpdates.include_timeslips && !omitUnbilled && projectIds.length > 0) {
                const projectUrls = deriveImplicatedProjectUrls({ projectIds });
                const unbilled = await findUnbilledTimeslipsForProjects(this.client, projectUrls);
                if (unbilled.length > 0) {
                  return {
                    content: [{ type: 'text' as const, text: formatUnbilledRefusal(unbilled) }],
                    isError: true,
                  };
                }
              }
            }

            const invoice = await this.client.updateInvoice(id, invoiceUpdates);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(invoice, null, 2) }]
            };
          }

          case 'create_invoice': {
            const args = request.params.arguments as Record<string, unknown>;
            const input = validateInvoiceAttributes(args);
            const omitUnbilled = args.omit_unbilled_timeslips === true;
            const projectIds = input.project_ids ?? [];

            // Detect-and-refuse #1 (unbilled timeslips on the implicated
            // project(s)) and #2 (numbering source for multi-project
            // invoices) are independent. We run both in parallel and
            // surface every blocker in a single response so the agent
            // can collect every decision from the user in one turn
            // rather than one decision per round-trip.
            //
            // Each check is bypassed when the caller has already made an
            // active choice for it: include_timeslips/omit_unbilled_timeslips
            // for #1, and numbering_source="org-wide" (always valid) for #2.
            const shouldCheckUnbilled = !input.include_timeslips && !omitUnbilled && projectIds.length > 0;
            const shouldCheckNumbering = projectIds.length > 1 && input.numbering_source !== ORG_WIDE_NUMBERING;

            const [unbilled, candidates] = await Promise.all([
              shouldCheckUnbilled
                ? findUnbilledTimeslipsForProjects(this.client, deriveImplicatedProjectUrls({ projectIds }))
                : Promise.resolve([] as UnbilledByProject[]),
              shouldCheckNumbering
                ? inspectProjectsForNumbering(this.client, projectIds)
                : Promise.resolve([] as NumberingCandidate[]),
            ]);

            const refusals: string[] = [];
            if (unbilled.length > 0) {
              refusals.push(formatUnbilledRefusal(unbilled));
            }
            if (shouldCheckNumbering) {
              if (!input.numbering_source) {
                refusals.push(formatNumberingRefusal(candidates));
              } else {
                const picked = candidates.find(c => c.id === input.numbering_source);
                if (picked && !picked.usesProjectInvoiceSequence) {
                  refusals.push(formatNumberingPickIneligible(picked, candidates));
                }
              }
            }

            if (refusals.length > 0) {
              return {
                content: [{ type: 'text' as const, text: refusals.join('\n\n---\n\n') }],
                isError: true,
              };
            }

            const wire = buildInvoicePayload(input);
            const invoice = await this.client.createInvoice(wire);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(invoice, null, 2) }]
            };
          }

          case 'list_invoices': {
            const invoices = await this.client.listInvoices(request.params.arguments as any);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(invoices, null, 2) }]
            };
          }

          case 'get_invoice': {
            const { id: rawId } = request.params.arguments as { id: string };
            const id = validateId(rawId);
            const invoice = await this.client.getInvoice(id);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(invoice, null, 2) }]
            };
          }

          case 'delete_invoice': {
            const { id: rawId, confirm } = request.params.arguments as { id: string; confirm?: boolean };
            const id = validateId(rawId);
            const invoice = await this.client.getInvoice(id);
            if (invoice.status !== 'Draft' && confirm !== true) {
              return {
                content: [{ type: 'text' as const, text: `Invoice ${id} has status "${invoice.status}". Deleting a non-draft invoice is bad accounting practice (per HMRC guidance). To proceed, retry with confirm: true.` }],
                isError: true
              };
            }
            await this.client.deleteInvoice(id);
            return {
              content: [{ type: 'text' as const, text: `Invoice ${id} deleted successfully` }]
            };
          }

          case 'mark_invoice_as_draft': {
            const { id: rawId } = request.params.arguments as { id: string };
            const id = validateId(rawId);
            const invoice = await this.client.markInvoiceAsDraft(id);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(invoice, null, 2) }]
            };
          }

          case 'mark_invoice_as_sent': {
            const { id: rawId } = request.params.arguments as { id: string };
            const id = validateId(rawId);
            const invoice = await this.client.markInvoiceAsSent(id);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(invoice, null, 2) }]
            };
          }

          case 'get_profit_and_loss_summary': {
            const params = request.params.arguments as {
              from_date?: string;
              to_date?: string;
              accounting_period?: string;
            } | undefined;
            const summary = await this.client.getProfitAndLossSummary(params);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }]
            };
          }

          case 'stage_evidence': {
            const args = request.params.arguments as {
              data?: unknown;
              file_name?: unknown;
              content_type?: unknown;
            };
            // Light schema-guard. The MCP SDK validates required+type, but
            // a defensive cast here avoids passing garbage to the pure
            // staging function and producing a less actionable error.
            if (typeof args?.data !== 'string' || typeof args?.file_name !== 'string' || typeof args?.content_type !== 'string') {
              const body = { ok: false as const, error: { code: 'invalid_arguments', message: 'data, file_name, content_type are required strings' } };
              return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
            }
            const outcome = stageEvidence(
              { data: args.data, file_name: args.file_name, content_type: args.content_type },
              { sessionPath: this.stagingState.sessionPath },
            );
            const body = outcome.ok
              ? { ok: true as const, ...outcome.result }
              : { ok: false as const, error: outcome.error };
            return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
          }

          case 'apply_reconciliations': {
            const args = request.params.arguments as { explanations?: unknown };
            if (!Array.isArray(args.explanations)) {
              return structuredError('invalid_arguments', '`explanations` must be an array of ExplanationToApply objects.');
            }
            if (args.explanations.length === 0) {
              return structuredError('invalid_arguments', '`explanations` must contain at least one item.');
            }
            if (args.explanations.length > 100) {
              return structuredError('invalid_arguments', `Batch too large: ${args.explanations.length} > 100. Split into smaller calls.`);
            }
            const explanations = args.explanations as ExplanationToApply[];
            const result = await applyExplanations(explanations, this.client, {
              stagingPath: this.stagingState.sessionPath,
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
          }

          case 'propose_reconciliations': {
            const args = request.params.arguments as {
              bank_account?: unknown;
              from_date?: unknown;
              to_date?: unknown;
              evidence?: unknown;
              limit?: unknown;
            };
            const accountId = extractBankAccountId(args.bank_account);
            if (!accountId) {
              return structuredError('invalid_arguments', 'bank_account must be a numeric ID or a /bank_accounts/<id> URL.');
            }
            if (typeof args.from_date !== 'string' || typeof args.to_date !== 'string') {
              return structuredError('invalid_arguments', 'from_date and to_date must be YYYY-MM-DD strings.');
            }
            const limit = clampLimit(args.limit, 50, 200);

            const account = await this.client.getBankAccount(accountId);

            const unexplained = await this.client.listBankTransactions({
              bank_account: account.url,
              from_date: args.from_date,
              to_date: args.to_date,
              view: 'unexplained',
            });

            // 12 months of explained-history seeds the merchant patterns.
            const historyFromDate = subtractMonths(args.from_date, 12);
            const explained = await this.client.listBankTransactions({
              bank_account: account.url,
              from_date: historyFromDate,
              to_date: args.to_date,
              view: 'explained',
            });
            const patterns = aggregatePatterns(explained);

            const truncated = unexplained.length > limit;
            const txnsToPropose = unexplained.slice(0, limit);

            const evidenceArr = Array.isArray(args.evidence) ? (args.evidence as Evidence[]) : [];

            const { proposals, notes } = buildProposals({
              unexplainedTransactions: txnsToPropose,
              patterns,
              evidence: evidenceArr,
              accountCurrency: account.currency,
            });

            const explanationsSeen = explained.reduce(
              (s, t) => s + (t.bank_transaction_explanations?.length ?? 0),
              0,
            );

            const body = {
              proposals,
              truncated,
              staging: {
                ready: this.stagingState.ready,
                path: this.stagingState.sessionPath,
                ...(this.stagingState.reason ? { reason: this.stagingState.reason } : {}),
              },
              notes,
              history_coverage: { months_analysed: 12, explanations_seen: explanationsSeen },
            };
            return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
          }

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error: any) {
        console.error(`[Error] Tool ${request.params.name} failed:`, error);
        return {
          content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
          isError: true
        };
      }
    });
  }

  private setupPromptHandlers() {
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [
        {
          name: RECONCILE_PROMPT_NAME,
          description: RECONCILE_PROMPT_DESCRIPTION,
          arguments: RECONCILE_PROMPT_ARGUMENTS,
        },
      ],
    }));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      if (request.params.name !== RECONCILE_PROMPT_NAME) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown prompt: ${request.params.name}`);
      }
      const args = (request.params.arguments ?? {}) as ReconcilePromptArgs;
      const body = buildReconcilePromptBody(this.stagingState, args);
      return {
        description: RECONCILE_PROMPT_DESCRIPTION,
        messages: [
          { role: 'user', content: { type: 'text', text: body } },
        ],
      };
    });
  }

  async run(transport?: Transport) {
    const t = transport ?? new StdioServerTransport();
    await this.server.connect(t);
    console.error('FreeAgent MCP server running on stdio');
  }
}

// Helpers used by the reconciliation tool handlers. Exported (via internal
// re-export below) so unit tests can exercise them without spinning up a
// full MCP server. Kept as plain functions because they hold no state.

function extractBankAccountId(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (/^\d+$/.test(input)) return input;
  const m = input.match(/\/bank_accounts\/(\d+)/);
  return m ? m[1] : null;
}

function clampLimit(input: unknown, defaultValue: number, max: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) return defaultValue;
  return Math.min(Math.floor(input), max);
}

function subtractMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function structuredError(code: string, message: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ ok: false, error: { code, message } }, null, 2),
    }],
  };
}

export const __test = { extractBankAccountId, clampLimit, subtractMonths };

// Only run when executed directly (not when imported by tests)
const isDirectRun = process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectRun) {
  const server = new FreeAgentServer();
  server.run().catch(console.error);
}
