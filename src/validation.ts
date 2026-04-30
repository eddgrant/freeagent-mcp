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

// Validated MCP-tool input shape for invoice creation. Distinct from the
// FreeAgent wire shape (InvoiceAttributes) because we expose `project_ids`
// + `numbering_source` and translate to the API's `project` (URL) +
// `project_ids` (numeric IDs) pairing internally.
export interface InvoiceToolInput {
  contact: string;
  dated_on: string;
  payment_terms_in_days: number;
  currency?: string;
  comments?: string;
  ec_status?: string;
  include_timeslips?: string;
  invoice_items?: InvoiceAttributes['invoice_items'];
  project_ids?: string[];           // numeric IDs (URLs accepted in input, normalised)
  numbering_source?: string;        // a project ID, or the literal "org-wide"
}

export const ORG_WIDE_NUMBERING = 'org-wide';

export function validateInvoiceAttributes(data: unknown): InvoiceToolInput {
  if (typeof data !== 'object' || !data) {
    throw new Error('Invalid invoice data: must be an object');
  }

  const attrs = data as Record<string, unknown>;

  if (typeof attrs.contact !== 'string' || typeof attrs.dated_on !== 'string') {
    throw new Error('Invalid invoice data: contact and dated_on are required');
  }

  const invoice: InvoiceToolInput = {
    contact: attrs.contact,
    dated_on: attrs.dated_on,
    payment_terms_in_days: typeof attrs.payment_terms_in_days === 'number' ? attrs.payment_terms_in_days : 30,
  };

  if (typeof attrs.currency === 'string') invoice.currency = attrs.currency;
  if (typeof attrs.comments === 'string') invoice.comments = attrs.comments;
  if (typeof attrs.ec_status === 'string') invoice.ec_status = attrs.ec_status;
  if (typeof attrs.include_timeslips === 'string') invoice.include_timeslips = attrs.include_timeslips;
  if (Array.isArray(attrs.invoice_items)) {
    invoice.invoice_items = attrs.invoice_items.map((item, i) => validateInvoiceItemAttributes(item, i));
  }
  if (attrs.project_ids !== undefined) {
    invoice.project_ids = normaliseProjectIds(attrs.project_ids);
  }
  if (attrs.numbering_source !== undefined) {
    invoice.numbering_source = normaliseNumberingSource(attrs.numbering_source, invoice.project_ids);
  }

  return invoice;
}

// Accepts each entry as a numeric ID string or a /projects/<id> URL,
// normalises to numeric IDs, deduplicates while preserving first-seen order.
export function normaliseProjectIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new Error('Invalid invoice data: project_ids must be an array of project IDs');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (typeof raw !== 'string') {
      throw new Error(`Invalid invoice data: project_ids[${i}] must be a string`);
    }
    const id = extractProjectId(raw, `project_ids[${i}]`);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function normaliseNumberingSource(value: unknown, projectIds: string[] | undefined): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid invoice data: numbering_source must be a string (a project ID, a project URL, or "org-wide")');
  }
  if (value === ORG_WIDE_NUMBERING) return value;
  const id = extractProjectId(value, 'numbering_source');
  if (projectIds && projectIds.length > 0 && !projectIds.includes(id)) {
    throw new Error(`Invalid invoice data: numbering_source "${id}" is not in project_ids. It must be one of [${projectIds.join(', ')}] or "${ORG_WIDE_NUMBERING}".`);
  }
  return id;
}

function extractProjectId(value: string, label: string): string {
  if (/^\d+$/.test(value)) return value;
  const m = value.match(/\/projects\/(\d+)\/?$/);
  if (m) return m[1];
  throw new Error(`Invalid invoice data: ${label} must be a numeric project ID or a project URL, got "${value}"`);
}

// Translate the validated tool input into the FreeAgent wire shape.
// `numberingSource` is already-normalised: either "org-wide", a numeric ID,
// or undefined (meaning the caller didn't pick one — only valid when
// project_ids has 0 or 1 entries, or when no implicated project uses a
// per-project sequence).
export function buildInvoicePayload(
  input: InvoiceToolInput,
  apiBase: string = 'https://api.freeagent.com/v2',
): InvoiceAttributes {
  const wire: InvoiceAttributes = {
    contact: input.contact,
    dated_on: input.dated_on,
    payment_terms_in_days: input.payment_terms_in_days,
  };
  if (input.currency) wire.currency = input.currency;
  if (input.comments) wire.comments = input.comments;
  if (input.ec_status) wire.ec_status = input.ec_status;
  if (input.include_timeslips) wire.include_timeslips = input.include_timeslips;
  if (input.invoice_items) wire.invoice_items = input.invoice_items;

  const ids = input.project_ids ?? [];
  if (ids.length > 0) {
    wire.project_ids = ids;

    let primaryId: string | undefined;
    if (input.numbering_source && input.numbering_source !== ORG_WIDE_NUMBERING) {
      primaryId = input.numbering_source;
    } else if (!input.numbering_source && ids.length === 1) {
      // Single-project default: use that project's sequence.
      primaryId = ids[0];
    }
    // numbering_source === "org-wide" or unset multi-project (only valid
    // when no per-project sequences exist) → omit `project` from the wire.
    if (primaryId) {
      wire.project = `${apiBase}/projects/${primaryId}`;
    }
  }
  return wire;
}
