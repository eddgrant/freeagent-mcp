// End-to-end tests for the mileage tools through a real MCP transport.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  createMockFreeAgentClient,
  connectTestMcpClient,
  parseToolResult as parseResult,
} from './_setup.js';
import type { FreeAgentClient } from '../freeagent-client.js';
import type { ExpenseCreatePayload, MileageSettings } from '../types.js';

const CURRENT_USER = 'https://api.freeagent.com/v2/users/1';

const settings: MileageSettings = {
  engine_type_and_size_options: [
    { from: '2020-04-06', to: null, value: { Petrol: ['Up to 1400cc', 'Over 2000cc'], Diesel: ['Up to 1600cc'] } },
  ],
  mileage_rates: [],
};

describe('mileage tools (via MCP)', () => {
  let client: Client;
  let mock: FreeAgentClient;

  beforeEach(async () => {
    mock = createMockFreeAgentClient();
    (mock.getCurrentUser as any).mockResolvedValue({ url: CURRENT_USER, first_name: 'Edd', last_name: 'Grant', email: 'edd@co.com' });
    (mock.getMileageSettings as any).mockResolvedValue(settings);
    (mock.createExpense as any).mockResolvedValue({ url: 'https://api.freeagent.com/v2/expenses/1', user: CURRENT_USER, dated_on: '2026-05-01', created_at: '', updated_at: '' });
    client = await connectTestMcpClient(mock);
  });

  afterEach(async () => { await client.close(); });

  it('registers the mileage tools', async () => {
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_mileage_settings', 'create_mileage_expense']));
  });

  it('get_mileage_settings returns the raw settings', async () => {
    const result = await client.callTool({ name: 'get_mileage_settings', arguments: {} });
    expect(parseResult(result)).toEqual(settings);
  });

  it('creates a car mileage claim, defaulting the engine type and validating the size', async () => {
    await client.callTool({
      name: 'create_mileage_expense',
      arguments: { dated_on: '2026-05-01', mileage: 47, vehicle_type: 'Car', engine_size: 'up to 1400cc' },
    });
    const payload = (mock.createExpense as any).mock.calls[0][0] as ExpenseCreatePayload;
    expect(payload).toMatchObject({
      category: 'Mileage',
      mileage: '47',
      vehicle_type: 'Car',
      engine_type: 'Petrol',
      engine_size: 'Up to 1400cc',
      reclaim_mileage: 1,
      user: CURRENT_USER,
    });
    expect(payload.gross_value).toBeUndefined();
  });

  it('creates a bicycle claim without consulting mileage settings', async () => {
    await client.callTool({
      name: 'create_mileage_expense',
      arguments: { dated_on: '2026-05-01', mileage: 8, vehicle_type: 'Bicycle' },
    });
    expect(mock.getMileageSettings as any).not.toHaveBeenCalled();
    const payload = (mock.createExpense as any).mock.calls[0][0] as ExpenseCreatePayload;
    expect(payload.vehicle_type).toBe('Bicycle');
    expect(payload.engine_type).toBeUndefined();
  });

  it('returns a helpful error for an invalid engine size', async () => {
    const result = await client.callTool({
      name: 'create_mileage_expense',
      arguments: { dated_on: '2026-05-01', mileage: 47, vehicle_type: 'Car', engine_size: '9000cc' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(parseResult(result)).toMatch(/not valid.*Up to 1400cc/s);
    expect(mock.createExpense as any).not.toHaveBeenCalled();
  });

  it('still creates the claim when mileage settings are unavailable', async () => {
    (mock.getMileageSettings as any).mockRejectedValue(new Error('503'));
    await client.callTool({
      name: 'create_mileage_expense',
      arguments: { dated_on: '2026-05-01', mileage: 47, vehicle_type: 'Car', engine_size: 'Up to 1400cc' },
    });
    const payload = (mock.createExpense as any).mock.calls[0][0] as ExpenseCreatePayload;
    expect(payload.engine_type).toBe('Petrol');
    expect(payload.engine_size).toBe('Up to 1400cc');
  });
});
