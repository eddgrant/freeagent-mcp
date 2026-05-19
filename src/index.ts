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
import {
  buildLogExpensesPromptBody,
  PROMPT_NAME as LOG_EXPENSES_PROMPT_NAME,
  PROMPT_DESCRIPTION as LOG_EXPENSES_PROMPT_DESCRIPTION,
  PROMPT_ARGUMENTS as LOG_EXPENSES_PROMPT_ARGUMENTS,
  type LogExpensesPromptArgs,
} from './prompts/log-expenses.js';
import {
  validateCreateExpenseInput,
  validateUpdateExpenseInput,
  buildExpensePayload,
  buildExpenseUpdatePayload,
  readStagedAttachment,
  SALES_TAX_STATUSES,
  REBILL_TYPES,
  RECURRING_FREQUENCIES,
  type ResolvedExpenseRefs,
} from './expenses.js';
import { resolveCategory, resolveUser, resolveProject } from './resolvers.js';
import {
  validateCreateMileageExpenseInput,
  findEngineOptionsForDate,
  resolveEngine,
  buildMileagePayload,
  VEHICLE_TYPES,
  type ResolvedEngine,
} from './mileage.js';
import type { MileageSettings } from './types.js';
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
          name: 'get_staging_directory',
          description:
            'Return the session staging directory — a folder on a shared filesystem that both ' +
            'you and this server can read. To attach a receipt to an expense, copy the file into ' +
            'this directory yourself (e.g. with `cp`) and pass the resulting path as ' +
            'attachment.evidence_path to create_expense / update_expense / create_mileage_expense. ' +
            'This is the fast, lossless route — copy the original at full quality, no base64 and ' +
            'no downscaling to save tokens. (FreeAgent still rejects attachments over 5 MB, so ' +
            'reduce a file only if it genuinely exceeds that.) Returns { ready: false, path: null } ' +
            'when the shared volume is not mounted; in that case fall back to stage_evidence.',
          inputSchema: {
            type: 'object' as const,
            properties: {}
          }
        },
        {
          name: 'stage_evidence',
          description:
            'FALLBACK for attaching a receipt when you cannot write to the staging directory ' +
            'yourself. Accepts base64-encoded bytes inline (≤5 MB), writes them to the session ' +
            'staging directory, and returns the on-disk path to pass as attachment.evidence_path. ' +
            'PREFER copying the file directly: call get_staging_directory, copy your file into ' +
            'that directory, and pass the path — that is faster and lossless, whereas passing ' +
            'bytes here forces large images to be downscaled to fit model context. ' +
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
          name: 'list_expenses',
          description: 'List employee expenses, with optional filtering by date range, project, view, and claimant.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              view: {
                type: 'string',
                enum: ['recent', 'recurring'],
                description: 'recent = recently dated expenses; recurring = recurring expense templates only.'
              },
              from_date: { type: 'string', description: 'Inclusive start date (YYYY-MM-DD)' },
              to_date: { type: 'string', description: 'Inclusive end date (YYYY-MM-DD)' },
              updated_since: { type: 'string', description: 'Only expenses updated after this ISO datetime' },
              project: { type: 'string', description: 'Filter by project URL (rebillable expenses)' },
              user: { type: 'string', description: 'Filter by claimant — a name, email, user URL, or "me". Applied client-side after fetching.' }
            }
          }
        },
        {
          name: 'get_expense',
          description: 'Get a single expense by ID, including read-only fields such as rebilled_on_invoice, capital_asset, and attachment metadata.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Expense ID' }
            },
            required: ['id']
          }
        },
        {
          name: 'create_expense',
          description:
            'Create an employee expense — money a team member spent that the company should account for. ' +
            'Pass gross_value as a POSITIVE amount; by default it is treated as out-of-pocket spending owed ' +
            'back to the claimant. Set refund_due: true only when the claimant owes money back to the company. ' +
            'category may be a name, nominal code, or URL; the claimant defaults to the authenticated user. ' +
            'For mileage claims use create_mileage_expense instead.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              category: { type: 'string', description: 'Expense category — a name (e.g. "Travel"), a nominal code, or a category URL. Resolved against list_categories.' },
              dated_on: { type: 'string', description: 'Date the expense was incurred (YYYY-MM-DD)' },
              gross_value: { type: 'number', description: 'Total amount including tax, as a POSITIVE number. Out-of-pocket by default — see refund_due.' },
              refund_due: { type: 'boolean', description: 'Set true when this is money the claimant owes back to the company rather than money they paid out of pocket. Default false.' },
              user: { type: 'string', description: 'Claimant — a name, email address, user URL, or "me". Defaults to the authenticated user.' },
              description: { type: 'string', description: 'Free-text description of the expense' },
              receipt_reference: { type: 'string', description: 'Receipt reference identifier' },
              sales_tax_rate: { type: 'string', description: 'VAT rate as a percentage, e.g. "20.0"' },
              sales_tax_value: { type: 'string', description: 'Exact VAT amount, as an alternative to sales_tax_rate' },
              sales_tax_status: { type: 'string', enum: [...SALES_TAX_STATUSES], description: 'VAT treatment' },
              ec_status: {
                type: 'string',
                enum: ['UK/Non-EC', 'EC Goods', 'EC Services', 'Reverse Charge'],
                description: 'EC VAT status. EC Goods / EC Services are invalid for dates on or after 2021-01-01 in Great Britain.'
              },
              currency: { type: 'string', description: 'Currency code if the expense was in a foreign currency, e.g. "USD". FreeAgent auto-converts to your native currency.' },
              native_gross_value: { type: 'number', description: 'Foreign-currency expense only: the amount in your native currency, as a POSITIVE number. Omit to let FreeAgent convert automatically.' },
              manual_sales_tax_amount: { type: 'string', description: 'Foreign-currency expense only: the reclaimable tax amount in your native currency. Note: FreeAgent ignores sales_tax_rate on foreign-currency expenses.' },
              project: { type: 'string', description: 'Project to associate the expense with — a project name, numeric ID, or URL. Required in order to rebill the cost.' },
              rebill_type: { type: 'string', enum: [...REBILL_TYPES], description: 'How to rebill the expense to the project: cost (at cost), markup (cost plus rebill_factor%), or price (a fixed price). Requires project.' },
              rebill_factor: { type: 'string', description: 'The markup percentage (rebill_type "markup") or fixed price (rebill_type "price"). Required for those rebill types.' },
              recurring: { type: 'string', enum: [...RECURRING_FREQUENCIES], description: 'Make this a recurring expense at the given frequency.' },
              recurring_end_date: { type: 'string', description: 'Date the recurrence stops (YYYY-MM-DD). Requires recurring.' },
              property: { type: 'string', description: 'Property URL — required for UkUnincorporatedLandlord companies, ignored otherwise.' },
              attachment: {
                type: 'object',
                description: 'Optional receipt. Preferred: call get_staging_directory, copy the file into that directory, and pass its path as evidence_path. Or use stage_evidence to upload base64 bytes.',
                properties: {
                  evidence_path: { type: 'string', description: 'Absolute path to the receipt file inside the session staging directory — from get_staging_directory (copy the file there yourself) or returned by stage_evidence.' },
                  file_name: { type: 'string', description: 'File name for the attachment' },
                  content_type: { type: 'string', description: 'MIME type, e.g. image/jpeg, image/png, application/pdf' },
                  description: { type: 'string', description: 'Optional attachment description' }
                },
                required: ['evidence_path', 'file_name', 'content_type']
              }
            },
            required: ['category', 'dated_on', 'gross_value']
          }
        },
        {
          name: 'update_expense',
          description:
            'Update an existing expense. Only the fields you supply are changed. If you change gross_value, ' +
            'pass it as a positive amount and set refund_due to match the intended direction.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Expense ID' },
              category: { type: 'string', description: 'New category — name, nominal code, or URL' },
              dated_on: { type: 'string', description: 'New date (YYYY-MM-DD)' },
              gross_value: { type: 'number', description: 'New total amount, as a POSITIVE number. Out-of-pocket unless refund_due is set.' },
              refund_due: { type: 'boolean', description: 'Direction for gross_value when it is being changed. Default false (out-of-pocket).' },
              user: { type: 'string', description: 'New claimant — a name, email, user URL, or "me"' },
              description: { type: 'string', description: 'New description' },
              receipt_reference: { type: 'string', description: 'New receipt reference' },
              sales_tax_rate: { type: 'string', description: 'New VAT rate, e.g. "20.0"' },
              sales_tax_value: { type: 'string', description: 'New exact VAT amount' },
              sales_tax_status: { type: 'string', enum: [...SALES_TAX_STATUSES], description: 'New VAT treatment' },
              ec_status: {
                type: 'string',
                enum: ['UK/Non-EC', 'EC Goods', 'EC Services', 'Reverse Charge'],
                description: 'New EC VAT status'
              },
              currency: { type: 'string', description: 'New currency code for a foreign-currency expense' },
              native_gross_value: { type: 'number', description: 'New native-currency amount, as a POSITIVE number (foreign-currency expense)' },
              manual_sales_tax_amount: { type: 'string', description: 'New reclaimable native-currency tax amount (foreign-currency expense)' },
              project: { type: 'string', description: 'Project to associate the expense with — a project name, numeric ID, or URL' },
              rebill_type: { type: 'string', enum: [...REBILL_TYPES], description: 'How to rebill the expense to the project' },
              rebill_factor: { type: 'string', description: 'Markup percentage or fixed price for rebill_type markup/price' },
              recurring: { type: 'string', enum: [...RECURRING_FREQUENCIES], description: 'Recurrence frequency' },
              recurring_end_date: { type: 'string', description: 'Date the recurrence stops (YYYY-MM-DD)' },
              property: { type: 'string', description: 'Property URL (UkUnincorporatedLandlord companies)' },
              attachment: {
                type: 'object',
                description: 'Replacement receipt. Preferred: call get_staging_directory, copy the file into that directory, and pass its path as evidence_path. Or use stage_evidence to upload base64 bytes.',
                properties: {
                  evidence_path: { type: 'string', description: 'Absolute path to the receipt file inside the session staging directory — from get_staging_directory (copy the file there yourself) or returned by stage_evidence.' },
                  file_name: { type: 'string', description: 'File name for the attachment' },
                  content_type: { type: 'string', description: 'MIME type, e.g. image/jpeg, image/png, application/pdf' },
                  description: { type: 'string', description: 'Optional attachment description' }
                },
                required: ['evidence_path', 'file_name', 'content_type']
              }
            },
            required: ['id']
          }
        },
        {
          name: 'delete_expense',
          description: 'Delete an expense. If the expense has already been rebilled onto an invoice, you must pass confirm: true to acknowledge that deleting it leaves that invoice referencing a removed expense.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: { type: 'string', description: 'Expense ID' },
              confirm: { type: 'boolean', description: 'Required when the expense has been rebilled onto an invoice.' }
            },
            required: ['id']
          }
        },
        {
          name: 'get_mileage_settings',
          description:
            'Get the FreeAgent mileage settings — the valid engine types, engine sizes, and ' +
            'mileage rates, scoped by date period. Use this to discover valid engine_type and ' +
            'engine_size values before calling create_mileage_expense.',
          inputSchema: {
            type: 'object' as const,
            properties: {}
          }
        },
        {
          name: 'create_mileage_expense',
          description:
            'Log a mileage claim — reimbursement for business travel in a personal vehicle. ' +
            'engine_type and engine_size are validated against the official mileage settings ' +
            'for the claim date (call get_mileage_settings to see the valid options); engine_type ' +
            'defaults to Petrol for cars and motorcycles. Bicycles need no engine fields.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              dated_on: { type: 'string', description: 'Date of travel (YYYY-MM-DD)' },
              mileage: { type: 'number', description: 'Miles travelled, as a positive number' },
              vehicle_type: { type: 'string', enum: [...VEHICLE_TYPES], description: 'Vehicle used for the journey' },
              engine_type: { type: 'string', description: 'Engine type for a Car/Motorcycle, e.g. "Petrol", "Diesel", "Electric". Defaults to Petrol. Validated against get_mileage_settings.' },
              engine_size: { type: 'string', description: 'Engine size band for a Car/Motorcycle, e.g. "Up to 1400cc". Validated against get_mileage_settings.' },
              reclaim_mileage: { type: 'boolean', description: 'Whether to reclaim at the HMRC AMAP rate. Default true.' },
              user: { type: 'string', description: 'Claimant — a name, email address, user URL, or "me". Defaults to the authenticated user.' },
              description: { type: 'string', description: 'Free-text description of the journey' },
              receipt_reference: { type: 'string', description: 'Receipt reference identifier' },
              have_vat_receipt: { type: 'boolean', description: 'Whether a VAT receipt is held for the fuel' },
              attachment: {
                type: 'object',
                description: 'Optional supporting document. Preferred: call get_staging_directory, copy the file into that directory, and pass its path as evidence_path. Or use stage_evidence to upload base64 bytes.',
                properties: {
                  evidence_path: { type: 'string', description: 'Absolute path to the receipt file inside the session staging directory — from get_staging_directory (copy the file there yourself) or returned by stage_evidence.' },
                  file_name: { type: 'string', description: 'File name for the attachment' },
                  content_type: { type: 'string', description: 'MIME type, e.g. image/jpeg, image/png, application/pdf' },
                  description: { type: 'string', description: 'Optional attachment description' }
                },
                required: ['evidence_path', 'file_name', 'content_type']
              }
            },
            required: ['dated_on', 'mileage', 'vehicle_type']
          }
        },
        {
          name: 'create_expenses',
          description:
            'Batch-create multiple expenses in a single call. FreeAgent processes the batch ' +
            'atomically — if one item is invalid the whole batch is rejected. Each item takes ' +
            'the same fields as create_expense. Categories, claimants and projects are resolved ' +
            'once per distinct value across the batch.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              expenses: {
                type: 'array',
                description: 'Up to 100 expense objects, each shaped like the create_expense arguments (category, dated_on, gross_value, refund_due, user, and the optional fields).',
                items: { type: 'object' }
              }
            },
            required: ['expenses']
          }
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

          case 'get_staging_directory': {
            const body = {
              ready: this.stagingState.ready,
              path: this.stagingState.sessionPath,
              ...(this.stagingState.reason ? { reason: this.stagingState.reason } : {}),
            };
            return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
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

          case 'list_expenses': {
            const args = (request.params.arguments ?? {}) as {
              view?: 'recent' | 'recurring';
              from_date?: string;
              to_date?: string;
              updated_since?: string;
              project?: string;
              user?: string;
            };
            const { user: userFilter, ...listParams } = args;
            let expenses = await this.client.listExpenses(listParams);
            // The FreeAgent /expenses endpoint has no claimant filter, so
            // apply it client-side after the (paginated) fetch.
            if (typeof userFilter === 'string' && userFilter.trim() !== '') {
              const userUrl = await resolveUser(this.client, userFilter);
              expenses = expenses.filter(e => e.user === userUrl);
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(expenses, null, 2) }]
            };
          }

          case 'get_expense': {
            const { id: rawId } = request.params.arguments as { id: string };
            const id = validateId(rawId);
            const expense = await this.client.getExpense(id);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(expense, null, 2) }]
            };
          }

          case 'create_expense': {
            const input = validateCreateExpenseInput(request.params.arguments);
            const [userUrl, categoryUrl, projectUrl] = await Promise.all([
              resolveUser(this.client, input.user),
              resolveCategory(this.client, input.category),
              input.project ? resolveProject(this.client, input.project) : Promise.resolve(undefined),
            ]);
            const refs: ResolvedExpenseRefs = { user: userUrl, category: categoryUrl };
            if (projectUrl) refs.project = projectUrl;
            if (input.attachment) {
              refs.attachment = readStagedAttachment(input.attachment, this.stagingState.sessionPath);
            }
            const expense = await this.client.createExpense(buildExpensePayload(input, refs));
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(expense, null, 2) }]
            };
          }

          case 'update_expense': {
            const { id: rawId } = request.params.arguments as { id: string };
            const id = validateId(rawId);
            const input = validateUpdateExpenseInput(request.params.arguments);
            const refs: ResolvedExpenseRefs = {};
            if (input.user) refs.user = await resolveUser(this.client, input.user);
            if (input.category) refs.category = await resolveCategory(this.client, input.category);
            if (input.project) refs.project = await resolveProject(this.client, input.project);
            if (input.attachment) {
              refs.attachment = readStagedAttachment(input.attachment, this.stagingState.sessionPath);
            }
            const payload = buildExpenseUpdatePayload(input, refs);
            if (Object.keys(payload).length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'No update fields supplied — nothing to change.' }],
                isError: true,
              };
            }
            const expense = await this.client.updateExpense(id, payload);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(expense, null, 2) }]
            };
          }

          case 'delete_expense': {
            const { id: rawId, confirm } = request.params.arguments as { id: string; confirm?: boolean };
            const id = validateId(rawId);
            const expense = await this.client.getExpense(id);
            if (expense.rebilled_on_invoice && confirm !== true) {
              return {
                content: [{ type: 'text' as const, text: `Expense ${id} has already been rebilled onto invoice ${expense.rebilled_on_invoice}. Deleting it leaves that invoice referencing a removed expense. To proceed, retry with confirm: true.` }],
                isError: true,
              };
            }
            await this.client.deleteExpense(id);
            return {
              content: [{ type: 'text' as const, text: `Expense ${id} deleted successfully` }]
            };
          }

          case 'get_mileage_settings': {
            const settings = await this.client.getMileageSettings();
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(settings, null, 2) }]
            };
          }

          case 'create_mileage_expense': {
            const input = validateCreateMileageExpenseInput(request.params.arguments);
            const userUrl = await resolveUser(this.client, input.user);

            // Validate engine type/size against the dated mileage settings.
            // Bicycles carry no engine fields. If the settings can't be
            // fetched, resolveEngine degrades to passing values through.
            let engine: ResolvedEngine = {};
            if (input.vehicle_type !== 'Bicycle') {
              let settings: MileageSettings | null = null;
              try {
                settings = await this.client.getMileageSettings();
              } catch (e: any) {
                console.error('[expenses] mileage_settings unavailable, skipping engine validation:', e.message);
              }
              const options = settings ? findEngineOptionsForDate(settings, input.dated_on) : null;
              engine = resolveEngine(options, input);
            }

            let attachment;
            if (input.attachment) {
              attachment = readStagedAttachment(input.attachment, this.stagingState.sessionPath);
            }
            const payload = buildMileagePayload(input, { user: userUrl, engine, attachment });
            const expense = await this.client.createExpense(payload);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(expense, null, 2) }]
            };
          }

          case 'create_expenses': {
            const args = request.params.arguments as { expenses?: unknown };
            if (!Array.isArray(args.expenses) || args.expenses.length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'expenses must be a non-empty array' }],
                isError: true,
              };
            }
            if (args.expenses.length > 100) {
              return {
                content: [{ type: 'text' as const, text: `Batch too large: ${args.expenses.length} > 100. Split into smaller calls.` }],
                isError: true,
              };
            }
            const inputs = args.expenses.map((item, i) => {
              try {
                return validateCreateExpenseInput(item);
              } catch (e: any) {
                throw new Error(`expenses[${i}]: ${e.message}`);
              }
            });
            // Memoise resolution so a batch that shares categories,
            // claimants or projects does not re-fetch the same lookup
            // once per item.
            const cache = new Map<string, Promise<string>>();
            const memo = (key: string, fn: () => Promise<string>) => {
              if (!cache.has(key)) cache.set(key, fn());
              return cache.get(key)!;
            };
            const payloads = await Promise.all(inputs.map(async (input, i) => {
              try {
                const [userUrl, categoryUrl, projectUrl] = await Promise.all([
                  memo(`u:${input.user ?? ''}`, () => resolveUser(this.client, input.user)),
                  memo(`c:${input.category}`, () => resolveCategory(this.client, input.category)),
                  input.project
                    ? memo(`p:${input.project}`, () => resolveProject(this.client, input.project!))
                    : Promise.resolve(undefined),
                ]);
                const refs: ResolvedExpenseRefs = { user: userUrl, category: categoryUrl };
                if (projectUrl) refs.project = projectUrl;
                if (input.attachment) {
                  refs.attachment = readStagedAttachment(input.attachment, this.stagingState.sessionPath);
                }
                return buildExpensePayload(input, refs);
              } catch (e: any) {
                throw new Error(`expenses[${i}]: ${e.message}`);
              }
            }));
            const created = await this.client.createExpenses(payloads);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(created, null, 2) }]
            };
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
          name: LOG_EXPENSES_PROMPT_NAME,
          description: LOG_EXPENSES_PROMPT_DESCRIPTION,
          arguments: LOG_EXPENSES_PROMPT_ARGUMENTS,
        },
      ],
    }));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      if (request.params.name === LOG_EXPENSES_PROMPT_NAME) {
        const args = (request.params.arguments ?? {}) as LogExpensesPromptArgs;
        return {
          description: LOG_EXPENSES_PROMPT_DESCRIPTION,
          messages: [
            { role: 'user', content: { type: 'text', text: buildLogExpensesPromptBody(this.stagingState, args) } },
          ],
        };
      }
      throw new McpError(ErrorCode.MethodNotFound, `Unknown prompt: ${request.params.name}`);
    });
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
