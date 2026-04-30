// End-to-end scenarios — describe the full agent-facing flow, not individual steps.
//
// These tests are written from the perspective of a calling agent that
// invokes the MCP tools directly. They do NOT mock the MCP transport — the
// requests go through a real Server↔Client pair via InMemoryTransport. Only
// the FreeAgent HTTP client is mocked. So whatever text these tests assert
// on is the same text a real agent (Claude, GPT, etc.) would receive.
//
// New invariants about user-facing behaviour belong here. Per-tool unit
// tests live in tool-handlers.test.ts.

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

describe('scenario: "create an invoice for projects X and Y"', () => {
    // Stand-in for the user's request being relayed by an agent. The agent
    // tries the obvious naive call first.
    it('first call: agent issues create_invoice with project_ids, MCP detects unbilled timeslips and refuses with a menu of next steps', async () => {
        vi.mocked(mockFaClient.listTimeslips).mockImplementation(async ({ project }: any) => {
            if (project === 'https://api.freeagent.com/v2/projects/100') {
                return [{ url: 'https://api.freeagent.com/v2/timeslips/1', dated_on: '2026-04-01', hours: '4.0' } as any];
            }
            if (project === 'https://api.freeagent.com/v2/projects/200') {
                return [{ url: 'https://api.freeagent.com/v2/timeslips/2', dated_on: '2026-04-15', hours: '6.0' } as any];
            }
            return [];
        });

        const result = await callTool('create_invoice', {
            contact: 'https://api.freeagent.com/v2/contacts/1',
            project_ids: ['100', '200'],
            dated_on: '2026-04-30',
        });

        // No invoice gets created; the agent must surface the choice to the user.
        expect(mockFaClient.createInvoice).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);

        const text = (result.content as any)[0].text as string;
        // The refusal must spell out exactly what was found, per project, so the
        // user can make an informed decision when the agent relays it back.
        expect(text).toContain('project 100');
        expect(text).toContain('project 200');
        expect(text).toContain('4.00 hour(s)');
        expect(text).toContain('6.00 hour(s)');
        // ...and must enumerate the two retry options the agent can take.
        expect(text).toContain('include_timeslips');
        expect(text).toContain('omit_unbilled_timeslips: true');
    });

    it('second call: agent retries with include_timeslips but no numbering_source — MCP refuses again with the numbering menu', async () => {
        const result = await callTool('create_invoice', {
            contact: 'https://api.freeagent.com/v2/contacts/1',
            project_ids: ['100', '200'],
            dated_on: '2026-04-30',
            include_timeslips: 'billed_grouped_by_timeslip_task',
        });

        // The unbilled-timeslip check is bypassed by include_timeslips, but
        // the multi-project numbering choice must still be made explicitly.
        expect(mockFaClient.listTimeslips).not.toHaveBeenCalled();
        expect(mockFaClient.createInvoice).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);

        const text = (result.content as any)[0].text as string;
        expect(text).toContain('numbering_source');
        expect(text).toContain('"100"');
        expect(text).toContain('"200"');
        expect(text).toContain('"org-wide"');
    });

    it('third call: agent retries with both include_timeslips and numbering_source, MCP forwards to FreeAgent', async () => {
        const created = {
            url: 'https://api.freeagent.com/v2/invoices/42',
            reference: 'PROJ-A-001',
            status: 'Draft',
        };
        vi.mocked(mockFaClient.createInvoice).mockResolvedValue(created as any);

        const result = await callTool('create_invoice', {
            contact: 'https://api.freeagent.com/v2/contacts/1',
            project_ids: ['100', '200'],
            numbering_source: '100',
            dated_on: '2026-04-30',
            include_timeslips: 'billed_grouped_by_timeslip_task',
        });

        expect(mockFaClient.createInvoice).toHaveBeenCalledTimes(1);
        const forwarded = vi.mocked(mockFaClient.createInvoice).mock.calls[0][0];
        // numbering_source=100 → wire project URL points at project 100.
        expect(forwarded.project).toBe('https://api.freeagent.com/v2/projects/100');
        expect(forwarded.project_ids).toEqual(['100', '200']);
        expect(forwarded.include_timeslips).toBe('billed_grouped_by_timeslip_task');

        expect(parseResult(result)).toEqual(created);
    });

    it('alternative happy path: agent uses omit_unbilled_timeslips and numbering_source="org-wide"', async () => {
        const created = { url: 'https://api.freeagent.com/v2/invoices/43', status: 'Draft' };
        vi.mocked(mockFaClient.createInvoice).mockResolvedValue(created as any);

        await callTool('create_invoice', {
            contact: 'https://api.freeagent.com/v2/contacts/1',
            project_ids: ['100', '200'],
            numbering_source: 'org-wide',
            dated_on: '2026-04-30',
            omit_unbilled_timeslips: true,
            invoice_items: [
                { item_type: 'Days', description: 'Consultancy', quantity: '5', price: '1000' },
            ],
        });

        expect(mockFaClient.listTimeslips).not.toHaveBeenCalled();
        expect(mockFaClient.createInvoice).toHaveBeenCalledTimes(1);

        const forwarded = vi.mocked(mockFaClient.createInvoice).mock.calls[0][0];
        // org-wide → no wire project field, FreeAgent uses its own org sequence.
        expect(forwarded.project).toBeUndefined();
        expect(forwarded.project_ids).toEqual(['100', '200']);
        // omit_unbilled_timeslips is purely a tool-level signal; it must not
        // leak into the FreeAgent payload.
        expect(forwarded).not.toHaveProperty('omit_unbilled_timeslips');
        expect(forwarded.invoice_items).toHaveLength(1);
    });
});

describe('scenario: "extend invoice 42 to also cover project Y"', () => {
    it('first call: agent issues update_invoice with the full project list, MCP detects unbilled timeslips on Y and refuses', async () => {
        vi.mocked(mockFaClient.listTimeslips).mockImplementation(async ({ project }: any) => {
            return project === 'https://api.freeagent.com/v2/projects/200'
                ? [{ url: 'https://api.freeagent.com/v2/timeslips/2', dated_on: '2026-04-15', hours: '6.0' } as any]
                : [];
        });

        // Caller passes the complete set: existing project 100 plus the new 200.
        const result = await callTool('update_invoice', {
            id: '42',
            project_ids: ['100', '200'],
        });

        expect(mockFaClient.updateInvoice).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect((result.content as any)[0].text).toContain('project 200');
    });

    it('second call: agent retries with include_timeslips, MCP forwards the PUT', async () => {
        vi.mocked(mockFaClient.updateInvoice).mockResolvedValue({
            url: 'https://api.freeagent.com/v2/invoices/42',
        } as any);

        await callTool('update_invoice', {
            id: '42',
            project_ids: ['100', '200'],
            include_timeslips: 'billed_grouped_by_timeslip_task',
        });

        expect(mockFaClient.listTimeslips).not.toHaveBeenCalled();
        const [, forwarded] = vi.mocked(mockFaClient.updateInvoice).mock.calls[0];
        expect(forwarded.project_ids).toEqual(['100', '200']);
        expect(forwarded.include_timeslips).toBe('billed_grouped_by_timeslip_task');
    });
});

describe('scenario: routine update that does not touch project scope', () => {
    it('agent updates only the comments field — MCP forwards the change without any timeslip lookup', async () => {
        vi.mocked(mockFaClient.updateInvoice).mockResolvedValue({
            url: 'https://api.freeagent.com/v2/invoices/42',
        } as any);

        await callTool('update_invoice', { id: '42', comments: 'Per agreed billing period' });

        // Routine updates intentionally skip the timeslip safety check — the
        // user already accepted whatever timeslip state the invoice was created
        // with; revisiting that decision on every comment edit would be noise.
        expect(mockFaClient.listTimeslips).not.toHaveBeenCalled();
        expect(mockFaClient.getInvoice).not.toHaveBeenCalled();
        expect(mockFaClient.updateInvoice).toHaveBeenCalledWith('42', { comments: 'Per agreed billing period' });
    });
});
