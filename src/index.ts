#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { FreeAgentClient } from './freeagent-client.js';
import { TimeslipAttributes, InvoiceAttributes } from './types.js';

const CLIENT_ID = process.env.FREEAGENT_CLIENT_ID as string;
const CLIENT_SECRET = process.env.FREEAGENT_CLIENT_SECRET as string;
const ACCESS_TOKEN = process.env.FREEAGENT_ACCESS_TOKEN as string;
const REFRESH_TOKEN = process.env.FREEAGENT_REFRESH_TOKEN as string;

if (!CLIENT_ID || !CLIENT_SECRET || !ACCESS_TOKEN || !REFRESH_TOKEN) {
  throw new Error('Missing required environment variables for FreeAgent authentication');
}

function validateTimeslipAttributes(data: unknown): TimeslipAttributes {
  if (typeof data !== 'object' || !data) {
    throw new Error('Invalid timeslip data: must be an object');
  }

  const attrs = data as Record<string, unknown>;

  if (typeof attrs.task !== 'string' ||
    typeof attrs.user !== 'string' ||
    typeof attrs.project !== 'string' ||
    typeof attrs.dated_on !== 'string' ||
    typeof attrs.hours !== 'string') {
    throw new Error('Invalid timeslip data: missing required fields');
  }

  return {
    task: attrs.task,
    user: attrs.user,
    project: attrs.project,
    dated_on: attrs.dated_on,
    hours: attrs.hours,
    comment: attrs.comment as string | undefined
  };
}

function validateInvoiceAttributes(data: unknown): InvoiceAttributes {
  if (typeof data !== 'object' || !data) {
    throw new Error('Invalid invoice data: must be an object');
  }

  const attrs = data as Record<string, unknown>;

  if (typeof attrs.contact !== 'string' || typeof attrs.dated_on !== 'string') {
    throw new Error('Invalid invoice data: contact and dated_on are required');
  }

  const invoice: InvoiceAttributes = {
    contact: attrs.contact,
    dated_on: attrs.dated_on,
    payment_terms_in_days: typeof attrs.payment_terms_in_days === 'number' ? attrs.payment_terms_in_days : 30,
  };

  if (typeof attrs.project === 'string') invoice.project = attrs.project;
  if (typeof attrs.currency === 'string') invoice.currency = attrs.currency;
  if (typeof attrs.comments === 'string') invoice.comments = attrs.comments;
  if (typeof attrs.ec_status === 'string') invoice.ec_status = attrs.ec_status;
  if (typeof attrs.include_timeslips === 'string') invoice.include_timeslips = attrs.include_timeslips;
  if (Array.isArray(attrs.invoice_items)) invoice.invoice_items = attrs.invoice_items as InvoiceAttributes['invoice_items'];

  return invoice;
}

class FreeAgentServer {
  private server: Server;
  private client: FreeAgentClient;

  constructor() {
    console.error('[Setup] Initializing FreeAgent MCP server...');

    this.client = new FreeAgentClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN
    });

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
              sort: { type: 'string', description: 'Sort order' }
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
            const { id } = request.params.arguments as { id: string };
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
            const { id, ...updates } = request.params.arguments as { id: string } & Record<string, unknown>;
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
            const { id } = request.params.arguments as { id: string };
            await this.client.deleteTimeslip(id);
            return {
              content: [{ type: 'text' as const, text: 'Timeslip deleted successfully' }]
            };
          }

          case 'start_timer': {
            const { id } = request.params.arguments as { id: string };
            const timeslip = await this.client.startTimer(id);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(timeslip, null, 2) }]
            };
          }

          case 'stop_timer': {
            const { id } = request.params.arguments as { id: string };
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
            const { id } = request.params.arguments as { id: string };
            const base64Content = await this.client.downloadInvoicePdf(id);
            return {
              content: [{ type: 'text' as const, text: base64Content }]
            };
          }

          case 'update_invoice': {
            const { id, ...updates } = request.params.arguments as { id: string } & Record<string, unknown>;
            const invoiceUpdates: Partial<InvoiceAttributes> = {};
            if (typeof updates.payment_terms_in_days === 'number') invoiceUpdates.payment_terms_in_days = updates.payment_terms_in_days;
            if (typeof updates.comments === 'string') invoiceUpdates.comments = updates.comments;
            if (typeof updates.ec_status === 'string') invoiceUpdates.ec_status = updates.ec_status;
            if (Array.isArray(updates.invoice_items)) invoiceUpdates.invoice_items = updates.invoice_items as InvoiceAttributes['invoice_items'];

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
            const { id } = request.params.arguments as { id: string };
            const invoice = await this.client.getInvoice(id);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(invoice, null, 2) }]
            };
          }

          case 'mark_invoice_as_sent': {
            const { id } = request.params.arguments as { id: string };
            const invoice = await this.client.markInvoiceAsSent(id);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(invoice, null, 2) }]
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

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('FreeAgent MCP server running on stdio');
  }
}

const server = new FreeAgentServer();
server.run().catch(console.error);
