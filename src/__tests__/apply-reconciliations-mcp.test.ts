// End-to-end test: drive apply_reconciliations through the real
// MCP Server↔Client transport pair with a mocked FreeAgentClient.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FreeAgentClient } from '../freeagent-client.js';
import type { BankTransaction } from '../types.js';
import { idempotencyKey } from '../apply-reconciliations.js';
import {
  createMockFreeAgentClient,
  connectTestMcpClient,
  clearMockClient,
  parseToolResult as parseResult,
} from './_setup.js';

const TX_URL = 'https://api.freeagent.com/v2/bank_transactions/123';
const ACCOUNT_URL = 'https://api.freeagent.com/v2/bank_accounts/9';
const CAT_TRAVEL = 'https://api.freeagent.com/v2/categories/365';

function unexplainedTx(): BankTransaction {
  return {
    url: TX_URL, amount: '-10', bank_account: ACCOUNT_URL, dated_on: '2026-04-01',
    description: 'TfL', unexplained_amount: '-10', is_manual: false,
    created_at: '', updated_at: '', bank_transaction_explanations: [],
  };
}

function makeExp(extra: Record<string, unknown> = {}) {
  const dated_on = '2026-04-01', gross_value = '-10';
  return {
    bank_transaction: TX_URL,
    dated_on,
    gross_value,
    category: CAT_TRAVEL,
    description: 'TfL trip',
    idempotency_key: idempotencyKey({
      bank_transaction: TX_URL, gross_value, dated_on, category: CAT_TRAVEL, description: 'TfL trip',
    }),
    ...extra,
  };
}

describe('apply_reconciliations (via MCP)', () => {
  describe('with staging mounted', () => {
    let client: Client;
    let mockFaClient: FreeAgentClient;
    let stagingDir: string;

    beforeAll(async () => {
      stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-mcp-'));
      mockFaClient = createMockFreeAgentClient();
      client = await connectTestMcpClient(mockFaClient, { stagingSessionPath: stagingDir });
    });

    beforeEach(() => clearMockClient(mockFaClient));

    afterAll(async () => {
      await client.close();
      fs.rmSync(stagingDir, { recursive: true, force: true });
    });

    it('lists apply_reconciliations in tools/list', async () => {
      const tools = await client.listTools();
      expect(tools.tools.map(t => t.name)).toContain('apply_reconciliations');
    });

    it('posts a category-only explanation and returns ApplyResult', async () => {
      vi.mocked(mockFaClient.getBankTransaction).mockResolvedValue(unexplainedTx());
      vi.mocked(mockFaClient.createBankTransactionExplanation).mockResolvedValue({
        url: 'https://api.freeagent.com/v2/bank_transaction_explanations/777',
        dated_on: '2026-04-01', gross_value: '-10',
      } as any);

      const result = await client.callTool({
        name: 'apply_reconciliations',
        arguments: { explanations: [makeExp()] },
      });
      const parsed = parseResult(result) as any;
      expect(parsed.posted).toHaveLength(1);
      expect(parsed.posted[0].explanation_url).toBe('https://api.freeagent.com/v2/bank_transaction_explanations/777');
      expect(parsed.skipped).toEqual([]);
      expect(parsed.failed).toEqual([]);
    });

    it('skips with duplicate_of_existing_explanation on retry', async () => {
      const exp = makeExp();
      const tx = unexplainedTx();
      tx.unexplained_amount = '0';
      tx.bank_transaction_explanations = [{
        url: 'x', gross_value: '-10', dated_on: '2026-04-01',
        category: CAT_TRAVEL, description: 'TfL trip',
      }];
      vi.mocked(mockFaClient.getBankTransaction).mockResolvedValue(tx);

      const result = await client.callTool({
        name: 'apply_reconciliations',
        arguments: { explanations: [exp] },
      });
      const parsed = parseResult(result) as any;
      expect(parsed.skipped[0].reason).toBe('duplicate_of_existing_explanation');
      expect(mockFaClient.createBankTransactionExplanation).not.toHaveBeenCalled();
    });

    it('attaches bytes from a staged file', async () => {
      const file = path.join(stagingDir, 'r.pdf');
      fs.writeFileSync(file, Buffer.from('hello'));

      vi.mocked(mockFaClient.getBankTransaction).mockResolvedValue(unexplainedTx());
      vi.mocked(mockFaClient.createBankTransactionExplanation).mockResolvedValue({
        url: 'https://api.freeagent.com/v2/bank_transaction_explanations/777',
        dated_on: '2026-04-01', gross_value: '-10',
      } as any);

      await client.callTool({
        name: 'apply_reconciliations',
        arguments: {
          explanations: [makeExp({
            attachment: { evidence_path: file, file_name: 'r.pdf', content_type: 'application/pdf' },
          })],
        },
      });

      const call = vi.mocked(mockFaClient.createBankTransactionExplanation).mock.calls[0][0];
      expect(call.attachment?.data).toBe(Buffer.from('hello').toString('base64'));
    });

    it('continues processing after a per-explanation failure (best-effort batch)', async () => {
      vi.mocked(mockFaClient.getBankTransaction).mockResolvedValue(unexplainedTx());
      vi.mocked(mockFaClient.createBankTransactionExplanation)
        .mockRejectedValueOnce(Object.assign(new Error('first failed'), { response: { status: 422 } }))
        .mockResolvedValueOnce({
          url: 'https://api.freeagent.com/v2/bank_transaction_explanations/2',
          dated_on: '2026-04-02', gross_value: '-5',
        } as any);

      const result = await client.callTool({
        name: 'apply_reconciliations',
        arguments: {
          explanations: [
            makeExp({ idempotency_key: 'k1', dated_on: '2026-04-01' }),
            makeExp({ idempotency_key: 'k2', dated_on: '2026-04-02', gross_value: '-5' }),
          ],
        },
      });
      const parsed = parseResult(result) as any;
      expect(parsed.posted).toHaveLength(1);
      expect(parsed.failed).toHaveLength(1);
      expect(parsed.failed[0].http_status).toBe(422);
    });
  });

  describe('input validation', () => {
    let client: Client;
    let mockFaClient: FreeAgentClient;

    beforeAll(async () => {
      mockFaClient = createMockFreeAgentClient();
      client = await connectTestMcpClient(mockFaClient);
    });

    afterAll(async () => { await client.close(); });

    it('rejects missing explanations array', async () => {
      const result = await client.callTool({ name: 'apply_reconciliations', arguments: {} });
      const parsed = parseResult(result) as any;
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('invalid_arguments');
    });

    it('rejects empty explanations array', async () => {
      const result = await client.callTool({ name: 'apply_reconciliations', arguments: { explanations: [] } });
      const parsed = parseResult(result) as any;
      expect(parsed.ok).toBe(false);
    });

    it('rejects batches >100', async () => {
      const result = await client.callTool({
        name: 'apply_reconciliations',
        arguments: { explanations: Array.from({ length: 101 }, () => makeExp()) },
      });
      const parsed = parseResult(result) as any;
      expect(parsed.ok).toBe(false);
      expect(parsed.error.message).toMatch(/100/);
    });
  });

  describe('with staging not mounted', () => {
    let client: Client;
    let mockFaClient: FreeAgentClient;

    beforeAll(async () => {
      mockFaClient = createMockFreeAgentClient();
      client = await connectTestMcpClient(mockFaClient);
    });

    beforeEach(() => clearMockClient(mockFaClient));

    afterAll(async () => { await client.close(); });

    it('still posts category-only explanations (attachments not required)', async () => {
      vi.mocked(mockFaClient.getBankTransaction).mockResolvedValue(unexplainedTx());
      vi.mocked(mockFaClient.createBankTransactionExplanation).mockResolvedValue({
        url: 'https://api.freeagent.com/v2/bank_transaction_explanations/777',
        dated_on: '2026-04-01', gross_value: '-10',
      } as any);

      const result = await client.callTool({
        name: 'apply_reconciliations',
        arguments: { explanations: [makeExp()] },
      });
      const parsed = parseResult(result) as any;
      expect(parsed.posted).toHaveLength(1);
    });

    it('skips explanations whose attachment requires the staging volume', async () => {
      vi.mocked(mockFaClient.getBankTransaction).mockResolvedValue(unexplainedTx());

      const result = await client.callTool({
        name: 'apply_reconciliations',
        arguments: {
          explanations: [makeExp({
            attachment: { evidence_path: '/tmp/x.pdf', file_name: 'x.pdf', content_type: 'application/pdf' },
          })],
        },
      });
      const parsed = parseResult(result) as any;
      expect(parsed.skipped[0].reason).toBe('staging_volume_not_mounted');
      expect(parsed.posted).toHaveLength(0);
    });
  });
});
