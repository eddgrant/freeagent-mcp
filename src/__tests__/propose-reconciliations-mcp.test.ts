// End-to-end test: drive propose_reconciliations through a real MCP
// Server↔Client transport pair with a mocked FreeAgentClient. Verifies
// argument plumbing, history aggregation against canned explained
// transactions, the staging field shape, and structured errors.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { FreeAgentClient } from '../freeagent-client.js';
import type { BankAccount, BankTransaction } from '../types.js';
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

afterAll(async () => { await client.close(); });

const ACCOUNT_URL = 'https://api.freeagent.com/v2/bank_accounts/721314';
const CAT_TRAVEL = 'https://api.freeagent.com/v2/categories/365';

const account: BankAccount = {
  url: ACCOUNT_URL,
  name: 'Business Account',
  bank_name: 'Starling',
  type: 'StandardBankAccount',
  is_personal: false,
  is_primary: true,
  status: 'active',
  currency: 'GBP',
  current_balance: '0.0',
  opening_balance: '0.0',
  created_at: '',
  updated_at: '',
};

function tx(args: { id: string; description: string; dated_on: string; amount: string; explained?: boolean }): BankTransaction {
  return {
    url: `https://api.freeagent.com/v2/bank_transactions/${args.id}`,
    amount: args.amount,
    bank_account: ACCOUNT_URL,
    dated_on: args.dated_on,
    description: args.description,
    unexplained_amount: args.explained ? '0.0' : args.amount,
    is_manual: false,
    created_at: '',
    updated_at: '',
    bank_transaction_explanations: args.explained
      ? [{
          url: `https://api.freeagent.com/v2/bank_transaction_explanations/${args.id}`,
          dated_on: args.dated_on,
          gross_value: args.amount,
          category: CAT_TRAVEL,
          sales_tax_rate: '0.0',
        }]
      : [],
  };
}

describe('propose_reconciliations (via MCP)', () => {
  describe('happy path', () => {
    it('seeds category from history and returns a structured response', async () => {
      vi.mocked(mockFaClient.getBankAccount).mockResolvedValue(account);
      // History: 5 prior TfL transactions, all categorised as Travel.
      const history = ['2026-01-05', '2026-01-12', '2026-02-08', '2026-03-02', '2026-04-01'].map((d, i) =>
        tx({ id: `100${i}`, description: 'TfL (Google Pay)/TFL TRAVEL CH/POS/', dated_on: d, amount: '-10', explained: true }),
      );
      const unexplained = [
        tx({ id: '5001', description: 'TfL (Contactless)/TFL TRAVEL CH/POS/', dated_on: '2026-04-15', amount: '-10' }),
      ];
      vi.mocked(mockFaClient.listBankTransactions).mockImplementation(async (params) => {
        return params.view === 'unexplained' ? unexplained : history;
      });

      const result = await client.callTool({
        name: 'propose_reconciliations',
        arguments: { bank_account: ACCOUNT_URL, from_date: '2026-04-01', to_date: '2026-04-30' },
      });

      const parsed = parseResult(result) as any;
      expect(parsed.proposals).toHaveLength(1);
      expect(parsed.proposals[0].explanations[0].category).toBe(CAT_TRAVEL);
      expect(parsed.proposals[0].overall_confidence).toBeGreaterThanOrEqual(0.8);
      expect(parsed.staging).toBeDefined();
      expect(parsed.history_coverage).toEqual({ months_analysed: 12, explanations_seen: 5 });
      expect(parsed.notes).toEqual([]);
      expect(parsed.truncated).toBe(false);
    });

    it('accepts a numeric ID for bank_account and resolves to the URL via getBankAccount', async () => {
      vi.mocked(mockFaClient.getBankAccount).mockResolvedValue(account);
      vi.mocked(mockFaClient.listBankTransactions).mockResolvedValue([]);

      await client.callTool({
        name: 'propose_reconciliations',
        arguments: { bank_account: '721314', from_date: '2026-04-01', to_date: '2026-04-30' },
      });

      expect(mockFaClient.getBankAccount).toHaveBeenCalledWith('721314');
      // Subsequent listBankTransactions calls use the URL returned by the account.
      const calls = vi.mocked(mockFaClient.listBankTransactions).mock.calls;
      expect(calls.every(c => c[0].bank_account === ACCOUNT_URL)).toBe(true);
    });

    it('queries 12 months of history for the explained pass', async () => {
      vi.mocked(mockFaClient.getBankAccount).mockResolvedValue(account);
      vi.mocked(mockFaClient.listBankTransactions).mockResolvedValue([]);

      await client.callTool({
        name: 'propose_reconciliations',
        arguments: { bank_account: ACCOUNT_URL, from_date: '2026-05-01', to_date: '2026-05-31' },
      });

      const calls = vi.mocked(mockFaClient.listBankTransactions).mock.calls;
      const explainedCall = calls.find(c => c[0].view === 'explained');
      expect(explainedCall).toBeDefined();
      // 2026-05-01 minus 12 months → 2025-05-01
      expect(explainedCall?.[0].from_date).toBe('2025-05-01');
    });
  });

  describe('guards', () => {
    it('skips transfers and surfaces them in notes[]', async () => {
      vi.mocked(mockFaClient.getBankAccount).mockResolvedValue(account);
      const history = ['2026-01-01', '2026-02-01', '2026-03-01'].map((d, i) => ({
        ...tx({ id: `t${i}`, description: 'Tide (Faster Payments Out)/Savings/PAYMENT/', dated_on: d, amount: '-1000', explained: true }),
        bank_transaction_explanations: [{
          url: '', dated_on: d, gross_value: '-1000',
          transfer_bank_account: 'https://api.freeagent.com/v2/bank_accounts/2',
        }],
      }));
      const unexplained = [tx({ id: '5001', description: 'Tide (Faster Payments Out)/Savings/PAYMENT/', dated_on: '2026-04-01', amount: '-1000' })];
      vi.mocked(mockFaClient.listBankTransactions).mockImplementation(async (params) =>
        params.view === 'unexplained' ? unexplained : history,
      );

      const result = await client.callTool({
        name: 'propose_reconciliations',
        arguments: { bank_account: ACCOUNT_URL, from_date: '2026-04-01', to_date: '2026-04-30' },
      });
      const parsed = parseResult(result) as any;
      expect(parsed.proposals).toHaveLength(0);
      expect(parsed.notes[0]).toMatch(/inter-account transfer/);
    });
  });

  describe('input validation', () => {
    it('returns structured error for missing bank_account', async () => {
      const result = await client.callTool({
        name: 'propose_reconciliations',
        arguments: { from_date: '2026-04-01', to_date: '2026-04-30' },
      });
      const parsed = parseResult(result) as any;
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('invalid_arguments');
      expect(parsed.error.message).toMatch(/bank_account/);
    });

    it('returns structured error for unparseable bank_account', async () => {
      const result = await client.callTool({
        name: 'propose_reconciliations',
        arguments: { bank_account: 'not-a-url-or-id', from_date: '2026-04-01', to_date: '2026-04-30' },
      });
      const parsed = parseResult(result) as any;
      expect(parsed.ok).toBe(false);
    });

    it('returns structured error for missing dates', async () => {
      const result = await client.callTool({
        name: 'propose_reconciliations',
        arguments: { bank_account: ACCOUNT_URL },
      });
      const parsed = parseResult(result) as any;
      expect(parsed.ok).toBe(false);
      expect(parsed.error.message).toMatch(/from_date and to_date/);
    });
  });

  describe('limit', () => {
    it('truncates and reports when more than `limit` unexplained transactions exist', async () => {
      vi.mocked(mockFaClient.getBankAccount).mockResolvedValue(account);
      const unexplained = Array.from({ length: 75 }, (_, i) =>
        tx({ id: `${i}`, description: `Merchant ${i} (Card Payment)/M${i}/POS/`, dated_on: '2026-04-01', amount: '-1' }),
      );
      vi.mocked(mockFaClient.listBankTransactions).mockImplementation(async (params) =>
        params.view === 'unexplained' ? unexplained : [],
      );

      const result = await client.callTool({
        name: 'propose_reconciliations',
        arguments: { bank_account: ACCOUNT_URL, from_date: '2026-04-01', to_date: '2026-04-30', limit: 50 },
      });
      const parsed = parseResult(result) as any;
      expect(parsed.proposals).toHaveLength(50);
      expect(parsed.truncated).toBe(true);
    });

    it('clamps `limit` at 200', async () => {
      vi.mocked(mockFaClient.getBankAccount).mockResolvedValue(account);
      const unexplained = Array.from({ length: 250 }, (_, i) =>
        tx({ id: `${i}`, description: `M ${i} (Card Payment)/M/POS/`, dated_on: '2026-04-01', amount: '-1' }),
      );
      vi.mocked(mockFaClient.listBankTransactions).mockImplementation(async (params) =>
        params.view === 'unexplained' ? unexplained : [],
      );

      const result = await client.callTool({
        name: 'propose_reconciliations',
        arguments: { bank_account: ACCOUNT_URL, from_date: '2026-04-01', to_date: '2026-04-30', limit: 1000 },
      });
      const parsed = parseResult(result) as any;
      expect(parsed.proposals).toHaveLength(200);
      expect(parsed.truncated).toBe(true);
    });
  });
});
