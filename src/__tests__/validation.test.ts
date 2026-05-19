// Unit tests for invoice tool-input → wire-payload translation.
// Input-shape validation is now the Zod schema's job (see tool-schemas.ts
// and the MCP-transport tests); what remains here is the genuine
// transformation: project_ids / numbering_source normalisation and the
// project-URL pairing in the wire payload.

import { describe, it, expect } from 'vitest';
import { normaliseProjectIds, normaliseNumberingSource, buildInvoicePayload, ORG_WIDE_NUMBERING } from '../validation.js';

describe('normaliseProjectIds', () => {
  it('accepts numeric ID strings as-is', () => {
    expect(normaliseProjectIds(['1', '2', '3'])).toEqual(['1', '2', '3']);
  });

  it('extracts numeric IDs from full project URLs', () => {
    expect(normaliseProjectIds(['https://api.freeagent.com/v2/projects/42'])).toEqual(['42']);
  });

  it('extracts IDs from URLs with a trailing slash', () => {
    expect(normaliseProjectIds(['https://api.freeagent.com/v2/projects/42/'])).toEqual(['42']);
  });

  it('deduplicates IDs while preserving first-seen order', () => {
    expect(normaliseProjectIds(['1', '2', '1'])).toEqual(['1', '2']);
  });

  it('rejects strings that are neither numeric nor project URLs', () => {
    expect(() => normaliseProjectIds(['not-a-project'])).toThrow('numeric project ID or a project URL');
  });
});

describe('normaliseNumberingSource', () => {
  it('accepts the "org-wide" sentinel', () => {
    expect(normaliseNumberingSource('org-wide', ['100'])).toBe(ORG_WIDE_NUMBERING);
  });

  it('accepts a numeric ID that appears in project_ids', () => {
    expect(normaliseNumberingSource('100', ['100', '200'])).toBe('100');
  });

  it('extracts the ID from a URL and validates membership', () => {
    expect(normaliseNumberingSource('https://api.freeagent.com/v2/projects/200', ['100', '200'])).toBe('200');
  });

  it('rejects a project ID not in project_ids', () => {
    expect(() => normaliseNumberingSource('999', ['100', '200'])).toThrow('not in project_ids');
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

  it('multi-project with numbering_source pointing at a project: uses that project URL on the wire', () => {
    const wire = buildInvoicePayload({ ...base, project_ids: ['100', '200'], numbering_source: '200' });
    expect(wire.project).toBe('https://api.freeagent.com/v2/projects/200');
    expect(wire.project_ids).toEqual(['100', '200']);
  });

  it('multi-project with numbering_source = "org-wide": omits the wire project field', () => {
    const wire = buildInvoicePayload({ ...base, project_ids: ['100', '200'], numbering_source: ORG_WIDE_NUMBERING });
    expect(wire.project).toBeUndefined();
    expect(wire.project_ids).toEqual(['100', '200']);
  });

  it('multi-project without numbering_source: omits the wire project field', () => {
    const wire = buildInvoicePayload({ ...base, project_ids: ['100', '200'] });
    expect(wire.project).toBeUndefined();
    expect(wire.project_ids).toEqual(['100', '200']);
  });
});
