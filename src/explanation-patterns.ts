// Aggregate the user's reconciliation history into per-merchant patterns
// that propose_reconciliations can use to seed category, VAT, and project
// suggestions on new transactions.
//
// Input: a list of BankTransaction objects with their nested
// bank_transaction_explanations[] populated (FreeAgent returns this shape
// from /bank_transactions when view=explained or view=all).
//
// Output: one MerchantPattern per unique merchant signature, with:
//   - the most-common category/VAT-rate/project (when consistent enough)
//   - recurring-payment detection (median-gap / variance heuristic)
//   - a small sample of dated_on values for human verification
//
// Recurring-payment detection: a group with ≥3 transactions and
// consistent inter-transaction gaps (stdev < 15% of median) is flagged
// as recurring with cadence = median gap.

import type { BankTransaction, BankTransactionExplanation } from './types.js';
import { merchantSignature, type SignatureOptions } from './merchant-signature.js';

export interface MerchantPattern {
    merchant_signature: string;
    count: number;
    last_used: string;                       // YYYY-MM-DD
    average_amount?: string;                 // signed decimal string

    common_category?: string;                // category URL
    common_sales_tax_rate?: string;          // e.g. "20.0"
    common_project?: string;                 // project URL

    /** Proportion of historical samples that set transfer_bank_account.
     *  When >0.7 the propose logic treats new transactions on this
     *  merchant as inter-account transfers and skips them in v1
     *  (transfers are deferred to v1.x). */
    transfer_share: number;                  // 0..1

    recurring?: { cadence_days: number; confidence: number };

    // Up to 3 most-recent dates, for human verification in the proposal
    // ("you've reconciled this on 2026-04-12, 2026-03-10, 2026-02-08").
    sample_dated_on: string[];
}

export interface AggregateOptions {
    /** Min agreement required before emitting common_category / VAT /
     *  project. 0..1; default 0.7 (i.e. ≥70% of group members must
     *  agree). Below this we leave the field unset rather than suggest
     *  a contested value. */
    consensusThreshold?: number;
    /** Recurring detection requires at least this many transactions in
     *  a group. Default 3. */
    minRecurringCount?: number;
    /** Recurring stdev/median ratio under which we call a group
     *  recurring. Default 0.15 (15%). */
    recurringMaxRelativeStdev?: number;
    /** Forwarded to merchantSignature. */
    signatureOptions?: SignatureOptions;
}

const DEFAULT_CONSENSUS = 0.7;
const DEFAULT_MIN_RECURRING = 3;
const DEFAULT_RECURRING_MAX_REL_STDEV = 0.15;

interface PatternSample {
    dated_on: string;
    gross_value: number;          // numeric for averaging
    category?: string;
    sales_tax_rate?: string;
    project?: string;
    transfer_bank_account?: string;
}

export function aggregatePatterns(
    transactions: BankTransaction[],
    opts: AggregateOptions = {},
): MerchantPattern[] {
    const consensus = opts.consensusThreshold ?? DEFAULT_CONSENSUS;
    const minRecurring = opts.minRecurringCount ?? DEFAULT_MIN_RECURRING;
    const maxRelStdev = opts.recurringMaxRelativeStdev ?? DEFAULT_RECURRING_MAX_REL_STDEV;

    // Group raw samples by merchant signature.
    const groups = new Map<string, PatternSample[]>();
    for (const tx of transactions) {
        const sig = merchantSignature(tx.description ?? '', opts.signatureOptions);
        if (!sig) continue;
        const explanations = (tx.bank_transaction_explanations ?? []) as BankTransactionExplanation[];
        if (explanations.length === 0) continue;

        // For matching purposes, fold every explanation into the group —
        // a split transaction contributes one sample per piece. The
        // category/VAT consensus then naturally weights the dominant
        // pattern even on splits.
        for (const exp of explanations) {
            const sample: PatternSample = {
                dated_on: exp.dated_on ?? tx.dated_on,
                gross_value: parseAmount(exp.gross_value ?? tx.amount),
                category: exp.category,
                sales_tax_rate: exp.sales_tax_rate,
                project: exp.project,
                transfer_bank_account: exp.transfer_bank_account,
            };
            const arr = groups.get(sig);
            if (arr) arr.push(sample);
            else groups.set(sig, [sample]);
        }
    }

    const out: MerchantPattern[] = [];
    for (const [sig, samples] of groups) {
        out.push(buildPattern(sig, samples, consensus, minRecurring, maxRelStdev));
    }
    out.sort((a, b) => b.count - a.count || a.merchant_signature.localeCompare(b.merchant_signature));
    return out;
}

function buildPattern(
    sig: string,
    samples: PatternSample[],
    consensus: number,
    minRecurring: number,
    maxRelStdev: number,
): MerchantPattern {
    const sortedByDate = [...samples].sort((a, b) => a.dated_on.localeCompare(b.dated_on));
    const last = sortedByDate[sortedByDate.length - 1];

    const totalAmount = samples.reduce((s, x) => s + x.gross_value, 0);
    const avg = samples.length > 0 ? totalAmount / samples.length : 0;

    const transferCount = samples.filter(s => s.transfer_bank_account).length;
    const transferShare = samples.length > 0 ? transferCount / samples.length : 0;

    return {
        merchant_signature: sig,
        count: samples.length,
        last_used: last.dated_on,
        average_amount: avg.toFixed(2),
        common_category: pickCommon(samples.map(s => s.category), consensus),
        common_sales_tax_rate: pickCommon(samples.map(s => s.sales_tax_rate), consensus),
        common_project: pickCommon(samples.map(s => s.project), consensus),
        transfer_share: Number(transferShare.toFixed(2)),
        recurring: detectRecurring(sortedByDate.map(s => s.dated_on), minRecurring, maxRelStdev),
        sample_dated_on: sortedByDate.slice(-3).map(s => s.dated_on).reverse(),
    };
}

/** Picks the most-common non-empty value if it meets the consensus
 *  threshold among non-empty values. Returns undefined otherwise. */
export function pickCommon(values: Array<string | undefined>, threshold: number): string | undefined {
    const counts = new Map<string, number>();
    let nonEmpty = 0;
    for (const v of values) {
        if (!v) continue;
        nonEmpty++;
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (nonEmpty === 0) return undefined;
    let best: string | undefined;
    let bestCount = 0;
    for (const [v, c] of counts) {
        if (c > bestCount) { best = v; bestCount = c; }
    }
    if (best === undefined) return undefined;
    return bestCount / nonEmpty >= threshold ? best : undefined;
}

/** Recurring detection by gap-variance heuristic. Returns undefined when
 *  the group is too small or too irregular. */
export function detectRecurring(
    sortedDates: string[],
    minCount: number,
    maxRelStdev: number,
): { cadence_days: number; confidence: number } | undefined {
    if (sortedDates.length < minCount) return undefined;

    // Build gap list in days.
    const gaps: number[] = [];
    for (let i = 1; i < sortedDates.length; i++) {
        const a = parseDate(sortedDates[i - 1]);
        const b = parseDate(sortedDates[i]);
        if (a == null || b == null) return undefined;
        const days = Math.round((b - a) / (1000 * 60 * 60 * 24));
        if (days <= 0) continue;          // duplicates or out-of-order; skip
        gaps.push(days);
    }
    if (gaps.length < minCount - 1) return undefined;

    const median = quickMedian(gaps);
    if (median <= 0) return undefined;

    const variance = gaps.reduce((s, g) => s + (g - median) ** 2, 0) / gaps.length;
    const stdev = Math.sqrt(variance);
    const relStdev = stdev / median;

    if (relStdev > maxRelStdev) return undefined;

    // Confidence scales inversely with normalised stdev: zero stdev → 1.0;
    // stdev at the threshold → 0.5; clamp at [0.5, 1.0].
    const confidence = Math.max(0.5, 1 - relStdev / maxRelStdev * 0.5);
    return { cadence_days: median, confidence: Number(confidence.toFixed(2)) };
}

function parseAmount(s: string | undefined): number {
    if (!s) return 0;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
}

function parseDate(s: string): number | null {
    // YYYY-MM-DD; permissive — Date.parse falls back to ISO interpretation.
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

function quickMedian(xs: number[]): number {
    if (xs.length === 0) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}
