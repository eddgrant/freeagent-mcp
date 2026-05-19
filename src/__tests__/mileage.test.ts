// Unit tests for mileage-claim handling: date-scoped engine resolution
// and wire-payload building. Input-shape validation is now the Zod
// schema's job — exercised via the MCP-transport tests in mileage-mcp.

import { describe, it, expect } from 'vitest';
import {
  findEngineOptionsForDate,
  resolveEngine,
  buildMileagePayload,
  type CreateMileageExpenseInput,
} from '../mileage.js';
import type { MileageSettings } from '../types.js';

const settings: MileageSettings = {
  engine_type_and_size_options: [
    { from: '2020-04-06', to: '2025-04-05', value: { Petrol: ['Up to 1400cc', '1401cc to 2000cc'], Diesel: ['Up to 1600cc'] } },
    { from: '2025-04-06', to: null, value: { Petrol: ['Up to 1400cc', 'Over 2000cc'], Electric: ['N/A'] } },
  ],
  mileage_rates: [],
};

describe('findEngineOptionsForDate', () => {
  it('returns the engine map for the covering period', () => {
    expect(findEngineOptionsForDate(settings, '2024-06-01')).toEqual({
      Petrol: ['Up to 1400cc', '1401cc to 2000cc'],
      Diesel: ['Up to 1600cc'],
    });
  });

  it('matches an open-ended (to: null) current period', () => {
    expect(Object.keys(findEngineOptionsForDate(settings, '2026-05-01')!)).toEqual(['Petrol', 'Electric']);
  });

  it('returns null when no period covers the date', () => {
    expect(findEngineOptionsForDate(settings, '2010-01-01')).toBeNull();
  });

  it('returns null when the settings have no options array', () => {
    expect(findEngineOptionsForDate({}, '2026-05-01')).toBeNull();
  });
});

describe('resolveEngine', () => {
  const options = settings.engine_type_and_size_options![0].value!;

  it('returns no engine fields for a bicycle', () => {
    expect(resolveEngine(options, { vehicle_type: 'Bicycle', dated_on: '2024-06-01' })).toEqual({});
  });

  it('resolves a valid engine type and size case-insensitively', () => {
    expect(resolveEngine(options, { vehicle_type: 'Car', engine_type: 'petrol', engine_size: 'up to 1400cc', dated_on: '2024-06-01' }))
      .toEqual({ engine_type: 'Petrol', engine_size: 'Up to 1400cc' });
  });

  it('defaults the engine type to Petrol when omitted', () => {
    expect(resolveEngine(options, { vehicle_type: 'Car', engine_size: 'Up to 1400cc', dated_on: '2024-06-01' }).engine_type)
      .toBe('Petrol');
  });

  it('throws, listing valid types, for an unknown engine type', () => {
    expect(() => resolveEngine(options, { vehicle_type: 'Car', engine_type: 'Nuclear', engine_size: 'x', dated_on: '2024-06-01' }))
      .toThrow(/not valid.*Petrol, Diesel/s);
  });

  it('throws, listing valid sizes, when engine_size is missing', () => {
    expect(() => resolveEngine(options, { vehicle_type: 'Car', engine_type: 'Diesel', dated_on: '2024-06-01' }))
      .toThrow(/engine_size is required.*Up to 1600cc/s);
  });

  it('throws, listing valid sizes, for an unknown engine size', () => {
    expect(() => resolveEngine(options, { vehicle_type: 'Car', engine_type: 'Petrol', engine_size: '5000cc', dated_on: '2024-06-01' }))
      .toThrow(/not valid.*Up to 1400cc/s);
  });

  it('passes values through when options could not be loaded', () => {
    expect(resolveEngine(null, { vehicle_type: 'Car', engine_size: '1600cc', dated_on: '2024-06-01' }))
      .toEqual({ engine_type: 'Petrol', engine_size: '1600cc' });
  });

  it('still requires engine_size when options could not be loaded', () => {
    expect(() => resolveEngine(null, { vehicle_type: 'Motorcycle', dated_on: '2024-06-01' }))
      .toThrow(/engine_size is required/);
  });
});

describe('buildMileagePayload', () => {
  it('builds the Mileage wire payload with no gross_value', () => {
    const input: CreateMileageExpenseInput = { dated_on: '2026-05-01', mileage: 47, vehicle_type: 'Car' };
    const payload = buildMileagePayload(input, {
      user: 'https://api.freeagent.com/v2/users/1',
      engine: { engine_type: 'Petrol', engine_size: 'Up to 1400cc' },
    });
    expect(payload).toEqual({
      user: 'https://api.freeagent.com/v2/users/1',
      dated_on: '2026-05-01',
      category: 'Mileage',
      mileage: '47',
      vehicle_type: 'Car',
      reclaim_mileage: 1,
      engine_type: 'Petrol',
      engine_size: 'Up to 1400cc',
    });
    expect(payload.gross_value).toBeUndefined();
  });

  it('defaults reclaim_mileage to 1 (AMAP) when omitted', () => {
    const input: CreateMileageExpenseInput = { dated_on: '2026-05-01', mileage: 12, vehicle_type: 'Bicycle' };
    expect(buildMileagePayload(input, { user: 'u/1', engine: {} }).reclaim_mileage).toBe(1);
  });

  it('maps reclaim_mileage: false to 0 and omits engine fields for a bicycle', () => {
    const input: CreateMileageExpenseInput = { dated_on: '2026-05-01', mileage: 10, vehicle_type: 'Bicycle', reclaim_mileage: false };
    const payload = buildMileagePayload(input, { user: 'u/1', engine: {} });
    expect(payload.reclaim_mileage).toBe(0);
    expect(payload.engine_type).toBeUndefined();
    expect(payload.vehicle_type).toBe('Bicycle');
  });
});
