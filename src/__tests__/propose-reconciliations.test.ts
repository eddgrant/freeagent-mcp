import { describe, it, expect } from 'vitest';
import { buildProposals } from '../propose-reconciliations.js';
import type { BankTransaction, Evidence } from '../types.js';
import type { MerchantPattern } from '../explanation-patterns.js';

const CAT_TRAVEL = 'https://api.freeagent.com/v2/categories/365';
const CAT_SOFTWARE = 'https://api.freeagent.com/v2/categories/269';
const TRANSFER_ACCT = 'https://api.freeagent.com/v2/bank_accounts/2';

function tx(args: Partial<BankTransaction> & { url: string; description: string; dated_on: string; amount: string }): BankTransaction {
    return {
        bank_account: 'https://api.freeagent.com/v2/bank_accounts/1',
        unexplained_amount: args.amount,
        is_manual: false,
        created_at: '',
        updated_at: '',
        ...args,
    };
}

function pattern(overrides: Partial<MerchantPattern> & { merchant_signature: string }): MerchantPattern {
    return {
        count: 5,
        last_used: '2026-04-01',
        sample_dated_on: ['2026-04-01'],
        transfer_share: 0,
        ...overrides,
    };
}

describe('buildProposals', () => {
    describe('with no history', () => {
        it('emits a low-confidence proposal with no category', () => {
            const result = buildProposals({
                unexplainedTransactions: [
                    tx({ url: 'tx/1', description: 'New Merchant (Card Payment)/NEW MERCHANT/POS/', dated_on: '2026-05-01', amount: '-25' }),
                ],
                patterns: [],
            });
            expect(result.proposals).toHaveLength(1);
            const p = result.proposals[0];
            expect(p.overall_confidence).toBe(0.3);
            expect(p.explanations[0].category).toBeUndefined();
            expect(p.explanations[0].history_match).toBeUndefined();
            expect(p.suggested_searches).toBeDefined();
        });

        it('includes a search hint with the merchant keywords', () => {
            const result = buildProposals({
                unexplainedTransactions: [
                    tx({ url: 'tx/1', description: 'Some Cafe (Card Payment)/SOME CAFE/POS/', dated_on: '2026-05-01', amount: '-15.50' }),
                ],
                patterns: [],
                accountCurrency: 'GBP',
            });
            const hint = result.proposals[0].suggested_searches?.[0];
            expect(hint?.amount).toBe('15.50');
            expect(hint?.currency).toBe('GBP');
            expect(hint?.merchant_keywords).toEqual(['SOME', 'CAFE']);
            expect(hint?.around_date).toBe('2026-05-01');
        });
    });

    describe('with history but no recurring signal', () => {
        it('seeds category/VAT/project from the pattern', () => {
            const result = buildProposals({
                unexplainedTransactions: [
                    tx({ url: 'tx/1', description: 'TfL (Google Pay)/TFL/POS/', dated_on: '2026-05-01', amount: '-10' }),
                ],
                patterns: [
                    pattern({
                        merchant_signature: 'TFL',
                        common_category: CAT_TRAVEL,
                        common_sales_tax_rate: '0.0',
                        average_amount: '-10.00',
                        count: 12,
                    }),
                ],
            });
            const p = result.proposals[0];
            expect(p.overall_confidence).toBe(0.8);
            expect(p.explanations[0].category).toBe(CAT_TRAVEL);
            expect(p.explanations[0].sales_tax_rate).toBe('0.0');
            expect(p.explanations[0].history_match?.merchant_signature).toBe('TFL');
            expect(p.explanations[0].history_match?.prior_count).toBe(12);
        });
    });

    describe('with recurring history', () => {
        it('emits 1.0 confidence and surfaces the recurring info', () => {
            const result = buildProposals({
                unexplainedTransactions: [
                    tx({ url: 'tx/1', description: 'Anthropic (Online Payment)/ANTHROPIC/POS/', dated_on: '2026-05-15', amount: '-20' }),
                ],
                patterns: [
                    pattern({
                        merchant_signature: 'ANTHROPIC',
                        common_category: CAT_SOFTWARE,
                        average_amount: '-20.00',
                        recurring: { cadence_days: 30, confidence: 1.0 },
                        count: 12,
                    }),
                ],
            });
            const p = result.proposals[0];
            expect(p.overall_confidence).toBe(1.0);
            expect(p.explanations[0].history_match?.recurring).toEqual({ cadence_days: 30, confidence: 1.0 });
            expect(p.suggested_searches).toBeUndefined(); // recurring + clear cat → no need
        });
    });

    describe('transfer guard', () => {
        it('skips and notes when transfer_share > 0.7', () => {
            const result = buildProposals({
                unexplainedTransactions: [
                    tx({ url: 'tx/1', description: 'Tide (Faster Payments Out)/Savings/PAYMENT/', dated_on: '2026-05-01', amount: '-1000' }),
                ],
                patterns: [
                    pattern({
                        merchant_signature: 'TIDE',
                        transfer_share: 1.0,
                        count: 8,
                    }),
                ],
            });
            expect(result.proposals).toHaveLength(0);
            expect(result.notes[0]).toMatch(/inter-account transfer/);
            expect(result.notes[0]).toMatch(/Tide/);
        });

        it('proposes when transfer_share is at the threshold or below', () => {
            const result = buildProposals({
                unexplainedTransactions: [
                    tx({ url: 'tx/1', description: 'Maybe (Card Payment)/MAYBE/POS/', dated_on: '2026-05-01', amount: '-50' }),
                ],
                patterns: [
                    pattern({ merchant_signature: 'MAYBE', transfer_share: 0.5, common_category: CAT_TRAVEL }),
                ],
            });
            expect(result.proposals).toHaveLength(1);
            expect(result.notes).toEqual([]);
        });
    });

    describe('refund guard', () => {
        it('skips positive amounts when historical average is negative', () => {
            const result = buildProposals({
                unexplainedTransactions: [
                    tx({ url: 'tx/1', description: 'TfL (Google Pay)/TFL/POS/', dated_on: '2026-05-01', amount: '+10' }),
                ],
                patterns: [
                    pattern({
                        merchant_signature: 'TFL',
                        average_amount: '-10.00',
                        common_category: CAT_TRAVEL,
                    }),
                ],
            });
            expect(result.proposals).toHaveLength(0);
            expect(result.notes[0]).toMatch(/refund or reversal/i);
        });

        it('skips negative amounts when historical average is positive', () => {
            const result = buildProposals({
                unexplainedTransactions: [
                    tx({ url: 'tx/1', description: 'Customer Co (Faster Payments In)/CC/PAYMENT/', dated_on: '2026-05-01', amount: '-500' }),
                ],
                patterns: [
                    pattern({
                        merchant_signature: 'CUSTOMER CO',
                        average_amount: '+500.00',
                    }),
                ],
            });
            expect(result.proposals).toHaveLength(0);
            expect(result.notes[0]).toMatch(/refund or reversal/i);
        });

        it('does not flag transactions that share sign with history', () => {
            const result = buildProposals({
                unexplainedTransactions: [
                    tx({ url: 'tx/1', description: 'TfL (Google Pay)/TFL/POS/', dated_on: '2026-05-01', amount: '-10' }),
                ],
                patterns: [
                    pattern({
                        merchant_signature: 'TFL',
                        average_amount: '-10.00',
                        common_category: CAT_TRAVEL,
                    }),
                ],
            });
            expect(result.proposals).toHaveLength(1);
        });
    });

    describe('evidence matching', () => {
        const txn = tx({ url: 'tx/1', description: 'Restaurant (Card Payment)/RESTAURANT/POS/', dated_on: '2026-05-01', amount: '-42.10' });

        it('attaches evidence when amount and date match', () => {
            const evidence: Evidence[] = [
                {
                    source: 'gmail:work',
                    ref_id: 'msg/abc',
                    file_name: 'receipt.pdf',
                    content_type: 'application/pdf',
                    extracted: { dated_on: '2026-05-01', gross_value: '42.10' },
                },
            ];
            const result = buildProposals({ unexplainedTransactions: [txn], patterns: [], evidence });
            const matched = result.proposals[0].explanations[0].evidence;
            expect(matched).toHaveLength(1);
            expect(matched?.[0].ref_id).toBe('msg/abc');
            expect(matched?.[0].match_confidence).toBeGreaterThan(0.9);
        });

        it('rejects evidence whose amount differs beyond tolerance', () => {
            const evidence: Evidence[] = [
                {
                    source: 'gmail:work',
                    ref_id: 'msg/abc',
                    file_name: 'receipt.pdf',
                    content_type: 'application/pdf',
                    extracted: { dated_on: '2026-05-01', gross_value: '99.99' },
                },
            ];
            const result = buildProposals({ unexplainedTransactions: [txn], patterns: [], evidence });
            expect(result.proposals[0].explanations[0].evidence).toBeUndefined();
        });

        it('rejects evidence outside the date window', () => {
            const evidence: Evidence[] = [
                {
                    source: 'gmail:work',
                    ref_id: 'msg/abc',
                    file_name: 'receipt.pdf',
                    content_type: 'application/pdf',
                    extracted: { dated_on: '2026-04-01', gross_value: '42.10' },
                },
            ];
            const result = buildProposals({ unexplainedTransactions: [txn], patterns: [], evidence });
            expect(result.proposals[0].explanations[0].evidence).toBeUndefined();
        });

        it('lifts confidence when evidence matches', () => {
            const evidence: Evidence[] = [
                {
                    source: 'gmail:work',
                    ref_id: 'msg/abc',
                    file_name: 'receipt.pdf',
                    content_type: 'application/pdf',
                    extracted: { dated_on: '2026-05-01', gross_value: '42.10' },
                },
            ];
            const noEvidence = buildProposals({ unexplainedTransactions: [txn], patterns: [] });
            const withEvidence = buildProposals({ unexplainedTransactions: [txn], patterns: [], evidence });
            expect(withEvidence.proposals[0].overall_confidence).toBeGreaterThan(
                noEvidence.proposals[0].overall_confidence,
            );
        });

        it('returns multiple candidates sorted by score (best first)', () => {
            const evidence: Evidence[] = [
                {
                    source: 'a', ref_id: 'lower', file_name: 'a.pdf', content_type: 'application/pdf',
                    extracted: { dated_on: '2026-05-04', gross_value: '42.10' },  // 3 days off
                },
                {
                    source: 'b', ref_id: 'higher', file_name: 'b.pdf', content_type: 'application/pdf',
                    extracted: { dated_on: '2026-05-01', gross_value: '42.10' },  // exact
                },
            ];
            const result = buildProposals({ unexplainedTransactions: [txn], patterns: [], evidence });
            const matched = result.proposals[0].explanations[0].evidence;
            expect(matched?.map(e => e.ref_id)).toEqual(['higher', 'lower']);
        });
    });

    describe('proposal_id generation', () => {
        it('produces a per-transaction stable-ish id', () => {
            const result = buildProposals({
                unexplainedTransactions: [
                    tx({ url: 'https://api.freeagent.com/v2/bank_transactions/12345', description: 'Foo (Card Payment)/F/POS/', dated_on: '2026-05-01', amount: '-1' }),
                ],
                patterns: [],
            });
            expect(result.proposals[0].proposal_id).toMatch(/^prop-12345-[a-z0-9]{6}$/);
        });
    });
});
