// Apply approved reconciliations to FreeAgent.
//
// Best-effort batch: each explanation is processed independently and
// reported in the result map (posted/skipped/failed). The agent never
// gets a generic "failed" — every outcome includes either a specific
// SkipReason or a concrete error string, so the user can be told
// exactly what happened to each transaction.
//
// Idempotency: every ExplanationToApply carries an `idempotency_key`
// (sha256 over canonical JSON of the salient fields). Before posting
// we GET the bank transaction and compare the agent-supplied key
// against keys derived from any already-existing explanations on it.
// On match we skip with `duplicate_of_existing_explanation` — covers
// the partial-batch retry case (network drop mid-batch, retry).
//
// Validation order per explanation (refuse early, fail loud):
//   1. v1.x scope guards (FX, transfer fields rejected for v1).
//   2. Path validation if attachment is present (resolve, prefix-check
//      under stagingPath, lstat to block symlinks, size cap).
//   3. Re-fetch bank transaction; check idempotency match → skip.
//   4. Check unexplained_amount → skip already_explained.
//   5. Bill/invoice existence and paid-state checks.
//   6. Read attachment bytes (only after every cheap check has passed).
//   7. POST.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
    ApplyResult,
    BankAccount,
    BankTransaction,
    BankTransactionExplanation,
    BankTransactionExplanationCreatePayload,
    Bill,
    ExplanationToApply,
    Invoice,
    SkipReason,
} from './types.js';

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface IdempotencyKeyInput {
    bank_transaction: string;
    gross_value: string;
    dated_on: string;
    category?: string;
    paid_bill?: string;
    paid_invoice?: string;
    description?: string;
}

/** sha256(canonical JSON with sorted keys) over the salient fields.
 *  Empty/undefined fields are omitted from the preimage so the key
 *  stays stable when the agent leaves out optional fields. Description
 *  is included so legitimate same-day same-amount splits don't collide. */
export function idempotencyKey(input: IdempotencyKeyInput): string {
    const obj: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) {
        if (v !== undefined && v !== '') obj[k] = v as string;
    }
    const canonical = JSON.stringify(
        Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]])),
    );
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Compute the idempotency key for an existing explanation so we can
 *  match it against an agent-supplied key. The fallback for
 *  `bank_transaction` uses the surrounding context — explanations
 *  fetched as nested children of a transaction may not echo the field. */
export function existingExplanationKey(
    exp: BankTransactionExplanation,
    fallbackBankTransaction: string,
): string {
    return idempotencyKey({
        bank_transaction: exp.bank_transaction ?? fallbackBankTransaction,
        gross_value: exp.gross_value ?? '',
        dated_on: exp.dated_on ?? '',
        category: exp.category,
        paid_bill: exp.paid_bill,
        paid_invoice: exp.paid_invoice,
        description: exp.description,
    });
}

export type PathValidation =
    | { ok: true; size: number }
    | { ok: false; reason: string };

/** Defence-in-depth path validation. The combination of (a) prefix
 *  check after path.resolve and (b) lstat+isFile blocks: traversal,
 *  symlinks, oversize files, and missing files. The trailing path.sep
 *  on the prefix check is load-bearing — without it, "<sid>FOO" would
 *  match "<sid>" as a prefix. */
export function validateEvidencePath(
    candidate: string,
    stagingPath: string | null,
): PathValidation {
    if (!stagingPath) return { ok: false, reason: 'staging_volume_not_mounted' };
    if (typeof candidate !== 'string' || candidate.length === 0) {
        return { ok: false, reason: 'empty_path' };
    }

    const resolved = path.resolve(candidate);
    const root = stagingPath.endsWith(path.sep) ? stagingPath : stagingPath + path.sep;
    if (!resolved.startsWith(root)) {
        return { ok: false, reason: `path_outside_staging:${stagingPath}` };
    }

    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(resolved);
    } catch {
        return { ok: false, reason: 'file_not_found' };
    }

    if (!stat.isFile()) return { ok: false, reason: 'not_a_regular_file' };
    if (stat.size > MAX_ATTACHMENT_BYTES) {
        return { ok: false, reason: `too_large:${stat.size}` };
    }

    return { ok: true, size: stat.size };
}

/** Subset of FreeAgentClient that applyExplanations needs. Tests pass
 *  a mock; the real wiring uses the full client. */
export interface ApplyClient {
    getBankAccount(id: string): Promise<BankAccount>;
    getBankTransaction(id: string): Promise<BankTransaction>;
    getBill(id: string): Promise<Bill>;
    getInvoice(id: string): Promise<Invoice>;
    createBankTransactionExplanation(
        payload: BankTransactionExplanationCreatePayload,
    ): Promise<BankTransactionExplanation>;
}

export interface ApplyOptions {
    stagingPath: string | null;
    log?: (line: string) => void;
    /** For tests — overrides fs.readFileSync. Defaults to real fs. */
    readFile?: (p: string) => Buffer;
}

export async function applyExplanations(
    explanations: ExplanationToApply[],
    client: ApplyClient,
    opts: ApplyOptions,
): Promise<ApplyResult> {
    const log = opts.log ?? ((m) => console.error(m));
    const readFile = opts.readFile ?? ((p) => fs.readFileSync(p));
    const result: ApplyResult = { posted: [], skipped: [], failed: [] };

    log(`[apply] start n=${explanations.length}`);

    for (const exp of explanations) {
        const outcome = await applyOne(exp, client, { ...opts, readFile, log });
        recordOutcome(result, exp, outcome, log);
    }

    log(
        `[apply] done posted=${result.posted.length} ` +
        `skipped=${result.skipped.length} failed=${result.failed.length}`,
    );
    return result;
}

type ApplyOutcome =
    | { kind: 'posted'; explanation_url: string }
    | { kind: 'skipped'; reason: SkipReason }
    | { kind: 'failed'; error: string; http_status?: number };

interface ApplyOneOpts {
    stagingPath: string | null;
    readFile: (p: string) => Buffer;
    log: (line: string) => void;
}

async function applyOne(
    exp: ExplanationToApply,
    client: ApplyClient,
    opts: ApplyOneOpts,
): Promise<ApplyOutcome> {
    // v1.x scope guards.
    if (exp.foreign_currency_value || exp.foreign_currency_rate) {
        return {
            kind: 'failed',
            error: 'Foreign-currency reconciliations are deferred to a future version. Reconcile manually in the FreeAgent UI.',
        };
    }
    if (exp.transfer_bank_account) {
        return {
            kind: 'failed',
            error: 'Inter-account transfers are deferred to a future version. Reconcile manually in the FreeAgent UI.',
        };
    }

    // Attachment validation (cheap; do before network calls).
    if (exp.attachment) {
        const validation = validateEvidencePath(
            exp.attachment.evidence_path,
            opts.stagingPath,
        );
        if (!validation.ok) {
            if (validation.reason === 'staging_volume_not_mounted') {
                return { kind: 'skipped', reason: 'staging_volume_not_mounted' };
            }
            return { kind: 'failed', error: `attachment validation failed: ${validation.reason}` };
        }
    }

    // Re-fetch the bank transaction for staleness + duplicate checks.
    const txId = lastUrlSegment(exp.bank_transaction);
    if (!txId) {
        return { kind: 'failed', error: `invalid bank_transaction URL: ${exp.bank_transaction}` };
    }

    let tx: BankTransaction;
    try {
        tx = await client.getBankTransaction(txId);
    } catch (e) {
        const cls = classifyHttpFailure(e, 'transaction_not_found');
        return cls;
    }

    // Idempotency match against existing explanations on this transaction.
    const existing = tx.bank_transaction_explanations ?? [];
    const dupe = existing.find(
        e => existingExplanationKey(e, exp.bank_transaction) === exp.idempotency_key,
    );
    if (dupe) return { kind: 'skipped', reason: 'duplicate_of_existing_explanation' };

    // Already explained AND no idempotency match → genuinely already
    // covered (in the UI, by a rule, by another session, etc.).
    if (tx.unexplained_amount === '0.0' || tx.unexplained_amount === '0') {
        return { kind: 'skipped', reason: 'already_explained' };
    }

    // Bill/invoice safety checks.
    if (exp.paid_bill) {
        const billId = lastUrlSegment(exp.paid_bill);
        if (!billId) return { kind: 'failed', error: `invalid paid_bill URL: ${exp.paid_bill}` };
        try {
            const bill = await client.getBill(billId);
            if (bill.status === 'Paid') return { kind: 'skipped', reason: 'bill_already_paid' };
        } catch (e) {
            return classifyHttpFailure(e, 'bill_not_found');
        }
    }
    if (exp.paid_invoice) {
        const invoiceId = lastUrlSegment(exp.paid_invoice);
        if (!invoiceId) return { kind: 'failed', error: `invalid paid_invoice URL: ${exp.paid_invoice}` };
        try {
            const invoice = await client.getInvoice(invoiceId);
            if (invoice.status === 'Paid') return { kind: 'skipped', reason: 'invoice_already_paid' };
        } catch (e) {
            return classifyHttpFailure(e, 'invoice_not_found');
        }
    }

    // Read attachment bytes (after all cheap checks have passed).
    let attachmentBytes: Buffer | undefined;
    if (exp.attachment) {
        try {
            attachmentBytes = opts.readFile(exp.attachment.evidence_path);
        } catch (e) {
            return { kind: 'failed', error: `failed to read attachment: ${(e as Error).message}` };
        }
    }

    // Build and POST.
    const payload: BankTransactionExplanationCreatePayload = compactPayload({
        bank_transaction: exp.bank_transaction,
        dated_on: exp.dated_on,
        gross_value: exp.gross_value,
        description: exp.description,
        category: exp.category,
        paid_bill: exp.paid_bill,
        paid_invoice: exp.paid_invoice,
        sales_tax_status: exp.sales_tax_status,
        sales_tax_rate: exp.sales_tax_rate,
        sales_tax_value: exp.sales_tax_value,
        project: exp.project,
        marked_for_review: exp.marked_for_review,
        attachment: attachmentBytes && exp.attachment
            ? {
                  data: attachmentBytes.toString('base64'),
                  file_name: exp.attachment.file_name,
                  content_type: exp.attachment.content_type,
                  description: exp.attachment.description,
              }
            : undefined,
    });

    try {
        const created = await client.createBankTransactionExplanation(payload);
        return { kind: 'posted', explanation_url: created.url };
    } catch (e) {
        const err = e as { response?: { status?: number }; message?: string };
        return {
            kind: 'failed',
            error: err.message ?? String(e),
            http_status: err.response?.status,
        };
    }
}

function recordOutcome(
    result: ApplyResult,
    exp: ExplanationToApply,
    outcome: ApplyOutcome,
    log: (line: string) => void,
): void {
    const key = exp.idempotency_key;
    if (outcome.kind === 'posted') {
        result.posted.push({
            bank_transaction: exp.bank_transaction,
            explanation_url: outcome.explanation_url,
            idempotency_key: key,
        });
        log(`[apply] explanation idempotency_key=${key} action=posted url=${outcome.explanation_url}`);
    } else if (outcome.kind === 'skipped') {
        result.skipped.push({
            bank_transaction: exp.bank_transaction,
            reason: outcome.reason,
            idempotency_key: key,
        });
        log(`[apply] explanation idempotency_key=${key} action=skipped reason=${outcome.reason}`);
    } else {
        result.failed.push({
            bank_transaction: exp.bank_transaction,
            error: outcome.error,
            http_status: outcome.http_status,
            idempotency_key: key,
        });
        log(`[apply] explanation idempotency_key=${key} action=failed status=${outcome.http_status ?? '?'} error=${outcome.error}`);
    }
}

function classifyHttpFailure(e: unknown, notFoundReason: SkipReason): ApplyOutcome {
    const err = e as { response?: { status?: number }; message?: string };
    const status = err.response?.status;
    if (status === 404) return { kind: 'skipped', reason: notFoundReason };
    return { kind: 'failed', error: err.message ?? String(e), http_status: status };
}

function lastUrlSegment(s: string): string | null {
    if (typeof s !== 'string' || s.length === 0) return null;
    if (/^\d+$/.test(s)) return s;
    const m = s.match(/\/(\d+)\/?$/);
    return m ? m[1] : null;
}

function compactPayload<T extends Record<string, unknown>>(p: T): T {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) {
        if (v !== undefined) out[k] = v;
    }
    return out as T;
}
