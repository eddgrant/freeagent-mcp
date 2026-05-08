import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { FreeAgentClient } from '../freeagent-client.js';
import {
  createMockFreeAgentClient,
  connectTestMcpClient,
  clearMockClient,
  parseToolResult as parseResult,
} from './_setup.js';

let client: Client;
let mockFaClient: FreeAgentClient;

beforeAll(async () => {
  mockFaClient = createMockFreeAgentClient();
  client = await connectTestMcpClient(mockFaClient);
});

beforeEach(() => clearMockClient(mockFaClient));

afterAll(async () => {
  await client.close();
});

async function callTool(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
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
    vi.mocked(mockFaClient.listTimeslips).mockResolvedValue([]);

    const result = await callTool('create_invoice', {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      dated_on: '2026-03-01',
    });

    expect(mockFaClient.createInvoice).toHaveBeenCalled();
    expect(parseResult(result)).toEqual(invoice);
  });

  it('refuses when unbilled timeslips exist on the implicated project and no directive is given', async () => {
    vi.mocked(mockFaClient.listTimeslips).mockResolvedValue([
      { url: 'https://api.freeagent.com/v2/timeslips/1', dated_on: '2026-03-01', hours: '2.0' } as any,
    ]);

    const result = await callTool('create_invoice', {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      project_ids: ['100'],
      dated_on: '2026-03-01',
    });

    expect(result.isError).toBe(true);
    expect(mockFaClient.createInvoice).not.toHaveBeenCalled();
    expect((result.content as any)[0].text).toContain('unbilled timeslip');
    expect((result.content as any)[0].text).toContain('omit_unbilled_timeslips: true');
  });

  it('proceeds when include_timeslips is set even with unbilled timeslips present', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/1' };
    vi.mocked(mockFaClient.createInvoice).mockResolvedValue(invoice as any);
    // The check is bypassed entirely, so listTimeslips should not even be called.

    await callTool('create_invoice', {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      project_ids: ['100'],
      dated_on: '2026-03-01',
      include_timeslips: 'billed_grouped_by_timeslip_task',
    });

    expect(mockFaClient.listTimeslips).not.toHaveBeenCalled();
    expect(mockFaClient.createInvoice).toHaveBeenCalled();
  });

  it('proceeds when omit_unbilled_timeslips is true', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/1' };
    vi.mocked(mockFaClient.createInvoice).mockResolvedValue(invoice as any);

    await callTool('create_invoice', {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      project_ids: ['100'],
      dated_on: '2026-03-01',
      omit_unbilled_timeslips: true,
    });

    expect(mockFaClient.listTimeslips).not.toHaveBeenCalled();
    expect(mockFaClient.createInvoice).toHaveBeenCalled();
    // omit_unbilled_timeslips is a tool-level flag, not a FreeAgent field — should not be forwarded.
    const forwarded = vi.mocked(mockFaClient.createInvoice).mock.calls[0][0];
    expect(forwarded).not.toHaveProperty('omit_unbilled_timeslips');
  });

  it('skips the check when no project or project_ids are provided', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/1' };
    vi.mocked(mockFaClient.createInvoice).mockResolvedValue(invoice as any);

    await callTool('create_invoice', {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      dated_on: '2026-03-01',
    });

    expect(mockFaClient.listTimeslips).not.toHaveBeenCalled();
    expect(mockFaClient.createInvoice).toHaveBeenCalled();
  });

  it('checks every project listed in project_ids in parallel', async () => {
    vi.mocked(mockFaClient.listTimeslips).mockImplementation(async ({ project }: any) => {
      return project === 'https://api.freeagent.com/v2/projects/200'
        ? [{ url: 'https://api.freeagent.com/v2/timeslips/9', dated_on: '2026-03-01', hours: '1.0' } as any]
        : [];
    });
    // Numbering inspection runs in parallel with the unbilled check; stub it so
    // the multi-project refusal isn't blocked on a missing getProject mock.
    vi.mocked(mockFaClient.getProject).mockImplementation(async (id: string) => ({
      url: '...', name: `P${id}`, uses_project_invoice_sequence: false,
    }) as any);

    const result = await callTool('create_invoice', {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      project_ids: ['100', '200'],
      dated_on: '2026-03-01',
    });

    expect(result.isError).toBe(true);
    // One unbilled query per project, bounded by N — avoids pulling unrelated
    // org data and dodges silent pagination truncation on busy orgs.
    expect(mockFaClient.listTimeslips).toHaveBeenCalledTimes(2);
    expect(mockFaClient.listTimeslips).toHaveBeenCalledWith({
      project: 'https://api.freeagent.com/v2/projects/100', view: 'unbilled',
    });
    expect(mockFaClient.listTimeslips).toHaveBeenCalledWith({
      project: 'https://api.freeagent.com/v2/projects/200', view: 'unbilled',
    });
    expect((result.content as any)[0].text).toContain('project 200');
  });

  it('forwards normalised project_ids and computed wire project to the client when proceeding (single project)', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/1' };
    vi.mocked(mockFaClient.createInvoice).mockResolvedValue(invoice as any);

    await callTool('create_invoice', {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      project_ids: ['100'],
      dated_on: '2026-03-01',
      omit_unbilled_timeslips: true,
    });

    const forwarded = vi.mocked(mockFaClient.createInvoice).mock.calls[0][0];
    expect(forwarded.project_ids).toEqual(['100']);
    expect(forwarded.project).toBe('https://api.freeagent.com/v2/projects/100');
  });

  it('refuses multi-project create when numbering_source is unset, with rich menu reflecting per-project sequence settings', async () => {
    vi.mocked(mockFaClient.getProject).mockImplementation(async (id: string) => {
      if (id === '100') return { url: '...', name: 'Alpha', uses_project_invoice_sequence: true } as any;
      if (id === '200') return { url: '...', name: 'Beta', uses_project_invoice_sequence: false } as any;
      throw new Error('unexpected ' + id);
    });

    const result = await callTool('create_invoice', {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      project_ids: ['100', '200'],
      dated_on: '2026-03-01',
      omit_unbilled_timeslips: true,
    });

    expect(result.isError).toBe(true);
    expect(mockFaClient.createInvoice).not.toHaveBeenCalled();
    const text = (result.content as any)[0].text as string;
    // Eligible projects show as numbering_source options.
    expect(text).toContain('numbering_source: "100"');
    expect(text).toContain('Alpha');
    expect(text).toContain('numbering_source: "org-wide"');
    // Ineligible project is mentioned but not as an option.
    expect(text).toContain('Beta');
    expect(text).not.toContain('numbering_source: "200"');
  });

  it('refuses when numbering_source picks a project that has no per-project sequence configured', async () => {
    vi.mocked(mockFaClient.getProject).mockImplementation(async (id: string) => {
      if (id === '100') return { url: '...', name: 'Alpha', uses_project_invoice_sequence: true } as any;
      if (id === '200') return { url: '...', name: 'Beta', uses_project_invoice_sequence: false } as any;
      throw new Error('unexpected ' + id);
    });

    const result = await callTool('create_invoice', {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      project_ids: ['100', '200'],
      numbering_source: '200',
      dated_on: '2026-03-01',
      omit_unbilled_timeslips: true,
    });

    expect(result.isError).toBe(true);
    expect(mockFaClient.createInvoice).not.toHaveBeenCalled();
    const text = (result.content as any)[0].text as string;
    expect(text).toContain('Beta');
    expect(text).toContain('does not have a per-project invoice sequence');
    // Suggests the eligible alternative (100/Alpha) and org-wide.
    expect(text).toContain('numbering_source: "100"');
    expect(text).toContain('numbering_source: "org-wide"');
  });

  it('proceeds when numbering_source picks a project that has a per-project sequence', async () => {
    vi.mocked(mockFaClient.getProject).mockImplementation(async (id: string) => ({
      url: '...', name: `P${id}`, uses_project_invoice_sequence: true,
    }) as any);
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/1' };
    vi.mocked(mockFaClient.createInvoice).mockResolvedValue(invoice as any);

    await callTool('create_invoice', {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      project_ids: ['100', '200'],
      numbering_source: '200',
      dated_on: '2026-03-01',
      omit_unbilled_timeslips: true,
    });

    const forwarded = vi.mocked(mockFaClient.createInvoice).mock.calls[0][0];
    expect(forwarded.project).toBe('https://api.freeagent.com/v2/projects/200');
    expect(forwarded.project_ids).toEqual(['100', '200']);
  });

  it('proceeds when numbering_source is "org-wide" and omits the wire project field — no project inspection needed for the org-wide case', async () => {
    vi.mocked(mockFaClient.getProject).mockImplementation(async (id: string) => ({
      url: '...', name: `P${id}`, uses_project_invoice_sequence: false,
    }) as any);
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/1' };
    vi.mocked(mockFaClient.createInvoice).mockResolvedValue(invoice as any);

    await callTool('create_invoice', {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      project_ids: ['100', '200'],
      numbering_source: 'org-wide',
      dated_on: '2026-03-01',
      omit_unbilled_timeslips: true,
    });

    const forwarded = vi.mocked(mockFaClient.createInvoice).mock.calls[0][0];
    expect(forwarded.project).toBeUndefined();
    expect(forwarded.project_ids).toEqual(['100', '200']);
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

  it('skips the timeslip check when project_ids is not provided', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/42' };
    vi.mocked(mockFaClient.updateInvoice).mockResolvedValue(invoice as any);

    await callTool('update_invoice', { id: '42', comments: 'Updated' });

    expect(mockFaClient.listTimeslips).not.toHaveBeenCalled();
    expect(mockFaClient.getInvoice).not.toHaveBeenCalled();
    expect(mockFaClient.updateInvoice).toHaveBeenCalled();
  });

  it('refuses when project_ids is set and unbilled timeslips exist on the extended scope', async () => {
    vi.mocked(mockFaClient.listTimeslips).mockImplementation(async ({ project }: any) => {
      return project === 'https://api.freeagent.com/v2/projects/200'
        ? [{ url: 'https://api.freeagent.com/v2/timeslips/9', dated_on: '2026-03-01', hours: '1.0' } as any]
        : [];
    });

    const result = await callTool('update_invoice', { id: '42', project_ids: ['100', '200'] });

    expect(result.isError).toBe(true);
    expect(mockFaClient.updateInvoice).not.toHaveBeenCalled();
    expect((result.content as any)[0].text).toContain('project 200');
  });

  it('proceeds when project_ids is set and include_timeslips is also set', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/42' };
    vi.mocked(mockFaClient.updateInvoice).mockResolvedValue(invoice as any);

    await callTool('update_invoice', {
      id: '42',
      project_ids: ['100', '200'],
      include_timeslips: 'billed_grouped_by_timeslip_task',
    });

    expect(mockFaClient.listTimeslips).not.toHaveBeenCalled();
    const forwarded = vi.mocked(mockFaClient.updateInvoice).mock.calls[0][1];
    expect(forwarded.project_ids).toEqual(['100', '200']);
    expect(forwarded.include_timeslips).toBe('billed_grouped_by_timeslip_task');
  });

  it('proceeds when omit_unbilled_timeslips is true on update', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/42' };
    vi.mocked(mockFaClient.updateInvoice).mockResolvedValue(invoice as any);

    await callTool('update_invoice', {
      id: '42',
      project_ids: ['100', '200'],
      omit_unbilled_timeslips: true,
    });

    expect(mockFaClient.listTimeslips).not.toHaveBeenCalled();
    expect(mockFaClient.updateInvoice).toHaveBeenCalled();
    const forwarded = vi.mocked(mockFaClient.updateInvoice).mock.calls[0][1];
    expect(forwarded).not.toHaveProperty('omit_unbilled_timeslips');
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

// Profit and loss
describe('get_profit_and_loss_summary', () => {
  it('returns JSON-stringified client response', async () => {
    const summary = {
      from: '2026-03-01',
      to: '2026-03-31',
      income: '15000',
      expenses: '3000',
      operating_profit: '12000',
      less: [],
      retained_profit: '12000',
      retained_profit_brought_forward: '50000',
      retained_profit_carried_forward: '62000',
    };
    vi.mocked(mockFaClient.getProfitAndLossSummary).mockResolvedValue(summary as any);

    const result = await callTool('get_profit_and_loss_summary', {
      from_date: '2026-03-01',
      to_date: '2026-03-31',
    });

    expect(mockFaClient.getProfitAndLossSummary).toHaveBeenCalledWith({
      from_date: '2026-03-01',
      to_date: '2026-03-31',
    });
    expect(parseResult(result)).toEqual(summary);
  });

  it('works with accounting_period param', async () => {
    const summary = { from: '2025-04-01', to: '2026-03-31', income: '100000' };
    vi.mocked(mockFaClient.getProfitAndLossSummary).mockResolvedValue(summary as any);

    const result = await callTool('get_profit_and_loss_summary', {
      accounting_period: '2025/26',
    });

    expect(mockFaClient.getProfitAndLossSummary).toHaveBeenCalledWith({
      accounting_period: '2025/26',
    });
    expect(parseResult(result)).toEqual(summary);
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
