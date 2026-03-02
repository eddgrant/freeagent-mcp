import { TimeslipAttributes, InvoiceAttributes } from './types.js';

export function validateTimeslipAttributes(data: unknown): TimeslipAttributes {
  if (typeof data !== 'object' || !data) {
    throw new Error('Invalid timeslip data: must be an object');
  }

  const attrs = data as Record<string, unknown>;

  if (typeof attrs.task !== 'string' ||
    typeof attrs.user !== 'string' ||
    typeof attrs.project !== 'string' ||
    typeof attrs.dated_on !== 'string' ||
    typeof attrs.hours !== 'string') {
    throw new Error('Invalid timeslip data: missing required fields');
  }

  return {
    task: attrs.task,
    user: attrs.user,
    project: attrs.project,
    dated_on: attrs.dated_on,
    hours: attrs.hours,
    comment: attrs.comment as string | undefined
  };
}

// Prevent path traversal via ID parameters interpolated into API URLs.
export function validateId(id: unknown): string {
  if (typeof id !== 'string' || !/^\d+$/.test(id)) {
    throw new Error('Invalid ID: must be a numeric string');
  }
  return id;
}

export function validateInvoiceItemAttributes(item: unknown, index: number): InvoiceAttributes['invoice_items'] extends (infer T)[] | undefined ? T : never {
  if (typeof item !== 'object' || !item) {
    throw new Error(`Invoice item at index ${index}: must be an object`);
  }
  const attrs = item as Record<string, unknown>;

  if (typeof attrs.item_type !== 'string' ||
    typeof attrs.description !== 'string' ||
    typeof attrs.quantity !== 'string' ||
    typeof attrs.price !== 'string') {
    throw new Error(`Invoice item at index ${index}: item_type, description, quantity, and price are required strings`);
  }

  const validated: Record<string, unknown> = {
    item_type: attrs.item_type,
    description: attrs.description,
    quantity: attrs.quantity,
    price: attrs.price,
  };

  if (typeof attrs.id === 'string') validated.id = attrs.id;
  if (typeof attrs.sales_tax_rate === 'string') validated.sales_tax_rate = attrs.sales_tax_rate;
  if (typeof attrs.position === 'number') validated.position = attrs.position;
  if (attrs._destroy === 1) validated._destroy = 1;

  return validated as any;
}

export function validateInvoiceAttributes(data: unknown): InvoiceAttributes {
  if (typeof data !== 'object' || !data) {
    throw new Error('Invalid invoice data: must be an object');
  }

  const attrs = data as Record<string, unknown>;

  if (typeof attrs.contact !== 'string' || typeof attrs.dated_on !== 'string') {
    throw new Error('Invalid invoice data: contact and dated_on are required');
  }

  const invoice: InvoiceAttributes = {
    contact: attrs.contact,
    dated_on: attrs.dated_on,
    payment_terms_in_days: typeof attrs.payment_terms_in_days === 'number' ? attrs.payment_terms_in_days : 30,
  };

  if (typeof attrs.project === 'string') invoice.project = attrs.project;
  if (typeof attrs.currency === 'string') invoice.currency = attrs.currency;
  if (typeof attrs.comments === 'string') invoice.comments = attrs.comments;
  if (typeof attrs.ec_status === 'string') invoice.ec_status = attrs.ec_status;
  if (typeof attrs.include_timeslips === 'string') invoice.include_timeslips = attrs.include_timeslips;
  if (Array.isArray(attrs.invoice_items)) {
    invoice.invoice_items = attrs.invoice_items.map((item, i) => validateInvoiceItemAttributes(item, i));
  }

  return invoice;
}
