// Unit tests for expense payload construction: the out-of-pocket sign
// convention, wire-payload building, the cross-field coherence checks,
// and the staged-attachment read. Input-shape validation is now the Zod
// schema's job — exercised via the MCP-transport tests in expenses-mcp.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildExpensePayload,
  buildExpenseUpdatePayload,
  applySign,
  readStagedAttachment,
  type CreateExpenseInput,
  type UpdateExpenseInput,
} from '../expenses.js';

const USER = 'https://api.freeagent.com/v2/users/1';
const CATEGORY = 'https://api.freeagent.com/v2/categories/285';

// Build a create_expense input, defaulting the required fields.
const ce = (extra: Partial<CreateExpenseInput> = {}): CreateExpenseInput =>
  ({ category: 'Travel', dated_on: '2026-05-01', gross_value: 10, ...extra });

describe('applySign', () => {
  it('negates an out-of-pocket amount (payment owed to the claimant)', () => {
    expect(applySign(12.5, false)).toBe('-12.5');
  });

  it('treats a missing refund_due flag as out-of-pocket', () => {
    expect(applySign(42)).toBe('-42');
  });

  it('keeps a refund-due amount positive (claimant owes the company)', () => {
    expect(applySign(12.5, true)).toBe('12.5');
  });
});

describe('buildExpensePayload', () => {
  it('builds an out-of-pocket payload with a negative gross_value', () => {
    const payload = buildExpensePayload(ce({ gross_value: 42 }), { user: USER, category: CATEGORY });
    expect(payload).toEqual({ user: USER, category: CATEGORY, dated_on: '2026-05-01', gross_value: '-42' });
  });

  it('keeps gross_value positive when refund_due is set', () => {
    const payload = buildExpensePayload(ce({ gross_value: 42, refund_due: true }), { user: USER, category: CATEGORY });
    expect(payload.gross_value).toBe('42');
  });

  it('carries optional sales-tax, description and attachment fields through', () => {
    const payload = buildExpensePayload(
      ce({ description: 'Train to client', sales_tax_rate: '20.0', sales_tax_status: 'TAXABLE' }),
      { user: USER, category: CATEGORY, attachment: { data: 'YWJj', file_name: 'r.pdf', content_type: 'application/pdf' } },
    );
    expect(payload.description).toBe('Train to client');
    expect(payload.sales_tax_rate).toBe('20.0');
    expect(payload.sales_tax_status).toBe('TAXABLE');
    expect(payload.attachment?.file_name).toBe('r.pdf');
  });

  it('throws an internal error if the resolved user/category URLs are missing', () => {
    expect(() => buildExpensePayload(ce(), {})).toThrow(/resolved user URL missing/);
  });

  describe('rebilling cross-field checks', () => {
    it('accepts rebill_type "cost" with a project', () => {
      const payload = buildExpensePayload(
        ce({ project: 'Acme', rebill_type: 'cost' }),
        { user: USER, category: CATEGORY, project: 'https://api.freeagent.com/v2/projects/9' },
      );
      expect(payload.rebill_type).toBe('cost');
      expect(payload.project).toBe('https://api.freeagent.com/v2/projects/9');
    });

    it('rejects rebill_type "markup" without a rebill_factor', () => {
      expect(() => buildExpensePayload(ce({ project: 'Acme', rebill_type: 'markup' }), { user: USER, category: CATEGORY }))
        .toThrow(/rebill_factor is required/);
    });

    it('rejects rebill_type without a project', () => {
      expect(() => buildExpensePayload(ce({ rebill_type: 'cost' }), { user: USER, category: CATEGORY }))
        .toThrow(/without a project/);
    });

    it('rejects rebill_factor without a rebill_type', () => {
      expect(() => buildExpensePayload(ce({ project: 'Acme', rebill_factor: '10' }), { user: USER, category: CATEGORY }))
        .toThrow(/without a rebill_type/);
    });

    it('puts the resolved project URL and rebill fields into the payload', () => {
      const payload = buildExpensePayload(
        ce({ project: 'Acme', rebill_type: 'markup', rebill_factor: '15' }),
        { user: USER, category: CATEGORY, project: 'https://api.freeagent.com/v2/projects/9' },
      );
      expect(payload.project).toBe('https://api.freeagent.com/v2/projects/9');
      expect(payload.rebill_type).toBe('markup');
      expect(payload.rebill_factor).toBe('15');
    });
  });

  describe('recurring', () => {
    it('carries a recurring frequency into the payload', () => {
      const payload = buildExpensePayload(ce({ recurring: 'Quarterly' }), { user: USER, category: CATEGORY });
      expect(payload.recurring).toBe('Quarterly');
    });

    it('rejects recurring_end_date without a recurring frequency', () => {
      expect(() => buildExpensePayload(ce({ recurring_end_date: '2027-01-01' }), { user: USER, category: CATEGORY }))
        .toThrow(/without a recurring frequency/);
    });
  });

  describe('foreign currency', () => {
    it('carries currency and sign-applies native_gross_value', () => {
      const payload = buildExpensePayload(ce({ currency: 'USD', native_gross_value: 8 }), { user: USER, category: CATEGORY });
      expect(payload.currency).toBe('USD');
      expect(payload.native_gross_value).toBe('-8');
    });

    it('keeps native_gross_value positive for a refund due', () => {
      const payload = buildExpensePayload(ce({ currency: 'USD', native_gross_value: 8, refund_due: true }), { user: USER, category: CATEGORY });
      expect(payload.native_gross_value).toBe('8');
    });

    it('carries manual_sales_tax_amount through', () => {
      const payload = buildExpensePayload(ce({ currency: 'USD', manual_sales_tax_amount: '1.20' }), { user: USER, category: CATEGORY });
      expect(payload.manual_sales_tax_amount).toBe('1.20');
    });
  });

  it('passes the property URL straight through (landlord companies)', () => {
    const propertyUrl = 'https://api.freeagent.com/v2/properties/3';
    const payload = buildExpensePayload(ce({ property: propertyUrl }), { user: USER, category: CATEGORY });
    expect(payload.property).toBe(propertyUrl);
  });
});

describe('buildExpenseUpdatePayload', () => {
  it('produces an empty payload when nothing is supplied', () => {
    expect(buildExpenseUpdatePayload({}, {})).toEqual({});
  });

  it('updates only the supplied fields', () => {
    expect(buildExpenseUpdatePayload({ description: 'Updated' }, {})).toEqual({ description: 'Updated' });
  });

  it('applies the sign convention to an updated gross_value', () => {
    expect(buildExpenseUpdatePayload({ gross_value: 30 }, {}).gross_value).toBe('-30');
    expect(buildExpenseUpdatePayload({ gross_value: 30, refund_due: true }, {}).gross_value).toBe('30');
  });

  it('includes resolved category/user URLs only when supplied', () => {
    expect(buildExpenseUpdatePayload({ category: 'Travel' }, { category: CATEGORY })).toEqual({ category: CATEGORY });
  });

  it('sets a fixed VAT amount via manual_sales_tax_amount', () => {
    expect(buildExpenseUpdatePayload({ manual_sales_tax_amount: '2.63' }, {}).manual_sales_tax_amount).toBe('2.63');
  });

  it('does not run the cross-field rebill checks — rebill_factor alone is allowed', () => {
    // The complementary rebill_type may already be set on the expense.
    const input: UpdateExpenseInput = { rebill_factor: '20' };
    expect(buildExpenseUpdatePayload(input, {}).rebill_factor).toBe('20');
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

  it('throws when the file bytes do not match the declared content_type', () => {
    expect(() => readStagedAttachment(
      { evidence_path: file, file_name: 'receipt.png', content_type: 'image/png' },
      dir,
    )).toThrow(/content-type mismatch/);
  });

  it('throws when the file is not a recognised type', () => {
    const txt = path.join(dir, 'notes.pdf');
    fs.writeFileSync(txt, Buffer.from('just some plain text', 'utf8'));
    expect(() => readStagedAttachment(
      { evidence_path: txt, file_name: 'notes.pdf', content_type: 'application/pdf' },
      dir,
    )).toThrow(/unrecognised type/);
  });
});
