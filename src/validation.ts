import { TimeslipAttributes, InvoiceAttributes, ProjectAttributes, TaskAttributes } from './types.js';

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

export function validateProjectAttributes(data: unknown): ProjectAttributes {
  if (typeof data !== 'object' || !data) {
    throw new Error('Invalid project data: must be an object');
  }

  const attrs = data as Record<string, unknown>;

  if (typeof attrs.contact !== 'string' ||
    typeof attrs.name !== 'string' ||
    typeof attrs.status !== 'string' ||
    typeof attrs.budget_units !== 'string' ||
    typeof attrs.currency !== 'string') {
    throw new Error('Invalid project data: contact, name, status, budget_units, and currency are required strings');
  }

  if (typeof attrs.budget !== 'number') {
    throw new Error('Invalid project data: budget is required and must be a number');
  }

  if (typeof attrs.uses_project_invoice_sequence !== 'boolean') {
    throw new Error('Invalid project data: uses_project_invoice_sequence is required and must be a boolean');
  }

  const project: ProjectAttributes = {
    contact: attrs.contact,
    name: attrs.name,
    status: attrs.status,
    budget: attrs.budget,
    budget_units: attrs.budget_units,
    currency: attrs.currency,
    uses_project_invoice_sequence: attrs.uses_project_invoice_sequence,
  };

  if (typeof attrs.contract_po_reference === 'string') project.contract_po_reference = attrs.contract_po_reference;
  if (typeof attrs.hours_per_day === 'number') project.hours_per_day = attrs.hours_per_day;
  if (typeof attrs.normal_billing_rate === 'string') project.normal_billing_rate = attrs.normal_billing_rate;
  if (typeof attrs.billing_period === 'string') project.billing_period = attrs.billing_period;
  if (typeof attrs.is_ir35 === 'boolean') project.is_ir35 = attrs.is_ir35;
  if (typeof attrs.starts_on === 'string') project.starts_on = attrs.starts_on;
  if (typeof attrs.ends_on === 'string') project.ends_on = attrs.ends_on;
  if (typeof attrs.include_unbilled_time_in_profitability === 'boolean') project.include_unbilled_time_in_profitability = attrs.include_unbilled_time_in_profitability;

  return project;
}

export function validateTaskAttributes(data: unknown): { project: string; task: TaskAttributes } {
  if (typeof data !== 'object' || !data) {
    throw new Error('Invalid task data: must be an object');
  }

  const attrs = data as Record<string, unknown>;

  if (typeof attrs.project !== 'string') {
    throw new Error('Invalid task data: project is required');
  }

  if (typeof attrs.name !== 'string') {
    throw new Error('Invalid task data: name is required');
  }

  const task: TaskAttributes = {
    name: attrs.name,
  };

  if (typeof attrs.is_billable === 'boolean') task.is_billable = attrs.is_billable;
  if (typeof attrs.status === 'string') task.status = attrs.status;
  if (typeof attrs.billing_rate === 'string') task.billing_rate = attrs.billing_rate;
  if (typeof attrs.billing_period === 'string') task.billing_period = attrs.billing_period;

  return { project: attrs.project, task };
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
