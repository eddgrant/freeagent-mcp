#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { FreeAgentClient } from './freeagent-client.js';
import { TimeslipAttributes, InvoiceAttributes, ProjectAttributes } from './types.js';
import { validateId, validateTimeslipAttributes, validateInvoiceItemAttributes, validateInvoiceAttributes, validateProjectAttributes, validateTaskAttributes } from './validation.js';

export class FreeAgentServer {
  private server: Server;
  private client: FreeAgentClient;

  constructor(client?: FreeAgentClient) {
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

    this.server = new Server(
      {
        name: 'freeagent-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
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
          description: 'Create a new invoice. Can optionally attach unbilled timeslips using include_timeslips grouping mode.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              contact: { type: 'string', description: 'Contact URL' },
              project: { type: 'string', description: 'Project URL' },
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
                description: 'How to group unbilled timeslips into invoice line items'
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
          description: 'Update an existing invoice. Use this to modify line item descriptions, payment terms, comments, etc.',
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
            if (Array.isArray(updates.invoice_items)) {
              invoiceUpdates.invoice_items = updates.invoice_items.map((item, i) => validateInvoiceItemAttributes(item, i));
            }

            const invoice = await this.client.updateInvoice(id, invoiceUpdates);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(invoice, null, 2) }]
            };
          }

          case 'create_invoice': {
            const invoiceAttrs = validateInvoiceAttributes(request.params.arguments);
            const invoice = await this.client.createInvoice(invoiceAttrs);
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
