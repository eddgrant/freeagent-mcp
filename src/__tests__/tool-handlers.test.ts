import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FreeAgentServer } from '../index.js';
import type { FreeAgentClient } from '../freeagent-client.js';

// Create a mock FreeAgentClient with all methods as vi.fn()
function createMockClient(): FreeAgentClient {
  return {
    listTimeslips: vi.fn(),
    getTimeslip: vi.fn(),
    createTimeslip: vi.fn(),
    createTimeslips: vi.fn(),
    updateTimeslip: vi.fn(),
    deleteTimeslip: vi.fn(),
    startTimer: vi.fn(),
    stopTimer: vi.fn(),
    createProject: vi.fn(),
    listProjects: vi.fn(),
    createTask: vi.fn(),
    listTasks: vi.fn(),
    listUsers: vi.fn(),
    getCurrentUser: vi.fn(),
    createInvoice: vi.fn(),
    listInvoices: vi.fn(),
    getInvoice: vi.fn(),
    updateInvoice: vi.fn(),
    downloadInvoicePdf: vi.fn(),
    deleteInvoice: vi.fn(),
    markInvoiceAsDraft: vi.fn(),
    markInvoiceAsSent: vi.fn(),
  } as unknown as FreeAgentClient;
}

let client: Client;
let mockFaClient: FreeAgentClient;

beforeAll(async () => {
  mockFaClient = createMockClient();
  const faServer = new FreeAgentServer(mockFaClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await faServer.run(serverTransport);
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
});

beforeEach(() => {
  // Clear all mock call history between tests
  Object.values(mockFaClient).forEach((fn) => {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as ReturnType<typeof vi.fn>).mockClear();
    }
  });
});

afterAll(async () => {
  await client.close();
});

async function callTool(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

function parseResult(result: Awaited<ReturnType<typeof callTool>>): unknown {
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Simple pass-through tools
describe('list_timeslips', () => {
  it('returns JSON-stringified client response', async () => {
    const timeslips = [{ url: 'https://api.freeagent.com/v2/timeslips/1', dated_on: '2026-03-01' }];
    vi.mocked(mockFaClient.listTimeslips).mockResolvedValue(timeslips as any);

    const result = await callTool('list_timeslips', { from_date: '2026-03-01' });

    expect(parseResult(result)).toEqual(timeslips);
  });
});

describe('list_projects', () => {
  it('returns JSON-stringified client response', async () => {
    const projects = [{ url: 'https://api.freeagent.com/v2/projects/1' }];
    vi.mocked(mockFaClient.listProjects).mockResolvedValue(projects as any);

    const result = await callTool('list_projects', { view: 'active' });

    expect(parseResult(result)).toEqual(projects);
  });
});

describe('create_project', () => {
  const validProject = {
    contact: 'https://api.freeagent.com/v2/contacts/1',
    name: 'Test Project',
    status: 'Active',
    budget: 0,
    budget_units: 'Hours',
    currency: 'GBP',
    uses_project_invoice_sequence: false,
  };

  it('validates attributes and calls client', async () => {
    const project = { url: 'https://api.freeagent.com/v2/projects/1', ...validProject };
    vi.mocked(mockFaClient.createProject).mockResolvedValue(project as any);

    const result = await callTool('create_project', validProject);

    expect(mockFaClient.createProject).toHaveBeenCalled();
    expect(parseResult(result)).toEqual(project);
  });

  it('returns error for invalid attributes', async () => {
    const result = await callTool('create_project', { name: 'Test' });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('required');
  });
});

describe('create_task', () => {
  it('validates attributes and calls client', async () => {
    const task = { url: 'https://api.freeagent.com/v2/tasks/1', name: 'Development' };
    vi.mocked(mockFaClient.createTask).mockResolvedValue(task as any);

    const result = await callTool('create_task', {
      project: 'https://api.freeagent.com/v2/projects/1',
      name: 'Development',
    });

    expect(mockFaClient.createTask).toHaveBeenCalledWith(
      'https://api.freeagent.com/v2/projects/1',
      { name: 'Development' },
    );
    expect(parseResult(result)).toEqual(task);
  });

  it('returns error when project is missing', async () => {
    const result = await callTool('create_task', { name: 'Task' });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('project is required');
  });

  it('returns error when name is missing', async () => {
    const result = await callTool('create_task', { project: 'url' });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('name is required');
  });
});

describe('list_tasks', () => {
  it('returns JSON-stringified client response', async () => {
    const tasks = [{ url: 'https://api.freeagent.com/v2/tasks/1' }];
    vi.mocked(mockFaClient.listTasks).mockResolvedValue(tasks as any);

    const result = await callTool('list_tasks');

    expect(parseResult(result)).toEqual(tasks);
  });
});

describe('list_users', () => {
  it('returns JSON-stringified client response', async () => {
    const users = [{ url: 'https://api.freeagent.com/v2/users/1' }];
    vi.mocked(mockFaClient.listUsers).mockResolvedValue(users as any);

    const result = await callTool('list_users');

    expect(parseResult(result)).toEqual(users);
  });
});

describe('get_current_user', () => {
  it('returns JSON-stringified client response', async () => {
    const user = { url: 'https://api.freeagent.com/v2/users/1', first_name: 'Test' };
    vi.mocked(mockFaClient.getCurrentUser).mockResolvedValue(user as any);

    const result = await callTool('get_current_user');

    expect(parseResult(result)).toEqual(user);
  });
});

describe('list_invoices', () => {
  it('returns JSON-stringified client response', async () => {
    const invoices = [{ url: 'https://api.freeagent.com/v2/invoices/1' }];
    vi.mocked(mockFaClient.listInvoices).mockResolvedValue(invoices as any);

    const result = await callTool('list_invoices', { view: 'draft' });

    expect(parseResult(result)).toEqual(invoices);
  });
});

// ID-validated tools
describe('get_timeslip', () => {
  it('calls client with validated ID', async () => {
    const timeslip = { url: 'https://api.freeagent.com/v2/timeslips/42' };
    vi.mocked(mockFaClient.getTimeslip).mockResolvedValue(timeslip as any);

    const result = await callTool('get_timeslip', { id: '42' });

    expect(mockFaClient.getTimeslip).toHaveBeenCalledWith('42');
    expect(parseResult(result)).toEqual(timeslip);
  });

  it('returns error for invalid ID', async () => {
    const result = await callTool('get_timeslip', { id: 'abc' });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('Invalid ID');
  });
});

describe('delete_timeslip', () => {
  it('calls client with validated ID', async () => {
    vi.mocked(mockFaClient.deleteTimeslip).mockResolvedValue(undefined);

    const result = await callTool('delete_timeslip', { id: '42' });

    expect(mockFaClient.deleteTimeslip).toHaveBeenCalledWith('42');
    expect((result.content as any)[0].text).toContain('deleted successfully');
  });

  it('returns error for invalid ID', async () => {
    const result = await callTool('delete_timeslip', { id: '../etc' });

    expect(result.isError).toBe(true);
  });
});

describe('start_timer', () => {
  it('calls client with validated ID', async () => {
    const timeslip = { url: 'https://api.freeagent.com/v2/timeslips/42' };
    vi.mocked(mockFaClient.startTimer).mockResolvedValue(timeslip as any);

    const result = await callTool('start_timer', { id: '42' });

    expect(mockFaClient.startTimer).toHaveBeenCalledWith('42');
    expect(parseResult(result)).toEqual(timeslip);
  });
});

describe('stop_timer', () => {
  it('calls client with validated ID', async () => {
    const timeslip = { url: 'https://api.freeagent.com/v2/timeslips/42' };
    vi.mocked(mockFaClient.stopTimer).mockResolvedValue(timeslip as any);

    const result = await callTool('stop_timer', { id: '42' });

    expect(mockFaClient.stopTimer).toHaveBeenCalledWith('42');
    expect(parseResult(result)).toEqual(timeslip);
  });
});

describe('get_invoice', () => {
  it('calls client with validated ID', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/42' };
    vi.mocked(mockFaClient.getInvoice).mockResolvedValue(invoice as any);

    const result = await callTool('get_invoice', { id: '42' });

    expect(mockFaClient.getInvoice).toHaveBeenCalledWith('42');
    expect(parseResult(result)).toEqual(invoice);
  });
});

describe('download_invoice_pdf', () => {
  it('calls client with validated ID', async () => {
    vi.mocked(mockFaClient.downloadInvoicePdf).mockResolvedValue('base64data');

    const result = await callTool('download_invoice_pdf', { id: '42' });

    expect(mockFaClient.downloadInvoicePdf).toHaveBeenCalledWith('42');
    expect((result.content as any)[0].text).toBe('base64data');
  });
});

describe('mark_invoice_as_draft', () => {
  it('calls client with validated ID', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/42' };
    vi.mocked(mockFaClient.markInvoiceAsDraft).mockResolvedValue(invoice as any);

    const result = await callTool('mark_invoice_as_draft', { id: '42' });

    expect(mockFaClient.markInvoiceAsDraft).toHaveBeenCalledWith('42');
    expect(parseResult(result)).toEqual(invoice);
  });
});

describe('mark_invoice_as_sent', () => {
  it('calls client with validated ID', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/42' };
    vi.mocked(mockFaClient.markInvoiceAsSent).mockResolvedValue(invoice as any);

    const result = await callTool('mark_invoice_as_sent', { id: '42' });

    expect(mockFaClient.markInvoiceAsSent).toHaveBeenCalledWith('42');
    expect(parseResult(result)).toEqual(invoice);
  });
});

// create_timeslip
describe('create_timeslip', () => {
  it('validates attributes and calls client', async () => {
    const attrs = {
      task: 'https://api.freeagent.com/v2/tasks/1',
      user: 'https://api.freeagent.com/v2/users/1',
      project: 'https://api.freeagent.com/v2/projects/1',
      dated_on: '2026-03-01',
      hours: '7.5',
    };
    const timeslip = { url: 'https://api.freeagent.com/v2/timeslips/1', ...attrs };
    vi.mocked(mockFaClient.createTimeslip).mockResolvedValue(timeslip as any);

    const result = await callTool('create_timeslip', attrs);

    expect(mockFaClient.createTimeslip).toHaveBeenCalled();
    expect(parseResult(result)).toEqual(timeslip);
  });

  it('returns error for invalid attributes', async () => {
    const result = await callTool('create_timeslip', { task: 'url' });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('missing required fields');
  });
});

// update_timeslip
describe('update_timeslip', () => {
  it('filters to only valid update fields', async () => {
    const timeslip = { url: 'https://api.freeagent.com/v2/timeslips/42' };
    vi.mocked(mockFaClient.updateTimeslip).mockResolvedValue(timeslip as any);

    await callTool('update_timeslip', { id: '42', hours: '8', unknown_field: 'ignored' });

    expect(mockFaClient.updateTimeslip).toHaveBeenCalledWith('42', { hours: '8' });
  });

  it('validates ID', async () => {
    const result = await callTool('update_timeslip', { id: 'abc', hours: '8' });

    expect(result.isError).toBe(true);
  });
});

// create_timeslips (batch with deduplication)
describe('create_timeslips', () => {
  const validTimeslip = {
    task: 'https://api.freeagent.com/v2/tasks/1',
    user: 'https://api.freeagent.com/v2/users/1',
    project: 'https://api.freeagent.com/v2/projects/1',
    dated_on: '2026-03-01',
    hours: '7.5',
  };

  it('creates all timeslips when none are duplicates', async () => {
    vi.mocked(mockFaClient.listTimeslips).mockResolvedValue([]);
    const created = [{ url: 'https://api.freeagent.com/v2/timeslips/1', ...validTimeslip }];
    vi.mocked(mockFaClient.createTimeslips).mockResolvedValue(created as any);

    const result = await callTool('create_timeslips', { timeslips: [validTimeslip] });

    expect(mockFaClient.createTimeslips).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
  });

  it('skips all when all are duplicates', async () => {
    vi.mocked(mockFaClient.listTimeslips).mockResolvedValue([validTimeslip as any]);

    const result = await callTool('create_timeslips', { timeslips: [validTimeslip] });

    expect(mockFaClient.createTimeslips).not.toHaveBeenCalled();
    expect((result.content as any)[0].text).toContain('already exist');
  });

  it('creates only new ones when some are duplicates', async () => {
    const timeslip2 = { ...validTimeslip, dated_on: '2026-03-02' };
    vi.mocked(mockFaClient.listTimeslips).mockResolvedValue([validTimeslip as any]);
    const created = [{ url: 'https://api.freeagent.com/v2/timeslips/2', ...timeslip2 }];
    vi.mocked(mockFaClient.createTimeslips).mockResolvedValue(created as any);

    const result = await callTool('create_timeslips', { timeslips: [validTimeslip, timeslip2] });

    expect(mockFaClient.createTimeslips).toHaveBeenCalledWith([timeslip2]);
    const text = (result.content as any)[0].text as string;
    expect(text).toContain('Skipped 1 duplicate');
  });

  it('rejects empty array', async () => {
    const result = await callTool('create_timeslips', { timeslips: [] });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('non-empty array');
  });

  it('wraps per-item validation errors with index', async () => {
    const result = await callTool('create_timeslips', {
      timeslips: [validTimeslip, { task: 'url' }],
    });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('index 1');
  });
});

// create_invoice
describe('create_invoice', () => {
  it('validates attributes and calls client', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/1' };
    vi.mocked(mockFaClient.createInvoice).mockResolvedValue(invoice as any);

    const result = await callTool('create_invoice', {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      dated_on: '2026-03-01',
    });

    expect(mockFaClient.createInvoice).toHaveBeenCalled();
    expect(parseResult(result)).toEqual(invoice);
  });
});

// update_invoice
describe('update_invoice', () => {
  it('validates ID and filters valid update fields', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/42' };
    vi.mocked(mockFaClient.updateInvoice).mockResolvedValue(invoice as any);

    await callTool('update_invoice', { id: '42', comments: 'Updated', unknown: 'ignored' });

    expect(mockFaClient.updateInvoice).toHaveBeenCalledWith('42', { comments: 'Updated' });
  });

  it('validates invoice_items array when present', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/42' };
    vi.mocked(mockFaClient.updateInvoice).mockResolvedValue(invoice as any);

    await callTool('update_invoice', {
      id: '42',
      invoice_items: [{ item_type: 'Hours', description: 'Work', quantity: '10', price: '100' }],
    });

    expect(mockFaClient.updateInvoice).toHaveBeenCalledWith('42', {
      invoice_items: [{ item_type: 'Hours', description: 'Work', quantity: '10', price: '100' }],
    });
  });

  it('returns error for invalid ID', async () => {
    const result = await callTool('update_invoice', { id: 'abc' });
    expect(result.isError).toBe(true);
  });
});

// delete_invoice
describe('delete_invoice', () => {
  it('deletes draft invoice without confirmation', async () => {
    vi.mocked(mockFaClient.getInvoice).mockResolvedValue({ status: 'Draft' } as any);
    vi.mocked(mockFaClient.deleteInvoice).mockResolvedValue(undefined);

    const result = await callTool('delete_invoice', { id: '42' });

    expect(mockFaClient.deleteInvoice).toHaveBeenCalledWith('42');
    expect((result.content as any)[0].text).toContain('deleted successfully');
  });

  it('refuses to delete non-draft without confirmation', async () => {
    vi.mocked(mockFaClient.getInvoice).mockResolvedValue({ status: 'Sent' } as any);

    const result = await callTool('delete_invoice', { id: '42' });

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('bad accounting practice');
  });

  it('deletes non-draft when confirm: true', async () => {
    vi.mocked(mockFaClient.getInvoice).mockResolvedValue({ status: 'Sent' } as any);
    vi.mocked(mockFaClient.deleteInvoice).mockResolvedValue(undefined);

    const result = await callTool('delete_invoice', { id: '42', confirm: true });

    expect(mockFaClient.deleteInvoice).toHaveBeenCalledWith('42');
    expect((result.content as any)[0].text).toContain('deleted successfully');
  });
});

// Error handling
describe('error handling', () => {
  it('client error is caught and returned as isError response', async () => {
    vi.mocked(mockFaClient.listTimeslips).mockRejectedValue(new Error('API rate limit'));

    const result = await callTool('list_timeslips');

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('API rate limit');
  });

  it('unknown tool name returns isError response', async () => {
    const result = await callTool('nonexistent_tool');
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain('Unknown tool');
  });
});
