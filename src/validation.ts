// Invoice tool-input → FreeAgent wire-payload translation.
//
// The create_invoice / update_invoice tools expose `project_ids` plus a
// `numbering_source`; FreeAgent's API wants `project` (a URL) paired with
// `project_ids` (numeric IDs). These helpers normalise the tool input and
// build the wire payload. Input *shape* is validated upstream by the Zod
// schemas — what remains here is genuine transformation (URL → ID
// extraction) and the cross-field numbering_source/project_ids check.

import { InvoiceAttributes } from './types.js';

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

// Accepts each entry as a numeric ID string or a /projects/<id> URL,
// normalises to numeric IDs, deduplicates while preserving first-seen order.
export function normaliseProjectIds(input: string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const id = extractProjectId(input[i], `project_ids[${i}]`);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function normaliseNumberingSource(value: string, projectIds: string[] | undefined): string {
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
