// Curated input handling for the expense tools.
//
// Pure module (bar the staged-attachment file read): validates raw MCP
// tool arguments into typed shapes and builds the FreeAgent wire payload.
//
// The sign convention lives here. FreeAgent stores an out-of-pocket
// expense as a NEGATIVE gross_value ("a payment to the claimant") and
// money the claimant owes back as POSITIVE ("a refund due"). Callers of
// these tools pass a positive `gross_value` and an optional `refund_due`
// flag; applySign() does the negation so the trap never reaches the user.

import * as fs from 'node:fs';
import type { ExpenseCreatePayload, ExpenseAttachmentPayload } from './types.js';
import { validateEvidencePath } from './evidence-staging.js';

export const SALES_TAX_STATUSES = ['TAXABLE', 'EXEMPT', 'OUT_OF_SCOPE'] as const;
export type SalesTaxStatus = (typeof SALES_TAX_STATUSES)[number];

export const REBILL_TYPES = ['cost', 'markup', 'price'] as const;
export type RebillType = (typeof REBILL_TYPES)[number];

export const RECURRING_FREQUENCIES = [
    'Weekly', 'Two Weekly', 'Four Weekly', 'Two Monthly',
    'Quarterly', 'Biannually', 'Annually', '2-Yearly',
] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

/** Receipt attachment as referenced by curated tool input — a path to a
 *  file already staged via stage_evidence, plus its metadata. */
export interface ExpenseAttachmentInput {
    evidence_path: string;
    file_name: string;
    content_type: string;
    description?: string;
}

/** Fields shared by the create and update curated inputs beyond the
 *  Phase 1 core: foreign currency, project rebilling, and recurrence. */
interface AdvancedExpenseFields {
    currency?: string;
    native_gross_value?: string;     // positive magnitude (sign applied at build)
    manual_sales_tax_amount?: string;
    project?: string;                // project reference (name / id / URL)
    rebill_type?: RebillType;
    rebill_factor?: string;
    recurring?: RecurringFrequency;
    recurring_end_date?: string;
    /** Property URL — required for UkUnincorporatedLandlord companies.
     *  Passed straight through; no name resolution (no Properties API). */
    property?: string;
}

/** Validated curated input for creating a money (non-mileage) expense. */
export interface CreateExpenseInput extends AdvancedExpenseFields {
    user?: string;            // claimant reference; undefined ⇒ current user
    category: string;         // category reference (name / code / URL)
    dated_on: string;
    gross_value: string;      // positive magnitude (sign applied at build time)
    refund_due: boolean;      // false ⇒ out-of-pocket (the common case)
    description?: string;
    receipt_reference?: string;
    sales_tax_rate?: string;
    sales_tax_value?: string;
    sales_tax_status?: SalesTaxStatus;
    ec_status?: string;
    attachment?: ExpenseAttachmentInput;
}

/** Validated curated input for updating an existing expense. Every field
 *  is optional — only what the caller supplies is changed. */
export interface UpdateExpenseInput extends AdvancedExpenseFields {
    user?: string;
    category?: string;
    dated_on?: string;
    gross_value?: string;
    refund_due: boolean;
    description?: string;
    receipt_reference?: string;
    sales_tax_rate?: string;
    sales_tax_value?: string;
    sales_tax_status?: SalesTaxStatus;
    ec_status?: string;
    attachment?: ExpenseAttachmentInput;
}

/** URLs resolved from curated references, ready to drop into the payload. */
export interface ResolvedExpenseRefs {
    user?: string;
    category?: string;
    project?: string;
    attachment?: ExpenseAttachmentPayload;
}

/** Out-of-pocket expenses are stored negative ("a payment to the
 *  claimant"); money owed back from the claimant is positive ("a refund
 *  due"). `magnitude` is always a positive decimal string. */
export function applySign(magnitude: string, refundDue: boolean): string {
    return refundDue ? magnitude : `-${magnitude}`;
}

function normalisePositiveAmount(value: unknown, label: string): string {
    let n: number;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
    else throw new Error(`${label} is required and must be a positive number`);

    if (!Number.isFinite(n)) {
        throw new Error(`${label} must be a finite number, got ${JSON.stringify(value)}`);
    }
    if (n <= 0) {
        throw new Error(
            `${label} must be a positive amount — the magnitude of the expense, tax ` +
            `inclusive. For money the claimant owes back to the company, set ` +
            `refund_due: true rather than passing a negative number.`,
        );
    }
    return String(value).trim();
}

function validateSalesTaxStatus(value: unknown): SalesTaxStatus {
    if (typeof value !== 'string' || !SALES_TAX_STATUSES.includes(value as SalesTaxStatus)) {
        throw new Error(`sales_tax_status must be one of ${SALES_TAX_STATUSES.join(', ')}`);
    }
    return value as SalesTaxStatus;
}

function validateRebillType(value: unknown): RebillType {
    if (typeof value !== 'string' || !REBILL_TYPES.includes(value as RebillType)) {
        throw new Error(`rebill_type must be one of ${REBILL_TYPES.join(', ')}`);
    }
    return value as RebillType;
}

function validateRecurringFrequency(value: unknown): RecurringFrequency {
    if (typeof value !== 'string' || !RECURRING_FREQUENCIES.includes(value as RecurringFrequency)) {
        throw new Error(`recurring must be one of: ${RECURRING_FREQUENCIES.join(', ')}`);
    }
    return value as RecurringFrequency;
}

function validateAttachmentInput(value: unknown): ExpenseAttachmentInput {
    if (typeof value !== 'object' || value == null) {
        throw new Error('attachment must be an object');
    }
    const a = value as Record<string, unknown>;
    if (typeof a.evidence_path !== 'string' || a.evidence_path.trim() === '') {
        throw new Error('attachment.evidence_path is required (a path returned by stage_evidence)');
    }
    if (typeof a.file_name !== 'string' || a.file_name.trim() === '') {
        throw new Error('attachment.file_name is required');
    }
    if (typeof a.content_type !== 'string' || a.content_type.trim() === '') {
        throw new Error('attachment.content_type is required');
    }
    const out: ExpenseAttachmentInput = {
        evidence_path: a.evidence_path,
        file_name: a.file_name,
        content_type: a.content_type,
    };
    if (typeof a.description === 'string') out.description = a.description;
    return out;
}

// Mileage claims have a different shape (no gross_value, no real
// category) — steer the caller to the dedicated tool rather than letting
// resolveCategory fail with a confusing "no category named Mileage".
function rejectMileageCategory(category: string): void {
    if (category.trim().toLowerCase() === 'mileage') {
        throw new Error(
            'Mileage claims are not money expenses — use the create_mileage_expense tool.',
        );
    }
}

// Read the advanced (rebilling / recurring / foreign-currency) fields off
// the raw arguments onto `target`. `crossCheck` enforces the inter-field
// rules — applied on create (the full picture is present) but skipped on
// update, where a complementary field may already exist on the expense.
function applyAdvancedFields(
    a: Record<string, unknown>,
    target: AdvancedExpenseFields,
    crossCheck: boolean,
): void {
    if (typeof a.currency === 'string' && a.currency.trim() !== '') target.currency = a.currency.trim();
    if (a.native_gross_value !== undefined) {
        target.native_gross_value = normalisePositiveAmount(a.native_gross_value, 'native_gross_value');
    }
    if (typeof a.manual_sales_tax_amount === 'string') target.manual_sales_tax_amount = a.manual_sales_tax_amount;
    if (typeof a.project === 'string' && a.project.trim() !== '') target.project = a.project.trim();
    if (a.rebill_type !== undefined) target.rebill_type = validateRebillType(a.rebill_type);
    if (typeof a.rebill_factor === 'string' && a.rebill_factor.trim() !== '') target.rebill_factor = a.rebill_factor.trim();
    if (typeof a.rebill_factor === 'number') target.rebill_factor = String(a.rebill_factor);
    if (a.recurring !== undefined) target.recurring = validateRecurringFrequency(a.recurring);
    if (typeof a.recurring_end_date === 'string' && a.recurring_end_date.trim() !== '') {
        target.recurring_end_date = a.recurring_end_date.trim();
    }
    if (typeof a.property === 'string' && a.property.trim() !== '') target.property = a.property.trim();

    if (!crossCheck) return;

    if (target.rebill_type && !target.project) {
        throw new Error('rebill_type was given without a project to rebill the cost to.');
    }
    if ((target.rebill_type === 'markup' || target.rebill_type === 'price') && !target.rebill_factor) {
        throw new Error(`rebill_factor is required when rebill_type is "${target.rebill_type}".`);
    }
    if (target.rebill_factor && !target.rebill_type) {
        throw new Error('rebill_factor was given without a rebill_type (cost, markup, or price).');
    }
    if (target.recurring_end_date && !target.recurring) {
        throw new Error('recurring_end_date was given without a recurring frequency.');
    }
}

export function validateCreateExpenseInput(data: unknown): CreateExpenseInput {
    if (typeof data !== 'object' || data == null) {
        throw new Error('Invalid expense data: must be an object');
    }
    const a = data as Record<string, unknown>;

    if (typeof a.category !== 'string' || a.category.trim() === '') {
        throw new Error('category is required (a category name, nominal code, or URL)');
    }
    rejectMileageCategory(a.category);
    if (typeof a.dated_on !== 'string' || a.dated_on.trim() === '') {
        throw new Error('dated_on is required (YYYY-MM-DD)');
    }

    const input: CreateExpenseInput = {
        category: a.category.trim(),
        dated_on: a.dated_on.trim(),
        gross_value: normalisePositiveAmount(a.gross_value, 'gross_value'),
        refund_due: a.refund_due === true,
    };
    if (typeof a.user === 'string' && a.user.trim() !== '') input.user = a.user.trim();
    if (typeof a.description === 'string') input.description = a.description;
    if (typeof a.receipt_reference === 'string') input.receipt_reference = a.receipt_reference;
    if (typeof a.sales_tax_rate === 'string') input.sales_tax_rate = a.sales_tax_rate;
    if (typeof a.sales_tax_value === 'string') input.sales_tax_value = a.sales_tax_value;
    if (a.sales_tax_status !== undefined) input.sales_tax_status = validateSalesTaxStatus(a.sales_tax_status);
    if (typeof a.ec_status === 'string') input.ec_status = a.ec_status;
    if (a.attachment !== undefined) input.attachment = validateAttachmentInput(a.attachment);
    applyAdvancedFields(a, input, true);
    return input;
}

export function validateUpdateExpenseInput(data: unknown): UpdateExpenseInput {
    if (typeof data !== 'object' || data == null) {
        throw new Error('Invalid expense data: must be an object');
    }
    const a = data as Record<string, unknown>;

    const input: UpdateExpenseInput = { refund_due: a.refund_due === true };
    if (typeof a.user === 'string' && a.user.trim() !== '') input.user = a.user.trim();
    if (typeof a.category === 'string' && a.category.trim() !== '') {
        rejectMileageCategory(a.category);
        input.category = a.category.trim();
    }
    if (typeof a.dated_on === 'string' && a.dated_on.trim() !== '') input.dated_on = a.dated_on.trim();
    if (a.gross_value !== undefined) {
        input.gross_value = normalisePositiveAmount(a.gross_value, 'gross_value');
    }
    if (typeof a.description === 'string') input.description = a.description;
    if (typeof a.receipt_reference === 'string') input.receipt_reference = a.receipt_reference;
    if (typeof a.sales_tax_rate === 'string') input.sales_tax_rate = a.sales_tax_rate;
    if (typeof a.sales_tax_value === 'string') input.sales_tax_value = a.sales_tax_value;
    if (a.sales_tax_status !== undefined) input.sales_tax_status = validateSalesTaxStatus(a.sales_tax_status);
    if (typeof a.ec_status === 'string') input.ec_status = a.ec_status;
    if (a.attachment !== undefined) input.attachment = validateAttachmentInput(a.attachment);
    applyAdvancedFields(a, input, false);
    return input;
}

function applyAdvancedToPayload(
    payload: Partial<ExpenseCreatePayload>,
    fields: AdvancedExpenseFields,
    refundDue: boolean,
    refs: ResolvedExpenseRefs,
): void {
    if (fields.currency) payload.currency = fields.currency;
    if (fields.native_gross_value) payload.native_gross_value = applySign(fields.native_gross_value, refundDue);
    if (fields.manual_sales_tax_amount) payload.manual_sales_tax_amount = fields.manual_sales_tax_amount;
    if (refs.project) payload.project = refs.project;
    if (fields.rebill_type) payload.rebill_type = fields.rebill_type;
    if (fields.rebill_factor) payload.rebill_factor = fields.rebill_factor;
    if (fields.recurring) payload.recurring = fields.recurring;
    if (fields.recurring_end_date) payload.recurring_end_date = fields.recurring_end_date;
    if (fields.property) payload.property = fields.property;
}

/** Build the FreeAgent wire payload for creating a money expense. */
export function buildExpensePayload(
    input: CreateExpenseInput,
    refs: ResolvedExpenseRefs,
): ExpenseCreatePayload {
    if (!refs.user) throw new Error('internal: resolved user URL missing');
    if (!refs.category) throw new Error('internal: resolved category URL missing');

    const payload: ExpenseCreatePayload = {
        user: refs.user,
        category: refs.category,
        dated_on: input.dated_on,
        gross_value: applySign(input.gross_value, input.refund_due),
    };
    if (input.description) payload.description = input.description;
    if (input.receipt_reference) payload.receipt_reference = input.receipt_reference;
    if (input.sales_tax_rate) payload.sales_tax_rate = input.sales_tax_rate;
    if (input.sales_tax_value) payload.sales_tax_value = input.sales_tax_value;
    if (input.sales_tax_status) payload.sales_tax_status = input.sales_tax_status;
    if (input.ec_status) payload.ec_status = input.ec_status;
    if (refs.attachment) payload.attachment = refs.attachment;
    applyAdvancedToPayload(payload, input, input.refund_due, refs);
    return payload;
}

/** Build a partial wire payload for updating an expense — only the fields
 *  the caller supplied are present. */
export function buildExpenseUpdatePayload(
    input: UpdateExpenseInput,
    refs: ResolvedExpenseRefs,
): Partial<ExpenseCreatePayload> {
    const payload: Partial<ExpenseCreatePayload> = {};
    if (refs.user) payload.user = refs.user;
    if (refs.category) payload.category = refs.category;
    if (input.dated_on) payload.dated_on = input.dated_on;
    if (input.gross_value !== undefined) {
        payload.gross_value = applySign(input.gross_value, input.refund_due);
    }
    if (input.description !== undefined) payload.description = input.description;
    if (input.receipt_reference !== undefined) payload.receipt_reference = input.receipt_reference;
    if (input.sales_tax_rate !== undefined) payload.sales_tax_rate = input.sales_tax_rate;
    if (input.sales_tax_value !== undefined) payload.sales_tax_value = input.sales_tax_value;
    if (input.sales_tax_status !== undefined) payload.sales_tax_status = input.sales_tax_status;
    if (input.ec_status !== undefined) payload.ec_status = input.ec_status;
    if (refs.attachment) payload.attachment = refs.attachment;
    applyAdvancedToPayload(payload, input, input.refund_due, refs);
    return payload;
}

/** Read a receipt that was staged via stage_evidence and turn it into an
 *  attachment payload. Reuses validateEvidencePath for the path-traversal,
 *  symlink and size defences. Throws (rather than silently dropping the
 *  receipt) when staging is unavailable or the path fails validation. */
export function readStagedAttachment(
    input: ExpenseAttachmentInput,
    stagingPath: string | null,
    deps: { readFile?: (p: string) => Buffer } = {},
): ExpenseAttachmentPayload {
    if (!stagingPath) {
        throw new Error(
            'An attachment was supplied but the evidence staging volume is not mounted. ' +
            'Create the expense without an attachment, or set up the shared volume (see README).',
        );
    }
    const check = validateEvidencePath(input.evidence_path, stagingPath);
    if (!check.ok) {
        throw new Error(`attachment validation failed: ${check.reason}`);
    }
    const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p));
    const bytes = readFile(input.evidence_path);
    const out: ExpenseAttachmentPayload = {
        data: bytes.toString('base64'),
        file_name: input.file_name,
        content_type: input.content_type,
    };
    if (input.description) out.description = input.description;
    return out;
}
