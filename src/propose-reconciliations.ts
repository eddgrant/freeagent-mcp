// Pure proposal-building logic for the reconciliation feature.
//
// Takes the raw inputs (the bank account, unexplained transactions,
// historical merchant patterns, and optionally agent-provided evidence)
// and emits the structured response shape that propose_reconciliations
// returns. No I/O, no FreeAgent calls, no MCP wiring — those live in
// src/index.ts and are tested through the MCP transport.
//
// Decisions captured here:
//   - Pattern matching is by exact merchant signature equality. Fuzzy
//     matching is a v1.x follow-up.
//   - Transfers are skipped when the historical pattern has
//     transfer_share > 0.7. Surfaced in notes[].
//   - Refunds are skipped when amount sign disagrees with the
//     pattern's average. Surfaced in notes[].
//   - Confidence scoring is rule-based:
//       1.0  recurring + clear category
//       0.8  history + clear category
//       0.6  history + ambiguous category
//       0.4  history with no consensus on anything
//       0.3  no history at all
//     Modulated up/down by evidence presence.

import type {
    BankTransaction,
    Evidence,
    ProposedExplanation,
    ReconciliationProposal,
    SearchHint,
} from './types.js';
import { merchantSignature } from './merchant-signature.js';
import type { MerchantPattern } from './explanation-patterns.js';

const TRANSFER_SHARE_THRESHOLD = 0.7;
const DATE_WINDOW_DAYS = 7;
const AMOUNT_TOLERANCE_RELATIVE = 0.02;     // ±2%

export interface BuildProposalsArgs {
    unexplainedTransactions: BankTransaction[];
    patterns: MerchantPattern[];
    evidence?: Evidence[];
    /** Currency of the account, used to enrich `suggested_searches`. */
    accountCurrency?: string;
}

export interface BuildProposalsResult {
    proposals: ReconciliationProposal[];
    notes: string[];
}

export function buildProposals(args: BuildProposalsArgs): BuildProposalsResult {
    const patternsBySig = new Map(args.patterns.map(p => [p.merchant_signature, p]));
    const proposals: ReconciliationProposal[] = [];
    const notes: string[] = [];

    for (const tx of args.unexplainedTransactions) {
        const sig = merchantSignature(tx.description ?? '');
        const pattern = sig ? patternsBySig.get(sig) : undefined;
        const amount = parseFloat(tx.amount);

        // Transfer guard — history says this merchant is mostly transfers.
        if (pattern && pattern.transfer_share > TRANSFER_SHARE_THRESHOLD) {
            notes.push(
                `Skipped ${describe(tx)}: looks like an inter-account transfer ` +
                `(${Math.round(pattern.transfer_share * 100)}% of prior ${pattern.merchant_signature} ` +
                `transactions were transfers). v1 does not propose transfers.`,
            );
            continue;
        }

        // Refund guard — amount sign disagrees with history.
        if (pattern && pattern.average_amount && Number.isFinite(amount)) {
            const avg = parseFloat(pattern.average_amount);
            if (Number.isFinite(avg) && Math.sign(amount) !== Math.sign(avg) && avg !== 0) {
                notes.push(
                    `Skipped ${describe(tx)}: amount sign (${formatSigned(amount)}) ` +
                    `differs from typical ${pattern.merchant_signature} ` +
                    `(${formatSigned(avg)}). Likely a refund or reversal — ` +
                    `v1 does not propose these.`,
                );
                continue;
            }
        }

        proposals.push(buildOneProposal(tx, sig, pattern, args.evidence ?? [], args.accountCurrency));
    }

    return { proposals, notes };
}

function buildOneProposal(
    tx: BankTransaction,
    sig: string,
    pattern: MerchantPattern | undefined,
    allEvidence: Evidence[],
    accountCurrency: string | undefined,
): ReconciliationProposal {
    const txAmount = parseFloat(tx.amount);
    const matchedEvidence = matchEvidence(tx, txAmount, allEvidence);
    const overallConfidence = scoreConfidence(pattern, matchedEvidence.length > 0);

    const explanation: ProposedExplanation = {
        dated_on: tx.dated_on,
        gross_value: tx.amount,
        category: pattern?.common_category,
        sales_tax_rate: pattern?.common_sales_tax_rate,
        project: pattern?.common_project,
        evidence: matchedEvidence.length > 0 ? matchedEvidence : undefined,
        history_match: pattern
            ? {
                  merchant_signature: pattern.merchant_signature,
                  prior_count: pattern.count,
                  last_used: pattern.last_used,
                  recurring: pattern.recurring,
              }
            : undefined,
    };

    return {
        proposal_id: makeProposalId(tx),
        bank_transaction: tx.url,
        explanations: [explanation],
        overall_confidence: overallConfidence,
        rationale: buildRationale(sig, pattern, matchedEvidence.length),
        suggested_searches: pattern && overallConfidence < 0.8 && matchedEvidence.length === 0
            ? [buildSearchHint(tx, txAmount, pattern, accountCurrency)]
            : pattern || matchedEvidence.length > 0
                ? undefined
                : [buildSearchHint(tx, txAmount, undefined, accountCurrency)],
    };
}

function matchEvidence(tx: BankTransaction, txAmount: number, evidence: Evidence[]): Evidence[] {
    if (evidence.length === 0 || !Number.isFinite(txAmount)) return [];

    const txDate = Date.parse(tx.dated_on);
    if (!Number.isFinite(txDate)) return [];

    const tolerance = Math.max(0.5, Math.abs(txAmount) * AMOUNT_TOLERANCE_RELATIVE);
    const txAbs = Math.abs(txAmount);

    return evidence
        .map((e): { e: Evidence; score: number } | null => {
            const ex = e.extracted ?? {};
            const eAmt = ex.gross_value !== undefined ? Math.abs(parseFloat(ex.gross_value)) : NaN;
            if (!Number.isFinite(eAmt)) return null;
            if (Math.abs(eAmt - txAbs) > tolerance) return null;

            // Date proximity: within DATE_WINDOW_DAYS.
            if (ex.dated_on) {
                const ed = Date.parse(ex.dated_on);
                if (Number.isFinite(ed)) {
                    const daysApart = Math.abs(ed - txDate) / (1000 * 60 * 60 * 24);
                    if (daysApart > DATE_WINDOW_DAYS) return null;
                    // Score: closer date + tighter amount = higher score.
                    const dateScore = 1 - daysApart / DATE_WINDOW_DAYS;
                    const amountScore = 1 - Math.abs(eAmt - txAbs) / tolerance;
                    return { e, score: 0.5 * dateScore + 0.5 * amountScore };
                }
            }
            // No date in evidence — match purely on amount.
            return { e, score: 1 - Math.abs(eAmt - txAbs) / tolerance };
        })
        .filter((m): m is { e: Evidence; score: number } => m !== null)
        .sort((a, b) => b.score - a.score)
        .map(m => ({ ...m.e, match_confidence: Number(m.score.toFixed(2)) }));
}

function scoreConfidence(pattern: MerchantPattern | undefined, hasEvidence: boolean): number {
    let base: number;
    if (!pattern) {
        base = 0.3;
    } else if (pattern.recurring && pattern.common_category) {
        base = 1.0;
    } else if (pattern.common_category) {
        base = 0.8;
    } else if (pattern.count >= 3) {
        base = 0.6;
    } else {
        base = 0.4;
    }
    // Evidence lifts confidence up to (but not past) 1.0.
    if (hasEvidence) base = Math.min(1.0, base + 0.1);
    return Number(base.toFixed(2));
}

function buildRationale(sig: string, pattern: MerchantPattern | undefined, evidenceCount: number): string {
    const parts: string[] = [];
    if (pattern) {
        parts.push(
            `Matched ${pattern.count} prior ${sig || 'merchant'} transaction${pattern.count === 1 ? '' : 's'}` +
            (pattern.last_used ? ` (last on ${pattern.last_used})` : ''),
        );
        if (pattern.common_category) {
            parts.push(`commonly categorised the same way`);
        }
        if (pattern.recurring) {
            parts.push(`recurring on a ~${pattern.recurring.cadence_days}-day cadence`);
        }
    } else if (sig) {
        parts.push(`No prior history for "${sig}" — proposed without category seeding`);
    } else {
        parts.push(`Could not extract a merchant signature from the description`);
    }
    if (evidenceCount > 0) {
        parts.push(`${evidenceCount} matching evidence ${evidenceCount === 1 ? 'item' : 'items'} attached`);
    }
    return parts.join('; ') + '.';
}

function buildSearchHint(
    tx: BankTransaction,
    txAmount: number,
    pattern: MerchantPattern | undefined,
    accountCurrency: string | undefined,
): SearchHint {
    const sig = pattern?.merchant_signature ?? merchantSignature(tx.description ?? '');
    const amountAbs = Number.isFinite(txAmount) ? Math.abs(txAmount).toFixed(2) : undefined;
    return {
        intent: 'find_receipt',
        around_date: tx.dated_on,
        date_window_days: DATE_WINDOW_DAYS,
        amount: amountAbs,
        amount_tolerance: amountAbs ? Math.max(0.5, parseFloat(amountAbs) * AMOUNT_TOLERANCE_RELATIVE).toFixed(2) : undefined,
        currency: accountCurrency,
        merchant_keywords: sig ? sig.split(/\s+/).filter(t => t.length >= 2) : undefined,
        has_attachment: true,
    };
}

function describe(tx: BankTransaction): string {
    const date = tx.dated_on || 'unknown date';
    const amt = tx.amount ?? '?';
    const desc = (tx.description ?? '').slice(0, 60);
    return `${date} ${amt} — ${desc}`;
}

function formatSigned(n: number): string {
    return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

function makeProposalId(tx: BankTransaction): string {
    // Stable per-call: derive from the transaction URL plus a short
    // random suffix so retried propose calls don't collide in logs.
    const id = tx.url.split('/').pop() ?? 'tx';
    const suffix = Math.random().toString(36).slice(2, 8);
    return `prop-${id}-${suffix}`;
}
