import { describe, it, expect } from 'vitest';
import {
  validateId,
  validateTimeslipAttributes,
  validateInvoiceItemAttributes,
  validateInvoiceAttributes,
  validateProjectAttributes,
  validateTaskAttributes,
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

  it('includes project when present', () => {
    const result = validateInvoiceAttributes({ ...validInvoice, project: 'https://api.freeagent.com/v2/projects/1' });
    expect(result.project).toBe('https://api.freeagent.com/v2/projects/1');
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
});
