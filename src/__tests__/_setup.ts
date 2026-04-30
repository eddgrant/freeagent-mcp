// Shared test bootstrap for tests that exercise the MCP server through a
// real Server↔Client transport pair. Files importing from here drive the
// MCP at the same surface a calling agent (Claude, GPT, etc.) would.
//
// Not picked up by vitest (the run config only matches *.test.ts).

import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FreeAgentServer } from '../index.js';
import type { FreeAgentClient } from '../freeagent-client.js';

export function createMockFreeAgentClient(): FreeAgentClient {
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
        getProfitAndLossSummary: vi.fn(),
        listCategories: vi.fn(),
        listBankAccounts: vi.fn(),
        listBankTransactions: vi.fn(),
        listBankTransactionExplanations: vi.fn(),
        listBills: vi.fn(),
        getBill: vi.fn(),
    } as unknown as FreeAgentClient;
}

export async function connectTestMcpClient(mockFaClient: FreeAgentClient): Promise<Client> {
    const faServer = new FreeAgentServer(mockFaClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await faServer.run(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    return client;
}

export function clearMockClient(mockFaClient: FreeAgentClient): void {
    Object.values(mockFaClient).forEach((fn) => {
        if (typeof fn === 'function' && 'mockClear' in fn) {
            (fn as ReturnType<typeof vi.fn>).mockClear();
        }
    });
}

export function parseToolResult(result: { content: unknown }): unknown {
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    try { return JSON.parse(text); } catch { return text; }
}
