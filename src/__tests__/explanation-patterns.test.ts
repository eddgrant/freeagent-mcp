import { describe, it, expect } from 'vitest';
import { aggregatePatterns, pickCommon, detectRecurring } from '../explanation-patterns.js';
import type { BankTransaction, BankTransactionExplanation } from '../types.js';

// Helpers — build minimal valid BankTransaction objects for testing.
function txn(args: {
    description: string;
    dated_on: string;
    amount: string;
    explanations: Array<Partial<BankTransactionExplanation>>;
}): BankTransaction {
    return {
        url: `https://api.freeagent.com/v2/bank_transactions/${Math.random()}`,
        amount: args.amount,
        bank_account: 'https://api.freeagent.com/v2/bank_accounts/1',
        dated_on: args.dated_on,
        description: args.description,
        unexplained_amount: '0.0',
        is_manual: false,
        created_at: '',
        updated_at: '',
        bank_transaction_explanations: args.explanations.map(e => ({
            url: '',
            dated_on: e.dated_on ?? args.dated_on,
            gross_value: e.gross_value ?? args.amount,
            ...e,
        })) as BankTransactionExplanation[],
    };
}

describe('pickCommon', () => {
    it('returns undefined when all values are empty', () => {
        expect(pickCommon([undefined, undefined, ''], 0.5)).toBeUndefined();
    });

    it('returns the most-common value when above threshold', () => {
        expect(pickCommon(['A', 'A', 'A', 'B'], 0.7)).toBe('A');
    });

    it('returns undefined when no value meets the threshold', () => {
        expect(pickCommon(['A', 'B', 'C'], 0.7)).toBeUndefined();
    });

    it('ignores empty values when computing threshold', () => {
        // 2 of 2 non-empty values agree → 100%, well above 70%.
        expect(pickCommon(['A', 'A', undefined, ''], 0.7)).toBe('A');
    });

    it('threshold is computed against non-empty count, not total', () => {
        // 2/3 non-empty agree → 67%, below 70% → undefined.
        expect(pickCommon(['A', 'A', 'B', undefined, undefined], 0.7)).toBeUndefined();
    });
});

describe('detectRecurring', () => {
    it('returns undefined when fewer than minCount dates supplied', () => {
        expect(detectRecurring(['2026-01-01', '2026-02-01'], 3, 0.15)).toBeUndefined();
    });

    it('detects a monthly schedule (cadence within typical month range)', () => {
        const dates = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'];
        // Gaps are [31, 28, 31] (Jan→Feb→Mar→Apr). Median = 31.
        const result = detectRecurring(dates, 3, 0.15);
        expect(result).toBeDefined();
        expect(result?.cadence_days).toBeGreaterThanOrEqual(28);
        expect(result?.cadence_days).toBeLessThanOrEqual(31);
        // Slight calendar drift puts confidence below 1.0 but well above 0.5.
        expect(result?.confidence).toBeGreaterThan(0.7);
    });

    it('returns 1.0 confidence on a perfectly uniform schedule', () => {
        // 30-day intervals exactly.
        const dates = ['2026-01-01', '2026-01-31', '2026-03-02', '2026-04-01'];
        const result = detectRecurring(dates, 3, 0.15);
        expect(result?.cadence_days).toBe(30);
        expect(result?.confidence).toBe(1.0);
    });

    it('returns undefined when gaps are too irregular', () => {
        const dates = ['2026-01-01', '2026-02-15', '2026-04-01', '2026-04-10'];
        // gaps ≈ 45, 45, 9 — wildly inconsistent
        expect(detectRecurring(dates, 3, 0.15)).toBeUndefined();
    });

    it('returns undefined when only one gap is available', () => {
        // 3 dates → only 2 gaps; default minCount=3 means we need ≥2 gaps,
        // which we have. But test minCount=4 → only 2 gaps, should refuse.
        const dates = ['2026-01-01', '2026-02-01', '2026-03-01'];
        expect(detectRecurring(dates, 4, 0.15)).toBeUndefined();
    });

    it('skips zero/negative gaps (duplicate dates)', () => {
        const dates = ['2026-01-01', '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'];
        const result = detectRecurring(dates, 3, 0.15);
        // The duplicate produces a 0 gap which we drop; remaining gaps
        // are 31, 28, 31 — recurring.
        expect(result).toBeDefined();
    });

    it('confidence drops as gaps become less consistent', () => {
        // Tight: every gap is exactly 30 days → confidence 1.0.
        const tight = detectRecurring(
            ['2026-01-01', '2026-01-31', '2026-03-02', '2026-04-01'],
            3, 0.15,
        );
        // Loose: monthly with calendar drift [31, 28, 31] → still recurring but lower confidence.
        const loose = detectRecurring(
            ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'],
            3, 0.15,
        );
        expect(tight).toBeDefined();
        expect(loose).toBeDefined();
        if (tight && loose) {
            expect(loose.confidence).toBeLessThan(tight.confidence);
        }
    });
});

describe('aggregatePatterns', () => {
    const CATEGORY_SUBSISTENCE = 'https://api.freeagent.com/v2/categories/285';
    const CATEGORY_TRAVEL = 'https://api.freeagent.com/v2/categories/365';
    const CATEGORY_SOFTWARE = 'https://api.freeagent.com/v2/categories/269';

    it('returns empty array on empty input', () => {
        expect(aggregatePatterns([])).toEqual([]);
    });

    it('skips transactions with no description', () => {
        const result = aggregatePatterns([
            txn({ description: '', dated_on: '2026-01-01', amount: '-10', explanations: [{ category: CATEGORY_TRAVEL }] }),
        ]);
        expect(result).toEqual([]);
    });

    it('skips transactions with no explanations', () => {
        const result = aggregatePatterns([
            txn({ description: 'Foo (Card Payment)/FOO/POS/', dated_on: '2026-01-01', amount: '-10', explanations: [] }),
        ]);
        expect(result).toEqual([]);
    });

    it('groups transactions by merchant signature', () => {
        const transactions = [
            txn({ description: 'TfL (Google Pay)/TFL TRAVEL CH/POS/', dated_on: '2026-04-01', amount: '-10', explanations: [{ category: CATEGORY_TRAVEL }] }),
            txn({ description: 'TfL (Contactless)/TFL TRAVEL CH/POS/', dated_on: '2026-04-08', amount: '-12', explanations: [{ category: CATEGORY_TRAVEL }] }),
            txn({ description: 'Anthropic (Online Payment)/ANTHROPIC/POS/', dated_on: '2026-04-15', amount: '-20', explanations: [{ category: CATEGORY_SOFTWARE }] }),
        ];
        const result = aggregatePatterns(transactions);
        expect(result.map(p => p.merchant_signature).sort()).toEqual(['ANTHROPIC', 'TFL']);
        const tfl = result.find(p => p.merchant_signature === 'TFL');
        expect(tfl?.count).toBe(2);
    });

    it('reports the most-common category per group when consensus is met', () => {
        const transactions = Array.from({ length: 10 }, (_, i) => txn({
            description: 'TfL (Google Pay)/TFL/POS/',
            dated_on: `2026-04-0${(i % 9) + 1}`,
            amount: '-10',
            explanations: [{ category: i < 9 ? CATEGORY_TRAVEL : CATEGORY_SUBSISTENCE }],
        }));
        const result = aggregatePatterns(transactions);
        expect(result[0].common_category).toBe(CATEGORY_TRAVEL);
    });

    it('omits common_category when no value meets the consensus threshold', () => {
        const transactions = [
            txn({ description: 'Foo (Card Payment)/FOO/POS/', dated_on: '2026-01-01', amount: '-10', explanations: [{ category: CATEGORY_TRAVEL }] }),
            txn({ description: 'Foo (Card Payment)/FOO/POS/', dated_on: '2026-02-01', amount: '-10', explanations: [{ category: CATEGORY_SUBSISTENCE }] }),
            txn({ description: 'Foo (Card Payment)/FOO/POS/', dated_on: '2026-03-01', amount: '-10', explanations: [{ category: CATEGORY_SOFTWARE }] }),
        ];
        const result = aggregatePatterns(transactions);
        expect(result[0].common_category).toBeUndefined();
    });

    it('records last_used as the most-recent dated_on across the group', () => {
        const transactions = [
            txn({ description: 'X (Card Payment)/X/POS/', dated_on: '2026-01-01', amount: '-1', explanations: [{ category: CATEGORY_TRAVEL }] }),
            txn({ description: 'X (Card Payment)/X/POS/', dated_on: '2026-04-15', amount: '-1', explanations: [{ category: CATEGORY_TRAVEL }] }),
            txn({ description: 'X (Card Payment)/X/POS/', dated_on: '2026-02-01', amount: '-1', explanations: [{ category: CATEGORY_TRAVEL }] }),
        ];
        const result = aggregatePatterns(transactions);
        expect(result[0].last_used).toBe('2026-04-15');
    });

    it('detects recurring monthly subscriptions', () => {
        const transactions = [
            txn({ description: 'Anthropic (Online Payment)/ANTHROPIC/POS/', dated_on: '2026-01-15', amount: '-20', explanations: [{ category: CATEGORY_SOFTWARE }] }),
            txn({ description: 'Anthropic (Online Payment)/ANTHROPIC/POS/', dated_on: '2026-02-15', amount: '-20', explanations: [{ category: CATEGORY_SOFTWARE }] }),
            txn({ description: 'Anthropic (Online Payment)/ANTHROPIC/POS/', dated_on: '2026-03-15', amount: '-20', explanations: [{ category: CATEGORY_SOFTWARE }] }),
            txn({ description: 'Anthropic (Online Payment)/ANTHROPIC/POS/', dated_on: '2026-04-15', amount: '-20', explanations: [{ category: CATEGORY_SOFTWARE }] }),
        ];
        const result = aggregatePatterns(transactions);
        expect(result[0].recurring).toBeDefined();
        expect(result[0].recurring?.cadence_days).toBeGreaterThanOrEqual(28);
        expect(result[0].recurring?.cadence_days).toBeLessThanOrEqual(31);
    });

    it('does not flag occasional ad-hoc purchases as recurring', () => {
        const transactions = [
            txn({ description: 'Random (Card Payment)/X/POS/', dated_on: '2026-01-01', amount: '-10', explanations: [{ category: CATEGORY_SUBSISTENCE }] }),
            txn({ description: 'Random (Card Payment)/X/POS/', dated_on: '2026-02-15', amount: '-30', explanations: [{ category: CATEGORY_SUBSISTENCE }] }),
            txn({ description: 'Random (Card Payment)/X/POS/', dated_on: '2026-04-22', amount: '-100', explanations: [{ category: CATEGORY_SUBSISTENCE }] }),
        ];
        const result = aggregatePatterns(transactions);
        expect(result[0].recurring).toBeUndefined();
    });

    it('emits sample_dated_on with up to 3 most-recent dates', () => {
        const transactions = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'].map(d =>
            txn({ description: 'X (Card Payment)/X/POS/', dated_on: d, amount: '-1', explanations: [{ category: CATEGORY_TRAVEL }] }),
        );
        const result = aggregatePatterns(transactions);
        expect(result[0].sample_dated_on).toEqual(['2026-05-01', '2026-04-01', '2026-03-01']);
    });

    it('computes signed average amount', () => {
        const transactions = [
            txn({ description: 'X (Card Payment)/X/POS/', dated_on: '2026-01-01', amount: '-10', explanations: [{ gross_value: '-10', category: CATEGORY_TRAVEL }] }),
            txn({ description: 'X (Card Payment)/X/POS/', dated_on: '2026-02-01', amount: '-20', explanations: [{ gross_value: '-20', category: CATEGORY_TRAVEL }] }),
        ];
        const result = aggregatePatterns(transactions);
        expect(result[0].average_amount).toBe('-15.00');
    });

    it('sorts groups by descending count, then alphabetical signature', () => {
        const transactions = [
            txn({ description: 'A (Card Payment)/A/POS/', dated_on: '2026-01-01', amount: '-1', explanations: [{ category: CATEGORY_TRAVEL }] }),
            txn({ description: 'B (Card Payment)/B/POS/', dated_on: '2026-01-01', amount: '-1', explanations: [{ category: CATEGORY_TRAVEL }] }),
            txn({ description: 'B (Card Payment)/B/POS/', dated_on: '2026-02-01', amount: '-1', explanations: [{ category: CATEGORY_TRAVEL }] }),
            txn({ description: 'C (Card Payment)/C/POS/', dated_on: '2026-01-01', amount: '-1', explanations: [{ category: CATEGORY_TRAVEL }] }),
        ];
        const result = aggregatePatterns(transactions);
        expect(result.map(p => p.merchant_signature)).toEqual(['B', 'A', 'C']);
    });

    it('counts split explanations as separate samples', () => {
        const transactions = [
            txn({
                description: 'Mixed (Card Payment)/X/POS/',
                dated_on: '2026-01-01', amount: '-100',
                explanations: [
                    { gross_value: '-60', category: CATEGORY_TRAVEL },
                    { gross_value: '-40', category: CATEGORY_SUBSISTENCE },
                ],
            }),
        ];
        const result = aggregatePatterns(transactions);
        expect(result[0].count).toBe(2);
    });

    describe('transfer_share', () => {
        it('reports 0 when no explanations are transfers', () => {
            const transactions = [
                txn({ description: 'TfL (Card Payment)/TFL/POS/', dated_on: '2026-01-01', amount: '-10', explanations: [{ category: CATEGORY_TRAVEL }] }),
            ];
            const result = aggregatePatterns(transactions);
            expect(result[0].transfer_share).toBe(0);
        });

        it('reports 1 when every explanation is a transfer', () => {
            const transactions = [
                txn({ description: 'Tide (Faster Payments Out)/Savings/PAYMENT/', dated_on: '2026-01-01', amount: '-1000', explanations: [{ transfer_bank_account: 'https://api.freeagent.com/v2/bank_accounts/2' }] }),
                txn({ description: 'Tide (Faster Payments Out)/Savings/PAYMENT/', dated_on: '2026-02-01', amount: '-1000', explanations: [{ transfer_bank_account: 'https://api.freeagent.com/v2/bank_accounts/2' }] }),
            ];
            const result = aggregatePatterns(transactions);
            expect(result[0].transfer_share).toBe(1);
        });

        it('reports the fraction when transfers are mixed', () => {
            const transactions = [
                txn({ description: 'X (Card Payment)/X/POS/', dated_on: '2026-01-01', amount: '-10', explanations: [{ category: CATEGORY_TRAVEL }] }),
                txn({ description: 'X (Card Payment)/X/POS/', dated_on: '2026-02-01', amount: '-10', explanations: [{ category: CATEGORY_TRAVEL }] }),
                txn({ description: 'X (Card Payment)/X/POS/', dated_on: '2026-03-01', amount: '-10', explanations: [{ transfer_bank_account: 'https://api.freeagent.com/v2/bank_accounts/2' }] }),
                txn({ description: 'X (Card Payment)/X/POS/', dated_on: '2026-04-01', amount: '-10', explanations: [{ transfer_bank_account: 'https://api.freeagent.com/v2/bank_accounts/2' }] }),
            ];
            const result = aggregatePatterns(transactions);
            expect(result[0].transfer_share).toBe(0.5);
        });
    });
});
