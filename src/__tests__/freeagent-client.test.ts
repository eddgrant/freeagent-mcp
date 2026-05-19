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
  // Make 429 backoff effectively instant in tests; production defaults
  // are restored by the constants in pagination.ts.
  FreeAgentClient.retryBaseMs = 0;
  FreeAgentClient.retryJitterMs = 0;
  client = new FreeAgentClient(config);
});

describe('listTimeslips', () => {
  it('calls GET /timeslips with caller params plus pagination and unwraps response', async () => {
    const timeslips = [{ url: 'https://api.freeagent.com/v2/timeslips/1' }];
    mockGet.mockResolvedValue({ data: { timeslips } });

    const params = { from_date: '2026-03-01', to_date: '2026-03-31' };
    const result = await client.listTimeslips(params);

    // Caller params are forwarded alongside page/per_page on every request.
    expect(mockGet).toHaveBeenCalledWith('/timeslips', { params: { ...params, page: 1, per_page: 100 } });
    expect(result).toEqual(timeslips);
  });

  it('re-throws on API error', async () => {
    mockGet.mockRejectedValue(new Error('Network error'));
    await expect(client.listTimeslips()).rejects.toThrow('Network error');
  });
});

// Pagination is implemented once in a private helper used by every
// list method. These tests exercise it via listTimeslips because the
// behaviour is the same for every list endpoint.
describe('paginated list (covers every list endpoint)', () => {
  // Helper to build a Link header pointing at a given last page in
  // FreeAgent's single-quoted format, as observed via the probe.
  function linkHeaderWithLast(lastPage: number) {
    return `<https://api.freeagent.com/v2/timeslips?page=${lastPage}&per_page=100>; rel='last', <https://api.freeagent.com/v2/timeslips?page=2&per_page=100>; rel='next'`;
  }

  it('fast path: parses Link rel=last and fans out remaining pages concurrently, preserving order', async () => {
    const totalPages = 5;
    const pageOf = (n: number) =>
      Array.from({ length: n === totalPages ? 30 : 100 }, (_, i) => ({ url: `t-${n}-${i}` }));

    mockGet.mockImplementation(async (_path: string, opts: any) => {
      const page = opts.params.page;
      return {
        data: { timeslips: pageOf(page) },
        // Link header on every response, but only page 1's is consulted.
        headers: { link: linkHeaderWithLast(totalPages) },
      };
    });

    const result = await client.listTimeslips();

    // 5 pages fetched: page 1 sequentially first, then 2..5 in fan-out.
    expect(mockGet).toHaveBeenCalledTimes(5);
    // Order in the concatenated result must match the page order, not the
    // completion order.
    expect(result).toHaveLength(4 * 100 + 30);
    expect(result[0]).toEqual({ url: 't-1-0' });
    expect(result[100]).toEqual({ url: 't-2-0' });
    expect(result[400]).toEqual({ url: 't-5-0' });
  });

  it('fast path: respects the concurrency cap (default 4) on the fan-out', async () => {
    const totalPages = 10;
    let inFlight = 0;
    let maxInFlight = 0;
    let firstCall = true;

    mockGet.mockImplementation(async (_path: string, opts: any) => {
      // The page-1 request runs sequentially before the fan-out starts;
      // it is not counted toward the concurrency observation.
      const isFirst = firstCall;
      firstCall = false;
      if (!isFirst) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
      }
      await new Promise(r => setTimeout(r, 5));
      if (!isFirst) inFlight--;

      const page = opts.params.page;
      const items = page === totalPages
        ? Array.from({ length: 12 }, (_, i) => ({ url: `t-${page}-${i}` }))
        : Array.from({ length: 100 }, (_, i) => ({ url: `t-${page}-${i}` }));
      return { data: { timeslips: items }, headers: { link: linkHeaderWithLast(totalPages) } };
    });

    await client.listTimeslips();

    // 9 remaining pages (2..10), default concurrency 4 — never more than 4 in flight.
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // genuine parallelism, not sequential
  });

  it('fast path: returns immediately when Link reports last=1 even though page 1 was full', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ url: `t${i + 1}` }));
    mockGet.mockResolvedValue({
      data: { timeslips: items },
      headers: { link: `<https://api.freeagent.com/v2/timeslips?page=1&per_page=100>; rel='last'` },
    });

    const result = await client.listTimeslips();

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(100);
  });

  it('throws (rather than silently truncating) when page 1 is full but Link rel=last is unparseable — the probe shows FreeAgent always provides it, so a missing one means a contract change we want to learn about loudly', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ url: `t${i + 1}` }));
    // No headers field at all: simulates a missing Link header (proxy
    // strip, future API change, or an endpoint we haven't probed).
    mockGet.mockResolvedValueOnce({ data: { timeslips: page1 } });

    await expect(client.listTimeslips()).rejects.toThrow(/Link header.*rel='last'/);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('stops after one request when the first page is short', async () => {
    const items = [{ url: 'https://api.freeagent.com/v2/timeslips/1' }];
    mockGet.mockResolvedValue({ data: { timeslips: items } });

    const result = await client.listTimeslips();

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(result).toEqual(items);
  });

  it('stops after one request when the first page is short', async () => {
    const items = [{ url: 'https://api.freeagent.com/v2/timeslips/1' }];
    mockGet.mockResolvedValue({ data: { timeslips: items } });

    const result = await client.listTimeslips();

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(result).toEqual(items);
  });

  it('returns an empty array when the first page is empty', async () => {
    mockGet.mockResolvedValue({ data: { timeslips: [] } });

    const result = await client.listTimeslips();

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  it('treats a missing collection key as empty (single page)', async () => {
    mockGet.mockResolvedValue({ data: {} });
    const result = await client.listTimeslips();
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  it('propagates errors mid-pagination without silently returning partial results', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ url: `t${i + 1}` }));
    const linkHeader = `<https://api.freeagent.com/v2/timeslips?page=3&per_page=100>; rel='last'`;
    mockGet
      .mockResolvedValueOnce({ data: { timeslips: page1 }, headers: { link: linkHeader } })
      .mockRejectedValueOnce(new Error('Network error on a later page'));

    await expect(client.listTimeslips()).rejects.toThrow('Network error on a later page');
  });

  it('forwards filter params on every page request', async () => {
    mockGet.mockResolvedValue({ data: { timeslips: [{ url: 't1' }] } });

    await client.listTimeslips({ view: 'unbilled', project: 'https://api.freeagent.com/v2/projects/100' });

    expect(mockGet).toHaveBeenCalledWith('/timeslips', {
      params: { view: 'unbilled', project: 'https://api.freeagent.com/v2/projects/100', page: 1, per_page: 100 },
    });
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

    expect(mockGet).toHaveBeenCalledWith('/projects', { params: { view: 'active', page: 1, per_page: 100 } });
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

    expect(mockGet).toHaveBeenCalledWith('/tasks', { params: { project: 'https://api.freeagent.com/v2/projects/1', page: 1, per_page: 100 } });
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

    expect(mockGet).toHaveBeenCalledWith('/users', { params: { view: 'active', page: 1, per_page: 100 } });
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

    expect(mockGet).toHaveBeenCalledWith('/invoices', { params: { view: 'draft', page: 1, per_page: 100 } });
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

describe('getProfitAndLossSummary', () => {
  it('calls GET /accounting/profit_and_loss/summary with params', async () => {
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
    mockGet.mockResolvedValue({ data: { profit_and_loss_summary: summary } });

    const params = { from_date: '2026-03-01', to_date: '2026-03-31' };
    const result = await client.getProfitAndLossSummary(params);

    expect(mockGet).toHaveBeenCalledWith('/accounting/profit_and_loss/summary', { params });
    expect(result).toEqual(summary);
  });

  it('re-throws on API error', async () => {
    mockGet.mockRejectedValue(new Error('Forbidden'));
    await expect(client.getProfitAndLossSummary()).rejects.toThrow('Forbidden');
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

describe('getBankAccount', () => {
  it('calls GET /bank_accounts/:id and unwraps response', async () => {
    const bank_account = { url: 'https://api.freeagent.com/v2/bank_accounts/9', currency: 'GBP' };
    mockGet.mockResolvedValue({ data: { bank_account } });

    const result = await client.getBankAccount('9');

    expect(mockGet).toHaveBeenCalledWith('/bank_accounts/9');
    expect(result).toEqual(bank_account);
  });
});

describe('getBankTransaction', () => {
  it('calls GET /bank_transactions/:id and unwraps response', async () => {
    const bank_transaction = { url: 'https://api.freeagent.com/v2/bank_transactions/123', amount: '-42.10' };
    mockGet.mockResolvedValue({ data: { bank_transaction } });

    const result = await client.getBankTransaction('123');

    expect(mockGet).toHaveBeenCalledWith('/bank_transactions/123');
    expect(result).toEqual(bank_transaction);
  });
});

describe('createBankTransactionExplanation', () => {
  it('calls POST /bank_transaction_explanations with wrapped body', async () => {
    const payload = {
      bank_transaction: 'https://api.freeagent.com/v2/bank_transactions/123',
      dated_on: '2026-04-12',
      gross_value: '-42.10',
      category: 'https://api.freeagent.com/v2/categories/285',
    };
    const created = { url: 'https://api.freeagent.com/v2/bank_transaction_explanations/777', ...payload };
    mockPost.mockResolvedValue({ data: { bank_transaction_explanation: created } });

    const result = await client.createBankTransactionExplanation(payload);

    expect(mockPost).toHaveBeenCalledWith(
      '/bank_transaction_explanations',
      { bank_transaction_explanation: payload },
    );
    expect(result).toEqual(created);
  });

  it('forwards an attachment payload verbatim', async () => {
    const payload = {
      bank_transaction: 'https://api.freeagent.com/v2/bank_transactions/123',
      dated_on: '2026-04-12',
      gross_value: '-42.10',
      category: 'https://api.freeagent.com/v2/categories/285',
      attachment: {
        data: 'aGVsbG8=',
        file_name: 'receipt.pdf',
        content_type: 'application/pdf',
      },
    };
    mockPost.mockResolvedValue({ data: { bank_transaction_explanation: { url: 'x', ...payload } } });

    await client.createBankTransactionExplanation(payload);

    expect(mockPost).toHaveBeenCalledWith(
      '/bank_transaction_explanations',
      { bank_transaction_explanation: payload },
    );
  });

  it('re-throws on API error', async () => {
    mockPost.mockRejectedValue(new Error('422 unprocessable'));
    await expect(client.createBankTransactionExplanation({
      bank_transaction: 'x', dated_on: '2026-04-12', gross_value: '0',
    })).rejects.toThrow('422 unprocessable');
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

describe('429 retry interceptor', () => {
  it('retries on 429 and resolves with the retry response', async () => {
    const errorHandler = mockInterceptors.response.use.mock.calls[0][1];

    const cfg: any = { headers: {} };
    const error = {
      response: { status: 429, headers: {} },
      config: cfg,
    };

    const retryResponse = { data: { timeslips: [] } };
    mockRequest.mockResolvedValue(retryResponse);

    const result = await errorHandler(error);

    expect(mockRequest).toHaveBeenCalledWith(cfg);
    expect(cfg._429Attempts).toBe(1);
    expect(result).toEqual(retryResponse);
  });

  it('honours the Retry-After header (delta-seconds) when present', async () => {
    // Don't actually sleep for the value — we set the base/jitter to 0
    // already, but Retry-After of '5' would otherwise add a 5s wait.
    // Use a tiny value to verify the path is taken without slowing tests.
    const errorHandler = mockInterceptors.response.use.mock.calls[0][1];

    const cfg: any = { headers: {} };
    const error = {
      response: { status: 429, headers: { 'retry-after': '0' } },
      config: cfg,
    };

    mockRequest.mockResolvedValue({ data: {} });
    await errorHandler(error);

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(cfg._429Attempts).toBe(1);
  });

  it('caps retries at retryMaxAttempts and propagates the final 429', async () => {
    const errorHandler = mockInterceptors.response.use.mock.calls[0][1];

    // Simulate the interceptor having already retried up to the limit.
    const cfg: any = { headers: {}, _429Attempts: FreeAgentClient.retryMaxAttempts };
    const error = {
      response: { status: 429, headers: {} },
      config: cfg,
    };

    await expect(errorHandler(error)).rejects.toEqual(error);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('does not interfere with non-429 / non-401 errors', async () => {
    const errorHandler = mockInterceptors.response.use.mock.calls[0][1];

    const error = {
      response: { status: 500 },
      config: { headers: {} },
    };

    await expect(errorHandler(error)).rejects.toEqual(error);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('uses exponential backoff in the absence of Retry-After', async () => {
    // Restore a non-zero baseline for this single test so we can verify
    // the doubling behaviour deterministically.
    FreeAgentClient.retryBaseMs = 10;
    FreeAgentClient.retryJitterMs = 0;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const errorHandler = mockInterceptors.response.use.mock.calls[0][1];

    mockRequest.mockResolvedValue({ data: {} });

    // Attempt 1: base * 2^0 = 10ms
    const cfg1: any = { headers: {} };
    await errorHandler({ response: { status: 429, headers: {} }, config: cfg1 });
    // Attempt 2: base * 2^1 = 20ms
    const cfg2: any = { headers: {}, _429Attempts: 1 };
    await errorHandler({ response: { status: 429, headers: {} }, config: cfg2 });
    // Attempt 3: base * 2^2 = 40ms
    const cfg3: any = { headers: {}, _429Attempts: 2 };
    await errorHandler({ response: { status: 429, headers: {} }, config: cfg3 });

    const delays = setTimeoutSpy.mock.calls.map(c => c[1]);
    expect(delays).toContain(10);
    expect(delays).toContain(20);
    expect(delays).toContain(40);

    setTimeoutSpy.mockRestore();
  });
});

describe('API error enrichment', () => {
  it('rewrites the error message with the FreeAgent error body (nested shape)', async () => {
    const errorHandler = mockInterceptors.response.use.mock.calls[0][1];
    const error: any = {
      response: { status: 422, data: { errors: { error: { message: 'Engine type is invalid' } } } },
      config: { headers: {} },
    };

    await expect(errorHandler(error)).rejects.toBe(error);

    expect(error.message).toContain('422');
    expect(error.message).toContain('Engine type is invalid');
  });

  it('collects per-field validation messages from the error body', async () => {
    const errorHandler = mockInterceptors.response.use.mock.calls[0][1];
    const error: any = {
      response: { status: 400, data: { errors: { dated_on: ['is not a valid date'] } } },
      config: { headers: {} },
    };

    await expect(errorHandler(error)).rejects.toBe(error);

    expect(error.message).toContain('is not a valid date');
  });

  it('falls back to the stringified body when no errors/error key is present', async () => {
    const errorHandler = mockInterceptors.response.use.mock.calls[0][1];
    const error: any = {
      response: { status: 500, data: { something: 'unexpected' } },
      config: { headers: {} },
    };

    await expect(errorHandler(error)).rejects.toBe(error);

    expect(error.message).toContain('500');
    expect(error.message).toContain('unexpected');
  });

  it('leaves a non-HTTP error (no response) untouched', async () => {
    const errorHandler = mockInterceptors.response.use.mock.calls[0][1];
    const error: any = new Error('socket hang up');

    await expect(errorHandler(error)).rejects.toBe(error);

    expect(error.message).toBe('socket hang up');
  });
});

describe('expenses', () => {
  const payload = {
    user: 'https://api.freeagent.com/v2/users/1',
    category: 'https://api.freeagent.com/v2/categories/285',
    dated_on: '2026-05-01',
    gross_value: '-42.0',
  };

  it('listExpenses calls GET /expenses with caller params plus pagination and unwraps', async () => {
    const expenses = [{ url: 'https://api.freeagent.com/v2/expenses/1' }];
    mockGet.mockResolvedValue({ data: { expenses } });

    const result = await client.listExpenses({ view: 'recent', from_date: '2026-05-01' });

    expect(mockGet).toHaveBeenCalledWith('/expenses', {
      params: { view: 'recent', from_date: '2026-05-01', page: 1, per_page: 100 },
    });
    expect(result).toEqual(expenses);
  });

  it('getExpense calls GET /expenses/:id and unwraps', async () => {
    mockGet.mockResolvedValue({ data: { expense: { url: 'e/5' } } });
    const result = await client.getExpense('5');
    expect(mockGet).toHaveBeenCalledWith('/expenses/5');
    expect(result).toEqual({ url: 'e/5' });
  });

  it('createExpense POSTs the expense wrapper and unwraps', async () => {
    mockPost.mockResolvedValue({ data: { expense: { url: 'e/9' } } });
    const result = await client.createExpense(payload);
    expect(mockPost).toHaveBeenCalledWith('/expenses', { expense: payload });
    expect(result).toEqual({ url: 'e/9' });
  });

  it('createExpenses POSTs the expenses array wrapper and unwraps', async () => {
    mockPost.mockResolvedValue({ data: { expenses: [{ url: 'e/9' }, { url: 'e/10' }] } });
    const result = await client.createExpenses([payload, payload]);
    expect(mockPost).toHaveBeenCalledWith('/expenses', { expenses: [payload, payload] });
    expect(result).toHaveLength(2);
  });

  it('updateExpense PUTs /expenses/:id with the expense wrapper', async () => {
    mockPut.mockResolvedValue({ data: { expense: { url: 'e/5' } } });
    const result = await client.updateExpense('5', { description: 'Updated' });
    expect(mockPut).toHaveBeenCalledWith('/expenses/5', { expense: { description: 'Updated' } });
    expect(result).toEqual({ url: 'e/5' });
  });

  it('deleteExpense calls DELETE /expenses/:id', async () => {
    mockDelete.mockResolvedValue({});
    await client.deleteExpense('5');
    expect(mockDelete).toHaveBeenCalledWith('/expenses/5');
  });

  it('getMileageSettings calls GET /expenses/mileage_settings and unwraps', async () => {
    const mileage_settings = { engine_type_and_size_options: [], mileage_rates: [] };
    mockGet.mockResolvedValue({ data: { mileage_settings } });
    const result = await client.getMileageSettings();
    expect(mockGet).toHaveBeenCalledWith('/expenses/mileage_settings');
    expect(result).toEqual(mileage_settings);
  });

  it('re-throws on API error', async () => {
    mockGet.mockRejectedValue(new Error('Network error'));
    await expect(client.getExpense('5')).rejects.toThrow('Network error');
  });
});
