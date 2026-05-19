// Unit tests for the curated expense input handling: validation, the
// out-of-pocket sign convention, and wire-payload building.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  validateCreateExpenseInput,
  validateUpdateExpenseInput,
  buildExpensePayload,
  buildExpenseUpdatePayload,
  applySign,
  readStagedAttachment,
} from '../expenses.js';

const USER = 'https://api.freeagent.com/v2/users/1';
const CATEGORY = 'https://api.freeagent.com/v2/categories/285';

describe('applySign', () => {
  it('negates an out-of-pocket amount (payment owed to the claimant)', () => {
    expect(applySign('12.50', false)).toBe('-12.50');
  });

  it('keeps a refund-due amount positive (claimant owes the company)', () => {
    expect(applySign('12.50', true)).toBe('12.50');
  });
});

describe('validateCreateExpenseInput', () => {
  it('accepts a minimal valid expense', () => {
    const input = validateCreateExpenseInput({ category: 'Travel', dated_on: '2026-05-01', gross_value: 42 });
    expect(input).toMatchObject({ category: 'Travel', dated_on: '2026-05-01', gross_value: '42', refund_due: false });
  });

  it('accepts gross_value as a numeric string and preserves its formatting', () => {
    expect(validateCreateExpenseInput({ category: 'Travel', dated_on: '2026-05-01', gross_value: '42.00' }).gross_value)
      .toBe('42.00');
  });

  it('rejects a missing category', () => {
    expect(() => validateCreateExpenseInput({ dated_on: '2026-05-01', gross_value: 1 }))
      .toThrow(/category is required/);
  });

  it('rejects a missing dated_on', () => {
    expect(() => validateCreateExpenseInput({ category: 'Travel', gross_value: 1 }))
      .toThrow(/dated_on is required/);
  });

  it('rejects a missing gross_value', () => {
    expect(() => validateCreateExpenseInput({ category: 'Travel', dated_on: '2026-05-01' }))
      .toThrow(/gross_value is required/);
  });

  it('rejects a negative gross_value and points at refund_due', () => {
    expect(() => validateCreateExpenseInput({ category: 'Travel', dated_on: '2026-05-01', gross_value: -5 }))
      .toThrow(/positive amount.*refund_due/s);
  });

  it('rejects a zero gross_value', () => {
    expect(() => validateCreateExpenseInput({ category: 'Travel', dated_on: '2026-05-01', gross_value: 0 }))
      .toThrow(/positive amount/);
  });

  it('steers mileage claims to the dedicated tool', () => {
    expect(() => validateCreateExpenseInput({ category: 'Mileage', dated_on: '2026-05-01', gross_value: 1 }))
      .toThrow(/create_mileage_expense/);
  });

  it('validates the sales_tax_status enum', () => {
    expect(() => validateCreateExpenseInput({ category: 'Travel', dated_on: '2026-05-01', gross_value: 1, sales_tax_status: 'MAYBE' }))
      .toThrow(/sales_tax_status must be one of/);
  });

  it('rejects an attachment missing evidence_path', () => {
    expect(() => validateCreateExpenseInput({
      category: 'Travel', dated_on: '2026-05-01', gross_value: 1,
      attachment: { file_name: 'r.pdf', content_type: 'application/pdf' },
    })).toThrow(/attachment.evidence_path is required/);
  });
});

describe('buildExpensePayload', () => {
  it('builds an out-of-pocket payload with a negative gross_value', () => {
    const input = validateCreateExpenseInput({ category: 'Travel', dated_on: '2026-05-01', gross_value: 42 });
    const payload = buildExpensePayload(input, { user: USER, category: CATEGORY });
    expect(payload).toEqual({
      user: USER,
      category: CATEGORY,
      dated_on: '2026-05-01',
      gross_value: '-42',
    });
  });

  it('keeps gross_value positive when refund_due is set', () => {
    const input = validateCreateExpenseInput({ category: 'Travel', dated_on: '2026-05-01', gross_value: 42, refund_due: true });
    expect(buildExpensePayload(input, { user: USER, category: CATEGORY }).gross_value).toBe('42');
  });

  it('carries optional sales-tax, description and attachment fields through', () => {
    const input = validateCreateExpenseInput({
      category: 'Travel', dated_on: '2026-05-01', gross_value: 10,
      description: 'Train to client', sales_tax_rate: '20.0', sales_tax_status: 'TAXABLE',
    });
    const payload = buildExpensePayload(input, {
      user: USER, category: CATEGORY,
      attachment: { data: 'YWJj', file_name: 'r.pdf', content_type: 'application/pdf' },
    });
    expect(payload.description).toBe('Train to client');
    expect(payload.sales_tax_rate).toBe('20.0');
    expect(payload.sales_tax_status).toBe('TAXABLE');
    expect(payload.attachment?.file_name).toBe('r.pdf');
  });
});

describe('validateUpdateExpenseInput / buildExpenseUpdatePayload', () => {
  it('produces an empty payload when nothing is supplied', () => {
    const input = validateUpdateExpenseInput({ id: '5' });
    expect(buildExpenseUpdatePayload(input, {})).toEqual({});
  });

  it('updates only the supplied fields', () => {
    const input = validateUpdateExpenseInput({ id: '5', description: 'Updated' });
    expect(buildExpenseUpdatePayload(input, {})).toEqual({ description: 'Updated' });
  });

  it('applies the sign convention to an updated gross_value', () => {
    const outOfPocket = validateUpdateExpenseInput({ id: '5', gross_value: 30 });
    expect(buildExpenseUpdatePayload(outOfPocket, {}).gross_value).toBe('-30');

    const refund = validateUpdateExpenseInput({ id: '5', gross_value: 30, refund_due: true });
    expect(buildExpenseUpdatePayload(refund, {}).gross_value).toBe('30');
  });

  it('includes resolved category/user URLs only when supplied', () => {
    const input = validateUpdateExpenseInput({ id: '5', category: 'Travel' });
    expect(buildExpenseUpdatePayload(input, { category: CATEGORY })).toEqual({ category: CATEGORY });
  });
});

describe('readStagedAttachment', () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-attach-'));
    file = path.join(dir, 'receipt.pdf');
    fs.writeFileSync(file, Buffer.from('%PDF-1.4 test', 'utf8'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a staged file and base64-encodes it', () => {
    const payload = readStagedAttachment(
      { evidence_path: file, file_name: 'receipt.pdf', content_type: 'application/pdf' },
      dir,
    );
    expect(Buffer.from(payload.data, 'base64').toString('utf8')).toBe('%PDF-1.4 test');
    expect(payload.file_name).toBe('receipt.pdf');
    expect(payload.content_type).toBe('application/pdf');
  });

  it('throws when the staging volume is not mounted', () => {
    expect(() => readStagedAttachment(
      { evidence_path: file, file_name: 'receipt.pdf', content_type: 'application/pdf' },
      null,
    )).toThrow(/staging volume is not mounted/);
  });

  it('throws when the path escapes the staging directory', () => {
    expect(() => readStagedAttachment(
      { evidence_path: '/etc/passwd', file_name: 'passwd', content_type: 'application/pdf' },
      dir,
    )).toThrow(/attachment validation failed/);
  });
});

describe('advanced expense modes (Phase 3)', () => {
  const base = { category: 'Travel', dated_on: '2026-05-01', gross_value: 10 };

  describe('rebilling', () => {
    it('accepts rebill_type "cost" with a project', () => {
      const input = validateCreateExpenseInput({ ...base, project: 'Acme', rebill_type: 'cost' });
      expect(input.rebill_type).toBe('cost');
      expect(input.project).toBe('Acme');
    });

    it('requires rebill_factor for rebill_type "markup"', () => {
      expect(() => validateCreateExpenseInput({ ...base, project: 'Acme', rebill_type: 'markup' }))
        .toThrow(/rebill_factor is required/);
    });

    it('accepts rebill_type "price" with a rebill_factor', () => {
      const input = validateCreateExpenseInput({ ...base, project: 'Acme', rebill_type: 'price', rebill_factor: '250' });
      expect(input.rebill_factor).toBe('250');
    });

    it('rejects rebill_type without a project', () => {
      expect(() => validateCreateExpenseInput({ ...base, rebill_type: 'cost' }))
        .toThrow(/without a project/);
    });

    it('rejects rebill_factor without rebill_type', () => {
      expect(() => validateCreateExpenseInput({ ...base, project: 'Acme', rebill_factor: '10' }))
        .toThrow(/without a rebill_type/);
    });

    it('rejects an unknown rebill_type', () => {
      expect(() => validateCreateExpenseInput({ ...base, project: 'Acme', rebill_type: 'discount' }))
        .toThrow(/rebill_type must be one of/);
    });

    it('puts the resolved project URL and rebill fields into the payload', () => {
      const input = validateCreateExpenseInput({ ...base, project: 'Acme', rebill_type: 'markup', rebill_factor: '15' });
      const payload = buildExpensePayload(input, {
        user: USER, category: CATEGORY, project: 'https://api.freeagent.com/v2/projects/9',
      });
      expect(payload.project).toBe('https://api.freeagent.com/v2/projects/9');
      expect(payload.rebill_type).toBe('markup');
      expect(payload.rebill_factor).toBe('15');
    });
  });

  describe('recurring', () => {
    it('accepts a valid recurring frequency', () => {
      expect(validateCreateExpenseInput({ ...base, recurring: 'Annually' }).recurring).toBe('Annually');
    });

    it('rejects an unknown recurring frequency ("Monthly" is not a FreeAgent frequency)', () => {
      expect(() => validateCreateExpenseInput({ ...base, recurring: 'Monthly' }))
        .toThrow(/recurring must be one of/);
    });

    it('accepts "Quarterly" and carries it into the payload', () => {
      const input = validateCreateExpenseInput({ ...base, recurring: 'Quarterly' });
      expect(buildExpensePayload(input, { user: USER, category: CATEGORY }).recurring).toBe('Quarterly');
    });

    it('rejects recurring_end_date without a recurring frequency', () => {
      expect(() => validateCreateExpenseInput({ ...base, recurring_end_date: '2027-01-01' }))
        .toThrow(/without a recurring frequency/);
    });
  });

  describe('foreign currency', () => {
    it('carries currency and sign-applies native_gross_value', () => {
      const input = validateCreateExpenseInput({ ...base, currency: 'USD', native_gross_value: 8 });
      const payload = buildExpensePayload(input, { user: USER, category: CATEGORY });
      expect(payload.currency).toBe('USD');
      // Out-of-pocket: native value is negated just like gross_value.
      expect(payload.native_gross_value).toBe('-8');
    });

    it('keeps native_gross_value positive for a refund due', () => {
      const input = validateCreateExpenseInput({ ...base, currency: 'USD', native_gross_value: 8, refund_due: true });
      expect(buildExpensePayload(input, { user: USER, category: CATEGORY }).native_gross_value).toBe('8');
    });

    it('carries manual_sales_tax_amount through', () => {
      const input = validateCreateExpenseInput({ ...base, currency: 'USD', manual_sales_tax_amount: '1.20' });
      expect(buildExpensePayload(input, { user: USER, category: CATEGORY }).manual_sales_tax_amount).toBe('1.20');
    });
  });

  describe('property (landlord companies)', () => {
    it('passes the property URL straight through to the payload', () => {
      const propertyUrl = 'https://api.freeagent.com/v2/properties/3';
      const input = validateCreateExpenseInput({ ...base, property: propertyUrl });
      expect(input.property).toBe(propertyUrl);
      expect(buildExpensePayload(input, { user: USER, category: CATEGORY }).property).toBe(propertyUrl);
    });
  });

  describe('update skips the cross-field rebill checks', () => {
    it('allows rebill_factor on its own (rebill_type may already be set)', () => {
      const input = validateUpdateExpenseInput({ id: '5', rebill_factor: '20' });
      expect(input.rebill_factor).toBe('20');
    });
  });
});
