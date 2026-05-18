import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    idempotencyKey,
    existingExplanationKey,
    validateEvidencePath,
    applyExplanations,
    type ApplyClient,
} from '../apply-reconciliations.js';
import type {
    BankAccount,
    BankTransaction,
    BankTransactionExplanation,
    Bill,
    ExplanationToApply,
    Invoice,
} from '../types.js';

const TX_URL = 'https://api.freeagent.com/v2/bank_transactions/123';
const ACCOUNT_URL = 'https://api.freeagent.com/v2/bank_accounts/9';
const CAT_TRAVEL = 'https://api.freeagent.com/v2/categories/365';
const BILL_URL = 'https://api.freeagent.com/v2/bills/55';
const INVOICE_URL = 'https://api.freeagent.com/v2/invoices/77';

describe('idempotencyKey', () => {
    it('is stable across calls with the same input', () => {
        const input = { bank_transaction: TX_URL, gross_value: '-10', dated_on: '2026-04-01', category: CAT_TRAVEL };
        expect(idempotencyKey(input)).toBe(idempotencyKey(input));
    });

    it('is order-independent: keys sorted before hashing', () => {
        // Construct two literal-equivalent objects with different declared
        // key order. We expect the same hash.
        const a = idempotencyKey({ bank_transaction: TX_URL, gross_value: '-10', dated_on: '2026-04-01' });
        const b = idempotencyKey({ dated_on: '2026-04-01', gross_value: '-10', bank_transaction: TX_URL });
        expect(a).toBe(b);
    });

    it('changes when description differs (splits with different descriptions)', () => {
        const base = { bank_transaction: TX_URL, gross_value: '-40', dated_on: '2026-04-01', category: CAT_TRAVEL };
        const a = idempotencyKey({ ...base, description: 'lunch — Pizza Express' });
        const b = idempotencyKey({ ...base, description: 'lunch — Deliveroo' });
        expect(a).not.toBe(b);
    });

    it('changes when paid_bill is set vs not', () => {
        const a = idempotencyKey({ bank_transaction: TX_URL, gross_value: '-10', dated_on: '2026-04-01', category: CAT_TRAVEL });
        const b = idempotencyKey({ bank_transaction: TX_URL, gross_value: '-10', dated_on: '2026-04-01', paid_bill: BILL_URL });
        expect(a).not.toBe(b);
    });

    it('omits empty/undefined fields from the preimage (so optional fields don\'t change the key)', () => {
        const a = idempotencyKey({ bank_transaction: TX_URL, gross_value: '-10', dated_on: '2026-04-01', category: CAT_TRAVEL });
        const b = idempotencyKey({ bank_transaction: TX_URL, gross_value: '-10', dated_on: '2026-04-01', category: CAT_TRAVEL, description: '' });
        expect(a).toBe(b);
    });

    it('produces a 64-char hex sha256 string', () => {
        const k = idempotencyKey({ bank_transaction: TX_URL, gross_value: '-10', dated_on: '2026-04-01' });
        expect(k).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('existingExplanationKey', () => {
    it('matches an agent-derived key when the salient fields agree', () => {
        const agentKey = idempotencyKey({
            bank_transaction: TX_URL,
            gross_value: '-10',
            dated_on: '2026-04-01',
            category: CAT_TRAVEL,
            description: 'TfL',
        });
        const existing: BankTransactionExplanation = {
            url: 'x',
            bank_transaction: TX_URL,
            gross_value: '-10',
            dated_on: '2026-04-01',
            category: CAT_TRAVEL,
            description: 'TfL',
        };
        expect(existingExplanationKey(existing, TX_URL)).toBe(agentKey);
    });

    it('uses the fallback bank_transaction when the explanation field is missing', () => {
        const agentKey = idempotencyKey({
            bank_transaction: TX_URL,
            gross_value: '-10',
            dated_on: '2026-04-01',
            category: CAT_TRAVEL,
        });
        const nested: BankTransactionExplanation = {
            url: 'x',
            // bank_transaction omitted (as it would be in nested form)
            gross_value: '-10',
            dated_on: '2026-04-01',
            category: CAT_TRAVEL,
        };
        expect(existingExplanationKey(nested, TX_URL)).toBe(agentKey);
    });
});

describe('validateEvidencePath', () => {
    let stagingDir: string;

    beforeEach(() => {
        stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-validate-'));
    });

    afterEach(() => {
        fs.rmSync(stagingDir, { recursive: true, force: true });
    });

    it('refuses when stagingPath is null', () => {
        const r = validateEvidencePath('/tmp/anything', null);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('staging_volume_not_mounted');
    });

    it('refuses empty paths', () => {
        const r = validateEvidencePath('', stagingDir);
        expect(r.ok).toBe(false);
    });

    it('refuses traversal attempts', () => {
        const r = validateEvidencePath(path.join(stagingDir, '..', 'etc', 'passwd'), stagingDir);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/path_outside_staging/);
    });

    it('refuses sibling directories that share a prefix (the +sep gotcha)', () => {
        // E.g. stagingPath=/tmp/x and someone passes /tmp/xFOO/file.
        const sibling = stagingDir + 'FOO';
        fs.mkdirSync(sibling);
        const file = path.join(sibling, 'leak.pdf');
        fs.writeFileSync(file, 'x');
        const r = validateEvidencePath(file, stagingDir);
        try {
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toMatch(/path_outside_staging/);
        } finally {
            fs.rmSync(sibling, { recursive: true, force: true });
        }
    });

    it('refuses missing files', () => {
        const r = validateEvidencePath(path.join(stagingDir, 'does-not-exist.pdf'), stagingDir);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('file_not_found');
    });

    it('refuses symlinks (lstat blocks them)', () => {
        const target = path.join(stagingDir, 'real.pdf');
        const link = path.join(stagingDir, 'link.pdf');
        fs.writeFileSync(target, 'a');
        fs.symlinkSync(target, link);
        const r = validateEvidencePath(link, stagingDir);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('not_a_regular_file');
    });

    it('refuses directories', () => {
        const subdir = path.join(stagingDir, 'sub');
        fs.mkdirSync(subdir);
        const r = validateEvidencePath(subdir, stagingDir);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('not_a_regular_file');
    });

    it('refuses oversize files (>5 MB)', () => {
        const big = path.join(stagingDir, 'big.pdf');
        // 5 MB + 1 byte
        fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1, 0));
        const r = validateEvidencePath(big, stagingDir);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/^too_large:/);
    });

    it('accepts a valid regular file inside the staging directory', () => {
        const ok = path.join(stagingDir, 'receipt.pdf');
        fs.writeFileSync(ok, 'hello');
        const r = validateEvidencePath(ok, stagingDir);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.size).toBe(5);
    });
});

// ----- applyExplanations integration-style tests -----

function makeMockClient(overrides: Partial<ApplyClient> = {}): ApplyClient {
    const tx: BankTransaction = {
        url: TX_URL,
        amount: '-10',
        bank_account: ACCOUNT_URL,
        dated_on: '2026-04-01',
        description: 'TfL (Google Pay)/TFL/POS/',
        unexplained_amount: '-10',
        is_manual: false,
        created_at: '',
        updated_at: '',
        bank_transaction_explanations: [],
    };
    const account: BankAccount = {
        url: ACCOUNT_URL, name: 'X', bank_name: 'Y', type: 'StandardBankAccount',
        is_personal: false, is_primary: true, status: 'active', currency: 'GBP',
        current_balance: '0', opening_balance: '0', created_at: '', updated_at: '',
    };
    return {
        getBankAccount: vi.fn().mockResolvedValue(account),
        getBankTransaction: vi.fn().mockResolvedValue(tx),
        getBill: vi.fn(),
        getInvoice: vi.fn(),
        createBankTransactionExplanation: vi.fn().mockResolvedValue({
            url: 'https://api.freeagent.com/v2/bank_transaction_explanations/777',
            dated_on: '2026-04-01',
            gross_value: '-10',
        }),
        ...overrides,
    };
}

function makeExplanation(overrides: Partial<ExplanationToApply> = {}): ExplanationToApply {
    const base: ExplanationToApply = {
        bank_transaction: TX_URL,
        dated_on: '2026-04-01',
        gross_value: '-10',
        category: CAT_TRAVEL,
        description: 'TfL trip',
        idempotency_key: idempotencyKey({
            bank_transaction: TX_URL,
            gross_value: '-10',
            dated_on: '2026-04-01',
            category: CAT_TRAVEL,
            description: 'TfL trip',
        }),
        ...overrides,
    };
    return base;
}

describe('applyExplanations — happy path', () => {
    it('posts a simple category-only explanation and returns posted[]', async () => {
        const client = makeMockClient();
        const result = await applyExplanations([makeExplanation()], client, { stagingPath: null });
        expect(result.posted).toHaveLength(1);
        expect(result.skipped).toEqual([]);
        expect(result.failed).toEqual([]);
        expect(client.createBankTransactionExplanation).toHaveBeenCalledOnce();
    });

    it('omits undefined fields from the POST payload', async () => {
        const client = makeMockClient();
        await applyExplanations([makeExplanation({ project: undefined, paid_bill: undefined })], client, { stagingPath: null });
        const call = vi.mocked(client.createBankTransactionExplanation).mock.calls[0][0];
        expect(call).not.toHaveProperty('project');
        expect(call).not.toHaveProperty('paid_bill');
        expect(call.bank_transaction).toBe(TX_URL);
    });
});

describe('applyExplanations — idempotency / staleness', () => {
    it('skips with duplicate_of_existing_explanation when key matches a nested explanation', async () => {
        const exp = makeExplanation();
        const tx: BankTransaction = {
            url: TX_URL, amount: '-10', bank_account: ACCOUNT_URL, dated_on: '2026-04-01',
            description: 'TfL', unexplained_amount: '0', is_manual: false, created_at: '', updated_at: '',
            bank_transaction_explanations: [{
                url: 'x', gross_value: '-10', dated_on: '2026-04-01',
                category: CAT_TRAVEL, description: 'TfL trip',
            }],
        };
        const client = makeMockClient({ getBankTransaction: vi.fn().mockResolvedValue(tx) });
        const result = await applyExplanations([exp], client, { stagingPath: null });
        expect(result.skipped[0].reason).toBe('duplicate_of_existing_explanation');
        expect(client.createBankTransactionExplanation).not.toHaveBeenCalled();
    });

    it('skips with already_explained when unexplained_amount is 0 and no idempotency match', async () => {
        const tx: BankTransaction = {
            url: TX_URL, amount: '-10', bank_account: ACCOUNT_URL, dated_on: '2026-04-01',
            description: 'TfL', unexplained_amount: '0.0', is_manual: false, created_at: '', updated_at: '',
            bank_transaction_explanations: [{
                url: 'x', gross_value: '-10', dated_on: '2026-04-01',
                category: 'https://api.freeagent.com/v2/categories/999', // different category → diff key
                description: 'something else',
            }],
        };
        const client = makeMockClient({ getBankTransaction: vi.fn().mockResolvedValue(tx) });
        const result = await applyExplanations([makeExplanation()], client, { stagingPath: null });
        expect(result.skipped[0].reason).toBe('already_explained');
    });

    it('skips with transaction_not_found on 404 from getBankTransaction', async () => {
        const e = Object.assign(new Error('Not Found'), { response: { status: 404 } });
        const client = makeMockClient({ getBankTransaction: vi.fn().mockRejectedValue(e) });
        const result = await applyExplanations([makeExplanation()], client, { stagingPath: null });
        expect(result.skipped[0].reason).toBe('transaction_not_found');
    });
});

describe('applyExplanations — bill / invoice safety checks', () => {
    it('skips when paid_bill exists but is already Paid', async () => {
        const bill: Bill = { url: BILL_URL, status: 'Paid', dated_on: '2026-04-01', due_on: '2026-04-30',
            total_value: '10', paid_value: '10', due_value: '0',
            sales_tax_value: '0', currency: 'GBP', contact: '',
            created_at: '', updated_at: '', bill_items: [], comments: '', reference: '' } as unknown as Bill;
        const client = makeMockClient({ getBill: vi.fn().mockResolvedValue(bill) });
        const exp = makeExplanation({ paid_bill: BILL_URL, category: undefined });
        const result = await applyExplanations([exp], client, { stagingPath: null });
        expect(result.skipped[0].reason).toBe('bill_already_paid');
    });

    it('skips with bill_not_found on 404', async () => {
        const e = Object.assign(new Error('Not Found'), { response: { status: 404 } });
        const client = makeMockClient({ getBill: vi.fn().mockRejectedValue(e) });
        const exp = makeExplanation({ paid_bill: BILL_URL, category: undefined });
        const result = await applyExplanations([exp], client, { stagingPath: null });
        expect(result.skipped[0].reason).toBe('bill_not_found');
    });

    it('skips when paid_invoice is already Paid', async () => {
        const invoice = { url: INVOICE_URL, status: 'Paid' } as unknown as Invoice;
        const client = makeMockClient({ getInvoice: vi.fn().mockResolvedValue(invoice) });
        const exp = makeExplanation({ paid_invoice: INVOICE_URL, category: undefined });
        const result = await applyExplanations([exp], client, { stagingPath: null });
        expect(result.skipped[0].reason).toBe('invoice_already_paid');
    });
});

describe('applyExplanations — v1 scope guards', () => {
    it('refuses foreign-currency reconciliations as failed (deferred to v1.x)', async () => {
        const client = makeMockClient();
        const exp = makeExplanation({ foreign_currency_value: '50', foreign_currency_rate: '0.85' });
        const result = await applyExplanations([exp], client, { stagingPath: null });
        expect(result.failed[0].error).toMatch(/foreign-currency/i);
        expect(client.createBankTransactionExplanation).not.toHaveBeenCalled();
    });

    it('refuses transfer_bank_account explanations', async () => {
        const client = makeMockClient();
        const exp = makeExplanation({ transfer_bank_account: 'https://api.freeagent.com/v2/bank_accounts/99', category: undefined });
        const result = await applyExplanations([exp], client, { stagingPath: null });
        expect(result.failed[0].error).toMatch(/transfers/i);
    });
});

describe('applyExplanations — attachments', () => {
    let stagingDir: string;
    beforeEach(() => { stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-att-')); });
    afterEach(() => { fs.rmSync(stagingDir, { recursive: true, force: true }); });

    it('reads bytes from disk and base64-encodes into the payload', async () => {
        const file = path.join(stagingDir, 'r.pdf');
        fs.writeFileSync(file, Buffer.from('hello'));
        const client = makeMockClient();
        const exp = makeExplanation({
            attachment: { evidence_path: file, file_name: 'r.pdf', content_type: 'application/pdf' },
        });
        await applyExplanations([exp], client, { stagingPath: stagingDir });
        const call = vi.mocked(client.createBankTransactionExplanation).mock.calls[0][0];
        expect(call.attachment?.data).toBe(Buffer.from('hello').toString('base64'));
        expect(call.attachment?.file_name).toBe('r.pdf');
    });

    it('skips with staging_volume_not_mounted when staging is null but attachment is present', async () => {
        const client = makeMockClient();
        const exp = makeExplanation({
            attachment: { evidence_path: '/tmp/x.pdf', file_name: 'x.pdf', content_type: 'application/pdf' },
        });
        const result = await applyExplanations([exp], client, { stagingPath: null });
        expect(result.skipped[0].reason).toBe('staging_volume_not_mounted');
        expect(client.createBankTransactionExplanation).not.toHaveBeenCalled();
    });

    it('fails with attachment validation message when path is outside staging', async () => {
        const outside = '/tmp/anywhere/x.pdf';
        const client = makeMockClient();
        const exp = makeExplanation({
            attachment: { evidence_path: outside, file_name: 'x.pdf', content_type: 'application/pdf' },
        });
        const result = await applyExplanations([exp], client, { stagingPath: stagingDir });
        expect(result.failed[0].error).toMatch(/attachment validation failed/);
    });
});

describe('applyExplanations — POST failure handling', () => {
    it('records POST failures in failed[] with status code', async () => {
        const e = Object.assign(new Error('Validation failed'), { response: { status: 422 } });
        const client = makeMockClient({ createBankTransactionExplanation: vi.fn().mockRejectedValue(e) });
        const result = await applyExplanations([makeExplanation()], client, { stagingPath: null });
        expect(result.failed[0].error).toBe('Validation failed');
        expect(result.failed[0].http_status).toBe(422);
    });

    it('continues processing the rest of the batch after one failure', async () => {
        // First call rejects, second resolves.
        const e = Object.assign(new Error('boom'), { response: { status: 500 } });
        const create = vi.fn()
            .mockRejectedValueOnce(e)
            .mockResolvedValueOnce({ url: 'https://api.freeagent.com/v2/bank_transaction_explanations/2', dated_on: '2026-04-02', gross_value: '-5' });
        const client = makeMockClient({ createBankTransactionExplanation: create });

        const exps = [
            makeExplanation({ idempotency_key: 'a' }),
            makeExplanation({ idempotency_key: 'b', dated_on: '2026-04-02', gross_value: '-5' }),
        ];
        // Each call needs a fresh transaction with non-zero unexplained.
        client.getBankTransaction = vi.fn().mockResolvedValue({
            url: TX_URL, amount: '-15', bank_account: ACCOUNT_URL, dated_on: '2026-04-01',
            description: 'X', unexplained_amount: '-15', is_manual: false, created_at: '', updated_at: '',
            bank_transaction_explanations: [],
        });

        const result = await applyExplanations(exps, client, { stagingPath: null });
        expect(result.posted).toHaveLength(1);
        expect(result.failed).toHaveLength(1);
    });
});

describe('applyExplanations — logging', () => {
    it('emits structured stderr lines per outcome', async () => {
        const client = makeMockClient();
        const log = vi.fn();
        await applyExplanations([makeExplanation()], client, { stagingPath: null, log });
        const lines = log.mock.calls.map(c => c[0]);
        expect(lines.some(l => /\[apply\] start n=1/.test(l))).toBe(true);
        expect(lines.some(l => /\[apply\] explanation idempotency_key=.+ action=posted/.test(l))).toBe(true);
        expect(lines.some(l => /\[apply\] done posted=1/.test(l))).toBe(true);
    });
});
