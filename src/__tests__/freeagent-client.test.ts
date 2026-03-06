import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { FreeAgentClient } from '../freeagent-client.js';

vi.mock('axios');

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();
const mockRequest = vi.fn();
const mockInterceptors = {
  response: { use: vi.fn() },
  request: { use: vi.fn() },
};

const mockAxiosInstance = {
  get: mockGet,
  post: mockPost,
  put: mockPut,
  delete: mockDelete,
  request: mockRequest,
  interceptors: mockInterceptors,
  defaults: { headers: {} as Record<string, unknown> },
};

vi.mocked(axios.create).mockReturnValue(mockAxiosInstance as any);

const config = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
};

let client: FreeAgentClient;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(axios.create).mockReturnValue(mockAxiosInstance as any);
  client = new FreeAgentClient(config);
});

describe('listTimeslips', () => {
  it('calls GET /timeslips with params and unwraps response', async () => {
    const timeslips = [{ url: 'https://api.freeagent.com/v2/timeslips/1' }];
    mockGet.mockResolvedValue({ data: { timeslips } });

    const params = { from_date: '2026-03-01', to_date: '2026-03-31' };
    const result = await client.listTimeslips(params);

    expect(mockGet).toHaveBeenCalledWith('/timeslips', { params });
    expect(result).toEqual(timeslips);
  });

  it('re-throws on API error', async () => {
    mockGet.mockRejectedValue(new Error('Network error'));
    await expect(client.listTimeslips()).rejects.toThrow('Network error');
  });
});

describe('getTimeslip', () => {
  it('calls GET /timeslips/:id and unwraps response', async () => {
    const timeslip = { url: 'https://api.freeagent.com/v2/timeslips/42' };
    mockGet.mockResolvedValue({ data: { timeslip } });

    const result = await client.getTimeslip('42');

    expect(mockGet).toHaveBeenCalledWith('/timeslips/42');
    expect(result).toEqual(timeslip);
  });
});

describe('createTimeslip', () => {
  it('calls POST /timeslips with wrapped body and unwraps response', async () => {
    const attrs = { task: 't', user: 'u', project: 'p', dated_on: '2026-03-01', hours: '7.5' };
    const timeslip = { url: 'https://api.freeagent.com/v2/timeslips/1', ...attrs };
    mockPost.mockResolvedValue({ data: { timeslip } });

    const result = await client.createTimeslip(attrs);

    expect(mockPost).toHaveBeenCalledWith('/timeslips', { timeslip: attrs });
    expect(result).toEqual(timeslip);
  });
});

describe('createTimeslips', () => {
  it('calls POST /timeslips with wrapped array and unwraps response', async () => {
    const attrs = [{ task: 't', user: 'u', project: 'p', dated_on: '2026-03-01', hours: '7.5' }];
    const timeslips = [{ url: 'https://api.freeagent.com/v2/timeslips/1' }];
    mockPost.mockResolvedValue({ data: { timeslips } });

    const result = await client.createTimeslips(attrs);

    expect(mockPost).toHaveBeenCalledWith('/timeslips', { timeslips: attrs });
    expect(result).toEqual(timeslips);
  });
});

describe('updateTimeslip', () => {
  it('calls PUT /timeslips/:id with wrapped body', async () => {
    const updates = { hours: '8' };
    const timeslip = { url: 'https://api.freeagent.com/v2/timeslips/42' };
    mockPut.mockResolvedValue({ data: { timeslip } });

    const result = await client.updateTimeslip('42', updates);

    expect(mockPut).toHaveBeenCalledWith('/timeslips/42', { timeslip: updates });
    expect(result).toEqual(timeslip);
  });
});

describe('deleteTimeslip', () => {
  it('calls DELETE /timeslips/:id', async () => {
    mockDelete.mockResolvedValue({});

    await client.deleteTimeslip('42');

    expect(mockDelete).toHaveBeenCalledWith('/timeslips/42');
  });
});

describe('startTimer', () => {
  it('calls POST /timeslips/:id/timer', async () => {
    const timeslip = { url: 'https://api.freeagent.com/v2/timeslips/42' };
    mockPost.mockResolvedValue({ data: { timeslip } });

    const result = await client.startTimer('42');

    expect(mockPost).toHaveBeenCalledWith('/timeslips/42/timer');
    expect(result).toEqual(timeslip);
  });
});

describe('stopTimer', () => {
  it('calls DELETE /timeslips/:id/timer', async () => {
    const timeslip = { url: 'https://api.freeagent.com/v2/timeslips/42' };
    mockDelete.mockResolvedValue({ data: { timeslip } });

    const result = await client.stopTimer('42');

    expect(mockDelete).toHaveBeenCalledWith('/timeslips/42/timer');
    expect(result).toEqual(timeslip);
  });
});

describe('createProject', () => {
  it('calls POST /projects with wrapped body and unwraps response', async () => {
    const attrs = {
      contact: 'https://api.freeagent.com/v2/contacts/1',
      name: 'Test Project',
      status: 'Active',
      budget: 0,
      budget_units: 'Hours',
      currency: 'GBP',
      uses_project_invoice_sequence: false,
    };
    const project = { url: 'https://api.freeagent.com/v2/projects/1', ...attrs };
    mockPost.mockResolvedValue({ data: { project } });

    const result = await client.createProject(attrs);

    expect(mockPost).toHaveBeenCalledWith('/projects', { project: attrs });
    expect(result).toEqual(project);
  });

  it('re-throws on API error', async () => {
    mockPost.mockRejectedValue(new Error('Validation error'));
    await expect(client.createProject({} as any)).rejects.toThrow('Validation error');
  });
});

describe('listProjects', () => {
  it('calls GET /projects with params and unwraps response', async () => {
    const projects = [{ url: 'https://api.freeagent.com/v2/projects/1' }];
    mockGet.mockResolvedValue({ data: { projects } });

    const result = await client.listProjects({ view: 'active' });

    expect(mockGet).toHaveBeenCalledWith('/projects', { params: { view: 'active' } });
    expect(result).toEqual(projects);
  });
});

describe('createTask', () => {
  it('calls POST /tasks with project as query param and wrapped body', async () => {
    const taskAttrs = { name: 'Development' };
    const projectUrl = 'https://api.freeagent.com/v2/projects/1';
    const task = { url: 'https://api.freeagent.com/v2/tasks/1', ...taskAttrs };
    mockPost.mockResolvedValue({ data: { task } });

    const result = await client.createTask(projectUrl, taskAttrs);

    expect(mockPost).toHaveBeenCalledWith('/tasks', { task: taskAttrs }, { params: { project: projectUrl } });
    expect(result).toEqual(task);
  });

  it('re-throws on API error', async () => {
    mockPost.mockRejectedValue(new Error('Validation error'));
    await expect(client.createTask('url', {} as any)).rejects.toThrow('Validation error');
  });
});

describe('listTasks', () => {
  it('calls GET /tasks with params and unwraps response', async () => {
    const tasks = [{ url: 'https://api.freeagent.com/v2/tasks/1' }];
    mockGet.mockResolvedValue({ data: { tasks } });

    const result = await client.listTasks({ project: 'https://api.freeagent.com/v2/projects/1' });

    expect(mockGet).toHaveBeenCalledWith('/tasks', { params: { project: 'https://api.freeagent.com/v2/projects/1' } });
    expect(result).toEqual(tasks);
  });
});

describe('getCurrentUser', () => {
  it('calls GET /users/me and unwraps response', async () => {
    const user = { url: 'https://api.freeagent.com/v2/users/1', first_name: 'Test' };
    mockGet.mockResolvedValue({ data: { user } });

    const result = await client.getCurrentUser();

    expect(mockGet).toHaveBeenCalledWith('/users/me');
    expect(result).toEqual(user);
  });
});

describe('listUsers', () => {
  it('calls GET /users with params and unwraps response', async () => {
    const users = [{ url: 'https://api.freeagent.com/v2/users/1' }];
    mockGet.mockResolvedValue({ data: { users } });

    const result = await client.listUsers({ view: 'active' });

    expect(mockGet).toHaveBeenCalledWith('/users', { params: { view: 'active' } });
    expect(result).toEqual(users);
  });
});

describe('createInvoice', () => {
  it('calls POST /invoices with wrapped body', async () => {
    const attrs = { contact: 'c', dated_on: '2026-03-01', payment_terms_in_days: 30 };
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/1' };
    mockPost.mockResolvedValue({ data: { invoice } });

    const result = await client.createInvoice(attrs);

    expect(mockPost).toHaveBeenCalledWith('/invoices', { invoice: attrs });
    expect(result).toEqual(invoice);
  });
});

describe('listInvoices', () => {
  it('calls GET /invoices with params', async () => {
    const invoices = [{ url: 'https://api.freeagent.com/v2/invoices/1' }];
    mockGet.mockResolvedValue({ data: { invoices } });

    const result = await client.listInvoices({ view: 'draft' });

    expect(mockGet).toHaveBeenCalledWith('/invoices', { params: { view: 'draft' } });
    expect(result).toEqual(invoices);
  });
});

describe('getInvoice', () => {
  it('calls GET /invoices/:id and unwraps response', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/42' };
    mockGet.mockResolvedValue({ data: { invoice } });

    const result = await client.getInvoice('42');

    expect(mockGet).toHaveBeenCalledWith('/invoices/42');
    expect(result).toEqual(invoice);
  });
});

describe('updateInvoice', () => {
  it('calls PUT /invoices/:id with wrapped body', async () => {
    const updates = { comments: 'Updated' };
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/42' };
    mockPut.mockResolvedValue({ data: { invoice } });

    const result = await client.updateInvoice('42', updates);

    expect(mockPut).toHaveBeenCalledWith('/invoices/42', { invoice: updates });
    expect(result).toEqual(invoice);
  });
});

describe('downloadInvoicePdf', () => {
  it('calls GET /invoices/:id/pdf and returns content', async () => {
    mockGet.mockResolvedValue({ data: { pdf: { content: 'base64data' } } });

    const result = await client.downloadInvoicePdf('42');

    expect(mockGet).toHaveBeenCalledWith('/invoices/42/pdf');
    expect(result).toBe('base64data');
  });
});

describe('deleteInvoice', () => {
  it('calls DELETE /invoices/:id', async () => {
    mockDelete.mockResolvedValue({});

    await client.deleteInvoice('42');

    expect(mockDelete).toHaveBeenCalledWith('/invoices/42');
  });
});

describe('markInvoiceAsDraft', () => {
  it('calls PUT on transitions/mark_as_draft endpoint', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/42' };
    mockPut.mockResolvedValue({ data: { invoice } });

    const result = await client.markInvoiceAsDraft('42');

    expect(mockPut).toHaveBeenCalledWith(
      '/invoices/42/transitions/mark_as_draft',
      null,
      { headers: { 'Content-Length': '0' } }
    );
    expect(result).toEqual(invoice);
  });
});

describe('markInvoiceAsSent', () => {
  it('calls PUT on transitions/mark_as_sent endpoint', async () => {
    const invoice = { url: 'https://api.freeagent.com/v2/invoices/42' };
    mockPut.mockResolvedValue({ data: { invoice } });

    const result = await client.markInvoiceAsSent('42');

    expect(mockPut).toHaveBeenCalledWith(
      '/invoices/42/transitions/mark_as_sent',
      null,
      { headers: { 'Content-Length': '0' } }
    );
    expect(result).toEqual(invoice);
  });
});

describe('token refresh interceptor', () => {
  it('registers a response interceptor', () => {
    expect(mockInterceptors.response.use).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('refreshes token and retries on 401', async () => {
    // Get the error handler from the interceptor registration
    const errorHandler = mockInterceptors.response.use.mock.calls[0][1];

    // Mock the refresh token call
    vi.mocked(axios.post).mockResolvedValue({
      data: { access_token: 'new-token', refresh_token: 'new-refresh' },
    });

    const errorConfig = {
      headers: { Authorization: 'Bearer old-token' },
      _retried: false,
    };
    const error = {
      response: { status: 401 },
      config: errorConfig,
    };

    const retryResponse = { data: { timeslip: {} } };
    mockRequest.mockResolvedValue(retryResponse);

    const result = await errorHandler(error);

    expect(vi.mocked(axios.post)).toHaveBeenCalledWith(
      'https://api.freeagent.com/v2/token_endpoint',
      expect.objectContaining({ grant_type: 'refresh_token' }),
    );
    expect(errorConfig.headers.Authorization).toBe('Bearer new-token');
    expect(result).toEqual(retryResponse);
  });

  it('rejects without infinite loop on repeated 401', async () => {
    const errorHandler = mockInterceptors.response.use.mock.calls[0][1];

    const error = {
      response: { status: 401 },
      config: { headers: {}, _retried: true },
    };

    await expect(errorHandler(error)).rejects.toEqual(error);
  });
});
