// End-to-end tests: drive the Phase 1 expense CRUD tools through a real
// MCP Server↔Client transport pair. Verifies tool registration, the
// curated resolution/sign behaviour, and the refusal guards.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  createMockFreeAgentClient,
  connectTestMcpClient,
  parseToolResult as parseResult,
} from './_setup.js';
import type { FreeAgentClient } from '../freeagent-client.js';
import type { Expense, ExpenseCreatePayload } from '../types.js';

const CURRENT_USER = 'https://api.freeagent.com/v2/users/1';
const TRAVEL_URL = 'https://api.freeagent.com/v2/categories/285';

function categoriesResponse() {
  return {
    admin_expenses_categories: [
      { url: TRAVEL_URL, description: 'Travel', nominal_code: '285' },
      { url: 'https://api.freeagent.com/v2/categories/286', description: 'Subsistence', nominal_code: '286' },
    ],
    cost_of_sales_categories: [],
    income_categories: [],
    general_categories: [],
  };
}

function expense(partial: Partial<Expense>): Expense {
  return {
    url: 'https://api.freeagent.com/v2/expenses/100',
    user: CURRENT_USER,
    dated_on: '2026-05-01',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    ...partial,
  };
}

describe('expense CRUD tools (via MCP)', () => {
  let client: Client;
  let mock: FreeAgentClient;

  beforeEach(async () => {
    mock = createMockFreeAgentClient();
    (mock.getCurrentUser as any).mockResolvedValue({ url: CURRENT_USER, first_name: 'Edd', last_name: 'Grant', email: 'edd@co.com' });
    (mock.listCategories as any).mockResolvedValue(categoriesResponse());
    client = await connectTestMcpClient(mock);
  });

  afterEach(async () => { await client.close(); });

  it('registers all five Phase 1 expense tools', async () => {
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'list_expenses', 'get_expense', 'create_expense', 'update_expense', 'delete_expense',
    ]));
  });

  describe('list_expenses', () => {
    it('lists expenses and forwards filter params', async () => {
      (mock.listExpenses as any).mockResolvedValue([expense({})]);
      const result = await client.callTool({ name: 'list_expenses', arguments: { view: 'recent', from_date: '2026-05-01' } });
      expect((mock.listExpenses as any).mock.calls[0][0]).toEqual({ view: 'recent', from_date: '2026-05-01' });
      expect(parseResult(result)).toHaveLength(1);
    });

    it('filters by claimant client-side', async () => {
      const other = 'https://api.freeagent.com/v2/users/2';
      (mock.listExpenses as any).mockResolvedValue([
        expense({ url: 'e/1', user: CURRENT_USER }),
        expense({ url: 'e/2', user: other }),
      ]);
      const result = await client.callTool({ name: 'list_expenses', arguments: { user: 'me' } });
      const parsed = parseResult(result) as Expense[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].user).toBe(CURRENT_USER);
      // The claimant filter is not a FreeAgent query param.
      expect((mock.listExpenses as any).mock.calls[0][0]).toEqual({});
    });
  });

  describe('get_expense', () => {
    it('fetches a single expense by numeric id', async () => {
      (mock.getExpense as any).mockResolvedValue(expense({ url: 'e/7' }));
      const result = await client.callTool({ name: 'get_expense', arguments: { id: '7' } });
      expect((mock.getExpense as any)).toHaveBeenCalledWith('7');
      expect((parseResult(result) as Expense).url).toBe('e/7');
    });

    it('rejects a non-numeric id', async () => {
      const result = await client.callTool({ name: 'get_expense', arguments: { id: '7/../9' } });
      expect((result as { isError?: boolean }).isError).toBe(true);
    });
  });

  describe('create_expense', () => {
    it('resolves category by name, defaults the claimant, and stores out-of-pocket as negative', async () => {
      (mock.createExpense as any).mockResolvedValue(expense({}));
      await client.callTool({
        name: 'create_expense',
        arguments: { category: 'Travel', dated_on: '2026-05-01', gross_value: 42.5 },
      });
      const payload = (mock.createExpense as any).mock.calls[0][0] as ExpenseCreatePayload;
      expect(payload.category).toBe(TRAVEL_URL);
      expect(payload.user).toBe(CURRENT_USER);
      expect(payload.gross_value).toBe('-42.5');
    });

    it('keeps gross_value positive for a refund due', async () => {
      (mock.createExpense as any).mockResolvedValue(expense({}));
      await client.callTool({
        name: 'create_expense',
        arguments: { category: 'Travel', dated_on: '2026-05-01', gross_value: 10, refund_due: true },
      });
      expect(((mock.createExpense as any).mock.calls[0][0] as ExpenseCreatePayload).gross_value).toBe('10');
    });

    it('returns an error for an unknown category', async () => {
      const result = await client.callTool({
        name: 'create_expense',
        arguments: { category: 'Nonexistent', dated_on: '2026-05-01', gross_value: 1 },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(parseResult(result)).toMatch(/No category matches/);
      expect(mock.createExpense as any).not.toHaveBeenCalled();
    });

    it('rejects a negative gross_value (schema requires a positive number)', async () => {
      const result = await client.callTool({
        name: 'create_expense',
        arguments: { category: 'Travel', dated_on: '2026-05-01', gross_value: -5 },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(parseResult(result)).toMatch(/validation/i);
      expect(mock.createExpense as any).not.toHaveBeenCalled();
    });
  });

  describe('update_expense', () => {
    it('updates only the supplied fields', async () => {
      (mock.updateExpense as any).mockResolvedValue(expense({ description: 'Updated' }));
      await client.callTool({ name: 'update_expense', arguments: { id: '7', description: 'Updated' } });
      expect((mock.updateExpense as any).mock.calls[0]).toEqual(['7', { description: 'Updated' }]);
    });

    it('errors when no update fields are supplied', async () => {
      const result = await client.callTool({ name: 'update_expense', arguments: { id: '7' } });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(mock.updateExpense as any).not.toHaveBeenCalled();
    });
  });

  describe('delete_expense', () => {
    it('deletes a plain expense', async () => {
      (mock.getExpense as any).mockResolvedValue(expense({}));
      const result = await client.callTool({ name: 'delete_expense', arguments: { id: '7' } });
      expect((mock.deleteExpense as any)).toHaveBeenCalledWith('7');
      expect(parseResult(result)).toMatch(/deleted successfully/);
    });

    it('refuses to delete a rebilled expense without confirm', async () => {
      (mock.getExpense as any).mockResolvedValue(expense({ rebilled_on_invoice: 'https://api.freeagent.com/v2/invoices/3' }));
      const result = await client.callTool({ name: 'delete_expense', arguments: { id: '7' } });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(parseResult(result)).toMatch(/rebilled onto invoice/);
      expect(mock.deleteExpense as any).not.toHaveBeenCalled();
    });

    it('deletes a rebilled expense when confirm is true', async () => {
      (mock.getExpense as any).mockResolvedValue(expense({ rebilled_on_invoice: 'https://api.freeagent.com/v2/invoices/3' }));
      const result = await client.callTool({ name: 'delete_expense', arguments: { id: '7', confirm: true } });
      expect((mock.deleteExpense as any)).toHaveBeenCalledWith('7');
      expect(parseResult(result)).toMatch(/deleted successfully/);
    });
  });

  describe('rebilling (Phase 3)', () => {
    it('resolves a project by name and sets the rebill fields', async () => {
      (mock.listProjects as any).mockResolvedValue([
        { url: 'https://api.freeagent.com/v2/projects/9', name: 'Acme Rebuild' },
      ]);
      (mock.createExpense as any).mockResolvedValue(expense({}));
      await client.callTool({
        name: 'create_expense',
        arguments: { category: 'Travel', dated_on: '2026-05-01', gross_value: 30, project: 'Acme Rebuild', rebill_type: 'markup', rebill_factor: '15' },
      });
      const payload = (mock.createExpense as any).mock.calls[0][0] as ExpenseCreatePayload;
      expect(payload.project).toBe('https://api.freeagent.com/v2/projects/9');
      expect(payload.rebill_type).toBe('markup');
      expect(payload.rebill_factor).toBe('15');
    });

    it('rejects rebill_type markup without rebill_factor', async () => {
      (mock.listProjects as any).mockResolvedValue([{ url: 'p/9', name: 'Acme' }]);
      const result = await client.callTool({
        name: 'create_expense',
        arguments: { category: 'Travel', dated_on: '2026-05-01', gross_value: 30, project: 'Acme', rebill_type: 'markup' },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(parseResult(result)).toMatch(/rebill_factor is required/);
    });
  });

  describe('create_expenses (batch, Phase 3)', () => {
    it('creates a batch and resolves shared lookups only once', async () => {
      (mock.createExpenses as any).mockResolvedValue([expense({ url: 'e/1' }), expense({ url: 'e/2' })]);
      await client.callTool({
        name: 'create_expenses',
        arguments: {
          expenses: [
            { category: 'Travel', dated_on: '2026-05-01', gross_value: 10 },
            { category: 'Travel', dated_on: '2026-05-02', gross_value: 20 },
          ],
        },
      });
      const payloads = (mock.createExpenses as any).mock.calls[0][0] as ExpenseCreatePayload[];
      expect(payloads).toHaveLength(2);
      expect(payloads[0].gross_value).toBe('-10');
      expect(payloads[1].gross_value).toBe('-20');
      // "Travel" and the default claimant are each resolved once.
      expect((mock.listCategories as any).mock.calls.length).toBe(1);
      expect((mock.getCurrentUser as any).mock.calls.length).toBe(1);
    });

    it('rejects an empty batch', async () => {
      const result = await client.callTool({ name: 'create_expenses', arguments: { expenses: [] } });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(mock.createExpenses as any).not.toHaveBeenCalled();
    });

    it('rejects a batch with an invalid item and posts nothing', async () => {
      const result = await client.callTool({
        name: 'create_expenses',
        arguments: {
          expenses: [
            { category: 'Travel', dated_on: '2026-05-01', gross_value: 10 },
            { category: 'Travel', dated_on: '2026-05-02', gross_value: -5 },
          ],
        },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(parseResult(result)).toMatch(/validation/i);
      expect(mock.createExpenses as any).not.toHaveBeenCalled();
    });
  });
});
