import { describe, it, expect } from 'vitest';
import {
  validateId,
  validateTimeslipAttributes,
  validateInvoiceItemAttributes,
  validateInvoiceAttributes,
  validateProjectAttributes,
  validateTaskAttributes,
  normaliseProjectIds,
  normaliseNumberingSource,
  buildInvoicePayload,
  ORG_WIDE_NUMBERING,
} from '../validation.js';

describe('validateId', () => {
  it('accepts a numeric string', () => {
    expect(validateId('123')).toBe('123');
  });

  it('accepts a single digit', () => {
    expect(validateId('0')).toBe('0');
  });

  it('rejects a number input', () => {
    expect(() => validateId(123)).toThrow('Invalid ID: must be a numeric string');
  });

  it('rejects null', () => {
    expect(() => validateId(null)).toThrow('Invalid ID');
  });

  it('rejects undefined', () => {
    expect(() => validateId(undefined)).toThrow('Invalid ID');
  });

  it('rejects non-numeric string "abc"', () => {
    expect(() => validateId('abc')).toThrow('Invalid ID');
  });

  it('rejects mixed string "12a"', () => {
    expect(() => validateId('12a')).toThrow('Invalid ID');
  });

  it('rejects empty string', () => {
    expect(() => validateId('')).toThrow('Invalid ID');
  });

  it('rejects decimal string "12.5"', () => {
    expect(() => validateId('12.5')).toThrow('Invalid ID');
  });
});

describe('validateTimeslipAttributes', () => {
  const validAttrs = {
    task: 'https://api.freeagent.com/v2/tasks/1',
    user: 'https://api.freeagent.com/v2/users/1',
    project: 'https://api.freeagent.com/v2/projects/1',
    dated_on: '2026-03-01',
    hours: '7.5',
  };

  it('accepts valid attributes with all required fields', () => {
    const result = validateTimeslipAttributes(validAttrs);
    expect(result).toEqual({ ...validAttrs, comment: undefined });
  });

  it('includes optional comment when present', () => {
    const result = validateTimeslipAttributes({ ...validAttrs, comment: 'Test comment' });
    expect(result.comment).toBe('Test comment');
  });

  it('rejects null input', () => {
    expect(() => validateTimeslipAttributes(null)).toThrow('must be an object');
  });

  it('rejects non-object input', () => {
    expect(() => validateTimeslipAttributes('string')).toThrow('must be an object');
  });

  it('rejects when task is missing', () => {
    const { task, ...rest } = validAttrs;
    expect(() => validateTimeslipAttributes(rest)).toThrow('missing required fields');
  });

  it('rejects when user is missing', () => {
    const { user, ...rest } = validAttrs;
    expect(() => validateTimeslipAttributes(rest)).toThrow('missing required fields');
  });

  it('rejects when project is missing', () => {
    const { project, ...rest } = validAttrs;
    expect(() => validateTimeslipAttributes(rest)).toThrow('missing required fields');
  });

  it('rejects when dated_on is missing', () => {
    const { dated_on, ...rest } = validAttrs;
    expect(() => validateTimeslipAttributes(rest)).toThrow('missing required fields');
  });

  it('rejects when hours is missing', () => {
    const { hours, ...rest } = validAttrs;
    expect(() => validateTimeslipAttributes(rest)).toThrow('missing required fields');
  });

  it('rejects when a required field has wrong type', () => {
    expect(() => validateTimeslipAttributes({ ...validAttrs, hours: 7.5 })).toThrow('missing required fields');
  });
});

describe('validateProjectAttributes', () => {
  const validProject = {
    contact: 'https://api.freeagent.com/v2/contacts/1',
    name: 'Test Project',
    status: 'Active',
    budget: 0,
    budget_units: 'Hours',
    currency: 'GBP',
    uses_project_invoice_sequence: false,
  };

  it('accepts valid attributes with all required fields', () => {
    const result = validateProjectAttributes(validProject);
    expect(result).toEqual(validProject);
  });

  it('includes optional fields when present', () => {
    const result = validateProjectAttributes({
      ...validProject,
      hours_per_day: 7.5,
      billing_period: 'day',
      normal_billing_rate: '500',
      is_ir35: false,
      starts_on: '2026-03-01',
      ends_on: '2026-12-31',
      contract_po_reference: 'PO-123',
      include_unbilled_time_in_profitability: true,
    });
    expect(result.hours_per_day).toBe(7.5);
    expect(result.billing_period).toBe('day');
    expect(result.normal_billing_rate).toBe('500');
    expect(result.is_ir35).toBe(false);
    expect(result.starts_on).toBe('2026-03-01');
    expect(result.ends_on).toBe('2026-12-31');
    expect(result.contract_po_reference).toBe('PO-123');
    expect(result.include_unbilled_time_in_profitability).toBe(true);
  });

  it('rejects null input', () => {
    expect(() => validateProjectAttributes(null)).toThrow('must be an object');
  });

  it('rejects when required string fields are missing', () => {
    const { name, ...rest } = validProject;
    expect(() => validateProjectAttributes(rest)).toThrow('contact, name, status, budget_units, and currency are required strings');
  });

  it('rejects when budget is missing', () => {
    const { budget, ...rest } = validProject;
    expect(() => validateProjectAttributes(rest)).toThrow('budget is required and must be a number');
  });

  it('rejects when uses_project_invoice_sequence is missing', () => {
    const { uses_project_invoice_sequence, ...rest } = validProject;
    expect(() => validateProjectAttributes(rest)).toThrow('uses_project_invoice_sequence is required and must be a boolean');
  });
});

describe('validateTaskAttributes', () => {
  const validTask = {
    project: 'https://api.freeagent.com/v2/projects/1',
    name: 'Development',
  };

  it('accepts valid attributes with required fields', () => {
    const result = validateTaskAttributes(validTask);
    expect(result.project).toBe(validTask.project);
    expect(result.task.name).toBe(validTask.name);
  });

  it('includes optional fields when present', () => {
    const result = validateTaskAttributes({
      ...validTask,
      is_billable: true,
      status: 'Active',
      billing_rate: '100',
      billing_period: 'hour',
    });
    expect(result.task.is_billable).toBe(true);
    expect(result.task.status).toBe('Active');
    expect(result.task.billing_rate).toBe('100');
    expect(result.task.billing_period).toBe('hour');
  });

  it('rejects null input', () => {
    expect(() => validateTaskAttributes(null)).toThrow('must be an object');
  });

  it('rejects when project is missing', () => {
    expect(() => validateTaskAttributes({ name: 'Task' })).toThrow('project is required');
  });

  it('rejects when name is missing', () => {
    expect(() => validateTaskAttributes({ project: 'url' })).toThrow('name is required');
  });
});

describe('validateInvoiceItemAttributes', () => {
  const validItem = {
    item_type: 'Hours',
    description: 'Development work',
    quantity: '10',
    price: '100.00',
  };

  it('accepts valid item with required fields', () => {
    const result = validateInvoiceItemAttributes(validItem, 0);
    expect(result).toEqual(validItem);
  });

  it('includes optional id when present', () => {
    const result = validateInvoiceItemAttributes({ ...validItem, id: '42' }, 0);
    expect(result.id).toBe('42');
  });

  it('includes optional sales_tax_rate when present', () => {
    const result = validateInvoiceItemAttributes({ ...validItem, sales_tax_rate: '20.0' }, 0);
    expect(result.sales_tax_rate).toBe('20.0');
  });

  it('includes optional position when a number', () => {
    const result = validateInvoiceItemAttributes({ ...validItem, position: 2 }, 0);
    expect((result as any).position).toBe(2);
  });

  it('includes _destroy when exactly 1', () => {
    const result = validateInvoiceItemAttributes({ ...validItem, _destroy: 1 }, 0);
    expect(result._destroy).toBe(1);
  });

  it('ignores position when wrong type (string)', () => {
    const result = validateInvoiceItemAttributes({ ...validItem, position: '2' }, 0);
    expect((result as any).position).toBeUndefined();
  });

  it('ignores _destroy when not exactly 1', () => {
    const result = validateInvoiceItemAttributes({ ...validItem, _destroy: 2 }, 0);
    expect(result._destroy).toBeUndefined();
  });

  it('rejects null input with index in error', () => {
    expect(() => validateInvoiceItemAttributes(null, 3)).toThrow('Invoice item at index 3: must be an object');
  });

  it('rejects when required fields missing with index in error', () => {
    expect(() => validateInvoiceItemAttributes({ item_type: 'Hours' }, 1)).toThrow(
      'Invoice item at index 1: item_type, description, quantity, and price are required strings'
    );
  });
});

describe('validateInvoiceAttributes', () => {
  const validInvoice = {
    contact: 'https://api.freeagent.com/v2/contacts/1',
    dated_on: '2026-03-01',
  };

  it('accepts valid invoice with required fields', () => {
    const result = validateInvoiceAttributes(validInvoice);
    expect(result.contact).toBe(validInvoice.contact);
    expect(result.dated_on).toBe(validInvoice.dated_on);
  });

  it('defaults payment_terms_in_days to 30 when not provided', () => {
    const result = validateInvoiceAttributes(validInvoice);
    expect(result.payment_terms_in_days).toBe(30);
  });

  it('uses provided payment_terms_in_days when a number', () => {
    const result = validateInvoiceAttributes({ ...validInvoice, payment_terms_in_days: 14 });
    expect(result.payment_terms_in_days).toBe(14);
  });

  it('includes currency when present', () => {
    const result = validateInvoiceAttributes({ ...validInvoice, currency: 'GBP' });
    expect(result.currency).toBe('GBP');
  });

  it('includes comments when present', () => {
    const result = validateInvoiceAttributes({ ...validInvoice, comments: 'Thank you' });
    expect(result.comments).toBe('Thank you');
  });

  it('includes ec_status when present', () => {
    const result = validateInvoiceAttributes({ ...validInvoice, ec_status: 'UK Non-EC' });
    expect(result.ec_status).toBe('UK Non-EC');
  });

  it('includes include_timeslips when present', () => {
    const result = validateInvoiceAttributes({ ...validInvoice, include_timeslips: 'billed_grouped_by_timeslip' });
    expect(result.include_timeslips).toBe('billed_grouped_by_timeslip');
  });

  it('validates nested invoice_items array', () => {
    const result = validateInvoiceAttributes({
      ...validInvoice,
      invoice_items: [
        { item_type: 'Hours', description: 'Work', quantity: '10', price: '100' },
      ],
    });
    expect(result.invoice_items).toHaveLength(1);
    expect(result.invoice_items![0].item_type).toBe('Hours');
  });

  it('rejects null input', () => {
    expect(() => validateInvoiceAttributes(null)).toThrow('must be an object');
  });

  it('rejects non-object input', () => {
    expect(() => validateInvoiceAttributes(42)).toThrow('must be an object');
  });

  it('rejects when contact is missing', () => {
    expect(() => validateInvoiceAttributes({ dated_on: '2026-03-01' })).toThrow('contact and dated_on are required');
  });

  it('rejects when dated_on is missing', () => {
    expect(() => validateInvoiceAttributes({ contact: 'url' })).toThrow('contact and dated_on are required');
  });

  it('normalises project_ids when provided as numeric IDs', () => {
    const result = validateInvoiceAttributes({
      ...validInvoice,
      project_ids: ['100', '200'],
    });
    expect(result.project_ids).toEqual(['100', '200']);
  });

  it('extracts project_ids from URLs', () => {
    const result = validateInvoiceAttributes({
      ...validInvoice,
      project_ids: ['https://api.freeagent.com/v2/projects/100', 'https://api.freeagent.com/v2/projects/200'],
    });
    expect(result.project_ids).toEqual(['100', '200']);
  });

  it('accepts numbering_source as a project ID present in project_ids', () => {
    const result = validateInvoiceAttributes({
      ...validInvoice,
      project_ids: ['100', '200'],
      numbering_source: '100',
    });
    expect(result.numbering_source).toBe('100');
  });

  it('accepts numbering_source as the org-wide sentinel', () => {
    const result = validateInvoiceAttributes({
      ...validInvoice,
      project_ids: ['100', '200'],
      numbering_source: 'org-wide',
    });
    expect(result.numbering_source).toBe('org-wide');
  });

  it('rejects numbering_source pointing at a project not in project_ids', () => {
    expect(() => validateInvoiceAttributes({
      ...validInvoice,
      project_ids: ['100', '200'],
      numbering_source: '999',
    })).toThrow('numbering_source "999" is not in project_ids');
  });
});

describe('normaliseProjectIds', () => {
  it('accepts numeric ID strings as-is', () => {
    expect(normaliseProjectIds(['1', '2', '3'])).toEqual(['1', '2', '3']);
  });

  it('extracts numeric IDs from full project URLs', () => {
    expect(normaliseProjectIds(['https://api.freeagent.com/v2/projects/42'])).toEqual(['42']);
  });

  it('extracts IDs from URLs with trailing slash', () => {
    expect(normaliseProjectIds(['https://api.freeagent.com/v2/projects/42/'])).toEqual(['42']);
  });

  it('deduplicates IDs while preserving first-seen order', () => {
    expect(normaliseProjectIds(['1', '2', '1'])).toEqual(['1', '2']);
  });

  it('rejects non-array input', () => {
    expect(() => normaliseProjectIds('100')).toThrow('must be an array');
  });

  it('rejects non-string entries', () => {
    expect(() => normaliseProjectIds([100])).toThrow('project_ids[0] must be a string');
  });

  it('rejects strings that are neither numeric nor project URLs', () => {
    expect(() => normaliseProjectIds(['not-a-project'])).toThrow('numeric project ID or a project URL');
  });
});

describe('normaliseNumberingSource', () => {
  it('accepts "org-wide" sentinel', () => {
    expect(normaliseNumberingSource('org-wide', ['100'])).toBe(ORG_WIDE_NUMBERING);
  });

  it('accepts a numeric ID that appears in project_ids', () => {
    expect(normaliseNumberingSource('100', ['100', '200'])).toBe('100');
  });

  it('extracts ID from a URL and validates membership', () => {
    expect(normaliseNumberingSource('https://api.freeagent.com/v2/projects/200', ['100', '200'])).toBe('200');
  });

  it('rejects a project ID not in project_ids', () => {
    expect(() => normaliseNumberingSource('999', ['100', '200'])).toThrow('not in project_ids');
  });

  it('rejects a non-string value', () => {
    expect(() => normaliseNumberingSource(100, ['100'])).toThrow('numbering_source must be a string');
  });
});

describe('buildInvoicePayload', () => {
  const base = { contact: 'https://api.freeagent.com/v2/contacts/1', dated_on: '2026-04-01', payment_terms_in_days: 30 };

  it('omits project and project_ids when no project_ids are provided', () => {
    const wire = buildInvoicePayload(base);
    expect(wire.project).toBeUndefined();
    expect(wire.project_ids).toBeUndefined();
  });

  it('single-project invoice: defaults project to that project URL (preserves per-project sequence)', () => {
    const wire = buildInvoicePayload({ ...base, project_ids: ['100'] });
    expect(wire.project).toBe('https://api.freeagent.com/v2/projects/100');
    expect(wire.project_ids).toEqual(['100']);
  });

  it('multi-project with numbering_source pointing at a project: uses that project URL on wire', () => {
    const wire = buildInvoicePayload({ ...base, project_ids: ['100', '200'], numbering_source: '200' });
    expect(wire.project).toBe('https://api.freeagent.com/v2/projects/200');
    expect(wire.project_ids).toEqual(['100', '200']);
  });

  it('multi-project with numbering_source = "org-wide": omits the wire project field', () => {
    const wire = buildInvoicePayload({ ...base, project_ids: ['100', '200'], numbering_source: ORG_WIDE_NUMBERING });
    expect(wire.project).toBeUndefined();
    expect(wire.project_ids).toEqual(['100', '200']);
  });

  it('multi-project without numbering_source: omits the wire project field (caller must have passed numbering check first)', () => {
    const wire = buildInvoicePayload({ ...base, project_ids: ['100', '200'] });
    expect(wire.project).toBeUndefined();
    expect(wire.project_ids).toEqual(['100', '200']);
  });
});
