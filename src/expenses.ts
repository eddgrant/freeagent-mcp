// Payload construction for the expense tools.
//
// Tool input is validated by the Zod schemas in tool-schemas.ts before a
// handler runs, so this module holds only what a schema cannot: the
// transformation from validated input to the FreeAgent wire payload, the
// cross-field coherence checks, and the staged-attachment file read.
//
// The sign convention lives here. FreeAgent stores an out-of-pocket
// expense as a NEGATIVE gross_value ("a payment to the claimant") and
// money the claimant owes back as POSITIVE ("a refund due"). Tool callers
// pass a positive gross_value and an optional refund_due flag; applySign()
// does the negation so the trap never reaches the user.

import * as fs from 'node:fs';
import { z } from 'zod';
import type { ExpenseCreatePayload, ExpenseAttachmentPayload } from './types.js';
import { validateEvidencePath, detectMimeType, ALLOWED_CONTENT_TYPES } from './evidence-staging.js';
import { toolSchemas } from './tool-schemas.js';

/** Validated create_expense input (the Zod-inferred shape). */
export type CreateExpenseInput = z.infer<typeof toolSchemas.create_expense>;
/** Validated update_expense input, minus the path-param `id`. */
export type UpdateExpenseInput = Omit<z.infer<typeof toolSchemas.update_expense>, 'id'>;
/** Receipt attachment as referenced by curated tool input. */
export type ExpenseAttachmentInput = NonNullable<CreateExpenseInput['attachment']>;

/** URLs resolved from curated references, ready to drop into the payload. */
export interface ResolvedExpenseRefs {
    user?: string;
    category?: string;
    project?: string;
    attachment?: ExpenseAttachmentPayload;
}

/** Out-of-pocket expenses are stored negative ("a payment to the
 *  claimant"); money owed back from the claimant is positive ("a refund
 *  due"). `amount` is always a positive number. */
export function applySign(amount: number, refundDue?: boolean): string {
    return String(refundDue ? amount : -amount);
}

// Cross-field rules a per-field schema can't express. Enforced on create
// (the full picture is present); skipped on update, where a complementary
// field may already exist on the expense.
function assertExpenseCoherent(input: CreateExpenseInput): void {
    if (input.rebill_type && !input.project) {
        throw new Error('rebill_type was given without a project to rebill the cost to.');
    }
    if ((input.rebill_type === 'markup' || input.rebill_type === 'price') && !input.rebill_factor) {
        throw new Error(`rebill_factor is required when rebill_type is "${input.rebill_type}".`);
    }
    if (input.rebill_factor && !input.rebill_type) {
        throw new Error('rebill_factor was given without a rebill_type (cost, markup, or price).');
    }
    if (input.recurring_end_date && !input.recurring) {
        throw new Error('recurring_end_date was given without a recurring frequency.');
    }
}

function applyAdvancedToPayload(
    payload: Partial<ExpenseCreatePayload>,
    fields: CreateExpenseInput | UpdateExpenseInput,
    refs: ResolvedExpenseRefs,
): void {
    if (fields.currency) payload.currency = fields.currency;
    if (fields.native_gross_value !== undefined) {
        payload.native_gross_value = applySign(fields.native_gross_value, fields.refund_due);
    }
    if (fields.manual_sales_tax_amount) payload.manual_sales_tax_amount = fields.manual_sales_tax_amount;
    if (refs.project) payload.project = refs.project;
    if (fields.rebill_type) payload.rebill_type = fields.rebill_type;
    if (fields.rebill_factor) payload.rebill_factor = fields.rebill_factor;
    if (fields.recurring) payload.recurring = fields.recurring;
    if (fields.recurring_end_date) payload.recurring_end_date = fields.recurring_end_date;
    if (fields.property) payload.property = fields.property;
}

/** Build the FreeAgent wire payload for creating a money expense. */
export function buildExpensePayload(input: CreateExpenseInput, refs: ResolvedExpenseRefs): ExpenseCreatePayload {
    if (!refs.user) throw new Error('internal: resolved user URL missing');
    if (!refs.category) throw new Error('internal: resolved category URL missing');
    assertExpenseCoherent(input);

    const payload: ExpenseCreatePayload = {
        user: refs.user,
        category: refs.category,
        dated_on: input.dated_on,
        gross_value: applySign(input.gross_value, input.refund_due),
    };
    if (input.description) payload.description = input.description;
    if (input.receipt_reference) payload.receipt_reference = input.receipt_reference;
    if (input.sales_tax_rate) payload.sales_tax_rate = input.sales_tax_rate;
    if (input.sales_tax_status) payload.sales_tax_status = input.sales_tax_status;
    if (input.ec_status) payload.ec_status = input.ec_status;
    if (refs.attachment) payload.attachment = refs.attachment;
    applyAdvancedToPayload(payload, input, refs);
    return payload;
}

/** Build a partial wire payload for updating an expense — only the fields
 *  the caller supplied are present. */
export function buildExpenseUpdatePayload(input: UpdateExpenseInput, refs: ResolvedExpenseRefs): Partial<ExpenseCreatePayload> {
    const payload: Partial<ExpenseCreatePayload> = {};
    if (refs.user) payload.user = refs.user;
    if (refs.category) payload.category = refs.category;
    if (input.dated_on) payload.dated_on = input.dated_on;
    if (input.gross_value !== undefined) payload.gross_value = applySign(input.gross_value, input.refund_due);
    if (input.description !== undefined) payload.description = input.description;
    if (input.receipt_reference !== undefined) payload.receipt_reference = input.receipt_reference;
    if (input.sales_tax_rate !== undefined) payload.sales_tax_rate = input.sales_tax_rate;
    if (input.sales_tax_status !== undefined) payload.sales_tax_status = input.sales_tax_status;
    if (input.ec_status !== undefined) payload.ec_status = input.ec_status;
    if (refs.attachment) payload.attachment = refs.attachment;
    applyAdvancedToPayload(payload, input, refs);
    return payload;
}

/** Read a receipt file the caller has copied into the session staging
 *  directory and turn it into an attachment payload. validateEvidencePath
 *  provides the path-traversal, symlink and size defences; the magic-byte
 *  check verifies the file's real type matches the declared content_type.
 *  Throws — rather than silently dropping the receipt — on any failure. */
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
        if (check.reason.startsWith('too_large:')) {
            const bytes = check.reason.slice('too_large:'.length);
            throw new Error(
                `attachment is too large (${bytes} bytes). FreeAgent rejects expense ` +
                `attachments over 5 MB — downscale or recompress the file and retry.`,
            );
        }
        throw new Error(`attachment validation failed: ${check.reason}`);
    }
    const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p));
    const bytes = readFile(input.evidence_path);

    const detected = detectMimeType(bytes);
    if (detected !== input.content_type) {
        throw new Error(
            `attachment content-type mismatch: declared "${input.content_type}" but the ` +
            `file's bytes are ${detected ?? 'an unrecognised type'}. Allowed types: ` +
            `${ALLOWED_CONTENT_TYPES.join(', ')}.`,
        );
    }

    const out: ExpenseAttachmentPayload = {
        data: bytes.toString('base64'),
        file_name: input.file_name,
        content_type: input.content_type,
    };
    if (input.description) out.description = input.description;
    return out;
}
